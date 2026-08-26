import assert from 'node:assert/strict'
import test from 'node:test'

import { createBudgetPlan } from '../src/evolution-modes.mjs'
import {
  normalizeCoworkEvolutionRecipe,
  normalizeEvolutionRecipe,
  normalizeReasoningEvolutionRecipe,
} from '../src/evolution-recipe.mjs'
import { ProtocolError } from '../src/protocol.mjs'

const MODES = ['single', 'independent', 'mutualism', 'competition', 'combined']

function controllerConfig(mode, { total = 12 } = {}) {
  const sharing = ['mutualism', 'combined'].includes(mode)
  const competition = ['competition', 'combined'].includes(mode)
  return {
    mode,
    concurrency: { n_branches: mode === 'single' ? 1 : 2 },
    budget: { total_budget: total, beta: 0.5 },
    peer_sharing: { enabled: sharing },
    competition: { enabled: competition, bonus_grant_unit: 1 },
  }
}

test('Reasoning 五种 Mode 规范化后保持名称与 Budget 语义', () => {
  for (const mode of MODES) {
    const oldConfig = controllerConfig(mode)
    const oldPlan = createBudgetPlan(oldConfig)
    const recipe = normalizeReasoningEvolutionRecipe({
      controllerConfig: oldConfig,
      layerSelection: 'updater-soft',
    })
    const population = recipe.spec.population
    const newPlan = createBudgetPlan(population)
    assert.equal(population.mode, mode)
    assert.deepEqual(newPlan, oldPlan)
    assert.equal(recipe.spec.moduleSearch.authority, 'updater-directed')
    assert.equal(recipe.spec.moduleSearch.strategy, null)
  }
})

test('Reasoning controller-sequential 映射为内置兼容 Strategy', () => {
  const recipe = normalizeReasoningEvolutionRecipe({
    controllerConfig: controllerConfig('single'),
  })
  assert.equal(recipe.spec.moduleSearch.authority, 'strategy-directed')
  assert.equal(recipe.spec.moduleSearch.strategy, 'legacy-layer-sequential')
  assert.equal(recipe.spec.moduleSearch.riskCeiling, 'l3')
})

test('Cowork 旧 generations/strategy 映射为 Single Population', () => {
  const defaultRecipe = normalizeCoworkEvolutionRecipe({
    generations: 3,
    mutationLevel: 'l1',
  })
  assert.equal(defaultRecipe.spec.population.mode, 'single')
  assert.equal(defaultRecipe.spec.population.concurrency.n_branches, 1)
  assert.equal(defaultRecipe.spec.population.budget.total_budget, 3)
  assert.equal(defaultRecipe.spec.moduleSearch.authority, 'strategy-directed')
  assert.equal(defaultRecipe.spec.moduleSearch.strategy, 'linear-hill-climb')

  const configured = normalizeCoworkEvolutionRecipe({
    generations: 2,
    mutationLevel: 'l2',
    strategy: { id: 'round-robin', protocol: 'docker-json-v1' },
  })
  assert.equal(configured.spec.moduleSearch.strategy, 'round-robin')
  assert.equal(configured.spec.moduleSearch.riskCeiling, 'l2')
})

test('EvolutionRecipe 严格约束搜索权限与 Strategy 的关系', () => {
  const population = controllerConfig('single')
  assert.throws(
    () => normalizeEvolutionRecipe({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionRecipe',
      spec: {
        population,
        moduleSearch: {
          authority: 'updater-directed', riskCeiling: 'l2', strategy: 'round-robin',
        },
      },
    }),
    (error) => error instanceof ProtocolError && /不能预先指定/u.test(error.message),
  )
  assert.throws(
    () => normalizeEvolutionRecipe({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionRecipe',
      spec: {
        population,
        moduleSearch: {
          authority: 'strategy-directed', riskCeiling: 'l2', strategy: null,
        },
      },
    }),
    (error) => error instanceof ProtocolError && /必须指定/u.test(error.message),
  )
})
