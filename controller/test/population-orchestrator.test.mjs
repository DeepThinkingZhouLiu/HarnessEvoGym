import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PopulationOrchestrator } from '../src/population-orchestrator.mjs'

const FINGERPRINT = 'a'.repeat(64)
const REVISION = 'b'.repeat(40)
const DIGEST = 'c'.repeat(64)

function controllerConfig(mode, {
  branches = mode === 'single' ? 1 : 2,
  total = 4,
  beta = 0.5,
} = {}) {
  const sharing = ['mutualism', 'combined'].includes(mode)
  const competition = ['competition', 'combined'].includes(mode)
  return {
    mode,
    concurrency: { n_branches: branches },
    budget: { total_budget: total, beta },
    peer_sharing: {
      enabled: sharing,
      log_path_template: '- {peer_id}: {log_path}',
      inject_position: 'prompt_suffix',
    },
    competition: {
      enabled: competition,
      bonus_grant_unit: 1,
      scoring_metric: 'delta_score',
    },
  }
}

function loaded(mode, options) {
  return {
    fingerprint: FINGERPRINT,
    config: {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvolutionCampaign',
      metadata: { id: 'population-test', name: 'population test' },
      controller_config: controllerConfig(mode, options),
      spec: {
        source: { format: 'hle-text-math' },
        solver: { targetRevision: REVISION },
      },
    },
    manifests: { validation: ['hle_000000000000000000000000'] },
  }
}

async function fixture(mode, {
  branches = mode === 'single' ? 1 : 2,
  total = 4,
  beta = 0.5,
  scores = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'population-orchestrator-'))
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(campaignsRoot)
  let active = 0
  let maximumActive = 0
  const branchesById = new Map()
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))

  function createBranch({ branchId, branchesRoot }) {
    const sequence = scores[branchId] ?? [2, 2, 2, 2, 2, 2, 2, 2]
    const contexts = []
    const mutations = []
    let currentContext = null
    let calls = 0
    let state = null
    const store = {
      evolutionLogPath: join(branchesRoot, branchId, 'public', 'evolution-log.jsonl'),
      async readState() { return structuredClone(state) },
      async readEvolutionLog() { return structuredClone(mutations) },
    }
    const orchestrator = {
      store,
      workspace: join(branchesRoot, branchId, 'candidates', 'baseline', 'workspace'),
      linearGit: {
        gitRoot: join(branchesRoot, branchId, 'private', 'linear-git.git'),
        async implementation(baseCommit, commit) {
          return {
            baseCommit,
            commit,
            tree: 'd'.repeat(40),
            digest: DIGEST,
            changedFiles: commit === REVISION ? [] : ['agent.py'],
            diffStat: commit === REVISION ? '' : 'agent.py | 1 +',
            patch: commit === REVISION ? '' : `diff --git a/agent.py b/agent.py\n+${branchId}\n`,
          }
        },
      },
      async initialize() {
        state = {
          status: 'BASELINE_FROZEN',
          candidates: [],
          incumbent: {
            candidateId: 'baseline', digest: DIGEST, commit: REVISION,
            validationVerified: null, validationTotal: 10,
          },
        }
        return structuredClone(state)
      },
      async run({ baselineOnly = false } = {}) {
        if (state.status === 'BASELINE_FROZEN') {
          state = {
            ...state,
            status: 'EVOLVING',
            incumbent: { ...state.incumbent, validationVerified: 1 },
            candidates: [{
              candidateId: 'baseline', validationVerified: 1,
              validationTotal: 10, decision: 'baseline', commit: REVISION,
            }],
          }
          if (baselineOnly) return structuredClone(state)
        }
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        try {
          const score = sequence[calls] ?? state.incumbent.validationVerified
          calls += 1
          contexts.push(currentContext)
          const candidateId = `c${String(calls).padStart(4, '0')}`
          const promoted = score > state.incumbent.validationVerified
          const commit = promoted ? `${String(calls).padStart(40, '0')}` : REVISION
          const candidate = {
            candidateId,
            validationVerified: score,
            validationTotal: 10,
            decision: promoted ? 'promoted' : 'rejected',
            commit,
          }
          mutations.push({
            candidateId,
            incumbentScore: state.incumbent.validationVerified,
            validationScore: score,
            delta: score - state.incumbent.validationVerified,
            decision: candidate.decision,
          })
          state = {
            ...state,
            candidates: [...state.candidates, candidate],
            incumbent: promoted
              ? {
                  candidateId, digest: DIGEST, commit,
                  validationVerified: score, validationTotal: 10,
                }
              : state.incumbent,
          }
          return structuredClone(state)
        } finally {
          active -= 1
        }
      },
      async resume(options) { return this.run(options) },
    }
    const handle = {
      orchestrator,
      setCoordinationContext(value) { currentContext = value },
      contexts,
      get calls() { return calls },
    }
    branchesById.set(branchId, handle)
    return handle
  }

  const orchestrator = new PopulationOrchestrator({
    loadedCampaign: loaded(mode, { branches, total, beta }),
    campaignsRoot,
    campaignId: `population-${mode}`,
    createBranch,
    clock,
  })
  return {
    orchestrator,
    branchesById,
    get maximumActive() { return maximumActive },
  }
}

