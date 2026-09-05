import {
  primaryMetricDelta,
  validateEvaluationSummary,
} from './evaluation-summary.mjs'
import { ProtocolError } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const BRANCH_ID = /^branch-[0-9]{3}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const REGION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export const BRANCH_PROJECTION_STATUSES = Object.freeze([
  'pending', 'active', 'paused', 'stopped',
])
export const BRANCH_STEP_DECISIONS = Object.freeze([
  'promoted', 'rejected', 'invalid', 'stopped',
])
export const BRANCH_EVOLUTION_DRIVER_METHODS = Object.freeze([
  'initialize', 'inspect', 'advanceOne', 'exportPeerEvidence', 'exportBest',
])

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

function safeId(value, label, pattern = SAFE_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ProtocolError(`${label} 格式无效`)
  }
  return value
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ProtocolError(`${label} 必须是不小于 ${minimum} 的安全整数`)
  }
  return value
}

function nullable(value, normalize) {
  return value === null ? null : normalize(value)
}

function normalizeFiniteNullable(value, label) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${label} 必须是有限数字或 null`)
  }
  return value
}

function normalizePrior(value, label) {
  const prior = object(value, label)
  const entries = Object.entries(prior)
  if (entries.length === 0) throw new ProtocolError(`${label} 不能为空`)
  let total = 0
  const normalized = {}
  for (const [regionId, probability] of entries) {
    if (!REGION_ID.test(regionId)) {
      throw new ProtocolError(`${label}.${regionId} Region ID 格式无效`)
    }
    if (typeof probability !== 'number' || !Number.isFinite(probability)
        || probability < 0 || probability > 1) {
      throw new ProtocolError(`${label}.${regionId} 必须是 0..1 范围内的有限数字`)
    }
    normalized[regionId] = probability
    total += probability
  }
  if (!(total > 0) || Math.abs(total - 1) > 1e-6) {
    throw new ProtocolError(`${label} 的概率和必须接近 1`)
  }
  return Object.freeze(normalized)
}

function normalizeGroupCandidate(value, index) {
  const candidate = object(value, `BranchProjection.lastStep.group.candidates[${index}]`)
  rejectUnknown(
    candidate,
    new Set([
      'id', 'mutationPlanId', 'regionIds', 'valid', 'promotionEligible',
      'utility', 'relativeAdvantage',
    ]),
    `BranchProjection.lastStep.group.candidates[${index}]`,
  )
  const id = safeId(candidate.id, `BranchProjection.lastStep.group.candidates[${index}].id`)
  const mutationPlanId = safeId(
    candidate.mutationPlanId,
    `BranchProjection.lastStep.group.candidates[${index}].mutationPlanId`,
  )
  if (!Array.isArray(candidate.regionIds) || candidate.regionIds.length === 0) {
    throw new ProtocolError(`BranchProjection.lastStep.group.candidates[${index}].regionIds 必须是非空数组`)
  }
  const regionIds = candidate.regionIds.map((regionId, regionIndex) => (
    safeId(
      regionId,
      `BranchProjection.lastStep.group.candidates[${index}].regionIds[${regionIndex}]`,
      REGION_ID,
    )
  ))
  if (new Set(regionIds).size !== regionIds.length) {
    throw new ProtocolError(`BranchProjection.lastStep.group.candidates[${index}].regionIds 不能重复`)
  }
  if (typeof candidate.valid !== 'boolean') {
    throw new ProtocolError(`BranchProjection.lastStep.group.candidates[${index}].valid 必须是 boolean`)
  }
  if (typeof candidate.promotionEligible !== 'boolean') {
    throw new ProtocolError(`BranchProjection.lastStep.group.candidates[${index}].promotionEligible 必须是 boolean`)
  }
  const utility = normalizeFiniteNullable(
    candidate.utility,
    `BranchProjection.lastStep.group.candidates[${index}].utility`,
  )
  const relativeAdvantage = normalizeFiniteNullable(
    candidate.relativeAdvantage,
    `BranchProjection.lastStep.group.candidates[${index}].relativeAdvantage`,
  )
  if (!candidate.valid && (candidate.promotionEligible || utility !== null || relativeAdvantage !== null)) {
    throw new ProtocolError(`BranchProjection.lastStep.group.candidates[${index}] 无效时 utility/relativeAdvantage 必须为 null`)
  }
  if (candidate.valid && utility === null) {
    throw new ProtocolError(`BranchProjection.lastStep.group.candidates[${index}] 有效时 utility 不能为空`)
  }
  return Object.freeze({
    id,
    mutationPlanId,
    regionIds: Object.freeze(regionIds),
    valid: candidate.valid,
    promotionEligible: candidate.promotionEligible,
    utility,
    relativeAdvantage,
  })
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeIncumbent(value, branchId) {
  return nullable(value, (raw) => {
    const incumbent = object(raw, 'BranchProjection.incumbent')
    rejectUnknown(
      incumbent,
      new Set(['candidateId', 'revision', 'digest', 'evaluation']),
      'BranchProjection.incumbent',
    )
    const candidateId = safeId(incumbent.candidateId, 'BranchProjection.incumbent.candidateId')
    if (typeof incumbent.revision !== 'string' || incumbent.revision.trim().length === 0
        || incumbent.revision.length > 512) {
      throw new ProtocolError('BranchProjection.incumbent.revision 必须是长度 1..512 的非空字符串')
    }
    if (typeof incumbent.digest !== 'string' || !SHA256.test(incumbent.digest)) {
      throw new ProtocolError('BranchProjection.incumbent.digest 必须是 64 位小写 SHA-256')
    }
    const evaluation = validateEvaluationSummary(incumbent.evaluation)
    if (evaluation.candidateId !== candidateId) {
      throw new ProtocolError(`${branchId} incumbent 与 EvaluationSummary Candidate 不一致`)
    }
    return Object.freeze({
      candidateId,
      revision: incumbent.revision,
      digest: incumbent.digest,
      evaluation,
    })
  })
}

function normalizeLastStep(value, completedSteps) {
  return nullable(value, (raw) => {
    const step = object(raw, 'BranchProjection.lastStep')
    rejectUnknown(
      step,
      new Set([
        'stepId', 'stepNumber', 'candidateId', 'candidateRevision', 'candidateDigest',
        'decision', 'ranking', 'budgetConsumed', 'groupId', 'groupSize', 'groupCandidateIds',
        'group',
      ]),
      'BranchProjection.lastStep',
    )
    const stepId = safeId(step.stepId, 'BranchProjection.lastStep.stepId')
    const stepNumber = safeInteger(step.stepNumber, 'BranchProjection.lastStep.stepNumber', 1)
    if (stepNumber !== completedSteps) {
      throw new ProtocolError('BranchProjection.lastStep.stepNumber 必须等于 completedSteps')
    }
    if (!BRANCH_STEP_DECISIONS.includes(step.decision)) {
      throw new ProtocolError(`BranchProjection.lastStep.decision 必须是 ${BRANCH_STEP_DECISIONS.join(' | ')}`)
    }
    const candidateId = step.candidateId === null
      ? null
      : safeId(step.candidateId, 'BranchProjection.lastStep.candidateId')
    const candidateRevision = step.candidateRevision === undefined || step.candidateRevision === null
      ? null
      : safeId(step.candidateRevision, 'BranchProjection.lastStep.candidateRevision', /^[^\u0000-\u001f\u007f]{1,512}$/u)
    const candidateDigest = step.candidateDigest === undefined || step.candidateDigest === null
      ? null
      : safeId(step.candidateDigest, 'BranchProjection.lastStep.candidateDigest', SHA256)
    const budgetConsumed = step.budgetConsumed === undefined ? 1 : step.budgetConsumed
    if (!Number.isSafeInteger(budgetConsumed) || budgetConsumed < 1 || budgetConsumed > 128) {
      throw new ProtocolError('BranchProjection.lastStep.budgetConsumed 必须是 1..128 的整数')
    }
    const groupId = step.groupId === undefined || step.groupId === null
      ? null
      : safeId(step.groupId, 'BranchProjection.lastStep.groupId')
    const groupSize = step.groupSize === undefined || step.groupSize === null
      ? null
      : safeInteger(step.groupSize, 'BranchProjection.lastStep.groupSize', 2)
    const groupCandidateIds = step.groupCandidateIds === undefined || step.groupCandidateIds === null
      ? null
      : step.groupCandidateIds
    let normalizedGroupCandidateIds = null
    if (groupCandidateIds !== null) {
      if (!Array.isArray(groupCandidateIds)) {
        throw new ProtocolError('BranchProjection.lastStep.groupCandidateIds 必须是数组')
      }
      normalizedGroupCandidateIds = groupCandidateIds.map((id, index) => (
        safeId(id, `BranchProjection.lastStep.groupCandidateIds[${index}]`)
      ))
    }
    if (candidateId === null && (candidateRevision !== null || candidateDigest !== null)) {
      throw new ProtocolError('BranchProjection.lastStep 无 Candidate 时不能包含 Artifact 身份')
    }
    if (groupSize === null && (groupId !== null || groupCandidateIds !== null || budgetConsumed !== 1)) {
      throw new ProtocolError('非分组 Step 不能包含分组或多 Candidate Budget 信息')
    }
    if (groupSize !== null) {
      if (groupSize > 32 || budgetConsumed !== groupSize) {
        throw new ProtocolError('分组 Step 的 groupSize 与 budgetConsumed 不一致')
      }
      if (!Array.isArray(groupCandidateIds) || groupCandidateIds.length !== groupSize) {
        throw new ProtocolError('分组 Step 必须列出完整的 groupCandidateIds')
      }
      if (new Set(normalizedGroupCandidateIds).size !== normalizedGroupCandidateIds.length) {
        throw new ProtocolError('分组 Step 的 groupCandidateIds 不能重复')
      }
    }
    const rawGroup = step.group === undefined || step.group === null ? null : object(step.group, 'BranchProjection.lastStep.group')
    let group = null
    if (groupSize !== null && rawGroup === null) {
      throw new ProtocolError('分组 Step 必须包含完整 group 元数据')
    }
    if (rawGroup !== null) {
      rejectUnknown(
        rawGroup,
        new Set([
          'groupId', 'groupSize', 'groupCandidateIds', 'winnerCandidateId', 'rollbackReason',
          'candidates', 'proposalPriorBefore', 'proposalPriorAfter',
        ]),
        'BranchProjection.lastStep.group',
      )
      if (groupSize === null) throw new ProtocolError('分组元数据必须与 groupSize 同时提供')
      if (typeof rawGroup.groupId !== 'string' || !SAFE_ID.test(rawGroup.groupId)
          || !Number.isSafeInteger(rawGroup.groupSize)
          || !Array.isArray(rawGroup.groupCandidateIds)
          || rawGroup.winnerCandidateId === undefined
          || rawGroup.rollbackReason === undefined
          || !Array.isArray(rawGroup.candidates)
          || rawGroup.proposalPriorBefore === undefined
          || rawGroup.proposalPriorAfter === undefined) {
        throw new ProtocolError('BranchProjection.lastStep.group 缺少必需字段')
      }
      if (rawGroup.groupId !== groupId || rawGroup.groupSize !== groupSize
          || !Array.isArray(rawGroup.groupCandidateIds)
          || !sameValues(rawGroup.groupCandidateIds, normalizedGroupCandidateIds)) {
        throw new ProtocolError('BranchProjection.lastStep.group 的分组身份必须与顶层字段一致')
      }
      if (rawGroup.winnerCandidateId !== null
          && (typeof rawGroup.winnerCandidateId !== 'string' || !SAFE_ID.test(rawGroup.winnerCandidateId))) {
        throw new ProtocolError('BranchProjection.lastStep.group.winnerCandidateId 格式无效')
      }
      if (rawGroup.winnerCandidateId !== null
          && !normalizedGroupCandidateIds.includes(rawGroup.winnerCandidateId)) {
        throw new ProtocolError('BranchProjection.lastStep.group.winnerCandidateId 必须属于 groupCandidateIds')
      }
      if (rawGroup.rollbackReason !== null
          && (typeof rawGroup.rollbackReason !== 'string' || rawGroup.rollbackReason.length > 256)) {
        throw new ProtocolError('BranchProjection.lastStep.group.rollbackReason 格式无效')
      }
      if (!Array.isArray(rawGroup.candidates) || rawGroup.candidates.length !== groupSize) {
        throw new ProtocolError('BranchProjection.lastStep.group.candidates 必须列出完整 sibling')
      }
      const normalizedCandidates = rawGroup.candidates.map(normalizeGroupCandidate)
      const candidateIds = normalizedCandidates.map((candidate) => candidate.id)
      if (!sameValues(candidateIds, normalizedGroupCandidateIds)) {
        throw new ProtocolError('BranchProjection.lastStep.group.candidates 必须与 groupCandidateIds 顺序一致')
      }
      if (rawGroup.winnerCandidateId !== null && candidateId !== rawGroup.winnerCandidateId) {
        throw new ProtocolError('分组 Step 的 Candidate 必须是 GRHS Winner')
      }
      const winner = rawGroup.winnerCandidateId === null
        ? null
        : normalizedCandidates.find((candidate) => candidate.id === rawGroup.winnerCandidateId)
      if (winner !== null && (!winner.valid || !winner.promotionEligible)) {
        throw new ProtocolError('GRHS Winner 必须是有效且通过晋升门槛的 sibling')
      }
      if ((winner !== null) !== (step.decision === 'promoted')) {
        throw new ProtocolError('GRHS Winner 与 Step decision 不一致')
      }
      if (rawGroup.winnerCandidateId === null && candidateId !== null
          && !normalizedGroupCandidateIds.includes(candidateId)) {
        throw new ProtocolError('分组 Step 的 Candidate 必须属于 sibling 列表')
      }
      const proposalPriorBefore = normalizePrior(
        rawGroup.proposalPriorBefore,
        'BranchProjection.lastStep.group.proposalPriorBefore',
      )
      const proposalPriorAfter = normalizePrior(
        rawGroup.proposalPriorAfter,
        'BranchProjection.lastStep.group.proposalPriorAfter',
      )
      if (!sameValues(
        Object.keys(proposalPriorBefore).sort(),
        Object.keys(proposalPriorAfter).sort(),
      )) {
        throw new ProtocolError('BranchProjection.lastStep.group 两个 proposal prior 的 Region 集合必须一致')
      }
      if ((rawGroup.winnerCandidateId === null) === (rawGroup.rollbackReason === null)) {
        throw new ProtocolError('BranchProjection.lastStep.group Winner 与 rollbackReason 状态不一致')
      }
      group = Object.freeze({
        groupId,
        groupSize,
        groupCandidateIds: Object.freeze(normalizedGroupCandidateIds.slice()),
        winnerCandidateId: rawGroup.winnerCandidateId,
        rollbackReason: rawGroup.rollbackReason,
        candidates: Object.freeze(normalizedCandidates),
        proposalPriorBefore,
        proposalPriorAfter,
      })
    }
    const ranking = object(step.ranking, 'BranchProjection.lastStep.ranking')
    rejectUnknown(
      ranking,
      new Set(['eligible', 'evaluation', 'baselineEvaluation']),
      'BranchProjection.lastStep.ranking',
    )
    if (typeof ranking.eligible !== 'boolean') {
      throw new ProtocolError('BranchProjection.lastStep.ranking.eligible 必须是 boolean')
    }
    const evaluation = nullable(
      ranking.evaluation,
      (summary) => validateEvaluationSummary(summary),
    )
    const baselineEvaluation = nullable(
      ranking.baselineEvaluation ?? null,
      (summary) => validateEvaluationSummary(summary),
    )
    if (evaluation !== null && evaluation.candidateId !== candidateId) {
      throw new ProtocolError('BranchProjection.lastStep Candidate 与 EvaluationSummary 不一致')
    }
    if (baselineEvaluation !== null) {
      if (evaluation === null) {
        throw new ProtocolError('BranchProjection.lastStep 配对基线必须与 Candidate Evaluation 同时提供')
      }
      if (baselineEvaluation.candidateId === candidateId) {
        throw new ProtocolError('BranchProjection.lastStep 配对基线不能指向当前 Candidate')
      }
      // 同时验证主指标与方向一致；Population 后续只消费这个受信比较口径。
      primaryMetricDelta(evaluation, baselineEvaluation)
    }
    if (['promoted', 'rejected'].includes(step.decision)
        && (candidateId === null || evaluation === null)) {
      throw new ProtocolError(`${step.decision} Step 必须提供 Candidate 与 EvaluationSummary`)
    }
    if (step.decision === 'promoted' && !ranking.eligible) {
      throw new ProtocolError('promoted Step 的 ranking.eligible 必须为 true')
    }
    if (['invalid', 'stopped'].includes(step.decision) && ranking.eligible) {
      throw new ProtocolError(`${step.decision} Step 的 ranking.eligible 必须为 false`)
    }
    return Object.freeze({
      stepId,
      stepNumber,
      candidateId,
      candidateRevision,
      candidateDigest,
      budgetConsumed,
      groupId,
      groupSize,
      groupCandidateIds: normalizedGroupCandidateIds === null
        ? null
        : Object.freeze(normalizedGroupCandidateIds.slice()),
      group: group === null ? null : Object.freeze(structuredClone(group)),
      decision: step.decision,
      ranking: Object.freeze({
        eligible: ranking.eligible,
        evaluation,
        baselineEvaluation,
      }),
    })
  })
}

/** Population 只消费这个投影，不得读取场景 Store、Git 或 Candidate 内部结构。 */
export function validateBranchProjection(input) {
  const projection = object(input, 'BranchProjection')
  rejectUnknown(
    projection,
    new Set([
      'apiVersion', 'kind', 'branchId', 'status', 'completedSteps', 'incumbent', 'lastStep',
    ]),
    'BranchProjection',
  )
  if (projection.apiVersion !== API_VERSION || projection.kind !== 'BranchProjection') {
    throw new ProtocolError('BranchProjection 协议无效')
  }
  const branchId = safeId(projection.branchId, 'BranchProjection.branchId', BRANCH_ID)
  if (!BRANCH_PROJECTION_STATUSES.includes(projection.status)) {
    throw new ProtocolError(`BranchProjection.status 必须是 ${BRANCH_PROJECTION_STATUSES.join(' | ')}`)
  }
  const completedSteps = safeInteger(projection.completedSteps, 'BranchProjection.completedSteps')
  const incumbent = normalizeIncumbent(projection.incumbent, branchId)
  const lastStep = normalizeLastStep(projection.lastStep, completedSteps)
  if (projection.status === 'pending' && (incumbent !== null || completedSteps !== 0 || lastStep !== null)) {
    throw new ProtocolError('pending Branch 不能包含 incumbent 或已完成 Step')
  }
  if (projection.status !== 'pending' && incumbent === null) {
    throw new ProtocolError(`${projection.status} Branch 必须包含 incumbent`)
  }
  if (completedSteps === 0 && lastStep !== null) {
    throw new ProtocolError('completedSteps=0 时 lastStep 必须为 null')
  }

  return Object.freeze({
    apiVersion: API_VERSION,
    kind: 'BranchProjection',
    branchId,
    status: projection.status,
    completedSteps,
    incumbent,
    lastStep,
  })
}

export function validateBranchStepResult(input) {
  const result = object(input, 'BranchStepResult')
  rejectUnknown(
    result,
    new Set(['apiVersion', 'kind', 'stepId', 'budgetConsumed', 'projection']),
    'BranchStepResult',
  )
  if (result.apiVersion !== API_VERSION || result.kind !== 'BranchStepResult') {
    throw new ProtocolError('BranchStepResult 协议无效')
  }
  const stepId = safeId(result.stepId, 'BranchStepResult.stepId')
  if (!Number.isSafeInteger(result.budgetConsumed) || result.budgetConsumed < 0 || result.budgetConsumed > 128) {
    throw new ProtocolError('BranchStepResult.budgetConsumed 必须是 0..128 的整数')
  }
  const projection = validateBranchProjection(result.projection)
  if (result.budgetConsumed > 0 && projection.lastStep?.stepId !== stepId) {
    throw new ProtocolError('消耗 Budget 的 BranchStepResult 必须对应当前 lastStep')
  }
  if (result.budgetConsumed > 0 && projection.lastStep?.budgetConsumed !== result.budgetConsumed) {
    throw new ProtocolError('BranchStepResult.budgetConsumed 与 lastStep 不一致')
  }
  return Object.freeze({
    apiVersion: API_VERSION,
    kind: 'BranchStepResult',
    stepId,
    budgetConsumed: result.budgetConsumed,
    projection,
  })
}

/** 验证受信 Branch Driver 实现的最小方法集。 */
export function validateBranchEvolutionDriver(driver) {
  if (driver === null || (typeof driver !== 'object' && typeof driver !== 'function')) {
    throw new ProtocolError('BranchEvolutionDriver 必须是对象')
  }
  const missing = BRANCH_EVOLUTION_DRIVER_METHODS.filter((method) => typeof driver[method] !== 'function')
  if (missing.length > 0) {
    throw new ProtocolError('BranchEvolutionDriver 缺少必需方法', missing.map((method) => `${method}()`))
  }
  return driver
}
