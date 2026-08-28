import { constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'

import { diffModelUsage } from '../cowork-model-gateway.mjs'
import { normalizeRelativePath } from '../path-policy.mjs'
import { ProtocolError } from '../protocol.mjs'

export const MSA_COWORK_CONTAINER_PATHS = Object.freeze({
  candidate: '/candidate',
  environmentAssets: '/environment-assets',
  solverOutput: '/solver-output',
})

const MAXIMUM_ANSWER_BYTES = 1024 * 1024
const MAXIMUM_SOLVER_STEPS = 32
const MAXIMUM_TASK_TEXT_BYTES = 64 * 1024
const MAXIMUM_TRACE_BYTES = 16 * 1024 * 1024
const MAXIMUM_TRACE_LINES = 20_000
const FULL_GIT_SHA = /^[0-9a-f]{40}$/u

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new ProtocolError(`${label} 必须是安全的非空字符串`)
  }
  return value.trim()
}

function taskText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError(`${label} 必须是非空字符串`)
  }
  if (value.includes('\u0000')) {
    throw new ProtocolError(`${label} 不能包含 NUL 字符`)
  }
  if (Buffer.byteLength(value, 'utf8') > MAXIMUM_TASK_TEXT_BYTES) {
    throw new ProtocolError(`${label} 超过 ${MAXIMUM_TASK_TEXT_BYTES} 字节上限`)
  }
  return value.trim()
}

function safeContainerWorkspace(value) {
  const workspace = requiredText(value, 'MSA Solver containerWorkspace')
  if (
    !workspace.startsWith('/')
    || workspace === '/'
    || posix.normalize(workspace) !== workspace
    || workspace.includes(':')
    || workspace.includes(',')
  ) {
    throw new ProtocolError('MSA Solver containerWorkspace 必须是安全的容器绝对路径')
  }
  for (const reserved of Object.values(MSA_COWORK_CONTAINER_PATHS)) {
    if (workspace === reserved || workspace.startsWith(`${reserved}/`) || reserved.startsWith(`${workspace}/`)) {
      throw new ProtocolError(`MSA Solver containerWorkspace 与保留挂载冲突：${workspace}`)
    }
  }
  if (['/tmp', '/run'].some((root) => workspace === root || workspace.startsWith(`${root}/`))) {
    throw new ProtocolError(`MSA Solver containerWorkspace 与私有 tmpfs 冲突：${workspace}`)
  }
  return workspace
}

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))
}

function assertDisjoint(paths) {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (isInside(paths[left].path, paths[right].path) || isInside(paths[right].path, paths[left].path)) {
        throw new ProtocolError(`${paths[left].label} 与 ${paths[right].label} 必须彼此隔离`)
      }
    }
  }
}

async function existingDirectory(pathValue, label) {
  let actual
  try {
    actual = await realpath(resolve(pathValue))
  } catch (error) {
    throw new ProtocolError(`${label} 不存在`, [error.message])
  }
  const handle = await open(actual, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    .catch((error) => {
      throw new ProtocolError(`${label} 必须是真实目录`, [error.message])
    })
  await handle.close()
  return actual
}

async function emptyOutputDirectory(pathValue) {
  await mkdir(resolve(pathValue), { recursive: true, mode: 0o700 })
  const actual = await existingDirectory(pathValue, 'MSA Solver Session 输出目录')
  const entries = await readdir(actual)
  if (entries.length > 0) {
    throw new ProtocolError('MSA Solver Session 输出目录在运行前必须为空', entries)
  }
  return actual
}

async function readBoundedRegularFile(pathValue, label, maximumBytes) {
  let handle
  try {
    handle = await open(pathValue, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('不是独立普通文件')
    if (info.size === 0) throw new Error('文件为空')
    if (info.size > maximumBytes) throw new Error(`文件超过 ${maximumBytes} 字节上限`)
    return (await handle.readFile()).toString('utf8')
  } catch (error) {
    throw new ProtocolError(`${label} 不安全或不可读`, [error.message])
  } finally {
    await handle?.close().catch(() => {})
  }
}

function validateTrace(text) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  if (lines.length === 0 || lines.length > MAXIMUM_TRACE_LINES) {
    throw new ProtocolError('MSA Solver Trace 行数无效')
  }
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('事件不是 JSON 对象')
    } catch (error) {
      throw new ProtocolError(`MSA Solver Trace 第 ${index + 1} 行无效`, [error.message])
    }
  }
  return `${lines.join('\n')}\n`
}

function redactExactSecret(text, secret) {
  if (typeof secret !== 'string' || secret.length < 8) return text
  return text.replaceAll(secret, '[REDACTED]')
}

