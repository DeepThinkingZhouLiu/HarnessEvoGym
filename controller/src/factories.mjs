import { SkillsBenchEnvironment } from './environments/skillsbench.mjs'
import { diffModelUsage } from './cowork-model-gateway.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  ensureDshRuntime,
  runDshSolver,
  runDshUpdater,
  stageUpdaterContext,
} from './runtimes/dsh.mjs'

const DRIVER_PROTOCOL = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+$/u
const ENVIRONMENT_FACTORIES = new Map()
const SOLVER_FACTORIES = new Map()
const UPDATER_FACTORIES = new Map()

function registerFactory(registry, kind, protocol, factory) {
  if (typeof protocol !== 'string' || !DRIVER_PROTOCOL.test(protocol)) {
    throw new ProtocolError(`${kind} Driver Protocol 必须是带版本的 kebab-case`)
  }
  if (typeof factory !== 'function') throw new ProtocolError(`${kind} Driver Factory 必须是函数`)
  if (registry.has(protocol)) throw new ProtocolError(`${kind} Driver Protocol 重复注册：${protocol}`)
  registry.set(protocol, factory)
}

function createRegistered(registry, kind, protocol, options, methods) {
  const factory = registry.get(protocol)
  if (!factory) throw new ProtocolError(`未实现的 ${kind} Protocol：${protocol}`)
  const driver = factory(options)
  if (!driver || typeof driver !== 'object') throw new ProtocolError(`${kind} Driver Factory 返回值无效`)
  for (const method of methods) {
    if (typeof driver[method] !== 'function') throw new ProtocolError(`${kind} Driver 缺少 ${method}()`)
  }
  return driver
}

export function registerEnvironmentDriver(protocol, factory) {
  registerFactory(ENVIRONMENT_FACTORIES, 'Environment', protocol, factory)
}

export function registerSolverDriver(protocol, factory) {
  registerFactory(SOLVER_FACTORIES, 'Solver', protocol, factory)
}

export function registerUpdaterDriver(protocol, factory) {
  registerFactory(UPDATER_FACTORIES, 'Updater', protocol, factory)
}

export function registeredDriverProtocols() {
  return Object.freeze({
    environment: Object.freeze([...ENVIRONMENT_FACTORIES.keys()].sort()),
    solver: Object.freeze([...SOLVER_FACTORIES.keys()].sort()),
    updater: Object.freeze([...UPDATER_FACTORIES.keys()].sort()),
  })
}

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
  return createRegistered(
    ENVIRONMENT_FACTORIES,
    'Environment',
    options.environment.protocol,
    options,
    ['preflight', 'runCandidatePartition'],
  )
}

function createDshSolverDriver({ target, provider, docker, repositoryRoot, sourceRevision, sourcePath, modelGateway = null }) {
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
        await runDshSolver({ docker, runtime: target.solver.runtime, provider, modelAccess, ...options }))
    },
    usage() {
      return publicUsage(measuredUsage)
    },
  }
}

function createDshUpdaterDriver({ updater, provider, docker, repositoryRoot, sourceRevision, sourcePath, modelGateway = null }) {
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
        await runDshUpdater({ docker, runtime: updater.runtime, provider, modelAccess, ...options }))
    },
    usage() {
      return publicUsage(measuredUsage)
    },
  }
}

registerEnvironmentDriver('skillsbench-docker-v1', (options) => new SkillsBenchEnvironment(options))
registerSolverDriver('dsh-headless-docker-v1', createDshSolverDriver)
registerUpdaterDriver('dsh-headless-docker-v1', createDshUpdaterDriver)

export function createSolverDriver(options) {
  const protocol = options.target.solver.protocol === 'dsh-headless-docker'
    ? 'dsh-headless-docker-v1'
    : options.target.solver.protocol
  return createRegistered(SOLVER_FACTORIES, 'Solver', protocol, options, ['ensureRuntime', 'run', 'usage'])
}

export function createUpdaterDriver(options) {
  const protocol = options.updater.protocol === 'dsh-headless-docker'
    ? 'dsh-headless-docker-v1'
    : options.updater.protocol
  return createRegistered(UPDATER_FACTORIES, 'Updater', protocol, options, [
    'ensureRuntime',
    'stageContext',
    'run',
    'usage',
  ])
}
