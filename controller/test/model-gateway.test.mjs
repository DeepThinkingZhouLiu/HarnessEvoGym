import assert from 'node:assert/strict'
import { once } from 'node:events'
import { open, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_CANDIDATE_API_KEY,
  isProviderInfrastructureAudit,
  startModelGateway,
} from '../src/model-gateway.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

function gatewayFetch(gateway, path = '/responses', options = {}) {
  return fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${DEFAULT_CANDIDATE_API_KEY}`,
      'content-type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify({ input: 'hello' }),
    ...options,
  })
}

test('provider audit classification excludes Candidate-local gateway policy errors', () => {
  assert.equal(isProviderInfrastructureAudit({ status: 429, origin: 'upstream' }), true)
  assert.equal(isProviderInfrastructureAudit({ status: 502, origin: 'credential' }), true)
  assert.equal(isProviderInfrastructureAudit({ status: 429, origin: 'gateway' }), false)
  assert.equal(isProviderInfrastructureAudit({ status: 400, origin: 'upstream' }), false)
  assert.equal(isProviderInfrastructureAudit({ status: 200, origin: 'upstream' }), false)
})

test('强制可信 Responses 字段、注入真实凭据并透明流式转发安全状态/headers', async (t) => {
  const realKey = 'upstream-real-key-123456'
  const promptSecret = 'PROMPT_MUST_NOT_ENTER_AUDIT'
  const responseSecret = 'RESPONSE_MUST_NOT_ENTER_AUDIT'
  let received
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-safe-header': 'visible',
      'x-secret-token': realKey,
      'set-cookie': `credential=${realKey}`,
    })
    response.write(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${responseSecret}"}\n\n`)
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"content":"RESPONSE_MUST_NOT_ENTER_AUDIT"}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":2}}}}\n\n')
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: async () => realKey,
    audit: (record) => audits.push(record),
    maxRequests: 5,
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const tools = [{ type: 'function', name: 'solve', parameters: { type: 'object' } }]
  const response = await gatewayFetch(gateway, '/responses', {
    body: JSON.stringify({
      model: 'attacker-model',
      reasoning: { effort: 'low', summary: 'none', attacker: true },
      max_output_tokens: 999_999,
      stream: false,
      input: promptSecret,
      tools,
    }),
  })
  const streamed = await response.text()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('x-safe-header'), 'visible')
  assert.equal(response.headers.get('x-secret-token'), null)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.match(streamed, new RegExp(responseSecret, 'u'))
  assert.deepEqual(received, {
    url: '/v1/responses',
    authorization: `Bearer ${realKey}`,
    body: {
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'max', summary: 'auto' },
      max_output_tokens: 32768,
      stream: true,
      input: promptSecret,
      tools,
    },
  })
  assert.equal(audits.length, 1)
  assert.equal(audits[0].origin, 'upstream')
  assert.deepEqual(audits[0].usage, {
    inputTokens: 10,
    outputTokens: 3,
    totalTokens: 13,
    cachedInputTokens: 4,
    reasoningOutputTokens: 2,
  })
  const serializedAudit = JSON.stringify(audits)
  assert.doesNotMatch(serializedAudit, new RegExp(realKey, 'u'))
  assert.doesNotMatch(serializedAudit, new RegExp(promptSecret, 'u'))
  assert.doesNotMatch(serializedAudit, new RegExp(responseSecret, 'u'))
})

test('只接受目标 POST、dummy auth，并限制请求体与总请求数', async (t) => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  const upstreamUrl = await listen(upstream)
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-for-limit-test',
    maxBodyBytes: 64,
    maxRequests: 1,
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const wrongPath = await gatewayFetch(gateway, '/chat/completions')
  assert.equal(wrongPath.status, 404)

  const wrongMethod = await fetch(`${gateway.url}/responses`, {
    method: 'GET',
    headers: { authorization: `Bearer ${DEFAULT_CANDIDATE_API_KEY}` },
  })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')

  const missingDummy = await fetch(`${gateway.url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(missingDummy.status, 401)

  const oversized = await gatewayFetch(gateway, '/responses', {
    body: JSON.stringify({ input: 'x'.repeat(100) }),
  })
  assert.equal(oversized.status, 413)

  const overTotal = await gatewayFetch(gateway)
  assert.equal(overTotal.status, 429)
  assert.equal(upstreamCalls, 0)
  assert.deepEqual(gateway.stats(), {
    activeRequests: 0,
    totalRequests: 1,
    remainingRequests: 0,
  })
})

test('并发上限拒绝额外请求且 Client abort 会中止上游', async (t) => {
  let releaseFirst
  let firstArrived
  const firstArrivedPromise = new Promise((resolve) => { firstArrived = resolve })
  const upstream = http.createServer((request, response) => {
    request.resume()
    firstArrived()
    releaseFirst = () => {
      if (response.destroyed) return
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
    }
  })
  const upstreamUrl = await listen(upstream)
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-concurrency-test',
    maxConcurrency: 1,
    maxRequests: 3,
  })
  t.after(async () => {
    releaseFirst?.()
    await gateway.close()
    await close(upstream)
  })

  const controller = new AbortController()
  const first = gatewayFetch(gateway, '/responses', { signal: controller.signal })
  await firstArrivedPromise
  const second = await gatewayFetch(gateway)
  assert.equal(second.status, 429)
  controller.abort()
  await assert.rejects(first, /abort/iu)

  const deadline = Date.now() + 2000
  while (gateway.stats().activeRequests !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(gateway.stats().activeRequests, 0)
})

test('上游非 2xx 保留状态与安全 headers，同时从 body/header/audit 脱敏', async (t) => {
  const realKey = 'upstream-error-key-123456'
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '7',
      'x-secret-token': realKey,
    })
    response.end(JSON.stringify({
      error: {
        message: `authorization: Bearer ${realKey}`,
        api_key: realKey,
      },
    }))
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => realKey,
    audit: (record) => audits.push(record),
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const response = await gatewayFetch(gateway)
  const body = await response.text()
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '7')
  assert.equal(response.headers.get('x-secret-token'), null)
  assert.doesNotMatch(body, new RegExp(realKey, 'u'))
  assert.match(body, /\[REDACTED\]/u)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].status, 429)
  assert.equal(audits[0].origin, 'upstream')
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(realKey, 'u'))
})

test('可从 fd 一次性读取上游 key，且不会把 key 暴露给 Candidate', async (t) => {
  const realKey = 'upstream-fd-key-123456'
  const keyPath = join(tmpdir(), `harness-rsi-key-${process.pid}-${Date.now()}`)
  await writeFile(keyPath, `${realKey}\n`, { mode: 0o600 })
  const handle = await open(keyPath, 'r')
  let receivedAuthorization
  const upstream = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  const upstreamUrl = await listen(upstream)
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    apiKeyFd: handle.fd,
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
    await handle.close()
    await rm(keyPath, { force: true })
  })

  const response = await gatewayFetch(gateway)
  await response.text()
  assert.equal(response.status, 200)
  assert.equal(receivedAuthorization, `Bearer ${realKey}`)
  assert.doesNotMatch(JSON.stringify(gateway.stats()), new RegExp(realKey, 'u'))
})
