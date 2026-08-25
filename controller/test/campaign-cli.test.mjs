import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  attestRuntimePatch,
  buildAgentEnvironment,
  buildPartitionOptions,
  createSealedRunner,
  runCampaignCliCommand,
  safeProgressEvent,
} from '../src/campaign-cli.mjs'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

function ids(count, startYear, series = 'a') {
  return Array.from({ length: count }, (_, index) => (
    `putnam_${String(startYear + Math.floor(index / 6)).padStart(4, '0')}_${series}${(index % 6) + 1}`
  ))
}

function campaignFixture() {
  return {
    config: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionCampaign',
      metadata: { id: 'fixture-campaign', name: 'fixture' },
      spec: {
        source: {},
        partitions: {
          validation: { manifest: 'validation.ids', expectedCount: 500 },
          test: { manifest: 'test.ids', expectedCount: 172, sha256: SHA_B },
        },
        solver: {
          preset: 'standard',
          api: 'openai-responses',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'max',
        },
      },
    },
    manifests: { validation: ids(500, 2100), test: ids(172, 2300, 'b') },
    fingerprint: SHA_A,
  }
}

function runtimeFixture() {
  return {
    config: {
      solver: {
        smokeConcurrency: 3,
        initialConcurrency: 7,
        maximumConcurrency: 11,
        taskTimeoutSeconds: 123,
        maximumModelRequestsPerTask: 13,
        maximumResponseTokens: 32_768,
        gatewayConcurrencyPerTask: 5,
        infrastructureRetries: 2,
        infrastructureRetryBaseDelaySeconds: 3,
      },
      updater: {
        timeoutSeconds: 456,
        maximumModelRequestsPerPhase: 17,
        gatewayConcurrency: 3,
      },
      gateway: {
        upstreamBaseUrl: 'https://provider.invalid/v1',
        requestTimeoutSeconds: 78,
      },
      verifier: { concurrency: 9, threadsPerProcess: 2, timeoutSeconds: 67 },
      testBroker: { timeoutSeconds: 3_600 },
      paths: {
        persistentRoot: '/runtime/persistent',
        scratchRoot: '/runtime/scratch',
        datasetRoot: '/runtime/dataset',
        pnpmStore: '/runtime/pnpm-store',
        buildHome: '/runtime/build-home',
        runtimePatch: '/runtime/control/patch.yml',
      },
      toolchain: {
        nodeVersion: '24.19.0',
        nodePath: '/runtime/node/bin/node',
        pnpmVersion: '11.7.0',
        pnpmPath: '/runtime/pnpm/bin/pnpm.cjs',
        elanHome: '/runtime/elan',
        lakePath: '/runtime/elan/bin/lake',
        leanToolchain: 'leanprover/lean4:v4.27.0',
        bwrapPath: '/usr/bin/bwrap',
        setprivPath: '/usr/bin/setpriv',
      },
      identities: {
        updaterUser: 'updater-user',
        solverUser: 'solver-user',
        verifierUser: 'verifier-user',
        buildUser: 'build-user',
      },
      secrets: {},
    },
    fingerprint: SHA_B,
  }
}

function stateFixture(status = 'EVOLVING_L1') {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'CampaignState',
    campaignId: 'fixture-campaign',
    status,
    configFingerprint: SHA_C,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    ...(status === 'CLOSED' || status === 'REPORTED'
      ? { closedAt: '2026-01-01T01:00:00.000Z' }
      : {}),
    activeLevel: status === 'EVOLVING_L1' ? 'l1' : null,
    consecutiveMisses: 0,
    incumbent: null,
    candidates: [],
    events: [{ sequence: 1, type: 'CONFIG_FROZEN', at: '2026-01-01T00:00:00.000Z' }],
  }
}

function baseDependencies(overrides = {}) {
  const output = []
  let cleaned = 0
  const store = {
    feedbackRoot: '/runtime/campaign/private/feedback',
    reportRoot: '/runtime/campaign/report',
    sealedRoot: '/runtime/campaign/sealed/test',
    async readState() { return stateFixture() },
    async saveState() {},
  }
  const identityNumbers = new Map([
    ['updater-user', { uid: 1101, gid: 2101 }],
    ['solver-user', { uid: 1102, gid: 2102 }],
    ['verifier-user', { uid: 1103, gid: 2103 }],
    ['build-user', { uid: 1104, gid: 2104 }],
  ])
  return {
    output,
    store,
    get cleaned() { return cleaned },
    dependencies: {
      async loadEvolutionCampaign() { return campaignFixture() },
      async loadPutnamRuntime() { return runtimeFixture() },
      async fingerprintControllerImplementation() { return SHA_A },
      combineCampaignFingerprint() { return SHA_C },
      async attestRuntimePatch() {},
      identityLookup(user) { return identityNumbers.get(user) },
      async attestSandboxRuntime() {},
      async acquireCampaignLock() { return async () => {} },
      createStore() { return store },
      writeStdout(text) { output.push(text) },
      async readSecretFd() { return Buffer.from('primary-provider-secret') },
      createAbortSignal() {
        return {
          signal: new AbortController().signal,
          cleanup() { cleaned += 1 },
        }
      },
      ...overrides,
    },
  }
}

