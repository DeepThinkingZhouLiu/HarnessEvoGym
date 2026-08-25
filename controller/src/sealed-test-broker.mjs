import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKER_FLAG = '--harness-rsi-sealed-test-worker'
const WORKER_JOB_VERSION = 1
const TEST_TASK_COUNT = 172
const MAX_JOB_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 4096
const MAX_SECRET_BYTES = 64 * 1024
const MAX_TRACE_BYTES = 64 * 1024 * 1024
const MAX_RESULT_BYTES = 256 * 1024 * 1024
const RECEIPT_KEYS = new Set(['receiptId', 'candidateId', 'status', 'completedAt'])
const INTERNAL_RECEIPT_KEYS = new Set([
  'version',
  'receipt',
  'manifestSha256',
  'recordCount',
  'summarySha256',
  'recordsSha256',
  'tracesSha256',
])
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const CREDENTIAL_FIELD = /(?:api.?key|authorization|credential|password|secret|(?:^|[_-])token(?:$|[_-]))/iu
const RESERVED_PARTITION_FIELDS = new Set([
  'candidateId',
  'instanceIds',
  'manifestPath',
  'sealedOutputPath',
  'sealed',
  'onProgress',
  'onRecord',
  'onTrace',
  'signal',
  'getApiKey',
])
const CHILD_ENV_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'TZ',
])

export class SealedTestBrokerError extends Error {
  constructor(code = 'SEALED_TEST_FAILED') {
    super('Sealed test execution failed')
    this.name = 'SealedTestBrokerError'
    this.code = code
    this.kind = 'infrastructure'
  }
}

function brokerError(code) {
  return new SealedTestBrokerError(code)
}

function assertId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw brokerError('SEALED_INPUT_INVALID')
  return value
}

function assertAbsolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw brokerError('SEALED_INPUT_INVALID')
  return resolve(value)
}

function assertRunnerExport(value) {
  if (typeof value !== 'string' || !EXPORT_PATTERN.test(value)) throw brokerError('SEALED_INPUT_INVALID')
  return value
}

function assertSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw brokerError('SEALED_INPUT_INVALID')
  }
  return value
}

export function sealedArtifactSha256(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value))) {
    throw brokerError('SEALED_OUTPUT_INVALID')
  }
  return createHash('sha256').update(value).digest('hex')
}

function traceSetSha256(entries) {
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  const hash = createHash('sha256')
    .update('harness-rsi-sealed-trace-directory-v1\0')
    .update(String(sorted.length))
    .update('\0')
  for (const entry of sorted) {
    if (typeof entry.name !== 'string' || !SHA256_PATTERN.test(entry.digest ?? '')) {
      throw brokerError('SEALED_OUTPUT_INVALID')
    }
    hash
      .update(String(Buffer.byteLength(entry.name)))
      .update(':')
      .update(entry.name)
      .update('\0')
      .update(entry.digest)
      .update('\0')
  }
  return hash.digest('hex')
}

/** Hash every trace filename and exact payload without returning either to the parent. */
export async function sealedTraceDirectorySha256(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const traceEntries = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw brokerError('SEALED_OUTPUT_INVALID')
      const entryPath = join(path, entry.name)
      const stat = await lstat(entryPath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw brokerError('SEALED_OUTPUT_INVALID')
      traceEntries.push({
        name: entry.name,
        digest: sealedArtifactSha256(await readFile(entryPath)),
      })
    }
    return traceSetSha256(traceEntries)
  } catch (error) {
    if (error instanceof SealedTestBrokerError) throw error
    throw brokerError('SEALED_STORAGE_FAILED')
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonValue(value, path = '', depth = 0) {
  if (depth > 32) throw brokerError('SEALED_INPUT_INVALID')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, path, depth + 1)
    return
  }
  if (!isPlainObject(value)) throw brokerError('SEALED_INPUT_INVALID')
  for (const [key, entry] of Object.entries(value)) {
    if (RESERVED_PARTITION_FIELDS.has(key) || CREDENTIAL_FIELD.test(key)) {
      throw brokerError('SEALED_INPUT_INVALID')
    }
    assertJsonValue(entry, path ? `${path}.${key}` : key, depth + 1)
  }
}

function normalizePartitionOptions(value = {}) {
  assertJsonValue(value)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > MAX_JOB_BYTES / 2) throw brokerError('SEALED_INPUT_INVALID')
  return JSON.parse(serialized)
}

