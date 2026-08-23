import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const NETWORK_MODES = new Set(['shared', 'none'])
const ATTEST_OUTPUT_LIMIT = 64 * 1024
const FIREWALL_COMMANDS = Object.freeze(['/usr/sbin/iptables', '/usr/sbin/ip6tables'])
const IPV4_FIREWALL_COMMAND = FIREWALL_COMMANDS[0]
const EGRESS_CHAIN = 'DSH_RSI_EGRESS'
const EGRESS_CLEANUP_ATTEMPTS = 3
const POISONED_EGRESS_UIDS = new Map()
const RESERVED_DESTINATIONS = [
  '/',
  '/bin',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
]

export const SOLVER_SANDBOX_PATHS = Object.freeze({
  candidate: '/opt/harness-rsi/candidate',
  leanProject: '/opt/harness-rsi/lean-project',
  nodeToolchain: '/opt/harness-rsi/node-toolchain',
  leanToolchain: '/opt/harness-rsi/lean-toolchain',
  runtimePatch: '/opt/harness-rsi/control/runtime.patch.yml',
  workspace: '/work',
})

export const VERIFIER_SANDBOX_PATHS = Object.freeze({
  leanProject: '/opt/harness-rsi/lean-project',
  leanToolchain: '/opt/harness-rsi/lean-toolchain',
  workspace: '/verify',
})

function absolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new ProtocolError(`${name} 必须是绝对路径`)
  }
  return resolve(value)
}

function positiveIdentity(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new ProtocolError(`${name} 必须是正整数`)
  return value
}

function within(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertSafeDestination(path, name) {
  if (path === '/' || RESERVED_DESTINATIONS.slice(1)
    .some((reserved) => within(reserved, path) || within(path, reserved))) {
    throw new ProtocolError(`${name} 使用了保留 sandbox 路径`)
  }
}

function normalizeMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) {
    throw new ProtocolError('sandbox mounts 必须是非空数组')
  }
  const normalized = mounts.map((mount, index) => {
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)) {
      throw new ProtocolError(`sandbox mounts[${index}] 必须是对象`)
    }
    const source = absolutePath(mount.source, `sandbox mounts[${index}].source`)
    const destination = absolutePath(mount.destination, `sandbox mounts[${index}].destination`)
    assertSafeDestination(destination, `sandbox mounts[${index}].destination`)
    if (typeof mount.readOnly !== 'boolean') {
      throw new ProtocolError(`sandbox mounts[${index}].readOnly 必须是布尔值`)
    }
    return { source, destination, readOnly: mount.readOnly }
  })

  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const a = normalized[left]
      const b = normalized[right]
      if (a.source === b.source || within(a.source, b.source) || within(b.source, a.source)) {
        throw new ProtocolError('sandbox mount source 不能重复或相互嵌套')
      }
      if (a.destination === b.destination
          || within(a.destination, b.destination)
          || within(b.destination, a.destination)) {
        throw new ProtocolError('sandbox mount destination 不能重复或相互嵌套')
      }
    }
  }
  return normalized
}

function normalizeMasks(maskedPaths, mounts) {
  if (!Array.isArray(maskedPaths)) throw new ProtocolError('sandbox maskedPaths 必须是数组')
  return maskedPaths.map((value, index) => {
    const path = absolutePath(value, `sandbox maskedPaths[${index}]`)
    const owner = mounts.find((mount) => mount.readOnly && within(mount.destination, path))
    if (!owner || path === owner.destination) {
      throw new ProtocolError('sandbox mask 必须位于只读 mount 内部')
    }
    return path
  })
}

function rewriteText(value, mappings) {
  let output = String(value)
  for (const { source, destination } of mappings) {
    output = output.split(source).join(destination)
  }
  return output
}

function rewriteInvocation(invocation, mounts) {
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)
      || typeof invocation.command !== 'string' || invocation.command.length === 0
      || !Array.isArray(invocation.args) || typeof invocation.cwd !== 'string'
      || !invocation.env || typeof invocation.env !== 'object' || Array.isArray(invocation.env)) {
    throw new ProtocolError('sandbox invocation 格式无效')
  }
  const mappings = mounts
    .map(({ source, destination }) => ({ source, destination }))
    .sort((left, right) => right.source.length - left.source.length)
  const command = rewriteText(invocation.command, mappings)
  const args = invocation.args.map((argument) => rewriteText(argument, mappings))
  const cwd = rewriteText(absolutePath(invocation.cwd, 'sandbox invocation.cwd'), mappings)
  const env = Object.fromEntries(Object.entries(invocation.env).map(([key, value]) => {
    if (typeof value !== 'string') throw new ProtocolError(`sandbox env ${key} 必须是字符串`)
    return [key, rewriteText(value, mappings)]
  }))
  if (!isAbsolute(command)) throw new ProtocolError('sandbox command 必须是绝对路径')
  if (!mounts.some((mount) => within(mount.destination, cwd)) && !within('/usr', cwd)) {
    throw new ProtocolError('sandbox cwd 必须位于显式 mount 内')
  }
  return { command, args, cwd, env }
}

