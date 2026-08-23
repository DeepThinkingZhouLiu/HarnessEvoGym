import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  StatusReportError,
  formatCampaignStatus,
  readCampaignStatus,
  renderCampaignStatus,
  writeClosedCampaignReport,
} from '../src/status-report.mjs'

function openState(status = 'EVOLVING_L1') {
  const poison = 'test score 171 putnam_1962_a1 /campaign/sealed/test/baseline'
  return {
    kind: 'CampaignState',
    campaignId: 'campaign',
    status,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T02:00:00Z',
    activeLevel: 'l1',
    consecutiveMisses: 1,
    incumbent: {
      candidateId: 'baseline', digest: 'a'.repeat(64),
      validationVerified: 100, validationTotal: 500,
    },
    candidates: [{
      candidateId: 'baseline', parentId: null, level: 'baseline', decision: 'baseline',
      validationVerified: 100, validationTotal: 500, evaluatedAt: '2026-01-01T01:00:00Z',
      testReceipt: { receiptId: 'opaque', candidateId: 'baseline', status: 'sealed' },
      testVerified: 171,
      hiddenTaskId: 'putnam_1962_a1',
      sealedPath: '/campaign/sealed/test/baseline',
    }],
    events: [{ type: 'TEST_COMPLETED', taskId: 'putnam_1962_a1', score: 171, path: poison }],
    inFlight: { testTaskId: 'putnam_1962_a1', sealedPath: poison },
    pause: { operation: poison, message: poison, resumeStatus: 'EVOLVING_L1' },
    securityReason: poison,
  }
}

