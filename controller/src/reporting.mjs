import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REPORTABLE_STATES = new Set(['CLOSED', 'REPORTED'])
const LEVELS = new Set(['baseline', 'l1', 'l2', 'l3'])
const DECISIONS = new Set(['baseline', 'promoted', 'rejected'])
const HOUR_MS = 60 * 60 * 1000
const VALIDATION_TOTAL = 500
const TEST_TOTAL = 172
const USAGE_FIELDS = ['requests', 'inputTokens', 'outputTokens', 'totalTokens']
const CAMPAIGN_LEVELS = ['l1', 'l2', 'l3']
const CSV_FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f-\u009f\ufeff]*[=+\-@]/u

// Character references are parsed as literal text by CommonMark, rather than
// being reinterpreted as Markdown delimiters. Keep model-authored proposal text
// literal in the report while preserving how it reads when rendered.
const MARKDOWN_LITERAL_ENTITIES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['\\', '&#92;'],
  ['`', '&#96;'],
  ['*', '&#42;'],
  ['_', '&#95;'],
  ['{', '&#123;'],
  ['}', '&#125;'],
  ['[', '&#91;'],
  [']', '&#93;'],
  ['(', '&#40;'],
  [')', '&#41;'],
  ['#', '&#35;'],
  ['+', '&#43;'],
  ['-', '&#45;'],
  ['!', '&#33;'],
  ['|', '&#124;'],
  ['~', '&#126;'],
])

export class ReportingError extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'ReportingError'
    this.details = details
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function parseTimestamp(value, path, errors) {
  if (!hasText(value)) {
    errors.push(`${path} must be a non-empty timestamp`)
    return null
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    errors.push(`${path} is not a valid timestamp`)
    return null
  }
  return milliseconds
}

function validateScore(verified, total, expectedTotal, path, errors) {
  if (!Number.isInteger(total) || total !== expectedTotal) {
    errors.push(`${path}.total must be ${expectedTotal}`)
  }
  if (!Number.isInteger(verified) || verified < 0 || verified > expectedTotal) {
    errors.push(`${path}.verified must be an integer from 0 to ${expectedTotal}`)
  }
}

function normalizeUsage(value, path, errors) {
  if (value === undefined || value === null) return null
  if (!isObject(value)) {
    errors.push(`${path}.usage must be an object when present`)
    return null
  }
  const usage = {}
  for (const field of USAGE_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      errors.push(`${path}.usage.${field} must be a non-negative safe integer`)
      return null
    }
    usage[field] = value[field]
  }
  return usage
}

function normalizeLatency(value, path, errors) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push(`${path}.latencyMs must be a non-negative safe integer when present`)
    return null
  }
  return value
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function escapeMarkdownCell(value) {
  const text = String(value)
  let escaped = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\r') {
      if (text[index + 1] === '\n') index += 1
      escaped += '<br />'
      continue
    }
    if (character === '\n') {
      escaped += '<br />'
      continue
    }
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) {
      escaped += `&#${code};`
      continue
    }
    escaped += MARKDOWN_LITERAL_ENTITIES.get(character) ?? character
  }
  return escaped
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const rawText = String(value)
  // A leading apostrophe is the conventional spreadsheet-safe representation.
  // Apply it only to strings: genuine numeric CSV values retain numeric types.
  // curve.json remains the lossless source for the original proposal text.
  const text = typeof value === 'string' && CSV_FORMULA_PREFIX.test(rawText)
    ? `'${rawText}`
    : rawText
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function findBaselineFreeze(state, errors) {
  if (!Array.isArray(state.events)) {
    errors.push('campaignState.events must be an array')
    return { event: null, milliseconds: null }
  }
  const events = state.events.filter((event) => event?.type === 'BASELINE_FROZEN')
  if (events.length !== 1) {
    errors.push('campaignState.events must contain exactly one BASELINE_FROZEN event')
    return { event: events[0] ?? null, milliseconds: null }
  }
  return {
    event: events[0],
    milliseconds: parseTimestamp(events[0].at, 'BASELINE_FROZEN.at', errors),
  }
}

function indexAggregates(aggregates, expectedTotal, name, errors, { optional = false } = {}) {
  const byCandidate = new Map()
  if (aggregates === undefined && optional) return { byCandidate, provided: false }
  if (!Array.isArray(aggregates)) {
    errors.push(`${name} must be an array`)
    return { byCandidate, provided: true }
  }

  for (const [index, aggregate] of aggregates.entries()) {
    const path = `${name}[${index}]`
    if (!isObject(aggregate)) {
      errors.push(`${path} must be an object`)
      continue
    }
    if (!hasText(aggregate.candidateId)) {
      errors.push(`${path}.candidateId must be a non-empty string`)
      continue
    }
    if (byCandidate.has(aggregate.candidateId)) {
      errors.push(`duplicate ${name} entry for candidate ${aggregate.candidateId}`)
      continue
    }
    if (aggregate.receiptId !== undefined && !hasText(aggregate.receiptId)) {
      errors.push(`${path}.receiptId must be a non-empty string when present`)
    }
    validateScore(aggregate.verified, aggregate.total, expectedTotal, path, errors)
    byCandidate.set(aggregate.candidateId, {
      ...aggregate,
      usage: normalizeUsage(aggregate.usage, path, errors),
      latencyMs: normalizeLatency(aggregate.latencyMs, path, errors),
    })
  }
  return { byCandidate, provided: true }
}

