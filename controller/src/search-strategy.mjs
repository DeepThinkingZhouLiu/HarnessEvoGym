import { randomUUID } from 'node:crypto'

import { MUTATION_RISK_LEVELS, validateMutationPlan } from './mutation-catalog.mjs'
import { ProtocolError } from './protocol.mjs'

const BUILTIN_STRATEGIES = new Map()
const MAXIMUM_PROTOCOL_BYTES = 256 * 1024
const MAXIMUM_STATE_BYTES = 64 * 1024
// Docker CLI 可能从 ~/.docker/config.json 隐式注入代理变量。即使 Strategy 断网，
// 也要显式传空，避免宿主代理地址或其中的凭据进入不可信容器。
const EMPTY_STANDARD_PROXY_ENVIRONMENT = Object.freeze(Object.fromEntries([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
].map((name) => [name, ''])))
const FORBIDDEN_CONTEXT_KEYS = new Set([
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'final',
  'record',
  'records',
  'secret',
  'secrets',
  'token',
  'trace',
  'traces',
])

function assertPlainJson(value, label, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProtocolError(`${label} 包含非有限数字：${path}`)
    return
  }
  if (typeof value !== 'object') {
    throw new ProtocolError(`${label} 包含非 JSON 值：${path}`)
  }
  if (seen.has(value)) throw new ProtocolError(`${label} 包含循环引用：${path}`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, label, `${path}[${index}]`, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProtocolError(`${label} 只能包含普通 JSON 对象：${path}`)
    }
    for (const [key, child] of Object.entries(value)) {
      assertPlainJson(child, label, `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function jsonClone(value, label, maximumBytes = MAXIMUM_STATE_BYTES) {
  if (value === undefined || value === null) return null
  assertPlainJson(value, label)
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new ProtocolError(`${label} 必须是可序列化 JSON`, [error.message])
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new ProtocolError(`${label} 超过 ${maximumBytes} bytes`)
  }
  const cloned = JSON.parse(serialized)
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new ProtocolError(`${label} 必须是 JSON 对象或 null`)
  }
  return cloned
}

function rejectSensitiveContextKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveContextKeys(item, `${path}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, '')
    if (FORBIDDEN_CONTEXT_KEYS.has(normalized)) {
      throw new ProtocolError(`Search Strategy Context 禁止包含 ${path}.${key}`)
    }
    rejectSensitiveContextKeys(child, `${path}.${key}`)
  }
}

function expectArray(value, label) {
  if (!Array.isArray(value)) throw new ProtocolError(`${label} 必须是数组`)
  return value
}

function publicCatalog(value) {
  const catalog = value
  const spec = catalog?.spec
  if (catalog?.apiVersion !== 'harness-rsi/v1alpha1'
      || catalog?.kind !== 'MutationCatalog'
      || spec === null
      || typeof spec !== 'object') {
    throw new ProtocolError('Search Strategy Context 缺少有效 MutationCatalog')
  }
  return {
    apiVersion: catalog.apiVersion,
    kind: catalog.kind,
    metadata: { target: catalog.metadata?.target },
    spec: {
      riskLevels: expectArray(spec.riskLevels, 'MutationCatalog.spec.riskLevels'),
      maximumRegionsPerPlan: spec.maximumRegionsPerPlan,
      regions: expectArray(spec.regions, 'MutationCatalog.spec.regions').map((region) => ({
        id: region.id,
        description: region.description,
        riskLevel: region.riskLevel,
        requires: expectArray(region.requires, `MutationCatalog Region ${region.id}.requires`),
        conflicts: expectArray(region.conflicts, `MutationCatalog Region ${region.id}.conflicts`),
      })),
    },
  }
}

function publicCandidate(candidate) {
  return {
    id: candidate.id,
    parentId: candidate.parentId,
    digest: candidate.digest,
    status: candidate.status,
  }
}

function publicSelection(selection) {
  if (selection === undefined) return undefined
  return {
    eligible: selection.eligible,
    gates: expectArray(selection.gates, 'Search Strategy Selection Gates').map((gate) => ({
      id: gate.id,
      passed: gate.passed,
      actual: gate.actual,
      operator: gate.operator,
      expected: gate.expected,
    })),
  }
}

function publicHistoryEntry(entry) {
  return {
    generation: entry.generation,
    parentId: entry.parentId,
    proposalId: entry.proposalId,
    status: entry.status,
    mutationPlanId: entry.mutationPlanId,
    regionIds: entry.regionIds,
    championBeforeId: entry.championBeforeId,
    championAfterId: entry.championAfterId,
    ...(entry.selection ? { selection: publicSelection(entry.selection) } : {}),
    ...(entry.rejection ? { rejection: { stage: entry.rejection.stage } } : {}),
  }
}

