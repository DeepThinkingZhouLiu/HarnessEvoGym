import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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

function state(campaignId = 'campaign') {
  return createCampaignState({
    campaignId,
    configFingerprint: DIGEST,
    at: '2026-01-01T00:00:00Z',
  })
}

test('redaction recursively removes runtime credentials', () => {
  assert.deepEqual(redactSecrets({ nested: ['before SECRET-VALUE after'] }, ['SECRET-VALUE']), {
    nested: ['before [REDACTED] after'],
  })
})

test('store keeps test aggregates sealed until campaign closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-sealed-'))
  const store = new CampaignStore(root, 'campaign')
  let current = state()
  await store.initialize({
    config: { spec: { partitions: {
      validation: { expectedCount: 2 },
      test: { expectedCount: 2, sha256: DIGEST },
    } } },
    state: current,
  })
  current = freezeBaseline(current, {
    candidateId: 'baseline', digest: DIGEST, at: '2026-01-01T00:00:01Z',
  })
  await store.writeValidation('baseline', {
    summary: {
      candidateId: 'baseline', verified: 1, total: 2,
      completedAt: '2026-01-01T00:00:02Z',
      usage: { requests: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    records: [{ latencyMs: 7 }, { latencyMs: 8 }],
  })
  const receipt = await store.sealTest('baseline', {
    summary: {
      candidateId: 'baseline', verified: 1, total: 2,
      completedAt: '2026-01-01T00:00:03Z',
      usage: { requests: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    records: [
      { instanceId: 'putnam_3000_a1', status: 'resolved', latencyMs: 1 },
      { instanceId: 'putnam_3001_a1', status: 'unresolved', latencyMs: 2 },
    ],
    testManifestSha256: DIGEST,
  })
  current = recordBaselineEvaluation(current, {
    validationVerified: 1,
    validationTotal: 2,
    testReceipt: receipt,
    at: '2026-01-01T00:00:04Z',
  })
  await store.saveState(current)
  await assert.rejects(() => store.readSealedAggregates(current), /CLOSED/u)
  current = closeCampaign({ ...current, status: 'CLOSING' }, {
    at: '2026-01-01T00:00:05Z',
  })
  await store.saveState(current)
  assert.equal((await store.readValidationAggregates(current))[0].verified, 1)
  assert.equal((await store.readSealedAggregates(current))[0].verified, 1)
})

test('state is authoritative and event history cannot be rewritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-state-'))
  const store = new CampaignStore(root, 'campaign')
  const initial = state()
  await store.initialize({ config: {}, state: initial })
  const rewritten = structuredClone(initial)
  rewritten.events[0].type = 'TAMPERED'
  await assert.rejects(() => store.saveState(rewritten), /只能追加/u)

  const frozen = freezeBaseline(initial, {
    candidateId: 'baseline', digest: DIGEST, at: '2026-01-01T00:00:01Z',
  })
  const eventsPath = join(store.publicRoot, 'events.jsonl')
  await rm(eventsPath)
  await mkdir(eventsPath)
  await assert.rejects(() => store.saveState(frozen))
  assert.deepEqual(await store.readState(), frozen)
})

test('mutation artifact is write-once and evolution log is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-mutation-'))
  const store = new CampaignStore(root, 'campaign')
  await store.initialize({
    config: { spec: { partitions: {
      validation: { expectedCount: 1 },
      test: { expectedCount: 1, sha256: DIGEST },
    } } },
    state: state(),
  })
  const mutation = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'UpdaterMutation',
    candidateId: 'c0001-l1',
    commit: 'b'.repeat(40),
  }
  await store.writeMutationArtifact('c0001-l1', mutation)
  assert.deepEqual(await store.readMutationArtifactIfExists('c0001-l1'), mutation)
  await assert.rejects(
    () => store.writeMutationArtifact('c0001-l1', { ...mutation, commit: 'c'.repeat(40) }),
    /已存在/u,
  )

  const log = { candidateId: 'c0001-l1', commit: mutation.commit, validationScore: 6 }
  await store.appendEvolutionLog(log)
  await store.appendEvolutionLog(log)
  assert.deepEqual(await store.readEvolutionLog(), [log])
  await assert.rejects(
    () => store.appendEvolutionLog({ ...log, validationScore: 7 }),
    /内容不同/u,
  )
})

test('updater reads validation and evolution history directly without a copied projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-feedback-'))
  const store = new CampaignStore(root, 'campaign')
  await store.initialize({
    config: { spec: { partitions: {
      validation: { expectedCount: 1 },
      test: { expectedCount: 1, sha256: DIGEST },
    } } },
    state: state(),
  })
  await store.writeValidation('baseline', {
    summary: {
      candidateId: 'baseline', verified: 1, total: 1,
      completedAt: '2026-01-01T00:00:01Z',
    },
    records: [{
      instanceId: 'putnam_2000_a1',
      status: 'resolved',
      latencyMs: 123,
    }],
    traces: { task: 'reasoning trace\n' },
  })
  await store.appendEvolutionLog({ candidateId: 'baseline', validationScore: 1 })
  await store.grantValidationAccess('baseline', process.getgid())
  await store.grantEvolutionLogAccess(process.getgid())

  const summaryPath = join(store.validationRoot, 'baseline', 'summary.json')
  assert.equal(JSON.parse(await readFile(summaryPath, 'utf8')).completedAt, '2026-01-01T00:00:01Z')
  assert.equal(
    await readFile(join(store.validationRoot, 'baseline', 'traces', 'task.jsonl'), 'utf8'),
    'reasoning trace\n',
  )
  assert.deepEqual(await store.readEvolutionLog(), [{ candidateId: 'baseline', validationScore: 1 }])
  assert.equal((await stat(summaryPath)).mode & 0o777, 0o440)
  assert.equal((await stat(store.evolutionLogPath)).mode & 0o777, 0o440)
  assert.equal('feedbackRoot' in store, false)
})

test('public state rejects test score fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-store-public-'))
  const store = new CampaignStore(root, 'campaign')
  const initial = state()
  await store.initialize({ config: {}, state: initial })
  await assert.rejects(
    () => store.saveState({
      ...initial,
      candidates: [{ candidateId: 'x', testScore: 1, testReceipt: null }],
    }),
    ProtocolError,
  )
})
