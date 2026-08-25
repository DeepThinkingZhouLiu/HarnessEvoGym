import assert from 'node:assert/strict'
import test from 'node:test'

import { ProtocolError } from '../src/protocol.mjs'
import {
  OUTER_SANDBOX_DSH_PERMISSION_MODE,
  SOLVER_SANDBOX_PATHS,
  VERIFIER_SANDBOX_PATHS,
  SandboxEgressLeaseError,
  acquireGatewayEgressLease,
  attestSandboxRuntime,
  buildBubblewrapInvocation,
  delegateDshConfinementToOuterSandbox,
  buildSolverSandboxInvocation,
  buildVerifierSandboxInvocation,
} from '../src/sandbox.mjs'

test('outer sandbox delegation enables DSH tools without mutating the source invocation', () => {
  const source = {
    command: '/usr/bin/node', args: [], cwd: '/work',
    env: { DSH_PERMISSION_MODE: 'workspace-write', PATH: '/usr/bin' },
  }
  const delegated = delegateDshConfinementToOuterSandbox(source)
  assert.equal(OUTER_SANDBOX_DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(delegated.env.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(source.env.DSH_PERMISSION_MODE, 'workspace-write')
  assert.notEqual(delegated.env, source.env)
})

function includesSequence(values, sequence) {
  return values.some((_value, index) => sequence.every((entry, offset) => values[index + offset] === entry))
}

const HOST = Object.freeze({
  candidate: '/mnt/runtime/runtimes/candidate-1',
  work: '/dev/shm/dsh-rsi/run-opaque/job-opaque/work/task-opaque',
  lean: '/mnt/runtime/datasets/PutnamBench/lean4',
  node: '/mnt/runtime/node-v24/bin/node',
  lake: '/mnt/runtime/elan/bin/lake',
  patch: '/mnt/runtime/control/runtime.patch.yml',
  verify: '/dev/shm/dsh-rsi/run-opaque/job-opaque/verify/verify-opaque',
})

test('solver bwrap exposes only explicit mounts, private temp, and shared host network', () => {
  const raw = {
    command: HOST.node,
    args: [
      '--import', `${HOST.candidate}/node_modules/tsx/dist/esm/index.mjs`,
      '--patch', HOST.patch,
      '--eval', 'process.chdir(process.env.TASK_CWD)',
    ],
    cwd: HOST.candidate,
    env: {
      HOME: `${HOST.work}/.dsh`,
      TASK_CWD: HOST.work,
      DSH_SOURCE_BIN: `file://${HOST.candidate}/apps/cli/src/bin.ts`,
      RSI_LEAN_PROJECT_ROOT: HOST.lean,
      RSI_TASK_FILE: `${HOST.work}/Main.lean`,
      PATH: `/mnt/runtime/elan/bin:/mnt/runtime/node-v24/bin:/usr/bin`,
    },
  }
  const invocation = buildSolverSandboxInvocation({
    invocation: raw,
    candidateRoot: HOST.candidate,
    workdir: HOST.work,
    leanRoot: HOST.lean,
    nodePath: HOST.node,
    lakePath: HOST.lake,
    patchPath: HOST.patch,
    solverUid: 1103,
    solverGid: 2103,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
  })

  assert.equal(invocation.command, '/usr/bin/setpriv')
  assert.deepEqual(invocation.args.slice(0, 4), [
    '--reuid=1103', '--regid=2103', '--clear-groups', '--no-new-privs',
  ])
  for (const flag of [
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
  ]) assert.ok(invocation.args.includes(flag), flag)
  assert.equal(invocation.args.includes('--unshare-net'), false)
  assert.equal(includesSequence(invocation.args, ['--tmpfs', '/tmp']), true)
  assert.equal(includesSequence(invocation.args, ['--tmpfs', '/dev/shm']), true)
  assert.equal(includesSequence(invocation.args, [
    '--ro-bind', HOST.candidate, SOLVER_SANDBOX_PATHS.candidate,
  ]), true)
  assert.equal(includesSequence(invocation.args, [
    '--bind', HOST.work, SOLVER_SANDBOX_PATHS.workspace,
  ]), true)
  for (const hidden of ['src', 'solutions_replaced_new', 'scripts']) {
    assert.equal(includesSequence(invocation.args, [
      '--tmpfs', `${SOLVER_SANDBOX_PATHS.leanProject}/${hidden}`,
    ]), true)
  }
  assert.equal(invocation.env.TASK_CWD, SOLVER_SANDBOX_PATHS.workspace)
  assert.equal(invocation.env.RSI_LEAN_PROJECT_ROOT, SOLVER_SANDBOX_PATHS.leanProject)
  assert.match(invocation.env.DSH_SOURCE_BIN, /^file:\/\/\/opt\/harness-rsi\/candidate\//u)
  assert.equal(invocation.env.PATH.includes('/mnt/runtime/'), false)
  const serialized = JSON.stringify(invocation)
  for (const forbidden of ['/controller/repo', 'test.ids', '/sealed/']) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('verifier bwrap is a distinct downgraded uid with no network or host feedback paths', () => {
  const raw = {
    command: HOST.lake,
    args: ['env', 'lean', '-DwarningAsError=true', `${HOST.verify}/Main.lean`],
    cwd: HOST.lean,
    env: { HOME: HOST.verify, TMPDIR: '/tmp', PATH: '/mnt/runtime/elan/bin:/usr/bin' },
  }
  const invocation = buildVerifierSandboxInvocation({
    invocation: raw,
    verificationDirectory: HOST.verify,
    leanRoot: HOST.lean,
    lakePath: HOST.lake,
    verifierUid: 1104,
    verifierGid: 2104,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
  })
  assert.deepEqual(invocation.args.slice(0, 4), [
    '--reuid=1104', '--regid=2104', '--clear-groups', '--no-new-privs',
  ])
  assert.ok(invocation.args.includes('--unshare-net'))
  assert.ok(invocation.args.includes('--unshare-user'))
  assert.equal(includesSequence(invocation.args, [
    '--bind', HOST.verify, VERIFIER_SANDBOX_PATHS.workspace,
  ]), true)
  assert.equal(invocation.args.includes(HOST.candidate), false)
  assert.equal(invocation.env.HOME, VERIFIER_SANDBOX_PATHS.workspace)
  assert.equal(JSON.stringify(invocation).includes('test.ids'), false)
  assert.equal(JSON.stringify(invocation).includes('/sealed/'), false)
})

test('generic sandbox refuses broad or overlapping mount boundaries', () => {
  const invocation = { command: '/usr/bin/true', args: [], cwd: '/work', env: {} }
  assert.throws(() => buildBubblewrapInvocation({
    invocation,
    uid: 1001,
    gid: 2001,
    mounts: [{ source: '/safe/work', destination: '/tmp/work', readOnly: false }],
  }), ProtocolError)
  assert.throws(() => buildBubblewrapInvocation({
    invocation,
    uid: 1001,
    gid: 2001,
    mounts: [
      { source: '/safe', destination: '/work', readOnly: false },
      { source: '/safe/nested', destination: '/opt/nested', readOnly: true },
    ],
  }), ProtocolError)
})

test('generic sandbox can provide an empty proc directory for restricted kernels', () => {
  const result = buildBubblewrapInvocation({
    invocation: { command: '/usr/bin/true', args: [], cwd: '/work', env: {} },
    uid: 1001,
    gid: 2001,
    procMode: 'empty',
    mounts: [{ source: '/safe/work', destination: '/work', readOnly: false }],
  })
  assert.equal(includesSequence(result.args, ['--dir', '/proc']), true)
  assert.equal(result.args.includes('--proc'), false)
  assert.throws(() => buildBubblewrapInvocation({
    invocation: { command: '/usr/bin/true', args: [], cwd: '/work', env: {} },
    uid: 1001,
    gid: 2001,
    procMode: 'host',
    mounts: [{ source: '/safe/work', destination: '/work', readOnly: false }],
  }), ProtocolError)
})

function firewallOutput(uids) {
  return [
    '-P OUTPUT ACCEPT',
    ...uids.map((uid) => `-A OUTPUT -m owner --uid-owner ${uid} -j DSH_RSI_EGRESS`),
    '-A OUTPUT -m conntrack --ctstate ESTABLISHED -j ACCEPT',
    '',
  ].join('\n')
}

test('live sandbox attestation accepts only a fail-closed dual-stack owner firewall', async () => {
  const uids = [1101, 1103, 1104]
  const commands = []
  const argumentLists = []
  const execute = async ({ command, args }) => {
    commands.push(command)
    argumentLists.push([...args])
    if (command === '/bin/true') return { exitCode: 0, stdout: 'bubblewrap 0.6.1\n' }
    if (command === '/usr/bin/env') return { exitCode: 0, stdout: 'setpriv from util-linux 2.39\n' }
    if (args.at(-1) === 'DSH_RSI_EGRESS') {
      return {
        exitCode: 0,
        stdout: '-N DSH_RSI_EGRESS\n-A DSH_RSI_EGRESS -j REJECT --reject-with icmp-port-unreachable\n',
      }
    }
    return { exitCode: 0, stdout: firewallOutput(uids) }
  }
  const result = await attestSandboxRuntime({
    bwrapPath: '/bin/true',
    setprivPath: '/usr/bin/env',
    restrictedUids: uids,
    execute,
  })
  assert.deepEqual(result.restrictedUids, uids)
  assert.equal(result.ipv4, 'attested')
  assert.equal(result.ipv6, 'attested')
  assert.ok(commands.includes('/usr/sbin/iptables'))
  assert.ok(commands.includes('/usr/sbin/ip6tables'))
  assert.equal(
    argumentLists.filter((args) => args.includes('-S')).every((args) => !args.includes('-n')),
    true,
  )

  await assert.rejects(
    () => attestSandboxRuntime({
      bwrapPath: '/bin/true',
      setprivPath: '/usr/bin/env',
      restrictedUids: uids,
      firewallCommands: ['iptables', 'ip6tables'],
      execute,
    }),
    (error) => error instanceof ProtocolError && /冻结配置/u.test(error.message),
  )

  await assert.rejects(
    () => attestSandboxRuntime({
      bwrapPath: '/bin/true',
      setprivPath: '/usr/bin/env',
      restrictedUids: uids,
      execute: async (invocation) => {
        const value = await execute(invocation)
        if (invocation.args.at(-1) === 'OUTPUT') value.stdout = firewallOutput(uids.slice(0, 2))
        return value
      },
    }),
    (error) => error instanceof ProtocolError && /egress rule/u.test(error.message),
  )

  await assert.rejects(
    () => attestSandboxRuntime({
      bwrapPath: '/bin/true',
      setprivPath: '/usr/bin/env',
      restrictedUids: uids,
      execute: async (invocation) => {
        const value = await execute(invocation)
        if (invocation.args.at(-1) === 'DSH_RSI_EGRESS') {
          value.stdout = [
            '-N DSH_RSI_EGRESS',
            '-A DSH_RSI_EGRESS -o lo -d 127.0.0.1/32 -p tcp -m tcp --dport 54321 -m owner --uid-owner 1103 -j RETURN',
            '-A DSH_RSI_EGRESS -j REJECT --reject-with icmp-port-unreachable',
            '',
          ].join('\n')
        }
        return value
      },
    }),
    (error) => error instanceof ProtocolError && /fail-closed/u.test(error.message),
  )
})

test('isolated sandbox attestation probes a no-network namespace without iptables', async () => {
  const commands = []
  const execute = async ({ command, args }) => {
    commands.push({ command, args: [...args] })
    if (args[0] === '--version' && command === '/bin/true') {
      return { exitCode: 0, stdout: 'bubblewrap 0.9.0\n' }
    }
    if (args[0] === '--version') return { exitCode: 0, stdout: 'setpriv 2.39\n' }
    return { exitCode: 0, stdout: '' }
  }
  const result = await attestSandboxRuntime({
    bwrapPath: '/bin/true',
    setprivPath: '/usr/bin/env',
    restrictedUids: [1101, 1102, 1103, 1104],
    isolatedNetwork: true,
    execute,
  })
  assert.equal(result.ipv4, 'isolated')
  assert.equal(result.ipv6, 'isolated')
  assert.equal(commands.some(({ command }) => command.includes('iptables')), false)
  const probe = commands.find(({ args }) => args.includes('--unshare-net'))
  assert.ok(probe)
  assert.ok(probe.args.includes('/proc'))
  assert.equal(probe.args.includes('--proc'), false)
})

test('gateway egress leases expose one exact IPv4 loopback UID/port and release idempotently', async () => {
  const invocations = []
  const installed = new Set()
  const execute = async (invocation) => {
    invocations.push(structuredClone(invocation))
    const action = invocation.args[2]
    const port = invocation.args[invocation.args.indexOf('--dport') + 1]
    if (action === '-I') installed.add(port)
    if (action === '-D') installed.delete(port)
    return {
      exitCode: action === '-C' && !installed.has(port) ? 1 : 0,
      stdout: '',
      stderr: '',
    }
  }
  const first = await acquireGatewayEgressLease({
    gatewayUrl: 'http://127.0.0.1:43127/v1',
    uid: 1103,
    execute,
  })
  const second = await acquireGatewayEgressLease({
    gatewayUrl: 'http://127.0.0.1:43128/v1',
    uid: 1103,
    execute,
  })
  assert.deepEqual({ uid: first.uid, port: first.port }, { uid: 1103, port: 43127 })
  assert.deepEqual({ uid: second.uid, port: second.port }, { uid: 1103, port: 43128 })

  const expectedRule = [
    '-o', 'lo', '-d', '127.0.0.1/32', '-p', 'tcp', '--dport', '43127',
    '-m', 'owner', '--uid-owner', '1103', '-j', 'RETURN',
  ]
  assert.deepEqual(invocations[0], {
    command: '/usr/sbin/iptables',
    args: ['-w', '5', '-I', 'DSH_RSI_EGRESS', '1', ...expectedRule],
  })
  assert.deepEqual(invocations[1], {
    command: '/usr/sbin/iptables',
    args: ['-w', '5', '-C', 'DSH_RSI_EGRESS', ...expectedRule],
  })

  await Promise.all([first.release(), second.release(), first.release(), second.release()])
  const deletes = invocations.filter(({ args }) => args.includes('-D'))
  assert.equal(deletes.length, 2)
  assert.deepEqual(deletes.map(({ args }) => args[args.indexOf('--dport') + 1]).sort(), ['43127', '43128'])
  assert.equal(invocations.every(({ command }) => command === '/usr/sbin/iptables'), true)
  const serialized = JSON.stringify(invocations)
  assert.equal(serialized.includes('api-key'), false)
  assert.equal(serialized.includes('candidate'), false)
  assert.equal(serialized.includes('putnam_'), false)
})

test('gateway egress lease rejects non-canonical endpoints and rolls back partial acquisition', async () => {
  const invalid = [
    'https://127.0.0.1:443/v1',
    'http://localhost:43127/v1',
    'http://127.1:43127/v1',
    'http://2130706433:43127/v1',
    'http://127.0.0.1/v1',
    'http://127.0.0.1:043127/v1',
    'http://127.0.0.1:65536/v1',
    'http://user@127.0.0.1:43127/v1',
    'http://127.0.0.1:43127/v1?secret=value',
  ]
  for (const gatewayUrl of invalid) {
    await assert.rejects(
      () => acquireGatewayEgressLease({ gatewayUrl, uid: 1103, execute: async () => ({ exitCode: 0 }) }),
      ProtocolError,
    )
  }

  const invocations = []
  await assert.rejects(
    () => acquireGatewayEgressLease({
      gatewayUrl: 'http://127.0.0.1:43127/v1',
      uid: 1103,
      execute: async (invocation) => {
        invocations.push(structuredClone(invocation))
        return { exitCode: invocation.args.includes('-C') ? 1 : 0, stdout: '', stderr: '' }
      },
    }),
    (error) => error instanceof SandboxEgressLeaseError && error.kind === 'infrastructure',
  )
  assert.deepEqual(invocations.map(({ args }) => args[2]), ['-I', '-C', '-D', '-C'])

  const ambiguousInsert = []
  await assert.rejects(
    () => acquireGatewayEgressLease({
      gatewayUrl: 'http://127.0.0.1:43129/v1',
      uid: 1104,
      execute: async (invocation) => {
        ambiguousInsert.push(structuredClone(invocation))
        const action = invocation.args[2]
        return { exitCode: action === '-I' ? 4 : 1, stdout: '', stderr: '' }
      },
    }),
    (error) => error instanceof SandboxEgressLeaseError && error.fatal === false,
  )
  assert.deepEqual(ambiguousInsert.map(({ args }) => args[2]), ['-I', '-D', '-C'])
})

test('unremovable gateway rule poisons its UID after bounded confirmed cleanup attempts', async () => {
  const uid = 901103
  const invocations = []
  const execute = async (invocation) => {
    invocations.push(structuredClone(invocation))
    const action = invocation.args[2]
    if (action === '-D') return { exitCode: 4, stdout: '', stderr: 'xtables lock failure' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const lease = await acquireGatewayEgressLease({
    gatewayUrl: 'http://127.0.0.1:53127/v1',
    uid,
    execute,
  })
  await assert.rejects(
    () => lease.release(),
    (error) => error instanceof SandboxEgressLeaseError
      && error.kind === 'infrastructure'
      && error.fatal === true
      && error.uid === uid,
  )
  assert.equal(invocations.filter(({ args }) => args[2] === '-D').length, 3)
  assert.equal(invocations.filter(({ args }) => args[2] === '-C').length, 4)

  const callsBeforePoisonCheck = invocations.length
  await assert.rejects(
    () => acquireGatewayEgressLease({
      gatewayUrl: 'http://127.0.0.1:53128/v1',
      uid,
      execute,
    }),
    (error) => error instanceof SandboxEgressLeaseError
      && error.fatal === true
      && error.uid === uid,
  )
  assert.equal(invocations.length, callsBeforePoisonCheck)
})
