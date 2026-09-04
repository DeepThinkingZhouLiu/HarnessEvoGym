import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  baselinePackDigest,
  createBaselinePackDocument,
  exportBaselinePackFromRun,
  loadBaselinePack,
  validateBaselinePackDocument,
  writeImportedRecords,
} from '../src/baseline-pack.mjs'

function benchmark() {
  const partitions = {
    feedback: { visibility: 'detailed', instanceIds: ['feedback-1'] },
    selection: { visibility: 'aggregate-only', instanceIds: ['selection-1'] },
    final: { visibility: 'sealed', instanceIds: ['final-1'] },
  }
  return {
    id: 'cowork-baseline-pack-test',
    name: 'Cowork BaselinePack Test',
    source: {
      adapter: 'fixture',
      dataset: 'fixture',
      split: 'fixed-v1',
      revision: 'a'.repeat(64),
    },
    evaluator: {
      adapter: 'fixture',
      resultFormat: 'harness-rsi/solver-result-jsonl-v2',
    },
    expectedTotal: 3,
    partitions,
    allInstanceIds: new Set(['feedback-1', 'selection-1', 'final-1']),
    partitionByInstance: new Map([
      ['feedback-1', 'feedback'],
      ['selection-1', 'selection'],
      ['final-1', 'final'],
    ]),
  }
}

function feedbackPacket() {
  const spec = {
    visibility: 'feedback-only',
    benchmark: {
      id: 'cowork-baseline-pack-test',
      sourceRevision: 'a'.repeat(64),
      caseCount: 1,
    },
    summary: { meanReward: 0.25, resolved: 0, failed: 1 },
    searchHistory: [],
    peerEvidence: [],
    cases: [{
      instanceId: 'feedback-1',
      status: 'unresolved',
      reward: 0.25,
      trialRewards: [0.25],
      taskInstruction: '修改文档',
      verifierFeedback: '部分通过',
      solverAnswer: '已完成',
      errors: '',
      policyViolations: [],
      latencyMs: 10,
      inputTokens: null,
      outputTokens: null,
      artifacts: [],
      artifactSummary: {
        totalEntries: 0,
        includedEntries: 0,
        omittedEntries: 0,
        truncated: false,
      },
    }],
    instructions: ['只使用 feedback'],
  }
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'FeedbackPacket',
    metadata: {
      runId: 'source-run',
      generation: 1,
      candidateId: 'h0',
      sha256: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
    },
    spec,
  }
}

function fixture() {
  const selectionRecords = [{
    instance_id: 'selection-1',
    status: 'unresolved',
    reward: 0.08,
    trial_rewards: [0.08],
    trial_seeds: [20260827],
    seed_controlled: false,
  }]
  const feedbackRecords = [{
    instance_id: 'feedback-1',
    status: 'unresolved',
    reward: 0.25,
    trial_rewards: [0.25],
    trial_seeds: [20260827],
    seed_controlled: false,
    feedback: {
      taskInstruction: '修改文档',
      verifierFeedback: '部分通过',
      solverAnswer: '已完成',
      errors: [],
    },
  }]
  const identity = {
    target: { id: 'msa-minimal', candidateDigest: 'b'.repeat(64) },
    benchmark: { id: 'cowork-baseline-pack-test' },
    policy: { primaryMetric: 'mean-reward' },
    seeds: [20260827],
  }
  const document = createBaselinePackDocument({
    id: 'cowork-h0-v1',
    createdAt: '2026-09-01T00:00:00.000Z',
    source: {
      runId: 'source-run',
      branchId: 'branch-001',
      baselineId: 'h0',
      candidateDigest: 'b'.repeat(64),
    },
    identity,
    benchmark: benchmark(),
    selectionRecords,
    selectionEvaluation: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvaluationSummary',
      candidateId: 'h0',
      primary: {
        metric: 'mean-reward',
        value: 0.08,
        direction: 'maximize',
        total: null,
      },
    },
    feedbackRecords,
    feedbackPacket: feedbackPacket(),
  })
  return { document, identity, selectionRecords, feedbackRecords }
}

test('BaselinePack 固化同一份 H0 Selection 与初始 Feedback', () => {
  const { document, identity } = fixture()
  assert.ok(document.spec.selection)
  assert.equal(document.spec.decision, undefined)
  const pack = validateBaselinePackDocument(document, {
    benchmark: benchmark(),
    expectedIdentity: identity,
    expectedSha256: document.metadata.sha256,
  })
  assert.equal(pack.selection.records.size, 1)
  assert.equal(pack.feedback.records.size, 1)
  assert.equal(pack.selection.evaluation.primary.value, 0.08)
  assert.equal(pack.feedback.packet.metadata.runId, 'source-run')
})

