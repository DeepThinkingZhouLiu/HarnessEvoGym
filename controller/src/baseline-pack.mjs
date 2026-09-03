import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { ProtocolError, validateResultRecords } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const PACK_KIND = 'BaselinePack'
const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,119}$/u
const MAXIMUM_PACK_BYTES = 16 * 1024 * 1024

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknown)
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError(`${label} 必须是非空字符串`)
  }
  return value
}

function sha256(value, label) {
  const digest = text(value, label)
  if (!SHA256.test(digest)) throw new ProtocolError(`${label} 必须是 64 位小写 SHA-256`)
  return digest
}

function safeId(value, label) {
  const id = text(value, label)
  if (!SAFE_ID.test(id)) throw new ProtocolError(`${label} 格式无效`)
  return id
}

function canonicalJsonValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(`BaselinePack 包含非有限数字：${path}`)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new ProtocolError(`BaselinePack 包含不可序列化字段：${path}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolError(`BaselinePack 只能包含普通 JSON 对象：${path}`)
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalJsonValue(value[key], `${path}.${key}`),
  ]))
}

export function baselinePackDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest('hex')
}

function fileDigest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertInside(root, pathValue, label) {
  const rel = relative(root, pathValue)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 必须位于 ${root} 内`)
  }
}

function exactIds(actual, expected, label) {
  const actualIds = [...actual].sort()
  const expectedIds = [...expected].sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new ProtocolError(`${label} Instance 集合与冻结 Benchmark 不一致`, [
      `expected=${expectedIds.join(',')}`,
      `actual=${actualIds.join(',')}`,
    ])
  }
}

function publicBenchmark(benchmark) {
  return {
    id: benchmark.id,
    name: benchmark.name,
    source: structuredClone(benchmark.source),
    evaluator: structuredClone(benchmark.evaluator),
    expectedTotal: benchmark.expectedTotal,
    partitions: structuredClone(benchmark.partitions),
  }
}

function benchmarkForValidation(benchmark) {
  if (benchmark.allInstanceIds instanceof Set && benchmark.partitionByInstance instanceof Map) {
    return benchmark
  }
  const projected = publicBenchmark(benchmark)
  const entries = Object.entries(projected.partitions).flatMap(([partition, value]) => (
    value.instanceIds.map((instanceId) => [instanceId, partition])
  ))
  return {
    ...projected,
    allInstanceIds: new Set(entries.map(([instanceId]) => instanceId)),
    partitionByInstance: new Map(entries),
  }
}

function primaryMetricValue(records, metric) {
  if (records.size === 0) throw new ProtocolError('BaselinePack Decision Partition 不能为空')
  if (metric === 'mean-reward') {
    return [...records.values()].reduce((sum, record) => sum + record.reward, 0) / records.size
  }
  if (metric === 'resolved-rate') {
    return [...records.values()].filter((record) => record.status === 'resolved').length / records.size
  }
  throw new ProtocolError(`BaselinePack 不支持主指标：${metric}`)
}

function assertNoSecrets(value, secrets = []) {
  const serialized = JSON.stringify(value)
  const leaked = secrets.filter((secret) => (
    typeof secret === 'string' && secret.length >= 4 && serialized.includes(secret)
  ))
  if (leaked.length > 0 || /sk-[A-Za-z0-9_-]{12,}/u.test(serialized)) {
    throw new ProtocolError('BaselinePack 检测到疑似凭据，拒绝写入或加载')
  }
}

function normalizedEvaluation(value, label = 'BaselinePack.spec.decision.evaluation') {
  const evaluation = object(value, label)
  rejectUnknown(
    evaluation,
    new Set(['apiVersion', 'kind', 'candidateId', 'primary']),
    label,
  )
  if (evaluation.apiVersion !== API_VERSION || evaluation.kind !== 'EvaluationSummary') {
    throw new ProtocolError('BaselinePack Decision EvaluationSummary 协议无效')
  }
  if (evaluation.candidateId !== 'h0') {
    throw new ProtocolError('BaselinePack Decision EvaluationSummary 必须指向 h0')
  }
  const primary = object(evaluation.primary, `${label}.primary`)
  rejectUnknown(
    primary,
    new Set(['metric', 'value', 'direction', 'total']),
    `${label}.primary`,
  )
  if (!['mean-reward', 'resolved-rate'].includes(primary.metric)
      || typeof primary.value !== 'number' || !Number.isFinite(primary.value)
      || primary.direction !== 'maximize' || primary.total !== null) {
    throw new ProtocolError('BaselinePack Decision 主指标无效')
  }
  return structuredClone(evaluation)
}

