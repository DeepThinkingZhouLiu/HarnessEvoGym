import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  InfrastructurePartitionError,
  PartitionAbortedError,
  collectJsonl,
  runPartition,
} from '../src/partition-runner.mjs'
import { ProtocolError } from '../src/protocol.mjs'

const IDS = ['putnam_1962_a1', 'putnam_1962_a2']

function solverResult(status, failureKind, durationMs = 10) {
  return {
    status,
    phase: 'solver',
    failureKind,
    reasonCode: null,
    timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', durationMs },
    traceRef: null,
  }
}

function verifierResult(status, failureKind, durationMs = 5) {
  return {
    status,
    phase: 'verifier',
    failureKind,
    reasonCode: null,
    timing: { startedAt: '2026-01-01T00:00:01Z', endedAt: '2026-01-01T00:00:02Z', durationMs },
    traceRef: null,
  }
}

async function fixture(instanceIds = [IDS[0]]) {
  const root = await mkdtemp(join(tmpdir(), 'partition-runner-'))
  const solutionsRoot = join(root, 'solutions')
  const scratchRoot = join(root, 'scratch')
  await Promise.all([mkdir(solutionsRoot), mkdir(scratchRoot)])
  for (const id of instanceIds) {
    await writeFile(join(solutionsRoot, `${id}_sol.lean`), `import Mathlib\ntheorem ${id} : True := sorry\n`)
  }
  return {
    root,
    options: {
      candidateId: 'candidate-1',
      instanceIds,
      candidateRoot: join(root, 'candidate'),
      solutionsRoot,
      leanRoot: join(root, 'lean'),
      scratchRoot,
      nodePath: '/usr/bin/node',
      patchPath: join(root, 'runtime.patch.yml'),
      upstreamBaseUrl: 'https://provider.invalid/v1',
      getApiKey: async () => 'fixture-provider-key',
      concurrency: 1,
      traceMaximumBytes: 4096,
    },
  }
}

function scriptedRuntime({
  solvers,
  verifiers = [],
  auditUsage = true,
  auditRecords = [],
  requestsPerSolver = 1,
  gatewayStats = () => ({}),
}) {
  let gateway
  let receivedGatewayOptions
  let solverCalls = 0
  let verifierCalls = 0
  let closed = 0
  const runtime = {
    async startModelGateway(options) {
      receivedGatewayOptions = options
      const state = { total: 0, maximum: options.maxRequests, audit: options.audit }
      gateway = {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({
          totalRequests: state.total,
          remainingRequests: Math.max(0, state.maximum - state.total),
          ...gatewayStats(state),
        }),
        close: async () => { closed += 1 },
        state,
      }
      return gateway
    },
    buildHarnessInvocation(options) {
      return {
        command: '/fake/node', args: [], cwd: options.workdir,
        env: { DSH_SESSION_ROOT: options.sessionRoot },
      }
    },
    async runHarnessSolver({ invocation }) {
      const result = solvers[Math.min(solverCalls, solvers.length - 1)]
      solverCalls += 1
      gateway.state.total += requestsPerSolver
      if (auditUsage) {
        gateway.state.audit(auditRecords[solverCalls - 1] ?? {
          status: 200,
          origin: 'upstream',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })
      }
      await writeFile(join(invocation.env.DSH_SESSION_ROOT, 'agent.jsonl'), `${'汉'.repeat(20)}\n`)
      return result
    },
    async verifyTask() {
      const result = verifiers[Math.min(verifierCalls, verifiers.length - 1)]
        ?? verifierResult('verified', null)
      verifierCalls += 1
      return result
    },
  }
  return {
    runtime,
    counts: () => ({ solverCalls, verifierCalls, closed, requests: gateway?.state.total ?? 0 }),
    gatewayOptions: () => receivedGatewayOptions,
  }
}

test('partition error classes distinguish infrastructure from cancellation', () => {
  const infrastructure = new InfrastructurePartitionError(2, 10)
  assert.equal(infrastructure.kind, 'infrastructure')
  assert.equal(infrastructure.errorCount, 2)
  assert.match(infrastructure.message, /2\/10/u)

  const aborted = new PartitionAbortedError(3, 10)
  assert.equal(aborted.kind, 'cancelled')
  assert.equal(aborted.completed, 3)
})

