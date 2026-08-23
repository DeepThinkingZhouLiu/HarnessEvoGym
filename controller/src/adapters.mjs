import {
  API_VERSION,
  assertApiObject,
  assertPathKind,
  expectBoolean,
  expectNumber,
  expectObject,
  expectStringArray,
  expectText,
  hasText,
  isObject,
  readConfigFile,
  resolveInside,
} from './config.mjs'
import { posix } from 'node:path'
import { normalizeRelativePath } from './path-policy.mjs'
import { ProtocolError, readJsonFile, validateBenchmark, validateEvaluationPolicy } from './protocol.mjs'

const MUTATION_LEVELS = ['l1', 'l2', 'l3']
const FULL_GIT_SHA = /^[0-9a-f]{40}$/u

function metadataId(input, label) {
  return expectText(expectObject(input.metadata, `${label}.metadata`).id, `${label}.metadata.id`)
}

function relativePath(value, label) {
  return normalizeRelativePath(expectText(value, label), label)
}

function validateRuntime(raw, label) {
  const runtime = expectObject(raw, label)
  const secretEnvironment = expectStringArray(runtime.secretEnvironment, `${label}.secretEnvironment`)
  for (const name of secretEnvironment) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new ProtocolError(`${label}.secretEnvironment 包含非法名称：${name}`)
  }
  return {
    image: expectText(runtime.image, `${label}.image`),
    dockerfile: relativePath(runtime.dockerfile, `${label}.dockerfile`),
    package: expectText(runtime.package, `${label}.package`),
    version: expectText(runtime.version, `${label}.version`),
    profile: expectText(runtime.profile, `${label}.profile`),
    preset: expectText(runtime.preset, `${label}.preset`),
    secretEnvironment,
  }
}

function gitRevision(value, label) {
  const revision = expectText(value, label)
  if (!FULL_GIT_SHA.test(revision)) throw new ProtocolError(`${label} 必须是完整的 40 位小写 Git SHA`)
  return revision
}

function mutationGlobs(value, label) {
  return expectStringArray(value, label).map((pattern, index) => relativePath(pattern, `${label}[${index}]`))
}

function extensions(value, label) {
  const normalized = expectStringArray(value, label).map((extension) => extension.toLowerCase())
  if (normalized.some((extension) => !/^\.[a-z0-9]+$/u.test(extension))) {
    throw new ProtocolError(`${label} 只能包含形如 .md 的小写扩展名`)
  }
  if (new Set(normalized).size !== normalized.length) throw new ProtocolError(`${label} 忽略大小写后不能重复`)
  return normalized
}

