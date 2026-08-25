import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CAMPAIGN_REASONING_EFFORTS,
  loadEvolutionCampaign,
  markReported,
} from './campaign.mjs'
import { acquireCampaignLock } from './campaign-lock.mjs'
import { CampaignStore } from './campaign-store.mjs'
import { EvolutionOrchestrator } from './orchestrator.mjs'
import { fingerprintControllerImplementation } from './implementation-fingerprint.mjs'
import { prepareHleTextMathDataset } from './hle-dataset.mjs'
import { recommendHleConcurrency } from './hle-concurrency.mjs'
import { runPartition as runHlePartition } from './hle-partition-runner.mjs'
import { ProtocolError } from './protocol.mjs'
import { PutnamEvolutionRuntime } from './production-runtime.mjs'
import { attestSandboxRuntime } from './sandbox.mjs'
import { runSealedTestInChild } from './sealed-test-broker.mjs'
import {
  combineCampaignFingerprint,
  loadPutnamRuntime,
} from './runtime-config.mjs'
import { createCachedSecretReader, parseSecretFd } from './secret-reader.mjs'
import {
  formatCampaignStatus,
  readCampaignStatus,
  writeClosedCampaignReport,
} from './status-report.mjs'

const execFileAsync = promisify(execFile)
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, '..', '..')

export const CAMPAIGN_CLI_DEFAULTS = Object.freeze({
  configPath: join(REPOSITORY_ROOT, 'benchmarks', 'putnambench-lean', 'campaign.json'),
  runtimePath: join(REPOSITORY_ROOT, 'environments', 'putnambench-lean', 'runtime.json'),
  sourceRoot: join(REPOSITORY_ROOT, 'sources', 'deepseek-harness'),
  mutationTemplatePath: join(REPOSITORY_ROOT, 'prompts', 'updater-mutate.md'),
  softMutationTemplatePath: join(REPOSITORY_ROOT, 'prompts', 'updater-mutate-soft.md'),
  partitionRunnerPath: join(REPOSITORY_ROOT, 'controller', 'src', 'partition-runner.mjs'),
  hlePartitionRunnerPath: join(REPOSITORY_ROOT, 'controller', 'src', 'hle-partition-runner.mjs'),
})

const COMMON_OPTIONS = new Set([
  'config',
  'runtime',
  'campaign-id',
  'campaigns-root',
  'source-root',
])
const CREDENTIAL_ACTIONS = new Set(['campaign smoke', 'evolve start', 'evolve run', 'evolve resume'])
const CREDENTIAL_OPTIONS = Object.freeze(['provider-key-fd', 'zcloud-key-fd'])
const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SAFE_PROGRESS_TYPES = new Set([
  'baseline-materialize-started',
  'baseline-frozen',
  'build-started',
  'baseline-evaluated',
  'round-started',
  'mutation-committed',
  'updater-stopped',
  'validation-task-complete',
  'validation-complete',
  'candidate-decided',
  'campaign-closed',
  'infrastructure-paused',
])

function parseOptions(args, extraOptions = []) {
  const allowed = new Set([...COMMON_OPTIONS, ...extraOptions])
  const values = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) throw new ProtocolError(`无法识别的位置参数：${token}`)
    const name = token.slice(2)
    if (!allowed.has(name)) throw new ProtocolError(`未知参数 --${name}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ProtocolError(`参数 --${name} 缺少值`)
    if (values.has(name)) throw new ProtocolError(`参数 --${name} 重复`)
    values.set(name, value)
    index += 1
  }
  return values
}

function optionPath(options, name, fallback) {
  return resolve(options.get(name) ?? fallback)
}

function requireCampaignId(value) {
  if (typeof value !== 'string' || !CAMPAIGN_ID_PATTERN.test(value)) {
    throw new ProtocolError('--campaign-id 包含非法路径字符')
  }
  return value
}

function parseRoundLimit(value) {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new ProtocolError('--round-limit 必须是 0..10000 的整数；0 表示 Controller 不设轮次上限')
  }
  return parsed
}

function parseTaskCount(value) {
  if (value === undefined) return 1
  if (!/^[0-9]+$/u.test(value)) throw new ProtocolError('--tasks 必须是 1..8 的整数')
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
    throw new ProtocolError('--tasks 必须是 1..8 的整数')
  }
  return count
}

function seconds(value) {
  return value * 1000
}

function isWithin(parent, child) {
  const relation = relative(resolve(parent), resolve(child))
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`))
}

