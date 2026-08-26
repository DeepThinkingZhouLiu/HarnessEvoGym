import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { runProcess } from '../src/process.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const strategyPath = resolve(repositoryRoot, 'strategies/examples/round-robin/strategy.mjs')

function request(operation, state = null, context = {}) {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'SearchStrategyRequest',
    operation,
    strategy: {
      id: 'round-robin-test',
      configuration: { regionOrder: ['skill-guidance', 'preset-composition', 'skill-scripts'] },
    },
    state,
    context,
  }
}

const catalog = {
  apiVersion: 'harness-rsi/v1alpha1',
  kind: 'MutationCatalog',
  metadata: { target: 'test' },
  spec: {
    riskLevels: ['l1', 'l2'],
    maximumRegionsPerPlan: 3,
    regions: [
      { id: 'preset-composition', riskLevel: 'l1', requires: [], conflicts: [] },
      { id: 'skill-guidance', riskLevel: 'l1', requires: [], conflicts: [] },
      { id: 'skill-scripts', riskLevel: 'l2', requires: ['skill-guidance'], conflicts: [] },
    ],
  },
}

async function invoke(payload) {
  const result = await runProcess(process.execPath, [strategyPath], {
    input: `${JSON.stringify(payload)}\n`,
    timeoutMs: 5_000,
  })
  return JSON.parse(result.stdout)
}

test('Contributor Round Robin 示例只返回 Region ID 并持久化游标', async () => {
  const context = {
    runId: 'example-run',
    generation: 1,
    riskCeiling: 'l1',
    catalog,
    championId: 'h0',
    allowedParentIds: ['h0'],
    candidates: [{ id: 'h0', status: 'baseline' }],
    searchHistory: [],
  }
  const first = await invoke(request('propose', null, context))
  assert.deepEqual(first.plan.spec.regionIds, ['skill-guidance'])
  assert.equal(Object.hasOwn(first.plan.spec, 'writable'), false)

  const second = await invoke(request('propose', first.state, { ...context, generation: 2 }))
  assert.deepEqual(second.plan.spec.regionIds, ['preset-composition'])
  assert.equal(second.state.proposed, 2)

  const observed = await invoke(request('observe', second.state, {
    generation: 2,
    proposalId: 'g002-l1',
    status: 'promoted',
  }))
  assert.equal(observed.state.observed, 1)
  assert.equal(observed.state.lastStatus, 'promoted')
})

test('Contributor Round Robin 示例不会在 L1 选择 L2 Region', async () => {
  const output = await invoke(request('propose', { cursor: 2, proposed: 2, observed: 1 }, {
    runId: 'example-run',
    generation: 3,
    riskCeiling: 'l1',
    catalog,
    championId: 'h0',
    allowedParentIds: ['h0'],
    candidates: [{ id: 'h0', status: 'baseline' }],
    searchHistory: [],
  }))
  assert.deepEqual(output.plan.spec.regionIds, ['skill-guidance'])
})
