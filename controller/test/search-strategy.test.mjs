import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  defaultSearchStrategyAdapter,
  loadExperimentBundle,
  validateSearchStrategyAdapter,
} from '../src/adapters.mjs'
import { mutationCatalogFor } from '../src/mutation-catalog.mjs'
import { createSearchStrategyDriver } from '../src/search-strategy.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function context() {
  const bundle = await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/cowork-skillsbench-dsh-l1.json'),
    repositoryRoot,
  )
  return {
    runId: 'run-test',
    generation: 1,
    riskCeiling: 'l1',
    catalog: mutationCatalogFor(bundle.target),
    championId: 'h0',
    allowedParentIds: ['h0'],
    candidates: [{ id: 'h0', parentId: null, digest: 'digest', status: 'baseline' }],
    searchHistory: [],
  }
}

async function progressiveContext(generation = 1) {
  const bundle = await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/reasoning-msa-smoke-l2-single.json'),
    repositoryRoot,
  )
  return {
    runId: 'progressive-run-test',
    generation,
    riskCeiling: 'l3',
    catalog: mutationCatalogFor(bundle.target),
    championId: 'h0',
    allowedParentIds: ['h0'],
    candidates: [{ id: 'h0', parentId: null, digest: 'digest', status: 'baseline' }],
    searchHistory: [],
  }
}

function progressiveAdapter(configuration = {}) {
  return validateSearchStrategyAdapter({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'SearchStrategyAdapter',
    metadata: { id: 'progressive-risk-expansion' },
    spec: {
      protocol: 'builtin-v1',
      implementation: 'progressive-risk-expansion',
      configuration: {
        startRiskLevel: 'l1',
        missesBeforeExpansion: 3,
        regionSelection: 'all-under-active-risk-level',
        ...configuration,
      },
    },
  })
}

test('内置线性 Strategy 保持旧行为并持久化最小状态', async () => {
  const driver = createSearchStrategyDriver({ adapter: defaultSearchStrategyAdapter() })
  const proposed = await driver.propose(await context())
  assert.deepEqual(proposed.plan.spec.parentIds, ['h0'])
  assert.deepEqual(proposed.plan.spec.regionIds, ['preset-composition', 'skill-guidance'])
  assert.equal(proposed.state.roundsProposed, 1)

  const observed = await driver.observe({
    runId: 'run-test',
    generation: 1,
    parentId: 'h0',
    proposalId: 'g001-l1',
    status: 'promoted',
    championId: 'g001-l1',
    regionIds: proposed.plan.spec.regionIds,
  }, proposed.state)
  assert.equal(observed.state.roundsObserved, 1)
  assert.equal(observed.state.lastObservation.status, 'promoted')
})

test('渐进风险扩展在连续三次未晋升后从 L1 扩大到 L2 和 L3', async () => {
  const driver = createSearchStrategyDriver({ adapter: progressiveAdapter() })
  let state = null
  let lastPlan = null
  for (let generation = 1; generation <= 9; generation += 1) {
    const proposed = await driver.propose(await progressiveContext(generation), state)
    state = proposed.state
    lastPlan = proposed.plan
    if (generation <= 3) {
      assert.deepEqual(lastPlan.spec.regionIds, ['reasoning-profile'])
    } else if (generation <= 6) {
      assert.deepEqual(lastPlan.spec.regionIds, [
        'reasoning-profile', 'reasoning-agent-loop', 'reasoning-tool-runtime',
      ])
    } else {
      assert.deepEqual(lastPlan.spec.regionIds, [
        'reasoning-profile',
        'reasoning-agent-loop',
        'reasoning-tool-runtime',
        'reasoning-model-transport',
        'reasoning-runtime-wiring',
      ])
    }
    const observed = await driver.observe({
      runId: 'progressive-run-test',
      generation,
      parentId: 'h0',
      proposalId: `g${String(generation).padStart(3, '0')}`,
      status: 'rejected',
      championId: 'h0',
      regionIds: lastPlan.spec.regionIds,
    }, state)
    state = observed.state
    assert.equal(observed.exhausted, generation === 9)
  }
  assert.equal(state.activeRiskLevel, 'l3')
  assert.equal(state.expansions, 2)
  assert.equal(state.exhausted, true)
  await assert.rejects(
    driver.propose(await progressiveContext(10), state),
    /已耗尽/u,
  )
})

