import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMsaHarnessInvocation,
  buildMsaSolverSandboxInvocation,
} from '../src/msa-hle-partition-runner.mjs'

test('MSA HLE invocation uses Python, one writable workspace, and a Unix gateway', () => {
  const invocation = buildMsaHarnessInvocation({
    candidateRoot: '/candidate',
    workdir: '/task',
    sessionRoot: '/task/.sessions',
    prompt: '2 + 2?',
    gatewaySocketPath: '/gateway/gateway.sock',
    gatewayDummyKey: 'dummy-key',
    baseEnvironment: { PATH: '/usr/bin:/bin' },
  })
  assert.equal(invocation.command, '/usr/bin/python3')
  assert.equal(invocation.cwd, '/task')
  assert.equal(invocation.env.RSI_MODEL_GATEWAY_SOCKET, '/gateway/gateway.sock')
  assert.ok(invocation.args.includes('/task/answer.txt'))

  const sandboxed = buildMsaSolverSandboxInvocation({
    invocation,
    candidateRoot: '/candidate',
    workdir: '/task',
    solverUid: 1001,
    solverGid: 1001,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
    gatewaySocketPath: '/gateway/gateway.sock',
  })
  assert.equal(sandboxed.command, '/usr/bin/setpriv')
  assert.ok(sandboxed.args.includes('--unshare-net'))
  assert.equal(sandboxed.args.includes('--proc'), false)
  assert.ok(sandboxed.args.includes('/opt/harness-rsi/candidate/run.py'))
  assert.ok(sandboxed.args.includes('/work/answer.txt'))
})
