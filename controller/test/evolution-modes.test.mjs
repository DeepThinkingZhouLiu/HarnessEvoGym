import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTROLLER_MODES,
  buildCoordinationContext,
  createBudgetPlan,
  normalizeControllerConfig,
  selectCompetitionWinner,
  selectPopulationBest,
} from '../src/evolution-modes.mjs'
import { ProtocolError } from '../src/protocol.mjs'

function config(mode, {
  branches = mode === 'single' ? 1 : 2,
  total = 32,
  beta = 0.5,
  injectPosition = 'prompt_suffix',
} = {}) {
  const peer = ['mutualism', 'combined'].includes(mode)
  const competition = ['competition', 'combined'].includes(mode)
  return {
    mode,
    concurrency: { n_branches: branches },
    budget: { total_budget: total, beta },
    peer_sharing: {
      enabled: peer,
      log_path_template: 'Peer {peer_id}: {log_path}',
      inject_position: injectPosition,
    },
    competition: {
      enabled: competition,
      bonus_grant_unit: 1,
      scoring_metric: 'delta_score',
    },
  }
}

test('all five controller modes normalize through one schema', () => {
  assert.deepEqual(CONTROLLER_MODES, [
    'single', 'independent', 'mutualism', 'competition', 'combined',
  ])
  for (const mode of CONTROLLER_MODES) {
    const normalized = normalizeControllerConfig(config(mode))
    assert.equal(normalized.mode, mode)
    assert.equal(normalized.peer_sharing.enabled, ['mutualism', 'combined'].includes(mode))
    assert.equal(normalized.competition.enabled, ['competition', 'combined'].includes(mode))
  }
})

test('single forces one branch and mode capabilities cannot silently drift', () => {
  assert.throws(
    () => normalizeControllerConfig(config('single', { branches: 2 })),
    (error) => error instanceof ProtocolError
      && error.details.some((detail) => /n_branches 必须是 1/u.test(detail)),
  )
  const invalid = config('mutualism')
  invalid.peer_sharing.enabled = false
  assert.throws(
    () => normalizeControllerConfig(invalid),
    (error) => error instanceof ProtocolError
      && error.details.some((detail) => /peer_sharing.enabled=true/u.test(detail)),
  )
})

test('budget plans preserve the exact global integer budget', () => {
  assert.deepEqual(
    createBudgetPlan(config('single')).branches.map((branch) => branch.baseBudget),
    [32],
  )
  const independent = createBudgetPlan(config('independent', { branches: 3 }))
  assert.deepEqual(independent.branches.map((branch) => branch.baseBudget), [11, 11, 10])
  assert.equal(independent.bonusPool, 0)

  const competition = createBudgetPlan(config('competition'))
  assert.deepEqual(competition.branches.map((branch) => branch.baseBudget), [8, 8])
  assert.equal(competition.bonusPool, 16)
  assert.equal(
    competition.branches.reduce((sum, branch) => sum + branch.baseBudget, 0)
      + competition.bonusPool,
    32,
  )
})

test('mutualism injects mounted peer logs only at the configured prompt position', () => {
  const context = buildCoordinationContext({
    controllerConfig: config('mutualism'),
    branchId: 'branch-001',
    peerLogs: [{ branchId: 'branch-002', sourcePath: '/campaign/branch-002/log.jsonl' }],
  })
  assert.equal(context.promptPrefix, '')
  assert.match(context.promptSuffix, /Peer Log Sharing Block/u)
  assert.match(context.promptSuffix, /Peer branch-002: \/opt\/harness-rsi\/peer-logs\/branch-002\.jsonl/u)
  assert.match(context.promptSuffix, /avoid repeating/u)
  assert.equal(context.peerLogs[0].sourcePath, '/campaign/branch-002/log.jsonl')
  assert.equal(
    context.peerLogs[0].sandboxPath,
    '/opt/harness-rsi/peer-logs/branch-002.jsonl',
  )
})

test('combined prompt carries both peer sharing and competition blocks', () => {
  const context = buildCoordinationContext({
    controllerConfig: config('combined', { injectPosition: 'prompt_prefix' }),
    branchId: 'branch-002',
    peerLogs: [{ branchId: 'branch-001', sourcePath: '/campaign/branch-001/log.jsonl' }],
    competitionState: { bonusRemaining: 7 },
  })
  assert.match(context.promptPrefix, /Competition Block/u)
  assert.match(context.promptPrefix, /Peer Log Sharing Block/u)
  assert.match(context.promptPrefix, /7 round/u)
  assert.equal(context.promptSuffix, '')
})

test('competition ranking uses delta, then score, then stable branch id', () => {
  assert.equal(selectCompetitionWinner([
    { branchId: 'branch-001', deltaScore: 1, validationScore: 6 },
    { branchId: 'branch-002', deltaScore: 2, validationScore: 5 },
  ]).branchId, 'branch-002')
  assert.equal(selectCompetitionWinner([
    { branchId: 'branch-002', deltaScore: 1, validationScore: 6 },
    { branchId: 'branch-001', deltaScore: 1, validationScore: 6 },
  ]).branchId, 'branch-001')
})

test('population best is the highest incumbent score with deterministic ties', () => {
  const best = selectPopulationBest([
    { branchId: 'branch-002', incumbent: { validationVerified: 7 } },
    { branchId: 'branch-001', incumbent: { validationVerified: 7 } },
    { branchId: 'branch-003', incumbent: { validationVerified: 6 } },
  ])
  assert.equal(best.branchId, 'branch-001')
})