test('single gives one branch the entire budget and reports the best harness', async () => {
  const context = await fixture('single', {
    total: 3,
    scores: { 'branch-001': [2, 3, 3] },
  })
  await context.orchestrator.initialize()
  const state = await context.orchestrator.run()
  assert.equal(state.status, 'CLOSED')
  assert.equal(state.budget.consumed, 3)
  assert.equal(state.branches[0].baseBudget, 3)
  assert.equal(state.best.validationVerified, 3)
  assert.equal(context.branchesById.get('branch-001').calls, 3)
  const report = await context.orchestrator.report()
  assert.equal(report.summary.best.branchId, 'branch-001')
  assert.match(await readFile(report.paths.patch, 'utf8'), /agent\.py/u)
})

test('independent advances each branch in synchronized parallel waves', async () => {
  const context = await fixture('independent', { branches: 3, total: 6 })
  await context.orchestrator.initialize()
  const state = await context.orchestrator.run()
  assert.equal(state.status, 'CLOSED')
  assert.equal(state.epoch, 2)
  assert.equal(state.budget.consumed, 6)
  assert.deepEqual(state.branches.map((branch) => branch.consumed), [2, 2, 2])
  assert.equal(context.maximumActive, 3)
})

test('mutualism shares all other branch logs starting with the next wave', async () => {
  const context = await fixture('mutualism', { total: 4 })
  await context.orchestrator.initialize()
  await context.orchestrator.run()
  for (const [branchId, branch] of context.branchesById) {
    assert.equal(branch.contexts.length, 2)
    assert.equal(branch.contexts[0].peerLogs.length, 0)
    assert.equal(branch.contexts[1].peerLogs.length, 1)
    assert.notEqual(branch.contexts[1].peerLogs[0].branchId, branchId)
    assert.match(branch.contexts[1].promptSuffix, /Peer Log Sharing Block/u)
  }
})

test('competition spends equal base credits then grants the bonus pool by delta score', async () => {
  const context = await fixture('competition', {
    total: 8,
    beta: 0.5,
    scores: {
      'branch-001': [2, 2, 2, 2, 2, 2],
      'branch-002': [3, 3, 3, 3, 3, 3],
    },
  })
  await context.orchestrator.initialize()
  const state = await context.orchestrator.run()
  assert.equal(state.budget.consumed, 8)
  assert.equal(state.budget.bonusPool, 4)
  assert.equal(state.budget.bonusRemaining, 0)
  assert.deepEqual(state.branches.map((branch) => branch.baseBudget), [2, 2])
  assert.deepEqual(state.branches.map((branch) => branch.bonusBudget), [0, 4])
  assert.deepEqual(state.branches.map((branch) => branch.consumed), [2, 6])
  assert.equal(state.best.branchId, 'branch-002')
})

test('combined keeps exhausted peers as log contributors while competition continues', async () => {
  const context = await fixture('combined', {
    total: 8,
    beta: 0.5,
    scores: {
      'branch-001': [2, 2, 2, 2],
      'branch-002': [3, 3, 3, 3, 3, 3],
    },
  })
  await context.orchestrator.initialize()
  const state = await context.orchestrator.run()
  assert.equal(state.status, 'CLOSED')
  const branchTwo = context.branchesById.get('branch-002')
  const soloCompetitionRound = branchTwo.contexts.find((coordination, index) => (
    index >= 2 && coordination.peerLogs.some((peer) => peer.branchId === 'branch-001')
  ))
  assert.ok(soloCompetitionRound)
  assert.match(soloCompetitionRound.promptPrefix, /Competition Block/u)
  assert.match(soloCompetitionRound.promptSuffix, /Peer Log Sharing Block/u)
})

test('roundLimit caps synchronization waves without changing the frozen total budget', async () => {
  const context = await fixture('independent', { branches: 2, total: 8 })
  await context.orchestrator.initialize()
  const state = await context.orchestrator.run({ roundLimit: 1 })
  assert.equal(state.status, 'EVOLVING')
  assert.equal(state.epoch, 1)
  assert.equal(state.budget.consumed, 2)
  assert.equal(state.budget.totalBudget, 8)
})

test('a capped invocation still closes and reports when its last wave exhausts the budget', async () => {
  const context = await fixture('single', { total: 1 })
  await context.orchestrator.initialize()
  const state = await context.orchestrator.run({ roundLimit: 1 })
  assert.equal(state.status, 'CLOSED')
  assert.equal(state.budget.consumed, 1)
  const report = await context.orchestrator.report()
  assert.equal(report.summary.budget.unused, 0)
})