function validateModel({ model, provider }) {
  if (!model || typeof model !== 'object' || model.provider !== provider.id) {
    throw new ProtocolError('MSA Solver Model 与 Provider Adapter 不匹配')
  }
  if (!provider.models.some((entry) => entry.id === model.model)) {
    throw new ProtocolError(`MSA Solver Model 不在 Provider 固定目录中：${model.model}`)
  }
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) {
    throw new ProtocolError('MSA Solver maxTokens 必须是正整数')
  }
}

function modelGatewayAccess({ modelAccess, provider }) {
  if (!modelAccess || typeof modelAccess !== 'object') {
    throw new ProtocolError('MSA Solver 缺少 Model Gateway Access')
  }
  const baseUrl = modelAccess.environment?.[provider.credentials.baseUrlEnvironment]
  const dummyKey = modelAccess.secretEnvironment?.[provider.credentials.apiKeyEnvironment]
  if (typeof baseUrl !== 'string' || typeof dummyKey !== 'string') {
    throw new ProtocolError('Model Gateway 未提供 MSA Solver 所需的内部地址或一次性令牌')
  }
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch (error) {
    throw new ProtocolError('MSA Solver Model Gateway Base URL 无效', [error.message])
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProtocolError('MSA Solver 只接受无凭据的内部 HTTP Model Gateway URL')
  }
  const network = requiredText(modelAccess.network, 'MSA Solver Model Gateway Network')
  if (['host', 'bridge', 'none'].includes(network)) {
    throw new ProtocolError('MSA Solver 必须连接 Run 专属 internal network')
  }
  return { baseUrl, dummyKey, network }
}

function runtimeProfile(runtime) {
  return requiredText(runtime.profile ?? 'cowork', 'MSA Solver profile')
}

function runtimePython(runtime) {
  const command = requiredText(runtime.pythonCommand ?? 'python3', 'MSA Solver pythonCommand')
  if (command.startsWith('-') || !/^(?:\/[a-zA-Z0-9._-]+)+$|^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(command)) {
    throw new ProtocolError('MSA Solver pythonCommand 必须是单个安全的可执行文件名')
  }
  return command
}

function runtimeOutputFile(runtime, field, fallback, label) {
  const pathValue = normalizeRelativePath(runtime[field] ?? fallback, label)
  if (pathValue.includes('/')) {
    throw new ProtocolError(`${label} 必须是 Session 输出根目录下的单个文件名`)
  }
  return pathValue
}

function runtimeMaximumBytes(runtime, field, fallback, label) {
  const value = runtime[field] ?? fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolError(`${label} 必须是正整数`)
  return value
}

function runtimeMaximumSteps(runtime) {
  const value = runtime.maximumSteps ?? MAXIMUM_SOLVER_STEPS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_SOLVER_STEPS) {
    throw new ProtocolError(`MSA Solver maximumSteps 必须是 1..${MAXIMUM_SOLVER_STEPS} 的整数`)
  }
  return value
}

async function runtimeDefinitionDigest(repositoryRoot, dockerfile) {
  const pathValue = join(repositoryRoot, normalizeRelativePath(dockerfile, 'MSA Runtime Dockerfile'))
  let source
  try {
    source = await readFile(pathValue)
  } catch (error) {
    throw new ProtocolError('MSA Runtime Dockerfile 不可读', [error.message])
  }
  return createHash('sha256').update(source).digest('hex')
}

export async function ensureMsaMinimalCoworkRuntime({
  docker,
  runtime,
  repositoryRoot,
  sourceRevision,
  sourcePath,
  baseImage,
  baseImageIdentity = baseImage,
  tag,
}) {
  if (!FULL_GIT_SHA.test(sourceRevision)) throw new ProtocolError('MSA Source Revision 必须是完整 Git SHA')
  const image = requiredText(tag, 'MSA Solver 派生镜像 Tag')
  const normalizedSourcePath = normalizeRelativePath(sourcePath, 'MSA Source Path')
  const dockerfile = normalizeRelativePath(runtime.dockerfile, 'MSA Runtime Dockerfile')
  const definitionDigest = await runtimeDefinitionDigest(repositoryRoot, dockerfile)
  const labels = {
    'org.opencontainers.image.revision': sourceRevision,
    'io.harness-rsi.runtime': 'msa-minimal-cowork-v1',
    'io.harness-rsi.msa-source-path': normalizedSourcePath,
    'io.harness-rsi.runtime-definition-digest': definitionDigest,
    'io.harness-rsi.base-image-identity': requiredText(baseImageIdentity, 'MSA Base Image Identity'),
  }

  if (await docker.imageExists(image)) {
    const current = await Promise.all(Object.keys(labels).map((label) => docker.imageLabel(image, label)))
    if (current.every((value, index) => value === Object.values(labels)[index])) {
      return { image, built: false, definitionDigest }
    }
  }

  await docker.build({
    context: repositoryRoot,
    dockerfile: join(repositoryRoot, dockerfile),
    tag: image,
    buildArgs: {
      BASE_IMAGE: requiredText(baseImage, 'MSA Base Image'),
      MSA_SOURCE_REVISION: sourceRevision,
      MSA_SOURCE_PATH: normalizedSourcePath,
      MSA_RUNTIME_DEFINITION_DIGEST: definitionDigest,
      MSA_BASE_IMAGE_IDENTITY: labels['io.harness-rsi.base-image-identity'],
    },
    labels,
  })
  return { image, built: true, definitionDigest }
}