export function validateTargetAdapter(input) {
  assertApiObject(input, 'TargetAdapter')
  const id = metadataId(input, 'TargetAdapter')
  const spec = expectObject(input.spec, 'TargetAdapter.spec')
  const source = expectObject(spec.source, 'TargetAdapter.spec.source')
  const materialization = expectObject(spec.materialization, 'TargetAdapter.spec.materialization')
  const solver = expectObject(spec.solver, 'TargetAdapter.spec.solver')
  const mutation = expectObject(spec.mutation, 'TargetAdapter.spec.mutation')
  const alwaysReadOnly = mutationGlobs(mutation.alwaysReadOnly, 'TargetAdapter.spec.mutation.alwaysReadOnly')
  const rawLevels = expectObject(mutation.levels, 'TargetAdapter.spec.mutation.levels')
  const levels = {}

  for (const levelName of Object.keys(rawLevels)) {
    if (!MUTATION_LEVELS.includes(levelName)) throw new ProtocolError(`未知变异层级：${levelName}`)
  }
  for (const levelName of MUTATION_LEVELS) {
    if (!rawLevels[levelName]) continue
    const level = expectObject(rawLevels[levelName], `TargetAdapter.spec.mutation.levels.${levelName}`)
    levels[levelName] = {
      description: expectText(level.description, `TargetAdapter.spec.mutation.levels.${levelName}.description`),
      writable: mutationGlobs(level.writable, `TargetAdapter.spec.mutation.levels.${levelName}.writable`),
      extensions: extensions(level.extensions, `TargetAdapter.spec.mutation.levels.${levelName}.extensions`),
    }
  }
  if (Object.keys(levels).length === 0) throw new ProtocolError('TargetAdapter 至少必须定义一个变异层级')

  const limits = expectObject(mutation.limits, 'TargetAdapter.spec.mutation.limits')
  let semanticChecks = null
  if (mutation.semanticChecks !== undefined) {
    const checks = expectObject(mutation.semanticChecks, 'TargetAdapter.spec.mutation.semanticChecks')
    const cordis = expectObject(checks.cordis, 'TargetAdapter.spec.mutation.semanticChecks.cordis')
    const skills = expectObject(checks.skills, 'TargetAdapter.spec.mutation.semanticChecks.skills')
    const requiredNamePrefix = expectText(
      skills.requiredNamePrefix,
      'TargetAdapter.spec.mutation.semanticChecks.skills.requiredNamePrefix',
    )
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-$/u.test(requiredNamePrefix)) {
      throw new ProtocolError('TargetAdapter.spec.mutation.semanticChecks.skills.requiredNamePrefix 必须是以连字符结尾的 kebab-case 前缀')
    }
    semanticChecks = {
      skills: {
        root: relativePath(skills.root, 'TargetAdapter.spec.mutation.semanticChecks.skills.root'),
        requiredNamePrefix,
      },
      cordis: {
        path: relativePath(cordis.path, 'TargetAdapter.spec.mutation.semanticChecks.cordis.path'),
        allowedPluginNames: expectStringArray(
          cordis.allowedPluginNames,
          'TargetAdapter.spec.mutation.semanticChecks.cordis.allowedPluginNames',
        ),
        allowedJsLines: expectStringArray(
          cordis.allowedJsLines,
          'TargetAdapter.spec.mutation.semanticChecks.cordis.allowedJsLines',
        ),
      },
    }
  }
  const sourceKind = expectText(source.kind, 'TargetAdapter.spec.source.kind')
  if (sourceKind !== 'git-submodule') throw new ProtocolError('当前 TargetAdapter 只支持 git-submodule Source')
  const strategy = expectText(materialization.strategy, 'TargetAdapter.spec.materialization.strategy')
  if (strategy !== 'controller-owned-overlay') {
    throw new ProtocolError('当前安全实现只支持 controller-owned-overlay Materialization')
  }
  const solverProtocol = expectText(solver.protocol, 'TargetAdapter.spec.solver.protocol')
  if (solverProtocol !== 'dsh-headless-docker') throw new ProtocolError('当前只实现 dsh-headless-docker Solver Protocol')
  const resolvedMutationLimits = {
    maximumTreeEntries: expectNumber(limits.maximumTreeEntries, 'mutation.limits.maximumTreeEntries', {
      integer: true,
      min: 1,
    }),
    maximumChangedFiles: expectNumber(limits.maximumChangedFiles, 'mutation.limits.maximumChangedFiles', {
      integer: true,
      min: 1,
    }),
    maximumChangedBytes: expectNumber(limits.maximumChangedBytes, 'mutation.limits.maximumChangedBytes', {
      integer: true,
      min: 1,
    }),
    maximumFileBytes: expectNumber(limits.maximumFileBytes, 'mutation.limits.maximumFileBytes', {
      integer: true,
      min: 1,
    }),
  }
  if (resolvedMutationLimits.maximumChangedFiles > resolvedMutationLimits.maximumTreeEntries) {
    throw new ProtocolError('mutation.limits.maximumChangedFiles 不能大于 maximumTreeEntries')
  }
  return {
    apiVersion: API_VERSION,
    kind: 'TargetAdapter',
    id,
    source: {
      kind: sourceKind,
      path: relativePath(source.path, 'TargetAdapter.spec.source.path'),
      revision: gitRevision(source.revision, 'TargetAdapter.spec.source.revision'),
    },
    materialization: {
      strategy,
      baselinePath: relativePath(materialization.baselinePath, 'TargetAdapter.spec.materialization.baselinePath'),
      runtimeRoot: relativePath(materialization.runtimeRoot, 'TargetAdapter.spec.materialization.runtimeRoot'),
      presetRelativePath: relativePath(
        materialization.presetRelativePath,
        'TargetAdapter.spec.materialization.presetRelativePath',
      ),
    },
    solver: {
      protocol: solverProtocol,
      runtime: validateRuntime(solver.runtime, 'TargetAdapter.spec.solver.runtime'),
    },
    mutation: {
      alwaysReadOnly,
      levels,
      semanticChecks,
      limits: resolvedMutationLimits,
    },
  }
}

