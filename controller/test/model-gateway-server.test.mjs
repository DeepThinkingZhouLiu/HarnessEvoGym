import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return server.address().port
}

async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function waitForGateway(url, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Model Gateway 提前退出：${stderr.join('')}`)
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok) return
    } catch {
      // 子进程仍在启动；短暂等待后重试。
    }
    await delay(20)
  }
  throw new Error(`Model Gateway 启动超时：${stderr.join('')}`)
}

function slowHttpPost(url, token, body, pauseMs = 0) {
  const target = new URL(url)
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk))
        if (pauseMs > 0) {
          response.pause()
          setTimeout(() => response.resume(), pauseMs)
        }
      })
      response.once('end', () => resolveRequest({
        status: response.statusCode,
        body: Buffer.concat(chunks),
      }))
      response.once('error', rejectRequest)
    })
    request.once('error', rejectRequest)
    request.end(body)
  })
}

function abortAfterFirstResponseChunk(url, token, body) {
  const target = new URL(url)
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (response) => {
      response.once('data', () => {
        settled = true
        const status = response.statusCode
        response.destroy()
        resolveRequest(status)
      })
      response.once('end', () => {
        if (!settled) rejectRequest(new Error('Gateway 在客户端中断前未返回数据'))
      })
      response.on('error', () => {
        // 这是测试主动中断读取后的预期事件。
      })
    })
    request.once('error', (error) => {
      if (!settled) rejectRequest(error)
    })
    request.end(body)
  })
}

function ssePayload(prefix, eventCount, usage) {
  const lines = []
  for (let index = 0; index < eventCount; index += 1) {
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { content: `${prefix}-片段🙂-${String(index).padStart(4, '0')}` } }],
    })}`, '')
  }
  lines.push(`data: ${JSON.stringify({ choices: [], usage })}`, '', 'data: [DONE]', '')
  return lines.join('\n')
}

function writeAsynchronousChunks(response, payload) {
  const bytes = Buffer.from(payload)
  const sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584]
  let offset = 0
  let index = 0
  const writeNext = () => {
    if (offset >= bytes.length) {
      response.end()
      return
    }
    const size = sizes[index % sizes.length]
    index += 1
    const next = bytes.subarray(offset, Math.min(bytes.length, offset + size))
    offset += next.length
    if (response.write(next)) setImmediate(writeNext)
    else response.once('drain', () => setImmediate(writeNext))
  }
  writeNext()
}

test('Model Gateway 校验令牌并只向固定 chat/completions 转发', async () => {
  const providerKey = 'provider-key-for-test'
  const gatewayToken = 'a'.repeat(64)
  const upstreamRequests = []
  const upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      upstreamRequests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_cache_hit_tokens":3,"completion_tokens_details":{"reasoning_tokens":2}}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })
  const upstreamPort = await listen(upstream)
  const gatewayPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, [resolve(repositoryRoot, 'docker/model-gateway/server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: gatewayToken,
      UPSTREAM_API_KEY_ENV: 'TEST_UPSTREAM_KEY',
      UPSTREAM_BASE_URL_ENV: 'TEST_UPSTREAM_URL',
      GATEWAY_MAX_REQUESTS: '10',
      GATEWAY_MAX_CONCURRENT_REQUESTS: '2',
      TEST_UPSTREAM_KEY: providerKey,
      TEST_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  try {
    await waitForGateway(gatewayUrl, child, stderr)
    const unauthorized = await fetch(`${gatewayUrl}/chat/completions`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(unauthorized.status, 401)

    const notFound = await fetch(`${gatewayUrl}/models`, {
      headers: { authorization: `Bearer ${gatewayToken}` },
    })
    assert.equal(notFound.status, 404)

    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      n: 2,
      stream: false,
      stream_options: { include_usage: false },
    })
    const proxied = await fetch(`${gatewayUrl}/chat/completions`, {
      method: 'POST',
      body,
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        'content-type': 'application/json',
      },
    })
    assert.equal(proxied.status, 200)
    assert.match(await proxied.text(), /delta/u)
    assert.deepEqual(upstreamRequests, [{
      path: '/v1/chat/completions',
      authorization: `Bearer ${providerKey}`,
      body,
    }])
    const usageResponse = await fetch(`${gatewayUrl}/rsi/usage`, {
      headers: { authorization: `Bearer ${gatewayToken}` },
    })
    assert.equal(usageResponse.status, 200)
    assert.deepEqual(await usageResponse.json(), {
      acceptedRequests: 1,
      activeRequests: 0,
      usageResponses: 1,
      unknownUsageResponses: 0,
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    })
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit))
    await new Promise((resolveClose) => upstream.close(resolveClose))
  }
})

