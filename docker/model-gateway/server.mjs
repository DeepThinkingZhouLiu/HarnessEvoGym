import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { pipeline, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

const listenPort = Number(process.env.GATEWAY_PORT ?? '8080')
const legacyToken = process.env.GATEWAY_TOKEN ?? ''
const controlToken = process.env.GATEWAY_CONTROL_TOKEN ?? ''
const initialSolverToken = process.env.GATEWAY_SOLVER_TOKEN ?? ''
const initialUpdaterToken = process.env.GATEWAY_UPDATER_TOKEN ?? ''
const apiKeyEnvironment = process.env.UPSTREAM_API_KEY_ENV ?? ''
const baseUrlEnvironment = process.env.UPSTREAM_BASE_URL_ENV ?? ''
const apiKey = process.env[apiKeyEnvironment] ?? ''
const rawBaseUrl = process.env[baseUrlEnvironment] ?? ''
const maximumRequests = Number(process.env.GATEWAY_MAX_REQUESTS ?? '512')
const maximumConcurrentRequests = Number(process.env.GATEWAY_MAX_CONCURRENT_REQUESTS ?? '8')
const maximumRequestBytes = 32 * 1024 * 1024

if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
  throw new Error('model-gateway: GATEWAY_PORT 必须是 1024-65535 的整数')
}
if (legacyToken.length < 32) throw new Error('model-gateway: GATEWAY_TOKEN 缺失或过短')
const roleIsolationEnabled = [controlToken, initialSolverToken, initialUpdaterToken].some(Boolean)
if (roleIsolationEnabled && [controlToken, initialSolverToken, initialUpdaterToken].some((value) => value.length < 32)) {
  throw new Error('model-gateway: Role Token 缺失或过短')
}
if (roleIsolationEnabled && new Set([legacyToken, controlToken, initialSolverToken, initialUpdaterToken]).size !== 4) {
  throw new Error('model-gateway: Gateway Token 必须彼此不同')
}
if (!apiKeyEnvironment || !apiKey) throw new Error('model-gateway: 上游 API Key 环境变量缺失')
if (!baseUrlEnvironment || !rawBaseUrl) throw new Error('model-gateway: 上游 Base URL 环境变量缺失')
if (!Number.isInteger(maximumRequests) || maximumRequests < 1) {
  throw new Error('model-gateway: GATEWAY_MAX_REQUESTS 必须是正整数')
}
if (!Number.isInteger(maximumConcurrentRequests) || maximumConcurrentRequests < 1) {
  throw new Error('model-gateway: GATEWAY_MAX_CONCURRENT_REQUESTS 必须是正整数')
}

const upstreamBase = new URL(rawBaseUrl)
if (!['http:', 'https:'].includes(upstreamBase.protocol)) {
  throw new Error('model-gateway: 上游 Base URL 只支持 HTTP(S)')
}
if (upstreamBase.username || upstreamBase.password || upstreamBase.search || upstreamBase.hash) {
  throw new Error('model-gateway: 上游 Base URL 不能包含凭据、Query 或 Fragment')
}

