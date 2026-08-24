import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { normalizeRelativePath } from '../path-policy.mjs'
import { ProtocolError, readJsonFile } from '../protocol.mjs'

function dshProviderApi(protocol) {
  if (protocol === 'openai-chat-completions') return 'openai-completions'
  throw new ProtocolError(`DSH Runtime 未实现 Provider Protocol：${protocol}`)
}

// Agent 的真正边界是外层 Docker：只读根、精确挂载、能力裁剪和内部网络。
// DSH 内层已设为 danger-full-access，再保留 sandbox executor 只会向模型暴露
// 不可用的“从最高权限继续升级”参数。Terra 会补全这些可选参数，使工具调用
// 在执行前被 DSH 拒绝。用 Home Patch 换成同一能力 seam 的 local provider，
// Solver 和 Updater 共用这一固定适配，候选 Candidate 不能修改它。
const HEADLESS_DOCKER_PATCH = [
  { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox', disabled: true },
  { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox', disabled: true },
  { id: 'permission', name: '@deepseek-ai/dsh-permission-presets', disabled: true },
  {
    insert: [
      { id: 'bash-local', name: '@deepseek-ai/dsh-bash-local' },
      { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local' },
    ],
  },
]

async function prepareDshHome(dshHome, model, provider, modelAccess) {
  await mkdir(join(dshHome, '.agent-presets'), { recursive: true })
  if (model.provider !== provider.id) {
    throw new ProtocolError('DSH Model 与当前 Provider Adapter 不匹配', [
      `model.provider=${model.provider}`,
      `adapter=${provider.id}`,
    ])
  }
  const catalogModel = provider.models.find((item) => item.id === model.model)
  if (!catalogModel) throw new ProtocolError(`DSH Model 不在 Provider 固定目录中：${model.model}`)
  const baseURL = modelAccess.environment[provider.credentials.baseUrlEnvironment]
  if (!baseURL) throw new ProtocolError('Model Gateway 未向 DSH 提供内部 Base URL')
  const settings = {
    'agent-default-model': {
      provider: provider.id,
      model: model.model,
    },
    'llm-pi-ai': {
      providers: {
        [provider.id]: {
          displayName: provider.name,
          apiKeyEnv: provider.credentials.apiKeyEnvironment,
          api: dshProviderApi(provider.protocol),
          baseURL,
          compat: provider.compatibility,
          defaultContextWindow: provider.defaultContextWindow,
          models: [{
            id: catalogModel.id,
            name: catalogModel.name,
            contextWindow: catalogModel.contextWindow ?? provider.defaultContextWindow,
            maxTokens: model.maxTokens,
          }],
        },
      },
    },
  }
  await Promise.all([
    writeFile(join(dshHome, 'settings.yaml'), stringifyYaml(settings), { encoding: 'utf8', mode: 0o600 }),
    writeFile(join(dshHome, 'cordis.patch.yml'), stringifyYaml(HEADLESS_DOCKER_PATCH), {
      encoding: 'utf8',
      mode: 0o600,
    }),
  ])
}

function runtimeEnvironment(dshHome = '/dsh-home', cwd = '/workspace') {
  return {
    DSH_HOME: dshHome,
    DSH_CWD: cwd,
    // Headless 没有人类审批通道；权限边界由外层 Docker 和 Diff Guard 强制。
    DSH_PERMISSION_MODE: 'danger-full-access',
    HOME: '/tmp/home',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  }
}

function redactJsonSecrets(value, secrets) {
  let serialized = JSON.stringify(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) serialized = serialized.replaceAll(secret, '[REDACTED]')
  }
  return JSON.parse(serialized)
}

export async function buildDshRuntime({
  docker,
  runtime,
  repositoryRoot,
  sourceRevision,
  sourcePath,
  baseImage = 'debian:bookworm-slim',
  baseImageIdentity = baseImage,
  definitionDigest,
  tag,
}) {
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) throw new ProtocolError('DSH Source Revision 必须是完整 Git SHA')
  const normalizedSourcePath = normalizeRelativePath(sourcePath, 'DSH Source Path')
  if (/\s/u.test(normalizedSourcePath)) throw new ProtocolError('DSH Source Path 不能包含空白字符')
  const resolvedDefinitionDigest = definitionDigest ?? await dshRuntimeDefinitionDigest(repositoryRoot, runtime.dockerfile)
  return await docker.build({
    context: repositoryRoot,
    dockerfile: join(repositoryRoot, runtime.dockerfile),
    tag: tag ?? runtime.image,
    buildArgs: {
      BASE_IMAGE: baseImage,
      DSH_PACKAGE: runtime.package,
      DSH_VERSION: runtime.version,
      DSH_SOURCE_REVISION: sourceRevision,
      DSH_SOURCE_PATH: normalizedSourcePath,
      DSH_RUNTIME_DEFINITION_DIGEST: resolvedDefinitionDigest,
      DSH_BASE_IMAGE_IDENTITY: baseImageIdentity,
    },
  })
}

export async function ensureDshRuntime(options) {
  const image = options.tag ?? options.runtime.image
  const definitionDigest = await dshRuntimeDefinitionDigest(options.repositoryRoot, options.runtime.dockerfile)
  const baseImageIdentity = options.baseImageIdentity ?? options.baseImage ?? 'debian:bookworm-slim'
  if (await options.docker.imageExists(image)) {
    const revision = await options.docker.imageLabel(image, 'org.opencontainers.image.revision')
    const packageName = await options.docker.imageLabel(image, 'io.harness-rsi.dsh-package')
    const version = await options.docker.imageLabel(image, 'io.harness-rsi.dsh-version')
    const sourcePath = await options.docker.imageLabel(image, 'io.harness-rsi.dsh-source-path')
    const imageDefinitionDigest = await options.docker.imageLabel(image, 'io.harness-rsi.runtime-definition-digest')
    const imageBaseIdentity = await options.docker.imageLabel(image, 'io.harness-rsi.base-image-identity')
    if (
      revision === options.sourceRevision &&
      packageName === options.runtime.package &&
      version === options.runtime.version &&
      sourcePath === options.sourcePath &&
      imageDefinitionDigest === definitionDigest &&
      imageBaseIdentity === baseImageIdentity
    ) {
      return { image, built: false }
    }
  }
  await buildDshRuntime({ ...options, definitionDigest, baseImageIdentity })
  return { image, built: true }
}

async function dshRuntimeDefinitionDigest(repositoryRoot, dockerfile) {
  const normalizedDockerfile = normalizeRelativePath(dockerfile, 'DSH Runtime Dockerfile')
  const definitionRoot = join(repositoryRoot, dirname(normalizedDockerfile))
  const hash = createHash('sha256')
  let definitionRootInfo
  try {
    definitionRootInfo = await lstat(definitionRoot)
  } catch (error) {
    throw new ProtocolError('DSH Runtime 定义目录不可读', [error.message])
  }
  if (definitionRootInfo.isSymbolicLink() || !definitionRootInfo.isDirectory()) {
    throw new ProtocolError(`DSH Runtime 定义根目录必须是普通目录：${dirname(normalizedDockerfile)}`)
  }

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      const pathValue = relative(repositoryRoot, absolute).replaceAll('\\', '/')
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new ProtocolError(`DSH Runtime 定义包含非普通文件：${pathValue}`)
      }
      if (info.isDirectory()) {
        await visit(absolute)
        continue
      }
      hash.update(`${pathValue}\0${info.mode & 0o111}\0`)
      hash.update(await readFile(absolute))
      hash.update('\0')
    }
  }

  await visit(definitionRoot)
  try {
    const dockerignore = join(repositoryRoot, '.dockerignore')
    hash.update('.dockerignore\0')
    hash.update(await readFile(dockerignore))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    hash.update('.dockerignore\0(missing)')
  }
  return hash.digest('hex')
}

