import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  closeCampaign,
  createCampaignState,
  freezeBaseline,
  recordBaselineEvaluation,
} from '../src/campaign.mjs'
import { CampaignStore, redactSecrets } from '../src/campaign-store.mjs'
import { ProtocolError } from '../src/protocol.mjs'

const DIGEST = 'a'.repeat(64)

function usage(requests, inputTokens, outputTokens, totalTokens, transientRetries = 0) {
  return {
    requests,
    upstreamAttempts: requests + transientRetries,
    transientRetries,
    inputTokens,
    outputTokens,
    totalTokens,
  }
}

function makeSealedRecords() {
  return Array.from({ length: 172 }, (_, index) => ({
    instanceId: `putnam_${String(3000 + index)}_a1`,
    status: index < 170 ? 'resolved' : 'unresolved',
    latencyMs: index === 0 ? 25 : 0,
    output: index === 0 ? 'SECRET-VALUE' : '',
  }))
}

test('redaction recursively removes runtime credentials', () => {
  assert.deepEqual(redactSecrets({ nested: ['before SECRET-VALUE after'] }, ['SECRET-VALUE']), {
    nested: ['before [REDACTED] after'],
  })
})

test('store keeps test aggregate sealed until CLOSED and returns opaque receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-'))
  const store = new CampaignStore(root, 'campaign')
  let state = createCampaignState({ campaignId: 'campaign', configFingerprint: DIGEST, at: '2026-01-01T00:00:00Z' })
  await store.initialize({
    config: { spec: { partitions: { test: { sha256: DIGEST } } } },
    state,
  })
  state = freezeBaseline(state, { candidateId: 'baseline', digest: DIGEST, at: '2026-01-01T00:00:01Z' })
  await store.writeValidation('baseline', {
    summary: {
      candidateId: 'baseline', verified: 400, total: 500,
      completedAt: '2026-01-01T00:00:59Z',
      usage: usage(2, 20, 10, 30, 1),
    },
    records: [{ latencyMs: 11 }, { latencyMs: 19 }],
  })
  const receipt = await store.sealTest('baseline', {
    summary: {
      candidateId: 'baseline', verified: 170, total: 172,
      completedAt: '2026-01-01T00:01:00Z',
      usage: usage(3, 30, 15, 45, 2),
    },
    records: makeSealedRecords(),
    testManifestSha256: DIGEST,
  }, ['SECRET-VALUE'])
  assert.deepEqual(Object.keys(receipt).sort(), ['candidateId', 'completedAt', 'receiptId', 'status'])
  state = recordBaselineEvaluation(state, {
    validationVerified: 400, validationTotal: 500, testReceipt: receipt, at: '2026-01-01T00:01:01Z',
  })
  await store.saveState(state)
  await assert.rejects(() => store.readSealedAggregates(state), /CLOSED/u)
  await assert.rejects(() => store.readValidationAggregates({ ...state, status: 'CLOSED' }), /CLOSED/u)
  await assert.rejects(() => store.readSealedAggregates({ ...state, status: 'CLOSED' }), /CLOSED/u)
  await assert.rejects(
    () => readFile(join(store.publicRoot, 'candidates', 'baseline', 'test-summary.json'), 'utf8'),
  )
  const sealedRecords = await readFile(join(store.sealedRoot, 'baseline', 'records.jsonl'), 'utf8')
  assert.equal(sealedRecords.includes('SECRET-VALUE'), false)

  state = { ...state, status: 'CLOSING' }
  state = closeCampaign(state, { at: '2026-01-02T00:00:00Z' })
  await store.saveState(state)
  const validationAggregates = await store.readValidationAggregates(state)
  assert.deepEqual(validationAggregates[0], {
    candidateId: 'baseline', verified: 400, total: 500,
    usage: usage(2, 20, 10, 30, 1),
    latencyMs: 30,
    completedAt: '2026-01-01T00:00:59Z',
  })
  const aggregates = await store.readSealedAggregates(state)
  assert.equal(aggregates[0].verified, 170)
  assert.deepEqual(aggregates[0].usage, {
    requests: 3, upstreamAttempts: 5, transientRetries: 2,
    inputTokens: 30, outputTokens: 15, totalTokens: 45,
  })
  assert.equal(aggregates[0].latencyMs, 25)

  const summaryPath = join(store.sealedRoot, 'baseline', 'summary.json')
  const originalSummary = await readFile(summaryPath, 'utf8')
  await writeFile(summaryPath, originalSummary.replace('"verified": 170', '"verified": 169'))
  await assert.rejects(() => store.readSealedAggregates(state), /内容.*不一致/u)
  await writeFile(summaryPath, originalSummary)

  const recordsPath = join(store.sealedRoot, 'baseline', 'records.jsonl')
  const originalRecords = await readFile(recordsPath, 'utf8')
  await writeFile(recordsPath, originalRecords.replace('"latencyMs":25', '"latencyMs":26'))
  await assert.rejects(() => store.readSealedAggregates(state), /内容.*不一致/u)
  await writeFile(recordsPath, originalRecords)

  const traceTamperPath = join(store.sealedRoot, 'baseline', 'traces', 'tampered.jsonl')
  await writeFile(traceTamperPath, 'tampered\n')
  await assert.rejects(() => store.readSealedAggregates(state), /内容.*不一致/u)
  await rm(traceTamperPath)

  const mismatched = structuredClone(state)
  mismatched.candidates[0].testReceipt.receiptId = 'forged-receipt'
  await assert.rejects(() => store.readSealedAggregates(mismatched), /不一致/u)

  await writeFile(
    join(store.sealedRoot, 'baseline', 'receipt.internal.json'),
    `${JSON.stringify({ receipt: { ...receipt, receiptId: 'tampered-receipt' } })}\n`,
  )
  await assert.rejects(() => store.readSealedAggregates(state), /internal receipt/iu)
})