function isoTimestamp(value) {
  const text = String(value ?? '')
  if (!text || Number.isNaN(Date.parse(text))) throw brokerError('SEALED_OUTPUT_INVALID')
  return text
}

function makeReceipt(candidateId, now, makeReceiptId) {
  return Object.freeze({
    receiptId: assertId(makeReceiptId()),
    candidateId,
    status: 'sealed',
    completedAt: isoTimestamp(now()),
  })
}

/** Validate and clone the only value allowed to cross from the sealed side. */
export function assertOpaqueSealedReceipt(receipt, expectedCandidateId) {
  try {
    if (!isPlainObject(receipt)) throw new Error('invalid')
    if (Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key))
        || Object.keys(receipt).length !== RECEIPT_KEYS.size) {
      throw new Error('invalid')
    }
    assertId(receipt.receiptId)
    assertId(receipt.candidateId)
    if (receipt.candidateId !== expectedCandidateId || receipt.status !== 'sealed') throw new Error('invalid')
    isoTimestamp(receipt.completedAt)
    return Object.freeze({
      receiptId: receipt.receiptId,
      candidateId: receipt.candidateId,
      status: 'sealed',
      completedAt: receipt.completedAt,
    })
  } catch {
    throw brokerError('SEALED_RECEIPT_INVALID')
  }
}

/** Validate the sealed-only content attestation. Never return this to the parent. */
export function assertInternalSealedReceipt(
  value,
  expectedCandidateId,
  expectedRecordCount = TEST_TASK_COUNT,
) {
  try {
    if (!Number.isSafeInteger(expectedRecordCount)
        || expectedRecordCount < 1 || expectedRecordCount > 10_000) throw new Error('invalid')
    if (!isPlainObject(value)
        || Object.keys(value).length !== INTERNAL_RECEIPT_KEYS.size
        || Object.keys(value).some((key) => !INTERNAL_RECEIPT_KEYS.has(key))
        || value.version !== 1
        || value.recordCount !== expectedRecordCount) {
      throw new Error('invalid')
    }
    const receipt = assertOpaqueSealedReceipt(value.receipt, expectedCandidateId)
    for (const digest of [
      value.manifestSha256,
      value.summarySha256,
      value.recordsSha256,
      value.tracesSha256,
    ]) {
      if (!SHA256_PATTERN.test(digest ?? '')) throw new Error('invalid')
    }
    return Object.freeze({
      version: 1,
      receipt,
      manifestSha256: value.manifestSha256,
      recordCount: expectedRecordCount,
      summarySha256: value.summarySha256,
      recordsSha256: value.recordsSha256,
      tracesSha256: value.tracesSha256,
    })
  } catch {
    throw brokerError('SEALED_RECEIPT_INVALID')
  }
}

async function readTestManifest(path, expectedSha256, expectedCount) {
  let contents
  try {
    contents = await readFile(path)
  } catch {
    throw brokerError('SEALED_MANIFEST_INVALID')
  }
  if (sealedArtifactSha256(contents) !== expectedSha256) {
    throw brokerError('SEALED_MANIFEST_INVALID')
  }
  const text = contents.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(contents)) throw brokerError('SEALED_MANIFEST_INVALID')
  const body = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : null
  const ids = body === null ? [] : body.split(/\r?\n/u)
  if (ids.length !== expectedCount || new Set(ids).size !== ids.length
      || ids.some((id) => !ID_PATTERN.test(id))
      || ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) {
    throw brokerError('SEALED_MANIFEST_INVALID')
  }
  return ids
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw brokerError('SEALED_STORAGE_FAILED')
  }
}

async function privateDirectory(path, { exclusive = false } = {}) {
  try {
    await mkdir(path, { recursive: !exclusive, mode: 0o700 })
    await chmod(path, 0o700)
  } catch {
    throw brokerError('SEALED_STORAGE_FAILED')
  }
}

async function ensurePrivateParent(path) {
  if (path === parse(path).root) throw brokerError('SEALED_STORAGE_FAILED')
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    // Do not chmod a pre-existing broad directory such as /tmp. The campaign
    // store must provide a genuinely private sealed root.
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('sealed parent is not private')
    }
  } catch {
    throw brokerError('SEALED_STORAGE_FAILED')
  }
}

