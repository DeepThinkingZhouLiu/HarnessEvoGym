import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadExperimentBundle } from '../src/adapters.mjs'
import { validateBenchmark } from '../src/protocol.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const modes = ['single', 'independent', 'mutualism', 'competition', 'combined']
const expected = {
  single: { branches: 1, budget: 1, peer: false, competition: false },
  independent: { branches: 2, budget: 2, peer: false, competition: false },
  mutualism: { branches: 2, budget: 3, peer: true, competition: false },
  competition: { branches: 2, budget: 3, peer: false, competition: true },
  combined: { branches: 2, budget: 3, peer: true, competition: true },
}

async function benchmark(path) {
  return validateBenchmark(JSON.parse(await readFile(join(repositoryRoot, path), 'utf8')))
}

test('Cowork MVP 只执行一道 Feedback 和一道 Selection，不消耗正式 Validation/Final', async () => {
  const [mvp, formal] = await Promise.all([
    benchmark('benchmarks/cowork-omegause-officeval-mvp-v1/benchmark.json'),
    benchmark('benchmarks/cowork-omegause-officeval-linux-v1/benchmark.json'),
  ])
  assert.deepEqual(mvp.partitions.feedback.instanceIds, ['officeval_060'])
  assert.deepEqual(mvp.partitions.selection.instanceIds, ['officeval_003'])
  assert.deepEqual(mvp.partitions.final.instanceIds, ['officeval_090'])
  const formalFeedback = new Set(formal.partitions.feedback.instanceIds)
  assert.ok([...mvp.allInstanceIds].every((id) => formalFeedback.has(id)))
})

for (const mode of modes) {
  test(`Cowork MVP ${mode} 固定 MSA + Codex + Terra High + L2 线性搜索`, async () => {
    const bundle = await loadExperimentBundle(
      join(repositoryRoot, 'experiments', `cowork-msa-mvp-codex-${mode}.json`),
      repositoryRoot,
    )
    assert.equal(bundle.target.id, 'msa-minimal')
    assert.equal(bundle.target.solver.runtime.maximumSteps, 1)
    assert.equal(bundle.updater.id, 'codex-cli')
    assert.equal(bundle.experiment.models.solver.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.solver.reasoningEffort, 'high')
    assert.equal(bundle.experiment.models.updater.model, 'gpt-5.6-terra')
    assert.equal(bundle.experiment.models.updater.reasoningEffort, 'high')
    assert.equal(bundle.recipe.spec.population.mode, mode)
    assert.equal(bundle.recipe.spec.population.concurrency.n_branches, expected[mode].branches)
    assert.equal(bundle.recipe.spec.population.budget.total_budget, expected[mode].budget)
    assert.equal(bundle.recipe.spec.population.peer_sharing.enabled, expected[mode].peer)
    assert.equal(bundle.recipe.spec.population.competition.enabled, expected[mode].competition)
    assert.equal(bundle.recipe.spec.moduleSearch.riskCeiling, 'l2')
    assert.equal(bundle.recipe.spec.moduleSearch.strategy, 'linear-hill-climb')
    assert.equal(bundle.benchmark.partitions.feedback.instanceIds.length, 1)
    assert.equal(bundle.benchmark.partitions.selection.instanceIds.length, 1)
  })
}
