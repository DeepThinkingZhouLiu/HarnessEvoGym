import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { validateModelGatewayEnvironment } from '../cowork-model-gateway.mjs'
import { MODEL_GATEWAY_RELAY_URL } from '../model-gateway-relay.mjs'
import { startModelGateway } from '../model-gateway.mjs'
import { ProtocolError } from '../protocol.mjs'
import { runProcess } from '../subprocess.mjs'
import {
  UPDATER_SANDBOX_PATHS,
  buildUpdaterInvocation,
} from '../updater-runner.mjs'
import {
  cliUpdaterTask,
  createCliUsageLedger,
  initializeCliCandidateGit,
  inspectCliUpdaterRuntime,
  readCliMutationReport,
  recordCliUsageAudit,
} from './cli-updater-common.mjs'
import { stageUpdaterContext } from './dsh.mjs'

/**
 * 固定版本 Claude Code CLI Updater。Claude 只看到本地 Anthropic Messages
 * Gateway 的假凭据；真实 ZCloud Key 始终留在 Controller 进程。
 */
export function createClaudeCodeUpdaterDriver({
  updater,
  provider,
  repositoryRoot,
  modelGateway = null,
  execute = runProcess,
  startGateway = startModelGateway,
}) {
  const measuredUsage = createCliUsageLedger()
  let runtimePromise = null

  async function ensureRuntime() {
    runtimePromise ??= inspectCliUpdaterRuntime(updater.runtime, {
      label: 'Claude Code',
      versionCommand: (executable) => executable,
      versionArgs: () => ['--version'],
      expectedVersionOutput: (version) => `${version} (Claude Code)`,
    })
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
      if (!modelGateway) throw new ProtocolError('Claude Code Updater 运行必须与 Solver 隔离网关协同')
      if (provider.protocol !== 'anthropic-messages') {
        throw new ProtocolError('Claude Code Updater 必须使用 Anthropic Messages Provider')
      }
      const runtime = await ensureRuntime()
      const { apiKey, baseUrl } = validateModelGatewayEnvironment({
        upstreamApiKeyEnvironment: provider.credentials.apiKeyEnvironment,
        upstreamBaseUrlEnvironment: provider.credentials.baseUrlEnvironment,
      })
      if (options.model.provider !== provider.id) {
        throw new ProtocolError('Claude Code Updater Model 与 Provider Adapter 不匹配')
      }
      const reportName = basename(options.reportName)
      if (reportName !== options.reportName) {
        throw new ProtocolError('Claude Code Mutation Report name 必须是单个文件名')
      }
      await Promise.all([
        mkdir(options.outputDirectory, { recursive: true }),
        mkdir(options.dshHome, { recursive: true }),
      ])
      if ((await readdir(options.outputDirectory)).length !== 0) {
        throw new ProtocolError('Claude Code Updater 输出目录在 Session 前必须为空')
      }

      const candidateRoot = dirname(options.candidateWorkspace)
      const gitRoot = join(candidateRoot, 'updater-claude-code.git')
      const evolutionLogPath = join(candidateRoot, 'updater-evolution-log.jsonl')
      await writeFile(evolutionLogPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o400 })
      await initializeCliCandidateGit(options.candidateWorkspace, gitRoot, 'Claude Code')

      const shortRunRoot = await mkdtemp(join(tmpdir(), 'harness-rsi-claude-'))
      await chmod(shortRunRoot, 0o700)
      await Promise.all([
        mkdir(join(shortRunRoot, 'home'), { mode: 0o700 }),
        mkdir(join(shortRunRoot, 'tmp'), { mode: 0o700 }),
      ])
      const dummyKey = `rsi-${randomBytes(24).toString('base64url')}`
      const socketPath = join(shortRunRoot, 'model-gateway.sock')
      const uid = process.getuid?.()
      const gid = process.getgid?.()
      if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
        throw new ProtocolError('Claude Code Updater 拒绝以 root 或未知宿主身份运行')
      }

      let gateway
      let result
      try {
        await modelGateway.rotateRoleToken('solver')
        gateway = await startGateway({
          wireProtocol: 'anthropic-messages',
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
          audit: async (record) => recordCliUsageAudit(measuredUsage, record),
        })
        const invocation = buildUpdaterInvocation({
          backend: 'claude-code-cli',
          nodeBinary: updater.runtime.nodeBinary,
          updaterRuntime: runtime.distributionRoot,
          claudeCodePath: runtime.executable,
          claudeCodeDistributionRoot: runtime.distributionRoot,
          updaterModel: options.model.model,
          updaterReasoningEffort: options.model.reasoningEffort ?? 'high',
          candidateRoot: options.candidateWorkspace,
          gitRoot,
          runRoot: shortRunRoot,
          runtimePatch: join(repositoryRoot, 'controller/src/claude-code-updater.runtime-placeholder'),
          gatewayRelayPath: join(repositoryRoot, 'controller/src/model-gateway-relay.mjs'),
          gatewayUrl: gateway.url,
          gatewaySocketPath: gateway.socketPath,
          gatewayDummyKey: dummyKey,
          prompt: cliUpdaterTask({
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
          preserveSupplementaryGroups: true,
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
          const error = new ProtocolError('Claude Code Updater 执行失败', [
            result.timedOut ? 'reason=timeout' : `exitCode=${result.exitCode}`,
            result.stderr.slice(-4_000),
            result.stdout.slice(-2_000),
          ].filter(Boolean))
          error.kind = result.timedOut || result.aborted ? 'infrastructure' : 'updater_failure'
          throw error
        }
        const report = await readCliMutationReport(
          options.outputDirectory,
          reportName,
          [apiKey, dummyKey],
          'Claude Code',
        )
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
