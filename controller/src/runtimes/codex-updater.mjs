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
import { ProtocolError } from '../protocol.mjs'
import { runProcess } from '../subprocess.mjs'
import {
  UPDATER_SANDBOX_PATHS,
  buildUpdaterInvocation,
} from '../updater-runner.mjs'
import { startModelGateway } from '../model-gateway.mjs'
import { stageUpdaterContext } from './dsh.mjs'
import {
  cliUpdaterTask,
  createCliUsageLedger,
  initializeCliCandidateGit,
  inspectCliUpdaterRuntime,
  readCliMutationReport,
  recordCliUsageAudit,
} from './cli-updater-common.mjs'

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
  const measuredUsage = createCliUsageLedger()
  let runtimePromise = null

  async function ensureRuntime() {
    runtimePromise ??= inspectCliUpdaterRuntime(updater.runtime, {
      label: 'Codex',
      versionCommand: () => updater.runtime.nodeBinary,
      versionArgs: (executable) => [executable, '--version'],
      expectedVersionOutput: (version) => `codex-cli ${version}`,
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
      await initializeCliCandidateGit(options.candidateWorkspace, gitRoot, 'Codex')

      const shortRunRoot = await mkdtemp(join(tmpdir(), 'harness-rsi-codex-'))
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
        throw new ProtocolError('Codex Updater 拒绝以 root 或未知宿主身份运行')
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
          audit: async (record) => recordCliUsageAudit(measuredUsage, record),
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
          // 本 Driver 在普通宿主用户下运行，setgroups 对非 root 不可用；
          // UID/GID 已核验为当前身份，保留附加组不扩大空根 Bubblewrap 的挂载边界。
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
          const error = new ProtocolError('Codex Updater 执行失败', [
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
          'Codex',
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
