import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEvaluationSummary } from '../src/evaluation-summary.mjs'
import { normalizeEvolutionRecipe } from '../src/evolution-recipe.mjs'
import { PopulationOrchestrator } from '../src/population-orchestrator.mjs'

const FINGERPRINT = 'a'.repeat(64)

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function population(mode) {
  const sharing = ['mutualism', 'combined'].includes(mode)
  const competition = ['competition', 'combined'].includes(mode)
  return {
    mode,
    concurrency: { n_branches: mode === 'single' ? 1 : 2 },
    budget: {
      total_budget: mode === 'single' ? 1 : 4,
      beta: competition ? 0.5 : 0,
    },
    peer_sharing: { enabled: sharing },
    competition: { enabled: competition, bonus_grant_unit: 1 },
  }
}

function loaded(mode) {
  return {
    fingerprint: FINGERPRINT,
    config: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionExperiment',
      metadata: { id: `generic-${mode}` },
    },
    recipe: normalizeEvolutionRecipe({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionRecipe',
      spec: {
        population: population(mode),
        moduleSearch: {
          authority: 'updater-directed',
          riskCeiling: 'l1',
          strategy: null,
        },
      },
    }),
  }
}

function projection(branchId, state, lastStep = null) {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BranchProjection',
    branchId,
    status: state.status ?? 'active',
    completedSteps: state.steps,
    incumbent: {
      candidateId: state.candidateId,
      revision: state.revision,
      digest: state.digest,
      evaluation: state.evaluation,
    },
    lastStep,
  }
}

async function runMode(mode, {
  failAdvance = false,
  stopAfter = null,
  initialValues = {},
  candidateValues = {},
  pairedBaselineValues = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'population-generic-'))
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(campaignsRoot)
  const contexts = new Map()
  const calls = new Map()

  const orchestrator = new PopulationOrchestrator({
    loadedCampaign: loaded(mode),
    campaignsRoot,
    campaignId: `generic-${mode}`,
    createBranch({ branchId, branchesRoot }) {
      let state = null
      const history = []
      contexts.set(branchId, [])
      calls.set(branchId, 0)
      return {
        async initialize() {
          const candidateId = `${branchId}-h0`
          state = {
            status: 'active',
            steps: 0,
            candidateId,
            revision: digest(`${branchId}-h0-revision`),
            digest: digest(`${branchId}-h0`),
            evaluation: createEvaluationSummary({
              candidateId,
              metric: 'mean-reward',
              value: initialValues[branchId] ?? 0,
            }),
          }
          return projection(branchId, state)
        },
        async inspect() {
          return projection(branchId, state, history.at(-1)?.lastStep ?? null)
        },
        async advanceOne({ stepId, coordination }) {
          if (failAdvance) throw new Error('fixture provider unavailable')
          const next = calls.get(branchId) + 1
          calls.set(branchId, next)
          contexts.get(branchId).push(structuredClone(coordination))
          const previous = state
          const candidateId = `${branchId}-c${next}`
          const value = candidateValues[branchId]?.[next - 1]
            ?? next + (branchId === 'branch-002' ? 0.5 : 0)
          state = {
            status: stopAfter === next ? 'stopped' : 'active',
            steps: next,
            candidateId,
            revision: digest(`${candidateId}-revision`),
            digest: digest(candidateId),
            evaluation: createEvaluationSummary({
              candidateId,
              metric: 'mean-reward',
              value,
            }),
          }
          const lastStep = {
            stepId,
            stepNumber: next,
            candidateId,
            decision: 'promoted',
            ranking: {
              eligible: true,
              evaluation: state.evaluation,
              ...(pairedBaselineValues[branchId]?.[next - 1] === undefined
                ? {}
                : {
                    baselineEvaluation: createEvaluationSummary({
                      candidateId: previous.candidateId,
                      metric: 'mean-reward',
                      value: pairedBaselineValues[branchId][next - 1],
                    }),
                  }),
            },
          }
          history.push({ generation: next, candidateId, value, lastStep })
          return {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'BranchStepResult',
            stepId,
            budgetConsumed: 1,
            projection: projection(branchId, state, lastStep),
          }
        },
        async exportPeerEvidence() {
          return {
            sourcePath: join(branchesRoot, branchId, 'public', 'evolution-log.jsonl'),
            entries: history.map(({ lastStep, ...entry }) => entry),
          }
        },
        async exportBest() {
          return {
            candidateId: state.candidateId,
            revision: state.revision,
            digest: state.digest,
            evaluation: state.evaluation,
            changedFiles: ['profiles/cowork.md'],
            diffStat: 'profiles/cowork.md | 1 +',
            patch: '+generic cowork candidate\n',
            workspace: join(branchesRoot, branchId, 'workspace'),
            implementationRoot: join(branchesRoot, branchId),
          }
        },
      }
    },
  })

  await orchestrator.initialize()
  const state = await orchestrator.run()
  return { state, contexts, calls }
}

test('SearchStrategy 耗尽后 Branch 可提前停止并保留未用 Population 预算', async () => {
  const result = await runMode('independent', { stopAfter: 1 })
  assert.equal(result.state.status, 'CLOSED')
  assert.equal(result.state.budget.consumed, 2)
  assert.equal(result.state.budget.totalBudget, 4)
  assert.ok(result.state.branches.every((branch) => branch.status === 'stopped'))
})