test('新版通用参数在 Selection 模式下仍输出兼容的 spec.selection', () => {
  const { identity, selectionRecords, feedbackRecords } = fixture()
  const document = createBaselinePackDocument({
    id: 'cowork-h0-selection-compatible-v1',
    createdAt: '2026-09-04T00:00:00.000Z',
    source: { runId: 'source-run', baselineId: 'h0', candidateDigest: 'b'.repeat(64) },
    identity,
    benchmark: benchmark(),
    decisionPartition: 'selection',
    decisionRecords: selectionRecords,
    decisionEvaluation: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvaluationSummary',
      candidateId: 'h0',
      primary: { metric: 'mean-reward', value: 0.08, direction: 'maximize', total: null },
    },
    feedbackRecords,
    feedbackPacket: feedbackPacket(),
  })
  assert.ok(document.spec.selection)
  assert.equal(document.spec.decision, undefined)
})

test('BaselinePack 可固定 Feedback 作为训练集内晋升基线', () => {
  const { feedbackRecords } = fixture()
  const identity = {
    target: { id: 'msa-minimal', candidateDigest: 'b'.repeat(64) },
    benchmark: { id: 'cowork-baseline-pack-test' },
    policy: { primaryMetric: 'mean-reward', decisionPartition: 'feedback' },
    seeds: [20260827],
  }
  const document = createBaselinePackDocument({
    id: 'cowork-h0-feedback-v1',
    createdAt: '2026-09-04T00:00:00.000Z',
    source: { runId: 'source-run', baselineId: 'h0', candidateDigest: 'b'.repeat(64) },
    identity,
    benchmark: benchmark(),
    decisionPartition: 'feedback',
    decisionRecords: feedbackRecords,
    decisionEvaluation: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvaluationSummary',
      candidateId: 'h0',
      primary: { metric: 'mean-reward', value: 0.25, direction: 'maximize', total: null },
    },
    feedbackRecords,
    feedbackPacket: feedbackPacket(),
  })
  const pack = validateBaselinePackDocument(document, {
    benchmark: benchmark(),
    expectedIdentity: identity,
  })
  assert.equal(pack.decision.partition, 'feedback')
  assert.equal(pack.decision.records.size, 1)
  assert.equal(pack.selection, undefined)
})

test('BaselinePack 对内容篡改、Final 注入和身份漂移 fail closed', () => {
  const { document, identity } = fixture()
  const tampered = structuredClone(document)
  tampered.spec.selection.records[0].reward = 1
  assert.throws(() => validateBaselinePackDocument(tampered, {
    benchmark: benchmark(),
    expectedIdentity: identity,
    expectedSha256: document.metadata.sha256,
  }), /内容摘要不匹配/u)

  const withFinal = structuredClone(document)
  withFinal.spec.final = { leaked: true }
  withFinal.metadata.sha256 = baselinePackDigest(withFinal.spec)
  assert.throws(() => validateBaselinePackDocument(withFinal, {
    benchmark: benchmark(),
    expectedIdentity: identity,
    expectedSha256: withFinal.metadata.sha256,
  }), /未知字段/u)

  assert.throws(() => validateBaselinePackDocument(document, {
    benchmark: benchmark(),
    expectedIdentity: { ...identity, seeds: [7] },
    expectedSha256: document.metadata.sha256,
  }), /身份不一致/u)
})

test('BaselinePack 检测凭据并拒绝导入', () => {
  const { document, identity } = fixture()
  const secret = 'provider-secret-value'
  document.spec.feedback.packet.spec.cases[0].solverAnswer = secret
  document.spec.feedback.packet.metadata.sha256 = createHash('sha256')
    .update(JSON.stringify(document.spec.feedback.packet.spec))
    .digest('hex')
  document.metadata.sha256 = baselinePackDigest(document.spec)
  assert.throws(() => validateBaselinePackDocument(document, {
    benchmark: benchmark(),
    expectedIdentity: identity,
    expectedSha256: document.metadata.sha256,
    secrets: [secret],
  }), /疑似凭据/u)
})

