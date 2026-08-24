import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PRODUCTION_TOOLCHAIN_PIN,
  BUILD_SANDBOX_PATHS,
  ProductionRuntimeError,
  PutnamEvolutionRuntime,
  SOURCE_SMOKE_SANDBOX_PATHS,
  validateImmutableDependencyStore,
  validateFrozenEvaluationRuntime,
  validateScratchTraversalRoot,
} from '../src/production-runtime.mjs'
import { renderPrompt } from '../src/updater-runner.mjs'

function validationIds() {
  return Array.from({ length: 500 }, (_, index) => (
    `putnam_${String(3000 + index).padStart(4, '0')}_a1`
  ))
}

function record(instanceId, status = 'resolved', ordinal = 1) {
  return {
    instanceId,
    status,
    failureKind: status === 'resolved' ? null : 'candidate',
    solverStatus: 'completed',
    verifierStatus: status === 'resolved' ? 'verified' : 'rejected',
    attempts: 1,
    verifierAttempts: 1,
    usage: { requests: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    latencyMs: ordinal,
    traceRef: `traces/task-${ordinal}.jsonl`,
  }
}

function mountMode(args, source, destination) {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (['--ro-bind', '--bind'].includes(args[index])
        && args[index + 1] === source && args[index + 2] === destination) {
      return args[index]
    }
  }
  return null
}

function explicitMounts(args) {
  const mounts = []
  for (let index = 0; index < args.length - 2; index += 1) {
    if (['--ro-bind', '--bind'].includes(args[index]) && args[index + 1] !== '/usr') {
      mounts.push(args.slice(index, index + 3))
    }
  }
  return mounts
}

async function fixture({
  optionOverrides = {},
  dependencyOverrides = {},
  installResult,
  hostBuildResult,
  hostBuildResults,
  smokeResult,
  smokeResults,
  separateToolchains = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'production-runtime-'))
  const scratchRoot = join(root, 'scratch-root')
  const campaignScratch = join(scratchRoot, 'campaign')
  const paths = {
    root,
    scratchRoot,
    campaignScratch,
    runtimes: join(root, 'runtimes'),
    store: join(root, 'pnpm-store'),
    buildHome: join(root, 'build-home'),
    updaterRuns: join(campaignScratch, 'updater-runs'),
    scratch: join(campaignScratch, 'validation'),
    dataset: join(root, 'putnambench'),
    node: join(root, 'node-toolchain', 'bin', 'node'),
    pnpm: separateToolchains
      ? join(root, 'pnpm-toolchain', 'bin', 'pnpm')
      : join(root, 'node-toolchain', 'lib', 'pnpm.cjs'),
    patch: join(root, 'control', 'runtime.patch.yml'),
    proposalTemplate: join(root, 'control', 'proposal.md'),
    applyTemplate: join(root, 'control', 'apply.md'),
    feedback: join(root, 'campaign', 'private', 'feedback'),
    baselineSource: join(root, 'candidate-source', 'baseline'),
    candidateSource: join(root, 'candidate-source', 'c0001-l1'),
    evaluationRuntime: join(root, 'runtimes', 'built-parent'),
  }
  await Promise.all([
    mkdir(join(paths.baselineSource, 'apps', 'cli', 'src'), { recursive: true }),
    mkdir(join(paths.candidateSource, 'apps', 'cli', 'src'), { recursive: true }),
    mkdir(paths.evaluationRuntime, { recursive: true }),
    mkdir(join(paths.store, 'v11', 'files'), { recursive: true }),
    mkdir(join(root, 'control'), { recursive: true }),
    mkdir(paths.dataset, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(paths.baselineSource, 'source.txt'), 'baseline source\n'),
    writeFile(join(paths.candidateSource, 'source.txt'), 'candidate source\n'),
    writeFile(paths.patch, 'trusted: true\n'),
    writeFile(paths.proposalTemplate, 'candidate={{ candidate.id }} level={{ mutation.level }}\n'),
    writeFile(paths.applyTemplate, 'proposal={{ proposal.id }} candidate={{ candidate.id }}\n'),
    writeFile(join(paths.store, 'v11', 'index.db'), 'fixture sqlite index\n'),
  ])

  const calls = {
    processes: [],
    copies: [],
    directories: [],
    scratchValidations: [],
    grants: [],
    storeValidations: [],
    frozenRuntimeValidations: [],
    freezes: [],
    validations: [],
    gateways: [],
    gatewayLeases: [],
    gatewayLeaseReleases: [],
    gatewayCloses: [],
    gatewayLifecycle: [],
    proposals: [],
    applies: [],
    dataset: [],
    partitions: [],
    sealed: [],
    traces: [],
    checkpointWrites: [],
  }
  const checkpointMap = new Map()
  const store = {
    async writeValidationTrace(candidateId, taskId, text, secrets) {
      calls.traces.push({ candidateId, taskId, text, secrets })
      return `traces/${taskId}.jsonl`
    },
    async writeValidationCheckpoint(candidateId, value, secrets) {
      calls.checkpointWrites.push({ candidateId, value, secrets })
      if (!checkpointMap.has(candidateId)) checkpointMap.set(candidateId, new Map())
      checkpointMap.get(candidateId).set(value.instanceId, structuredClone(value))
    },
    async readValidationCheckpoints(candidateId) {
      return [...(checkpointMap.get(candidateId)?.values() ?? [])].reverse()
    },
  }
  let getApiKeyCalls = 0
  let hostBuildCalls = 0
  let sourceSmokeCalls = 0
  const getApiKey = async () => {
    getApiKeyCalls += 1
    return 'provider-real-secret-value'
  }
  let dummyOrdinal = 0

  const dependencies = {
    async executeProcess(options) {
      calls.processes.push(options)
      if (options.command === paths.node && options.args[0] === '--version') {
        return { ok: true, exitCode: 0, stdout: 'v24.19.0\n', stderr: '' }
      }
      if (options.command === paths.node
          && options.args[0] === paths.pnpm
          && options.args[1] === '--version') {
        return { ok: true, exitCode: 0, stdout: '11.7.0\n', stderr: '' }
      }
      if (options.args.includes('install')) {
        if (installResult instanceof Error) throw installResult
        return installResult ?? { ok: true, exitCode: 0, stdout: '', stderr: '' }
      }
      if (options.args.includes('build:lib:host')) {
        const configuredBuild = Array.isArray(hostBuildResults)
          ? hostBuildResults[Math.min(hostBuildCalls, hostBuildResults.length - 1)]
          : hostBuildResult
        hostBuildCalls += 1
        if (configuredBuild instanceof Error) throw configuredBuild
        return configuredBuild ?? { ok: true, exitCode: 0, stdout: '', stderr: '' }
      }
      if (options.args.some((argument) => argument.endsWith('/apps/cli/src/bin.ts'))
          && options.args.includes('--version')) {
        const configuredSmoke = Array.isArray(smokeResults)
          ? smokeResults[Math.min(sourceSmokeCalls, smokeResults.length - 1)]
          : smokeResult
        sourceSmokeCalls += 1
        if (configuredSmoke instanceof Error) throw configuredSmoke
        return configuredSmoke ?? { ok: true, exitCode: 0, stdout: '0.0.0\n', stderr: '' }
      }
      throw new Error('unexpected process invocation')
    },
    async copyRuntimeSource(options) {
      calls.copies.push(options)
      await mkdir(options.destination, { recursive: true })
      await writeFile(join(options.destination, 'runtime-copy.txt'), options.sourceRoot)
    },
    async prepareOwnedDirectory(options) {
      calls.directories.push(options)
      await mkdir(options.path, { recursive: true })
    },
    async validateScratchRoot(options) { calls.scratchValidations.push(options) },
    async grantBuildAccess(options) { calls.grants.push(options) },
    async validateDependencyStore(options) { calls.storeValidations.push(options) },
    async validateFrozenRuntime(options) { calls.frozenRuntimeValidations.push(options) },
    async freezeRuntimeTree(options) { calls.freezes.push(options) },
    async validateRuntime(path) { calls.validations.push(path) },
    async startGateway(options) {
      calls.gateways.push(options)
      const port = 12_000 + calls.gateways.length
      calls.gatewayLifecycle.push(`gateway:start:${port}`)
      return {
        url: `http://127.0.0.1:${port}/v1`,
        candidateApiKey: options.candidateApiKey,
        async close() {
          calls.gatewayCloses.push(options.candidateApiKey)
          calls.gatewayLifecycle.push(`gateway:close:${port}`)
        },
      }
    },
    async acquireGatewayEgressLease(options) {
      calls.gatewayLeases.push(options)
      const port = Number(new URL(options.gatewayUrl).port)
      calls.gatewayLifecycle.push(`lease:acquire:${port}`)
      return {
        async release() {
          calls.gatewayLeaseReleases.push(options)
          calls.gatewayLifecycle.push(`lease:release:${port}`)
        },
      }
    },
    async proposalRunner(options) {
      const template = await readFile(options.templatePath, 'utf8')
      calls.proposals.push({ ...options, rendered: renderPrompt(template, options.templateValues) })
      calls.gatewayLifecycle.push(`agent:proposal:${new URL(options.invocationOptions.gatewayUrl).port}`)
      const values = options.templateValues
      return {
        proposal: {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'MutationProposal',
          proposalId: values.proposal.id,
          campaignId: values.campaign.id,
          candidateId: values.candidate.id,
          parentId: values.candidate.parentId,
          level: values.mutation.level,
          createdAt: values.proposal.createdAt,
          model: { model: 'gpt-5.6-sol', effort: 'max' },
          direction: 'fixture direction',
          hypothesis: 'fixture hypothesis',
          evidence: [{ observation: 'validation evidence' }],
          intendedFiles: ['apps/cli/config/agent-presets/standard.yml'],
          expectedEffect: 'higher validation score',
          risks: [],
        },
      }
    },
    async applyRunner(options) {
      const template = await readFile(options.templatePath, 'utf8')
      calls.applies.push({ ...options, rendered: renderPrompt(template, options.templateValues) })
      calls.gatewayLifecycle.push(`agent:apply:${new URL(options.invocationOptions.gatewayUrl).port}`)
      return {
        report: {
          proposalId: options.templateValues.proposal.id,
          diagnosis: 'fixture',
          changedFiles: [],
          checks: [],
          remainingRisks: [],
        },
      }
    },
    async prepareDataset(options) {
      calls.dataset.push(options)
      return {
        solutionsRoot: join(paths.dataset, 'lean4', 'solutions_replaced_new'),
        leanRoot: join(paths.dataset, 'lean4'),
      }
    },
    async partitionRunner(options) {
      calls.partitions.push(options)
      const records = []
      let ordinal = 0
      for (const instanceId of options.instanceIds) {
        ordinal += 1
        const traceRef = await options.onTrace({
          problemId: instanceId,
          taskId: `task-${ordinal}`,
          text: `trace-${ordinal}`,
        })
        const value = { ...record(instanceId, 'resolved', ordinal), traceRef }
        await options.onRecord(value)
        records.push(value)
      }
      return {
        summary: {
          candidateId: options.candidateId,
          verified: records.length,
          total: records.length,
          completedAt: 'ignored-by-merge',
          usage: {},
        },
        records,
        traces: {},
      }
    },
    async sealedTestRunner(options) {
      calls.sealed.push(options)
      return {
        receiptId: `sealed-${options.candidateId}`,
        candidateId: options.candidateId,
        status: 'sealed',
        completedAt: '2026-01-01T00:00:00Z',
      }
    },
    dummyKeyFactory() {
      dummyOrdinal += 1
      return `unique-dummy-key-${dummyOrdinal}`
    },
    ...dependencyOverrides,
  }

  const runtime = new PutnamEvolutionRuntime({
    store,
    runtimesRoot: paths.runtimes,
    pnpmStoreRoot: paths.store,
    buildHome: paths.buildHome,
    scratchRoot: paths.scratchRoot,
    campaignScratchRoot: paths.campaignScratch,
    updaterRunRoot: paths.updaterRuns,
    validationScratchRoot: paths.scratch,
    datasetRoot: paths.dataset,
    nodePath: paths.node,
    pnpmCliPath: paths.pnpm,
    runtimePatch: paths.patch,
    proposalTemplatePath: paths.proposalTemplate,
    applyTemplatePath: paths.applyTemplate,
    upstreamBaseUrl: 'https://provider.invalid/v1',
    getApiKey,
    baseEnvironment: {
      PATH: '/usr/bin:/bin',
      ELAN_HOME: '/opt/pinned-elan',
      LANG: 'C.UTF-8',
      NODE_OPTIONS: '--require=/must/not/pass',
      ZCLOUD_API_KEY: 'provider-real-secret-value',
      DASHSCOPE_API_KEY: 'backup-real-secret-value',
    },
    secretValues: ['provider-real-secret-value', 'backup-real-secret-value'],
    updaterUid: 1101,
    updaterGid: 2101,
    buildUid: 1102,
    buildGid: 2102,
    solverUid: 1103,
    solverGid: 2103,
    verifierUid: 1104,
    verifierGid: 2104,
    bwrapPath: '/usr/bin/bwrap',
    trustedUid: 0,
    trustedGid: 2101,
    feedbackRoot: paths.feedback,
    clock: () => new Date('2026-01-02T03:04:05Z'),
    legacyUnsafeExecution: true,
    dependencies,
    ...optionOverrides,
  })
  return {
    runtime,
    root,
    paths,
    calls,
    store,
    checkpointMap,
    getApiKey,
    get getApiKeyCalls() { return getApiKeyCalls },
  }
}