function assertDisjoint(left, leftName, right, rightName) {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new ProtocolError(`${leftName} 与 ${rightName} 必须互不包含`)
  }
}

/** Fail before mkdir/chown/rm if a mutable runtime path crosses a trust root. */
export function assertCampaignRuntimeLayout(context) {
  const persistentRoot = resolve(context.runtime.config.paths.persistentRoot)
  const scratchRoot = resolve(context.runtime.config.paths.scratchRoot)
  const campaignsRoot = resolve(context.campaignsRoot)
  const sourceRoot = resolve(context.sourceRoot)
  if (!isWithin(persistentRoot, campaignsRoot) || persistentRoot === campaignsRoot) {
    throw new ProtocolError('campaignsRoot 必须严格位于 runtime persistentRoot 内')
  }
  assertDisjoint(REPOSITORY_ROOT, 'Controller repository', persistentRoot, 'persistentRoot')
  assertDisjoint(REPOSITORY_ROOT, 'Controller repository', scratchRoot, 'scratchRoot')
  assertDisjoint(sourceRoot, 'sourceRoot', persistentRoot, 'persistentRoot')
  assertDisjoint(sourceRoot, 'sourceRoot', scratchRoot, 'scratchRoot')
  assertDisjoint(persistentRoot, 'persistentRoot', scratchRoot, 'scratchRoot')
  if (!isWithin(REPOSITORY_ROOT, context.configPath)
      || !isWithin(REPOSITORY_ROOT, context.runtimePath)
      || !isWithin(REPOSITORY_ROOT, context.testManifestPath)) {
    throw new ProtocolError('Campaign、Runtime 与 sealed manifest 必须位于 Controller trust root 内')
  }
  return context
}

function assertFrozenModel(loadedCampaign, loadedRuntime) {
  const solver = loadedCampaign.config.spec.solver
  if (!CAMPAIGN_REASONING_EFFORTS.includes(solver.reasoningEffort)
      || solver.api !== 'openai-responses') {
    throw new ProtocolError('Campaign 模型必须冻结为受支持 effort / openai-responses')
  }
  if ((loadedCampaign.config.spec.source.format ?? 'putnambench-lean') === 'hle-text-math') {
    const scoring = loadedCampaign.config.spec.scoring
    const verifier = loadedRuntime.config.verifier
    if (scoring.judgeModel !== solver.model || verifier.judgeModel !== solver.model
        || verifier.judgeReasoningEffort !== scoring.judgeReasoningEffort) {
      throw new ProtocolError('HLE Solver、Campaign judge 与 Runtime judge 模型配置必须一致')
    }
  }
}

export async function loadCampaignRuntimeContext(options, dependencies = {}) {
  const loadCampaign = dependencies.loadEvolutionCampaign ?? loadEvolutionCampaign
  const loadRuntime = dependencies.loadPutnamRuntime ?? loadPutnamRuntime
  const combineFingerprint = dependencies.combineCampaignFingerprint ?? combineCampaignFingerprint
  const fingerprintImplementation = dependencies.fingerprintControllerImplementation
    ?? fingerprintControllerImplementation
  const configPath = optionPath(options, 'config', CAMPAIGN_CLI_DEFAULTS.configPath)
  const runtimePath = optionPath(options, 'runtime', CAMPAIGN_CLI_DEFAULTS.runtimePath)
  const sourceRoot = optionPath(options, 'source-root', CAMPAIGN_CLI_DEFAULTS.sourceRoot)
  const campaign = await loadCampaign(configPath)
  const runtime = await loadRuntime(runtimePath)
  assertFrozenModel(campaign, runtime)
  const campaignId = requireCampaignId(options.get('campaign-id') ?? campaign.config.metadata.id)
  const campaignsRoot = optionPath(
    options,
    'campaigns-root',
    join(runtime.config.paths.persistentRoot, 'campaigns'),
  )
  const implementationFingerprint = await fingerprintImplementation(REPOSITORY_ROOT)
  const fingerprint = combineFingerprint(
    campaign.fingerprint,
    runtime.fingerprint,
    implementationFingerprint,
  )
  return assertCampaignRuntimeLayout({
    campaign: { ...campaign, fingerprint },
    campaignFingerprint: campaign.fingerprint,
    runtime,
    implementationFingerprint,
    fingerprint,
    campaignId,
    campaignsRoot,
    sourceRoot,
    configPath,
    runtimePath,
    testManifestPath: resolve(
      dirname(configPath),
      campaign.config.spec.partitions.test.manifest,
    ),
  })
}

