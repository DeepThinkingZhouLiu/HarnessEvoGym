import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { assertHleInstanceId } from './hle-dataset.mjs'
import {
  MODEL_GATEWAY_RELAY_URL,
  relayWrappedInvocation,
} from './model-gateway-relay.mjs'
import { runPartition as runGenericPartition } from './partition-runner.mjs'
import {
  buildHarnessInvocation as buildBaseHarnessInvocation,
  runHarnessSolver as runBaseHarnessSolver,
} from './putnambench-runner.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  SOLVER_SANDBOX_PATHS,
  buildBubblewrapInvocation,
  delegateDshConfinementToOuterSandbox,
  executableDistributionRoot,
} from './sandbox.mjs'

const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_ANSWER_BYTES = 1024 * 1024
const JUDGE_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const storePromises = new Map()
const HLE_GATEWAY_SANDBOX_ROOT = '/opt/harness-rsi/gateway'
const HLE_RELAY_SANDBOX_PATH = '/opt/harness-rsi/control/model-gateway-relay.mjs'

export class HleJudgeInfrastructureError extends Error {
  constructor(code, options) {
    super('HLE judge infrastructure failure', options)
    this.name = 'HleJudgeInfrastructureError'
    this.code = code
    this.kind = 'infrastructure'
  }
}

class HleAnswerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HleAnswerError'
    this.kind = 'candidate'
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function timing(startedMs, endedMs) {
  return {
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: Math.max(0, endedMs - startedMs),
  }
}

function verifierResult({ status, failureKind, reasonCode, startedMs, endedMs, usage }) {
  return {
    status,
    phase: 'verifier',
    failureKind,
    reasonCode,
    timing: timing(startedMs, endedMs),
    traceRef: null,
    ...(usage ? { usage } : {}),
  }
}

function judgeInfrastructureReason(error) {
  return error instanceof HleJudgeInfrastructureError
    ? error.code.toLowerCase()
    : 'judge_failure'
}

function validateStoredRecord(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`HLE private store row ${index} 必须是对象`)
  }
  assertHleInstanceId(value.instanceId)
  for (const field of ['sourceId', 'question', 'answer', 'answerType', 'rawSubject']) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new ProtocolError(`HLE private store row ${index}.${field} 无效`)
    }
  }
  if (!['exactMatch', 'multipleChoice'].includes(value.answerType) || value.category !== 'Math') {
    throw new ProtocolError(`HLE private store row ${index} schema 无效`)
  }
  return Object.freeze({ ...value })
}

async function readStore(recordsPath) {
  const stat = await lstat(recordsPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_SESSION_BYTES) {
    throw new ProtocolError('HLE private store 必须是有界的普通文件')
  }
  const text = await readFile(recordsPath, 'utf8')
  if (!text.endsWith('\n')) throw new ProtocolError('HLE private store 必须保留末尾换行')
  const rows = text.trimEnd().split(/\r?\n/u).map((line, index) => {
    try {
      return validateStoredRecord(JSON.parse(line), index + 1)
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(`HLE private store row ${index + 1} JSON 无效`)
    }
  })
  const byId = new Map(rows.map((row) => [row.instanceId, row]))
  if (byId.size !== rows.length) throw new ProtocolError('HLE private store 包含重复 instance ID')
  return byId
}

async function loadStore(root) {
  const path = join(resolve(root), 'records.jsonl')
  if (!storePromises.has(path)) {
    storePromises.set(path, readStore(path).catch((error) => {
      storePromises.delete(path)
      throw error
    }))
  }
  return storePromises.get(path)
}