test('builds baseline and candidates offline inside the no-network build sandbox', async () => {
  const context = await fixture()
  const baseline = await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  const candidate = await context.runtime.buildCandidate({
    candidateId: 'c0001-l1', candidateRoot: context.paths.candidateSource, level: 'l1',
  })

  assert.equal(baseline.ok, true)
  assert.equal(candidate.ok, true)
  assert.notEqual(baseline.runtimeRoot, context.paths.baselineSource)
  assert.notEqual(candidate.runtimeRoot, context.paths.candidateSource)
  assert.equal(await readFile(join(context.paths.baselineSource, 'source.txt'), 'utf8'), 'baseline source\n')
  assert.equal(await readFile(join(context.paths.candidateSource, 'source.txt'), 'utf8'), 'candidate source\n')

  const installs = context.calls.processes.filter((entry) => entry.args.includes('install'))
  assert.equal(installs.length, 2)
  for (const invocation of installs) {
    assert.equal(invocation.command, '/usr/bin/setpriv')
    assert.equal(invocation.args.includes('--reuid=1102'), true)
    assert.equal(invocation.args.includes('--regid=2102'), true)
    assert.equal(invocation.args.includes('--no-new-privs'), true)
    assert.equal(invocation.args.includes('/usr/bin/bwrap'), true)
    assert.equal(invocation.args.includes('--unshare-net'), true)
    assert.equal(invocation.args.includes('--offline'), true)
    assert.equal(invocation.args.includes('--ignore-scripts'), true)
    assert.equal(invocation.args.includes('--frozen-store'), true)
    assert.equal(invocation.args.includes('--trust-lockfile'), true)
    assert.equal(invocation.args.includes('--config.minimum-release-age=0'), true)
    assert.equal(invocation.args.includes('--config.trust-policy=off'), true)
    assert.equal(invocation.args.includes('--config.update-notifier=false'), true)
    assert.equal(invocation.args.includes('--prefer-offline'), false)
    assert.equal(invocation.args.includes('--package-import-method=copy'), true)
    const storeIndex = invocation.args.indexOf('--store-dir')
    assert.equal(invocation.args[storeIndex + 1], BUILD_SANDBOX_PATHS.store)
    assert.equal(mountMode(
      invocation.args,
      context.paths.store,
      BUILD_SANDBOX_PATHS.store,
    ), '--ro-bind')
    assert.equal(mountMode(
      invocation.args,
      join(context.root, 'node-toolchain'),
      BUILD_SANDBOX_PATHS.sharedToolchain,
    ), '--ro-bind')
    const runtimeMount = explicitMounts(invocation.args).find((entry) => (
      entry[2] === BUILD_SANDBOX_PATHS.runtime
    ))
    assert.equal(runtimeMount?.[0], '--bind')
    assert.equal(runtimeMount?.[1].startsWith(`${context.paths.runtimes}/.`), true)
    const buildMount = explicitMounts(invocation.args).find((entry) => (
      entry[2] === BUILD_SANDBOX_PATHS.workspace
    ))
    assert.equal(buildMount?.[0], '--bind')
    assert.equal(buildMount?.[1].startsWith(`${context.paths.buildHome}/`), true)
    assert.equal(explicitMounts(invocation.args).length, 4)
    assert.equal(invocation.args.includes(context.paths.baselineSource), false)
    assert.equal(invocation.args.includes(context.paths.candidateSource), false)
    assert.equal(invocation.args.includes(context.paths.feedback), false)
    assert.equal(invocation.args.includes(context.paths.dataset), false)
    const boundary = invocation.args.lastIndexOf('--')
    const childArguments = invocation.args.slice(boundary + 1)
    const childCommand = childArguments.join(' ')
    const installIndex = childArguments.indexOf('install')
    for (const globalConfig of [
      '--config.minimum-release-age=0',
      '--config.trust-policy=off',
      '--config.update-notifier=false',
    ]) {
      assert.equal(childArguments.indexOf(globalConfig) > 0, true)
      assert.equal(childArguments.indexOf(globalConfig) < installIndex, true)
    }
    assert.equal(childCommand.includes(context.root), false)
    assert.equal(childCommand.includes(BUILD_SANDBOX_PATHS.store), true)
    assert.equal(childCommand.includes(BUILD_SANDBOX_PATHS.sharedToolchain), true)
    assert.equal(invocation.env.HOME, `${BUILD_SANDBOX_PATHS.workspace}/home`)
    assert.equal(invocation.env.TMPDIR, `${BUILD_SANDBOX_PATHS.workspace}/tmp`)
    assert.equal(invocation.cwd, '/')
    assert.equal('shell' in invocation, false)
    assert.equal(invocation.env.ZCLOUD_API_KEY, undefined)
    assert.equal(invocation.env.DASHSCOPE_API_KEY, undefined)
    assert.equal(invocation.env.NODE_OPTIONS, undefined)
  }
  const hostBuilds = context.calls.processes.filter((entry) => (
    entry.args.includes('build:lib:host')
  ))
  assert.equal(hostBuilds.length, 2)
  for (const invocation of hostBuilds) {
    assert.equal(invocation.command, '/usr/bin/setpriv')
    assert.equal(invocation.args.includes('--reuid=1102'), true)
    assert.equal(invocation.args.includes('--regid=2102'), true)
    assert.equal(invocation.args.includes('--no-new-privs'), true)
    assert.equal(invocation.args.includes('/usr/bin/bwrap'), true)
    assert.equal(invocation.args.includes('--unshare-net'), true)
    assert.equal(invocation.args.includes('--config.minimum-release-age=0'), true)
    assert.equal(invocation.args.includes('--config.trust-policy=off'), true)
    assert.equal(invocation.args.includes('--config.update-notifier=false'), true)
    assert.equal(invocation.args.includes('run'), true)
    assert.equal(invocation.args.includes('build:lib:host'), true)
    const configLoaderIndex = invocation.args.indexOf('--config-loader')
    assert.equal(configLoaderIndex > invocation.args.indexOf('build:lib:host'), true)
    assert.equal(invocation.args[configLoaderIndex + 1], 'native')
    assert.equal(invocation.args.includes('--offline'), false)
    assert.equal(invocation.args.includes('--ignore-scripts'), false)
    assert.equal(mountMode(
      invocation.args,
      context.paths.store,
      BUILD_SANDBOX_PATHS.store,
    ), '--ro-bind')
    const runtimeMount = explicitMounts(invocation.args).find((entry) => (
      entry[2] === BUILD_SANDBOX_PATHS.runtime
    ))
    assert.equal(runtimeMount?.[0], '--bind')
    assert.equal(explicitMounts(invocation.args).length, 4)
    assert.equal(invocation.args.includes(context.paths.baselineSource), false)
    assert.equal(invocation.args.includes(context.paths.candidateSource), false)
    assert.equal(invocation.args.includes(context.paths.feedback), false)
    assert.equal(invocation.args.includes(context.paths.dataset), false)
    const boundary = invocation.args.lastIndexOf('--')
    assert.equal(invocation.args.slice(boundary + 1).join(' ').includes(context.root), false)
    assert.equal(invocation.env.HOME, `${BUILD_SANDBOX_PATHS.workspace}/home`)
    assert.equal(invocation.env.TMPDIR, `${BUILD_SANDBOX_PATHS.workspace}/tmp`)
    assert.equal(invocation.env.PATH, [
      `${BUILD_SANDBOX_PATHS.sharedToolchain}/bin`,
      `${BUILD_SANDBOX_PATHS.sharedToolchain}/lib`,
      '/usr/bin',
      '/bin',
    ].join(':'))
    assert.equal(invocation.env.PATH.includes(context.root), false)
    assert.equal(invocation.env.ZCLOUD_API_KEY, undefined)
    assert.equal(invocation.env.DASHSCOPE_API_KEY, undefined)
    assert.equal(invocation.env.NODE_OPTIONS, undefined)
  }
  assert.deepEqual(context.calls.storeValidations, [{
    root: context.paths.store,
    trustedUid: 0,
    buildUid: 1102,
  }])
  const toolchainChecks = context.calls.processes.filter((entry) => (
    entry.command === context.paths.node
      && (entry.args[0] === '--version'
        || (entry.args[0] === context.paths.pnpm && entry.args[1] === '--version'))
  ))
  assert.equal(toolchainChecks.length, 2)
  assert.deepEqual(PRODUCTION_TOOLCHAIN_PIN, {
    nodeVersion: 'v24.19.0',
    pnpmVersion: '11.7.0',
  })
  const sourceSmokes = context.calls.processes.filter((entry) => (
    entry.args.some((argument) => argument.endsWith('/apps/cli/src/bin.ts'))
  ))
  assert.equal(sourceSmokes.length, 2)
  for (const smoke of sourceSmokes) {
    assert.equal(smoke.command, '/usr/bin/setpriv')
    assert.equal(smoke.args.includes('--reuid=1103'), true)
    assert.equal(smoke.args.includes('--regid=2103'), true)
    assert.equal(smoke.args.includes('/usr/bin/bwrap'), true)
    assert.equal(smoke.args.includes('--unshare-net'), true)
    assert.equal(explicitMounts(smoke.args).length, 3)
    assert.equal(smoke.args.includes('--import'), true)
    assert.equal(smoke.args.some((argument) => (
      argument.includes(`${SOURCE_SMOKE_SANDBOX_PATHS.runtime}/node_modules/tsx/`)
    )), true)
    assert.equal(smoke.args.includes('--version'), true)
    assert.equal(mountMode(
      smoke.args,
      join(context.root, 'node-toolchain'),
      SOURCE_SMOKE_SANDBOX_PATHS.nodeToolchain,
    ), '--ro-bind')
    const runtimeMountIndex = smoke.args.indexOf(SOURCE_SMOKE_SANDBOX_PATHS.runtime)
    assert.equal(runtimeMountIndex > 0, true)
    assert.equal(smoke.args[runtimeMountIndex - 2], '--ro-bind')
    const sourceSmokeMountIndex = smoke.args.indexOf(SOURCE_SMOKE_SANDBOX_PATHS.workspace)
    assert.equal(sourceSmokeMountIndex > 0, true)
    assert.equal(smoke.args[sourceSmokeMountIndex - 2], '--bind')
    const sourceSmokeHostRoot = smoke.args[sourceSmokeMountIndex - 1]
    assert.equal(sourceSmokeHostRoot.startsWith(join(context.paths.campaignScratch, 'source-smoke')), true)
    for (const hidden of [
      context.paths.baselineSource,
      context.paths.candidateSource,
      context.paths.feedback,
      context.paths.dataset,
      process.cwd(),
    ]) {
      assert.equal(smoke.args.includes(hidden), false)
    }
    const boundary = smoke.args.lastIndexOf('--')
    assert.equal(smoke.args.slice(boundary + 1).join(' ').includes(context.root), false)
    assert.equal('shell' in smoke, false)
    assert.equal(smoke.env.HOME, `${SOURCE_SMOKE_SANDBOX_PATHS.workspace}/home`)
    assert.equal(smoke.env.TMPDIR, `${SOURCE_SMOKE_SANDBOX_PATHS.workspace}/tmp`)
    assert.equal(
      smoke.env.TSX_TSCONFIG_PATH,
      `${SOURCE_SMOKE_SANDBOX_PATHS.runtime}/tsconfig.json`,
    )
    assert.equal(smoke.env.ZCLOUD_API_KEY, undefined)
    assert.equal(smoke.env.DASHSCOPE_API_KEY, undefined)
    assert.equal(smoke.env.NODE_OPTIONS, undefined)
  }
  assert.equal(context.calls.grants.every((entry) => entry.gid === 2102), true)
  assert.equal(context.calls.freezes.every((entry) => entry.gid === 2101), true)
  assert.deepEqual(context.calls.scratchValidations, [{
    root: context.paths.scratchRoot,
    trustedUid: 0,
  }])
  assert.deepEqual(context.calls.directories[0], {
    path: context.paths.campaignScratch,
    uid: 0,
    gid: 2101,
    mode: 0o711,
  })
  const parentModes = new Map(context.calls.directories.map((entry) => [entry.path, entry.mode]))
  assert.equal(parentModes.get(context.paths.campaignScratch), 0o711)
  assert.equal(parentModes.get(context.paths.runtimes), 0o711)
  assert.equal(parentModes.get(context.paths.buildHome), 0o711)
  assert.equal(parentModes.get(context.paths.updaterRuns), 0o711)
  assert.equal(parentModes.get(context.paths.scratch), 0o711)
  assert.equal(parentModes.get(join(context.paths.campaignScratch, 'smoke-scratch')), 0o711)
  assert.equal(parentModes.get(join(context.paths.campaignScratch, 'source-smoke')), 0o711)
  assert.equal(parentModes.get(join(context.paths.campaignScratch, 'sealed-test')), 0o711)
  const isolatedSourceSmokeDirectories = context.calls.directories.filter((entry) => (
    entry.path.startsWith(`${join(context.paths.campaignScratch, 'source-smoke')}/`)
  ))
  assert.equal(isolatedSourceSmokeDirectories.length > 0, true)
  assert.equal(isolatedSourceSmokeDirectories.every((entry) => (
    entry.uid === 1103 && entry.gid === 2103 && entry.mode === 0o700
  )), true)
  const isolatedBuildDirectories = context.calls.directories.filter((entry) => (
    entry.path.startsWith(`${context.paths.buildHome}/`)
  ))
  assert.equal(isolatedBuildDirectories.length, 6)
  assert.equal(isolatedBuildDirectories.every((entry) => (
    entry.uid === 1102 && entry.gid === 2102 && entry.mode === 0o700
  )), true)
})