test('JSONL collection enforces an exact UTF-8 byte ceiling and marks truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'partition-trace-'))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'trace.jsonl'), `${'汉🙂'.repeat(2000)}\n`)
  const trace = await collectJsonl(root, 160)
  assert.ok(Buffer.byteLength(trace) <= 160)
  assert.match(trace, /"traceTruncated":true/u)
  assert.equal(Buffer.from(trace, 'utf8').toString('utf8'), trace)
})

test('solver infrastructure retry shares one total model-request budget', async () => {
  const { options, root } = await fixture()
  const scripted = scriptedRuntime({
    solvers: [
      solverResult('infrastructure_error', 'infrastructure', 11),
      solverResult('completed', null, 13),
    ],
    verifiers: [verifierResult('verified', null, 7)],
  })
  let trace
  const result = await runPartition({
    ...options,
    maximumModelRequestsPerTask: 2,
    infrastructureRetries: 5,
    runtime: scripted.runtime,
    onTrace: async (payload) => { trace = payload.text; return 'trace://one' },
  })
  assert.equal(result.summary.verified, 1)
  assert.deepEqual(result.summary.usage, {
    requests: 2,
    upstreamAttempts: 2,
    transientRetries: 0,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
  })
  assert.equal(result.records[0].attempts, 2)
  assert.equal(result.records[0].verifierAttempts, 1)
  assert.equal(result.records[0].latencyMs, 31)
  assert.deepEqual(scripted.counts(), { solverCalls: 2, verifierCalls: 1, closed: 1, requests: 2 })
  assert.equal(scripted.gatewayOptions().maxTransientRetries, 2)
  assert.match(trace, /"solverAttempt":2/u)
  assert.deepEqual(await readdir(options.scratchRoot), [])
  assert.ok(root)
})

test('partition usage preserves logical requests and exact physical retry accounting', async () => {
  const { options } = await fixture()
  const scripted = scriptedRuntime({
    solvers: [solverResult('completed', null)],
    requestsPerSolver: 16,
    gatewayStats: () => ({ upstreamAttempts: 18, transientRetries: 2 }),
    auditRecords: [{
      status: 200,
      origin: 'upstream',
      upstreamAttempts: 3,
      transientRetries: 2,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }],
  })
  const result = await runPartition({
    ...options,
    maximumModelRequestsPerTask: 16,
    maxTransientRetries: 2,
    runtime: scripted.runtime,
  })
  assert.deepEqual(result.records[0].usage, {
    requests: 16,
    upstreamAttempts: 18,
    transientRetries: 2,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  })
  assert.deepEqual(result.summary.usage, result.records[0].usage)
  assert.equal(scripted.gatewayOptions().maxTransientRetries, 2)
})

test('legacy gateways derive physical attempts from terminal audits without NaN', async () => {
  const { options } = await fixture()
  const scripted = scriptedRuntime({
    solvers: [solverResult('completed', null)],
    auditRecords: [{
      status: 200,
      origin: 'upstream',
      upstreamAttempts: 3,
      transientRetries: 2,
      usage: { inputTokens: Number.NaN, outputTokens: 5, totalTokens: 5 },
    }],
  })
  const result = await runPartition({ ...options, runtime: scripted.runtime })
  assert.deepEqual(result.summary.usage, {
    requests: 1,
    upstreamAttempts: 3,
    transientRetries: 2,
    inputTokens: 0,
    outputTokens: 5,
    totalTokens: 5,
  })
  assert.equal(Object.values(result.summary.usage).every(Number.isSafeInteger), true)

  const localFixture = await fixture()
  const localOnly = scriptedRuntime({
    solvers: [solverResult('completed', null)],
    auditRecords: [{ status: 502, origin: 'credential' }],
  })
  const localResult = await runPartition({
    ...localFixture.options,
    runtime: localOnly.runtime,
  })
  assert.equal(localResult.summary.usage.requests, 1)
  assert.equal(localResult.summary.usage.upstreamAttempts, 0)
  assert.equal(localResult.summary.usage.transientRetries, 0)
})

test('exhausted model-request budget suppresses a pointless solver retry', async () => {
  const { options } = await fixture()
  const scripted = scriptedRuntime({
    solvers: [solverResult('infrastructure_error', 'infrastructure')],
  })
  await assert.rejects(
    () => runPartition({
      ...options,
      maximumModelRequestsPerTask: 1,
      infrastructureRetries: 5,
      runtime: scripted.runtime,
    }),
    (error) => error instanceof InfrastructurePartitionError && error.errorCount === 1,
  )
  assert.deepEqual(scripted.counts(), { solverCalls: 1, verifierCalls: 0, closed: 1, requests: 1 })
  assert.deepEqual(await readdir(options.scratchRoot), [])
})