function tokenMatches(header, expectedToken) {
  const prefix = 'Bearer '
  if (!expectedToken || typeof header !== 'string' || !header.startsWith(prefix)) return false
  const supplied = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(expectedToken)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function authorizedPrincipal(header) {
  if (tokenMatches(header, controlToken)) return { role: 'control' }
  if (tokenMatches(header, roleTokens.get('solver'))) return { role: 'solver' }
  if (tokenMatches(header, roleTokens.get('updater'))) return { role: 'updater' }
  if (tokenMatches(header, legacyToken)) return { role: 'legacy' }
  return null
}

function upstreamUrl() {
  const basePath = upstreamBase.pathname.replace(/\/+$/u, '')
  return new URL(`${basePath}/chat/completions`, upstreamBase.origin)
}

const requestHeaderAllowlist = new Set([
  'accept',
  'content-length',
  'content-type',
  'user-agent',
  'x-deepseek-harness-compact',
  'x-deepseek-harness-session-id',
  'x-deepseek-harness-user-id',
])

const responseHeaderAllowlist = new Set([
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'date',
  'request-id',
  'retry-after',
  'x-deepseek-request-id',
  'x-request-id',
])

function filteredHeaders(headers, allowlist) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => allowlist.has(name.toLowerCase()) && value !== undefined),
  )
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body)}\n`)
}

function emptyUsage() {
  return {
    acceptedRequests: 0,
    activeRequests: 0,
    usageResponses: 0,
    unknownUsageResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

const globalUsage = emptyUsage()
const roleUsage = new Map([
  ['legacy', emptyUsage()],
  ['solver', emptyUsage()],
  ['updater', emptyUsage()],
])
const rolePolicies = new Map()
const roleTokens = new Map([
  ['solver', initialSolverToken],
  ['updater', initialUpdaterToken],
])
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const MAX_TOKENS_FIELDS = new Set(['max_tokens', 'max_completion_tokens'])
const AMPLIFICATION_FIELDS = new Set([
  'beam_width',
  'best_of',
  'candidate_count',
  'candidates',
  'num_beams',
  'num_return_sequences',
  'number_of_responses',
  'return_n',
])

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parsedUsage(value) {
  if (!value || typeof value !== 'object') return null
  const promptTokens = nonNegativeInteger(value.prompt_tokens)
  const completionTokens = nonNegativeInteger(value.completion_tokens)
  if (promptTokens === null || completionTokens === null) return null
  const cachedTokens = nonNegativeInteger(
    value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0,
  )
  const hiddenReasoningTokens = nonNegativeInteger(
    value.completion_tokens_details?.reasoning_tokens ?? 0,
  )
  if (cachedTokens === null || hiddenReasoningTokens === null) return null
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    cacheReadTokens: cachedTokens,
    reasoningTokens: hiddenReasoningTokens,
  }
}

function usageSnapshot(counters = globalUsage) {
  return { ...counters }
}

function createSseUsageMeter(counters) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let latestUsage = null
  let completed = false

  function inspectLine(line) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!normalized.startsWith('data:')) return
    const payload = normalized.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const event = JSON.parse(payload)
      const usage = parsedUsage(event?.usage)
      if (usage) latestUsage = usage
    } catch {
      // Usage 计量不能改变模型响应；无法解析的 SSE 行只会让本次计量标记为未知。
    }
  }

  function finish() {
    if (completed) return
    completed = true
    buffer += decoder.end()
    if (buffer) inspectLine(buffer)
    if (!latestUsage) {
      for (const counter of counters) counter.unknownUsageResponses += 1
      return
    }
    for (const counter of counters) {
      counter.usageResponses += 1
      counter.inputTokens += latestUsage.inputTokens
      counter.outputTokens += latestUsage.outputTokens
      counter.cacheReadTokens += latestUsage.cacheReadTokens
      counter.reasoningTokens += latestUsage.reasoningTokens
    }
  }

  function inspectChunk(chunk) {
    buffer += decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      inspectLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > 4 * 1024 * 1024) buffer = ''
  }

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      inspectChunk(chunk)
      // 计量和转发共用唯一数据链；原始字节不做任何改写。
      callback(null, chunk)
    },
    flush(callback) {
      finish()
      callback()
    },
  })
  meter.once('error', finish)
  meter.once('close', finish)
  return meter
}

function validatedRolePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!['solver', 'updater'].includes(value.role)) return null
  if (typeof value.model !== 'string' || !MODEL_ID_PATTERN.test(value.model)) return null
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 1_000_000) return null
  if (!MAX_TOKENS_FIELDS.has(value.maxTokensField)) return null
  if (Object.keys(value).some((key) => !['role', 'model', 'maxTokens', 'maxTokensField'].includes(key))) return null
  return {
    role: value.role,
    model: value.model,
    maxTokens: value.maxTokens,
    maxTokensField: value.maxTokensField,
  }
}

function trustedRequestBody(rawBody, policy) {
  let input
  try {
    input = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const output = { ...input, model: policy.model }
  delete output.max_tokens
  delete output.max_completion_tokens
  delete output.max_output_tokens
  delete output.maxTokens
  for (const field of AMPLIFICATION_FIELDS) delete output[field]
  output[policy.maxTokensField] = policy.maxTokens
  // 受信角色只能请求一个、必然返回 Usage 的流式 Completion。
  // 覆盖而不信任 Agent 提交的同名字段，避免放大生成数或绕过计量。
  output.n = 1
  output.stream = true
  output.stream_options = { include_usage: true }
  return Buffer.from(JSON.stringify(output))
}

function readControlBody(request, maximumBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maximumBytes) {
        reject(new Error('request_too_large'))
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
    request.once('aborted', reject)
  })
}

async function configureRole(request, response) {
  let value
  try {
    value = JSON.parse((await readControlBody(request)).toString('utf8'))
  } catch {
    if (!response.writableEnded) send(response, 400, { error: 'invalid_role_policy' })
    return
  }
  const policy = validatedRolePolicy(value)
  if (!policy) {
    send(response, 400, { error: 'invalid_role_policy' })
    return
  }
  const existing = rolePolicies.get(policy.role)
  if (existing && JSON.stringify(existing) !== JSON.stringify(policy)) {
    send(response, 409, { error: 'role_policy_is_immutable' })
    return
  }
  rolePolicies.set(policy.role, policy)
  send(response, 200, { ok: true, role: policy.role })
}

function validatedTokenRotation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.keys(value).length !== 1 || !['solver', 'updater'].includes(value.role)) return null
  return { role: value.role }
}

function freshRoleToken() {
  let token
  do {
    token = randomBytes(32).toString('hex')
  } while ([legacyToken, controlToken, ...roleTokens.values()].includes(token))
  return token
}

async function rotateRoleToken(request, response) {
  let value
  try {
    value = JSON.parse((await readControlBody(request)).toString('utf8'))
  } catch {
    if (!response.writableEnded) send(response, 400, { error: 'invalid_token_rotation' })
    return
  }
  const rotation = validatedTokenRotation(value)
  if (!rotation) {
    send(response, 400, { error: 'invalid_token_rotation' })
    return
  }
  if (roleUsage.get(rotation.role).activeRequests !== 0) {
    send(response, 409, { error: 'role_has_active_requests' })
    return
  }
  const token = freshRoleToken()
  roleTokens.set(rotation.role, token)
  send(response, 200, { ok: true, role: rotation.role, token })
}

const server = http.createServer((request, response) => {
  let requestUrl
  try {
    requestUrl = new URL(request.url ?? '/', 'http://model-gateway.invalid')
  } catch {
    send(response, 400, { error: 'invalid_request_url' })
    request.resume()
    return
  }
  if (request.method === 'GET' && requestUrl.pathname === '/healthz' && requestUrl.search === '') {
    send(response, 200, { ok: true })
    request.resume()
    return
  }
  const principal = authorizedPrincipal(request.headers.authorization)
  if (request.method === 'POST' && requestUrl.pathname === '/rsi/configure-role' && requestUrl.search === '') {
    if (principal?.role !== 'control') {
      send(response, 401, { error: 'unauthorized' })
      request.resume()
      return
    }
    configureRole(request, response).catch(() => {
      if (!response.writableEnded) send(response, 500, { error: 'configuration_failure' })
    })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/rsi/rotate-role-token' && requestUrl.search === '') {
    if (principal?.role !== 'control') {
      send(response, 401, { error: 'unauthorized' })
      request.resume()
      return
    }
    rotateRoleToken(request, response).catch(() => {
      if (!response.writableEnded) send(response, 500, { error: 'token_rotation_failure' })
    })
    return
  }
  if (request.method === 'GET' && requestUrl.pathname === '/rsi/usage') {
    if (!principal) {
      send(response, 401, { error: 'unauthorized' })
      request.resume()
      return
    }
    const queryEntries = [...requestUrl.searchParams.entries()]
    if (queryEntries.length > 1 || queryEntries.some(([name]) => name !== 'role')) {
      send(response, 400, { error: 'invalid_usage_query' })
      request.resume()
      return
    }
    const requestedRole = requestUrl.searchParams.get('role')
    if (requestedRole !== null && !roleUsage.has(requestedRole)) {
      send(response, 400, { error: 'invalid_role' })
      request.resume()
      return
    }
    if (principal.role === 'legacy' && requestedRole !== null) {
      send(response, 403, { error: 'forbidden' })
      request.resume()
      return
    }
    if (roleUsage.has(principal.role) && principal.role !== 'legacy'
        && requestedRole !== null && requestedRole !== principal.role) {
      send(response, 403, { error: 'forbidden' })
      request.resume()
      return
    }
    const selectedRole = principal.role === 'control'
      ? requestedRole
      : (principal.role === 'legacy' ? null : principal.role)
    send(response, 200, usageSnapshot(selectedRole === null ? globalUsage : roleUsage.get(selectedRole)))
    request.resume()
    return
  }
  if (request.method !== 'POST' || requestUrl.pathname !== '/chat/completions' || requestUrl.search !== '') {
    send(response, 404, { error: 'not_found' })
    request.resume()
    return
  }
  if (!principal || principal.role === 'control') {
    send(response, 401, { error: 'unauthorized' })
    request.resume()
    return
  }
  const policy = rolePolicies.get(principal.role)
  if (roleIsolationEnabled && principal.role !== 'legacy' && !policy) {
    send(response, 503, { error: 'role_policy_not_configured' })
    request.resume()
    return
  }
  if (policy && request.headers['content-encoding'] !== undefined
      && request.headers['content-encoding'] !== 'identity') {
    send(response, 415, { error: 'encoded_request_not_supported' })
    request.resume()
    return
  }
  const declaredLength = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
    send(response, 413, { error: 'request_too_large' })
    request.resume()
    return
  }
  if (globalUsage.acceptedRequests >= maximumRequests) {
    send(response, 429, { error: 'run_request_budget_exhausted' })
    request.resume()
    return
  }
  if (globalUsage.activeRequests >= maximumConcurrentRequests) {
    response.setHeader('retry-after', '1')
    send(response, 429, { error: 'gateway_concurrency_limit' })
    request.resume()
    return
  }
  const counters = [globalUsage, roleUsage.get(principal.role)]
  for (const counter of counters) {
    counter.acceptedRequests += 1
    counter.activeRequests += 1
  }
  let released = false
  let usageDelegated = false
  let unknownRecorded = false
  const recordUnknownUsage = () => {
    if (usageDelegated || unknownRecorded) return
    unknownRecorded = true
    for (const counter of counters) counter.unknownUsageResponses += 1
  }
  const release = () => {
    if (released) return
    released = true
    for (const counter of counters) counter.activeRequests -= 1
  }
  response.once('finish', release)
  response.once('close', release)

  const chunks = []
  let received = 0
  let rejected = false
  request.on('data', (chunk) => {
    if (rejected) return
    received += chunk.length
    if (received > maximumRequestBytes) {
      rejected = true
      chunks.length = 0
      recordUnknownUsage()
      send(response, 413, { error: 'request_too_large' })
      return
    }
    chunks.push(chunk)
  })
  request.on('error', () => {
    recordUnknownUsage()
    if (!response.headersSent) send(response, 400, { error: 'invalid_request' })
  })
  request.on('end', () => {
    if (rejected || response.writableEnded) return
    const rawBody = Buffer.concat(chunks, received)
    const payload = policy ? trustedRequestBody(rawBody, policy) : rawBody
    if (!payload) {
      recordUnknownUsage()
      send(response, 400, { error: 'invalid_json_request' })
      return
    }
    const target = upstreamUrl()
    const transport = target.protocol === 'https:' ? https : http
    const headers = {
      ...filteredHeaders(request.headers, requestHeaderAllowlist),
      authorization: `Bearer ${apiKey}`,
      host: target.host,
    }
    if (policy) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const upstream = transport.request(target, { method: 'POST', headers }, (upstreamResponse) => {
      usageDelegated = true
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        filteredHeaders(upstreamResponse.headers, responseHeaderAllowlist),
      )
      const usageMeter = createSseUsageMeter(counters)
      pipeline(upstreamResponse, usageMeter, response, (error) => {
        if (error && !response.destroyed) response.destroy(error)
      })
    })
    upstream.setTimeout(20 * 60 * 1000, () => upstream.destroy(new Error('upstream timeout')))
    upstream.on('error', (error) => {
      recordUnknownUsage()
      if (!response.headersSent) send(response, 502, { error: 'upstream_failure' })
      else response.destroy(error)
    })
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy()
    })
    upstream.end(payload)
  })
})

server.requestTimeout = 20 * 60 * 1000
server.headersTimeout = 30_000
server.listen(listenPort, '0.0.0.0')

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