test('build PATH pins separate production Node and pnpm toolchains ahead of /usr', async () => {
  const context = await fixture({ separateToolchains: true })
  const result = await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  assert.equal(result.ok, true)
  const hostBuild = context.calls.processes.find((entry) => (
    entry.args.includes('build:lib:host')
  ))
  assert.equal(hostBuild.env.PATH, [
    `${BUILD_SANDBOX_PATHS.nodeToolchain}/bin`,
    `${BUILD_SANDBOX_PATHS.pnpmToolchain}/bin`,
    '/usr/bin',
    '/bin',
  ].join(':'))
  assert.equal(mountMode(
    hostBuild.args,
    join(context.root, 'node-toolchain'),
    BUILD_SANDBOX_PATHS.nodeToolchain,
  ), '--ro-bind')
  assert.equal(mountMode(
    hostBuild.args,
    join(context.root, 'pnpm-toolchain'),
    BUILD_SANDBOX_PATHS.pnpmToolchain,
  ), '--ro-bind')
})

test('candidate install nonzero is a candidate failure; operational failures are infrastructure', async (context) => {
  await context.test('nonzero', async () => {
    const fixtureContext = await fixture({
      installResult: { ok: false, exitCode: 2, stdout: '', stderr: 'lock mismatch' },
    })
    const result = await fixtureContext.runtime.buildCandidate({
      candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'candidate')
    assert.equal(result.exitCode, 2)
  })
  await context.test('timeout', async () => {
    const fixtureContext = await fixture({
      installResult: { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '' },
    })
    await assert.rejects(
      () => fixtureContext.runtime.buildCandidate({
        candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
      }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
  })
  await context.test('spawn error', async () => {
    const fixtureContext = await fixture({ installResult: new Error('spawn failed') })
    await assert.rejects(
      () => fixtureContext.runtime.buildCandidate({
        candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
      }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
  })
  await context.test('host build nonzero', async () => {
    const fixtureContext = await fixture({
      hostBuildResult: { ok: false, exitCode: 2, stdout: '', stderr: 'compile failed' },
    })
    const result = await fixtureContext.runtime.buildCandidate({
      candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'candidate')
    assert.equal(result.exitCode, 2)
    assert.match(result.message, /host artifact build/u)
    const hostBuilds = fixtureContext.calls.processes.filter((entry) => (
      entry.args.includes('build:lib:host')
    ))
    assert.equal(hostBuilds.length, 2)
  })
  await context.test('transient host build nonzero is retried once', async () => {
    const fixtureContext = await fixture({
      hostBuildResults: [
        { ok: false, exitCode: 1, stdout: '', stderr: 'transient NFS read failure' },
        { ok: true, exitCode: 0, stdout: '', stderr: '' },
      ],
    })
    const result = await fixtureContext.runtime.buildCandidate({
      candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
    })
    assert.equal(result.ok, true)
    const hostBuilds = fixtureContext.calls.processes.filter((entry) => (
      entry.args.includes('build:lib:host')
    ))
    assert.equal(hostBuilds.length, 2)
  })
  await context.test('host build timeout', async () => {
    const fixtureContext = await fixture({
      hostBuildResult: { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '' },
    })
    await assert.rejects(
      () => fixtureContext.runtime.buildCandidate({
        candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
      }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
  })
  await context.test('operational host build failure is never hidden by a later success', async () => {
    for (const operational of [
      { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '' },
      { ok: false, exitCode: null, aborted: true, stdout: '', stderr: '' },
      { ok: false, exitCode: null, outputExceeded: true, stdout: '', stderr: '' },
      { ok: false, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' },
    ]) {
      const fixtureContext = await fixture({
        hostBuildResults: [
          operational,
          { ok: true, exitCode: 0, stdout: '', stderr: '' },
        ],
      })
      await assert.rejects(
        () => fixtureContext.runtime.buildCandidate({
          candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
        }),
        (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
      )
      const hostBuilds = fixtureContext.calls.processes.filter((entry) => (
        entry.args.includes('build:lib:host')
      ))
      assert.equal(hostBuilds.length, 1)
    }
  })
  await context.test('host build spawn error is infrastructure without retry', async () => {
    const fixtureContext = await fixture({
      hostBuildResults: [
        new Error('spawn failed'),
        { ok: true, exitCode: 0, stdout: '', stderr: '' },
      ],
    })
    await assert.rejects(
      () => fixtureContext.runtime.buildCandidate({
        candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
      }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
    const hostBuilds = fixtureContext.calls.processes.filter((entry) => (
      entry.args.includes('build:lib:host')
    ))
    assert.equal(hostBuilds.length, 1)
  })
  await context.test('missing source entry', async () => {
    const fixtureContext = await fixture({
      dependencyOverrides: {
        async validateRuntime() { throw new Error('Harness source entry is missing') },
      },
    })
    const result = await fixtureContext.runtime.buildCandidate({
      candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'candidate')
    assert.match(result.message, /missing required source/u)
  })
  await context.test('source launch nonzero', async () => {
    const fixtureContext = await fixture({
      smokeResult: { ok: false, exitCode: 1, stdout: '', stderr: 'source syntax error' },
    })
    const result = await fixtureContext.runtime.buildCandidate({
      candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'candidate')
    assert.match(result.message, /source launch/u)
  })
  await context.test('transient source launch nonzero is retried once', async () => {
    const fixtureContext = await fixture({
      smokeResults: [
        { ok: false, exitCode: 1, stdout: '', stderr: 'transient NFS read failure' },
        { ok: true, exitCode: 0, stdout: '0.0.0\n', stderr: '' },
      ],
    })
    const result = await fixtureContext.runtime.buildCandidate({
      candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
    })
    assert.equal(result.ok, true)
    const sourceSmokes = fixtureContext.calls.processes.filter((entry) => (
      entry.args.some((argument) => argument.endsWith('/apps/cli/src/bin.ts'))
    ))
    assert.equal(sourceSmokes.length, 2)
  })
  await context.test('source launch timeout', async () => {
    const fixtureContext = await fixture({
      smokeResult: { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '' },
    })
    await assert.rejects(
      () => fixtureContext.runtime.buildCandidate({
        candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
      }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
  })
  await context.test('operational source failure is never hidden by a later success', async () => {
    for (const operational of [
      { ok: false, exitCode: null, timedOut: true, stdout: '', stderr: '' },
      { ok: false, exitCode: null, aborted: true, stdout: '', stderr: '' },
      { ok: false, exitCode: null, outputExceeded: true, stdout: '', stderr: '' },
      { ok: false, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' },
    ]) {
      const fixtureContext = await fixture({
        smokeResults: [
          operational,
          { ok: true, exitCode: 0, stdout: '0.0.0\n', stderr: '' },
        ],
      })
      await assert.rejects(
        () => fixtureContext.runtime.buildCandidate({
          candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
        }),
        (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
      )
      const sourceSmokes = fixtureContext.calls.processes.filter((entry) => (
        entry.args.some((argument) => argument.endsWith('/apps/cli/src/bin.ts'))
      ))
      assert.equal(sourceSmokes.length, 1)
    }
  })
  await context.test('source launch spawn error is infrastructure without retry', async () => {
    const fixtureContext = await fixture({
      smokeResults: [
        new Error('spawn failed'),
        { ok: true, exitCode: 0, stdout: '0.0.0\n', stderr: '' },
      ],
    })
    await assert.rejects(
      () => fixtureContext.runtime.buildCandidate({
        candidateId: 'c0001-l1', candidateRoot: fixtureContext.paths.candidateSource, level: 'l1',
      }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
    const sourceSmokes = fixtureContext.calls.processes.filter((entry) => (
      entry.args.some((argument) => argument.endsWith('/apps/cli/src/bin.ts'))
    ))
    assert.equal(sourceSmokes.length, 1)
  })
})

test('Updater always uses frozen baseline runtime, feedback prompt, and a fresh loopback gateway', async () => {
  const context = await fixture()
  const baseline = await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  const proposal = await context.runtime.propose({
    campaignId: 'campaign',
    candidateId: 'c0001-l1',
    parentId: 'baseline',
    level: 'l1',
    candidateRoot: context.paths.candidateSource,
    feedbackRoot: context.paths.feedback,
    proposalId: 'p0001-l1',
    createdAt: '2026-01-01T00:00:00Z',
  })
  const mutationReport = await context.runtime.apply({
    campaignId: 'campaign',
    candidateId: 'c0001-l1',
    parentId: 'baseline',
    level: 'l1',
    candidateRoot: context.paths.candidateSource,
    proposal,
  })

  assert.equal(mutationReport.proposalId, proposal.proposalId)
  assert.equal(context.calls.proposals[0].rendered.includes(context.paths.feedback), true)
  assert.equal(context.calls.applies[0].rendered.includes(context.paths.feedback), true)
  for (const phase of [...context.calls.proposals, ...context.calls.applies]) {
    assert.equal(phase.invocationOptions.updaterRuntime, baseline.runtimeRoot)
    assert.equal(phase.invocationOptions.nodeBinary, context.paths.node)
    assert.equal(phase.invocationOptions.uid, 1101)
    assert.equal(phase.invocationOptions.gid, 2101)
    assert.equal(phase.invocationOptions.legacy, true)
    assert.equal(phase.invocationOptions.baseEnv.ZCLOUD_API_KEY, undefined)
    assert.equal(phase.invocationOptions.baseEnv.DASHSCOPE_API_KEY, undefined)
    assert.equal(phase.invocationOptions.baseEnv.NODE_OPTIONS, undefined)
  }
  assert.equal(context.calls.gateways.length, 2)
  assert.deepEqual(context.calls.gatewayLeases, [
    { gatewayUrl: 'http://127.0.0.1:12001/v1', uid: 1101 },
    { gatewayUrl: 'http://127.0.0.1:12002/v1', uid: 1101 },
  ])
  assert.deepEqual(context.calls.gatewayLeaseReleases, context.calls.gatewayLeases)
  assert.deepEqual(context.calls.gatewayLifecycle, [
    'gateway:start:12001',
    'lease:acquire:12001',
    'agent:proposal:12001',
    'lease:release:12001',
    'gateway:close:12001',
    'gateway:start:12002',
    'lease:acquire:12002',
    'agent:apply:12002',
    'lease:release:12002',
    'gateway:close:12002',
  ])
  assert.notEqual(context.calls.gateways[0].candidateApiKey, context.calls.gateways[1].candidateApiKey)
  assert.deepEqual(context.calls.gatewayCloses, context.calls.gateways.map((entry) => entry.candidateApiKey))
  for (const gateway of context.calls.gateways) {
    assert.equal(gateway.host, '127.0.0.1')
    assert.equal(gateway.maxOutputTokens, 32_768)
    assert.equal(gateway.getApiKey, context.getApiKey)
    assert.notEqual(gateway.candidateApiKey, 'provider-real-secret-value')
  }
  assert.equal(context.getApiKeyCalls, 0)
})

test('Updater callback failures after any provider/credential audit pause as infrastructure', async (context) => {
  function auditedGateway(audits) {
    return async (options) => {
      for (const record of audits) await options.audit(record)
      return {
        url: 'http://127.0.0.1:12999/v1',
        candidateApiKey: options.candidateApiKey,
        async close() {},
      }
    }
  }
  const mutation = (paths) => ({
    campaignId: 'campaign',
    candidateId: 'c0001-l1',
    parentId: 'baseline',
    level: 'l1',
    candidateRoot: paths.candidateSource,
    feedbackRoot: paths.feedback,
    proposalId: 'p0001-l1',
    createdAt: '2026-01-01T00:00:00Z',
  })

  await context.test('credential failure during proposal', async () => {
    const callbackError = new Error('Updater did not produce a proposal')
    const fixtureContext = await fixture({
      dependencyOverrides: {
        startGateway: auditedGateway([{ status: 502, origin: 'credential' }]),
        async proposalRunner() { throw callbackError },
      },
    })
    await fixtureContext.runtime.buildCandidate({
      candidateId: 'baseline', candidateRoot: fixtureContext.paths.baselineSource, level: 'baseline',
    })
    await assert.rejects(
      () => fixtureContext.runtime.propose(mutation(fixtureContext.paths)),
      (error) => error instanceof ProductionRuntimeError
        && error.kind === 'infrastructure'
        && error.operation === 'updater-proposal'
        && error.cause === callbackError,
    )
  })

  await context.test('upstream 503 during apply', async () => {
    const callbackError = new Error('Updater apply session exited nonzero')
    const fixtureContext = await fixture({
      dependencyOverrides: {
        startGateway: auditedGateway([{ status: 503, origin: 'upstream' }]),
        async applyRunner() { throw callbackError },
      },
    })
    await fixtureContext.runtime.buildCandidate({
      candidateId: 'baseline', candidateRoot: fixtureContext.paths.baselineSource, level: 'baseline',
    })
    const proposal = await fixtureContext.runtime.propose(mutation(fixtureContext.paths))
    await assert.rejects(
      () => fixtureContext.runtime.apply({
        campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
        candidateRoot: fixtureContext.paths.candidateSource, proposal,
      }),
      (error) => error instanceof ProductionRuntimeError
        && error.kind === 'infrastructure'
        && error.operation === 'updater-apply'
        && error.cause === callbackError,
    )
  })

  await context.test('a later local audit cannot erase an earlier provider failure', async () => {
    const callbackError = new Error('candidate-side malformed proposal')
    const fixtureContext = await fixture({
      dependencyOverrides: {
        startGateway: auditedGateway([
          { status: 503, origin: 'upstream' },
          { status: 400, origin: 'gateway' },
        ]),
        async proposalRunner() { throw callbackError },
      },
    })
    await fixtureContext.runtime.buildCandidate({
      candidateId: 'baseline', candidateRoot: fixtureContext.paths.baselineSource, level: 'baseline',
    })
    await assert.rejects(
      () => fixtureContext.runtime.propose(mutation(fixtureContext.paths)),
      (error) => error instanceof ProductionRuntimeError
        && error.kind === 'infrastructure'
        && error.operation === 'updater-proposal'
        && error.cause === callbackError,
    )
  })

  await context.test('a delayed older provider audit still invalidates a failed session', async () => {
    const callbackError = new Error('candidate-side malformed proposal')
    const fixtureContext = await fixture({
      dependencyOverrides: {
        startGateway: auditedGateway([
          {
            requestSequence: 2,
            status: 429,
            origin: 'gateway',
            localReason: 'request_budget',
          },
          { requestSequence: 1, status: 503, origin: 'upstream' },
        ]),
        async proposalRunner() { throw callbackError },
      },
    })
    await fixtureContext.runtime.buildCandidate({
      candidateId: 'baseline', candidateRoot: fixtureContext.paths.baselineSource, level: 'baseline',
    })
    await assert.rejects(
      () => fixtureContext.runtime.propose(mutation(fixtureContext.paths)),
      (error) => error instanceof ProductionRuntimeError
        && error.kind === 'infrastructure'
        && error.operation === 'updater-proposal'
        && error.cause === callbackError,
    )
  })
})

test('production updater cannot bypass bwrap and uses the firewall-restricted updater identity', async () => {
  const executions = []
  const context = await fixture({
    optionOverrides: { legacyUnsafeExecution: false },
    dependencyOverrides: {
      proposalRunner: undefined,
      applyRunner: undefined,
      async updaterExecute(options) {
        executions.push(options)
        if (options.env.DSH_PERMISSION_MODE === 'read-only') {
          return {
            ok: true,
            stdout: JSON.stringify({
              kind: 'MutationProposal', proposalId: 'p0001-l1',
              candidateId: 'c0001-l1', direction: 'sandbox fixture',
            }),
            stderr: '',
          }
        }
        return {
          ok: true,
          stdout: JSON.stringify({
            proposalId: 'p0001-l1', diagnosis: 'sandbox fixture',
            changedFiles: [], checks: [], remainingRisks: [],
          }),
          stderr: '',
        }
      },
    },
  })
  const baseline = await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  const proposal = await context.runtime.propose({
    campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
    candidateRoot: context.paths.candidateSource, feedbackRoot: context.paths.feedback,
    proposalId: 'p0001-l1', createdAt: '2026-01-01T00:00:00Z',
  })
  await context.runtime.apply({
    campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
    candidateRoot: context.paths.candidateSource, proposal,
  })

  assert.equal(executions.length, 2)
  for (const invocation of executions) {
    assert.equal(invocation.command, '/usr/bin/setpriv')
    assert.equal(invocation.args.includes('--reuid=1101'), true)
    assert.equal(invocation.args.includes('--regid=2101'), true)
    assert.equal(invocation.args.includes('/usr/bin/bwrap'), true)
    // Shared networking is required only for the loopback gateway; the CLI
    // runtime attests this exact updater UID in the fail-closed owner chain.
    assert.equal(invocation.args.includes('--unshare-net'), false)
    assert.equal(explicitMounts(invocation.args).length, 6)
    assert.equal(mountMode(
      invocation.args,
      baseline.runtimeRoot,
      '/opt/harness-rsi/updater-runtime',
    ), '--ro-bind')
    assert.equal(mountMode(
      invocation.args,
      context.paths.feedback,
      '/opt/harness-rsi/feedback',
    ), '--ro-bind')
    assert.equal(mountMode(
      invocation.args,
      context.paths.patch,
      '/opt/harness-rsi/runtime.patch.yml',
    ), '--ro-bind')
    const boundary = invocation.args.lastIndexOf('--')
    assert.equal(invocation.args.slice(boundary + 1).join(' ').includes(context.root), false)
    assert.equal(Object.values(invocation.env).join(' ').includes(context.root), false)
  }
  assert.equal(mountMode(
    executions[0].args,
    context.paths.candidateSource,
    '/opt/harness-rsi/candidate',
  ), '--ro-bind')
  assert.equal(mountMode(
    executions[1].args,
    context.paths.candidateSource,
    '/opt/harness-rsi/candidate',
  ), '--bind')
  const updaterPrivateDirectories = context.calls.directories.filter((entry) => (
    entry.path.startsWith(`${context.paths.updaterRuns}/`)
  ))
  assert.equal(updaterPrivateDirectories.length >= 6, true)
  assert.equal(updaterPrivateDirectories.every((entry) => (
    entry.uid === 1101 && entry.gid === 2101 && entry.mode === 0o700
  )), true)
})

test('duplicate updater dummy credentials fail before starting another gateway', async () => {
  const context = await fixture({
    dependencyOverrides: { dummyKeyFactory: () => 'same-dummy-key' },
  })
  await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  const proposal = await context.runtime.propose({
    campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
    candidateRoot: context.paths.candidateSource, feedbackRoot: context.paths.feedback,
    proposalId: 'p0001-l1', createdAt: '2026-01-01T00:00:00Z',
  })
  await assert.rejects(
    () => context.runtime.apply({
      campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
      candidateRoot: context.paths.candidateSource, proposal,
    }),
    ProductionRuntimeError,
  )
  assert.equal(context.calls.gateways.length, 1)
})

test('Updater never starts before its exact gateway lease and lease failure closes lazily', async () => {
  let leaseCalls = 0
  const context = await fixture({
    dependencyOverrides: {
      async acquireGatewayEgressLease() {
        leaseCalls += 1
        const error = new Error('firewall insert failed')
        error.kind = 'infrastructure'
        throw error
      },
    },
  })
  await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  await assert.rejects(
    () => context.runtime.propose({
      campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
      candidateRoot: context.paths.candidateSource, feedbackRoot: context.paths.feedback,
      proposalId: 'p0001-l1', createdAt: '2026-01-01T00:00:00Z',
    }),
    (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
  )
  assert.equal(leaseCalls, 1)
  assert.equal(context.calls.proposals.length, 0)
  assert.equal(context.calls.gateways.length, 1)
  assert.equal(context.calls.gatewayCloses.length, 1)
  // Merely binding the lazy loopback gateway and attempting its firewall lease
  // must neither load the provider credential nor send anything upstream.
  assert.equal(context.getApiKeyCalls, 0)
})

test('unconfirmed Updater lease cleanup sticky-poisons the UID against port reuse', async () => {
  let acquisitions = 0
  let releases = 0
  const context = await fixture({
    dependencyOverrides: {
      async acquireGatewayEgressLease() {
        acquisitions += 1
        return {
          async release() {
            releases += 1
            const error = new Error('exact allow rule still present')
            error.kind = 'infrastructure'
            error.fatal = true
            error.uid = 1101
            throw error
          },
        }
      },
    },
  })
  await context.runtime.buildCandidate({
    candidateId: 'baseline', candidateRoot: context.paths.baselineSource, level: 'baseline',
  })
  const mutation = {
    campaignId: 'campaign', candidateId: 'c0001-l1', parentId: 'baseline', level: 'l1',
    candidateRoot: context.paths.candidateSource, feedbackRoot: context.paths.feedback,
    proposalId: 'p0001-l1', createdAt: '2026-01-01T00:00:00Z',
  }
  await assert.rejects(
    () => context.runtime.propose(mutation),
    (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
  )
  await assert.rejects(
    () => context.runtime.propose({ ...mutation, proposalId: 'p0002-l1' }),
    (error) => error instanceof ProductionRuntimeError
      && /quarantined/u.test(error.message),
  )
  assert.equal(acquisitions, 1)
  assert.equal(releases, 1)
  assert.equal(context.calls.proposals.length, 1)
  assert.equal(context.calls.gateways.length, 1)
  assert.equal(context.calls.gatewayCloses.length, 1)
})

test('validation resumes non-error checkpoints, persists each new record, and reorders all 500', async () => {
  const context = await fixture()
  const ids = validationIds()
  const existing = new Map()
  for (let index = 0; index < 498; index += 1) {
    existing.set(ids[index], record(ids[index], index % 7 === 0 ? 'unresolved' : 'resolved', index + 1))
  }
  context.checkpointMap.set('candidate', existing)

  const result = await context.runtime.evaluateValidation({
    candidateId: 'candidate', candidateRoot: context.paths.evaluationRuntime, instanceIds: ids,
  })
  assert.equal(context.calls.partitions.length, 1)
  assert.deepEqual(context.calls.partitions[0].instanceIds, ids.slice(498))
  assert.equal(context.calls.dataset.length, 1)
  assert.equal(context.calls.traces.length, 2)
  assert.equal(context.calls.checkpointWrites.length, 2)
  assert.equal(context.calls.checkpointWrites.every((entry) => (
    entry.candidateId === 'candidate'
      && entry.secrets.includes('provider-real-secret-value')
  )), true)
  assert.deepEqual(result.records.map((entry) => entry.instanceId), ids)
  assert.equal(result.summary.total, 500)
  assert.equal(result.summary.verified, result.records.filter((entry) => entry.status === 'resolved').length)
  assert.deepEqual(result.summary.usage, {
    requests: 500, inputTokens: 1000, outputTokens: 1500, totalTokens: 2500,
  })
  assert.equal(result.summary.completedAt, '2026-01-02T03:04:05.000Z')
  assert.equal(context.calls.partitions[0].solverUid, 1103)
  assert.equal(context.calls.partitions[0].solverGid, 2103)
  assert.equal(context.calls.partitions[0].verifierUid, 1104)
  assert.equal(context.calls.partitions[0].verifierGid, 2104)
  assert.equal(context.calls.partitions[0].bwrapPath, '/usr/bin/bwrap')
  assert.equal(context.calls.partitions[0].setprivPath, '/usr/bin/setpriv')
  assert.equal(context.calls.partitions[0].baseEnvironment.ZCLOUD_API_KEY, undefined)
  assert.equal(context.calls.partitions[0].baseEnvironment.DASHSCOPE_API_KEY, undefined)
  assert.equal(context.calls.partitions[0].baseEnvironment.ELAN_HOME, '/opt/pinned-elan')
  assert.equal(context.calls.partitions[0].getApiKey, context.getApiKey)
  const preparedModes = new Map(context.calls.directories.map((entry) => [entry.path, entry.mode]))
  assert.deepEqual(context.calls.scratchValidations, [{
    root: context.paths.scratchRoot,
    trustedUid: 0,
  }])
  assert.equal(preparedModes.get(context.paths.campaignScratch), 0o711)
  assert.equal(preparedModes.get(join(context.paths.campaignScratch, 'sealed-test')), 0o711)

  const resumed = await context.runtime.evaluateValidation({
    candidateId: 'candidate', candidateRoot: context.paths.evaluationRuntime, instanceIds: ids,
  })
  assert.equal(context.calls.partitions.length, 1)
  assert.equal(context.calls.dataset.length, 1)
  assert.deepEqual(resumed.records.map((entry) => entry.instanceId), ids)
  assert.deepEqual(context.calls.frozenRuntimeValidations, [
    { root: context.paths.evaluationRuntime, trustedUid: 0 },
    { root: context.paths.evaluationRuntime, trustedUid: 0 },
  ])
  assert.deepEqual(context.calls.validations, [
    context.paths.evaluationRuntime,
    context.paths.evaluationRuntime,
  ])
})

test('smoke builds then reuses baseline and runs only caller-provided validation IDs in isolated scratch', async () => {
  const context = await fixture({
    dependencyOverrides: {
      async validateRuntime(path) {
        await readFile(join(path, 'runtime-copy.txt'), 'utf8')
      },
    },
  })
  const ids = validationIds().slice(0, 2)
  const first = await context.runtime.smoke({
    candidateRoot: context.paths.baselineSource,
    instanceIds: ids,
  })
  // Simulate a fresh Controller process reusing the persisted baseline.
  context.runtime.baselineBuilt = false
  const second = await context.runtime.smoke({
    candidateRoot: context.paths.baselineSource,
    instanceIds: ids.slice(0, 1),
  })

  assert.equal(first.summary.candidateId, 'baseline-smoke')
  assert.deepEqual(first.records.map((entry) => entry.instanceId), ids)
  assert.equal(first.records.every((entry) => entry.traceRef.startsWith('smoke://')), true)
  assert.equal(second.summary.total, 1)
  assert.equal(context.calls.partitions.length, 2)
  assert.deepEqual(context.calls.partitions[0].instanceIds, ids)
  assert.notEqual(context.calls.partitions[0].instanceIds, ids)
  assert.equal(
    context.calls.partitions[0].scratchRoot,
    join(context.paths.campaignScratch, 'smoke-scratch'),
  )
  assert.notEqual(context.calls.partitions[0].scratchRoot, context.paths.scratch)
  assert.equal(context.calls.partitions[0].sealed, false)
  assert.equal(context.calls.partitions[0].baseEnvironment.ELAN_HOME, '/opt/pinned-elan')
  assert.equal(context.calls.checkpointWrites.length, 0)
  assert.equal(context.calls.traces.length, 0)
  assert.equal(context.calls.copies.length, 1)
  assert.equal(context.calls.processes.filter((entry) => entry.args.includes('install')).length, 1)
  assert.deepEqual(context.calls.frozenRuntimeValidations, [{
    root: join(context.paths.runtimes, 'baseline'),
    trustedUid: 0,
  }])

  await assert.rejects(
    () => context.runtime.smoke({
      candidateRoot: context.paths.baselineSource,
      instanceIds: validationIds().slice(0, 9),
    }),
    ProductionRuntimeError,
  )
})

test('sealed test delegates only candidate identity/root and returns only an opaque receipt', async () => {
  const context = await fixture()
  const receipt = await context.runtime.evaluateTest({
    candidateId: 'candidate', candidateRoot: context.paths.evaluationRuntime,
  })
  assert.deepEqual(Object.keys(receipt).sort(), ['candidateId', 'completedAt', 'receiptId', 'status'])
  assert.equal(context.calls.sealed.length, 1)
  assert.deepEqual(context.calls.sealed[0], {
    candidateId: 'candidate',
    candidateRoot: context.paths.evaluationRuntime,
  })
  for (const forbidden of [
    'instanceIds', 'store', 'datasetRoot', 'scratchRoot', 'getApiKey',
    'baseEnvironment', 'solverUid', 'solverGid', 'signal',
  ]) {
    assert.equal(forbidden in context.calls.sealed[0], false)
  }
  assert.equal(context.calls.partitions.length, 0)
  assert.equal(context.calls.dataset.length, 0)
  const preparedModes = new Map(context.calls.directories.map((entry) => [entry.path, entry.mode]))
  assert.deepEqual(context.calls.scratchValidations, [{
    root: context.paths.scratchRoot,
    trustedUid: 0,
  }])
  assert.equal(preparedModes.get(context.paths.campaignScratch), 0o711)
  assert.equal(preparedModes.get(join(context.paths.campaignScratch, 'sealed-test')), 0o711)
})

test('sealed runner result-bearing fields are rejected as infrastructure contract failures', async () => {
  const context = await fixture({
    dependencyOverrides: {
      sealedTestRunner: async ({ candidateId }) => ({
        receiptId: 'bad-receipt', candidateId, status: 'sealed',
        completedAt: '2026-01-01T00:00:00Z', verified: 171,
      }),
    },
  })
  await assert.rejects(
    () => context.runtime.evaluateTest({
      candidateId: 'candidate', candidateRoot: context.paths.evaluationRuntime,
    }),
    (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
  )
})

test('validation and sealed evaluation reject source, nested, or illegal runtime paths', async () => {
  const context = await fixture()
  for (const candidateRoot of [
    context.paths.candidateSource,
    join(context.paths.runtimes, 'nested', 'runtime'),
    join(context.paths.runtimes, '.hidden'),
  ]) {
    await assert.rejects(
      () => context.runtime.evaluateTest({ candidateId: 'candidate', candidateRoot }),
      (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
    )
  }
  assert.equal(context.calls.sealed.length, 0)
  assert.equal(context.calls.frozenRuntimeValidations.length, 0)
})

test('source/runtime overlap is rejected before destructive build work', async () => {
  const context = await fixture()
  await assert.rejects(
    () => context.runtime.buildCandidate({
      candidateId: 'c0001-l1',
      candidateRoot: join(context.paths.runtimes, 'c0001-l1'),
      level: 'l1',
    }),
    (error) => error instanceof ProductionRuntimeError && error.kind === 'infrastructure',
  )
  assert.equal(context.calls.processes.length, 0)
  assert.equal(context.calls.copies.length, 0)
})

test('campaign scratch leaves must be strictly contained and mutually isolated', async () => {
  await assert.rejects(
    () => fixture({ optionOverrides: { validationScratchRoot: '/outside-validation' } }),
    /validationScratchRoot must be a direct child of campaignScratchRoot/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: {
      solverHome: join('/outside-campaign', 'nested', 'solver-home'),
      scratchRoot: '/',
      campaignScratchRoot: '/outside-campaign',
      validationScratchRoot: join('/outside-campaign', 'validation'),
      updaterRunRoot: join('/outside-campaign', 'updater'),
      smokeScratchRoot: join('/outside-campaign', 'smoke'),
      sourceSmokeRoot: join('/outside-campaign', 'source-smoke'),
    } }),
    /solverHome must be a direct child of campaignScratchRoot/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: {
      smokeScratchRoot: join('/outside-campaign', 'validation'),
      scratchRoot: '/',
      campaignScratchRoot: '/outside-campaign',
      validationScratchRoot: join('/outside-campaign', 'validation'),
      updaterRunRoot: join('/outside-campaign', 'updater'),
      sourceSmokeRoot: join('/outside-campaign', 'source-smoke'),
      solverHome: join('/outside-campaign', 'solver-home'),
    } }),
    /validationScratchRoot must be separate from smokeScratchRoot/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { campaignScratchRoot: undefined } }),
    /campaignScratchRoot must be an absolute path/u,
  )
})

test('production identities require four distinct primary groups', async () => {
  await assert.rejects(
    () => fixture({ optionOverrides: { solverGid: 2102 } }),
    /distinct primary gid/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { verifierGid: 2103 } }),
    /distinct primary gid/u,
  )
})

test('production identities require distinct non-controller user ids', async () => {
  await assert.rejects(
    () => fixture({ optionOverrides: { solverUid: 1102 } }),
    /distinct uid/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { updaterUid: 0 } }),
    /integers >= 1|distinct uid/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { verifierUid: 1103 } }),
    /distinct uid/u,
  )
})

test('production runtime requires bwrap/verifier identity and gates legacy runner injection', async () => {
  await assert.rejects(
    () => fixture({ optionOverrides: { bwrapPath: undefined } }),
    /bwrapPath must be an absolute path/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { verifierUid: undefined, verifierGid: undefined } }),
    /updater\/build\/solver\/verifier/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { legacyUnsafeExecution: false } }),
    /custom updater runners require legacyUnsafeExecution/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { testInstanceIds: ['putnam_2000_a1'] } }),
    /only to the sealed child broker/u,
  )
})

test('production toolchain pin cannot be overridden by campaign configuration', async () => {
  await assert.rejects(
    () => fixture({ optionOverrides: { expectedNodeVersion: 'v24.18.0' } }),
    /must match PRODUCTION_TOOLCHAIN_PIN/u,
  )
  await assert.rejects(
    () => fixture({ optionOverrides: { expectedPnpmVersion: '11.6.0' } }),
    /must match PRODUCTION_TOOLCHAIN_PIN/u,
  )
})

test('scratch traversal root must already be trusted-owned, nonsymlink, and 0711', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'production-scratch-root-'))
  const scratch = join(parent, 'scratch')
  const link = join(parent, 'scratch-link')
  await mkdir(scratch)
  await chmod(scratch, 0o711)
  await validateScratchTraversalRoot({ root: scratch, trustedUid: process.getuid() })

  await chmod(scratch, 0o700)
  await assert.rejects(
    () => validateScratchTraversalRoot({ root: scratch, trustedUid: process.getuid() }),
    /trusted-owned 0711/u,
  )
  await chmod(scratch, 0o711)
  await symlink('scratch', link)
  await assert.rejects(
    () => validateScratchTraversalRoot({ root: link, trustedUid: process.getuid() }),
    /trusted-owned 0711/u,
  )
})

test('pinned dependency store must be nonempty, trusted-owned, and immutable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-store-'))
  const trustedUid = process.getuid()
  const filesRoot = join(root, 'v11', 'files')
  const file = join(filesRoot, 'content-addressed-entry')
  const index = join(root, 'v11', 'index.db')
  const projectLink = join(root, 'v11', 'projects', 'trusted-project')
  await mkdir(filesRoot, { recursive: true })
  await mkdir(join(root, 'v11', 'projects'), { recursive: true })
  await Promise.all([
    writeFile(file, 'pinned dependency\n'),
    writeFile(index, 'pinned sqlite index\n'),
    symlink('../files', projectLink),
  ])
  await Promise.all([chmod(file, 0o444), chmod(index, 0o444)])
  await chmod(filesRoot, 0o555)
  await chmod(join(root, 'v11', 'projects'), 0o555)
  await chmod(join(root, 'v11'), 0o555)
  await chmod(root, 0o555)
  await validateImmutableDependencyStore({
    root,
    trustedUid,
    buildUid: trustedUid + 1,
  })

  await chmod(file, 0o664)
  await assert.rejects(
    () => validateImmutableDependencyStore({
      root,
      trustedUid,
      buildUid: trustedUid + 1,
    }),
    /group\/other writable/u,
  )
})

