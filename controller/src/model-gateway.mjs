import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, chown, unlink } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const DEFAULT_CANDIDATE_API_KEY = 'harness-rsi-local-dummy'

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_MAX_REQUESTS = 10_000
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_ERROR_BYTES = 1024 * 1024
const MAX_SECRET_BYTES = 64 * 1024
const MAX_SSE_LINE_BYTES = 256 * 1024
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Classify only terminal provider/credential failures, never local Candidate policy errors. */
export function isProviderInfrastructureAudit(record) {
  if (!record || !Number.isInteger(record.status)) return false
  if (record.origin === 'credential') return true
  if (record.origin !== 'upstream') return false
  if (record.status === 400 && record.failureType === 'upstream_error') return true
  return [401, 402, 403, 404, 407, 408, 409, 425, 429].includes(record.status)
    || record.status >= 500
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SENSITIVE_HEADER_NAME = /(?:authorization|api[-_]?key|cookie|secret|token|organization|project)/iu

class RequestFailure extends Error {
  constructor(status) {
    super('gateway request failed')
    this.status = status
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizeUpstreamEndpoint(value) {
  let base
  try {
    base = new URL(value)
  } catch {
    throw new TypeError('upstreamBaseUrl must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new TypeError('upstreamBaseUrl must be an absolute HTTP(S) URL without credentials')
  }
  base.hash = ''
  base.search = ''
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/responses`
  return base
}

function normalizeApiKey(value) {
  const key = Buffer.isBuffer(value) ? value.toString('utf8').trim() : String(value ?? '').trim()
  if (key.length < 8 || key.length > MAX_SECRET_BYTES || /[\r\n]/u.test(key)) {
    throw new Error('invalid upstream credential')
  }
  return key
}

function readApiKeyFromFd(fd) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let settled = false
    const stream = createReadStream('', { fd, autoClose: false })

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      stream.removeAllListeners()
      callback(value)
    }

    stream.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_SECRET_BYTES) {
        stream.destroy()
        finish(reject, new Error('invalid upstream credential'))
        return
      }
      chunks.push(chunk)
    })
    stream.once('end', () => finish(resolve, Buffer.concat(chunks)))
    stream.once('error', () => finish(reject, new Error('unable to read upstream credential')))
  })
}

function makeApiKeyLoader({ getApiKey, apiKeyFd }) {
  const hasFunction = typeof getApiKey === 'function'
  // Keep stdin/stdout/stderr out of the credential path; callers should pass an
  // inherited anonymous descriptor (normally fd 3 or above).
  const hasFd = Number.isInteger(apiKeyFd) && apiKeyFd >= 3
  if (hasFunction === hasFd) {
    throw new TypeError('provide exactly one of getApiKey or apiKeyFd')
  }

  const provider = hasFunction ? getApiKey : () => readApiKeyFromFd(apiKeyFd)
  let pending
  return {
    async load() {
      if (!pending) {
        pending = Promise.resolve()
          .then(provider)
          .then(normalizeApiKey)
          .catch(() => {
            pending = undefined
            throw new Error('upstream credential unavailable')
          })
      }
      return pending
    },
    clear() {
      pending = undefined
    },
  }
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1'
}

function constantTimeTextEqual(left, right) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function sendJson(response, status, value, headers = {}) {
  if (response.destroyed || response.headersSent) return
  const body = Buffer.from(`${JSON.stringify(value)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...headers,
  })
  response.end(body)
}

function publicError(status) {
  if (status === 400) return 'Invalid JSON request body'
  if (status === 401) return 'Dummy gateway authorization required'
  if (status === 404) return 'Not found'
  if (status === 405) return 'Method not allowed'
  if (status === 413) return 'Request body too large'
  if (status === 429) return 'Gateway request limit reached'
  if (status === 499) return 'Client closed request'
  if (status === 504) return 'Upstream request timed out'
  return 'Upstream request failed'
}

function rejectRequest(request, response, status, extraHeaders) {
  request.resume()
  sendJson(response, status, { error: { message: publicError(status), type: 'gateway_error' } }, extraHeaders)
}

function readRequestBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      request.resume()
      reject(new RequestFailure(413))
      return
    }

    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > maximumBytes) {
        request.resume()
        finish(reject, new RequestFailure(413))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks))
    const onAborted = () => finish(reject, new RequestFailure(499))
    const onError = () => finish(reject, new RequestFailure(400))

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('error', onError)
  })
}

