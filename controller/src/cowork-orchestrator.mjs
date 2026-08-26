import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  copyRegularTree,
  diffSnapshots,
  enforceMutationPolicy,
  mutationPolicyFor,
  snapshotTree,
  treeDigest,
  validateMutationReport,
  writeCandidateManifest,
} from './candidate.mjs'
import { materializeCandidate } from './candidate-materializers.mjs'
import { validateCandidate } from './candidate-validators.mjs'
import { loadExperimentBundle } from './adapters.mjs'
import { assertPathKind, resolveInside } from './config.mjs'
import { DockerClient } from './docker.mjs'
import { evaluateBenchmark } from './evaluator.mjs'
import { createEnvironmentRunner, createSolverDriver, createUpdaterDriver } from './factories.mjs'
import { buildFeedbackPacket } from './feedback.mjs'
import { createEvaluationSummary } from './evaluation-summary.mjs'
import { validateBranchProjection, validateBranchStepResult } from './branch-evolution-driver.mjs'
import {
  issueMutationLease,
  mutationCatalogFor,
  validateMutationPlan,
} from './mutation-catalog.mjs'
import {
  buildModelGatewayImage,
  ModelGateway,
  validateModelGatewayEnvironment,
} from './cowork-model-gateway.mjs'
import { ProtocolError, readJsonFile, writeJsonFile } from './protocol.mjs'
import { runProcess, secretValuesFromEnvironment } from './process.mjs'
import { createSearchStrategyDriver } from './search-strategy.mjs'
import { resolveTargetSource } from './target-sources.mjs'
import { PopulationOrchestrator } from './population-orchestrator.mjs'

const MAXIMUM_STRATEGY_HISTORY_ENTRIES = 64

class CandidateMutationError extends Error {
  constructor(message, details = [], cause = null) {
    super(message)
    this.name = 'CandidateMutationError'
    this.kind = 'candidate'
    this.details = details
    this.cause = cause
  }
}

function safeRunId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(value)) {
    throw new ProtocolError('Run ID 只能包含小写字母、数字、点、下划线和连字符，长度为 3-120')
  }
  return value
}

function safeCandidateId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,119}$/u.test(value)) {
    throw new ProtocolError('Candidate ID 只能包含小写字母、数字、点、下划线和连字符，长度为 2-120')
  }
  return value
}

export function createRunId(prefix = 'cowork') {
  const timestamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'z').toLowerCase()
  return `${prefix}-${timestamp}-${randomUUID().slice(0, 8)}`
}

