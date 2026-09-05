import { MUTATION_RISK_LEVELS, validateMutationPlan } from '../mutation-catalog.mjs'
import { ProtocolError } from '../protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'

function finite(value, label, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`${label} 必须是 ${minimum}..${maximum} 范围内的有限数字`)
  }
  return value
}

function integer(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`${label} 必须是 ${minimum}..${maximum} 范围内的整数`)
  }
  return value
}

function eligibleRegions(catalog, riskCeiling) {
  const ceiling = MUTATION_RISK_LEVELS.indexOf(riskCeiling)
  if (ceiling < 0) throw new ProtocolError(`GRHS riskCeiling 无效：${riskCeiling}`)
  const regions = catalog?.spec?.regions
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new ProtocolError('GRHS 缺少 Mutation Catalog Region')
  }
  return regions.filter((region) => MUTATION_RISK_LEVELS.indexOf(region.riskLevel) <= ceiling)
}

function requiredRegionIds(regionId, regionById, selected = new Set()) {
  if (selected.has(regionId)) return selected
  const region = regionById.get(regionId)
  if (!region) throw new ProtocolError(`GRHS Region 依赖不存在：${regionId}`)
  selected.add(regionId)
  for (const dependency of region.requires ?? []) requiredRegionIds(dependency, regionById, selected)
  return selected
}

function normalizePrior(regions, prior) {
  if (prior !== undefined && prior !== null
      && (typeof prior !== 'object' || Array.isArray(prior))) {
    throw new ProtocolError('GRHS proposalPrior 必须是对象')
  }
  const regionIds = new Set(regions.map((region) => region.id))
  const unknown = Object.keys(prior ?? {}).filter((id) => !regionIds.has(id))
  if (unknown.length > 0) {
    throw new ProtocolError('GRHS proposalPrior 含有当前 Catalog 不存在的 Region', unknown)
  }
  const weights = regions.map((region) => {
    const value = prior?.[region.id]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new ProtocolError(`GRHS proposalPrior.${region.id} 必须是非负有限数字`)
    }
    return value > 0 ? value : 0
  })
  const total = weights.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return regions.map(() => 1 / regions.length)
  return weights.map((value) => value / total)
}

function round(value) {
  if (value === null || value === undefined) return null
  return Number(value.toFixed(12))
}

export function validateGrhsStrategyConfiguration(configuration = {}) {
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new ProtocolError('GRHS Strategy configuration 必须是对象')
  }
  const allowed = new Set(['groupSize', 'minimumValidCandidates', 'advantageEpsilon', 'priorLearningRate'])
  const unknown = Object.keys(configuration).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError('GRHS Strategy configuration 含有未知字段', unknown)
  const groupSize = integer(configuration.groupSize ?? 4, 'grhs.groupSize', { minimum: 2, maximum: 32 })
  const minimumValidCandidates = integer(
    configuration.minimumValidCandidates ?? 2,
    'grhs.minimumValidCandidates',
    { minimum: 2, maximum: groupSize },
  )
  return Object.freeze({
    groupSize,
    minimumValidCandidates,
    advantageEpsilon: finite(configuration.advantageEpsilon ?? 1e-8, 'grhs.advantageEpsilon', {
      minimum: Number.EPSILON,
      maximum: 1,
    }),
    priorLearningRate: finite(configuration.priorLearningRate ?? 0.1, 'grhs.priorLearningRate', {
      minimum: 0,
      maximum: 100,
    }),
  })
}

export function initialGrhsPrior(catalog, riskCeiling) {
  const regions = eligibleRegions(catalog, riskCeiling)
  const probability = 1 / regions.length
  return Object.fromEntries(regions.map((region) => [region.id, probability]))
}

export function createGrhsMutationPlans({
  catalog,
  riskCeiling,
  parentId,
  generation,
  configuration,
  proposalPrior,
}) {
  const normalized = validateGrhsStrategyConfiguration(configuration)
  integer(generation, 'GRHS generation')
  if (typeof parentId !== 'string' || parentId.length === 0) {
    throw new ProtocolError('GRHS parentId 不能为空')
  }
  const regions = eligibleRegions(catalog, riskCeiling)
  const probabilities = normalizePrior(regions, proposalPrior)
  const ranked = regions.map((region, index) => ({
    region,
    probability: probabilities[index],
  })).sort((left, right) => (
    right.probability - left.probability
    || left.region.id.localeCompare(right.region.id)
  ))
  const regionById = new Map(regions.map((region) => [region.id, region]))
  return Array.from({ length: normalized.groupSize }, (_, index) => {
    // Round-robin over the ranked list keeps low-prior regions observable while
    // still putting the currently preferred regions first.
    const primary = ranked[index % ranked.length].region.id
    const regionIds = [...requiredRegionIds(primary, regionById)].sort()
    return validateMutationPlan({
      apiVersion: API_VERSION,
      kind: 'MutationPlan',
      metadata: {
        id: `generation-${String(generation).padStart(4, '0')}-grhs-${String(index + 1).padStart(3, '0')}`,
      },
      spec: { generation, parentIds: [parentId], regionIds },
    }, {
      catalog,
      riskCeiling,
      allowedParentIds: [parentId],
        expectedGeneration: generation,
    })
  })
}