function indexTestAggregates(testAggregates, errors) {
  return indexAggregates(testAggregates, TEST_TOTAL, 'testAggregates', errors).byCandidate
}

function indexValidationAggregates(validationAggregates, errors) {
  return indexAggregates(
    validationAggregates,
    VALIDATION_TOTAL,
    'validationAggregates',
    errors,
    { optional: true },
  )
}

function indexProposals(proposals, errors) {
  const byId = new Map()
  if (!Array.isArray(proposals)) {
    errors.push('proposals must be an array')
    return byId
  }

  for (const [index, proposal] of proposals.entries()) {
    const path = `proposals[${index}]`
    if (!isObject(proposal)) {
      errors.push(`${path} must be an object`)
      continue
    }
    if (!hasText(proposal.proposalId)) {
      errors.push(`${path}.proposalId must be a non-empty string`)
      continue
    }
    if (byId.has(proposal.proposalId)) {
      errors.push(`duplicate proposal ${proposal.proposalId}`)
      continue
    }
    if (!hasText(proposal.candidateId)) errors.push(`${path}.candidateId must be a non-empty string`)
    if (!hasText(proposal.direction)) errors.push(`${path}.direction must be a non-empty string`)
    const createdMilliseconds = parseTimestamp(proposal.createdAt, `${path}.createdAt`, errors)
    byId.set(proposal.proposalId, { ...proposal, createdMilliseconds })
  }
  return byId
}

function markerForDecision(decision) {
  if (decision === 'promoted') return 'accepted'
  if (decision === 'rejected') return 'rejected'
  return 'baseline'
}

function addSafeInteger(left, right, path, errors) {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) {
    errors.push(`${path} exceeds the safe integer range`)
    return left
  }
  return sum
}

function totalResource(points, name, errors) {
  const total = {
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    latencyMs: 0,
    candidates: points.length,
    candidatesWithUsage: 0,
    candidatesWithLatency: 0,
  }
  for (const point of points) {
    const resource = point[name]
    if (resource?.usage) {
      total.candidatesWithUsage += 1
      for (const field of USAGE_FIELDS) {
        total.usage[field] = addSafeInteger(
          total.usage[field],
          resource.usage[field],
          `campaignTotals.${name}.usage.${field}`,
          errors,
        )
      }
    }
    if (resource?.latencyMs !== null && resource?.latencyMs !== undefined) {
      total.candidatesWithLatency += 1
      total.latencyMs = addSafeInteger(
        total.latencyMs,
        resource.latencyMs,
        `campaignTotals.${name}.latencyMs`,
        errors,
      )
    }
  }
  return total
}

function campaignResourceTotals(points, errors) {
  const validation = totalResource(points, 'validation', errors)
  const test = totalResource(points, 'test', errors)
  const combined = {
    usage: {},
    latencyMs: addSafeInteger(
      validation.latencyMs,
      test.latencyMs,
      'campaignTotals.combined.latencyMs',
      errors,
    ),
  }
  for (const field of USAGE_FIELDS) {
    combined.usage[field] = addSafeInteger(
      validation.usage[field],
      test.usage[field],
      `campaignTotals.combined.usage.${field}`,
      errors,
    )
  }
  return { validation, test, combined }
}

function levelAttemptSummaries(points) {
  let incumbentVerified = points[0].validation.verified
  return CAMPAIGN_LEVELS.map((level) => {
    const attempts = points.filter((point) => point.level === level)
    const startingIncumbentVerified = incumbentVerified
    let completed = 0
    let candidateFailures = 0
    let promoted = 0
    let rejected = 0
    for (const point of attempts) {
      if (point.outcome === 'completed') completed += 1
      if (point.outcome === 'candidate_failure') candidateFailures += 1
      if (point.decision === 'promoted') {
        promoted += 1
        incumbentVerified = point.validation.verified
      } else if (point.decision === 'rejected') {
        rejected += 1
      }
    }
    return {
      level,
      attempts: attempts.length,
      completed,
      candidateFailures,
      promoted,
      rejected,
      startingIncumbentVerified,
      endingIncumbentVerified: incumbentVerified,
      validationGain: incumbentVerified - startingIncumbentVerified,
      bestAttemptVerified: attempts.length > 0
        ? Math.max(...attempts.map((point) => point.validation.verified))
        : null,
    }
  })
}