test('campaign validate combines fingerprints and exposes no task IDs or paths', async () => {
  const fixture = baseDependencies()
  const result = await runCampaignCliCommand(
    'campaign',
    'validate',
    [],
    fixture.dependencies,
  )
  assert.equal(result.valid, true)
  assert.equal(result.fingerprint, SHA_C)
  assert.deepEqual(result.model, {
    name: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    api: 'openai-responses',
  })
  assert.deepEqual(result.partitions, { validation: 500, test: 172 })
  const output = fixture.output.join('')
  assert.doesNotMatch(output, /putnam_/u)
  assert.doesNotMatch(output, /provider-secret/u)
})

test('campaign validate accepts a frozen high reasoning effort', async () => {
  const fixture = baseDependencies({
    async loadEvolutionCampaign() {
      const campaign = campaignFixture()
      campaign.config.spec.solver.reasoningEffort = 'high'
      return campaign
    },
  })
  const result = await runCampaignCliCommand(
    'campaign',
    'validate',
    [],
    fixture.dependencies,
  )
  assert.equal(result.valid, true)
  assert.equal(result.model.reasoningEffort, 'high')
})

test('partition and environment options come from the frozen runtime', () => {
  const runtime = runtimeFixture().config
  const identities = { verifier: { uid: 1103, gid: 2103 } }
  assert.deepEqual(buildPartitionOptions(runtime, 20, identities), {
    concurrency: 9,
    maximumModelRequestsPerTask: 13,
    maximumResponseTokens: 32_768,
    maximumGatewayConcurrencyPerTask: 5,
    taskTimeoutMs: 123_000,
    verifierTimeoutMs: 67_000,
    gatewayRequestTimeoutMs: 78_000,
    infrastructureRetries: 2,
    infrastructureRetryBaseDelayMs: 3_000,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
    verifierUid: 1103,
    verifierGid: 2103,
  })
  delete runtime.solver.maximumModelRequestsPerTask
  delete runtime.solver.maximumResponseTokens
  delete runtime.solver.gatewayConcurrencyPerTask
  assert.deepEqual(
    {
      maximumModelRequestsPerTask: buildPartitionOptions(runtime, 20, identities)
        .maximumModelRequestsPerTask,
      maximumResponseTokens: buildPartitionOptions(runtime, 20, identities).maximumResponseTokens,
      maximumGatewayConcurrencyPerTask: buildPartitionOptions(runtime, 20, identities)
        .maximumGatewayConcurrencyPerTask,
    },
    {
      maximumModelRequestsPerTask: null,
      maximumResponseTokens: null,
      maximumGatewayConcurrencyPerTask: null,
    },
  )
  const environment = buildAgentEnvironment(runtime, {
    LANG: 'C.UTF-8',
    ZCLOUD_API_KEY: 'must-not-pass',
    NODE_OPTIONS: '--require=must-not-pass',
  }, '/runtime/solver-home')
  assert.equal(environment.ELAN_HOME, '/runtime/elan')
  assert.equal(environment.PATH, '/runtime/node/bin:/runtime/elan/bin:/usr/bin:/bin')
  assert.equal(environment.LEAN_NUM_THREADS, '2')
  assert.equal(environment.ZCLOUD_API_KEY, undefined)
  assert.equal(environment.NODE_OPTIONS, undefined)
})

test('runtime patch attestation binds the installed copy to trusted bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-patch-'))
  const path = join(root, 'runtime.patch.yml')
  const trusted = new URL(
    '../../environments/putnambench-lean/zcloud-max-headless.patch.yml',
    import.meta.url,
  )
  await writeFile(path, await readFile(trusted))
  const runtime = runtimeFixture().config
  runtime.paths.runtimePatch = path
  await attestRuntimePatch(runtime)
  await writeFile(path, 'tampered\n')
  await assert.rejects(() => attestRuntimePatch(runtime), /不一致/u)
})

