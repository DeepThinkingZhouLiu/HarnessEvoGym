import { dirname, join, resolve } from 'node:path'

import {
  createHlePartitionRuntime,
} from './hle-partition-runner.mjs'
import { MODEL_GATEWAY_RELAY_URL } from './model-gateway-relay.mjs'
import { runPartition as runGenericPartition } from './partition-runner.mjs'
import { runHarnessSolver } from './putnambench-runner.mjs'
import { ProtocolError } from './protocol.mjs'
import { buildBubblewrapInvocation, SOLVER_SANDBOX_PATHS } from './sandbox.mjs'

const GATEWAY_SANDBOX_ROOT = '/opt/harness-rsi/gateway'

function solverEnvironment(baseEnvironment = {}) {
  const output = {}
  for (const key of ['LANG', 'LC_ALL', 'PATH', 'TZ']) {
    if (typeof baseEnvironment[key] === 'string') output[key] = baseEnvironment[key]
  }
  return output
}

export function buildMsaHarnessInvocation({
  candidateRoot,
  workdir,
  sessionRoot,
  prompt,
  gatewaySocketPath,
  gatewayDummyKey,
  baseEnvironment,
}) {
  if (typeof gatewaySocketPath !== 'string' || gatewaySocketPath.length === 0) {
    throw new ProtocolError('MSA Solver 缺少 model gateway socket')
  }
  return {
    command: '/usr/bin/python3',
    args: [
      join(resolve(candidateRoot), 'run.py'),
      '--task', prompt,
      '--answer', join(resolve(workdir), 'answer.txt'),
      '--trace', join(resolve(sessionRoot), 'agent.jsonl'),
      '--profile', 'math',
    ],
    cwd: resolve(workdir),
    env: {
      ...solverEnvironment(baseEnvironment),
      HOME: resolve(workdir),
      TMPDIR: '/tmp',
      PYTHONDONTWRITEBYTECODE: '1',
      RSI_MODEL_GATEWAY_SOCKET: resolve(gatewaySocketPath),
      RSI_MODEL_GATEWAY_DUMMY_KEY: gatewayDummyKey,
    },
  }
}

export function buildMsaSolverSandboxInvocation({
  invocation,
  candidateRoot,
  workdir,
  solverUid,
  solverGid,
  bwrapPath,
  setprivPath,
  gatewaySocketPath,
}) {
  if (invocation.env.RSI_MODEL_GATEWAY_SOCKET !== gatewaySocketPath) {
    throw new ProtocolError('MSA Solver gateway socket 不一致')
  }
  return buildBubblewrapInvocation({
    invocation,
    uid: solverUid,
    gid: solverGid,
    bwrapPath,
    setprivPath,
    network: 'none',
    procMode: 'empty',
    hostname: 'rsi-msa-solver',
    mounts: [
      { source: candidateRoot, destination: SOLVER_SANDBOX_PATHS.candidate, readOnly: true },
      {
        source: dirname(resolve(gatewaySocketPath)),
        destination: GATEWAY_SANDBOX_ROOT,
        readOnly: true,
      },
      { source: workdir, destination: SOLVER_SANDBOX_PATHS.workspace, readOnly: false },
    ],
  })
}

export function createMsaHlePartitionRuntime(options) {
  const hle = createHlePartitionRuntime(options)
  return Object.freeze({
    ...hle,
    buildHarnessInvocation: buildMsaHarnessInvocation,
    runHarnessSolver,
    buildSolverSandboxInvocation: buildMsaSolverSandboxInvocation,
  })
}

export async function runPartition(options) {
  return runGenericPartition({
    ...options,
    benchmark: 'hle-text-math',
    runtime: createMsaHlePartitionRuntime(options),
  })
}

export { MODEL_GATEWAY_RELAY_URL }
