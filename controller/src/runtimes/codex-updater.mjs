import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

import { validateModelGatewayEnvironment } from '../cowork-model-gateway.mjs'
import { MODEL_GATEWAY_RELAY_URL } from '../model-gateway-relay.mjs'
import { ProtocolError, readJsonFile } from '../protocol.mjs'
import { runProcess } from '../subprocess.mjs'
import {
  UPDATER_SANDBOX_PATHS,
  buildUpdaterInvocation,
} from '../updater-runner.mjs'
import { startModelGateway } from '../model-gateway.mjs'
import { stageUpdaterContext } from './dsh.mjs'

const REPORT_MAXIMUM_BYTES = 256 * 1024
const ROOT_SANDBOX_UID = 65_534
const ROOT_SANDBOX_GID = 65_534

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function regularPath(pathValue, label, kind = 'file') {
  let info
  try {
    info = await lstat(pathValue)
  } catch (error) {
    throw new ProtocolError(`${label} 不可用`, [error.message])
  }
  if (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())) {
    throw new ProtocolError(`${label} 必须是普通${kind === 'file' ? '文件' : '目录'}`)
  }
  return info
}

async function chownTree(pathValue, uid, gid) {
  const info = await lstat(pathValue)
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new ProtocolError('根 Controller 禁止向 Updater 移交符号链接或特殊文件', [pathValue])
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(pathValue)) {
      await chownTree(join(pathValue, entry), uid, gid)
    }
  }
  await chown(pathValue, uid, gid)
}

async function attestRootSandboxLauncher() {
  let maximumUserNamespaces
  try {
    maximumUserNamespaces = (await readFile('/proc/sys/user/max_user_namespaces', 'utf8')).trim()
  } catch (error) {
    throw new ProtocolError('root Controller 无法核验 user namespace 上限', [error.message])
  }
  if (maximumUserNamespaces !== '0') {
    throw new ProtocolError('root Controller 只能在禁用嵌套 user namespace 的宿主启动 Updater', [
      `user.max_user_namespaces=${maximumUserNamespaces}`,
    ])
  }
}

async function checkedProcess(options, label) {
  const result = await runProcess(options)
  if (!result.ok) {
    throw new ProtocolError(`${label}失败`, [
      result.stderr.slice(-4_000),
      result.stdout.slice(-2_000),
    ].filter(Boolean))
  }
  return result
}

async function distributionDigest(root) {
  const files = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathValue = join(directory, entry.name)
      if (entry.isDirectory()) await walk(pathValue)
      else if (entry.isFile()) files.push(pathValue)
      else throw new ProtocolError('Codex distribution 禁止符号链接或特殊文件', [pathValue])
    }
  }
  await walk(root)
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right), 'en'))
  const hash = createHash('sha256')
  for (const pathValue of files) {
    hash.update(relative(root, pathValue).replaceAll('\\', '/'))
    hash.update('\0')
    for await (const chunk of createReadStream(pathValue)) hash.update(chunk)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function inspectCodexRuntime(runtime) {
  const [executable, distributionRoot] = await Promise.all([
    realpath(runtime.executable),
    realpath(runtime.distributionRoot),
  ])
  await Promise.all([
    regularPath(executable, 'Codex executable'),
    regularPath(distributionRoot, 'Codex distribution', 'directory'),
    regularPath(runtime.nodeBinary, 'Codex Node runtime'),
    regularPath(runtime.bwrapPath, 'Codex Bubblewrap'),
    regularPath(runtime.setprivPath, 'Codex setpriv'),
  ])
  if (!inside(distributionRoot, executable)) {
    throw new ProtocolError('Codex executable 不在固定 distribution 内')
  }
  const packageMetadata = await readJsonFile(join(distributionRoot, 'package.json'))
  if (packageMetadata.name !== runtime.package || packageMetadata.version !== runtime.version) {
    throw new ProtocolError('Codex distribution 与 Adapter 固定版本不一致', [
      `adapter=${runtime.package}@${runtime.version}`,
      `actual=${packageMetadata.name ?? '(missing)'}@${packageMetadata.version ?? '(missing)'}`,
    ])
  }
  const actualDigest = await distributionDigest(distributionRoot)
  if (actualDigest !== runtime.distributionDigest) {
    throw new ProtocolError('Codex distribution 内容摘要与 Adapter 不一致', [
      `expected=${runtime.distributionDigest}`,
      `actual=${actualDigest}`,
    ])
  }
  const version = await checkedProcess({
    command: runtime.nodeBinary,
    args: [executable, '--version'],
    cwd: distributionRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeoutMs: 30_000,
    outputLimitBytes: 64 * 1024,
  }, 'Codex 版本核验')
  if (version.stdout.trim() !== `codex-cli ${runtime.version}`) {
    throw new ProtocolError('Codex executable 报告的版本与 Adapter 不一致', [
      `expected=codex-cli ${runtime.version}`,
      `actual=${version.stdout.trim()}`,
    ])
  }
  return Object.freeze({
    executable,
    distributionRoot,
    version: runtime.version,
    distributionDigest: actualDigest,
  })
}

function gitEnvironment() {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Harness RSI Controller',
    GIT_AUTHOR_EMAIL: 'harness-rsi@localhost',
    GIT_COMMITTER_NAME: 'Harness RSI Controller',
    GIT_COMMITTER_EMAIL: 'harness-rsi@localhost',
  }
}