test('HLE runtime patch attestation also binds the installed Unix relay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-hle-relay-'))
  const patchPath = join(root, 'runtime.patch.yml')
  const relayPath = join(root, 'model-gateway-relay.mjs')
  const trustedPatch = new URL(
    '../../environments/hle-text-math/dashscope-qwen38-max-headless.patch.yml',
    import.meta.url,
  )
  const trustedRelay = new URL('../src/model-gateway-relay.mjs', import.meta.url)
  await Promise.all([
    writeFile(patchPath, await readFile(trustedPatch)),
    writeFile(relayPath, await readFile(trustedRelay)),
  ])
  const runtime = runtimeFixture().config
  runtime.kind = 'HleTextMathRuntime'
  runtime.paths.runtimePatch = patchPath
  await attestRuntimePatch(runtime)
  await writeFile(relayPath, 'tampered\n')
  await assert.rejects(() => attestRuntimePatch(runtime), /relay.*不一致/u)
})

test('sealed runner ignores caller injection and sends manifest/key only to child broker', async () => {
  const calls = []
  const getApiKey = async () => 'primary-provider-secret'
  const context = {
    campaign: campaignFixture(),
    runtime: runtimeFixture(),
    campaignId: 'fixture-campaign',
    campaignsRoot: '/runtime/campaigns',
    testManifestPath: '/trusted/test.ids',
  }
  const identities = {
    solver: { uid: 1102, gid: 2102 },
    verifier: { uid: 1103, gid: 2103 },
  }
  const runner = createSealedRunner({
    context,
    identities,
    getApiKey,
    signal: new AbortController().signal,
    async runChild(options) {
      calls.push(options)
      return {
        receiptId: 'opaque-receipt',
        candidateId: options.candidateId,
        status: 'sealed',
        completedAt: '2026-01-01T00:00:00Z',
      }
    },
  })
  const receipt = await runner({
    candidateId: 'c0001-l1',
    candidateRoot: '/runtime/candidate',
    instanceIds: ['malicious'],
    getApiKey: () => 'malicious',
    testManifestPath: '/malicious/test.ids',
    onProgress: () => { throw new Error('must not run') },
  })
  assert.equal(receipt.receiptId, 'opaque-receipt')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].testManifestPath, '/trusted/test.ids')
  assert.equal(calls[0].testManifestSha256, SHA_B)
  assert.equal(calls[0].getApiKey, getApiKey)
  assert.equal(calls[0].partitionOptions.candidateRoot, '/runtime/candidate')
  assert.equal(calls[0].partitionOptions.instanceIds, undefined)
  assert.equal(calls[0].partitionOptions.getApiKey, undefined)
  assert.equal(calls[0].partitionOptions.testManifestPath, undefined)
  assert.equal(calls[0].partitionOptions.verifierUid, 1103)
})

test('campaign smoke uses only the first requested validation tasks and maps production options', async () => {
  let runtimeOptions
  let smokeInput
  let secretReads = 0
  const securityOrder = []
  const fixture = baseDependencies({
    async attestSandboxRuntime(options) {
      securityOrder.push('attest')
      assert.equal(options.bwrapPath, '/usr/bin/bwrap')
      assert.equal(options.setprivPath, '/usr/bin/setpriv')
      assert.deepEqual(options.restrictedUids, [1101, 1102, 1103, 1104])
    },
    async readSecretFd() {
      securityOrder.push('secret')
      secretReads += 1
      return Buffer.from('primary-provider-secret')
    },
    createRuntime(options) {
      runtimeOptions = options
      return {
        async smoke(input) {
          smokeInput = input
          return {
            summary: {
              candidateId: 'baseline-smoke',
              verified: 2,
              total: input.instanceIds.length,
              usage: { requests: 3, inputTokens: 4, outputTokens: 5, totalTokens: 9 },
            },
          }
        },
      }
    },
  })
  const result = await runCampaignCliCommand(
    'campaign',
    'smoke',
    ['--zcloud-key-fd', '7', '--tasks', '4'],
    fixture.dependencies,
  )
  assert.deepEqual(smokeInput.instanceIds, campaignFixture().manifests.validation.slice(0, 4))
  assert.equal(smokeInput.candidateRoot.endsWith('/sources/deepseek-harness'), true)
  assert.equal(runtimeOptions.partitionOptions.concurrency, 3)
  assert.equal(runtimeOptions.partitionOptions.verifierUid, 1103)
  assert.equal(runtimeOptions.gatewayOptions.maxRequests, 17)
  assert.equal(runtimeOptions.gatewayOptions.maxConcurrency, 3)
  assert.equal(runtimeOptions.trustedUid, 0)
  assert.equal(runtimeOptions.trustedGid, 2101)
  assert.equal(runtimeOptions.baseEnvironment.ELAN_HOME, '/runtime/elan')
  assert.deepEqual(runtimeOptions.secretValues, ['primary-provider-secret'])
  assert.equal(runtimeOptions.runtimeCacheRoot, undefined)
  assert.deepEqual(securityOrder, ['attest', 'secret'])
  assert.equal(secretReads, 1)
  assert.equal(result.summary.total, 4)
  assert.equal(fixture.cleaned, 1)
  assert.doesNotMatch(fixture.output.join(''), /primary-provider-secret/u)
})

