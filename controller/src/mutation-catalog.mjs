import {
  expectNumber,
  expectObject,
  expectStringArray,
  expectText,
} from './config.mjs'
import { normalizeRelativePath } from './path-policy.mjs'
import { ProtocolError } from './protocol.mjs'

export const MUTATION_RISK_LEVELS = Object.freeze(['l1', 'l2', 'l3'])

const REGION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PLAN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknown)
}

function normalizedExtensions(value, label) {
  const output = expectStringArray(value, label).map((extension) => extension.toLowerCase())
  if (output.some((extension) => !/^\.[a-z0-9]+$/u.test(extension))) {
    throw new ProtocolError(`${label} 只能包含形如 .md 的小写扩展名`)
  }
  if (new Set(output).size !== output.length) throw new ProtocolError(`${label} 不能重复`)
  return output
}

function normalizedGlobs(value, label) {
  return expectStringArray(value, label).map((pattern, index) => (
    normalizeRelativePath(pattern, `${label}[${index}]`)
  ))
}

function setDifference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function sameSet(left, right) {
  return left.length === right.length && setDifference(left, right).length === 0
}

function riskIndex(level) {
  return MUTATION_RISK_LEVELS.indexOf(level)
}

function validateDependencyGraph(regions) {
  const byId = new Map(regions.map((region) => [region.id, region]))
  const visited = new Set()
  const visiting = new Set()

  function visit(region, path) {
    if (visiting.has(region.id)) {
      throw new ProtocolError('Mutation Catalog Region 依赖图存在环', [
        [...path, region.id].join(' -> '),
      ])
    }
    if (visited.has(region.id)) return
    visiting.add(region.id)
    for (const requiredId of region.requires) {
      const required = byId.get(requiredId)
      if (riskIndex(required.riskLevel) > riskIndex(region.riskLevel)) {
        throw new ProtocolError(`Mutation Catalog Region ${region.id} 依赖了更高风险的 Region`, [
          `${region.id}(${region.riskLevel}) -> ${required.id}(${required.riskLevel})`,
        ])
      }
      visit(required, [...path, region.id])
    }
    visiting.delete(region.id)
    visited.add(region.id)
  }

  for (const region of regions) visit(region, [])
}

function derivedCatalog(levels) {
  const regions = Object.entries(levels).map(([riskLevel, level]) => ({
    id: riskLevel,
    description: level.description,
    riskLevel,
    writable: [...level.writable],
    extensions: [...level.extensions],
    requires: [],
    conflicts: [],
  }))
  return {
    maximumRegionsPerPlan: regions.length,
    regions,
    derivedFromLegacyLevels: true,
  }
}

/**
 * 把 Target 自己声明的模块目录规范化为可供搜索算法消费的 Catalog。
 * 旧 Target 没有 catalog 时，每个 L1/L2/L3 自动成为一个兼容 Region。
 */