function infrastructureEventSummary(events) {
  const summarizedEvents = []
  for (const event of events) {
    if (!isObject(event)
        || !['INFRASTRUCTURE_PAUSED', 'INFRASTRUCTURE_RESUMED'].includes(event.type)) continue
    summarizedEvents.push({
      sequence: Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : null,
      type: event.type,
      at: hasText(event.at) ? event.at : null,
      operation: event.type === 'INFRASTRUCTURE_PAUSED' && hasText(event.operation)
        ? event.operation
        : null,
      resumeStatus: hasText(event.resumeStatus) ? event.resumeStatus : null,
    })
  }
  const pauseCount = summarizedEvents
    .filter((event) => event.type === 'INFRASTRUCTURE_PAUSED').length
  const resumeCount = summarizedEvents.length - pauseCount
  return {
    pauseCount,
    resumeCount,
    unresolvedPauseCount: Math.max(0, pauseCount - resumeCount),
    // Infrastructure messages are deliberately excluded: counts and operations
    // are useful campaign metadata, while exception text may contain host paths.
    events: summarizedEvents,
  }
}

function reportResourceTotals(report) {
  if (isObject(report.campaignTotals)) return report.campaignTotals
  // Keep the standalone renderers compatible with reports built before
  // resource metrics were added.
  const errors = []
  const totals = campaignResourceTotals(report.points ?? [], errors)
  if (errors.length > 0) throw new ReportingError('report resource totals are invalid', errors)
  return totals
}

/**
 * Join a terminal CampaignState with validation/test resource aggregates and
 * frozen proposals.
 * Candidate ordering always comes from CampaignState.candidates; test scores are
 * never consulted for ordering or selection.
 */
