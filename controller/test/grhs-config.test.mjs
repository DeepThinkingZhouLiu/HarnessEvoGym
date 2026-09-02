import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadExperimentBundle, validateExperiment } from '../src/adapters.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const experimentPath = join(repositoryRoot, 'experiments/cowork-msa-grhs-smoke-codex.json')

test('GRHS OfficeVal smoke 固定 MSA Solver、Codex Updater 与 Terra High', async () => {
  const bundle = await loadExperimentBundle(experimentPath, repositoryRoot)
  assert.equal(bundle.target.id, 'msa-minimal-cowork-rsi')
  assert.equal(bundle.updater.id, 'codex-cli')
  assert.equal(bundle.environment.docker.backend, 'agentbay')
  assert.equal(bundle.environment.docker.agentBay.imageIdEnvironment, 'HARNESS_RSI_AGENTBAY_IMAGE_ID')
  assert.equal(bundle.environment.task.maximumConcurrentTrials, 55)
  assert.equal(bundle.environment.modelGateway.maximumConcurrentRequests, 64)
  assert.equal(bundle.environment.modelGateway.maximumRequestsPerRun, 100000)
  assert.equal(bundle.target.solver.runtime.maximumSteps, 0)
  assert.equal(bundle.experiment.models.solver.model, 'gpt-5.6-terra')
  assert.equal(bundle.experiment.models.solver.reasoningEffort, 'high')
  assert.equal(bundle.experiment.models.updater.model, 'gpt-5.6-terra')
  assert.equal(bundle.experiment.models.updater.reasoningEffort, 'high')
  assert.equal(bundle.experiment.evolution.grhs.groupSize, 2)
  assert.equal(bundle.experiment.evolution.generations, 1)
  assert.equal(bundle.experiment.recipePath, null)
  assert.equal(bundle.benchmark.partitions.feedback.instanceIds.length, 1)
  assert.equal(bundle.benchmark.partitions.selection.instanceIds.length, 1)
  assert.equal(bundle.benchmark.partitions.final.visibility, 'sealed')
})

test('GRHS groupSize 小于 2 时 Experiment fail closed', async () => {
  const raw = JSON.parse(await readFile(experimentPath, 'utf8'))
  raw.metadata = { id: 'invalid-grhs' }
  raw.spec.evolution.grhs.groupSize = 1
  assert.throws(() => validateExperiment(raw), /grhs\.groupSize/u)
})

test('GRHS 不允许被 Population Recipe 或单 Plan Strategy 静默覆盖', async () => {
  const raw = JSON.parse(await readFile(experimentPath, 'utf8'))
  const temporaryRoot = join(repositoryRoot, '.rsi', 'test-configs')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'grhs-'))
  try {
    raw.spec.recipe = 'recipes/population-smoke/single.yml'
    const recipeConflict = join(directory, 'recipe-conflict.json')
    await writeFile(recipeConflict, JSON.stringify(raw))
    await assert.rejects(
      loadExperimentBundle(recipeConflict, repositoryRoot),
      /不能与 Population EvolutionRecipe 同时启用/u,
    )

    delete raw.spec.recipe
    raw.spec.adapters.strategy = 'adapters/strategies/linear-hill-climb.yml'
    const strategyConflict = join(directory, 'strategy-conflict.json')
    await writeFile(strategyConflict, JSON.stringify(raw))
    await assert.rejects(
      loadExperimentBundle(strategyConflict, repositoryRoot),
      /不能同时指定单 Plan SearchStrategy/u,
    )
  } finally {
    await rm(directory, { recursive: true })
  }
})