export function buildHleSolverPrompt({ question, answerType }) {
  if (typeof question !== 'string' || question.trim().length === 0
      || !['exactMatch', 'multipleChoice'].includes(answerType)) {
    throw new ProtocolError('HLE solver prompt 参数无效')
  }
  return [
    'Solve the following text-only mathematics problem using your own reasoning.',
    'Restricted minimal mode: you may use only the sandboxed shell/Python and files you create inside the task workspace for scratch computation.',
    'External networking, web browsing, search engines, and asking another agent or the user for an answer are prohibited.',
    'Do not locate, read, or modify benchmark datasets, manifests, reference/gold answers, Controller/evaluator files, or any file outside the task workspace.',
    'Return exactly three labeled sections: `Explanation:`, `Answer:`, and `Confidence:`.',
    'The Answer line must contain only the final answer; Confidence must be a number from 0 to 100.',
    `Answer type: ${answerType}.`,
    '',
    question,
  ].join('\n')
}

export async function prepareHleTask({ solutionsRoot, problemId, taskRoot, trustedRoot }) {
  assertHleInstanceId(problemId)
  const store = await loadStore(solutionsRoot)
  const record = store.get(problemId)
  if (!record) throw new ProtocolError('HLE instance 不在冻结 partition store 中')
  await Promise.all([
    mkdir(resolve(taskRoot), { recursive: true, mode: 0o700 }),
    mkdir(resolve(trustedRoot), { recursive: true, mode: 0o700 }),
  ])
  const workdir = await mkdtemp(join(resolve(taskRoot), 'task-'))
  const taskId = basename(workdir)
  const editablePath = join(workdir, 'answer.txt')
  const trustedPath = join(resolve(trustedRoot), `${taskId}.json`)
  await writeFile(editablePath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await writeFile(trustedPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o400,
  })
  await chmod(trustedPath, 0o400)
  return {
    problemId,
    taskId,
    workdir,
    editablePath,
    trustedPath,
    prompt: buildHleSolverPrompt(record),
    templateSha256: sha256(record.question),
  }
}

export function buildHleHarnessInvocation(options) {
  const invocation = buildBaseHarnessInvocation(options)
  return {
    ...invocation,
    env: {
      ...invocation.env,
      RSI_BENCHMARK: 'hle-text-math',
      RSI_HLE_ANSWER_PATH: join(options.workdir, 'answer.txt'),
      ...(options.gatewaySocketPath === undefined
        ? {}
        : { RSI_MODEL_GATEWAY_SOCKET: options.gatewaySocketPath }),
    },
  }
}

async function jsonlPaths(root) {
  const output = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path)
    }
  }
  await visit(resolve(root))
  return output
}

function assistantText(event) {
  if (event?.type !== 'assistant/message' || !Array.isArray(event.data?.message?.content)) return null
  const blocks = event.data.message.content.filter((block) => (
    block?.type === 'text' && typeof block.text === 'string'
  ))
  return blocks.length === 0 ? null : blocks.map((block) => block.text).join('')
}

export async function extractFinalAssistantText(sessionRoot) {
  const roots = []
  for (const path of await jsonlPaths(sessionRoot)) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_BYTES) continue
    const text = await readFile(path, 'utf8')
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0)
    if (lines.length === 0) continue
    let header
    try { header = JSON.parse(lines[0]) } catch { continue }
    if (header?.type !== 'session' || header.parentSession !== undefined || header.origin === 'subagent') continue
    let finalText = null
    for (const line of lines.slice(1)) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      finalText = assistantText(event) ?? finalText
    }
    if (finalText !== null) roots.push({ createdAt: Number(header.createdAt) || 0, path, text: finalText })
  }
  roots.sort((left, right) => right.createdAt - left.createdAt || left.path.localeCompare(right.path))
  const answer = roots[0]?.text?.trim()
  if (!answer) throw new HleAnswerError('Harness 没有持久化 root assistant final answer')
  if (Buffer.byteLength(answer) > MAX_ANSWER_BYTES) throw new HleAnswerError('Harness final answer 超出上限')
  return answer
}