test('terminal upstream/provider failures are infrastructure while local policy errors are candidate failures', async () => {
  const providerFixture = await fixture()
  const provider = scriptedRuntime({
    solvers: [
      solverResult('candidate_error', 'candidate'),
      solverResult('completed', null),
    ],
    auditRecords: [
      { status: 429, origin: 'upstream' },
      {
        status: 200,
        origin: 'upstream',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ],
  })
  const recovered = await runPartition({
    ...providerFixture.options,
    maximumModelRequestsPerTask: 2,
    infrastructureRetries: 1,
    runtime: provider.runtime,
  })
  assert.equal(recovered.summary.verified, 1)
  assert.equal(recovered.records[0].attempts, 2)

  const policyFixture = await fixture()
  const policy = scriptedRuntime({
    solvers: [solverResult('candidate_error', 'candidate')],
    auditRecords: [{ status: 429, origin: 'gateway' }],
  })
  const rejected = await runPartition({
    ...policyFixture.options,
    maximumModelRequestsPerTask: 1,
    infrastructureRetries: 2,
    runtime: policy.runtime,
  })
  assert.equal(rejected.records[0].status, 'unresolved')
  assert.equal(rejected.records[0].failureKind, 'candidate')
  assert.equal(rejected.records[0].attempts, 1)
})

test('any provider failure makes a failed concurrent attempt infrastructure', async () => {
  const { options } = await fixture()
  let audit
  let requestSequence = 0
  const runtime = {
    async startModelGateway(gatewayOptions) {
      audit = gatewayOptions.audit
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({ totalRequests: 1, remainingRequests: 0, requestSequence }),
        async waitForIdle() {},
        async close() {},
      }
    },
    buildHarnessInvocation: (value) => ({
      command: '/fake/node', args: [], cwd: value.workdir,
      env: { DSH_SESSION_ROOT: value.sessionRoot },
    }),
    async runHarnessSolver() {
      // Completion order is deliberately the inverse of arrival order. Without
      // request-id causality, a real provider failure makes this attempt unsafe
      // to score as Candidate evidence even when a newer local rejection exists.
      audit({ requestSequence: 2, status: 429, origin: 'gateway', localReason: 'request_budget' })
      audit({ requestSequence: 1, status: 429, origin: 'upstream' })
      requestSequence = 2
      return solverResult('candidate_error', 'candidate')
    },
    async verifyTask() { throw new Error('verifier must not run') },
  }
  await assert.rejects(
    () => runPartition({
      ...options,
      maximumModelRequestsPerTask: 1,
      runtime,
    }),
    (error) => error instanceof InfrastructurePartitionError && error.errorCount === 1,
  )
})

test('attempt watermark returns an empty set instead of reusing a late older audit', async () => {
  const { options } = await fixture()
  let audit
  let requestSequence = 0
  let solverCalls = 0
  const runtime = {
    async startModelGateway(gatewayOptions) {
      audit = gatewayOptions.audit
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({
          totalRequests: 2,
          remainingRequests: 1,
          requestSequence,
        }),
        async waitForIdle() {},
        async close() {},
      }
    },
    buildHarnessInvocation: (value) => ({
      command: '/fake/node', args: [], cwd: value.workdir,
      env: { DSH_SESSION_ROOT: value.sessionRoot },
    }),
    async runHarnessSolver() {
      solverCalls += 1
      if (solverCalls === 1) {
        requestSequence = 1
        audit({ requestSequence: 1, status: 503, origin: 'upstream' })
        // A second request from attempt 1 was accepted, but its audit has not
        // completed when the first attempt's barrier incorrectly returns.
        requestSequence = 2
      } else {
        // The old audit completes after attempt 2 captured watermark 2.
        audit({ requestSequence: 2, status: 503, origin: 'upstream' })
      }
      return solverResult('candidate_error', 'candidate')
    },
    async verifyTask() { throw new Error('verifier must not run') },
  }
  const result = await runPartition({
    ...options,
    maximumModelRequestsPerTask: 3,
    infrastructureRetries: 1,
    runtime,
  })
  assert.equal(solverCalls, 2)
  assert.equal(result.records[0].status, 'unresolved')
  assert.equal(result.records[0].failureKind, 'candidate')
})

