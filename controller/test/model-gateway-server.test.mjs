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
    }, solverToken)).status, 401)
    assert.equal((await request('/chat/completions', solverToken, {
      method: 'POST', body: JSON.stringify({ model: 'attacker' }),
    })).status, 503)
    assert.equal((await configure({
      role: 'solver', model: 'trusted-solver', maxTokens: 111, maxTokensField: 'max_tokens',
    })).status, 200)
    assert.equal((await configure({
      role: 'updater', model: 'trusted-updater', maxTokens: 222, maxTokensField: 'max_completion_tokens',
    })).status, 200)
    assert.equal((await configure({
      role: 'solver', model: 'changed-model', maxTokens: 111, maxTokensField: 'max_tokens',
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
        n: 1,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'solver' }],
      },
      {
        model: 'trusted-solver',
        max_tokens: 111,
        messages: [{ role: 'user', content: 'renewed-solver' }],
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