test('public state rejects test score fields and event history rewrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-'))
  const store = new CampaignStore(root, 'campaign')
  const state = createCampaignState({ campaignId: 'campaign', configFingerprint: DIGEST, at: '2026-01-01T00:00:00Z' })
  await store.initialize({ config: {}, state })
  await assert.rejects(
    () => store.saveState({ ...state, candidates: [{ candidateId: 'x', testScore: 1, testReceipt: null }] }),
    ProtocolError,
  )
  const rewritten = structuredClone(state)
  rewritten.events[0].type = 'TAMPERED'
  await assert.rejects(() => store.saveState(rewritten), /只能追加/u)
})

test('state is authoritative when derivative event-log rebuild crashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-events-'))
  const store = new CampaignStore(root, 'campaign')
  const initial = createCampaignState({
    campaignId: 'campaign', configFingerprint: DIGEST, at: '2026-01-01T00:00:00Z',
  })
  await store.initialize({ config: {}, state: initial })
  const next = freezeBaseline(initial, {
    candidateId: 'baseline', digest: DIGEST, at: '2026-01-01T00:00:01Z',
  })
  const eventsPath = join(store.publicRoot, 'events.jsonl')
  await rm(eventsPath)
  await mkdir(eventsPath)

  await assert.rejects(() => store.saveState(next))
  assert.deepEqual(await store.readState(), next)

  await rm(eventsPath, { recursive: true })
  await store.saveState(await store.readState())
  const events = (await readFile(eventsPath, 'utf8')).trimEnd().split('\n').map(JSON.parse)
  assert.deepEqual(events, next.events)
})