test('BaselinePack 从仓库内普通文件加载，并校验引用摘要', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-baseline-pack-'))
  const { document, identity } = fixture()
  const path = join(root, 'packs', 'h0.json')
  await writeImportedRecords(join(root, 'records', 'selection.jsonl'), document.spec.selection.records)
  await writeImportedRecords(join(root, 'records', 'selection.jsonl'), document.spec.selection.records)
  await assert.rejects(
    writeImportedRecords(join(root, 'records', 'selection.jsonl'), [{ changed: true }]),
    /无法写入/u,
  )
  await mkdir(join(root, 'packs'), { recursive: true })
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
  const pack = await loadBaselinePack({
    repositoryRoot: root,
    reference: { path: 'packs/h0.json', sha256: document.metadata.sha256 },
    benchmark: benchmark(),
    expectedIdentity: identity,
  })
  assert.equal(pack.id, 'cowork-h0-v1')
  assert.equal(
    JSON.parse(await readFile(path, 'utf8')).metadata.sha256,
    document.metadata.sha256,
  )
  await assert.rejects(loadBaselinePack({
    repositoryRoot: root,
    reference: { path: 'packs/h0.json', sha256: '0'.repeat(64) },
    benchmark: benchmark(),
    expectedIdentity: identity,
  }), /固定摘要不一致/u)
})

test('训练集内晋升可从 Baseline-only H0 结果直接导出公共 Feedback Pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-feedback-baseline-export-'))
  const runRoot = join(root, 'runs', 'baseline-only-source')
  const outputPath = join(root, 'packs', 'h0-feedback.json')
  const sourceBenchmark = benchmark()
  sourceBenchmark.partitions.selection = { visibility: 'aggregate-only', instanceIds: [] }
  sourceBenchmark.expectedTotal = 2
  sourceBenchmark.allInstanceIds = new Set(['feedback-1', 'final-1'])
  sourceBenchmark.partitionByInstance = new Map([
    ['feedback-1', 'feedback'],
    ['final-1', 'final'],
  ])
  const snapshot = {
    target: {
      id: 'msa-minimal',
      source: { kind: 'fixture' },
      materialization: { strategy: 'fixture' },
      solver: { protocol: 'fixture' },
    },
    environment: {
      protocol: 'fixture',
      feedback: {
        maximumTextBytesPerCase: 4096,
        maximumArtifactEntriesPerCase: 10,
        maximumArtifactBytesPerCase: 4096,
        maximumHistoryEntries: 10,
        maximumHistoryBytes: 4096,
      },
    },
    provider: { id: 'fixture-provider' },
    experiment: {
      models: { solver: { provider: 'fixture-provider', model: 'fixture-model' } },
      evolution: { trialsPerInstance: 1 },
    },
    benchmark: {
      id: sourceBenchmark.id,
      name: sourceBenchmark.name,
      source: sourceBenchmark.source,
      evaluator: sourceBenchmark.evaluator,
      expectedTotal: sourceBenchmark.expectedTotal,
      partitions: sourceBenchmark.partitions,
    },
    policy: { primaryMetric: 'mean-reward', decisionPartition: 'feedback' },
  }
  const feedbackRecords = fixture().feedbackRecords
  await mkdir(join(runRoot, 'results', 'generation-0'), { recursive: true })
  await writeFile(join(runRoot, 'state.json'), `${JSON.stringify({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionRunState',
    metadata: { id: 'baseline-only-source', status: 'running' },
    spec: {
      branchId: 'branch-001',
      baselineId: 'h0',
      targetSourceRevision: 'target-source-v1',
      benchmarkSourceRevision: sourceBenchmark.source.revision,
      seeds: [20260827],
      candidates: [{
        id: 'h0',
        digest: 'b'.repeat(64),
        evaluation: {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'EvaluationSummary',
          candidateId: 'h0',
          primary: { metric: 'mean-reward', value: 0.25, direction: 'maximize', total: null },
        },
      }],
    },
  }, null, 2)}\n`)
  await writeFile(join(runRoot, 'experiment.snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
  await writeFile(
    join(runRoot, 'results', 'generation-0', 'h0-feedback.jsonl'),
    `${feedbackRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )

  const exported = await exportBaselinePackFromRun({
    repositoryRoot: root,
    runDirectory: runRoot,
    outputPath,
    id: 'baseline-only-feedback-pack',
    createdAt: '2026-09-05T00:00:00.000Z',
  })
  assert.equal(exported.pack.spec.decision.partition, 'feedback')
  assert.deepEqual(exported.pack.spec.decision.records, feedbackRecords)
  assert.deepEqual(exported.pack.spec.feedback.records, feedbackRecords)
  assert.equal(exported.pack.spec.feedback.packet.metadata.generation, 1)
  assert.equal(exported.pack.spec.feedback.packet.spec.searchHistory.length, 0)
  assert.equal(exported.pack.spec.feedback.packet.spec.peerEvidence.length, 0)
})
