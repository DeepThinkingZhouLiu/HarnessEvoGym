import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ReportingError,
  buildCampaignReport,
  buildReportArtifacts,
  renderCurveCsv,
  renderImprovementsMarkdown,
  writeCampaignReport,
} from '../src/reporting.mjs'

function parseCsv(contents) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index]
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (character !== '\r') {
      cell += character
    }
  }
  assert.equal(quoted, false, 'CSV must end outside a quoted field')
  assert.deepEqual(row, [])
  assert.equal(cell, '')
  return rows
}

function fixture() {
  const candidates = [
    {
      candidateId: 'baseline', parentId: null, level: 'baseline', decision: 'baseline',
      validationVerified: 100, validationTotal: 500, evaluatedAt: '2026-01-01T01:00:00Z',
      testReceipt: { receiptId: 'receipt-0' },
    },
    {
      candidateId: 'candidate-l1', parentId: 'baseline', level: 'l1', decision: 'promoted',
      proposalId: 'proposal-l1', outcome: 'completed', validationVerified: 110,
      validationTotal: 500, evaluatedAt: '2026-01-01T02:00:00Z',
      testReceipt: { receiptId: 'receipt-1' },
    },
    {
      candidateId: 'candidate-l2', parentId: 'candidate-l1', level: 'l2', decision: 'rejected',
      proposalId: 'proposal-l2', outcome: 'completed', validationVerified: 108,
      validationTotal: 500, evaluatedAt: '2026-01-01T04:00:00Z',
      testReceipt: { receiptId: 'receipt-2' },
    },
    {
      candidateId: 'candidate-l3', parentId: 'candidate-l1', level: 'l3', decision: 'rejected',
      proposalId: 'proposal-l3', outcome: 'candidate_failure', validationVerified: 105,
      validationTotal: 500, evaluatedAt: '2026-01-01T08:00:00Z',
      testReceipt: { receiptId: 'receipt-3' },
    },
  ]
  return {
    campaignState: {
      kind: 'CampaignState', campaignId: 'report-fixture', status: 'CLOSED',
      closedAt: '2026-01-01T09:00:00Z', candidates,
      events: [{ type: 'BASELINE_FROZEN', at: '2026-01-01T00:00:00Z', candidateId: 'baseline' }],
    },
    validationAggregates: [
      {
        candidateId: 'baseline', verified: 100, total: 500,
        usage: { requests: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        latencyMs: 1000,
      },
      {
        candidateId: 'candidate-l1', verified: 110, total: 500,
        usage: { requests: 2, inputTokens: 200, outputTokens: 20, totalTokens: 220 },
        latencyMs: 2000,
      },
      {
        candidateId: 'candidate-l2', verified: 108, total: 500,
        usage: { requests: 3, inputTokens: 300, outputTokens: 30, totalTokens: 330 },
        latencyMs: 3000,
      },
      {
        candidateId: 'candidate-l3', verified: 105, total: 500,
        usage: { requests: 4, inputTokens: 400, outputTokens: 40, totalTokens: 440 },
        latencyMs: 4000,
      },
    ],
    // Deliberately shuffled and non-monotonic. Report order must come from the ledger.
    testAggregates: [
      {
        candidateId: 'candidate-l3', verified: 44, total: 172,
        usage: { requests: 8, inputTokens: 800, outputTokens: 80, totalTokens: 880 },
        latencyMs: 8000,
      },
      {
        candidateId: 'baseline', verified: 40, total: 172,
        usage: { requests: 5, inputTokens: 500, outputTokens: 50, totalTokens: 550 },
        latencyMs: 5000,
      },
      {
        candidateId: 'candidate-l2', verified: 70, total: 172,
        usage: { requests: 7, inputTokens: 700, outputTokens: 70, totalTokens: 770 },
        latencyMs: 7000,
      },
      {
        candidateId: 'candidate-l1', verified: 42, total: 172,
        usage: { requests: 6, inputTokens: 600, outputTokens: 60, totalTokens: 660 },
        latencyMs: 6000,
      },
    ],
    proposals: [
      {
        proposalId: 'proposal-l1', candidateId: 'candidate-l1',
        direction: 'Tighten search, then verify', createdAt: '2026-01-01T01:10:00Z',
      },
      {
        proposalId: 'proposal-l2', candidateId: 'candidate-l2',
        direction: 'Preserve context, retry tool errors', createdAt: '2026-01-01T02:10:00Z',
      },
      {
        proposalId: 'proposal-l3', candidateId: 'candidate-l3',
        direction: 'Refactor the solver loop', createdAt: '2026-01-01T04:10:00Z',
      },
    ],
  }
}

test('report joins vault aggregates in ledger order without smoothing or test sorting', () => {
  const report = buildCampaignReport(fixture())
  assert.deepEqual(report.points.map((point) => point.candidateId), [
    'baseline', 'candidate-l1', 'candidate-l2', 'candidate-l3',
  ])
  assert.deepEqual(report.points.map((point) => point.test.verified), [40, 42, 70, 44])
  assert.deepEqual(report.points.map((point) => point.elapsedHours), [1, 2, 4, 8])
  assert.deepEqual(report.points.map((point) => point.marker), [
    'baseline', 'accepted', 'rejected', 'rejected',
  ])
  assert.equal(report.smoothed, false)
  assert.equal(report.ordering, 'campaign-candidate-sequence')
  assert.equal(report.durationHours, 9)
  assert.deepEqual(report.points[1].validation.usage, {
    requests: 2, inputTokens: 200, outputTokens: 20, totalTokens: 220,
  })
  assert.equal(report.points[1].test.latencyMs, 6000)
  assert.deepEqual(report.campaignTotals.combined, {
    usage: { requests: 36, inputTokens: 3600, outputTokens: 360, totalTokens: 3960 },
    latencyMs: 36000,
  })
  assert.deepEqual(report.levelSummaries, [
    {
      level: 'l1', attempts: 1, completed: 1, candidateFailures: 0,
      promoted: 1, rejected: 0, startingIncumbentVerified: 100,
      endingIncumbentVerified: 110, validationGain: 10, bestAttemptVerified: 110,
    },
    {
      level: 'l2', attempts: 1, completed: 1, candidateFailures: 0,
      promoted: 0, rejected: 1, startingIncumbentVerified: 110,
      endingIncumbentVerified: 110, validationGain: 0, bestAttemptVerified: 108,
    },
    {
      level: 'l3', attempts: 1, completed: 0, candidateFailures: 1,
      promoted: 0, rejected: 1, startingIncumbentVerified: 110,
      endingIncumbentVerified: 110, validationGain: 0, bestAttemptVerified: 105,
    },
  ])
  assert.deepEqual(report.infrastructureSummary, {
    pauseCount: 0, resumeCount: 0, unresolvedPauseCount: 0, events: [],
  })
  assert.deepEqual(report.textExportPolicy, {
    jsonProposalText: 'raw',
    csvFormulaNeutralization: 'leading-apostrophe',
    markdownDynamicText: 'literal-character-references',
  })
})

test('artifacts contain raw scores, all levels, decisions, and frozen directions', () => {
  const { files } = buildReportArtifacts(fixture())
  const json = JSON.parse(files['curve.json'])
  assert.equal(json.points[2].validation.verified, 108)
  assert.equal(json.points[2].test.verified, 70)

  assert.match(files['curve.csv'], /validation_verified,validation_total,validation_rate,validation_requests/u)
  assert.match(files['curve.csv'], /test_total_tokens,test_latency_ms,test_receipt_id/u)
  assert.match(files['curve.csv'], /^campaign_total,/mu)
  assert.match(files['curve.csv'], /"Preserve context, retry tool errors"/u)
  assert.match(files['curve.svg'], /data-series="validation"/u)
  assert.match(files['curve.svg'], /data-series="test"/u)
  assert.match(files['curve.svg'], /data-phase="l1"/u)
  assert.match(files['curve.svg'], /data-phase="l2"/u)
  assert.match(files['curve.svg'], /data-phase="l3"/u)
  assert.match(files['curve.svg'], /data-marker="accepted"/u)
  assert.match(files['curve.svg'], /data-marker="rejected"/u)
  assert.match(files['improvements.md'], /Preserve context, retry tool errors/u)
  assert.match(files['improvements.md'], /Evaluation usage and latency/u)
  assert.match(files['improvements.md'], /Combined campaign total: 36 requests/u)
  assert.match(files['improvements.md'], /never used for acceptance, ordering, or stopping/u)
  assert.match(files['improvements.md'], /Attempts by mutation level/u)
  assert.match(files['improvements.md'], /Infrastructure events/u)
})

test('model-authored directions are literal in Markdown while JSON preserves the raw text', () => {
  const input = fixture()
  const direction = '<img src=x onerror=alert(1)> &lt;script&gt; | `code` [click](javascript:alert(1))\r\nnext'
  input.proposals[0].direction = direction
  input.campaignState.campaignId = 'report</code><script>alert(2)</script>'

  const { files } = buildReportArtifacts(input)
  const json = JSON.parse(files['curve.json'])
  const markdown = files['improvements.md']
  assert.equal(json.points[1].proposalDirection, direction)
  assert.equal(json.campaignId, input.campaignState.campaignId)
  assert.doesNotMatch(markdown, /<img\b/u)
  assert.doesNotMatch(markdown, /<script\b/u)
  assert.match(markdown, /&lt;img src=x onerror=alert&#40;1&#41;&gt;/u)
  assert.match(markdown, /&amp;lt;script&amp;gt;/u)
  assert.match(markdown, /&#124; &#96;code&#96;/u)
  assert.match(markdown, /&#91;click&#93;&#40;javascript:alert&#40;1&#41;&#41;/u)
  assert.match(markdown, /<br \/>next/u)
})

test('CSV neutralizes spreadsheet formulas and curve JSON remains lossless', async (context) => {
  const directions = [
    '=1+1',
    '+cmd',
    '-2+3',
    '@SUM(A1:A2)',
    ' \t=HYPERLINK("https://example.test","click")',
    '\n=cmd',
  ]
  for (const direction of directions) {
    await context.test(JSON.stringify(direction), () => {
      const input = fixture()
      input.proposals[0].direction = direction
      const { files } = buildReportArtifacts(input)
      const rows = parseCsv(files['curve.csv'])
      const directionIndex = rows[0].indexOf('proposal_direction')
      const candidateIdIndex = rows[0].indexOf('candidate_id')
      const candidateRow = rows.find((row) => row[candidateIdIndex] === 'candidate-l1')
      assert.ok(candidateRow)
      assert.equal(candidateRow[directionIndex], `'${direction}`)
      assert.equal(JSON.parse(files['curve.json']).points[1].proposalDirection, direction)
    })
  }
})

test('infrastructure reporting summarizes lifecycle events without exception messages', () => {
  const input = fixture()
  input.campaignState.events.push(
    {
      sequence: 2,
      type: 'INFRASTRUCTURE_PAUSED',
      at: '2026-01-01T02:30:00Z',
      operation: '<gateway-retry>',
      message: 'sensitive host path must not be copied',
      resumeStatus: 'EVOLVING_L2',
    },
    {
      sequence: 3,
      type: 'INFRASTRUCTURE_RESUMED',
      at: '2026-01-01T02:40:00Z',
      resumeStatus: 'EVOLVING_L2',
    },
  )
  const { report, files } = buildReportArtifacts(input)
  assert.equal(report.infrastructureSummary.pauseCount, 1)
  assert.equal(report.infrastructureSummary.resumeCount, 1)
  assert.equal(report.infrastructureSummary.unresolvedPauseCount, 0)
  assert.deepEqual(report.infrastructureSummary.events.map((event) => event.type), [
    'INFRASTRUCTURE_PAUSED', 'INFRASTRUCTURE_RESUMED',
  ])
  assert.doesNotMatch(files['curve.json'], /sensitive host path/u)
  assert.doesNotMatch(files['improvements.md'], /sensitive host path/u)
  assert.match(files['improvements.md'], /&lt;gateway&#45;retry&gt;/u)
})

test('historical reports without resource metrics remain compatible and total missing values as zero', () => {
  const input = fixture()
  delete input.validationAggregates
  for (const aggregate of input.testAggregates) {
    delete aggregate.usage
    delete aggregate.latencyMs
  }
  const report = buildCampaignReport(input)
  assert.equal(report.points[0].validation.usage, null)
  assert.equal(report.points[0].validation.latencyMs, null)
  assert.equal(report.points[0].test.usage, null)
  assert.equal(report.points[0].test.latencyMs, null)
  assert.equal(report.campaignTotals.combined.usage.totalTokens, 0)
  assert.equal(report.campaignTotals.combined.latencyMs, 0)
  assert.equal(report.campaignTotals.validation.candidatesWithUsage, 0)

  const historicalReportObject = structuredClone(report)
  delete historicalReportObject.campaignTotals
  assert.match(renderCurveCsv(historicalReportObject), /^campaign_total,/mu)
  assert.match(renderImprovementsMarkdown(historicalReportObject), /Combined campaign total: 0 requests/u)
})

test('reporting rejects a campaign before CLOSED', () => {
  const input = fixture()
  input.campaignState.status = 'CLOSING'
  assert.throws(() => buildCampaignReport(input), ReportingError)
})

test('reporting rejects missing, duplicate, unknown, mismatched, and out-of-range aggregates', async (context) => {
  await context.test('missing', () => {
    const input = fixture()
    input.testAggregates.pop()
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('duplicate', () => {
    const input = fixture()
    input.testAggregates.push({ ...input.testAggregates[0] })
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('unknown', () => {
    const input = fixture()
    input.testAggregates.push({ candidateId: 'unknown', receiptId: 'x', verified: 1, total: 172 })
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('receipt mismatch', () => {
    const input = fixture()
    input.testAggregates[0].receiptId = 'wrong'
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('verified above total', () => {
    const input = fixture()
    input.testAggregates[0].verified = 173
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('wrong total', () => {
    const input = fixture()
    input.testAggregates[0].total = 171
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('unsafe usage', () => {
    const input = fixture()
    input.testAggregates[0].usage.totalTokens = Number.MAX_SAFE_INTEGER + 1
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('overflowing campaign total', () => {
    const input = fixture()
    input.testAggregates[0].usage.totalTokens = Number.MAX_SAFE_INTEGER
    input.testAggregates[1].usage.totalTokens = 1
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('validation score mismatch', () => {
    const input = fixture()
    input.validationAggregates[0].verified = 99
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
})

test('reporting requires a unique pre-evaluation proposal for every mutation', async (context) => {
  await context.test('missing proposal', () => {
    const input = fixture()
    input.proposals.pop()
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('duplicate proposal', () => {
    const input = fixture()
    input.proposals.push({ ...input.proposals[0] })
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
  await context.test('proposal created after evaluation', () => {
    const input = fixture()
    input.proposals[0].createdAt = '2026-01-02T00:00:00Z'
    assert.throws(() => buildCampaignReport(input), /validation failed/u)
  })
})

test('writeCampaignReport writes exactly the four report artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-report-'))
  const result = await writeCampaignReport(join(directory, 'nested'), fixture())
  assert.deepEqual(Object.keys(result.paths).sort(), [
    'curve.csv', 'curve.json', 'curve.svg', 'improvements.md',
  ])
  for (const [name, path] of Object.entries(result.paths)) {
    const contents = await readFile(path, 'utf8')
    assert.equal(contents, buildReportArtifacts(fixture()).files[name])
  }
})