export function validateUpdaterAdapter(input) {
  assertApiObject(input, 'UpdaterAdapter')
  const id = metadataId(input, 'UpdaterAdapter')
  const spec = expectObject(input.spec, 'UpdaterAdapter.spec')
  const protocol = expectText(spec.protocol, 'UpdaterAdapter.spec.protocol')
  if (protocol !== 'dsh-headless-docker') {
    throw new ProtocolError(`当前未实现 Updater Protocol：${protocol}`)
  }
  const prompt = expectObject(spec.prompt, 'UpdaterAdapter.spec.prompt')
  const source = expectObject(spec.source, 'UpdaterAdapter.spec.source')
  const sourceKind = expectText(source.kind, 'UpdaterAdapter.spec.source.kind')
  if (sourceKind !== 'git-submodule') throw new ProtocolError('当前 UpdaterAdapter 只支持 git-submodule Source')
  const output = expectObject(spec.output, 'UpdaterAdapter.spec.output')
  const mutationReportName = relativePath(
    expectObject(output.mutationReport, 'UpdaterAdapter.spec.output.mutationReport').name,
    'UpdaterAdapter.spec.output.mutationReport.name',
  )
  if (mutationReportName.includes('/')) throw new ProtocolError('Mutation Report name 必须是单个文件名')
  return {
    apiVersion: API_VERSION,
    kind: 'UpdaterAdapter',
    id,
    protocol,
    source: {
      kind: sourceKind,
      path: relativePath(source.path, 'UpdaterAdapter.spec.source.path'),
      revision: gitRevision(source.revision, 'UpdaterAdapter.spec.source.revision'),
    },
    runtime: validateRuntime(spec.runtime, 'UpdaterAdapter.spec.runtime'),
    promptPath: relativePath(prompt.path, 'UpdaterAdapter.spec.prompt.path'),
    mutationReportName,
  }
}

