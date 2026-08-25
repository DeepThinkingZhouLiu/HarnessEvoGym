import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertOpaqueTestReceipt } from './campaign.mjs'
import { isProviderInfrastructureAudit, startModelGateway } from './model-gateway.mjs'
import { MODEL_GATEWAY_RELAY_URL } from './model-gateway-relay.mjs'
import { DEEPSEEK_HARNESS_MUTATION_POLICY } from './mutation.mjs'
import { runPartition } from './partition-runner.mjs'
import { preparePutnamBenchDataset } from './putnambench-runner.mjs'
import {
  acquireGatewayEgressLease,
  buildBubblewrapInvocation,
  executableDistributionRoot,
} from './sandbox.mjs'
import { runProcess } from './subprocess.mjs'
import {
  runMutationPhase,
  UPDATER_SANDBOX_PATHS,
} from './updater-runner.mjs'

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
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const LEVELS = new Set(['baseline', 'l1', 'l2', 'l3'])
const RUNTIME_CACHE_ATTESTATION = '.harness-rsi-runtime-cache-v1.json'
const RUNTIME_CACHE_SCHEMA_VERSION = 1
const RUNTIME_BUILD_RECIPE_VERSION = 'dsh-offline-copy-host-typert-v1'
const SLIM_HOT_PATCH_EXTENSIONS = new Set([
  '.cjs', '.js', '.json', '.jsx', '.md', '.mjs', '.ts', '.tsx', '.yaml', '.yml',
])

function runtimeBuildCacheDescriptor({
  candidateDigest,
  benchmark,
  nodeVersion,
  pnpmVersion,
  platform = process.platform,
  architecture = process.arch,
}) {
  if (typeof candidateDigest !== 'string' || !SHA256_PATTERN.test(candidateDigest)) {
    throw new TypeError('candidateDigest must be a lowercase SHA-256 digest')
  }
  if (!['putnambench-lean', 'hle-text-math'].includes(benchmark)) {
    throw new TypeError('benchmark must be putnambench-lean or hle-text-math')
  }
  return Object.freeze({
    schemaVersion: RUNTIME_CACHE_SCHEMA_VERSION,
    recipeVersion: RUNTIME_BUILD_RECIPE_VERSION,
    candidateDigest,
    benchmark,
    nodeVersion: requireText(nodeVersion, 'nodeVersion'),
    pnpmVersion: requireText(pnpmVersion, 'pnpmVersion'),
    platform: requireText(platform, 'platform'),
    architecture: requireText(architecture, 'architecture'),
  })
}

export function runtimeBuildCacheKey(options) {
  const descriptor = runtimeBuildCacheDescriptor(options)
  return createHash('sha256')
    .update('harness-rsi-runtime-build-cache-v1\0')
    .update(JSON.stringify(descriptor))
    .digest('hex')
}