async function defaultIdentityLookup(user, idPath = '/usr/bin/id') {
  const [uidResult, gidResult] = await Promise.all([
    execFileAsync(idPath, ['-u', user], { encoding: 'utf8' }),
    execFileAsync(idPath, ['-g', user], { encoding: 'utf8' }),
  ])
  return { uid: Number(uidResult.stdout.trim()), gid: Number(gidResult.stdout.trim()) }
}

export async function resolveRuntimeIdentities(runtimeConfig, dependencies = {}) {
  const lookup = dependencies.identityLookup ?? defaultIdentityLookup
  const identities = {}
  for (const [field, user] of Object.entries(runtimeConfig.identities)) {
    if (!field.endsWith('User')) continue
    const name = field.slice(0, -'User'.length)
    const identity = await lookup(user, dependencies.idPath)
    if (!Number.isInteger(identity?.uid) || identity.uid < 1
        || !Number.isInteger(identity?.gid) || identity.gid < 1) {
      throw new ProtocolError(`系统身份 ${user} 的 uid/gid 无效`)
    }
    identities[name] = { user, uid: identity.uid, gid: identity.gid }
  }
  for (const required of ['updater', 'solver', 'verifier', 'build']) {
    if (!identities[required]) throw new ProtocolError(`Runtime 缺少 ${required} 系统身份`)
  }
  const primaryGids = Object.values(identities).map((identity) => identity.gid)
  if (new Set(primaryGids).size !== primaryGids.length) {
    throw new ProtocolError('Updater、Solver、Verifier、Build 必须使用不同的 primary gid')
  }
  return identities
}

export function buildAgentEnvironment(runtimeConfig, environment = process.env, home) {
  const nodeBin = dirname(runtimeConfig.toolchain.nodePath)
  const elanBin = join(runtimeConfig.toolchain.elanHome, 'bin')
  return {
    HOME: home,
    PATH: `${nodeBin}:${elanBin}:/usr/bin:/bin`,
    ELAN_HOME: runtimeConfig.toolchain.elanHome,
    LANG: environment.LANG ?? 'C.UTF-8',
    LC_ALL: environment.LC_ALL ?? 'C.UTF-8',
    TZ: environment.TZ ?? 'UTC',
    CI: '1',
    NO_COLOR: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    LEAN_NUM_THREADS: String(runtimeConfig.verifier.threadsPerProcess),
  }
}

export async function attestRuntimePatch(runtimeConfig) {
  const environmentName = runtimeConfig.kind === 'HleTextMathRuntime'
    ? 'hle-text-math'
    : 'putnambench-lean'
  const patchName = runtimeConfig.kind === 'HleTextMathRuntime'
    ? 'dashscope-qwen38-max-headless.patch.yml'
    : 'zcloud-max-headless.patch.yml'
  const trustedPath = join(
    REPOSITORY_ROOT,
    'environments',
    environmentName,
    patchName,
  )
  const installedPath = runtimeConfig.paths.runtimePatch
  let trustedStat
  let installedStat
  let trusted
  let installed
  try {
    [trustedStat, installedStat, trusted, installed] = await Promise.all([
      lstat(trustedPath),
      lstat(installedPath),
      readFile(trustedPath),
      readFile(installedPath),
    ])
  } catch (error) {
    throw new ProtocolError('Controller runtime patch 不可用', [error.message])
  }
  if (!trustedStat.isFile() || trustedStat.isSymbolicLink()
      || !installedStat.isFile() || installedStat.isSymbolicLink()) {
    throw new ProtocolError('Controller runtime patch 必须是普通文件且不能是符号链接')
  }
  if (!trusted.equals(installed)) {
    throw new ProtocolError('已安装 runtime patch 与 Controller fingerprint 绑定版本不一致')
  }
  if (runtimeConfig.kind === 'HleTextMathRuntime') {
    const trustedRelayPath = join(REPOSITORY_ROOT, 'controller', 'src', 'model-gateway-relay.mjs')
    const installedRelayPath = join(dirname(installedPath), 'model-gateway-relay.mjs')
    let trustedRelayStat
    let installedRelayStat
    let trustedRelay
    let installedRelay
    try {
      [trustedRelayStat, installedRelayStat, trustedRelay, installedRelay] = await Promise.all([
        lstat(trustedRelayPath),
        lstat(installedRelayPath),
        readFile(trustedRelayPath),
        readFile(installedRelayPath),
      ])
    } catch (error) {
      throw new ProtocolError('Controller model gateway relay 不可用', [error.message])
    }
    if (!trustedRelayStat.isFile() || trustedRelayStat.isSymbolicLink()
        || !installedRelayStat.isFile() || installedRelayStat.isSymbolicLink()) {
      throw new ProtocolError('Controller model gateway relay 必须是普通文件且不能是符号链接')
    }
    if (!trustedRelay.equals(installedRelay)) {
      throw new ProtocolError('已安装 model gateway relay 与 Controller fingerprint 绑定版本不一致')
    }
  }
}

