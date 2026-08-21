import { ProtocolError } from './protocol.mjs'

function round(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isResolved(record) {
  return record?.status === 'resolved'
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(fraction * (sortedValues.length - 1))))
  return sortedValues[index]
}

function summarizeNumeric(records, field) {
  const values = records
    .map((record) => record[field])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
  const observedTotal = values.reduce((sum, value) => sum + value, 0)
  return {
    knownCount: values.length,
    complete: values.length === records.length,
    total: values.length === records.length ? round(observedTotal) : null,
    observedTotal: values.length > 0 ? round(observedTotal) : null,
    mean: values.length > 0 ? round(observedTotal / values.length) : null,
  }
}

function summarizeLatency(records) {
  const summary = summarizeNumeric(records, 'latencyMs')
  const values = records
    .map((record) => record.latencyMs)
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right)
  return {
    ...summary,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  }
}

function wilsonInterval(successes, total, confidence = 0.95) {
  if (total === 0) return null
  const z = confidence === 0.95 ? 1.959963984540054 : 1.959963984540054
  const proportion = successes / total
  const denominator = 1 + (z ** 2) / total
  const center = (proportion + (z ** 2) / (2 * total)) / denominator
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / total + (z ** 2) / (4 * total ** 2))
  return {
    confidence,
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
  }
}

function createRandom(seed) {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function bootstrapPairedDelta(differences, options) {
  if (differences.length === 0) return null
  const random = createRandom(options.seed)
  const samples = new Float64Array(options.samples)

  for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex += 1) {
    let total = 0
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)]
    }
    samples[sampleIndex] = total / differences.length
  }

  samples.sort()
  const tail = (1 - options.confidence) / 2
  return {
    confidence: options.confidence,
    samples: options.samples,
    seed: options.seed,
    lower: round(percentile(samples, tail)),
    upper: round(percentile(samples, 1 - tail)),
  }
}

function materializeRecords(recordMap, instanceIds) {
  return instanceIds.map((instanceId) =>
    recordMap.get(instanceId) ?? {
      instanceId,
      status: 'not_attempted',
      policyViolations: [],
    },
  )
}

function summarizeRun(recordMap, instanceIds) {
  const records = materializeRecords(recordMap, instanceIds)
  const counts = {
    total: records.length,
    recordsPresent: instanceIds.filter((instanceId) => recordMap.has(instanceId)).length,
    attempted: 0,
    completed: 0,
    resolved: 0,
    unresolved: 0,
    error: 0,
    timeout: 0,
    notAttempted: 0,
  }

  let policyViolationCount = 0
  let policyViolationInstances = 0
  for (const record of records) {
    if (record.status !== 'not_attempted') counts.attempted += 1
    if (record.status === 'resolved' || record.status === 'unresolved') counts.completed += 1
    if (record.status === 'resolved') counts.resolved += 1
    if (record.status === 'unresolved') counts.unresolved += 1
    if (record.status === 'error') counts.error += 1
    if (record.status === 'timeout') counts.timeout += 1
    if (record.status === 'not_attempted') counts.notAttempted += 1
    if (record.policyViolations.length > 0) {
      policyViolationInstances += 1
      policyViolationCount += record.policyViolations.length
    }
  }

  const tokenRecords = records.map((record) => ({
    totalTokens:
      typeof record.inputTokens === 'number' && typeof record.outputTokens === 'number'
        ? record.inputTokens + record.outputTokens
        : undefined,
  }))

  return {
    ...counts,
    coverageRate: round(counts.recordsPresent / counts.total),
    completionRate: round(counts.completed / counts.total),
    resolvedRate: round(counts.resolved / counts.total),
    resolvedRateCi95: wilsonInterval(counts.resolved, counts.total),
    costUsd: summarizeNumeric(records, 'costUsd'),
    tokens: summarizeNumeric(tokenRecords, 'totalTokens'),
    latencyMs: summarizeLatency(records),
    policyViolations: {
      instances: policyViolationInstances,
      count: policyViolationCount,
    },
  }
}