function forceTrustedRequestFields(
  body,
  maxOutputTokens,
  trustedModel,
  trustedReasoningEffort,
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestFailure(400)
  const trusted = {
    ...body,
    model: trustedModel,
    reasoning: {
      effort: trustedReasoningEffort,
      summary: 'auto',
    },
    stream: true,
  }
  if (maxOutputTokens !== null) trusted.max_output_tokens = maxOutputTokens
  return trusted
}

function redactText(value, secrets) {
  let output = value
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) output = output.split(secret).join('[REDACTED]')
  }
  return output
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu, '$1[REDACTED]')
    .replace(/((?:api[-_]?key|authorization|secret|token)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu, '$1[REDACTED]')
}

function safeResponseHeaders(headers, secrets, { changedBody = false } = {}) {
  const output = {}
  for (const [name, rawValue] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName) || SENSITIVE_HEADER_NAME.test(lowerName)) continue
    if (changedBody && ['content-length', 'content-encoding', 'content-md5', 'etag'].includes(lowerName)) continue
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    const safeValues = values
      .filter((value) => value !== undefined)
      .map((value) => redactText(String(value), secrets))
    if (safeValues.length === 1) output[lowerName] = safeValues[0]
    else if (safeValues.length > 1) output[lowerName] = safeValues
  }
  return output
}

function numericUsage(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function extractSafeUsage(event) {
  const input = event?.response?.usage ?? event?.usage
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const usage = {
    inputTokens: numericUsage(input.input_tokens),
    outputTokens: numericUsage(input.output_tokens),
    totalTokens: numericUsage(input.total_tokens),
    cachedInputTokens: numericUsage(input.input_tokens_details?.cached_tokens),
    reasoningOutputTokens: numericUsage(input.output_tokens_details?.reasoning_tokens),
  }
  const filtered = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined))
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

class SseUsageCollector {
  constructor(maximumLineBytes = MAX_SSE_LINE_BYTES) {
    this.maximumLineBytes = maximumLineBytes
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.discardingLine = false
    this.usage = undefined
  }

  push(chunk) {
    this.#pushText(this.decoder.write(chunk))
  }

  finish() {
    this.#pushText(this.decoder.end())
    if (!this.discardingLine && this.buffer.length > 0) this.#parseLine(this.buffer)
    this.buffer = ''
    return this.usage
  }

  #pushText(text) {
    this.buffer += text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) {
        if (Buffer.byteLength(this.buffer) > this.maximumLineBytes) {
          this.buffer = ''
          this.discardingLine = true
        }
        return
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (this.discardingLine) {
        this.discardingLine = false
        continue
      }
      this.#parseLine(line)
    }
  }

  #parseLine(line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trimStart()
    if (!data || data === '[DONE]' || Buffer.byteLength(data) > this.maximumLineBytes) return
    try {
      const usage = extractSafeUsage(JSON.parse(data))
      if (usage) this.usage = usage
    } catch {
      // Usage is optional. Never expose or retain malformed SSE payloads in audit errors.
    }
  }
}

function collectLimitedBody(stream, maximumBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    stream.on('data', (chunk) => {
      size += chunk.length
      if (size > maximumBytes) {
        stream.once('error', () => {})
        stream.destroy()
        finish({ overflow: true, body: undefined })
        return
      }
      chunks.push(chunk)
    })
    stream.once('end', () => finish({ overflow: false, body: Buffer.concat(chunks) }))
    stream.once('aborted', () => finish({ overflow: true, body: undefined }))
    stream.once('error', () => finish({ overflow: true, body: undefined }))
  })
}

function isTextualResponse(headers) {
  const contentType = String(headers['content-type'] ?? '').toLowerCase()
  return contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('problem+')
    || contentType === ''
}

function safeUpstreamFailureType(body) {
  try {
    const value = JSON.parse(body.toString('utf8'))
    const error = value?.error && typeof value.error === 'object' ? value.error : value
    return error?.type === 'upstream_error' ? 'upstream_error' : undefined
  } catch {
    return undefined
  }
}

