import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'

import { isProviderInfrastructureAudit, startModelGateway } from './model-gateway.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  buildHarnessInvocation,
  prepareTask,
  runHarnessSolver,
  verifyTask,
} from './putnambench-runner.mjs'
import {
  acquireGatewayEgressLease,
  buildSolverSandboxInvocation,
} from './sandbox.mjs'

const PROBLEM_ID = /^putnam_\d{4}_[ab][1-6]$/u
const HLE_PROBLEM_ID = /^hle_[a-f0-9]{24}$/u
const DEFAULT_TRACE_MAXIMUM_BYTES = 64 * 1024 * 1024
const MINIMUM_TRACE_MAXIMUM_BYTES = 128
const MAXIMUM_TRACE_BYTES = 64 * 1024 * 1024
const TRACE_READ_CHUNK_BYTES = 64 * 1024
const MAXIMUM_INFRASTRUCTURE_RETRY_DELAY_MS = 60_000
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

const DEFAULT_RUNTIME = Object.freeze({
  acquireGatewayEgressLease,
  startModelGateway,
  modelGatewayOptions: async () => Object.freeze({
    startOptions: Object.freeze({}),
    cleanup: async () => {},
  }),
  buildSolverSandboxInvocation,
  buildHarnessInvocation,
  prepareTask,
  runHarnessSolver,
  verifyTask,
})

function assertId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new ProtocolError(`${name} 非法`)
  }
}

function assertInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`${name} 必须是 ${minimum}..${maximum} 的整数`)
  }
}

function assertRuntime(runtime) {
  const merged = { ...DEFAULT_RUNTIME, ...(runtime ?? {}) }
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value !== 'function') throw new ProtocolError(`Partition runtime.${name} 必须是函数`)
  }
  return merged
}

function infrastructureRetryDelay(baseDelayMs, retryNumber) {
  if (baseDelayMs === 0) return 0
  const exponential = Math.min(
    MAXIMUM_INFRASTRUCTURE_RETRY_DELAY_MS,
    baseDelayMs * (2 ** Math.max(0, retryNumber - 1)),
  )
  const jitter = Math.floor(Math.random() * (baseDelayMs + 1))
  return Math.min(MAXIMUM_INFRASTRUCTURE_RETRY_DELAY_MS, exponential + jitter)
}

async function waitBeforeInfrastructureRetry({
  baseDelayMs,
  retryNumber,
  phase,
  signal,
  trace,
}) {
  const delayMs = infrastructureRetryDelay(baseDelayMs, retryNumber)
  trace.add(`${JSON.stringify({
    infrastructureRetry: retryNumber,
    phase,
    delayMs,
  })}\n`)
  if (delayMs > 0) await sleep(delayMs, undefined, { signal })
}

async function walk(directory, callback) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const stat = await lstat(path)
    await callback(path, stat)
    if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(path, callback)
  }
}

async function grantTaskAccess(directory, uid, gid) {
  if (uid === undefined && gid === undefined) return
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new ProtocolError('Solver uid/gid 必须同时是正整数')
  }
  await chown(directory, uid, gid)
  await chmod(directory, 0o700)
  await walk(directory, async (path, stat) => {
    if (stat.isSymbolicLink()) return
    await chown(path, uid, gid)
    await chmod(path, stat.isDirectory() ? 0o700 : (stat.mode & 0o111 ? 0o700 : 0o600))
  })
}

function utf8Prefix(value, maximumBytes) {
  if (maximumBytes <= 0) return ''
  if (Buffer.byteLength(value) <= maximumBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    let end = middle
    if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1
    if (Buffer.byteLength(value.slice(0, end)) <= maximumBytes) low = middle
    else high = middle - 1
  }
  let end = low
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maximumBytes) end -= 1
  return value.slice(0, end)
}

class TraceAccumulator {
  constructor(maximumBytes) {
    assertInteger(maximumBytes, 'traceMaximumBytes', MINIMUM_TRACE_MAXIMUM_BYTES, MAXIMUM_TRACE_BYTES)
    this.maximumBytes = maximumBytes
    this.parts = []
    this.bytes = 0
    this.truncated = false
  }

  get remainingBytes() {
    return Math.max(0, this.maximumBytes - this.bytes)
  }

