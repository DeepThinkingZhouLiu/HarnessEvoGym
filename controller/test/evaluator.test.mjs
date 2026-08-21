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