async function privateWrite(path, contents, mode = 0o600) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents))
  try {
    await writeFile(path, buffer, { flag: 'wx', mode })
    await chmod(path, mode)
  } catch {
    throw brokerError('SEALED_STORAGE_FAILED')
  }
}

function redactExactSecrets(value, secretValues = []) {
  let output = String(value)
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 8) {
      output = output.split(secret).join('[REDACTED]')
    }
  }
  return output
}

function serializedTrace(value, secretValues = []) {
  if (Buffer.isBuffer(value)) return Buffer.from(redactExactSecrets(value.toString('utf8'), secretValues))
  if (typeof value === 'string') return Buffer.from(redactExactSecrets(value, secretValues))
  try {
    return Buffer.from(redactExactSecrets(`${JSON.stringify(value)}\n`, secretValues))
  } catch {
    throw brokerError('SEALED_OUTPUT_INVALID')
  }
}

function validatePartitionResult(result, candidateId, instanceIds, expectedCount) {
  if (!isPlainObject(result) || !isPlainObject(result.summary) || !Array.isArray(result.records)) {
    throw brokerError('SEALED_OUTPUT_INVALID')
  }
  const { summary, records } = result
  if (summary.candidateId !== candidateId || summary.total !== expectedCount
      || !Number.isInteger(summary.verified) || summary.verified < 0
      || summary.verified > expectedCount || records.length !== expectedCount) {
    throw brokerError('SEALED_OUTPUT_INVALID')
  }
  let resolved = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!isPlainObject(record) || record.instanceId !== instanceIds[index]) {
      throw brokerError('SEALED_OUTPUT_INVALID')
    }
    if (record.status === 'resolved') resolved += 1
  }
  if (resolved !== summary.verified) throw brokerError('SEALED_OUTPUT_INVALID')
  return { summary, records, traces: result.traces }
}

function serializeResult(result, receipt, expectedCount, secretValues = []) {
  let summaryText
  let recordsText
  try {
    summaryText = redactExactSecrets(`${JSON.stringify({
      ...result.summary,
      candidateId: receipt.candidateId,
      verified: result.summary.verified,
      total: expectedCount,
      completedAt: receipt.completedAt,
    }, null, 2)}\n`, secretValues)
    recordsText = redactExactSecrets(
      result.records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      secretValues,
    )
  } catch {
    throw brokerError('SEALED_OUTPUT_INVALID')
  }
  if (Buffer.byteLength(summaryText) + Buffer.byteLength(recordsText) > MAX_RESULT_BYTES) {
    throw brokerError('SEALED_OUTPUT_INVALID')
  }
  return { summaryText, recordsText }
}

function makeStagingPath(sealedOutputPath) {
  return join(
    dirname(sealedOutputPath),
    `.${basename(sealedOutputPath)}.partial-${process.pid}-${randomUUID()}`,
  )
}

async function removeStaging(path) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Cleanup failure stays on the sealed side and must not expose a filesystem path.
  }
}

/**
 * Test-friendly implementation with an injectable runPartition function.
 *
 * This function preserves the return-value boundary but does not isolate stdout or
 * memory because the injected runner executes in-process. Production must use
 * runSealedTestInChild (plus an OS/container filesystem and egress sandbox).
 */