  add(value) {
    if (this.truncated) return false
    const text = String(value)
    const byteLength = Buffer.byteLength(text)
    if (byteLength <= this.remainingBytes) {
      this.parts.push(text)
      this.bytes += byteLength
      return true
    }
    const prefix = utf8Prefix(text, this.remainingBytes)
    if (prefix.length > 0) {
      this.parts.push(prefix)
      this.bytes += Buffer.byteLength(prefix)
    }
    this.truncated = true
    return false
  }

  markTruncated() {
    this.truncated = true
  }

  finish() {
    let text = this.parts.join('')
    if (!this.truncated) return text
    const marker = `${JSON.stringify({ traceTruncated: true, maximumBytes: this.maximumBytes })}\n`
    const markerBytes = Buffer.byteLength(marker)
    text = utf8Prefix(text, Math.max(0, this.maximumBytes - markerBytes))
    return `${text}${marker}`
  }

  clear() {
    this.parts.fill('')
    this.parts.length = 0
    this.bytes = 0
  }
}

async function appendJsonlFiles(root, accumulator) {
  const visit = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return true
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (accumulator.truncated) return false
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!await visit(path)) return false
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const header = `${JSON.stringify({ traceFile: relative(root, path) })}\n`
      if (!accumulator.add(header)) return false

      const decoder = new StringDecoder('utf8')
      const handle = await open(path, 'r')
      let position = 0
      try {
        while (position < stat.size) {
          if (accumulator.remainingBytes === 0) {
            accumulator.markTruncated()
            return false
          }
          const length = Math.min(TRACE_READ_CHUNK_BYTES, stat.size - position, accumulator.remainingBytes)
          const buffer = Buffer.allocUnsafe(length)
          const { bytesRead } = await handle.read(buffer, 0, length, position)
          if (bytesRead === 0) break
          position += bytesRead
          if (!accumulator.add(decoder.write(buffer.subarray(0, bytesRead)))) return false
        }
        if (position < stat.size) {
          accumulator.markTruncated()
          return false
        }
        if (!accumulator.add(decoder.end())) return false
        const finalStat = await handle.stat()
        if (finalStat.size > stat.size) {
          accumulator.markTruncated()
          return false
        }
      } finally {
        await handle.close()
      }
    }
    return true
  }
  await visit(root)
}

/** Collect JSONL traces with an exact UTF-8 byte ceiling, including metadata. */
export async function collectJsonl(root, maximumBytes = DEFAULT_TRACE_MAXIMUM_BYTES) {
  const accumulator = new TraceAccumulator(maximumBytes)
  await appendJsonlFiles(resolve(root), accumulator)
  const text = accumulator.finish()
  accumulator.clear()
  return text
}

