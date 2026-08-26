import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { ProtocolError } from './protocol.mjs'

const USAGE_COUNTER_FIELDS = [
  'acceptedRequests',
  'usageResponses',
  'unknownUsageResponses',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'reasoningTokens',
]
const USAGE_SNAPSHOT_FIELDS = [...USAGE_COUNTER_FIELDS, 'activeRequests']

function validateUsageSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('Model Gateway Usage 必须是 JSON 对象')
  }
  for (const field of USAGE_SNAPSHOT_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new ProtocolError(`Model Gateway Usage 字段无效：${field}`)
    }
  }
  return Object.fromEntries(USAGE_SNAPSHOT_FIELDS.map((field) => [field, value[field]]))
}

export function diffModelUsage(before, after) {
  const first = validateUsageSnapshot(before)
  const second = validateUsageSnapshot(after)
  const delta = {}
  for (const field of USAGE_COUNTER_FIELDS) {
    delta[field] = second[field] - first[field]
    if (delta[field] < 0) throw new ProtocolError(`Model Gateway Usage 计数器发生倒退：${field}`)
  }
  const accountedResponses = delta.usageResponses + delta.unknownUsageResponses
  return {
    ...delta,
    activeRequests: second.activeRequests,
    complete:
      second.activeRequests === 0 &&
      delta.unknownUsageResponses === 0 &&
      accountedResponses === delta.acceptedRequests,
  }
}

export async function buildModelGatewayImage({ config, docker, repositoryRoot }) {
  await docker.build({
    context: repositoryRoot,
    dockerfile: resolve(repositoryRoot, config.dockerfile),
    tag: config.image,
  })
  return config.image
}

export function validateModelGatewayEnvironment(config) {
  const apiKey = process.env[config.upstreamApiKeyEnvironment]
  const baseUrl = process.env[config.upstreamBaseUrlEnvironment]
  if (!apiKey || !baseUrl) {
    throw new ProtocolError('启动 Model Gateway 所需的上游环境变量缺失', [
      config.upstreamApiKeyEnvironment,
      config.upstreamBaseUrlEnvironment,
    ])
  }
  if (apiKey.trim() !== apiKey || /[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new ProtocolError(`上游 API Key 环境变量格式非法：${config.upstreamApiKeyEnvironment}`)
  }
  let parsedBaseUrl
  try {
    parsedBaseUrl = new URL(baseUrl)
  } catch (error) {
    throw new ProtocolError('上游 Model Base URL 无效', [error.message])
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new ProtocolError('上游 Model Base URL 只支持 HTTP(S)')
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new ProtocolError('上游 Model Base URL 不能包含凭据、Query 或 Fragment')
  }
  return { apiKey, baseUrl }
}

export class ModelGateway {
  constructor({ config, docker, repositoryRoot, scopeId }) {
    this.config = config
    this.docker = docker
    this.repositoryRoot = repositoryRoot
    this.scopeId = scopeId
    this.network = null
    this.container = null
    this.accessPromise = null
  }

  async access() {
    this.accessPromise ??= this.start()
    return await this.accessPromise
  }

  async start() {
    validateModelGatewayEnvironment(this.config)

    const token = randomBytes(32).toString('hex')
    const networkName = `${this.scopeId}-model-net`
    const containerName = `${this.scopeId}-model-gateway`
    try {
      await buildModelGatewayImage({
        config: this.config,
        docker: this.docker,
        repositoryRoot: this.repositoryRoot,
      })
      this.network = await this.docker.createNetwork({ name: networkName, internal: true })
      this.container = await this.docker.runDetached({
        image: this.config.image,
        name: containerName,
        network: this.config.egressNetwork,
        environment: {
          GATEWAY_PORT: String(this.config.port),
          UPSTREAM_API_KEY_ENV: this.config.upstreamApiKeyEnvironment,
          UPSTREAM_BASE_URL_ENV: this.config.upstreamBaseUrlEnvironment,
          GATEWAY_MAX_REQUESTS: String(this.config.maximumRequestsPerRun),
          GATEWAY_MAX_CONCURRENT_REQUESTS: String(this.config.maximumConcurrentRequests),
        },
        secretEnvironment: { GATEWAY_TOKEN: token },
        inheritEnvironment: [
          this.config.upstreamApiKeyEnvironment,
          this.config.upstreamBaseUrlEnvironment,
        ],
        resources: this.config.resources,
      })
      await this.docker.connectNetwork({
        network: this.network.name,
        container: this.container.name,
        alias: this.config.alias,
      })
      await this.waitUntilHealthy()
      const noProxy = `localhost,127.0.0.1,::1,${this.config.alias}`
      return {
        network: this.network.name,
        environment: {
          [this.config.upstreamBaseUrlEnvironment]: `http://${this.config.alias}:${this.config.port}`,
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
        secretEnvironment: { [this.config.upstreamApiKeyEnvironment]: token },
      }
    } catch (error) {
      const logs = this.container
        ? await this.docker.containerLogs(this.container.name, [
            this.config.upstreamApiKeyEnvironment,
            this.config.upstreamBaseUrlEnvironment,
          ]).catch(() => null)
        : null
      await this.stop()
      throw new ProtocolError('Model Gateway 启动失败', [
        error.message,
        ...(error.details ?? []),
        logs?.stderr,
        logs?.stdout,
      ].filter(Boolean))
    }
  }

  async waitUntilHealthy() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await this.docker.containerHealth(this.container.name)
      if (status === 'healthy') return
      if (['dead', 'exited', 'unhealthy'].includes(status)) {
        throw new ProtocolError(`Model Gateway 容器状态异常：${status}`)
      }
      await delay(250)
    }
    throw new ProtocolError('Model Gateway 健康检查超时')
  }

  async usage() {
    await this.access()
    const usageUrl = `http://127.0.0.1:${this.config.port}/rsi/usage`
    const script = [
      `const response = await fetch(${JSON.stringify(usageUrl)}, {`,
      "  headers: { authorization: `Bearer ${process.env.GATEWAY_TOKEN}` },",
      '})',
      "if (!response.ok) throw new Error(`usage endpoint returned ${response.status}`)",
      'process.stdout.write(JSON.stringify(await response.json()))',
    ].join('\n')
    const result = await this.docker.exec({
      container: this.container.name,
      command: ['node', '--input-type=module', '--eval', script],
      secretValues: [],
    })
    let value
    try {
      value = JSON.parse(result.stdout)
    } catch (error) {
      throw new ProtocolError('Model Gateway Usage 响应不是合法 JSON', [error.message])
    }
    return validateUsageSnapshot(value)
  }

  async stop() {
    const errors = []
    if (this.container) {
      await this.docker.removeContainer(this.container.name).catch((error) => errors.push(error.message))
      this.container = null
    }
    if (this.network) {
      await this.docker.removeNetwork(this.network.name).catch((error) => errors.push(error.message))
      this.network = null
    }
    this.accessPromise = null
    return errors
  }
}
