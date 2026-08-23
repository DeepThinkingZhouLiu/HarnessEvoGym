import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBenchmark, validateEvaluationPolicy, validateEvolutionLedger } from '../src/protocol.mjs'

function benchmarkFixture() {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'Benchmark',
    metadata: { id: 'fixture', name: 'Fixture' },
    spec: {
      source: {
        adapter: 'swe-bench',
        dataset: 'local/fixture',
        split: 'test',
        revision: 'fixture-v1',
      },
      evaluator: {
        adapter: 'swe-bench',
        resultFormat: 'harness-rsi/solver-result-jsonl-v1',
      },
      partitions: {
        feedback: { visibility: 'detailed', instanceIds: ['repo__one-1'] },
        selection: { visibility: 'aggregate-only', instanceIds: ['repo__two-1'] },
        final: { visibility: 'sealed', instanceIds: ['repo__three-1'] },
      },
      expectedTotal: 3,
    },
  }
}

test('Benchmark 校验返回三个互斥 Partition', () => {
  const benchmark = validateBenchmark(benchmarkFixture())
  assert.equal(benchmark.expectedTotal, 3)
  assert.deepEqual(benchmark.partitions.final.instanceIds, ['repo__three-1'])
})

test('Benchmark 校验拒绝跨 Partition 重复 Instance', () => {
  const fixture = benchmarkFixture()
  fixture.spec.partitions.final.instanceIds = ['repo__two-1']
  assert.throws(() => validateBenchmark(fixture), /Benchmark 配置校验失败/u)
})

test('Benchmark 校验拒绝移动数据版本', () => {
  const fixture = benchmarkFixture()
  fixture.spec.source.revision = 'main'
  assert.throws(() => validateBenchmark(fixture), /Benchmark 配置校验失败/u)
})

test('Evaluation Policy 校验补全强类型配置', () => {
  const policy = validateEvaluationPolicy({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvaluationPolicy',
    metadata: { id: 'policy' },
    spec: {
      decisionPartition: 'selection',
      bootstrap: { samples: 1000, confidence: 0.95, seed: 1 },
      gates: {
        coverage: { minimumRecords: 1, minimumCompletion: 1 },
        quality: {
          minimumNetResolved: 1,
          minimumDeltaResolvedRate: 0,
          maximumRegressions: 0,
          requirePositivePairedCiLowerBound: false,
        },
        cost: {
          maximumRelativeInferenceCostIncrease: null,
          maximumEvolutionCostUsd: null,
        },
        safety: { maximumPolicyViolations: 0 },
      },
    },
  })
  assert.equal(policy.decisionPartition, 'selection')
  assert.equal(policy.gates.coverage.minimumRecords, 1)
  assert.equal(policy.gates.coverage.minimumCompletion, 1)
})

test('Evaluation Policy 拒绝把 final 用作晋升决策集', () => {
  const fixture = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvaluationPolicy',
    metadata: { id: 'unsafe-policy' },
    spec: {
      decisionPartition: 'final',
      bootstrap: { samples: 1000, confidence: 0.95, seed: 1 },
      gates: {
        coverage: { minimumRecords: 1, minimumCompletion: 1 },
        quality: {
          minimumNetResolved: 1,
          minimumDeltaResolvedRate: 0,
          maximumRegressions: 0,
          requirePositivePairedCiLowerBound: false,
        },
        cost: {
          maximumRelativeInferenceCostIncrease: null,
          maximumEvolutionCostUsd: null,
        },
        safety: { maximumPolicyViolations: 0 },
      },
    },
  }
  assert.throws(() => validateEvaluationPolicy(fixture), /Evaluation Policy 校验失败/u)
})

test('Solver Result v2 接受连续 Reward 与重复 Trial', async () => {
  const { validateResultRecords } = await import('../src/protocol.mjs')
  const benchmark = validateBenchmark(benchmarkFixture())
  const records = validateResultRecords([
    {
      instance_id: 'repo__one-1',
      status: 'unresolved',
      reward: 0.5,
      trial_rewards: [0.25, 0.75],
      trial_seeds: [1, 2],
      seed_controlled: false,
      feedback: { verifierFeedback: '部分通过' },
    },
  ], benchmark, 'Candidate')
  assert.equal(records.get('repo__one-1').reward, 0.5)
  assert.deepEqual(records.get('repo__one-1').trialRewards, [0.25, 0.75])
})

test('非 feedback Partition 禁止携带逐题反馈', async () => {
  const { validateResultRecords } = await import('../src/protocol.mjs')
  const benchmark = validateBenchmark(benchmarkFixture())
  assert.throws(() => validateResultRecords([
    {
      instance_id: 'repo__two-1',
      status: 'unresolved',
      reward: 0,
      feedback: { verifierFeedback: '不应泄漏' },
    },
  ], benchmark, 'Candidate'), /Solver Result 校验失败/u)
})

test('Evolution Ledger 用 null 表示未采集 Token，不伪装成零消耗', () => {
  const ledger = validateEvolutionLedger({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionLedger',
    spec: {
      generations: 1,
      candidatesEvaluated: 1,
      updaterTokens: null,
      solverTokens: null,
      costUsd: null,
      wallTimeMs: 1000,
    },
  })
  assert.equal(ledger.totalTokens, null)
  assert.equal(ledger.costUsd, null)
})
