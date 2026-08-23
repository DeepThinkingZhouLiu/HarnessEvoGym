import { SkillsBenchEnvironment } from './environments/skillsbench.mjs'
import { diffModelUsage } from './model-gateway.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  ensureDshRuntime,
  runDshSolver,
  runDshUpdater,
  stageUpdaterContext,
} from './runtimes/dsh.mjs'

const ENVIRONMENT_FACTORIES = new Map([
  ['skillsbench-docker-v1', (options) => new SkillsBenchEnvironment(options)],
])

function usageAccumulator() {
  return {
    complete: true,
    acceptedRequests: 0,
    usageResponses: 0,
    unknownUsageResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

function addUsage(accumulator, usage) {
  accumulator.complete &&= usage.complete
  for (const field of [
    'acceptedRequests',
    'usageResponses',
    'unknownUsageResponses',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'reasoningTokens',
  ]) {
    accumulator[field] += usage[field]
  }
}

function publicUsage(accumulator) {
  return {
    complete: accumulator.complete,
    requests: accumulator.acceptedRequests,
    usageResponses: accumulator.usageResponses,
    unknownUsageResponses: accumulator.unknownUsageResponses,
    inputTokens: accumulator.complete ? accumulator.inputTokens : null,
    outputTokens: accumulator.complete ? accumulator.outputTokens : null,
    totalTokens: accumulator.complete ? accumulator.inputTokens + accumulator.outputTokens : null,
    observedInputTokens: accumulator.inputTokens,
    observedOutputTokens: accumulator.outputTokens,
    cacheReadTokens: accumulator.complete ? accumulator.cacheReadTokens : null,
    reasoningTokens: accumulator.complete ? accumulator.reasoningTokens : null,
  }
}

async function runWithUsage(modelGateway, accumulator, operation) {
  const before = await modelGateway.usage()
  let result
  let operationError
  try {
    result = await operation()
  } catch (error) {
    operationError = error
  }

  let usage
  try {
    usage = diffModelUsage(before, await modelGateway.usage())
    addUsage(accumulator, usage)
  } catch (error) {
    accumulator.complete = false
    if (!operationError) throw error
    operationError.details = [...(operationError.details ?? []), `Usage 计量失败：${error.message}`]
  }
  if (operationError) {
    if (usage) operationError.modelUsage = usage
    throw operationError
  }
  return { ...result, modelUsage: usage }
}

/**
 * 把 Environment Adapter 的协议名解析为运行时实现。
 * 新 Benchmark 只需在这里注册新 Driver，编排器不感知其任务目录和评分细节。
 */
export function createEnvironmentRunner(options) {
  const factory = ENVIRONMENT_FACTORIES.get(options.environment.protocol)
  if (!factory) throw new ProtocolError(`未实现的 Environment Protocol：${options.environment.protocol}`)
  return factory(options)
}

export function createSolverDriver({ target, docker, repositoryRoot, sourceRevision, sourcePath, modelGateway = null }) {
  if (target.solver.protocol !== 'dsh-headless-docker') {
    throw new ProtocolError(`未实现的 Solver Protocol：${target.solver.protocol}`)
  }
  const measuredUsage = usageAccumulator()
  return {
    id: target.solver.protocol,
    cacheKey: sourceRevision.slice(0, 12),
    async ensureRuntime({ baseImage, baseImageIdentity, tag }) {
      return await ensureDshRuntime({
        docker,
        runtime: target.solver.runtime,
        repositoryRoot,
        sourceRevision,
        sourcePath,
        baseImage,
        baseImageIdentity,
        tag,
      })
    },
    async run(options) {
      if (!modelGateway) throw new ProtocolError('Solver 运行必须使用隔离 Model Gateway')
      const modelAccess = await modelGateway.access()
      return await runWithUsage(modelGateway, measuredUsage, async () =>
        await runDshSolver({ docker, runtime: target.solver.runtime, modelAccess, ...options }))
    },
    usage() {
      return publicUsage(measuredUsage)
    },
  }
}

export function createUpdaterDriver({ updater, docker, repositoryRoot, sourceRevision, sourcePath, modelGateway = null }) {
  if (updater.protocol !== 'dsh-headless-docker') {
    throw new ProtocolError(`未实现的 Updater Protocol：${updater.protocol}`)
  }
  const measuredUsage = usageAccumulator()
  return {
    id: updater.protocol,
    async ensureRuntime({ tag = updater.runtime.image } = {}) {
      return await ensureDshRuntime({
        docker,
        runtime: updater.runtime,
        repositoryRoot,
        sourceRevision,
        sourcePath,
        tag,
      })
    },
    async stageContext(options) {
      return await stageUpdaterContext(options)
    },
    async run(options) {
      if (!modelGateway) throw new ProtocolError('Updater 运行必须使用隔离 Model Gateway')
      const modelAccess = await modelGateway.access()
      return await runWithUsage(modelGateway, measuredUsage, async () =>
        await runDshUpdater({ docker, runtime: updater.runtime, modelAccess, ...options }))
    },
    usage() {
      return publicUsage(measuredUsage)
    },
  }
}