function proxyToUpstream({
  endpoint,
  payload,
  apiKey,
  requestId,
  downstreamRequest,
  downstreamResponse,
  requestTimeoutMs,
  maxErrorBytes,
}) {
  return new Promise((resolve) => {
    const transport = endpoint.protocol === 'https:' ? https : http
    let upstreamRequest
    let upstreamResponse
    let finished = false
    let timedOut = false

    const cleanup = () => {
      downstreamRequest.off('aborted', onClientGone)
      downstreamResponse.off('close', onClientGone)
      downstreamResponse.off('drain', onDrain)
    }
    const finish = (status, usage, failureType) => {
      if (finished) return
      finished = true
      cleanup()
      resolve({ status, usage, failureType })
    }
    const onClientGone = () => {
      if (downstreamResponse.writableFinished) return
      upstreamRequest?.destroy()
      upstreamResponse?.destroy()
      finish(499)
    }
    const onDrain = () => upstreamResponse?.resume()
    const failBeforeHeaders = (status) => {
      if (!downstreamResponse.headersSent) {
        sendJson(downstreamResponse, status, {
          error: { message: publicError(status), type: 'gateway_error' },
        })
      } else if (!downstreamResponse.destroyed) {
        downstreamResponse.destroy()
      }
      finish(status)
    }

    downstreamRequest.once('aborted', onClientGone)
    downstreamResponse.once('close', onClientGone)
    downstreamResponse.on('drain', onDrain)

    upstreamRequest = transport.request(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
        'content-type': 'application/json',
        'content-length': payload.length,
        'user-agent': 'harness-rsi-model-gateway/1',
        'x-gateway-request-id': requestId,
      },
    }, async (response) => {
      upstreamResponse = response
      const status = response.statusCode ?? 502
      if (status < 200 || status >= 300) {
        const collected = await collectLimitedBody(response, maxErrorBytes)
        if (finished) return
        const textual = isTextualResponse(response.headers)
        let body
        let headers
        let failureType
        if (!collected.overflow && textual) {
          failureType = safeUpstreamFailureType(collected.body)
          body = Buffer.from(redactText(collected.body.toString('utf8'), [apiKey]))
          headers = safeResponseHeaders(response.headers, [apiKey], { changedBody: true })
        } else {
          body = Buffer.from(`${JSON.stringify({
            error: { message: 'Upstream request failed', type: 'upstream_error' },
          })}\n`)
          headers = safeResponseHeaders(response.headers, [apiKey], { changedBody: true })
          headers['content-type'] = 'application/json; charset=utf-8'
        }
        headers['content-length'] = body.length
        if (!downstreamResponse.destroyed) {
          downstreamResponse.writeHead(status, headers)
          downstreamResponse.end(body)
        }
        finish(status, undefined, failureType)
        return
      }

      const headers = safeResponseHeaders(response.headers, [apiKey])
      if (!downstreamResponse.destroyed) {
        downstreamResponse.writeHead(status, headers)
        downstreamResponse.flushHeaders()
      }
      const collector = new SseUsageCollector()
      response.on('data', (chunk) => {
        if (finished) return
        collector.push(chunk)
        if (!downstreamResponse.destroyed && !downstreamResponse.write(chunk)) response.pause()
      })
      response.once('end', () => {
        if (finished) return
        const usage = collector.finish()
        if (!downstreamResponse.destroyed) downstreamResponse.end()
        finish(status, usage)
      })
      response.once('aborted', () => failBeforeHeaders(502))
      response.once('error', () => failBeforeHeaders(502))
    })

    upstreamRequest.setTimeout(requestTimeoutMs, () => {
      timedOut = true
      upstreamRequest.destroy()
    })
    upstreamRequest.once('error', () => {
      if (finished) return
      failBeforeHeaders(timedOut ? 504 : 502)
    })
    upstreamRequest.end(payload)
  })
}