export function buildCampaignReport({ campaignState, validationAggregates, testAggregates, proposals }) {
  const errors = []
  if (!isObject(campaignState) || campaignState.kind !== 'CampaignState') {
    throw new ReportingError('campaignState must be a CampaignState object')
  }
  if (!REPORTABLE_STATES.has(campaignState.status)) {
    throw new ReportingError('campaign reports can only be built after closure', [
      `status must be CLOSED or REPORTED, received ${campaignState.status ?? '<missing>'}`,
    ])
  }
  if (!hasText(campaignState.campaignId)) errors.push('campaignState.campaignId must be non-empty')

  const baselineFreeze = findBaselineFreeze(campaignState, errors)
  const closedMilliseconds = parseTimestamp(campaignState.closedAt, 'campaignState.closedAt', errors)
  const testByCandidate = indexTestAggregates(testAggregates, errors)
  const validationIndex = indexValidationAggregates(validationAggregates, errors)
  const validationByCandidate = validationIndex.byCandidate
  const proposalById = indexProposals(proposals, errors)
  const candidates = campaignState.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    errors.push('campaignState.candidates must be a non-empty array')
  }

  const points = []
  const candidateIds = new Set()
  const receiptIds = new Set()
  const usedProposalIds = new Set()
  let previousEvaluationMilliseconds = baselineFreeze.milliseconds
  let previousLevelIndex = -1

  for (const [index, candidate] of (Array.isArray(candidates) ? candidates : []).entries()) {
    const path = `campaignState.candidates[${index}]`
    if (!isObject(candidate)) {
      errors.push(`${path} must be an object`)
      continue
    }
    if (!hasText(candidate.candidateId)) {
      errors.push(`${path}.candidateId must be a non-empty string`)
      continue
    }
    if (candidateIds.has(candidate.candidateId)) errors.push(`duplicate candidate ${candidate.candidateId}`)
    candidateIds.add(candidate.candidateId)

    if (!LEVELS.has(candidate.level)) errors.push(`${path}.level is invalid`)
    if (!DECISIONS.has(candidate.decision)) errors.push(`${path}.decision is invalid`)
    if (index === 0 && (candidate.level !== 'baseline' || candidate.decision !== 'baseline')) {
      errors.push('the first candidate must be the baseline')
    }
    if (index > 0 && (candidate.level === 'baseline' || candidate.decision === 'baseline')) {
      errors.push(`${path} cannot be another baseline`)
    }
    const levelIndex = candidate.level === 'baseline'
      ? -1
      : ['l1', 'l2', 'l3'].indexOf(candidate.level)
    if (levelIndex < previousLevelIndex) errors.push(`${path}.level moves backwards`)
    previousLevelIndex = Math.max(previousLevelIndex, levelIndex)

    if (index === 0 && candidate.parentId !== null) errors.push('baseline parentId must be null')
    if (index > 0 && (!hasText(candidate.parentId) || !candidateIds.has(candidate.parentId))) {
      errors.push(`${path}.parentId must refer to an earlier candidate`)
    }

    validateScore(
      candidate.validationVerified,
      candidate.validationTotal,
      VALIDATION_TOTAL,
      `${path}.validation`,
      errors,
    )
    const validationAggregate = validationByCandidate.get(candidate.candidateId)
    if (validationIndex.provided && !validationAggregate) {
      errors.push(`missing validation aggregate for candidate ${candidate.candidateId}`)
    } else if (validationAggregate
        && (validationAggregate.verified !== candidate.validationVerified
          || validationAggregate.total !== candidate.validationTotal)) {
      errors.push(`validation aggregate does not match candidate ${candidate.candidateId}`)
    }
    const evaluatedMilliseconds = parseTimestamp(candidate.evaluatedAt, `${path}.evaluatedAt`, errors)
    if (evaluatedMilliseconds !== null && baselineFreeze.milliseconds !== null
        && evaluatedMilliseconds < baselineFreeze.milliseconds) {
      errors.push(`${path}.evaluatedAt precedes the baseline freeze`)
    }
    if (evaluatedMilliseconds !== null && previousEvaluationMilliseconds !== null
        && evaluatedMilliseconds < previousEvaluationMilliseconds) {
      errors.push(`${path}.evaluatedAt is earlier than the preceding candidate`)
    }
    if (evaluatedMilliseconds !== null) previousEvaluationMilliseconds = evaluatedMilliseconds

    const receipt = candidate.testReceipt
    if (!isObject(receipt) || !hasText(receipt.receiptId)) {
      errors.push(`${path}.testReceipt.receiptId must be non-empty`)
    } else if (receiptIds.has(receipt.receiptId)) {
      errors.push(`duplicate test receipt ${receipt.receiptId}`)
    } else {
      receiptIds.add(receipt.receiptId)
    }

    const test = testByCandidate.get(candidate.candidateId)
    if (!test) {
      errors.push(`missing test aggregate for candidate ${candidate.candidateId}`)
    } else if (isObject(receipt) && test.receiptId !== undefined
        && test.receiptId !== receipt.receiptId) {
      errors.push(`test aggregate receipt does not match candidate ${candidate.candidateId}`)
    }

    let proposal = null
    if (index > 0) {
      if (!hasText(candidate.proposalId)) {
        errors.push(`${path}.proposalId must be non-empty`)
      } else {
        proposal = proposalById.get(candidate.proposalId) ?? null
        if (!proposal) {
          errors.push(`missing proposal ${candidate.proposalId} for candidate ${candidate.candidateId}`)
        } else {
          usedProposalIds.add(candidate.proposalId)
          if (proposal.candidateId !== candidate.candidateId) {
            errors.push(`proposal ${candidate.proposalId} candidateId does not match`)
          }
          if (proposal.createdMilliseconds !== null && baselineFreeze.milliseconds !== null
              && proposal.createdMilliseconds < baselineFreeze.milliseconds) {
            errors.push(`proposal ${candidate.proposalId} predates the baseline freeze`)
          }
          if (proposal.createdMilliseconds !== null && evaluatedMilliseconds !== null
              && proposal.createdMilliseconds > evaluatedMilliseconds) {
            errors.push(`proposal ${candidate.proposalId} was not frozen before evaluation`)
          }
        }
      }
    }

    const elapsedHours = evaluatedMilliseconds !== null && baselineFreeze.milliseconds !== null
      ? round((evaluatedMilliseconds - baselineFreeze.milliseconds) / HOUR_MS)
      : null
    points.push({
      sequence: index,
      candidateId: candidate.candidateId,
      parentId: candidate.parentId,
      level: candidate.level,
      proposalId: candidate.proposalId ?? null,
      proposalDirection: proposal?.direction ?? null,
      proposalCreatedAt: proposal?.createdAt ?? null,
      evaluatedAt: candidate.evaluatedAt,
      elapsedHours,
      outcome: candidate.outcome ?? (index === 0 ? 'baseline' : 'completed'),
      decision: candidate.decision,
      marker: markerForDecision(candidate.decision),
      validation: {
        verified: candidate.validationVerified,
        total: candidate.validationTotal,
        rate: candidate.validationVerified / candidate.validationTotal,
        usage: validationAggregate?.usage ?? null,
        latencyMs: validationAggregate?.latencyMs ?? null,
      },
      test: test
        ? {
            verified: test.verified,
            total: test.total,
            rate: test.verified / test.total,
            usage: test.usage,
            latencyMs: test.latencyMs,
          }
        : null,
      testReceiptId: receipt?.receiptId ?? null,
    })
  }

  for (const candidateId of testByCandidate.keys()) {
    if (!candidateIds.has(candidateId)) errors.push(`test aggregate refers to unknown candidate ${candidateId}`)
  }
  for (const candidateId of validationByCandidate.keys()) {
    if (!candidateIds.has(candidateId)) {
      errors.push(`validation aggregate refers to unknown candidate ${candidateId}`)
    }
  }
  for (const proposalId of proposalById.keys()) {
    if (!usedProposalIds.has(proposalId)) errors.push(`proposal ${proposalId} is not used by a candidate`)
  }
  if (baselineFreeze.event && points[0]
      && hasText(baselineFreeze.event.candidateId)
      && baselineFreeze.event.candidateId !== points[0].candidateId) {
    errors.push('BASELINE_FROZEN candidateId does not match the baseline candidate')
  }
  if (closedMilliseconds !== null && baselineFreeze.milliseconds !== null
      && closedMilliseconds < baselineFreeze.milliseconds) {
    errors.push('campaignState.closedAt precedes the baseline freeze')
  }
  if (closedMilliseconds !== null && previousEvaluationMilliseconds !== null
      && closedMilliseconds < previousEvaluationMilliseconds) {
    errors.push('campaignState.closedAt precedes the final candidate evaluation')
  }

  const campaignTotals = campaignResourceTotals(points, errors)
  if (errors.length > 0) throw new ReportingError('campaign report validation failed', errors)

  const levelSummaries = levelAttemptSummaries(points)
  const infrastructureSummary = infrastructureEventSummary(campaignState.events)

  return {
    schemaVersion: 'harness-rsi/evolution-curve-v1',
    campaignId: campaignState.campaignId,
    campaignStatus: campaignState.status,
    baselineFrozenAt: baselineFreeze.event.at,
    closedAt: campaignState.closedAt,
    durationHours: round((closedMilliseconds - baselineFreeze.milliseconds) / HOUR_MS),
    ordering: 'campaign-candidate-sequence',
    selectionMetric: 'validation-verified-only',
    smoothed: false,
    validationTotal: VALIDATION_TOTAL,
    testTotal: TEST_TOTAL,
    textExportPolicy: {
      jsonProposalText: 'raw',
      csvFormulaNeutralization: 'leading-apostrophe',
      markdownDynamicText: 'literal-character-references',
    },
    campaignTotals,
    levelSummaries,
    infrastructureSummary,
    points,
  }
}