function destinationParents(mounts) {
  const directories = new Set(['/opt', '/opt/harness-rsi'])
  for (const { destination } of mounts) {
    let current = dirname(destination)
    while (current !== '/') {
      if (!RESERVED_DESTINATIONS.includes(current)) directories.add(current)
      current = dirname(current)
    }
  }
  return [...directories]
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
    .flatMap((directory) => ['--dir', directory])
}

/**
 * Build the fail-closed process boundary used for an untrusted Solver or Lean
 * verifier. The root filesystem starts empty: only /usr plus the explicit
 * mounts are visible. Host source paths are rewritten to fixed guest paths so
 * private host /tmp and /dev/shm can be replaced without losing the task bind.
 *
 * `network: "shared"` is reserved for an agent whose host UID is routed into a
 * fail-closed owner chain and holds a short-lived lease for one loopback TCP
 * gateway port. `network: "none"` creates a new network namespace.
 */
export function buildBubblewrapInvocation({
  invocation,
  mounts: rawMounts,
  uid,
  gid,
  bwrapPath = '/usr/bin/bwrap',
  setprivPath = '/usr/bin/setpriv',
  network = 'none',
  hostname = 'harness-rsi',
  maskedPaths = [],
}) {
  const userId = positiveIdentity(uid, 'sandbox uid')
  const groupId = positiveIdentity(gid, 'sandbox gid')
  const bwrap = absolutePath(bwrapPath, 'bwrapPath')
  const setpriv = absolutePath(setprivPath, 'setprivPath')
  if (!NETWORK_MODES.has(network)) throw new ProtocolError('sandbox network 模式无效')
  if (typeof hostname !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(hostname)) {
    throw new ProtocolError('sandbox hostname 无效')
  }

  const mounts = normalizeMounts(rawMounts)
  const masks = normalizeMasks(maskedPaths, mounts)
  const rewritten = rewriteInvocation(invocation, mounts)
  const bwrapArguments = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    ...(network === 'none' ? ['--unshare-net'] : []),
    '--uid', '0',
    '--gid', '0',
    '--cap-drop', 'ALL',
    '--hostname', hostname,
    ...destinationParents(mounts),
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--dir', '/etc',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/passwd', '/etc/passwd',
    '--ro-bind-try', '/etc/group', '/etc/group',
    '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime',
    ...mounts.flatMap(({ source, destination, readOnly }) => [
      readOnly ? '--ro-bind' : '--bind', source, destination,
    ]),
    ...masks.flatMap((path) => ['--tmpfs', path]),
    '--proc', '/proc',
    '--dev', '/dev',
    '--dir', '/dev/shm',
    '--tmpfs', '/dev/shm',
    '--dir', '/tmp',
    '--tmpfs', '/tmp',
    '--dir', '/run',
    '--tmpfs', '/run',
    '--chdir', rewritten.cwd,
    '--',
    rewritten.command,
    ...rewritten.args,
  ]

  return {
    command: setpriv,
    args: [
      `--reuid=${userId}`,
      `--regid=${groupId}`,
      '--clear-groups',
      '--no-new-privs',
      bwrap,
      ...bwrapArguments,
    ],
    cwd: '/',
    env: rewritten.env,
  }
}

/** Return the immutable distribution root for /root/bin/tool style paths. */
export function executableDistributionRoot(executablePath) {
  const executable = absolutePath(executablePath, 'tool executable')
  if (within('/usr', executable)) return null
  const parent = dirname(executable)
  return dirname(parent)
}

function optionalToolchainMount(source, destination) {
  return source === null ? [] : [{ source, destination, readOnly: true }]
}

