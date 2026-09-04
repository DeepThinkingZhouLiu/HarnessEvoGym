import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { loadExperimentBundle } from '../src/adapters.mjs'
import { REPOSITORY_ROOT } from '../src/config.mjs'
import { createBudgetPlan } from '../src/evolution-modes.mjs'

const MODES = ['single', 'independent', 'mutualism', 'competition', 'combined']

test('五种 Cowork RSI 配置使用同一正式起点、严格评测与总预算', async () => {
  for (const mode of MODES) {
    const bundle = await loadExperimentBundle(
      resolve(REPOSITORY_ROOT, `experiments/cowork-msa-rsi-linear-${mode}.json`),
      REPOSITORY_ROOT,
    )
    assert.equal(bundle.recipe.spec.population.mode, mode)
    assert.equal(bundle.recipe.spec.population.budget.total_budget, 4)
    assert.equal(createBudgetPlan(bundle.recipe.spec.population).totalBudget, 4)
    assert.equal(bundle.recipe.spec.moduleSearch.authority, 'strategy-directed')
    assert.equal(bundle.recipe.spec.moduleSearch.strategy, 'linear-hill-climb')
    assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l1')
    assert.equal(bundle.target.id, 'msa-minimal-cowork-rsi')
    assert.equal(bundle.target.solver.runtime.maximumSteps, 12)
    assert.equal(bundle.target.mutation.semanticChecks.profile.maximums.max_steps, 12)
    assert.equal(
      bundle.target.mutation.semanticChecks.profile.maximums.max_output_tokens,
      bundle.experiment.models.solver.maxTokens,
    )
    assert.equal(bundle.environment.id, 'omegause-officeval')
    assert.equal(bundle.environment.task.maximumConcurrentTrials, 4)
    assert.equal(bundle.environment.docker.resources.timeoutSeconds, 3600)
    assert.ok(
      bundle.environment.task.maximumConcurrentTrials
        <= bundle.environment.modelGateway.maximumConcurrentRequests,
    )
    assert.equal(bundle.benchmark.id, 'cowork-omegause-officeval-linux-v1')
    assert.equal(bundle.benchmark.partitions.feedback.instanceIds.length, 55)
    assert.equal(bundle.benchmark.partitions.selection.instanceIds.length, 18)
    assert.equal(bundle.benchmark.partitions.final.instanceIds.length, 18)
    assert.equal(bundle.benchmark.partitions.final.visibility, 'sealed')
    assert.equal(bundle.policy.id, 'cowork-officeval-rsi-v1')
    assert.equal(bundle.experiment.models.solver.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.updater.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.solver.reasoningEffort, 'high')
    assert.equal(bundle.experiment.models.updater.reasoningEffort, 'high')
  }
})

test('Cowork Smoke 仍保持单步硬上限，不会被正式 RSI 配置放大成本', async () => {
  const bundle = await loadExperimentBundle(
    resolve(REPOSITORY_ROOT, 'experiments/cowork-msa-smoke-single.json'),
    REPOSITORY_ROOT,
  )
  assert.equal(bundle.target.id, 'msa-minimal')
  assert.equal(bundle.target.solver.runtime.maximumSteps, 1)
})