function compareRuns(baselineMap, candidateMap, instanceIds, bootstrap) {
  const differences = []
  let newlyResolved = 0
  let regressed = 0
  let bothResolved = 0
  let neitherResolved = 0

  for (const instanceId of instanceIds) {
    const baselineResolved = isResolved(baselineMap.get(instanceId))
    const candidateResolved = isResolved(candidateMap.get(instanceId))
    const difference = Number(candidateResolved) - Number(baselineResolved)
    differences.push(difference)

    if (!baselineResolved && candidateResolved) newlyResolved += 1
    else if (baselineResolved && !candidateResolved) regressed += 1
    else if (baselineResolved && candidateResolved) bothResolved += 1
    else neitherResolved += 1
  }

  return {
    newlyResolved,
    regressed,
    bothResolved,
    neitherResolved,
    netResolved: newlyResolved - regressed,
    deltaResolvedRate: round((newlyResolved - regressed) / instanceIds.length),
    pairedDeltaCi: bootstrapPairedDelta(differences, bootstrap),
  }
}

function compareOptionalTotals(baselineMetric, candidateMetric) {
  if (baselineMetric.total === null || candidateMetric.total === null) {
    return { absolute: null, relative: null }
  }
  const absolute = candidateMetric.total - baselineMetric.total
  let relative = null
  if (baselineMetric.total === 0) relative = candidateMetric.total === 0 ? 0 : null
  else relative = absolute / baselineMetric.total
  return { absolute: round(absolute), relative: round(relative) }
}

function gate(id, passed, actual, operator, expected, reason) {
  return { id, passed, actual, operator, expected, reason }
}

function applyPolicy(partitionReport, policy, evolutionLedger) {
  const gates = []
  const minimumRecords = policy.gates.coverage.minimumRecords
  const minimumCompletion = policy.gates.coverage.minimumCompletion
  gates.push(
    gate(
      'baseline-record-coverage',
      partitionReport.baseline.coverageRate >= minimumRecords,
      partitionReport.baseline.coverageRate,
      '>=',
      minimumRecords,
      'Baseline 结果记录必须覆盖决策 Partition',
    ),
    gate(
      'candidate-record-coverage',
      partitionReport.candidate.coverageRate >= minimumRecords,
      partitionReport.candidate.coverageRate,
      '>=',
      minimumRecords,
      'Candidate 结果记录必须覆盖决策 Partition',
    ),
    gate(
      'baseline-completion',
      partitionReport.baseline.completionRate >= minimumCompletion,
      partitionReport.baseline.completionRate,
      '>=',
      minimumCompletion,
      'Baseline 必须完成足够比例的决策任务',
    ),
    gate(
      'candidate-completion',
      partitionReport.candidate.completionRate >= minimumCompletion,
      partitionReport.candidate.completionRate,
      '>=',
      minimumCompletion,
      'Candidate 必须完成足够比例的决策任务',
    ),
  )

  const quality = policy.gates.quality
  gates.push(
    gate(
      'minimum-net-resolved',
      partitionReport.paired.netResolved >= quality.minimumNetResolved,
      partitionReport.paired.netResolved,
      '>=',
      quality.minimumNetResolved,
      '新解决数量减去回退数量必须达到阈值',
    ),
    gate(
      'minimum-delta-resolved-rate',
      partitionReport.paired.deltaResolvedRate >= quality.minimumDeltaResolvedRate,
      partitionReport.paired.deltaResolvedRate,
      '>=',
      quality.minimumDeltaResolvedRate,
      '配对解决率提升必须达到阈值',
    ),
  )

  if (quality.maximumRegressions !== null) {
    gates.push(
      gate(
        'maximum-regressions',
        partitionReport.paired.regressed <= quality.maximumRegressions,
        partitionReport.paired.regressed,
        '<=',
        quality.maximumRegressions,
        'Baseline 已解决但 Candidate 回退的任务不能超过阈值',
      ),
    )
  }

  if (quality.requirePositivePairedCiLowerBound) {
    const lowerBound = partitionReport.paired.pairedDeltaCi?.lower ?? null
    gates.push(
      gate(
        'positive-paired-ci-lower-bound',
        lowerBound !== null && lowerBound > 0,
        lowerBound,
        '>',
        0,
        '配对 Bootstrap 区间下界必须大于零',
      ),
    )
  }

  const maximumRelativeCost = policy.gates.cost.maximumRelativeInferenceCostIncrease
  if (maximumRelativeCost !== null) {
    const relativeCost = partitionReport.deltas.costUsd.relative
    gates.push(
      gate(
        'maximum-relative-inference-cost-increase',
        relativeCost !== null && relativeCost <= maximumRelativeCost,
        relativeCost,
        '<=',
        maximumRelativeCost,
        'Candidate 推理成本涨幅必须可计算且不超过阈值',
      ),
    )
  }

  const maximumEvolutionCost = policy.gates.cost.maximumEvolutionCostUsd
  if (maximumEvolutionCost !== null) {
    gates.push(
      gate(
        'maximum-evolution-cost',
        evolutionLedger !== null && evolutionLedger.costUsd <= maximumEvolutionCost,
        evolutionLedger?.costUsd ?? null,
        '<=',
        maximumEvolutionCost,
        '总进化成本必须提供且不超过预算',
      ),
    )
  }

  const maximumPolicyViolations = policy.gates.safety.maximumPolicyViolations
  gates.push(
    gate(
      'maximum-policy-violations',
      partitionReport.candidate.policyViolations.count <= maximumPolicyViolations,
      partitionReport.candidate.policyViolations.count,
      '<=',
      maximumPolicyViolations,
      'Candidate 的权限或协议违规不能超过阈值',
    ),
  )

  return {
    mode: 'promotion',
    partition: policy.decisionPartition,
    eligible: gates.every((item) => item.passed),
    gates,
  }
}