export function validateEnvironmentAdapter(input) {
  assertApiObject(input, 'EnvironmentAdapter')
  const id = metadataId(input, 'EnvironmentAdapter')
  const spec = expectObject(input.spec, 'EnvironmentAdapter.spec')
  const protocol = expectText(spec.protocol, 'EnvironmentAdapter.spec.protocol')
  if (protocol !== 'skillsbench-docker-v1') {
    throw new ProtocolError(`当前未实现 Environment Protocol：${protocol}`)
  }
  const source = expectObject(spec.source, 'EnvironmentAdapter.spec.source')
  const task = expectObject(spec.task, 'EnvironmentAdapter.spec.task')
  const workspaceLimits = expectObject(task.workspaceLimits, 'EnvironmentAdapter.spec.task.workspaceLimits')
  const docker = expectObject(spec.docker, 'EnvironmentAdapter.spec.docker')
  const resources = expectObject(docker.resources, 'EnvironmentAdapter.spec.docker.resources')
  const modelGateway = expectObject(spec.modelGateway, 'EnvironmentAdapter.spec.modelGateway')
  const gatewayResources = expectObject(
    modelGateway.resources,
    'EnvironmentAdapter.spec.modelGateway.resources',
  )
  const verifier = expectObject(spec.verifier, 'EnvironmentAdapter.spec.verifier')
  const reward = expectObject(spec.reward, 'EnvironmentAdapter.spec.reward')
  const feedback = expectObject(spec.feedback, 'EnvironmentAdapter.spec.feedback')

  const rootEnvironment = expectText(source.rootEnvironment, 'EnvironmentAdapter.spec.source.rootEnvironment')
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(rootEnvironment)) {
    throw new ProtocolError('EnvironmentAdapter.spec.source.rootEnvironment 必须是大写环境变量名')
  }
  const upstreamApiKeyEnvironment = expectText(
    modelGateway.upstreamApiKeyEnvironment,
    'EnvironmentAdapter.spec.modelGateway.upstreamApiKeyEnvironment',
  )
  const upstreamBaseUrlEnvironment = expectText(
    modelGateway.upstreamBaseUrlEnvironment,
    'EnvironmentAdapter.spec.modelGateway.upstreamBaseUrlEnvironment',
  )
  for (const [label, name] of [
    ['upstreamApiKeyEnvironment', upstreamApiKeyEnvironment],
    ['upstreamBaseUrlEnvironment', upstreamBaseUrlEnvironment],
  ]) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      throw new ProtocolError(`EnvironmentAdapter.spec.modelGateway.${label} 必须是大写环境变量名`)
    }
  }
  if (upstreamApiKeyEnvironment === upstreamBaseUrlEnvironment) {
    throw new ProtocolError('Model Gateway 的 API Key 与 Base URL 环境变量不能同名')
  }
  const gatewayAlias = expectText(modelGateway.alias, 'EnvironmentAdapter.spec.modelGateway.alias')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(gatewayAlias)) {
    throw new ProtocolError('EnvironmentAdapter.spec.modelGateway.alias 必须是小写 Docker DNS 名')
  }
  if (gatewayAlias === 'localhost') {
    throw new ProtocolError('EnvironmentAdapter.spec.modelGateway.alias 不能使用 localhost')
  }
  const gatewayEgressNetwork = expectText(
    modelGateway.egressNetwork,
    'EnvironmentAdapter.spec.modelGateway.egressNetwork',
  )
  if (['host', 'none'].includes(gatewayEgressNetwork)) {
    throw new ProtocolError('Model Gateway egressNetwork 不能是 host 或 none')
  }

  const network = expectText(docker.network, 'EnvironmentAdapter.spec.docker.network')
  if (network === 'host') throw new ProtocolError('Solver/Updater Docker 禁止使用 host 网络')
  const verifierNetwork = expectText(verifier.network, 'EnvironmentAdapter.spec.verifier.network')
  if (verifierNetwork === 'host') throw new ProtocolError('Verifier Docker 禁止使用 host 网络')
  const workspacePath = expectText(task.workspacePath, 'EnvironmentAdapter.spec.task.workspacePath')
  if (
    !workspacePath.startsWith('/') ||
    workspacePath === '/' ||
    workspacePath.includes(':') ||
    workspacePath.includes(',') ||
    posix.normalize(workspacePath) !== workspacePath
  ) {
    throw new ProtocolError('EnvironmentAdapter.spec.task.workspacePath 必须是安全的容器绝对路径')
  }
  const reservedWorkspaceRoots = ['/tmp', '/run', '/logs', '/verifier', '/rsi-submission', '/dsh-home', '/benchmark-skills']
  if (reservedWorkspaceRoots.some((root) => workspacePath === root || workspacePath.startsWith(`${root}/`))) {
    throw new ProtocolError(`EnvironmentAdapter.spec.task.workspacePath 与 RSI 保留挂载冲突：${workspacePath}`)
  }
  const rewardMinimum = expectNumber(reward.minimum, 'EnvironmentAdapter.spec.reward.minimum')
  const rewardMaximum = expectNumber(reward.maximum, 'EnvironmentAdapter.spec.reward.maximum')
  const resolvedThreshold = expectNumber(reward.resolvedThreshold, 'EnvironmentAdapter.spec.reward.resolvedThreshold')
  if (rewardMinimum >= rewardMaximum) throw new ProtocolError('Reward minimum 必须小于 maximum')
  if (resolvedThreshold < rewardMinimum || resolvedThreshold > rewardMaximum) {
    throw new ProtocolError('resolvedThreshold 必须位于 Reward 范围内')
  }
  const outputCandidates = expectStringArray(
    verifier.outputCandidates,
    'EnvironmentAdapter.spec.verifier.outputCandidates',
  ).map((value, index) => {
    if (!value.startsWith('/logs/')) {
      throw new ProtocolError(`EnvironmentAdapter.spec.verifier.outputCandidates[${index}] 必须位于 /logs/`)
    }
    return `/logs/${relativePath(value.slice('/logs/'.length), `verifier.outputCandidates[${index}]`)}`
  })
  const resolvedWorkspaceLimits = {
    maximumFiles: expectNumber(workspaceLimits.maximumFiles, 'task.workspaceLimits.maximumFiles', {
      integer: true,
      min: 1,
    }),
    maximumBytes: expectNumber(workspaceLimits.maximumBytes, 'task.workspaceLimits.maximumBytes', {
      integer: true,
      min: 1,
    }),
    maximumFileBytes: expectNumber(workspaceLimits.maximumFileBytes, 'task.workspaceLimits.maximumFileBytes', {
      integer: true,
      min: 1,
    }),
    maximumChangedFiles: expectNumber(
      workspaceLimits.maximumChangedFiles,
      'task.workspaceLimits.maximumChangedFiles',
      { integer: true, min: 1 },
    ),
    maximumChangedBytes: expectNumber(
      workspaceLimits.maximumChangedBytes,
      'task.workspaceLimits.maximumChangedBytes',
      { integer: true, min: 1 },
    ),
  }
  if (resolvedWorkspaceLimits.maximumFileBytes > resolvedWorkspaceLimits.maximumBytes) {
    throw new ProtocolError('maximumFileBytes 不能大于 maximumBytes')
  }
  if (resolvedWorkspaceLimits.maximumChangedFiles > resolvedWorkspaceLimits.maximumFiles) {
    throw new ProtocolError('maximumChangedFiles 不能大于 maximumFiles')
  }
  if (resolvedWorkspaceLimits.maximumChangedBytes > resolvedWorkspaceLimits.maximumBytes) {
    throw new ProtocolError('maximumChangedBytes 不能大于 maximumBytes')
  }

  return {
    apiVersion: API_VERSION,
    kind: 'EnvironmentAdapter',
    id,
    protocol,
    source: {
      rootEnvironment,
      tasksSubdirectory: relativePath(source.tasksSubdirectory, 'EnvironmentAdapter.spec.source.tasksSubdirectory'),
      revision: gitRevision(source.revision, 'EnvironmentAdapter.spec.source.revision'),
    },
    task: {
      instructionCandidates: expectStringArray(task.instructionCandidates, 'EnvironmentAdapter.spec.task.instructionCandidates')
        .map((value) => relativePath(value, 'instructionCandidates')),
      dockerfile: relativePath(task.dockerfile, 'EnvironmentAdapter.spec.task.dockerfile'),
      dockerContext: relativePath(task.dockerContext, 'EnvironmentAdapter.spec.task.dockerContext'),
      skillsDirectory: relativePath(task.skillsDirectory, 'EnvironmentAdapter.spec.task.skillsDirectory'),
      workspacePath,
      workspaceLimits: resolvedWorkspaceLimits,
      verifierCandidates: expectStringArray(task.verifierCandidates, 'EnvironmentAdapter.spec.task.verifierCandidates')
        .map((value) => relativePath(value, 'verifierCandidates')),
    },
    docker: {
      binary: expectText(docker.binary, 'EnvironmentAdapter.spec.docker.binary'),
      network,
      runAsCurrentUser: expectBoolean(docker.runAsCurrentUser, 'EnvironmentAdapter.spec.docker.runAsCurrentUser'),
      resources: {
        cpus: expectNumber(resources.cpus, 'EnvironmentAdapter.spec.docker.resources.cpus', { min: 0.1 }),
        memory: expectText(resources.memory, 'EnvironmentAdapter.spec.docker.resources.memory'),
        pids: expectNumber(resources.pids, 'EnvironmentAdapter.spec.docker.resources.pids', {
          integer: true,
          min: 16,
        }),
        timeoutSeconds: expectNumber(
          resources.timeoutSeconds,
          'EnvironmentAdapter.spec.docker.resources.timeoutSeconds',
          { integer: true, min: 1 },
        ),
      },
    },
    modelGateway: {
      image: expectText(modelGateway.image, 'EnvironmentAdapter.spec.modelGateway.image'),
      dockerfile: relativePath(modelGateway.dockerfile, 'EnvironmentAdapter.spec.modelGateway.dockerfile'),
      alias: gatewayAlias,
      port: expectNumber(modelGateway.port, 'EnvironmentAdapter.spec.modelGateway.port', {
        integer: true,
        min: 1024,
        max: 65535,
      }),
      egressNetwork: gatewayEgressNetwork,
      upstreamApiKeyEnvironment,
      upstreamBaseUrlEnvironment,
      maximumRequestsPerRun: expectNumber(
        modelGateway.maximumRequestsPerRun,
        'EnvironmentAdapter.spec.modelGateway.maximumRequestsPerRun',
        { integer: true, min: 1, max: 100000 },
      ),
      maximumConcurrentRequests: expectNumber(
        modelGateway.maximumConcurrentRequests,
        'EnvironmentAdapter.spec.modelGateway.maximumConcurrentRequests',
        { integer: true, min: 1, max: 64 },
      ),
      resources: {
        cpus: expectNumber(gatewayResources.cpus, 'modelGateway.resources.cpus', { min: 0.1 }),
        memory: expectText(gatewayResources.memory, 'modelGateway.resources.memory'),
        pids: expectNumber(gatewayResources.pids, 'modelGateway.resources.pids', {
          integer: true,
          min: 16,
        }),
      },
    },
    verifier: {
      pythonCommand: expectText(verifier.pythonCommand, 'EnvironmentAdapter.spec.verifier.pythonCommand'),
      shellCommand: expectText(verifier.shellCommand, 'EnvironmentAdapter.spec.verifier.shellCommand'),
      arguments: expectStringArray(verifier.arguments ?? [], 'EnvironmentAdapter.spec.verifier.arguments', { nonEmpty: false }),
      outputCandidates,
      network: verifierNetwork,
      runAsCurrentUser: expectBoolean(
        verifier.runAsCurrentUser,
        'EnvironmentAdapter.spec.verifier.runAsCurrentUser',
      ),
    },
    reward: {
      minimum: rewardMinimum,
      maximum: rewardMaximum,
      resolvedThreshold,
    },
    feedback: {
      maximumTextBytesPerCase: expectNumber(
        feedback.maximumTextBytesPerCase,
        'EnvironmentAdapter.spec.feedback.maximumTextBytesPerCase',
        { integer: true, min: 256 },
      ),
      maximumArtifactEntriesPerCase: expectNumber(
        feedback.maximumArtifactEntriesPerCase,
        'EnvironmentAdapter.spec.feedback.maximumArtifactEntriesPerCase',
        { integer: true, min: 1, max: 10000 },
      ),
      maximumArtifactBytesPerCase: expectNumber(
        feedback.maximumArtifactBytesPerCase,
        'EnvironmentAdapter.spec.feedback.maximumArtifactBytesPerCase',
        { integer: true, min: 1024, max: 1024 * 1024 },
      ),
      maximumHistoryEntries: expectNumber(
        feedback.maximumHistoryEntries,
        'EnvironmentAdapter.spec.feedback.maximumHistoryEntries',
        { integer: true, min: 1, max: 100 },
      ),
      maximumHistoryBytes: expectNumber(
        feedback.maximumHistoryBytes,
        'EnvironmentAdapter.spec.feedback.maximumHistoryBytes',
        { integer: true, min: 1024, max: 1024 * 1024 },
      ),
    },
  }
}

