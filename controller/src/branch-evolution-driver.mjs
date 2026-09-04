import {
  primaryMetricDelta,
  validateEvaluationSummary,
} from './evaluation-summary.mjs'
import { ProtocolError } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const BRANCH_ID = /^branch-[0-9]{3}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u

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
        'decision', 'ranking',
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
    if (candidateId === null && (candidateRevision !== null || candidateDigest !== null)) {
      throw new ProtocolError('BranchProjection.lastStep 无 Candidate 时不能包含 Artifact 身份')
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
  if (![0, 1].includes(result.budgetConsumed)) {
    throw new ProtocolError('BranchStepResult.budgetConsumed 只能是 0 或 1')
  }
  const projection = validateBranchProjection(result.projection)
  if (result.budgetConsumed === 1 && projection.lastStep?.stepId !== stepId) {
    throw new ProtocolError('消耗 Budget 的 BranchStepResult 必须对应当前 lastStep')
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