export function normalizeMutationCatalogConfiguration(input, levels) {
  if (input === undefined || input === null) return derivedCatalog(levels)

  const raw = expectObject(input, 'TargetAdapter.spec.mutation.catalog')
  rejectUnknownFields(raw, new Set(['maximumRegionsPerPlan', 'regions']), 'TargetAdapter.spec.mutation.catalog')
  if (!Array.isArray(raw.regions) || raw.regions.length === 0) {
    throw new ProtocolError('TargetAdapter.spec.mutation.catalog.regions 必须是非空数组')
  }
  const seen = new Set()
  const regions = raw.regions.map((value, index) => {
    const label = `TargetAdapter.spec.mutation.catalog.regions[${index}]`
    const region = expectObject(value, label)
    rejectUnknownFields(
      region,
      new Set(['id', 'description', 'riskLevel', 'writable', 'extensions', 'requires', 'conflicts']),
      label,
    )
    const id = expectText(region.id, `${label}.id`)
    if (!REGION_ID.test(id)) throw new ProtocolError(`${label}.id 必须是 kebab-case`)
    if (seen.has(id)) throw new ProtocolError(`Mutation Catalog Region 重复：${id}`)
    seen.add(id)
    const riskLevel = expectText(region.riskLevel, `${label}.riskLevel`)
    if (!levels[riskLevel]) throw new ProtocolError(`Mutation Catalog Region ${id} 引用了未定义层级 ${riskLevel}`)
    return {
      id,
      description: expectText(region.description, `${label}.description`),
      riskLevel,
      writable: normalizedGlobs(region.writable, `${label}.writable`),
      extensions: normalizedExtensions(region.extensions, `${label}.extensions`),
      requires: expectStringArray(region.requires ?? [], `${label}.requires`, { nonEmpty: false }),
      conflicts: expectStringArray(region.conflicts ?? [], `${label}.conflicts`, { nonEmpty: false }),
    }
  })

  for (const region of regions) {
    for (const reference of [...region.requires, ...region.conflicts]) {
      if (!seen.has(reference)) throw new ProtocolError(`Mutation Catalog Region ${region.id} 引用了未知 Region ${reference}`)
      if (reference === region.id) throw new ProtocolError(`Mutation Catalog Region ${region.id} 不能引用自身`)
    }
    if (region.requires.some((id) => region.conflicts.includes(id))) {
      throw new ProtocolError(`Mutation Catalog Region ${region.id} 不能同时依赖并冲突同一 Region`)
    }
    const level = levels[region.riskLevel]
    const extraPaths = setDifference(region.writable, level.writable)
    const extraExtensions = setDifference(region.extensions, level.extensions)
    if (extraPaths.length > 0 || extraExtensions.length > 0) {
      throw new ProtocolError(`Mutation Catalog Region ${region.id} 超出 ${region.riskLevel.toUpperCase()} 边界`, [
        ...extraPaths.map((path) => `path=${path}`),
        ...extraExtensions.map((extension) => `extension=${extension}`),
      ])
    }
  }
  validateDependencyGraph(regions)

  // 兼容要求：内置线性策略选择当前风险上限内的全部 Region 时，必须得到旧层级完全相同的权限。
  for (const [levelName, level] of Object.entries(levels)) {
    const ceiling = riskIndex(levelName)
    const eligible = regions.filter((region) => riskIndex(region.riskLevel) <= ceiling)
    const writable = [...new Set(eligible.flatMap((region) => region.writable))]
    const extensions = [...new Set(eligible.flatMap((region) => region.extensions))]
    if (!sameSet(writable, level.writable) || !sameSet(extensions, level.extensions)) {
      throw new ProtocolError(`Mutation Catalog 与旧 ${levelName.toUpperCase()} 权限不兼容`, [
        `catalog.writable=${writable.join(',')}`,
        `level.writable=${level.writable.join(',')}`,
        `catalog.extensions=${extensions.join(',')}`,
        `level.extensions=${level.extensions.join(',')}`,
      ])
    }
  }

  const maximumRegionsPerPlan = expectNumber(
    raw.maximumRegionsPerPlan ?? regions.length,
    'TargetAdapter.spec.mutation.catalog.maximumRegionsPerPlan',
    { integer: true, min: 1, max: 128 },
  )
  const maximumCompatibleSelection = Math.max(
    ...Object.keys(levels).map((levelName) => (
      regions.filter((region) => riskIndex(region.riskLevel) <= riskIndex(levelName)).length
    )),
  )
  if (maximumRegionsPerPlan < maximumCompatibleSelection) {
    throw new ProtocolError('maximumRegionsPerPlan 太小，无法保持旧层级兼容行为', [
      `required>=${maximumCompatibleSelection}`,
      `actual=${maximumRegionsPerPlan}`,
    ])
  }
  return { maximumRegionsPerPlan, regions, derivedFromLegacyLevels: false }
}

export function mutationCatalogFor(target) {
  const catalog = target?.mutation?.catalog ?? derivedCatalog(target?.mutation?.levels ?? {})
  if (!target?.id || !Array.isArray(catalog.regions) || catalog.regions.length === 0) {
    throw new ProtocolError('Target 缺少有效 Mutation Catalog')
  }
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationCatalog',
    metadata: { target: target.id },
    spec: {
      riskLevels: MUTATION_RISK_LEVELS.filter((level) => target.mutation.levels[level]),
      maximumRegionsPerPlan: catalog.maximumRegionsPerPlan,
      regions: catalog.regions.map((region) => ({
        id: region.id,
        description: region.description,
        riskLevel: region.riskLevel,
        writable: [...region.writable],
        extensions: [...region.extensions],
        requires: [...region.requires],
        conflicts: [...region.conflicts],
      })),
    },
  }
}