async function initializeCandidateGit(workspace, gitRoot) {
  try {
    await lstat(gitRoot)
    throw new ProtocolError('Codex Updater Git Root 在 Session 前必须不存在')
  } catch (error) {
    if (error instanceof ProtocolError || error.code !== 'ENOENT') throw error
  }
  const common = {
    cwd: workspace,
    env: gitEnvironment(),
    timeoutMs: 60_000,
    outputLimitBytes: 4 * 1024 * 1024,
  }
  await checkedProcess({
    ...common,
    command: '/usr/bin/git',
    args: ['init', '--bare', gitRoot],
  }, '初始化 Codex Candidate Git')
  const git = async (args, label) => await checkedProcess({
    ...common,
    command: '/usr/bin/git',
    args: [`--git-dir=${gitRoot}`, `--work-tree=${workspace}`, ...args],
  }, label)
  await git(['config', 'core.bare', 'false'], '配置 Codex Candidate Git')
  await git(['config', 'core.worktree', workspace], '配置 Codex Candidate Worktree')
  await git(['add', '--all', '--force'], '暂存 Codex Candidate 基线')
  await git(['commit', '--no-gpg-sign', '-m', 'harness-rsi candidate baseline'], '提交 Codex Candidate 基线')
}

function redactJsonSecrets(value, secrets) {
  let serialized = JSON.stringify(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      serialized = serialized.replaceAll(secret, '[REDACTED]')
    }
  }
  return JSON.parse(serialized)
}

async function readMutationReport(outputDirectory, reportName, secrets) {
  const entries = await readdir(outputDirectory, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].name !== reportName || !entries[0].isFile()) {
    throw new ProtocolError(`Codex Updater 输出目录只允许 ${reportName} 一个普通文件`)
  }
  const pathValue = join(outputDirectory, reportName)
  const info = await lstat(pathValue)
  if (!info.isFile() || info.isSymbolicLink() || info.size > REPORT_MAXIMUM_BYTES) {
    throw new ProtocolError('Codex Mutation Report 必须是小于等于 256 KiB 的普通文件')
  }
  return redactJsonSecrets(await readJsonFile(pathValue), secrets)
}

function codexUpdaterTask({ targetId, mutationLevel, reportName }) {
  return `你正在执行一次受控 Harness RSI Updater Session，目标是改进 ${targetId} Solver，而不是完成某一道 Benchmark 题。

请按顺序阅读：
- ${UPDATER_SANDBOX_PATHS.feedback}/updater.md
- ${UPDATER_SANDBOX_PATHS.feedback}/mutation-policy.json
- ${UPDATER_SANDBOX_PATHS.feedback}/feedback-packet.json
- ${UPDATER_SANDBOX_PATHS.upstream}/ 下的只读上游 Harness 源码
- 当前工作目录中的 Candidate 实现

当前风险上限为 ${mutationLevel.toUpperCase()}。请跨多个反馈案例定位重复失败机制，提出一个可证伪的假设，并在 mutation-policy 允许的 Region 内做最小完整修改。不要硬编码题目、答案或 ID；不要修改 Controller、Evaluator、Benchmark、凭据、资源限制、只读路径或上游源码。不要只给建议，必须实际修改当前 Candidate。

完成后，把严格 JSON 报告写入 ${UPDATER_SANDBOX_PATHS.output}/${reportName}：
{
  "diagnosis": "跨案例诊断",
  "hypothesis": "本轮可证伪假设",
  "changedFiles": ["实际修改的 Candidate 相对路径"],
  "expectedImpact": "预期影响",
  "validation": ["实际执行过的检查"],
  "remainingRisks": "剩余风险"
}

报告目录只允许出现这一个文件。完成修改和报告后，用一句话总结，不要继续处理 Benchmark。`
}

