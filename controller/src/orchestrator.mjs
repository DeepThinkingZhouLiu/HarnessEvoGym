import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  copyRegularTree,
  diffSnapshots,
  enforceMutationPolicy,
  mutationPolicyFor,
  snapshotTree,
  treeDigest,
  validateCandidateSemantics,
  validateMutationReport,
  writeCandidateManifest,
} from './candidate.mjs'
import { loadExperimentBundle } from './adapters.mjs'
import { assertPathKind, resolveInside } from './config.mjs'
import { DockerClient } from './docker.mjs'
import { evaluateBenchmark } from './evaluator.mjs'
import { createEnvironmentRunner, createSolverDriver, createUpdaterDriver } from './factories.mjs'
import { buildFeedbackPacket } from './feedback.mjs'
import {
  buildModelGatewayImage,
  ModelGateway,
  validateModelGatewayEnvironment,
} from './model-gateway.mjs'
import { ProtocolError, readJsonFile, writeJsonFile } from './protocol.mjs'
import { runProcess, secretValuesFromEnvironment } from './process.mjs'

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
  const targetSource = await resolvePinnedSource(repositoryRoot, bundle.target.source, 'Target Source')
  const updaterSource = bundle.updater.source.path === bundle.target.source.path
    ? targetSource
    : await resolvePinnedSource(repositoryRoot, bundle.updater.source, 'Updater Source')
  if (updaterSource.revision !== bundle.updater.source.revision) {
    throw new ProtocolError('Updater Adapter Revision 与复用的 Target Source Revision 不一致')
  }
  const baselineTemplate = resolveInside(
    repositoryRoot,
    bundle.target.materialization.baselinePath,
    'Target Baseline Path',
  )
  await assertPathKind(baselineTemplate, 'Target Baseline Template')
  for (const [label, runtime, source] of [
    ['Target Solver', bundle.target.solver.runtime, targetSource],
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
    assertPathKind(
      resolveInside(baselineTemplate, bundle.target.materialization.presetRelativePath, 'H0 Preset'),
      'H0 Preset',
    ),
  ])
  const docker = makeDocker(bundle.environment)
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
  const environmentStatus = await environment.preflight()
  for (const instanceId of context.bundle.benchmark.allInstanceIds) await environment.taskLayout(instanceId)
  return {
    experiment: context.bundle.experiment.id,
    mutationLevel: context.bundle.experiment.evolution.mutationLevel,
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
  await copyRegularTree(context.baselineTemplate, workspace)
  await Promise.all([
    mkdir(join(workspace, '.rsi-context'), { recursive: true }),
    mkdir(join(workspace, '.rsi-output'), { recursive: true }),
  ])
  const snapshot = await snapshotTree(workspace, {
    maximumFileBytes: context.bundle.target.mutation.limits.maximumFileBytes,
    maximumTreeEntries: context.bundle.target.mutation.limits.maximumTreeEntries,
  })
  const semanticReport = await validateCandidateSemantics(workspace, context.bundle.target)
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
    promptPath: resolveInside(context.repositoryRoot, context.bundle.updater.promptPath, 'Updater Prompt'),
    promptVariables: {
      'target.name': context.bundle.target.id,
      'baseline.revision': parent.digest,
      'mutation.level': level,
      'mutation.writablePaths': mutationPolicy.spec.writable.map((value) => `- ${value}`).join('\n'),
      'mutation.readOnlyPaths': mutationPolicy.spec.readOnly.map((value) => `- ${value}`).join('\n'),
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
  const semanticReport = await validateCandidateSemantics(workspace, context.bundle.target)
  await writeJsonFile(join(root, 'mutation-diff.json'), {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationDiff',
    metadata: { candidateId: id, parentId: parent.id },
    spec: { ...policyReport, semanticChecks: semanticReport.checks },
  })
  if (!policyReport.valid) {
    throw new ProtocolError('Updater 产生越界 Diff', policyReport.violations.map((item) => `${item.path}: ${item.reason}`))
  }
  if (!semanticReport.valid) {
    throw new ProtocolError(
      'Candidate Preset 语义检查失败',
      semanticReport.violations.map((item) => `${item.path}: ${item.reason}`),
    )
  }
  const report = validateMutationReport(updaterResult.report, policyReport.changes)
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
    target: bundle.target,
    updater: bundle.updater,
    provider: bundle.provider,
    environment: bundle.environment,
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
  let candidatesEvaluated = 0
  const mutationPolicy = mutationPolicyFor(
    context.bundle.target,
    context.bundle.experiment.evolution.mutationLevel,
  )
  await writeJsonFile(join(runRoot, 'mutation-policy.json'), mutationPolicy)
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
      onEvent({ stage: 'feedback', generation, message: `${champion.id} 运行 feedback Partition` })
      const generationRoot = join(runRoot, 'generations', `generation-${generation}`)
      await mkdir(generationRoot, { recursive: true })
      const feedbackRecords = await environment.runCandidatePartition({
        candidateId: champion.id,
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
          parent: champion,
          feedbackPacket,
          mutationPolicy,
        })
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
        const parentId = champion.id
        if (evaluation.decision.eligible) champion = proposal
        else rejection = { stage: 'selection-gates', message: 'Candidate 未通过晋升 Gate', details: [] }
        state.spec.candidates.push({
          id: proposal.id,
          parentId,
          digest: proposal.digest,
          status: evaluation.decision.eligible ? 'promoted' : 'rejected',
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
          selection: publicDecision(evaluation.decision),
        }
        await appendRegistry(repositoryRoot, {
          runId,
          candidateId: proposal.id,
          parentId,
          digest: proposal.digest,
          mutationLevel: state.spec.mutationLevel,
          status: evaluation.decision.eligible ? 'promoted' : 'rejected',
        })
      } else {
        const rejectedId = `g${String(generation).padStart(3, '0')}-${state.spec.mutationLevel}`
        state.spec.candidates.push({
          id: rejectedId,
          parentId: champion.id,
          digest: null,
          status: 'rejected',
          rejection,
        })
        historyEntry = {
          generation,
          parentId: champion.id,
          proposalId: rejectedId,
          status: 'invalid-proposal',
          rejection: { stage: rejection.stage, message: rejection.message },
        }
      }

      state.spec.searchHistory.push(historyEntry)

      onEvent({
        stage: 'decision',
        generation,
        message: proposal && champion.id === proposal.id ? `晋升 ${proposal.id}` : `保留 ${champion.id}`,
      })

      state.spec.championId = champion.id
      state.spec.generationsCompleted = generation
      await writeJsonFile(join(generationRoot, 'decision.json'), {
        generation,
        championId: champion.id,
        promoted: proposal ? champion.id === proposal.id : false,
        rejection,
      })
      await writeJsonFile(join(runRoot, 'state.json'), state)
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

export async function finalizeEvolution({ repositoryRoot, runDirectory, onEvent = () => {} }) {
  const runRoot = await realpath(resolve(runDirectory))
  assertInside(resolve(repositoryRoot, '.rsi/runs'), runRoot, 'Evolution Run')
  const state = await readJsonFile(join(runRoot, 'state.json'))
  if (
    state?.apiVersion !== 'harness-rsi/v1alpha1' ||
    state?.kind !== 'EvolutionRunState' ||
    !state.spec ||
    typeof state.spec !== 'object' ||
    !Array.isArray(state.spec.candidates)
  ) {
    throw new ProtocolError('指定目录不是合法的 Evolution Run')
  }
  if (state.metadata.status !== 'completed') throw new ProtocolError('只有 completed Run 可以执行 Final Evaluation')
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
  await claimFinalAttempt(runRoot, { attemptId: finalAttemptId, startedAt: finalStartedAt })
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
        id: state.metadata.id,
        baselineRevision: h0Manifest.spec.treeDigest,
        candidateRevision: championManifest.spec.treeDigest,
      },
      baselineRecords: new Map([...baselineFeedbackRecords, ...baselineRecords]),
      candidateRecords: new Map([...candidateFeedbackRecords, ...candidateRecords]),
      partitions: ['feedback', 'final'],
      evolutionLedger: state.spec.ledger ?? null,
      allowSealed: true,
    })
    const reportPath = join(runRoot, 'final-evaluation.json')
    await writeJsonFile(reportPath, report)
    state.spec.final = {
      evaluated: true,
      attemptId: finalAttemptId,
      startedAt: finalStartedAt,
      completedAt: new Date().toISOString(),
      baselineId,
      candidateId: championId,
      report: relative(runRoot, reportPath).replaceAll('\\', '/'),
    }
    state.metadata.status = 'finalized'
    await writeJsonFile(join(runRoot, 'state.json'), state)
    onEvent({ stage: 'finalized', message: `Final 报告已写入 ${reportPath}` })
    return { runId: state.metadata.id, reportPath, report }
  } catch (error) {
    state.metadata.status = 'final-failed'
    state.spec.final = {
      ...state.spec.final,
      failedAt: new Date().toISOString(),
      failure: { message: error.message, details: error.details ?? [] },
    }
    await writeJsonFile(join(runRoot, 'state.json'), state)
    throw error
  } finally {
    const cleanupErrors = await context.modelGateway.stop()
    if (cleanupErrors.length > 0) {
      onEvent({ stage: 'cleanup-warning', message: `Model Gateway 清理失败：${cleanupErrors.join('；')}` })
    }
  }
}