export function scoreGrhsGroup({ candidates, configuration, proposalPrior }) {
  const normalized = validateGrhsStrategyConfiguration(configuration)
  if (!Array.isArray(candidates) || candidates.length !== normalized.groupSize) {
    throw new ProtocolError(`GRHS 必须收到恰好 ${normalized.groupSize} 个 sibling 结果`)
  }
  const ids = candidates.map((candidate) => candidate.id)
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new ProtocolError('GRHS Candidate ID 必须非空且唯一')
  }
  const scored = candidates.map((candidate) => {
    if (!candidate.valid) return { ...candidate, utility: null, advantage: null }
    return {
      ...candidate,
      utility: finite(candidate.qualityDelta, `${candidate.id}.qualityDelta`),
      advantage: null,
    }
  })
  const valid = scored.filter((candidate) => candidate.valid)
  if (valid.length >= normalized.minimumValidCandidates) {
    const mean = valid.reduce((sum, candidate) => sum + candidate.utility, 0) / valid.length
    const variance = valid.reduce((sum, candidate) => sum + ((candidate.utility - mean) ** 2), 0) / valid.length
    const standardDeviation = Math.sqrt(variance)
    for (const candidate of valid) {
      candidate.advantage = (candidate.utility - mean)
        / (standardDeviation + normalized.advantageEpsilon)
    }
  }
  for (const candidate of scored) {
    candidate.utility = round(candidate.utility)
    candidate.advantage = round(candidate.advantage)
  }
  const relativeUpdateApplied = valid.length >= normalized.minimumValidCandidates
  const nextPrior = relativeUpdateApplied
    ? updateGrhsPrior({ prior: proposalPrior, candidates: scored, learningRate: normalized.priorLearningRate })
    : { ...proposalPrior }
  const ranked = valid.filter((candidate) => candidate.promotionEligible).sort((left, right) => (
    right.utility - left.utility || left.id.localeCompare(right.id)
  ))
  const best = ranked[0] ?? null
  return {
    candidates: scored,
    validCandidates: valid.length,
    relativeUpdateApplied,
    proposalPriorBefore: { ...proposalPrior },
    proposalPriorAfter: nextPrior,
    promotedCandidateId: relativeUpdateApplied && best !== null ? best.id : null,
    rollbackReason: !relativeUpdateApplied
      ? 'insufficient-valid-candidates'
      : best === null
        ? 'no-candidate-passed-gates'
        : null,
  }
}

function updateGrhsPrior({ prior, candidates, learningRate }) {
  finite(learningRate, 'GRHS priorLearningRate', { minimum: 0, maximum: 100 })
  const regionIds = Object.keys(prior ?? {}).sort()
  if (regionIds.length === 0) throw new ProtocolError('GRHS proposal prior 不能为空')
  const weights = Object.fromEntries(regionIds.map((id) => {
    const value = prior[id]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ProtocolError(`GRHS proposalPrior.${id} 必须是非负有限数字`)
    }
    return [id, Math.max(value, Number.EPSILON)]
  }))
  for (const candidate of candidates) {
    if (!candidate.valid || candidate.advantage === null) continue
    if (!Array.isArray(candidate.regionIds) || candidate.regionIds.length === 0) continue
    const share = candidate.advantage / candidate.regionIds.length
    for (const regionId of candidate.regionIds) {
      if (weights[regionId] !== undefined) weights[regionId] *= Math.exp(learningRate * share)
    }
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || total <= 0) throw new ProtocolError('GRHS proposalPrior 更新结果无效')
  return Object.fromEntries(regionIds.map((id) => [id, round(weights[id] / total)]))
}

export function createGrhsStrategy(configuration = {}) {
  const normalized = validateGrhsStrategyConfiguration(configuration)
  return {
    grouped: true,
    groupSize: normalized.groupSize,
    async proposeGroup(context, previousState) {
      const proposalPrior = previousState?.proposalPrior
        ?? initialGrhsPrior(context.catalog, context.riskCeiling)
      const pendingGroup = previousState?.pendingGroup ?? null
      if (pendingGroup !== null) {
        if (pendingGroup.parentId !== context.championId) {
          throw new ProtocolError('GRHS 分组尚未结束时 Champion 不能变化')
        }
        return { state: { ...(previousState ?? {}), proposalPrior }, plans: pendingGroup.plans }
      }
      const plans = createGrhsMutationPlans({
        catalog: context.catalog,
        riskCeiling: context.riskCeiling,
        parentId: context.championId,
        generation: context.generation,
        configuration: normalized,
        proposalPrior,
      })
      return {
        state: {
          ...(previousState ?? {}),
          proposalPrior,
          groupsProposed: (previousState?.groupsProposed ?? 0) + 1,
          groupsObserved: previousState?.groupsObserved ?? 0,
          pendingGroup: {
            parentId: context.championId,
            plans,
          },
        },
        plans,
      }
    },
    async observeGroup(context, previousState) {
      const proposalPrior = previousState?.proposalPrior
        ?? initialGrhsPrior(context.catalog, context.riskCeiling)
      const decision = scoreGrhsGroup({
        candidates: context.candidates,
        configuration: normalized,
        proposalPrior,
      })
      return {
        state: {
          ...(previousState ?? {}),
          proposalPrior: decision.proposalPriorAfter,
          groupsProposed: previousState?.groupsProposed ?? 0,
          groupsObserved: (previousState?.groupsObserved ?? 0) + 1,
          pendingGroup: null,
          lastGroup: {
            generation: context.generation,
            promotedCandidateId: decision.promotedCandidateId,
            rollbackReason: decision.rollbackReason,
          },
        },
        exhausted: false,
        decision,
      }
    },
    // Single-plan calls are deliberately rejected so a GRHS run cannot silently
    // degrade into ordinary linear search.
    async propose() {
      throw new ProtocolError('GRHS 必须通过 proposeGroup() 调用')
    },
    async observe() {
      throw new ProtocolError('GRHS 必须通过 observeGroup() 调用')
    },
  }
}
