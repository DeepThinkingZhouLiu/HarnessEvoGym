import { readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { relayWrappedInvocation, socatRelayWrappedInvocation } from './model-gateway-relay.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  buildBubblewrapInvocation,
  delegateDshConfinementToOuterSandbox,
  executableDistributionRoot,
} from './sandbox.mjs'
import { runProcess } from './subprocess.mjs'

const SOURCE_WRAPPER = 'process.chdir(process.env.TASK_CWD); await import(process.env.DSH_SOURCE_BIN)'
const SAFE_ENV_KEYS = new Set(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'])
const UPDATER_BACKENDS = new Set(['deepseek-harness', 'codex-cli'])
const CODEX_PROVIDER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u
const CODEX_NATIVE_TARGETS = new Map([
  ['linux:x64', ['codex-linux-x64', 'x86_64-unknown-linux-musl']],
  ['linux:arm64', ['codex-linux-arm64', 'aarch64-unknown-linux-musl']],
])
// The Updater is frozen infrastructure. Only the evaluated Solver uses the
// evolving minimal preset.
export const INFRASTRUCTURE_UPDATER_PRESET = 'standard'

export const UPDATER_SANDBOX_PATHS = Object.freeze({
  runtime: '/opt/harness-rsi/updater-runtime',
  candidate: '/opt/harness-rsi/candidate',
  git: '/opt/harness-rsi/git',
  feedback: '/opt/harness-rsi/feedback',
  evolutionLog: '/opt/harness-rsi/evolution-log.jsonl',
  peerLogs: '/opt/harness-rsi/peer-logs',
  upstream: '/opt/harness-rsi/upstream',
  output: '/opt/harness-rsi/output',
  runtimePatch: '/opt/harness-rsi/runtime.patch.yml',
  nodeToolchain: '/opt/harness-rsi/node-toolchain',
  run: '/work',
  relay: '/opt/harness-rsi/model-gateway-relay.mjs',
})

function lookup(values, dottedPath) {
  let current = values
  for (const part of dottedPath.split('.')) current = current?.[part]
  if (current === undefined || current === null) {
    throw new ProtocolError(`Prompt 缺少模板变量：${dottedPath}`)
  }
  if (Array.isArray(current)) {
    return current.every((entry) => entry === null || typeof entry !== 'object')
      ? current.join(', ')
      : JSON.stringify(current, null, 2)
  }
  if (typeof current === 'object') return JSON.stringify(current, null, 2)
  return String(current)
}

export function renderPrompt(template, values) {
  if (typeof template !== 'string') throw new ProtocolError('Prompt template 必须是字符串')
  const rendered = template.replace(
    /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/gu,
    (_match, path) => lookup(values, path),
  )
  if (/\{\{[^}]+\}\}/u.test(rendered)) throw new ProtocolError('Prompt 含有无法解析的模板变量')
  return rendered
}

function safeBaseEnvironment(baseEnv) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (SAFE_ENV_KEYS.has(key) && typeof value === 'string') env[key] = value
  }
  return env
}

function codexNativeExecutable(root = UPDATER_SANDBOX_PATHS.runtime) {
  const target = CODEX_NATIVE_TARGETS.get(`${process.platform}:${process.arch}`)
  if (target === undefined) throw new ProtocolError('Codex Updater 不支持当前平台')
  const [packageName, triple] = target
  return join(
    root,
    'node_modules', '@openai', packageName, 'vendor', triple, 'bin', 'codex',
  )
}

