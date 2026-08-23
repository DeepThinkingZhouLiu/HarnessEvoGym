import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ProtocolError } from './protocol.mjs'
import { buildBubblewrapInvocation, executableDistributionRoot } from './sandbox.mjs'
import { runProcess } from './subprocess.mjs'

const SOURCE_WRAPPER = 'process.chdir(process.env.TASK_CWD); await import(process.env.DSH_SOURCE_BIN)'
const SAFE_ENV_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TMPDIR',
  'TZ',
])

export const UPDATER_SANDBOX_PATHS = Object.freeze({
  runtime: '/opt/harness-rsi/updater-runtime',
  candidate: '/opt/harness-rsi/candidate',
  feedback: '/opt/harness-rsi/feedback',
  runtimePatch: '/opt/harness-rsi/runtime.patch.yml',
  nodeToolchain: '/opt/harness-rsi/node-toolchain',
  run: '/work',
})

function lookup(values, dottedPath) {
  let current = values
  for (const part of dottedPath.split('.')) current = current?.[part]
  if (current === undefined || current === null) throw new ProtocolError(`Prompt 缺少模板变量：${dottedPath}`)
  if (Array.isArray(current)) return current.join(', ')
  if (typeof current === 'object') return JSON.stringify(current, null, 2)
  return String(current)
}

export function renderPrompt(template, values) {
  if (typeof template !== 'string') throw new ProtocolError('Prompt template 必须是字符串')
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/gu, (_match, path) => lookup(values, path))
  if (/\{\{[^}]+\}\}/u.test(rendered)) throw new ProtocolError('Prompt 含有无法解析的模板变量')
  return rendered
}

export function parseStrictJsonOutput(output, expectedKind) {
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new ProtocolError('Updater 没有返回 JSON')
  }
  let value
  try {
    value = JSON.parse(output.trim())
  } catch (error) {
    throw new ProtocolError('Updater 最终输出必须是单个裸 JSON 对象', [error.message])
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('Updater 最终输出必须是 JSON 对象')
  }
  if (expectedKind && value.kind !== expectedKind) throw new ProtocolError(`Updater JSON kind 必须是 ${expectedKind}`)
  return value
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
  runRoot,
  runtimePatch,
  gatewayUrl,
  gatewayDummyKey,
  prompt,
  permissionMode,
  uid,
  gid,
  feedbackRoot,
  bwrapPath,
  setprivPath = '/usr/bin/setpriv',
  legacy = false,
  baseEnv = process.env,
}) {
  if (!['read-only', 'workspace-write'].includes(permissionMode)) {
    throw new ProtocolError('Updater permissionMode 无效')
  }
  const runtime = resolve(updaterRuntime)
  const workspace = resolve(candidateRoot)
  const run = resolve(runRoot)
  const node = resolve(nodeBinary)
  const patch = resolve(runtimePatch)
  const nodeArgs = [
    '--import', 'tsx/esm',
    '--eval', SOURCE_WRAPPER,
    '--', 'dsh',
    '--profile', 'headless',
    '--patch', patch,
    '--preset', 'standard',
    prompt,
  ]
  const useSetpriv = uid !== undefined || gid !== undefined
  if (useSetpriv && (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1)) {
    throw new ProtocolError('Updater uid/gid 必须同时是正整数')
  }
  const invocation = {
    command: node,
    args: nodeArgs,
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
      DSH_PERMISSION_MODE: permissionMode,
      RSI_MODEL_GATEWAY_URL: gatewayUrl,
      RSI_MODEL_GATEWAY_DUMMY_KEY: gatewayDummyKey,
    },
  }
  if (legacy === true) {
    return {
      ...invocation,
      command: useSetpriv ? setprivPath : node,
      args: useSetpriv
        ? [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', node, ...nodeArgs]
        : nodeArgs,
    }
  }
  if (legacy !== false) throw new ProtocolError('Updater legacy 必须是布尔值')
  if (!useSetpriv) throw new ProtocolError('Sandboxed Updater 必须提供 uid/gid')
  if (typeof feedbackRoot !== 'string' || feedbackRoot.length === 0) {
    throw new ProtocolError('Sandboxed Updater 必须提供 feedbackRoot')
  }
  const feedback = resolve(feedbackRoot)
  const nodeToolchain = executableDistributionRoot(node)
  return buildBubblewrapInvocation({
    invocation: {
      ...invocation,
      env: {
        ...invocation.env,
        DSH_SOURCE_BIN: pathToFileURL(
          join(UPDATER_SANDBOX_PATHS.runtime, 'apps', 'cli', 'src', 'bin.ts'),
        ).href,
      },
    },
    uid,
    gid,
    bwrapPath,
    setprivPath,
    network: 'shared',
    hostname: 'rsi-updater',
    mounts: [
      { source: runtime, destination: UPDATER_SANDBOX_PATHS.runtime, readOnly: true },
      {
        source: workspace,
        destination: UPDATER_SANDBOX_PATHS.candidate,
        readOnly: permissionMode === 'read-only',
      },
      { source: feedback, destination: UPDATER_SANDBOX_PATHS.feedback, readOnly: true },
      { source: run, destination: UPDATER_SANDBOX_PATHS.run, readOnly: false },
      { source: patch, destination: UPDATER_SANDBOX_PATHS.runtimePatch, readOnly: true },
      ...(nodeToolchain === null ? [] : [{
        source: nodeToolchain,
        destination: UPDATER_SANDBOX_PATHS.nodeToolchain,
        readOnly: true,
      }]),
    ],
  })
}

async function runUpdater({
  invocation,
  timeoutMs,
  signal,
  execute = runProcess,
}) {
  const result = await execute({
    ...invocation,
    timeoutMs,
    signal,
    outputLimitBytes: 16 * 1024 * 1024,
    secretValues: [],
  })
  if (!result.ok) {
    const kind = result.timedOut || result.aborted ? 'infrastructure' : 'updater_failure'
    throw new UpdaterRunError(`Updater ${kind}`, { kind, result })
  }
  return result
}

export class UpdaterRunError extends Error {
  constructor(message, { kind, result }) {
    super(message)
    this.name = 'UpdaterRunError'
    this.kind = kind
    this.result = result
  }
}

export async function runProposalPhase({
  templatePath,
  templateValues,
  invocationOptions,
  timeoutMs,
  signal,
  execute,
}) {
  const template = await readFile(templatePath, 'utf8')
  const prompt = renderPrompt(template, templateValues)
  const invocation = buildUpdaterInvocation({
    ...invocationOptions,
    prompt,
    permissionMode: 'read-only',
  })
  const result = await runUpdater({ invocation, timeoutMs, signal, execute })
  return {
    proposal: parseStrictJsonOutput(result.stdout, 'MutationProposal'),
    result,
  }
}

export async function runApplyPhase({
  templatePath,
  templateValues,
  invocationOptions,
  timeoutMs,
  signal,
  execute,
}) {
  const template = await readFile(templatePath, 'utf8')
  const prompt = renderPrompt(template, templateValues)
  const invocation = buildUpdaterInvocation({
    ...invocationOptions,
    prompt,
    permissionMode: 'workspace-write',
  })
  const result = await runUpdater({ invocation, timeoutMs, signal, execute })
  const report = parseStrictJsonOutput(result.stdout)
  for (const field of ['proposalId', 'diagnosis', 'changedFiles', 'checks', 'remainingRisks']) {
    if (!(field in report)) throw new ProtocolError(`Mutation report 缺少 ${field}`)
  }
  return { report, result }
}
