import { relative, resolve, sep } from 'node:path'

import { writeCampaignReport } from './reporting.mjs'

const REPORTABLE_STATES = new Set(['CLOSED', 'REPORTED'])
const PROBLEM_ID_PATTERN = /putnam_\d{4}_[ab][1-6]/iu
const SEALED_PATH_PATTERN = /(?:^|[/\\])sealed(?:[/\\]|$)/iu
const TEST_SENSITIVE_PATTERN = /\b(?:test|hidden)[\s_.:-]*(?:score|verified|resolved|passed|failed|rate|task|problem|record|trace|path|id)\b/iu

export class StatusReportError extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'StatusReportError'
    this.details = details
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeText(value) {
  if (typeof value !== 'string') return null
  if (PROBLEM_ID_PATTERN.test(value) || SEALED_PATH_PATTERN.test(value)
      || TEST_SENSITIVE_PATTERN.test(value)) return '[REDACTED]'
  return value
}

function safeOptionalText(value) {
  return typeof value === 'string' ? safeText(value) : null
}

function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null
}

function formatCandidate(candidate) {
  if (!isObject(candidate)) return null
  const validationVerified = safeInteger(candidate.validationVerified, { max: 500 })
  const validationTotal = candidate.validationTotal === 500 ? 500 : null
  return {
    candidateId: safeOptionalText(candidate.candidateId),
    parentId: candidate.parentId === null ? null : safeOptionalText(candidate.parentId),
    level: safeOptionalText(candidate.level),
    proposalId: safeOptionalText(candidate.proposalId),
    outcome: safeOptionalText(candidate.outcome),
    decision: safeOptionalText(candidate.decision),
    validationVerified,
    validationTotal,
    evaluatedAt: safeOptionalText(candidate.evaluatedAt),
  }
}

function formatIncumbent(incumbent) {
  if (!isObject(incumbent)) return null
  return {
    candidateId: safeOptionalText(incumbent.candidateId),
    digest: safeOptionalText(incumbent.digest),
    validationVerified: safeInteger(incumbent.validationVerified, { max: 500 }),
    validationTotal: incumbent.validationTotal === 500 ? 500 : null,
  }
}

/**
 * Build the read-only CLI projection. This is an allow-list projection: event
 * payloads, pause/security messages, in-flight task details, opaque test
 * receipts, filesystem roots, and unknown state fields are never copied.
 */
export function formatCampaignStatus(state) {
  if (!isObject(state) || !['CampaignState', 'CampaignStatus'].includes(state.kind)
      || !Array.isArray(state.candidates)) {
    throw new StatusReportError('invalid CampaignState or CampaignStatus')
  }
  if (typeof state.status !== 'string' || state.status.length === 0) {
    throw new StatusReportError('CampaignState status is missing')
  }

  const candidates = state.candidates.map(formatCandidate).filter(Boolean)
  const acceptedMutations = candidates.filter((candidate) => candidate.decision === 'promoted').length
  const rejectedMutations = candidates.filter((candidate) => candidate.decision === 'rejected').length
  const reportAvailable = REPORTABLE_STATES.has(state.status)

  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'CampaignStatus',
    campaignId: safeOptionalText(state.campaignId),
    status: safeText(state.status),
    createdAt: safeOptionalText(state.createdAt),
    updatedAt: safeOptionalText(state.updatedAt),
    closedAt: reportAvailable ? safeOptionalText(state.closedAt) : null,
    reportAvailable,
    activeLevel: safeOptionalText(state.activeLevel),
    consecutiveMisses: safeInteger(state.consecutiveMisses, { max: 3 }),
    incumbent: formatIncumbent(state.incumbent),
    progress: {
      evaluatedCandidates: candidates.length,
      acceptedMutations,
      rejectedMutations,
    },
    candidates,
  }
}

export async function readCampaignStatus(store) {
  if (!store || typeof store.readState !== 'function') {
    throw new StatusReportError('store must provide readState()')
  }
  return formatCampaignStatus(await store.readState())
}

export function renderCampaignStatus(status) {
  if (!isObject(status) || status.kind !== 'CampaignStatus') {
    throw new StatusReportError('status must be a formatted CampaignStatus')
  }
  // Re-project at the rendering boundary so a caller cannot attach unknown
  // fields to an otherwise valid-looking CampaignStatus and leak them.
  return `${JSON.stringify(formatCampaignStatus(status), null, 2)}\n`
}

function pathIsWithin(parentPath, childPath) {
  const relation = relative(resolve(parentPath), resolve(childPath))
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')
}

/**
 * Read aggregate-only validation/test metrics and write final artifacts. The
 * terminal state check deliberately happens before any vault/proposal access.
 */
export async function writeClosedCampaignReport(store, { outputDirectory } = {}) {
  if (!store || typeof store.readState !== 'function') {
    throw new StatusReportError('store must provide readState()')
  }
  const state = await store.readState()
  if (!REPORTABLE_STATES.has(state?.status)) {
    throw new StatusReportError('final reports require a CLOSED or REPORTED campaign')
  }
  if (!Array.isArray(state.candidates)) throw new StatusReportError('terminal CampaignState has no candidates')
  if (typeof store.readSealedAggregates !== 'function' || typeof store.readProposal !== 'function') {
    throw new StatusReportError('store does not provide final-report readers')
  }

  const destination = outputDirectory ?? store.reportRoot
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new StatusReportError('final report output directory is missing')
  }
  if (typeof store.sealedRoot === 'string' && pathIsWithin(store.sealedRoot, destination)) {
    throw new StatusReportError('final report output must be outside the sealed vault')
  }

  const validationAggregates = typeof store.readValidationAggregates === 'function'
    ? await store.readValidationAggregates(state)
    : undefined
  const testAggregates = await store.readSealedAggregates(state)
  const proposals = []
  for (const candidate of state.candidates) {
    if (candidate.level !== 'baseline') proposals.push(await store.readProposal(candidate.candidateId))
  }
  return writeCampaignReport(destination, {
    campaignState: state,
    validationAggregates,
    testAggregates,
    proposals,
  })
}