function normalizeOptions(options) {
  const endpoint = normalizeUpstreamEndpoint(options.upstreamBaseUrl)
  const trustedModel = options.trustedModel ?? 'gpt-5.6-sol'
  if (typeof trustedModel !== 'string' || !MODEL_ID_PATTERN.test(trustedModel)) {
    throw new TypeError('trustedModel must be a valid model identifier')
  }
  const trustedReasoningEffort = options.trustedReasoningEffort ?? 'max'
  if (!REASONING_EFFORTS.has(trustedReasoningEffort)) {
    throw new TypeError('trustedReasoningEffort must be a supported effort')
  }
  const maxBodyBytes = requirePositiveInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes')
  const maxConcurrency = options.maxConcurrency === null
    ? null
    : requirePositiveInteger(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, 'maxConcurrency')
  const maxRequests = options.maxRequests === null
    ? null
    : requirePositiveInteger(options.maxRequests ?? DEFAULT_MAX_REQUESTS, 'maxRequests')
  const maxOutputTokens = options.maxOutputTokens === null
    ? null
    : requirePositiveInteger(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 'maxOutputTokens')
  if (maxOutputTokens !== null && maxOutputTokens > 65_536) {
    throw new TypeError('maxOutputTokens must be at most 65536')
  }
  const requestTimeoutMs = requirePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  )
  const maxErrorBytes = requirePositiveInteger(
    options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES,
    'maxErrorBytes',
  )
  const candidateApiKey = options.candidateApiKey ?? DEFAULT_CANDIDATE_API_KEY
  if (typeof candidateApiKey !== 'string' || candidateApiKey.length < 8 || /[\r\n]/u.test(candidateApiKey)) {
    throw new TypeError('candidateApiKey must be a non-empty dummy value without newlines')
  }
  if (options.audit !== undefined && typeof options.audit !== 'function') {
    throw new TypeError('audit must be a function')
  }
  return {
    endpoint,
    trustedModel,
    trustedReasoningEffort,
    maxBodyBytes,
    maxConcurrency,
    maxRequests,
    maxOutputTokens,
    requestTimeoutMs,
    maxErrorBytes,
    candidateApiKey,
    audit: options.audit ?? (() => {}),
    apiKeyLoader: makeApiKeyLoader(options),
  }
}

/**
 * Create a loopback-only Responses API credential gateway.
 *
 * SECURITY BOUNDARY: this process hides the upstream credential and fixes trusted
 * model settings. It does NOT replace a container/network namespace egress policy.
 * Candidate workloads must still be prevented from connecting to the upstream API
 * (or any other exfiltration endpoint) except through this loopback listener.
 */