function validateFeedbackPacket(packet, { benchmark, feedbackRecords }) {
  const value = object(packet, 'BaselinePack.spec.feedback.packet')
  rejectUnknown(value, new Set(['apiVersion', 'kind', 'metadata', 'spec']), 'FeedbackPacket')
  if (value.apiVersion !== API_VERSION || value.kind !== 'FeedbackPacket') {
    throw new ProtocolError('BaselinePack FeedbackPacket 协议无效')
  }
  const metadata = object(value.metadata, 'FeedbackPacket.metadata')
  if (metadata.candidateId !== 'h0' || metadata.generation !== 1) {
    throw new ProtocolError('BaselinePack 只能保存 H0 第一轮 FeedbackPacket')
  }
  sha256(metadata.sha256, 'FeedbackPacket.metadata.sha256')
  const spec = object(value.spec, 'FeedbackPacket.spec')
  if (metadata.sha256 !== createHash('sha256').update(JSON.stringify(spec)).digest('hex')) {
    throw new ProtocolError('BaselinePack FeedbackPacket 摘要不匹配')
  }
  if (spec.visibility !== 'feedback-only'
      || spec.benchmark?.id !== benchmark.id
      || spec.benchmark?.sourceRevision !== benchmark.source.revision
      || !Array.isArray(spec.cases)
      || !Array.isArray(spec.searchHistory) || spec.searchHistory.length !== 0
      || !Array.isArray(spec.peerEvidence) || spec.peerEvidence.length !== 0) {
    throw new ProtocolError('BaselinePack FeedbackPacket 不是无历史、无 Peer 的初始 H0 反馈')
  }
  exactIds(
    spec.cases.map((item) => item?.instanceId),
    benchmark.partitions.feedback.instanceIds,
    'BaselinePack FeedbackPacket',
  )
  for (const item of spec.cases) {
    const record = feedbackRecords.get(item.instanceId)
    if (!record || item.status !== record.status || Math.abs(item.reward - record.reward) > 1e-9) {
      throw new ProtocolError(`BaselinePack FeedbackPacket 与原始记录不一致：${item.instanceId}`)
    }
  }
  return structuredClone(value)
}

/**
 * 只冻结会影响 H0 解题和评分的配置。Population Mode、Updater、SearchStrategy
 * 与变异风险层不属于公共起点，因此有意不进入兼容身份。
 */
export function createBaselineCompatibilityIdentity({
  bundle,
  targetSourceRevision,
  benchmarkSourceRevision,
  candidateDigest,
  seeds,
}) {
  return canonicalJsonValue({
    target: {
      id: bundle.target.id,
      source: bundle.target.source,
      sourceRevision: targetSourceRevision,
      materialization: bundle.target.materialization,
      solver: bundle.target.solver,
      candidateDigest,
    },
    environment: {
      configuration: bundle.environment,
      sourceRevision: benchmarkSourceRevision,
    },
    provider: bundle.provider,
    solverModel: bundle.experiment.models.solver,
    benchmark: publicBenchmark(bundle.benchmark),
    policy: bundle.policy,
    trials: {
      trialsPerInstance: bundle.experiment.evolution.trialsPerInstance,
      seeds,
    },
  })
}

