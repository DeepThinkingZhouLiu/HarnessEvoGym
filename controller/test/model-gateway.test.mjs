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

test('maxTransientRetries rejects values outside the frozen global bound', async () => {
  for (const maxTransientRetries of [-1, 9, 1.5]) {
    await assert.rejects(startModelGateway({
      upstreamBaseUrl: 'http://127.0.0.1:1/v1',
      getApiKey: () => 'real-key-invalid-retry-bound',
      maxTransientRetries,
    }), /maxTransientRetries must be a safe integer from 0 to 8/u)
  }
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

test('完整 502/503 在单一 Candidate request 内透明重试并只审计最终成功', async (t) => {
  const failureSecret = 'retry-failure-secret-123456'
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    if (upstreamCalls <= 2) {
      response.writeHead(upstreamCalls === 1 ? 502 : 503, {
        'content-type': 'application/json',
        'x-secret-token': failureSecret,
      })
      response.end(JSON.stringify({ error: { token: failureSecret } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"response":{"usage":{"input_tokens":8,"output_tokens":5,"total_tokens":13}}}\n\ndata: [DONE]\n\n')
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-transparent-retry-test',
    audit: (record) => audits.push(record),
    maxRequests: 5,
    transientRetryDelaysMs: [0, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const response = await gatewayFetch(gateway)
  const body = await response.text()
  await gateway.waitForIdle()

  assert.equal(response.status, 200)
  assert.match(body, /\[DONE\]/u)
  assert.doesNotMatch(body, new RegExp(failureSecret, 'u'))
  assert.equal(upstreamCalls, 3)
  assert.equal(gateway.stats().totalRequests, 1)
  assert.equal(gateway.stats().upstreamAttempts, 3)
  assert.equal(gateway.stats().transientRetries, 2)
  assert.equal(gateway.stats().remainingTransientRetries, 0)
  assert.deepEqual(audits, [{
    timestamp: audits[0].timestamp,
    requestId: audits[0].requestId,
    requestSequence: 1,
    status: 200,
    origin: 'upstream',
    upstreamAttempts: 3,
    transientRetries: 2,
    retryStatuses: [502, 503],
    usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
  }])
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(failureSecret, 'u'))
})

test('gateway 全局只允许两个额外 transient attempts，最终失败仍安全转发', async (t) => {
  const realKey = 'global-retry-key-123456'
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    const status = upstreamCalls <= 3 ? 502 : 503
    response.writeHead(status, {
      'content-type': 'application/json',
      'retry-after': '2',
      'x-secret-token': realKey,
    })
    response.end(JSON.stringify({ error: { authorization: `Bearer ${realKey}` } }))
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => realKey,
    audit: (record) => audits.push(record),
    maxRequests: 16,
    transientRetryDelaysMs: [0, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const first = await gatewayFetch(gateway)
  const firstBody = await first.text()
  const second = await gatewayFetch(gateway)
  const secondBody = await second.text()
  await gateway.waitForIdle()

  assert.equal(first.status, 502)
  assert.equal(second.status, 503)
  assert.equal(second.headers.get('retry-after'), '2')
  assert.equal(second.headers.get('x-secret-token'), null)
  assert.doesNotMatch(`${firstBody}${secondBody}`, new RegExp(realKey, 'u'))
  assert.match(firstBody, /\[REDACTED\]/u)
  assert.match(secondBody, /\[REDACTED\]/u)
  assert.equal(upstreamCalls, 4)
  assert.equal(gateway.stats().totalRequests, 2)
  assert.equal(gateway.stats().upstreamAttempts, 4)
  assert.equal(gateway.stats().transientRetries, 2)
  assert.equal(gateway.stats().remainingTransientRetries, 0)
  assert.deepEqual(audits.map(({
    status,
    origin,
    upstreamAttempts,
    transientRetries,
    retryStatuses,
  }) => ({
    status,
    origin,
    upstreamAttempts,
    transientRetries,
    retryStatuses,
  })), [
    {
      status: 502,
      origin: 'upstream',
      upstreamAttempts: 3,
      transientRetries: 2,
      retryStatuses: [502, 502],
    },
    {
      status: 503,
      origin: 'upstream',
      upstreamAttempts: 1,
      transientRetries: 0,
      retryStatuses: [],
    },
  ])
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(realKey, 'u'))
})

test('并发 Candidate requests 同步竞争同一个 transient retry pool', async (t) => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end('{"error":"transient"}')
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-concurrent-pool-test',
    audit: (record) => audits.push(record),
    maxConcurrency: 3,
    maxTransientRetries: 2,
    transientRetryDelaysMs: [0, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const responses = await Promise.all([
    gatewayFetch(gateway),
    gatewayFetch(gateway),
    gatewayFetch(gateway),
  ])
  await Promise.all(responses.map((response) => response.text()))
  await gateway.waitForIdle()

  assert.deepEqual(responses.map((response) => response.status), [502, 502, 502])
  assert.equal(upstreamCalls, 5)
  assert.equal(gateway.stats().totalRequests, 3)
  assert.equal(gateway.stats().upstreamAttempts, 5)
  assert.equal(gateway.stats().transientRetries, 2)
  assert.equal(gateway.stats().remainingTransientRetries, 0)
  assert.equal(audits.length, 3)
  assert.equal(audits.reduce((sum, record) => sum + record.upstreamAttempts, 0), 5)
  assert.equal(audits.reduce((sum, record) => sum + record.transientRetries, 0), 2)
})

test('maxTransientRetries=0 disables transparent retry', async (t) => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end('{"error":"not retried"}')
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-retry-disabled-test',
    audit: (record) => audits.push(record),
    maxTransientRetries: 0,
    transientRetryDelaysMs: [0, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const response = await gatewayFetch(gateway)
  await response.text()
  await gateway.waitForIdle()

  assert.equal(response.status, 502)
  assert.equal(upstreamCalls, 1)
  assert.equal(gateway.stats().upstreamAttempts, 1)
  assert.equal(gateway.stats().transientRetries, 0)
  assert.equal(gateway.stats().remainingTransientRetries, 0)
  assert.equal(audits[0].upstreamAttempts, 1)
  assert.equal(audits[0].transientRetries, 0)
  assert.deepEqual(audits[0].retryStatuses, [])
})

test('Client abort during transient backoff cancels the retry timer', async (t) => {
  let upstreamCalls = 0
  let responseFinished
  const responseFinishedPromise = new Promise((resolve) => { responseFinished = resolve })
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    response.writeHead(502, { 'content-type': 'application/json' })
    response.once('finish', responseFinished)
    response.end('{"error":"retry later"}')
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-abort-backoff-test',
    audit: (record) => audits.push(record),
    transientRetryDelaysMs: [250, 0],
  })
  t.after(async () => {
    gateway.server.closeAllConnections?.()
    await gateway.close()
    upstream.closeAllConnections?.()
    await close(upstream)
  })

  const controller = new AbortController()
  const pending = gatewayFetch(gateway, '/responses', { signal: controller.signal })
  await responseFinishedPromise
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(gateway.stats().activeRequests, 1)
  assert.equal(gateway.stats().upstreamAttempts, 1)
  assert.equal(gateway.stats().transientRetries, 0)
  controller.abort()
  await assert.rejects(pending, /abort/iu)
  await gateway.waitForIdle()
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(upstreamCalls, 1)
  assert.equal(gateway.stats().upstreamAttempts, 1)
  assert.equal(gateway.stats().transientRetries, 0)
  assert.equal(gateway.stats().remainingTransientRetries, 2)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].status, 499)
  assert.equal(audits[0].upstreamAttempts, 1)
  assert.equal(audits[0].transientRetries, 0)
  assert.deepEqual(audits[0].retryStatuses, [])
})

test('不完整 502 和连接错误均不重试', async (t) => {
  for (const failureKind of ['incomplete-response', 'connection-error']) {
    let upstreamCalls = 0
    const audits = []
    const upstream = http.createServer((request, response) => {
      request.resume()
      upstreamCalls += 1
      if (failureKind === 'connection-error') {
        request.socket.destroy()
        return
      }
      response.writeHead(502, { 'content-type': 'application/json' })
      response.flushHeaders()
      response.write('{"error":"partial')
      setImmediate(() => response.destroy())
    })
    const upstreamUrl = await listen(upstream)
    const gateway = await startModelGateway({
      upstreamBaseUrl: `${upstreamUrl}/v1`,
      getApiKey: () => 'real-key-no-retry-test',
      audit: (record) => audits.push(record),
      transientRetryDelaysMs: [0, 0],
    })

    try {
      const response = await gatewayFetch(gateway)
      assert.equal(response.status, 502)
      await response.text()
      await gateway.waitForIdle()
      assert.equal(upstreamCalls, 1)
      assert.equal(gateway.stats().transientRetries, 0)
      assert.equal(gateway.stats().remainingTransientRetries, 2)
      assert.equal(audits.length, 1)
      assert.equal(audits[0].upstreamAttempts, 1)
      assert.equal(audits[0].transientRetries, 0)
      assert.deepEqual(audits[0].retryStatuses, [])
    } finally {
      await gateway.close()
      await close(upstream)
    }
  }
})

test('所有 retry attempts 共享原始绝对 deadline，timeout 不再重试', async (t) => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    if (upstreamCalls === 1) {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end('{"error":"retry"}')
    }
    // The retry deliberately stays open until the one shared deadline closes it.
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-shared-deadline-test',
    audit: (record) => audits.push(record),
    requestTimeoutMs: 100,
    transientRetryDelaysMs: [30, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const startedAt = Date.now()
  const response = await gatewayFetch(gateway)
  await response.text()
  const elapsedMs = Date.now() - startedAt
  await gateway.waitForIdle()

  assert.equal(response.status, 504)
  assert.ok(elapsedMs < 300, `shared deadline unexpectedly took ${elapsedMs}ms`)
  assert.equal(upstreamCalls, 2)
  assert.equal(gateway.stats().upstreamAttempts, 2)
  assert.equal(gateway.stats().transientRetries, 1)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].status, 504)
  assert.equal(audits[0].upstreamAttempts, 2)
  assert.equal(audits[0].transientRetries, 1)
  assert.deepEqual(audits[0].retryStatuses, [502])
})