async function pathExists(pathValue) {
  try {
    await stat(pathValue)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function assertInside(root, pathValue, label) {
  const rel = relative(root, pathValue)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 必须位于 ${root} 内`)
  }
}

async function gitRevision(pathValue) {
  const revision = await runProcess('git', ['-C', pathValue, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  const dirty = await runProcess(
    'git',
    ['-C', pathValue, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'],
    { timeoutMs: 30_000 },
  )
  if (dirty.stdout.trim()) {
    throw new ProtocolError(`可信 Source 存在未提交或已忽略的本地文件：${pathValue}`)
  }
  return revision.stdout.trim()
}

async function trustedControllerRevision(repositoryRoot) {
  const revision = await runProcess('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  const value = revision.stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new ProtocolError('无法解析 Controller Git Revision')
  const dirty = await runProcess(
    'git',
    [
      '-C',
      repositoryRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      'controller/src',
      'docker',
      'package.json',
      'package-lock.json',
    ],
    { timeoutMs: 30_000 },
  )
  if (dirty.stdout.trim()) {
    throw new ProtocolError('Controller 信任根必须先提交，再开始或继续实验', [dirty.stdout.trim()])
  }
  return value
}

async function pinnedSubmoduleRevision(repositoryRoot, sourcePath) {
  const result = await runProcess('git', ['-C', repositoryRoot, 'ls-tree', 'HEAD', '--', sourcePath], {
    timeoutMs: 30_000,
  })
  const match = result.stdout.match(/^160000\s+commit\s+([0-9a-f]{40})\t/u)
  if (!match) throw new ProtocolError(`HEAD 中没有固定的 Git Submodule：${sourcePath}`)
  return match[1]
}

async function resolvePinnedSource(repositoryRoot, source, label) {
  const root = resolveInside(repositoryRoot, source.path, `${label} Path`)
  await assertPathKind(root, label)
  const [revision, pinnedRevision] = await Promise.all([
    gitRevision(root),
    pinnedSubmoduleRevision(repositoryRoot, source.path),
  ])
  if (pinnedRevision !== source.revision) {
    throw new ProtocolError(`${label} Adapter Revision 与主仓固定的 Submodule Revision 不一致`, [
      `adapter=${source.revision}`,
      `pinned=${pinnedRevision}`,
    ])
  }
  if (revision !== pinnedRevision) {
    throw new ProtocolError(`${label} Checkout 与主仓固定的 Submodule Revision 不一致`, [
      `pinned=${pinnedRevision}`,
      `checkout=${revision}`,
    ])
  }
  return { root, revision }
}

function buildLedger({ generations, candidatesEvaluated, startedAt, solverUsage, updaterUsage }) {
  return {
    generations,
    candidatesEvaluated,
    updaterTokens: updaterUsage.totalTokens,
    solverTokens: solverUsage.totalTokens,
    updaterUsage: structuredClone(updaterUsage),
    solverUsage: structuredClone(solverUsage),
    costUsd: null,
    wallTimeMs: Date.now() - startedAt,
  }
}

function publicDecision(decision) {
  return {
    eligible: decision.eligible,
    gates: decision.gates.map(({ id, passed, actual, operator, expected }) => ({
      id,
      passed,
      actual,
      operator,
      expected,
    })),
  }
}

function resultPath(runRoot, generation, candidateId, partition) {
  return join(runRoot, 'results', `generation-${generation}`, `${candidateId}-${partition}.jsonl`)
}

async function appendRegistry(repositoryRoot, record) {
  const registryRoot = resolve(repositoryRoot, '.rsi/registry')
  await mkdir(registryRoot, { recursive: true })
  await appendFile(join(registryRoot, 'candidates.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}

function makeDocker(environment) {
  return new DockerClient({
    binary: environment.docker.binary,
    network: environment.docker.network,
    resources: environment.docker.resources,
    runAsCurrentUser: environment.docker.runAsCurrentUser,
  })
}

function requiredSecrets(bundle) {
  return [...new Set([
    ...bundle.target.solver.runtime.secretEnvironment,
    ...bundle.updater.runtime.secretEnvironment,
    bundle.environment.modelGateway.upstreamApiKeyEnvironment,
    bundle.environment.modelGateway.upstreamBaseUrlEnvironment,
  ])]
}

function assertSecrets(names) {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length > 0) throw new ProtocolError('缺少模型 Provider 运行时凭据', missing)
}

async function createContext({
  repositoryRoot,
  experimentPath,
  runRootOverride = null,
  gatewayScope = null,
}) {
  const absoluteExperimentPath = resolve(experimentPath)
  assertInside(repositoryRoot, absoluteExperimentPath, 'Experiment 配置')
  const bundle = await loadExperimentBundle(absoluteExperimentPath, repositoryRoot)
  const targetSource = await resolveTargetSource({
    repositoryRoot,
    source: bundle.target.source,
    label: 'Target Source',
  })
  const updaterSource = bundle.updater.source.path === bundle.target.source.path
    ? targetSource
    : await resolvePinnedSource(repositoryRoot, bundle.updater.source, 'Updater Source')
  if (updaterSource.revision !== bundle.updater.source.revision) {
    throw new ProtocolError('Updater Adapter Revision 与复用的 Target Source Revision 不一致')
  }
  const baselineTemplate = bundle.target.materialization.baselinePath
    ? resolveInside(repositoryRoot, bundle.target.materialization.baselinePath, 'Target Baseline Path')
    : null
  if (baselineTemplate) await assertPathKind(baselineTemplate, 'Target Baseline Template')
  for (const [label, runtime, source] of [
    ...(['dsh-headless-docker', 'dsh-headless-docker-v1'].includes(bundle.target.solver.protocol)
      ? [['Target Solver', bundle.target.solver.runtime, targetSource]]
      : []),
    ['Updater', bundle.updater.runtime, updaterSource],
  ]) {
    const sourcePackage = await readJsonFile(join(source.root, 'apps/cli/package.json'))
    if (runtime.package !== sourcePackage.name || runtime.version !== sourcePackage.version) {
      throw new ProtocolError(`${label} Runtime 与固定 DSH Source Package 不一致`, [
        `source=${sourcePackage.name}@${sourcePackage.version}`,
        `runtime=${runtime.package}@${runtime.version}`,
      ])
    }
  }
  await Promise.all([
    assertPathKind(
      resolveInside(repositoryRoot, bundle.target.solver.runtime.dockerfile, 'Target Runtime Dockerfile'),
      'Target Runtime Dockerfile',
      'file',
    ),
    assertPathKind(
      resolveInside(repositoryRoot, bundle.updater.runtime.dockerfile, 'Updater Runtime Dockerfile'),
      'Updater Runtime Dockerfile',
      'file',
    ),
    assertPathKind(
      resolveInside(repositoryRoot, bundle.updater.promptPath, 'Updater Prompt'),
      'Updater Prompt',
      'file',
    ),
    assertPathKind(
      resolveInside(repositoryRoot, bundle.environment.modelGateway.dockerfile, 'Model Gateway Dockerfile'),
      'Model Gateway Dockerfile',
      'file',
    ),
    ...(baselineTemplate
      ? [assertPathKind(
          resolveInside(baselineTemplate, bundle.target.materialization.presetRelativePath, 'H0 Preset'),
          'H0 Preset',
        )]
      : []),
  ])
  const docker = makeDocker(bundle.environment)
  const searchStrategy = createSearchStrategyDriver({ adapter: bundle.strategy, docker })
  const modelGateway = gatewayScope
    ? new ModelGateway({
        config: bundle.environment.modelGateway,
        docker,
        repositoryRoot,
        scopeId: gatewayScope,
      })
    : null
  const solverDriver = createSolverDriver({
    target: bundle.target,
    provider: bundle.provider,
    docker,
    repositoryRoot,
    sourceRevision: targetSource.revision,
    sourcePath: bundle.target.source.path,
    modelGateway,
  })
  const updaterDriver = createUpdaterDriver({
    updater: bundle.updater,
    provider: bundle.provider,
    docker,
    repositoryRoot,
    sourceRevision: updaterSource.revision,
    sourcePath: bundle.updater.source.path,
    modelGateway,
  })
  const runRoot = runRootOverride
  return {
    bundle,
    sourceRoot: targetSource.root,
    targetSourceRoot: targetSource.root,
    targetSourceRevision: targetSource.revision,
    updaterSourceRoot: updaterSource.root,
    updaterSourceRevision: updaterSource.revision,
    baselineTemplate,
    sourceRevision: targetSource.revision,
    docker,
    solverDriver,
    updaterDriver,
    searchStrategy,
    modelGateway,
    runRoot,
    absoluteExperimentPath,
  }
}

export async function preflightExperiment({ repositoryRoot, experimentPath, requireSecrets = true }) {
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  const context = await createContext({ repositoryRoot, experimentPath })
  const names = requiredSecrets(context.bundle)
  if (requireSecrets) {
    assertSecrets(names)
    validateModelGatewayEnvironment(context.bundle.environment.modelGateway)
  }
  const temporaryRunRoot = resolve(repositoryRoot, '.rsi/preflight')
  const environment = createEnvironmentRunner({
    environment: context.bundle.environment,
    benchmark: context.bundle.benchmark,
    target: context.bundle.target,
    solverDriver: context.solverDriver,
    docker: context.docker,
    runRoot: temporaryRunRoot,
  })
  const [environmentStatus] = await Promise.all([
    environment.preflight(),
    context.searchStrategy.preflight(),
  ])
  for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
  return {
    experiment: context.bundle.experiment.id,
    mutationLevel: context.bundle.experiment.evolution.mutationLevel,
    searchStrategy: context.searchStrategy.descriptor(),
    controllerRevision,
    targetSourceRevision: context.targetSourceRevision,
    updaterSourceRevision: context.updaterSourceRevision,
    benchmarkSourceRevision: environmentStatus.sourceRevision,
    instances: context.bundle.benchmark.expectedTotal,
    requiredSecretEnvironment: names,
    docker: 'available',
  }
}

export async function buildExperimentRuntime({ repositoryRoot, experimentPath }) {
  const context = await createContext({ repositoryRoot, experimentPath })
  await context.docker.info()
  const runtime = await context.updaterDriver.ensureRuntime()
  const gatewayImage = await buildModelGatewayImage({
    config: context.bundle.environment.modelGateway,
    docker: context.docker,
    repositoryRoot,
  })
  return {
    image: context.bundle.updater.runtime.image,
    gatewayImage,
    package: `${context.bundle.updater.runtime.package}@${context.bundle.updater.runtime.version}`,
    sourceRevision: context.updaterSourceRevision,
    built: runtime.built,
  }
}

async function materializeH0({ context, runRoot }) {
  const candidateRoot = join(runRoot, 'candidates', 'h0')
  const workspace = join(candidateRoot, 'workspace')
  await mkdir(candidateRoot, { recursive: true })
  const composition = await materializeCandidate({
    repositoryRoot: context.repositoryRoot,
    target: context.bundle.target,
    sourceRoot: context.targetSourceRoot,
    destination: workspace,
  })
  await Promise.all([
    mkdir(join(workspace, '.rsi-context'), { recursive: true }),
    mkdir(join(workspace, '.rsi-output'), { recursive: true }),
  ])
  const snapshot = await snapshotTree(workspace, {
    maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
    maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
  })
  const semanticReport = await validateCandidate({ workspace, target: context.bundle.target })
  if (!semanticReport.valid) {
    throw new ProtocolError(
      'H0 Preset 语义检查失败',
      semanticReport.violations.map((item) => `${item.path}: ${item.reason}`),
    )
  }
  await writeCandidateManifest(join(candidateRoot, 'manifest.json'), {
    candidateId: 'h0',
    parentId: null,
    snapshot,
    sourceRevision: context.sourceRevision,
    composition,
  })
  return { id: 'h0', root: candidateRoot, workspace, digest: treeDigest(snapshot) }
}

async function runUpdaterGeneration({
  context,
  runRoot,
  generation,
  parent,
  feedbackPacket,
  mutationPolicy,
}) {
  const level = context.bundle.experiment.evolution.mutationLevel
  const id = `g${String(generation).padStart(3, '0')}-${level}`
  const root = join(runRoot, 'candidates', id)
  const workspace = join(root, 'workspace')
  await mkdir(root, { recursive: true })
  await copyRegularTree(parent.workspace, workspace)
  const before = await snapshotTree(workspace, {
    maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
    maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
  })
  const inputDirectory = join(root, 'updater-input')
  const outputDirectory = join(root, 'updater-output')
  const dshHome = join(root, 'updater-dsh-home')
  await mkdir(dshHome, { recursive: true })
  await context.updaterDriver.stageContext({
    destination: inputDirectory,
    promptPath: context.updaterPromptPath
      ?? resolveInside(context.repositoryRoot, context.bundle.updater.promptPath, 'Updater Prompt'),
    promptVariables: {
      'target.name': context.bundle.target.id,
      'baseline.revision': parent.digest,
      'mutation.level': level,
      'mutation.regions': mutationPolicy.metadata.regions.join(', '),
      'mutation.writablePaths': mutationPolicy.spec.writable.map((value) => `- ${value}`).join('\n'),
      'mutation.readOnlyPaths': mutationPolicy.spec.readOnly.map((value) => `- ${value}`).join('\n'),
      'mutation.semanticConstraints': JSON.stringify(mutationPolicy.spec.semanticConstraints, null, 2),
      'output.mutationReportPath': `.rsi-output/${context.bundle.updater.mutationReportName}`,
    },
    feedbackPacket,
    mutationPolicy,
  })

  const updaterResult = await context.updaterDriver.run({
    image: context.bundle.updater.runtime.image,
    model: context.bundle.experiment.models.updater,
    candidateWorkspace: workspace,
    upstreamSource: context.sourceRoot,
    contextDirectory: inputDirectory,
    outputDirectory,
    dshHome,
    mutationLevel: level,
    targetId: context.bundle.target.id,
    reportName: context.bundle.updater.mutationReportName,
    name: `${context.runId}-${id}-updater`,
    timeoutMs: context.bundle.environment.docker.resources.timeoutSeconds * 1000,
  })
  await writeFile(join(root, 'updater-stdout.txt'), `${updaterResult.stdout}\n`, 'utf8')
  await writeFile(join(root, 'updater-stderr.txt'), `${updaterResult.stderr}\n`, 'utf8')

  const after = await snapshotTree(workspace, {
    maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
    maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
  })
  const changes = diffSnapshots(before, after)
  const policyReport = enforceMutationPolicy(changes, mutationPolicy)
  const semanticReport = await validateCandidate({ workspace, target: context.bundle.target })
  await writeJsonFile(join(root, 'mutation-diff.json'), {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationDiff',
    metadata: { candidateId: id, parentId: parent.id },
    spec: { ...policyReport, semanticChecks: semanticReport.checks },
  })
  if (!policyReport.valid) {
    throw new CandidateMutationError(
      'Updater 产生越界 Diff',
      policyReport.violations.map((item) => `${item.path}: ${item.reason}`),
    )
  }
  if (!semanticReport.valid) {
    throw new CandidateMutationError(
      'Candidate Preset 语义检查失败',
      semanticReport.violations.map((item) => `${item.path}: ${item.reason}`),
    )
  }
  let report
  try {
    report = validateMutationReport(updaterResult.report, policyReport.changes)
  } catch (error) {
    throw new CandidateMutationError(error.message, error.details ?? [], error)
  }
  await writeJsonFile(join(root, 'mutation-report.json'), report)
  await writeCandidateManifest(join(root, 'manifest.json'), {
    candidateId: id,
    parentId: parent.id,
    snapshot: after,
    sourceRevision: context.sourceRevision,
  })
  return { id, root, workspace, digest: treeDigest(after), report, policyReport }
}

function publicBundleSnapshot(bundle) {
  return {
    experiment: bundle.experiment,
    recipe: bundle.recipe,
    target: bundle.target,
    updater: bundle.updater,
    provider: bundle.provider,
    environment: bundle.environment,
    strategy: bundle.strategy,
    benchmark: {
      id: bundle.benchmark.id,
      name: bundle.benchmark.name,
      source: bundle.benchmark.source,
      evaluator: bundle.benchmark.evaluator,
      expectedTotal: bundle.benchmark.expectedTotal,
      partitions: bundle.benchmark.partitions,
    },
    policy: bundle.policy,
  }
}

function jsonDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function canonicalJsonValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(`Population Bundle 包含非有限数字：${path}`)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new ProtocolError(`Population Bundle 包含不可序列化字段：${path}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolError(`Population Bundle 只能包含普通 JSON 对象：${path}`)
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalJsonValue(value[key], `${path}.${key}`),
  ]))
}

function canonicalJsonDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest('hex')
}

/**
 * 冻结 Population 真正会消费的公开 Bundle，以及不会泄露 Prompt 正文的可信输入摘要。
 * Adapter/Policy 已经被 loadExperimentBundle 展开为规范对象；对象键排序保证相同语义
 * 不受 YAML/JSON 属性顺序影响。凭据只保留环境变量名，绝不读取进摘要。
 */
