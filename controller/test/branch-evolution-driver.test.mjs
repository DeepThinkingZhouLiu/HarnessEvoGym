import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validateBranchEvolutionDriver,
  validateBranchProjection,
  validateBranchStepResult,
} from '../src/branch-evolution-driver.mjs'
import { createEvaluationSummary } from '../src/evaluation-summary.mjs'
import { ProtocolError } from '../src/protocol.mjs'

const DIGEST = 'a'.repeat(64)

function projection(overrides = {}) {
  const evaluation = createEvaluationSummary({
    candidateId: 'candidate-1', metric: 'mean-reward', value: 0.8,
  })
  const baselineEvaluation = createEvaluationSummary({
    candidateId: 'baseline', metric: 'mean-reward', value: 0.6,
  })
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BranchProjection',
    branchId: 'branch-001',
    status: 'active',
    completedSteps: 1,
    incumbent: {
      candidateId: 'candidate-1', revision: DIGEST, digest: DIGEST, evaluation,
    },
    lastStep: {
      stepId: 'step-1',
      stepNumber: 1,
      candidateId: 'candidate-1',
      decision: 'promoted',
      ranking: { eligible: true, evaluation, baselineEvaluation },
    },
    ...overrides,
  }
}

test('BranchProjection 不暴露 Reasoning/Cowork 内部状态', () => {
  const normalized = validateBranchProjection(projection())
  assert.equal(normalized.incumbent.evaluation.primary.metric, 'mean-reward')
  assert.equal(normalized.lastStep.decision, 'promoted')
  assert.equal(normalized.lastStep.ranking.baselineEvaluation.primary.value, 0.6)
  assert.ok(Object.isFrozen(normalized))
})

test('BranchProjection 拒绝 Candidate 错配与场景私有字段', () => {
  const invalidCandidate = projection()
  invalidCandidate.incumbent.evaluation = createEvaluationSummary({
    candidateId: 'another', metric: 'mean-reward', value: 0.8,
  })
  assert.throws(
    () => validateBranchProjection(invalidCandidate),
    (error) => error instanceof ProtocolError && /Candidate 不一致/u.test(error.message),
  )
  assert.throws(
    () => validateBranchProjection({ ...projection(), linearGit: {} }),
    (error) => error instanceof ProtocolError && /未知字段/u.test(error.message),
  )

  const mismatchedMetric = projection()
  mismatchedMetric.lastStep.ranking.baselineEvaluation = createEvaluationSummary({
    candidateId: 'baseline', metric: 'resolved-rate', value: 0.6,
  })
  assert.throws(
    () => validateBranchProjection(mismatchedMetric),
    (error) => error instanceof ProtocolError && /主指标不一致/u.test(error.message),
  )

  const selfComparison = projection()
  selfComparison.lastStep.ranking.baselineEvaluation = createEvaluationSummary({
    candidateId: 'candidate-1', metric: 'mean-reward', value: 0.6,
  })
  assert.throws(
    () => validateBranchProjection(selfComparison),
    (error) => error instanceof ProtocolError && /不能指向当前 Candidate/u.test(error.message),
  )
})

test('GRHS BranchProjection 严格绑定 Group 身份、Sibling 列表和 Proposal Prior', () => {
  const siblingIds = ['sibling-1', 'sibling-2']
  const group = {
    groupId: 'generation-0001-grhs',
    groupSize: 2,
    groupCandidateIds: siblingIds,
    winnerCandidateId: 'sibling-1',
    rollbackReason: null,
    candidates: siblingIds.map((id, index) => ({
      id,
      mutationPlanId: `plan-${index + 1}`,
      regionIds: ['reasoning-profile'],
      valid: true,
      promotionEligible: index === 0,
      utility: index === 0 ? 0.2 : 0.1,
      relativeAdvantage: index === 0 ? 1 : -1,
    })),
    proposalPriorBefore: { 'reasoning-profile': 1 },
    proposalPriorAfter: { 'reasoning-profile': 1 },
  }
  const valid = projection()
  valid.lastStep = {
    ...valid.lastStep,
    candidateId: 'sibling-1',
    candidateRevision: DIGEST,
    candidateDigest: DIGEST,
    budgetConsumed: 2,
    groupId: group.groupId,
    groupSize: group.groupSize,
    groupCandidateIds: siblingIds,
    group,
  }
  valid.incumbent = {
    ...valid.incumbent,
    candidateId: 'sibling-1',
    evaluation: createEvaluationSummary({ candidateId: 'sibling-1', metric: 'mean-reward', value: 0.8 }),
  }
  valid.lastStep.ranking = {
    eligible: true,
    evaluation: valid.incumbent.evaluation,
    baselineEvaluation: valid.lastStep.ranking.baselineEvaluation,
  }
  assert.equal(validateBranchProjection(valid).lastStep.group.winnerCandidateId, 'sibling-1')

  const mismatchedIds = structuredClone(valid)
  mismatchedIds.lastStep.group.groupCandidateIds = ['sibling-2', 'sibling-1']
  assert.throws(() => validateBranchProjection(mismatchedIds), /分组身份必须与顶层字段一致/u)

  const missingCandidateFields = structuredClone(valid)
  delete missingCandidateFields.lastStep.group.candidates[0].mutationPlanId
  assert.throws(() => validateBranchProjection(missingCandidateFields), /mutationPlanId/u)

  const invalidWinner = structuredClone(valid)
  invalidWinner.lastStep.group.winnerCandidateId = 'outside'
  assert.throws(() => validateBranchProjection(invalidWinner), /必须属于 groupCandidateIds/u)
})

test('BranchStepResult 严格绑定当前 Step 与 Budget', () => {
  const result = validateBranchStepResult({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BranchStepResult',
    stepId: 'step-1',
    budgetConsumed: 1,
    projection: projection(),
  })
  assert.equal(result.projection.completedSteps, 1)
  assert.throws(
    () => validateBranchStepResult({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'BranchStepResult',
      stepId: 'step-other',
      budgetConsumed: 1,
      projection: projection(),
    }),
    /必须对应当前 lastStep/u,
  )
})

test('BranchEvolutionDriver 必须实现五个通用方法', () => {
  const driver = {
    initialize() {},
    inspect() {},
    advanceOne() {},
    exportPeerEvidence() {},
    exportBest() {},
  }
  assert.equal(validateBranchEvolutionDriver(driver), driver)
  assert.throws(
    () => validateBranchEvolutionDriver({ initialize() {} }),
    (error) => error instanceof ProtocolError
      && error.details.includes('advanceOne()')
      && error.details.includes('exportBest()'),
  )
})