test('solver retries rotate the per-attempt dummy credential', async () => {
  const { options } = await fixture()
  let audit
  let requestSequence = 0
  let totalRequests = 0
  let solverCalls = 0
  const invocationKeys = []
  const rotatedKeys = []
  const runtime = {
    async startModelGateway(gatewayOptions) {
      audit = gatewayOptions.audit
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({
          totalRequests,
          remainingRequests: 2 - totalRequests,
          requestSequence,
        }),
        rotateCandidateApiKey(value) { rotatedKeys.push(value) },
        async waitForIdle() {},
        async close() {},
      }
    },
    buildHarnessInvocation(value) {
      invocationKeys.push(value.gatewayDummyKey)
      return {
        command: '/fake/node', args: [], cwd: value.workdir,
        env: { DSH_SESSION_ROOT: value.sessionRoot },
      }
    },
    async runHarnessSolver() {
      solverCalls += 1
      totalRequests += 1
      requestSequence += 1
      audit(solverCalls === 1
        ? { requestSequence, status: 503, origin: 'upstream' }
        : {
            requestSequence,
            status: 200,
            origin: 'upstream',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          })
      return solverCalls === 1
        ? solverResult('candidate_error', 'candidate')
        : solverResult('completed', null)
    },
    async verifyTask() { return verifierResult('verified', null) },
  }
  const result = await runPartition({
    ...options,
    maximumModelRequestsPerTask: 2,
    infrastructureRetries: 1,
    runtime,
  })
  assert.equal(result.summary.verified, 1)
  assert.equal(invocationKeys.length, 2)
  assert.notEqual(invocationKeys[0], invocationKeys[1])
  assert.equal(rotatedKeys[0], invocationKeys[1])
  assert.notEqual(rotatedKeys[1], invocationKeys[1])
})

test('first infrastructure record stops scheduling untouched partition work', async () => {
  const ids = [
    'putnam_1962_a1',
    'putnam_1962_a2',
    'putnam_1962_a3',
    'putnam_1962_a4',
  ]
  const { options } = await fixture(ids)
  const scripted = scriptedRuntime({
    solvers: [solverResult('infrastructure_error', 'infrastructure')],
  })
  await assert.rejects(
    () => runPartition({
      ...options,
      concurrency: 1,
      infrastructureRetries: 0,
      runtime: scripted.runtime,
    }),
    (error) => error instanceof InfrastructurePartitionError
      && error.errorCount === 1
      && error.total === ids.length,
  )
  assert.equal(scripted.counts().solverCalls, 1)
})

test('a direct task exception stops scheduling untouched partition work', async () => {
  const ids = [
    'putnam_1962_a1',
    'putnam_1962_a2',
    'putnam_1962_a3',
    'putnam_1962_a4',
  ]
  const { options } = await fixture(ids)
  let gatewayStarts = 0
  let releaseInFlight
  const inFlight = new Promise((resolve) => { releaseInFlight = resolve })
  const runtime = {
    async startModelGateway() {
      gatewayStarts += 1
      if (gatewayStarts === 2) releaseInFlight()
      await inFlight
      throw new Error('gateway setup failed')
    },
  }
  await assert.rejects(
    () => runPartition({ ...options, concurrency: 2, runtime }),
    (error) => error instanceof InfrastructurePartitionError
      && error.errorCount === 2
      && error.total === ids.length,
  )
  // The two already in-flight workers may finish, but neither may claim one of
  // the two untouched tasks after the shared stop flag is set.
  assert.equal(gatewayStarts, 2)
})

test('verifier infrastructure retry reuses the proof without another model call', async () => {
  const { options } = await fixture()
  const scripted = scriptedRuntime({
    solvers: [solverResult('completed', null, 10)],
    verifiers: [
      verifierResult('timeout', 'infrastructure', 3),
      verifierResult('verified', null, 4),
    ],
  })
  const result = await runPartition({
    ...options,
    maximumModelRequestsPerTask: 1,
    infrastructureRetries: 2,
    runtime: scripted.runtime,
  })
  assert.equal(result.summary.verified, 1)
  assert.equal(result.records[0].attempts, 1)
  assert.equal(result.records[0].verifierAttempts, 2)
  assert.equal(result.records[0].latencyMs, 17)
  assert.deepEqual(scripted.counts(), { solverCalls: 1, verifierCalls: 2, closed: 1, requests: 1 })
})

