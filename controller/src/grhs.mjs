import { MUTATION_RISK_LEVELS, validateMutationPlan } from './mutation-catalog.mjs'
import { ProtocolError } from './protocol.mjs'

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

export function validateGrhsConfiguration(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('EvolutionExperiment.spec.evolution.grhs 必须是对象')
  }
  const allowed = new Set([
    'groupSize',
    'minimumValidCandidates',
    'advantageEpsilon',
    'priorLearningRate',
  ])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError('GRHS 配置含有未知字段', unknown)
  const groupSize = integer(value.groupSize, 'grhs.groupSize', { minimum: 2, maximum: 32 })
  const minimumValidCandidates = integer(
    value.minimumValidCandidates ?? 2,
    'grhs.minimumValidCandidates',
    { minimum: 2, maximum: groupSize },
  )
  return Object.freeze({
    groupSize,
    minimumValidCandidates,
    advantageEpsilon: finite(value.advantageEpsilon ?? 1e-8, 'grhs.advantageEpsilon', {
      minimum: Number.EPSILON,
      maximum: 1,
    }),
    priorLearningRate: finite(value.priorLearningRate ?? 0.1, 'grhs.priorLearningRate', {
      minimum: 0,
      maximum: 100,
    }),
  })
}

function eligibleRegions(catalog, riskCeiling) {
  const ceiling = MUTATION_RISK_LEVELS.indexOf(riskCeiling)
  if (ceiling < 0) throw new ProtocolError(`GRHS riskCeiling 无效：${riskCeiling}`)
  const regions = catalog?.spec?.regions
  if (!Array.isArray(regions) || regions.length === 0) throw new ProtocolError('GRHS 缺少 MutationCatalog Region')
  return regions.filter((region) => MUTATION_RISK_LEVELS.indexOf(region.riskLevel) <= ceiling)
}

export function initialProposalPrior(catalog, riskCeiling) {
  const regions = eligibleRegions(catalog, riskCeiling)
  const probability = 1 / regions.length
  return Object.fromEntries(regions.map((region) => [region.id, probability]))
}

function normalizedPrior(regions, prior) {
  const weights = regions.map((region) => {
    const value = prior?.[region.id]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  })
  const total = weights.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return regions.map(() => 1 / regions.length)
  return weights.map((value) => value / total)
}

function requiredRegionIds(regionId, regionById, selected = new Set()) {
  if (selected.has(regionId)) return selected
  const region = regionById.get(regionId)
  if (!region) throw new ProtocolError(`GRHS Region 依赖不存在：${regionId}`)
  selected.add(regionId)
  for (const dependency of region.requires ?? []) requiredRegionIds(dependency, regionById, selected)
  return selected
}

/**
 * Group Controller owns sibling scheduling. SearchStrategy remains the single-plan
 * extension seam; GRHS deliberately emits a precommitted group from one parent.
 */
export function createGrhsMutationPlans({
  catalog,
  riskCeiling,
  parentId,
  generation,
  groupSize,
  proposalPrior,
}) {
  integer(generation, 'GRHS generation')
  integer(groupSize, 'GRHS groupSize', { minimum: 2, maximum: 32 })
  if (typeof parentId !== 'string' || parentId.length === 0) throw new ProtocolError('GRHS parentId 不能为空')
  const regions = eligibleRegions(catalog, riskCeiling)
  const probabilities = normalizedPrior(regions, proposalPrior)
  const ranked = regions.map((region, index) => ({
    region,
    probability: probabilities[index],
  })).sort((left, right) => (
    right.probability - left.probability
    || left.region.id.localeCompare(right.region.id)
  ))
  const regionById = new Map(regions.map((region) => [region.id, region]))
  return Array.from({ length: groupSize }, (_, index) => {
    const primary = ranked[index % ranked.length].region.id
    const regionIds = [...requiredRegionIds(primary, regionById)].sort()
    const plan = {
      apiVersion: API_VERSION,
      kind: 'MutationPlan',
      metadata: {
        id: `generation-${String(generation).padStart(4, '0')}-grhs-${String(index + 1).padStart(3, '0')}`,
      },
      spec: { generation, parentIds: [parentId], regionIds },
    }
    return validateMutationPlan(plan, {
      catalog,
      riskCeiling,
      allowedParentIds: [parentId],
      expectedGeneration: generation,
    })
  })
}