export function runtimeBuildCacheAttestation(options) {
  const descriptor = runtimeBuildCacheDescriptor(options)
  return Object.freeze({
    ...descriptor,
    cacheKey: runtimeBuildCacheKey(descriptor),
  })
}

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

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= values.length) return
      output[index] = await mapper(values[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

async function walkTree(root, visit) {
  // NAS metadata round-trips dominate a sequential lstat walk. Traverse one
  // breadth layer at a time with a fixed cap: deterministic child ordering is
  // preserved, while no unbounded Promise fan-out can overload the filer.
  let frontier = [root]
  while (frontier.length > 0) {
    const children = await mapWithConcurrency(frontier, 64, async (path) => {
      const stat = await lstat(path)
      await visit(path, stat)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return []
      const entries = await readdir(path, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      return entries.map((entry) => join(path, entry.name))
    })
    frontier = children.flat()
  }
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
    requireRegularFile(
      join(runtimeRoot, 'packages', 'interaction', 'commands', 'lib', 'typert.host.js'),
      'commands host typert artifact',
    ),
    requireRegularFile(
      join(runtimeRoot, 'packages', 'goal', 'goal', 'lib', 'typert.host.js'),
      'goal host typert artifact',
    ),
  ])
}

const EVALUATION_RUNTIME_ENTRIES = Object.freeze([
  { path: '', type: 'directory' },
  { path: 'apps', type: 'directory' },
  { path: join('apps', 'cli'), type: 'directory' },
  { path: join('apps', 'cli', 'src'), type: 'directory' },
  { path: join('apps', 'cli', 'src', 'bin.ts'), type: 'file' },
  { path: 'packages', type: 'directory' },
  { path: join('packages', 'interaction'), type: 'directory' },
  { path: join('packages', 'interaction', 'commands'), type: 'directory' },
  { path: join('packages', 'interaction', 'commands', 'lib'), type: 'directory' },
  {
    path: join('packages', 'interaction', 'commands', 'lib', 'typert.host.js'),
    type: 'file',
  },
  { path: join('packages', 'goal'), type: 'directory' },
  { path: join('packages', 'goal', 'goal'), type: 'directory' },
  { path: join('packages', 'goal', 'goal', 'lib'), type: 'directory' },
  { path: join('packages', 'goal', 'goal', 'lib', 'typert.host.js'), type: 'file' },
  { path: 'node_modules', type: 'directory' },
  {
    path: join('node_modules', 'tsx'),
    type: 'directory',
    allowInternalDirectorySymlink: true,
  },
  { path: join('node_modules', 'tsx', 'dist'), type: 'directory' },
  { path: join('node_modules', 'tsx', 'dist', 'esm'), type: 'directory' },
  { path: join('node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), type: 'file' },
])

async function validateInternalDirectorySymlink({ path, runtimeRoot, trustedUid }) {
  const target = await readlink(path)
  if (isAbsolute(target)) {
    throw new Error(`Evaluation runtime critical symlink must be relative: ${path}`)
  }
  if (target.split(sep).some((component) => (
    component === '' || component === '.' || component === '..'
  ))) {
    throw new Error(`Evaluation runtime critical symlink target must be normalized: ${path}`)
  }
  const targetPath = resolve(dirname(path), target)
  if (targetPath === runtimeRoot || !isWithin(runtimeRoot, targetPath)) {
    throw new Error(`Evaluation runtime critical symlink must stay within the runtime: ${path}`)
  }

  // pnpm exposes workspace packages through relative links into node_modules/.pnpm.
  // The link inode can remain build-owned because replacing it requires write
  // permission on its already-attested parent. Its complete lexical target chain,
  // however, must consist only of trusted-owned, frozen real directories. This
  // rejects dangling links, link chains, and any writable redirection point.
  let current = runtimeRoot
  for (const component of relative(runtimeRoot, targetPath).split(sep)) {
    current = join(current, component)
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      throw new Error(`Evaluation runtime critical symlink target is invalid: ${path}`, {
        cause: error,
      })
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Evaluation runtime critical symlink target chain is invalid: ${path}`)
    }
    if (stat.uid !== trustedUid || (stat.mode & 0o222) !== 0) {
      throw new Error(
        `Evaluation runtime critical symlink target is not trusted-owned and frozen: ${path}`,
      )
    }
  }
}

/** Re-attest the immutable launch closure immediately before either partition. */
export async function validateFrozenEvaluationRuntime({ root, trustedUid }) {
  const runtimeRoot = resolve(root)
  for (const entry of EVALUATION_RUNTIME_ENTRIES) {
    const path = entry.path === '' ? runtimeRoot : join(runtimeRoot, entry.path)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      if (entry.allowInternalDirectorySymlink !== true || entry.type !== 'directory') {
        throw new Error(`Evaluation runtime critical ${entry.type} is invalid: ${path}`)
      }
      await validateInternalDirectorySymlink({ path, runtimeRoot, trustedUid })
      continue
    }
    const correctType = entry.type === 'directory' ? stat.isDirectory() : stat.isFile()
    if (!correctType) {
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
  procMode = 'mounted',
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
    procMode,
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

async function defaultPrepareUpdaterTemplate({ sourcePath, destination }) {
  const source = await readFile(sourcePath, 'utf8')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, `${source.trimEnd()}\n`, {
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
    this.runtimeCacheRoot = options.runtimeCacheRoot === undefined
      ? null
      : requireAbsolutePath(options.runtimeCacheRoot, 'runtimeCacheRoot')
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
      ...(this.runtimeCacheRoot === null ? [] : [
        ['runtimeCacheRoot', this.runtimeCacheRoot, 'runtimesRoot', this.runtimesRoot],
        ['runtimeCacheRoot', this.runtimeCacheRoot, 'sourceSmokeRoot', this.sourceSmokeRoot],
        ['runtimeCacheRoot', this.runtimeCacheRoot,
          'validationScratchRoot', this.validationScratchRoot],
      ]),
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
    this.benchmark = requireText(options.benchmark ?? 'putnambench-lean', 'benchmark')
    if (!['putnambench-lean', 'hle-text-math'].includes(this.benchmark)) {
      throw new TypeError('benchmark must be putnambench-lean or hle-text-math')
    }
    this.validationExpectedCount = options.validationExpectedCount ?? 500
    if (!Number.isSafeInteger(this.validationExpectedCount)
        || this.validationExpectedCount < 1 || this.validationExpectedCount > 10_000) {
      throw new TypeError('validationExpectedCount must be 1..10000')
    }
    this.nodePath = requireAbsolutePath(options.nodePath, 'nodePath')
    this.pnpmCliPath = requireAbsolutePath(options.pnpmCliPath, 'pnpmCliPath')
    this.runtimePatch = requireAbsolutePath(options.runtimePatch, 'runtimePatch')
    this.mutationTemplatePath = requireAbsolutePath(
      options.mutationTemplatePath,
      'mutationTemplatePath',
    )
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
    this.preset = requireText(
      options.preset ?? (this.benchmark === 'hle-text-math' ? 'minimal' : 'standard'),
      'preset',
    )
    this.model = requireText(options.model ?? 'gpt-5.6-sol', 'model')
    this.reasoningEffort = requireText(options.reasoningEffort ?? 'max', 'reasoningEffort')
    this.updaterBackend = requireText(
      options.updaterBackend ?? 'deepseek-harness',
      'updaterBackend',
    )
    this.updaterProvider = requireText(options.updaterProvider ?? 'gateway', 'updaterProvider')
    this.updaterModel = requireText(options.updaterModel ?? this.model, 'updaterModel')
    this.updaterReasoningEffort = requireText(
      options.updaterReasoningEffort ?? this.reasoningEffort,
      'updaterReasoningEffort',
    )
    this.codexPath = options.codexPath === undefined
      ? undefined
      : requireAbsolutePath(options.codexPath, 'codexPath')
    this.lakePath = requireText(options.lakePath ?? 'lake', 'lakePath')
    this.pythonPath = requireText(options.pythonPath ?? 'python3', 'pythonPath')
    if (Object.prototype.hasOwnProperty.call(options, 'testInstanceIds')) {
      throw new TypeError('testInstanceIds belong only to the sealed child broker')
    }

    this.buildTimeoutMs = requirePositive(options.buildTimeoutMs ?? 20 * 60 * 1000, 'buildTimeoutMs')
    this.toolchainTimeoutMs = requirePositive(
      options.toolchainTimeoutMs ?? 30_000,
      'toolchainTimeoutMs',
    )
    this.smokeTimeoutMs = requirePositive(options.smokeTimeoutMs ?? 30_000, 'smokeTimeoutMs')
    this.mutationTimeoutMs = requirePositive(
      options.mutationTimeoutMs ?? 45 * 60 * 1000,
      'mutationTimeoutMs',
    )
    this.partitionOptions = { ...(options.partitionOptions ?? {}) }
    this.gatewayOptions = { ...(options.gatewayOptions ?? {}) }
    this.signal = options.signal
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
    this.coordinationContextProvider = requireFunction(
      options.coordinationContextProvider ?? (() => ({
        promptPrefix: '',
        promptSuffix: '',
        peerLogs: [],
      })),
      'coordinationContextProvider',
    )
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
    if (options.slimSingleBranch !== undefined
        && typeof options.slimSingleBranch !== 'boolean') {
      throw new TypeError('slimSingleBranch must be a boolean')
    }
    this.slimSingleBranch = options.slimSingleBranch === true

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
    const customMutationRunner = options.mutationRunner ?? dependencies.mutationRunner
    if (customMutationRunner !== undefined && !this.legacyUnsafeExecution) {
      throw new TypeError('custom mutationRunner requires legacyUnsafeExecution')
    }
    this.mutationRunner = requireFunction(
      customMutationRunner ?? runMutationPhase,
      'mutationRunner',
    )
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
    this.usedDummyKeys = new Set()
    this.validatedRuntimeRoots = new Set()
    this.updaterGatewayPoison = null
    this.runtimeRootsPromise = null
    this.infrastructurePromise = null
    this.toolchainPromise = null
    this.datasetPromise = null
  }

  async #ensureRuntimeRoots() {
    if (!this.runtimeRootsPromise) {
      this.runtimeRootsPromise = (async () => {
        await this.prepareOwnedDirectory({
          path: this.runtimesRoot,
          uid: this.trustedUid,
          gid: this.trustedGid,
          mode: 0o711,
        })
        if (this.runtimeCacheRoot !== null) {
          await this.prepareOwnedDirectory({
            path: this.runtimeCacheRoot,
            uid: this.trustedUid,
            gid: this.trustedGid,
            mode: 0o711,
          })
        }
      })().catch((error) => {
        this.runtimeRootsPromise = null
        throw infrastructureError('runtime-roots', 'Unable to prepare runtime roots', error)
      })
    }
    return this.runtimeRootsPromise
  }

  async #ensureInfrastructure() {
    if (!this.infrastructurePromise) {
      this.infrastructurePromise = (async () => {
        await this.#ensureRuntimeRoots()
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

  #cacheAttestation(candidateDigest) {
    return runtimeBuildCacheAttestation({
      candidateDigest,
      benchmark: this.benchmark,
      nodeVersion: this.expectedNodeVersion,
      pnpmVersion: this.expectedPnpmVersion,
    })
  }

  #cacheEntry(attestation) {
    if (this.runtimeCacheRoot === null) return null
    return join(this.runtimeCacheRoot, attestation.cacheKey)
  }

  async #validateCacheEntry(cacheEntry, expectedAttestation = null) {
    if (this.runtimeCacheRoot === null) throw new Error('Runtime cache is disabled')
    const rel = relative(this.runtimeCacheRoot, cacheEntry)
    if (!SHA256_PATTERN.test(rel) || rel.includes(sep)) {
      throw new Error('Runtime cache entry must be a direct content-addressed child')
    }
    const metadataPath = join(cacheEntry, RUNTIME_CACHE_ATTESTATION)
    const metadataStat = await lstat(metadataPath)
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()
        || metadataStat.uid !== this.trustedUid || (metadataStat.mode & 0o222) !== 0
        || metadataStat.size < 2 || metadataStat.size > 4096) {
      throw new Error('Runtime cache attestation is not a trusted frozen file')
    }
    let actual
    try {
      actual = JSON.parse(await readFile(metadataPath, 'utf8'))
    } catch (error) {
      throw new Error('Runtime cache attestation is invalid JSON', { cause: error })
    }
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      throw new Error('Runtime cache attestation is invalid')
    }
    const reconstructed = this.#cacheAttestation(actual.candidateDigest)
    const expectedKeys = Object.keys(reconstructed).sort()
    const actualKeys = Object.keys(actual).sort()
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
        || expectedKeys.some((key) => actual[key] !== reconstructed[key])
        || actual.cacheKey !== rel
        || (expectedAttestation !== null
          && expectedKeys.some((key) => actual[key] !== expectedAttestation[key]))) {
      throw new Error('Runtime cache attestation does not match the frozen build inputs')
    }
    await this.validateFrozenRuntime({ root: cacheEntry, trustedUid: this.trustedUid })
    await this.validateRuntime(cacheEntry)
    this.validatedRuntimeRoots.add(cacheEntry)
    return reconstructed
  }

  async #trySlimSingleBranchBuild({
    candidateId,
    sourceRoot,
    runtimeRoot,
    temporaryRoot,
    level,
    candidateDigest,
  }) {
    if (!this.slimSingleBranch || level === 'baseline' || !this.baselineBuilt) return null
    const mutation = await this.store.readMutationArtifactIfExists(candidateId)
    const changes = mutation?.changes
    if (mutation?.outcome !== 'completed' || mutation.digest !== candidateDigest
        || !Array.isArray(changes) || changes.length === 0
        || changes.some((change) => change?.kind !== 'modified'
          || typeof change.path !== 'string')) {
      return null
    }
    const buildSensitive = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/u
    if (changes.some(({ path }) => {
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
      return buildSensitive.test(path) || !SLIM_HOT_PATCH_EXTENSIONS.has(extension)
    })) return null

    const baselineCache = await realpath(this.baselineRuntimeRoot)
    if (this.runtimeCacheRoot === null) return null
    const baselineRel = relative(this.runtimeCacheRoot, baselineCache)
    if (!SHA256_PATTERN.test(baselineRel) || baselineRel.includes(sep)) {
      throw new Error('Slim build baseline must resolve to a content-addressed cache entry')
    }

    await this.removePath(temporaryRoot)
    await this.removePath(runtimeRoot)
    const cloned = await this.executeProcess({
      command: '/usr/bin/cp',
      args: ['-a', '-l', '--', baselineCache, temporaryRoot],
      cwd: this.runtimesRoot,
      env: safeEnvironment(this.baseEnvironment, this.buildHome),
      timeoutMs: this.buildTimeoutMs,
      signal: this.signal,
      outputLimitBytes: 2 * 1024 * 1024,
      secretValues: this.secretValues,
    })
    if (!processSucceeded(cloned)) {
      throw new Error('Slim runtime hard-link clone failed')
    }

    // A campaign-local slim runtime is not a full-build cache entry. Removing
    // this hard link cannot alter the baseline attestation inode.
    await this.removePath(join(temporaryRoot, RUNTIME_CACHE_ATTESTATION))
    for (const { path } of changes) {
      const sourcePath = resolve(sourceRoot, path)
      const targetPath = resolve(temporaryRoot, path)
      const sourceRel = relative(sourceRoot, sourcePath)
      const targetRel = relative(temporaryRoot, targetPath)
      if (sourceRel === '..' || sourceRel.startsWith(`..${sep}`)
          || targetRel === '..' || targetRel.startsWith(`..${sep}`)) {
        throw new Error('Slim runtime hot patch escaped its source or runtime root')
      }
      const sourceStat = await lstat(sourcePath)
      const targetStat = await lstat(targetPath)
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
          || !targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error(`Slim runtime hot patch requires an existing regular file: ${path}`)
      }
      const replacement = join(dirname(targetPath), `.rsi-hot-patch-${randomUUID()}`)
      try {
        await writeFile(replacement, await readFile(sourcePath), {
          flag: 'wx',
          mode: sourceStat.mode & 0o111 ? 0o555 : 0o444,
        })
        await chown(replacement, this.trustedUid, this.trustedGid)
        await chmod(replacement, sourceStat.mode & 0o111 ? 0o555 : 0o444)
        await this.renamePath(replacement, targetPath)
      } finally {
        await this.removePath(replacement).catch(() => {})
      }
    }
    await this.validateRuntime(temporaryRoot)
    await this.renamePath(temporaryRoot, runtimeRoot)
    this.validatedRuntimeRoots.add(runtimeRoot)
    return {
      ok: true,
      candidateId,
      level,
      runtimeRoot,
      nodeVersion: this.expectedNodeVersion,
      pnpmVersion: this.expectedPnpmVersion,
      slimReuse: true,
      parentRuntimeRoot: this.baselineRuntimeRoot,
      changedFiles: changes.map((change) => change.path),
    }
  }

  async #activateCachedRuntime(runtimeRoot, cacheEntry) {
    const temporaryLink = join(this.runtimesRoot, `.${basename(runtimeRoot)}.link-${randomUUID()}`)
    await this.removePath(temporaryLink)
    await this.removePath(runtimeRoot)
    try {
      await symlink(cacheEntry, temporaryLink, 'dir')
      await this.renamePath(temporaryLink, runtimeRoot)
    } finally {
      await this.removePath(temporaryLink).catch(() => {})
    }
  }

  async #tryCachedRuntime({ runtimeRoot, attestation }) {
    const cacheEntry = this.#cacheEntry(attestation)
    if (cacheEntry === null) return null
    try {
      await lstat(cacheEntry)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    await this.#validateCacheEntry(cacheEntry, attestation)
    await this.#activateCachedRuntime(runtimeRoot, cacheEntry)
    return cacheEntry
  }

  async buildCandidate({ candidateId, candidateRoot, level, candidateDigest }) {
    assertCandidate(candidateId, level)
    const sourceRoot = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const runtimeRoot = join(this.runtimesRoot, candidateId)
    const attestation = this.runtimeCacheRoot === null
      ? null
      : this.#cacheAttestation(candidateDigest)
    const cacheEntry = attestation === null ? null : this.#cacheEntry(attestation)
    const temporaryParent = cacheEntry === null ? this.runtimesRoot : this.runtimeCacheRoot
    const temporaryRoot = join(temporaryParent, `.${candidateId}.tmp-${randomUUID()}`)
    const buildRunRoot = join(this.buildHome, `${candidateId}-${randomUUID()}`)
    assertSeparated(sourceRoot, runtimeRoot)
    assertSeparated(sourceRoot, temporaryRoot)
    await this.#ensureRuntimeRoots()

    try {
      const cachedRuntime = attestation === null
        ? null
        : await this.#tryCachedRuntime({ runtimeRoot, attestation })
      if (cachedRuntime !== null) {
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
          cacheHit: true,
          cacheKey: attestation.cacheKey,
        }
      }
      const slim = await this.#trySlimSingleBranchBuild({
        candidateId,
        sourceRoot,
        runtimeRoot,
        temporaryRoot,
        level,
        candidateDigest,
      })
      if (slim !== null) return slim
      await this.#ensureInfrastructure()
      await this.#ensureToolchain()
      await this.removePath(temporaryRoot)
      await this.removePath(runtimeRoot)
      await this.copyRuntimeSource({ sourceRoot, destination: temporaryRoot })
      await this.grantBuildAccess({ root: temporaryRoot, uid: this.buildUid, gid: this.buildGid })
      const pnpmSafetyArguments = [
        '--config.minimum-release-age=0',
        '--config.trust-policy=off',
        '--config.update-notifier=false',
      ]
      const installArguments = [
        this.pnpmCliPath,
        ...pnpmSafetyArguments,
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
      const hostBuildArguments = [
        this.pnpmCliPath,
        ...pnpmSafetyArguments,
        'run',
        'build:lib:host',
      ]
      let installResult
      let hostBuildResult
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
        const executeBuildStep = async (args) => {
          const invocation = buildBubblewrapInvocation({
            invocation: {
              command: this.nodePath,
              args,
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
            procMode: this.benchmark === 'hle-text-math' ? 'empty' : 'mounted',
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
          return this.executeProcess({
            ...invocation,
            timeoutMs: this.buildTimeoutMs,
            signal: this.signal,
            outputLimitBytes: 16 * 1024 * 1024,
            secretValues: this.secretValues,
          })
        }
        installResult = await executeBuildStep(installArguments)
        if (processSucceeded(installResult)) {
          // Fresh source checkouts cannot boot the normal headless profile until
          // its generated host-side typert exports exist. Build them inside the
          // same unprivileged, no-network sandbox before freezing the runtime.
          hostBuildResult = await executeBuildStep(hostBuildArguments)
        }
      } finally {
        await this.removePath(buildRunRoot).catch(() => {})
      }
      if (processOperationalFailure(installResult)) {
        throw new Error('dependency installation timed out, aborted, or exceeded output limits')
      }
      if (!processSucceeded(installResult)) {
        await this.removePath(temporaryRoot)
        return candidateBuildFailure({
          candidateId,
          level,
          message: 'Candidate dependency installation failed',
          exitCode: processExitCode(installResult),
        })
      }
      if (processOperationalFailure(hostBuildResult)) {
        throw new Error('host artifact build timed out, aborted, or exceeded output limits')
      }
      if (!processSucceeded(hostBuildResult)) {
        await this.removePath(temporaryRoot)
        return candidateBuildFailure({
          candidateId,
          level,
          message: 'Candidate host artifact build failed',
          exitCode: processExitCode(hostBuildResult),
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
      if (attestation !== null) {
        await writeFile(
          join(temporaryRoot, RUNTIME_CACHE_ATTESTATION),
          `${JSON.stringify(attestation, null, 2)}\n`,
          { flag: 'wx', mode: 0o400 },
        )
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
          procMode: this.benchmark === 'hle-text-math' ? 'empty' : 'mounted',
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
      if (cacheEntry === null) {
        await this.renamePath(temporaryRoot, runtimeRoot)
      } else {
        try {
          await this.renamePath(temporaryRoot, cacheEntry)
        } catch (error) {
          // Two campaigns may build the same digest concurrently. Only an
          // already-valid immutable entry is allowed to win the race.
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
          await this.removePath(temporaryRoot)
          await this.#validateCacheEntry(cacheEntry, attestation)
        }
        await this.#activateCachedRuntime(runtimeRoot, cacheEntry)
      }
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
        ...(attestation === null ? {} : {
          cacheHit: false,
          cacheKey: attestation.cacheKey,
        }),
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
    coordination,
  }) {
    return {
      campaign: { id: campaignId },
      candidate: {
        id: candidateId,
        parentId,
        root: UPDATER_SANDBOX_PATHS.candidate,
      },
      mutation: {
        level,
        writablePaths: DEEPSEEK_HARNESS_MUTATION_POLICY.levels[level],
        readOnlyPaths: DEEPSEEK_HARNESS_MUTATION_POLICY.alwaysReadOnly,
      },
      feedback: {
        root: UPDATER_SANDBOX_PATHS.feedback,
        log: UPDATER_SANDBOX_PATHS.evolutionLog,
      },
      controller: {
        promptPrefix: coordination.promptPrefix ?? '',
        promptSuffix: coordination.promptSuffix ?? '',
      },
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

  async #withGateway(operation, candidateId, runRoot, callback) {
    const isolatedGateway = this.benchmark === 'hle-text-math'
    if (!isolatedGateway && this.updaterGatewayPoison) {
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
        trustedModel: this.updaterModel,
        trustedReasoningEffort: this.updaterReasoningEffort,
        ...(isolatedGateway ? {
          socketPath: join(runRoot, 'model-gateway.sock'),
          publicUrl: MODEL_GATEWAY_RELAY_URL,
          socketUid: this.updaterUid,
          socketGid: this.updaterGid,
        } : { host: '127.0.0.1' }),
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
      if (isolatedGateway && (gateway.url !== MODEL_GATEWAY_RELAY_URL
          || gateway.socketPath !== join(runRoot, 'model-gateway.sock'))) {
        throw new Error('gateway did not preserve the isolated Unix binding')
      }
      // startModelGateway is lazy: it does not load or send the upstream
      // credential until an authenticated downstream request arrives. Install
      // the exact UID/port allow rule before the Updater can make that request.
      if (!isolatedGateway) {
        gatewayLease = await this.acquireGatewayEgressLease({
          gatewayUrl: gateway.url,
          uid: this.updaterUid,
        })
        if (!gatewayLease || typeof gatewayLease.release !== 'function') {
          const error = new Error('gateway egress lease is invalid')
          error.fatal = true
          throw error
        }
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
        if (gatewayLease) await gatewayLease.release()
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

  async #prepareUpdaterRun({ candidateId }) {
    await this.#ensureInfrastructure()
    try {
      await this.#evaluationRuntime(this.baselineRuntimeRoot)
    } catch (error) {
      throw infrastructureError('updater-runtime', 'Frozen baseline runtime is unavailable', error)
    }
    const runRoot = join(this.updaterRunRoot, `${candidateId}-mutation-${randomUUID()}`)
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
    const templatePath = join(runRoot, 'mutation.prompt.md')
    await this.prepareUpdaterTemplate({
      sourcePath: this.mutationTemplatePath,
      destination: templatePath,
    })
    return { runRoot, home, templatePath }
  }

  #updaterInvocation({
    candidateRoot,
    gitRoot,
    feedbackRoot,
    evolutionLogPath,
    peerLogs,
    runRoot,
    home,
    gateway,
    dummyKey,
  }) {
    return {
      backend: this.updaterBackend,
      nodeBinary: this.nodePath,
      updaterRuntime: this.baselineRuntimeRoot,
      codexPath: this.codexPath,
      updaterProvider: this.updaterProvider,
      updaterModel: this.updaterModel,
      updaterReasoningEffort: this.updaterReasoningEffort,
      candidateRoot,
      gitRoot,
      runRoot,
      runtimePatch: this.runtimePatch,
      feedbackRoot,
      evolutionLogPath,
      peerLogs,
      gatewayUrl: gateway.url,
      ...(gateway.socketPath === undefined ? {} : { gatewaySocketPath: gateway.socketPath }),
      gatewayDummyKey: dummyKey,
      uid: this.updaterUid,
      gid: this.updaterGid,
      bwrapPath: this.bwrapPath,
      setprivPath: this.setprivPath,
      baseEnv: safeEnvironment(this.baseEnvironment, home),
    }
  }

  async mutate({
    campaignId,
    candidateId,
    parentId,
    level,
    candidateRoot,
    gitRoot,
    feedbackRoot,
    evolutionLogPath,
  }) {
    assertCandidate(candidateId, level)
    const candidate = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const repository = requireAbsolutePath(gitRoot, 'gitRoot')
    const feedback = requireAbsolutePath(feedbackRoot, 'feedbackRoot')
    const evolutionLog = requireAbsolutePath(evolutionLogPath, 'evolutionLogPath')
    const coordination = await this.coordinationContextProvider({
      campaignId,
      candidateId,
      parentId,
      level,
    }) ?? {}
    const run = await this.#prepareUpdaterRun({ candidateId })
    return this.#withGateway('updater-mutation', candidateId, run.runRoot, async (gateway, dummyKey) => {
      const { result, stopReason } = await this.mutationRunner({
        templatePath: run.templatePath,
        templateValues: this.#templateValues({
          campaignId,
          candidateId,
          parentId,
          level,
          coordination,
        }),
        invocationOptions: this.#updaterInvocation({
          candidateRoot: candidate,
          gitRoot: repository,
          feedbackRoot: feedback,
          evolutionLogPath: evolutionLog,
          peerLogs: coordination.peerLogs ?? [],
          runRoot: run.runRoot,
          home: run.home,
          gateway,
          dummyKey,
        }),
        timeoutMs: this.mutationTimeoutMs,
        signal: this.signal,
        execute: this.updaterExecute,
      })
      return {
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        stopReason,
      }
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
        throw infrastructureError('dataset-prepare', `Unable to prepare pinned ${this.benchmark} dataset`, error)
      })
    }
    return this.datasetPromise
  }

  async #evaluationRuntime(candidateRoot) {
    await this.#ensureRuntimeRoots()
    const requestedRoot = requireAbsolutePath(candidateRoot, 'candidateRoot')
    const runtimeRel = relative(this.runtimesRoot, requestedRoot)
    const canonicalRuntime = runtimeRel !== '' && !runtimeRel.includes(sep)
      && CANDIDATE_ID_PATTERN.test(runtimeRel)
    const cacheRel = this.runtimeCacheRoot === null
      ? null
      : relative(this.runtimeCacheRoot, requestedRoot)
    const directCacheEntry = cacheRel !== null && SHA256_PATTERN.test(cacheRel)
      && !cacheRel.includes(sep)
    if (!canonicalRuntime && !directCacheEntry) {
      throw new Error('Evaluation runtime must be a legal runtime alias or cache entry')
    }

    let runtimeRoot = requestedRoot
    const requestedStat = await lstat(requestedRoot)
    if (requestedStat.isSymbolicLink()) {
      if (!canonicalRuntime || this.runtimeCacheRoot === null
          || requestedStat.uid !== this.trustedUid) {
        throw new Error('Evaluation runtime alias is not trusted')
      }
      const lexicalTarget = resolve(dirname(requestedRoot), await readlink(requestedRoot))
      const targetRel = relative(this.runtimeCacheRoot, lexicalTarget)
      if (!SHA256_PATTERN.test(targetRel) || targetRel.includes(sep)) {
        throw new Error('Evaluation runtime alias escapes the content-addressed cache')
      }
      const resolvedTarget = await realpath(requestedRoot)
      if (resolvedTarget !== lexicalTarget) {
        throw new Error('Evaluation runtime alias target must not contain a link chain')
      }
      const targetStat = await lstat(resolvedTarget)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new Error('Evaluation runtime cache target must be a real directory')
      }
      runtimeRoot = resolvedTarget
    } else if (!requestedStat.isDirectory()) {
      throw new Error('Evaluation runtime must be a directory')
    }

    if (this.runtimeCacheRoot !== null
        && SHA256_PATTERN.test(relative(this.runtimeCacheRoot, runtimeRoot))) {
      if (!this.validatedRuntimeRoots.has(runtimeRoot)) {
        await this.#validateCacheEntry(runtimeRoot)
      }
      return runtimeRoot
    }
    if (!this.validatedRuntimeRoots.has(runtimeRoot)) {
      await this.validateFrozenRuntime({
        root: runtimeRoot,
        trustedUid: this.trustedUid,
      })
      await this.validateRuntime(runtimeRoot)
      this.validatedRuntimeRoots.add(runtimeRoot)
    }
    return runtimeRoot
  }

  async #baselineForSmoke(sourceRoot) {
    await this.#ensureInfrastructure()
    if (!this.baselineBuilt) {
      let structurallyReusable = false
      try {
        await this.#evaluationRuntime(this.baselineRuntimeRoot)
        structurallyReusable = true
      } catch (error) {
        if (error instanceof ProductionRuntimeError || isInfrastructureFilesystemFailure(error)) {
          throw infrastructureError(
            'smoke-baseline',
            'Unable to inspect the frozen baseline runtime',
            error,
          )
        }
      }
      if (structurallyReusable) this.baselineBuilt = true
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
    const ids = validatePartitionIds(instanceIds, this.validationExpectedCount, 'validation')
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
