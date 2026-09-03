import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readConfigFile } from '../src/config.mjs'
import { createBudgetPlan } from '../src/evolution-modes.mjs'
import {
  normalizeCoworkEvolutionRecipe,
  normalizeEvolutionRecipe,
  normalizeReasoningEvolutionRecipe,
} from '../src/evolution-recipe.mjs'
import { ProtocolError } from '../src/protocol.mjs'

const MODES = ['single', 'independent', 'mutualism', 'competition', 'combined']
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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

test('Reasoning controller-sequential 映射为渐进风险扩展 Strategy', () => {
  const recipe = normalizeReasoningEvolutionRecipe({
    controllerConfig: controllerConfig('single'),
  })
  assert.equal(recipe.spec.moduleSearch.authority, 'strategy-directed')
  assert.equal(recipe.spec.moduleSearch.strategy, 'progressive-risk-expansion')
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

test('EvolutionRecipe 可按 Population Budget 里程碑配置消融 Checkpoint', () => {
  const input = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionRecipe',
    spec: {
      population: controllerConfig('independent', { total: 16 }),
      moduleSearch: {
        authority: 'strategy-directed',
        riskCeiling: 'l2',
        strategy: 'linear-hill-climb',
      },
      checkpointing: {
        budgetMilestones: [0, 4, 8, 12, 16],
        capture: {
          populationBest: true,
          branchIncumbents: true,
          latestAttempts: true,
        },
      },
    },
  }
  const recipe = normalizeEvolutionRecipe(input)
  assert.deepEqual(recipe.spec.checkpointing.budgetMilestones, [0, 4, 8, 12, 16])
  assert.deepEqual(recipe.spec.checkpointing.capture, {
    populationBest: true,
    branchIncumbents: true,
    latestAttempts: true,
  })

  input.spec.checkpointing.budgetMilestones = [0, 8, 4]
  assert.throws(() => normalizeEvolutionRecipe(input), /必须严格递增/u)
  input.spec.checkpointing.budgetMilestones = [0, 17]
  assert.throws(() => normalizeEvolutionRecipe(input), /0\.\.16/u)
  input.spec.checkpointing.budgetMilestones = [0, 4]
  input.spec.checkpointing.capture = {
    populationBest: false,
    branchIncumbents: false,
    latestAttempts: false,
  }
  assert.throws(() => normalizeEvolutionRecipe(input), /至少必须启用一项/u)
})

test('五种 N2B16 消融 Recipe 共用同一组 Budget 里程碑', async () => {
  for (const mode of MODES) {
    const recipe = normalizeEvolutionRecipe(await readConfigFile(resolve(
      REPOSITORY_ROOT,
      `recipes/population-ablation-linear-16/${mode}.yml`,
    )))
    assert.equal(recipe.spec.population.mode, mode)
    assert.equal(recipe.spec.population.budget.total_budget, 16)
    assert.equal(recipe.spec.population.concurrency.n_branches, mode === 'single' ? 1 : 2)
    assert.deepEqual(recipe.spec.checkpointing.budgetMilestones, [0, 4, 8, 12, 16])
  }
})