test('proposal and mutation bundle use atomic write-once commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-bundle-'))
  const store = new CampaignStore(root, 'campaign')
  const state = createCampaignState({
    campaignId: 'campaign', configFingerprint: DIGEST, at: '2026-01-01T00:00:00Z',
  })
  await store.initialize({ config: {}, state })
  const proposal = { proposalId: 'p1', direction: 'first' }
  await store.writeProposal('candidate', proposal)
  assert.deepEqual(await store.readProposalIfExists('candidate'), proposal)
  await assert.rejects(() => store.writeProposal('candidate', { ...proposal, direction: 'replace' }), /已冻结/u)
  assert.deepEqual(await store.readProposal('candidate'), proposal)

  const bundle = { kind: 'MutationBundle', candidateId: 'candidate', value: 1 }
  await store.writeMutationBundle('candidate', bundle)
  assert.deepEqual(await store.readMutationBundleIfExists('candidate'), bundle)
  await assert.rejects(() => store.writeMutationBundle('candidate', { ...bundle, value: 2 }), /已冻结/u)
  assert.deepEqual(await store.readMutationBundleIfExists('candidate'), bundle)
})

test('validation traces are persisted incrementally under the trusted validation root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-trace-'))
  const store = new CampaignStore(root, 'trace-campaign')
  const state = createCampaignState({
    campaignId: 'trace-campaign',
    configFingerprint: DIGEST,
    at: '2026-01-01T00:00:00Z',
  })
  await store.initialize({ config: { frozen: true }, state })

  const traceRef = await store.writeValidationTrace(
    'baseline',
    'task-opaque',
    'before sk-example-secret-value after',
    ['sk-example-secret-value'],
  )
  assert.equal(traceRef, 'traces/task-opaque.jsonl')
  assert.equal(
    await readFile(join(store.validationRoot, 'baseline', traceRef), 'utf8'),
    'before [REDACTED] after',
  )

  const checkpoint = {
    instanceId: 'putnam_2000_a1',
    status: 'resolved',
    traceRef,
    usage: usage(1, 50, 72, 123, 1),
  }
  await store.writeValidationCheckpoint('baseline', checkpoint)
  assert.deepEqual(await store.readValidationCheckpoints('baseline'), [checkpoint])
  await assert.rejects(
    () => store.writeValidationCheckpoint('baseline', {
      instanceId: 'putnam_2000_a2', status: 'error',
    }),
    /checkpoint record/u,
  )
  for (const missing of ['upstreamAttempts', 'transientRetries']) {
    const invalidUsage = usage(1, 1, 1, 2)
    delete invalidUsage[missing]
    await assert.rejects(
      () => store.writeValidationCheckpoint('baseline', {
        instanceId: 'putnam_2000_a2', status: 'resolved', usage: invalidUsage,
      }),
      new RegExp(`usage\\.${missing}`, 'u'),
    )
  }
})