test('2xx stream headers 发出后的上游错误不重试', async (t) => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    response.write('data: {"type":"partial"}\n\n')
    setTimeout(() => response.destroy(), 10)
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-stream-error-test',
    audit: (record) => audits.push(record),
    transientRetryDelaysMs: [0, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const response = await gatewayFetch(gateway)
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  await gateway.waitForIdle()

  assert.equal(upstreamCalls, 1)
  assert.equal(gateway.stats().upstreamAttempts, 1)
  assert.equal(gateway.stats().transientRetries, 0)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].status, 502)
  assert.equal(audits[0].upstreamAttempts, 1)
  assert.equal(audits[0].transientRetries, 0)
  assert.deepEqual(audits[0].retryStatuses, [])
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
    localConcurrencyRejectedRequests: 0,
    localBudgetRejectedRequests: 1,
    requestSequence: 5,
    upstreamAttempts: 0,
    transientRetries: 0,
    remainingTransientRetries: 2,
  })
})

test('并发上限拒绝额外请求且 Client abort 会中止上游', async (t) => {
  let releaseFirst
  let firstArrived
  let upstreamRequests = 0
  const audits = []
  const firstArrivedPromise = new Promise((resolve) => { firstArrived = resolve })
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamRequests += 1
    if (upstreamRequests === 1) {
      firstArrived()
      releaseFirst = () => {
        if (response.destroyed) return
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: [DONE]\n\n')
      }
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
    }
  })
  const upstreamUrl = await listen(upstream)
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-concurrency-test',
    audit: (record) => audits.push(record),
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
  assert.match(await second.text(), /concurrency limit/u)
  assert.deepEqual(gateway.stats(), {
    activeRequests: 1,
    totalRequests: 1,
    remainingRequests: 2,
    localConcurrencyRejectedRequests: 1,
    localBudgetRejectedRequests: 0,
    requestSequence: 2,
    upstreamAttempts: 1,
    transientRetries: 0,
    remainingTransientRetries: 2,
  })
  controller.abort()
  await assert.rejects(first, /abort/iu)

  const deadline = Date.now() + 2000
  while (gateway.stats().activeRequests !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(gateway.stats().activeRequests, 0)

  releaseFirst?.()
  assert.equal((await gatewayFetch(gateway)).status, 200)
  assert.equal((await gatewayFetch(gateway)).status, 200)
  await gateway.waitForIdle()
  assert.equal(gateway.stats().totalRequests, 3)
  assert.equal(gateway.stats().remainingRequests, 0)
  assert.equal(audits.find((record) => record.requestSequence === 1)?.status, 499)
  assert.equal(audits.find((record) => record.requestSequence === 1)?.upstreamAttempts, 1)
})

