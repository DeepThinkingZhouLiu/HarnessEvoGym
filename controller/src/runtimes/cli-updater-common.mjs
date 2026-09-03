import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { ProtocolError, readJsonFile } from '../protocol.mjs'
import { runProcess } from '../subprocess.mjs'
import { UPDATER_SANDBOX_PATHS } from '../updater-runner.mjs'

const REPORT_MAXIMUM_BYTES = 256 * 1024

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

async function distributionDigest(root, runtimeLabel) {
  const files = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathValue = join(directory, entry.name)
      if (entry.isDirectory()) await walk(pathValue)
      else if (entry.isFile()) files.push(pathValue)
      else throw new ProtocolError(`${runtimeLabel} distribution 禁止符号链接或特殊文件`, [pathValue])
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

export async function inspectCliUpdaterRuntime(runtime, {
  label,
  versionCommand,
  versionArgs,
  expectedVersionOutput,
}) {
  const [executable, distributionRoot] = await Promise.all([
    realpath(runtime.executable),
    realpath(runtime.distributionRoot),
  ])
  await Promise.all([
    regularPath(executable, `${label} executable`),
    regularPath(distributionRoot, `${label} distribution`, 'directory'),
    regularPath(runtime.nodeBinary, `${label} Node runtime`),
    regularPath(runtime.bwrapPath, `${label} Bubblewrap`),
    regularPath(runtime.setprivPath, `${label} setpriv`),
  ])
  if (!inside(distributionRoot, executable)) {
    throw new ProtocolError(`${label} executable 不在固定 distribution 内`)
  }
  const packageMetadata = await readJsonFile(join(distributionRoot, 'package.json'))
  if (packageMetadata.name !== runtime.package || packageMetadata.version !== runtime.version) {
    throw new ProtocolError(`${label} distribution 与 Adapter 固定版本不一致`, [
      `adapter=${runtime.package}@${runtime.version}`,
      `actual=${packageMetadata.name ?? '(missing)'}@${packageMetadata.version ?? '(missing)'}`,
    ])
  }
  const actualDigest = await distributionDigest(distributionRoot, label)
  if (actualDigest !== runtime.distributionDigest) {
    throw new ProtocolError(`${label} distribution 内容摘要与 Adapter 不一致`, [
      `expected=${runtime.distributionDigest}`,
      `actual=${actualDigest}`,
    ])
  }
  const version = await checkedProcess({
    command: versionCommand(executable),
    args: versionArgs(executable),
    cwd: distributionRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeoutMs: 30_000,
    outputLimitBytes: 64 * 1024,
  }, `${label} 版本核验`)
  if (version.stdout.trim() !== expectedVersionOutput(runtime.version)) {
    throw new ProtocolError(`${label} executable 报告的版本与 Adapter 不一致`, [
      `expected=${expectedVersionOutput(runtime.version)}`,
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

export async function initializeCliCandidateGit(workspace, gitRoot, label) {
  try {
    await lstat(gitRoot)
    throw new ProtocolError(`${label} Updater Git Root 在 Session 前必须不存在`)
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
  }, `初始化 ${label} Candidate Git`)
  const git = async (args, operation) => await checkedProcess({
    ...common,
    command: '/usr/bin/git',
    args: [`--git-dir=${gitRoot}`, `--work-tree=${workspace}`, ...args],
  }, operation)
  await git(['config', 'core.bare', 'false'], `配置 ${label} Candidate Git`)
  await git(['config', 'core.worktree', workspace], `配置 ${label} Candidate Worktree`)
  await git(['add', '--all', '--force'], `暂存 ${label} Candidate 基线`)
  await git(['commit', '--no-gpg-sign', '-m', 'harness-rsi candidate baseline'], `提交 ${label} Candidate 基线`)
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

export async function readCliMutationReport(outputDirectory, reportName, secrets, label) {
  const entries = await readdir(outputDirectory, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].name !== reportName || !entries[0].isFile()) {
    throw new ProtocolError(`${label} Updater 输出目录只允许 ${reportName} 一个普通文件`)
  }
  const pathValue = join(outputDirectory, reportName)
  const info = await lstat(pathValue)
  if (!info.isFile() || info.isSymbolicLink() || info.size > REPORT_MAXIMUM_BYTES) {
    throw new ProtocolError(`${label} Mutation Report 必须是小于等于 256 KiB 的普通文件`)
  }
  return redactJsonSecrets(await readJsonFile(pathValue), secrets)
}

export function cliUpdaterTask({ targetId, mutationLevel, reportName }) {
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

export function createCliUsageLedger() {
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

export function recordCliUsageAudit(usage, record) {
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