export async function runMsaMinimalCoworkSolver({
  docker,
  runtime,
  image,
  model,
  provider,
  candidateWorkspace,
  taskWorkspace,
  environmentAssets,
  sessionRoot,
  modelAccess,
  task,
  name,
  timeoutMs,
  containerWorkspace = '/workspace',
}) {
  validateModel({ model, provider })
  const gateway = modelGatewayAccess({ modelAccess, provider })
  const workspaceInContainer = safeContainerWorkspace(containerWorkspace)
  const [candidate, workspace, assets, output] = await Promise.all([
    existingDirectory(candidateWorkspace, 'MSA Candidate Workspace'),
    existingDirectory(taskWorkspace, 'MSA Task Workspace'),
    existingDirectory(environmentAssets, 'MSA Environment Assets'),
    emptyOutputDirectory(sessionRoot),
  ])
  assertDisjoint([
    { path: candidate, label: 'MSA Candidate Workspace' },
    { path: workspace, label: 'MSA Task Workspace' },
    { path: assets, label: 'MSA Environment Assets' },
    { path: output, label: 'MSA Solver Session 输出目录' },
  ])

  const answerFile = runtimeOutputFile(runtime, 'answerFile', 'answer.txt', 'MSA Solver answerFile')
  const traceFile = runtimeOutputFile(runtime, 'traceFile', 'agent.jsonl', 'MSA Solver traceFile')
  if (answerFile === traceFile) throw new ProtocolError('MSA Solver answerFile 与 traceFile 不能相同')
  const maximumAnswerBytes = runtimeMaximumBytes(
    runtime,
    'maximumAnswerBytes',
    MAXIMUM_ANSWER_BYTES,
    'MSA Solver maximumAnswerBytes',
  )
  const maximumTraceBytes = runtimeMaximumBytes(
    runtime,
    'maximumTraceBytes',
    MAXIMUM_TRACE_BYTES,
    'MSA Solver maximumTraceBytes',
  )
  const answerPath = join(output, answerFile)
  const tracePath = join(output, traceFile)
  const result = await docker.run({
    image: requiredText(image, 'MSA Solver Image'),
    name: requiredText(name, 'MSA Solver Container Name'),
    command: [
      runtimePython(runtime),
      `${MSA_COWORK_CONTAINER_PATHS.candidate}/run.py`,
      '--task', taskText(task, 'MSA Solver Task'),
      '--answer', `${MSA_COWORK_CONTAINER_PATHS.solverOutput}/${answerFile}`,
      '--trace', `${MSA_COWORK_CONTAINER_PATHS.solverOutput}/${traceFile}`,
      '--profile', runtimeProfile(runtime),
    ],
    workdir: workspaceInContainer,
    mounts: [
      { source: candidate, target: MSA_COWORK_CONTAINER_PATHS.candidate, readOnly: true },
      { source: workspace, target: workspaceInContainer, readOnly: false },
      { source: assets, target: MSA_COWORK_CONTAINER_PATHS.environmentAssets, readOnly: true },
      { source: output, target: MSA_COWORK_CONTAINER_PATHS.solverOutput, readOnly: false },
    ],
    environment: {
      HOME: '/tmp/home',
      TMPDIR: '/tmp',
      PYTHONDONTWRITEBYTECODE: '1',
      RSI_MODEL_GATEWAY_BASE_URL: gateway.baseUrl,
      RSI_MODEL_GATEWAY_MODEL: model.model,
      RSI_MODEL_GATEWAY_MAX_TOKENS: String(model.maxTokens),
      RSI_SOLVER_MAX_STEPS: String(runtimeMaximumSteps(runtime)),
      RSI_ENVIRONMENT_ASSETS_ROOT: MSA_COWORK_CONTAINER_PATHS.environmentAssets,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      NO_PROXY: modelAccess.environment?.NO_PROXY ?? 'localhost,127.0.0.1,::1',
      no_proxy: modelAccess.environment?.no_proxy ?? 'localhost,127.0.0.1,::1',
    },
    secretEnvironment: { RSI_MODEL_GATEWAY_DUMMY_KEY: gateway.dummyKey },
    inheritEnvironment: [],
    network: gateway.network,
    runAsCurrentUser: true,
    readOnlyRoot: true,
    capabilities: [],
    timeoutMs,
  })

  let answer = await readBoundedRegularFile(answerPath, 'MSA Solver Answer', maximumAnswerBytes)
  let trace = validateTrace(await readBoundedRegularFile(tracePath, 'MSA Solver Trace', maximumTraceBytes))
  answer = redactExactSecret(answer, gateway.dummyKey).trim()
  trace = redactExactSecret(trace, gateway.dummyKey)
  if (!answer) throw new ProtocolError('MSA Solver Answer 去除空白后为空')
  await Promise.all([
    writeFile(answerPath, `${answer}\n`, { encoding: 'utf8', mode: 0o600 }),
    writeFile(tracePath, trace, { encoding: 'utf8', mode: 0o600 }),
  ])
  return {
    answer,
    trace,
    stderr: redactExactSecret(result.stderr ?? '', gateway.dummyKey),
    durationMs: result.durationMs,
    outputTruncated: result.outputTruncated ?? false,
  }
}