function usageFromAudits(audits, gateway, verifier) {
  const totalRequests = gateway.stats?.().totalRequests
  const verifierUsage = verifier?.usage ?? {}
  const usage = {
    requests: (Number.isSafeInteger(totalRequests) ? totalRequests : audits.length)
      + (verifierUsage.requests ?? 0),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
  for (const audit of audits) {
    usage.inputTokens += audit.usage?.inputTokens ?? 0
    usage.outputTokens += audit.usage?.outputTokens ?? 0
    usage.totalTokens += audit.usage?.totalTokens ?? 0
  }
  usage.inputTokens += verifierUsage.inputTokens ?? 0
  usage.outputTokens += verifierUsage.outputTokens ?? 0
  usage.totalTokens += verifierUsage.totalTokens ?? 0
  return usage
}

function normalizeRecord({
  problemId,
  solver,
  verifier,
  attempts,
  verifierAttempts,
  usage,
  latencyMs,
  traceRef,
}) {
  const verified = verifier?.status === 'verified'
  const cancelled = solver.failureKind === 'cancelled' || verifier?.failureKind === 'cancelled'
  const infrastructure = solver.failureKind === 'infrastructure'
    || verifier?.failureKind === 'infrastructure'
  return {
    instanceId: problemId,
    status: verified
      ? 'resolved'
      : cancelled
        ? 'not_attempted'
        : infrastructure
          ? 'error'
          : solver.status === 'timeout'
            ? 'timeout'
            : 'unresolved',
    failureKind: cancelled ? 'cancelled' : infrastructure ? 'infrastructure' : verified ? null : 'candidate',
    solverStatus: solver.status,
    verifierStatus: verifier?.status ?? 'not_attempted',
    attempts,
    verifierAttempts,
    usage,
    latencyMs,
    traceRef,
  }
}

function remainingGatewayRequests(gateway) {
  const remaining = gateway.stats?.().remainingRequests
  return Number.isSafeInteger(remaining) ? remaining : Number.POSITIVE_INFINITY
}

function providerInfrastructureFailure(audits) {
  return isProviderInfrastructureAudit(audits.at(-1))
}

function classifyProviderFailure(solver, audits) {
  if (solver?.status === 'completed' || !providerInfrastructureFailure(audits)) return solver
  return {
    ...solver,
    status: 'infrastructure_error',
    failureKind: 'infrastructure',
    reasonCode: 'model_provider_failure',
  }
}

async function runOneTask(options, problemId, opaqueRunRoot) {
  const audits = []
  const dummyKey = `rsi-${randomBytes(24).toString('base64url')}`
  let gateway
  let gatewayLease
  let gatewayBinding
  const trace = new TraceAccumulator(options.traceMaximumBytes)
  let lastSolver
  let lastVerifier
  let taskId
  let solverAttempts = 0
  let verifierAttempts = 0
  let solverInfrastructureRetries = 0
  let verifierInfrastructureRetries = 0
  let latencyMs = 0
  try {
    await mkdir(opaqueRunRoot, { recursive: true, mode: 0o711 })
    await chmod(opaqueRunRoot, 0o711)
    gatewayBinding = await options.runtime.modelGatewayOptions({
      scratchRoot: options.scratchRoot,
      opaqueRunRoot,
      problemId,
      solverUid: options.solverUid,
      solverGid: options.solverGid,
    })
    if (!gatewayBinding || typeof gatewayBinding !== 'object' || Array.isArray(gatewayBinding)
        || !gatewayBinding.startOptions || typeof gatewayBinding.startOptions !== 'object'
        || Array.isArray(gatewayBinding.startOptions)
        || typeof gatewayBinding.cleanup !== 'function') {
      throw new ProtocolError('Partition model gateway binding 无效')
    }
    gateway = await options.runtime.startModelGateway({
      upstreamBaseUrl: options.upstreamBaseUrl,
      getApiKey: options.getApiKey,
      trustedModel: options.gatewayModel,
      trustedReasoningEffort: options.gatewayReasoningEffort,
      candidateApiKey: dummyKey,
      maxRequests: options.maximumModelRequestsPerTask,
      maxConcurrency: options.maximumGatewayConcurrencyPerTask,
      maxOutputTokens: options.maximumResponseTokens,
      requestTimeoutMs: options.gatewayRequestTimeoutMs,
      audit: (record) => { audits.push(record) },
      ...gatewayBinding.startOptions,
    })
    if (options.sandboxed) {
      gatewayLease = await options.runtime.acquireGatewayEgressLease({
        gatewayUrl: gateway.url,
        uid: options.solverUid,
      })
      if (!gatewayLease || typeof gatewayLease.release !== 'function') {
        throw new ProtocolError('Solver gateway egress lease 无效')
      }
    }

    while (true) {
      solverAttempts += 1
      const attemptRoot = join(opaqueRunRoot, `attempt-${solverAttempts}-${randomUUID()}`)
      const tasks = join(attemptRoot, 'work')
      const trusted = join(attemptRoot, 'trusted')
      try {
        await mkdir(attemptRoot, { mode: 0o711 })
        await chmod(attemptRoot, 0o711)
        await mkdir(tasks, { recursive: true, mode: 0o711 })
        await chmod(tasks, 0o711)
        await mkdir(trusted, { recursive: true, mode: 0o700 })
        await chmod(trusted, 0o700)
        const task = await options.runtime.prepareTask({
          solutionsRoot: options.solutionsRoot,
          problemId,
          taskRoot: tasks,
          trustedRoot: trusted,
        })
        taskId = task.taskId
        const dshHome = join(task.workdir, '.dsh')
        const sessionRoot = join(task.workdir, '.sessions')
        await Promise.all([
          mkdir(dshHome, { recursive: true, mode: 0o700 }),
          mkdir(sessionRoot, { recursive: true, mode: 0o700 }),
        ])
        await grantTaskAccess(task.workdir, options.solverUid, options.solverGid)
        const rawInvocation = options.runtime.buildHarnessInvocation({
          candidateRoot: options.candidateRoot,
          nodePath: options.nodePath,
          patchPath: options.patchPath,
          dshHome,
          sessionRoot,
          workdir: task.workdir,
          prompt: task.prompt,
          gatewayBaseUrl: gateway.url,
          gatewaySocketPath: gateway.socketPath,
          gatewayDummyKey: dummyKey,
          leanRoot: options.leanRoot,
          baseEnvironment: options.baseEnvironment,
          preset: options.preset,
        })
        const invocation = options.sandboxed
          ? options.runtime.buildSolverSandboxInvocation({
              invocation: rawInvocation,
              candidateRoot: options.candidateRoot,
              workdir: task.workdir,
              leanRoot: options.leanRoot,
              nodePath: options.nodePath,
              lakePath: options.lakePath,
              patchPath: options.patchPath,
              solverUid: options.solverUid,
              solverGid: options.solverGid,
              bwrapPath: options.bwrapPath,
              setprivPath: options.setprivPath,
              gatewaySocketPath: gateway.socketPath,
            })
          : rawInvocation
        const attemptAuditStart = audits.length
        lastSolver = await options.runtime.runHarnessSolver({
          invocation,
          sandboxed: options.sandboxed,
          timeoutMs: options.taskTimeoutMs,
          signal: options.signal,
        })
        lastSolver = classifyProviderFailure(lastSolver, audits.slice(attemptAuditStart))
        latencyMs += lastSolver.timing.durationMs
        trace.add(`${JSON.stringify({ solverAttempt: solverAttempts, solver: lastSolver })}\n`)
        await appendJsonlFiles(sessionRoot, trace)

        if (lastSolver.status !== 'completed') {
          const retryable = lastSolver.failureKind === 'infrastructure'
            && solverInfrastructureRetries < options.infrastructureRetries
            && remainingGatewayRequests(gateway) > 0
          if (retryable) {
            solverInfrastructureRetries += 1
            await waitBeforeInfrastructureRetry({
              baseDelayMs: options.infrastructureRetryBaseDelayMs,
              retryNumber: solverInfrastructureRetries,
              phase: 'solver',
              signal: options.signal,
              trace,
            })
            continue
          }
          if (lastSolver.failureKind === 'infrastructure' && remainingGatewayRequests(gateway) === 0) {
            trace.add(`${JSON.stringify({ retryStopped: 'model_request_budget_exhausted' })}\n`)
          }
          break
        }

        while (true) {
          verifierAttempts += 1
          lastVerifier = await options.runtime.verifyTask({
            editablePath: task.editablePath,
            trustedPath: task.trustedPath,
            verificationRoot: join(attemptRoot, 'verify'),
            leanRoot: options.leanRoot,
            lakePath: options.lakePath,
            baseEnvironment: options.baseEnvironment,
            verifierUid: options.verifierUid,
            verifierGid: options.verifierGid,
            bwrapPath: options.bwrapPath,
            setprivPath: options.setprivPath,
            signal: options.signal,
            timeoutMs: options.verifierTimeoutMs,
          })
          latencyMs += lastVerifier.timing.durationMs
          trace.add(`${JSON.stringify({ verifierAttempt: verifierAttempts, verifier: lastVerifier })}\n`)
          if (lastVerifier.failureKind !== 'infrastructure'
              || verifierInfrastructureRetries >= options.infrastructureRetries) break
          verifierInfrastructureRetries += 1
          await waitBeforeInfrastructureRetry({
            baseDelayMs: options.infrastructureRetryBaseDelayMs,
            retryNumber: verifierInfrastructureRetries,
            phase: 'verifier',
            signal: options.signal,
            trace,
          })
        }
        break
      } finally {
        await rm(attemptRoot, { recursive: true, force: true })
      }
    }

    const traceText = trace.finish()
    const traceRef = await options.onTrace({
      problemId,
      taskId,
      sealed: options.sealed,
      text: traceText,
    })
    if (typeof traceRef !== 'string' || traceRef.length === 0) {
      throw new ProtocolError('Partition onTrace 必须返回非空 traceRef')
    }
    trace.clear()
    return normalizeRecord({
      problemId,
      solver: lastSolver,
      verifier: lastVerifier,
      attempts: solverAttempts,
      verifierAttempts,
      usage: usageFromAudits(audits, gateway, lastVerifier),
      latencyMs,
      traceRef,
    })
  } finally {
    trace.clear()
    try {
      if (gatewayLease) await gatewayLease.release()
    } finally {
      try {
        if (gateway) await gateway.close()
      } finally {
        try {
          if (gatewayBinding) await gatewayBinding.cleanup()
        } finally {
          await rm(opaqueRunRoot, { recursive: true, force: true })
        }
      }
    }
  }
}

function partitionUsage(records) {
  return records.reduce((total, record) => ({
    requests: total.requests + record.usage.requests,
    inputTokens: total.inputTokens + record.usage.inputTokens,
    outputTokens: total.outputTokens + record.usage.outputTokens,
    totalTokens: total.totalTokens + record.usage.totalTokens,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
}

export async function runPartition({
  candidateId,
  instanceIds,
  candidateRoot,
  solutionsRoot,
  leanRoot,
  scratchRoot,
  nodePath,
  lakePath = 'lake',
  patchPath,
  upstreamBaseUrl,
  getApiKey,
  gatewayModel = 'gpt-5.6-sol',
  gatewayReasoningEffort = 'max',
  baseEnvironment = process.env,
  preset = 'standard',
  benchmark = 'putnambench-lean',
  concurrency = 8,
  maximumModelRequestsPerTask = 16,
  maximumResponseTokens = 32768,
  maximumGatewayConcurrencyPerTask = 4,
  taskTimeoutMs = 30 * 60 * 1000,
  verifierTimeoutMs = 5 * 60 * 1000,
  gatewayRequestTimeoutMs = 10 * 60 * 1000,
  partitionTimeoutMs,
  infrastructureRetries = 2,
  infrastructureRetryBaseDelayMs = 3_000,
  traceMaximumBytes = DEFAULT_TRACE_MAXIMUM_BYTES,
  solverUid,
  solverGid,
  verifierUid,
  verifierGid,
  bwrapPath = '/usr/bin/bwrap',
  setprivPath = '/usr/bin/setpriv',
  onTrace = async ({ taskId }) => `trace://${taskId}`,
  onRecord = async () => {},
  onProgress = () => {},
  sealed = false,
  signal,
  runtime,
}) {
  assertId(candidateId, 'candidateId')
  if (!Array.isArray(instanceIds) || instanceIds.length === 0 || new Set(instanceIds).size !== instanceIds.length) {
    throw new ProtocolError('Partition instanceIds 必须是非空且唯一的数组')
  }
  for (const instanceId of instanceIds) {
    const pattern = benchmark === 'putnambench-lean'
      ? PROBLEM_ID
      : benchmark === 'hle-text-math'
        ? HLE_PROBLEM_ID
        : null
    if (!pattern) throw new ProtocolError(`未知 Partition benchmark：${String(benchmark)}`)
    if (!pattern.test(instanceId)) throw new ProtocolError(`非法 ${benchmark} instanceId：${String(instanceId)}`)
  }
  assertInteger(concurrency, 'Partition concurrency', 1, 64)
  if (maximumModelRequestsPerTask !== null) {
    assertInteger(maximumModelRequestsPerTask, 'maximumModelRequestsPerTask', 1, 64)
  }
  if (maximumResponseTokens !== null) {
    assertInteger(maximumResponseTokens, 'maximumResponseTokens', 8192, 32768)
  }
  if (maximumGatewayConcurrencyPerTask !== null) {
    assertInteger(maximumGatewayConcurrencyPerTask, 'maximumGatewayConcurrencyPerTask', 1, 16)
  }
  assertInteger(infrastructureRetries, 'infrastructureRetries', 0, 5)
  assertInteger(
    infrastructureRetryBaseDelayMs,
    'infrastructureRetryBaseDelayMs',
    0,
    MAXIMUM_INFRASTRUCTURE_RETRY_DELAY_MS,
  )
  assertInteger(traceMaximumBytes, 'traceMaximumBytes', MINIMUM_TRACE_MAXIMUM_BYTES, MAXIMUM_TRACE_BYTES)
  assertInteger(taskTimeoutMs, 'taskTimeoutMs', 60_000, 7_200_000)
  assertInteger(verifierTimeoutMs, 'verifierTimeoutMs', 30_000, 1_800_000)
  assertInteger(gatewayRequestTimeoutMs, 'gatewayRequestTimeoutMs', 30_000, 1_800_000)
  if (partitionTimeoutMs !== undefined) {
    assertInteger(partitionTimeoutMs, 'partitionTimeoutMs', 60_000, 7_200_000)
  }
  if (typeof getApiKey !== 'function') throw new ProtocolError('Partition getApiKey 必须是函数')
  if (typeof gatewayModel !== 'string' || !MODEL_ID_PATTERN.test(gatewayModel)) {
    throw new ProtocolError('Partition gatewayModel 不是合法模型标识')
  }
  if (!REASONING_EFFORTS.has(gatewayReasoningEffort)) {
    throw new ProtocolError('Partition gatewayReasoningEffort 无效')
  }
  if (typeof onTrace !== 'function') throw new ProtocolError('Partition onTrace 必须是函数')
  if (typeof onRecord !== 'function') throw new ProtocolError('Partition onRecord 必须是函数')
  if (typeof onProgress !== 'function') throw new ProtocolError('Partition onProgress 必须是函数')
  if (typeof sealed !== 'boolean') throw new ProtocolError('Partition sealed 必须是布尔值')
  const sandboxIdentities = [solverUid, solverGid, verifierUid, verifierGid]
  const sandboxed = sandboxIdentities.some((value) => value !== undefined)
  if (sandboxed && sandboxIdentities.some((value) => value === undefined)) {
    throw new ProtocolError('Production sandbox 必须同时提供 Solver 与 Verifier uid/gid')
  }
  if (sandboxed && sandboxIdentities.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new ProtocolError('Solver/Verifier uid/gid 必须是正整数')
  }
  if (sandboxed && (solverUid === verifierUid || solverGid === verifierGid)) {
    throw new ProtocolError('Solver 与 Verifier 必须使用不同 uid/gid')
  }
  if (sandboxed && (!isAbsolute(bwrapPath) || !isAbsolute(setprivPath))) {
    throw new ProtocolError('bwrapPath/setprivPath 必须是绝对路径')
  }
  if (signal?.aborted) throw new PartitionAbortedError(0, instanceIds.length)
  const deadlineController = partitionTimeoutMs === undefined ? null : new AbortController()
  let deadlineExpired = false
  const deadlineTimer = deadlineController === null ? null : setTimeout(() => {
    deadlineExpired = true
    deadlineController.abort()
  }, partitionTimeoutMs)
  deadlineTimer?.unref?.()
  const activeSignal = deadlineController === null
    ? signal
    : signal === undefined
      ? deadlineController.signal
      : AbortSignal.any([signal, deadlineController.signal])
  const activeRuntime = assertRuntime(runtime)
  const taskOptions = {
    runtime: activeRuntime,
    scratchRoot: resolve(scratchRoot),
    candidateRoot: resolve(candidateRoot),
    solutionsRoot: resolve(solutionsRoot),
    leanRoot: resolve(leanRoot),
    nodePath: resolve(nodePath),
    lakePath,
    patchPath: resolve(patchPath),
    upstreamBaseUrl,
    getApiKey,
    gatewayModel,
    gatewayReasoningEffort,
    baseEnvironment,
    preset,
    maximumModelRequestsPerTask,
    maximumResponseTokens,
    maximumGatewayConcurrencyPerTask,
    taskTimeoutMs,
    verifierTimeoutMs,
    gatewayRequestTimeoutMs,
    infrastructureRetries,
    infrastructureRetryBaseDelayMs,
    traceMaximumBytes,
    solverUid,
    solverGid,
    verifierUid,
    verifierGid,
    bwrapPath,
    setprivPath,
    sandboxed,
    onTrace,
    sealed,
    signal: activeSignal,
  }
  const runRoot = join(resolve(scratchRoot), `run-${randomUUID()}`)
  await mkdir(runRoot, { recursive: true, mode: 0o711 })
  await chmod(runRoot, 0o711)
  const records = new Array(instanceIds.length)
  let nextIndex = 0
  let completed = 0
  let completionCallbacks = Promise.resolve()
  const emitCompletion = (record, event) => {
    completionCallbacks = completionCallbacks.then(async () => {
      await onRecord(record)
      await onProgress(Object.freeze(event))
    })
    return completionCallbacks
  }
  const workers = Array.from({ length: Math.min(concurrency, instanceIds.length) }, async () => {
    while (true) {
      if (activeSignal?.aborted) return
      const index = nextIndex
      nextIndex += 1
      if (index >= instanceIds.length) return
      const problemId = instanceIds[index]
      const opaqueTaskRoot = join(runRoot, `job-${randomUUID()}`)
      records[index] = await runOneTask(taskOptions, problemId, opaqueTaskRoot)
      if (records[index].failureKind === 'cancelled') return
      completed += 1
      const checkpoint = structuredClone(records[index])
      Object.freeze(checkpoint.usage)
      await emitCompletion(Object.freeze(checkpoint), sealed
        ? { type: 'sealed-task-complete', completed, total: instanceIds.length }
        : {
            type: 'validation-task-complete',
            problemId,
            status: records[index].status,
            completed,
            total: instanceIds.length,
          })
    }
  })

  let settlements
  try {
    settlements = await Promise.allSettled(workers)
    await completionCallbacks.catch(() => {})
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer)
    await rm(runRoot, { recursive: true, force: true })
  }
  const workerErrors = settlements
    .filter((settlement) => settlement.status === 'rejected')
    .map((settlement) => settlement.reason)
  if (deadlineExpired) {
    const completedRecords = records.filter((record) => record && record.failureKind !== 'cancelled').length
    throw new PartitionDeadlineError(completedRecords, records.length, partitionTimeoutMs)
  }
  if (signal?.aborted || workerErrors.some((error) => error instanceof PartitionAbortedError
      || error?.code === 'COMMAND_ABORTED' || error?.name === 'AbortError')) {
    const completedRecords = records.filter((record) => record && record.failureKind !== 'cancelled').length
    throw new PartitionAbortedError(completedRecords, records.length)
  }
  const protocolFailure = workerErrors.find((error) => error instanceof ProtocolError)
  if (protocolFailure) throw protocolFailure
  if (workerErrors.length > 0) {
    throw new InfrastructurePartitionError(workerErrors.length, records.length, { cause: workerErrors[0] })
  }

  const cancelled = records.filter((record) => record.failureKind === 'cancelled').length
  if (cancelled > 0) throw new PartitionAbortedError(records.length - cancelled, records.length)
  const infrastructureErrors = records.filter((record) => record.status === 'error').length
  if (infrastructureErrors > 0) {
    throw new InfrastructurePartitionError(infrastructureErrors, records.length)
  }
  const verified = records.filter((record) => record.status === 'resolved').length
  return {
    summary: {
      candidateId,
      verified,
      total: records.length,
      completedAt: new Date().toISOString(),
      usage: partitionUsage(records),
    },
    records,
    traces: {},
  }
}

export class InfrastructurePartitionError extends Error {
  constructor(errorCount, total, options) {
    super(`Partition 有 ${errorCount}/${total} 个基础设施错误，结果未计分`, options)
    this.name = 'InfrastructurePartitionError'
    this.kind = 'infrastructure'
    this.errorCount = errorCount
    this.total = total
  }
}

export class PartitionAbortedError extends Error {
  constructor(completed, total) {
    super(`Partition 已取消（完成 ${completed}/${total}）`)
    this.name = 'PartitionAbortedError'
    this.kind = 'cancelled'
    this.completed = completed
    this.total = total
  }
}

export class PartitionDeadlineError extends Error {
  constructor(completed, total, timeoutMs) {
    super(`Partition 超过硬截止时间（完成 ${completed}/${total}，上限 ${timeoutMs}ms）`)
    this.name = 'PartitionDeadlineError'
    this.kind = 'infrastructure'
    this.completed = completed
    this.total = total
    this.timeoutMs = timeoutMs
  }
}
