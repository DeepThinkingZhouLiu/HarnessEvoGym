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
import { isAbsolute, posix, relative, resolve } from 'node:path'
import { normalizeMutationCatalogConfiguration } from './mutation-catalog.mjs'
import { normalizeRelativePath } from './path-policy.mjs'
import { ProtocolError, readJsonFile, validateBenchmark, validateEvaluationPolicy } from './protocol.mjs'
import { normalizeCoworkEvolutionRecipe, normalizeEvolutionRecipe } from './evolution-recipe.mjs'
import { validateGrhsConfiguration } from './grhs.mjs'

const MUTATION_LEVELS = ['l1', 'l2', 'l3']
const FULL_GIT_SHA = /^[0-9a-f]{40}$/u
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u
const ADAPTER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const STRATEGY_IMAGE = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[0-9a-f]{64}$/u
const SHA256_DIGEST = /^[0-9a-f]{64}$/u
const PINNED_CONTAINER_IMAGE = /^(?:[a-z0-9][a-z0-9._:-]*\/)*[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/u

function metadataId(input, label) {
  return expectText(expectObject(input.metadata, `${label}.metadata`).id, `${label}.metadata.id`)
}

function environmentName(value, label) {
  const name = expectText(value, label)
  if (!ENVIRONMENT_NAME.test(name)) throw new ProtocolError(`${label} 必须是大写环境变量名`)
  return name
}

function relativePath(value, label) {
  return normalizeRelativePath(expectText(value, label), label)
}

function validateRuntime(raw, label) {
  const runtime = expectObject(raw, label)
  const secretEnvironment = expectStringArray(runtime.secretEnvironment, `${label}.secretEnvironment`)
  for (const name of secretEnvironment) {
    if (!ENVIRONMENT_NAME.test(name)) throw new ProtocolError(`${label}.secretEnvironment 包含非法名称：${name}`)
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

function absoluteRuntimePath(value, label) {
  const pathValue = expectText(value, label)
  if (!isAbsolute(pathValue) || pathValue.includes('\0')) {
    throw new ProtocolError(`${label} 必须是绝对路径`)
  }
  return pathValue
}

function validateCodexUpdaterRuntime(raw, label) {
  const runtime = expectObject(raw, label)
  const secretEnvironment = expectStringArray(runtime.secretEnvironment, `${label}.secretEnvironment`)
  for (const name of secretEnvironment) {
    if (!ENVIRONMENT_NAME.test(name)) throw new ProtocolError(`${label}.secretEnvironment 包含非法名称：${name}`)
  }
  const providerId = expectText(runtime.providerId, `${label}.providerId`)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(providerId)) {
    throw new ProtocolError(`${label}.providerId 不是合法 Codex Provider 标识`)
  }
  const version = expectText(runtime.version, `${label}.version`)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new ProtocolError(`${label}.version 必须是固定语义版本`)
  }
  return {
    executable: absoluteRuntimePath(runtime.executable, `${label}.executable`),
    distributionRoot: absoluteRuntimePath(runtime.distributionRoot, `${label}.distributionRoot`),
    nodeBinary: absoluteRuntimePath(runtime.nodeBinary, `${label}.nodeBinary`),
    bwrapPath: absoluteRuntimePath(runtime.bwrapPath, `${label}.bwrapPath`),
    setprivPath: absoluteRuntimePath(runtime.setprivPath, `${label}.setprivPath`),
    package: expectText(runtime.package, `${label}.package`),
    version,
    distributionDigest: sha256Digest(runtime.distributionDigest, `${label}.distributionDigest`),
    providerId,
    maximumModelRequests: expectNumber(
      runtime.maximumModelRequests ?? 64,
      `${label}.maximumModelRequests`,
      { integer: true, min: 1, max: 128 },
    ),
    secretEnvironment,
  }
}

function validateMsaSolverRuntime(raw, label) {
  const runtime = expectObject(raw, label)
  const secretEnvironment = expectStringArray(runtime.secretEnvironment, `${label}.secretEnvironment`)
  for (const name of secretEnvironment) {
    if (!ENVIRONMENT_NAME.test(name)) throw new ProtocolError(`${label}.secretEnvironment 包含非法名称：${name}`)
  }
  return {
    image: expectText(runtime.image, `${label}.image`),
    dockerfile: relativePath(runtime.dockerfile, `${label}.dockerfile`),
    profile: expectText(runtime.profile, `${label}.profile`),
    pythonCommand: expectText(runtime.pythonCommand ?? 'python3', `${label}.pythonCommand`),
    answerFile: relativePath(runtime.answerFile ?? 'answer.txt', `${label}.answerFile`),
    traceFile: relativePath(runtime.traceFile ?? 'trace.json', `${label}.traceFile`),
    maximumAnswerBytes: expectNumber(runtime.maximumAnswerBytes ?? 1024 * 1024, `${label}.maximumAnswerBytes`, {
      integer: true,
      min: 1,
      max: 16 * 1024 * 1024,
    }),
    maximumTraceBytes: expectNumber(runtime.maximumTraceBytes ?? 4 * 1024 * 1024, `${label}.maximumTraceBytes`, {
      integer: true,
      min: 1,
      max: 64 * 1024 * 1024,
    }),
    maximumSteps: expectNumber(runtime.maximumSteps ?? 32, `${label}.maximumSteps`, {
      integer: true,
      min: 0,
      max: 32,
    }),
    secretEnvironment,
  }
}

function gitRevision(value, label) {
  const revision = expectText(value, label)
  if (!FULL_GIT_SHA.test(revision)) throw new ProtocolError(`${label} 必须是完整的 40 位小写 Git SHA`)
  return revision
}

function sha256Digest(value, label) {
  const digest = expectText(value, label)
  if (!SHA256_DIGEST.test(digest)) throw new ProtocolError(`${label} 必须是 64 位小写 SHA-256`)
  return digest
}

function mutationGlobs(value, label, { nonEmpty = true } = {}) {
  return expectStringArray(value, label, { nonEmpty })
    .map((pattern, index) => relativePath(pattern, `${label}[${index}]`))
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
    const semanticProtocol = expectText(checks.protocol ?? 'dsh-cordis-v1', 'TargetAdapter.spec.mutation.semanticChecks.protocol')
    const rawSkills = checks.skills
    let skills = null
    if (rawSkills !== undefined) {
      const skillConfig = expectObject(rawSkills, 'TargetAdapter.spec.mutation.semanticChecks.skills')
      const requiredNamePrefix = expectText(
        skillConfig.requiredNamePrefix,
        'TargetAdapter.spec.mutation.semanticChecks.skills.requiredNamePrefix',
      )
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-$/u.test(requiredNamePrefix)) {
        throw new ProtocolError('TargetAdapter.spec.mutation.semanticChecks.skills.requiredNamePrefix 必须是以连字符结尾的 kebab-case 前缀')
      }
      skills = {
        root: relativePath(skillConfig.root, 'TargetAdapter.spec.mutation.semanticChecks.skills.root'),
        requiredNamePrefix,
      }
    }
    if (semanticProtocol === 'dsh-cordis-v1') {
      const cordis = expectObject(checks.cordis, 'TargetAdapter.spec.mutation.semanticChecks.cordis')
      if (!skills) throw new ProtocolError('dsh-cordis-v1 Candidate Validator 必须配置 skills')
      semanticChecks = {
        protocol: semanticProtocol,
        skills,
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
    } else if (['msa-minimal-cowork-v1', 'msa-minimal-reasoning-v1'].includes(semanticProtocol)) {
      const profile = expectObject(checks.profile, 'TargetAdapter.spec.mutation.semanticChecks.profile')
      const maximums = expectObject(profile.maximums, 'TargetAdapter.spec.mutation.semanticChecks.profile.maximums')
      semanticChecks = {
        protocol: semanticProtocol,
        requiredFiles: mutationGlobs(checks.requiredFiles, 'TargetAdapter.spec.mutation.semanticChecks.requiredFiles'),
        pythonFiles: mutationGlobs(checks.pythonFiles, 'TargetAdapter.spec.mutation.semanticChecks.pythonFiles'),
        profile: {
          path: relativePath(profile.path, 'TargetAdapter.spec.mutation.semanticChecks.profile.path'),
          maximums: Object.fromEntries(Object.entries(maximums).map(([field, maximum]) => [
            field,
            expectNumber(maximum, `TargetAdapter.spec.mutation.semanticChecks.profile.maximums.${field}`, {
              integer: true,
              min: 1,
              max: 1_000_000_000,
            }),
          ])),
        },
        skills,
      }
    } else {
      throw new ProtocolError(`当前未实现 Candidate Validator：${semanticProtocol}`)
    }
  }
  const sourceKind = expectText(source.kind, 'TargetAdapter.spec.source.kind')
  const sourceProtocol = sourceKind === 'git-submodule'
    ? 'git-submodule-v1'
    : sourceKind === 'repository-tree'
      ? 'repository-tree-v1'
      : sourceKind
  if (!['git-submodule-v1', 'repository-tree-v1'].includes(sourceProtocol)) {
    throw new ProtocolError(`当前未实现 Target Source：${sourceKind}`)
  }
  const strategy = expectText(materialization.strategy, 'TargetAdapter.spec.materialization.strategy')
  const materializationProtocol = strategy === 'controller-owned-overlay'
    ? 'controller-owned-overlay-v1'
    : strategy === 'source-plus-seed-overlay'
      ? 'source-plus-seed-overlay-v1'
      : strategy
  if (!['controller-owned-overlay-v1', 'source-plus-seed-overlay-v1'].includes(materializationProtocol)) {
    throw new ProtocolError(`当前未实现 Candidate Materialization：${strategy}`)
  }
  const solverProtocol = expectText(solver.protocol, 'TargetAdapter.spec.solver.protocol')
  const normalizedSolverProtocol = solverProtocol === 'dsh-headless-docker'
    ? 'dsh-headless-docker-v1'
    : solverProtocol
  if (!['dsh-headless-docker-v1', 'msa-minimal-docker-v1'].includes(normalizedSolverProtocol)) {
    throw new ProtocolError(`当前未实现 Solver Protocol：${solverProtocol}`)
  }
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
  const catalog = normalizeMutationCatalogConfiguration(mutation.catalog, levels)
  return {
    apiVersion: API_VERSION,
    kind: 'TargetAdapter',
    id,
    source: {
      kind: sourceKind,
      protocol: sourceProtocol,
      path: relativePath(source.path, 'TargetAdapter.spec.source.path'),
      revision: gitRevision(source.revision, 'TargetAdapter.spec.source.revision'),
    },
    materialization: materializationProtocol === 'controller-owned-overlay-v1'
      ? {
          strategy,
          protocol: materializationProtocol,
          baselinePath: relativePath(materialization.baselinePath, 'TargetAdapter.spec.materialization.baselinePath'),
          runtimeRoot: relativePath(materialization.runtimeRoot, 'TargetAdapter.spec.materialization.runtimeRoot'),
          presetRelativePath: relativePath(
            materialization.presetRelativePath,
            'TargetAdapter.spec.materialization.presetRelativePath',
          ),
        }
      : {
          strategy,
          protocol: materializationProtocol,
          seedPath: relativePath(materialization.seedPath, 'TargetAdapter.spec.materialization.seedPath'),
          seedDigest: sha256Digest(
            materialization.seedDigest,
            'TargetAdapter.spec.materialization.seedDigest',
          ),
          overrides: mutationGlobs(
            materialization.overrides ?? [],
            'TargetAdapter.spec.materialization.overrides',
            { nonEmpty: false },
          ),
          runtimeRoot: relativePath(materialization.runtimeRoot, 'TargetAdapter.spec.materialization.runtimeRoot'),
          presetRelativePath: '.',
        },
    solver: {
      protocol: solverProtocol,
      runtime: normalizedSolverProtocol === 'dsh-headless-docker-v1'
        ? validateRuntime(solver.runtime, 'TargetAdapter.spec.solver.runtime')
        : validateMsaSolverRuntime(solver.runtime, 'TargetAdapter.spec.solver.runtime'),
    },
    mutation: {
      alwaysReadOnly,
      levels,
      catalog,
      semanticChecks,
      limits: resolvedMutationLimits,
    },
  }
}

