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

test('外部 Docker Strategy 无网络、无挂载、无环境变量，只交换 JSON', async () => {
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
  const driver = createSearchStrategyDriver({ adapter, docker: fakeDocker })
  await driver.preflight()
  const proposed = await driver.propose(await context())
  assert.deepEqual(proposed.plan.spec.regionIds, ['skill-guidance'])
  const publicRegion = JSON.parse(requests[0].input).context.catalog.spec.regions[0]
  assert.equal(Object.hasOwn(publicRegion, 'writable'), false)
  assert.equal(Object.hasOwn(publicRegion, 'extensions'), false)
  assert.equal(requests[0].network, 'none')
  assert.deepEqual(requests[0].mounts, [])
  assert.deepEqual(requests[0].environment, {})
  assert.deepEqual(requests[0].inheritEnvironment, [])
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
