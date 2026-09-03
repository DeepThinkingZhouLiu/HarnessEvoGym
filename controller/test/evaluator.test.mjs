import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateBenchmark } from '../src/evaluator.mjs'
import {
  readJsonFile,
  readResultFile,
  validateBenchmark,
  validateEvaluationPolicy,
  validateEvolutionLedger,
  validateResultRecords,
} from '../src/protocol.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function loadFixture(phase = 'selection') {
  const benchmark = validateBenchmark(
    await readJsonFile(resolve(root, 'benchmarks/examples/swebench-rsi-smoke/benchmark.json')),
  )
  const policy = validateEvaluationPolicy(
    await readJsonFile(resolve(root, 'evaluation/policies/rsi-mvp.json')),
  )
  const resultFiles = {
    selection: {
      baseline: ['evaluation/examples/selection-baseline.jsonl'],
      candidate: ['evaluation/examples/selection-candidate.jsonl'],
    },
    final: {
      baseline: ['evaluation/examples/final-baseline.jsonl'],
      candidate: ['evaluation/examples/final-candidate.jsonl'],
    },
    all: {
      baseline: [
        'evaluation/examples/selection-baseline.jsonl',
        'evaluation/examples/final-baseline.jsonl',
      ],
      candidate: [
        'evaluation/examples/selection-candidate.jsonl',
        'evaluation/examples/final-candidate.jsonl',
      ],
    },
  }
  const files = resultFiles[phase]
  const baselineInput = (
    await Promise.all(files.baseline.map((file) => readResultFile(resolve(root, file))))
  ).flat()
  const candidateInput = (
    await Promise.all(files.candidate.map((file) => readResultFile(resolve(root, file))))
  ).flat()
  const baselineRecords = validateResultRecords(baselineInput, benchmark, 'Baseline')
  const candidateRecords = validateResultRecords(candidateInput, benchmark, 'Candidate')
  const evolutionLedger = validateEvolutionLedger(
    await readJsonFile(resolve(root, 'evaluation/examples/evolution-ledger.json')),
  )
  return {
    benchmark,
    policy,
    run: {
      id: 'test-run',
      baselineRevision: 'baseline-sha',
      candidateRevision: 'candidate-sha',
    },
    baselineRecords,
    candidateRecords,
    evolutionLedger,
  }
}

test('selection 配对指标产生可晋升决策', async () => {
  const fixture = await loadFixture()
  const report = evaluateBenchmark({ ...fixture, partitions: ['selection'] })
  assert.equal(report.partitions.selection.baseline.resolvedRate, 0.5)
  assert.equal(report.partitions.selection.candidate.resolvedRate, 1)
  assert.equal(report.partitions.selection.paired.newlyResolved, 1)
  assert.equal(report.partitions.selection.paired.regressed, 0)
  assert.equal(report.partitions.selection.paired.deltaResolvedRate, 0.5)
  assert.equal(report.partitions.selection.deltas.costUsd.relative, 0.1)
  assert.equal(report.decision.mode, 'promotion')
  assert.equal(report.decision.eligible, true)
})

test('feedback 配对指标可按配置直接决定训练集内晋升', async () => {
  const fixture = await loadFixture()
  const report = evaluateBenchmark({
    ...fixture,
    policy: { ...fixture.policy, decisionPartition: 'feedback' },
    partitions: ['feedback'],
  })
  assert.equal(report.decision.partition, 'feedback')
  assert.equal(report.partitions.feedback.paired.newlyResolved, 1)
  assert.equal(report.decision.mode, 'promotion')
  assert.equal(report.decision.eligible, true)
})

test('final 单独运行只生成报告，不做 Candidate 选择', async () => {
  const fixture = await loadFixture('final')
  const report = evaluateBenchmark({ ...fixture, partitions: ['final'], allowSealed: true })
  assert.equal(report.partitions.final.paired.netResolved, 1)
  assert.equal(report.decision.mode, 'report-only')
  assert.equal(report.decision.eligible, null)
})

test('final 默认保持 sealed', async () => {
  const fixture = await loadFixture('final')
  assert.throws(
    () => evaluateBenchmark({ ...fixture, partitions: ['final'] }),
    /结果文件包含 sealed Final Instance/u,
  )
})

test('进化期结果文件不能提前混入 final Instance', async () => {
  const fixture = await loadFixture('all')
  assert.throws(
    () => evaluateBenchmark({ ...fixture, partitions: ['selection'] }),
    /结果文件包含 sealed Final Instance/u,
  )
})