function jsonConfiguration(value, label) {
  const configuration = value === undefined ? {} : expectObject(value, label)
  let serialized
  try {
    serialized = JSON.stringify(configuration)
  } catch (error) {
    throw new ProtocolError(`${label} 必须是可序列化 JSON`, [error.message])
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new ProtocolError(`${label} 不能超过 64 KiB`)
  }
  return JSON.parse(serialized)
}

export function validateSearchStrategyAdapter(input) {
  assertApiObject(input, 'SearchStrategyAdapter')
  const id = metadataId(input, 'SearchStrategyAdapter')
  if (!ADAPTER_ID.test(id)) throw new ProtocolError('SearchStrategyAdapter.metadata.id 必须是 kebab-case')
  const spec = expectObject(input.spec, 'SearchStrategyAdapter.spec')
  const protocol = expectText(spec.protocol, 'SearchStrategyAdapter.spec.protocol')
  const configuration = jsonConfiguration(spec.configuration, 'SearchStrategyAdapter.spec.configuration')

  if (protocol === 'builtin-v1') {
    return {
      apiVersion: API_VERSION,
      kind: 'SearchStrategyAdapter',
      id,
      protocol,
      implementation: expectText(spec.implementation, 'SearchStrategyAdapter.spec.implementation'),
      configuration,
      runtime: null,
    }
  }
  if (protocol !== 'docker-json-v1') {
    throw new ProtocolError(`当前未实现 Search Strategy Protocol：${protocol}`)
  }
  const runtime = expectObject(spec.runtime, 'SearchStrategyAdapter.spec.runtime')
  const image = expectText(runtime.image, 'SearchStrategyAdapter.spec.runtime.image')
  if (!STRATEGY_IMAGE.test(image)) {
    throw new ProtocolError('外部 Search Strategy Image 必须固定到 sha256 Digest')
  }
  const command = expectStringArray(runtime.command, 'SearchStrategyAdapter.spec.runtime.command')
  if (command.some((part) => /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new ProtocolError('SearchStrategyAdapter runtime.command 包含控制字符')
  }
  const resources = expectObject(runtime.resources, 'SearchStrategyAdapter.spec.runtime.resources')
  const memory = expectText(resources.memory, 'SearchStrategyAdapter.spec.runtime.resources.memory')
  if (!/^[1-9][0-9]*(?:[kKmMgG])?$/u.test(memory)) {
    throw new ProtocolError('SearchStrategyAdapter runtime.resources.memory 格式无效')
  }
  return {
    apiVersion: API_VERSION,
    kind: 'SearchStrategyAdapter',
    id,
    protocol,
    implementation: null,
    configuration,
    runtime: {
      image,
      command,
      timeoutSeconds: expectNumber(runtime.timeoutSeconds, 'SearchStrategyAdapter.spec.runtime.timeoutSeconds', {
        integer: true,
        min: 1,
        max: 300,
      }),
      resources: {
        cpus: expectNumber(resources.cpus, 'SearchStrategyAdapter.spec.runtime.resources.cpus', {
          min: 0.1,
          max: 8,
        }),
        memory,
        pids: expectNumber(resources.pids, 'SearchStrategyAdapter.spec.runtime.resources.pids', {
          integer: true,
          min: 16,
          max: 512,
        }),
      },
    },
  }
}

export function defaultSearchStrategyAdapter() {
  return validateSearchStrategyAdapter({
    apiVersion: API_VERSION,
    kind: 'SearchStrategyAdapter',
    metadata: { id: 'linear-hill-climb' },
    spec: {
      protocol: 'builtin-v1',
      implementation: 'linear-hill-climb',
      configuration: { regionSelection: 'all-under-risk-ceiling' },
    },
  })
}

export function validateUpdaterAdapter(input) {
  assertApiObject(input, 'UpdaterAdapter')
  const id = metadataId(input, 'UpdaterAdapter')
  const spec = expectObject(input.spec, 'UpdaterAdapter.spec')
  const protocol = expectText(spec.protocol, 'UpdaterAdapter.spec.protocol')
  if (!['dsh-headless-docker', 'dsh-headless-docker-v1', 'codex-exec-v1'].includes(protocol)) {
    throw new ProtocolError(`当前未实现 Updater Protocol：${protocol}`)
  }
  const prompt = expectObject(spec.prompt, 'UpdaterAdapter.spec.prompt')
  const output = expectObject(spec.output, 'UpdaterAdapter.spec.output')
  const mutationReportName = relativePath(
    expectObject(output.mutationReport, 'UpdaterAdapter.spec.output.mutationReport').name,
    'UpdaterAdapter.spec.output.mutationReport.name',
  )
  if (mutationReportName.includes('/')) throw new ProtocolError('Mutation Report name 必须是单个文件名')
  if (protocol === 'codex-exec-v1') {
    if (spec.source !== undefined) throw new ProtocolError('Codex Updater 不接受 Source；运行时由固定 distribution 提供')
    return {
      apiVersion: API_VERSION,
      kind: 'UpdaterAdapter',
      id,
      protocol,
      source: null,
      runtime: validateCodexUpdaterRuntime(spec.runtime, 'UpdaterAdapter.spec.runtime'),
      promptPath: relativePath(prompt.path, 'UpdaterAdapter.spec.prompt.path'),
      mutationReportName,
    }
  }
  const source = expectObject(spec.source, 'UpdaterAdapter.spec.source')
  const sourceKind = expectText(source.kind, 'UpdaterAdapter.spec.source.kind')
  if (sourceKind !== 'git-submodule') throw new ProtocolError('当前 UpdaterAdapter 只支持 git-submodule Source')
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

export function validateModelProviderAdapter(input) {
  assertApiObject(input, 'ModelProviderAdapter')
  const id = metadataId(input, 'ModelProviderAdapter')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    throw new ProtocolError('ModelProviderAdapter.metadata.id 必须是 kebab-case')
  }
  const metadata = expectObject(input.metadata, 'ModelProviderAdapter.metadata')
  const spec = expectObject(input.spec, 'ModelProviderAdapter.spec')
  const protocol = expectText(spec.protocol, 'ModelProviderAdapter.spec.protocol')
  if (protocol !== 'openai-chat-completions') {
    throw new ProtocolError(`当前未实现 Model Provider Protocol：${protocol}`)
  }
  const credentials = expectObject(spec.credentials, 'ModelProviderAdapter.spec.credentials')
  const apiKeyEnvironment = environmentName(
    credentials.apiKeyEnvironment,
    'ModelProviderAdapter.spec.credentials.apiKeyEnvironment',
  )
  const baseUrlEnvironment = environmentName(
    credentials.baseUrlEnvironment,
    'ModelProviderAdapter.spec.credentials.baseUrlEnvironment',
  )
  if (apiKeyEnvironment === baseUrlEnvironment) {
    throw new ProtocolError('Model Provider 的 API Key 与 Base URL 环境变量不能同名')
  }

  const compatibility = expectObject(spec.compatibility, 'ModelProviderAdapter.spec.compatibility')
  const maxTokensField = expectText(
    compatibility.maxTokensField,
    'ModelProviderAdapter.spec.compatibility.maxTokensField',
  )
  if (!['max_tokens', 'max_completion_tokens'].includes(maxTokensField)) {
    throw new ProtocolError('ModelProviderAdapter.spec.compatibility.maxTokensField 只支持 max_tokens 或 max_completion_tokens')
  }

  if (!Array.isArray(spec.models) || spec.models.length === 0) {
    throw new ProtocolError('ModelProviderAdapter.spec.models 必须是非空数组')
  }
  const seenModelIds = new Set()
  const models = spec.models.map((value, index) => {
    const model = expectObject(value, `ModelProviderAdapter.spec.models[${index}]`)
    const modelId = expectText(model.id, `ModelProviderAdapter.spec.models[${index}].id`)
    if (seenModelIds.has(modelId)) throw new ProtocolError(`Model Provider 重复声明模型：${modelId}`)
    seenModelIds.add(modelId)
    return {
      id: modelId,
      name: expectText(model.name ?? modelId, `ModelProviderAdapter.spec.models[${index}].name`),
      ...(model.contextWindow === undefined
        ? {}
        : {
            contextWindow: expectNumber(
              model.contextWindow,
              `ModelProviderAdapter.spec.models[${index}].contextWindow`,
              { integer: true, min: 1 },
            ),
          }),
    }
  })

  return {
    apiVersion: API_VERSION,
    kind: 'ModelProviderAdapter',
    id,
    name: expectText(metadata.name ?? id, 'ModelProviderAdapter.metadata.name'),
    protocol,
    credentials: { apiKeyEnvironment, baseUrlEnvironment },
    compatibility: {
      supportsDeveloperRole: expectBoolean(
        compatibility.supportsDeveloperRole,
        'ModelProviderAdapter.spec.compatibility.supportsDeveloperRole',
      ),
      maxTokensField,
    },
    defaultContextWindow: expectNumber(
      spec.defaultContextWindow,
      'ModelProviderAdapter.spec.defaultContextWindow',
      { integer: true, min: 1 },
    ),
    models,
  }
}

function rejectUnknownConfiguration(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknown)
}

