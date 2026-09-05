import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEvaluationSummary } from '../src/evaluation-summary.mjs'
import { normalizeEvolutionRecipe } from '../src/evolution-recipe.mjs'
import { PopulationOrchestrator } from '../src/population-orchestrator.mjs'

const FINGERPRINT = 'a'.repeat(64)
const DIGEST = 'b'.repeat(64)

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

function loaded(mode, checkpointing = null) {
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
        ...(checkpointing === null ? {} : { checkpointing }),
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
  checkpointing = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'population-generic-'))
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(campaignsRoot)
  const contexts = new Map()
  const calls = new Map()

  const orchestrator = new PopulationOrchestrator({
    loadedCampaign: loaded(mode, checkpointing),
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
            candidateRevision: state.revision,
            candidateDigest: state.digest,
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
  return { state, contexts, calls, campaignsRoot }
}

test('SearchStrategy 耗尽后 Branch 可提前停止并保留未用 Population 预算', async () => {
  const result = await runMode('independent', { stopAfter: 1 })
  assert.equal(result.state.status, 'CLOSED')
  assert.equal(result.state.budget.consumed, 2)
  assert.equal(result.state.budget.totalBudget, 4)
  assert.ok(result.state.branches.every((branch) => branch.status === 'stopped'))
})

test('Population 将 GRHS Group 作为一个 Step 累计完整 sibling Budget 并保存分组 Checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'population-grhs-'))
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(campaignsRoot)
  const recipe = normalizeEvolutionRecipe({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionRecipe',
    spec: {
      population: {
        mode: 'single',
        concurrency: { n_branches: 1 },
        budget: { total_budget: 4, beta: 0 },
        peer_sharing: { enabled: false },
        competition: { enabled: false },
      },
      moduleSearch: {
        authority: 'strategy-directed',
        riskCeiling: 'l3',
        strategy: 'group-relative-harness',
        group: { enabled: true, size: 4 },
      },
      checkpointing: {
        budgetMilestones: [0, 4],
        branchGenerationMilestones: [1],
        capture: { populationBest: true, branchIncumbents: true, latestAttempts: true },
      },
    },
  })
  const h0 = createEvaluationSummary({ candidateId: 'branch-001-h0', metric: 'mean-reward', value: 0.1 })
  const candidate = createEvaluationSummary({ candidateId: 'g001-grhs-s001-l3', metric: 'mean-reward', value: 0.2 })
  const baseline = createEvaluationSummary({ candidateId: 'branch-001-h0', metric: 'mean-reward', value: 0.1 })
  const projection = (steps, lastStep = null) => ({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BranchProjection',
    branchId: 'branch-001',
    status: 'active',
    completedSteps: steps,
    incumbent: {
      candidateId: steps === 0 ? h0.candidateId : candidate.candidateId,
      revision: DIGEST,
      digest: DIGEST,
      evaluation: steps === 0 ? h0 : candidate,
    },
    lastStep,
  })
  let advanced = false
  const orchestrator = new PopulationOrchestrator({
    loadedCampaign: {
      fingerprint: FINGERPRINT,
      config: { apiVersion: 'harness-rsi/v1alpha1', kind: 'EvolutionExperiment', metadata: { id: 'grhs' } },
      recipe,
    },
    campaignsRoot,
    campaignId: 'grhs-population',
    createBranch() {
      return {
        async initialize() { return projection(0) },
        async inspect() {
          if (!advanced) return projection(0)
          return projection(1, {
            stepId: 'epoch-0001-branch-001',
            stepNumber: 1,
            candidateId: candidate.candidateId,
            candidateRevision: DIGEST,
            candidateDigest: DIGEST,
            budgetConsumed: 4,
            groupId: 'generation-0001-grhs',
            groupSize: 4,
            groupCandidateIds: [
              'g001-grhs-s001-l3', 'g001-grhs-s002-l3', 'g001-grhs-s003-l3', 'g001-grhs-s004-l3',
            ],
            decision: 'promoted',
            ranking: { eligible: true, evaluation: candidate, baselineEvaluation: baseline },
            group: {
              groupId: 'generation-0001-grhs',
              groupSize: 4,
              groupCandidateIds: [
                'g001-grhs-s001-l3', 'g001-grhs-s002-l3', 'g001-grhs-s003-l3', 'g001-grhs-s004-l3',
              ],
              winnerCandidateId: candidate.candidateId,
              rollbackReason: null,
              candidates: [
                {
                  id: 'g001-grhs-s001-l3', mutationPlanId: 'plan-001', regionIds: ['reasoning-profile'],
                  valid: true, promotionEligible: true, utility: 0.1, relativeAdvantage: 0,
                },
                {
                  id: 'g001-grhs-s002-l3', mutationPlanId: 'plan-002', regionIds: ['reasoning-profile'],
                  valid: true, promotionEligible: false, utility: 0.1, relativeAdvantage: 0,
                },
                {
                  id: 'g001-grhs-s003-l3', mutationPlanId: 'plan-003', regionIds: ['reasoning-profile'],
                  valid: true, promotionEligible: false, utility: 0.1, relativeAdvantage: 0,
                },
                {
                  id: 'g001-grhs-s004-l3', mutationPlanId: 'plan-004', regionIds: ['reasoning-profile'],
                  valid: true, promotionEligible: false, utility: 0.1, relativeAdvantage: 0,
                },
              ],
              proposalPriorBefore: { 'reasoning-profile': 1 },
              proposalPriorAfter: { 'reasoning-profile': 1 },
            },
          })
        },
        async advanceOne({ stepId }) {
          advanced = true
          return {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'BranchStepResult',
            stepId,
            budgetConsumed: 4,
            projection: await this.inspect(),
          }
        },
        async exportPeerEvidence() { return { sourcePath: join(root, 'evidence.jsonl'), entries: [] } },
        async exportBest() { return { candidateId: candidate.candidateId, revision: DIGEST, digest: DIGEST, evaluation: candidate, changedFiles: [], diffStat: '', patch: '', workspace: root, implementationRoot: root } },
      }
    },
  })
  await orchestrator.initialize()
  const state = await orchestrator.run()
  assert.equal(state.status, 'CLOSED')
  assert.equal(state.budget.consumed, 4)
  assert.equal(state.branches[0].consumed, 4)
  assert.equal(state.checkpoints.length, 2)
  const branchCheckpoint = JSON.parse(await readFile(join(
    campaignsRoot,
    'grhs-population',
    state.branchCheckpoints[0].path,
  ), 'utf8'))
  assert.equal(branchCheckpoint.latestAttempt.groupSize, 4)
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

test('Population 跨过 Budget 里程碑时保留 Champion、Branch Incumbent 和当轮 Candidate 身份', async () => {
  const result = await runMode('independent', {
    checkpointing: {
      budgetMilestones: [0, 1, 2, 3, 4],
      capture: {
        populationBest: true,
        branchIncumbents: true,
        latestAttempts: true,
      },
    },
  })
  assert.deepEqual(
    result.state.checkpoints.map(({ requestedBudget, actualConsumedBudget }) => ({
      requestedBudget,
      actualConsumedBudget,
    })),
    [
      { requestedBudget: 0, actualConsumedBudget: 0 },
      { requestedBudget: 1, actualConsumedBudget: 2 },
      { requestedBudget: 2, actualConsumedBudget: 2 },
      { requestedBudget: 3, actualConsumedBudget: 4 },
      { requestedBudget: 4, actualConsumedBudget: 4 },
    ],
  )

  const checkpointPath = join(
    result.campaignsRoot,
    'generic-independent',
    'public',
    'checkpoints',
    'budget-0001.json',
  )
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  assert.equal((await stat(checkpointPath)).mode & 0o777, 0o400)
  assert.equal(checkpoint.kind, 'PopulationBudgetCheckpoint')
  assert.equal(checkpoint.requestedBudget, 1)
  assert.equal(checkpoint.actualConsumedBudget, 2)
  assert.equal(
    checkpoint.capturedAt,
    result.state.events.find((entry) => (
      entry.type === 'POPULATION_WAVE_COMPLETED' && entry.epoch === 1
    )).at,
  )
  assert.equal(checkpoint.populationBest.candidateId, 'branch-002-c1')
  assert.deepEqual(
    checkpoint.branchIncumbents.map((entry) => entry.incumbent.candidateId),
    ['branch-001-c1', 'branch-002-c1'],
  )
  assert.deepEqual(
    checkpoint.latestAttempts.map((entry) => ({
      candidateId: entry.step.candidateId,
      candidateRevision: entry.step.candidateRevision,
      candidateDigest: entry.step.candidateDigest,
    })),
    ['branch-001', 'branch-002'].map((branchId) => ({
      candidateId: `${branchId}-c1`,
      candidateRevision: digest(`${branchId}-c1-revision`),
      candidateDigest: digest(`${branchId}-c1`),
    })),
  )
})

test('Population 按每个 Branch 的实际代数保存独立 Checkpoint', async () => {
  const result = await runMode('independent', {
    checkpointing: {
      budgetMilestones: [0, 4],
      branchGenerationMilestones: [1, 2],
      capture: {
        populationBest: true,
        branchIncumbents: true,
        latestAttempts: true,
      },
    },
  })
  assert.deepEqual(
    result.state.branchCheckpoints.map((entry) => [
      entry.branchId,
      entry.requestedGeneration,
      entry.actualCompletedSteps,
    ]),
    [
      ['branch-001', 1, 1],
      ['branch-002', 1, 1],
      ['branch-001', 2, 2],
      ['branch-002', 2, 2],
    ],
  )
  const checkpointPath = join(
    result.campaignsRoot,
    'generic-independent',
    'public',
    'checkpoints',
    'branches',
    'branch-001',
    'generation-0002.json',
  )
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  assert.equal((await stat(checkpointPath)).mode & 0o777, 0o400)
  assert.equal(checkpoint.kind, 'BranchGenerationCheckpoint')
  assert.equal(checkpoint.requestedGeneration, 2)
  assert.equal(checkpoint.actualCompletedSteps, 2)
  assert.equal(checkpoint.actualConsumedBudget, 2)
  assert.equal(checkpoint.latestAttempt.stepNumber, 2)
})

test('Checkpoint 文件落盘后进程中断，可从稳定 Population 状态幂等补全总账', async () => {
  const root = await mkdtemp(join(tmpdir(), 'population-checkpoint-crash-'))
  const campaignsRoot = join(root, 'campaigns')
  const campaignId = 'generic-checkpoint-crash'
  await mkdir(campaignsRoot)
  let branchState = null
  let restored = 0

  function createBranch({ branchId, branchesRoot }) {
    return {
      async initialize() {
        const candidateId = `${branchId}-h0`
        branchState = {
          status: 'active',
          steps: 0,
          candidateId,
          revision: digest(`${candidateId}-revision`),
          digest: digest(candidateId),
          evaluation: createEvaluationSummary({
            candidateId,
            metric: 'mean-reward',
            value: 0,
          }),
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
          candidateRevision: digest(`${candidateId}-revision`),
          candidateDigest: digest(candidateId),
          decision: 'promoted',
          ranking: { eligible: true, evaluation },
        }
        branchState = {
          status: 'active',
          steps: 1,
          candidateId,
          revision: lastStep.candidateRevision,
          digest: lastStep.candidateDigest,
          evaluation,
          lastStep,
        }
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
          entries: [],
        }
      },
      async exportBest() {
        return {
          candidateId: branchState.candidateId,
          revision: branchState.revision,
          digest: branchState.digest,
          evaluation: branchState.evaluation,
          changedFiles: ['profiles/cowork.md'],
          diffStat: 'profiles/cowork.md | 1 +',
          patch: '+checkpoint recovery\n',
          workspace: join(branchesRoot, branchId, 'workspace'),
          implementationRoot: join(branchesRoot, branchId),
        }
      },
    }
  }

  const checkpointing = {
    budgetMilestones: [1],
    capture: {
      populationBest: true,
      branchIncumbents: true,
      latestAttempts: true,
    },
  }
  const first = new PopulationOrchestrator({
    loadedCampaign: loaded('single', checkpointing),
    campaignsRoot,
    campaignId,
    createBranch,
  })
  await first.initialize()

  let checkpointLinked = false
  const writeBudgetCheckpoint = first.store.writeBudgetCheckpoint.bind(first.store)
  first.store.writeBudgetCheckpoint = async (...args) => {
    const result = await writeBudgetCheckpoint(...args)
    checkpointLinked = true
    return result
  }
  const saveState = first.store.saveState.bind(first.store)
  first.store.saveState = async (...args) => {
    if (checkpointLinked) throw new Error('fixture hard crash after checkpoint link')
    return await saveState(...args)
  }

  await assert.rejects(
    () => first.run(),
    /fixture hard crash after checkpoint link/u,
  )
  const interrupted = await first.store.readState()
  assert.equal(interrupted.status, 'EVOLVING')
  assert.equal(interrupted.inFlightWave, undefined)
  assert.equal(interrupted.budget.consumed, 1)
  assert.deepEqual(interrupted.checkpoints, [])

  const checkpointPath = join(
    campaignsRoot,
    campaignId,
    'public',
    'checkpoints',
    'budget-0001.json',
  )
  const checkpointBeforeResume = await readFile(checkpointPath, 'utf8')

  const second = new PopulationOrchestrator({
    loadedCampaign: loaded('single', checkpointing),
    campaignsRoot,
    campaignId,
    createBranch,
  })
  const completed = await second.resume()
  assert.equal(restored, 1)
  assert.equal(completed.status, 'CLOSED')
  assert.deepEqual(
    completed.checkpoints.map(({ requestedBudget, actualConsumedBudget }) => ({
      requestedBudget,
      actualConsumedBudget,
    })),
    [{ requestedBudget: 1, actualConsumedBudget: 1 }],
  )
  assert.equal(await readFile(checkpointPath, 'utf8'), checkpointBeforeResume)
  assert.equal(completed.events.some((entry) => (
    entry.type === 'POPULATION_STABLE_STATE_RECOVERED'
      && entry.phase === 'checkpoint-commit-boundary'
  )), true)
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

test('Population 可从 Baseline 阶段暂停恢复，再固化 Branch Incumbent 并进入首轮进化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'population-baseline-resume-'))
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(campaignsRoot)
  const candidateId = 'branch-001-h0'
  let failBaseline = true
  let restored = 0
  let branchState = {
    status: 'active',
    steps: 0,
    candidateId,
    revision: digest(`${candidateId}-revision`),
    digest: digest(candidateId),
    evaluation: createEvaluationSummary({
      candidateId,
      metric: 'mean-reward',
      value: 0.25,
    }),
  }

  function createBranch({ branchId, branchesRoot }) {
    return {
      async initialize() {
        if (failBaseline) throw new Error('fixture baseline provider unavailable')
        return projection(branchId, branchState)
      },
      async restore() {
        restored += 1
        return projection(branchId, branchState)
      },
      async inspect() {
        return projection(branchId, branchState)
      },
      async advanceOne({ stepId }) {
        const nextId = `${branchId}-c1`
        const evaluation = createEvaluationSummary({
          candidateId: nextId,
          metric: 'mean-reward',
          value: 0.5,
        })
        const lastStep = {
          stepId,
          stepNumber: 1,
          candidateId: nextId,
          decision: 'promoted',
          ranking: { eligible: true, evaluation },
        }
        branchState = {
          status: 'active',
          steps: 1,
          candidateId: nextId,
          revision: digest(`${nextId}-revision`),
          digest: digest(nextId),
          evaluation,
        }
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
          entries: [],
        }
      },
      async exportBest() {
        return {
          candidateId: branchState.candidateId,
          revision: branchState.revision,
          digest: branchState.digest,
          evaluation: branchState.evaluation,
          changedFiles: ['profiles/cowork.md'],
          diffStat: 'profiles/cowork.md | 1 +',
          patch: '+baseline resume\n',
          workspace: join(branchesRoot, branchId, 'workspace'),
          implementationRoot: join(branchesRoot, branchId),
        }
      },
    }
  }

  const first = new PopulationOrchestrator({
    loadedCampaign: loaded('single'),
    campaignsRoot,
    campaignId: 'generic-baseline-resume',
    createBranch,
  })
  const paused = await first.initialize()
  assert.equal(paused.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(paused.events.at(-1).phase, 'baseline')
  assert.equal(paused.branches[0].incumbent, null)

  failBaseline = false
  const second = new PopulationOrchestrator({
    loadedCampaign: loaded('single'),
    campaignsRoot,
    campaignId: 'generic-baseline-resume',
    createBranch,
  })
  const completed = await second.resume()
  assert.equal(restored, 1)
  assert.equal(completed.status, 'CLOSED')
  assert.equal(completed.budget.consumed, 1)
  assert.equal(completed.events.some((event) => (
    event.type === 'POPULATION_BASELINE_EVALUATED' && event.recovered === true
  )), true)
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