/** Map every Partition-supported budget from the frozen runtime config. */
export function buildPartitionOptions(runtimeConfig, requestedConcurrency, identities = {}) {
  const concurrency = Math.min(
    requestedConcurrency,
    runtimeConfig.solver.maximumConcurrency,
    runtimeConfig.verifier.concurrency,
  )
  return {
    concurrency,
    maximumModelRequestsPerTask: runtimeConfig.solver.maximumModelRequestsPerTask ?? null,
    maximumResponseTokens: runtimeConfig.solver.maximumResponseTokens ?? null,
    maximumGatewayConcurrencyPerTask: runtimeConfig.solver.gatewayConcurrencyPerTask ?? null,
    taskTimeoutMs: seconds(runtimeConfig.solver.taskTimeoutSeconds),
    verifierTimeoutMs: seconds(runtimeConfig.verifier.timeoutSeconds),
    gatewayRequestTimeoutMs: seconds(runtimeConfig.gateway.requestTimeoutSeconds),
    infrastructureRetries: runtimeConfig.solver.infrastructureRetries,
    infrastructureRetryBaseDelayMs: seconds(
      runtimeConfig.solver.infrastructureRetryBaseDelaySeconds,
    ),
    ...(runtimeConfig.solver.partitionTimeoutSeconds === undefined
      ? {}
      : { partitionTimeoutMs: seconds(runtimeConfig.solver.partitionTimeoutSeconds) }),
    ...(runtimeConfig.toolchain.bwrapPath
      ? { bwrapPath: runtimeConfig.toolchain.bwrapPath }
      : {}),
    ...(runtimeConfig.toolchain.setprivPath
      ? { setprivPath: runtimeConfig.toolchain.setprivPath }
      : {}),
    ...(identities.verifier
      ? { verifierUid: identities.verifier.uid, verifierGid: identities.verifier.gid }
      : {}),
  }
}

export function safeProgressEvent(event) {
  if (!event || typeof event !== 'object' || !SAFE_PROGRESS_TYPES.has(event.type)) return null
  const safe = { type: event.type }
  if (typeof event.candidateId === 'string' && CAMPAIGN_ID_PATTERN.test(event.candidateId)) {
    safe.candidateId = event.candidateId
  }
  if (['l1', 'l2', 'l3', 'baseline'].includes(event.level)) safe.level = event.level
  if (['completed', 'candidate_failure'].includes(event.outcome)) safe.outcome = event.outcome
  if (['baseline', 'promoted', 'rejected'].includes(event.decision)) safe.decision = event.decision
  if (Number.isInteger(event.validationVerified)
      && event.validationVerified >= 0 && event.validationVerified <= 500) {
    safe.validationVerified = event.validationVerified
  }
  if (Number.isInteger(event.completed) && event.completed >= 0
      && Number.isInteger(event.total) && event.total >= event.completed && event.total <= 500) {
    safe.completed = event.completed
    safe.total = event.total
  }
  if (typeof event.operation === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(event.operation)
      && !/(?:test|sealed|hidden)/iu.test(event.operation)) {
    safe.operation = event.operation
  }
  return Object.freeze(safe)
}

function createProgressWriter(writeLine) {
  return (event) => {
    const safe = safeProgressEvent(event)
    if (safe) writeLine(`${JSON.stringify(safe)}\n`)
  }
}

