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
  startCandidateRound,
  stopEvolutionByUpdater,
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

function softEvolvingState() {
  let state = createCampaignState({
    campaignId: 'soft-campaign',
    configFingerprint: DIGEST_A,
    at: '2026-01-01T00:00:00Z',
    layerSelection: 'updater-soft',
  })
  state = freezeBaseline(state, {
    candidateId: 'baseline', digest: DIGEST_A, commit: 'a'.repeat(40),
    at: '2026-01-01T00:00:01Z',
  })
  return recordBaselineEvaluation(state, {
    validationVerified: 100,
    validationTotal: 500,
    testReceipt: null,
    at: '2026-01-01T00:00:02Z',
  })
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

test('a scheduled-off candidate records validation without a test receipt', () => {
  const state = evolvingState()
  const input = candidate(state, 'candidate-1', 100, 2)
  delete input.testReceipt
  input.testEvaluated = false
  const next = recordCandidateEvaluation(state, input)
  assert.equal(next.candidates[1].testEvaluated, false)
  assert.equal(Object.hasOwn(next.candidates[1], 'testReceipt'), false)
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

test('soft layers let the updater choose each round without Controller miss transitions', () => {
  let state = softEvolvingState()
  assert.equal(state.status, 'EVOLVING')
  assert.equal(state.activeLevel, null)
  assert.equal(Object.hasOwn(state, 'consecutiveMisses'), false)

  const attempts = [
    ['l1', 100],
    ['l2', 99],
    ['l1', 101],
    ['l3', 100],
    ['l2', 101],
  ]
  attempts.forEach(([level, score], index) => {
    state = recordCandidateEvaluation(state, {
      candidateId: `soft-${index + 1}`,
      parentId: state.incumbent.candidateId,
      level,
      digest: DIGEST_B,
      commit: String(index + 1).repeat(40),
      validationVerified: score,
      validationTotal: 500,
      testEvaluated: false,
      at: `2026-01-01T00:01:0${index}Z`,
    })
  })
  assert.equal(state.status, 'EVOLVING')
  assert.equal(state.incumbent.validationVerified, 101)
  assert.deepEqual(state.candidates.slice(1).map((entry) => entry.level), [
    'l1', 'l2', 'l1', 'l3', 'l2',
  ])
  assert.equal(Object.hasOwn(state, 'consecutiveMisses'), false)
})

test('soft-layer updater may explicitly stop an otherwise unbounded campaign', () => {
  let state = softEvolvingState()
  state = startCandidateRound(state, {
    candidateId: 'soft-stop', at: '2026-01-01T00:02:00Z',
  })
  state = stopEvolutionByUpdater(state, {
    candidateId: 'soft-stop', reason: 'no evidence-backed mutation remains',
    at: '2026-01-01T00:02:01Z',
  })
  assert.equal(state.status, 'CLOSING')
  assert.equal(state.inFlight, null)
  assert.equal(state.events.at(-1).type, 'UPDATER_STOPPED')
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

test('HLE loader accepts configurable validation size without opening test IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hle-campaign-test-'))
  const validation = `${Array.from(
    { length: 50 },
    (_, index) => `hle_${index.toString(16).padStart(24, '0')}`,
  ).join('\n')}\n`
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  await writeFile(join(directory, 'validation.ids'), validation)
  const config = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionCampaign',
    metadata: { id: 'hle-test', name: 'HLE test' },
    spec: {
      source: {
        format: 'hle-text-math', dataset: 'cais/hle', revision: 'a'.repeat(40),
        filter: { category: 'Math', textOnly: true },
      },
      partitions: {
        validation: {
          manifest: 'validation.ids', expectedCount: 50,
          sha256: sha(validation), visibility: 'feedback',
        },
        test: {
          manifest: 'missing-sealed-test.ids', expectedCount: 50,
          sha256: DIGEST_B, visibility: 'sealed-until-closed',
        },
      },
      evolution: {
        levels: ['l1', 'l2', 'l3'], consecutiveMissesBeforeAdvance: 3,
        promotion: 'strict-validation-verified-count',
      },
      scoring: {
        method: 'trusted-llm-judge', judgeModel: 'gpt-5.6-sol',
        judgeReasoningEffort: 'low', exposeValidationTrace: true,
        exposeTestDetails: false,
      },
      solver: {
        targetRevision: 'c'.repeat(40), profile: 'headless', preset: 'minimal',
        api: 'openai-responses', model: 'gpt-5.6-sol', reasoningEffort: 'max',
      },
    },
  }
  const configPath = join(directory, 'campaign.json')
  await writeFile(configPath, JSON.stringify(config))
  const loaded = await loadEvolutionCampaign(configPath)
  assert.equal(loaded.config.spec.source.format, 'hle-text-math')
  assert.equal(loaded.config.spec.solver.preset, 'minimal')
  assert.equal(loaded.manifests.validation.length, 50)
  assert.equal(loaded.config.spec.evolution.testEvaluationInterval, 5)
  assert.equal(Object.hasOwn(loaded.manifests, 'test'), false)

  config.spec.solver.reasoningEffort = 'high'
  await writeFile(configPath, JSON.stringify(config))
  const highEffort = await loadEvolutionCampaign(configPath)
  assert.equal(highEffort.config.spec.solver.reasoningEffort, 'high')

  const validationTen = `${validation.trimEnd().split('\n').slice(0, 10).join('\n')}\n`
  await writeFile(join(directory, 'validation.ids'), validationTen)
  config.spec.partitions.validation.expectedCount = 10
  config.spec.partitions.validation.sha256 = sha(validationTen)
  config.spec.evolution.testEvaluationInterval = 0
  await writeFile(configPath, JSON.stringify(config))
  const validationOnly = await loadEvolutionCampaign(configPath)
  assert.equal(validationOnly.manifests.validation.length, 10)
  assert.equal(validationOnly.config.spec.evolution.testEvaluationInterval, 0)

  delete config.spec.evolution.consecutiveMissesBeforeAdvance
  config.spec.evolution.layerSelection = 'updater-soft'
  await writeFile(configPath, JSON.stringify(config))
  const softLayers = await loadEvolutionCampaign(configPath)
  assert.equal(softLayers.config.spec.evolution.layerSelection, 'updater-soft')

  config.spec.evolution.consecutiveMissesBeforeAdvance = 3
  await writeFile(configPath, JSON.stringify(config))
  await assert.rejects(
    () => loadEvolutionCampaign(configPath),
    (error) => error instanceof ProtocolError && error.details.some((detail) => /不能配置/u.test(detail)),
  )
})