export async function runDshSolver({
  docker,
  runtime,
  image,
  model,
  provider,
  candidatePreset,
  workspace,
  dshHome,
  benchmarkSkills,
  modelAccess,
  task,
  name,
  timeoutMs,
  containerWorkspace = '/workspace',
}) {
  const environment = runtimeEnvironment('/dsh-home', containerWorkspace)
  const mounts = [
    { source: workspace, target: containerWorkspace, readOnly: false },
    { source: dshHome, target: '/dsh-home', readOnly: false },
    {
      source: candidatePreset,
      target: `/dsh-home/.agent-presets/${runtime.preset}`,
      readOnly: true,
    },
  ]
  if (benchmarkSkills !== undefined) {
    mounts.push({ source: benchmarkSkills, target: '/benchmark-skills', readOnly: true })
    environment.DSH_BUNDLED_SKILL_DIR = '/benchmark-skills'
  }
  if (!modelAccess) throw new ProtocolError('DSH Solver 缺少 Model Gateway Access')
  for (const nameValue of runtime.secretEnvironment) {
    if (!modelAccess.environment[nameValue] && !modelAccess.secretEnvironment[nameValue]) {
      throw new ProtocolError(`Model Gateway 未提供 Solver 环境变量：${nameValue}`)
    }
  }
  await prepareDshHome(dshHome, model, provider, modelAccess)
  Object.assign(environment, modelAccess.environment)
  const result = await docker.run({
    image,
    name,
    // SkillsBench 指令会以 YAML front matter 的 `---` 开头；用 `--` 明确结束
    // Headless 选项解析，避免 Commander 把任务正文当成未知选项。
    command: ['dsh', '--profile', runtime.profile, '--preset', runtime.preset, '--', task],
    workdir: containerWorkspace,
    mounts,
    environment,
    secretEnvironment: modelAccess.secretEnvironment,
    inheritEnvironment: [],
    network: modelAccess.network,
    timeoutMs,
  })
  return {
    answer: result.stdout.trim(),
    stderr: result.stderr,
    durationMs: result.durationMs,
    outputTruncated: result.outputTruncated,
  }
}