function publicContext(value, operation) {
  const context = jsonClone(value, 'Search Strategy Context', MAXIMUM_PROTOCOL_BYTES)
  if (context === null) throw new ProtocolError('Search Strategy Context 不能为空')
  rejectSensitiveContextKeys(context)
  if (operation === 'propose') {
    return {
      runId: context.runId,
      generation: context.generation,
      riskCeiling: context.riskCeiling,
      catalog: publicCatalog(context.catalog),
      championId: context.championId,
      allowedParentIds: expectArray(context.allowedParentIds, 'Search Strategy allowedParentIds'),
      candidates: expectArray(context.candidates, 'Search Strategy candidates').map(publicCandidate),
      searchHistory: expectArray(context.searchHistory, 'Search Strategy searchHistory').map(publicHistoryEntry),
    }
  }
  if (operation === 'observe') {
    return {
      runId: context.runId,
      generation: context.generation,
      parentId: context.parentId,
      proposalId: context.proposalId,
      status: context.status,
      championId: context.championId,
      regionIds: expectArray(context.regionIds, 'Search Strategy regionIds'),
      ...(context.selection ? { selection: publicSelection(context.selection) } : {}),
      ...(context.rejection ? { rejection: { stage: context.rejection.stage } } : {}),
    }
  }
  throw new ProtocolError(`Search Strategy operation 无效：${operation}`)
}

function strategyResponse(value, operation) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('Search Strategy Response 必须是 JSON 对象')
  }
  if (value.apiVersion !== 'harness-rsi/v1alpha1'
      || value.kind !== 'SearchStrategyResponse'
      || value.operation !== operation) {
    throw new ProtocolError('Search Strategy Response 协议或 operation 不匹配')
  }
  const allowed = operation === 'propose'
    ? new Set(['apiVersion', 'kind', 'operation', 'state', 'plan'])
    : new Set(['apiVersion', 'kind', 'operation', 'state'])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError('Search Strategy Response 含有未知字段', unknown)
  return {
    state: jsonClone(value.state, 'Search Strategy State'),
    ...(operation === 'propose' ? { plan: value.plan } : {}),
  }
}

export function registerBuiltinSearchStrategy(id, factory) {
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new ProtocolError('Builtin Search Strategy ID 必须是 kebab-case')
  }
  if (typeof factory !== 'function') throw new ProtocolError('Builtin Search Strategy Factory 必须是函数')
  if (BUILTIN_STRATEGIES.has(id)) throw new ProtocolError(`Builtin Search Strategy 重复注册：${id}`)
  BUILTIN_STRATEGIES.set(id, factory)
}

function linearHillClimb(configuration) {
  if (configuration.regionSelection !== undefined
      && configuration.regionSelection !== 'all-under-risk-ceiling') {
    throw new ProtocolError('linear-hill-climb 只支持 all-under-risk-ceiling Region 选择')
  }
  return {
    async propose(context, previousState) {
      const ceiling = MUTATION_RISK_LEVELS.indexOf(context.riskCeiling)
      const regionIds = context.catalog.spec.regions
        .filter((region) => MUTATION_RISK_LEVELS.indexOf(region.riskLevel) <= ceiling)
        .map((region) => region.id)
      return {
        state: {
          roundsProposed: (previousState?.roundsProposed ?? 0) + 1,
          roundsObserved: previousState?.roundsObserved ?? 0,
        },
        plan: {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'MutationPlan',
          metadata: { id: `generation-${String(context.generation).padStart(4, '0')}-linear` },
          spec: {
            generation: context.generation,
            parentIds: [context.championId],
            regionIds,
          },
        },
      }
    },
    async observe(context, previousState) {
      return {
        state: {
          roundsProposed: previousState?.roundsProposed ?? 0,
          roundsObserved: (previousState?.roundsObserved ?? 0) + 1,
          lastObservation: {
            generation: context.generation,
            proposalId: context.proposalId,
            status: context.status,
          },
        },
      }
    },
  }
}

registerBuiltinSearchStrategy('linear-hill-climb', linearHillClimb)