test('waitForIdle includes asynchronous audit completion', async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  const upstreamUrl = await listen(upstream)
  let releaseAudit
  const auditBarrier = new Promise((resolve) => { releaseAudit = resolve })
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-audit-barrier-test',
    audit: () => auditBarrier,
  })
  t.after(async () => {
    releaseAudit()
    await gateway.close()
    await close(upstream)
  })

  assert.equal((await gatewayFetch(gateway)).status, 200)
  let idle = false
  const waiting = gateway.waitForIdle().then(() => { idle = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(idle, false)
  releaseAudit()
  await waiting
  assert.equal(idle, true)
})

test('rotating the dummy credential quarantines late requests without spending budget', async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  const upstreamUrl = await listen(upstream)
  const originalKey = 'attempt-one-dummy-key'
  const nextKey = 'attempt-two-dummy-key'
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-rotation-test',
    candidateApiKey: originalKey,
    maxRequests: 2,
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  gateway.rotateCandidateApiKey(nextKey)
  assert.equal(gateway.candidateApiKey, nextKey)
  const stale = await fetch(`${gateway.url}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${originalKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: 'stale attempt' }),
  })
  assert.equal(stale.status, 401)
  assert.equal(gateway.stats().totalRequests, 0)

  const current = await fetch(`${gateway.url}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${nextKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: 'current attempt' }),
  })
  assert.equal(current.status, 200)
  assert.equal(gateway.stats().totalRequests, 1)
})