test('渐进风险扩展在 Candidate 晋升后清空连续失败计数', async () => {
  const driver = createSearchStrategyDriver({ adapter: progressiveAdapter() })
  let proposed = await driver.propose(await progressiveContext(1))
  let observed = await driver.observe({
    runId: 'progressive-run-test', generation: 1, parentId: 'h0', proposalId: 'g001',
    status: 'rejected', championId: 'h0', regionIds: proposed.plan.spec.regionIds,
  }, proposed.state)
  proposed = await driver.propose(await progressiveContext(2), observed.state)
  observed = await driver.observe({
    runId: 'progressive-run-test', generation: 2, parentId: 'h0', proposalId: 'g002',
    status: 'promoted', championId: 'g002', regionIds: proposed.plan.spec.regionIds,
  }, proposed.state)
  assert.equal(observed.state.activeRiskLevel, 'l1')
  assert.equal(observed.state.consecutiveMisses, 0)
  assert.equal(observed.exhausted, false)
})

test('渐进风险扩展只遍历当前 Target 真正定义的风险层', async () => {
  const driver = createSearchStrategyDriver({
    adapter: progressiveAdapter({ missesBeforeExpansion: 1 }),
  })
  const dshContext = { ...await context(), riskCeiling: 'l2' }
  const first = await driver.propose(dshContext)
  assert.deepEqual(first.plan.spec.regionIds, ['preset-composition', 'skill-guidance'])
  const firstObservation = await driver.observe({
    runId: 'run-test', generation: 1, parentId: 'h0', proposalId: 'g001',
    status: 'rejected', championId: 'h0', regionIds: first.plan.spec.regionIds,
  }, first.state)
  assert.equal(firstObservation.state.activeRiskLevel, 'l2')

  const second = await driver.propose({ ...dshContext, generation: 2 }, firstObservation.state)
  assert.deepEqual(second.plan.spec.regionIds, [
    'preset-composition', 'skill-guidance', 'skill-scripts',
  ])
  const secondObservation = await driver.observe({
    runId: 'run-test', generation: 2, parentId: 'h0', proposalId: 'g002',
    status: 'rejected', championId: 'h0', regionIds: second.plan.spec.regionIds,
  }, second.state)
  assert.equal(secondObservation.exhausted, true)
  assert.deepEqual(secondObservation.state.riskLevels, ['l1', 'l2'])
})

test('渐进风险扩展严格拒绝未知配置和非法耐心阈值', () => {
  assert.throws(
    () => createSearchStrategyDriver({ adapter: progressiveAdapter({ missesBeforeExpansion: 0 }) }),
    /1\.\.10000/u,
  )
  assert.throws(
    () => createSearchStrategyDriver({ adapter: progressiveAdapter({ arbitrary: true }) }),
    /未知配置/u,
  )
})

test('外部 Docker Strategy 无网络、无挂载、无宿主环境泄漏，只交换 JSON', async () => {
  const requests = []
  const fakeDocker = {
    async imageExists() { return true },
    async run(options) {
      requests.push(options)
      const request = JSON.parse(options.input)
      const response = request.operation === 'propose'
        ? {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'SearchStrategyResponse',
            operation: 'propose',
            state: { cursor: 1 },
            plan: {
              apiVersion: 'harness-rsi/v1alpha1',
              kind: 'MutationPlan',
              metadata: { id: 'external-plan-1' },
              spec: { generation: 1, parentIds: ['h0'], regionIds: ['skill-guidance'] },
            },
          }
        : {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'SearchStrategyResponse',
            operation: 'observe',
            state: { cursor: 2 },
            exhausted: true,
          }
      return { stdout: JSON.stringify(response), stderr: '' }
    },
  }
  const adapter = validateSearchStrategyAdapter({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'SearchStrategyAdapter',
    metadata: { id: 'external-test' },
    spec: {
      protocol: 'docker-json-v1',
      runtime: {
        image: `example/strategy@sha256:${'a'.repeat(64)}`,
        command: ['node', '/app/strategy.mjs'],
        timeoutSeconds: 10,
        resources: { cpus: 0.5, memory: '64m', pids: 32 },
      },
      configuration: { policy: 'round-robin' },
    },
  })
  const proxyNames = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]
  const originalProxyEnvironment = Object.fromEntries(proxyNames.map((name) => [name, process.env[name]]))
  const hostProxySecret = 'http://host-proxy-credential.invalid:7890'
  let proposed
  let observed
  try {
    for (const name of proxyNames) process.env[name] = hostProxySecret
    const driver = createSearchStrategyDriver({ adapter, docker: fakeDocker })
    await driver.preflight()
    proposed = await driver.propose(await context())
    observed = await driver.observe({
      runId: 'run-test', generation: 1, parentId: 'h0', proposalId: 'g001-l1',
      status: 'rejected', championId: 'h0', regionIds: proposed.plan.spec.regionIds,
    }, proposed.state)
  } finally {
    for (const name of proxyNames) {
      if (originalProxyEnvironment[name] === undefined) delete process.env[name]
      else process.env[name] = originalProxyEnvironment[name]
    }
  }
  assert.deepEqual(proposed.plan.spec.regionIds, ['skill-guidance'])
  assert.equal(observed.exhausted, true)
  const publicRegion = JSON.parse(requests[0].input).context.catalog.spec.regions[0]
  assert.equal(Object.hasOwn(publicRegion, 'writable'), false)
  assert.equal(Object.hasOwn(publicRegion, 'extensions'), false)
  assert.equal(requests[0].network, 'none')
  assert.deepEqual(requests[0].mounts, [])
  assert.deepEqual(requests[0].environment, Object.fromEntries(proxyNames.map((name) => [name, ''])))
  assert.deepEqual(requests[0].secretEnvironment, {})
  assert.deepEqual(requests[0].inheritEnvironment, [])
  assert.equal(JSON.stringify({
    environment: requests[0].environment,
    secretEnvironment: requests[0].secretEnvironment,
    inheritEnvironment: requests[0].inheritEnvironment,
  }).includes(hostProxySecret), false)
  assert.equal(requests[0].readOnlyRoot, true)
})

