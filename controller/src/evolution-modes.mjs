import { ProtocolError } from './protocol.mjs'

export const CONTROLLER_MODES = Object.freeze([
  'single',
  'independent',
  'mutualism',
  'competition',
  'combined',
])

export const PEER_SHARING_MODES = Object.freeze(['mutualism', 'combined'])
export const COMPETITION_MODES = Object.freeze(['competition', 'combined'])
export const PEER_LOG_SANDBOX_ROOT = '/opt/harness-rsi/peer-logs'

const INJECT_POSITIONS = new Set(['prompt_prefix', 'prompt_suffix'])
const SCORING_METRICS = new Set(['delta_score'])
const BRANCH_ID_PATTERN = /^branch-[0-9]{3}$/u
const DEFAULT_LOG_PATH_TEMPLATE = '- {peer_id}: {log_path}'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} 必须是对象`)
    return {}
  }
  return value
}

function rejectUnknown(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} 是未知字段`)
  }
}

function integer(value, path, errors, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${path} 必须是 ${minimum}..${maximum} 的整数`)
  }
}

function boolean(value, path, errors) {
  if (typeof value !== 'boolean') errors.push(`${path} 必须是 boolean`)
}

function text(value, path, errors, maximum = 4096) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    errors.push(`${path} 必须是长度 1..${maximum} 的非空字符串`)
  }
}

export function modeUsesPeerSharing(mode) {
  return PEER_SHARING_MODES.includes(mode)
}

export function modeUsesCompetition(mode) {
  return COMPETITION_MODES.includes(mode)
}

/** Validate and normalize the public controller_config block. */
export function normalizeControllerConfig(input) {
  const errors = []
  const config = object(input, 'controller_config', errors)
  rejectUnknown(config, new Set([
    'mode', 'concurrency', 'budget', 'peer_sharing', 'competition',
  ]), 'controller_config', errors)

  const mode = config.mode
  if (!CONTROLLER_MODES.includes(mode)) {
    errors.push(`controller_config.mode 必须是 ${CONTROLLER_MODES.join(' | ')}`)
  }

  const concurrency = object(config.concurrency, 'controller_config.concurrency', errors)
  rejectUnknown(concurrency, new Set(['n_branches']), 'controller_config.concurrency', errors)
  integer(concurrency.n_branches, 'controller_config.concurrency.n_branches', errors, 1, 32)
  if (mode === 'single' && concurrency.n_branches !== 1) {
    errors.push('single 模式的 n_branches 必须是 1')
  }
  if (mode !== undefined && mode !== 'single'
      && Number.isSafeInteger(concurrency.n_branches) && concurrency.n_branches < 2) {
    errors.push(`${mode} 模式的 n_branches 必须至少是 2`)
  }

  const budget = object(config.budget, 'controller_config.budget', errors)
  rejectUnknown(budget, new Set(['total_budget', 'beta']), 'controller_config.budget', errors)
  integer(budget.total_budget, 'controller_config.budget.total_budget', errors, 1, 10_000)
  const beta = budget.beta ?? 0.5
  if (typeof beta !== 'number' || !Number.isFinite(beta) || beta < 0 || beta > 1) {
    errors.push('controller_config.budget.beta 必须位于 [0, 1]')
  }

  const peerSharing = object(
    config.peer_sharing ?? {},
    'controller_config.peer_sharing',
    errors,
  )
  rejectUnknown(peerSharing, new Set([
    'enabled', 'log_path_template', 'inject_position',
  ]), 'controller_config.peer_sharing', errors)
  const peerEnabled = peerSharing.enabled ?? modeUsesPeerSharing(mode)
  boolean(peerEnabled, 'controller_config.peer_sharing.enabled', errors)
  if (CONTROLLER_MODES.includes(mode) && peerEnabled !== modeUsesPeerSharing(mode)) {
    errors.push(`${mode} 模式要求 peer_sharing.enabled=${modeUsesPeerSharing(mode)}`)
  }
  const logPathTemplate = peerSharing.log_path_template ?? DEFAULT_LOG_PATH_TEMPLATE
  text(logPathTemplate, 'controller_config.peer_sharing.log_path_template', errors, 1024)
  if (typeof logPathTemplate === 'string' && !logPathTemplate.includes('{log_path}')) {
    errors.push('controller_config.peer_sharing.log_path_template 必须包含 {log_path}')
  }
  const injectPosition = peerSharing.inject_position ?? 'prompt_suffix'
  if (!INJECT_POSITIONS.has(injectPosition)) {
    errors.push('controller_config.peer_sharing.inject_position 必须是 prompt_prefix 或 prompt_suffix')
  }

  const competition = object(
    config.competition ?? {},
    'controller_config.competition',
    errors,
  )
  rejectUnknown(competition, new Set([
    'enabled', 'bonus_grant_unit', 'scoring_metric',
  ]), 'controller_config.competition', errors)
  const competitionEnabled = competition.enabled ?? modeUsesCompetition(mode)
  boolean(competitionEnabled, 'controller_config.competition.enabled', errors)
  if (CONTROLLER_MODES.includes(mode)
      && competitionEnabled !== modeUsesCompetition(mode)) {
    errors.push(`${mode} 模式要求 competition.enabled=${modeUsesCompetition(mode)}`)
  }
  const bonusGrantUnit = competition.bonus_grant_unit ?? 1
  integer(
    bonusGrantUnit,
    'controller_config.competition.bonus_grant_unit',
    errors,
    1,
    Number.isSafeInteger(budget.total_budget) ? budget.total_budget : 10_000,
  )
  const scoringMetric = competition.scoring_metric ?? 'delta_score'
  if (!SCORING_METRICS.has(scoringMetric)) {
    errors.push('controller_config.competition.scoring_metric 目前只支持 delta_score')
  }

  if (errors.length > 0) throw new ProtocolError('controller_config 配置校验失败', errors)
  return Object.freeze({
    mode,
    concurrency: Object.freeze({ n_branches: concurrency.n_branches }),
    budget: Object.freeze({ total_budget: budget.total_budget, beta }),
    peer_sharing: Object.freeze({
      enabled: peerEnabled,
      log_path_template: logPathTemplate,
      inject_position: injectPosition,
    }),
    competition: Object.freeze({
      enabled: competitionEnabled,
      bonus_grant_unit: bonusGrantUnit,
      scoring_metric: scoringMetric,
    }),
  })
}

function evenAllocation(total, count) {
  const quotient = Math.floor(total / count)
  const remainder = total % count
  return Array.from({ length: count }, (_, index) => quotient + (index < remainder ? 1 : 0))
}

export function branchIds(count) {
  integer(count, 'n_branches', [], 1, 32)
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) {
    throw new ProtocolError('n_branches 必须是 1..32 的整数')
  }
  return Array.from({ length: count }, (_, index) => `branch-${String(index + 1).padStart(3, '0')}`)
}

/** Convert a total integer round budget into deterministic branch credits. */
export function createBudgetPlan(controllerConfig) {
  const config = normalizeControllerConfig(controllerConfig)
  const count = config.concurrency.n_branches
  const total = config.budget.total_budget
  const ids = branchIds(count)
  let allocations
  let bonusPool = 0
  if (modeUsesCompetition(config.mode)) {
    // Every branch receives exactly the same guaranteed base. Fractional and
    // indivisible remainders stay in the competitive pool, preserving the
    // global integer budget without giving a branch an arbitrary head start.
    const perBranch = Math.floor((total * config.budget.beta) / count)
    allocations = Array(count).fill(perBranch)
    bonusPool = total - perBranch * count
  } else {
    allocations = evenAllocation(total, count)
  }
  return Object.freeze({
    mode: config.mode,
    totalBudget: total,
    beta: config.budget.beta,
    bonusPool,
    branches: Object.freeze(ids.map((branchId, index) => Object.freeze({
      branchId,
      baseBudget: allocations[index],
    }))),
  })
}

function requireBranchId(value, path) {
  if (!BRANCH_ID_PATTERN.test(value ?? '')) throw new ProtocolError(`${path} 无效`)
  return value
}

function renderPeerLine(template, peer) {
  return template
    .split('{peer_id}').join(peer.branchId)
    .split('{log_path}').join(peer.sandboxPath)
}

export function buildCoordinationContext({
  controllerConfig,
  branchId,
  peerLogs = [],
  competitionState = null,
}) {
  const config = normalizeControllerConfig(controllerConfig)
  requireBranchId(branchId, 'branchId')
  const normalizedPeers = peerLogs.map((peer, index) => {
    requireBranchId(peer?.branchId, `peerLogs[${index}].branchId`)
    if (peer.branchId === branchId) throw new ProtocolError('Peer log 不能指向当前 branch')
    if (typeof peer.sourcePath !== 'string' || !peer.sourcePath.startsWith('/')) {
      throw new ProtocolError(`peerLogs[${index}].sourcePath 必须是绝对路径`)
    }
    const sandboxPath = `${PEER_LOG_SANDBOX_ROOT}/${peer.branchId}.jsonl`
    return Object.freeze({ ...peer, sandboxPath })
  })

  const prefix = []
  const suffix = []
  if (modeUsesCompetition(config.mode)) {
    const remaining = competitionState?.bonusRemaining ?? 0
    const grant = config.competition.bonus_grant_unit
    prefix.push([
      '## Competition Block',
      '',
      `You are ${branchId} in a synchronized evolutionary competition.`,
      `Branches are ranked after this wave by ${config.competition.scoring_metric}; the largest validation-score improvement receives up to ${grant} additional evolution round(s).`,
      `The shared bonus pool currently has ${remaining} round(s) remaining.`,
      'Pursue one high-impact, generalizable mutation. Do not game the evaluator or bundle unrelated changes.',
    ].join('\n'))
  }
  if (modeUsesPeerSharing(config.mode) && normalizedPeers.length > 0) {
    const peerBlock = [
      '## Peer Log Sharing Block',
      '',
      'Read the other branches\' historical evolution logs at:',
      ...normalizedPeers.map((peer) => renderPeerLine(
        config.peer_sharing.log_path_template,
        peer,
      )),
      '',
      'Borrow general features that produced strong validation gains in peers.',
      'Identify features peers already found ineffective or incorrect and avoid repeating those failed experiments.',
      'Peer evidence is advisory: form one independent, evidence-backed mutation for the current branch.',
    ].join('\n')
    const target = config.peer_sharing.inject_position === 'prompt_prefix' ? prefix : suffix
    target.push(peerBlock)
  }
  return Object.freeze({
    promptPrefix: prefix.join('\n\n'),
    promptSuffix: suffix.join('\n\n'),
    peerLogs: Object.freeze(normalizedPeers),
  })
}

export function selectCompetitionWinner(results) {
  if (!Array.isArray(results)) throw new ProtocolError('Competition results 必须是数组')
  const eligible = results.filter((result) => (
    result?.eligible !== false
      && BRANCH_ID_PATTERN.test(result?.branchId ?? '')
      && Number.isFinite(result?.deltaScore)
      && Number.isFinite(result?.validationScore)
  ))
  eligible.sort((left, right) => (
    right.deltaScore - left.deltaScore
      || right.validationScore - left.validationScore
      || left.branchId.localeCompare(right.branchId)
  ))
  return eligible[0] ?? null
}

export function selectPopulationBest(branches) {
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new ProtocolError('Population branches 不能为空')
  }
  const ranked = branches.filter((branch) => (
    BRANCH_ID_PATTERN.test(branch?.branchId ?? '')
      && Number.isInteger(branch?.incumbent?.validationVerified)
  )).sort((left, right) => (
    right.incumbent.validationVerified - left.incumbent.validationVerified
      || left.branchId.localeCompare(right.branchId)
  ))
  if (ranked.length === 0) throw new ProtocolError('Population 没有可排名的 branch incumbent')
  return ranked[0]
}
