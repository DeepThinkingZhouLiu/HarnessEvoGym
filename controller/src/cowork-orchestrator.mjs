import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
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
import {
  createBaselineCompatibilityIdentity,
  loadBaselinePack,
  writeImportedRecords,
} from './baseline-pack.mjs'
import { assertPathKind, resolveInside } from './config.mjs'
import { DockerClient } from './docker.mjs'
import { AgentBayDockerClient } from './agentbay-docker.mjs'
import { evaluateBenchmark } from './evaluator.mjs'
import { createEnvironmentRunner, createSolverDriver, createUpdaterDriver } from './factories.mjs'
import { buildFeedbackPacket } from './feedback.mjs'
import {
  createGrhsMutationPlans,
  initialProposalPrior,
  scoreGrhsGroup,
} from './grhs.mjs'
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
import { PopulationStore } from './population-store.mjs'
import { acquireCampaignLock } from './campaign-lock.mjs'

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

async function assertControllerRevisionForFinal({
  repositoryRoot,
  frozenRevision,
  currentRevision,
  recoveryRequested,
}) {
  if (currentRevision === frozenRevision) return
  if (!recoveryRequested) {
    throw new ProtocolError('当前 Controller Revision 与 Run 冻结值不一致', [
      `run=${frozenRevision ?? '(missing)'}`,
      `current=${currentRevision}`,
    ])
  }
  if (typeof frozenRevision !== 'string' || !/^[0-9a-f]{40}$/u.test(frozenRevision)) {
    throw new ProtocolError('Run 缺少合法的冻结 Controller Revision')
  }
  const ancestry = await runProcess(
    'git',
    ['-C', repositoryRoot, 'merge-base', '--is-ancestor', frozenRevision, currentRevision],
    { timeoutMs: 30_000, allowExitCodes: [0, 1] },
  )
  if (ancestry.exitCode !== 0) {
    throw new ProtocolError('Final Recovery Controller 必须继承原进化 Controller Revision', [
      `run=${frozenRevision}`,
      `current=${currentRevision}`,
    ])
  }
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

const USAGE_COUNTER_FIELDS = Object.freeze([
  'requests',
  'usageResponses',
  'unknownUsageResponses',
  'observedInputTokens',
  'observedOutputTokens',
])

const COMPLETE_USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'reasoningTokens',
])

function assertUsageSnapshot(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.complete !== 'boolean') {
    throw new ProtocolError(`${label} Usage 格式无效`)
  }
  for (const field of USAGE_COUNTER_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new ProtocolError(`${label} Usage 字段无效：${field}`)
    }
  }
  for (const field of COMPLETE_USAGE_FIELDS) {
    if (value.complete) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
        throw new ProtocolError(`${label} Usage 字段无效：${field}`)
      }
    } else if (value[field] !== null) {
      throw new ProtocolError(`${label} Usage 不完整时 ${field} 必须为 null`)
    }
  }
  return value
}

function mergeUsageSnapshots(previous, current, label) {
  const right = assertUsageSnapshot(current, label)
  if (previous === null || previous === undefined) return structuredClone(right)
  const left = assertUsageSnapshot(previous, `已持久化 ${label}`)
  const complete = left.complete && right.complete
  const merged = {
    complete,
    ...Object.fromEntries(USAGE_COUNTER_FIELDS.map((field) => [field, left[field] + right[field]])),
  }
  for (const field of COMPLETE_USAGE_FIELDS) {
    merged[field] = complete ? left[field] + right[field] : null
  }
  return merged
}