function closedFixture(root, status = 'CLOSED') {
  const state = {
    kind: 'CampaignState', campaignId: 'closed-campaign', status,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T03:00:00Z',
    closedAt: '2026-01-01T03:00:00Z', activeLevel: null, consecutiveMisses: 0,
    incumbent: {
      candidateId: 'candidate-l1', digest: 'b'.repeat(64),
      validationVerified: 110, validationTotal: 500,
    },
    events: [
      { type: 'BASELINE_FROZEN', at: '2026-01-01T00:00:00Z', candidateId: 'baseline' },
    ],
    candidates: [
      {
        candidateId: 'baseline', parentId: null, level: 'baseline', decision: 'baseline',
        validationVerified: 100, validationTotal: 500, evaluatedAt: '2026-01-01T01:00:00Z',
        testReceipt: { receiptId: 'receipt-0' },
      },
      {
        candidateId: 'candidate-l1', parentId: 'baseline', level: 'l1',
        proposalId: 'proposal-l1', outcome: 'completed', decision: 'promoted',
        validationVerified: 110, validationTotal: 500, evaluatedAt: '2026-01-01T02:00:00Z',
        testReceipt: { receiptId: 'receipt-1' },
      },
    ],
  }
  const calls = { validation: 0, sealed: 0, proposals: [] }
  const store = {
    reportRoot: join(root, 'report'),
    sealedRoot: join(root, 'sealed', 'test'),
    async readState() { return state },
    async readValidationAggregates(receivedState) {
      calls.validation += 1
      assert.equal(receivedState, state)
      return [
        {
          candidateId: 'baseline', verified: 100, total: 500,
          usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          latencyMs: 100,
        },
        {
          candidateId: 'candidate-l1', verified: 110, total: 500,
          usage: { requests: 2, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          latencyMs: 200,
        },
      ]
    },
    async readSealedAggregates(receivedState) {
      calls.sealed += 1
      assert.equal(receivedState, state)
      return [
        {
          candidateId: 'baseline', verified: 40, total: 172,
          usage: { requests: 3, inputTokens: 30, outputTokens: 15, totalTokens: 45 },
          latencyMs: 300,
        },
        {
          candidateId: 'candidate-l1', verified: 44, total: 172,
          usage: { requests: 4, inputTokens: 40, outputTokens: 20, totalTokens: 60 },
          latencyMs: 400,
        },
      ]
    },
    async readProposal(candidateId) {
      calls.proposals.push(candidateId)
      return {
        proposalId: 'proposal-l1', candidateId: 'candidate-l1',
        direction: 'strengthen proof search', createdAt: '2026-01-01T01:10:00Z',
      }
    },
  }
  return { state, store, calls }
}

test('open, paused, and aborted status projections cannot expose hidden data', async (context) => {
  for (const status of ['EVOLVING_L1', 'PAUSED_INFRASTRUCTURE', 'ABORTED_SECURITY']) {
    await context.test(status, async () => {
      const state = openState(status)
      let vaultRead = false
      const store = {
        async readState() { return state },
        async readSealedAggregates() { vaultRead = true; throw new Error('must not run') },
        sealedRoot: '/campaign/sealed/test',
      }
      const output = renderCampaignStatus(await readCampaignStatus(store))
      assert.equal(vaultRead, false)
      assert.equal(output.includes('171'), false)
      assert.equal(output.includes('putnam_'), false)
      assert.equal(output.includes('/sealed/'), false)
      assert.equal(output.includes('sealedPath'), false)
      assert.equal(output.includes('testReceipt'), false)
      assert.equal(output.includes('securityReason'), false)
      assert.equal(JSON.parse(output).reportAvailable, false)
      assert.equal(JSON.parse(output).candidates[0].validationVerified, 100)
    })
  }
})

test('formatCampaignStatus is an allow-list projection, including after closure', () => {
  const state = openState('CLOSED')
  state.closedAt = '2026-01-02T00:00:00Z'
  const status = formatCampaignStatus(state)
  assert.equal(status.kind, 'CampaignStatus')
  assert.equal(status.reportAvailable, true)
  assert.equal(status.closedAt, '2026-01-02T00:00:00Z')
  assert.equal('events' in status, false)
  assert.equal('pause' in status, false)
  assert.equal('testReceipt' in status.candidates[0], false)
})

test('known string fields are fail-safe redacted if state corruption injects hidden material', () => {
  const state = openState()
  state.campaignId = 'test score 171'
  state.candidates[0].candidateId = 'putnam_1962_a1'
  state.incumbent.digest = '/campaign/sealed/test/summary.json'
  const output = renderCampaignStatus(formatCampaignStatus(state))
  assert.equal(output.includes('test score'), false)
  assert.equal(output.includes('putnam_'), false)
  assert.equal(output.includes('/sealed/'), false)
  assert.match(output, /\[REDACTED\]/u)
})

test('renderer re-projects a forged CampaignStatus instead of serializing unknown fields', () => {
  const status = formatCampaignStatus(openState())
  status.testScore = 171
  status.taskId = 'putnam_1962_a1'
  status.sealedPath = '/campaign/sealed/test/summary.json'
  status.candidates[0].testScore = 171
  const output = renderCampaignStatus(status)
  assert.equal(output.includes('171'), false)
  assert.equal(output.includes('putnam_'), false)
  assert.equal(output.includes('/sealed/'), false)
  assert.equal(output.includes('testScore'), false)
})

test('non-terminal report request fails before vault or proposal access', async (context) => {
  for (const status of ['EVOLVING_L2', 'PAUSED_INFRASTRUCTURE', 'ABORTED_SECURITY']) {
    await context.test(status, async () => {
      const calls = []
      const store = {
        async readState() { calls.push('state'); return openState(status) },
        async readSealedAggregates() { calls.push('sealed'); return [] },
        async readProposal() { calls.push('proposal'); return {} },
        reportRoot: '/tmp/report',
      }
      await assert.rejects(() => writeClosedCampaignReport(store), StatusReportError)
      assert.deepEqual(calls, ['state'])
    })
  }
})

test('CLOSED and REPORTED campaigns may generate the four final artifacts', async (context) => {
  for (const status of ['CLOSED', 'REPORTED']) {
    await context.test(status, async () => {
      const root = await mkdtemp(join(tmpdir(), 'status-report-'))
      const { store, calls } = closedFixture(root, status)
      const result = await writeClosedCampaignReport(store)
      assert.equal(calls.validation, 1)
      assert.equal(calls.sealed, 1)
      assert.deepEqual(calls.proposals, ['candidate-l1'])
      assert.deepEqual(Object.keys(result.paths).sort(), [
        'curve.csv', 'curve.json', 'curve.svg', 'improvements.md',
      ])
      const curve = JSON.parse(await readFile(result.paths['curve.json'], 'utf8'))
      assert.equal(curve.points[1].test.verified, 44)
      assert.equal(curve.points[1].validation.usage.totalTokens, 30)
      assert.equal(curve.campaignTotals.combined.usage.requests, 10)
      assert.equal(curve.campaignTotals.combined.latencyMs, 1000)
      assert.equal(curve.campaignStatus, status)
    })
  }
})

test('final report cannot be written inside the sealed vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'status-report-'))
  const { store, calls } = closedFixture(root)
  await assert.rejects(
    () => writeClosedCampaignReport(store, { outputDirectory: join(store.sealedRoot, 'report') }),
    /outside the sealed vault/u,
  )
  assert.equal(calls.validation, 0)
  assert.equal(calls.sealed, 0)
  assert.deepEqual(calls.proposals, [])
})