export function renderCurveJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function renderCurveCsv(report) {
  const headers = [
    'sequence',
    'candidate_id',
    'parent_id',
    'level',
    'proposal_id',
    'proposal_direction',
    'proposal_created_at',
    'evaluated_at',
    'elapsed_hours',
    'outcome',
    'decision',
    'marker',
    'validation_verified',
    'validation_total',
    'validation_rate',
    'validation_requests',
    'validation_input_tokens',
    'validation_output_tokens',
    'validation_total_tokens',
    'validation_latency_ms',
    'test_verified',
    'test_total',
    'test_rate',
    'test_requests',
    'test_input_tokens',
    'test_output_tokens',
    'test_total_tokens',
    'test_latency_ms',
    'test_receipt_id',
  ]
  const rows = report.points.map((point) => [
    point.sequence,
    point.candidateId,
    point.parentId,
    point.level,
    point.proposalId,
    point.proposalDirection,
    point.proposalCreatedAt,
    point.evaluatedAt,
    point.elapsedHours,
    point.outcome,
    point.decision,
    point.marker,
    point.validation.verified,
    point.validation.total,
    round(point.validation.rate),
    point.validation.usage?.requests,
    point.validation.usage?.inputTokens,
    point.validation.usage?.outputTokens,
    point.validation.usage?.totalTokens,
    point.validation.latencyMs,
    point.test.verified,
    point.test.total,
    round(point.test.rate),
    point.test.usage?.requests,
    point.test.usage?.inputTokens,
    point.test.usage?.outputTokens,
    point.test.usage?.totalTokens,
    point.test.latencyMs,
    point.testReceiptId,
  ])
  const totals = reportResourceTotals(report)
  const validationTotal = totals.validation
  const testTotal = totals.test
  const totalRow = [
    'campaign_total', '', '', '', '', '', '', '', '', '', '', '',
    '', '', '',
    validationTotal.usage.requests,
    validationTotal.usage.inputTokens,
    validationTotal.usage.outputTokens,
    validationTotal.usage.totalTokens,
    validationTotal.latencyMs,
    '', '', '',
    testTotal.usage.requests,
    testTotal.usage.inputTokens,
    testTotal.usage.outputTokens,
    testTotal.usage.totalTokens,
    testTotal.latencyMs,
    '',
  ]
  return `${[headers, ...rows, totalRow].map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function buildLevelBands(report) {
  const groups = []
  for (let index = 1; index < report.points.length; index += 1) {
    const point = report.points[index]
    const last = groups.at(-1)
    if (!last || last.level !== point.level) {
      groups.push({ level: point.level, firstIndex: index, lastIndex: index })
    } else {
      last.lastIndex = index
    }
  }
  return groups.map((group) => {
    const first = report.points[group.firstIndex]
    const before = report.points[group.firstIndex - 1]
    const last = report.points[group.lastIndex]
    const after = report.points[group.lastIndex + 1]
    return {
      level: group.level,
      startHours: (before.elapsedHours + first.elapsedHours) / 2,
      endHours: after
        ? (last.elapsedHours + after.elapsedHours) / 2
        : report.durationHours,
    }
  })
}

function svgMarker(point, x, y, seriesColor) {
  const title = escapeXml(
    `${point.candidateId}: ${point.marker}, ${point.level.toUpperCase()}, ${point.elapsedHours} h`,
  )
  const attributes = `data-candidate="${escapeXml(point.candidateId)}" data-marker="${point.marker}" data-level="${escapeXml(point.level)}"`
  if (point.marker === 'baseline') {
    const polygon = `${x},${y - 6} ${x + 6},${y} ${x},${y + 6} ${x - 6},${y}`
    return `<g ${attributes}><title>${title}</title><polygon points="${polygon}" fill="white" stroke="${seriesColor}" stroke-width="2"/></g>`
  }
  if (point.marker === 'accepted') {
    return `<g ${attributes}><title>${title}</title><circle cx="${x}" cy="${y}" r="7" fill="white" stroke="#16803a" stroke-width="3"/><circle cx="${x}" cy="${y}" r="3" fill="${seriesColor}"/></g>`
  }
  return `<g ${attributes}><title>${title}</title><path d="M ${x - 6} ${y - 6} L ${x + 6} ${y + 6} M ${x + 6} ${y - 6} L ${x - 6} ${y + 6}" fill="none" stroke="#b42318" stroke-width="3" stroke-linecap="round"/></g>`
}

export function renderCurveSvg(report) {
  const width = 1200
  const height = 720
  const left = 92
  const right = 1140
  const top = 104
  const bottom = 606
  const plotWidth = right - left
  const plotHeight = bottom - top
  const xMaximum = Math.max(report.durationHours, ...report.points.map((point) => point.elapsedHours), 1)
  const x = (hours) => round(left + (hours / xMaximum) * plotWidth, 2)
  const y = (rate) => round(bottom - rate * plotHeight, 2)
  const validationColor = '#175cd3'
  const testColor = '#dc6803'
  const bandColors = { l1: '#eff8ff', l2: '#f4f3ff', l3: '#fff4ed' }
  const lines = []

  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`)
  lines.push('<title id="title">Harness RSI raw validation and hidden-test evolution curves</title>')
  lines.push(`<desc id="description">Chronological, unsmoothed candidate scores for campaign ${escapeXml(report.campaignId)}. Test results were unsealed only after closure.</desc>`)
  lines.push('<rect width="1200" height="720" fill="white"/>')
  lines.push(`<text x="${left}" y="38" font-family="sans-serif" font-size="24" font-weight="700" fill="#101828">PutnamBench-Lean Harness RSI</text>`)
  lines.push(`<text x="${left}" y="66" font-family="sans-serif" font-size="14" fill="#475467">Raw candidate points · baseline frozen ${escapeXml(report.baselineFrozenAt)} · no smoothing</text>`)

  for (const band of buildLevelBands(report)) {
    const bandX = x(band.startHours)
    const bandWidth = Math.max(0, x(band.endHours) - bandX)
    lines.push(`<g data-phase="${band.level}"><rect x="${bandX}" y="${top}" width="${round(bandWidth, 2)}" height="${plotHeight}" fill="${bandColors[band.level]}"/><text x="${round(bandX + 8, 2)}" y="${top + 20}" font-family="sans-serif" font-size="13" font-weight="700" fill="#475467">${band.level.toUpperCase()}</text></g>`)
  }

  for (let tick = 0; tick <= 5; tick += 1) {
    const rate = tick / 5
    const tickY = y(rate)
    lines.push(`<line x1="${left}" y1="${tickY}" x2="${right}" y2="${tickY}" stroke="#d0d5dd" stroke-width="1"/>`)
    lines.push(`<text x="${left - 14}" y="${tickY + 5}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#475467">${Math.round(rate * 100)}%</text>`)
  }
  for (let tick = 0; tick <= 5; tick += 1) {
    const hours = (xMaximum * tick) / 5
    const tickX = x(hours)
    lines.push(`<line x1="${tickX}" y1="${bottom}" x2="${tickX}" y2="${bottom + 6}" stroke="#667085"/>`)
    lines.push(`<text x="${tickX}" y="${bottom + 24}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#475467">${round(hours, 2)}</text>`)
  }
  lines.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#667085"/>`)
  lines.push(`<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#667085"/>`)
  lines.push(`<text x="${(left + right) / 2}" y="${bottom + 52}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#344054">Elapsed hours since baseline freeze</text>`)
  lines.push(`<text x="24" y="${(top + bottom) / 2}" transform="rotate(-90 24 ${(top + bottom) / 2})" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#344054">Verified rate</text>`)

  const validationPoints = report.points
    .map((point) => `${x(point.elapsedHours)},${y(point.validation.rate)}`)
    .join(' ')
  const testPoints = report.points
    .map((point) => `${x(point.elapsedHours)},${y(point.test.rate)}`)
    .join(' ')
  lines.push(`<polyline data-series="validation" points="${validationPoints}" fill="none" stroke="${validationColor}" stroke-width="3" stroke-linejoin="round"/>`)
  lines.push(`<polyline data-series="test" points="${testPoints}" fill="none" stroke="${testColor}" stroke-width="3" stroke-linejoin="round"/>`)
  for (const point of report.points) {
    lines.push(svgMarker(point, x(point.elapsedHours), y(point.validation.rate), validationColor))
    lines.push(svgMarker(point, x(point.elapsedHours), y(point.test.rate), testColor))
  }

  const legendY = 678
  lines.push(`<line x1="${left}" y1="${legendY}" x2="${left + 28}" y2="${legendY}" stroke="${validationColor}" stroke-width="3"/><text x="${left + 36}" y="${legendY + 5}" font-family="sans-serif" font-size="13" fill="#344054">Validation (500)</text>`)
  lines.push(`<line x1="${left + 170}" y1="${legendY}" x2="${left + 198}" y2="${legendY}" stroke="${testColor}" stroke-width="3"/><text x="${left + 206}" y="${legendY + 5}" font-family="sans-serif" font-size="13" fill="#344054">Hidden test (172)</text>`)
  lines.push(`<circle cx="${left + 386}" cy="${legendY}" r="6" fill="white" stroke="#16803a" stroke-width="3"/><text x="${left + 398}" y="${legendY + 5}" font-family="sans-serif" font-size="13" fill="#344054">Accepted</text>`)
  lines.push(`<path d="M ${left + 492} ${legendY - 5} L ${left + 502} ${legendY + 5} M ${left + 502} ${legendY - 5} L ${left + 492} ${legendY + 5}" stroke="#b42318" stroke-width="3"/><text x="${left + 512}" y="${legendY + 5}" font-family="sans-serif" font-size="13" fill="#344054">Rejected</text>`)
  lines.push(`<polygon points="${left + 618},${legendY - 6} ${left + 624},${legendY} ${left + 618},${legendY + 6} ${left + 612},${legendY}" fill="white" stroke="#475467" stroke-width="2"/><text x="${left + 634}" y="${legendY + 5}" font-family="sans-serif" font-size="13" fill="#344054">Baseline</text>`)
  lines.push('</svg>')
  return `${lines.join('\n')}\n`
}