test('外部 Strategy 镜像名拒绝控制字符，并必须固定 RepoDigest', () => {
  const base = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'SearchStrategyAdapter',
    metadata: { id: 'unsafe-image' },
    spec: {
      protocol: 'docker-json-v1',
      runtime: {
        image: `example/strategy@sha256:${'a'.repeat(64)}`,
        command: ['strategy'],
        timeoutSeconds: 10,
        resources: { cpus: 0.5, memory: '64m', pids: 32 },
      },
      configuration: {},
    },
  }
  assert.doesNotThrow(() => validateSearchStrategyAdapter(base))
  base.spec.runtime.image = `example/strategy\n@sha256:${'a'.repeat(64)}`
  assert.throws(() => validateSearchStrategyAdapter(base), /必须固定/u)
  base.spec.runtime.image = 'example/strategy:latest'
  assert.throws(() => validateSearchStrategyAdapter(base), /必须固定/u)
})

test('Search Strategy Context 和响应不能夹带 Final 或越界 Region', async () => {
  const driver = createSearchStrategyDriver({ adapter: defaultSearchStrategyAdapter() })
  await assert.rejects(driver.propose({ ...await context(), final: { score: 1 } }), /禁止包含 .*final/u)
  await assert.rejects(
    driver.propose({ ...await context(), candidates: [{ id: 'h0', metadata: { apiKey: 'forbidden' } }] }),
    /禁止包含 .*apiKey/u,
  )

  const fakeDocker = {
    async run() {
      return {
        stdout: JSON.stringify({
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'SearchStrategyResponse',
          operation: 'propose',
          state: {},
          plan: {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'MutationPlan',
            metadata: { id: 'forged' },
            spec: { generation: 1, parentIds: ['h0'], regionIds: ['controller-root'] },
          },
        }),
      }
    },
  }
  const adapter = {
    ...defaultSearchStrategyAdapter(),
    id: 'forged-external',
    protocol: 'docker-json-v1',
    implementation: null,
    runtime: {
      image: `example/strategy@sha256:${'b'.repeat(64)}`,
      command: ['strategy'],
      timeoutSeconds: 10,
      resources: { cpus: 0.5, memory: '64m', pids: 32 },
    },
  }
  const external = createSearchStrategyDriver({ adapter, docker: fakeDocker })
  await assert.rejects(external.propose(await context()), /未知 Region/u)
})

test('Search Strategy State 拒绝会被 JSON 静默改写的值', async () => {
  const driver = createSearchStrategyDriver({ adapter: defaultSearchStrategyAdapter() })
  for (const invalid of [
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: undefined },
    { value: 1n },
  ]) {
    await assert.rejects(driver.propose(await context(), invalid), /非有限数字|非 JSON 值/u)
  }
})
