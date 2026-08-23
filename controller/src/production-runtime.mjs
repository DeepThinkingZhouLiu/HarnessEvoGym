import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertOpaqueTestReceipt } from './campaign.mjs'
import { isProviderInfrastructureAudit, startModelGateway } from './model-gateway.mjs'
import { DEEPSEEK_HARNESS_MUTATION_POLICY } from './mutation.mjs'
import { runPartition } from './partition-runner.mjs'
import { preparePutnamBenchDataset } from './putnambench-runner.mjs'
import {
  acquireGatewayEgressLease,
  buildBubblewrapInvocation,
  executableDistributionRoot,
} from './sandbox.mjs'
import { runProcess } from './subprocess.mjs'
import { runApplyPhase, runProposalPhase } from './updater-runner.mjs'

export const PRODUCTION_TOOLCHAIN_PIN = Object.freeze({
  nodeVersion: 'v24.19.0',
  pnpmVersion: '11.7.0',
})

const SAFE_ENVIRONMENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'ELAN_HOME',
  'NO_COLOR',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'TZ',
])
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const LEVELS = new Set(['baseline', 'l1', 'l2', 'l3'])

export const SOURCE_SMOKE_SANDBOX_PATHS = Object.freeze({
  runtime: '/opt/harness-rsi/candidate-runtime',
  nodeToolchain: '/opt/harness-rsi/node-toolchain',
  workspace: '/source-smoke',
})

export const BUILD_SANDBOX_PATHS = Object.freeze({
  runtime: '/opt/harness-rsi/build-runtime',
  store: '/opt/harness-rsi/pnpm-store',
  nodeToolchain: '/opt/harness-rsi/node-toolchain',
  pnpmToolchain: '/opt/harness-rsi/pnpm-toolchain',
  sharedToolchain: '/opt/harness-rsi/build-toolchain',
  workspace: '/build',
})

export class ProductionRuntimeError extends Error {
  constructor(operation, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProductionRuntimeError'
    this.kind = 'infrastructure'
    this.operation = operation
  }
}

function infrastructureError(operation, message, cause) {
  if (cause instanceof ProductionRuntimeError) return cause
  return new ProductionRuntimeError(operation, message, cause)
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  return value
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`)
  }
  return resolve(value)
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function requirePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}

function validateIdentity(uid, gid, label, { allowRoot = false } = {}) {
  if (uid === undefined && gid === undefined) return
  const minimum = allowRoot ? 0 : 1
  if (!Number.isInteger(uid) || uid < minimum || !Number.isInteger(gid) || gid < minimum) {
    throw new TypeError(`${label} uid/gid must both be integers >= ${minimum}`)
  }
}

function safeEnvironment(baseEnvironment, home) {
  const output = {}
  for (const [key, value] of Object.entries(baseEnvironment ?? {})) {
    if (SAFE_ENVIRONMENT_KEYS.has(key) && typeof value === 'string') output[key] = value
  }
  output.HOME = resolve(home)
  output.CI = '1'
  output.NO_COLOR = '1'
  output.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return output
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertSeparated(sourceRoot, runtimeRoot) {
  if (isWithin(sourceRoot, runtimeRoot) || isWithin(runtimeRoot, sourceRoot)) {
    throw new ProductionRuntimeError(
      'candidate-build',
      'Candidate source and dependency runtime must be separate paths',
    )
  }
}

function assertCandidate(candidateId, level) {
  if (typeof candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new ProductionRuntimeError('runtime-input', 'candidateId is invalid')
  }
  if (!LEVELS.has(level)) throw new ProductionRuntimeError('runtime-input', 'mutation level is invalid')
  if ((level === 'baseline') !== (candidateId === 'baseline')) {
    throw new ProductionRuntimeError('runtime-input', 'baseline candidate and level must match')
  }
}

function processExitCode(result) {
  const code = result?.exitCode ?? result?.code
  return Number.isInteger(code) ? code : null
}

function processSucceeded(result) {
  if (result?.ok === true) return true
  return processExitCode(result) === 0
    && result?.timedOut !== true
    && result?.aborted !== true
    && result?.outputExceeded !== true
}

function processOperationalFailure(result) {
  return result?.timedOut === true || result?.aborted === true || result?.outputExceeded === true
}

async function walkTree(root, visit) {
  const stat = await lstat(root)
  await visit(root, stat)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) await walkTree(join(root, entry.name), visit)
}

/**
 * The campaign only consumes the dependency cache prepared by trusted setup.
 * A writable or build-owned entry would turn an earlier Candidate into a
 * dependency-supply-chain input for every later Candidate, so fail closed.
 */
export async function validateImmutableDependencyStore({ root, trustedUid, buildUid }) {
  const storeRoot = resolve(root)
  const rootStat = await lstat(storeRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Pinned pnpm store root must be a real directory')
  }
  const [indexStat, filesStat] = await Promise.all([
    lstat(join(storeRoot, 'v11', 'index.db')),
    lstat(join(storeRoot, 'v11', 'files')),
  ])
  if (!indexStat.isFile() || indexStat.isSymbolicLink()
      || !filesStat.isDirectory() || filesStat.isSymbolicLink()) {
    throw new Error('Pinned pnpm v11 store is missing its immutable index/files closure')
  }
  let entries = 0
  await walkTree(storeRoot, async (path, stat) => {
    entries += 1
    if (stat.uid !== trustedUid || stat.uid === buildUid) {
      throw new Error(`Pinned pnpm store entry is not trusted-owned: ${path}`)
    }
    if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) {
      throw new Error(`Pinned pnpm store entry is group/other writable: ${path}`)
    }
  })
  if (entries < 2) throw new Error('Pinned pnpm store is empty')
}

function buildToolchainMounts(nodePath, pnpmCliPath) {
  const nodeRoot = executableDistributionRoot(nodePath)
  const pnpmRoot = executableDistributionRoot(pnpmCliPath)
  if (nodeRoot === null && pnpmRoot === null) return []
  if (nodeRoot === null) {
    return [{ source: pnpmRoot, destination: BUILD_SANDBOX_PATHS.pnpmToolchain, readOnly: true }]
  }
  if (pnpmRoot === null) {
    return [{ source: nodeRoot, destination: BUILD_SANDBOX_PATHS.nodeToolchain, readOnly: true }]
  }
  if (nodeRoot === pnpmRoot || isWithin(nodeRoot, pnpmRoot) || isWithin(pnpmRoot, nodeRoot)) {
    const sharedRoot = isWithin(nodeRoot, pnpmRoot) ? nodeRoot : pnpmRoot
    return [{
      source: sharedRoot,
      destination: BUILD_SANDBOX_PATHS.sharedToolchain,
      readOnly: true,
    }]
  }
  return [
    { source: nodeRoot, destination: BUILD_SANDBOX_PATHS.nodeToolchain, readOnly: true },
    { source: pnpmRoot, destination: BUILD_SANDBOX_PATHS.pnpmToolchain, readOnly: true },
  ]
}

async function defaultPrepareOwnedDirectory({ path, uid, gid, mode }) {
  await mkdir(path, { recursive: true, mode })
  if (uid !== undefined && gid !== undefined) await chown(path, uid, gid)
  await chmod(path, mode)
}

async function defaultCopyRuntimeSource({ sourceRoot, destination }) {
  const source = resolve(sourceRoot)
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter(path) {
      const rel = relative(source, path)
      if (!rel) return true
      const first = rel.split(sep)[0]
      return first !== '.git' && first !== 'node_modules'
    },
  })
}

async function defaultGrantBuildAccess({ root, uid, gid }) {
  await walkTree(root, async (path, stat) => {
    if (stat.isSymbolicLink()) return
    if (uid !== undefined && gid !== undefined) await chown(path, uid, gid)
    if (stat.isDirectory()) await chmod(path, 0o750)
    else if (stat.isFile()) await chmod(path, stat.mode & 0o111 ? 0o750 : 0o640)
  })
}

async function defaultFreezeRuntimeTree({ root, uid, gid }) {
  await walkTree(root, async (path, stat) => {
    if (stat.isSymbolicLink()) return
    if (uid !== undefined && gid !== undefined) await chown(path, uid, gid)
    if (stat.isDirectory()) await chmod(path, 0o555)
    else if (stat.isFile()) await chmod(path, stat.mode & 0o111 ? 0o555 : 0o444)
  })
}

async function requireRegularFile(path, label) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`)
}