test('evolve start initializes, runs, and keeps updater gid as the Candidate trust group', async () => {
  let orchestratorOptions
  let runtimeOptions
  let runOptions
  const calls = []
  const runningState = stateFixture('EVOLVING_L1')
  const fixture = baseDependencies({
    createRuntime(options) { runtimeOptions = options; return {} },
    createOrchestrator(options) {
      orchestratorOptions = options
      return {
        async initialize() { calls.push('initialize') },
        async run(options) { calls.push('run'); runOptions = options; return runningState },
        async resume() { calls.push('resume'); return runningState },
      }
    },
  })
  const result = await runCampaignCliCommand(
    'evolve',
    'start',
    ['--zcloud-key-fd', '5'],
    fixture.dependencies,
  )
  assert.deepEqual(calls, ['initialize', 'run'])
  assert.deepEqual(runOptions, { roundLimit: 0 })
  assert.equal(orchestratorOptions.loadedCampaign.fingerprint, SHA_C)
  assert.equal(orchestratorOptions.trustedUid, 0)
  assert.equal(orchestratorOptions.trustedGid, 2101)
  assert.equal(orchestratorOptions.updaterGid, 2101)
  assert.equal(runtimeOptions.runtimeCacheRoot, '/runtime/persistent/runtime-cache/v1')
  assert.equal(result.status.status, 'EVOLVING_L1')
  assert.equal(fixture.cleaned, 1)
})

test('controller_config routes evolve start through the population coordinator', async () => {
  const populationCampaign = campaignFixture()
  populationCampaign.config.controller_config = {
    mode: 'independent',
    concurrency: { n_branches: 2 },
    budget: { total_budget: 4, beta: 0.5 },
    peer_sharing: {
      enabled: false,
      log_path_template: '- {peer_id}: {log_path}',
      inject_position: 'prompt_suffix',
    },
    competition: {
      enabled: false,
      bonus_grant_unit: 1,
      scoring_metric: 'delta_score',
    },
  }
  const populationState = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'PopulationCampaignState',
    campaignId: 'fixture-campaign',
    configFingerprint: SHA_C,
    mode: 'independent',
    status: 'EVOLVING',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    epoch: 1,
    budget: {
      totalBudget: 4, consumed: 2, beta: 0.5,
      bonusPool: 0, bonusRemaining: 0, bonusGranted: 0,
    },
    best: {
      branchId: 'branch-001', candidateId: 'c0001', commit: 'a'.repeat(40),
      digest: SHA_A, validationVerified: 2, validationTotal: 10,
    },
    branches: ['branch-001', 'branch-002'].map((branchId) => ({
      branchId,
      status: 'active',
      baseBudget: 2,
      bonusBudget: 0,
      consumed: 1,
      incumbent: {
        candidateId: 'c0001', commit: 'a'.repeat(40), digest: SHA_A,
        validationVerified: 2, validationTotal: 10,
      },
      peerLogPath: `/opt/harness-rsi/peer-logs/${branchId}.jsonl`,
    })),
    events: [],
  }
  let options
  const calls = []
  const fixture = baseDependencies({
    async loadEvolutionCampaign() { return populationCampaign },
    createPopulationOrchestrator(value) {
      options = value
      return {
        async initialize() { calls.push('initialize') },
        async run(runOptions) {
          calls.push(['run', runOptions])
          return populationState
        },
      }
    },
  })
  const result = await runCampaignCliCommand(
    'evolve',
    'start',
    ['--zcloud-key-fd', '5', '--round-limit', '1'],
    fixture.dependencies,
  )
  assert.deepEqual(calls, ['initialize', ['run', { roundLimit: 1 }]])
  assert.equal(typeof options.createBranch, 'function')
  assert.equal(result.status.kind, 'PopulationCampaignStatus')
  assert.equal(result.status.mode, 'independent')
  assert.equal(result.status.budget.consumed, 2)
})