function validateDockerTransport(docker, label) {
  const backend = expectText(docker.backend ?? 'local', `${label}.backend`)
  if (backend === 'local') {
    if (docker.agentBay !== undefined) throw new ProtocolError(`${label}.agentBay 仅可用于 agentbay backend`)
    return { backend, agentBay: null }
  }
  if (backend !== 'agentbay') throw new ProtocolError(`${label}.backend 当前仅支持 local 或 agentbay`)
  const agentBay = expectObject(docker.agentBay, `${label}.agentBay`)
  rejectUnknownConfiguration(
    agentBay,
    new Set(['pythonExecutable', 'bridgePath', 'imageIdEnvironment', 'policyIdEnvironment', 'registryMirror']),
    `${label}.agentBay`,
  )
  const pythonExecutable = expectText(agentBay.pythonExecutable, `${label}.agentBay.pythonExecutable`)
  if (!isAbsolute(pythonExecutable)) throw new ProtocolError(`${label}.agentBay.pythonExecutable 必须是绝对路径`)
  const registryMirror = expectText(agentBay.registryMirror ?? 'https://docker.1panel.live', `${label}.agentBay.registryMirror`)
  if (registryMirror && !/^https:\/\/[A-Za-z0-9._:-]+\/?$/u.test(registryMirror)) {
    throw new ProtocolError(`${label}.agentBay.registryMirror 必须是无凭据 HTTPS Origin`)
  }
  return {
    backend,
    agentBay: {
      pythonExecutable,
      bridgePath: relativePath(agentBay.bridgePath, `${label}.agentBay.bridgePath`),
      imageIdEnvironment: environmentName(agentBay.imageIdEnvironment, `${label}.agentBay.imageIdEnvironment`),
      policyIdEnvironment: environmentName(agentBay.policyIdEnvironment, `${label}.agentBay.policyIdEnvironment`),
      registryMirror,
    },
  }
}