export async function capturePopulationBundle(bundle, repositoryRoot) {
  const promptPath = resolveInside(repositoryRoot, bundle.updater.promptPath, 'Updater Prompt')
  await assertPathKind(promptPath, 'Updater Prompt', 'file')
  let updaterPromptSource
  try {
    updaterPromptSource = await readFile(promptPath, 'utf8')
  } catch (error) {
    throw new ProtocolError('无法读取 Population Updater Prompt', [error.message])
  }
  const snapshot = {
    ...publicBundleSnapshot(bundle),
    trustedInputs: {
      updaterPrompt: {
        path: bundle.updater.promptPath,
        bytes: Buffer.byteLength(updaterPromptSource, 'utf8'),
        sha256: createHash('sha256').update(updaterPromptSource).digest('hex'),
      },
    },
  }
  return {
    snapshot,
    digest: canonicalJsonDigest(snapshot),
    updaterPromptSource,
  }
}

export async function assertPopulationBundleMatches({
  bundle,
  repositoryRoot,
  expectedDigest,
}) {
  if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedDigest)) {
    throw new ProtocolError('Population Bundle 冻结摘要必须是 64 位小写 SHA-256')
  }
  const captured = await capturePopulationBundle(bundle, repositoryRoot)
  if (captured.digest !== expectedDigest) {
    throw new ProtocolError('Population Branch 加载的 Bundle 与父层冻结快照不一致', [
      `expected=${expectedDigest}`,
      `actual=${captured.digest}`,
    ])
  }
  return captured
}

export async function claimFinalAttempt(runRoot, { attemptId, startedAt }) {
  const claimPath = join(runRoot, 'final-attempt.json')
  let handle
  try {
    handle = await open(claimPath, 'wx', 0o444)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ProtocolError('Final Attempt 已被其他进程领取；禁止重复解封')
    }
    throw new ProtocolError('无法原子领取 Final Attempt', [error.message])
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'FinalAttemptClaim',
      metadata: { attemptId, startedAt },
    }, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return claimPath
}

async function assertCandidateIntegrity({
  candidateId,
  workspace,
  manifest,
  sourceRevision,
  expectedDigest,
  maximumFileBytes,
  maximumTreeEntries,
  label,
}) {
  if (manifest.kind !== 'CandidateManifest' || manifest.apiVersion !== 'harness-rsi/v1alpha1') {
    throw new ProtocolError(`${label} Manifest 协议无效`)
  }
  if (manifest.spec?.sourceRevision !== sourceRevision) {
    throw new ProtocolError(`${label} Source Revision 与 Run 冻结值不一致`)
  }
  if (manifest.metadata?.id !== candidateId) throw new ProtocolError(`${label} Manifest Candidate ID 不一致`)
  if (manifest.spec?.treeDigest !== expectedDigest) {
    throw new ProtocolError(`${label} Manifest Digest 与 Run 锁定值不一致`, [
      `state=${expectedDigest}`,
      `manifest=${manifest.spec?.treeDigest ?? '(missing)'}`,
    ])
  }
  const snapshot = await snapshotTree(workspace, { maximumFileBytes, maximumTreeEntries })
  const digest = treeDigest(snapshot)
  if (digest !== manifest.spec?.treeDigest) {
    throw new ProtocolError(`${label} Workspace 已在进化后被修改`, [
      `manifest=${manifest.spec?.treeDigest ?? '(missing)'}`,
      `actual=${digest}`,
    ])
  }
  return digest
}

function meanReward(records) {
  const values = [...records.values()].map((record) => record.reward)
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new ProtocolError('Cowork Selection 缺少有效 Reward')
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function primaryMetricFromRecords(records, metric) {
  if (metric === 'mean-reward') return meanReward(records)
  if (metric === 'resolved-rate') {
    const values = [...records.values()]
    if (values.length === 0) throw new ProtocolError('Cowork Selection 缺少 Result Record')
    return values.filter((record) => record.status === 'resolved').length / values.length
  }
  throw new ProtocolError(`不支持的 Cowork 主指标：${metric}`)
}

function primaryMetricFromEvaluation(partition, metric) {
  if (metric === 'mean-reward') return partition.meanReward
  if (metric === 'resolved-rate') return partition.resolvedRate
  throw new ProtocolError(`不支持的 Cowork 主指标：${metric}`)
}

async function cumulativeCandidateDiff({ runRoot, baseline, candidate, limits }) {
  const [before, after] = await Promise.all([
    snapshotTree(baseline.workspace, limits),
    snapshotTree(candidate.workspace, limits),
  ])
  const changes = diffSnapshots(before, after)
  if (changes.length === 0) return { changes, patch: '', diffStat: '' }

  const baselinePath = relative(runRoot, baseline.workspace).replaceAll('\\', '/')
  const candidatePath = relative(runRoot, candidate.workspace).replaceAll('\\', '/')
  assertInside(runRoot, baseline.workspace, 'Baseline Workspace')
  assertInside(runRoot, candidate.workspace, 'Champion Workspace')
  const result = await runProcess('git', [
    'diff', '--no-index', '--binary', '--no-ext-diff', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '--', baselinePath, candidatePath,
  ], {
    cwd: runRoot,
    allowExitCodes: [0, 1],
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024 * 1024,
  })
  const patch = result.stdout
    .replaceAll(`a/${baselinePath}/`, 'a/')
    .replaceAll(`b/${candidatePath}/`, 'b/')
  const diffStat = changes
    .map((change) => `${change.path} | ${change.type}`)
    .join('\n')
  return { changes, patch, diffStat }
}

async function readPeerEvidence(coordination, maximumBytes = 64 * 1024) {
  const peers = []
  for (const peer of coordination?.peerLogs ?? []) {
    let source
    try {
      const info = await stat(peer.sourcePath)
      if (!info.isFile() || info.size > maximumBytes) {
        throw new ProtocolError(`Peer Evidence 文件无效：${peer.branchId}`)
      }
      source = await readFile(peer.sourcePath, 'utf8')
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(`无法读取 Peer Evidence：${peer.branchId}`, [error.message])
    }
    const entries = source.split(/\r?\n/u).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new ProtocolError(`Peer Evidence 第 ${index + 1} 行不是合法 JSON`, [error.message])
      }
    })
    peers.push({ branchId: peer.branchId, entries })
  }
  return peers
}

function coworkBranchProjection({ branchId, state, stepId = null }) {
  const champion = state.spec.candidates.find((candidate) => candidate.id === state.spec.championId)
  if (!champion?.evaluation) throw new ProtocolError(`Cowork Branch ${branchId} 缺少 Champion Evaluation`)
  const lastCandidate = state.spec.lastCandidateId
    ? state.spec.candidates.find((candidate) => candidate.id === state.spec.lastCandidateId)
    : null
  return validateBranchProjection({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BranchProjection',
    branchId,
    status: state.metadata.status === 'paused' ? 'paused' : state.metadata.status === 'stopped' ? 'stopped' : 'active',
    completedSteps: state.spec.generationsCompleted,
    incumbent: {
      candidateId: champion.id,
      revision: champion.digest,
      digest: champion.digest,
      evaluation: champion.evaluation,
    },
    lastStep: lastCandidate
      ? {
          stepId: stepId ?? state.spec.lastStepId,
          stepNumber: state.spec.generationsCompleted,
          candidateId: lastCandidate.id,
          decision: lastCandidate.status === 'promoted'
            ? 'promoted'
            : lastCandidate.status === 'rejected'
              ? 'rejected'
              : 'invalid',
          ranking: {
            eligible: lastCandidate.status === 'promoted',
            evaluation: lastCandidate.evaluation ?? null,
          },
        }
      : null,
  })
}

/**
 * Cowork 的单 Branch 执行面。Population 只通过通用 BranchEvolutionDriver 调它，
 * 不读取 SkillsBench、Overlay、SearchStrategy 或 Candidate Store 的内部字段。
 */