test('Updater feedback is absolute-time-free while relative validation timing remains available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-feedback-view-'))
  const store = new CampaignStore(root, 'feedback-view')
  let state = createCampaignState({
    campaignId: 'feedback-view', configFingerprint: DIGEST, at: '2026-03-01T00:00:00Z',
  })
  await store.initialize({
    config: { spec: { partitions: { test: { sha256: DIGEST } } } },
    state,
  })
  state = freezeBaseline(state, {
    candidateId: 'baseline', digest: DIGEST, at: '2026-03-01T00:00:01Z',
  })
  await store.writeValidation('baseline', {
    summary: {
      candidateId: 'baseline', verified: 321, total: 500,
      completedAt: '2026-03-01T01:02:03Z',
      usage: usage(500, 1, 2, 3, 2),
    },
    records: [{
      instanceId: 'putnam_2000_a1',
      status: 'unresolved',
      failureKind: 'candidate',
      solverStatus: 'candidate_error',
      verifierStatus: 'not_attempted',
      attempts: 2,
      verifierAttempts: 0,
      traceRef: 'traces/opaque-task.jsonl',
      startedAt: '2026-03-01T01:00:00Z',
      latencyMs: 123_456,
      usage: usage(16, 600, 399, 999, 2),
    }],
    traces: {
      'opaque-task': [
        JSON.stringify({
          timestamp: '2026-03-01T01:01:01Z',
          solverAttempt: 2,
          solver: {
            timing: {
              startedAt: '2026-03-01T01:00:00Z',
              endedAt: '2026-03-01T01:00:10Z',
              durationMs: 10_000,
            },
            stdout: 'trace-grounded reasoning survives',
          },
        }),
        'plain trace at 2026-03-01T01:01:02+00:00',
        '',
      ].join('\n'),
    },
  })
  await store.writeValidationTrace(
    'baseline',
    'orphan-infrastructure-attempt',
    '{"failureKind":"infrastructure"}\n',
  )
  const receipt = await store.sealTest('baseline', {
    summary: {
      candidateId: 'baseline', verified: 100, total: 172,
      completedAt: '2026-03-01T09:09:09Z',
    },
    records: makeSealedRecords(),
    testManifestSha256: DIGEST,
  })
  state = recordBaselineEvaluation(state, {
    validationVerified: 321,
    validationTotal: 500,
    testReceipt: receipt,
    at: '2026-03-01T09:09:10Z',
  })
  await store.saveState(state)

  // Model the raw validation tree retaining its actual completion-time mtime;
  // this trusted tree must never be the Updater mount.
  const rawSummaryPath = join(store.validationRoot, 'baseline', 'summary.json')
  await utimes(rawSummaryPath, new Date('2026-03-01T01:02:03Z'), new Date('2026-03-01T01:02:03Z'))
  assert.notEqual(store.validationRoot, store.feedbackRoot)

  assert.equal(await store.prepareUpdaterFeedbackProjection(), store.feedbackRoot)
  await store.grantFeedbackAccess(process.getgid())
  const projectedSummaryPath = join(store.feedbackRoot, 'baseline', 'summary.json')
  assert.deepEqual(JSON.parse(await readFile(projectedSummaryPath, 'utf8')), {
    candidateId: 'baseline', verified: 321, total: 500,
    usage: usage(500, 1, 2, 3, 2),
  })
  const projectedRecord = JSON.parse((await readFile(
    join(store.feedbackRoot, 'baseline', 'records.jsonl'),
    'utf8',
  )).trim())
  assert.deepEqual(Object.keys(projectedRecord).sort(), [
    'attempts', 'failureKind', 'instanceId', 'latencyMs', 'solverStatus',
    'status', 'traceRef', 'usage', 'verifierAttempts', 'verifierStatus',
  ])
  assert.equal(projectedRecord.latencyMs, 123_456)
  assert.deepEqual(projectedRecord.usage, usage(16, 600, 399, 999, 2))
  const projectedTrace = await readFile(
    join(store.feedbackRoot, 'baseline', 'traces', 'opaque-task.jsonl'),
    'utf8',
  )
  assert.match(projectedTrace, /trace-grounded reasoning survives/u)
  assert.match(projectedTrace, /\[NORMALIZED_TIME\]/u)
  assert.match(projectedTrace, /"timing":\{"durationMs":10000\}/u)
  await assert.rejects(
    () => readFile(
      join(store.feedbackRoot, 'baseline', 'traces', 'orphan-infrastructure-attempt.jsonl'),
      'utf8',
    ),
    (error) => error.code === 'ENOENT',
  )
  assert.doesNotMatch(
    `${await readFile(projectedSummaryPath, 'utf8')}\n${JSON.stringify(projectedRecord)}\n${projectedTrace}`,
    /2026-03-01|completedAt|startedAt|endedAt|timestamp/iu,
  )

  const visit = async (directory) => {
    const paths = [directory]
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) paths.push(...await visit(path))
      else paths.push(path)
    }
    return paths
  }
  for (const path of await visit(store.feedbackRoot)) {
    assert.equal((await stat(path)).mtime.toISOString(), '2000-01-01T00:00:00.000Z')
  }
  assert.equal((await stat(rawSummaryPath)).mtime.toISOString(), '2026-03-01T01:02:03.000Z')
  assert.equal(
    JSON.parse(await readFile(rawSummaryPath, 'utf8')).completedAt,
    '2026-03-01T01:02:03Z',
  )
})