export function buildUpdaterInvocation({
  backend = 'deepseek-harness',
  nodeBinary,
  updaterRuntime,
  codexPath,
  codexDistributionRoot,
  updaterProvider,
  updaterModel,
  updaterReasoningEffort,
  candidateRoot,
  gitRoot,
  runRoot,
  runtimePatch,
  gatewayUrl,
  gatewayDummyKey,
  gatewaySocketPath,
  prompt,
  uid,
  gid,
  feedbackRoot,
  upstreamRoot,
  outputRoot,
  evolutionLogPath,
  peerLogs = [],
  bwrapPath,
  setprivPath = '/usr/bin/setpriv',
  gatewayRelayPath,
  preserveSupplementaryGroups = false,
  privilegedLauncher = false,
  baseEnv = process.env,
}) {
  if (!UPDATER_BACKENDS.has(backend)) {
    throw new ProtocolError(`未知 Updater backend：${backend}`)
  }
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new ProtocolError('Updater uid/gid 必须是正整数')
  }
  const workspace = resolve(candidateRoot)
  const repository = resolve(gitRoot)
  const feedback = resolve(feedbackRoot)
  const evolutionLog = resolve(evolutionLogPath)
  if (!Array.isArray(peerLogs)) throw new ProtocolError('Updater peerLogs 必须是数组')
  const normalizedPeerLogs = peerLogs.map((peer, index) => {
    if (!peer || typeof peer !== 'object' || Array.isArray(peer)
        || !/^branch-[0-9]{3}$/u.test(peer.branchId ?? '')) {
      throw new ProtocolError(`Updater peerLogs[${index}] 格式无效`)
    }
    const source = resolve(peer.sourcePath)
    const destination = join(UPDATER_SANDBOX_PATHS.peerLogs, `${peer.branchId}.jsonl`)
    if (peer.sandboxPath !== destination) {
      throw new ProtocolError(`Updater peerLogs[${index}] sandboxPath 无效`)
    }
    return { source, destination, readOnly: true }
  })
  if (new Set(normalizedPeerLogs.map((peer) => peer.destination)).size
      !== normalizedPeerLogs.length) {
    throw new ProtocolError('Updater peerLogs 不能包含重复 branch')
  }
  const run = resolve(runRoot)
  const node = resolve(nodeBinary)
  const patch = resolve(runtimePatch)
  const nodeToolchain = backend === 'codex-cli' ? null : executableDistributionRoot(node)
  const codex = backend === 'codex-cli' ? resolve(codexPath) : null
  const runtime = backend === 'codex-cli'
    ? (codexDistributionRoot === undefined
        ? executableDistributionRoot(codex)
        : resolve(codexDistributionRoot))
    : resolve(updaterRuntime)
  if (runtime === null) throw new ProtocolError('Codex CLI 必须来自可挂载的独立 distribution')
  if (backend === 'codex-cli') {
    const codexRelativePath = relative(runtime, codex)
    if (codexRelativePath === '..' || codexRelativePath.startsWith(`..${sep}`)) {
      throw new ProtocolError('Codex CLI executable 必须位于固定 distribution 内')
    }
  }
  const relaySourcePath = gatewayRelayPath === undefined
    ? join(dirname(patch), 'model-gateway-relay.mjs')
    : resolve(gatewayRelayPath)
  const isolatedGateway = gatewaySocketPath !== undefined
  if (isolatedGateway) {
    const socket = resolve(gatewaySocketPath)
    if (dirname(socket) !== run || basename(socket) !== 'model-gateway.sock') {
      throw new ProtocolError('Updater gateway socket 必须是 runRoot/model-gateway.sock')
    }
  }

  const commonEnvironment = {
    ...safeBaseEnvironment(baseEnv),
    HOME: join(run, 'home'),
    TMPDIR: join(run, 'tmp'),
    GIT_DIR: repository,
    GIT_WORK_TREE: workspace,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Harness RSI Updater',
    GIT_AUTHOR_EMAIL: 'harness-rsi@localhost',
    GIT_COMMITTER_NAME: 'Harness RSI Updater',
    GIT_COMMITTER_EMAIL: 'harness-rsi@localhost',
    RSI_MODEL_GATEWAY_URL: gatewayUrl,
    RSI_MODEL_GATEWAY_DUMMY_KEY: gatewayDummyKey,
    ...(gatewaySocketPath === undefined
      ? {}
      : { RSI_MODEL_GATEWAY_SOCKET: resolve(gatewaySocketPath) }),
  }
  let invocation
  if (backend === 'codex-cli') {
    if (!CODEX_PROVIDER_PATTERN.test(updaterProvider ?? '')) {
      throw new ProtocolError('Codex Updater provider 标识无效')
    }
    for (const [name, value] of [
      ['model', updaterModel],
      ['reasoning effort', updaterReasoningEffort],
    ]) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ProtocolError(`Codex Updater ${name} 不能为空`)
      }
    }
    const nativeCodex = codexNativeExecutable(runtime)
    const toml = (value) => JSON.stringify(value)
    invocation = {
      command: nativeCodex,
      args: [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--model', updaterModel,
        '--config', `model_provider=${toml(updaterProvider)}`,
        '--config', `model_reasoning_effort=${toml(updaterReasoningEffort)}`,
        '--config', `model_providers.${updaterProvider}.name=${toml(updaterProvider)}`,
        '--config', `model_providers.${updaterProvider}.base_url=${toml(gatewayUrl)}`,
        '--config', `model_providers.${updaterProvider}.env_key=${toml('RSI_MODEL_GATEWAY_DUMMY_KEY')}`,
        '--config', `model_providers.${updaterProvider}.wire_api=${toml('responses')}`,
        '--config', `model_providers.${updaterProvider}.request_max_retries=5`,
        '--config', `model_providers.${updaterProvider}.stream_max_retries=5`,
        '--cd', workspace,
        prompt,
      ],
      cwd: workspace,
      env: {
        ...commonEnvironment,
        CODEX_HOME: commonEnvironment.HOME,
        // Python 检查可以被 Codex 显式调用；它们的 pyc 是临时产物，
        // 必须留在沙箱私有的 run tmp，不能进入 Candidate Mutation Diff。
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPYCACHEPREFIX: join(UPDATER_SANDBOX_PATHS.run, 'tmp', 'python-cache'),
      },
    }
  } else {
    invocation = delegateDshConfinementToOuterSandbox({
      command: node,
      args: [
        '--import', 'tsx/esm',
        '--eval', SOURCE_WRAPPER,
        '--', 'dsh',
        '--profile', 'headless',
        '--patch', patch,
        '--preset', INFRASTRUCTURE_UPDATER_PRESET,
        prompt,
      ],
      cwd: runtime,
      env: {
        ...commonEnvironment,
        TASK_CWD: workspace,
        DSH_SOURCE_BIN: pathToFileURL(join(runtime, 'apps', 'cli', 'src', 'bin.ts')).href,
        TSX_TSCONFIG_PATH: join(runtime, 'tsconfig.json'),
        DSH_HOME: join(run, 'dsh-home'),
        DSH_SESSION_ROOT: join(run, 'session-trace'),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'workspace-write',
      },
    })
  }
  const innerInvocation = isolatedGateway
    ? (backend === 'codex-cli'
        ? socatRelayWrappedInvocation({ invocation, socketPath: gatewaySocketPath })
        : relayWrappedInvocation({
            invocation,
            nodePath: node,
            relayPath: relaySourcePath,
            socketPath: gatewaySocketPath,
          }))
    : invocation
  return buildBubblewrapInvocation({
    invocation: {
      ...innerInvocation,
      env: {
        ...innerInvocation.env,
        GIT_DIR: UPDATER_SANDBOX_PATHS.git,
        GIT_WORK_TREE: UPDATER_SANDBOX_PATHS.candidate,
        ...(backend === 'deepseek-harness' ? {
          TASK_CWD: UPDATER_SANDBOX_PATHS.candidate,
          DSH_SOURCE_BIN: pathToFileURL(
            join(UPDATER_SANDBOX_PATHS.runtime, 'apps', 'cli', 'src', 'bin.ts'),
          ).href,
        } : {}),
      },
    },
    uid,
    gid,
    bwrapPath,
    setprivPath,
    preserveSupplementaryGroups,
    privilegedLauncher,
    // A root Controller cannot raise loopback in a fresh net namespace on
    // hosts whose capability bounding set omits CAP_NET_ADMIN. In that
    // attested fallback, only the frozen Codex process and its one-time dummy
    // gateway credential share the host network; no provider secret enters
    // this invocation. Rootless launchers retain the private namespace.
    network: isolatedGateway && !privilegedLauncher ? 'none' : 'shared',
    procMode: backend === 'codex-cli'
      ? 'synthetic-self'
      : (isolatedGateway ? 'empty' : 'mounted'),
    ...(backend === 'codex-cli'
      ? { procSelfExecutable: codexNativeExecutable() }
      : {}),
    hostname: 'rsi-updater',
    mounts: [
      { source: runtime, destination: UPDATER_SANDBOX_PATHS.runtime, readOnly: true },
      { source: workspace, destination: UPDATER_SANDBOX_PATHS.candidate, readOnly: false },
      { source: repository, destination: UPDATER_SANDBOX_PATHS.git, readOnly: false },
      { source: feedback, destination: UPDATER_SANDBOX_PATHS.feedback, readOnly: true },
      {
        source: evolutionLog,
        destination: UPDATER_SANDBOX_PATHS.evolutionLog,
        readOnly: true,
      },
      ...normalizedPeerLogs,
      ...(upstreamRoot === undefined ? [] : [{
        source: resolve(upstreamRoot),
        destination: UPDATER_SANDBOX_PATHS.upstream,
        readOnly: true,
      }]),
      ...(outputRoot === undefined ? [] : [{
        source: resolve(outputRoot),
        destination: UPDATER_SANDBOX_PATHS.output,
        readOnly: false,
      }]),
      { source: run, destination: UPDATER_SANDBOX_PATHS.run, readOnly: false },
      ...(backend === 'deepseek-harness' ? [{
        source: patch,
        destination: UPDATER_SANDBOX_PATHS.runtimePatch,
        readOnly: true,
      }] : []),
      ...(isolatedGateway && backend !== 'codex-cli' ? [{
        source: relaySourcePath,
        destination: UPDATER_SANDBOX_PATHS.relay,
        readOnly: true,
      }] : []),
      ...(nodeToolchain === null ? [] : [{
        source: nodeToolchain,
        destination: UPDATER_SANDBOX_PATHS.nodeToolchain,
        readOnly: true,
      }]),
    ],
  })
}