export function createCoworkBranchEvolutionDriver({
  repositoryRoot,
  experimentPath,
  runId,
  branchId,
  runRootOverride = null,
  expectedBundleDigest = null,
  onEvent = () => {},
}) {
  safeRunId(runId)
  let context = null
  let environment = null
  let state = null
  let champion = null
  let runRoot = null
  let startedAt = null
  let candidatesEvaluated = 0
  let mutationCatalog = null
  let materializedCandidates = null
  let peerEvidencePath = null

  async function persist() {
    await writeJsonFile(join(runRoot, 'state.json'), state)
  }

  async function initialize() {
    if (state) throw new ProtocolError(`Cowork Branch ${branchId} 已经初始化`)
    const controllerRevision = await trustedControllerRevision(repositoryRoot)
    context = await createContext({ repositoryRoot, experimentPath, gatewayScope: runId })
    context.repositoryRoot = repositoryRoot
    context.runId = runId
    const frozenBundle = expectedBundleDigest === null
      ? null
      : await assertPopulationBundleMatches({
          bundle: context.bundle,
          repositoryRoot,
          expectedDigest: expectedBundleDigest,
        })
    assertSecrets(requiredSecrets(context.bundle))
    validateModelGatewayEnvironment(context.bundle.environment.modelGateway)
    if (runRootOverride) {
      runRoot = resolve(runRootOverride)
      await mkdir(resolve(runRoot, '..'), { recursive: true })
    } else {
      const runtimeBase = resolveInside(
        repositoryRoot,
        context.bundle.target.materialization.runtimeRoot,
        'Target Runtime Root',
      )
      await mkdir(runtimeBase, { recursive: true })
      runRoot = join(await realpath(runtimeBase), runId)
    }
    if (await pathExists(runRoot)) throw new ProtocolError(`Run 已存在，拒绝覆盖：${runRoot}`)
    await mkdir(runRoot, { recursive: false })
    if (frozenBundle) {
      const trustedInputsRoot = join(runRoot, 'trusted-inputs')
      await mkdir(trustedInputsRoot, { recursive: false, mode: 0o700 })
      context.updaterPromptPath = join(trustedInputsRoot, 'updater-prompt.md')
      await writeFile(context.updaterPromptPath, frozenBundle.updaterPromptSource, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o400,
      })
    }
    context.runRoot = runRoot
    startedAt = Date.now()
    environment = createEnvironmentRunner({
      environment: context.bundle.environment,
      benchmark: context.bundle.benchmark,
      target: context.bundle.target,
      solverDriver: context.solverDriver,
      docker: context.docker,
      runRoot,
    })
    onEvent({ stage: 'preflight', message: `校验 Cowork Branch ${branchId} 的 Target 与 Environment` })
    const environmentStatus = await environment.preflight()
    await context.searchStrategy.preflight()
    for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
    await context.updaterDriver.ensureRuntime()
    champion = await materializeH0({ context, runRoot })
    materializedCandidates = new Map([[champion.id, champion]])
    mutationCatalog = mutationCatalogFor(context.bundle.target)
    const compatibilityPolicy = mutationPolicyFor(
      context.bundle.target,
      context.bundle.recipe.spec.moduleSearch.riskCeiling,
    )
    await Promise.all([
      writeJsonFile(join(runRoot, 'mutation-policy.json'), compatibilityPolicy),
      writeJsonFile(join(runRoot, 'mutation-catalog.json'), mutationCatalog),
    ])
    const seeds = context.bundle.experiment.evolution.seeds.slice(
      0,
      context.bundle.experiment.evolution.trialsPerInstance,
    )
    if (seeds.length !== context.bundle.experiment.evolution.trialsPerInstance) {
      throw new ProtocolError('Experiment 的 seeds 数量少于 trialsPerInstance')
    }
    let baselineRecords
    try {
      baselineRecords = await environment.runCandidatePartition({
        candidateId: champion.id,
        candidateWorkspace: champion.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'selection',
        seeds,
        outputPath: resultPath(runRoot, 0, champion.id, 'selection'),
      })
    } finally {
      await context.modelGateway.stop()
    }
    const baselineEvaluation = createEvaluationSummary({
      candidateId: champion.id,
      metric: context.bundle.policy.primaryMetric,
      value: primaryMetricFromRecords(baselineRecords, context.bundle.policy.primaryMetric),
    })
    const experimentRelativePath = relative(repositoryRoot, context.absoluteExperimentPath).replaceAll('\\', '/')
    state = {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionRunState',
      metadata: { id: runId, status: 'running' },
      spec: {
        branchId,
        experimentPath: experimentRelativePath,
        controllerRevision,
        targetSourceRevision: context.targetSourceRevision,
        updaterSourceRevision: context.updaterSourceRevision,
        benchmarkSourceRevision: environmentStatus.sourceRevision,
        baselineId: champion.id,
        championId: champion.id,
        mutationLevel: context.bundle.recipe.spec.moduleSearch.riskCeiling,
        recipe: context.bundle.recipe,
        searchStrategy: context.searchStrategy.descriptor(),
        searchStrategyState: null,
        generationsRequested: context.bundle.recipe.spec.population.budget.total_budget,
        generationsCompleted: 0,
        seeds,
        candidates: [{
          id: champion.id,
          parentId: null,
          digest: champion.digest,
          status: 'baseline',
          evaluation: baselineEvaluation,
        }],
        searchHistory: [],
        lastCandidateId: null,
        lastStepId: null,
        ledger: buildLedger({
          generations: 0,
          candidatesEvaluated: 0,
          startedAt,
          solverUsage: context.solverDriver.usage(),
          updaterUsage: context.updaterDriver.usage(),
        }),
        final: null,
      },
    }
    const experimentSnapshot = publicBundleSnapshot(context.bundle)
    state.spec.configDigest = jsonDigest(experimentSnapshot)
    peerEvidencePath = join(runRoot, 'public', 'evolution-log.jsonl')
    await mkdir(join(runRoot, 'public'), { recursive: true })
    await Promise.all([
      writeFile(peerEvidencePath, '', { encoding: 'utf8', mode: 0o600 }),
      writeJsonFile(join(runRoot, 'experiment.snapshot.json'), experimentSnapshot),
      persist(),
    ])
    return coworkBranchProjection({ branchId, state })
  }

  async function advanceOne({ stepId, coordination }) {
    if (!state) throw new ProtocolError(`Cowork Branch ${branchId} 尚未初始化`)
    if (state.metadata.status === 'stopped') {
      return validateBranchStepResult({
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'BranchStepResult',
        stepId,
        budgetConsumed: 0,
        projection: coworkBranchProjection({ branchId, state }),
      })
    }
    const generation = state.spec.generationsCompleted + 1
    const generationRoot = join(runRoot, 'generations', `generation-${generation}`)
    await mkdir(generationRoot, { recursive: true })
    const moduleSearch = context.bundle.recipe.spec.moduleSearch
    let proposed
    if (moduleSearch.authority === 'strategy-directed') {
      proposed = await context.searchStrategy.propose({
        runId,
        generation,
        riskCeiling: state.spec.mutationLevel,
        catalog: mutationCatalog,
        championId: champion.id,
        allowedParentIds: [...materializedCandidates.keys()],
        candidates: state.spec.candidates.map((candidate) => ({
          id: candidate.id,
          parentId: candidate.parentId,
          digest: candidate.digest,
          status: candidate.status,
        })),
        searchHistory: state.spec.searchHistory.slice(-MAXIMUM_STRATEGY_HISTORY_ENTRIES),
      }, state.spec.searchStrategyState)
      state.spec.searchStrategyState = proposed.state
    } else {
      proposed = {
        state: state.spec.searchStrategyState,
        plan: {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'MutationPlan',
          metadata: { id: `generation-${String(generation).padStart(4, '0')}-updater` },
          spec: {
            generation,
            parentIds: [champion.id],
            regionIds: mutationCatalog.spec.regions
              .filter((region) => Number(region.riskLevel.slice(1)) <= Number(state.spec.mutationLevel.slice(1)))
              .map((region) => region.id),
          },
        },
      }
    }
    const mutationPlan = validateMutationPlan(proposed.plan, {
      catalog: mutationCatalog,
      riskCeiling: state.spec.mutationLevel,
      allowedParentIds: [...materializedCandidates.keys()],
      expectedGeneration: generation,
    })
    if (state.spec.searchHistory.some((entry) => entry.mutationPlanId === mutationPlan.metadata.id)) {
      throw new ProtocolError(`Search Strategy 重复使用 MutationPlan ID：${mutationPlan.metadata.id}`)
    }
    const mutationLease = issueMutationLease({
      target: context.bundle.target,
      catalog: mutationCatalog,
      plan: mutationPlan,
      riskCeiling: state.spec.mutationLevel,
    })
    const mutationParent = materializedCandidates.get(mutationPlan.spec.parentIds[0])
    if (!mutationParent) throw new ProtocolError('Module Search 选择的父 Candidate 尚未实例化')
    await Promise.all([
      writeJsonFile(join(generationRoot, 'mutation-plan.json'), mutationPlan),
      writeJsonFile(join(generationRoot, 'mutation-lease.json'), mutationLease),
    ])

    let proposal
    let rejection = null
    let historyEntry
    let phase = 'feedback'
    try {
      onEvent({ stage: 'feedback', generation, message: `${branchId}/${mutationParent.id} 运行 feedback Partition` })
      const feedbackRecords = await environment.runCandidatePartition({
        candidateId: mutationParent.id,
        candidateWorkspace: mutationParent.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'feedback',
        seeds: state.spec.seeds,
        outputPath: resultPath(runRoot, generation, mutationParent.id, 'feedback'),
      })
      const feedbackPacket = buildFeedbackPacket({
        runId,
        generation,
        candidateId: mutationParent.id,
        benchmark: context.bundle.benchmark,
        records: feedbackRecords,
        maximumTextBytesPerCase: context.bundle.environment.feedback.maximumTextBytesPerCase,
        maximumArtifactEntriesPerCase: context.bundle.environment.feedback.maximumArtifactEntriesPerCase,
        maximumArtifactBytesPerCase: context.bundle.environment.feedback.maximumArtifactBytesPerCase,
        secretValues: secretValuesFromEnvironment(requiredSecrets(context.bundle)),
        searchHistory: state.spec.searchHistory,
        peerEvidence: await readPeerEvidence(coordination),
        maximumHistoryEntries: context.bundle.environment.feedback.maximumHistoryEntries,
        maximumHistoryBytes: context.bundle.environment.feedback.maximumHistoryBytes,
      })
      await writeJsonFile(join(generationRoot, 'feedback-packet.json'), feedbackPacket)
      phase = 'update'
      proposal = await runUpdaterGeneration({
        context,
        runRoot,
        generation,
        parent: mutationParent,
        feedbackPacket,
        mutationPolicy: mutationLease,
      })
      materializedCandidates.set(proposal.id, proposal)
      candidatesEvaluated += 1
      phase = 'selection'
      const baselineRecords = await environment.runCandidatePartition({
        candidateId: champion.id,
        candidateWorkspace: champion.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'selection',
        seeds: state.spec.seeds,
        outputPath: resultPath(runRoot, generation, champion.id, 'selection'),
      })
      const candidateRecords = await environment.runCandidatePartition({
        candidateId: proposal.id,
        candidateWorkspace: proposal.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'selection',
        seeds: state.spec.seeds,
        outputPath: resultPath(runRoot, generation, proposal.id, 'selection'),
      })
      const evaluation = evaluateBenchmark({
        benchmark: context.bundle.benchmark,
        policy: context.bundle.policy,
        run: { id: runId, baselineRevision: champion.digest, candidateRevision: proposal.digest },
        baselineRecords,
        candidateRecords,
        partitions: ['selection'],
        evolutionLedger: buildLedger({
          generations: generation,
          candidatesEvaluated,
          startedAt,
          solverUsage: context.solverDriver.usage(),
          updaterUsage: context.updaterDriver.usage(),
        }),
      })
      await writeJsonFile(join(proposal.root, 'evaluation.json'), evaluation)
      const candidateEvaluation = createEvaluationSummary({
        candidateId: proposal.id,
        metric: context.bundle.policy.primaryMetric,
        value: primaryMetricFromEvaluation(
          evaluation.partitions.selection.candidate,
          context.bundle.policy.primaryMetric,
        ),
      })
      const parentId = mutationParent.id
      const championBeforeId = champion.id
      if (evaluation.decision.eligible) champion = proposal
      else rejection = { stage: 'selection-gates', message: 'Candidate 未通过晋升 Gate', details: [] }
      const candidateRecord = {
        id: proposal.id,
        parentId,
        digest: proposal.digest,
        status: evaluation.decision.eligible ? 'promoted' : 'rejected',
        evaluation: candidateEvaluation,
        mutationPlanId: mutationPlan.metadata.id,
        regionIds: mutationPlan.spec.regionIds,
        decision: evaluation.decision,
      }
      state.spec.candidates.push(candidateRecord)
      historyEntry = {
        generation,
        parentId,
        proposalId: proposal.id,
        status: candidateRecord.status,
        hypothesis: proposal.report.hypothesis,
        changedFiles: proposal.report.changedFiles,
        expectedImpact: proposal.report.expectedImpact,
        mutationPlanId: mutationPlan.metadata.id,
        regionIds: mutationPlan.spec.regionIds,
        selection: publicDecision(evaluation.decision),
        primaryMetric: candidateEvaluation.primary,
        championBeforeId,
        championAfterId: champion.id,
      }
    } catch (error) {
      // Feedback/Selection/Verifier 出错属于实验基础设施或可信评测失败，不能伪装成
      // 一个“0 分 Candidate”。只有 Updater 自己产生的非法或越界提案才记 invalid。
      if (phase !== 'update' || !(error instanceof CandidateMutationError)) throw error
      rejection = { stage: 'update-and-diff', message: error.message, details: error.details ?? [] }
      const rejectedId = proposal?.id ?? `g${String(generation).padStart(3, '0')}-${state.spec.mutationLevel}`
      if (!state.spec.candidates.some((candidate) => candidate.id === rejectedId)) {
        state.spec.candidates.push({
          id: rejectedId,
          parentId: mutationParent.id,
          digest: proposal?.digest ?? null,
          status: 'invalid-proposal',
          evaluation: null,
          mutationPlanId: mutationPlan.metadata.id,
          regionIds: mutationPlan.spec.regionIds,
          rejection,
        })
      }
      historyEntry = {
        generation,
        parentId: mutationParent.id,
        proposalId: rejectedId,
        status: 'invalid-proposal',
        mutationPlanId: mutationPlan.metadata.id,
        regionIds: mutationPlan.spec.regionIds,
        rejection: { stage: rejection.stage, message: rejection.message },
      }
    } finally {
      await context.modelGateway.stop()
    }

    state.spec.searchHistory.push(historyEntry)
    state.spec.championId = champion.id
    state.spec.generationsCompleted = generation
    state.spec.lastCandidateId = historyEntry.proposalId
    state.spec.lastStepId = stepId
    state.spec.ledger = buildLedger({
      generations: generation,
      candidatesEvaluated,
      startedAt,
      solverUsage: context.solverDriver.usage(),
      updaterUsage: context.updaterDriver.usage(),
    })
    await appendFile(peerEvidencePath, `${JSON.stringify({
      branchId,
      ...historyEntry,
    })}\n`, 'utf8')
    if (moduleSearch.authority === 'strategy-directed') {
      const observed = await context.searchStrategy.observe({
        runId,
        generation,
        parentId: mutationParent.id,
        proposalId: historyEntry.proposalId,
        status: historyEntry.status,
        championId: champion.id,
        regionIds: mutationPlan.spec.regionIds,
        ...(historyEntry.selection ? { selection: historyEntry.selection } : {}),
        ...(historyEntry.rejection ? { rejection: historyEntry.rejection } : {}),
      }, state.spec.searchStrategyState)
      state.spec.searchStrategyState = observed.state
      if (observed.exhausted) {
        state.metadata.status = 'stopped'
        state.spec.searchExhaustion = {
          generation,
          strategy: context.searchStrategy.id,
          reason: 'risk-ceiling-stagnated',
        }
      }
    }
    await persist()
    return validateBranchStepResult({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'BranchStepResult',
      stepId,
      budgetConsumed: 1,
      projection: coworkBranchProjection({ branchId, state, stepId }),
    })
  }

  return {
    initialize,
    async inspect() {
      if (!state) throw new ProtocolError(`Cowork Branch ${branchId} 尚未初始化`)
      return coworkBranchProjection({ branchId, state })
    },
    advanceOne,
    async exportPeerEvidence() {
      if (!state) throw new ProtocolError(`Cowork Branch ${branchId} 尚未初始化`)
      return {
        sourcePath: peerEvidencePath,
        entries: structuredClone(state.spec.searchHistory),
        evolution: structuredClone(state.spec.ledger),
      }
    },
    async exportBest() {
      if (!state) throw new ProtocolError(`Cowork Branch ${branchId} 尚未初始化`)
      const record = state.spec.candidates.find((candidate) => candidate.id === champion.id)
      const baseline = materializedCandidates.get(state.spec.baselineId)
      const materialized = materializedCandidates.get(champion.id)
      if (!baseline || !materialized || !record?.evaluation) {
        throw new ProtocolError(`Cowork Branch ${branchId} 无法定位 Baseline 或 Champion`)
      }
      const cumulative = await cumulativeCandidateDiff({
        runRoot,
        baseline,
        candidate: materialized,
        limits: {
          maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
          maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
        },
      })
      return {
        candidateId: champion.id,
        revision: champion.digest,
        digest: champion.digest,
        evaluation: record.evaluation,
        changedFiles: cumulative.changes.map((change) => change.path),
        diffStat: cumulative.diffStat,
        patch: cumulative.patch,
        evolution: structuredClone(state.spec.ledger),
        workspace: champion.workspace,
        implementationRoot: champion.root,
      }
    },
  }
}