function buildRsiMetrics(partitions, evolutionLedger) {
  const gains = Object.fromEntries(
    Object.entries(partitions).map(([name, report]) => [name, report.paired.deltaResolvedRate]),
  )
  const feedbackGain = gains.feedback
  const finalGain = gains.final
  const finalNetResolved = partitions.final?.paired.netResolved
  return {
    gainByPartition: gains,
    generalizationGap:
      feedbackGain !== undefined && finalGain !== undefined ? round(feedbackGain - finalGain) : null,
    evolution: evolutionLedger,
    finalNetResolvedPer100Usd:
      evolutionLedger?.costUsd > 0 && finalNetResolved !== undefined
        ? round((finalNetResolved / evolutionLedger.costUsd) * 100)
        : null,
  }
}

export function evaluateBenchmark({
  benchmark,
  policy,
  run,
  baselineRecords,
  candidateRecords,
  partitions,
  evolutionLedger = null,
  allowSealed = false,
}) {
  if (!run?.id || !run?.baselineRevision || !run?.candidateRevision) {
    throw new ProtocolError('Evaluation Report 必须记录 Run、Baseline Revision 与 Candidate Revision')
  }
  if (!allowSealed) {
    const sealedIds = new Set(benchmark.partitions.final.instanceIds)
    const leakedIds = new Set(
      [...baselineRecords.keys(), ...candidateRecords.keys()].filter((instanceId) => sealedIds.has(instanceId)),
    )
    if (leakedIds.size > 0) {
      throw new ProtocolError('未解锁的结果文件包含 sealed Final Instance', [
        `检测到 ${leakedIds.size} 个 Final Instance；请使用独立的进化期结果文件`,
      ])
    }
  }
  const partitionReports = {}

  for (const partitionName of partitions) {
    if (!benchmark.partitions[partitionName]) throw new ProtocolError(`未知 Benchmark Partition：${partitionName}`)
    if (benchmark.partitions[partitionName].visibility === 'sealed' && !allowSealed) {
      throw new ProtocolError(`Partition ${partitionName} 是 sealed，必须显式允许最终评测`)
    }
    const instanceIds = benchmark.partitions[partitionName].instanceIds
    const baseline = summarizeRun(baselineRecords, instanceIds)
    const candidate = summarizeRun(candidateRecords, instanceIds)
    const paired = compareRuns(baselineRecords, candidateRecords, instanceIds, policy.bootstrap)
    partitionReports[partitionName] = {
      visibility: benchmark.partitions[partitionName].visibility,
      baseline,
      candidate,
      paired,
      deltas: {
        costUsd: compareOptionalTotals(baseline.costUsd, candidate.costUsd),
        tokens: compareOptionalTotals(baseline.tokens, candidate.tokens),
        latencyMs: compareOptionalTotals(baseline.latencyMs, candidate.latencyMs),
      },
    }
  }

  const decision = partitionReports[policy.decisionPartition]
    ? applyPolicy(partitionReports[policy.decisionPartition], policy, evolutionLedger)
    : {
        mode: 'report-only',
        partition: policy.decisionPartition,
        eligible: null,
        gates: [],
      }

  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvaluationReport',
    metadata: {
      runId: run.id,
      benchmarkId: benchmark.id,
      policyId: policy.id,
      baselineRevision: run.baselineRevision,
      candidateRevision: run.candidateRevision,
    },
    source: benchmark.source,
    requestedPartitions: [...partitions],
    partitions: partitionReports,
    rsiMetrics: buildRsiMetrics(partitionReports, evolutionLedger),
    decision,
  }
}