export function extractUpdaterStopReason(backend, stdout) {
  let text = typeof stdout === 'string' ? stdout : ''
  if (backend === 'codex-cli') {
    const messages = []
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event?.type === 'item.completed'
            && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string') {
          messages.push(event.item.text)
        }
      } catch {
        // Codex diagnostics go to stderr, but ignore any non-JSON stdout line.
      }
    }
    text = messages.at(-1) ?? text
  }
  return text.match(/^RSI_STOP:\s*(.+)$/imu)?.[1]?.trim() ?? null
}

export class UpdaterRunError extends Error {
  constructor(message, { kind, result }) {
    super(message)
    this.name = 'UpdaterRunError'
    this.kind = kind
    this.result = result
  }
}

export async function runMutationPhase({
  templatePath,
  templateValues,
  invocationOptions,
  timeoutMs,
  signal,
  execute = runProcess,
}) {
  const prompt = renderPrompt(await readFile(templatePath, 'utf8'), templateValues)
  const result = await execute({
    ...buildUpdaterInvocation({ ...invocationOptions, prompt }),
    timeoutMs,
    signal,
    outputLimitBytes: 16 * 1024 * 1024,
    secretValues: [],
  })
  if (!result.ok) {
    const kind = result.timedOut || result.aborted ? 'infrastructure' : 'updater_failure'
    throw new UpdaterRunError(`Updater ${kind}`, { kind, result })
  }
  return {
    result,
    stopReason: extractUpdaterStopReason(
      invocationOptions.backend ?? 'deepseek-harness',
      result.stdout,
    ),
  }
}