export async function runEvolution({
  repositoryRoot,
  experimentPath,
  runId = createRunId(),
  onEvent = () => {},
}) {
  safeRunId(runId)
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  const context = await createContext({ repositoryRoot, experimentPath, gatewayScope: runId })
  context.repositoryRoot = repositoryRoot
  context.runId = runId
  assertSecrets(requiredSecrets(context.bundle))
  validateModelGatewayEnvironment(context.bundle.environment.modelGateway)
  const runtimeBase = resolveInside(
    repositoryRoot,
    context.bundle.target.materialization.runtimeRoot,
    'Target Runtime Root',
  )
  await mkdir(runtimeBase, { recursive: true })
  const actualRuntimeBase = await realpath(runtimeBase)
  assertInside(await realpath(repositoryRoot), actualRuntimeBase, 'Target Runtime Root')
  const runRoot = join(actualRuntimeBase, runId)
  if (await pathExists(runRoot)) throw new ProtocolError(`Run 已存在，拒绝覆盖：${runId}`)
  await mkdir(runRoot, { recursive: false })
  context.runRoot = runRoot
  const startedAt = Date.now()

  const environment = createEnvironmentRunner({
    environment: context.bundle.environment,
    benchmark: context.bundle.benchmark,
    target: context.bundle.target,
    solverDriver: context.solverDriver,
    docker: context.docker,
    runRoot,
  })
  onEvent({ stage: 'preflight', message: '校验 Docker、DSH Source 与 SkillsBench Revision' })
  const environmentStatus = await environment.preflight()
  await context.searchStrategy.preflight()
  for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
  const updaterImageRevision = await context.docker.imageExists(context.bundle.updater.runtime.image)
    ? await context.docker.imageLabel(context.bundle.updater.runtime.image, 'org.opencontainers.image.revision')
    : null
  if (updaterImageRevision !== context.updaterSourceRevision) {
    onEvent({ stage: 'runtime-build', message: `构建 Updater Runtime ${context.bundle.updater.runtime.image}` })
  }
  await context.updaterDriver.ensureRuntime()

  const h0 = await materializeH0({ context, runRoot })
  let champion = h0
  const materializedCandidates = new Map([[h0.id, h0]])
  let candidatesEvaluated = 0
  const compatibilityPolicy = mutationPolicyFor(
    context.bundle.target,
    context.bundle.experiment.evolution.mutationLevel,
  )
  const mutationCatalog = mutationCatalogFor(context.bundle.target)
  await Promise.all([
    writeJsonFile(join(runRoot, 'mutation-policy.json'), compatibilityPolicy),
    writeJsonFile(join(runRoot, 'mutation-catalog.json'), mutationCatalog),
  ])
  const experimentRelativePath = relative(repositoryRoot, context.absoluteExperimentPath).replaceAll('\\', '/')
  const state = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionRunState',
    metadata: { id: runId, status: 'running' },
    spec: {
      experimentPath: experimentRelativePath,
      controllerRevision,
      targetSourceRevision: context.targetSourceRevision,
      updaterSourceRevision: context.updaterSourceRevision,
      benchmarkSourceRevision: environmentStatus.sourceRevision,
      baselineId: h0.id,
      championId: champion.id,
      mutationLevel: context.bundle.experiment.evolution.mutationLevel,
      searchStrategy: context.searchStrategy.descriptor(),
      searchStrategyState: null,
      generationsRequested: context.bundle.experiment.evolution.generations,
      generationsCompleted: 0,
      seeds: context.bundle.experiment.evolution.seeds.slice(
        0,
        context.bundle.experiment.evolution.trialsPerInstance,
      ),
      candidates: [{ id: h0.id, parentId: null, digest: h0.digest, status: 'baseline' }],
      searchHistory: [],
      final: null,
    },
  }
  if (state.spec.seeds.length !== context.bundle.experiment.evolution.trialsPerInstance) {
    throw new ProtocolError('Experiment 的 seeds 数量少于 trialsPerInstance')
  }
  const experimentSnapshot = publicBundleSnapshot(context.bundle)
  state.spec.configDigest = jsonDigest(experimentSnapshot)
  await writeJsonFile(join(runRoot, 'experiment.snapshot.json'), experimentSnapshot)
  await writeJsonFile(join(runRoot, 'state.json'), state)

  try {
    for (let generation = 1; generation <= context.bundle.experiment.evolution.generations; generation += 1) {
      const generationRoot = join(runRoot, 'generations', `generation-${generation}`)
      await mkdir(generationRoot, { recursive: true })
      const proposed = await context.searchStrategy.propose({
        runId,
        generation,
        riskCeiling: state.spec.mutationLevel,
        catalog: mutationCatalog,
        championId: champion.id,
        allowedParentIds: [...materializedCandidates.keys()],
        candidates: state.spec.candidates.map((candidate) => ({
          id: candidate.id,
          parentId: candidate.parentId,
          digest: candidate.digest,
          status: candidate.status,
        })),
        // Strategy 已通过 observe 持有自己的有界状态；这里只回放最近摘要，
        // 避免长运行的协议请求随轮次无限增长。
        searchHistory: state.spec.searchHistory.slice(-MAXIMUM_STRATEGY_HISTORY_ENTRIES),
      }, state.spec.searchStrategyState)
      state.spec.searchStrategyState = proposed.state
      const mutationPlan = proposed.plan
      if (state.spec.searchHistory.some((entry) => entry.mutationPlanId === mutationPlan.metadata.id)) {
        throw new ProtocolError(`Search Strategy 重复使用 MutationPlan ID：${mutationPlan.metadata.id}`)
      }
      const mutationLease = issueMutationLease({
        target: context.bundle.target,
        catalog: mutationCatalog,
        plan: mutationPlan,
        riskCeiling: state.spec.mutationLevel,
      })
      const mutationParent = materializedCandidates.get(mutationPlan.spec.parentIds[0])
      if (!mutationParent) throw new ProtocolError('Search Strategy 选择的父 Candidate 尚未实例化')
      await Promise.all([
        writeJsonFile(join(generationRoot, 'mutation-plan.json'), mutationPlan),
        writeJsonFile(join(generationRoot, 'mutation-lease.json'), mutationLease),
      ])

      onEvent({ stage: 'feedback', generation, message: `${mutationParent.id} 运行 feedback Partition` })
      const feedbackRecords = await environment.runCandidatePartition({
        candidateId: mutationParent.id,
        candidateWorkspace: mutationParent.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'feedback',
        seeds: state.spec.seeds,
        outputPath: resultPath(runRoot, generation, mutationParent.id, 'feedback'),
      })
      const feedbackPacket = buildFeedbackPacket({
        runId,
        generation,
        candidateId: mutationParent.id,
        benchmark: context.bundle.benchmark,
        records: feedbackRecords,
        maximumTextBytesPerCase: context.bundle.environment.feedback.maximumTextBytesPerCase,
        maximumArtifactEntriesPerCase:
          context.bundle.environment.feedback.maximumArtifactEntriesPerCase,
        maximumArtifactBytesPerCase:
          context.bundle.environment.feedback.maximumArtifactBytesPerCase,
        secretValues: secretValuesFromEnvironment(requiredSecrets(context.bundle)),
        searchHistory: state.spec.searchHistory,
        maximumHistoryEntries: context.bundle.environment.feedback.maximumHistoryEntries,
        maximumHistoryBytes: context.bundle.environment.feedback.maximumHistoryBytes,
      })
      await writeJsonFile(join(generationRoot, 'feedback-packet.json'), feedbackPacket)

      let proposal
      let rejection = null
      let historyEntry
      try {
        onEvent({ stage: 'update', generation, message: `启动 ${state.spec.mutationLevel.toUpperCase()} Updater Session` })
        proposal = await runUpdaterGeneration({
          context,
          runRoot,
          generation,
          parent: mutationParent,
          feedbackPacket,
          mutationPolicy: mutationLease,
        })
        materializedCandidates.set(proposal.id, proposal)
      } catch (error) {
        rejection = {
          stage: 'update-and-diff',
          message: error.message,
          details: error.details ?? [],
        }
      }

      if (proposal) {
        candidatesEvaluated += 1
        onEvent({ stage: 'selection', generation, message: `${champion.id} 与 ${proposal.id} 配对评测` })
        const baselineRecords = await environment.runCandidatePartition({
          candidateId: champion.id,
          candidateWorkspace: champion.workspace,
          model: context.bundle.experiment.models.solver,
          partition: 'selection',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, champion.id, 'selection'),
        })
        const candidateRecords = await environment.runCandidatePartition({
          candidateId: proposal.id,
          candidateWorkspace: proposal.workspace,
          model: context.bundle.experiment.models.solver,
          partition: 'selection',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, proposal.id, 'selection'),
        })
        const evaluation = evaluateBenchmark({
          benchmark: context.bundle.benchmark,
          policy: context.bundle.policy,
          run: { id: runId, baselineRevision: champion.digest, candidateRevision: proposal.digest },
          baselineRecords,
          candidateRecords,
          partitions: ['selection'],
          evolutionLedger: buildLedger({
            generations: generation,
            candidatesEvaluated,
            startedAt,
            solverUsage: context.solverDriver.usage(),
            updaterUsage: context.updaterDriver.usage(),
          }),
        })
        await writeJsonFile(join(proposal.root, 'evaluation.json'), evaluation)
        const parentId = mutationParent.id
        const championBeforeId = champion.id
        if (evaluation.decision.eligible) champion = proposal
        else rejection = { stage: 'selection-gates', message: 'Candidate 未通过晋升 Gate', details: [] }
        state.spec.candidates.push({
          id: proposal.id,
          parentId,
          digest: proposal.digest,
          status: evaluation.decision.eligible ? 'promoted' : 'rejected',
          mutationPlanId: mutationPlan.metadata.id,
          regionIds: mutationPlan.spec.regionIds,
          decision: evaluation.decision,
        })
        historyEntry = {
          generation,
          parentId,
          proposalId: proposal.id,
          status: evaluation.decision.eligible ? 'promoted' : 'rejected',
          hypothesis: proposal.report.hypothesis,
          changedFiles: proposal.report.changedFiles,
          expectedImpact: proposal.report.expectedImpact,
          mutationPlanId: mutationPlan.metadata.id,
          regionIds: mutationPlan.spec.regionIds,
          selection: publicDecision(evaluation.decision),
          championBeforeId,
          championAfterId: champion.id,
        }
        await appendRegistry(repositoryRoot, {
          runId,
          candidateId: proposal.id,
          parentId,
          digest: proposal.digest,
          mutationLevel: state.spec.mutationLevel,
          regionIds: mutationPlan.spec.regionIds,
          status: evaluation.decision.eligible ? 'promoted' : 'rejected',
        })
      } else {
        const rejectedId = `g${String(generation).padStart(3, '0')}-${state.spec.mutationLevel}`
        state.spec.candidates.push({
          id: rejectedId,
          parentId: mutationParent.id,
          digest: null,
          status: 'rejected',
          mutationPlanId: mutationPlan.metadata.id,
          regionIds: mutationPlan.spec.regionIds,
          rejection,
        })
        historyEntry = {
          generation,
          parentId: mutationParent.id,
          proposalId: rejectedId,
          status: 'invalid-proposal',
          mutationPlanId: mutationPlan.metadata.id,
          regionIds: mutationPlan.spec.regionIds,
          rejection: { stage: rejection.stage, message: rejection.message },
        }
      }

      state.spec.searchHistory.push(historyEntry)

      // 晋升决策是 Controller 事实，先持久再把结果告诉可能不可信的 Strategy。
      // observe 失败时 Run 会安全停止，但不会丢失已完成的 Candidate 谱系与决策。
      state.spec.championId = champion.id
      state.spec.generationsCompleted = generation
      await writeJsonFile(join(generationRoot, 'decision.json'), {
        generation,
        championId: champion.id,
        promoted: proposal ? champion.id === proposal.id : false,
        rejection,
      })
      await writeJsonFile(join(runRoot, 'state.json'), state)

      const observed = await context.searchStrategy.observe({
        runId,
        generation,
        parentId: mutationParent.id,
        proposalId: historyEntry.proposalId,
        status: historyEntry.status,
        championId: champion.id,
        regionIds: mutationPlan.spec.regionIds,
        ...(historyEntry.selection ? { selection: historyEntry.selection } : {}),
        ...(historyEntry.rejection ? { rejection: historyEntry.rejection } : {}),
      }, state.spec.searchStrategyState)
      state.spec.searchStrategyState = observed.state
      if (observed.exhausted) {
        state.spec.searchExhaustion = {
          generation,
          strategy: context.searchStrategy.id,
          reason: 'risk-ceiling-stagnated',
        }
      }

      onEvent({
        stage: 'decision',
        generation,
        message: proposal && champion.id === proposal.id ? `晋升 ${proposal.id}` : `保留 ${champion.id}`,
      })

      await writeJsonFile(join(runRoot, 'state.json'), state)
      if (observed.exhausted) break
    }
  } catch (error) {
    state.metadata.status = 'failed'
    state.spec.failure = { message: error.message, details: error.details ?? [] }
    await writeJsonFile(join(runRoot, 'state.json'), state)
    throw error
  } finally {
    const cleanupErrors = await context.modelGateway.stop()
    if (cleanupErrors.length > 0) {
      onEvent({ stage: 'cleanup-warning', message: `Model Gateway 清理失败：${cleanupErrors.join('；')}` })
    }
  }

  state.metadata.status = 'completed'
  state.spec.ledger = buildLedger({
    generations: state.spec.generationsCompleted,
    candidatesEvaluated,
    startedAt,
    solverUsage: context.solverDriver.usage(),
    updaterUsage: context.updaterDriver.usage(),
  })
  await writeJsonFile(join(runRoot, 'state.json'), state)
  onEvent({ stage: 'completed', message: `进化完成，Champion=${champion.id}` })
  return { runId, runRoot, championId: champion.id, state }
}