function round(value) {
  if (value === null || value === undefined) return null
  return Number(value.toFixed(12))
}

export function updateProposalPrior({ prior, candidates, learningRate }) {
  finite(learningRate, 'GRHS prior learningRate', { minimum: 0, maximum: 100 })
  const regionIds = Object.keys(prior ?? {}).sort()
  if (regionIds.length === 0) throw new ProtocolError('GRHS proposal prior 不能为空')
  const weights = Object.fromEntries(regionIds.map((id) => [id, Math.max(prior[id], Number.EPSILON)]))
  for (const candidate of candidates) {
    if (!candidate.valid || candidate.advantage === null) continue
    if (!Array.isArray(candidate.regionIds) || candidate.regionIds.length === 0) continue
    const share = candidate.advantage / candidate.regionIds.length
    for (const regionId of candidate.regionIds) {
      if (weights[regionId] !== undefined) weights[regionId] *= Math.exp(learningRate * share)
    }
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(regionIds.map((id) => [id, round(weights[id] / total)]))
}

/** Score discrete sibling patches and make one group-level promote/rollback decision. */
export function scoreGrhsGroup({ candidates, configuration, proposalPrior }) {
  if (!Array.isArray(candidates) || candidates.length !== configuration.groupSize) {
    throw new ProtocolError(`GRHS 必须收到恰好 ${configuration.groupSize} 个 sibling 结果`)
  }
  const ids = candidates.map((candidate) => candidate.id)
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new ProtocolError('GRHS Candidate ID 必须非空且唯一')
  }
  const scored = candidates.map((candidate) => {
    if (!candidate.valid) {
      return { ...candidate, utility: null, advantage: null }
    }
    return {
      ...candidate,
      utility: finite(candidate.qualityDelta, `${candidate.id}.qualityDelta`),
      advantage: null,
    }
  })
  const valid = scored.filter((candidate) => candidate.valid)
  if (valid.length >= configuration.minimumValidCandidates) {
    const mean = valid.reduce((sum, candidate) => sum + candidate.utility, 0) / valid.length
    const variance = valid.reduce((sum, candidate) => sum + ((candidate.utility - mean) ** 2), 0) / valid.length
    const standardDeviation = Math.sqrt(variance)
    for (const candidate of valid) {
      candidate.advantage = (candidate.utility - mean) / (standardDeviation + configuration.advantageEpsilon)
    }
  }
  for (const candidate of scored) {
    candidate.utility = round(candidate.utility)
    candidate.advantage = round(candidate.advantage)
  }
  const relativeUpdateApplied = valid.length >= configuration.minimumValidCandidates
  const nextPrior = relativeUpdateApplied
    ? updateProposalPrior({ prior: proposalPrior, candidates: scored, learningRate: configuration.priorLearningRate })
    : { ...proposalPrior }
  const ranked = valid.filter((candidate) => candidate.promotionEligible).sort((left, right) => (
    right.utility - left.utility
    || left.id.localeCompare(right.id)
  ))
  const best = ranked[0] ?? null
  const promotedCandidateId = relativeUpdateApplied
    && best !== null
    ? best.id
    : null
  let rollbackReason = null
  if (!relativeUpdateApplied) rollbackReason = 'insufficient-valid-candidates'
  else if (best === null) rollbackReason = 'no-candidate-passed-gates'
  return {
    apiVersion: API_VERSION,
    kind: 'GrhsGroupDecision',
    candidates: scored,
    validCandidates: valid.length,
    relativeUpdateApplied,
    proposalPriorBefore: { ...proposalPrior },
    proposalPriorAfter: nextPrior,
    promotedCandidateId,
    rollbackReason,
  }
}