export function createSealedRunner({
  context,
  identities,
  getApiKey,
  signal,
  environment = process.env,
  runChild = runSealedTestInChild,
}) {
  const runtime = context.runtime.config
  const benchmark = context.campaign.config.spec.source.format ?? 'putnambench-lean'
  const hle = benchmark === 'hle-text-math'
  const campaignScratchRoot = join(runtime.paths.scratchRoot, context.campaignId)
  const solverHome = join(campaignScratchRoot, 'solver-home')
  const partitionOptions = {
    ...buildPartitionOptions(runtime, runtime.solver.initialConcurrency, identities),
    solutionsRoot: hle
      ? join(runtime.paths.datasetRoot, 'sealed', 'test')
      : join(runtime.paths.datasetRoot, 'lean4', 'solutions_replaced_new'),
    leanRoot: hle ? runtime.paths.datasetRoot : join(runtime.paths.datasetRoot, 'lean4'),
    scratchRoot: join(campaignScratchRoot, 'sealed-test'),
    nodePath: runtime.toolchain.nodePath,
    lakePath: runtime.toolchain.lakePath,
    patchPath: runtime.paths.runtimePatch,
    upstreamBaseUrl: runtime.gateway.upstreamBaseUrl,
    gatewayModel: context.campaign.config.spec.solver.model,
    gatewayReasoningEffort: context.campaign.config.spec.solver.reasoningEffort,
    baseEnvironment: buildAgentEnvironment(runtime, environment, solverHome),
    preset: context.campaign.config.spec.solver.preset,
    model: context.campaign.config.spec.solver.model,
    reasoningEffort: context.campaign.config.spec.solver.reasoningEffort,
    solverUid: identities.solver.uid,
    solverGid: identities.solver.gid,
    benchmark,
    ...(hle ? {
      judgeModel: runtime.verifier.judgeModel,
      judgeReasoningEffort: runtime.verifier.judgeReasoningEffort,
      judgeMaximumOutputTokens: runtime.verifier.judgeMaximumOutputTokens,
      judgeTimeoutMs: seconds(runtime.verifier.timeoutSeconds),
    } : {}),
    ...(identities.verifier
      ? { verifierUid: identities.verifier.uid, verifierGid: identities.verifier.gid }
      : {}),
  }

  // This trusted closure deliberately ignores all caller-supplied IDs, paths,
  // keys, stores, and callbacks. The manifest and provider accessor flow only
  // into the isolated broker, never into an in-process evaluation callback.
  return async function sealedTestRunner({ candidateId, candidateRoot }) {
    return runChild({
      candidateId,
      testManifestPath: context.testManifestPath,
      testManifestSha256: context.campaign.config.spec.partitions.test.sha256,
      sealedOutputPath: join(
        context.campaignsRoot,
        context.campaignId,
        'sealed',
        'test',
        candidateId,
      ),
      runnerModulePath: hle
        ? CAMPAIGN_CLI_DEFAULTS.hlePartitionRunnerPath
        : CAMPAIGN_CLI_DEFAULTS.partitionRunnerPath,
      runnerExport: 'runPartition',
      partitionOptions: { ...partitionOptions, candidateRoot },
      getApiKey,
      signal,
      timeoutMs: seconds(runtime.testBroker.timeoutSeconds),
      nodePath: runtime.toolchain.nodePath,
      childEnvironment: buildAgentEnvironment(runtime, environment, solverHome),
      expectedCount: context.campaign.config.spec.partitions.test.expectedCount,
    })
  }
}

export function createAbortSignal(processObject = process) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  processObject.once('SIGINT', abort)
  processObject.once('SIGTERM', abort)
  return {
    signal: controller.signal,
    cleanup() {
      processObject.removeListener('SIGINT', abort)
      processObject.removeListener('SIGTERM', abort)
    },
  }
}

function createStore(context, dependencies) {
  if (typeof dependencies.createStore === 'function') {
    return dependencies.createStore(context.campaignsRoot, context.campaignId)
  }
  return new CampaignStore(context.campaignsRoot, context.campaignId)
}