export function buildSolverSandboxInvocation({
  invocation,
  candidateRoot,
  workdir,
  leanRoot,
  nodePath,
  lakePath,
  patchPath,
  solverUid,
  solverGid,
  bwrapPath,
  setprivPath,
}) {
  const nodeRoot = executableDistributionRoot(nodePath)
  const leanToolchainRoot = executableDistributionRoot(lakePath)
  return buildBubblewrapInvocation({
    invocation,
    uid: solverUid,
    gid: solverGid,
    bwrapPath,
    setprivPath,
    network: 'shared',
    hostname: 'rsi-solver',
    maskedPaths: [
      `${SOLVER_SANDBOX_PATHS.leanProject}/src`,
      `${SOLVER_SANDBOX_PATHS.leanProject}/solutions_replaced_new`,
      `${SOLVER_SANDBOX_PATHS.leanProject}/scripts`,
    ],
    mounts: [
      { source: candidateRoot, destination: SOLVER_SANDBOX_PATHS.candidate, readOnly: true },
      { source: leanRoot, destination: SOLVER_SANDBOX_PATHS.leanProject, readOnly: true },
      { source: patchPath, destination: SOLVER_SANDBOX_PATHS.runtimePatch, readOnly: true },
      ...optionalToolchainMount(nodeRoot, SOLVER_SANDBOX_PATHS.nodeToolchain),
      ...optionalToolchainMount(leanToolchainRoot, SOLVER_SANDBOX_PATHS.leanToolchain),
      { source: workdir, destination: SOLVER_SANDBOX_PATHS.workspace, readOnly: false },
    ],
  })
}

export function buildVerifierSandboxInvocation({
  invocation,
  verificationDirectory,
  leanRoot,
  lakePath,
  verifierUid,
  verifierGid,
  bwrapPath,
  setprivPath,
}) {
  const leanToolchainRoot = executableDistributionRoot(lakePath)
  return buildBubblewrapInvocation({
    invocation,
    uid: verifierUid,
    gid: verifierGid,
    bwrapPath,
    setprivPath,
    network: 'none',
    hostname: 'rsi-verifier',
    maskedPaths: [
      `${VERIFIER_SANDBOX_PATHS.leanProject}/src`,
      `${VERIFIER_SANDBOX_PATHS.leanProject}/solutions_replaced_new`,
      `${VERIFIER_SANDBOX_PATHS.leanProject}/scripts`,
    ],
    mounts: [
      { source: leanRoot, destination: VERIFIER_SANDBOX_PATHS.leanProject, readOnly: true },
      ...optionalToolchainMount(leanToolchainRoot, VERIFIER_SANDBOX_PATHS.leanToolchain),
      { source: verificationDirectory, destination: VERIFIER_SANDBOX_PATHS.workspace, readOnly: false },
    ],
  })
}

function executeAttestation({ command, args }) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
      },
    })
    const output = { stdout: [], stderr: [], bytes: 0, exceeded: false }
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    timer.unref?.()
    const collect = (target) => (chunk) => {
      output.bytes += chunk.length
      if (output.bytes > ATTEST_OUTPUT_LIMIT) {
        output.exceeded = true
        child.kill('SIGKILL')
        return
      }
      output[target].push(Buffer.from(chunk))
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      accept({
        exitCode,
        signal,
        outputExceeded: output.exceeded,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      })
    })
  })
}

async function checkedExecute(execute, command, args, description) {
  let result
  try {
    result = await execute({ command, args })
  } catch {
    throw new ProtocolError(`sandbox attestation 失败：${description}`)
  }
  const exitCode = result?.exitCode ?? result?.code
  if (exitCode !== 0 || result?.outputExceeded === true) {
    throw new ProtocolError(`sandbox attestation 失败：${description}`)
  }
  return String(result.stdout ?? '')
}

function assertFirewallChain(text, firewall) {
  const rules = text.split(/\r?\n/u).filter((line) => line.startsWith(`-A ${EGRESS_CHAIN} `))
  if (rules.length !== 1 || !rules[0].startsWith(`-A ${EGRESS_CHAIN} -j REJECT`)) {
    throw new ProtocolError(`sandbox attestation 失败：${firewall} chain 不是 fail-closed`)
  }
}

function assertOutputOwnerRules(text, firewall, restrictedUids) {
  const rules = text.split(/\r?\n/u).filter((line) => line.startsWith('-A OUTPUT '))
  const prefix = rules.slice(0, restrictedUids.length)
  for (const uid of restrictedUids) {
    const expected = `-A OUTPUT -m owner --uid-owner ${uid} -j DSH_RSI_EGRESS`
    if (!prefix.includes(expected)) {
      throw new ProtocolError(`sandbox attestation 失败：${firewall} 缺少前置 UID ${uid} egress rule`)
    }
  }
}