function buildLedger({
  generations,
  candidatesEvaluated,
  startedAt,
  solverUsage,
  updaterUsage,
  previousLedger = null,
}) {
  if (previousLedger !== null && previousLedger !== undefined
      && (!Number.isSafeInteger(previousLedger.candidatesEvaluated)
        || previousLedger.candidatesEvaluated < 0
        || !Number.isSafeInteger(previousLedger.wallTimeMs)
        || previousLedger.wallTimeMs < 0)) {
    throw new ProtocolError('已持久化 Evolution Ledger 格式无效')
  }
  const mergedUpdaterUsage = mergeUsageSnapshots(
    previousLedger?.updaterUsage,
    updaterUsage,
    'Updater',
  )
  const mergedSolverUsage = mergeUsageSnapshots(
    previousLedger?.solverUsage,
    solverUsage,
    'Solver',
  )
  return {
    generations,
    candidatesEvaluated: (previousLedger?.candidatesEvaluated ?? 0) + candidatesEvaluated,
    updaterTokens: mergedUpdaterUsage.totalTokens,
    solverTokens: mergedSolverUsage.totalTokens,
    updaterUsage: mergedUpdaterUsage,
    solverUsage: mergedSolverUsage,
    costUsd: null,
    wallTimeMs: (previousLedger?.wallTimeMs ?? 0) + Date.now() - startedAt,
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

function grhsPatchComplexity(proposal, limits) {
  const changedFiles = proposal.policyReport.changedFiles / limits.maximumChangedFiles
  const changedBytes = proposal.policyReport.changedBytes / limits.maximumChangedBytes
  return (changedFiles + changedBytes) / 2
}

function grhsPolicyValid(evaluation) {
  const invalidGateIds = new Set([
    'baseline-record-coverage',
    'candidate-record-coverage',
    'baseline-completion',
    'candidate-completion',
    'maximum-policy-violations',
  ])
  return evaluation.decision.gates.every((gate) => !invalidGateIds.has(gate.id) || gate.passed)
}

function resultPath(runRoot, generation, candidateId, partition) {
  return join(runRoot, 'results', `generation-${generation}`, `${candidateId}-${partition}.jsonl`)
}

async function appendRegistry(repositoryRoot, record) {
  const registryRoot = resolve(repositoryRoot, '.rsi/registry')
  await mkdir(registryRoot, { recursive: true })
  await appendFile(join(registryRoot, 'candidates.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}

function makeDocker(environment, repositoryRoot) {
  if (environment.docker.backend === 'agentbay') {
    return new AgentBayDockerClient({
      network: environment.docker.network,
      resources: environment.docker.resources,
      runAsCurrentUser: environment.docker.runAsCurrentUser,
      agentBay: environment.docker.agentBay,
      repositoryRoot,
    })
  }
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
  const updaterSource = bundle.updater.source === null
    ? null
    : (bundle.updater.source.path === bundle.target.source.path
        ? targetSource
        : await resolvePinnedSource(repositoryRoot, bundle.updater.source, 'Updater Source'))
  if (updaterSource !== null && updaterSource.revision !== bundle.updater.source.revision) {
    throw new ProtocolError('Updater Adapter Revision 与复用的 Target Source Revision 不一致')
  }
  const updaterSourceRevision = updaterSource?.revision ?? bundle.updater.runtime.distributionDigest
  const baselineTemplate = bundle.target.materialization.baselinePath
    ? resolveInside(repositoryRoot, bundle.target.materialization.baselinePath, 'Target Baseline Path')
    : null
  if (baselineTemplate) await assertPathKind(baselineTemplate, 'Target Baseline Template')
  for (const [label, runtime, source] of [
    ...(['dsh-headless-docker', 'dsh-headless-docker-v1'].includes(bundle.target.solver.protocol)
      ? [['Target Solver', bundle.target.solver.runtime, targetSource]]
      : []),
    ...(updaterSource === null ? [] : [['Updater', bundle.updater.runtime, updaterSource]]),
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
    ...(bundle.updater.runtime.dockerfile
      ? [assertPathKind(
          resolveInside(repositoryRoot, bundle.updater.runtime.dockerfile, 'Updater Runtime Dockerfile'),
          'Updater Runtime Dockerfile',
          'file',
        )]
      : []),
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
  const docker = makeDocker(bundle.environment, repositoryRoot)
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
    sourceRevision: updaterSourceRevision,
    sourcePath: bundle.updater.source?.path ?? null,
    modelGateway,
  })
  const runRoot = runRootOverride
  return {
    bundle,
    sourceRoot: targetSource.root,
    targetSourceRoot: targetSource.root,
    targetSourceRevision: targetSource.revision,
    updaterSourceRoot: updaterSource?.root ?? null,
    updaterSourceRevision,
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
    repositoryRoot,
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
    image: context.bundle.updater.runtime.image ?? null,
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
  candidateId = null,
  groupContext = null,
}) {
  const level = context.bundle.experiment.evolution.mutationLevel
  const id = candidateId ?? `g${String(generation).padStart(3, '0')}-${level}`
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
      'group.context': groupContext === null
        ? '本轮不是分组搜索。'
        : `本轮是 GRHS sibling ${groupContext.memberIndex}/${groupContext.groupSize}。所有 sibling 共享同一父版本、反馈证据、Selection、Seed 和预算。\n当前 proposal prior：${JSON.stringify(groupContext.proposalPrior)}\n请生成独立、最小且可证伪的 Patch；不要模仿或依赖其他 sibling 的未公开结果。`,
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
      ...(bundle.experimentPath
        ? { experiment: { path: bundle.experimentPath } }
        : {}),
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

export async function claimFinalRecoveryAttempt(runRoot, {
  attemptId,
  startedAt,
  recoveredFromAttemptId,
  evolutionControllerRevision,
  finalizerControllerRevision,
}) {
  const claimPath = join(runRoot, 'final-recovery-attempt.json')
  let handle
  try {
    handle = await open(claimPath, 'wx', 0o444)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ProtocolError('Final Recovery Attempt 已被领取；禁止再次恢复')
    }
    throw new ProtocolError('无法原子领取 Final Recovery Attempt', [error.message])
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'FinalRecoveryAttemptClaim',
      metadata: { attemptId, startedAt },
      spec: {
        recoveredFromAttemptId,
        evolutionControllerRevision,
        finalizerControllerRevision,
      },
    }, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return claimPath
}

async function controllerEntry(pathValue, label) {
  try {
    const info = await lstat(pathValue)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new ProtocolError(`${label} 必须是 Controller 创建的普通文件或目录`)
    }
    return info
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function finalTrialRoot(runRoot, generation, candidateId, partition, attemptId) {
  if (!['feedback', 'final'].includes(partition)) {
    throw new ProtocolError(`Final Recovery Partition 无效：${partition}`)
  }
  const resultPartition = partition === 'feedback'
    ? `feedback-final-${attemptId}`
    : `final-${attemptId}`
  const outputPath = resultPath(
    runRoot,
    generation,
    candidateId,
    resultPartition,
  )
  const executionId = createHash('sha256').update(resolve(outputPath)).digest('hex').slice(0, 12)
  return join(runRoot, 'trials', executionId)
}

async function inspectFailedFinalArtifacts({
  runRoot,
  failedAttemptId,
  baselineId,
  championId,
  generationsCompleted,
}) {
  if (typeof failedAttemptId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(failedAttemptId)) {
    throw new ProtocolError('待恢复的 Final Attempt ID 无效')
  }
  const generation = generationsCompleted + 1
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ProtocolError('待恢复的 Final 缺少合法轮次')
  }
  const candidateIds = [...new Set([
    safeCandidateId(baselineId),
    safeCandidateId(championId),
  ])]
  const finalTrialRoots = candidateIds.map((candidateId) => (
    finalTrialRoot(runRoot, generation, candidateId, 'final', failedAttemptId)
  ))
  for (const pathValue of finalTrialRoots) {
    assertInside(runRoot, pathValue, 'Final Recovery 密封证据路径')
    if (await controllerEntry(pathValue, 'Final 试验产物')) {
      throw new ProtocolError('失败的 Final Attempt 已接触 sealed final；禁止恢复')
    }
  }

  const generationResults = join(runRoot, 'results', `generation-${generation}`)
  const resultInfo = await controllerEntry(generationResults, 'Final Result 轮次')
  const allowedFeedbackResults = new Set(candidateIds.map(
    (candidateId) => `${candidateId}-feedback-final-${failedAttemptId}.jsonl`,
  ))
  if (resultInfo) {
    if (!resultInfo.isDirectory()) throw new ProtocolError('Final Result 轮次必须是普通目录')
    const entries = await readdir(generationResults, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !allowedFeedbackResults.has(entry.name)) {
        throw new ProtocolError('Final Result 轮次存在非 Feedback 产物；禁止恢复', [entry.name])
      }
    }
  }

  const feedbackTrialRoots = candidateIds.map((candidateId) => (
    finalTrialRoot(runRoot, generation, candidateId, 'feedback', failedAttemptId)
  ))
  const sources = []
  if (resultInfo) sources.push(generationResults)
  for (const pathValue of feedbackTrialRoots) {
    assertInside(runRoot, pathValue, 'Final Recovery Feedback 路径')
    const info = await controllerEntry(pathValue, 'Final Feedback 试验产物')
    if (info && !info.isDirectory()) {
      throw new ProtocolError('Final Feedback 试验产物必须是普通目录')
    }
    if (info) sources.push(pathValue)
  }
  return { generation, sources: [...new Set(sources)].sort() }
}

/**
 * 只归档失败 Final 的公开 Feedback 回放；只要发现 sealed final 证据就 fail closed。
 */
export async function archiveFailedFinalAttempt({
  runRoot,
  failedAttemptId,
  baselineId,
  championId,
  generationsCompleted,
  now = () => new Date(),
}) {
  const inspection = await inspectFailedFinalArtifacts({
    runRoot,
    failedAttemptId,
    baselineId,
    championId,
    generationsCompleted,
  })
  if (inspection.sources.length === 0) return null

  const archivedAt = now().toISOString()
  const archiveId = `${archivedAt.replace(/[:.]/gu, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`
  const archiveBase = join(runRoot, 'final-recovery')
  const archiveRoot = join(archiveBase, `${failedAttemptId}-${archiveId}`)
  await mkdir(archiveBase, { recursive: true, mode: 0o700 })
  await mkdir(archiveRoot, { recursive: false, mode: 0o700 })
  const archived = []
  for (const source of inspection.sources) {
    const relativePath = relative(runRoot, source).replaceAll('\\', '/')
    const destination = join(archiveRoot, relativePath)
    assertInside(archiveRoot, destination, 'Final Recovery 归档路径')
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await rename(source, destination)
    archived.push(relativePath)
  }
  const manifest = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'FinalRecoveryArchive',
    metadata: { recoveredFromAttemptId: failedAttemptId, archivedAt },
    spec: {
      generation: inspection.generation,
      sealedFinalAccessed: false,
      archived,
    },
  }
  await writeJsonFile(join(archiveRoot, 'manifest.json'), manifest)
  return { root: archiveRoot, manifest }
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
            baselineEvaluation: lastCandidate.baselineEvaluation ?? null,
          },
        }
      : null,
  })
}

async function existingControllerDirectory(pathValue, label) {
  try {
    const info = await lstat(pathValue)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ProtocolError(`${label} 必须是 Controller 创建的普通目录`)
    }
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * 恢复时归档本轮编排产物，但保留 Environment 管理的 Trial Root。
 * OmegaUse 会逐题验证 committed-result.json，复用已提交题目，并把半成品题目单独移入
 * recovery/trial-attempts 后再运行。这里不能再整棵归档 trials/<executionId>。
 */
export async function archiveIncompleteCoworkGeneration({
  runRoot,
  state,
  preserveTrialCheckpoints = false,
  now = () => new Date(),
}) {
  const generation = state?.spec?.generationsCompleted + 1
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ProtocolError('Cowork 恢复状态缺少合法的 generationsCompleted')
  }
  if (state.metadata?.status === 'stopped') return null
  const level = state.spec.mutationLevel
  const nextCandidateId = safeCandidateId(`g${String(generation).padStart(3, '0')}-${level}`)
  const candidateIds = new Set([
    nextCandidateId,
    ...state.spec.candidates
      .filter((candidate) => candidate?.digest !== null)
      .map((candidate) => safeCandidateId(candidate.id)),
  ])
  const sources = new Set([
    join(runRoot, 'generations', `generation-${generation}`),
    join(runRoot, 'results', `generation-${generation}`),
    join(runRoot, 'candidates', nextCandidateId),
  ])
  if (!preserveTrialCheckpoints) {
    for (const candidateId of candidateIds) {
      for (const partition of ['feedback', 'selection']) {
        const outputPath = resultPath(runRoot, generation, candidateId, partition)
        const executionId = createHash('sha256').update(resolve(outputPath)).digest('hex').slice(0, 12)
        sources.add(join(runRoot, 'trials', executionId))
      }
    }
  }

  const existing = []
  for (const source of sources) {
    assertInside(runRoot, source, 'Cowork 恢复源路径')
    if (await existingControllerDirectory(source, 'Cowork 未完成产物')) existing.push(source)
  }
  if (existing.length === 0) return null

  const attemptId = `${now().toISOString().replace(/[:.]/gu, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`
  const recoveryBase = join(runRoot, 'recovery')
  const recoveryRoot = join(recoveryBase, `generation-${generation}-${attemptId}`)
  await mkdir(recoveryBase, { recursive: true, mode: 0o700 })
  await mkdir(recoveryRoot, { recursive: false, mode: 0o700 })
  const archived = []
  for (const source of existing.sort()) {
    const relativePath = relative(runRoot, source).replaceAll('\\', '/')
    const destination = join(recoveryRoot, relativePath)
    assertInside(recoveryRoot, destination, 'Cowork 恢复归档路径')
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await rename(source, destination)
    archived.push(relativePath)
  }
  const manifest = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'CoworkRecoveryArchive',
    metadata: { attemptId, archivedAt: now().toISOString() },
    spec: { generation, archived },
  }
  await writeJsonFile(join(recoveryRoot, 'manifest.json'), manifest)
  return { root: recoveryRoot, manifest }
}

