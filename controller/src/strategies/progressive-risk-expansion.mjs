import { MUTATION_RISK_LEVELS } from '../mutation-catalog.mjs'
import { ProtocolError } from '../protocol.mjs'

const ALLOWED_CONFIGURATION = new Set([
  'startRiskLevel',
  'missesBeforeExpansion',
  'regionSelection',
])

function validateConfiguration(configuration) {
  const unknown = Object.keys(configuration).filter((key) => !ALLOWED_CONFIGURATION.has(key))
  if (unknown.length > 0) {
    throw new ProtocolError('progressive-risk-expansion 含有未知配置', unknown)
  }
  const startRiskLevel = configuration.startRiskLevel ?? 'l1'
  if (!MUTATION_RISK_LEVELS.includes(startRiskLevel)) {
    throw new ProtocolError('progressive-risk-expansion.startRiskLevel 必须是 l1 | l2 | l3')
  }
  const missesBeforeExpansion = configuration.missesBeforeExpansion ?? 3
  if (!Number.isSafeInteger(missesBeforeExpansion)
      || missesBeforeExpansion < 1
      || missesBeforeExpansion > 10_000) {
    throw new ProtocolError('progressive-risk-expansion.missesBeforeExpansion 必须是 1..10000 的整数')
  }
  const regionSelection = configuration.regionSelection ?? 'all-under-active-risk-level'
  if (regionSelection !== 'all-under-active-risk-level') {
    throw new ProtocolError(
      'progressive-risk-expansion 只支持 all-under-active-risk-level Region 选择',
    )
  }
  return { startRiskLevel, missesBeforeExpansion }
}

function availableRiskLevels(context, startRiskLevel) {
  const ceiling = MUTATION_RISK_LEVELS.indexOf(context.riskCeiling)
  const catalogLevels = new Set(context.catalog.spec.regions.map((region) => region.riskLevel))
  const levels = MUTATION_RISK_LEVELS.filter((level, index) => (
    index <= ceiling && catalogLevels.has(level)
  ))
  if (levels.length === 0) {
    throw new ProtocolError('progressive-risk-expansion 在风险上限内没有可搜索 Region')
  }
  if (!levels.includes(startRiskLevel)) {
    throw new ProtocolError(
      `progressive-risk-expansion 起始层级 ${startRiskLevel.toUpperCase()} 不在 Target 可用风险层中`,
    )
  }
  return levels.slice(levels.indexOf(startRiskLevel))
}

function validRiskLevels(levels) {
  return Array.isArray(levels)
    && levels.length > 0
    && levels.every((level) => MUTATION_RISK_LEVELS.includes(level))
    && new Set(levels).size === levels.length
    && levels.every((level, index) => index === 0
      || MUTATION_RISK_LEVELS.indexOf(level) > MUTATION_RISK_LEVELS.indexOf(levels[index - 1]))
}

function normalizedState(previousState, context, startRiskLevel) {
  const levels = context === null
    ? previousState?.riskLevels
    : availableRiskLevels(context, startRiskLevel)
  if (!validRiskLevels(levels)) {
    throw new ProtocolError('progressive-risk-expansion State.riskLevels 必须是严格递增的风险层数组')
  }
  if (previousState === null) {
    return {
      riskLevels: levels,
      activeRiskLevel: levels[0],
      consecutiveMisses: 0,
      roundsProposed: 0,
      roundsObserved: 0,
      expansions: 0,
      exhausted: false,
    }
  }
  const allowedState = new Set([
    'activeRiskLevel',
    'riskLevels',
    'consecutiveMisses',
    'roundsProposed',
    'roundsObserved',
    'expansions',
    'exhausted',
    'lastObservation',
  ])
  const unknownState = Object.keys(previousState).filter((key) => !allowedState.has(key))
  if (unknownState.length > 0) {
    throw new ProtocolError('progressive-risk-expansion State 含有未知字段', unknownState)
  }
  if (!levels.includes(previousState.activeRiskLevel)) {
    throw new ProtocolError('progressive-risk-expansion State.activeRiskLevel 超出当前 Target 边界')
  }
  if (!Array.isArray(previousState.riskLevels)
      || previousState.riskLevels.length !== levels.length
      || previousState.riskLevels.some((level, index) => level !== levels[index])) {
    throw new ProtocolError('progressive-risk-expansion State.riskLevels 与当前 Target 不一致')
  }
  for (const [name, value] of [
    ['consecutiveMisses', previousState.consecutiveMisses],
    ['roundsProposed', previousState.roundsProposed],
    ['roundsObserved', previousState.roundsObserved],
    ['expansions', previousState.expansions],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProtocolError(`progressive-risk-expansion State.${name} 必须是非负整数`)
    }
  }
  if (typeof previousState.exhausted !== 'boolean') {
    throw new ProtocolError('progressive-risk-expansion State.exhausted 必须是布尔值')
  }
  return { ...previousState }
}

export function createProgressiveRiskExpansionStrategy(configuration) {
  const { startRiskLevel, missesBeforeExpansion } = validateConfiguration(configuration)
  return {
    async propose(context, previousState) {
      const state = normalizedState(previousState, context, startRiskLevel)
      if (state.exhausted) {
        throw new ProtocolError('progressive-risk-expansion 已耗尽，不能继续生成 MutationPlan')
      }
      const active = MUTATION_RISK_LEVELS.indexOf(state.activeRiskLevel)
      const regionIds = context.catalog.spec.regions
        .filter((region) => MUTATION_RISK_LEVELS.indexOf(region.riskLevel) <= active)
        .map((region) => region.id)
      return {
        state: { ...state, roundsProposed: state.roundsProposed + 1 },
        plan: {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'MutationPlan',
          metadata: {
            id: `generation-${String(context.generation).padStart(4, '0')}-progressive-${state.activeRiskLevel}`,
          },
          spec: {
            generation: context.generation,
            parentIds: [context.championId],
            regionIds,
          },
        },
      }
    },
    async observe(context, previousState) {
      // observe 上下文不重复传 Catalog；可用层级已在 propose 时写入受校验状态。
      const state = normalizedState(previousState, null, startRiskLevel)
      if (state.exhausted) {
        throw new ProtocolError('progressive-risk-expansion 已耗尽，不能重复 observe')
      }
      if (!['promoted', 'rejected', 'invalid-proposal'].includes(context.status)) {
        throw new ProtocolError(`progressive-risk-expansion 无法观测状态：${context.status}`)
      }
      const levels = state.riskLevels
      let activeRiskLevel = state.activeRiskLevel
      let consecutiveMisses = context.status === 'promoted' ? 0 : state.consecutiveMisses + 1
      let expansions = state.expansions
      let exhausted = false
      if (consecutiveMisses >= missesBeforeExpansion) {
        const current = levels.indexOf(activeRiskLevel)
        if (current < levels.length - 1) {
          activeRiskLevel = levels[current + 1]
          consecutiveMisses = 0
          expansions += 1
        } else {
          exhausted = true
        }
      }
      return {
        exhausted,
        state: {
          riskLevels: levels,
          activeRiskLevel,
          consecutiveMisses,
          roundsProposed: state.roundsProposed,
          roundsObserved: state.roundsObserved + 1,
          expansions,
          exhausted,
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
