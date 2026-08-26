import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const listenPort = Number(process.env.GATEWAY_PORT ?? '8080')
const token = process.env.GATEWAY_TOKEN ?? ''
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
if (token.length < 32) throw new Error('model-gateway: GATEWAY_TOKEN 缺失或过短')
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

function authorized(header) {
  const prefix = 'Bearer '
  if (typeof header !== 'string' || !header.startsWith(prefix)) return false
  const supplied = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function upstreamUrl() {
  const basePath = upstreamBase.pathname.replace(/\/+$/u, '')
  return new URL(`${basePath}/chat/completions`, upstreamBase.origin)
}

const requestHeaderAllowlist = new Set([
  'accept',
  'content-encoding',
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

let acceptedRequests = 0
let activeRequests = 0
let usageResponses = 0
let unknownUsageResponses = 0
let inputTokens = 0
let outputTokens = 0
let cacheReadTokens = 0
let reasoningTokens = 0

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

function usageSnapshot() {
  return {
    acceptedRequests,
    activeRequests,
    usageResponses,
    unknownUsageResponses,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
  }
}

function observeSseUsage(upstreamResponse) {
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
    if (buffer) inspectLine(buffer)
    if (!latestUsage) {
      unknownUsageResponses += 1
      return
    }
    usageResponses += 1
    inputTokens += latestUsage.inputTokens
    outputTokens += latestUsage.outputTokens
    cacheReadTokens += latestUsage.cacheReadTokens
    reasoningTokens += latestUsage.reasoningTokens
  }

  upstreamResponse.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      inspectLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > 4 * 1024 * 1024) buffer = ''
  })
  upstreamResponse.once('end', finish)
  upstreamResponse.once('error', finish)
  upstreamResponse.once('aborted', finish)
  upstreamResponse.once('close', finish)
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    send(response, 200, { ok: true })
    request.resume()
    return
  }
  if (request.method === 'GET' && request.url === '/rsi/usage') {
    if (!authorized(request.headers.authorization)) {
      send(response, 401, { error: 'unauthorized' })
    } else {
      send(response, 200, usageSnapshot())
    }
    request.resume()
    return
  }
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    send(response, 404, { error: 'not_found' })
    request.resume()
    return
  }
  if (!authorized(request.headers.authorization)) {
    send(response, 401, { error: 'unauthorized' })
    request.resume()
    return
  }
  const declaredLength = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
    send(response, 413, { error: 'request_too_large' })
    request.resume()
    return
  }
  if (acceptedRequests >= maximumRequests) {
    send(response, 429, { error: 'run_request_budget_exhausted' })
    request.resume()
    return
  }
  if (activeRequests >= maximumConcurrentRequests) {
    response.setHeader('retry-after', '1')
    send(response, 429, { error: 'gateway_concurrency_limit' })
    request.resume()
    return
  }
  acceptedRequests += 1
  activeRequests += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    activeRequests -= 1
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
      send(response, 413, { error: 'request_too_large' })
      return
    }
    chunks.push(chunk)
  })
  request.on('error', () => {
    if (!response.headersSent) send(response, 400, { error: 'invalid_request' })
  })
  request.on('end', () => {
    if (rejected || response.writableEnded) return
    const target = upstreamUrl()
    const transport = target.protocol === 'https:' ? https : http
    const headers = {
      ...filteredHeaders(request.headers, requestHeaderAllowlist),
      authorization: `Bearer ${apiKey}`,
      host: target.host,
    }
    const upstream = transport.request(target, { method: 'POST', headers }, (upstreamResponse) => {
      observeSseUsage(upstreamResponse)
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        filteredHeaders(upstreamResponse.headers, responseHeaderAllowlist),
      )
      upstreamResponse.pipe(response)
    })
    upstream.setTimeout(20 * 60 * 1000, () => upstream.destroy(new Error('upstream timeout')))
    upstream.on('error', (error) => {
      if (!response.headersSent) send(response, 502, { error: 'upstream_failure' })
      else response.destroy(error)
    })
    response.on('close', () => {
      if (!response.writableEnded) upstream.destroy()
    })
    upstream.end(Buffer.concat(chunks, received))
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