test('Branch 基础设施异常会暂停 Population，不能伪装成 0 分后关闭', async () => {
  const result = await runMode('single', { failAdvance: true })
  assert.equal(result.state.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(result.state.budget.consumed, 0)
  const paused = result.state.events.at(-1)
  assert.equal(paused.type, 'POPULATION_INFRASTRUCTURE_PAUSED')
  assert.equal(paused.failures[0].branchId, 'branch-001')
  assert.match(paused.failures[0].message, /provider unavailable/u)
})

test('Population 使用 Branch 同期配对基线计算增量与 Competition 预算', async () => {
  const result = await runMode('competition', {
    initialValues: { 'branch-001': 10, 'branch-002': 10 },
    candidateValues: {
      'branch-001': [9, 9, 9],
      'branch-002': [11, 11, 11],
    },
    pairedBaselineValues: {
      'branch-001': [8, 9, 9],
      'branch-002': [10.5, 11, 11],
    },
  })
  const firstWave = result.state.events.find((event) => (
    event.type === 'POPULATION_WAVE_COMPLETED' && event.epoch === 1
  ))
  assert.equal(firstWave.bonusWinner, 'branch-001')
  assert.deepEqual(
    firstWave.results.map(({ branchId, validationScore, deltaScore }) => ({
      branchId, validationScore, deltaScore,
    })),
    [
      { branchId: 'branch-001', validationScore: 9, deltaScore: 1 },
      { branchId: 'branch-002', validationScore: 11, deltaScore: 0.5 },
    ],
  )
})

test('Population 跨进程恢复会先重载 Branch，再幂等继续 in-flight wave', async () => {
  const root = await mkdtemp(join(tmpdir(), 'population-resume-'))
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(campaignsRoot)
  let branchState = null
  let fail = true
  let restored = 0

  function createBranch({ branchId, branchesRoot }) {
    const history = []
    return {
      async initialize() {
        const candidateId = `${branchId}-h0`
        branchState = {
          status: 'active',
          steps: 0,
          candidateId,
          revision: digest(`${candidateId}-revision`),
          digest: digest(candidateId),
          evaluation: createEvaluationSummary({ candidateId, metric: 'mean-reward', value: 0 }),
          lastStep: null,
        }
        return projection(branchId, branchState)
      },
      async restore() {
        restored += 1
        return projection(branchId, branchState, branchState.lastStep)
      },
      async inspect() {
        return projection(branchId, branchState, branchState.lastStep)
      },
      async advanceOne({ stepId }) {
        if (fail) throw new Error('fixture provider unavailable')
        const candidateId = `${branchId}-c1`
        const evaluation = createEvaluationSummary({
          candidateId,
          metric: 'mean-reward',
          value: 1,
        })
        const lastStep = {
          stepId,
          stepNumber: 1,
          candidateId,
          decision: 'promoted',
          ranking: { eligible: true, evaluation },
        }
        branchState = {
          status: 'active',
          steps: 1,
          candidateId,
          revision: digest(`${candidateId}-revision`),
          digest: digest(candidateId),
          evaluation,
          lastStep,
        }
        history.push({ generation: 1, candidateId })
        return {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'BranchStepResult',
          stepId,
          budgetConsumed: 1,
          projection: projection(branchId, branchState, lastStep),
        }
      },
      async exportPeerEvidence() {
        return {
          sourcePath: join(branchesRoot, branchId, 'public', 'evolution-log.jsonl'),
          entries: history,
        }
      },
      async exportBest() {
        return {
          candidateId: branchState.candidateId,
          revision: branchState.revision,
          digest: branchState.digest,
          evaluation: branchState.evaluation,
          changedFiles: ['profiles/cowork.md'],
          diffStat: 'profiles/cowork.md | modified',
          patch: '+restored\n',
          workspace: join(branchesRoot, branchId, 'workspace'),
          implementationRoot: join(branchesRoot, branchId),
        }
      },
    }
  }

  const first = new PopulationOrchestrator({
    loadedCampaign: loaded('single'),
    campaignsRoot,
    campaignId: 'generic-resume',
    createBranch,
  })
  await first.initialize()
  const paused = await first.run()
  assert.equal(paused.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(paused.budget.consumed, 0)

  fail = false
  const second = new PopulationOrchestrator({
    loadedCampaign: loaded('single'),
    campaignsRoot,
    campaignId: 'generic-resume',
    createBranch,
  })
  const completed = await second.resume()
  assert.equal(restored, 1)
  assert.equal(completed.status, 'CLOSED')
  assert.equal(completed.budget.consumed, 1)
  assert.equal(completed.events.filter((event) => (
    event.type === 'POPULATION_INFRASTRUCTURE_RESUMED'
  )).length, 1)
})

for (const mode of ['single', 'independent', 'mutualism', 'competition', 'combined']) {
  test(`通用 mean-reward Branch Driver 可运行 ${mode} Mode`, async () => {
    const result = await runMode(mode)
    assert.equal(result.state.status, 'CLOSED')
    assert.equal(result.state.best.primaryMetric, 'mean-reward')
    assert.equal(result.state.budget.consumed, population(mode).budget.total_budget)
    if (['mutualism', 'combined'].includes(mode)) {
      assert.equal(result.contexts.get('branch-001')[0].peerLogs.length, 0)
      assert.ok([...result.contexts.values()].some((values) => (
        values.slice(1).some((value) => value.peerLogs.length === 1)
      )))
    }
    if (['competition', 'combined'].includes(mode)) {
      assert.equal(result.state.budget.bonusRemaining, 0)
      assert.ok(result.state.branches.some((branch) => branch.bonusBudget > 0))
    }
  })
}
