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

test('Cowork L1+L2 单轮 Probe 使用正式题集并只产生一个 Candidate', async () => {
  const bundle = await loadExperimentBundle(
    resolve(REPOSITORY_ROOT, 'experiments/cowork-msa-rsi-linear-single-l2-one-generation.json'),
    REPOSITORY_ROOT,
  )
  assert.equal(bundle.recipe.spec.population.mode, 'single')
  assert.equal(bundle.recipe.spec.population.budget.total_budget, 1)
  assert.equal(bundle.recipe.spec.moduleSearch.strategy, 'linear-hill-climb')
  assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l2')
  assert.equal(bundle.experiment.evolution.mutationLevel, 'l2')
  assert.equal(bundle.experiment.evolution.generations, 1)
  assert.equal(bundle.target.id, 'msa-minimal-cowork-rsi')
  assert.deepEqual(
    bundle.target.mutation.catalog.regions
      .filter((region) => ['l1', 'l2'].includes(region.riskLevel))
      .map((region) => region.id),
    ['profile-policy', 'skill-guidance', 'agent-loop', 'tool-runtime'],
  )
  assert.ok(bundle.target.mutation.levels.l2.writable.includes('agent.py'))
  assert.ok(bundle.target.mutation.levels.l2.writable.includes('tools.py'))
  assert.equal(bundle.benchmark.partitions.feedback.instanceIds.length, 55)
  assert.equal(bundle.benchmark.partitions.selection.instanceIds.length, 18)
  assert.equal(bundle.benchmark.partitions.final.instanceIds.length, 18)
  assert.equal(bundle.experiment.models.solver.reasoningEffort, 'high')
  assert.equal(bundle.experiment.models.updater.reasoningEffort, 'high')
})

test('正式 Codex 五 Mode 使用 32 总预算、双 Branch 和受控跨 Mode 并发', async () => {
  for (const mode of MODES) {
    const bundle = await loadExperimentBundle(
      resolve(REPOSITORY_ROOT, `experiments/cowork-msa-rsi-formal32-codex-${mode}.json`),
      REPOSITORY_ROOT,
    )
    const population = bundle.recipe.spec.population
    assert.equal(population.mode, mode)
    assert.equal(population.concurrency.n_branches, mode === 'single' ? 1 : 2)
    assert.equal(population.budget.total_budget, 32)
    assert.equal(createBudgetPlan(population).totalBudget, 32)
    assert.equal(population.budget.beta, ['competition', 'combined'].includes(mode) ? 0.5 : 0)
    assert.equal(bundle.recipe.spec.moduleSearch.authority, 'strategy-directed')
    assert.equal(bundle.recipe.spec.moduleSearch.strategy, 'linear-hill-climb')
    assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l2')
    assert.equal(bundle.experiment.evolution.mutationLevel, 'l2')
    assert.equal(bundle.experiment.evolution.generations, 32)
    assert.equal(bundle.updater.id, 'codex-cli')
    assert.equal(bundle.updater.protocol, 'codex-exec-v1')
    assert.equal(bundle.target.id, 'msa-minimal-cowork-rsi')
    assert.equal(bundle.environment.id, 'omegause-officeval')
    assert.equal(bundle.environment.task.maximumConcurrentTrials, 2)
    assert.equal(bundle.experiment.models.solver.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.updater.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.solver.reasoningEffort, 'high')
    assert.equal(bundle.experiment.models.updater.reasoningEffort, 'high')
    assert.equal(bundle.experiment.evolution.trialsPerInstance, 1)
    assert.deepEqual(bundle.experiment.evolution.seeds, [20260827])
    assert.equal(bundle.benchmark.partitions.feedback.instanceIds.length, 55)
    assert.equal(bundle.benchmark.partitions.selection.instanceIds.length, 18)
    assert.equal(bundle.benchmark.partitions.final.instanceIds.length, 18)
    assert.equal(bundle.benchmark.partitions.final.visibility, 'sealed')
  }
})

test('筛选五 Mode 共用固定 12/8 题集、4 总预算和 12 步 Solver', async () => {
  const expectedFeedback = [
    'officeval_003', 'officeval_007', 'officeval_017', 'officeval_032',
    'officeval_041', 'officeval_042', 'officeval_068', 'officeval_073',
    'officeval_082', 'officeval_086', 'officeval_090', 'officeval_095',
  ]
  const expectedSelection = [
    'officeval_002', 'officeval_034', 'officeval_040', 'officeval_058',
    'officeval_062', 'officeval_076', 'officeval_087', 'officeval_100',
  ]
  for (const mode of MODES) {
    const bundle = await loadExperimentBundle(
      resolve(REPOSITORY_ROOT, `experiments/cowork-msa-rsi-pilot4-codex-${mode}.json`),
      REPOSITORY_ROOT,
    )
    const population = bundle.recipe.spec.population
    assert.equal(population.mode, mode)
    assert.equal(population.concurrency.n_branches, mode === 'single' ? 1 : 2)
    assert.equal(population.budget.total_budget, 4)
    assert.equal(createBudgetPlan(population).totalBudget, 4)
    assert.equal(population.budget.beta, ['competition', 'combined'].includes(mode) ? 0.5 : 0)
    assert.equal(bundle.recipe.spec.moduleSearch.strategy, 'linear-hill-climb')
    assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l2')
    assert.equal(bundle.experiment.evolution.generations, 4)
    assert.equal(bundle.target.solver.runtime.maximumSteps, 12)
    assert.equal(bundle.updater.id, 'codex-cli')
    assert.equal(bundle.experiment.models.solver.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.updater.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.solver.reasoningEffort, 'high')
    assert.equal(bundle.experiment.models.updater.reasoningEffort, 'high')
    assert.equal(bundle.benchmark.id, 'cowork-omegause-officeval-pilot-v1')
    assert.deepEqual(bundle.benchmark.partitions.feedback.instanceIds, expectedFeedback)
    assert.deepEqual(bundle.benchmark.partitions.selection.instanceIds, expectedSelection)
    assert.equal(bundle.benchmark.partitions.final.instanceIds.length, 18)
    assert.equal(bundle.benchmark.partitions.final.visibility, 'sealed')
  }
})
