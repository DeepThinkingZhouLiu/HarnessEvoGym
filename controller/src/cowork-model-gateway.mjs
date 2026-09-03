import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
const AGENT_ROLES = new Set(['solver', 'updater'])
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const MAX_TOKENS_FIELDS = new Set(['max_tokens', 'max_completion_tokens'])
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const ROLE_TOKEN_PATTERN = /^[0-9a-f]{64}$/u
const GATEWAY_DEFINITION_LABEL = 'io.harness-rsi.model-gateway-definition-digest'
const GATEWAY_VERSION_LABEL = 'io.harness-rsi.model-gateway'
const GATEWAY_VERSION = 'v1'
const GATEWAY_BUILDS = new Map()

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

async function gatewayDefinition(repositoryRoot, dockerfile) {
  const dockerfilePath = resolve(repositoryRoot, dockerfile)
  const serverPath = resolve(repositoryRoot, 'docker/model-gateway/server.mjs')
  let dockerfileSource
  let serverSource
  try {
    [dockerfileSource, serverSource] = await Promise.all([
      readFile(dockerfilePath),
      readFile(serverPath),
    ])
  } catch (error) {
    throw new ProtocolError('Model Gateway 镜像定义不可读', [error.message])
  }
  const digest = createHash('sha256')
    .update('Dockerfile\0')
    .update(dockerfileSource)
    .update('\0server.mjs\0')
    .update(serverSource)
    .digest('hex')
  return {
    digest,
    dockerfilePath,
    serverDigest: createHash('sha256').update(serverSource).digest('hex'),
  }
}

async function ensureModelGatewayImage({ config, docker, repositoryRoot, definition }) {
  if (await docker.imageExists(config.image)) {
    const definitionDigest = await docker.imageLabel(config.image, GATEWAY_DEFINITION_LABEL)
    if (definitionDigest === definition.digest) return config.image

    // 兼容本次摘要标签上线前构建的 v1 镜像：只有容器内服务文件
    // 与当前受信源码完全一致时才复用，避免离线环境无谓重建。
    const version = await docker.imageLabel(config.image, GATEWAY_VERSION_LABEL)
    if (definitionDigest === null && version === GATEWAY_VERSION) {
      const imageServerDigest = await docker.imageFileDigest(config.image, '/app/server.mjs')
      if (imageServerDigest === definition.serverDigest) return config.image
    }
  }

  await docker.build({
    context: repositoryRoot,
    dockerfile: definition.dockerfilePath,
    tag: config.image,
    labels: {
      [GATEWAY_DEFINITION_LABEL]: definition.digest,
      [GATEWAY_VERSION_LABEL]: GATEWAY_VERSION,
    },
  })
  return config.image
}

export async function buildModelGatewayImage({ config, docker, repositoryRoot }) {
  const key = `${resolve(repositoryRoot)}\0${config.image}`
  if (!GATEWAY_BUILDS.has(key)) {
    const build = (async () => {
      const definition = await gatewayDefinition(repositoryRoot, config.dockerfile)
      return await ensureModelGatewayImage({ config, docker, repositoryRoot, definition })
    })()
    GATEWAY_BUILDS.set(key, build)
  }
  const build = GATEWAY_BUILDS.get(key)
  try {
    return await build
  } finally {
    if (GATEWAY_BUILDS.get(key) === build) GATEWAY_BUILDS.delete(key)
  }
}