export async function runSealedTest({
  candidateId: rawCandidateId,
  testManifestPath: rawManifestPath,
  testManifestSha256: rawManifestSha256,
  sealedOutputPath: rawOutputPath,
  stagingOutputPath: rawStagingPath,
  partitionOptions = {},
  runPartition,
  getApiKey,
  signal,
  now = () => new Date().toISOString(),
  makeReceiptId = randomUUID,
  secretValues = [],
  expectedCount = TEST_TASK_COUNT,
}) {
  const candidateId = assertId(rawCandidateId)
  const testManifestPath = assertAbsolutePath(rawManifestPath)
  const testManifestSha256 = assertSha256(rawManifestSha256)
  const sealedOutputPath = assertAbsolutePath(rawOutputPath)
  const stagingOutputPath = rawStagingPath
    ? assertAbsolutePath(rawStagingPath)
    : makeStagingPath(sealedOutputPath)
  const requiredStagingPrefix = `.${basename(sealedOutputPath)}.partial-`
  if (dirname(stagingOutputPath) !== dirname(sealedOutputPath)
      || !basename(stagingOutputPath).startsWith(requiredStagingPrefix)
      || stagingOutputPath === sealedOutputPath || typeof runPartition !== 'function'
      || typeof now !== 'function' || typeof makeReceiptId !== 'function'
      || (getApiKey !== undefined && typeof getApiKey !== 'function')
      || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 10_000) {
    throw brokerError('SEALED_INPUT_INVALID')
  }
  const safePartitionOptions = normalizePartitionOptions(partitionOptions)
  if (signal?.aborted) throw brokerError('SEALED_TEST_ABORTED')

  let committed = false
  let stagingCreated = false
  try {
    if (await pathExists(sealedOutputPath) || await pathExists(stagingOutputPath)) {
      throw brokerError('SEALED_STORAGE_FAILED')
    }
    await ensurePrivateParent(dirname(sealedOutputPath))
    await privateDirectory(stagingOutputPath, { exclusive: true })
    stagingCreated = true
    const traceRoot = join(stagingOutputPath, 'traces')
    await privateDirectory(traceRoot, { exclusive: true })
    const instanceIds = await readTestManifest(testManifestPath, testManifestSha256, expectedCount)

    const onTrace = async ({ text }) => {
      const trace = serializedTrace(text, secretValues)
      if (trace.length > MAX_TRACE_BYTES) throw brokerError('SEALED_OUTPUT_INVALID')
      const traceId = randomUUID()
      await privateWrite(join(traceRoot, `${traceId}.jsonl`), trace)
      return `sealed://trace/${traceId}`
    }

    let rawResult
    try {
      rawResult = await runPartition({
        ...safePartitionOptions,
        candidateId,
        instanceIds,
        manifestPath: testManifestPath,
        sealedOutputPath: stagingOutputPath,
        sealed: true,
        onProgress: () => {},
        onTrace,
        signal,
        ...(getApiKey ? { getApiKey } : {}),
      })
    } catch {
      if (signal?.aborted) throw brokerError('SEALED_TEST_ABORTED')
      throw brokerError('SEALED_RUN_FAILED')
    }
    if (signal?.aborted) throw brokerError('SEALED_TEST_ABORTED')

    const result = validatePartitionResult(rawResult, candidateId, instanceIds, expectedCount)
    const receipt = makeReceipt(candidateId, now, makeReceiptId)
    const serialized = serializeResult(result, receipt, expectedCount, secretValues)
    await privateWrite(join(stagingOutputPath, 'summary.json'), serialized.summaryText)
    await privateWrite(join(stagingOutputPath, 'records.jsonl'), serialized.recordsText)
    if (result.traces !== undefined
        && !(isPlainObject(result.traces) && Object.keys(result.traces).length === 0)) {
      const returnedTraces = serializedTrace(result.traces, secretValues)
      if (returnedTraces.length > MAX_TRACE_BYTES) throw brokerError('SEALED_OUTPUT_INVALID')
      await privateWrite(join(traceRoot, `returned-${randomUUID()}.json`), returnedTraces)
    }
    const internalReceipt = assertInternalSealedReceipt({
      version: 1,
      receipt,
      manifestSha256: testManifestSha256,
      recordCount: expectedCount,
      summarySha256: sealedArtifactSha256(serialized.summaryText),
      recordsSha256: sealedArtifactSha256(serialized.recordsText),
      tracesSha256: await sealedTraceDirectorySha256(traceRoot),
    }, candidateId, expectedCount)
    await privateWrite(
      join(stagingOutputPath, 'receipt.opaque.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      0o400,
    )
    await privateWrite(
      join(stagingOutputPath, 'receipt.internal.json'),
      `${JSON.stringify(internalReceipt, null, 2)}\n`,
      0o400,
    )
    if (await pathExists(sealedOutputPath)) throw brokerError('SEALED_STORAGE_FAILED')
    try {
      await rename(stagingOutputPath, sealedOutputPath)
      committed = true
    } catch {
      throw brokerError('SEALED_STORAGE_FAILED')
    }
    return assertOpaqueSealedReceipt(receipt, candidateId)
  } catch (error) {
    if (error instanceof SealedTestBrokerError) throw error
    throw brokerError('SEALED_TEST_FAILED')
  } finally {
    if (!committed && stagingCreated) await removeStaging(stagingOutputPath)
  }
}

export function createSealedTestBroker({
  runPartition,
  now = () => new Date().toISOString(),
  makeReceiptId = randomUUID,
}) {
  if (typeof runPartition !== 'function') throw brokerError('SEALED_INPUT_INVALID')
  return Object.freeze({
    run: (job) => runSealedTest({ ...job, runPartition, now, makeReceiptId }),
  })
}

function sanitizedChildEnvironment(environment = process.env) {
  return Object.fromEntries([...CHILD_ENV_KEYS]
    .filter((key) => typeof environment[key] === 'string')
    .map((key) => [key, environment[key]]))
}

function normalizeCredential(value) {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ''))
  const trimmed = Buffer.from(secret.toString('utf8').trim())
  secret.fill(0)
  if (trimmed.length < 8 || trimmed.length > MAX_SECRET_BYTES || /[\r\n]/u.test(trimmed.toString('utf8'))) {
    trimmed.fill(0)
    throw brokerError('SEALED_CREDENTIAL_UNAVAILABLE')
  }
  return trimmed
}