export function createBaselinePackDocument({
  id,
  createdAt,
  source,
  identity,
  benchmark,
  decisionPartition = 'selection',
  decisionRecords,
  decisionEvaluation,
  selectionRecords,
  selectionEvaluation,
  feedbackRecords,
  feedbackPacket,
  secrets = [],
}) {
  safeId(id, 'BaselinePack.metadata.id')
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new ProtocolError('BaselinePack.metadata.createdAt 必须是合法时间')
  }
  const normalizedSource = object(source, 'BaselinePack.spec.source')
  const validationBenchmark = benchmarkForValidation(benchmark)
  if (!['feedback', 'selection'].includes(decisionPartition)) {
    throw new ProtocolError('BaselinePack decisionPartition 必须是 feedback 或 selection')
  }
  const rawDecisionRecords = decisionRecords ?? selectionRecords
  const rawDecisionEvaluation = decisionEvaluation ?? selectionEvaluation
  const decisionMap = validateResultRecords(
    rawDecisionRecords,
    validationBenchmark,
    `BaselinePack ${decisionPartition}`,
  )
  const feedbackMap = validateResultRecords(feedbackRecords, validationBenchmark, 'BaselinePack Feedback')
  exactIds(
    decisionMap.keys(),
    validationBenchmark.partitions[decisionPartition].instanceIds,
    `BaselinePack ${decisionPartition}`,
  )
  exactIds(feedbackMap.keys(), validationBenchmark.partitions.feedback.instanceIds, 'BaselinePack Feedback')
  const evaluation = normalizedEvaluation(rawDecisionEvaluation)
  if (identity?.policy?.primaryMetric !== evaluation.primary.metric) {
    throw new ProtocolError('BaselinePack Decision 主指标与冻结 Evaluation Policy 不一致')
  }
  if ((identity?.policy?.decisionPartition ?? 'selection') !== decisionPartition) {
    throw new ProtocolError('BaselinePack Decision Partition 与冻结 Evaluation Policy 不一致')
  }
  const actualPrimary = primaryMetricValue(decisionMap, evaluation.primary.metric)
  if (Math.abs(actualPrimary - evaluation.primary.value) > 1e-12) {
    throw new ProtocolError('BaselinePack Decision 分数与逐题记录不一致', [
      `evaluation=${evaluation.primary.value}`,
      `records=${actualPrimary}`,
    ])
  }
  const packet = validateFeedbackPacket(feedbackPacket, {
    benchmark: validationBenchmark,
    feedbackRecords: feedbackMap,
  })
  const decisionEntry = {
    records: structuredClone(rawDecisionRecords),
    evaluation,
  }
  // Selection 是 v1alpha1 既有的公开格式。即使调用方使用新的通用参数，仍继续
  // 输出 spec.selection，避免新版 Controller 生成的 Pack 破坏旧消费脚本。
  const usesLegacySelectionShape = decisionPartition === 'selection'
  const spec = {
    source: structuredClone(normalizedSource),
    identity: canonicalJsonValue(identity),
    ...(usesLegacySelectionShape
      ? { selection: decisionEntry }
      : { decision: { partition: decisionPartition, ...decisionEntry } }),
    feedback: {
      records: structuredClone(feedbackRecords),
      packet,
    },
  }
  const document = {
    apiVersion: API_VERSION,
    kind: PACK_KIND,
    metadata: {
      id,
      createdAt,
      sha256: baselinePackDigest(spec),
    },
    spec,
  }
  assertNoSecrets(document, secrets)
  return document
}