export function renderImprovementsMarkdown(report) {
  const lines = [
    '# Mutation directions and outcomes',
    '',
    `Campaign: \`${escapeMarkdownCell(report.campaignId)}\``,
    '',
    'Rows are in campaign-ledger order. Directions were frozen before each mutation; hidden-test scores were unsealed only after campaign closure and were never used for acceptance, ordering, or stopping.',
    'Dynamic Markdown text is rendered literally. Spreadsheet-formula-like CSV text is prefixed with an apostrophe; `curve.json` retains the original proposal text.',
    '',
    '| # | elapsed h | level | candidate | result | proposed direction | validation | hidden test |',
    '|---:|---:|:---:|---|:---:|---|---:|---:|',
  ]
  for (const point of report.points) {
    const direction = point.proposalDirection ?? 'Frozen baseline'
    lines.push(
      `| ${point.sequence} | ${point.elapsedHours} | ${point.level.toUpperCase()} | \`${escapeMarkdownCell(point.candidateId)}\` | ${point.marker} | ${escapeMarkdownCell(direction)} | ${point.validation.verified}/${point.validation.total} | ${point.test.verified}/${point.test.total} |`,
    )
  }
  const levelSummaries = Array.isArray(report.levelSummaries)
    ? report.levelSummaries
    : levelAttemptSummaries(report.points)
  lines.push(
    '',
    '## Attempts by mutation level',
    '',
    '| level | attempts | completed | candidate failures | promoted | rejected | incumbent start | incumbent end | gain | best attempt |',
    '|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  )
  for (const level of levelSummaries) {
    lines.push(
      `| ${escapeMarkdownCell(level.level.toUpperCase())} | ${level.attempts} | ${level.completed} | ${level.candidateFailures} | ${level.promoted} | ${level.rejected} | ${level.startingIncumbentVerified} | ${level.endingIncumbentVerified} | ${level.validationGain} | ${level.bestAttemptVerified ?? 'n/a'} |`,
    )
  }

  const infrastructure = isObject(report.infrastructureSummary)
    ? report.infrastructureSummary
    : { pauseCount: 0, resumeCount: 0, unresolvedPauseCount: 0, events: [] }
  lines.push(
    '',
    '## Infrastructure events',
    '',
    `Pauses: ${infrastructure.pauseCount}; resumes: ${infrastructure.resumeCount}; unresolved pauses: ${infrastructure.unresolvedPauseCount}. Exception messages are intentionally excluded from report artifacts.`,
  )
  if (Array.isArray(infrastructure.events) && infrastructure.events.length > 0) {
    lines.push(
      '',
      '| ledger # | event | at | operation | resume status |',
      '|---:|---|---|---|---|',
    )
    for (const event of infrastructure.events) {
      lines.push(
        `| ${event.sequence ?? 'n/a'} | ${escapeMarkdownCell(event.type)} | ${escapeMarkdownCell(event.at ?? 'n/a')} | ${escapeMarkdownCell(event.operation ?? 'n/a')} | ${escapeMarkdownCell(event.resumeStatus ?? 'n/a')} |`,
      )
    }
  }
  lines.push(
    '',
    '## Evaluation usage and latency',
    '',
    'Missing metrics in historical campaign artifacts are shown as `n/a`; campaign totals count them as zero and include coverage counts.',
    '',
    '| candidate | val req | val input | val output | val total | val latency ms | test req | test input | test output | test total | test latency ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  )
  const metric = (value) => value ?? 'n/a'
  for (const point of report.points) {
    lines.push(
      `| \`${escapeMarkdownCell(point.candidateId)}\` | ${metric(point.validation.usage?.requests)} | ${metric(point.validation.usage?.inputTokens)} | ${metric(point.validation.usage?.outputTokens)} | ${metric(point.validation.usage?.totalTokens)} | ${metric(point.validation.latencyMs)} | ${metric(point.test.usage?.requests)} | ${metric(point.test.usage?.inputTokens)} | ${metric(point.test.usage?.outputTokens)} | ${metric(point.test.usage?.totalTokens)} | ${metric(point.test.latencyMs)} |`,
    )
  }
  const totals = reportResourceTotals(report)
  const validationTotal = totals.validation
  const testTotal = totals.test
  lines.push(
    `| **Campaign total** | **${validationTotal.usage.requests}** | **${validationTotal.usage.inputTokens}** | **${validationTotal.usage.outputTokens}** | **${validationTotal.usage.totalTokens}** | **${validationTotal.latencyMs}** | **${testTotal.usage.requests}** | **${testTotal.usage.inputTokens}** | **${testTotal.usage.outputTokens}** | **${testTotal.usage.totalTokens}** | **${testTotal.latencyMs}** |`,
    '',
    `Coverage: validation usage ${validationTotal.candidatesWithUsage}/${validationTotal.candidates}, validation latency ${validationTotal.candidatesWithLatency}/${validationTotal.candidates}; hidden-test usage ${testTotal.candidatesWithUsage}/${testTotal.candidates}, hidden-test latency ${testTotal.candidatesWithLatency}/${testTotal.candidates}.`,
    '',
    `Combined campaign total: ${totals.combined.usage.requests} requests, ${totals.combined.usage.inputTokens} input tokens, ${totals.combined.usage.outputTokens} output tokens, ${totals.combined.usage.totalTokens} total tokens, ${totals.combined.latencyMs} ms aggregate task latency.`,
    '',
    'No smoothing, test-based sorting, or post-hoc candidate selection was applied.',
    '',
  )
  return lines.join('\n')
}

export function buildReportArtifacts(input) {
  const report = buildCampaignReport(input)
  return {
    report,
    files: {
      'curve.csv': renderCurveCsv(report),
      'curve.json': renderCurveJson(report),
      'curve.svg': renderCurveSvg(report),
      'improvements.md': renderImprovementsMarkdown(report),
    },
  }
}

async function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporaryPath, contents, 'utf8')
  await rename(temporaryPath, filePath)
}

export async function writeCampaignReport(outputDirectory, input) {
  if (!hasText(outputDirectory)) throw new ReportingError('outputDirectory must be non-empty')
  const directory = resolve(outputDirectory)
  const artifacts = buildReportArtifacts(input)
  await mkdir(directory, { recursive: true })
  await Promise.all(
    Object.entries(artifacts.files).map(([name, contents]) => atomicWrite(join(directory, name), contents)),
  )
  return {
    directory,
    paths: Object.fromEntries(Object.keys(artifacts.files).map((name) => [name, join(directory, name)])),
    report: artifacts.report,
  }
}