function updaterTask({ level, targetId, reportName }) {
  return `你正在执行一次受控 RSI Updater Session，目标是改进 ${targetId} 的 Cowork Solver。

当前唯一允许的变异层级是 ${level.toUpperCase()}。请先阅读：
- .rsi-context/updater.md：工作方法与禁止事项
- .rsi-context/mutation-policy.json：机器强制执行的写入白名单
- .rsi-context/feedback-packet.json：上一轮 Feedback 任务的脱敏证据
- .rsi-context/upstream/：只读的 DeepSeek Harness 上游源码，用于理解接口

你只能修改当前 /candidate 下符合 mutation-policy 的 Candidate 文件。不要修改、复制或试图绕过 .rsi-context；不要读取任何隐藏任务，因为容器内也不会提供它们。请横向分析多个案例，提出一个可证伪的改进假设，然后做最小完整修改。

完成后必须把 JSON Mutation Report 写到 .rsi-output/${reportName}，格式严格为：
{
  "diagnosis": "跨案例诊断",
  "hypothesis": "本轮可证伪假设",
  "changedFiles": ["相对 /candidate 的实际改动路径"],
  "expectedImpact": "预期影响",
  "validation": ["实际执行过的检查；没有则为空数组"],
  "remainingRisks": "剩余风险"
}

不要只解释方案；请实际完成允许范围内的文件修改和报告。`
}