export async function runHleHarnessSolver(options) {
  const result = await runBaseHarnessSolver(options)
  if (result.status !== 'completed') return result
  try {
    // Bubblewrap rewrites environment paths to their guest mount points.  The
    // controller must inspect the host paths after the sandbox has exited.
    const sessionRoot = options.invocation.rsiHostSessionRoot
      ?? options.invocation.env.DSH_SESSION_ROOT
    const answerPath = options.invocation.rsiHostAnswerPath
      ?? options.invocation.env.RSI_HLE_ANSWER_PATH
    const answer = await extractFinalAssistantText(sessionRoot)
    await writeFile(answerPath, `${answer}\n`, {
      encoding: 'utf8', flag: 'w', mode: 0o600,
    })
    return result
  } catch (error) {
    if (!(error instanceof HleAnswerError)) throw error
    return {
      ...result,
      status: 'candidate_error',
      failureKind: 'candidate',
      reasonCode: 'missing_or_invalid_final_answer',
    }
  }
}

function responseOutputText(value) {
  if (typeof value?.output_text === 'string') return value.output_text
  const texts = []
  for (const item of value?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (['output_text', 'text'].includes(content?.type) && typeof content.text === 'string') {
        texts.push(content.text)
      }
    }
  }
  return texts.join('')
}

