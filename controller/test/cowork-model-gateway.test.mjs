import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildModelGatewayImage,
  diffModelUsage,
  ModelGateway,
  validateModelGatewayEnvironment,
} from '../src/cowork-model-gateway.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'

test('Model Gateway 只把一次性令牌和内部地址交给 Agent', async () => {
  const originalKey = process.env.TEST_RSI_API_KEY
  const originalUrl = process.env.TEST_RSI_BASE_URL
  process.env.TEST_RSI_API_KEY = 'real-provider-secret'
  process.env.TEST_RSI_BASE_URL = 'https://provider.example/v1'
  const calls = []
  const docker = {
    async imageExists() { return false },
    async build(options) { calls.push(['build', options]) },
    async createNetwork() { return { id: 'network-id', name: 'internal-net' } },
    async runDetached(options) {
      calls.push(['run', options])
      return { id: 'container-id', name: 'gateway' }
    },
    async connectNetwork() {},
    async containerHealth() { return 'healthy' },
    async removeContainer() {},
    async removeNetwork() {},
    async containerLogs() { return { stdout: '', stderr: '' } },
    async exec(options) {
      calls.push(['exec', options])
      if (options.command.join(' ').includes('/rsi/rotate-role-token')) {
        return {
          stdout: JSON.stringify({ ok: true, role: 'solver', token: 'e'.repeat(64) }),
          stderr: '',
        }
      }
      return {
        stdout: JSON.stringify({
          acceptedRequests: 1,
          activeRequests: 0,
          usageResponses: 1,
          unknownUsageResponses: 0,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          reasoningTokens: 5,
        }),
        stderr: '',
      }
    },
  }
  const gateway = new ModelGateway({
    config: {
      image: 'gateway:test',
      dockerfile: 'docker/model-gateway/Dockerfile',
      alias: 'model-gateway',
      port: 8080,
      egressNetwork: 'bridge',
      upstreamApiKeyEnvironment: 'TEST_RSI_API_KEY',
      upstreamBaseUrlEnvironment: 'TEST_RSI_BASE_URL',
      maximumRequestsPerRun: 512,
      maximumConcurrentRequests: 8,
      maximumUpstreamRetries: 5,
      resources: { cpus: 1, memory: '512m', pids: 128 },
    },
    docker,
    repositoryRoot: REPOSITORY_ROOT,
    scopeId: 'run-one',
  })
  try {
    const access = await gateway.access()
    assert.equal(access.network, 'internal-net')
    assert.equal(access.environment.TEST_RSI_BASE_URL, 'http://model-gateway:8080')
    assert.notEqual(access.secretEnvironment.TEST_RSI_API_KEY, process.env.TEST_RSI_API_KEY)
    assert.equal(access.secretEnvironment.TEST_RSI_API_KEY.length, 64)
    const solverAccess = await gateway.access('solver', {
      model: 'trusted-solver',
      maxTokens: 2048,
      maxTokensField: 'max_tokens',
      reasoningEffort: 'high',
    })
    const updaterAccess = await gateway.access('updater', {
      model: 'trusted-updater',
      maxTokens: 4096,
      maxTokensField: 'max_completion_tokens',
    })
    assert.notEqual(
      solverAccess.secretEnvironment.TEST_RSI_API_KEY,
      updaterAccess.secretEnvironment.TEST_RSI_API_KEY,
    )
    const expiredSolverToken = solverAccess.secretEnvironment.TEST_RSI_API_KEY
    await gateway.rotateRoleToken('solver')
    const renewedSolverAccess = await gateway.access('solver', {
      model: 'trusted-solver',
      maxTokens: 2048,
      maxTokensField: 'max_tokens',
      reasoningEffort: 'high',
    })
    assert.equal(renewedSolverAccess.secretEnvironment.TEST_RSI_API_KEY, 'e'.repeat(64))
    assert.notEqual(renewedSolverAccess.secretEnvironment.TEST_RSI_API_KEY, expiredSolverToken)
    assert.notEqual(access.secretEnvironment.TEST_RSI_API_KEY, solverAccess.secretEnvironment.TEST_RSI_API_KEY)
    const runOptions = calls.find(([name]) => name === 'run')[1]
    assert.equal(runOptions.environment.GATEWAY_TOKEN, undefined)
    assert.equal(runOptions.environment.GATEWAY_MAX_UPSTREAM_RETRIES, '5')
    assert.equal(runOptions.secretEnvironment.GATEWAY_TOKEN.length, 64)
    assert.equal(runOptions.secretEnvironment.GATEWAY_CONTROL_TOKEN.length, 64)
    assert.equal(runOptions.secretEnvironment.GATEWAY_SOLVER_TOKEN.length, 64)
    assert.equal(runOptions.secretEnvironment.GATEWAY_UPDATER_TOKEN.length, 64)
    assert.equal(new Set(Object.values(runOptions.secretEnvironment)).size, 4)
    assert.deepEqual(runOptions.inheritEnvironment, [
      'TEST_RSI_API_KEY',
      'TEST_RSI_BASE_URL',
    ])
    await assert.rejects(
      () => gateway.access('solver', {
        model: 'untrusted-reconfiguration',
        maxTokens: 2048,
        maxTokensField: 'max_tokens',
      }),
      /Policy 在同一 Run 内不允许变更/u,
    )
    const usage = await gateway.usage('solver')
    assert.equal(usage.inputTokens, 100)
    const execScripts = calls.filter(([name]) => name === 'exec').map(([, options]) => options.command.join(' '))
    assert.ok(execScripts.some((script) => script.includes('trusted-solver')))
    assert.ok(execScripts.some((script) => script.includes('reasoningEffort\\\":\\\"high')))
    assert.ok(execScripts.some((script) => script.includes('trusted-updater')))
    assert.ok(execScripts.some((script) => script.includes('/rsi/rotate-role-token')))
    assert.ok(execScripts.some((script) => script.includes('/rsi/usage?role=solver')))
    assert.doesNotMatch(execScripts.join('\n'), new RegExp('e{64}', 'u'))
    assert.doesNotMatch(execScripts.join('\n'), /real-provider-secret/u)
  } finally {
    await gateway.stop()
    if (originalKey === undefined) delete process.env.TEST_RSI_API_KEY
    else process.env.TEST_RSI_API_KEY = originalKey
    if (originalUrl === undefined) delete process.env.TEST_RSI_BASE_URL
    else process.env.TEST_RSI_BASE_URL = originalUrl
  }
})