function assertRestorableCoworkState(value, { runId, branchId }) {
  if (!value || value.apiVersion !== 'harness-rsi/v1alpha1'
      || value.kind !== 'EvolutionRunState'
      || value.metadata?.id !== runId
      || !['baseline-running', 'running', 'stopped'].includes(value.metadata?.status)
      || value.spec?.branchId !== branchId
      || !Array.isArray(value.spec.candidates)
      || !Array.isArray(value.spec.searchHistory)
      || !Number.isSafeInteger(value.spec.generationsCompleted)
      || value.spec.generationsCompleted < 0) {
    throw new ProtocolError(`Cowork Branch ${branchId} 持久化状态无法恢复`)
  }
  const ids = value.spec.candidates.map((candidate) => safeCandidateId(candidate?.id))
  if (new Set(ids).size !== ids.length || !ids.includes(value.spec.baselineId)
      || !ids.includes(value.spec.championId)) {
    throw new ProtocolError(`Cowork Branch ${branchId} Candidate 谱系无效`)
  }
  return value
}

/**
 * Cowork 的单 Branch 执行面。Population 只通过通用 BranchEvolutionDriver 调它，
 * 不读取具体 Environment、Overlay、SearchStrategy 或 Candidate Store 的内部字段。
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
  let ledgerOffset = null
  let baselinePack = null

  async function persist() {
    await writeJsonFile(join(runRoot, 'state.json'), state)
  }

  function ledger(generations) {
    return buildLedger({
      generations,
      candidatesEvaluated,
      startedAt,
      solverUsage: context.solverDriver.usage(),
      updaterUsage: context.updaterDriver.usage(),
      previousLedger: ledgerOffset,
    })
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
      repositoryRoot,
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
    if (context.bundle.experiment.baselinePack !== null) {
      baselinePack = await loadBaselinePack({
        repositoryRoot,
        reference: context.bundle.experiment.baselinePack,
        benchmark: context.bundle.benchmark,
        expectedIdentity: createBaselineCompatibilityIdentity({
          bundle: context.bundle,
          targetSourceRevision: context.targetSourceRevision,
          benchmarkSourceRevision: environmentStatus.sourceRevision,
          candidateDigest: champion.digest,
          seeds,
        }),
        secrets: secretValuesFromEnvironment(requiredSecrets(context.bundle)),
      })
      onEvent({
        stage: 'baseline-pack-loaded',
        message: `复用 BaselinePack ${baselinePack.id}@${baselinePack.sha256.slice(0, 12)}`,
      })
    }
    const experimentRelativePath = relative(
      repositoryRoot,
      context.absoluteExperimentPath,
    ).replaceAll('\\', '/')
    state = {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionRunState',
      metadata: { id: runId, status: 'baseline-running' },
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
          evaluation: null,
        }],
        searchHistory: [],
        lastCandidateId: null,
        lastStepId: null,
        ledger: ledger(0),
        final: null,
        ...(baselinePack === null
          ? {}
          : {
              baselinePack: {
                id: baselinePack.id,
                sha256: baselinePack.sha256,
                path: context.bundle.experiment.baselinePack.path,
              },
            }),
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

    let baselineRecords
    try {
      if (baselinePack !== null) {
        await writeImportedRecords(
          resultPath(runRoot, 0, champion.id, 'selection'),
          baselinePack.selection.rawRecords,
        )
        baselineRecords = baselinePack.selection.records
      } else {
        baselineRecords = await environment.runCandidatePartition({
          candidateId: champion.id,
          candidateDigest: champion.digest,
          candidateWorkspace: champion.workspace,
          model: context.bundle.experiment.models.solver,
          partition: 'selection',
          seeds,
          outputPath: resultPath(runRoot, 0, champion.id, 'selection'),
        })
      }
    } catch (error) {
      state.spec.ledger = ledger(0)
      await persist()
      throw error
    } finally {
      await context.modelGateway.stop()
    }
    const baselineEvaluation = createEvaluationSummary({
      candidateId: champion.id,
      metric: context.bundle.policy.primaryMetric,
      value: primaryMetricFromRecords(baselineRecords, context.bundle.policy.primaryMetric),
    })
    state.metadata.status = 'running'
    state.spec.candidates[0].evaluation = baselineEvaluation
    state.spec.ledger = ledger(0)
    await persist()
    return coworkBranchProjection({ branchId, state })
  }

  async function restore() {
    if (state !== null) {
      await archiveIncompleteCoworkGeneration({
        runRoot,
        state,
        preserveTrialCheckpoints:
          context?.bundle.environment.protocol === 'omegause-officeval-docker-v1',
      })
      return coworkBranchProjection({ branchId, state })
    }
    if (runRootOverride === null || expectedBundleDigest === null) {
      throw new ProtocolError('Cowork Branch 跨进程恢复需要冻结的 Run Root 和 Bundle Digest')
    }

    const expectedRunRoot = resolve(runRootOverride)
    if (!await pathExists(expectedRunRoot)) return initialize()
    await assertPathKind(expectedRunRoot, `Cowork Branch ${branchId} Run Root`)
    const canonicalParent = await realpath(dirname(expectedRunRoot))
    runRoot = await realpath(expectedRunRoot)
    if (runRoot !== join(canonicalParent, basename(expectedRunRoot))) {
      throw new ProtocolError(`Cowork Branch ${branchId} Run Root 包含符号链接或别名`)
    }
    const statePath = join(runRoot, 'state.json')
    if (!await pathExists(statePath)) {
      // 新版会在首道 Baseline 题前先固化 state。若故障更早，则保留
      // 整个半成品目录供审计，再从冻结 Experiment 干净重建 Branch。
      const recoveryRoot = join(canonicalParent, 'baseline-recovery')
      await mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
      const archivedAt = new Date().toISOString()
      const archiveRoot = join(
        recoveryRoot,
        `${archivedAt.replace(/[:.]/gu, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`,
      )
      await rename(runRoot, archiveRoot)
      await writeJsonFile(join(archiveRoot, 'recovery-manifest.json'), {
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'CoworkBaselineRecoveryArchive',
        metadata: { branchId, archivedAt },
        spec: { reason: 'missing-branch-state-before-baseline' },
      })
      state = null
      runRoot = null
      return initialize()
    }
    state = assertRestorableCoworkState(await readJsonFile(statePath), {
      runId,
      branchId,
    })

    const controllerRevision = await trustedControllerRevision(repositoryRoot)
    if (controllerRevision !== state.spec.controllerRevision) {
      throw new ProtocolError('Cowork Branch 恢复时 Controller Revision 已变化', [
        `state=${state.spec.controllerRevision}`,
        `current=${controllerRevision}`,
      ])
    }
    context = await createContext({ repositoryRoot, experimentPath, gatewayScope: runId })
    context.repositoryRoot = repositoryRoot
    context.runId = runId
    context.runRoot = runRoot
    const frozenBundle = await assertPopulationBundleMatches({
      bundle: context.bundle,
      repositoryRoot,
      expectedDigest: expectedBundleDigest,
    })
    assertSecrets(requiredSecrets(context.bundle))
    validateModelGatewayEnvironment(context.bundle.environment.modelGateway)

    const expectedExperimentPath = relative(repositoryRoot, context.absoluteExperimentPath).replaceAll('\\', '/')
    if (state.spec.experimentPath !== expectedExperimentPath
        || state.spec.targetSourceRevision !== context.targetSourceRevision
        || state.spec.updaterSourceRevision !== context.updaterSourceRevision
        || state.spec.configDigest !== jsonDigest(publicBundleSnapshot(context.bundle))
        || canonicalJsonDigest(state.spec.recipe) !== canonicalJsonDigest(context.bundle.recipe)) {
      throw new ProtocolError(`Cowork Branch ${branchId} 状态与当前冻结实验不一致`)
    }

    const promptPath = join(runRoot, 'trusted-inputs', 'updater-prompt.md')
    await assertPathKind(promptPath, 'Cowork 冻结 Updater Prompt', 'file')
    if (await readFile(promptPath, 'utf8') !== frozenBundle.updaterPromptSource) {
      throw new ProtocolError('Cowork 冻结 Updater Prompt 内容已变化')
    }
    context.updaterPromptPath = promptPath

    environment = createEnvironmentRunner({
      repositoryRoot,
      environment: context.bundle.environment,
      benchmark: context.bundle.benchmark,
      target: context.bundle.target,
      solverDriver: context.solverDriver,
      docker: context.docker,
      runRoot,
    })
    const environmentStatus = await environment.preflight()
    if (environmentStatus.sourceRevision !== state.spec.benchmarkSourceRevision) {
      throw new ProtocolError('Cowork Branch 恢复时 Benchmark Source Revision 已变化')
    }
    await context.searchStrategy.preflight()
    for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
    await context.updaterDriver.ensureRuntime()

    mutationCatalog = mutationCatalogFor(context.bundle.target)
    const compatibilityPolicy = mutationPolicyFor(
      context.bundle.target,
      context.bundle.recipe.spec.moduleSearch.riskCeiling,
    )
    const [storedCatalog, storedPolicy] = await Promise.all([
      readJsonFile(join(runRoot, 'mutation-catalog.json')),
      readJsonFile(join(runRoot, 'mutation-policy.json')),
    ])
    if (canonicalJsonDigest(storedCatalog) !== canonicalJsonDigest(mutationCatalog)
        || canonicalJsonDigest(storedPolicy) !== canonicalJsonDigest(compatibilityPolicy)) {
      throw new ProtocolError('Cowork Branch 恢复时 Mutation 权限边界已变化')
    }

    const expectedSeeds = context.bundle.experiment.evolution.seeds.slice(
      0,
      context.bundle.experiment.evolution.trialsPerInstance,
    )
    if (canonicalJsonDigest(state.spec.seeds) !== canonicalJsonDigest(expectedSeeds)) {
      throw new ProtocolError('Cowork Branch 恢复时 Trial Seeds 已变化')
    }

    materializedCandidates = new Map()
    for (const record of state.spec.candidates) {
      if (record.digest === null) {
        if (record.status !== 'invalid-proposal') {
          throw new ProtocolError(`Candidate ${record.id} 缺少 Digest`)
        }
        continue
      }
      if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(record.digest)) {
        throw new ProtocolError(`Candidate ${record.id} Digest 无效`)
      }
      const root = join(runRoot, 'candidates', record.id)
      const workspace = join(root, 'workspace')
      const manifest = await readJsonFile(join(root, 'manifest.json'))
      if (manifest.metadata?.parentId !== record.parentId) {
        throw new ProtocolError(`Candidate ${record.id} Parent 谱系不一致`)
      }
      await assertCandidateIntegrity({
        candidateId: record.id,
        workspace,
        manifest,
        sourceRevision: state.spec.targetSourceRevision,
        expectedDigest: record.digest,
        maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
        maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
        label: `恢复 Candidate ${record.id}`,
      })
      const semanticReport = await validateCandidate({ workspace, target: context.bundle.target })
      if (!semanticReport.valid) {
        throw new ProtocolError(`恢复 Candidate ${record.id} 语义检查失败`,
          semanticReport.violations.map((item) => `${item.path}: ${item.reason}`))
      }
      materializedCandidates.set(record.id, {
        id: record.id,
        root,
        workspace,
        digest: record.digest,
      })
    }
    champion = materializedCandidates.get(state.spec.championId)
    if (!champion || !materializedCandidates.has(state.spec.baselineId)) {
      throw new ProtocolError(`Cowork Branch ${branchId} 无法恢复 Baseline 或 Champion`)
    }
    const restoredBaseline = materializedCandidates.get(state.spec.baselineId)
    if (context.bundle.experiment.baselinePack !== null) {
      baselinePack = await loadBaselinePack({
        repositoryRoot,
        reference: context.bundle.experiment.baselinePack,
        benchmark: context.bundle.benchmark,
        expectedIdentity: createBaselineCompatibilityIdentity({
          bundle: context.bundle,
          targetSourceRevision: context.targetSourceRevision,
          benchmarkSourceRevision: environmentStatus.sourceRevision,
          candidateDigest: restoredBaseline.digest,
          seeds: expectedSeeds,
        }),
        secrets: secretValuesFromEnvironment(requiredSecrets(context.bundle)),
      })
    }
    const expectedBaselinePackState = baselinePack === null
      ? null
      : {
          id: baselinePack.id,
          sha256: baselinePack.sha256,
          path: context.bundle.experiment.baselinePack.path,
        }
    if (canonicalJsonDigest(state.spec.baselinePack ?? null)
        !== canonicalJsonDigest(expectedBaselinePackState)) {
      throw new ProtocolError('Cowork Branch 恢复时 BaselinePack 身份已变化')
    }

    peerEvidencePath = join(runRoot, 'public', 'evolution-log.jsonl')
    const expectedEvidence = state.spec.searchHistory
      .map((entry) => JSON.stringify({ branchId, ...entry }))
      .join('\n') + (state.spec.searchHistory.length > 0 ? '\n' : '')
    let currentEvidence = null
    try {
      await assertPathKind(peerEvidencePath, 'Cowork Evolution Log', 'file')
      currentEvidence = await readFile(peerEvidencePath, 'utf8')
    } catch (error) {
      if (!(error instanceof ProtocolError) || !/\u4e0d\u5b58\u5728/u.test(error.message)) throw error
    }
    if (currentEvidence !== expectedEvidence) {
      const recoveryRoot = join(runRoot, 'recovery')
      await mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
      if (currentEvidence !== null) {
        await rename(peerEvidencePath, join(
          recoveryRoot,
          `evolution-log-${new Date().toISOString().replace(/[:.]/gu, '-').toLowerCase()}-${randomUUID().slice(0, 8)}.jsonl`,
        ))
      }
      await writeFile(peerEvidencePath, expectedEvidence, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    }

    startedAt = Date.now()
    ledgerOffset = structuredClone(state.spec.ledger)
    candidatesEvaluated = 0
    if (state.metadata.status === 'baseline-running') {
      const baselineRecord = state.spec.candidates.find((record) => record.id === state.spec.baselineId)
      if (state.spec.generationsCompleted !== 0
          || state.spec.searchHistory.length !== 0
          || baselineRecord?.evaluation !== null) {
        throw new ProtocolError(`Cowork Branch ${branchId} Baseline 恢复状态不一致`)
      }
      let baselineRecords
      try {
        if (baselinePack !== null) {
          await writeImportedRecords(
            resultPath(runRoot, 0, champion.id, 'selection'),
            baselinePack.selection.rawRecords,
          )
          baselineRecords = baselinePack.selection.records
        } else {
          baselineRecords = await environment.runCandidatePartition({
            candidateId: champion.id,
            candidateDigest: champion.digest,
            candidateWorkspace: champion.workspace,
            model: context.bundle.experiment.models.solver,
            partition: 'selection',
            seeds: state.spec.seeds,
            outputPath: resultPath(runRoot, 0, champion.id, 'selection'),
          })
        }
      } catch (error) {
        state.spec.ledger = ledger(0)
        await persist()
        throw error
      } finally {
        await context.modelGateway.stop()
      }
      baselineRecord.evaluation = createEvaluationSummary({
        candidateId: champion.id,
        metric: context.bundle.policy.primaryMetric,
        value: primaryMetricFromRecords(baselineRecords, context.bundle.policy.primaryMetric),
      })
      state.metadata.status = 'running'
      state.spec.ledger = ledger(0)
      await persist()
      return coworkBranchProjection({ branchId, state })
    }
    await archiveIncompleteCoworkGeneration({
      runRoot,
      state,
      preserveTrialCheckpoints:
        context.bundle.environment.protocol === 'omegause-officeval-docker-v1',
    })
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
    const searchStrategyStateBefore = structuredClone(state.spec.searchStrategyState)
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
      let feedbackPacket
      const importsInitialH0Feedback = baselinePack !== null
        && generation === 1
        && mutationParent.id === state.spec.baselineId
        && state.spec.searchHistory.length === 0
      if (importsInitialH0Feedback) {
        onEvent({
          stage: 'baseline-pack-feedback',
          generation,
          message: `${branchId}/${mutationParent.id} 复用公共 H0 Feedback`,
        })
        await writeImportedRecords(
          resultPath(runRoot, generation, mutationParent.id, 'feedback'),
          baselinePack.feedback.rawRecords,
        )
        feedbackPacket = structuredClone(baselinePack.feedback.packet)
      } else {
        onEvent({ stage: 'feedback', generation, message: `${branchId}/${mutationParent.id} 运行 feedback Partition` })
        const feedbackRecords = await environment.runCandidatePartition({
          candidateId: mutationParent.id,
          candidateDigest: mutationParent.digest,
          candidateWorkspace: mutationParent.workspace,
          model: context.bundle.experiment.models.solver,
          partition: 'feedback',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, mutationParent.id, 'feedback'),
        })
        feedbackPacket = buildFeedbackPacket({
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
      }
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
      phase = 'selection'
      let baselineRecords
      if (baselinePack !== null && champion.id === state.spec.baselineId) {
        await writeImportedRecords(
          resultPath(runRoot, generation, champion.id, 'selection'),
          baselinePack.selection.rawRecords,
        )
        baselineRecords = baselinePack.selection.records
      } else {
        baselineRecords = await environment.runCandidatePartition({
          candidateId: champion.id,
          candidateDigest: champion.digest,
          candidateWorkspace: champion.workspace,
          model: context.bundle.experiment.models.solver,
          partition: 'selection',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, champion.id, 'selection'),
        })
      }
      const candidateRecords = await environment.runCandidatePartition({
        candidateId: proposal.id,
        candidateDigest: proposal.digest,
        candidateWorkspace: proposal.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'selection',
        seeds: state.spec.seeds,
        outputPath: resultPath(runRoot, generation, proposal.id, 'selection'),
      })
      candidatesEvaluated += 1
      const evaluation = evaluateBenchmark({
        benchmark: context.bundle.benchmark,
        policy: context.bundle.policy,
        run: { id: runId, baselineRevision: champion.digest, candidateRevision: proposal.digest },
        baselineRecords,
        candidateRecords,
        partitions: ['selection'],
        evolutionLedger: ledger(generation),
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
      const baselineEvaluation = createEvaluationSummary({
        candidateId: championBeforeId,
        metric: context.bundle.policy.primaryMetric,
        value: primaryMetricFromEvaluation(
          evaluation.partitions.selection.baseline,
          context.bundle.policy.primaryMetric,
        ),
      })
      if (evaluation.decision.eligible) champion = proposal
      else rejection = { stage: 'selection-gates', message: 'Candidate 未通过晋升 Gate', details: [] }
      const candidateRecord = {
        id: proposal.id,
        parentId,
        digest: proposal.digest,
        status: evaluation.decision.eligible ? 'promoted' : 'rejected',
        evaluation: candidateEvaluation,
        baselineEvaluation,
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
      if (phase !== 'update' || !(error instanceof CandidateMutationError)) {
        // 保留失败尝试已经消耗的 Token/时间，但不增加 Generation 或
        // Candidate 评测数。跨进程恢复后会从该 Ledger 继续累加，不会把失败成本“洗掉”。
        state.spec.searchStrategyState = searchStrategyStateBefore
        state.spec.ledger = ledger(state.spec.generationsCompleted)
        await persist()
        throw error
      }
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
    state.spec.ledger = ledger(generation)
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
    restore,
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

async function runGrhsRound({
  context,
  environment,
  runRoot,
  runId,
  generation,
  generationRoot,
  champion,
  state,
  mutationCatalog,
  materializedCandidates,
  candidatesEvaluated,
  startedAt,
  onEvent,
}) {
  const configuration = context.bundle.experiment.evolution.grhs
  const groupId = `g${String(generation).padStart(3, '0')}-grhs`
  const groupRoot = join(generationRoot, 'grhs-group')
  await mkdir(groupRoot, { recursive: true })
  const proposalPrior = state.spec.grhs.proposalPrior
  const mutationPlans = createGrhsMutationPlans({
    catalog: mutationCatalog,
    riskCeiling: state.spec.mutationLevel,
    parentId: champion.id,
    generation,
    groupSize: configuration.groupSize,
    proposalPrior,
  })
  const leases = mutationPlans.map((plan) => issueMutationLease({
    target: context.bundle.target,
    catalog: mutationCatalog,
    plan,
    riskCeiling: state.spec.mutationLevel,
  }))
  await Promise.all(mutationPlans.flatMap((plan, index) => {
    const siblingRoot = join(groupRoot, 'siblings', `s${String(index + 1).padStart(3, '0')}`)
    return [
      mkdir(siblingRoot, { recursive: true }),
      writeJsonFile(join(siblingRoot, 'mutation-plan.json'), plan),
      writeJsonFile(join(siblingRoot, 'mutation-lease.json'), leases[index]),
    ]
  }))

  onEvent({ stage: 'feedback', generation, message: `${champion.id} 为 ${configuration.groupSize} 个 sibling 运行共享 feedback` })
  const feedbackRecords = await environment.runCandidatePartition({
    candidateId: champion.id,
    candidateDigest: champion.digest,
    candidateWorkspace: champion.workspace,
    model: context.bundle.experiment.models.solver,
    partition: 'feedback',
    seeds: state.spec.seeds,
    outputPath: resultPath(runRoot, generation, champion.id, 'feedback'),
  })
  const feedbackPacket = buildFeedbackPacket({
    runId,
    generation,
    candidateId: champion.id,
    benchmark: context.bundle.benchmark,
    records: feedbackRecords,
    maximumTextBytesPerCase: context.bundle.environment.feedback.maximumTextBytesPerCase,
    maximumArtifactEntriesPerCase: context.bundle.environment.feedback.maximumArtifactEntriesPerCase,
    maximumArtifactBytesPerCase: context.bundle.environment.feedback.maximumArtifactBytesPerCase,
    secretValues: secretValuesFromEnvironment(requiredSecrets(context.bundle)),
    searchHistory: state.spec.searchHistory,
    maximumHistoryEntries: context.bundle.environment.feedback.maximumHistoryEntries,
    maximumHistoryBytes: context.bundle.environment.feedback.maximumHistoryBytes,
  })
  await writeJsonFile(join(groupRoot, 'feedback-packet.json'), feedbackPacket)

  onEvent({ stage: 'selection-baseline', generation, message: `${champion.id} 运行 sibling 共享 Selection Baseline` })
  const baselineRecords = await environment.runCandidatePartition({
    candidateId: champion.id,
    candidateDigest: champion.digest,
    candidateWorkspace: champion.workspace,
    model: context.bundle.experiment.models.solver,
    partition: 'selection',
    seeds: state.spec.seeds,
    outputPath: resultPath(runRoot, generation, champion.id, 'selection'),
  })

  const siblingResults = []
  let evaluatedThisRound = 0
  for (let index = 0; index < mutationPlans.length; index += 1) {
    const member = index + 1
    const candidateId = `${groupId}-s${String(member).padStart(3, '0')}-${state.spec.mutationLevel}`
    const plan = mutationPlans[index]
    let proposal = null
    let evaluation = null
    let rejection = null
    try {
      onEvent({
        stage: 'update',
        generation,
        message: `启动 GRHS sibling ${member}/${configuration.groupSize} Codex Updater Session`,
      })
      proposal = await runUpdaterGeneration({
        context,
        runRoot,
        generation,
        parent: champion,
        feedbackPacket,
        mutationPolicy: leases[index],
        candidateId,
        groupContext: {
          memberIndex: member,
          groupSize: configuration.groupSize,
          proposalPrior,
        },
      })
      materializedCandidates.set(proposal.id, proposal)
      onEvent({ stage: 'selection', generation, message: `${champion.id} 与 ${proposal.id} 配对评测` })
      const candidateRecords = await environment.runCandidatePartition({
        candidateId: proposal.id,
        candidateDigest: proposal.digest,
        candidateWorkspace: proposal.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'selection',
        seeds: state.spec.seeds,
        outputPath: resultPath(runRoot, generation, proposal.id, 'selection'),
      })
      evaluatedThisRound += 1
      evaluation = evaluateBenchmark({
        benchmark: context.bundle.benchmark,
        policy: context.bundle.policy,
        run: { id: runId, baselineRevision: champion.digest, candidateRevision: proposal.digest },
        baselineRecords,
        candidateRecords,
        partitions: ['selection'],
        evolutionLedger: buildLedger({
          generations: generation,
          candidatesEvaluated: candidatesEvaluated + evaluatedThisRound,
          startedAt,
          solverUsage: context.solverDriver.usage(),
          updaterUsage: context.updaterDriver.usage(),
        }),
      })
      await writeJsonFile(join(proposal.root, 'evaluation.json'), evaluation)
    } catch (error) {
      // Candidate 变异失败属于组内无效样本；Selection/Environment 失败属于
      // Controller 基础设施，不能伪装成低 utility 后继续做晋升决策。
      if (proposal !== null) throw error
      rejection = {
        stage: 'update-and-diff',
        message: error.message,
        details: error.details ?? [],
      }
    }
    if (!proposal || !evaluation) {
      siblingResults.push({
        id: candidateId,
        parentId: champion.id,
        regionIds: plan.spec.regionIds,
        valid: false,
        promotionEligible: false,
        rejection,
      })
      continue
    }
    const selection = evaluation.partitions.selection
    const tokenDelta = selection.deltas.tokens.relative
    siblingResults.push({
      id: proposal.id,
      parentId: champion.id,
      regionIds: plan.spec.regionIds,
      valid: grhsPolicyValid(evaluation),
      promotionEligible: evaluation.decision.eligible,
      qualityDelta: selection.paired.deltaMeanReward,
      qualityLowerBound: selection.paired.pairedRewardDeltaCi?.lower ?? selection.paired.deltaMeanReward,
      regressionRate: selection.paired.rewardRegressed
        / context.bundle.benchmark.partitions.selection.instanceIds.length,
      incrementalCost: typeof tokenDelta === 'number' ? tokenDelta : 0,
      patchComplexity: grhsPatchComplexity(proposal, context.bundle.target.mutation.limits),
      proposal,
      evaluation,
      rejection: grhsPolicyValid(evaluation) ? null : {
        stage: 'policy-gates',
        message: 'Candidate 未通过 Coverage、Completion 或 Safety Gate',
        details: [],
      },
    })
  }

  const digestOwners = new Map()
  for (const sibling of siblingResults) {
    const digest = sibling.proposal?.digest
    if (!digest) continue
    if (!digestOwners.has(digest)) {
      digestOwners.set(digest, sibling.id)
      continue
    }
    sibling.valid = false
    sibling.promotionEligible = false
    sibling.rejection = {
      stage: 'group-deduplication',
      message: `Patch 与 sibling ${digestOwners.get(digest)} 完全相同，不是离散 Candidate`,
      details: [],
    }
  }

  const groupDecision = scoreGrhsGroup({
    candidates: siblingResults.map(({ proposal, evaluation, ...candidate }) => candidate),
    configuration,
    proposalPrior,
  })
  const promoted = groupDecision.promotedCandidateId === null
    ? null
    : siblingResults.find((candidate) => candidate.id === groupDecision.promotedCandidateId)?.proposal ?? null
  const championAfter = promoted ?? champion
  const scoredById = new Map(groupDecision.candidates.map((candidate) => [candidate.id, candidate]))

  for (const sibling of siblingResults) {
    const scored = scoredById.get(sibling.id)
    const status = sibling.id === groupDecision.promotedCandidateId
      ? 'promoted'
      : sibling.valid ? 'rejected' : 'invalid-proposal'
    state.spec.candidates.push({
      id: sibling.id,
      parentId: champion.id,
      digest: sibling.proposal?.digest ?? null,
      status,
      groupId,
      mutationPlanId: mutationPlans[siblingResults.indexOf(sibling)].metadata.id,
      regionIds: sibling.regionIds,
      utility: scored.utility,
      relativeAdvantage: scored.advantage,
      utilityLowerBound: scored.utilityLowerBound,
      ...(sibling.evaluation ? { decision: sibling.evaluation.decision } : {}),
      ...(sibling.rejection ? { rejection: sibling.rejection } : {}),
    })
    state.spec.searchHistory.push({
      generation,
      groupId,
      parentId: champion.id,
      proposalId: sibling.id,
      status,
      mutationPlanId: mutationPlans[siblingResults.indexOf(sibling)].metadata.id,
      regionIds: sibling.regionIds,
      utility: scored.utility,
      relativeAdvantage: scored.advantage,
      utilityLowerBound: scored.utilityLowerBound,
      ...(sibling.proposal ? {
        hypothesis: sibling.proposal.report.hypothesis,
        changedFiles: sibling.proposal.report.changedFiles,
        expectedImpact: sibling.proposal.report.expectedImpact,
      } : {}),
      ...(sibling.evaluation ? { selection: publicDecision(sibling.evaluation.decision) } : {}),
      ...(sibling.rejection ? { rejection: sibling.rejection } : {}),
      championBeforeId: champion.id,
      championAfterId: championAfter.id,
    })
    await appendRegistry(context.repositoryRoot, {
      runId,
      candidateId: sibling.id,
      parentId: champion.id,
      digest: sibling.proposal?.digest ?? null,
      mutationLevel: state.spec.mutationLevel,
      regionIds: sibling.regionIds,
      groupId,
      utility: scored.utility,
      relativeAdvantage: scored.advantage,
      status,
    })
  }

  state.spec.grhs.proposalPrior = groupDecision.proposalPriorAfter
  state.spec.grhs.groups.push({
    generation,
    groupId,
    parentId: champion.id,
    candidateIds: siblingResults.map((candidate) => candidate.id),
    promotedCandidateId: groupDecision.promotedCandidateId,
    rollbackReason: groupDecision.rollbackReason,
  })
  await writeJsonFile(join(groupRoot, 'group-decision.json'), groupDecision)
  await writeJsonFile(join(generationRoot, 'decision.json'), {
    generation,
    groupId,
    parentId: champion.id,
    championId: championAfter.id,
    promotedCandidateId: groupDecision.promotedCandidateId,
    rollbackReason: groupDecision.rollbackReason,
  })
  onEvent({
    stage: 'decision',
    generation,
    message: promoted ? `GRHS 晋升 ${promoted.id}` : `GRHS 回滚，保留 ${champion.id}`,
  })
  return { champion: championAfter, candidatesEvaluated: candidatesEvaluated + evaluatedThisRound }
}

export async function runEvolution({
  repositoryRoot,
  experimentPath,
  runId = createRunId(),
  onEvent = () => {},
  baselineOnly = false,
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
    repositoryRoot,
    environment: context.bundle.environment,
    benchmark: context.bundle.benchmark,
    target: context.bundle.target,
    solverDriver: context.solverDriver,
    docker: context.docker,
    runRoot,
  })
  onEvent({ stage: 'preflight', message: '校验 Docker、Target Source 与 Environment Revision' })
  const environmentStatus = await environment.preflight()
  await context.searchStrategy.preflight()
  for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
  if (context.bundle.updater.runtime.image) {
    const updaterImageRevision = await context.docker.imageExists(context.bundle.updater.runtime.image)
      ? await context.docker.imageLabel(context.bundle.updater.runtime.image, 'org.opencontainers.image.revision')
      : null
    if (updaterImageRevision !== context.updaterSourceRevision) {
      onEvent({ stage: 'runtime-build', message: `构建 Updater Runtime ${context.bundle.updater.runtime.image}` })
    }
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
      searchStrategy: context.bundle.experiment.evolution.grhs === null
        ? context.searchStrategy.descriptor()
        : null,
      searchStrategyState: null,
      grhs: context.bundle.experiment.evolution.grhs === null
        ? null
        : {
            algorithm: 'group-relative-harness-search-v1',
            configuration: context.bundle.experiment.evolution.grhs,
            proposalPrior: initialProposalPrior(
              mutationCatalog,
              context.bundle.experiment.evolution.mutationLevel,
            ),
            groups: [],
          },
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

  if (baselineOnly) {
    const baselinePath = resultPath(runRoot, 0, h0.id, 'selection')
    try {
      onEvent({ stage: 'selection-baseline', message: `${h0.id} 运行 H0 Selection Baseline` })
      const baselineRecords = await environment.runCandidatePartition({
        candidateId: h0.id,
        candidateDigest: h0.digest,
        candidateWorkspace: h0.workspace,
        model: context.bundle.experiment.models.solver,
        partition: 'selection',
        seeds: state.spec.seeds,
        outputPath: baselinePath,
      })
      const baselineEvaluation = createEvaluationSummary({
        candidateId: h0.id,
        metric: context.bundle.policy.primaryMetric,
        value: primaryMetricFromRecords(baselineRecords, context.bundle.policy.primaryMetric),
      })
      state.metadata.status = 'baseline-completed'
      state.spec.candidates[0].evaluation = baselineEvaluation
      state.spec.ledger = buildLedger({
        generations: 0,
        candidatesEvaluated: 0,
        startedAt,
        solverUsage: context.solverDriver.usage(),
        updaterUsage: context.updaterDriver.usage(),
      })
      await writeJsonFile(join(runRoot, 'state.json'), state)
      onEvent({ stage: 'baseline-completed', message: `H0 Baseline 完成，${context.bundle.policy.primaryMetric}=${baselineEvaluation.primary.value}` })
      return {
        runId,
        runRoot,
        baselineId: h0.id,
        baselinePath,
        primary: baselineEvaluation.primary,
        budgetConsumed: 0,
        state,
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
  }

  try {
    for (let generation = 1; generation <= context.bundle.experiment.evolution.generations; generation += 1) {
      const generationRoot = join(runRoot, 'generations', `generation-${generation}`)
      await mkdir(generationRoot, { recursive: true })
      if (state.spec.grhs !== null) {
        const round = await runGrhsRound({
          context,
          environment,
          runRoot,
          runId,
          generation,
          generationRoot,
          champion,
          state,
          mutationCatalog,
          materializedCandidates,
          candidatesEvaluated,
          startedAt,
          onEvent,
        })
        champion = round.champion
        candidatesEvaluated = round.candidatesEvaluated
        state.spec.championId = champion.id
        state.spec.generationsCompleted = generation
        await writeJsonFile(join(runRoot, 'state.json'), state)
        continue
      }
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
        candidateDigest: mutationParent.digest,
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
          candidateDigest: champion.digest,
          candidateWorkspace: champion.workspace,
          model: context.bundle.experiment.models.solver,
          partition: 'selection',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, champion.id, 'selection'),
        })
        const candidateRecords = await environment.runCandidatePartition({
          candidateId: proposal.id,
          candidateDigest: proposal.digest,
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
  baselineOnly = false,
}) {
  safeRunId(runId)
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  const bundle = await loadExperimentBundle(resolve(experimentPath), repositoryRoot)
  if (baselineOnly && bundle.recipe.spec.population.concurrency.n_branches !== 1) {
    throw new ProtocolError('公共 H0 Baseline 只能使用单 Branch Recipe，避免重复评测同一 Candidate')
  }
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
  const release = await acquireCampaignLock({
    campaignsRoot: populationsRoot,
    campaignId: runId,
    command: 'experiment run',
  })
  try {
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
    const initialized = await orchestrator.initialize()
    const baselineResult = baselineOnly && initialized.status !== 'PAUSED_INFRASTRUCTURE'
      ? await orchestrator.freezeBaseline()
      : null
    const state = baselineResult === null ? await orchestrator.run() : baselineResult.state
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
      ...(baselineResult === null
        ? {}
        : { baseline: baselineResult.baseline, baselinePath: baselineResult.baselinePath }),
    }
  } finally {
    await release()
  }
}

/** 从已冻结的 Population + Branch 检查点恢复 Cowork 实验。 */
export async function resumePopulationEvolution({
  repositoryRoot,
  runDirectory,
  onEvent = () => {},
}) {
  const requestedRunRoot = resolve(runDirectory)
  await assertPathKind(requestedRunRoot, 'Population Run Root')
  const runRoot = await realpath(requestedRunRoot)
  const runId = safeRunId(basename(runRoot))
  const parentState = await readJsonFile(join(runRoot, 'public', 'state.json'))
  if (parentState?.kind !== 'PopulationCampaignState'
      || parentState.campaignId !== runId
      || parentState.status !== 'PAUSED_INFRASTRUCTURE'
      || !Array.isArray(parentState.branches)
      || parentState.branches.length === 0) {
    throw new ProtocolError('Population Run 当前不是可恢复的 PAUSED_INFRASTRUCTURE')
  }
  if (parentState.branches.some(({ branchId }) => (
    typeof branchId !== 'string' || !/^branch-[0-9]{3}$/u.test(branchId)
  ))) {
    throw new ProtocolError('Population Branch ID 无效')
  }

  const storedSnapshot = await readJsonFile(join(runRoot, 'public', 'config.snapshot.json'))
  const branchStates = []
  for (const { branchId } of parentState.branches) {
    const statePath = join(runRoot, 'branches', branchId, 'run', 'state.json')
    if (!await pathExists(statePath)) continue
    branchStates.push(assertRestorableCoworkState(await readJsonFile(statePath), {
      runId: `${runId}-${branchId}`,
      branchId,
    }))
  }
  const snapshotExperimentPath = storedSnapshot.trustedInputs?.experiment?.path
  const experimentPaths = new Set(branchStates.map((branchState) => branchState.spec.experimentPath))
  if (typeof snapshotExperimentPath === 'string') experimentPaths.add(snapshotExperimentPath)
  if (experimentPaths.size !== 1) {
    throw new ProtocolError('Population 无法唯一确定冻结的 Experiment Path')
  }
  const experimentPath = resolveInside(
    repositoryRoot,
    [...experimentPaths][0],
    'Population Experiment Path',
  )
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  if (branchStates.some((branchState) => branchState.spec.controllerRevision !== controllerRevision)) {
    throw new ProtocolError('Population 恢复时 Controller Revision 与 Branch 冻结值不一致')
  }

  const bundle = await loadExperimentBundle(experimentPath, repositoryRoot)
  const requestedRuntimeRoot = resolveInside(
    repositoryRoot,
    bundle.target.materialization.runtimeRoot,
    'Target Runtime Root',
  )
  await assertPathKind(requestedRuntimeRoot, 'Target Runtime Root')
  const runtimeRoot = await realpath(requestedRuntimeRoot)
  const populationsRoot = join(runtimeRoot, 'populations')
  const expectedRunRoot = join(await realpath(populationsRoot), runId)
  if (runRoot !== expectedRunRoot) {
    throw new ProtocolError('Population Run Root 不属于 Experiment 声明的受控 Runtime Root')
  }

  const frozenBundle = await capturePopulationBundle(bundle, repositoryRoot)
  if (parentState.configDigest !== frozenBundle.digest) {
    throw new ProtocolError('Population 恢复时 Bundle Digest 与父状态不一致')
  }
  if (canonicalJsonDigest(storedSnapshot) !== canonicalJsonDigest(frozenBundle.snapshot)) {
    throw new ProtocolError('Population 冻结 Config Snapshot 已变化')
  }
  const loadedCampaign = {
    config: frozenBundle.snapshot,
    recipe: bundle.recipe,
    configDigest: frozenBundle.digest,
    fingerprint: canonicalJsonDigest({ controllerRevision, configDigest: frozenBundle.digest }),
  }

  const release = await acquireCampaignLock({
    campaignsRoot: populationsRoot,
    campaignId: runId,
    command: 'experiment resume',
  })
  try {
    const orchestrator = new PopulationOrchestrator({
      loadedCampaign,
      campaignsRoot: populationsRoot,
      campaignId: runId,
      frozenConfig: frozenBundle.snapshot,
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
    const state = await orchestrator.resume()
    if (state.status === 'PAUSED_INFRASTRUCTURE') {
      throw new ProtocolError('Population 再次因基础设施故障暂停，未计为评测失败', [
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
  } finally {
    await release()
  }
}

/** 旧 Experiment 保持原单 Champion 目录格式；显式 Recipe 进入通用 Population。 */
export async function runConfiguredEvolution(options) {
  const experiment = await loadExperimentBundle(resolve(options.experimentPath), options.repositoryRoot)
  return experiment.experiment.recipePath === null
    ? await runEvolution(options)
    : await runPopulationEvolution(options)
}

/** 只跑单 Branch H0 selection，不调用 Updater、不进入进化轮次。 */
export async function runConfiguredBaseline(options) {
  const experiment = await loadExperimentBundle(resolve(options.experimentPath), options.repositoryRoot)
  return experiment.experiment.recipePath === null
    ? await runEvolution({ ...options, baselineOnly: true })
    : await runPopulationEvolution({ ...options, baselineOnly: true })
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

async function loadPopulationFinalAuthorization({
  repositoryRoot,
  populationRoot,
  recoverInfrastructure = false,
}) {
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
  if (!recoverInfrastructure && state.final !== null && state.final !== undefined) {
    throw new ProtocolError('Population Final Partition 已经解封过；禁止重复访问')
  }
  if (recoverInfrastructure && (
    state.final?.evaluated !== false
    || typeof state.final?.attemptId !== 'string'
    || typeof state.final?.failedAt !== 'string'
    || state.final?.failure?.name !== 'FinalEvaluationError'
  )) {
    throw new ProtocolError('只能恢复已明确记录基础设施失败的 Population Final')
  }
  safeRunId(state.campaignId)
  if (typeof state.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(state.configDigest)
      || typeof state.configFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(state.configFingerprint)) {
    throw new ProtocolError('Population 缺少可验证的冻结配置摘要')
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
  if (recoverInfrastructure) {
    if (branchState.metadata.status !== 'final-failed'
        || branchState.spec.final?.evaluated !== false
        || branchState.spec.final?.attemptId !== state.final.attemptId
        || typeof branchState.spec.final?.failedAt !== 'string') {
      throw new ProtocolError('Population 与 Best Branch 的 Final 失败状态不一致')
    }
  } else {
    if (!['running', 'stopped', 'completed'].includes(branchState.metadata.status)) {
      throw new ProtocolError(`Population Best Branch 不能执行 Final：${branchState.metadata.status}`)
    }
    if (branchState.spec.final !== null) {
      throw new ProtocolError('Population Best Branch Final 已经解封过')
    }
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
  const frozenControllerRevision = branchState.spec.controllerRevision
  const expectedFingerprint = canonicalJsonDigest({
    controllerRevision: frozenControllerRevision,
    configDigest: state.configDigest,
  })
  if (expectedFingerprint !== state.configFingerprint) {
    throw new ProtocolError('Population Bundle 与原 Controller Revision 的冻结指纹不一致')
  }
  const currentControllerRevision = await trustedControllerRevision(repositoryRoot)
  await assertControllerRevisionForFinal({
    repositoryRoot,
    frozenRevision: frozenControllerRevision,
    currentRevision: currentControllerRevision,
    recoveryRequested: recoverInfrastructure,
  })

  let recovery = null
  if (recoverInfrastructure) {
    if (state.final.branchId !== branchId || state.final.candidateId !== state.best.candidateId) {
      throw new ProtocolError('Population Final 失败记录与锁定 Champion 不一致')
    }
    const claim = await readJsonFile(join(populationRoot, 'final-attempt.json'))
    if (claim?.apiVersion !== 'harness-rsi/v1alpha1'
        || claim.kind !== 'FinalAttemptClaim'
        || claim.metadata?.attemptId !== state.final.attemptId
        || claim.metadata?.startedAt !== state.final.startedAt) {
      throw new ProtocolError('原 Final Attempt Claim 与失败状态不一致')
    }
    if (await pathExists(join(store.reportRoot, 'final-evaluation.json'))) {
      throw new ProtocolError('Final 报告已存在；禁止恢复')
    }
    recovery = {
      failedFinal: structuredClone(branchState.spec.final),
      recoveredFromAttemptId: state.final.attemptId,
      evolutionControllerRevision: frozenControllerRevision,
      finalizerControllerRevision: currentControllerRevision,
    }
  }
  return {
    root: populationRoot,
    store,
    state,
    branchId,
    runRoot,
    branchState,
    currentControllerRevision,
    recovery,
  }
}

async function finalizeCoworkRun({
  repositoryRoot,
  runRoot,
  state,
  population = null,
  recovery = null,
  onEvent = () => {},
}) {
  assertEvolutionRunState(state)
  if (recovery !== null && population === null) {
    throw new ProtocolError('Final Recovery 只支持有父层审计状态的 Population Run')
  }
  if (population === null && state.metadata.status !== 'completed') {
    throw new ProtocolError('只有 completed Run 可以执行 Final Evaluation')
  }
  if (recovery === null && state.spec.final !== null) {
    throw new ProtocolError('Final Partition 已经解封过；禁止重复访问')
  }
  if (recovery !== null && (
    state.metadata.status !== 'final-failed'
    || state.spec.final?.attemptId !== recovery.recoveredFromAttemptId
  )) {
    throw new ProtocolError('Final Recovery 与子 Run 失败状态不一致')
  }
  safeRunId(state.metadata.id)
  const baselineId = safeCandidateId(state.spec.baselineId)
  const championId = safeCandidateId(state.spec.championId)
  const controllerRevision = await trustedControllerRevision(repositoryRoot)
  if (recovery === null && controllerRevision !== state.spec.controllerRevision) {
    throw new ProtocolError('当前 Controller Revision 与 Run 冻结值不一致', [
      `run=${state.spec.controllerRevision ?? '(missing)'}`,
      `current=${controllerRevision}`,
    ])
  }
  if (recovery !== null && controllerRevision !== recovery.finalizerControllerRevision) {
    throw new ProtocolError('Final Recovery 预授权的 Controller Revision 已变更')
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
    repositoryRoot,
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
  const generation = state.spec.generationsCompleted + 1
  let recoveryArchive = null
  let finalAudit = {}
  if (recovery === null) {
    await claimFinalAttempt(population?.root ?? runRoot, {
      attemptId: finalAttemptId,
      startedAt: finalStartedAt,
    })
  } else {
    // 领取 Recovery 前先证明上次尝试没有任何 sealed-final 产物。原 Claim 不删除，
    // Recovery Claim 也是一次性的，因此并发或二次失败都不会导致反复解封。
    await inspectFailedFinalArtifacts({
      runRoot,
      failedAttemptId: recovery.recoveredFromAttemptId,
      baselineId,
      championId,
      generationsCompleted: state.spec.generationsCompleted,
    })
    await claimFinalRecoveryAttempt(population.root, {
      attemptId: finalAttemptId,
      startedAt: finalStartedAt,
      recoveredFromAttemptId: recovery.recoveredFromAttemptId,
      evolutionControllerRevision: recovery.evolutionControllerRevision,
      finalizerControllerRevision: recovery.finalizerControllerRevision,
    })
    recoveryArchive = await archiveFailedFinalAttempt({
      runRoot,
      failedAttemptId: recovery.recoveredFromAttemptId,
      baselineId,
      championId,
      generationsCompleted: state.spec.generationsCompleted,
    })
    finalAudit = {
      recoveredFrom: recovery.failedFinal,
      recoveredFromAttemptId: recovery.recoveredFromAttemptId,
      evolutionControllerRevision: recovery.evolutionControllerRevision,
      finalizerControllerRevision: recovery.finalizerControllerRevision,
      recoveryArchive: recoveryArchive === null
        ? null
        : relative(runRoot, recoveryArchive.root).replaceAll('\\', '/'),
    }
  }
  if (population !== null) {
    await savePopulationFinalState(population, {
      evaluated: false,
      attemptId: finalAttemptId,
      startedAt: finalStartedAt,
      branchId: population.branchId,
      candidateId: championId,
      ...(recovery === null ? {} : {
        recoveredFromAttemptId: recovery.recoveredFromAttemptId,
        evolutionControllerRevision: recovery.evolutionControllerRevision,
        finalizerControllerRevision: recovery.finalizerControllerRevision,
        recoveryArchive: finalAudit.recoveryArchive,
      }),
    }, recovery === null ? 'POPULATION_FINAL_STARTED' : 'POPULATION_FINAL_RECOVERY_STARTED', {
      branchId: population.branchId,
      candidateId: championId,
      ...(recovery === null ? {} : {
        recoveredFromAttemptId: recovery.recoveredFromAttemptId,
        evolutionControllerRevision: recovery.evolutionControllerRevision,
        finalizerControllerRevision: recovery.finalizerControllerRevision,
      }),
    })
  }
  state.metadata.status = 'finalizing'
  state.spec.final = {
    evaluated: false,
    attemptId: finalAttemptId,
    startedAt: finalStartedAt,
    ...finalAudit,
  }

  try {
    await writeJsonFile(join(runRoot, 'state.json'), state)
    const baselineFeedbackRecords = await environment.runCandidatePartition({
      candidateId: baselineId,
      candidateDigest: h0State.digest,
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
          candidateDigest: championState.digest,
          candidateWorkspace: championWorkspace,
          model: context.bundle.experiment.models.solver,
          partition: 'feedback',
          seeds: state.spec.seeds,
          outputPath: resultPath(runRoot, generation, championId, `feedback-final-${finalAttemptId}`),
        })
    onEvent({ stage: 'final-feedback', message: 'H0 与锁定 Champion 已完成 Feedback 回放' })
    const baselineRecords = await environment.runCandidatePartition({
      candidateId: baselineId,
      candidateDigest: h0State.digest,
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
          candidateDigest: championState.digest,
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
      ...finalAudit,
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
        ...(recovery === null ? {} : {
          recoveredFromAttemptId: recovery.recoveredFromAttemptId,
          evolutionControllerRevision: recovery.evolutionControllerRevision,
          finalizerControllerRevision: recovery.finalizerControllerRevision,
          recoveryArchive: finalAudit.recoveryArchive,
        }),
        report: 'report/final-evaluation.json',
        metrics: report.rsiMetrics,
      }, 'POPULATION_FINAL_COMPLETED', {
        branchId: population.branchId,
        baselineId,
        candidateId: championId,
        report: 'report/final-evaluation.json',
        ...(recovery === null ? {} : {
          recoveredFromAttemptId: recovery.recoveredFromAttemptId,
          finalizerControllerRevision: recovery.finalizerControllerRevision,
        }),
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
        ...(recovery === null ? {} : {
          recoveredFromAttemptId: recovery.recoveredFromAttemptId,
          finalizerControllerRevision: recovery.finalizerControllerRevision,
        }),
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

export async function finalizeEvolution({
  repositoryRoot,
  runDirectory,
  recoverInfrastructure = false,
  onEvent = () => {},
}) {
  const runRoot = await realpath(resolve(runDirectory))
  assertInside(resolve(repositoryRoot, '.rsi/runs'), runRoot, 'Evolution Run')
  if (await pathExists(join(runRoot, 'public', 'state.json'))) {
    const population = await loadPopulationFinalAuthorization({
      repositoryRoot,
      populationRoot: runRoot,
      recoverInfrastructure,
    })
    return await finalizeCoworkRun({
      repositoryRoot,
      runRoot: population.runRoot,
      state: population.branchState,
      population,
      recovery: population.recovery,
      onEvent,
    })
  }
  if (recoverInfrastructure) {
    throw new ProtocolError('Final Recovery 只支持 Population Run')
  }
  const state = await readJsonFile(join(runRoot, 'state.json'))
  return await finalizeCoworkRun({ repositoryRoot, runRoot, state, onEvent })
}