/**
 * Runtime gate for CLI start/resume/smoke paths. It deliberately checks live
 * kernel firewall state instead of trusting a setup marker. Callers must invoke
 * it before starting a gateway or loading a provider credential.
 */
export async function attestSandboxRuntime({
  bwrapPath = '/usr/bin/bwrap',
  setprivPath = '/usr/bin/setpriv',
  restrictedUids,
  firewallCommands = FIREWALL_COMMANDS,
  execute = executeAttestation,
}) {
  const bwrap = absolutePath(bwrapPath, 'bwrapPath')
  const setpriv = absolutePath(setprivPath, 'setprivPath')
  if (!Array.isArray(restrictedUids) || restrictedUids.length < 2
      || new Set(restrictedUids).size !== restrictedUids.length
      || restrictedUids.some((uid) => !Number.isInteger(uid) || uid < 1)) {
    throw new ProtocolError('restrictedUids 必须是至少两个不同的正整数')
  }
  if (!Array.isArray(firewallCommands)
      || firewallCommands.length !== FIREWALL_COMMANDS.length
      || firewallCommands.some((command, index) => command !== FIREWALL_COMMANDS[index])) {
    throw new ProtocolError('iptables/ip6tables 命令路径必须使用冻结配置')
  }
  try {
    await Promise.all([
      access(bwrap, fsConstants.X_OK),
      access(setpriv, fsConstants.X_OK),
    ])
  } catch {
    throw new ProtocolError('sandbox attestation 失败：bwrap/setpriv 不可执行')
  }

  const version = await checkedExecute(execute, bwrap, ['--version'], 'bwrap version')
  const match = version.match(/(?:bubblewrap|bwrap)\s+(\d+)\.(\d+)/iu)
  if (!match || (Number(match[1]) < 1 && Number(match[2]) < 6)) {
    throw new ProtocolError('sandbox attestation 失败：bwrap 必须 >= 0.6')
  }
  await checkedExecute(execute, setpriv, ['--version'], 'setpriv version')

  for (const firewall of firewallCommands) {
    const chain = await checkedExecute(
      execute,
      firewall,
      ['-w', '5', '-S', 'DSH_RSI_EGRESS'],
      `${firewall} DSH_RSI_EGRESS`,
    )
    assertFirewallChain(chain, firewall)
    const output = await checkedExecute(
      execute,
      firewall,
      ['-w', '5', '-S', 'OUTPUT'],
      `${firewall} OUTPUT`,
    )
    assertOutputOwnerRules(output, firewall, restrictedUids)
  }
  return Object.freeze({
    bwrapPath: bwrap,
    setprivPath: setpriv,
    restrictedUids: Object.freeze([...restrictedUids]),
    ipv4: 'attested',
    ipv6: 'attested',
  })
}

