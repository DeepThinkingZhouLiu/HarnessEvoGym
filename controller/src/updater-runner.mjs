import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { relayWrappedInvocation } from './model-gateway-relay.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  buildBubblewrapInvocation,
  delegateDshConfinementToOuterSandbox,
  executableDistributionRoot,
} from './sandbox.mjs'
import { runProcess } from './subprocess.mjs'

const SOURCE_WRAPPER = 'process.chdir(process.env.TASK_CWD); await import(process.env.DSH_SOURCE_BIN)'
const SAFE_ENV_KEYS = new Set(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'])

// The Updater is frozen infrastructure. Only the evaluated Solver uses the
// evolving minimal preset.
export const INFRASTRUCTURE_UPDATER_PRESET = 'standard'

export const UPDATER_SANDBOX_PATHS = Object.freeze({
  runtime: '/opt/harness-rsi/updater-runtime',
  candidate: '/opt/harness-rsi/candidate',
  git: '/opt/harness-rsi/git',
  feedback: '/opt/harness-rsi/feedback',
  evolutionLog: '/opt/harness-rsi/evolution-log.jsonl',
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

export function buildUpdaterInvocation({
  nodeBinary,
  updaterRuntime,
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
  evolutionLogPath,
  bwrapPath,
  setprivPath = '/usr/bin/setpriv',
  baseEnv = process.env,
}) {
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1) {
    throw new ProtocolError('Updater uid/gid 必须是正整数')
  }
  const runtime = resolve(updaterRuntime)
  const workspace = resolve(candidateRoot)
  const repository = resolve(gitRoot)
  const feedback = resolve(feedbackRoot)
  const evolutionLog = resolve(evolutionLogPath)
  const run = resolve(runRoot)
  const node = resolve(nodeBinary)
  const patch = resolve(runtimePatch)
  const nodeToolchain = executableDistributionRoot(node)
  const relaySourcePath = join(dirname(patch), 'model-gateway-relay.mjs')
  const isolatedGateway = gatewaySocketPath !== undefined
  if (isolatedGateway) {
    const socket = resolve(gatewaySocketPath)
    if (dirname(socket) !== run || basename(socket) !== 'model-gateway.sock') {
      throw new ProtocolError('Updater gateway socket 必须是 runRoot/model-gateway.sock')
    }
  }

  const invocation = {
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
      ...safeBaseEnvironment(baseEnv),
      HOME: join(run, 'home'),
      TMPDIR: join(run, 'tmp'),
      TASK_CWD: workspace,
      DSH_SOURCE_BIN: pathToFileURL(join(runtime, 'apps', 'cli', 'src', 'bin.ts')).href,
      TSX_TSCONFIG_PATH: join(runtime, 'tsconfig.json'),
      DSH_HOME: join(run, 'dsh-home'),
      DSH_SESSION_ROOT: join(run, 'session-trace'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      GIT_DIR: UPDATER_SANDBOX_PATHS.git,
      GIT_WORK_TREE: UPDATER_SANDBOX_PATHS.candidate,
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
    },
  }
  const innerInvocation = isolatedGateway
    ? relayWrappedInvocation({
        invocation,
        nodePath: node,
        relayPath: relaySourcePath,
        socketPath: gatewaySocketPath,
      })
    : invocation
  const delegatedInvocation = delegateDshConfinementToOuterSandbox(innerInvocation)
  return buildBubblewrapInvocation({
    invocation: {
      ...delegatedInvocation,
      env: {
        ...delegatedInvocation.env,
        TASK_CWD: UPDATER_SANDBOX_PATHS.candidate,
        GIT_DIR: UPDATER_SANDBOX_PATHS.git,
        GIT_WORK_TREE: UPDATER_SANDBOX_PATHS.candidate,
        DSH_SOURCE_BIN: pathToFileURL(
          join(UPDATER_SANDBOX_PATHS.runtime, 'apps', 'cli', 'src', 'bin.ts'),
        ).href,
      },
    },
    uid,
    gid,
    bwrapPath,
    setprivPath,
    network: isolatedGateway ? 'none' : 'shared',
    procMode: isolatedGateway ? 'empty' : 'mounted',
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
      { source: run, destination: UPDATER_SANDBOX_PATHS.run, readOnly: false },
      { source: patch, destination: UPDATER_SANDBOX_PATHS.runtimePatch, readOnly: true },
      ...(isolatedGateway ? [{
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
  return { result }
}