test('evaluation runtime critical launch closure must remain trusted-owned and frozen', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'production-evaluation-runtime-'))
  const root = join(parent, 'candidate-parent')
  const sourceEntry = join(root, 'apps', 'cli', 'src', 'bin.ts')
  const tsxEntry = join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  const commandsTypert = join(
    root, 'packages', 'interaction', 'commands', 'lib', 'typert.host.js',
  )
  const goalTypert = join(root, 'packages', 'goal', 'goal', 'lib', 'typert.host.js')
  await Promise.all([
    mkdir(join(root, 'apps', 'cli', 'src'), { recursive: true }),
    mkdir(join(root, 'node_modules', 'tsx', 'dist', 'esm'), { recursive: true }),
    mkdir(join(root, 'packages', 'interaction', 'commands', 'lib'), { recursive: true }),
    mkdir(join(root, 'packages', 'goal', 'goal', 'lib'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(sourceEntry, 'export {}\n'),
    writeFile(tsxEntry, 'export {}\n'),
    writeFile(commandsTypert, 'export {}\n'),
    writeFile(goalTypert, 'export {}\n'),
  ])
  await Promise.all([
    chmod(sourceEntry, 0o444),
    chmod(tsxEntry, 0o444),
    chmod(commandsTypert, 0o444),
    chmod(goalTypert, 0o444),
  ])
  for (const directory of [
    join(root, 'apps', 'cli', 'src'),
    join(root, 'apps', 'cli'),
    join(root, 'apps'),
    join(root, 'packages', 'interaction', 'commands', 'lib'),
    join(root, 'packages', 'interaction', 'commands'),
    join(root, 'packages', 'interaction'),
    join(root, 'packages', 'goal', 'goal', 'lib'),
    join(root, 'packages', 'goal', 'goal'),
    join(root, 'packages', 'goal'),
    join(root, 'packages'),
    join(root, 'node_modules', 'tsx', 'dist', 'esm'),
    join(root, 'node_modules', 'tsx', 'dist'),
    join(root, 'node_modules', 'tsx'),
    join(root, 'node_modules'),
    root,
  ]) await chmod(directory, 0o555)

  await validateFrozenEvaluationRuntime({ root, trustedUid: process.getuid() })
  await chmod(sourceEntry, 0o644)
  await assert.rejects(
    () => validateFrozenEvaluationRuntime({ root, trustedUid: process.getuid() }),
    /trusted-owned and frozen/u,
  )
})