async function readLimitedFd(fd, maximumBytes) {
  return new Promise((resolveValue, rejectValue) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const stream = createReadStream('', { fd, autoClose: false })
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      stream.removeAllListeners()
      callback(value)
    }
    stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maximumBytes) {
        stream.destroy()
        finish(rejectValue, brokerError('SEALED_WORKER_INPUT_INVALID'))
        return
      }
      chunks.push(chunk)
    })
    stream.once('end', () => finish(resolveValue, Buffer.concat(chunks)))
    stream.once('error', () => finish(rejectValue, brokerError('SEALED_WORKER_INPUT_INVALID')))
  })
}

async function readOpaqueReceipt(path, candidateId) {
  let handle
  try {
    handle = await open(path, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
      throw brokerError('SEALED_RECEIPT_INVALID')
    }
    const buffer = Buffer.alloc(stat.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== buffer.length) throw brokerError('SEALED_RECEIPT_INVALID')
    return assertOpaqueSealedReceipt(JSON.parse(buffer.toString('utf8')), candidateId)
  } catch {
    throw brokerError('SEALED_RECEIPT_INVALID')
  } finally {
    await handle?.close().catch(() => {})
  }
}

function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/**
 * Production broker. The child has no IPC channel; stdout/stderr are /dev/null.
 * Job configuration flows parent -> child on fd 3, and an optional provider key
 * flows on fd 4. No task id, score, record, trace, child error, stdout, or stderr
 * is read back. The parent reads only the bounded opaque receipt after exit 0.
 *
 * This boundary still requires an OS/container policy that restricts the worker's
 * filesystem to the test manifest, Candidate, runtime, scratch, and sealed output.
 */