export async function runDshUpdater({
  docker,
  runtime,
  image,
  model,
  provider,
  candidateWorkspace,
  upstreamSource,
  contextDirectory,
  outputDirectory,
  dshHome,
  modelAccess,
  mutationLevel,
  targetId,
  reportName,
  name,
  timeoutMs,
}) {
  if (!modelAccess) throw new ProtocolError('DSH Updater 缺少 Model Gateway Access')
  for (const nameValue of runtime.secretEnvironment) {
    if (!modelAccess.environment[nameValue] && !modelAccess.secretEnvironment[nameValue]) {
      throw new ProtocolError(`Model Gateway 未提供 Updater 环境变量：${nameValue}`)
    }
  }
  await prepareDshHome(dshHome, model, provider, modelAccess)
  await mkdir(join(candidateWorkspace, '.rsi-context'), { recursive: true })
  await mkdir(join(candidateWorkspace, '.rsi-output'), { recursive: true })
  await mkdir(join(contextDirectory, 'upstream'), { recursive: true })
  await mkdir(outputDirectory, { recursive: true })
  const reportPath = join(outputDirectory, basename(reportName))
  const existingOutputs = await readdir(outputDirectory)
  if (existingOutputs.length > 0) {
    throw new ProtocolError('Updater 输出目录在 Session 前必须为空', existingOutputs)
  }

  const result = await docker.run({
    image,
    name,
    command: [
      'dsh',
      '--profile',
      runtime.profile,
      '--preset',
      runtime.preset,
      '--',
      updaterTask({ level: mutationLevel, targetId, reportName: basename(reportName) }),
    ],
    workdir: '/candidate',
    mounts: [
      { source: candidateWorkspace, target: '/candidate', readOnly: false },
      { source: contextDirectory, target: '/candidate/.rsi-context', readOnly: true },
      { source: upstreamSource, target: '/candidate/.rsi-context/upstream', readOnly: true },
      // DSH write 会通过同目录临时文件 + rename 原子写入；单文件 bind mount 会返回 EBUSY。
      // 因此挂载独立输出目录，并在 Session 后强制目录里只能存在约定的普通 JSON 文件。
      { source: outputDirectory, target: '/candidate/.rsi-output', readOnly: false },
      { source: dshHome, target: '/dsh-home', readOnly: false },
    ],
    environment: {
      ...runtimeEnvironment('/dsh-home', '/candidate'),
      ...modelAccess.environment,
    },
    secretEnvironment: modelAccess.secretEnvironment,
    inheritEnvironment: [],
    network: modelAccess.network,
    timeoutMs,
  })

  let report
  try {
    const outputEntries = await readdir(outputDirectory, { withFileTypes: true })
    if (
      outputEntries.length !== 1 ||
      outputEntries[0].name !== basename(reportName) ||
      !outputEntries[0].isFile()
    ) {
      throw new Error(`Updater 输出目录只允许 ${basename(reportName)} 一个普通文件`)
    }
    const reportInfo = await lstat(reportPath)
    if (!reportInfo.isFile() || reportInfo.size > 256 * 1024) {
      throw new Error('Mutation Report 必须是小于等于 256 KiB 的普通文件')
    }
    report = redactJsonSecrets(
      await readJsonFile(reportPath),
      Object.values(modelAccess.secretEnvironment),
    )
  } catch (error) {
    throw new ProtocolError('Updater 未生成合法 Mutation Report', [error.message, result.stdout.slice(-2000)])
  }
  return {
    report,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    outputTruncated: result.outputTruncated,
  }
}

export function renderUpdaterPrompt(template, variables) {
  const prompt = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_match, key) => {
    if (!Object.hasOwn(variables, key)) throw new ProtocolError(`Updater Prompt 包含未知模板变量：${key}`)
    return String(variables[key])
  })
  if (/\{\{[^{}]+\}\}/u.test(prompt)) throw new ProtocolError('Updater Prompt 存在未渲染模板变量')
  return prompt
}

export async function stageUpdaterContext({
  destination,
  promptPath,
  promptVariables,
  feedbackPacket,
  mutationPolicy,
}) {
  await mkdir(destination, { recursive: true })
  const template = await readFile(promptPath, 'utf8')
  const prompt = renderUpdaterPrompt(template, promptVariables)
  await Promise.all([
    writeFile(join(destination, 'updater.md'), prompt, { encoding: 'utf8', mode: 0o444 }),
    writeFile(join(destination, 'feedback-packet.json'), `${JSON.stringify(feedbackPacket, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o444,
    }),
    writeFile(join(destination, 'mutation-policy.json'), `${JSON.stringify(mutationPolicy, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o444,
    }),
  ])
}