function validateModel(value, label) {
  const model = expectObject(value, label)
  return {
    provider: expectText(model.provider, `${label}.provider`),
    model: expectText(model.model, `${label}.model`),
    maxTokens: expectNumber(model.maxTokens, `${label}.maxTokens`, {
      integer: true,
      min: 1,
      max: 1_000_000,
    }),
  }
}

export function validateExperiment(input) {
  assertApiObject(input, 'EvolutionExperiment')
  const id = metadataId(input, 'EvolutionExperiment')
  const spec = expectObject(input.spec, 'EvolutionExperiment.spec')
  const adapters = expectObject(spec.adapters, 'EvolutionExperiment.spec.adapters')
  const models = expectObject(spec.models, 'EvolutionExperiment.spec.models')
  const evolution = expectObject(spec.evolution, 'EvolutionExperiment.spec.evolution')
  const mutationLevel = expectText(evolution.mutationLevel, 'EvolutionExperiment.spec.evolution.mutationLevel')
  if (!MUTATION_LEVELS.includes(mutationLevel)) throw new ProtocolError(`不支持的 mutationLevel：${mutationLevel}`)
  const seeds = evolution.seeds
  if (!Array.isArray(seeds) || seeds.length === 0) throw new ProtocolError('EvolutionExperiment.spec.evolution.seeds 必须是非空数组')
  seeds.forEach((seed, index) => expectNumber(seed, `seeds[${index}]`, { integer: true, min: 0, max: 0xffffffff }))
  if (new Set(seeds).size !== seeds.length) throw new ProtocolError('EvolutionExperiment.spec.evolution.seeds 不能重复')
  const trialsPerInstance = expectNumber(
    evolution.trialsPerInstance,
    'EvolutionExperiment.spec.evolution.trialsPerInstance',
    { integer: true, min: 1, max: 20 },
  )
  if (seeds.length < trialsPerInstance) throw new ProtocolError('seeds 数量不能少于 trialsPerInstance')
  return {
    apiVersion: API_VERSION,
    kind: 'EvolutionExperiment',
    id,
    adapters: {
      target: relativePath(adapters.target, 'EvolutionExperiment.spec.adapters.target'),
      updater: relativePath(adapters.updater, 'EvolutionExperiment.spec.adapters.updater'),
      environment: relativePath(adapters.environment, 'EvolutionExperiment.spec.adapters.environment'),
    },
    benchmarkPath: relativePath(spec.benchmark, 'EvolutionExperiment.spec.benchmark'),
    policyPath: relativePath(spec.policy, 'EvolutionExperiment.spec.policy'),
    models: {
      solver: validateModel(models.solver, 'EvolutionExperiment.spec.models.solver'),
      updater: validateModel(models.updater, 'EvolutionExperiment.spec.models.updater'),
    },
    evolution: {
      mutationLevel,
      generations: expectNumber(evolution.generations, 'EvolutionExperiment.spec.evolution.generations', {
        integer: true,
        min: 1,
      }),
      trialsPerInstance,
      seeds,
    },
  }
}

