import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadExperimentBundle } from '../src/adapters.mjs'
import { mutationCatalogFor } from '../src/mutation-catalog.mjs'
import { createSearchStrategyDriver } from '../src/search-strategy.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function progressiveBundle() {
  return await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/reasoning-msa-progressive-strict-smoke.json'),
    repositoryRoot,
  )
}

function strategyContext(bundle, generation) {
  return {
    runId: 'progressive-config-test',
    generation,
    riskCeiling: bundle.recipe.spec.moduleSearch.riskCeiling,
    catalog: mutationCatalogFor(bundle.target),
    championId: 'h0',
    allowedParentIds: ['h0'],
    candidates: [{ id: 'h0', parentId: null, digest: 'fixture-digest', status: 'baseline' }],
    searchHistory: [],
  }
}

test('Progressive 示例完整绑定 Recipe、Strategy、Target 与严格晋升 Policy', async () => {
  const bundle = await progressiveBundle()
  assert.equal(bundle.recipe.spec.population.mode, 'single')
  assert.equal(bundle.recipe.spec.population.budget.total_budget, 9)
  assert.equal(bundle.recipe.spec.moduleSearch.authority, 'strategy-directed')
  assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l3')
  assert.equal(bundle.recipe.spec.moduleSearch.strategy, 'progressive-risk-expansion')
  assert.equal(bundle.strategy.id, 'progressive-risk-expansion')
  assert.equal(bundle.target.id, 'msa-minimal-reasoning')
  assert.equal(bundle.policy.id, 'strict-mean-reward-improvement-v1')
  assert.equal(bundle.policy.gates.quality.minimumMeanRewardDelta, 0)
  assert.equal(bundle.policy.gates.quality.minimumRewardImproved, 1)
  assert.equal(bundle.policy.gates.quality.maximumRewardRegressions, 0)
  assert.equal(bundle.experiment.evolution.generations, 9)
})

test('Progressive 示例通过真实 Loader 链路按 L1、L2、L3 推进并耗尽', async () => {
  const bundle = await progressiveBundle()
  const driver = createSearchStrategyDriver({ adapter: bundle.strategy })
  let state = null
  const regionsByGeneration = new Map()

  for (let generation = 1; generation <= 9; generation += 1) {
    const proposed = await driver.propose(strategyContext(bundle, generation), state)
    state = proposed.state
    regionsByGeneration.set(generation, proposed.plan.spec.regionIds)
    const observed = await driver.observe({
      runId: 'progressive-config-test',
      generation,
      parentId: 'h0',
      proposalId: `g${String(generation).padStart(3, '0')}`,
      status: 'rejected',
      championId: 'h0',
      regionIds: proposed.plan.spec.regionIds,
    }, state)
    state = observed.state
    assert.equal(observed.exhausted, generation === 9)
  }

  assert.deepEqual(regionsByGeneration.get(1), ['reasoning-profile'])
  assert.deepEqual(regionsByGeneration.get(4), [
    'reasoning-profile', 'reasoning-agent-loop', 'reasoning-tool-runtime',
  ])
  assert.deepEqual(regionsByGeneration.get(7), [
    'reasoning-profile',
    'reasoning-agent-loop',
    'reasoning-tool-runtime',
    'reasoning-model-transport',
    'reasoning-runtime-wiring',
  ])
  assert.equal(state.exhausted, true)
})