test('sandboxed task leases only its gateway before Solver and releases before close', async () => {
  const { options } = await fixture()
  const events = []
  const runtime = {
    async startModelGateway() {
      events.push('gateway:start')
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({ totalRequests: 1, remainingRequests: 1 }),
        async close() { events.push('gateway:close') },
      }
    },
    async acquireGatewayEgressLease({ gatewayUrl, uid }) {
      assert.equal(gatewayUrl, 'http://127.0.0.1:54321/v1')
      assert.equal(uid, 1103)
      events.push('lease:acquire')
      return { async release() { events.push('lease:release') } }
    },
    buildHarnessInvocation(value) {
      return { command: '/usr/bin/true', args: [], cwd: value.workdir, env: {} }
    },
    async runHarnessSolver() {
      events.push('solver:start')
      await Promise.resolve()
      events.push('solver:end')
      return solverResult('completed', null)
    },
    async verifyTask() {
      events.push('verifier:end')
      return verifierResult('verified', null)
    },
  }
  const result = await runPartition({
    ...options,
    lakePath: '/usr/bin/true',
    solverUid: 1103,
    solverGid: 2103,
    verifierUid: 1104,
    verifierGid: 2104,
    runtime,
  })
  assert.equal(result.summary.verified, 1)
  assert.deepEqual(events, [
    'gateway:start',
    'lease:acquire',
    'solver:start',
    'solver:end',
    'verifier:end',
    'lease:release',
    'gateway:close',
  ])
})

test('gateway lease acquisition failure starts no Solver and still closes the gateway', async () => {
  const { options } = await fixture()
  const events = []
  const runtime = {
    async startModelGateway() {
      events.push('gateway:start')
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({ totalRequests: 0, remainingRequests: 1 }),
        async close() { events.push('gateway:close') },
      }
    },
    async acquireGatewayEgressLease() {
      events.push('lease:fail')
      const error = new Error('iptables unavailable')
      error.kind = 'infrastructure'
      throw error
    },
    buildHarnessInvocation() { throw new Error('must not build Solver invocation') },
    async runHarnessSolver() { throw new Error('must not run Solver') },
    async verifyTask() { throw new Error('must not verify') },
  }
  await assert.rejects(
    () => runPartition({
      ...options,
      lakePath: '/usr/bin/true',
      solverUid: 1103,
      solverGid: 2103,
      verifierUid: 1104,
      verifierGid: 2104,
      runtime,
    }),
    (error) => error instanceof InfrastructurePartitionError && error.kind === 'infrastructure',
  )
  assert.deepEqual(events, ['gateway:start', 'lease:fail', 'gateway:close'])
  assert.deepEqual(await readdir(options.scratchRoot), [])
})

test('candidate timeout is scored as timeout while cancellation aborts the partition', async () => {
  const first = await fixture()
  const timedOut = scriptedRuntime({ solvers: [solverResult('timeout', 'candidate')] })
  const timeoutResult = await runPartition({ ...first.options, runtime: timedOut.runtime })
  assert.equal(timeoutResult.records[0].status, 'timeout')
  assert.equal(timeoutResult.records[0].failureKind, 'candidate')

  const second = await fixture()
  const cancelled = scriptedRuntime({ solvers: [solverResult('aborted', 'cancelled')] })
  await assert.rejects(
    () => runPartition({ ...second.options, runtime: cancelled.runtime }),
    (error) => error instanceof PartitionAbortedError && error.kind === 'cancelled',
  )
  assert.deepEqual(await readdir(second.options.scratchRoot), [])
})

test('sealed progress exposes only opaque completion counts', async () => {
  const { options } = await fixture(IDS)
  const events = []
  const callbackOrder = []
  const traces = []
  const runtime = {
    async startModelGateway() {
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({ totalRequests: 0, remainingRequests: 10 }),
        close: async () => {},
      }
    },
    buildHarnessInvocation: (value) => ({
      command: '/fake/node', args: [], cwd: value.workdir,
      env: { DSH_SESSION_ROOT: value.sessionRoot },
    }),
    runHarnessSolver: async () => solverResult('completed', null),
    verifyTask: async () => verifierResult('verified', null),
  }
  const result = await runPartition({
    ...options,
    concurrency: 2,
    sealed: true,
    runtime,
    onTrace: async (payload) => { traces.push(payload); return `sealed://${payload.taskId}` },
    onRecord: async (record) => {
      assert.equal(Object.isFrozen(record), true)
      assert.equal(Object.isFrozen(record.usage), true)
      callbackOrder.push(`record:${record.instanceId}`)
    },
    onProgress: async (event) => {
      events.push(event)
      callbackOrder.push(`progress:${event.completed}`)
    },
  })
  assert.equal(result.summary.verified, 2)
  assert.equal(events.length, 2)
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['completed', 'total', 'type'])
    assert.equal(event.type, 'sealed-task-complete')
    assert.equal(JSON.stringify(event).includes('putnam_'), false)
    assert.equal(Object.hasOwn(event, 'status'), false)
  }
  assert.equal(traces.every((trace) => trace.sealed === true), true)
  assert.equal(callbackOrder.length, 4)
  assert.match(callbackOrder[0], /^record:putnam_/u)
  assert.equal(callbackOrder[1], 'progress:1')
  assert.match(callbackOrder[2], /^record:putnam_/u)
  assert.equal(callbackOrder[3], 'progress:2')
})