test('Model Gateway 按 Solver/Updater 强制覆盖可信模型并分角色计量', async () => {
  const providerKey = 'provider-key-for-role-test'
  const legacyToken = 'a'.repeat(64)
  const controlToken = 'b'.repeat(64)
  const solverToken = 'c'.repeat(64)
  const updaterToken = 'd'.repeat(64)
  const upstreamRequests = []
  const upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })
  const upstreamPort = await listen(upstream)
  const gatewayPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, [resolve(repositoryRoot, 'docker/model-gateway/server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: legacyToken,
      GATEWAY_CONTROL_TOKEN: controlToken,
      GATEWAY_SOLVER_TOKEN: solverToken,
      GATEWAY_UPDATER_TOKEN: updaterToken,
      UPSTREAM_API_KEY_ENV: 'TEST_UPSTREAM_KEY',
      UPSTREAM_BASE_URL_ENV: 'TEST_UPSTREAM_URL',
      GATEWAY_MAX_REQUESTS: '10',
      GATEWAY_MAX_CONCURRENT_REQUESTS: '2',
      TEST_UPSTREAM_KEY: providerKey,
      TEST_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  const request = async (path, token, options = {}) => await fetch(`${gatewayUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  })
  const configure = async (policy, token = controlToken) => await request('/rsi/configure-role', token, {
    method: 'POST',
    body: JSON.stringify(policy),
  })
  const rotate = async (role, token = controlToken) => await request('/rsi/rotate-role-token', token, {
    method: 'POST',
    body: JSON.stringify({ role }),
  })

  try {
    await waitForGateway(gatewayUrl, child, stderr)
    assert.equal((await configure({
      role: 'solver', model: 'trusted-solver', maxTokens: 111, maxTokensField: 'max_tokens',
      reasoningEffort: 'high',
    }, solverToken)).status, 401)
    assert.equal((await request('/chat/completions', solverToken, {
      method: 'POST', body: JSON.stringify({ model: 'attacker' }),
    })).status, 503)
    assert.equal((await configure({
      role: 'solver', model: 'trusted-solver', maxTokens: 111, maxTokensField: 'max_tokens',
      reasoningEffort: 'high',
    })).status, 200)
    assert.equal((await configure({
      role: 'updater', model: 'trusted-updater', maxTokens: 222, maxTokensField: 'max_completion_tokens',
    })).status, 200)
    assert.equal((await configure({
      role: 'solver', model: 'changed-model', maxTokens: 111, maxTokensField: 'max_tokens',
      reasoningEffort: 'high',
    })).status, 409)

    const solverResponse = await request('/chat/completions', solverToken, {
      method: 'POST',
      body: JSON.stringify({
        model: 'attacker-model',
        max_tokens: 999999,
        max_completion_tokens: 999999,
        n: 99,
        stream: false,
        stream_options: { include_usage: false },
        best_of: 99,
        num_return_sequences: 99,
        reasoning: { effort: 'low' },
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'solver' }],
      }),
    })
    assert.equal(solverResponse.status, 200)
    await solverResponse.text()

    assert.equal((await rotate('solver', solverToken)).status, 401)
    const rotationResponse = await rotate('solver')
    assert.equal(rotationResponse.status, 200)
    const rotation = await rotationResponse.json()
    assert.equal(rotation.role, 'solver')
    assert.match(rotation.token, /^[0-9a-f]{64}$/u)
    assert.notEqual(rotation.token, solverToken)
    assert.equal((await request('/chat/completions', solverToken, {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'expired' }] }),
    })).status, 401)
    const renewedSolverResponse = await request('/chat/completions', rotation.token, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'renewed-solver' }] }),
    })
    assert.equal(renewedSolverResponse.status, 200)
    await renewedSolverResponse.text()

    const updaterResponse = await request('/chat/completions', updaterToken, {
      method: 'POST',
      body: JSON.stringify({
        model: 'attacker-model',
        max_tokens: 999999,
        max_completion_tokens: 999999,
        messages: [{ role: 'user', content: 'updater' }],
      }),
    })
    assert.equal(updaterResponse.status, 200)
    await updaterResponse.text()

    assert.deepEqual(upstreamRequests, [
      {
        model: 'trusted-solver',
        max_tokens: 111,
        reasoning_effort: 'high',
        n: 1,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'solver' }],
      },
      {
        model: 'trusted-solver',
        max_tokens: 111,
        messages: [{ role: 'user', content: 'renewed-solver' }],
        reasoning_effort: 'high',
        n: 1,
        stream: true,
        stream_options: { include_usage: true },
      },
      {
        model: 'trusted-updater',
        max_completion_tokens: 222,
        messages: [{ role: 'user', content: 'updater' }],
        n: 1,
        stream: true,
        stream_options: { include_usage: true },
      },
    ])
    assert.equal((await request('/rsi/usage?role=updater', solverToken)).status, 401)
    assert.equal((await request('/rsi/usage?role=updater', rotation.token)).status, 403)
    const solverUsage = await request('/rsi/usage?role=solver', controlToken)
    const updaterUsage = await request('/rsi/usage?role=updater', controlToken)
    const aggregateUsage = await request('/rsi/usage', legacyToken)
    assert.deepEqual(await solverUsage.json(), {
      acceptedRequests: 2,
      activeRequests: 0,
      usageResponses: 2,
      unknownUsageResponses: 0,
      inputTokens: 6,
      outputTokens: 4,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    })
    assert.equal((await updaterUsage.json()).acceptedRequests, 1)
    assert.equal((await aggregateUsage.json()).acceptedRequests, 3)
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit))
    await new Promise((resolveClose) => upstream.close(resolveClose))
  }
})

test('Model Gateway 在未下发 Header 前有限重试上游 502/503/504', async () => {
  const providerKey = 'provider-key-for-retry-test'
  const gatewayToken = 'a'.repeat(64)
  let upstreamAttempts = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      upstreamAttempts += 1
      if (upstreamAttempts === 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end('{"error":"overloaded"}')
        return
      }
      if (upstreamAttempts === 2) {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end('{"error":"bad_gateway"}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"recovered"}}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })
  const upstreamPort = await listen(upstream)
  const gatewayPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, [resolve(repositoryRoot, 'docker/model-gateway/server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: gatewayToken,
      UPSTREAM_API_KEY_ENV: 'TEST_UPSTREAM_KEY',
      UPSTREAM_BASE_URL_ENV: 'TEST_UPSTREAM_URL',
      GATEWAY_MAX_REQUESTS: '10',
      GATEWAY_MAX_CONCURRENT_REQUESTS: '2',
      TEST_UPSTREAM_KEY: providerKey,
      TEST_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  try {
    await waitForGateway(gatewayUrl, child, stderr)
    const proxied = await fetch(`${gatewayUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'retry' }] }),
    })
    assert.equal(proxied.status, 200)
    assert.match(await proxied.text(), /recovered/u)
    assert.equal(upstreamAttempts, 3)

    const usageResponse = await fetch(`${gatewayUrl}/rsi/usage`, {
      headers: { authorization: `Bearer ${gatewayToken}` },
    })
    assert.deepEqual(await usageResponse.json(), {
      acceptedRequests: 1,
      activeRequests: 0,
      usageResponses: 1,
      unknownUsageResponses: 0,
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    })
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit))
    await new Promise((resolveClose) => upstream.close(resolveClose))
  }
})