async function createRuntimeStack({ context, mode, getApiKey, signal, dependencies, progress }) {
  const runtimeConfig = context.runtime.config
  const benchmark = context.campaign.config.spec.source.format ?? 'putnambench-lean'
  const hle = benchmark === 'hle-text-math'
  const softLayers = context.campaign.config.spec.evolution?.layerSelection === 'updater-soft'
  if (softLayers && runtimeConfig.mutation?.mode !== 'updater-soft') {
    throw new ProtocolError('updater-soft Campaign 需要 Runtime mutation layer 参数')
  }
  const attestPatch = dependencies.attestRuntimePatch ?? attestRuntimePatch
  await attestPatch(runtimeConfig)
  const identities = await resolveRuntimeIdentities(runtimeConfig, dependencies)
  const attestSandbox = dependencies.attestSandboxRuntime ?? attestSandboxRuntime
  await attestSandbox({
    bwrapPath: runtimeConfig.toolchain.bwrapPath,
    setprivPath: runtimeConfig.toolchain.setprivPath,
    restrictedUids: [
      identities.updater.uid,
      identities.solver.uid,
      identities.verifier.uid,
      identities.build.uid,
    ],
    isolatedNetwork: hle,
  })
  const store = createStore(context, dependencies)
  const environment = dependencies.environment ?? process.env
  const campaignScratchRoot = join(runtimeConfig.paths.scratchRoot, context.campaignId)
  const runtimeOptions = {
    store,
    runtimesRoot: join(runtimeConfig.paths.persistentRoot, 'runtimes', context.campaignId),
    ...(mode === 'campaign' ? {
      runtimeCacheRoot: join(runtimeConfig.paths.persistentRoot, 'runtime-cache', 'v1'),
    } : {}),
    pnpmStoreRoot: runtimeConfig.paths.pnpmStore,
    buildHome: runtimeConfig.paths.buildHome,
    updaterRunRoot: join(campaignScratchRoot, 'updater-runs'),
    validationScratchRoot: join(campaignScratchRoot, 'validation'),
    smokeScratchRoot: join(campaignScratchRoot, 'smoke'),
    solverHome: join(campaignScratchRoot, 'solver-home'),
    datasetRoot: runtimeConfig.paths.datasetRoot,
    benchmark,
    validationExpectedCount: context.campaign.config.spec.partitions.validation.expectedCount,
    nodePath: runtimeConfig.toolchain.nodePath,
    pnpmCliPath: runtimeConfig.toolchain.pnpmPath,
    runtimePatch: runtimeConfig.paths.runtimePatch,
    mutationTemplatePath: softLayers
      ? CAMPAIGN_CLI_DEFAULTS.softMutationTemplatePath
      : CAMPAIGN_CLI_DEFAULTS.mutationTemplatePath,
    mutationConfiguration: runtimeConfig.mutation,
    expectedNodeVersion: `v${runtimeConfig.toolchain.nodeVersion}`,
    expectedPnpmVersion: runtimeConfig.toolchain.pnpmVersion,
    upstreamBaseUrl: runtimeConfig.gateway.upstreamBaseUrl,
    getApiKey,
    updaterBackend: runtimeConfig.updater.backend ?? 'deepseek-harness',
    updaterProvider: runtimeConfig.updater.provider ?? 'gateway',
    updaterModel: runtimeConfig.updater.model
      ?? context.campaign.config.spec.solver.model,
    updaterReasoningEffort: runtimeConfig.updater.reasoningEffort
      ?? context.campaign.config.spec.solver.reasoningEffort,
    ...(runtimeConfig.toolchain.codexPath
      ? { codexPath: runtimeConfig.toolchain.codexPath }
      : {}),
    preset: context.campaign.config.spec.solver.preset,
    model: context.campaign.config.spec.solver.model,
    reasoningEffort: context.campaign.config.spec.solver.reasoningEffort,
    lakePath: runtimeConfig.toolchain.lakePath,
    pythonPath: '/usr/bin/python3',
    setprivPath: runtimeConfig.toolchain.setprivPath ?? '/usr/bin/setpriv',
    ...(runtimeConfig.toolchain.bwrapPath
      ? { bwrapPath: runtimeConfig.toolchain.bwrapPath }
      : {}),
    baseEnvironment: buildAgentEnvironment(
      runtimeConfig,
      environment,
      join(campaignScratchRoot, 'solver-home'),
    ),
    secretValues: [await getApiKey()],
    ...(runtimeConfig.updater.timeoutSeconds === undefined
      ? { mutationTimeoutMs: null }
      : {
          buildTimeoutMs: seconds(runtimeConfig.updater.timeoutSeconds),
          mutationTimeoutMs: seconds(runtimeConfig.updater.timeoutSeconds),
        }),
    partitionOptions: {
      ...buildPartitionOptions(
        runtimeConfig,
        mode === 'smoke'
          ? runtimeConfig.solver.smokeConcurrency
          : runtimeConfig.solver.initialConcurrency,
        identities,
      ),
      gatewayModel: context.campaign.config.spec.solver.model,
      gatewayReasoningEffort: context.campaign.config.spec.solver.reasoningEffort,
      benchmark,
      ...(hle ? {
        judgeModel: runtimeConfig.verifier.judgeModel,
        judgeReasoningEffort: runtimeConfig.verifier.judgeReasoningEffort,
        judgeMaximumOutputTokens: runtimeConfig.verifier.judgeMaximumOutputTokens,
        judgeTimeoutMs: seconds(runtimeConfig.verifier.timeoutSeconds),
      } : {}),
    },
    ...(hle ? {
      prepareDataset: prepareHleTextMathDataset,
      partitionRunner: runHlePartition,
    } : {}),
    gatewayOptions: {
      maxRequests: runtimeConfig.updater.maximumModelRequestsPerPhase ?? null,
      maxConcurrency: runtimeConfig.updater.gatewayConcurrency,
      requestTimeoutMs: seconds(runtimeConfig.gateway.requestTimeoutSeconds),
      maxOutputTokens: runtimeConfig.solver.maximumResponseTokens ?? null,
    },
    updaterUid: identities.updater.uid,
    updaterGid: identities.updater.gid,
    buildUid: identities.build.uid,
    buildGid: identities.build.gid,
    solverUid: identities.solver.uid,
    solverGid: identities.solver.gid,
    ...(identities.verifier
      ? { verifierUid: identities.verifier.uid, verifierGid: identities.verifier.gid }
      : {}),
    trustedUid: 0,
    trustedGid: identities.updater.gid,
    signal,
    onProgress: progress,
    sealedTestRunner: createSealedRunner({
      context,
      identities,
      getApiKey,
      signal,
      environment,
      runChild: dependencies.runSealedTestInChild ?? runSealedTestInChild,
    }),
  }
  const runtime = typeof dependencies.createRuntime === 'function'
    ? dependencies.createRuntime(runtimeOptions)
    : new PutnamEvolutionRuntime(runtimeOptions)
  return { runtime, store, identities, runtimeOptions }
}