async function defaultValidateRuntime(runtimeRoot) {
  await Promise.all([
    requireRegularFile(join(runtimeRoot, 'apps', 'cli', 'src', 'bin.ts'), 'Harness source entry'),
    requireRegularFile(
      join(runtimeRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
      'tsx runtime entry',
    ),
  ])
}

const EVALUATION_RUNTIME_ENTRIES = Object.freeze([
  { path: '', type: 'directory' },
  { path: 'apps', type: 'directory' },
  { path: join('apps', 'cli'), type: 'directory' },
  { path: join('apps', 'cli', 'src'), type: 'directory' },
  { path: join('apps', 'cli', 'src', 'bin.ts'), type: 'file' },
  { path: 'node_modules', type: 'directory' },
  { path: join('node_modules', 'tsx'), type: 'directory' },
  { path: join('node_modules', 'tsx', 'dist'), type: 'directory' },
  { path: join('node_modules', 'tsx', 'dist', 'esm'), type: 'directory' },
  { path: join('node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), type: 'file' },
])

/** Re-attest the immutable launch closure immediately before either partition. */
export async function validateFrozenEvaluationRuntime({ root, trustedUid }) {
  const runtimeRoot = resolve(root)
  for (const entry of EVALUATION_RUNTIME_ENTRIES) {
    const path = entry.path === '' ? runtimeRoot : join(runtimeRoot, entry.path)
    const stat = await lstat(path)
    const correctType = entry.type === 'directory' ? stat.isDirectory() : stat.isFile()
    if (!correctType || stat.isSymbolicLink()) {
      throw new Error(`Evaluation runtime critical ${entry.type} is invalid: ${path}`)
    }
    if (stat.uid !== trustedUid || (stat.mode & 0o222) !== 0) {
      throw new Error(`Evaluation runtime critical entry is not trusted-owned and frozen: ${path}`)
    }
  }
}

async function defaultSmokeRuntime({
  runtimeRoot,
  sourceSmokeRoot,
  nodePath,
  bwrapPath,
  setprivPath,
  solverUid,
  solverGid,
  environment,
  timeoutMs,
  signal,
  secretValues,
  executeProcess,
}) {
  const tsxEntry = pathToFileURL(
    join(SOURCE_SMOKE_SANDBOX_PATHS.runtime, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
  ).href
  const sourceEntry = join(SOURCE_SMOKE_SANDBOX_PATHS.runtime, 'apps', 'cli', 'src', 'bin.ts')
  const workspace = join(sourceSmokeRoot, 'work')
  const home = join(sourceSmokeRoot, 'home')
  const temporary = join(sourceSmokeRoot, 'tmp')
  const nodeToolchain = executableDistributionRoot(nodePath)
  const invocation = buildBubblewrapInvocation({
    invocation: {
      command: nodePath,
      args: ['--import', tsxEntry, sourceEntry, '--version'],
      cwd: workspace,
      env: {
        ...environment,
        HOME: home,
        TMPDIR: temporary,
        TSX_TSCONFIG_PATH: join(SOURCE_SMOKE_SANDBOX_PATHS.runtime, 'tsconfig.json'),
      },
    },
    uid: solverUid,
    gid: solverGid,
    bwrapPath,
    setprivPath,
    network: 'none',
    hostname: 'rsi-source-smoke',
    mounts: [
      {
        source: runtimeRoot,
        destination: SOURCE_SMOKE_SANDBOX_PATHS.runtime,
        readOnly: true,
      },
      ...(nodeToolchain === null ? [] : [{
        source: nodeToolchain,
        destination: SOURCE_SMOKE_SANDBOX_PATHS.nodeToolchain,
        readOnly: true,
      }]),
      {
        source: sourceSmokeRoot,
        destination: SOURCE_SMOKE_SANDBOX_PATHS.workspace,
        readOnly: false,
      },
    ],
  })
  return executeProcess({
    ...invocation,
    timeoutMs,
    signal,
    outputLimitBytes: 2 * 1024 * 1024,
    secretValues,
  })
}

async function defaultPrepareUpdaterTemplate({ sourcePath, destination, feedbackRoot }) {
  requireText(feedbackRoot, 'feedbackRoot')
  const source = await readFile(sourcePath, 'utf8')
  const footer = [
    '',
    'Controller-mounted validation feedback root (read-only): `{{ feedback.root }}`',
    'Use only validation summaries and traces under that root. Never request hidden-test material.',
    '',
  ].join('\n')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, `${source.trimEnd()}\n${footer}`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o400,
  })
  return destination
}

function isInfrastructureFilesystemFailure(error) {
  return new Set([
    'EACCES',
    'EBUSY',
    'EIO',
    'EMFILE',
    'ENFILE',
    'ENOMEM',
    'ENOSPC',
    'EPERM',
    'EROFS',
    'ESTALE',
    'ETIMEDOUT',
  ]).has(error?.code)
}

function candidateBuildFailure({ candidateId, level, message, exitCode = null }) {
  return {
    ok: false,
    kind: 'candidate',
    candidateId,
    level,
    message,
    exitCode,
  }
}

function validateLoopbackGateway(gateway, expectedDummyKey) {
  if (!gateway || typeof gateway.close !== 'function' || gateway.candidateApiKey !== expectedDummyKey) {
    throw new Error('gateway did not preserve the unique dummy credential')
  }
  let url
  try {
    url = new URL(gateway.url)
  } catch {
    throw new Error('gateway did not return a valid URL')
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('gateway is not loopback-only')
  }
}

function validatePartitionIds(instanceIds, expectedCount, label) {
  if (!Array.isArray(instanceIds) || instanceIds.length !== expectedCount
      || new Set(instanceIds).size !== instanceIds.length
      || instanceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new ProductionRuntimeError(
      `${label}-evaluation`,
      `${label} instanceIds must contain exactly ${expectedCount} unique IDs`,
    )
  }
  return [...instanceIds]
}

function validateSmokeIds(instanceIds) {
  if (!Array.isArray(instanceIds) || instanceIds.length < 1 || instanceIds.length > 8
      || new Set(instanceIds).size !== instanceIds.length
      || instanceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new ProductionRuntimeError(
      'smoke-evaluation',
      'smoke instanceIds must contain 1..8 unique validation IDs',
    )
  }
  return [...instanceIds]
}

function summarizeValidation(candidateId, instanceIds, records, completedAt) {
  const usage = records.reduce((total, record) => ({
    requests: total.requests + (Number.isSafeInteger(record.usage?.requests) ? record.usage.requests : 0),
    inputTokens: total.inputTokens
      + (Number.isSafeInteger(record.usage?.inputTokens) ? record.usage.inputTokens : 0),
    outputTokens: total.outputTokens
      + (Number.isSafeInteger(record.usage?.outputTokens) ? record.usage.outputTokens : 0),
    totalTokens: total.totalTokens
      + (Number.isSafeInteger(record.usage?.totalTokens) ? record.usage.totalTokens : 0),
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  return {
    summary: {
      candidateId,
      verified: records.filter((record) => record.status === 'resolved').length,
      total: instanceIds.length,
      completedAt,
      usage,
    },
    records,
    traces: {},
  }
}

/**
 * Production adapter for EvolutionOrchestrator.
 *
 * Candidate source snapshots are never dependency installation roots. Each
 * build copies source into an immutable runtime tree under runtimesRoot, while
 * every build uses the same pinned Node/pnpm pair and content-addressed store.
 */
export class PutnamEvolutionRuntime {
  constructor(options = {}) {
    const dependencies = options.dependencies ?? {}
    this.store = options.store
    if (!this.store || typeof this.store.writeValidationTrace !== 'function'
        || typeof this.store.writeValidationCheckpoint !== 'function'
        || typeof this.store.readValidationCheckpoints !== 'function') {
      throw new TypeError('store validation trace/checkpoint methods are required')
    }

    this.runtimesRoot = requireAbsolutePath(options.runtimesRoot, 'runtimesRoot')
    this.pnpmStoreRoot = requireAbsolutePath(options.pnpmStoreRoot, 'pnpmStoreRoot')
    this.buildHome = requireAbsolutePath(options.buildHome, 'buildHome')
    this.updaterRunRoot = requireAbsolutePath(options.updaterRunRoot, 'updaterRunRoot')
    this.validationScratchRoot = requireAbsolutePath(
      options.validationScratchRoot,
      'validationScratchRoot',
    )
    this.smokeScratchRoot = requireAbsolutePath(
      options.smokeScratchRoot ?? join(dirname(this.validationScratchRoot), 'smoke-scratch'),
      'smokeScratchRoot',
    )
    this.sourceSmokeRoot = requireAbsolutePath(
      options.sourceSmokeRoot ?? join(dirname(this.validationScratchRoot), 'source-smoke'),
      'sourceSmokeRoot',
    )
    for (const [leftName, left, rightName, right] of [
      ['smokeScratchRoot', this.smokeScratchRoot,
        'validationScratchRoot', this.validationScratchRoot],
      ['sourceSmokeRoot', this.sourceSmokeRoot,
        'validationScratchRoot', this.validationScratchRoot],
      ['sourceSmokeRoot', this.sourceSmokeRoot, 'smokeScratchRoot', this.smokeScratchRoot],
      ['sourceSmokeRoot', this.sourceSmokeRoot, 'runtimesRoot', this.runtimesRoot],
    ]) {
      if (isWithin(left, right) || isWithin(right, left)) {
        throw new TypeError(`${leftName} must be separate from ${rightName}`)
      }
    }
    this.solverHome = requireAbsolutePath(
      options.solverHome ?? join(this.validationScratchRoot, 'solver-home'),
      'solverHome',
    )
    this.datasetRoot = requireAbsolutePath(options.datasetRoot, 'datasetRoot')
    this.nodePath = requireAbsolutePath(options.nodePath, 'nodePath')
    this.pnpmCliPath = requireAbsolutePath(options.pnpmCliPath, 'pnpmCliPath')
    this.runtimePatch = requireAbsolutePath(options.runtimePatch, 'runtimePatch')
    this.proposalTemplatePath = requireAbsolutePath(
      options.proposalTemplatePath,
      'proposalTemplatePath',
    )
    this.applyTemplatePath = requireAbsolutePath(options.applyTemplatePath, 'applyTemplatePath')
    this.bwrapPath = requireAbsolutePath(options.bwrapPath, 'bwrapPath')
    this.setprivPath = requireAbsolutePath(options.setprivPath ?? '/usr/bin/setpriv', 'setprivPath')

    this.expectedNodeVersion = requireText(
      options.expectedNodeVersion ?? PRODUCTION_TOOLCHAIN_PIN.nodeVersion,
      'expectedNodeVersion',
    )
    this.expectedPnpmVersion = requireText(
      options.expectedPnpmVersion ?? PRODUCTION_TOOLCHAIN_PIN.pnpmVersion,
      'expectedPnpmVersion',
    )
    if (this.expectedNodeVersion !== PRODUCTION_TOOLCHAIN_PIN.nodeVersion
        || this.expectedPnpmVersion !== PRODUCTION_TOOLCHAIN_PIN.pnpmVersion) {
      throw new TypeError('production Node/pnpm versions must match PRODUCTION_TOOLCHAIN_PIN')
    }
    this.upstreamBaseUrl = requireText(options.upstreamBaseUrl, 'upstreamBaseUrl')
    let upstream
    try {
      upstream = new URL(this.upstreamBaseUrl)
    } catch {
      throw new TypeError('upstreamBaseUrl must be an HTTP(S) URL')
    }
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
      throw new TypeError('upstreamBaseUrl must be an HTTP(S) URL without credentials')
    }
    this.getApiKey = requireFunction(options.getApiKey, 'getApiKey')
    this.sealedTestRunner = requireFunction(
      options.sealedTestRunner ?? dependencies.sealedTestRunner,
      'sealedTestRunner',
    )

    this.baseEnvironment = options.baseEnvironment ?? process.env
    this.secretValues = Array.isArray(options.secretValues) ? [...options.secretValues] : []
    this.preset = requireText(options.preset ?? 'standard', 'preset')
    this.lakePath = requireText(options.lakePath ?? 'lake', 'lakePath')
    this.pythonPath = requireText(options.pythonPath ?? 'python3', 'pythonPath')
    this.feedbackRoot = options.feedbackRoot === undefined
      ? null
      : requireAbsolutePath(options.feedbackRoot, 'feedbackRoot')
    if (Object.prototype.hasOwnProperty.call(options, 'testInstanceIds')) {
      throw new TypeError('testInstanceIds belong only to the sealed child broker')
    }

    this.buildTimeoutMs = requirePositive(options.buildTimeoutMs ?? 20 * 60 * 1000, 'buildTimeoutMs')
    this.toolchainTimeoutMs = requirePositive(
      options.toolchainTimeoutMs ?? 30_000,
      'toolchainTimeoutMs',
    )
    this.smokeTimeoutMs = requirePositive(options.smokeTimeoutMs ?? 30_000, 'smokeTimeoutMs')
    this.proposalTimeoutMs = requirePositive(
      options.proposalTimeoutMs ?? 45 * 60 * 1000,
      'proposalTimeoutMs',
    )
    this.applyTimeoutMs = requirePositive(options.applyTimeoutMs ?? 45 * 60 * 1000, 'applyTimeoutMs')
    this.partitionOptions = { ...(options.partitionOptions ?? {}) }
    this.gatewayOptions = { ...(options.gatewayOptions ?? {}) }
    this.signal = options.signal
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
    this.gatewayAudit = typeof options.gatewayAudit === 'function' ? options.gatewayAudit : () => {}
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date()

    this.updaterUid = options.updaterUid
    this.updaterGid = options.updaterGid
    this.buildUid = options.buildUid
    this.buildGid = options.buildGid
    this.solverUid = options.solverUid
    this.solverGid = options.solverGid
    this.verifierUid = options.verifierUid
    this.verifierGid = options.verifierGid
    this.trustedUid = options.trustedUid ?? process.getuid?.()
    this.trustedGid = options.trustedGid ?? process.getgid?.()
    validateIdentity(this.updaterUid, this.updaterGid, 'updater')
    validateIdentity(this.buildUid, this.buildGid, 'build')
    validateIdentity(this.solverUid, this.solverGid, 'solver')
    validateIdentity(this.verifierUid, this.verifierGid, 'verifier')
    validateIdentity(this.trustedUid, this.trustedGid, 'trusted', { allowRoot: true })
    if ([this.updaterUid, this.updaterGid, this.buildUid, this.buildGid,
      this.solverUid, this.solverGid, this.verifierUid, this.verifierGid]
      .some((value) => value === undefined)) {
      throw new TypeError('production updater/build/solver/verifier uid/gid are all required')
    }
    if (new Set([this.updaterGid, this.buildGid, this.solverGid, this.verifierGid]).size !== 4) {
      throw new TypeError('updater, build, solver, and verifier must use distinct primary gid values')
    }
    if (new Set([this.updaterUid, this.buildUid, this.solverUid, this.verifierUid]).size !== 4
        || [this.updaterUid, this.buildUid, this.solverUid, this.verifierUid]
          .includes(this.trustedUid)) {
      throw new TypeError('updater, build, solver, verifier, and trusted controller must use distinct uid values')
    }

    if (options.legacyUnsafeExecution !== undefined
        && typeof options.legacyUnsafeExecution !== 'boolean') {
      throw new TypeError('legacyUnsafeExecution must be a boolean')
    }
    this.legacyUnsafeExecution = options.legacyUnsafeExecution === true

    this.executeProcess = requireFunction(
      options.executeProcess ?? dependencies.executeProcess ?? runProcess,
      'executeProcess',
    )
    this.copyRuntimeSource = requireFunction(
      options.copyRuntimeSource ?? dependencies.copyRuntimeSource ?? defaultCopyRuntimeSource,
      'copyRuntimeSource',
    )
    this.prepareOwnedDirectory = requireFunction(
      options.prepareOwnedDirectory
        ?? dependencies.prepareOwnedDirectory
        ?? defaultPrepareOwnedDirectory,
      'prepareOwnedDirectory',
    )
    this.grantBuildAccess = requireFunction(
      options.grantBuildAccess ?? dependencies.grantBuildAccess ?? defaultGrantBuildAccess,
      'grantBuildAccess',
    )
    this.validateDependencyStore = requireFunction(
      options.validateDependencyStore
        ?? dependencies.validateDependencyStore
        ?? validateImmutableDependencyStore,
      'validateDependencyStore',
    )
    this.freezeRuntimeTree = requireFunction(
      options.freezeRuntimeTree ?? dependencies.freezeRuntimeTree ?? defaultFreezeRuntimeTree,
      'freezeRuntimeTree',
    )
    this.validateRuntime = requireFunction(
      options.validateRuntime ?? dependencies.validateRuntime ?? defaultValidateRuntime,
      'validateRuntime',
    )
    this.validateFrozenRuntime = requireFunction(
      options.validateFrozenRuntime
        ?? dependencies.validateFrozenRuntime
        ?? validateFrozenEvaluationRuntime,
      'validateFrozenRuntime',
    )
    const customSmokeRuntime = options.smokeRuntime ?? dependencies.smokeRuntime
    if (customSmokeRuntime !== undefined && !this.legacyUnsafeExecution) {
      throw new TypeError('custom smokeRuntime requires legacyUnsafeExecution')
    }
    this.smokeRuntime = requireFunction(customSmokeRuntime ?? defaultSmokeRuntime, 'smokeRuntime')
    this.removePath = requireFunction(
      options.removePath
        ?? dependencies.removePath
        ?? ((path) => rm(path, { recursive: true, force: true })),
      'removePath',
    )
    this.renamePath = requireFunction(
      options.renamePath ?? dependencies.renamePath ?? rename,
      'renamePath',
    )
    this.prepareUpdaterTemplate = requireFunction(
      options.prepareUpdaterTemplate
        ?? dependencies.prepareUpdaterTemplate
        ?? defaultPrepareUpdaterTemplate,
      'prepareUpdaterTemplate',
    )
    this.startGateway = requireFunction(
      options.startGateway ?? dependencies.startGateway ?? startModelGateway,
      'startGateway',
    )
    this.acquireGatewayEgressLease = requireFunction(
      options.acquireGatewayEgressLease
        ?? dependencies.acquireGatewayEgressLease
        ?? acquireGatewayEgressLease,
      'acquireGatewayEgressLease',
    )
    const customProposalRunner = options.proposalRunner ?? dependencies.proposalRunner
    const customApplyRunner = options.applyRunner ?? dependencies.applyRunner
    if ((customProposalRunner !== undefined || customApplyRunner !== undefined)
        && !this.legacyUnsafeExecution) {
      throw new TypeError('custom updater runners require legacyUnsafeExecution')
    }
    this.proposalRunner = requireFunction(customProposalRunner ?? runProposalPhase, 'proposalRunner')
    this.applyRunner = requireFunction(customApplyRunner ?? runApplyPhase, 'applyRunner')
    this.updaterExecute = options.updaterExecute ?? dependencies.updaterExecute
    if (this.updaterExecute !== undefined) requireFunction(this.updaterExecute, 'updaterExecute')
    this.prepareDataset = requireFunction(
      options.prepareDataset
        ?? dependencies.prepareDataset
        ?? preparePutnamBenchDataset,
      'prepareDataset',
    )
    this.datasetExecute = options.datasetExecute ?? dependencies.datasetExecute
    if (this.datasetExecute !== undefined) requireFunction(this.datasetExecute, 'datasetExecute')
    this.partitionRunner = requireFunction(
      options.partitionRunner ?? dependencies.partitionRunner ?? runPartition,
      'partitionRunner',
    )
    this.dummyKeyFactory = requireFunction(
      options.dummyKeyFactory
        ?? dependencies.dummyKeyFactory
        ?? (() => `rsi-${randomBytes(24).toString('base64url')}`),
      'dummyKeyFactory',
    )

    this.baselineRuntimeRoot = join(this.runtimesRoot, 'baseline')
    this.baselineBuilt = false
    this.feedbackRoots = new Map()
    this.usedDummyKeys = new Set()
    this.updaterGatewayPoison = null
    this.infrastructurePromise = null
    this.toolchainPromise = null
    this.datasetPromise = null
  }

  async #ensureInfrastructure() {
    if (!this.infrastructurePromise) {
      this.infrastructurePromise = (async () => {
        await this.prepareOwnedDirectory({
          path: this.runtimesRoot,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        await this.validateDependencyStore({
          root: this.pnpmStoreRoot,
          trustedUid: this.trustedUid,
          buildUid: this.buildUid,
        })
        await this.prepareOwnedDirectory({
          path: this.buildHome,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        await this.prepareOwnedDirectory({
          path: this.updaterRunRoot,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        await this.prepareOwnedDirectory({
          path: this.validationScratchRoot,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        await this.prepareOwnedDirectory({
          path: this.smokeScratchRoot,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        await this.prepareOwnedDirectory({
          path: this.sourceSmokeRoot,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        await this.prepareOwnedDirectory({
          path: this.solverHome,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o555,
        })
      })().catch((error) => {
        this.infrastructurePromise = null
        throw infrastructureError('runtime-directories', 'Unable to prepare runtime directories', error)
      })
    }
    return this.infrastructurePromise
  }

  async #ensureToolchain() {
    if (!this.toolchainPromise) {
      this.toolchainPromise = (async () => {
        const environment = safeEnvironment(this.baseEnvironment, this.buildHome)
        const node = await this.executeProcess({
          command: this.nodePath,
          args: ['--version'],
          cwd: this.buildHome,
          env: environment,
          timeoutMs: this.toolchainTimeoutMs,
          signal: this.signal,
          outputLimitBytes: 1024 * 1024,
          secretValues: this.secretValues,
        })
        if (!processSucceeded(node) || String(node.stdout ?? '').trim() !== this.expectedNodeVersion) {
          throw new Error('fixed Node version does not match the production pin')
        }
        const pnpm = await this.executeProcess({
          command: this.nodePath,
          args: [this.pnpmCliPath, '--version'],
          cwd: this.buildHome,
          env: environment,
          timeoutMs: this.toolchainTimeoutMs,
          signal: this.signal,
          outputLimitBytes: 1024 * 1024,
          secretValues: this.secretValues,
        })
        if (!processSucceeded(pnpm) || String(pnpm.stdout ?? '').trim() !== this.expectedPnpmVersion) {
          throw new Error('fixed pnpm version does not match the production pin')
        }
      })().catch((error) => {
        this.toolchainPromise = null
        throw infrastructureError('toolchain-check', 'Pinned Node/pnpm toolchain is unavailable', error)
      })
    }
    return this.toolchainPromise
  }

  async buildCandidate({ candidateId, candidateRoot, level }) {
    assertCandidate(candidateId, level)
    const sourceRoot = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const runtimeRoot = join(this.runtimesRoot, candidateId)
    const temporaryRoot = join(this.runtimesRoot, `.${candidateId}.tmp-${randomUUID()}`)
    const buildRunRoot = join(this.buildHome, `${candidateId}-${randomUUID()}`)
    assertSeparated(sourceRoot, runtimeRoot)
    assertSeparated(sourceRoot, temporaryRoot)
    await this.#ensureInfrastructure()
    await this.#ensureToolchain()

    try {
      await this.removePath(temporaryRoot)
      await this.removePath(runtimeRoot)
      await this.copyRuntimeSource({ sourceRoot, destination: temporaryRoot })
      await this.grantBuildAccess({ root: temporaryRoot, uid: this.buildUid, gid: this.buildGid })
      const pnpmArguments = [
        this.pnpmCliPath,
        '--config.minimum-release-age=0',
        '--config.trust-policy=off',
        '--config.update-notifier=false',
        'install',
        '--frozen-lockfile',
        '--offline',
        '--ignore-scripts',
        '--frozen-store',
        '--trust-lockfile',
        '--store-dir',
        this.pnpmStoreRoot,
        '--package-import-method=copy',
        '--reporter=append-only',
      ]
      let result
      try {
        await this.removePath(buildRunRoot)
        for (const path of [
          buildRunRoot,
          join(buildRunRoot, 'home'),
          join(buildRunRoot, 'tmp'),
        ]) {
          await this.prepareOwnedDirectory({
            path,
            uid: this.buildUid,
            gid: this.buildGid,
            mode: 0o700,
          })
        }
        const invocation = buildBubblewrapInvocation({
          invocation: {
            command: this.nodePath,
            args: pnpmArguments,
            cwd: temporaryRoot,
            env: {
              ...safeEnvironment(this.baseEnvironment, join(buildRunRoot, 'home')),
              TMPDIR: join(buildRunRoot, 'tmp'),
            },
          },
          uid: this.buildUid,
          gid: this.buildGid,
          bwrapPath: this.bwrapPath,
          setprivPath: this.setprivPath,
          network: 'none',
          hostname: 'rsi-build',
          mounts: [
            {
              source: temporaryRoot,
              destination: BUILD_SANDBOX_PATHS.runtime,
              readOnly: false,
            },
            {
              source: this.pnpmStoreRoot,
              destination: BUILD_SANDBOX_PATHS.store,
              readOnly: true,
            },
            ...buildToolchainMounts(this.nodePath, this.pnpmCliPath),
            {
              source: buildRunRoot,
              destination: BUILD_SANDBOX_PATHS.workspace,
              readOnly: false,
            },
          ],
        })
        result = await this.executeProcess({
          ...invocation,
          timeoutMs: this.buildTimeoutMs,
          signal: this.signal,
          outputLimitBytes: 16 * 1024 * 1024,
          secretValues: this.secretValues,
        })
      } finally {
        await this.removePath(buildRunRoot).catch(() => {})
      }
      if (processOperationalFailure(result)) {
        throw new Error('dependency installation timed out, aborted, or exceeded output limits')
      }
      if (!processSucceeded(result)) {
        await this.removePath(temporaryRoot)
        return candidateBuildFailure({
          candidateId,
          level,
          message: 'Candidate dependency installation failed',
          exitCode: processExitCode(result),
        })
      }
      try {
        await this.validateRuntime(temporaryRoot)
      } catch (error) {
        if (error instanceof ProductionRuntimeError || isInfrastructureFilesystemFailure(error)) {
          throw error
        }
        await this.removePath(temporaryRoot)
        return candidateBuildFailure({
          candidateId,
          level,
          message: 'Candidate runtime is missing required source or dependencies',
        })
      }
      await this.freezeRuntimeTree({
        root: temporaryRoot,
        uid: this.trustedUid,
        gid: this.trustedGid,
      })
      const sourceSmokeRunRoot = join(
        this.sourceSmokeRoot,
        `${candidateId}-${randomUUID()}`,
      )
      let smoke
      try {
        await this.removePath(sourceSmokeRunRoot)
        for (const path of [
          sourceSmokeRunRoot,
          join(sourceSmokeRunRoot, 'work'),
          join(sourceSmokeRunRoot, 'home'),
          join(sourceSmokeRunRoot, 'tmp'),
        ]) {
          await this.prepareOwnedDirectory({
            path,
            uid: this.solverUid,
            gid: this.solverGid,
            mode: 0o700,
          })
        }
        smoke = await this.smokeRuntime({
          runtimeRoot: temporaryRoot,
          sourceSmokeRoot: sourceSmokeRunRoot,
          nodePath: this.nodePath,
          bwrapPath: this.bwrapPath,
          setprivPath: this.setprivPath,
          solverUid: this.solverUid,
          solverGid: this.solverGid,
          environment: safeEnvironment(this.baseEnvironment, this.solverHome),
          timeoutMs: this.smokeTimeoutMs,
          signal: this.signal,
          secretValues: this.secretValues,
          executeProcess: this.executeProcess,
        })
      } finally {
        await this.removePath(sourceSmokeRunRoot).catch(() => {})
      }
      if (processOperationalFailure(smoke)) {
        throw new Error('candidate source launch timed out, aborted, or exceeded output limits')
      }
      if (!processSucceeded(smoke)) {
        await this.removePath(temporaryRoot)
        return candidateBuildFailure({
          candidateId,
          level,
          message: 'Candidate source launch smoke failed',
          exitCode: processExitCode(smoke),
        })
      }
      await this.renamePath(temporaryRoot, runtimeRoot)
      if (level === 'baseline') {
        this.baselineRuntimeRoot = runtimeRoot
        this.baselineBuilt = true
      }
      return {
        ok: true,
        candidateId,
        level,
        runtimeRoot,
        nodeVersion: this.expectedNodeVersion,
        pnpmVersion: this.expectedPnpmVersion,
      }
    } catch (error) {
      await this.removePath(temporaryRoot).catch(() => {})
      throw infrastructureError('candidate-build', 'Candidate runtime build infrastructure failure', error)
    }
  }

  #templateValues({
    campaignId,
    candidateId,
    parentId,
    level,
    candidateRoot,
    proposalId,
    createdAt,
    proposal,
    feedbackRoot,
  }) {
    return {
      campaign: { id: campaignId },
      candidate: { id: candidateId, parentId, root: candidateRoot },
      mutation: {
        level,
        writablePaths: DEEPSEEK_HARNESS_MUTATION_POLICY.levels[level],
        readOnlyPaths: DEEPSEEK_HARNESS_MUTATION_POLICY.alwaysReadOnly,
      },
      proposal: {
        id: proposalId ?? proposal?.proposalId,
        createdAt: createdAt ?? proposal?.createdAt,
        json: proposal === undefined ? null : JSON.stringify(proposal, null, 2),
      },
      feedback: { root: feedbackRoot },
      feedbackRoot,
    }
  }

  #nextDummyKey() {
    const key = this.dummyKeyFactory()
    if (typeof key !== 'string' || key.length < 8 || /[\r\n]/u.test(key)
        || this.usedDummyKeys.has(key)) {
      throw new ProductionRuntimeError(
        'model-gateway',
        'Unable to allocate a unique gateway dummy credential',
      )
    }
    this.usedDummyKeys.add(key)
    return key
  }

  async #withGateway(operation, candidateId, callback) {
    if (this.updaterGatewayPoison) {
      throw infrastructureError(
        operation,
        'Updater gateway UID is quarantined after an unconfirmed firewall cleanup',
        this.updaterGatewayPoison,
      )
    }
    const dummyKey = this.#nextDummyKey()
    let gateway
    let gatewayLease
    let latestAudit = null
    try {
      gateway = await this.startGateway({
        ...this.gatewayOptions,
        host: '127.0.0.1',
        upstreamBaseUrl: this.upstreamBaseUrl,
        getApiKey: this.getApiKey,
        candidateApiKey: dummyKey,
        maxOutputTokens: 32_768,
        audit: (record) => {
          latestAudit = record === null || typeof record !== 'object'
            ? null
            : { ...record }
          return this.gatewayAudit({ operation, candidateId, ...record })
        },
      })
      validateLoopbackGateway(gateway, dummyKey)
      // startModelGateway is lazy: it does not load or send the upstream
      // credential until an authenticated downstream request arrives. Install
      // the exact UID/port allow rule before the Updater can make that request.
      gatewayLease = await this.acquireGatewayEgressLease({
        gatewayUrl: gateway.url,
        uid: this.updaterUid,
      })
      if (!gatewayLease || typeof gatewayLease.release !== 'function') {
        const error = new Error('gateway egress lease is invalid')
        error.fatal = true
        throw error
      }
    } catch (error) {
      if (error?.fatal === true) this.updaterGatewayPoison = error
      if (gateway?.close) await gateway.close().catch(() => {})
      throw infrastructureError(
        operation,
        'Unable to start and lease a private model gateway',
        error,
      )
    }
    try {
      return await callback(gateway, dummyKey)
    } catch (error) {
      if (error?.kind === 'infrastructure') {
        throw infrastructureError(operation, 'Updater infrastructure phase failed', error)
      }
      if (isProviderInfrastructureAudit(latestAudit)) {
        throw infrastructureError(
          operation,
          'Updater failed after a terminal provider or credential response',
          error,
        )
      }
      throw error
    } finally {
      let leaseError
      try {
        await gatewayLease.release()
      } catch (error) {
        // A possibly-live allow rule is a sticky fatal condition: do not let a
        // later ephemeral gateway reuse its port under this Updater UID.
        this.updaterGatewayPoison = error
        leaseError = infrastructureError(
          operation,
          'Unable to confirm removal of the model gateway egress lease',
          error,
        )
      }
      let closeError
      try {
        await gateway.close()
      } catch (error) {
        closeError = infrastructureError(operation, 'Unable to close model gateway', error)
      }
      if (leaseError) throw leaseError
      if (closeError) throw closeError
    }
  }

  async #prepareUpdaterRun({ candidateId, phase, feedbackRoot }) {
    await this.#ensureInfrastructure()
    try {
      await this.validateRuntime(this.baselineRuntimeRoot)
    } catch (error) {
      throw infrastructureError('updater-runtime', 'Frozen baseline runtime is unavailable', error)
    }
    const runRoot = join(this.updaterRunRoot, `${candidateId}-${phase}-${randomUUID()}`)
    await this.prepareOwnedDirectory({
      path: runRoot,
      uid: this.updaterUid,
      gid: this.updaterGid,
      mode: 0o700,
    })
    const home = join(runRoot, 'home')
    for (const path of [home, join(runRoot, 'tmp')]) {
      await this.prepareOwnedDirectory({
        path,
        uid: this.updaterUid,
        gid: this.updaterGid,
        mode: 0o700,
      })
    }
    const sourcePath = phase === 'proposal' ? this.proposalTemplatePath : this.applyTemplatePath
    const templatePath = join(runRoot, `${phase}.prompt.md`)
    await this.prepareUpdaterTemplate({ sourcePath, destination: templatePath, feedbackRoot })
    return { runRoot, home, templatePath }
  }

  #updaterInvocation({ candidateRoot, feedbackRoot, runRoot, home, gateway, dummyKey }) {
    return {
      nodeBinary: this.nodePath,
      updaterRuntime: this.baselineRuntimeRoot,
      candidateRoot,
      runRoot,
      runtimePatch: this.runtimePatch,
      feedbackRoot,
      gatewayUrl: gateway.url,
      gatewayDummyKey: dummyKey,
      uid: this.updaterUid,
      gid: this.updaterGid,
      bwrapPath: this.bwrapPath,
      setprivPath: this.setprivPath,
      legacy: this.legacyUnsafeExecution,
      baseEnv: safeEnvironment(this.baseEnvironment, home),
    }
  }

  async propose({
    campaignId,
    candidateId,
    parentId,
    level,
    candidateRoot,
    feedbackRoot,
    proposalId,
    createdAt,
  }) {
    assertCandidate(candidateId, level)
    const candidate = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const feedback = requireAbsolutePath(feedbackRoot, 'feedbackRoot')
    this.feedbackRoots.set(candidateId, feedback)
    const run = await this.#prepareUpdaterRun({ candidateId, phase: 'proposal', feedbackRoot: feedback })
    return this.#withGateway('updater-proposal', candidateId, async (gateway, dummyKey) => {
      const result = await this.proposalRunner({
        templatePath: run.templatePath,
        templateValues: this.#templateValues({
          campaignId,
          candidateId,
          parentId,
          level,
          candidateRoot: candidate,
          proposalId,
          createdAt,
          feedbackRoot: feedback,
        }),
        invocationOptions: this.#updaterInvocation({
          candidateRoot: candidate,
          feedbackRoot: feedback,
          runRoot: run.runRoot,
          home: run.home,
          gateway,
          dummyKey,
        }),
        timeoutMs: this.proposalTimeoutMs,
        signal: this.signal,
        execute: this.updaterExecute,
      })
      return result.proposal
    })
  }

  async apply({ campaignId, candidateId, parentId, level, candidateRoot, proposal }) {
    assertCandidate(candidateId, level)
    const candidate = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const feedback = this.feedbackRoots.get(candidateId) ?? this.feedbackRoot
    if (!feedback) {
      throw new ProductionRuntimeError(
        'updater-apply',
        'feedbackRoot is required to resume an apply phase',
      )
    }
    const run = await this.#prepareUpdaterRun({ candidateId, phase: 'apply', feedbackRoot: feedback })
    return this.#withGateway('updater-apply', candidateId, async (gateway, dummyKey) => {
      const result = await this.applyRunner({
        templatePath: run.templatePath,
        templateValues: this.#templateValues({
          campaignId,
          candidateId,
          parentId,
          level,
          candidateRoot: candidate,
          proposal,
          feedbackRoot: feedback,
        }),
        invocationOptions: this.#updaterInvocation({
          candidateRoot: candidate,
          feedbackRoot: feedback,
          runRoot: run.runRoot,
          home: run.home,
          gateway,
          dummyKey,
        }),
        timeoutMs: this.applyTimeoutMs,
        signal: this.signal,
        execute: this.updaterExecute,
      })
      return result.report
    })
  }

  async #preparedDataset() {
    if (!this.datasetPromise) {
      this.datasetPromise = this.prepareDataset({
        datasetRoot: this.datasetRoot,
        pythonPath: this.pythonPath,
        signal: this.signal,
        ...(this.datasetExecute === undefined ? {} : { execute: this.datasetExecute }),
      }).catch((error) => {
        this.datasetPromise = null
        throw infrastructureError('dataset-prepare', 'Unable to prepare pinned PutnamBench dataset', error)
      })
    }
    return this.datasetPromise
  }

  async #evaluationRuntime(candidateRoot) {
    const runtimeRoot = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const rel = relative(this.runtimesRoot, runtimeRoot)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)
        || rel.includes(sep) || !CANDIDATE_ID_PATTERN.test(rel)) {
      throw new Error('Evaluation runtime must be a legal direct child of runtimesRoot')
    }
    await this.validateFrozenRuntime({
      root: runtimeRoot,
      trustedUid: this.trustedUid,
    })
    await this.validateRuntime(runtimeRoot)
    return runtimeRoot
  }

  async #baselineForSmoke(sourceRoot) {
    await this.#ensureInfrastructure()
    if (!this.baselineBuilt) {
      try {
        await this.validateRuntime(this.baselineRuntimeRoot)
        this.baselineBuilt = true
      } catch (error) {
        if (error instanceof ProductionRuntimeError || isInfrastructureFilesystemFailure(error)) {
          throw infrastructureError(
            'smoke-baseline',
            'Unable to inspect the frozen baseline runtime',
            error,
          )
        }
      }
    }
    if (!this.baselineBuilt) {
      const build = await this.buildCandidate({
        candidateId: 'baseline',
        candidateRoot: sourceRoot,
        level: 'baseline',
      })
      if (!build.ok) {
        const error = new Error(build.message ?? 'Baseline source failed the smoke build')
        error.name = 'SmokeCandidateBuildError'
        error.kind = 'candidate'
        throw error
      }
    }
    return this.baselineRuntimeRoot
  }

  /**
   * Run a small, caller-selected validation-only preflight through the real
   * Harness/model-gateway/Lean path. This method never loads the sealed test
   * manifest and never writes campaign validation checkpoints.
   */
  async smoke({ candidateRoot, instanceIds }) {
    const sourceRoot = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const ids = validateSmokeIds(instanceIds)
    try {
      const runtimeRoot = await this.#baselineForSmoke(sourceRoot)
      const dataset = await this.#preparedDataset()
      const result = await this.partitionRunner({
        ...this.partitionOptions,
        candidateId: 'baseline-smoke',
        instanceIds: ids,
        candidateRoot: runtimeRoot,
        solutionsRoot: dataset.solutionsRoot,
        leanRoot: dataset.leanRoot,
        scratchRoot: this.smokeScratchRoot,
        nodePath: this.nodePath,
        lakePath: this.lakePath,
        patchPath: this.runtimePatch,
        upstreamBaseUrl: this.upstreamBaseUrl,
        getApiKey: this.getApiKey,
        baseEnvironment: safeEnvironment(this.baseEnvironment, this.solverHome),
        preset: this.preset,
        solverUid: this.solverUid,
        solverGid: this.solverGid,
        verifierUid: this.verifierUid,
        verifierGid: this.verifierGid,
        bwrapPath: this.bwrapPath,
        setprivPath: this.setprivPath,
        sealed: false,
        signal: this.signal,
        onProgress: (event) => this.onProgress({ ...event, smoke: true }),
        onTrace: ({ problemId, taskId }) => `smoke://${taskId ?? problemId}`,
        onRecord: async () => {},
      })
      return {
        summary: structuredClone(result.summary),
        records: structuredClone(result.records),
        traces: {},
      }
    } catch (error) {
      if (error?.kind === 'candidate') throw error
      throw infrastructureError('smoke-evaluation', 'Smoke preflight failed', error)
    }
  }

  async evaluateValidation({ candidateId, candidateRoot, instanceIds }) {
    const ids = validatePartitionIds(instanceIds, 500, 'validation')
    try {
      const runtimeRoot = await this.#evaluationRuntime(candidateRoot)
      const allowedIds = new Set(ids)
      const checkpointRecords = await this.store.readValidationCheckpoints(candidateId)
      if (!Array.isArray(checkpointRecords)) throw new Error('validation checkpoints must be an array')
      const recordsById = new Map()
      for (const record of checkpointRecords) {
        if (!record || typeof record !== 'object' || record.status === 'error') continue
        if (!allowedIds.has(record.instanceId)) {
          throw new Error('validation checkpoint is outside the frozen manifest')
        }
        if (recordsById.has(record.instanceId)) throw new Error('duplicate validation checkpoint')
        recordsById.set(record.instanceId, record)
      }
      const remainingIds = ids.filter((id) => !recordsById.has(id))
      if (remainingIds.length > 0) {
        const dataset = await this.#preparedDataset()
        const freshById = new Map()
        const remainingIdSet = new Set(remainingIds)
        const result = await this.partitionRunner({
          ...this.partitionOptions,
          candidateId,
          instanceIds: remainingIds,
          candidateRoot: runtimeRoot,
          solutionsRoot: dataset.solutionsRoot,
          leanRoot: dataset.leanRoot,
          scratchRoot: this.validationScratchRoot,
          nodePath: this.nodePath,
          lakePath: this.lakePath,
          patchPath: this.runtimePatch,
          upstreamBaseUrl: this.upstreamBaseUrl,
          getApiKey: this.getApiKey,
          baseEnvironment: safeEnvironment(this.baseEnvironment, this.solverHome),
          preset: this.preset,
          solverUid: this.solverUid,
          solverGid: this.solverGid,
          verifierUid: this.verifierUid,
          verifierGid: this.verifierGid,
          bwrapPath: this.bwrapPath,
          setprivPath: this.setprivPath,
          sealed: false,
          signal: this.signal,
          onProgress: (event) => this.onProgress({
            ...event,
            completed: recordsById.size + (event.completed ?? 0),
            total: ids.length,
          }),
          onTrace: ({ taskId, text }) => this.store.writeValidationTrace(
            candidateId,
            taskId,
            text,
            this.secretValues,
          ),
          onRecord: async (record) => {
            if (record?.status === 'error' || record?.failureKind === 'cancelled') return
            if (!remainingIdSet.has(record?.instanceId)) {
              throw new Error('partition emitted a checkpoint outside the remaining manifest')
            }
            if (freshById.has(record.instanceId)) {
              throw new Error('partition emitted a duplicate validation checkpoint')
            }
            await this.store.writeValidationCheckpoint(candidateId, record, this.secretValues)
            freshById.set(record.instanceId, record)
          },
        })
        if (!Array.isArray(result?.records)) throw new Error('partition records must be an array')
        const returnedIds = new Set()
        for (const record of result?.records ?? []) {
          if (record?.status === 'error' || record?.failureKind === 'cancelled') continue
          if (!remainingIdSet.has(record.instanceId)) {
            throw new Error('partition returned a record outside the remaining manifest')
          }
          if (returnedIds.has(record.instanceId)) {
            throw new Error('partition returned duplicate validation records')
          }
          returnedIds.add(record.instanceId)
          if (!freshById.has(record.instanceId)) {
            await this.store.writeValidationCheckpoint(candidateId, record, this.secretValues)
            freshById.set(record.instanceId, record)
          }
        }
        for (const id of remainingIds) {
          const record = freshById.get(id)
          if (!record) throw new Error('partition did not return every remaining validation record')
          recordsById.set(id, record)
        }
      }
      const records = ids.map((id) => recordsById.get(id))
      if (records.some((record) => !record)) throw new Error('validation checkpoint merge is incomplete')
      return summarizeValidation(
        candidateId,
        ids,
        records,
        this.clock().toISOString(),
      )
    } catch (error) {
      throw infrastructureError(
        'validation-evaluation',
        'Validation partition infrastructure failure',
        error,
      )
    }
  }

  async evaluateTest({ candidateId, candidateRoot }) {
    // Test IDs and their digest live only inside the sealed child broker. The
    // main Controller passes candidate identity/root and receives an opaque
    // receipt; it never validates, stores, or forwards the hidden manifest.
    try {
      const runtimeRoot = await this.#evaluationRuntime(candidateRoot)
      const receipt = await this.sealedTestRunner({
        candidateId,
        candidateRoot: runtimeRoot,
      })
      return assertOpaqueTestReceipt(receipt, candidateId)
    } catch (error) {
      throw infrastructureError('sealed-test-evaluation', 'Sealed test runner failed', error)
    }
  }
}