test('round-limit zero means no manual cap while positive values stay bounded', async () => {
  const seen = []
  const fixture = baseDependencies({
    createRuntime() { return {} },
    createOrchestrator() {
      return {
        async run(options) { seen.push(options); return stateFixture('EVOLVING_L1') },
      }
    },
  })
  await runCampaignCliCommand(
    'evolve',
    'run',
    ['--zcloud-key-fd', '5', '--round-limit', '0'],
    fixture.dependencies,
  )
  await runCampaignCliCommand(
    'evolve',
    'run',
    ['--zcloud-key-fd', '5', '--round-limit', '7'],
    fixture.dependencies,
  )
  assert.deepEqual(seen, [{ roundLimit: 0 }, { roundLimit: 7 }])
})

test('status validates the combined fingerprint without reading a credential', async () => {
  const fixture = baseDependencies()
  const result = await runCampaignCliCommand('evolve', 'status', [], fixture.dependencies)
  assert.equal(result.kind, 'CampaignStatus')
  assert.equal(result.status, 'EVOLVING_L1')

  fixture.store.readState = async () => ({ ...stateFixture(), configFingerprint: SHA_A })
  await assert.rejects(
    () => runCampaignCliCommand('evolve', 'status', [], fixture.dependencies),
    /指纹/u,
  )
})

test('report writes terminal artifacts then marks CLOSED state REPORTED', async () => {
  const fixture = baseDependencies({
    async writeClosedCampaignReport() {
      return {
        directory: '/runtime/campaign/report',
        paths: { 'curve.svg': '/runtime/campaign/report/curve.svg' },
      }
    },
    clock: () => new Date('2026-01-02T00:00:00Z'),
  })
  const closed = stateFixture('CLOSED')
  let saved
  fixture.store.readState = async () => closed
  fixture.store.saveState = async (state) => { saved = state }
  const result = await runCampaignCliCommand('evolve', 'report', [], fixture.dependencies)
  assert.equal(saved.status, 'REPORTED')
  assert.equal(saved.reportedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(result.status.status, 'REPORTED')
  assert.equal(result.report.paths['curve.svg'], '/runtime/campaign/report/curve.svg')
})

test('hidden-test progress and unrecognized fields are never rendered', () => {
  assert.equal(safeProgressEvent({ type: 'test-started', candidateId: 'baseline' }), null)
  assert.equal(safeProgressEvent({
    type: 'sealed-task-complete',
    problemId: 'putnam_2024_a1',
    completed: 1,
    total: 172,
  }), null)
  assert.deepEqual(safeProgressEvent({
    type: 'validation-task-complete',
    problemId: 'putnam_2023_a1',
    status: 'resolved',
    completed: 7,
    total: 500,
    secret: 'must-not-pass',
  }), { type: 'validation-task-complete', completed: 7, total: 500 })
})

test('credential commands require only zcloud fd and reject fallback mixing', async () => {
  const fixture = baseDependencies()
  await assert.rejects(
    () => runCampaignCliCommand('campaign', 'smoke', [], fixture.dependencies),
    /zcloud-key-fd/u,
  )
  await assert.rejects(
    () => runCampaignCliCommand(
      'campaign',
      'smoke',
      ['--zcloud-key-fd', '7', '--dashscope-key-fd', '8'],
      fixture.dependencies,
    ),
    /未知参数 --dashscope-key-fd/u,
  )
})

test('sandbox attestation fails closed before the provider descriptor is consumed', async () => {
  let secretReads = 0
  const fixture = baseDependencies({
    async attestSandboxRuntime() { throw new Error('firewall not fail-closed') },
    async readSecretFd() {
      secretReads += 1
      return Buffer.from('primary-provider-secret')
    },
    createRuntime() { throw new Error('must not construct runtime') },
  })
  await assert.rejects(
    () => runCampaignCliCommand(
      'campaign',
      'smoke',
      ['--zcloud-key-fd', '7'],
      fixture.dependencies,
    ),
    /firewall not fail-closed/u,
  )
  assert.equal(secretReads, 0)
  assert.equal(fixture.cleaned, 1)
})

test('run verifies frozen state before attestation and credential consumption', async () => {
  const order = []
  const fixture = baseDependencies({
    createStore() {
      return {
        ...baseDependencies().store,
        async readState() {
          order.push('state')
          return { ...stateFixture(), configFingerprint: SHA_A }
        },
      }
    },
    async attestSandboxRuntime() { order.push('attest') },
    async readSecretFd() {
      order.push('secret')
      return Buffer.from('primary-provider-secret')
    },
  })
  await assert.rejects(
    () => runCampaignCliCommand('evolve', 'run', ['--zcloud-key-fd', '7'], fixture.dependencies),
    /指纹/u,
  )
  assert.deepEqual(order, ['state'])
})