export function parseHleJudgeDecision(text) {
  if (typeof text !== 'string' || text.length > 64 * 1024) {
    throw new HleJudgeInfrastructureError('JUDGE_OUTPUT_INVALID')
  }
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let value
  try { value = JSON.parse(trimmed) } catch {
    throw new HleJudgeInfrastructureError('JUDGE_OUTPUT_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'correct')
      || typeof value.correct !== 'boolean') {
    throw new HleJudgeInfrastructureError('JUDGE_OUTPUT_INVALID')
  }
  return Object.freeze({ correct: value.correct })
}

function judgePrompt(record, response) {
  return [
    'Judge whether the candidate response gives the same final answer as the reference answer.',
    'Ignore differences in exposition. For multiple choice, compare the selected option. For exact-match answers, accept mathematically equivalent forms.',
    'Return only JSON with exactly one boolean field: {"correct":true} or {"correct":false}.',
    '',
    `Question:\n${record.question}`,
    `Reference answer:\n${record.answer}`,
    `Candidate response:\n${response}`,
  ].join('\n')
}

function endpoint(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch {
    throw new HleJudgeInfrastructureError('JUDGE_ENDPOINT_INVALID')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new HleJudgeInfrastructureError('JUDGE_ENDPOINT_INVALID')
  }
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/responses`
  return url
}

export async function callHleJudge({
  upstreamBaseUrl,
  getApiKey,
  record,
  response,
  model = 'gpt-5.6-sol',
  reasoningEffort = 'low',
  maximumOutputTokens = 1024,
  timeoutMs = 120_000,
  signal,
  fetchImpl = fetch,
}) {
  if (typeof getApiKey !== 'function' || typeof fetchImpl !== 'function'
      || typeof model !== 'string' || model.length === 0 || !JUDGE_EFFORTS.has(reasoningEffort)
      || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 64 || maximumOutputTokens > 4096
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new HleJudgeInfrastructureError('JUDGE_CONFIG_INVALID')
  }
  const requestSignal = signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let apiKey
  let result
  try {
    apiKey = await getApiKey()
    const responseValue = await fetchImpl(endpoint(upstreamBaseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        max_output_tokens: maximumOutputTokens,
        stream: false,
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: judgePrompt(record, response) }],
        }],
      }),
      signal: requestSignal,
    })
    if (!responseValue.ok) throw new HleJudgeInfrastructureError('JUDGE_UPSTREAM_REJECTED')
    result = await responseValue.json()
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof HleJudgeInfrastructureError) throw error
    throw new HleJudgeInfrastructureError('JUDGE_REQUEST_FAILED')
  } finally {
    apiKey = undefined
  }
  const decision = parseHleJudgeDecision(responseOutputText(result))
  const inputTokens = Number.isSafeInteger(result?.usage?.input_tokens) ? result.usage.input_tokens : 0
  const outputTokens = Number.isSafeInteger(result?.usage?.output_tokens) ? result.usage.output_tokens : 0
  const totalTokens = Number.isSafeInteger(result?.usage?.total_tokens)
    ? result.usage.total_tokens
    : inputTokens + outputTokens
  return Object.freeze({
    ...decision,
    usage: Object.freeze({ requests: 1, inputTokens, outputTokens, totalTokens }),
  })
}

export async function verifyHleTask({
  editablePath,
  trustedPath,
  judge,
  signal,
  now = Date.now,
}) {
  const startedMs = now()
  if (typeof judge !== 'function') throw new ProtocolError('HLE verifier judge 必须是函数')
  try {
    const [answerStat, trustedStat] = await Promise.all([lstat(editablePath), lstat(trustedPath)])
    if (!answerStat.isFile() || answerStat.isSymbolicLink() || answerStat.size > MAX_ANSWER_BYTES
        || !trustedStat.isFile() || trustedStat.isSymbolicLink() || trustedStat.size > MAX_SESSION_BYTES) {
      throw new ProtocolError('HLE verifier input 不是有界的普通文件')
    }
    const [response, recordText] = await Promise.all([
      readFile(editablePath, 'utf8'),
      readFile(trustedPath, 'utf8'),
    ])
    if (response.trim().length === 0) {
      return verifierResult({
        status: 'rejected', failureKind: 'candidate', reasonCode: 'empty_answer',
        startedMs, endedMs: now(),
      })
    }
    const record = validateStoredRecord(JSON.parse(recordText), 'trusted')
    const judged = await judge({ record, response: response.trim(), signal })
    return verifierResult({
      status: judged.correct ? 'verified' : 'rejected',
      failureKind: judged.correct ? null : 'candidate',
      reasonCode: judged.correct ? null : 'judge_rejected',
      startedMs,
      endedMs: now(),
      usage: judged.usage,
    })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      return verifierResult({
        status: 'aborted', failureKind: 'cancelled', reasonCode: 'aborted',
        startedMs, endedMs: now(),
      })
    }
    if (error?.kind === 'candidate') {
      return verifierResult({
        status: 'rejected', failureKind: 'candidate', reasonCode: 'invalid_answer',
        startedMs, endedMs: now(),
      })
    }
    return verifierResult({
      status: 'infrastructure_error',
      failureKind: 'infrastructure',
      reasonCode: judgeInfrastructureReason(error),
      startedMs, endedMs: now(),
    })
  }
}

export function buildHleSolverSandboxInvocation({
  invocation,
  candidateRoot,
  workdir,
  nodePath,
  patchPath,
  solverUid,
  solverGid,
  bwrapPath,
  setprivPath,
  gatewaySocketPath,
}) {
  if (typeof gatewaySocketPath !== 'string' || gatewaySocketPath.length === 0
      || invocation.env.RSI_MODEL_GATEWAY_SOCKET !== gatewaySocketPath) {
    throw new ProtocolError('HLE Solver 缺少可信 model gateway socket')
  }
  const hostSessionRoot = invocation.env.DSH_SESSION_ROOT
  const hostAnswerPath = invocation.env.RSI_HLE_ANSWER_PATH
  const nodeRoot = executableDistributionRoot(nodePath)
  const gatewayDirectory = dirname(resolve(gatewaySocketPath))
  const relaySourcePath = join(dirname(resolve(patchPath)), 'model-gateway-relay.mjs')
  const wrappedInvocation = relayWrappedInvocation({
    invocation: delegateDshConfinementToOuterSandbox(invocation),
    nodePath,
    relayPath: relaySourcePath,
    socketPath: gatewaySocketPath,
  })
  const sandboxed = buildBubblewrapInvocation({
    invocation: wrappedInvocation,
    uid: solverUid,
    gid: solverGid,
    bwrapPath,
    setprivPath,
    network: 'none',
    procMode: 'empty',
    hostname: 'rsi-hle-solver',
    mounts: [
      { source: candidateRoot, destination: SOLVER_SANDBOX_PATHS.candidate, readOnly: true },
      { source: patchPath, destination: SOLVER_SANDBOX_PATHS.runtimePatch, readOnly: true },
      {
        source: relaySourcePath,
        destination: HLE_RELAY_SANDBOX_PATH,
        readOnly: true,
      },
      {
        source: gatewayDirectory,
        destination: HLE_GATEWAY_SANDBOX_ROOT,
        readOnly: true,
      },
      ...(nodeRoot === null ? [] : [{
        source: nodeRoot, destination: SOLVER_SANDBOX_PATHS.nodeToolchain, readOnly: true,
      }]),
      { source: workdir, destination: SOLVER_SANDBOX_PATHS.workspace, readOnly: false },
    ],
  })
  return {
    ...sandboxed,
    // Controller-only metadata. These fields are not copied into the child
    // process environment, so the sandbox sees only /work paths.
    rsiHostSessionRoot: hostSessionRoot,
    rsiHostAnswerPath: hostAnswerPath,
  }
}

export function createHlePartitionRuntime({
  upstreamBaseUrl,
  getApiKey,
  judgeModel = 'gpt-5.6-sol',
  judgeReasoningEffort = 'low',
  judgeMaximumOutputTokens = 1024,
  judgeTimeoutMs = 120_000,
  gatewaySocketRoot = '/dev/shm',
  judge,
}) {
  const activeJudge = judge ?? (({ record, response, signal }) => callHleJudge({
    upstreamBaseUrl,
    getApiKey,
    record,
    response,
    signal,
    model: judgeModel,
    reasoningEffort: judgeReasoningEffort,
    maximumOutputTokens: judgeMaximumOutputTokens,
    timeoutMs: judgeTimeoutMs,
  }))
  return Object.freeze({
    prepareTask: prepareHleTask,
    buildHarnessInvocation: buildHleHarnessInvocation,
    runHarnessSolver: runHleHarnessSolver,
    verifyTask: (options) => verifyHleTask({ ...options, judge: activeJudge }),
    buildSolverSandboxInvocation: buildHleSolverSandboxInvocation,
    modelGatewayOptions: async ({ solverUid, solverGid }) => {
      if (!Number.isInteger(solverUid) || solverUid < 1
          || !Number.isInteger(solverGid) || solverGid < 1) {
        throw new ProtocolError('HLE gateway socket 需要 Solver uid/gid')
      }
      const root = await mkdtemp(join(resolve(gatewaySocketRoot), 'rsi-gw-'))
      await chmod(root, 0o711)
      let cleaned = false
      return Object.freeze({
        startOptions: Object.freeze({
          socketPath: join(root, 'gateway.sock'),
          publicUrl: MODEL_GATEWAY_RELAY_URL,
          socketUid: solverUid,
          socketGid: solverGid,
        }),
        cleanup: async () => {
          if (cleaned) return
          cleaned = true
          await rm(root, { recursive: true, force: true })
        },
      })
    },
    acquireGatewayEgressLease: async ({ gatewayUrl, uid }) => {
      if (gatewayUrl !== MODEL_GATEWAY_RELAY_URL || !Number.isInteger(uid) || uid < 1) {
        throw new ProtocolError('HLE isolated gateway lease 参数无效')
      }
      return Object.freeze({ release: async () => {} })
    },
  })
}

/** Sealed-broker-compatible entry point; every option remains JSON serializable. */
export async function runPartition(options) {
  const runtime = createHlePartitionRuntime(options)
  return runGenericPartition({
    ...options,
    benchmark: 'hle-text-math',
    runtime,
  })
}