export function validateBaselinePackDocument(document, {
  benchmark,
  expectedIdentity,
  expectedSha256,
  secrets = [],
}) {
  const value = object(document, 'BaselinePack')
  rejectUnknown(value, new Set(['apiVersion', 'kind', 'metadata', 'spec']), 'BaselinePack')
  if (value.apiVersion !== API_VERSION || value.kind !== PACK_KIND) {
    throw new ProtocolError('BaselinePack 协议无效')
  }
  const metadata = object(value.metadata, 'BaselinePack.metadata')
  rejectUnknown(metadata, new Set(['id', 'createdAt', 'sha256']), 'BaselinePack.metadata')
  safeId(metadata.id, 'BaselinePack.metadata.id')
  if (typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) {
    throw new ProtocolError('BaselinePack.metadata.createdAt 必须是合法时间')
  }
  const documentSha256 = sha256(metadata.sha256, 'BaselinePack.metadata.sha256')
  if (expectedSha256 !== undefined && documentSha256 !== sha256(expectedSha256, 'BaselinePack Reference sha256')) {
    throw new ProtocolError('BaselinePack 与 Experiment 固定摘要不一致')
  }
  const spec = object(value.spec, 'BaselinePack.spec')
  rejectUnknown(spec, new Set(['source', 'identity', 'selection', 'decision', 'feedback']), 'BaselinePack.spec')
  if (baselinePackDigest(spec) !== documentSha256) {
    throw new ProtocolError('BaselinePack 内容摘要不匹配，文件可能已被修改')
  }
  if (baselinePackDigest(spec.identity) !== baselinePackDigest(expectedIdentity)) {
    throw new ProtocolError('BaselinePack 与当前 H0/Benchmark/模型/环境身份不一致')
  }
  const source = object(spec.source, 'BaselinePack.spec.source')
  if ((spec.selection === undefined) === (spec.decision === undefined)) {
    throw new ProtocolError('BaselinePack 必须且只能包含 legacy selection 或 decision')
  }
  const legacySelection = spec.selection === undefined
    ? null
    : object(spec.selection, 'BaselinePack.spec.selection')
  const decision = legacySelection === null
    ? object(spec.decision, 'BaselinePack.spec.decision')
    : { partition: 'selection', ...legacySelection }
  const feedback = object(spec.feedback, 'BaselinePack.spec.feedback')
  if (legacySelection === null) {
    rejectUnknown(decision, new Set(['partition', 'records', 'evaluation']), 'BaselinePack.spec.decision')
  } else {
    rejectUnknown(legacySelection, new Set(['records', 'evaluation']), 'BaselinePack.spec.selection')
  }
  rejectUnknown(feedback, new Set(['records', 'packet']), 'BaselinePack.spec.feedback')
  if (!['feedback', 'selection'].includes(decision.partition)) {
    throw new ProtocolError('BaselinePack Decision Partition 必须是 feedback 或 selection')
  }
  if (!Array.isArray(decision.records) || !Array.isArray(feedback.records)) {
    throw new ProtocolError('BaselinePack Decision/Feedback records 必须是数组')
  }
  const validationBenchmark = benchmarkForValidation(benchmark)
  const decisionRecords = validateResultRecords(
    decision.records,
    validationBenchmark,
    `BaselinePack ${decision.partition}`,
  )
  const feedbackRecords = validateResultRecords(feedback.records, validationBenchmark, 'BaselinePack Feedback')
  exactIds(
    decisionRecords.keys(),
    validationBenchmark.partitions[decision.partition].instanceIds,
    `BaselinePack ${decision.partition}`,
  )
  exactIds(feedbackRecords.keys(), validationBenchmark.partitions.feedback.instanceIds, 'BaselinePack Feedback')
  const evaluation = normalizedEvaluation(decision.evaluation)
  const expectedPrimaryMetric = expectedIdentity?.policy?.primaryMetric
  if (typeof expectedPrimaryMetric !== 'string'
      || evaluation.primary.metric !== expectedPrimaryMetric) {
    throw new ProtocolError('BaselinePack Decision 主指标与当前 Evaluation Policy 不一致')
  }
  if ((expectedIdentity?.policy?.decisionPartition ?? 'selection') !== decision.partition) {
    throw new ProtocolError('BaselinePack Decision Partition 与当前 Evaluation Policy 不一致')
  }
  const actualPrimary = primaryMetricValue(decisionRecords, evaluation.primary.metric)
  if (Math.abs(actualPrimary - evaluation.primary.value) > 1e-12) {
    throw new ProtocolError('BaselinePack Decision 分数与逐题记录不一致')
  }
  const packet = validateFeedbackPacket(feedback.packet, {
    benchmark: validationBenchmark,
    feedbackRecords,
  })
  assertNoSecrets(value, secrets)
  return Object.freeze({
    id: metadata.id,
    sha256: documentSha256,
    createdAt: metadata.createdAt,
    source: structuredClone(source),
    identity: structuredClone(spec.identity),
    decision: Object.freeze({
      partition: decision.partition,
      rawRecords: structuredClone(decision.records),
      records: decisionRecords,
      evaluation,
    }),
    ...(decision.partition === 'selection'
      ? {
          selection: Object.freeze({
            rawRecords: structuredClone(decision.records),
            records: decisionRecords,
            evaluation,
          }),
        }
      : {}),
    feedback: Object.freeze({
      rawRecords: structuredClone(feedback.records),
      records: feedbackRecords,
      packet,
    }),
  })
}