function parseLoopbackGateway(gatewayUrl) {
  if (typeof gatewayUrl !== 'string' || /[\r\n\0]/u.test(gatewayUrl)) {
    throw new ProtocolError('gateway URL 必须是显式 IPv4 loopback HTTP URL')
  }
  const raw = gatewayUrl.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\/[^?#]*)?$/u)
  if (!raw) throw new ProtocolError('gateway URL 只允许 http://127.0.0.1:<port>')
  const port = Number(raw[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== raw[1]) {
    throw new ProtocolError('gateway URL TCP port 无效')
  }
  let parsed
  try {
    parsed = new URL(gatewayUrl)
  } catch {
    throw new ProtocolError('gateway URL 无效')
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || (parsed.port === '' ? port !== 80 : parsed.port !== String(port))
      || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
    throw new ProtocolError('gateway URL 只允许无凭据的 IPv4 loopback TCP endpoint')
  }
  return port
}

function gatewayLeaseRule(uid, port) {
  return [
    '-o', 'lo',
    '-d', '127.0.0.1/32',
    '-p', 'tcp',
    '--dport', String(port),
    '-m', 'owner',
    '--uid-owner', String(uid),
    '-j', 'RETURN',
  ]
}

async function checkedFirewallExecute(execute, args, description) {
  try {
    return await checkedExecute(execute, IPV4_FIREWALL_COMMAND, args, description)
  } catch (error) {
    throw new SandboxEgressLeaseError(description, { cause: error })
  }
}

async function firewallRuleExists(execute, rule, description) {
  let result
  try {
    result = await execute({
      command: IPV4_FIREWALL_COMMAND,
      args: ['-w', '5', '-C', EGRESS_CHAIN, ...rule],
    })
  } catch (error) {
    throw new SandboxEgressLeaseError(description, { cause: error })
  }
  if (result?.outputExceeded === true) {
    throw new SandboxEgressLeaseError(description)
  }
  const exitCode = result?.exitCode ?? result?.code
  if (exitCode === 0) return true
  // iptables documents status 1 for a valid -C rule which is not present.
  if (exitCode === 1) return false
  throw new SandboxEgressLeaseError(description)
}

function poisonEgressUid(uid, cause) {
  const error = new SandboxEgressLeaseError(
    `UID ${uid} 的 gateway allow rule 无法确认删除`,
    { cause, fatal: true, uid },
  )
  POISONED_EGRESS_UIDS.set(uid, error)
  return error
}

async function removeGatewayLeaseRule(execute, rule, uid, description) {
  let lastError
  for (let attempt = 1; attempt <= EGRESS_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await checkedFirewallExecute(
        execute,
        ['-w', '5', '-D', EGRESS_CHAIN, ...rule],
        `${description} delete ${attempt}/${EGRESS_CLEANUP_ATTEMPTS}`,
      )
    } catch (error) {
      lastError = error
    }
    try {
      if (!await firewallRuleExists(
        execute,
        rule,
        `${description} confirmation ${attempt}/${EGRESS_CLEANUP_ATTEMPTS}`,
      )) return
    } catch (error) {
      lastError = error
    }
  }
  throw poisonEgressUid(uid, lastError)
}

/**
 * A trusted, root-side lease for the one TCP endpoint exposed by a private
 * model gateway. The command line contains only a numeric UID and TCP port;
 * provider credentials and candidate/task identifiers never cross this
 * boundary.
 *
 * The static chain is otherwise a single terminal REJECT. Multiple gateways
 * can coexist because every lease inserts and later deletes its own exact
 * UID/port rule under iptables' xtables lock. Release is safe to call more
 * than once and never widens access if acquisition fails midway.
 */
export async function acquireGatewayEgressLease({
  gatewayUrl,
  uid,
  execute = executeAttestation,
}) {
  const userId = positiveIdentity(uid, 'gateway lease uid')
  const port = parseLoopbackGateway(gatewayUrl)
  if (typeof execute !== 'function') throw new ProtocolError('gateway lease execute 必须是函数')
  if (POISONED_EGRESS_UIDS.has(userId)) {
    throw new SandboxEgressLeaseError(
      `UID ${userId} 已因残留 gateway allow rule 被隔离`,
      { cause: POISONED_EGRESS_UIDS.get(userId), fatal: true, uid: userId },
    )
  }
  const rule = gatewayLeaseRule(userId, port)

  try {
    await checkedFirewallExecute(
      execute,
      ['-w', '5', '-I', EGRESS_CHAIN, '1', ...rule],
      'gateway egress lease insert',
    )
    if (!await firewallRuleExists(execute, rule, 'gateway egress lease verification')) {
      throw new SandboxEgressLeaseError('gateway egress lease verification')
    }
  } catch (error) {
    // Even a failed/aborted iptables process may have committed its rule before
    // losing the result channel. Always perform exact, confirmed rollback.
    try {
      await removeGatewayLeaseRule(
        execute,
        rule,
        userId,
        'gateway egress lease rollback',
      )
    } catch (cleanupError) {
      throw cleanupError
    }
    throw error
  }

  let released = false
  let releasePromise = null
  const release = async () => {
    if (released) return
    if (releasePromise) return releasePromise
    releasePromise = removeGatewayLeaseRule(
      execute,
      rule,
      userId,
      'gateway egress lease release',
    ).then(() => { released = true })
    try {
      await releasePromise
    } finally {
      releasePromise = null
    }
  }

  return Object.freeze({
    uid: userId,
    port,
    release,
  })
}

export class SandboxEgressLeaseError extends Error {
  constructor(message, options = {}) {
    super(`sandbox egress lease 失败：${message}`, options)
    this.name = 'SandboxEgressLeaseError'
    this.kind = 'infrastructure'
    this.fatal = options.fatal === true
    this.uid = options.uid ?? null
  }
}
