const MAXIMUM_INPUT_BYTES = 256 * 1024
const RISK_LEVELS = ['l1', 'l2', 'l3']

function fail(message) {
  throw new Error(`round-robin-strategy: ${message}`)
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`)
  return value
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(`${label} 必须是大于等于 ${minimum} 的整数`)
  return value
}

async function readRequest() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAXIMUM_INPUT_BYTES) fail('输入超过 256 KiB')
    chunks.push(chunk)
  }
  let request
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail('标准输入不是合法 JSON')
  }
  object(request, 'request')
  if (request.apiVersion !== 'harness-rsi/v1alpha1' || request.kind !== 'SearchStrategyRequest') {
    fail('协议版本或 kind 不匹配')
  }
  if (!['propose', 'observe'].includes(request.operation)) fail('operation 不支持')
  return request
}

function response(operation, state, plan = undefined) {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'SearchStrategyResponse',
    operation,
    state,
    ...(plan === undefined ? {} : { plan }),
  }
}

function normalizedState(value) {
  const state = value === null || value === undefined ? {} : object(value, 'state')
  return {
    cursor: integer(state.cursor ?? 0, 'state.cursor'),
    proposed: integer(state.proposed ?? 0, 'state.proposed'),
    observed: integer(state.observed ?? 0, 'state.observed'),
    ...(typeof state.lastStatus === 'string' ? { lastStatus: state.lastStatus } : {}),
  }
}

function selectedRegionClosure(region, regions, riskCeiling, maximumRegions) {
  const ceiling = RISK_LEVELS.indexOf(riskCeiling)
  if (ceiling < 0) fail(`未知风险上限 ${riskCeiling}`)
  const selected = new Set()
  const visiting = new Set()

  function visit(regionId) {
    if (selected.has(regionId)) return
    if (visiting.has(regionId)) fail(`Region 依赖存在环：${regionId}`)
    const current = regions.get(regionId)
    if (!current) fail(`Region 依赖不存在：${regionId}`)
    if (RISK_LEVELS.indexOf(current.riskLevel) > ceiling) fail(`Region ${regionId} 超出风险上限`)
    visiting.add(regionId)
    for (const dependency of current.requires ?? []) visit(dependency)
    visiting.delete(regionId)
    for (const selectedId of selected) {
      const selectedRegion = regions.get(selectedId)
      if ((current.conflicts ?? []).includes(selectedId) || (selectedRegion.conflicts ?? []).includes(regionId)) {
        fail(`Region ${regionId} 与 ${selectedId} 冲突`)
      }
    }
    selected.add(regionId)
    if (selected.size > maximumRegions) fail('Region 数量超出 Target 上限')
  }

  visit(region.id)
  return [...selected]
}

function propose(request) {
  const context = object(request.context, 'context')
  const catalog = object(object(context.catalog, 'context.catalog').spec, 'context.catalog.spec')
  if (!Array.isArray(catalog.regions) || catalog.regions.length === 0) fail('Catalog 没有 Region')
  const state = normalizedState(request.state)
  const configuration = object(request.strategy?.configuration ?? {}, 'strategy.configuration')
  const regions = new Map(catalog.regions.map((region) => [region.id, object(region, `region.${region?.id}`)]))
  const configuredOrder = configuration.regionOrder
  if (configuredOrder !== undefined && (!Array.isArray(configuredOrder)
      || configuredOrder.length === 0
      || configuredOrder.some((id) => typeof id !== 'string' || !regions.has(id)))) {
    fail('configuration.regionOrder 必须是 Catalog Region ID 的非空数组')
  }
  const order = configuredOrder ?? [...regions.keys()]
  let regionIds = null
  for (let offset = 0; offset < order.length; offset += 1) {
    const index = (state.cursor + offset) % order.length
    const candidate = regions.get(order[index])
    try {
      regionIds = selectedRegionClosure(
        candidate,
        regions,
        context.riskCeiling,
        integer(catalog.maximumRegionsPerPlan, 'catalog.maximumRegionsPerPlan', 1),
      )
      state.cursor = (index + 1) % order.length
      break
    } catch {
      // 跳过越界、冲突或无法满足依赖的 Region，继续尝试下一个。
    }
  }
  if (regionIds === null) fail('没有可用的 Region')
  if (typeof context.championId !== 'string') fail('context.championId 缺失')
  state.proposed += 1
  const generation = integer(context.generation, 'context.generation', 1)
  return response('propose', state, {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationPlan',
    metadata: { id: `generation-${String(generation).padStart(4, '0')}-round-robin` },
    spec: {
      generation,
      parentIds: [context.championId],
      regionIds,
    },
  })
}

function observe(request) {
  const context = object(request.context, 'context')
  const state = normalizedState(request.state)
  state.observed += 1
  state.lastStatus = typeof context.status === 'string' ? context.status : 'unknown'
  return response('observe', state)
}

const request = await readRequest()
const output = request.operation === 'propose' ? propose(request) : observe(request)
process.stdout.write(`${JSON.stringify(output)}\n`)