export async function runPopulationEvolution({
  repositoryRoot,
  experimentPath,
  runId = createRunId('cowork-population'),
  onEvent = () => {},
}) {
  safeRunId(runId)
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  const bundle = await loadExperimentBundle(resolve(experimentPath), repositoryRoot)
  const requestedRuntimeRoot = resolveInside(
    repositoryRoot,
    bundle.target.materialization.runtimeRoot,
    'Target Runtime Root',
  )
  await mkdir(requestedRuntimeRoot, { recursive: true })
  const [trustedRepositoryRoot, runtimeRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(requestedRuntimeRoot),
  ])
  assertInside(trustedRepositoryRoot, runtimeRoot, 'Target Runtime Root')
  const populationsRoot = join(runtimeRoot, 'populations')
  await mkdir(populationsRoot, { recursive: true })
  const frozenBundle = await capturePopulationBundle(bundle, repositoryRoot)
  const frozenConfig = frozenBundle.snapshot
  const loadedCampaign = {
    config: frozenConfig,
    recipe: bundle.recipe,
    configDigest: frozenBundle.digest,
    fingerprint: canonicalJsonDigest({ controllerRevision, configDigest: frozenBundle.digest }),
  }
  const orchestrator = new PopulationOrchestrator({
    loadedCampaign,
    campaignsRoot: populationsRoot,
    campaignId: runId,
    frozenConfig,
    secretValues: secretValuesFromEnvironment(requiredSecrets(bundle)),
    progress: (event) => onEvent({ stage: event.type, ...event, message: event.type }),
    createBranch({ branchId, branchesRoot }) {
      return createCoworkBranchEvolutionDriver({
        repositoryRoot,
        experimentPath,
        runId: `${runId}-${branchId}`,
        branchId,
        runRootOverride: join(branchesRoot, branchId, 'run'),
        expectedBundleDigest: frozenBundle.digest,
        onEvent,
      })
    },
  })
  await orchestrator.initialize()
  const state = await orchestrator.run()
  if (state.status === 'PAUSED_INFRASTRUCTURE') {
    throw new ProtocolError('Population 因基础设施故障暂停，拒绝把本次运行报告为成功', [
      `runRoot=${orchestrator.store.root}`,
    ])
  }
  return {
    runId,
    runRoot: orchestrator.store.root,
    championId: state.best.candidateId,
    state,
    population: true,
  }
}