function emptyUsage() {
  return {
    complete: true,
    requests: 0,
    usageResponses: 0,
    unknownUsageResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    observedInputTokens: 0,
    observedOutputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

function recordAudit(usage, record) {
  usage.requests += 1
  const observed = record.usage
  if (!observed
      || !Number.isSafeInteger(observed.inputTokens)
      || !Number.isSafeInteger(observed.outputTokens)) {
    usage.complete = false
    usage.unknownUsageResponses += 1
    usage.inputTokens = null
    usage.outputTokens = null
    usage.totalTokens = null
    usage.cacheReadTokens = null
    usage.reasoningTokens = null
    return
  }
  usage.usageResponses += 1
  usage.observedInputTokens += observed.inputTokens
  usage.observedOutputTokens += observed.outputTokens
  if (!usage.complete) return
  usage.inputTokens += observed.inputTokens
  usage.outputTokens += observed.outputTokens
  usage.totalTokens += observed.totalTokens ?? observed.inputTokens + observed.outputTokens
  usage.cacheReadTokens += observed.cachedInputTokens ?? 0
  usage.reasoningTokens += observed.reasoningOutputTokens ?? 0
}

/**
 * 官方 Codex CLI Updater。模型只经过 Controller-owned Responses Gateway，
 * 文件系统只暴露 Candidate、只读反馈/上游源码和单独的报告目录。
 */
export function createCodexUpdaterDriver({
  updater,
  provider,
  repositoryRoot,
  modelGateway = null,
  execute = runProcess,
  startGateway = startModelGateway,
}) {
  const measuredUsage = emptyUsage()
  let runtimePromise = null

  async function ensureRuntime() {
    runtimePromise ??= inspectCodexRuntime(updater.runtime)
    return await runtimePromise
  }

  return {
    id: updater.protocol,
    async ensureRuntime() {
      const runtime = await ensureRuntime()
      return {
        executable: runtime.executable,
        package: updater.runtime.package,
        version: runtime.version,
        distributionDigest: runtime.distributionDigest,
        built: false,
      }
    },
    async stageContext(options) {
      const reportName = basename(options.promptVariables['output.mutationReportPath'])
      return await stageUpdaterContext({
        ...options,
        promptVariables: {
          ...options.promptVariables,
          'output.mutationReportPath': `${UPDATER_SANDBOX_PATHS.output}/${reportName}`,
        },
      })
    },
    async run(options) {
      if (!modelGateway) throw new ProtocolError('Codex Updater 运行必须与 Solver 隔离网关协同')
      const runtime = await ensureRuntime()
      const { apiKey, baseUrl } = validateModelGatewayEnvironment({
        upstreamApiKeyEnvironment: provider.credentials.apiKeyEnvironment,
        upstreamBaseUrlEnvironment: provider.credentials.baseUrlEnvironment,
      })
      if (options.model.provider !== provider.id) {
        throw new ProtocolError('Codex Updater Model 与 Provider Adapter 不匹配')
      }
      const reportName = basename(options.reportName)
      if (reportName !== options.reportName) throw new ProtocolError('Codex Mutation Report name 必须是单个文件名')
      await Promise.all([
        mkdir(options.outputDirectory, { recursive: true }),
        mkdir(options.dshHome, { recursive: true }),
      ])
      if ((await readdir(options.outputDirectory)).length !== 0) {
        throw new ProtocolError('Codex Updater 输出目录在 Session 前必须为空')
      }

      const candidateRoot = dirname(options.candidateWorkspace)
      const gitRoot = join(candidateRoot, 'updater-codex.git')
      const evolutionLogPath = join(candidateRoot, 'updater-evolution-log.jsonl')
      await writeFile(evolutionLogPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o400 })
      await initializeCandidateGit(options.candidateWorkspace, gitRoot)

      const shortRunRoot = await mkdtemp(join(tmpdir(), 'harness-rsi-codex-'))
      await chmod(shortRunRoot, 0o700)
      await Promise.all([
        mkdir(join(shortRunRoot, 'home'), { mode: 0o700 }),
        mkdir(join(shortRunRoot, 'tmp'), { mode: 0o700 }),
      ])
      const dummyKey = `rsi-${randomBytes(24).toString('base64url')}`
      const socketPath = join(shortRunRoot, 'model-gateway.sock')
      const controllerUid = process.getuid?.()
      const controllerGid = process.getgid?.()
      if (!Number.isInteger(controllerUid) || controllerUid < 0
          || !Number.isInteger(controllerGid) || controllerGid < 0) {
        throw new ProtocolError('Codex Updater 拒绝以未知宿主身份运行')
      }
      const privilegedLauncher = controllerUid === 0
      const uid = privilegedLauncher ? ROOT_SANDBOX_UID : controllerUid
      const gid = privilegedLauncher ? ROOT_SANDBOX_GID : controllerGid
      if (privilegedLauncher) {
        await attestRootSandboxLauncher()
        await Promise.all([
          chownTree(options.candidateWorkspace, uid, gid),
          chownTree(gitRoot, uid, gid),
          chownTree(options.outputDirectory, uid, gid),
          chownTree(evolutionLogPath, uid, gid),
          chownTree(shortRunRoot, uid, gid),
        ])
      }

      let gateway
      let result
      try {
        // Feedback 可能包含 Solver 曾见过的短期令牌；进入 Updater 前先撤销。
        await modelGateway.rotateRoleToken('solver')
        gateway = await startGateway({
          upstreamBaseUrl: baseUrl,
          getApiKey: async () => apiKey,
          trustedModel: options.model.model,
          trustedReasoningEffort: options.model.reasoningEffort ?? 'high',
          maxOutputTokens: options.model.maxTokens,
          maxRequests: updater.runtime.maximumModelRequests,
          maxConcurrency: 1,
          candidateApiKey: dummyKey,
          socketPath,
          publicUrl: MODEL_GATEWAY_RELAY_URL,
          socketUid: uid,
          socketGid: gid,
          audit: async (record) => recordAudit(measuredUsage, record),
        })
        const invocation = buildUpdaterInvocation({
          backend: 'codex-cli',
          nodeBinary: updater.runtime.nodeBinary,
          updaterRuntime: runtime.distributionRoot,
          codexPath: runtime.executable,
          codexDistributionRoot: runtime.distributionRoot,
          updaterProvider: updater.runtime.providerId,
          updaterModel: options.model.model,
          updaterReasoningEffort: options.model.reasoningEffort ?? 'high',
          candidateRoot: options.candidateWorkspace,
          gitRoot,
          runRoot: shortRunRoot,
          runtimePatch: join(repositoryRoot, 'controller/src/codex-updater.runtime-placeholder'),
          gatewayRelayPath: join(repositoryRoot, 'controller/src/model-gateway-relay.mjs'),
          gatewayUrl: gateway.url,
          gatewaySocketPath: gateway.socketPath,
          gatewayDummyKey: dummyKey,
          prompt: codexUpdaterTask({
            targetId: options.targetId,
            mutationLevel: options.mutationLevel,
            reportName,
          }),
          uid,
          gid,
          feedbackRoot: options.contextDirectory,
          upstreamRoot: options.upstreamSource,
          outputRoot: options.outputDirectory,
          evolutionLogPath,
          peerLogs: [],
          bwrapPath: updater.runtime.bwrapPath,
          setprivPath: updater.runtime.setprivPath,
          // 普通宿主用户保留已核验的附加组；root Controller 则由
          // Bubblewrap 建立边界后降到专用的无特权 UID/GID。
          preserveSupplementaryGroups: !privilegedLauncher,
          privilegedLauncher,
          baseEnv: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TZ: 'UTC',
          },
        })
        result = await execute({
          ...invocation,
          timeoutMs: options.timeoutMs,
          outputLimitBytes: 16 * 1024 * 1024,
          secretValues: [apiKey, dummyKey],
        })
        if (!result.ok) {
          const error = new ProtocolError('Codex Updater 执行失败', [
            result.timedOut ? 'reason=timeout' : `exitCode=${result.exitCode}`,
            result.stderr.slice(-4_000),
            result.stdout.slice(-2_000),
          ].filter(Boolean))
          error.kind = result.timedOut || result.aborted ? 'infrastructure' : 'updater_failure'
          throw error
        }
        const report = await readMutationReport(options.outputDirectory, reportName, [apiKey, dummyKey])
        return {
          report,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          outputTruncated: result.outputExceeded,
        }
      } finally {
        if (gateway) await gateway.close().catch(() => {})
        await rm(shortRunRoot, { recursive: true, force: true }).catch(() => {})
      }
    },
    usage() {
      return structuredClone(measuredUsage)
    },
  }
}