test('Model Gateway 在预缓冲、大量异步分块和慢客户端下原样转发 SSE', async () => {
  const providerKey = 'provider-key-for-stream-test'
  const legacyToken = 'a'.repeat(64)
  const controlToken = 'b'.repeat(64)
  const solverToken = 'c'.repeat(64)
  const updaterToken = 'd'.repeat(64)
  const synchronousPayload = ssePayload('sync', 2771, {
    prompt_tokens: 17,
    completion_tokens: 9,
  })
  const asynchronousPayload = ssePayload('async', 1400, {
    prompt_tokens: 19,
    completion_tokens: 11,
  })
  const upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const scenario = payload.messages?.at(-1)?.content
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (scenario === 'sync-prebuffer') {
        // 在 Gateway 收到 header callback 前，上游已经一次性写完大量 body。
        response.end(synchronousPayload)
      } else if (scenario === 'async-chunks') {
        writeAsynchronousChunks(response, asynchronousPayload)
      } else {
        response.end('unexpected scenario')
      }
    })
  })
  const upstreamPort = await listen(upstream)
  const gatewayPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, [resolve(repositoryRoot, 'docker/model-gateway/server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: legacyToken,
      GATEWAY_CONTROL_TOKEN: controlToken,
      GATEWAY_SOLVER_TOKEN: solverToken,
      GATEWAY_UPDATER_TOKEN: updaterToken,
      UPSTREAM_API_KEY_ENV: 'TEST_UPSTREAM_KEY',
      UPSTREAM_BASE_URL_ENV: 'TEST_UPSTREAM_URL',
      GATEWAY_MAX_REQUESTS: '10',
      GATEWAY_MAX_CONCURRENT_REQUESTS: '2',
      TEST_UPSTREAM_KEY: providerKey,
      TEST_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  try {
    await waitForGateway(gatewayUrl, child, stderr)
    const configured = await fetch(`${gatewayUrl}/rsi/configure-role`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        role: 'solver',
        model: 'trusted-solver',
        maxTokens: 4096,
        maxTokensField: 'max_tokens',
      }),
    })
    assert.equal(configured.status, 200)

    const synchronous = await slowHttpPost(
      `${gatewayUrl}/chat/completions`,
      solverToken,
      JSON.stringify({ messages: [{ role: 'user', content: 'sync-prebuffer' }] }),
      1,
    )
    assert.equal(synchronous.status, 200)
    assert.equal(synchronous.body.equals(Buffer.from(synchronousPayload)), true)

    const asynchronous = await slowHttpPost(
      `${gatewayUrl}/chat/completions`,
      solverToken,
      JSON.stringify({ messages: [{ role: 'user', content: 'async-chunks' }] }),
      1,
    )
    assert.equal(asynchronous.status, 200)
    assert.equal(asynchronous.body.equals(Buffer.from(asynchronousPayload)), true)

    const usageResponse = await fetch(`${gatewayUrl}/rsi/usage?role=solver`, {
      headers: { authorization: `Bearer ${controlToken}` },
    })
    assert.equal(usageResponse.status, 200)
    assert.deepEqual(await usageResponse.json(), {
      acceptedRequests: 2,
      activeRequests: 0,
      usageResponses: 2,
      unknownUsageResponses: 0,
      inputTokens: 36,
      outputTokens: 20,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    })
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit))
    await new Promise((resolveClose) => upstream.close(resolveClose))
  }
})