function verifyFrozenFingerprint(state, context) {
  if (!state || state.configFingerprint !== context.fingerprint) {
    throw new ProtocolError('Campaign 配置或 Runtime 指纹与冻结 state 不一致')
  }
}

async function terminalReport(orchestrator, state) {
  if (state.status !== 'CLOSED' && state.status !== 'REPORTED') return null
  const report = await orchestrator.report()
  return { directory: report.directory, paths: report.paths, state: report.state }
}

function commandResult(status, report) {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionCommandResult',
    status: formatCampaignStatus(status),
    ...(report ? { report: { directory: report.directory, paths: report.paths } } : {}),
  }
}

function emitJson(writeLine, value) {
  writeLine(`${JSON.stringify(value, null, 2)}\n`)
  return value
}

export function isCampaignCliCommand(group, action) {
  return (group === 'campaign' && ['validate', 'smoke'].includes(action))
    || (group === 'evolve' && ['start', 'run', 'resume', 'status', 'report'].includes(action))
}

/** Production command dispatcher, with explicit dependency seams for offline tests. */
export async function runCampaignCliCommand(group, action, args, dependencies = {}) {
  if (!isCampaignCliCommand(group, action)) {
    throw new ProtocolError(`未知命令：${[group, action].filter(Boolean).join(' ')}`)
  }
  const command = `${group} ${action}`
  const credentialRequired = CREDENTIAL_ACTIONS.has(command)
  const extraOptions = [
    ...(credentialRequired ? CREDENTIAL_OPTIONS : []),
    ...(command === 'campaign smoke' ? ['tasks'] : []),
    ...(group === 'evolve' && ['start', 'run', 'resume'].includes(action)
      ? ['round-limit']
      : []),
  ]
  const options = parseOptions(args, extraOptions)
  const context = await loadCampaignRuntimeContext(options, dependencies)
  const writeLine = dependencies.writeStdout ?? ((text) => process.stdout.write(text))

  if (command === 'campaign validate') {
    return emitJson(writeLine, {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'CampaignValidationReport',
      valid: true,
      campaignId: context.campaignId,
      fingerprint: context.fingerprint,
      model: {
        name: context.campaign.config.spec.solver.model,
        reasoningEffort: context.campaign.config.spec.solver.reasoningEffort,
        api: context.campaign.config.spec.solver.api,
      },
      partitions: {
        validation: context.campaign.config.spec.partitions.validation.expectedCount,
        test: context.campaign.config.spec.partitions.test.expectedCount,
      },
    })
  }

  if (command === 'evolve status') {
    const store = createStore(context, dependencies)
    const state = await store.readState()
    verifyFrozenFingerprint(state, context)
    const status = dependencies.readCampaignStatus
      ? await dependencies.readCampaignStatus(store)
      : await readCampaignStatus(store)
    return emitJson(writeLine, status)
  }

  const lock = dependencies.acquireCampaignLock ?? acquireCampaignLock
  const releaseLock = await lock({
    campaignsRoot: context.campaignsRoot,
    campaignId: context.campaignId,
    command,
  })
  try {
    if (command === 'evolve report') {
      const store = createStore(context, dependencies)
      const state = await store.readState()
      verifyFrozenFingerprint(state, context)
      const writeReport = dependencies.writeClosedCampaignReport ?? writeClosedCampaignReport
      const report = await writeReport(store)
      let finalState = state
      if (state.status === 'CLOSED') {
        const clock = dependencies.clock ?? (() => new Date())
        finalState = markReported(state, { at: clock().toISOString() })
        await store.saveState(finalState)
      }
      return emitJson(writeLine, commandResult(finalState, report))
    }

    // A resumed campaign must authenticate its frozen combined fingerprint
    // before any runtime-selected executable is run or the credential FD is read.
    if (command === 'evolve run' || command === 'evolve resume') {
      const existingStore = createStore(context, dependencies)
      verifyFrozenFingerprint(await existingStore.readState(), context)
    }

    const credentialOption = context.runtime.config.secrets.primaryKeyFdOption ?? 'zcloud-key-fd'
    const unexpectedCredential = CREDENTIAL_OPTIONS.find(
      (name) => name !== credentialOption && options.has(name),
    )
    if (unexpectedCredential) {
      throw new ProtocolError(`当前 Runtime 不接受 --${unexpectedCredential}`)
    }
    const rawFd = options.get(credentialOption)
    if (rawFd === undefined) throw new ProtocolError(`缺少必填参数 --${credentialOption}`)
    const fd = parseSecretFd(rawFd, credentialOption)
    const getApiKey = (dependencies.createCachedSecretReader ?? createCachedSecretReader)({
      fd,
      optionName: credentialOption,
      ...(dependencies.readSecretFd ? { readFd: dependencies.readSecretFd } : {}),
    })
    const signals = dependencies.createAbortSignal
      ? dependencies.createAbortSignal()
      : createAbortSignal(dependencies.processObject ?? process)
    const progress = createProgressWriter(writeLine)
    try {
      const stack = await createRuntimeStack({
        context,
        mode: command === 'campaign smoke' ? 'smoke' : 'campaign',
        getApiKey,
        signal: signals.signal,
        dependencies,
        progress,
      })
      if (command === 'campaign smoke') {
        const tasks = parseTaskCount(options.get('tasks'))
        const result = await stack.runtime.smoke({
          candidateRoot: context.sourceRoot,
          instanceIds: context.campaign.manifests.validation.slice(0, tasks),
        })
        return emitJson(writeLine, {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'CampaignSmokeResult',
          campaignId: context.campaignId,
          summary: result.summary,
          ...((context.campaign.config.spec.source.format === 'hle-text-math' && tasks >= 4)
            ? {
                concurrencyPlan: recommendHleConcurrency({
                  latenciesMs: result.records.map((record) => record.latencyMs),
                  taskCount: context.campaign.config.spec.partitions.validation.expectedCount,
                  targetMs: seconds(context.runtime.config.solver.partitionTimeoutSeconds),
                  maximumConcurrency: context.runtime.config.solver.maximumConcurrency,
                }),
              }
            : {}),
        })
      }

      const orchestratorOptions = {
        loadedCampaign: context.campaign,
        campaignsRoot: context.campaignsRoot,
        campaignId: context.campaignId,
        sourceRoot: context.sourceRoot,
        runtime: stack.runtime,
        progress,
        updaterUid: stack.identities.updater.uid,
        updaterGid: stack.identities.updater.gid,
        trustedUid: 0,
        trustedGid: stack.identities.updater.gid,
        secretValues: [await getApiKey()],
        runtimeSnapshot: context.runtime.config,
        implementationFingerprint: context.implementationFingerprint,
      }
      const orchestrator = typeof dependencies.createOrchestrator === 'function'
        ? dependencies.createOrchestrator(orchestratorOptions)
        : new EvolutionOrchestrator(orchestratorOptions)
      let state
      const runOptions = { roundLimit: parseRoundLimit(options.get('round-limit')) }
      if (action === 'start') {
        await orchestrator.initialize()
        state = await orchestrator.run(runOptions)
      } else if (action === 'run') {
        state = await orchestrator.run(runOptions)
      } else {
        state = await orchestrator.resume(runOptions)
      }
      const report = await terminalReport(orchestrator, state)
      return emitJson(writeLine, commandResult(report?.state ?? state, report))
    } finally {
      signals.cleanup()
    }
  } finally {
    await releaseLock()
  }
}