test('evaluation runtime accepts only a frozen internal pnpm tsx link', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'production-evaluation-pnpm-link-'))
  const root = join(parent, 'candidate-parent')
  const nodeModules = join(root, 'node_modules')
  const pnpmRoot = join(nodeModules, '.pnpm')
  const packageRoot = join(pnpmRoot, 'tsx@4.22.4')
  const packageNodeModules = join(packageRoot, 'node_modules')
  const tsxTarget = join(packageNodeModules, 'tsx')
  const tsxLink = join(nodeModules, 'tsx')
  const sourceEntry = join(root, 'apps', 'cli', 'src', 'bin.ts')
  const tsxEntry = join(tsxTarget, 'dist', 'esm', 'index.mjs')
  const commandsTypert = join(
    root, 'packages', 'interaction', 'commands', 'lib', 'typert.host.js',
  )
  const goalTypert = join(root, 'packages', 'goal', 'goal', 'lib', 'typert.host.js')
  const internalTarget = join('.pnpm', 'tsx@4.22.4', 'node_modules', 'tsx')

  await Promise.all([
    mkdir(join(root, 'apps', 'cli', 'src'), { recursive: true }),
    mkdir(join(tsxTarget, 'dist', 'esm'), { recursive: true }),
    mkdir(join(root, 'packages', 'interaction', 'commands', 'lib'), { recursive: true }),
    mkdir(join(root, 'packages', 'goal', 'goal', 'lib'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(sourceEntry, 'export {}\n'),
    writeFile(tsxEntry, 'export {}\n'),
    writeFile(commandsTypert, 'export {}\n'),
    writeFile(goalTypert, 'export {}\n'),
    symlink(internalTarget, tsxLink),
  ])
  await Promise.all([
    chmod(sourceEntry, 0o444),
    chmod(tsxEntry, 0o444),
    chmod(commandsTypert, 0o444),
    chmod(goalTypert, 0o444),
  ])
  for (const directory of [
    join(root, 'apps', 'cli', 'src'),
    join(root, 'apps', 'cli'),
    join(root, 'apps'),
    join(root, 'packages', 'interaction', 'commands', 'lib'),
    join(root, 'packages', 'interaction', 'commands'),
    join(root, 'packages', 'interaction'),
    join(root, 'packages', 'goal', 'goal', 'lib'),
    join(root, 'packages', 'goal', 'goal'),
    join(root, 'packages', 'goal'),
    join(root, 'packages'),
    join(tsxTarget, 'dist', 'esm'),
    join(tsxTarget, 'dist'),
    tsxTarget,
    packageNodeModules,
    packageRoot,
    pnpmRoot,
    nodeModules,
    root,
  ]) await chmod(directory, 0o555)

  const trustedUid = process.getuid()
  await validateFrozenEvaluationRuntime({ root, trustedUid })

  await chmod(pnpmRoot, 0o755)
  await assert.rejects(
    () => validateFrozenEvaluationRuntime({ root, trustedUid }),
    /symlink target is not trusted-owned and frozen/u,
  )
  await chmod(pnpmRoot, 0o555)

  const replaceLink = async (target) => {
    await chmod(nodeModules, 0o755)
    await unlink(tsxLink)
    await symlink(target, tsxLink)
    await chmod(nodeModules, 0o555)
  }

  await replaceLink(tsxTarget)
  await assert.rejects(
    () => validateFrozenEvaluationRuntime({ root, trustedUid }),
    /symlink must be relative/u,
  )

  await replaceLink(join('..', '..', 'outside-runtime'))
  await assert.rejects(
    () => validateFrozenEvaluationRuntime({ root, trustedUid }),
    /symlink target must be normalized/u,
  )

  await replaceLink(join('.pnpm', 'missing', 'node_modules', 'tsx'))
  await assert.rejects(
    () => validateFrozenEvaluationRuntime({ root, trustedUid }),
    /symlink target is invalid/u,
  )

  await chmod(pnpmRoot, 0o755)
  await symlink(join('tsx@4.22.4', 'node_modules', 'tsx'), join(pnpmRoot, 'current-tsx'))
  await chmod(pnpmRoot, 0o555)
  await replaceLink(join('.pnpm', 'current-tsx'))
  await assert.rejects(
    () => validateFrozenEvaluationRuntime({ root, trustedUid }),
    /symlink target chain is invalid/u,
  )
})