/** 旧 Experiment 保持原单 Champion 目录格式；显式 Recipe 进入通用 Population。 */
export async function runConfiguredEvolution(options) {
  const experiment = await loadExperimentBundle(resolve(options.experimentPath), options.repositoryRoot)
  return experiment.experiment.recipePath === null
    ? await runEvolution(options)
    : await runPopulationEvolution(options)
}

function assertEvolutionRunState(state) {
  if (
    state?.apiVersion !== 'harness-rsi/v1alpha1' ||
    state?.kind !== 'EvolutionRunState' ||
    !state.spec ||
    typeof state.spec !== 'object' ||
    !Array.isArray(state.spec.candidates)
  ) {
    throw new ProtocolError('指定目录不是合法的 Evolution Run')
  }
  return state
}

function populationFinalEvent(state, type, at, details = {}) {
  return {
    sequence: state.events.length + 1,
    type,
    at,
    ...details,
  }
}

async function savePopulationFinalState(authorization, final, type, details = {}) {
  const at = new Date().toISOString()
  const previousUpdatedAt = authorization.state.updatedAt
  const next = {
    ...authorization.state,
    updatedAt: at,
    final,
    events: [
      ...authorization.state.events,
      populationFinalEvent(authorization.state, type, at, details),
    ],
  }
  await authorization.store.saveState(next, { expectedUpdatedAt: previousUpdatedAt })
  authorization.state = next
  return next
}

async function loadPopulationFinalAuthorization({ repositoryRoot, populationRoot }) {
  const state = await readJsonFile(join(populationRoot, 'public', 'state.json'))
  if (
    state?.apiVersion !== 'harness-rsi/v1alpha1' ||
    state?.kind !== 'PopulationCampaignState' ||
    !Array.isArray(state.branches) ||
    !Array.isArray(state.events)
  ) {
    throw new ProtocolError('指定目录不是合法的 Population Campaign')
  }
  if (!['CLOSED', 'REPORTED'].includes(state.status)) {
    throw new ProtocolError('只有已关闭的 Population 可以执行 Final Evaluation')
  }
  if (state.final !== null && state.final !== undefined) {
    throw new ProtocolError('Population Final Partition 已经解封过；禁止重复访问')
  }
  safeRunId(state.campaignId)
  if (typeof state.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(state.configDigest)
      || typeof state.configFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(state.configFingerprint)) {
    throw new ProtocolError('Population 缺少可验证的冻结配置摘要')
  }
  const currentControllerRevision = await trustedControllerRevision(repositoryRoot)
  const expectedFingerprint = canonicalJsonDigest({
    controllerRevision: currentControllerRevision,
    configDigest: state.configDigest,
  })
  if (expectedFingerprint !== state.configFingerprint) {
    throw new ProtocolError('当前 Controller Revision 或 Population Bundle 与冻结指纹不一致')
  }
  const branchId = state.best?.branchId
  if (typeof branchId !== 'string' || !/^branch-[0-9]{3}$/u.test(branchId)) {
    throw new ProtocolError('Population 缺少合法的 Best Branch')
  }
  const matchingBranches = state.branches.filter((branch) => branch.branchId === branchId)
  if (matchingBranches.length !== 1) throw new ProtocolError('Population Best Branch 无法唯一定位')
  const bestBranch = matchingBranches[0]
  for (const field of ['candidateId', 'digest', 'revision']) {
    if (typeof state.best?.[field] !== 'string'
        || state.best[field] !== bestBranch.incumbent?.[field]) {
      throw new ProtocolError(`Population Best ${field} 与 Branch Incumbent 不一致`)
    }
  }

  const store = new PopulationStore(dirname(populationRoot), basename(populationRoot))
  if (store.root !== populationRoot) throw new ProtocolError('Population Root 解析结果不一致')
  const report = await store.readReport()
  if (
    report.bestHarness?.kind !== 'BestHarnessImplementation' ||
    report.bestHarness.branchId !== branchId ||
    report.bestHarness.candidateId !== state.best.candidateId ||
    report.bestHarness.digest !== state.best.digest ||
    report.bestHarness.revision !== state.best.revision
  ) {
    throw new ProtocolError('Population Best Harness 报告与关闭状态不一致')
  }

  const branchesRoot = await realpath(store.branchesRoot)
  const runRoot = await realpath(join(branchesRoot, branchId, 'run'))
  assertInside(branchesRoot, runRoot, 'Population Best Branch Run')
  const branchState = assertEvolutionRunState(await readJsonFile(join(runRoot, 'state.json')))
  if (branchState.spec.branchId !== branchId) {
    throw new ProtocolError('Population Best Branch 与子 Run 身份不一致')
  }
  if (!['running', 'stopped', 'completed'].includes(branchState.metadata.status)) {
    throw new ProtocolError(`Population Best Branch 不能执行 Final：${branchState.metadata.status}`)
  }
  if (branchState.spec.final !== null) {
    throw new ProtocolError('Population Best Branch Final 已经解封过')
  }
  if (branchState.spec.championId !== state.best.candidateId) {
    throw new ProtocolError('Population Best Candidate 与子 Run Champion 不一致')
  }
  const champion = branchState.spec.candidates.find((candidate) => (
    candidate.id === branchState.spec.championId
  ))
  if (!champion || champion.digest !== state.best.digest) {
    throw new ProtocolError('Population Best Candidate Digest 与子 Run 不一致')
  }
  return { root: populationRoot, store, state, branchId, runRoot, branchState }
}