export async function loadExperimentBundle(experimentPath, repositoryRoot) {
  const experiment = validateExperiment(await readConfigFile(experimentPath))
  const benchmarkPath = resolveInside(repositoryRoot, experiment.benchmarkPath, 'Benchmark 路径')
  const policyPath = resolveInside(repositoryRoot, experiment.policyPath, 'Evaluation Policy 路径')
  await Promise.all([
    assertPathKind(benchmarkPath, 'Benchmark 配置', 'file'),
    assertPathKind(policyPath, 'Evaluation Policy 配置', 'file'),
  ])
  const target = validateTargetAdapter(
    await readConfigFile(resolveInside(repositoryRoot, experiment.adapters.target, 'Target Adapter 路径')),
  )
  const updater = validateUpdaterAdapter(
    await readConfigFile(resolveInside(repositoryRoot, experiment.adapters.updater, 'Updater Adapter 路径')),
  )
  const environment = validateEnvironmentAdapter(
    await readConfigFile(resolveInside(repositoryRoot, experiment.adapters.environment, 'Environment Adapter 路径')),
  )
  const benchmark = validateBenchmark(
    await readJsonFile(benchmarkPath),
  )
  const policy = validateEvaluationPolicy(
    await readJsonFile(policyPath),
  )
  if (benchmark.source.adapter !== environment.id) {
    throw new ProtocolError('Benchmark 与 Environment Adapter 不匹配', [
      `Benchmark=${benchmark.source.adapter}`,
      `Environment=${environment.id}`,
    ])
  }
  if (benchmark.evaluator.adapter !== environment.id) {
    throw new ProtocolError('Benchmark Evaluator 与 Environment Adapter 不匹配', [
      `Benchmark=${benchmark.evaluator.adapter}`,
      `Environment=${environment.id}`,
    ])
  }
  if (!target.mutation.levels[experiment.evolution.mutationLevel]) {
    throw new ProtocolError(`Target Adapter 没有定义 ${experiment.evolution.mutationLevel}`)
  }
  const gatewayEnvironment = new Set([
    environment.modelGateway.upstreamApiKeyEnvironment,
    environment.modelGateway.upstreamBaseUrlEnvironment,
  ])
  for (const [label, names] of [
    ['Target Solver', target.solver.runtime.secretEnvironment],
    ['Updater', updater.runtime.secretEnvironment],
  ]) {
    if (names.length !== gatewayEnvironment.size || names.some((name) => !gatewayEnvironment.has(name))) {
      throw new ProtocolError(`${label} 的凭据环境变量必须由 Model Gateway 完整代理`, [
        `runtime=${names.join(',')}`,
        `gateway=${[...gatewayEnvironment].join(',')}`,
      ])
    }
  }
  return { experiment, target, updater, environment, benchmark, policy }
}

export async function validateAnyAdapter(input) {
  if (!isObject(input) || !hasText(input.kind)) throw new ProtocolError('Adapter 配置缺少 kind')
  if (input.kind === 'TargetAdapter') return validateTargetAdapter(input)
  if (input.kind === 'UpdaterAdapter') return validateUpdaterAdapter(input)
  if (input.kind === 'EnvironmentAdapter') return validateEnvironmentAdapter(input)
  if (input.kind === 'EvolutionExperiment') return validateExperiment(input)
  throw new ProtocolError(`不支持校验 kind=${input.kind}`)
}