function validateTextReasoningEnvironment({ id, spec, protocol }) {
  rejectUnknownConfiguration(
    spec,
    new Set(['protocol', 'source', 'task', 'runtime', 'docker', 'modelGateway', 'reward', 'feedback']),
    'EnvironmentAdapter.spec',
  )
  const source = expectObject(spec.source, 'EnvironmentAdapter.spec.source')
  const task = expectObject(spec.task, 'EnvironmentAdapter.spec.task')
  const runtime = expectObject(spec.runtime, 'EnvironmentAdapter.spec.runtime')
  const docker = expectObject(spec.docker, 'EnvironmentAdapter.spec.docker')
  const resources = expectObject(docker.resources, 'EnvironmentAdapter.spec.docker.resources')
  const modelGateway = expectObject(spec.modelGateway, 'EnvironmentAdapter.spec.modelGateway')
  const gatewayResources = expectObject(modelGateway.resources, 'EnvironmentAdapter.spec.modelGateway.resources')
  const reward = expectObject(spec.reward, 'EnvironmentAdapter.spec.reward')
  const feedback = expectObject(spec.feedback, 'EnvironmentAdapter.spec.feedback')
  rejectUnknownConfiguration(source, new Set(['tasksPath', 'digest']), 'EnvironmentAdapter.spec.source')
  rejectUnknownConfiguration(task, new Set(['workspacePath', 'answerNormalization']), 'EnvironmentAdapter.spec.task')
  rejectUnknownConfiguration(runtime, new Set(['baseImage', 'imagePrefix']), 'EnvironmentAdapter.spec.runtime')
  rejectUnknownConfiguration(docker, new Set(['binary', 'network', 'runAsCurrentUser', 'resources']), 'EnvironmentAdapter.spec.docker')
  rejectUnknownConfiguration(resources, new Set(['cpus', 'memory', 'pids', 'timeoutSeconds']), 'EnvironmentAdapter.spec.docker.resources')
  rejectUnknownConfiguration(
    modelGateway,
    new Set([
      'image',
      'dockerfile',
      'alias',
      'port',
      'egressNetwork',
      'maximumRequestsPerRun',
      'maximumConcurrentRequests',
      'maximumUpstreamRetries',
      'resources',
    ]),
    'EnvironmentAdapter.spec.modelGateway',
  )
  rejectUnknownConfiguration(gatewayResources, new Set(['cpus', 'memory', 'pids']), 'modelGateway.resources')
  rejectUnknownConfiguration(reward, new Set(['minimum', 'maximum', 'resolvedThreshold']), 'EnvironmentAdapter.spec.reward')
  rejectUnknownConfiguration(
    feedback,
    new Set([
      'maximumTextBytesPerCase',
      'maximumArtifactEntriesPerCase',
      'maximumArtifactBytesPerCase',
      'maximumHistoryEntries',
      'maximumHistoryBytes',
    ]),
    'EnvironmentAdapter.spec.feedback',
  )

  const digest = expectText(source.digest, 'EnvironmentAdapter.spec.source.digest')
  if (!SHA256_DIGEST.test(digest)) {
    throw new ProtocolError('EnvironmentAdapter.spec.source.digest 必须是 64 位小写 SHA-256')
  }
  const workspacePath = expectText(task.workspacePath, 'EnvironmentAdapter.spec.task.workspacePath')
  if (
    !workspacePath.startsWith('/')
    || workspacePath === '/'
    || workspacePath.includes(':')
    || workspacePath.includes(',')
    || posix.normalize(workspacePath) !== workspacePath
  ) {
    throw new ProtocolError('EnvironmentAdapter.spec.task.workspacePath 必须是安全的容器绝对路径')
  }
  const reserved = ['/candidate', '/environment-assets', '/solver-output', '/tmp', '/run']
  if (reserved.some((root) => workspacePath === root || workspacePath.startsWith(`${root}/`))) {
    throw new ProtocolError(`EnvironmentAdapter.spec.task.workspacePath 与 RSI 保留挂载冲突：${workspacePath}`)
  }
  const answerNormalization = expectText(
    task.answerNormalization,
    'EnvironmentAdapter.spec.task.answerNormalization',
  )
  if (answerNormalization !== 'trim-collapse-casefold-v1') {
    throw new ProtocolError('Synthetic Reasoning 只支持 trim-collapse-casefold-v1 答案归一化')
  }
  const baseImage = expectText(runtime.baseImage, 'EnvironmentAdapter.spec.runtime.baseImage')
  if (!PINNED_CONTAINER_IMAGE.test(baseImage)) {
    throw new ProtocolError('Synthetic Reasoning Base Image 必须固定到 sha256 Digest')
  }
  const imagePrefix = expectText(runtime.imagePrefix, 'EnvironmentAdapter.spec.runtime.imagePrefix')
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(imagePrefix)) {
    throw new ProtocolError('EnvironmentAdapter.spec.runtime.imagePrefix 格式无效')
  }
  const network = expectText(docker.network, 'EnvironmentAdapter.spec.docker.network')
  if (network === 'host') throw new ProtocolError('Solver/Updater Docker 禁止使用 host 网络')
  const gatewayAlias = expectText(modelGateway.alias, 'EnvironmentAdapter.spec.modelGateway.alias')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(gatewayAlias) || gatewayAlias === 'localhost') {
    throw new ProtocolError('EnvironmentAdapter.spec.modelGateway.alias 必须是非 localhost 的小写 Docker DNS 名')
  }
  const gatewayEgressNetwork = expectText(
    modelGateway.egressNetwork,
    'EnvironmentAdapter.spec.modelGateway.egressNetwork',
  )
  if (['host', 'none'].includes(gatewayEgressNetwork)) {
    throw new ProtocolError('Model Gateway egressNetwork 不能是 host 或 none')
  }
  const rewardMinimum = expectNumber(reward.minimum, 'EnvironmentAdapter.spec.reward.minimum')
  const rewardMaximum = expectNumber(reward.maximum, 'EnvironmentAdapter.spec.reward.maximum')
  const resolvedThreshold = expectNumber(reward.resolvedThreshold, 'EnvironmentAdapter.spec.reward.resolvedThreshold')
  if (rewardMinimum !== 0 || rewardMaximum !== 1 || resolvedThreshold !== 1) {
    throw new ProtocolError('Synthetic Reasoning 确定性评分必须固定为 0/1，resolvedThreshold=1')
  }

  return {
    apiVersion: API_VERSION,
    kind: 'EnvironmentAdapter',
    id,
    protocol,
    source: {
      tasksPath: relativePath(source.tasksPath, 'EnvironmentAdapter.spec.source.tasksPath'),
      digest,
      revision: digest,
    },
    task: { workspacePath, answerNormalization },
    runtime: { baseImage, imagePrefix },
    docker: {
      backend: 'local',
      agentBay: null,
      binary: expectText(docker.binary, 'EnvironmentAdapter.spec.docker.binary'),
      network,
      runAsCurrentUser: expectBoolean(docker.runAsCurrentUser, 'EnvironmentAdapter.spec.docker.runAsCurrentUser'),
      resources: {
        cpus: expectNumber(resources.cpus, 'EnvironmentAdapter.spec.docker.resources.cpus', { min: 0.1, max: 32 }),
        memory: expectText(resources.memory, 'EnvironmentAdapter.spec.docker.resources.memory'),
        pids: expectNumber(resources.pids, 'EnvironmentAdapter.spec.docker.resources.pids', {
          integer: true,
          min: 16,
          max: 4096,
        }),
        timeoutSeconds: expectNumber(
          resources.timeoutSeconds,
          'EnvironmentAdapter.spec.docker.resources.timeoutSeconds',
          { integer: true, min: 1, max: 7200 },
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
      maximumUpstreamRetries: expectNumber(
        modelGateway.maximumUpstreamRetries ?? 2,
        'EnvironmentAdapter.spec.modelGateway.maximumUpstreamRetries',
        { integer: true, min: 0, max: 5 },
      ),
      resources: {
        cpus: expectNumber(gatewayResources.cpus, 'modelGateway.resources.cpus', { min: 0.1, max: 32 }),
        memory: expectText(gatewayResources.memory, 'modelGateway.resources.memory'),
        pids: expectNumber(gatewayResources.pids, 'modelGateway.resources.pids', {
          integer: true,
          min: 16,
          max: 4096,
        }),
      },
    },
    reward: { minimum: 0, maximum: 1, resolvedThreshold: 1 },
    feedback: {
      maximumTextBytesPerCase: expectNumber(
        feedback.maximumTextBytesPerCase,
        'EnvironmentAdapter.spec.feedback.maximumTextBytesPerCase',
        { integer: true, min: 256, max: 1024 * 1024 },
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

function validateOmegaUseOfficeValEnvironment({ id, spec, protocol }) {
  rejectUnknownConfiguration(
    spec,
    new Set(['protocol', 'source', 'task', 'runtime', 'docker', 'modelGateway', 'verifier', 'reward', 'feedback']),
    'EnvironmentAdapter.spec',
  )
  const source = expectObject(spec.source, 'EnvironmentAdapter.spec.source')
  const task = expectObject(spec.task, 'EnvironmentAdapter.spec.task')
  const workspaceLimits = expectObject(task.workspaceLimits, 'EnvironmentAdapter.spec.task.workspaceLimits')
  const runtime = expectObject(spec.runtime, 'EnvironmentAdapter.spec.runtime')
  const docker = expectObject(spec.docker, 'EnvironmentAdapter.spec.docker')
  const resources = expectObject(docker.resources, 'EnvironmentAdapter.spec.docker.resources')
  const modelGateway = expectObject(spec.modelGateway, 'EnvironmentAdapter.spec.modelGateway')
  const gatewayResources = expectObject(modelGateway.resources, 'EnvironmentAdapter.spec.modelGateway.resources')
  const verifier = expectObject(spec.verifier, 'EnvironmentAdapter.spec.verifier')
  const verifierResources = expectObject(verifier.resources, 'EnvironmentAdapter.spec.verifier.resources')
  const reward = expectObject(spec.reward, 'EnvironmentAdapter.spec.reward')
  const feedback = expectObject(spec.feedback, 'EnvironmentAdapter.spec.feedback')

  rejectUnknownConfiguration(
    source,
    new Set([
      'datasetRootEnvironment',
      'evaluatorRootEnvironment',
      'datasetRevision',
      'evaluatorRevision',
      'manifestPath',
      'manifestDigest',
    ]),
    'EnvironmentAdapter.spec.source',
  )
  rejectUnknownConfiguration(
    task,
    new Set(['workspacePath', 'environmentAssets', 'maximumConcurrentTrials', 'workspaceLimits']),
    'EnvironmentAdapter.spec.task',
  )
  rejectUnknownConfiguration(
    workspaceLimits,
    new Set([
      'maximumFiles',
      'maximumBytes',
      'maximumFileBytes',
      'maximumChangedFiles',
      'maximumChangedBytes',
    ]),
    'EnvironmentAdapter.spec.task.workspaceLimits',
  )
  rejectUnknownConfiguration(
    runtime,
    new Set(['image', 'dockerfile', 'verifierRunner']),
    'EnvironmentAdapter.spec.runtime',
  )
  rejectUnknownConfiguration(
    docker,
    new Set(['binary', 'network', 'runAsCurrentUser', 'resources', 'backend', 'agentBay']),
    'EnvironmentAdapter.spec.docker',
  )
  rejectUnknownConfiguration(
    resources,
    new Set(['cpus', 'memory', 'pids', 'timeoutSeconds']),
    'EnvironmentAdapter.spec.docker.resources',
  )
  rejectUnknownConfiguration(
    modelGateway,
    new Set([
      'image',
      'dockerfile',
      'alias',
      'port',
      'egressNetwork',
      'maximumRequestsPerRun',
      'maximumConcurrentRequests',
      'maximumUpstreamRetries',
      'resources',
    ]),
    'EnvironmentAdapter.spec.modelGateway',
  )
  rejectUnknownConfiguration(gatewayResources, new Set(['cpus', 'memory', 'pids']), 'modelGateway.resources')
  rejectUnknownConfiguration(
    verifier,
    new Set(['timeoutSeconds', 'resources']),
    'EnvironmentAdapter.spec.verifier',
  )
  rejectUnknownConfiguration(
    verifierResources,
    new Set(['cpus', 'memory', 'pids']),
    'EnvironmentAdapter.spec.verifier.resources',
  )
  rejectUnknownConfiguration(reward, new Set(['minimum', 'maximum', 'resolvedThreshold']), 'EnvironmentAdapter.spec.reward')
  rejectUnknownConfiguration(
    feedback,
    new Set([
      'maximumTextBytesPerCase',
      'maximumArtifactEntriesPerCase',
      'maximumArtifactBytesPerCase',
      'maximumHistoryEntries',
      'maximumHistoryBytes',
    ]),
    'EnvironmentAdapter.spec.feedback',
  )

  const datasetRootEnvironment = environmentName(
    source.datasetRootEnvironment,
    'EnvironmentAdapter.spec.source.datasetRootEnvironment',
  )
  const evaluatorRootEnvironment = environmentName(
    source.evaluatorRootEnvironment,
    'EnvironmentAdapter.spec.source.evaluatorRootEnvironment',
  )
  if (datasetRootEnvironment === evaluatorRootEnvironment) {
    throw new ProtocolError('OmegaUse Dataset 与 Evaluator 必须使用不同的根目录环境变量')
  }
  const workspacePath = expectText(task.workspacePath, 'EnvironmentAdapter.spec.task.workspacePath')
  if (
    !workspacePath.startsWith('/')
    || workspacePath === '/'
    || workspacePath.includes(':')
    || workspacePath.includes(',')
    || posix.normalize(workspacePath) !== workspacePath
  ) {
    throw new ProtocolError('EnvironmentAdapter.spec.task.workspacePath 必须是安全的容器绝对路径')
  }
  const reserved = [
    '/candidate',
    '/environment-assets',
    '/solver-output',
    '/submission',
    '/verifier',
    '/logs',
    '/tmp',
    '/run',
  ]
  if (reserved.some((root) => workspacePath === root || workspacePath.startsWith(`${root}/`))) {
    throw new ProtocolError(`EnvironmentAdapter.spec.task.workspacePath 与 RSI 保留挂载冲突：${workspacePath}`)
  }
  const resolvedWorkspaceLimits = {
    maximumFiles: expectNumber(workspaceLimits.maximumFiles, 'task.workspaceLimits.maximumFiles', {
      integer: true,
      min: 1,
      max: 100000,
    }),
    maximumBytes: expectNumber(workspaceLimits.maximumBytes, 'task.workspaceLimits.maximumBytes', {
      integer: true,
      min: 1024,
    }),
    maximumFileBytes: expectNumber(workspaceLimits.maximumFileBytes, 'task.workspaceLimits.maximumFileBytes', {
      integer: true,
      min: 1,
    }),
    maximumChangedFiles: expectNumber(
      workspaceLimits.maximumChangedFiles,
      'task.workspaceLimits.maximumChangedFiles',
      { integer: true, min: 1, max: 10000 },
    ),
    maximumChangedBytes: expectNumber(
      workspaceLimits.maximumChangedBytes,
      'task.workspaceLimits.maximumChangedBytes',
      { integer: true, min: 1 },
    ),
  }
  if (
    resolvedWorkspaceLimits.maximumFileBytes > resolvedWorkspaceLimits.maximumBytes
    || resolvedWorkspaceLimits.maximumChangedBytes > resolvedWorkspaceLimits.maximumBytes
    || resolvedWorkspaceLimits.maximumChangedFiles > resolvedWorkspaceLimits.maximumFiles
  ) {
    throw new ProtocolError('OmegaUse Workspace Limits 的子上限不能超过对应总上限')
  }

  const network = expectText(docker.network, 'EnvironmentAdapter.spec.docker.network')
  if (network === 'host') throw new ProtocolError('Solver/Updater Docker 禁止使用 host 网络')
  const gatewayAlias = expectText(modelGateway.alias, 'EnvironmentAdapter.spec.modelGateway.alias')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(gatewayAlias) || gatewayAlias === 'localhost') {
    throw new ProtocolError('EnvironmentAdapter.spec.modelGateway.alias 必须是非 localhost 的小写 Docker DNS 名')
  }
  const gatewayEgressNetwork = expectText(
    modelGateway.egressNetwork,
    'EnvironmentAdapter.spec.modelGateway.egressNetwork',
  )
  if (['host', 'none'].includes(gatewayEgressNetwork)) {
    throw new ProtocolError('Model Gateway egressNetwork 不能是 host 或 none')
  }
  const rewardMinimum = expectNumber(reward.minimum, 'EnvironmentAdapter.spec.reward.minimum')
  const rewardMaximum = expectNumber(reward.maximum, 'EnvironmentAdapter.spec.reward.maximum')
  const resolvedThreshold = expectNumber(reward.resolvedThreshold, 'EnvironmentAdapter.spec.reward.resolvedThreshold')
  if (rewardMinimum !== 0 || rewardMaximum !== 1 || resolvedThreshold !== 1) {
    throw new ProtocolError('OmegaUse Reward 必须归一化到 [0,1] 且 resolvedThreshold=1')
  }
  const runtimeImage = expectText(runtime.image, 'EnvironmentAdapter.spec.runtime.image')
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}(?::[a-z0-9][a-z0-9._-]{0,63})?$/u.test(runtimeImage)) {
    throw new ProtocolError('EnvironmentAdapter.spec.runtime.image 格式无效')
  }

  return {
    apiVersion: API_VERSION,
    kind: 'EnvironmentAdapter',
    id,
    protocol,
    source: {
      datasetRootEnvironment,
      evaluatorRootEnvironment,
      datasetRevision: gitRevision(source.datasetRevision, 'EnvironmentAdapter.spec.source.datasetRevision'),
      evaluatorRevision: gitRevision(source.evaluatorRevision, 'EnvironmentAdapter.spec.source.evaluatorRevision'),
      manifestPath: relativePath(source.manifestPath, 'EnvironmentAdapter.spec.source.manifestPath'),
      manifestDigest: sha256Digest(source.manifestDigest, 'EnvironmentAdapter.spec.source.manifestDigest'),
      revision: sha256Digest(source.manifestDigest, 'EnvironmentAdapter.spec.source.manifestDigest'),
    },
    task: {
      workspacePath,
      environmentAssets: relativePath(task.environmentAssets, 'EnvironmentAdapter.spec.task.environmentAssets'),
      maximumConcurrentTrials: expectNumber(
        task.maximumConcurrentTrials ?? 1,
        'EnvironmentAdapter.spec.task.maximumConcurrentTrials',
        { integer: true, min: 1, max: 200 },
      ),
      workspaceLimits: resolvedWorkspaceLimits,
    },
    runtime: {
      image: runtimeImage,
      dockerfile: relativePath(runtime.dockerfile, 'EnvironmentAdapter.spec.runtime.dockerfile'),
      verifierRunner: relativePath(runtime.verifierRunner, 'EnvironmentAdapter.spec.runtime.verifierRunner'),
    },
    docker: {
      ...validateDockerTransport(docker, 'EnvironmentAdapter.spec.docker'),
      binary: expectText(docker.binary, 'EnvironmentAdapter.spec.docker.binary'),
      network,
      runAsCurrentUser: expectBoolean(docker.runAsCurrentUser, 'EnvironmentAdapter.spec.docker.runAsCurrentUser'),
      resources: {
        cpus: expectNumber(resources.cpus, 'EnvironmentAdapter.spec.docker.resources.cpus', { min: 0.1, max: 32 }),
        memory: expectText(resources.memory, 'EnvironmentAdapter.spec.docker.resources.memory'),
        pids: expectNumber(resources.pids, 'EnvironmentAdapter.spec.docker.resources.pids', {
          integer: true,
          min: 16,
          max: 4096,
        }),
        timeoutSeconds: expectNumber(
          resources.timeoutSeconds,
          'EnvironmentAdapter.spec.docker.resources.timeoutSeconds',
          { integer: true, min: 1, max: 7200 },
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
      maximumRequestsPerRun: expectNumber(
        modelGateway.maximumRequestsPerRun,
        'EnvironmentAdapter.spec.modelGateway.maximumRequestsPerRun',
        { integer: true, min: 1, max: 100000 },
      ),
      maximumConcurrentRequests: expectNumber(
        modelGateway.maximumConcurrentRequests,
        'EnvironmentAdapter.spec.modelGateway.maximumConcurrentRequests',
        { integer: true, min: 1, max: 200 },
      ),
      maximumUpstreamRetries: expectNumber(
        modelGateway.maximumUpstreamRetries ?? 2,
        'EnvironmentAdapter.spec.modelGateway.maximumUpstreamRetries',
        { integer: true, min: 0, max: 5 },
      ),
      resources: {
        cpus: expectNumber(gatewayResources.cpus, 'modelGateway.resources.cpus', { min: 0.1, max: 32 }),
        memory: expectText(gatewayResources.memory, 'modelGateway.resources.memory'),
        pids: expectNumber(gatewayResources.pids, 'modelGateway.resources.pids', {
          integer: true,
          min: 16,
          max: 4096,
        }),
      },
    },
    verifier: {
      timeoutSeconds: expectNumber(verifier.timeoutSeconds, 'EnvironmentAdapter.spec.verifier.timeoutSeconds', {
        integer: true,
        min: 1,
        max: 1800,
      }),
      resources: {
        cpus: expectNumber(verifierResources.cpus, 'verifier.resources.cpus', { min: 0.1, max: 16 }),
        memory: expectText(verifierResources.memory, 'verifier.resources.memory'),
        pids: expectNumber(verifierResources.pids, 'verifier.resources.pids', {
          integer: true,
          min: 16,
          max: 1024,
        }),
      },
    },
    reward: { minimum: 0, maximum: 1, resolvedThreshold: 1 },
    feedback: {
      maximumTextBytesPerCase: expectNumber(
        feedback.maximumTextBytesPerCase,
        'EnvironmentAdapter.spec.feedback.maximumTextBytesPerCase',
        { integer: true, min: 256, max: 1024 * 1024 },
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

export function validateEnvironmentAdapter(input) {
  assertApiObject(input, 'EnvironmentAdapter')
  const id = metadataId(input, 'EnvironmentAdapter')
  const spec = expectObject(input.spec, 'EnvironmentAdapter.spec')
  const protocol = expectText(spec.protocol, 'EnvironmentAdapter.spec.protocol')
  if (protocol === 'text-reasoning-deterministic-v1') {
    return validateTextReasoningEnvironment({ id, spec, protocol })
  }
  if (protocol === 'omegause-officeval-docker-v1') {
    return validateOmegaUseOfficeValEnvironment({ id, spec, protocol })
  }
  throw new ProtocolError(`当前未实现 Environment Protocol：${protocol}`)
}

function validateModel(value, label) {
  const model = expectObject(value, label)
  const reasoningEffort = model.reasoningEffort === undefined
    ? null
    : expectText(model.reasoningEffort, `${label}.reasoningEffort`)
  if (reasoningEffort !== null
      && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
    throw new ProtocolError(`${label}.reasoningEffort 无效`)
  }
  return {
    provider: expectText(model.provider, `${label}.provider`),
    model: expectText(model.model, `${label}.model`),
    maxTokens: expectNumber(model.maxTokens, `${label}.maxTokens`, {
      integer: true,
      min: 1,
      max: 1_000_000,
    }),
    reasoningEffort,
  }
}

function validateBaselinePackReference(value) {
  const reference = expectObject(value, 'EvolutionExperiment.spec.baselinePack')
  const unknown = Object.keys(reference).filter((key) => !['mode', 'path', 'sha256'].includes(key))
  if (unknown.length > 0) {
    throw new ProtocolError('EvolutionExperiment.spec.baselinePack 含有未知字段', unknown)
  }
  const mode = expectText(reference.mode, 'EvolutionExperiment.spec.baselinePack.mode')
  if (mode !== 'reuse') {
    throw new ProtocolError('EvolutionExperiment.spec.baselinePack.mode 当前只能是 reuse')
  }
  return {
    mode,
    path: relativePath(reference.path, 'EvolutionExperiment.spec.baselinePack.path'),
    sha256: sha256Digest(reference.sha256, 'EvolutionExperiment.spec.baselinePack.sha256'),
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
      provider: relativePath(adapters.provider, 'EvolutionExperiment.spec.adapters.provider'),
      strategy: adapters.strategy === undefined
        ? null
        : relativePath(adapters.strategy, 'EvolutionExperiment.spec.adapters.strategy'),
    },
    benchmarkPath: relativePath(spec.benchmark, 'EvolutionExperiment.spec.benchmark'),
    policyPath: relativePath(spec.policy, 'EvolutionExperiment.spec.policy'),
    recipePath: spec.recipe === undefined
      ? null
      : relativePath(spec.recipe, 'EvolutionExperiment.spec.recipe'),
    baselinePack: spec.baselinePack === undefined
      ? null
      : validateBaselinePackReference(spec.baselinePack),
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
      grhs: evolution.grhs === undefined ? null : validateGrhsConfiguration(evolution.grhs),
    },
  }
}

export async function loadExperimentBundle(experimentPath, repositoryRoot) {
  const absoluteExperimentPath = resolve(experimentPath)
  const relativeExperimentPath = normalizeRelativePath(
    relative(resolve(repositoryRoot), absoluteExperimentPath).replaceAll('\\', '/'),
    'EvolutionExperiment 路径',
  )
  const experiment = validateExperiment(await readConfigFile(absoluteExperimentPath))
  const benchmarkPath = resolveInside(repositoryRoot, experiment.benchmarkPath, 'Benchmark 路径')
  const policyPath = resolveInside(repositoryRoot, experiment.policyPath, 'Evaluation Policy 路径')
  const recipePath = experiment.recipePath === null
    ? null
    : resolveInside(repositoryRoot, experiment.recipePath, 'Evolution Recipe 路径')
  const baselinePackPath = experiment.baselinePack === null
    ? null
    : resolveInside(repositoryRoot, experiment.baselinePack.path, 'BaselinePack 路径')
  await Promise.all([
    assertPathKind(benchmarkPath, 'Benchmark 配置', 'file'),
    assertPathKind(policyPath, 'Evaluation Policy 配置', 'file'),
    ...(recipePath ? [assertPathKind(recipePath, 'Evolution Recipe 配置', 'file')] : []),
    ...(baselinePackPath ? [assertPathKind(baselinePackPath, 'BaselinePack', 'file')] : []),
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
  const provider = validateModelProviderAdapter(
    await readConfigFile(resolveInside(repositoryRoot, experiment.adapters.provider, 'Model Provider Adapter 路径')),
  )
  const strategy = experiment.adapters.strategy === null
    ? defaultSearchStrategyAdapter()
    : validateSearchStrategyAdapter(
        await readConfigFile(resolveInside(repositoryRoot, experiment.adapters.strategy, 'Search Strategy Adapter 路径')),
      )
  const benchmark = validateBenchmark(
    await readJsonFile(benchmarkPath),
  )
  const policy = validateEvaluationPolicy(
    await readJsonFile(policyPath),
  )
  const recipe = recipePath
    ? normalizeEvolutionRecipe(await readConfigFile(recipePath))
    : normalizeCoworkEvolutionRecipe({
        generations: experiment.evolution.generations,
        strategy,
        mutationLevel: experiment.evolution.mutationLevel,
      })
  if (experiment.baselinePack !== null && recipePath === null) {
    throw new ProtocolError('BaselinePack 只支持显式 EvolutionRecipe 的通用 Population 实验')
  }
  if (experiment.evolution.grhs !== null && recipePath !== null) {
    throw new ProtocolError('GRHS Group Controller MVP 不能与 Population EvolutionRecipe 同时启用')
  }
  if (experiment.evolution.grhs !== null && experiment.adapters.strategy !== null) {
    throw new ProtocolError('GRHS Group Controller 自己调度 sibling MutationPlan，不能同时指定单 Plan SearchStrategy')
  }
  if (recipe.spec.moduleSearch.riskCeiling !== experiment.evolution.mutationLevel) {
    throw new ProtocolError('Evolution Recipe 风险上限与旧 mutationLevel 不一致')
  }
  if (recipe.spec.moduleSearch.authority === 'strategy-directed'
      && recipe.spec.moduleSearch.strategy !== strategy.id) {
    throw new ProtocolError('Evolution Recipe 的 Module Search Strategy 与 Adapter 不一致', [
      `recipe=${recipe.spec.moduleSearch.strategy}`,
      `adapter=${strategy.id}`,
    ])
  }
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
    provider.credentials.apiKeyEnvironment,
    provider.credentials.baseUrlEnvironment,
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
  for (const [label, model] of [
    ['Solver', experiment.models.solver],
    ['Updater', experiment.models.updater],
  ]) {
    if (model.provider !== provider.id) {
      throw new ProtocolError(`${label} Model 引用了未加载的 Provider`, [
        `model.provider=${model.provider}`,
        `adapter=${provider.id}`,
      ])
    }
    if (!provider.models.some((item) => item.id === model.model)) {
      throw new ProtocolError(`${label} Model 不在 Provider 固定目录中：${model.model}`)
    }
  }
  const resolvedEnvironment = {
    ...environment,
    modelGateway: {
      ...environment.modelGateway,
      upstreamApiKeyEnvironment: provider.credentials.apiKeyEnvironment,
      upstreamBaseUrlEnvironment: provider.credentials.baseUrlEnvironment,
    },
  }
  return {
    experimentPath: relativeExperimentPath,
    experiment,
    recipe,
    target,
    updater,
    environment: resolvedEnvironment,
    provider,
    strategy,
    benchmark,
    policy,
  }
}

export async function validateAnyAdapter(input) {
  if (!isObject(input) || !hasText(input.kind)) throw new ProtocolError('Adapter 配置缺少 kind')
  if (input.kind === 'TargetAdapter') return validateTargetAdapter(input)
  if (input.kind === 'UpdaterAdapter') return validateUpdaterAdapter(input)
  if (input.kind === 'ModelProviderAdapter') return validateModelProviderAdapter(input)
  if (input.kind === 'EnvironmentAdapter') return validateEnvironmentAdapter(input)
  if (input.kind === 'SearchStrategyAdapter') return validateSearchStrategyAdapter(input)
  if (input.kind === 'EvolutionExperiment') return validateExperiment(input)
  throw new ProtocolError(`不支持校验 kind=${input.kind}`)
}