async function finalizeCoworkRun({
  repositoryRoot,
  runRoot,
  state,
  population = null,
  onEvent = () => {},
}) {
  assertEvolutionRunState(state)
  if (population === null && state.metadata.status !== 'completed') {
    throw new ProtocolError('只有 completed Run 可以执行 Final Evaluation')
  }
  if (state.spec.final !== null) throw new ProtocolError('Final Partition 已经解封过；禁止重复访问')
  safeRunId(state.metadata.id)
  const baselineId = safeCandidateId(state.spec.baselineId)
  const championId = safeCandidateId(state.spec.championId)
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  if (controllerRevision !== state.spec.controllerRevision) {
    throw new ProtocolError('当前 Controller Revision 与 Run 冻结值不一致', [
      `run=${state.spec.controllerRevision ?? '(missing)'}`,
      `current=${controllerRevision}`,
    ])
  }
  const experimentPath = resolveInside(repositoryRoot, state.spec.experimentPath, 'Run Experiment Path')
  const context = await createContext({
    repositoryRoot,
    experimentPath,
    runRootOverride: runRoot,
    gatewayScope: state.metadata.id,
  })
  context.repositoryRoot = repositoryRoot
  context.runId = state.metadata.id
  assertSecrets(requiredSecrets(context.bundle))
  validateModelGatewayEnvironment(context.bundle.environment.modelGateway)
  if (context.targetSourceRevision !== state.spec.targetSourceRevision) {
    throw new ProtocolError('当前 Target Source Revision 与 Run 冻结值不一致')
  }
  if (context.updaterSourceRevision !== state.spec.updaterSourceRevision) {
    throw new ProtocolError('当前 Updater Source Revision 与 Run 冻结值不一致')
  }
  const frozenSnapshot = await readJsonFile(join(runRoot, 'experiment.snapshot.json'))
  if (jsonDigest(frozenSnapshot) !== state.spec.configDigest) {
    throw new ProtocolError('Run 的冻结 Experiment Snapshot 与状态摘要不一致')
  }
  if (jsonDigest(publicBundleSnapshot(context.bundle)) !== state.spec.configDigest) {
    throw new ProtocolError('当前 Experiment/Adapter/Benchmark/Policy 已在进化后变更')
  }
  if (population !== null) {
    await assertPopulationBundleMatches({
      bundle: context.bundle,
      repositoryRoot,
      expectedDigest: population.state.configDigest,
    })
  }
  const environment = createEnvironmentRunner({
    environment: context.bundle.environment,
    benchmark: context.bundle.benchmark,
    target: context.bundle.target,
    solverDriver: context.solverDriver,
    docker: context.docker,
    runRoot,
  })
  onEvent({ stage: 'final-preflight', message: '重新确认冻结 Source 与 Benchmark Revision' })
  const environmentStatus = await environment.preflight()
  if (environmentStatus.sourceRevision !== state.spec.benchmarkSourceRevision) {
    throw new ProtocolError('当前 Benchmark Source Revision 与 Run 冻结值不一致')
  }
  for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
  const h0Root = resolve(runRoot, 'candidates', baselineId)
  const championRoot = resolve(runRoot, 'candidates', championId)
  assertInside(runRoot, h0Root, 'H0 Candidate')
  assertInside(runRoot, championRoot, 'Champion Candidate')
  const h0Workspace = await realpath(join(h0Root, 'workspace'))
  const championWorkspace = await realpath(join(championRoot, 'workspace'))
  assertInside(h0Root, h0Workspace, 'H0 Workspace')
  assertInside(championRoot, championWorkspace, 'Champion Workspace')
  const h0Manifest = await readJsonFile(join(h0Root, 'manifest.json'))
  const championManifest = await readJsonFile(join(championRoot, 'manifest.json'))
  const frozenCandidates = new Map(state.spec.candidates.map((candidate) => [candidate.id, candidate]))
  if (frozenCandidates.size !== state.spec.candidates.length) {
    throw new ProtocolError('Run 状态包含重复 Candidate ID')
  }
  const h0State = frozenCandidates.get(baselineId)
  const championState = frozenCandidates.get(championId)
  if (!h0State?.digest || !championState?.digest) {
    throw new ProtocolError('Run 状态缺少 H0 或 Champion 的冻结 Digest')
  }
  if (h0State.status !== 'baseline' || !['baseline', 'promoted'].includes(championState.status)) {
    throw new ProtocolError('Run 状态中的 H0 或 Champion 状态非法')
  }
  const integrityOptions = {
    sourceRevision: context.sourceRevision,
    maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
    maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
  }
  await assertCandidateIntegrity({
    ...integrityOptions,
    candidateId: baselineId,
    workspace: h0Workspace,
    manifest: h0Manifest,
    expectedDigest: h0State.digest,
    label: 'H0',
  })
  await assertCandidateIntegrity({
    ...integrityOptions,
    candidateId: championId,
    workspace: championWorkspace,
    manifest: championManifest,
    expectedDigest: championState.digest,
    label: 'Champion',
  })

  const finalAttemptId = randomUUID()
  const finalStartedAt = new Date().toISOString()
  await claimFinalAttempt(population?.root ?? runRoot, {
    attemptId: finalAttemptId,
    startedAt: finalStartedAt,
  })
  if (population !== null) {
    await savePopulationFinalState(population, {
      evaluated: false,
      attemptId: finalAttemptId,
      startedAt: finalStartedAt,
      branchId: population.branchId,
      candidateId: championId,
    }, 'POPULATION_FINAL_STARTED', {
      branchId: population.branchId,
      candidateId: championId,
    })
  }
  state.metadata.status = 'finalizing'
  state.spec.final = { evaluated: false, attemptId: finalAttemptId, startedAt: finalStartedAt }

  const generation = state.spec.generationsCompleted + 1
  try {
    await writeJsonFile(join(runRoot, 'state.json'), state)
    const baselineFeedbackRecords = await environment.runCandidatePartition({
      candidateId: baselineId,
      candidateWorkspace: h0Workspace,
      model: context.bundle.experiment.models.solver,
      partition: 'feedback',
      seeds: state.spec.seeds,
      outputPath: resultPath(runRoot, generation, baselineId, `feedback-final-${finalAttemptId}`),
    })
    const candidateFeedbackRecords = championId === baselineId
      ? baselineFeedbackRecords
      : await environment.runCandidatePartition({
          candidateId: championId,
          candidateWorkspace: championWorkspace,
          model: context.bundle.experiment.models.solver,
          partition: 'feedback',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, championId, `feedback-final-${finalAttemptId}`),
        })
    onEvent({ stage: 'final-feedback', message: 'H0 与锁定 Champion 已完成 Feedback 回放' })
    const baselineRecords = await environment.runCandidatePartition({
      candidateId: baselineId,
      candidateWorkspace: h0Workspace,
      model: context.bundle.experiment.models.solver,
      partition: 'final',
      seeds: state.spec.seeds,
      outputPath: resultPath(runRoot, generation, baselineId, `final-${finalAttemptId}`),
    })
    onEvent({ stage: 'final-baseline', message: `${baselineId} 已完成 Final Partition` })
    const candidateRecords = championId === baselineId
      ? baselineRecords
      : await environment.runCandidatePartition({
          candidateId: championId,
          candidateWorkspace: championWorkspace,
          model: context.bundle.experiment.models.solver,
          partition: 'final',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, championId, `final-${finalAttemptId}`),
        })
    const report = evaluateBenchmark({
      benchmark: context.bundle.benchmark,
      policy: context.bundle.policy,
      run: {
        id: population?.state.campaignId ?? state.metadata.id,
        baselineRevision: h0Manifest.spec.treeDigest,
        candidateRevision: championManifest.spec.treeDigest,
      },
      baselineRecords: new Map([...baselineFeedbackRecords, ...baselineRecords]),
      candidateRecords: new Map([...candidateFeedbackRecords, ...candidateRecords]),
      partitions: ['feedback', 'final'],
      evolutionLedger: state.spec.ledger ?? null,
      allowSealed: true,
    })
    const reportPath = population === null
      ? join(runRoot, 'final-evaluation.json')
      : await population.store.writeFinalReport(report)
    state.spec.final = {
      evaluated: true,
      attemptId: finalAttemptId,
      startedAt: finalStartedAt,
      completedAt: new Date().toISOString(),
      baselineId,
      candidateId: championId,
      report: population === null
        ? relative(runRoot, reportPath).replaceAll('\\', '/')
        : `population://${population.state.campaignId}/report/final-evaluation.json`,
    }
    state.metadata.status = 'finalized'
    await writeJsonFile(join(runRoot, 'state.json'), state)
    if (population !== null) {
      await savePopulationFinalState(population, {
        evaluated: true,
        attemptId: finalAttemptId,
        startedAt: finalStartedAt,
        completedAt: state.spec.final.completedAt,
        branchId: population.branchId,
        baselineId,
        candidateId: championId,
        report: 'report/final-evaluation.json',
        metrics: report.rsiMetrics,
      }, 'POPULATION_FINAL_COMPLETED', {
        branchId: population.branchId,
        baselineId,
        candidateId: championId,
        report: 'report/final-evaluation.json',
      })
    }
    onEvent({ stage: 'finalized', message: `Final 报告已写入 ${reportPath}` })
    return { runId: population?.state.campaignId ?? state.metadata.id, reportPath, report }
  } catch (error) {
    state.metadata.status = 'final-failed'
    state.spec.final = {
      ...state.spec.final,
      failedAt: new Date().toISOString(),
      failure: { message: error.message, details: error.details ?? [] },
    }
    await writeJsonFile(join(runRoot, 'state.json'), state)
    if (population !== null) {
      // Population public state/event 不回显 Final 任务、Verifier 或上游错误细节。
      const failure = {
        name: 'FinalEvaluationError',
        message: 'Final Evaluation failed; inspect trusted Controller logs',
      }
      await savePopulationFinalState(population, {
        ...(population.state.final ?? {}),
        evaluated: false,
        failedAt: state.spec.final.failedAt,
        failure,
      }, 'POPULATION_FINAL_FAILED', {
        branchId: population.branchId,
        candidateId: championId,
        failure,
      })
    }
    throw error
  } finally {
    const cleanupErrors = await context.modelGateway.stop()
    if (cleanupErrors.length > 0) {
      onEvent({ stage: 'cleanup-warning', message: `Model Gateway 清理失败：${cleanupErrors.join('；')}` })
    }
  }
}

export async function finalizeEvolution({ repositoryRoot, runDirectory, onEvent = () => {} }) {
  const runRoot = await realpath(resolve(runDirectory))
  assertInside(resolve(repositoryRoot, '.rsi/runs'), runRoot, 'Evolution Run')
  if (await pathExists(join(runRoot, 'public', 'state.json'))) {
    const population = await loadPopulationFinalAuthorization({ repositoryRoot, populationRoot: runRoot })
    return await finalizeCoworkRun({
      repositoryRoot,
      runRoot: population.runRoot,
      state: population.branchState,
      population,
      onEvent,
    })
  }
  const state = await readJsonFile(join(runRoot, 'state.json'))
  return await finalizeCoworkRun({ repositoryRoot, runRoot, state, onEvent })
}