test('close flushes a pending audit from a locally rejected request', async (t) => {
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  const upstreamUrl = await listen(upstream)
  let releaseAudit
  const auditBarrier = new Promise((resolve) => { releaseAudit = resolve })
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-close-audit-test',
    audit: () => auditBarrier,
  })
  t.after(async () => {
    releaseAudit()
    await gateway.close()
    await close(upstream)
  })

  const rejected = await fetch(`${gateway.url}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(rejected.status, 401)
  let closed = false
  const closing = gateway.close().then(() => { closed = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(closed, false)
  releaseAudit()
  await closing
  assert.equal(closed, true)
})

test('上游非 2xx 保留状态与安全 headers，同时从 body/header/audit 脱敏', async (t) => {
  const realKey = 'upstream-error-key-123456'
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    upstreamCalls += 1
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
  assert.equal(audits[0].upstreamAttempts, 1)
  assert.equal(audits[0].transientRetries, 0)
  assert.deepEqual(audits[0].retryStatuses, [])
  assert.equal(upstreamCalls, 1)
  assert.equal(gateway.stats().transientRetries, 0)
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(realKey, 'u'))
})

test('401/429/其他非 transient HTTP 状态不会重试', async (t) => {
  const statuses = [400, 401, 429, 504]
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    const status = statuses[upstreamCalls]
    upstreamCalls += 1
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { status } }))
  })
  const upstreamUrl = await listen(upstream)
  const audits = []
  const gateway = await startModelGateway({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    getApiKey: () => 'real-key-non-transient-test',
    audit: (record) => audits.push(record),
    transientRetryDelaysMs: [0, 0],
  })
  t.after(async () => {
    await gateway.close()
    await close(upstream)
  })

  const receivedStatuses = []
  for (const status of statuses) {
    const response = await gatewayFetch(gateway)
    receivedStatuses.push(response.status)
    await response.text()
    assert.equal(response.status, status)
  }
  await gateway.waitForIdle()

  assert.deepEqual(receivedStatuses, statuses)
  assert.equal(upstreamCalls, statuses.length)
  assert.equal(gateway.stats().upstreamAttempts, statuses.length)
  assert.equal(gateway.stats().transientRetries, 0)
  assert.equal(gateway.stats().remainingTransientRetries, 2)
  assert.deepEqual(audits.map((record) => record.retryStatuses), [[], [], [], []])
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