export async function runSealedTestInChild({
  candidateId: rawCandidateId,
  testManifestPath: rawManifestPath,
  testManifestSha256: rawManifestSha256,
  sealedOutputPath: rawOutputPath,
  runnerModulePath: rawRunnerModulePath,
  runnerExport = 'runPartition',
  partitionOptions = {},
  getApiKey,
  signal,
  timeoutMs = 24 * 60 * 60 * 1000,
  killGraceMs = 5_000,
  nodePath = process.execPath,
  childEnvironment = process.env,
  expectedCount = TEST_TASK_COUNT,
}) {
  const candidateId = assertId(rawCandidateId)
  const testManifestPath = assertAbsolutePath(rawManifestPath)
  const testManifestSha256 = assertSha256(rawManifestSha256)
  const sealedOutputPath = assertAbsolutePath(rawOutputPath)
  const runnerModulePath = assertAbsolutePath(rawRunnerModulePath)
  const exportName = assertRunnerExport(runnerExport)
  const safePartitionOptions = normalizePartitionOptions(partitionOptions)
  const nodeExecutable = assertAbsolutePath(nodePath)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isFinite(killGraceMs) || killGraceMs < 0
      || (getApiKey !== undefined && typeof getApiKey !== 'function')
      || !Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 10_000) {
    throw brokerError('SEALED_INPUT_INVALID')
  }
  if (signal?.aborted) throw brokerError('SEALED_TEST_ABORTED')
  const stagingOutputPath = makeStagingPath(sealedOutputPath)

  let credential
  if (getApiKey) {
    try {
      credential = normalizeCredential(await getApiKey())
    } catch {
      throw brokerError('SEALED_CREDENTIAL_UNAVAILABLE')
    }
  }
  const job = {
    version: WORKER_JOB_VERSION,
    candidateId,
    testManifestPath,
    testManifestSha256,
    sealedOutputPath,
    stagingOutputPath,
    runnerModulePath,
    runnerExport: exportName,
    partitionOptions: safePartitionOptions,
    hasCredential: Boolean(credential),
    expectedCount,
  }
  const jobBuffer = Buffer.from(JSON.stringify(job))
  if (jobBuffer.length > MAX_JOB_BYTES) {
    credential?.fill(0)
    throw brokerError('SEALED_INPUT_INVALID')
  }

  const selfPath = fileURLToPath(import.meta.url)
  let child
  try {
    child = spawn(nodeExecutable, [selfPath, WORKER_FLAG], {
      detached: process.platform !== 'win32',
      env: sanitizedChildEnvironment(childEnvironment),
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', credential ? 'pipe' : 'ignore'],
    })
  } catch {
    credential?.fill(0)
    throw brokerError('SEALED_WORKER_FAILED')
  }

  child.stdio[3].on('error', () => {})
  child.stdio[3].end(jobBuffer)
  jobBuffer.fill(0)
  if (credential) {
    child.stdio[4].on('error', () => {})
    child.stdio[4].end(credential, () => credential.fill(0))
  }

  return new Promise((resolveValue, rejectValue) => {
    let settled = false
    let stopCode
    let forceTimer
    const timer = setTimeout(() => {
      stopCode = 'SEALED_TEST_TIMEOUT'
      stopChild(child)
      forceTimer = setTimeout(() => stopChild(child, 'SIGKILL'), killGraceMs)
      forceTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    const cleanup = () => {
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      credential?.fill(0)
    }
    const finish = async (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const onAbort = () => {
      stopCode = 'SEALED_TEST_ABORTED'
      stopChild(child)
      forceTimer = setTimeout(() => stopChild(child, 'SIGKILL'), killGraceMs)
      forceTimer.unref?.()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.once('error', () => finish(rejectValue, brokerError('SEALED_WORKER_FAILED')))
    child.once('close', async (exitCode) => {
      if (stopCode) {
        await finish(rejectValue, brokerError(stopCode))
        return
      }
      if (exitCode !== 0) {
        await finish(rejectValue, brokerError('SEALED_WORKER_FAILED'))
        return
      }
      try {
        const receipt = await readOpaqueReceipt(
          join(sealedOutputPath, 'receipt.opaque.json'),
          candidateId,
        )
        await finish(resolveValue, receipt)
      } catch {
        await finish(rejectValue, brokerError('SEALED_RECEIPT_INVALID'))
      }
    })
  })
}

async function sealedWorkerMain() {
  let credential
  try {
    const jobBytes = await readLimitedFd(3, MAX_JOB_BYTES)
    let job
    try {
      job = JSON.parse(jobBytes.toString('utf8'))
    } catch {
      throw brokerError('SEALED_WORKER_INPUT_INVALID')
    } finally {
      jobBytes.fill(0)
    }
    if (!isPlainObject(job) || job.version !== WORKER_JOB_VERSION
        || typeof job.hasCredential !== 'boolean') {
      throw brokerError('SEALED_WORKER_INPUT_INVALID')
    }
    if (job.hasCredential) credential = normalizeCredential(await readLimitedFd(4, MAX_SECRET_BYTES))
    const imported = await import(pathToFileURL(assertAbsolutePath(job.runnerModulePath)).href)
    const runPartition = imported[assertRunnerExport(job.runnerExport)]
    if (typeof runPartition !== 'function') throw brokerError('SEALED_WORKER_INPUT_INVALID')
    const childPartitionOptions = normalizePartitionOptions(job.partitionOptions)
    const keyText = credential?.toString('utf8')
    await runSealedTest({
      candidateId: job.candidateId,
      testManifestPath: job.testManifestPath,
      testManifestSha256: job.testManifestSha256,
      sealedOutputPath: job.sealedOutputPath,
      stagingOutputPath: job.stagingOutputPath,
      partitionOptions: childPartitionOptions,
      runPartition,
      expectedCount: job.expectedCount,
      ...(keyText ? { getApiKey: async () => keyText } : {}),
      ...(keyText ? { secretValues: [keyText] } : {}),
    })
  } finally {
    credential?.fill(0)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
    && process.argv[2] === WORKER_FLAG) {
  try {
    await sealedWorkerMain()
  } catch {
    // Never print worker failures: task ids, scores, traces, and provider errors
    // may be present in the original exception. Exit status is the only signal.
    process.exitCode = 70
  }
}
