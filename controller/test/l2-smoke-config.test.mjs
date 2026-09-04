import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadExperimentBundle } from '../src/adapters.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('Cowork 与 Reasoning 的 L1+L2 Smoke 使用同一 Single Recipe 风险上限', async () => {
  for (const scene of ['cowork', 'reasoning']) {
    const bundle = await loadExperimentBundle(
      resolve(repositoryRoot, `experiments/${scene}-msa-smoke-l2-single.json`),
      repositoryRoot,
    )
    assert.equal(bundle.recipe.spec.population.mode, 'single')
    assert.equal(bundle.recipe.spec.population.budget.total_budget, 1)
    assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l2')
    assert.equal(bundle.experiment.evolution.mutationLevel, 'l2')
    assert.ok(bundle.target.mutation.catalog.regions.some((region) => region.riskLevel === 'l2'))
  }
})