test('同时评测 feedback 与 final 时计算泛化差距和进化效率', async () => {
  const fixture = await loadFixture('all')
  const report = evaluateBenchmark({
    ...fixture,
    partitions: ['feedback', 'final'],
    allowSealed: true,
  })
  assert.equal(report.rsiMetrics.generalizationGap, 0)
  assert.equal(report.rsiMetrics.evolution.costUsd, 12)
  assert.equal(report.rsiMetrics.finalNetResolvedPer100Usd, 8.333333)
})

test('连续 Reward 使用配对均值和回退数量做晋升', async () => {
  const fixture = await loadFixture()
  fixture.policy.primaryMetric = 'mean-reward'
  fixture.policy.gates.quality.minimumNetResolved = 0
  fixture.policy.gates.quality.minimumMeanRewardDelta = 0.1
  fixture.policy.gates.quality.minimumRewardImproved = 1
  fixture.policy.gates.quality.maximumRewardRegressions = 0
  const ids = fixture.benchmark.partitions.selection.instanceIds
  fixture.baselineRecords.get(ids[0]).reward = 0.25
  fixture.baselineRecords.get(ids[1]).reward = 0.5
  fixture.candidateRecords.get(ids[0]).reward = 0.75
  fixture.candidateRecords.get(ids[1]).reward = 0.5
  const report = evaluateBenchmark({ ...fixture, partitions: ['selection'] })
  assert.equal(report.partitions.selection.baseline.meanReward, 0.375)
  assert.equal(report.partitions.selection.candidate.meanReward, 0.625)
  assert.equal(report.partitions.selection.paired.deltaMeanReward, 0.25)
  assert.equal(report.partitions.selection.paired.rewardImproved, 1)
  assert.equal(report.partitions.selection.paired.rewardRegressed, 0)
  assert.equal(report.decision.eligible, true)
})

test('严格 Reward Policy 拒绝平分，只接受至少一题提升且零回退', async () => {
  const benchmark = validateBenchmark(
    await readJsonFile(resolve(root, 'benchmarks/text-reasoning-smoke/benchmark.json')),
  )
  const policy = validateEvaluationPolicy(
    await readJsonFile(resolve(root, 'evaluation/policies/strict-mean-reward-improvement.json')),
  )
  const instanceId = benchmark.partitions.selection.instanceIds[0]
  const records = (status, reward, label) => validateResultRecords([{
    instance_id: instanceId,
    status,
    reward,
    policy_violations: [],
  }], benchmark, label)
  const baselineRecords = records('unresolved', 0, 'Baseline')
  const tiedRecords = records('unresolved', 0, 'Tied Candidate')
  const improvedRecords = records('resolved', 1, 'Improved Candidate')
  const run = {
    id: 'strict-policy-test',
    baselineRevision: 'baseline-sha',
    candidateRevision: 'candidate-sha',
  }

  const tied = evaluateBenchmark({
    benchmark,
    policy,
    run,
    baselineRecords,
    candidateRecords: tiedRecords,
    partitions: ['selection'],
  })
  assert.equal(tied.partitions.selection.paired.deltaMeanReward, 0)
  assert.equal(tied.decision.eligible, false)
  assert.equal(
    tied.decision.gates.find((gate) => gate.id === 'minimum-reward-improved').passed,
    false,
  )

  const improved = evaluateBenchmark({
    benchmark,
    policy,
    run,
    baselineRecords,
    candidateRecords: improvedRecords,
    partitions: ['selection'],
  })
  assert.equal(improved.partitions.selection.paired.deltaMeanReward, 1)
  assert.equal(improved.decision.eligible, true)
})

test('Resolved Rate 区间使用 Policy 配置的置信度', async () => {
  const fixture = await loadFixture()
  fixture.policy.bootstrap.confidence = 0.9
  const report = evaluateBenchmark({ ...fixture, partitions: ['selection'] })
  assert.equal(report.partitions.selection.baseline.resolvedRateCi.confidence, 0.9)
})

test('Token 涨幅 Gate 使用已采集的配对 Partition Usage', async () => {
  const fixture = await loadFixture()
  fixture.policy.gates.performance.maximumRelativeTokenIncrease = 0.04
  const report = evaluateBenchmark({ ...fixture, partitions: ['selection'] })
  const tokenGate = report.decision.gates.find((item) => item.id === 'maximum-relative-token-increase')
  assert.equal(report.partitions.selection.deltas.tokens.relative, 0.05)
  assert.equal(tokenGate.passed, false)
  assert.equal(report.decision.eligible, false)
})
