import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEFAULT_CANDIDATE_API_KEY } from './model-gateway.mjs'
import { ProtocolError } from './protocol.mjs'
import { buildVerifierSandboxInvocation } from './sandbox.mjs'

export const PUTNAMBENCH_LEAN_PIN = Object.freeze({
  datasetRevision: 'dfb0a47a1c1ec3a10f2a9acfdf41a2043920f33c',
  leanToolchain: 'leanprover/lean4:v4.27.0',
  mathlibRevision: 'a3a10db0e9d66acbebf76c5e6a135066525ac900',
  taskCount: 672,
})

// This credential authenticates only to the Controller-owned loopback gateway.
// It has no value at the upstream model provider and is intentionally constant.
export const CONTROLLER_GATEWAY_DUMMY_KEY = DEFAULT_CANDIDATE_API_KEY
const SOURCE_WRAPPER = 'process.chdir(process.env.TASK_CWD); await import(process.env.DSH_SOURCE_BIN)'

const PROBLEM_ID = /^putnam_\d{4}_[ab][1-6]$/u
const SORRY_TOKEN = /\bsorry\b/gu
const FORBIDDEN_PROOF_TERMS = [
  /\bsorry\b/u,
  /\badmit\b/u,
  /\baxiom\b/u,
  /\bnative_decide\b/u,
]
const SAFE_ENVIRONMENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'ELAN_HOME',
  'HOME',
  'NO_COLOR',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'TZ',
])
const MAXIMUM_CANDIDATE_SOURCE_BYTES = 4 * 1024 * 1024
const SOURCE_READ_CHUNK_BYTES = 64 * 1024
const DATASET_PREPARATION_LOCK = '.harness-rsi-dataset-prepare.lock'
const DATASET_PREPARATION_OWNER = 'owner.json'
const DATASET_PREPARATION_STAGE_PREFIX = '.harness-rsi-dataset-stage-'
const DATASET_PREPARATION_BACKUP_PREFIX = '.harness-rsi-dataset-backup-'
const DATASET_PREPARATION_STAGE_PATTERN = /^\.harness-rsi-dataset-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DATASET_PREPARATION_BACKUP_PATTERN = /^\.harness-rsi-dataset-backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PREPARED_ATTESTATION_FILE = '.harness-rsi-attestation.json'
const PREPARED_ATTESTATION_TEMP_PREFIX = `${PREPARED_ATTESTATION_FILE}.tmp-`
const PREPARED_FORMAT = 'putnambench-official-rewrite/v1'
const DEFAULT_DATASET_LOCK_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_DATASET_LOCK_POLL_MS = 100
const DEFAULT_INCOMPLETE_LOCK_GRACE_MS = 60_000

export class CommandTimeoutError extends Error {
  constructor(message = 'command timed out') {
    super(message)
    this.name = 'CommandTimeoutError'
    this.code = 'COMMAND_TIMEOUT'
  }
}

export class CommandAbortedError extends Error {
  constructor(message = 'command aborted') {
    super(message)
    this.name = 'CommandAbortedError'
    this.code = 'COMMAND_ABORTED'
  }
}

export class CommandInfrastructureError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'CommandInfrastructureError'
    this.code = options.code ?? 'COMMAND_INFRASTRUCTURE'
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function readTrimmed(path) {
  return (await readFile(path, 'utf8')).trim()
}

async function processStartToken(pid) {
  const text = await readTrimmed(`/proc/${pid}/stat`)
  const close = text.lastIndexOf(')')
  if (close < 0) throw new Error('invalid /proc stat record')
  const fields = text.slice(close + 1).trim().split(/\s+/u)
  // The remainder starts at field 3 (state); starttime is field 22.
  if (!fields[19]) throw new Error('/proc stat record lacks starttime')
  return fields[19]
}

async function datasetLockIdentity() {
  return {
    host: hostname(),
    bootId: await readTrimmed('/proc/sys/kernel/random/boot_id'),
    startToken: await processStartToken(process.pid),
  }
}

async function readDatasetLockOwner(lockDirectory) {
  try {
    const owner = JSON.parse(await readFile(join(lockDirectory, DATASET_PREPARATION_OWNER), 'utf8'))
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null
  } catch {
    return null
  }
}

async function localDatasetLockOwnerIsAlive(owner, identity) {
  if (!owner || owner.host !== identity.host || owner.bootId !== identity.bootId
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || typeof owner.startToken !== 'string') return false
  try {
    return await processStartToken(owner.pid) === owner.startToken
  } catch {
    return false
  }
}