async function readLimitedJson(pathValue, label) {
  let info
  try {
    info = await lstat(pathValue)
  } catch (error) {
    throw new ProtocolError(`${label} 不存在或不可访问`, [error.message])
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAXIMUM_PACK_BYTES) {
    throw new ProtocolError(`${label} 必须是小于 16 MiB 的普通文件`)
  }
  let textValue
  try {
    textValue = await readFile(pathValue, 'utf8')
    return JSON.parse(textValue)
  } catch (error) {
    throw new ProtocolError(`${label} 不是合法 JSON`, [error.message])
  }
}

export async function loadBaselinePack({
  repositoryRoot,
  reference,
  benchmark,
  expectedIdentity,
  secrets = [],
}) {
  if (!reference) return null
  const repository = await realpath(repositoryRoot)
  const requested = resolve(repository, reference.path)
  assertInside(repository, requested, 'BaselinePack Path')
  const actual = await realpath(requested).catch((error) => {
    throw new ProtocolError('BaselinePack 不存在或不可访问', [error.message])
  })
  assertInside(repository, actual, 'BaselinePack Path')
  const document = await readLimitedJson(actual, 'BaselinePack')
  return {
    ...validateBaselinePackDocument(document, {
      benchmark,
      expectedIdentity,
      expectedSha256: reference.sha256,
      secrets,
    }),
    path: actual,
  }
}

async function resolveBranchRun(runDirectory, requestedBranchId) {
  const root = await realpath(runDirectory)
  const directState = join(root, 'state.json')
  try {
    const state = await readLimitedJson(directState, 'Evolution Run State')
    if (state.kind === 'EvolutionRunState') return { runRoot: root, state }
  } catch (error) {
    if (!(error instanceof ProtocolError) || !/不存在或不可访问/u.test(error.message)) throw error
  }

  const population = await readLimitedJson(join(root, 'public', 'state.json'), 'Population State')
  if (population.kind !== 'PopulationCampaignState' || !Array.isArray(population.branches)) {
    throw new ProtocolError('指定目录不是 Cowork Evolution Run 或 Population Run')
  }
  const branchId = requestedBranchId
    ?? (population.branches.length === 1 ? population.branches[0].branchId : null)
  if (branchId === null) throw new ProtocolError('多 Branch Population 导出 BaselinePack 时必须指定 --branch')
  if (!population.branches.some((branch) => branch.branchId === branchId)) {
    throw new ProtocolError(`Population 不包含 Branch：${branchId}`)
  }
  const runRoot = await realpath(join(root, 'branches', branchId, 'run'))
  const state = await readLimitedJson(join(runRoot, 'state.json'), 'Evolution Run State')
  return { runRoot, state }
}

async function exclusiveJson(pathValue, value) {
  await mkdir(dirname(pathValue), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(pathValue, 'wx', 0o400)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new ProtocolError(`BaselinePack 输出已存在或不可写：${pathValue}`, [error.message])
  } finally {
    await handle?.close()
  }
}