export function validateModelGatewayEnvironment(config) {
  if (!Number.isSafeInteger(config.maximumUpstreamRetries ?? 2)
      || (config.maximumUpstreamRetries ?? 2) < 0
      || (config.maximumUpstreamRetries ?? 2) > 5) {
    throw new ProtocolError('Model Gateway maximumUpstreamRetries 必须是 0..5 的整数')
  }
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

function normalizeRole(role) {
  if (role === undefined) return 'legacy'
  if (!AGENT_ROLES.has(role)) throw new ProtocolError(`Model Gateway Role 无效：${role}`)
  return role
}

function normalizeRolePolicy(role, policy) {
  if (role === 'legacy') {
    if (policy !== undefined) throw new ProtocolError('旧版 Model Gateway Access 不接受 Role Policy')
    return null
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ProtocolError(`${role} Model Gateway Policy 必须是 JSON 对象`)
  }
  if (typeof policy.model !== 'string' || !MODEL_ID_PATTERN.test(policy.model)) {
    throw new ProtocolError(`${role} Model Gateway Policy model 无效`)
  }
  if (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 1 || policy.maxTokens > 1_000_000) {
    throw new ProtocolError(`${role} Model Gateway Policy maxTokens 无效`)
  }
  if (!MAX_TOKENS_FIELDS.has(policy.maxTokensField)) {
    throw new ProtocolError(`${role} Model Gateway Policy maxTokensField 无效`)
  }
  if (policy.reasoningEffort !== null && policy.reasoningEffort !== undefined
      && !REASONING_EFFORTS.has(policy.reasoningEffort)) {
    throw new ProtocolError(`${role} Model Gateway Policy reasoningEffort 无效`)
  }
  return Object.freeze({
    model: policy.model,
    maxTokens: policy.maxTokens,
    maxTokensField: policy.maxTokensField,
    reasoningEffort: policy.reasoningEffort ?? null,
  })
}

export class ModelGateway {
  constructor({ config, docker, repositoryRoot, scopeId }) {
    this.config = config
    this.docker = docker
    this.repositoryRoot = repositoryRoot
    this.scopeId = scopeId
    this.network = null
    this.container = null
    this.startPromise = null
    this.baseAccess = null
    this.tokens = null
    this.rolePolicies = new Map()
    this.roleConfigurationPromises = new Map()
    this.roleTokenRotationPromises = new Map()
  }

  async access(roleInput, policyInput) {
    const role = normalizeRole(roleInput)
    const policy = normalizeRolePolicy(role, policyInput)
    this.startPromise ??= this.start()
    const baseAccess = await this.startPromise
    const rotation = this.roleTokenRotationPromises.get(role)
    if (rotation) await rotation
    if (policy) await this.configureRole(role, policy)
    return {
      ...baseAccess,
      secretEnvironment: {
        [this.config.upstreamApiKeyEnvironment]: this.tokens[role],
      },
    }
  }

  async start() {
    validateModelGatewayEnvironment(this.config)

    const tokens = {
      legacy: randomBytes(32).toString('hex'),
      control: randomBytes(32).toString('hex'),
      solver: randomBytes(32).toString('hex'),
      updater: randomBytes(32).toString('hex'),
    }
    this.tokens = tokens
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
          GATEWAY_MAX_UPSTREAM_RETRIES: String(this.config.maximumUpstreamRetries ?? 2),
        },
        secretEnvironment: {
          GATEWAY_TOKEN: tokens.legacy,
          GATEWAY_CONTROL_TOKEN: tokens.control,
          GATEWAY_SOLVER_TOKEN: tokens.solver,
          GATEWAY_UPDATER_TOKEN: tokens.updater,
        },
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
      this.baseAccess = {
        network: this.network.name,
        environment: {
          [this.config.upstreamBaseUrlEnvironment]: `http://${this.config.alias}:${this.config.port}`,
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
      }
      return this.baseAccess
    } catch (error) {
      const logs = this.container
        ? await this.docker.containerLogs(this.container.name, [
            this.config.upstreamApiKeyEnvironment,
            this.config.upstreamBaseUrlEnvironment,
          ]).catch(() => null)
        : null
      await this.stop()
      const wrapped = new ProtocolError('Model Gateway 启动失败', [
        error.message,
        ...(error.details ?? []),
        logs?.stderr,
        logs?.stdout,
      ].filter(Boolean))
      wrapped.kind = 'infrastructure'
      throw wrapped
    }
  }

  async configureRole(role, policy) {
    const existing = this.rolePolicies.get(role)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(policy)) {
        throw new ProtocolError(`Model Gateway ${role} Policy 在同一 Run 内不允许变更`)
      }
      await this.roleConfigurationPromises.get(role)
      return
    }
    this.rolePolicies.set(role, policy)
    const promise = this.configureRoleInContainer(role, policy).catch((error) => {
      this.rolePolicies.delete(role)
      this.roleConfigurationPromises.delete(role)
      throw error
    })
    this.roleConfigurationPromises.set(role, promise)
    await promise
  }

  async configureRoleInContainer(role, policy) {
    const configureUrl = `http://127.0.0.1:${this.config.port}/rsi/configure-role`
    const script = [
      `const response = await fetch(${JSON.stringify(configureUrl)}, {`,
      "  method: 'POST',",
      "  headers: { authorization: `Bearer ${process.env.GATEWAY_CONTROL_TOKEN}`, 'content-type': 'application/json' },",
      `  body: ${JSON.stringify(JSON.stringify({ role, ...policy }))},`,
      '})',
      "if (!response.ok) throw new Error(`configure endpoint returned ${response.status}`)",
    ].join('\n')
    await this.docker.exec({
      container: this.container.name,
      command: ['node', '--input-type=module', '--eval', script],
      secretValues: [],
    })
  }

  async rotateRoleToken(roleInput) {
    const role = normalizeRole(roleInput)
    if (role === 'legacy') throw new ProtocolError('旧版 Model Gateway Token 不支持轮换')
    this.startPromise ??= this.start()
    await this.startPromise

    // 同一角色的轮换串行化；access() 会等待当前轮换完成后才发放新 Token。
    const previous = this.roleTokenRotationPromises.get(role) ?? Promise.resolve()
    const rotation = previous.catch(() => {}).then(async () => {
      const token = await this.rotateRoleTokenInContainer(role)
      this.tokens[role] = token
      return token
    })
    this.roleTokenRotationPromises.set(role, rotation)
    try {
      return await rotation
    } finally {
      if (this.roleTokenRotationPromises.get(role) === rotation) {
        this.roleTokenRotationPromises.delete(role)
      }
    }
  }

  async rotateRoleTokenInContainer(role) {
    const rotateUrl = `http://127.0.0.1:${this.config.port}/rsi/rotate-role-token`
    const script = [
      `const response = await fetch(${JSON.stringify(rotateUrl)}, {`,
      "  method: 'POST',",
      "  headers: { authorization: `Bearer ${process.env.GATEWAY_CONTROL_TOKEN}`, 'content-type': 'application/json' },",
      `  body: ${JSON.stringify(JSON.stringify({ role }))},`,
      '})',
      "if (!response.ok) throw new Error(`rotate endpoint returned ${response.status}`)",
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
    } catch {
      throw new ProtocolError(`Model Gateway ${role} Token 轮换响应无效`)
    }
    if (value?.ok !== true || value.role !== role || !ROLE_TOKEN_PATTERN.test(value.token)) {
      throw new ProtocolError(`Model Gateway ${role} Token 轮换响应无效`)
    }
    if (value.token === this.tokens[role]) {
      throw new ProtocolError(`Model Gateway ${role} Token 轮换未产生新令牌`)
    }
    return value.token
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

  async usage(roleInput) {
    const role = normalizeRole(roleInput)
    this.startPromise ??= this.start()
    await this.startPromise
    const usageUrl = `http://127.0.0.1:${this.config.port}/rsi/usage${role === 'legacy' ? '' : `?role=${role}`}`
    const script = [
      `const response = await fetch(${JSON.stringify(usageUrl)}, {`,
      "  headers: { authorization: `Bearer ${process.env.GATEWAY_CONTROL_TOKEN}` },",
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
    this.startPromise = null
    this.baseAccess = null
    this.tokens = null
    this.rolePolicies.clear()
    this.roleConfigurationPromises.clear()
    this.roleTokenRotationPromises.clear()
    return errors
  }
}