test('Model Gateway 在客户端提前关闭时停止上游并标记 Usage 不完整', async () => {
  const providerKey = 'provider-key-for-abort-test'
  const legacyToken = 'a'.repeat(64)
  const controlToken = 'b'.repeat(64)
  const solverToken = 'c'.repeat(64)
  const updaterToken = 'd'.repeat(64)
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
      const timer = setTimeout(() => response.end([
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')), 250)
      response.once('close', () => clearTimeout(timer))
    })
  })
  const upstreamPort = await listen(upstream)
  const gatewayPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, [resolve(repositoryRoot, 'docker/model-gateway/server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: legacyToken,
      GATEWAY_CONTROL_TOKEN: controlToken,
      GATEWAY_SOLVER_TOKEN: solverToken,
      GATEWAY_UPDATER_TOKEN: updaterToken,
      UPSTREAM_API_KEY_ENV: 'TEST_UPSTREAM_KEY',
      UPSTREAM_BASE_URL_ENV: 'TEST_UPSTREAM_URL',
      GATEWAY_MAX_REQUESTS: '10',
      GATEWAY_MAX_CONCURRENT_REQUESTS: '2',
      TEST_UPSTREAM_KEY: providerKey,
      TEST_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  try {
    await waitForGateway(gatewayUrl, child, stderr)
    const configured = await fetch(`${gatewayUrl}/rsi/configure-role`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        role: 'solver',
        model: 'trusted-solver',
        maxTokens: 4096,
        maxTokensField: 'max_tokens',
      }),
    })
    assert.equal(configured.status, 200)
    assert.equal(await abortAfterFirstResponseChunk(
      `${gatewayUrl}/chat/completions`,
      solverToken,
      JSON.stringify({ messages: [{ role: 'user', content: 'abort' }] }),
    ), 200)

    let usage
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${gatewayUrl}/rsi/usage?role=solver`, {
        headers: { authorization: `Bearer ${controlToken}` },
      })
      usage = await response.json()
      if (usage.activeRequests === 0 && usage.unknownUsageResponses === 1) break
      await delay(10)
    }
    assert.deepEqual(usage, {
      acceptedRequests: 1,
      activeRequests: 0,
      usageResponses: 0,
      unknownUsageResponses: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    })
    assert.equal((await fetch(`${gatewayUrl}/healthz`)).status, 200)
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolveExit) => child.once('exit', resolveExit))
    await new Promise((resolveClose) => upstream.close(resolveClose))
  }
})