test('onRecord failure is infrastructure, suppresses progress, waits for peers, and cleans', async () => {
  const { options } = await fixture(IDS)
  let solverCalls = 0
  let progressCalls = 0
  const runtime = {
    async startModelGateway() {
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({ totalRequests: 0, remainingRequests: 10 }),
        close: async () => {},
      }
    },
    buildHarnessInvocation: (value) => ({
      command: '/fake/node', args: [], cwd: value.workdir,
      env: { DSH_SESSION_ROOT: value.sessionRoot },
    }),
    async runHarnessSolver() {
      solverCalls += 1
      if (solverCalls === 2) await new Promise((accept) => setTimeout(accept, 25))
      return solverResult('completed', null)
    },
    verifyTask: async () => verifierResult('verified', null),
  }
  await assert.rejects(
    () => runPartition({
      ...options,
      concurrency: 2,
      runtime,
      onRecord: async () => { throw new Error('checkpoint unavailable') },
      onProgress: () => { progressCalls += 1 },
    }),
    (error) => error instanceof InfrastructurePartitionError && error.kind === 'infrastructure',
  )
  assert.equal(solverCalls, 2)
  assert.equal(progressCalls, 0)
  assert.deepEqual(await readdir(options.scratchRoot), [])
})

test('worker and trace failures wait for peers and clean every opaque run directory', async () => {
  const { options } = await fixture(IDS)
  let solverCalls = 0
  const seenTraces = []
  const runtime = {
    async startModelGateway() {
      return {
        url: 'http://127.0.0.1:54321/v1',
        stats: () => ({ totalRequests: 0, remainingRequests: 10 }),
        close: async () => {},
      }
    },
    buildHarnessInvocation: (value) => ({
      command: '/fake/node', args: [], cwd: value.workdir,
      env: { DSH_SESSION_ROOT: value.sessionRoot },
    }),
    async runHarnessSolver() {
      solverCalls += 1
      if (solverCalls === 2) await new Promise((accept) => setTimeout(accept, 25))
      return solverResult('completed', null)
    },
    verifyTask: async () => verifierResult('verified', null),
  }
  await assert.rejects(
    () => runPartition({
      ...options,
      concurrency: 2,
      runtime,
      onTrace: async ({ problemId }) => {
        seenTraces.push(problemId)
        if (problemId === IDS[0]) throw new Error('trace sink unavailable')
        return `trace://${problemId}`
      },
    }),
    (error) => error instanceof InfrastructurePartitionError && error.kind === 'infrastructure',
  )
  assert.deepEqual(new Set(seenTraces), new Set(IDS))
  assert.deepEqual(await readdir(options.scratchRoot), [])
})

test('invalid budgets are rejected before any task starts', async () => {
  const { options } = await fixture()
  await assert.rejects(
    () => runPartition({ ...options, infrastructureRetries: -1 }),
    ProtocolError,
  )
  await assert.rejects(
    () => runPartition({ ...options, traceMaximumBytes: 64 }),
    ProtocolError,
  )
  await assert.rejects(
    () => runPartition({ ...options, maximumModelRequestsPerTask: 0 }),
    ProtocolError,
  )
  for (const maxTransientRetries of [-1, 9]) {
    await assert.rejects(
      () => runPartition({ ...options, maxTransientRetries }),
      ProtocolError,
    )
  }
  await assert.rejects(
    () => runPartition({ ...options, solverUid: 1103, solverGid: 2103 }),
    (error) => error instanceof ProtocolError && /Verifier uid\/gid/u.test(error.message),
  )
  await assert.rejects(
    () => runPartition({
      ...options,
      solverUid: 1103,
      solverGid: 2103,
      verifierUid: 1103,
      verifierGid: 2104,
    }),
    (error) => error instanceof ProtocolError && /不同 uid\/gid/u.test(error.message),
  )
  assert.deepEqual(await readdir(options.scratchRoot), [])
})