function usageAccumulator() {
  return {
    complete: true,
    acceptedRequests: 0,
    usageResponses: 0,
    unknownUsageResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

function addUsage(total, delta) {
  total.complete &&= delta.complete
  for (const field of [
    'acceptedRequests',
    'usageResponses',
    'unknownUsageResponses',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'reasoningTokens',
  ]) total[field] += delta[field]
}

function publicUsage(total) {
  return {
    complete: total.complete,
    requests: total.acceptedRequests,
    usageResponses: total.usageResponses,
    unknownUsageResponses: total.unknownUsageResponses,
    inputTokens: total.complete ? total.inputTokens : null,
    outputTokens: total.complete ? total.outputTokens : null,
    totalTokens: total.complete ? total.inputTokens + total.outputTokens : null,
    observedInputTokens: total.inputTokens,
    observedOutputTokens: total.outputTokens,
    cacheReadTokens: total.complete ? total.cacheReadTokens : null,
    reasoningTokens: total.complete ? total.reasoningTokens : null,
  }
}

export function createMsaMinimalCoworkSolverDriver({
  target,
  provider,
  docker,
  repositoryRoot,
  sourceRevision,
  sourcePath,
  modelGateway,
}) {
  const measuredUsage = usageAccumulator()
  return {
    id: target.solver.protocol,
    cacheKey: `msa-${sourceRevision.slice(0, 12)}`,
    async ensureRuntime({ baseImage, baseImageIdentity, tag }) {
      return await ensureMsaMinimalCoworkRuntime({
        docker,
        runtime: target.solver.runtime,
        repositoryRoot,
        sourceRevision,
        sourcePath,
        baseImage,
        baseImageIdentity,
        tag,
      })
    },
    async run(options) {
      if (!modelGateway) throw new ProtocolError('MSA Solver 运行必须使用隔离 Model Gateway')
      const before = await modelGateway.usage('solver')
      let result
      let operationError
      try {
        result = await runMsaMinimalCoworkSolver({
          ...options,
          docker,
          runtime: target.solver.runtime,
          provider,
          modelAccess: await modelGateway.access('solver', {
            model: options.model.model,
            maxTokens: options.model.maxTokens,
            maxTokensField: provider.compatibility?.maxTokensField ?? 'max_tokens',
            reasoningEffort: options.model.reasoningEffort ?? null,
          }),
        })
      } catch (error) {
        operationError = error
      }
      try {
        const usage = diffModelUsage(before, await modelGateway.usage('solver'))
        addUsage(measuredUsage, usage)
        if (operationError) operationError.modelUsage = usage
        else result.modelUsage = usage
      } catch (error) {
        measuredUsage.complete = false
        if (!operationError) throw error
        operationError.details = [...(operationError.details ?? []), `Usage 计量失败：${error.message}`]
      }
      if (operationError) throw operationError
      return result
    },
    usage() {
      return publicUsage(measuredUsage)
    },
  }
}