test('Model Gateway 并发准备只构建一次且绑定定义摘要', async () => {
  const calls = []
  const docker = {
    async imageExists() { return false },
    async build(options) {
      calls.push(options)
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    },
  }
  const config = {
    image: 'gateway:concurrent-test',
    dockerfile: 'docker/model-gateway/Dockerfile',
  }
  await Promise.all(Array.from({ length: 5 }, () => buildModelGatewayImage({
    config,
    docker,
    repositoryRoot: REPOSITORY_ROOT,
  })))
  assert.equal(calls.length, 1)
  assert.match(
    calls[0].labels['io.harness-rsi.model-gateway-definition-digest'],
    /^[0-9a-f]{64}$/u,
  )
  assert.equal(calls[0].labels['io.harness-rsi.model-gateway'], 'v1')
})

test('Model Gateway 可复用服务文件一致的旧 v1 镜像', async () => {
  let builds = 0
  const docker = {
    async imageExists() { return true },
    async imageLabel(_image, label) {
      if (label === 'io.harness-rsi.model-gateway') return 'v1'
      return null
    },
    async imageFileDigest() {
      return 'da3e1e846e41739162cbd2d71546810b55316ba136f9d4f0034cd7809d65da49'
    },
    async build() { builds += 1 },
  }
  await buildModelGatewayImage({
    config: { image: 'gateway:legacy-test', dockerfile: 'docker/model-gateway/Dockerfile' },
    docker,
    repositoryRoot: REPOSITORY_ROOT,
  })
  assert.equal(builds, 0)
})

test('Model Gateway Usage 差分会把未知响应标成不完整', () => {
  const before = {
    acceptedRequests: 2,
    activeRequests: 0,
    usageResponses: 2,
    unknownUsageResponses: 0,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    reasoningTokens: 5,
  }
  const after = {
    acceptedRequests: 4,
    activeRequests: 0,
    usageResponses: 3,
    unknownUsageResponses: 1,
    inputTokens: 180,
    outputTokens: 35,
    cacheReadTokens: 15,
    reasoningTokens: 8,
  }
  const usage = diffModelUsage(before, after)
  assert.equal(usage.acceptedRequests, 2)
  assert.equal(usage.inputTokens, 80)
  assert.equal(usage.complete, false)
})

test('Model Gateway 在启动前拒绝带凭据或 Query 的上游 URL', () => {
  const originalKey = process.env.TEST_RSI_API_KEY
  const originalUrl = process.env.TEST_RSI_BASE_URL
  process.env.TEST_RSI_API_KEY = 'valid-test-key'
  process.env.TEST_RSI_BASE_URL = 'https://user:password@provider.example/v1?unsafe=1'
  try {
    assert.throws(
      () => validateModelGatewayEnvironment({
        upstreamApiKeyEnvironment: 'TEST_RSI_API_KEY',
        upstreamBaseUrlEnvironment: 'TEST_RSI_BASE_URL',
      }),
      /不能包含凭据/u,
    )
  } finally {
    if (originalKey === undefined) delete process.env.TEST_RSI_API_KEY
    else process.env.TEST_RSI_API_KEY = originalKey
    if (originalUrl === undefined) delete process.env.TEST_RSI_BASE_URL
    else process.env.TEST_RSI_BASE_URL = originalUrl
  }
})
