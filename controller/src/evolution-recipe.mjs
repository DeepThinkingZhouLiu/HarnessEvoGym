import { normalizeControllerConfig } from './evolution-modes.mjs'
import { ProtocolError } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const AUTHORITIES = Object.freeze(['updater-directed', 'strategy-directed'])
const RISK_LEVELS = Object.freeze(['l1', 'l2', 'l3'])
const LAYER_SELECTIONS = Object.freeze(['controller-sequential', 'updater-soft'])

export const MODULE_SEARCH_AUTHORITIES = AUTHORITIES

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknown)
}

function strategyReference(value, { defaultValue = null } = {}) {
  const source = value ?? defaultValue
  if (typeof source === 'string') {
    if (source.trim().length === 0 || source.length > 1024 || /[\u0000-\u001f\u007f]/u.test(source)) {
      throw new ProtocolError('EvolutionRecipe moduleSearch.strategy 格式无效')
    }
    return source
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const id = source.id ?? source.metadata?.id
    if (typeof id === 'string' && id.trim().length > 0 && id.length <= 128) return id
  }
  if (source === null) return null
  throw new ProtocolError('EvolutionRecipe moduleSearch.strategy 必须是 Strategy ID、Adapter 路径或已解析 Adapter')
}

function normalizeModuleSearch(input) {
  const search = object(input, 'EvolutionRecipe.spec.moduleSearch')
  rejectUnknown(search, new Set(['authority', 'riskCeiling', 'strategy']), 'EvolutionRecipe.spec.moduleSearch')
  if (!AUTHORITIES.includes(search.authority)) {
    throw new ProtocolError(`EvolutionRecipe moduleSearch.authority 必须是 ${AUTHORITIES.join(' | ')}`)
  }
  if (!RISK_LEVELS.includes(search.riskCeiling)) {
    throw new ProtocolError(`EvolutionRecipe moduleSearch.riskCeiling 必须是 ${RISK_LEVELS.join(' | ')}`)
  }
  const strategy = strategyReference(search.strategy)
  if (search.authority === 'updater-directed' && strategy !== null) {
    throw new ProtocolError('updater-directed 不能预先指定 Search Strategy')
  }
  if (search.authority === 'strategy-directed' && strategy === null) {
    throw new ProtocolError('strategy-directed 必须指定 Search Strategy')
  }
  return Object.freeze({ authority: search.authority, riskCeiling: search.riskCeiling, strategy })
}

function freezePopulation(input) {
  return Object.freeze({
    ...input,
    concurrency: Object.freeze({ ...input.concurrency }),
    budget: Object.freeze({ ...input.budget }),
    peer_sharing: Object.freeze({ ...input.peer_sharing }),
    competition: Object.freeze({ ...input.competition }),
  })
}

/** 规范化新的通用 Recipe，Population 字段保持 HZY 原始语义与命名。 */
export function normalizeEvolutionRecipe(input) {
  const recipe = object(input, 'EvolutionRecipe')
  rejectUnknown(recipe, new Set(['apiVersion', 'kind', 'spec']), 'EvolutionRecipe')
  if (recipe.apiVersion !== API_VERSION || recipe.kind !== 'EvolutionRecipe') {
    throw new ProtocolError('EvolutionRecipe 协议无效')
  }
  const spec = object(recipe.spec, 'EvolutionRecipe.spec')
  rejectUnknown(spec, new Set(['population', 'moduleSearch']), 'EvolutionRecipe.spec')
  const population = freezePopulation(normalizeControllerConfig(spec.population))
  const moduleSearch = normalizeModuleSearch(spec.moduleSearch)
  return Object.freeze({
    apiVersion: API_VERSION,
    kind: 'EvolutionRecipe',
    spec: Object.freeze({ population, moduleSearch }),
  })
}

function recipe(population, moduleSearch) {
  return normalizeEvolutionRecipe({
    apiVersion: API_VERSION,
    kind: 'EvolutionRecipe',
    spec: { population, moduleSearch },
  })
}

/** 把旧 Reasoning controller_config/layerSelection 投影成通用 Recipe。 */
export function normalizeReasoningEvolutionRecipe({
  controllerConfig,
  layerSelection = 'controller-sequential',
  riskCeiling = 'l3',
}) {
  if (!LAYER_SELECTIONS.includes(layerSelection)) {
    throw new ProtocolError(`Reasoning layerSelection 必须是 ${LAYER_SELECTIONS.join(' | ')}`)
  }
  return recipe(controllerConfig, layerSelection === 'updater-soft'
    ? { authority: 'updater-directed', riskCeiling, strategy: null }
    : {
        authority: 'strategy-directed',
        riskCeiling,
        strategy: 'progressive-risk-expansion',
      })
}

/** 把旧 Cowork generations/strategy 投影成 Single Population Recipe。 */
export function normalizeCoworkEvolutionRecipe({
  generations,
  strategy = null,
  mutationLevel,
}) {
  if (!Number.isSafeInteger(generations) || generations < 1 || generations > 10_000) {
    throw new ProtocolError('Cowork generations 必须是 1..10000 的整数')
  }
  if (!RISK_LEVELS.includes(mutationLevel)) {
    throw new ProtocolError(`Cowork mutationLevel 必须是 ${RISK_LEVELS.join(' | ')}`)
  }
  const normalizedStrategy = strategyReference(strategy, { defaultValue: 'linear-hill-climb' })
  return recipe({
    mode: 'single',
    concurrency: { n_branches: 1 },
    budget: { total_budget: generations, beta: 0.5 },
    peer_sharing: { enabled: false },
    competition: { enabled: false },
  }, {
    authority: 'strategy-directed',
    riskCeiling: mutationLevel,
    strategy: normalizedStrategy,
  })
}