export async function exportBaselinePackFromRun({
  repositoryRoot,
  runDirectory,
  outputPath,
  id,
  branchId = null,
  createdAt = new Date().toISOString(),
  secrets = [],
}) {
  const repository = await realpath(repositoryRoot)
  const { runRoot, state } = await resolveBranchRun(runDirectory, branchId)
  assertInside(repository, runRoot, 'BaselinePack Source Run')
  if (state.kind !== 'EvolutionRunState' || state.spec?.baselineId !== 'h0') {
    throw new ProtocolError('Source Run 缺少合法 H0')
  }
  const baseline = state.spec.candidates?.find((candidate) => candidate.id === 'h0')
  if (!baseline?.evaluation || !SHA256.test(baseline.digest ?? '')) {
    throw new ProtocolError('Source Run 缺少已评测的 H0 Candidate')
  }
  const snapshot = await readLimitedJson(join(runRoot, 'experiment.snapshot.json'), 'Experiment Snapshot')
  const decisionPartition = snapshot.policy?.decisionPartition
  if (!['feedback', 'selection'].includes(decisionPartition)) {
    throw new ProtocolError('Experiment Snapshot 缺少合法 Decision Partition')
  }
  const decisionPath = join(runRoot, 'results', 'generation-0', `h0-${decisionPartition}.jsonl`)
  const feedbackPath = join(runRoot, 'results', 'generation-1', 'h0-feedback.jsonl')
  const packetPath = join(runRoot, 'generations', 'generation-1', 'feedback-packet.json')
  const [decisionText, feedbackText, feedbackPacket, feedbackPacketText] = await Promise.all([
    readFile(decisionPath, 'utf8'),
    readFile(feedbackPath, 'utf8'),
    readLimitedJson(packetPath, 'H0 FeedbackPacket'),
    readFile(packetPath, 'utf8'),
  ])
  const parseJsonl = (value, label) => value.trim().split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new ProtocolError(`${label} 第 ${index + 1} 行不是合法 JSON`, [error.message])
    }
  })
  const seeds = state.spec.seeds
  const identity = createBaselineCompatibilityIdentity({
    bundle: snapshot,
    targetSourceRevision: state.spec.targetSourceRevision,
    benchmarkSourceRevision: state.spec.benchmarkSourceRevision,
    candidateDigest: baseline.digest,
    seeds,
  })
  const pack = createBaselinePackDocument({
    id,
    createdAt,
    source: {
      runId: state.metadata.id,
      branchId: state.spec.branchId ?? null,
      baselineId: 'h0',
      candidateDigest: baseline.digest,
      files: decisionPartition === 'selection'
        ? {
            selectionSha256: fileDigest(decisionText),
            feedbackSha256: fileDigest(feedbackText),
            feedbackPacketSha256: fileDigest(feedbackPacketText),
          }
        : {
            decisionPartition,
            decisionSha256: fileDigest(decisionText),
            feedbackSha256: fileDigest(feedbackText),
            feedbackPacketSha256: fileDigest(feedbackPacketText),
          },
    },
    identity,
    benchmark: snapshot.benchmark,
    decisionPartition,
    decisionRecords: parseJsonl(decisionText, `H0 ${decisionPartition}`),
    decisionEvaluation: baseline.evaluation,
    feedbackRecords: parseJsonl(feedbackText, 'H0 Feedback'),
    feedbackPacket,
    secrets,
  })
  const requestedOutput = resolve(outputPath)
  assertInside(repository, requestedOutput, 'BaselinePack Output')
  await mkdir(dirname(requestedOutput), { recursive: true, mode: 0o700 })
  const actualParent = await realpath(dirname(requestedOutput))
  assertInside(repository, actualParent, 'BaselinePack Output Parent')
  const actualOutput = join(actualParent, basename(requestedOutput))
  await exclusiveJson(actualOutput, pack)
  return { pack, path: actualOutput }
}

export async function writeImportedRecords(outputPath, records) {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  const payload = records.map((record) => JSON.stringify(record)).join('\n')
  const expected = `${payload}${payload ? '\n' : ''}`
  let handle
  try {
    handle = await open(outputPath, 'wx', 0o600)
    await handle.writeFile(expected, 'utf8')
  } catch (error) {
    if (error.code === 'EEXIST') {
      const current = await readFile(outputPath, 'utf8').catch(() => null)
      if (current === expected) return
    }
    throw new ProtocolError(`无法写入 BaselinePack 导入记录：${outputPath}`, [error.message])
  } finally {
    await handle?.close()
  }
}
