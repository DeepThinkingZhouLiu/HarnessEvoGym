import { ProtocolError } from './protocol.mjs'

function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`${name} 必须是 ${minimum}..${maximum} 的整数`)
  }
}

export function nearestRankPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0
      || values.some((value) => !Number.isFinite(value) || value <= 0)
      || !Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new ProtocolError('延时分位数参数无效')
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(percentile * sorted.length) - 1]
}

/**
 * Size concurrency from observed end-to-end solver+judge p90. The safety factor
 * and reserve keep the nominal estimate below the one-hour hard deadline.
 */
export function recommendHleConcurrency({
  latenciesMs,
  taskCount = 100,
  targetMs = 60 * 60 * 1000,
  reserveMs = 5 * 60 * 1000,
  safetyFactor = 1.15,
  minimumConcurrency = 4,
  maximumConcurrency = 24,
}) {
  if (!Array.isArray(latenciesMs) || latenciesMs.length < 4) {
    throw new ProtocolError('HLE 并发校准至少需要 4 个完整任务')
  }
  integer(taskCount, 'taskCount', 1, 10_000)
  integer(targetMs, 'targetMs', 60_000)
  integer(reserveMs, 'reserveMs', 0, targetMs - 1)
  integer(minimumConcurrency, 'minimumConcurrency', 1, 64)
  integer(maximumConcurrency, 'maximumConcurrency', minimumConcurrency, 64)
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1 || safetyFactor > 3) {
    throw new ProtocolError('safetyFactor 必须是 1..3')
  }
  const p90LatencyMs = nearestRankPercentile(latenciesMs, 0.9)
  const usableMs = targetMs - reserveMs
  const required = Math.ceil(taskCount * p90LatencyMs * safetyFactor / usableMs)
  const concurrency = Math.max(minimumConcurrency, Math.min(maximumConcurrency, required))
  const projectedMs = Math.ceil(taskCount * p90LatencyMs * safetyFactor / concurrency)
  return Object.freeze({
    sampleSize: latenciesMs.length,
    p90LatencyMs,
    concurrency,
    requiredConcurrency: required,
    projectedMs,
    targetMs,
    reserveMs,
    feasible: required <= maximumConcurrency && projectedMs <= usableMs,
  })
}
