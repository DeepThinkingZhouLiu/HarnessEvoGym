import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertOpaqueTestReceipt,
  closeCampaign,
  createCampaignState,
  freezeBaseline,
  loadEvolutionCampaign,
  recordBaselineEvaluation,
  recordCandidateEvaluation,
} from '../src/campaign.mjs'
import { ProtocolError } from '../src/protocol.mjs'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

function receipt(candidateId, ordinal = 1) {
  return {
    receiptId: `sealed-${ordinal}`,
    candidateId,
    status: 'sealed',
    completedAt: `2026-01-01T00:00:0${ordinal}Z`,
  }
}

function evolvingState() {
  let state = createCampaignState({
    campaignId: 'test-campaign',
    configFingerprint: DIGEST_A,
    at: '2026-01-01T00:00:00Z',
  })
  state = freezeBaseline(state, {
    candidateId: 'baseline',
    digest: DIGEST_A,
    at: '2026-01-01T00:00:01Z',
  })
  return recordBaselineEvaluation(state, {
    validationVerified: 100,
    validationTotal: 500,
    testReceipt: receipt('baseline'),
    at: '2026-01-01T00:00:02Z',
  })
}

function candidate(state, id, score, ordinal) {
  return {
    candidateId: id,
    parentId: state.incumbent.candidateId,
    level: state.activeLevel,
    digest: DIGEST_B,
    proposalId: `proposal-${id}`,
    validationVerified: score,
    validationTotal: 500,
    testReceipt: receipt(id, ordinal),
    at: `2026-01-01T00:00:${10 + ordinal}Z`,
  }
}

test('strict improvement promotes and resets patience', () => {
  let state = evolvingState()
  state = recordCandidateEvaluation(state, candidate(state, 'candidate-1', 100, 2))
  assert.equal(state.incumbent.candidateId, 'baseline')
  assert.equal(state.consecutiveMisses, 1)

  state = recordCandidateEvaluation(state, candidate(state, 'candidate-2', 101, 3))
  assert.equal(state.incumbent.candidateId, 'candidate-2')
  assert.equal(state.consecutiveMisses, 0)
  assert.equal(state.activeLevel, 'l1')
})

test('three misses advance L1 to L2 and preserve incumbent', () => {
  let state = evolvingState()
  for (let index = 1; index <= 3; index += 1) {
    state = recordCandidateEvaluation(state, candidate(state, `candidate-${index}`, 99, index + 1))
  }
  assert.equal(state.status, 'EVOLVING_L2')
  assert.equal(state.activeLevel, 'l2')
  assert.equal(state.consecutiveMisses, 0)
  assert.equal(state.incumbent.candidateId, 'baseline')
})

test('three misses at every level close without consulting test score', () => {
  let state = evolvingState()
  let ordinal = 1
  for (const level of ['l1', 'l2', 'l3']) {
    assert.equal(state.activeLevel, level)
    for (let miss = 0; miss < 3; miss += 1) {
      ordinal += 1
      state = recordCandidateEvaluation(
        state,
        candidate(state, `${level}-${miss}`, state.incumbent.validationVerified, ordinal),
      )
    }
  }
  assert.equal(state.status, 'CLOSING')
  assert.equal(state.activeLevel, null)
  state = closeCampaign(state, { at: '2026-01-02T00:00:00Z' })
  assert.equal(state.status, 'CLOSED')
})

test('test receipt rejects result-bearing fields', () => {
  assert.throws(
    () => assertOpaqueTestReceipt({ ...receipt('candidate'), score: 170 }, 'candidate'),
    (error) => error instanceof ProtocolError && /泄漏/u.test(error.message),
  )
  assert.throws(
    () => assertOpaqueTestReceipt({ ...receipt('candidate'), digest: DIGEST_A }, 'candidate'),
    ProtocolError,
  )
})

test('campaign loader reads validation but never opens or materializes sealed test IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-test-'))
  const validation = `${Array.from(
    { length: 500 },
    (_, index) => `putnam_${String(2000 + index)}_a1`,
  ).join('\n')}\n`
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  await writeFile(join(directory, 'validation.ids'), validation)
  const config = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionCampaign',
    metadata: { id: 'x', name: 'x' },
    spec: {
      source: {
        dataset: 'x', revision: 'a'.repeat(40), leanVersion: 'v4.27.0',
        mathlibRevision: 'b'.repeat(40),
      },
      partitions: {
        validation: { manifest: 'validation.ids', expectedCount: 500, sha256: sha(validation), visibility: 'feedback' },
        // Deliberately absent. Only the sealed broker child may open this path.
        test: { manifest: 'test.ids', expectedCount: 172, sha256: DIGEST_B, visibility: 'sealed-until-closed' },
      },
      evolution: {
        levels: ['l1', 'l2', 'l3'], consecutiveMissesBeforeAdvance: 3,
        promotion: 'strict-validation-verified-count', evaluateTestForEveryCandidate: true,
      },
      solver: {
        targetRevision: 'c'.repeat(40), profile: 'headless', preset: 'standard',
        api: 'openai-responses', model: 'gpt-5.6-sol', reasoningEffort: 'max',
      },
    },
  }
  const configPath = join(directory, 'campaign.json')
  await writeFile(configPath, JSON.stringify(config))
  const loaded = await loadEvolutionCampaign(configPath)
  assert.equal(loaded.manifests.validation.length, 500)
  assert.equal(Object.hasOwn(loaded.manifests, 'test'), false)
  assert.equal(JSON.stringify(loaded).includes('putnam_1963_a1'), false)

  const escaped = structuredClone(config)
  escaped.spec.partitions.test.manifest = '../test.ids'
  await writeFile(configPath, JSON.stringify(escaped))
  await assert.rejects(
    () => loadEvolutionCampaign(configPath),
    (error) => error instanceof ProtocolError
      && /manifest 校验失败/u.test(error.message)
      && !error.details.some((detail) => /putnam_/u.test(detail)),
  )
})