function requirePlanObject(value) {
  const plan = expectObject(value, 'MutationPlan')
  rejectUnknownFields(plan, new Set(['apiVersion', 'kind', 'metadata', 'spec']), 'MutationPlan')
  if (plan.apiVersion !== 'harness-rsi/v1alpha1' || plan.kind !== 'MutationPlan') {
    throw new ProtocolError('Search Strategy 必须返回 harness-rsi/v1alpha1 MutationPlan')
  }
  const metadata = expectObject(plan.metadata, 'MutationPlan.metadata')
  const spec = expectObject(plan.spec, 'MutationPlan.spec')
  rejectUnknownFields(metadata, new Set(['id']), 'MutationPlan.metadata')
  rejectUnknownFields(spec, new Set(['generation', 'parentIds', 'regionIds']), 'MutationPlan.spec')
  const id = expectText(metadata.id, 'MutationPlan.metadata.id')
  if (!PLAN_ID.test(id)) throw new ProtocolError('MutationPlan.metadata.id 格式无效')
  return { id, spec }
}

export function validateMutationPlan(value, {
  catalog,
  riskCeiling,
  allowedParentIds,
  expectedGeneration,
}) {
  const { id, spec } = requirePlanObject(value)
  if (!catalog?.spec?.riskLevels?.includes(riskCeiling)) {
    throw new ProtocolError(`MutationPlan 风险上限无效：${riskCeiling}`)
  }
  const generation = expectNumber(spec.generation, 'MutationPlan.spec.generation', { integer: true, min: 1 })
  if (generation !== expectedGeneration) throw new ProtocolError('MutationPlan generation 与当前轮次不一致')
  const parentIds = expectStringArray(spec.parentIds, 'MutationPlan.spec.parentIds')
  if (parentIds.length !== 1) throw new ProtocolError('MutationPlan v1 只支持一个父 Candidate')
  const allowedParents = new Set(allowedParentIds)
  if (!allowedParents.has(parentIds[0])) throw new ProtocolError(`MutationPlan 引用了不可用父 Candidate：${parentIds[0]}`)

  const regionIds = expectStringArray(spec.regionIds, 'MutationPlan.spec.regionIds')
  if (regionIds.length > catalog.spec.maximumRegionsPerPlan) {
    throw new ProtocolError('MutationPlan Region 数量超过 Target 上限')
  }
  const regions = new Map(catalog.spec.regions.map((region) => [region.id, region]))
  const selected = new Set(regionIds)
  const ceiling = riskIndex(riskCeiling)
  for (const regionId of regionIds) {
    const region = regions.get(regionId)
    if (!region) throw new ProtocolError(`MutationPlan 引用了未知 Region：${regionId}`)
    if (riskIndex(region.riskLevel) > ceiling) {
      throw new ProtocolError(`MutationPlan Region ${regionId} 超出风险上限 ${riskCeiling.toUpperCase()}`)
    }
    const missing = region.requires.filter((required) => !selected.has(required))
    const conflicts = region.conflicts.filter((conflict) => selected.has(conflict))
    if (missing.length > 0) throw new ProtocolError(`MutationPlan Region ${regionId} 缺少依赖`, missing)
    if (conflicts.length > 0) throw new ProtocolError(`MutationPlan Region ${regionId} 存在冲突`, conflicts)
  }
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationPlan',
    metadata: { id },
    spec: { generation, parentIds, regionIds },
  }
}

/** Controller 根据已校验 Plan 发放一次性权限；Strategy 永远不能直接提供路径。 */
export function issueMutationLease({ target, catalog, plan, riskCeiling }) {
  const regions = new Map(catalog.spec.regions.map((region) => [region.id, region]))
  const selected = plan.spec.regionIds.map((id) => regions.get(id))
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationLease',
    metadata: {
      target: target.id,
      level: riskCeiling,
      planId: plan.metadata.id,
      regions: [...plan.spec.regionIds],
    },
    spec: {
      description: selected.map((region) => `${region.id}: ${region.description}`).join('\n'),
      writable: [...new Set(selected.flatMap((region) => region.writable))],
      readOnly: [...target.mutation.alwaysReadOnly],
      extensions: [...new Set(selected.flatMap((region) => region.extensions))],
      limits: { ...target.mutation.limits },
      parentIds: [...plan.spec.parentIds],
      generation: plan.spec.generation,
    },
  }
}