async function waitForDatasetLock(delayMs, signal) {
  if (signal?.aborted) throw new CommandAbortedError('dataset preparation lock wait aborted')
  await new Promise((accept, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CommandAbortedError('dataset preparation lock wait aborted'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      accept()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function assertLockDuration(value, name, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
    throw new ProtocolError(`${name} 必须是${allowZero ? '非负' : '正'}有限数字`)
  }
}

/**
 * Acquire the machine-wide PutnamBench materialization lease. The atomic mkdir
 * is shared by every Campaign using the same canonical checkout. PID starttime
 * and boot-id make dead-owner recovery safe against both crashes and PID reuse.
 * A live owner on another host is never reclaimed automatically.
 */
export async function acquirePutnamBenchDatasetLock({
  datasetRoot,
  signal,
  timeoutMs = DEFAULT_DATASET_LOCK_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_DATASET_LOCK_POLL_MS,
  incompleteLockGraceMs = DEFAULT_INCOMPLETE_LOCK_GRACE_MS,
} = {}) {
  assertLockDuration(timeoutMs, 'dataset lock timeoutMs')
  assertLockDuration(pollIntervalMs, 'dataset lock pollIntervalMs')
  assertLockDuration(incompleteLockGraceMs, 'dataset incomplete lock grace', { allowZero: true })
  if (typeof datasetRoot !== 'string' || !isAbsolute(datasetRoot)) {
    throw new ProtocolError('datasetRoot 必须是绝对路径')
  }
  const canonicalRoot = await realpath(resolve(datasetRoot))
  const rootStat = await lstat(canonicalRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProtocolError('datasetRoot 必须解析为真实目录')
  }

  const identity = await datasetLockIdentity()
  const lockDirectory = join(canonicalRoot, DATASET_PREPARATION_LOCK)
  const deadline = Date.now() + timeoutMs

  while (true) {
    if (signal?.aborted) throw new CommandAbortedError('dataset preparation lock wait aborted')
    const nonce = randomUUID()
    try {
      await mkdir(lockDirectory, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new ProtocolError('无法创建 PutnamBench dataset preparation lock', [error.message])
      }

      const nowMs = Date.now()
      const owner = await readDatasetLockOwner(lockDirectory)
      const ownerHasIdentity = typeof owner?.host === 'string'
        && typeof owner?.bootId === 'string'
        && Number.isSafeInteger(owner?.pid)
        && owner.pid > 0
        && typeof owner?.startToken === 'string'
      let recentIncomplete = false
      if (!ownerHasIdentity) {
        try {
          const stat = await lstat(lockDirectory)
          recentIncomplete = nowMs - stat.mtimeMs < incompleteLockGraceMs
        } catch (statError) {
          if (statError.code === 'ENOENT') continue
          throw new ProtocolError('无法检查 PutnamBench dataset preparation lock', [statError.message])
        }
      }
      const localOwnerAlive = await localDatasetLockOwnerIsAlive(owner, identity)
      const remoteOwner = ownerHasIdentity && owner.host !== identity.host
      if (!localOwnerAlive && !remoteOwner && !recentIncomplete) {
        const stalePath = join(
          canonicalRoot,
          `${DATASET_PREPARATION_LOCK}.stale-${randomUUID()}`,
        )
        try {
          await rename(lockDirectory, stalePath)
          await rm(stalePath, { recursive: true, force: true })
          continue
        } catch (reclaimError) {
          if (reclaimError.code === 'ENOENT') continue
          throw new ProtocolError('无法回收失效 PutnamBench dataset preparation lock', [
            reclaimError.message,
          ])
        }
      }

      if (nowMs >= deadline) {
        throw new CommandTimeoutError('timed out waiting for PutnamBench dataset preparation lock')
      }
      await waitForDatasetLock(Math.min(pollIntervalMs, deadline - nowMs), signal)
      continue
    }

    try {
      await writeFile(join(lockDirectory, DATASET_PREPARATION_OWNER), `${JSON.stringify({
        schemaVersion: 1,
        nonce,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...identity,
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      await rm(lockDirectory, { recursive: true, force: true }).catch(() => {})
      throw new ProtocolError('无法初始化 PutnamBench dataset preparation lock', [error.message])
    }

    let released = false
    return async () => {
      if (released) return
      const owner = await readDatasetLockOwner(lockDirectory)
      if (owner?.nonce !== nonce) {
        throw new ProtocolError('PutnamBench dataset preparation lock ownership changed')
      }
      await rm(lockDirectory, { recursive: true, force: true })
      released = true
    }
  }
}

function assertPositiveTimeout(timeoutMs) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new ProtocolError('timeoutMs 必须是正有限数字')
  }
}

function appendOutput(current, chunk, maxOutputBytes) {
  if (Buffer.byteLength(current) >= maxOutputBytes) return current
  const remaining = maxOutputBytes - Buffer.byteLength(current)
  const buffer = Buffer.from(chunk)
  return current + buffer.subarray(0, remaining).toString('utf8')
}

/**
 * Execute a command without a shell. Supplying env replaces, rather than extends,
 * the parent environment so Candidate processes cannot inherit provider secrets.
 */
export async function executeCommand({
  command,
  args = [],
  cwd,
  env,
  signal,
  timeoutMs,
  maxOutputBytes = 4 * 1024 * 1024,
  killGraceMs = 5_000,
}) {
  assertPositiveTimeout(timeoutMs)
  if (signal?.aborted) throw new CommandAbortedError()

  return new Promise((accept, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let timer
    let forceTimer
    let child

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const killChild = (childSignal) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === 'win32') child.kill(childSignal)
        else process.kill(-child.pid, childSignal)
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(childSignal)
      }
    }
    const requestStop = () => {
      killChild('SIGTERM')
      if (!forceTimer) {
        forceTimer = setTimeout(() => killChild('SIGKILL'), killGraceMs)
        forceTimer.unref?.()
      }
    }
    const onAbort = () => {
      aborted = true
      requestStop()
    }

    try {
      child = spawn(command, args, {
        cwd,
        env: env === undefined ? process.env : env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(reject, new CommandInfrastructureError(`无法启动命令：${command}`, { cause: error, code: error.code }))
      return
    }

    child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk, maxOutputBytes) })
    child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk, maxOutputBytes) })
    child.on('error', (error) => {
      finish(reject, new CommandInfrastructureError(`命令启动失败：${command}`, { cause: error, code: error.code }))
    })
    child.on('close', (exitCode, exitSignal) => {
      if (aborted) {
        finish(reject, new CommandAbortedError())
      } else if (timedOut) {
        finish(reject, new CommandTimeoutError())
      } else {
        finish(accept, { exitCode, signal: exitSignal, stdout, stderr })
      }
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        requestStop()
      }, timeoutMs)
      timer.unref?.()
    }
  })
}

function commandExitCode(result) {
  const value = result?.exitCode ?? result?.code
  return Number.isInteger(value) ? value : null
}

function assertCommandSucceeded(result, description) {
  const exitCode = commandExitCode(result)
  if (exitCode !== 0) {
    throw new ProtocolError(`${description}失败`, [
      `exitCode=${String(exitCode)}`,
      String(result?.stderr ?? '').slice(0, 2000),
    ])
  }
}

async function assertRegularFile(path, description) {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    throw new ProtocolError(`缺少${description}：${path}`, [error.message])
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ProtocolError(`${description}必须是普通文件：${path}`)
  }
}

function uniqueSorry(text, description) {
  const matches = [...text.matchAll(SORRY_TOKEN)]
  if (matches.length !== 1) {
    throw new ProtocolError(`${description}必须恰好包含一个 sorry`, [`实际数量：${matches.length}`])
  }
  return { index: matches[0].index, length: matches[0][0].length }
}

async function readCandidateSource(path) {
  const noFollow = fsConstants.O_NOFOLLOW
  if (!Number.isInteger(noFollow)) throw new ProtocolError('当前平台不支持安全读取 Candidate source')
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAXIMUM_CANDIDATE_SOURCE_BYTES) {
      throw new ProtocolError('Candidate source 必须是有界普通文件')
    }
    const chunks = []
    let total = 0
    while (total <= MAXIMUM_CANDIDATE_SOURCE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(
        SOURCE_READ_CHUNK_BYTES,
        MAXIMUM_CANDIDATE_SOURCE_BYTES + 1 - total,
      ))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > MAXIMUM_CANDIDATE_SOURCE_BYTES) {
      throw new ProtocolError('Candidate source 超出大小上限')
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function validatePutnamBenchCheckout({
  datasetRoot,
  execute = executeCommand,
  signal,
  timeoutMs = 30_000,
  pin = PUTNAMBENCH_LEAN_PIN,
}) {
  const root = resolve(datasetRoot)
  const leanRoot = join(root, 'lean4')
  const revisionResult = await execute({
    command: 'git', args: ['-C', root, 'rev-parse', 'HEAD'], cwd: root, signal, timeoutMs,
  })
  assertCommandSucceeded(revisionResult, '读取 PutnamBench revision ')
  const actualRevision = String(revisionResult.stdout ?? '').trim()
  if (actualRevision !== pin.datasetRevision) {
    throw new ProtocolError('PutnamBench revision 与冻结配置不一致', [
      `expected=${pin.datasetRevision}`,
      `actual=${actualRevision}`,
    ])
  }
  const statusResult = await execute({
    command: 'git',
    args: ['-C', root, 'status', '--porcelain=v1', '--untracked-files=no'],
    cwd: root,
    signal,
    timeoutMs,
  })
  assertCommandSucceeded(statusResult, '校验 PutnamBench tracked files ')
  if (String(statusResult.stdout ?? '').trim().length > 0) {
    throw new ProtocolError('PutnamBench tracked files 与冻结 revision 不一致')
  }

  const toolchainPath = join(leanRoot, 'lean-toolchain')
  const manifestPath = join(leanRoot, 'lake-manifest.json')
  const rewriteScript = join(leanRoot, 'scripts', 'rewrite_solutions.py')
  await Promise.all([
    assertRegularFile(toolchainPath, 'lean-toolchain'),
    assertRegularFile(manifestPath, 'lake-manifest.json'),
    assertRegularFile(rewriteScript, '官方 rewrite_solutions.py'),
  ])

  const actualToolchain = (await readFile(toolchainPath, 'utf8')).trim()
  if (actualToolchain !== pin.leanToolchain) {
    throw new ProtocolError('Lean toolchain 与冻结配置不一致', [
      `expected=${pin.leanToolchain}`,
      `actual=${actualToolchain}`,
    ])
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new ProtocolError('无法解析 lake-manifest.json', [error.message])
  }
  const mathlib = Array.isArray(manifest?.packages)
    ? manifest.packages.filter((entry) => entry?.name === 'mathlib')
    : []
  if (mathlib.length !== 1 || mathlib[0].rev !== pin.mathlibRevision) {
    throw new ProtocolError('mathlib revision 与冻结配置不一致', [
      `expected=${pin.mathlibRevision}`,
      `actual=${mathlib.map((entry) => entry?.rev).join(',') || '<missing>'}`,
    ])
  }

  return { root, leanRoot, rewriteScript, revision: actualRevision }
}

async function attestPreparedOutput({ sourceRoot, solutionsRoot, pin }) {
  const solutionsStat = await lstat(solutionsRoot)
  if (!solutionsStat.isDirectory() || solutionsStat.isSymbolicLink()) {
    throw new ProtocolError('PutnamBench rewrite 输出必须是实际目录')
  }
  const [sourceEntries, solutionEntries] = await Promise.all([
    readdir(sourceRoot, { withFileTypes: true }),
    readdir(solutionsRoot, { withFileTypes: true }),
  ])
  const sourceNames = sourceEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.lean'))
    .map((entry) => entry.name.slice(0, -'.lean'.length))
    .sort()
  const unexpectedEntries = solutionEntries.filter((entry) => (
    entry.name !== PREPARED_ATTESTATION_FILE
      && !(entry.isFile() && entry.name.endsWith('_sol.lean'))
  ))
  if (unexpectedEntries.length > 0) {
    throw new ProtocolError('PutnamBench rewrite 目录包含非预期条目', [
      ...unexpectedEntries.slice(0, 10).map((entry) => entry.name),
    ])
  }
  const solutionNames = solutionEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('_sol.lean'))
    .map((entry) => entry.name)
    .sort()
  if (sourceNames.length !== pin.taskCount || solutionNames.length !== pin.taskCount) {
    throw new ProtocolError('PutnamBench rewrite 文件数不正确', [
      `source=${sourceNames.length}`,
      `solutions=${solutionNames.length}`,
      `expected=${pin.taskCount}`,
    ])
  }

  const expectedSolutions = sourceNames.map((name) => `${name}_sol.lean`)
  if (expectedSolutions.some((name, index) => name !== solutionNames[index])) {
    throw new ProtocolError('PutnamBench rewrite 输出与 src 文件集合不一致')
  }
  const outputHash = createHash('sha256')
  for (const name of solutionNames) {
    if (!PROBLEM_ID.test(name.slice(0, -'_sol.lean'.length))) {
      throw new ProtocolError(`非法 PutnamBench Lean 文件名：${name}`)
    }
    const path = join(solutionsRoot, name)
    await assertRegularFile(path, 'solution-patched template')
    const contents = await readFile(path)
    uniqueSorry(contents.toString('utf8'), name)
    outputHash.update(name)
    outputHash.update('\0')
    outputHash.update(String(contents.length))
    outputHash.update('\0')
    outputHash.update(contents)
    outputHash.update('\0')
  }

  return {
    problemIds: solutionNames.map((name) => name.slice(0, -'_sol.lean'.length)),
    taskCount: solutionNames.length,
    outputSha256: outputHash.digest('hex'),
  }
}

function preparedAttestation(pin, outputSha256) {
  return {
    schemaVersion: 1,
    format: PREPARED_FORMAT,
    datasetRevision: pin.datasetRevision,
    leanToolchain: pin.leanToolchain,
    mathlibRevision: pin.mathlibRevision,
    taskCount: pin.taskCount,
    outputSha256,
  }
}

async function readPreparedAttestation(solutionsRoot) {
  let rootStat
  try {
    rootStat = await lstat(solutionsRoot)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProtocolError('PutnamBench prepared output 必须是实际目录')
  }
  const path = join(solutionsRoot, PREPARED_ATTESTATION_FILE)
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ProtocolError('PutnamBench prepared attestation 必须是普通文件')
  }
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw new ProtocolError('PutnamBench prepared attestation 无法解析', [error.message])
  }
}

function assertPreparedAttestation(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      throw new ProtocolError('PutnamBench prepared output attestation 不匹配', [
        `${key}: expected=${String(value)} actual=${String(actual?.[key])}`,
      ])
    }
  }
}

async function assertPreparedOutputReadOnly(solutionsRoot, solutionNames) {
  const rootStat = await lstat(solutionsRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o222) !== 0) {
    throw new ProtocolError('PutnamBench prepared output 必须是只读真实目录')
  }
  for (const name of [...solutionNames, PREPARED_ATTESTATION_FILE]) {
    const stat = await lstat(join(solutionsRoot, name))
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) {
      throw new ProtocolError(`PutnamBench prepared output 不是只读普通文件：${name}`)
    }
  }
}

async function freezePreparedOutput(solutionsRoot, solutionNames) {
  for (const name of [...solutionNames, PREPARED_ATTESTATION_FILE]) {
    await chmod(join(solutionsRoot, name), 0o444)
  }
  await chmod(solutionsRoot, 0o555)
}

async function writePreparedAttestation(solutionsRoot, value, { atomic = false } = {}) {
  const finalPath = join(solutionsRoot, PREPARED_ATTESTATION_FILE)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (!atomic) {
    await writeFile(finalPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o400 })
    return
  }
  const temporaryPath = join(solutionsRoot, `${PREPARED_ATTESTATION_TEMP_PREFIX}${randomUUID()}`)
  try {
    await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o400 })
    await rename(temporaryPath, finalPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function removeStalePreparationArtifacts(datasetRoot) {
  const entries = await readdir(datasetRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (DATASET_PREPARATION_STAGE_PATTERN.test(entry.name)
        || DATASET_PREPARATION_BACKUP_PATTERN.test(entry.name)) {
      await rm(join(datasetRoot, entry.name), { recursive: true, force: true })
    }
  }
}

async function removeStaleAttestationTemps(solutionsRoot) {
  let entries
  try {
    entries = await readdir(solutionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(PREPARED_ATTESTATION_TEMP_PREFIX)) {
      await rm(join(solutionsRoot, entry.name), { force: true })
    }
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Run the official transformation once, prove the exact 672-file closure, and
 * atomically publish a read-only revision/content-attested output. Every
 * Campaign sharing the checkout serializes on the filesystem lease and then
 * fully re-attests the immutable output instead of rewriting it.
 */
export async function preparePutnamBenchDataset({
  datasetRoot,
  execute = executeCommand,
  pythonPath = 'python3',
  signal,
  timeoutMs = 120_000,
  lockTimeoutMs = DEFAULT_DATASET_LOCK_TIMEOUT_MS,
  lockPollIntervalMs = DEFAULT_DATASET_LOCK_POLL_MS,
  incompleteLockGraceMs = DEFAULT_INCOMPLETE_LOCK_GRACE_MS,
  pin = PUTNAMBENCH_LEAN_PIN,
}) {
  const canonicalRoot = await realpath(resolve(datasetRoot))
  const release = await acquirePutnamBenchDatasetLock({
    datasetRoot: canonicalRoot,
    signal,
    timeoutMs: lockTimeoutMs,
    pollIntervalMs: lockPollIntervalMs,
    incompleteLockGraceMs,
  })
  let stageRoot = null
  try {
    const checkout = await validatePutnamBenchCheckout({
      datasetRoot: canonicalRoot,
      execute,
      signal,
      timeoutMs,
      pin,
    })
    const sourceRoot = join(checkout.leanRoot, 'src')
    const solutionsRoot = join(checkout.leanRoot, 'solutions_replaced_new')
    await removeStalePreparationArtifacts(canonicalRoot)
    await removeStaleAttestationTemps(solutionsRoot)

    const existingAttestation = await readPreparedAttestation(solutionsRoot).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existingAttestation !== null) {
      const attested = await attestPreparedOutput({ sourceRoot, solutionsRoot, pin })
      assertPreparedAttestation(existingAttestation, preparedAttestation(pin, attested.outputSha256))
      // If a process died after publishing the marker but before its final
      // chmod, completing the idempotent freeze is safe after the content hash
      // and complete file closure have both been re-proved.
      await freezePreparedOutput(
        solutionsRoot,
        attested.problemIds.map((name) => `${name}_sol.lean`),
      )
      await assertPreparedOutputReadOnly(
        solutionsRoot,
        attested.problemIds.map((name) => `${name}_sol.lean`),
      )
      return { ...checkout, sourceRoot, solutionsRoot, ...attested }
    }

    stageRoot = join(canonicalRoot, `${DATASET_PREPARATION_STAGE_PREFIX}${randomUUID()}`)
    const stagedSourceRoot = join(stageRoot, 'src')
    const stagedScriptRoot = join(stageRoot, 'scripts')
    const stagedRewriteScript = join(stagedScriptRoot, 'rewrite_solutions.py')
    const stagedSolutionsRoot = join(stageRoot, 'solutions_replaced_new')
    await mkdir(stagedScriptRoot, { recursive: true, mode: 0o700 })
    await Promise.all([
      cp(sourceRoot, stagedSourceRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      }),
      cp(checkout.rewriteScript, stagedRewriteScript, {
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      }),
    ])

    const rewriteResult = await execute({
      command: pythonPath,
      args: [stagedRewriteScript],
      cwd: stageRoot,
      signal,
      timeoutMs,
    })
    assertCommandSucceeded(rewriteResult, '官方 solution rewrite ')
    const staged = await attestPreparedOutput({
      sourceRoot,
      solutionsRoot: stagedSolutionsRoot,
      pin,
    })
    const marker = preparedAttestation(pin, staged.outputSha256)
    await writePreparedAttestation(stagedSolutionsRoot, marker)
    await freezePreparedOutput(
      stagedSolutionsRoot,
      staged.problemIds.map((name) => `${name}_sol.lean`),
    )

    if (await pathExists(solutionsRoot)) {
      // A pre-attestation deployment may already have generated the exact
      // official bytes. Prove equality before adopting it without any rename.
      let legacy = null
      try {
        legacy = await attestPreparedOutput({ sourceRoot, solutionsRoot, pin })
      } catch {
        // Incomplete legacy output is quarantined below; it was never safe to consume.
      }
      if (legacy?.outputSha256 === staged.outputSha256) {
        await writePreparedAttestation(solutionsRoot, marker, { atomic: true })
        await freezePreparedOutput(
          solutionsRoot,
          legacy.problemIds.map((name) => `${name}_sol.lean`),
        )
        await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
        stageRoot = null
        return { ...checkout, sourceRoot, solutionsRoot, ...legacy }
      }

      const backupRoot = join(canonicalRoot, `${DATASET_PREPARATION_BACKUP_PREFIX}${randomUUID()}`)
      await rename(solutionsRoot, backupRoot)
      try {
        await rename(stagedSolutionsRoot, solutionsRoot)
      } catch (error) {
        await rename(backupRoot, solutionsRoot).catch(() => {})
        throw error
      }
      // Publication already succeeded. A crashed/failed best-effort cleanup is
      // harmless and the next lease holder removes the UUID-scoped backup.
      await rm(backupRoot, { recursive: true, force: true }).catch(() => {})
    } else {
      await rename(stagedSolutionsRoot, solutionsRoot)
    }
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    stageRoot = null
    return { ...checkout, sourceRoot, solutionsRoot, ...staged }
  } finally {
    if (stageRoot !== null) await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    await release()
  }
}

export function buildSolverPrompt({ editableFileName = 'Main.lean' } = {}) {
  if (basename(editableFileName) !== editableFileName || editableFileName.length === 0) {
    throw new ProtocolError('editableFileName 必须是不含目录的文件名')
  }
  return [
    `Work only on ${editableFileName} in the current directory.`,
    'It contains exactly one Lean placeholder token: `sorry`.',
    'Replace only that token with a complete Lean 4 proof; preserve every other byte, including imports, comments, whitespace, and the theorem statement.',
    'Do not use `sorry`, `admit`, `axiom`, or `native_decide`.',
    'Before finishing, run: cd "$RSI_LEAN_PROJECT_ROOT" && lake env lean -DwarningAsError=true "$RSI_TASK_FILE".',
  ].join(' ')
}

/**
 * Materialize one opaque task. The trusted copy lives outside the Solver's
 * working directory and is addressed only by an opaque task id.
 */
export async function prepareTask({ solutionsRoot, problemId, taskRoot, trustedRoot }) {
  if (!PROBLEM_ID.test(problemId)) throw new ProtocolError(`非法 PutnamBench problem id：${problemId}`)
  const templatePath = join(resolve(solutionsRoot), `${problemId}_sol.lean`)
  await assertRegularFile(templatePath, 'solution-patched template')
  const template = await readFile(templatePath, 'utf8')
  uniqueSorry(template, `${problemId} template`)

  const resolvedTaskRoot = resolve(taskRoot)
  const resolvedTrustedRoot = resolve(trustedRoot)
  await Promise.all([
    mkdir(resolvedTaskRoot, { recursive: true, mode: 0o700 }),
    mkdir(resolvedTrustedRoot, { recursive: true, mode: 0o700 }),
  ])
  const taskDirectory = await mkdtemp(join(resolvedTaskRoot, 'task-'))
  const taskId = basename(taskDirectory)
  const editablePath = join(taskDirectory, 'Main.lean')
  const trustedPath = join(resolvedTrustedRoot, `${taskId}.lean`)
  await writeFile(editablePath, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await writeFile(trustedPath, template, { encoding: 'utf8', flag: 'wx', mode: 0o400 })
  await chmod(trustedPath, 0o400)

  return {
    problemId,
    taskId,
    workdir: taskDirectory,
    editablePath,
    trustedPath,
    prompt: buildSolverPrompt(),
    templateSha256: sha256(template),
  }
}

function assertAbsolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new ProtocolError(`${name} 必须是绝对路径`)
  }
  return resolve(value)
}

export function sanitizeSolverEnvironment(baseEnvironment = {}) {
  const output = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (typeof baseEnvironment[key] === 'string') output[key] = baseEnvironment[key]
  }
  return output
}

/** Build the exact source-mode Harness invocation without any provider key. */
export function buildHarnessInvocation({
  candidateRoot,
  nodePath,
  patchPath,
  dshHome,
  workdir,
  prompt,
  gatewayBaseUrl,
  gatewayDummyKey = CONTROLLER_GATEWAY_DUMMY_KEY,
  leanRoot,
  baseEnvironment = process.env,
  preset = 'standard',
  tsxImportPath,
  sessionRoot,
}) {
  const candidate = assertAbsolutePath(candidateRoot, 'candidateRoot')
  const node = assertAbsolutePath(nodePath, 'nodePath')
  const patch = assertAbsolutePath(patchPath, 'patchPath')
  const home = assertAbsolutePath(dshHome, 'dshHome')
  const cwd = assertAbsolutePath(workdir, 'workdir')
  const project = assertAbsolutePath(leanRoot, 'leanRoot')
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new ProtocolError('Solver prompt 不能为空')
  let gateway
  try {
    gateway = new URL(gatewayBaseUrl)
  } catch {
    throw new ProtocolError('gatewayBaseUrl 必须是有效 URL')
  }
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password) {
    throw new ProtocolError('gatewayBaseUrl 必须使用无凭据的 HTTP(S) URL')
  }
  if (!['127.0.0.1', '[::1]'].includes(gateway.hostname)) {
    throw new ProtocolError('gatewayBaseUrl 必须指向 Controller loopback gateway')
  }
  if (typeof preset !== 'string' || preset.trim().length === 0) throw new ProtocolError('preset 不能为空')
  if (typeof gatewayDummyKey !== 'string' || gatewayDummyKey.length < 8 || /[\r\n]/u.test(gatewayDummyKey)) {
    throw new ProtocolError('gatewayDummyKey 必须是无换行的非空 dummy credential')
  }

  const importPath = tsxImportPath === undefined
    ? join(candidate, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    : assertAbsolutePath(tsxImportPath, 'tsxImportPath')
  const entryPath = join(candidate, 'apps', 'cli', 'src', 'bin.ts')
  const sessions = sessionRoot === undefined
    ? join(home, 'sessions')
    : assertAbsolutePath(sessionRoot, 'sessionRoot')
  const env = {
    ...sanitizeSolverEnvironment(baseEnvironment),
    HOME: home,
    TMPDIR: '/tmp',
    DSH_HOME: home,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_SESSION_ROOT: sessions,
    DSH_TELEMETRY_DISABLED: '1',
    TASK_CWD: cwd,
    DSH_SOURCE_BIN: pathToFileURL(entryPath).href,
    RSI_LEAN_PROJECT_ROOT: project,
    RSI_TASK_FILE: join(cwd, 'Main.lean'),
    RSI_MODEL_GATEWAY_URL: gateway.toString(),
    RSI_MODEL_GATEWAY_DUMMY_KEY: gatewayDummyKey,
  }
  return {
    command: node,
    args: [
      '--import', importPath,
      '--eval', SOURCE_WRAPPER,
      '--', 'dsh',
      '--profile', 'headless',
      '--patch', patch,
      '--preset', preset,
      prompt,
    ],
    // tsx must initialize against the Candidate's tsconfig/path aliases before
    // the wrapper changes cwd to the anonymous Lean task workspace.
    cwd: candidate,
    env,
  }
}

function timing(startedMs, endedMs) {
  return {
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: Math.max(0, endedMs - startedMs),
  }
}

async function persistTrace(recordTrace, traceRef, payload) {
  if (typeof recordTrace !== 'function') return traceRef ?? null
  const recorded = await recordTrace(payload)
  if (typeof recorded !== 'string' || recorded.length === 0) {
    throw new CommandInfrastructureError('recordTrace 必须返回非空 traceRef')
  }
  return recorded
}

function errorClassification(error) {
  if (error instanceof CommandTimeoutError || error?.code === 'COMMAND_TIMEOUT') return 'timeout'
  if (error instanceof CommandAbortedError || error?.code === 'COMMAND_ABORTED' || error?.name === 'AbortError') return 'aborted'
  return 'infrastructure_error'
}

function standardResult({ status, phase, failureKind, startedMs, endedMs, traceRef, reasonCode }) {
  return {
    status,
    phase,
    failureKind,
    reasonCode,
    timing: timing(startedMs, endedMs),
    traceRef: traceRef ?? null,
  }
}

export async function runHarnessSolver({
  invocation,
  execute = executeCommand,
  sandboxed = false,
  signal,
  timeoutMs,
  traceRef,
  recordTrace,
  now = Date.now,
}) {
  assertPositiveTimeout(timeoutMs)
  if (typeof sandboxed !== 'boolean') throw new ProtocolError('sandboxed 必须是布尔值')
  const startedMs = now()
  try {
    const execution = await execute({ ...invocation, signal, timeoutMs })
    const storedTrace = await persistTrace(recordTrace, traceRef, {
      phase: 'solver',
      exitCode: commandExitCode(execution),
      signal: execution?.signal ?? null,
      stdout: String(execution?.stdout ?? ''),
      stderr: String(execution?.stderr ?? ''),
    })
    const endedMs = now()
    if (commandExitCode(execution) === 0) {
      return standardResult({
        status: 'completed', phase: 'solver', failureKind: null,
        startedMs, endedMs, traceRef: storedTrace, reasonCode: null,
      })
    }
    const sandboxLauncherFailure = sandboxed
      && /(?:^|\n)(?:bwrap|setpriv):/u.test(String(execution?.stderr ?? ''))
    return standardResult({
      status: sandboxLauncherFailure ? 'infrastructure_error' : 'candidate_error',
      phase: 'solver',
      failureKind: sandboxLauncherFailure ? 'infrastructure' : 'candidate',
      startedMs,
      endedMs,
      traceRef: storedTrace,
      reasonCode: sandboxLauncherFailure ? 'sandbox_launcher_failure' : 'harness_nonzero_exit',
    })
  } catch (error) {
    const status = errorClassification(error)
    let storedTrace = traceRef ?? null
    try {
      storedTrace = await persistTrace(recordTrace, traceRef, {
        phase: 'solver', error: error.message, code: error.code ?? null,
      })
    } catch {
      // The original execution failure remains the primary classification.
    }
    const endedMs = now()
    return standardResult({
      status,
      phase: 'solver',
      failureKind: status === 'timeout' ? 'candidate' : status === 'aborted' ? 'cancelled' : 'infrastructure',
      startedMs,
      endedMs,
      traceRef: storedTrace,
      reasonCode: status === 'timeout' ? 'solver_budget_exhausted' : status,
    })
  }
}

/**
 * Return the only permitted replacement. Byte-identical prefix and suffix
 * checks make import, statement, comment, and surrounding whitespace edits fail.
 */
export function extractProofReplacement(trustedTemplate, candidateSource) {
  if (typeof trustedTemplate !== 'string' || typeof candidateSource !== 'string') {
    throw new ProtocolError('Lean template 与 Candidate source 必须是字符串')
  }
  const placeholder = uniqueSorry(trustedTemplate, '可信 Lean template')
  const prefix = trustedTemplate.slice(0, placeholder.index)
  const suffix = trustedTemplate.slice(placeholder.index + placeholder.length)
  if (!candidateSource.startsWith(prefix) || !candidateSource.endsWith(suffix)) {
    throw new ProtocolError('Candidate 修改了唯一 sorry 以外的内容')
  }
  const replacementEnd = candidateSource.length - suffix.length
  if (replacementEnd < prefix.length) throw new ProtocolError('Candidate proof replacement 边界非法')
  const replacement = candidateSource.slice(prefix.length, replacementEnd)
  if (replacement.trim().length === 0) throw new ProtocolError('Candidate proof replacement 不能为空')
  const forbidden = FORBIDDEN_PROOF_TERMS.find((pattern) => pattern.test(replacement))
  if (forbidden) throw new ProtocolError(`Candidate proof replacement 包含禁用项：${forbidden.source}`)
  return { prefix, replacement, suffix, source: `${prefix}${replacement}${suffix}` }
}

export async function verifyTask({
  editablePath,
  trustedPath,
  verificationRoot,
  leanRoot,
  lakePath = 'lake',
  execute = executeCommand,
  baseEnvironment = process.env,
  signal,
  timeoutMs = 120_000,
  verifierUid,
  verifierGid,
  bwrapPath,
  setprivPath,
  traceRef,
  recordTrace,
  now = Date.now,
}) {
  assertPositiveTimeout(timeoutMs)
  if ((verifierUid === undefined) !== (verifierGid === undefined)) {
    throw new ProtocolError('Verifier uid/gid 必须同时提供')
  }
  if (verifierUid !== undefined
      && (!Number.isInteger(verifierUid) || verifierUid < 1
        || !Number.isInteger(verifierGid) || verifierGid < 1)) {
    throw new ProtocolError('Verifier uid/gid 必须同时是正整数')
  }
  const startedMs = now()
  let trustedTemplate
  try {
    trustedTemplate = await readFile(trustedPath, 'utf8')
  } catch (error) {
    const endedMs = now()
    return standardResult({
      status: 'infrastructure_error', phase: 'verifier', failureKind: 'infrastructure',
      startedMs, endedMs, traceRef, reasonCode: 'trusted_template_unavailable',
    })
  }

  let candidateSource
  try {
    candidateSource = await readCandidateSource(editablePath)
  } catch (error) {
    const storedTrace = await persistTrace(recordTrace, traceRef, {
      phase: 'integrity', error: error.message, code: error.code ?? null,
    })
    const endedMs = now()
    return standardResult({
      status: 'rejected', phase: 'integrity', failureKind: 'candidate',
      startedMs, endedMs, traceRef: storedTrace, reasonCode: 'candidate_file_unavailable',
    })
  }

  let reconstructed
  try {
    reconstructed = extractProofReplacement(trustedTemplate, candidateSource).source
  } catch (error) {
    const storedTrace = await persistTrace(recordTrace, traceRef, {
      phase: 'integrity', error: error.message,
    })
    const endedMs = now()
    return standardResult({
      status: 'rejected', phase: 'integrity', failureKind: 'candidate',
      startedMs, endedMs, traceRef: storedTrace, reasonCode: 'proof_only_policy_violation',
    })
  }

  let verificationDirectory
  try {
    const root = assertAbsolutePath(verificationRoot, 'verificationRoot')
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (verifierUid !== undefined) {
      await chown(root, verifierUid, verifierGid)
      await chmod(root, 0o700)
    }
    verificationDirectory = await mkdtemp(join(root, 'verify-'))
    const frozenPath = join(verificationDirectory, 'Main.lean')
    await writeFile(frozenPath, reconstructed, { encoding: 'utf8', flag: 'wx', mode: 0o400 })
    await chmod(frozenPath, 0o400)
    if (verifierUid !== undefined) {
      await chown(verificationDirectory, verifierUid, verifierGid)
      await chown(frozenPath, verifierUid, verifierGid)
    }
    const verifierEnvironment = {
      ...sanitizeSolverEnvironment(baseEnvironment),
      ...(verifierUid === undefined ? {} : { HOME: verificationDirectory, TMPDIR: '/tmp' }),
    }
    const rawInvocation = {
      command: lakePath,
      args: ['env', 'lean', '-DwarningAsError=true', frozenPath],
      cwd: resolve(leanRoot),
      env: verifierEnvironment,
    }
    const invocation = verifierUid === undefined
      ? rawInvocation
      : buildVerifierSandboxInvocation({
          invocation: rawInvocation,
          verificationDirectory,
          leanRoot: resolve(leanRoot),
          lakePath,
          verifierUid,
          verifierGid,
          bwrapPath,
          setprivPath,
        })
    const execution = await execute({
      ...invocation,
      signal,
      timeoutMs,
    })
    const storedTrace = await persistTrace(recordTrace, traceRef, {
      phase: 'verifier',
      exitCode: commandExitCode(execution),
      signal: execution?.signal ?? null,
      stdout: String(execution?.stdout ?? ''),
      stderr: String(execution?.stderr ?? ''),
    })
    const endedMs = now()
    if (commandExitCode(execution) === 0) {
      return standardResult({
        status: 'verified', phase: 'verifier', failureKind: null,
        startedMs, endedMs, traceRef: storedTrace, reasonCode: null,
      })
    }
    return standardResult({
      status: 'rejected', phase: 'verifier', failureKind: 'candidate',
      startedMs, endedMs, traceRef: storedTrace, reasonCode: 'lean_rejected',
    })
  } catch (error) {
    const status = errorClassification(error)
    let storedTrace = traceRef ?? null
    try {
      storedTrace = await persistTrace(recordTrace, traceRef, {
        phase: 'verifier', error: error.message, code: error.code ?? null,
      })
    } catch {
      // Preserve the verifier failure as the primary result.
    }
    const endedMs = now()
    return standardResult({
      status,
      phase: 'verifier',
      failureKind: status === 'aborted' ? 'cancelled' : 'infrastructure',
      startedMs,
      endedMs,
      traceRef: storedTrace,
      reasonCode: status === 'timeout' ? 'verifier_timeout' : status,
    })
  } finally {
    if (verificationDirectory) await rm(verificationDirectory, { recursive: true, force: true })
  }
}