export function createModelGateway(options) {
  const config = normalizeOptions(options ?? {})
  const counters = { active: 0, total: 0 }
  let boundUrl
  let boundSocketPath

  const safeAudit = async (record) => {
    const safeRecord = Object.freeze({
      timestamp: record.timestamp,
      requestId: record.requestId,
      status: record.status,
      origin: record.origin,
      ...(record.failureType === 'upstream_error' ? { failureType: record.failureType } : {}),
      ...(record.usage ? { usage: Object.freeze({ ...record.usage }) } : {}),
    })
    try {
      await config.audit(safeRecord)
    } catch {
      // Audit sink failures must never expose its error, request content, or credentials.
    }
  }

  const server = http.createServer((request, response) => {
    const requestId = randomUUID()
    let audited = false
    const audit = async (status, usage, origin = 'gateway', failureType) => {
      if (audited) return
      audited = true
      await safeAudit({
        timestamp: new Date().toISOString(),
        requestId,
        status,
        origin,
        failureType,
        usage,
      })
    }
    const run = async () => {
      response.setHeader('x-gateway-request-id', requestId)

      if (boundSocketPath === undefined && !isLoopbackAddress(request.socket.remoteAddress)) {
        rejectRequest(request, response, 403)
        await audit(403)
        return
      }
      if (request.url !== '/v1/responses') {
        rejectRequest(request, response, 404)
        await audit(404)
        return
      }
      if (request.method !== 'POST') {
        rejectRequest(request, response, 405, { allow: 'POST' })
        await audit(405)
        return
      }
      const authorization = Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization
      if (!constantTimeTextEqual(authorization ?? '', `Bearer ${config.candidateApiKey}`)) {
        rejectRequest(request, response, 401)
        await audit(401)
        return
      }
      if (config.maxRequests !== null && counters.total >= config.maxRequests) {
        rejectRequest(request, response, 429)
        await audit(429)
        return
      }
      counters.total += 1
      if (config.maxConcurrency !== null && counters.active >= config.maxConcurrency) {
        rejectRequest(request, response, 429)
        await audit(429)
        return
      }

      counters.active += 1
      try {
        let rawBody
        try {
          rawBody = await readRequestBody(request, config.maxBodyBytes)
        } catch (error) {
          const status = error instanceof RequestFailure ? error.status : 400
          if (!response.destroyed) rejectRequest(request, response, status)
          await audit(status)
          return
        }

        let trustedBody
        try {
          trustedBody = forceTrustedRequestFields(
            JSON.parse(rawBody.toString('utf8')),
            config.maxOutputTokens,
            config.trustedModel,
            config.trustedReasoningEffort,
          )
        } catch {
          rejectRequest(request, response, 400)
          await audit(400)
          return
        }

        let apiKey
        try {
          apiKey = await config.apiKeyLoader.load()
        } catch {
          rejectRequest(request, response, 502)
          await audit(502, undefined, 'credential')
          return
        }
        if (response.destroyed) {
          await audit(499)
          return
        }

        const outcome = await proxyToUpstream({
          endpoint: config.endpoint,
          payload: Buffer.from(JSON.stringify(trustedBody)),
          apiKey,
          requestId,
          downstreamRequest: request,
          downstreamResponse: response,
          requestTimeoutMs: config.requestTimeoutMs,
          maxErrorBytes: config.maxErrorBytes,
        })
        await audit(outcome.status, outcome.usage, 'upstream', outcome.failureType)
      } finally {
        counters.active -= 1
      }
    }

    run().catch(async () => {
      sendJson(response, 500, { error: { message: 'Gateway internal error', type: 'gateway_error' } })
      await audit(500)
    })
  })

  const gateway = {
    server,
    candidateApiKey: config.candidateApiKey,
    get url() {
      return boundUrl
    },
    get socketPath() {
      return boundSocketPath
    },
    stats() {
      return Object.freeze({
        activeRequests: counters.active,
        totalRequests: counters.total,
        remainingRequests: config.maxRequests === null
          ? null
          : Math.max(0, config.maxRequests - counters.total),
      })
    },
    async start({
      host = '127.0.0.1',
      port = 0,
      socketPath,
      publicUrl,
      socketUid,
      socketGid,
    } = {}) {
      const unix = socketPath !== undefined
      if (!isLoopbackHost(host)) throw new TypeError('model gateway host must be 127.0.0.1 or ::1')
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be 0..65535')
      if (unix && (typeof socketPath !== 'string' || !isAbsolute(socketPath)
          || /[\r\n\0]/u.test(socketPath) || socketPath.length > 100)) {
        throw new TypeError('model gateway socketPath must be a short absolute path')
      }
      if (unix && (typeof publicUrl !== 'string'
          || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/u.test(publicUrl))) {
        throw new TypeError('Unix model gateway requires a fixed loopback publicUrl')
      }
      if (unix && ((socketUid === undefined) !== (socketGid === undefined)
          || (socketUid !== undefined
            && (!Number.isInteger(socketUid) || socketUid < 1
              || !Number.isInteger(socketGid) || socketGid < 1)))) {
        throw new TypeError('Unix model gateway socket uid/gid must be positive integers')
      }
      if (server.listening) throw new Error('model gateway is already listening')
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        if (unix) server.listen(socketPath)
        else server.listen(port, host)
      })
      if (unix) {
        boundSocketPath = socketPath
        try {
          if (socketUid !== undefined) await chown(socketPath, socketUid, socketGid)
          await chmod(socketPath, 0o660)
        } catch (error) {
          await new Promise((resolve) => server.close(() => resolve()))
          await unlink(socketPath).catch(() => {})
          boundSocketPath = undefined
          throw error
        }
        boundUrl = publicUrl
        return gateway
      }
      const address = server.address()
      const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
      boundUrl = `http://${displayHost}:${address.port}/v1`
      return gateway
    },
    async close() {
      config.apiKeyLoader.clear()
      boundUrl = undefined
      const socketPath = boundSocketPath
      boundSocketPath = undefined
      if (!server.listening) return
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeIdleConnections?.()
      })
      if (socketPath !== undefined) {
        await unlink(socketPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error
        })
      }
    },
  }

  return gateway
}

export async function startModelGateway(options) {
  const {
    host = '127.0.0.1',
    port = 0,
    socketPath,
    publicUrl,
    socketUid,
    socketGid,
    ...gatewayOptions
  } = options ?? {}
  const gateway = createModelGateway(gatewayOptions)
  return gateway.start({ host, port, socketPath, publicUrl, socketUid, socketGid })
}