async function runDockerStrategy({ adapter, docker, operation, context, state }) {
  if (!docker || typeof docker.run !== 'function') {
    throw new ProtocolError('docker-json-v1 Search Strategy 需要 Docker Driver')
  }
  const request = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'SearchStrategyRequest',
    operation,
    strategy: { id: adapter.id, configuration: adapter.configuration },
    state,
    context,
  }
  const input = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(input, 'utf8') > MAXIMUM_PROTOCOL_BYTES) {
    throw new ProtocolError('Search Strategy Request 超过协议上限')
  }
  const result = await docker.run({
    image: adapter.runtime.image,
    name: `rsi-strategy-${adapter.id}-${randomUUID()}`,
    command: adapter.runtime.command,
    network: 'none',
    readOnlyRoot: true,
    runAsCurrentUser: true,
    mounts: [],
    environment: EMPTY_STANDARD_PROXY_ENVIRONMENT,
    secretEnvironment: {},
    inheritEnvironment: [],
    tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=16m'],
    resources: adapter.runtime.resources,
    timeoutMs: adapter.runtime.timeoutSeconds * 1000,
    input,
  })
  if (Buffer.byteLength(result.stdout, 'utf8') > MAXIMUM_PROTOCOL_BYTES) {
    throw new ProtocolError('Search Strategy Response 超过协议上限')
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new ProtocolError('Search Strategy Response 不是合法 JSON', [error.message])
  }
  return strategyResponse(parsed, operation)
}

/**
 * Strategy 只能看到脱敏的候选摘要与 Catalog，并返回 Region ID。
 * Docker Strategy 没有挂载、网络、环境变量或凭据。
 */
export function createSearchStrategyDriver({ adapter, docker = null }) {
  rejectSensitiveContextKeys(adapter.configuration, '$.strategy.configuration')
  let implementation = null
  if (adapter.protocol === 'builtin-v1') {
    const factory = BUILTIN_STRATEGIES.get(adapter.implementation)
    if (!factory) throw new ProtocolError(`未注册 Builtin Search Strategy：${adapter.implementation}`)
    implementation = factory(adapter.configuration)
  } else if (adapter.protocol !== 'docker-json-v1') {
    throw new ProtocolError(`未实现 Search Strategy Protocol：${adapter.protocol}`)
  }

  return {
    id: adapter.id,
    protocol: adapter.protocol,
    async preflight() {
      if (adapter.protocol === 'builtin-v1') return { available: true, protocol: adapter.protocol }
      if (!docker || typeof docker.imageExists !== 'function') {
        throw new ProtocolError('docker-json-v1 Search Strategy 需要可检查镜像的 Docker Driver')
      }
      if (!await docker.imageExists(adapter.runtime.image)) {
        throw new ProtocolError(`Search Strategy Image 不存在：${adapter.runtime.image}`)
      }
      return { available: true, protocol: adapter.protocol, image: adapter.runtime.image }
    },
    descriptor() {
      return {
        id: adapter.id,
        protocol: adapter.protocol,
        ...(adapter.implementation ? { implementation: adapter.implementation } : {}),
        configuration: jsonClone(adapter.configuration, 'Search Strategy Configuration') ?? {},
        ...(adapter.runtime ? { image: adapter.runtime.image } : {}),
      }
    },
    async propose(rawContext, previousState = null) {
      const context = publicContext(rawContext, 'propose')
      const state = jsonClone(previousState, 'Search Strategy State')
      rejectSensitiveContextKeys(state, '$.strategy.state')
      const output = implementation
        ? await implementation.propose(context, state)
        : await runDockerStrategy({ adapter, docker, operation: 'propose', context, state })
      const normalized = implementation
        ? {
            state: jsonClone(output?.state, 'Search Strategy State'),
            plan: output?.plan,
          }
        : output
      rejectSensitiveContextKeys(normalized.state, '$.strategy.state')
      return {
        state: normalized.state,
        plan: validateMutationPlan(normalized.plan, {
          catalog: context.catalog,
          riskCeiling: context.riskCeiling,
          allowedParentIds: context.allowedParentIds,
          expectedGeneration: context.generation,
        }),
      }
    },
    async observe(rawContext, previousState = null) {
      const context = publicContext(rawContext, 'observe')
      const state = jsonClone(previousState, 'Search Strategy State')
      rejectSensitiveContextKeys(state, '$.strategy.state')
      const output = implementation
        ? await implementation.observe(context, state)
        : await runDockerStrategy({ adapter, docker, operation: 'observe', context, state })
      const nextState = jsonClone(output?.state, 'Search Strategy State')
      rejectSensitiveContextKeys(nextState, '$.strategy.state')
      return { state: nextState }
    },
  }
}
