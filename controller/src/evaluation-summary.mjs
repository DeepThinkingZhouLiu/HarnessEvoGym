import { ProtocolError } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const METRIC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export const PRIMARY_METRIC_DIRECTIONS = Object.freeze(['maximize', 'minimize'])

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

function text(value, label, { maximum = 512 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new ProtocolError(`${label} 必须是长度 1..${maximum} 的非空字符串`)
  }
  return value
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${label} 必须是有限数字`)
  }
  return value
}

function freezeSummary(value) {
  Object.freeze(value.primary)
  return Object.freeze(value)
}

/**
 * 把不同 Environment 的评分投影成 Population 只需理解的主指标。
 * 指标名和方向必须在同一 Population 内保持一致。
 */
export function validateEvaluationSummary(input) {
  const summary = object(input, 'EvaluationSummary')
  rejectUnknown(
    summary,
    new Set(['apiVersion', 'kind', 'candidateId', 'primary']),
    'EvaluationSummary',
  )
  if (summary.apiVersion !== API_VERSION || summary.kind !== 'EvaluationSummary') {
    throw new ProtocolError('EvaluationSummary 协议无效')
  }

  const candidateId = text(summary.candidateId, 'EvaluationSummary.candidateId', { maximum: 128 })
  if (!CANDIDATE_ID.test(candidateId)) {
    throw new ProtocolError('EvaluationSummary.candidateId 格式无效')
  }

  const primary = object(summary.primary, 'EvaluationSummary.primary')
  rejectUnknown(primary, new Set(['metric', 'value', 'direction', 'total']), 'EvaluationSummary.primary')
  const metric = text(primary.metric, 'EvaluationSummary.primary.metric', { maximum: 128 })
  if (!METRIC_ID.test(metric)) {
    throw new ProtocolError('EvaluationSummary.primary.metric 必须是 kebab-case')
  }
  const value = finiteNumber(primary.value, 'EvaluationSummary.primary.value')
  if (!PRIMARY_METRIC_DIRECTIONS.includes(primary.direction)) {
    throw new ProtocolError('EvaluationSummary.primary.direction 必须是 maximize 或 minimize')
  }
  const total = primary.total ?? null
  if (total !== null) {
    finiteNumber(total, 'EvaluationSummary.primary.total')
    if (total < 0) throw new ProtocolError('EvaluationSummary.primary.total 不能为负数')
  }

  return freezeSummary({
    apiVersion: API_VERSION,
    kind: 'EvaluationSummary',
    candidateId,
    primary: { metric, value, direction: primary.direction, total },
  })
}

export function createEvaluationSummary({
  candidateId,
  metric,
  value,
  direction = 'maximize',
  total = null,
}) {
  return validateEvaluationSummary({
    apiVersion: API_VERSION,
    kind: 'EvaluationSummary',
    candidateId,
    primary: { metric, value, direction, total },
  })
}

/** 返回“候选相对基线的改善值”；正数始终表示变好。 */
export function primaryMetricDelta(candidateInput, baselineInput) {
  const candidate = validateEvaluationSummary(candidateInput)
  const baseline = validateEvaluationSummary(baselineInput)
  if (candidate.primary.metric !== baseline.primary.metric) {
    throw new ProtocolError('EvaluationSummary 主指标不一致', [
      `candidate=${candidate.primary.metric}`,
      `baseline=${baseline.primary.metric}`,
    ])
  }
  if (candidate.primary.direction !== baseline.primary.direction) {
    throw new ProtocolError('EvaluationSummary 主指标方向不一致')
  }
  const raw = candidate.primary.value - baseline.primary.value
  return candidate.primary.direction === 'maximize' ? raw : -raw
}
