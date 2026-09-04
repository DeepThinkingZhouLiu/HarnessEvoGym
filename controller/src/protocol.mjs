import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const API_VERSION = 'harness-rsi/v1alpha1'
const PARTITION_NAMES = ['feedback', 'selection', 'final']
const PARTITION_VISIBILITY = {
  feedback: 'detailed',
  selection: 'aggregate-only',
  final: 'sealed',
}
const RESULT_STATUSES = new Set([
  'resolved',
  'unresolved',
  'error',
  'timeout',
  'not_attempted',
])
const MOVING_REVISIONS = new Set(['head', 'latest', 'main', 'master'])

export class ProtocolError extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'ProtocolError'
    this.details = details
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function pushRequiredText(errors, value, path) {
  if (!hasText(value)) errors.push(`${path} 必须是非空字符串`)
}

function pushNumber(errors, value, path, options = {}) {
  const { integer = false, min = -Infinity, max = Infinity, nullable = false } = options
  if (nullable && value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path} 必须是有限数字${nullable ? '或 null' : ''}`)
    return
  }
  if (integer && !Number.isInteger(value)) errors.push(`${path} 必须是整数`)
  if (value < min || value > max) errors.push(`${path} 必须位于 ${min} 到 ${max} 之间`)
}

function pushBoolean(errors, value, path) {
  if (typeof value !== 'boolean') errors.push(`${path} 必须是布尔值`)
}

function throwIfErrors(message, errors) {
  if (errors.length > 0) throw new ProtocolError(message, errors)
}

async function assertRegularInputFile(filePath, label) {
  let info
  try {
    info = await lstat(filePath)
  } catch (error) {
    throw new ProtocolError(`无法访问${label}：${filePath}`, [error.message])
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ProtocolError(`${label}必须是普通文件：${filePath}`)
  }
}

export async function readJsonFile(filePath) {
  await assertRegularInputFile(filePath, 'JSON 文件')
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new ProtocolError(`无法读取 JSON 文件：${filePath}`, [error.message])
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ProtocolError(`JSON 格式错误：${filePath}`, [error.message])
  }
}

export async function readResultFile(filePath) {
  await assertRegularInputFile(filePath, '结果文件')
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new ProtocolError(`无法读取结果文件：${filePath}`, [error.message])
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  if (trimmed.startsWith('[')) {
    let value
    try {
      value = JSON.parse(trimmed)
    } catch (error) {
      throw new ProtocolError(`结果 JSON 格式错误：${filePath}`, [error.message])
    }
    if (!Array.isArray(value)) throw new ProtocolError(`结果文件必须是 JSON 数组或 JSONL：${filePath}`)
    return value
  }

  return trimmed.split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new ProtocolError(`结果 JSONL 第 ${index + 1} 行格式错误：${filePath}`, [error.message])
    }
  })
}

export async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, filePath)
}

export function validateBenchmark(input) {
  const errors = []
  if (!isObject(input)) throw new ProtocolError('Benchmark 配置必须是 JSON 对象')

  if (input.apiVersion !== API_VERSION) errors.push(`apiVersion 必须是 ${API_VERSION}`)
  if (input.kind !== 'Benchmark') errors.push('kind 必须是 Benchmark')

  const metadata = isObject(input.metadata) ? input.metadata : {}
  pushRequiredText(errors, metadata.id, 'metadata.id')
  pushRequiredText(errors, metadata.name, 'metadata.name')

  const spec = isObject(input.spec) ? input.spec : {}
  const source = isObject(spec.source) ? spec.source : {}
  pushRequiredText(errors, source.adapter, 'spec.source.adapter')
  pushRequiredText(errors, source.dataset, 'spec.source.dataset')
  pushRequiredText(errors, source.split, 'spec.source.split')
  pushRequiredText(errors, source.revision, 'spec.source.revision')
  if (hasText(source.revision) && MOVING_REVISIONS.has(source.revision.toLowerCase())) {
    errors.push('spec.source.revision 必须固定到不可变版本，不能使用 main/master/HEAD/latest')
  }

  const evaluator = isObject(spec.evaluator) ? spec.evaluator : {}
  pushRequiredText(errors, evaluator.adapter, 'spec.evaluator.adapter')
  if (!['harness-rsi/solver-result-jsonl-v1', 'harness-rsi/solver-result-jsonl-v2'].includes(evaluator.resultFormat)) {
    errors.push('spec.evaluator.resultFormat 必须是 harness-rsi/solver-result-jsonl-v1 或 v2')
  }

  const partitionsInput = isObject(spec.partitions) ? spec.partitions : {}
  const partitions = {}
  const allInstanceIds = new Set()

  for (const partitionName of Object.keys(partitionsInput)) {
    if (!PARTITION_NAMES.includes(partitionName)) {
      errors.push(`spec.partitions.${partitionName} 不是受支持的 Partition`)
    }
  }

  for (const partitionName of PARTITION_NAMES) {
    const partitionPath = `spec.partitions.${partitionName}`
    const omittedOptionalSelection = partitionName === 'selection'
      && partitionsInput[partitionName] === undefined
    const partition = omittedOptionalSelection
      ? { visibility: PARTITION_VISIBILITY.selection, instanceIds: [] }
      : isObject(partitionsInput[partitionName]) ? partitionsInput[partitionName] : {}
    if (partition.visibility !== PARTITION_VISIBILITY[partitionName]) {
      errors.push(`${partitionPath}.visibility 必须是 ${PARTITION_VISIBILITY[partitionName]}`)
    }

    const instanceIds = partition.instanceIds
    if (!Array.isArray(instanceIds)
        || (instanceIds.length === 0 && partitionName !== 'selection')) {
      errors.push(`${partitionPath}.instanceIds 必须是${partitionName === 'selection' ? '' : '非空'}数组`)
      partitions[partitionName] = { visibility: partition.visibility, instanceIds: [] }
      continue
    }

    const localIds = new Set()
    for (const [index, instanceId] of instanceIds.entries()) {
      const instancePath = `${partitionPath}.instanceIds[${index}]`
      if (!hasText(instanceId)) {
        errors.push(`${instancePath} 必须是非空字符串`)
        continue
      }
      if (localIds.has(instanceId)) errors.push(`${instancePath} 在当前 Partition 中重复`)
      if (allInstanceIds.has(instanceId)) errors.push(`${instancePath} 跨 Partition 重复`)
      localIds.add(instanceId)
      allInstanceIds.add(instanceId)
    }

    if (partition.expectedCount !== undefined) {
      pushNumber(errors, partition.expectedCount, `${partitionPath}.expectedCount`, {
        integer: true,
        min: partitionName === 'selection' ? 0 : 1,
      })
      if (Number.isInteger(partition.expectedCount) && partition.expectedCount !== instanceIds.length) {
        errors.push(`${partitionPath}.expectedCount 与 instanceIds 数量不一致`)
      }
    }

    partitions[partitionName] = {
      visibility: partition.visibility,
      instanceIds: [...instanceIds],
    }
  }

  pushNumber(errors, spec.expectedTotal, 'spec.expectedTotal', { integer: true, min: 2 })
  if (Number.isInteger(spec.expectedTotal) && spec.expectedTotal !== allInstanceIds.size) {
    errors.push(`spec.expectedTotal=${spec.expectedTotal}，但实际唯一 Instance 数量是 ${allInstanceIds.size}`)
  }

  throwIfErrors('Benchmark 配置校验失败', errors)
  return {
    id: metadata.id,
    name: metadata.name,
    source: {
      adapter: source.adapter,
      dataset: source.dataset,
      split: source.split,
      revision: source.revision,
    },
    evaluator: {
      adapter: evaluator.adapter,
      resultFormat: evaluator.resultFormat,
    },
    expectedTotal: spec.expectedTotal,
    partitions,
    allInstanceIds,
    partitionByInstance: new Map(
      Object.entries(partitions).flatMap(([name, partition]) =>
        partition.instanceIds.map((instanceId) => [instanceId, name]),
      ),
    ),
  }
}

export function validateEvaluationPolicy(input) {
  const errors = []
  if (!isObject(input)) throw new ProtocolError('Evaluation Policy 必须是 JSON 对象')

  if (input.apiVersion !== API_VERSION) errors.push(`apiVersion 必须是 ${API_VERSION}`)
  if (input.kind !== 'EvaluationPolicy') errors.push('kind 必须是 EvaluationPolicy')

  const metadata = isObject(input.metadata) ? input.metadata : {}
  pushRequiredText(errors, metadata.id, 'metadata.id')

  const spec = isObject(input.spec) ? input.spec : {}
  if (!['feedback', 'selection'].includes(spec.decisionPartition)) {
    errors.push('spec.decisionPartition 必须是 feedback 或 selection；final 只能用于最终报告')
  }
  const primaryMetric = spec.primaryMetric ?? 'resolved-rate'
  if (!['resolved-rate', 'mean-reward'].includes(primaryMetric)) {
    errors.push('spec.primaryMetric 必须是 resolved-rate 或 mean-reward')
  }

  const bootstrap = isObject(spec.bootstrap) ? spec.bootstrap : {}
  pushNumber(errors, bootstrap.samples, 'spec.bootstrap.samples', { integer: true, min: 100, max: 100000 })
  pushNumber(errors, bootstrap.confidence, 'spec.bootstrap.confidence', { min: 0.5, max: 0.999 })
  pushNumber(errors, bootstrap.seed, 'spec.bootstrap.seed', {
    integer: true,
    min: 0,
    max: 0xffffffff,
  })

  const gates = isObject(spec.gates) ? spec.gates : {}
  const coverage = isObject(gates.coverage) ? gates.coverage : {}
  pushNumber(errors, coverage.minimumRecords, 'spec.gates.coverage.minimumRecords', { min: 0, max: 1 })
  pushNumber(errors, coverage.minimumCompletion, 'spec.gates.coverage.minimumCompletion', { min: 0, max: 1 })

  const quality = isObject(gates.quality) ? gates.quality : {}
  pushNumber(errors, quality.minimumNetResolved, 'spec.gates.quality.minimumNetResolved', {
    integer: true,
    min: 0,
  })
  pushNumber(errors, quality.minimumDeltaResolvedRate, 'spec.gates.quality.minimumDeltaResolvedRate', {
    min: -1,
    max: 1,
  })
  pushNumber(errors, quality.maximumRegressions, 'spec.gates.quality.maximumRegressions', {
    integer: true,
    min: 0,
    nullable: true,
  })
  pushBoolean(errors, quality.requirePositivePairedCiLowerBound, 'spec.gates.quality.requirePositivePairedCiLowerBound')
  const minimumMeanRewardDelta = quality.minimumMeanRewardDelta ?? null
  const minimumRewardImproved = quality.minimumRewardImproved ?? 0
  const maximumRewardRegressions = quality.maximumRewardRegressions ?? null
  const requirePositiveRewardCiLowerBound = quality.requirePositiveRewardCiLowerBound ?? false
  pushNumber(errors, minimumMeanRewardDelta, 'spec.gates.quality.minimumMeanRewardDelta', {
    min: -1,
    max: 1,
    nullable: true,
  })
  pushNumber(errors, minimumRewardImproved, 'spec.gates.quality.minimumRewardImproved', {
    integer: true,
    min: 0,
  })
  pushNumber(errors, maximumRewardRegressions, 'spec.gates.quality.maximumRewardRegressions', {
    integer: true,
    min: 0,
    nullable: true,
  })
  pushBoolean(errors, requirePositiveRewardCiLowerBound, 'spec.gates.quality.requirePositiveRewardCiLowerBound')

  const cost = isObject(gates.cost) ? gates.cost : {}
  pushNumber(errors, cost.maximumRelativeInferenceCostIncrease, 'spec.gates.cost.maximumRelativeInferenceCostIncrease', {
    min: 0,
    nullable: true,
  })
  pushNumber(errors, cost.maximumEvolutionCostUsd, 'spec.gates.cost.maximumEvolutionCostUsd', {
    min: 0,
    nullable: true,
  })

  const performance = isObject(gates.performance) ? gates.performance : {}
  const maximumRelativeLatencyIncrease = performance.maximumRelativeLatencyIncrease ?? null
  const maximumRelativeTokenIncrease = performance.maximumRelativeTokenIncrease ?? null
  pushNumber(
    errors,
    maximumRelativeLatencyIncrease,
    'spec.gates.performance.maximumRelativeLatencyIncrease',
    { min: 0, nullable: true },
  )
  pushNumber(
    errors,
    maximumRelativeTokenIncrease,
    'spec.gates.performance.maximumRelativeTokenIncrease',
    { min: 0, nullable: true },
  )

  const safety = isObject(gates.safety) ? gates.safety : {}
  pushNumber(errors, safety.maximumPolicyViolations, 'spec.gates.safety.maximumPolicyViolations', {
    integer: true,
    min: 0,
  })

  throwIfErrors('Evaluation Policy 校验失败', errors)
  return {
    id: metadata.id,
    decisionPartition: spec.decisionPartition,
    primaryMetric,
    bootstrap: {
      samples: bootstrap.samples,
      confidence: bootstrap.confidence,
      seed: bootstrap.seed,
    },
    gates: {
      coverage: {
        minimumRecords: coverage.minimumRecords,
        minimumCompletion: coverage.minimumCompletion,
      },
      quality: {
        minimumNetResolved: quality.minimumNetResolved,
        minimumDeltaResolvedRate: quality.minimumDeltaResolvedRate,
        maximumRegressions: quality.maximumRegressions,
        requirePositivePairedCiLowerBound: quality.requirePositivePairedCiLowerBound,
        minimumMeanRewardDelta,
        minimumRewardImproved,
        maximumRewardRegressions,
        requirePositiveRewardCiLowerBound,
      },
      cost: {
        maximumRelativeInferenceCostIncrease: cost.maximumRelativeInferenceCostIncrease,
        maximumEvolutionCostUsd: cost.maximumEvolutionCostUsd,
      },
      performance: { maximumRelativeLatencyIncrease, maximumRelativeTokenIncrease },
      safety: { maximumPolicyViolations: safety.maximumPolicyViolations },
    },
  }
}

export function validateResultRecords(input, benchmark, label) {
  const errors = []
  if (!Array.isArray(input)) throw new ProtocolError(`${label} 结果必须是数组或 JSONL`)

  const records = new Map()
  for (const [index, rawRecord] of input.entries()) {
    const path = `${label}[${index}]`
    if (!isObject(rawRecord)) {
      errors.push(`${path} 必须是对象`)
      continue
    }

    pushRequiredText(errors, rawRecord.instance_id, `${path}.instance_id`)
    if (!RESULT_STATUSES.has(rawRecord.status)) {
      errors.push(`${path}.status 必须是 ${[...RESULT_STATUSES].join('、')} 之一`)
    }
    if (hasText(rawRecord.instance_id) && !benchmark.allInstanceIds.has(rawRecord.instance_id)) {
      errors.push(`${path}.instance_id 不属于当前 Benchmark`)
    }
    if (hasText(rawRecord.instance_id) && records.has(rawRecord.instance_id)) {
      errors.push(`${path}.instance_id 在结果文件中重复`)
    }

    const defaultReward = rawRecord.status === 'resolved' ? 1 : 0
    const reward = rawRecord.reward ?? defaultReward
    pushNumber(errors, reward, `${path}.reward`, { min: 0, max: 1 })

    let trialRewards = rawRecord.trial_rewards
    if (trialRewards === undefined) trialRewards = [reward]
    if (!Array.isArray(trialRewards) || trialRewards.length === 0) {
      errors.push(`${path}.trial_rewards 必须是非空数字数组`)
      trialRewards = []
    } else {
      trialRewards.forEach((value, trialIndex) =>
        pushNumber(errors, value, `${path}.trial_rewards[${trialIndex}]`, { min: 0, max: 1 }),
      )
      if (typeof reward === 'number' && trialRewards.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        const mean = trialRewards.reduce((sum, value) => sum + value, 0) / trialRewards.length
        if (Math.abs(mean - reward) > 1e-9) errors.push(`${path}.reward 必须等于 trial_rewards 的平均值`)
      }
    }

    let trialSeeds = rawRecord.trial_seeds
    if (trialSeeds === undefined) trialSeeds = []
    if (!Array.isArray(trialSeeds) || trialSeeds.some((value) => !Number.isInteger(value) || value < 0)) {
      errors.push(`${path}.trial_seeds 必须是非负整数数组`)
      trialSeeds = []
    }
    if (trialSeeds.length > 0 && trialSeeds.length !== trialRewards.length) {
      errors.push(`${path}.trial_seeds 与 trial_rewards 长度必须一致`)
    }
    if (rawRecord.seed_controlled !== undefined && typeof rawRecord.seed_controlled !== 'boolean') {
      errors.push(`${path}.seed_controlled 必须是布尔值`)
    }

    const partition = hasText(rawRecord.instance_id)
      ? benchmark.partitionByInstance?.get(rawRecord.instance_id)
      : undefined
    if (rawRecord.feedback !== undefined && partition !== 'feedback') {
      errors.push(`${path}.feedback 只能出现在 feedback Partition`)
    }
    if (rawRecord.feedback !== undefined && !isObject(rawRecord.feedback)) {
      errors.push(`${path}.feedback 必须是对象`)
    }
    if (rawRecord.artifacts !== undefined && !Array.isArray(rawRecord.artifacts)) {
      errors.push(`${path}.artifacts 必须是数组`)
    }

    for (const metricName of ['cost_usd', 'input_tokens', 'output_tokens', 'latency_ms']) {
      if (rawRecord[metricName] !== undefined) {
        pushNumber(errors, rawRecord[metricName], `${path}.${metricName}`, {
          integer: metricName !== 'cost_usd',
          min: 0,
        })
      }
    }

    if (rawRecord.policy_violations !== undefined) {
      if (!Array.isArray(rawRecord.policy_violations) || rawRecord.policy_violations.some((item) => !hasText(item))) {
        errors.push(`${path}.policy_violations 必须是非空字符串数组`)
      }
    }

    if (hasText(rawRecord.instance_id) && !records.has(rawRecord.instance_id)) {
      records.set(rawRecord.instance_id, {
        instanceId: rawRecord.instance_id,
        status: rawRecord.status,
        reward,
        trialRewards,
        trialSeeds,
        seedControlled: rawRecord.seed_controlled ?? null,
        costUsd: rawRecord.cost_usd,
        inputTokens: rawRecord.input_tokens,
        outputTokens: rawRecord.output_tokens,
        latencyMs: rawRecord.latency_ms,
        policyViolations: rawRecord.policy_violations ?? [],
        artifacts: rawRecord.artifacts ?? [],
        feedback: rawRecord.feedback,
      })
    }
  }

  throwIfErrors(`${label} Solver Result 校验失败`, errors)
  return records
}

export function validateEvolutionLedger(input) {
  if (input === null || input === undefined) return null
  const errors = []
  if (!isObject(input)) throw new ProtocolError('Evolution Ledger 必须是 JSON 对象')

  if (input.apiVersion !== API_VERSION) errors.push(`apiVersion 必须是 ${API_VERSION}`)
  if (input.kind !== 'EvolutionLedger') errors.push('kind 必须是 EvolutionLedger')

  const spec = isObject(input.spec) ? input.spec : {}
  pushNumber(errors, spec.generations, 'spec.generations', { integer: true, min: 0 })
  pushNumber(errors, spec.candidatesEvaluated, 'spec.candidatesEvaluated', { integer: true, min: 0 })
  pushNumber(errors, spec.updaterTokens, 'spec.updaterTokens', { integer: true, min: 0, nullable: true })
  pushNumber(errors, spec.solverTokens, 'spec.solverTokens', { integer: true, min: 0, nullable: true })
  pushNumber(errors, spec.costUsd, 'spec.costUsd', { min: 0, nullable: true })
  pushNumber(errors, spec.wallTimeMs, 'spec.wallTimeMs', { integer: true, min: 0 })

  throwIfErrors('Evolution Ledger 校验失败', errors)
  return {
    generations: spec.generations,
    candidatesEvaluated: spec.candidatesEvaluated,
    updaterTokens: spec.updaterTokens,
    solverTokens: spec.solverTokens,
    totalTokens:
      typeof spec.updaterTokens === 'number' && typeof spec.solverTokens === 'number'
        ? spec.updaterTokens + spec.solverTokens
        : null,
    costUsd: spec.costUsd,
    wallTimeMs: spec.wallTimeMs,
  }
}

export { PARTITION_NAMES }
