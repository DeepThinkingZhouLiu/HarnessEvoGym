import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGrhsMutationPlans,
  initialProposalPrior,
  scoreGrhsGroup,
  validateGrhsConfiguration,
} from '../src/grhs.mjs'

const catalog = {
  apiVersion: 'harness-rsi/v1alpha1',
  kind: 'MutationCatalog',
  metadata: { target: 'fixture' },
  spec: {
    riskLevels: ['l1', 'l2'],
    maximumRegionsPerPlan: 2,
    regions: [
      { id: 'profile', riskLevel: 'l1', requires: [], conflicts: [] },
      { id: 'skills', riskLevel: 'l1', requires: [], conflicts: [] },
      { id: 'agent-loop', riskLevel: 'l2', requires: [], conflicts: [] },
    ],
  },
}

function configuration(overrides = {}) {
  return validateGrhsConfiguration({
    groupSize: 2,
    minimumValidCandidates: 2,
    regressionPenalty: 0.5,
    costPenalty: 0.1,
    complexityPenalty: 0.2,
    advantageEpsilon: 1e-8,
    priorLearningRate: 0.25,
    promotionMargin: 0,
    ...overrides,
  })
}

function candidate(id, regionIds, overrides = {}) {
  return {
    id,
    parentId: 'h0',
    regionIds,
    valid: true,
    promotionEligible: true,
    qualityDelta: 0.2,
    qualityLowerBound: 0.1,
    regressionRate: 0,
    incrementalCost: 0,
    patchComplexity: 0,
    ...overrides,
  }
}

test('GRHS 从同一父版本确定性生成离散 sibling MutationPlan', () => {
  const prior = initialProposalPrior(catalog, 'l2')
  const plans = createGrhsMutationPlans({
    catalog,
    riskCeiling: 'l2',
    parentId: 'h0',
    generation: 1,
    groupSize: 2,
    proposalPrior: prior,
  })
  assert.equal(plans.length, 2)
  assert.ok(plans.every((plan) => plan.spec.parentIds[0] === 'h0'))
  assert.equal(new Set(plans.map((plan) => plan.metadata.id)).size, 2)
  assert.equal(new Set(plans.map((plan) => plan.spec.regionIds.join(','))).size, 2)
  assert.deepEqual(plans, createGrhsMutationPlans({
    catalog,
    riskCeiling: 'l2',
    parentId: 'h0',
    generation: 1,
    groupSize: 2,
    proposalPrior: prior,
  }))
})

test('GRHS utility 组合质量、回退、成本和 Patch 复杂度并更新 proposal prior', () => {
  const prior = { profile: 0.5, skills: 0.5 }
  const decision = scoreGrhsGroup({
    configuration: configuration(),
    proposalPrior: prior,
    candidates: [
      candidate('candidate-a', ['profile'], { qualityDelta: 0.3, qualityLowerBound: 0.2 }),
      candidate('candidate-b', ['skills'], {
        qualityDelta: 0.3,
        qualityLowerBound: 0.2,
        regressionRate: 0.2,
        incrementalCost: 0.5,
        patchComplexity: 0.5,
      }),
    ],
  })
  const [better, worse] = decision.candidates
  assert.equal(better.utility, 0.3)
  assert.equal(worse.utility, 0.05)
  assert.ok(better.advantage > 0)
  assert.ok(worse.advantage < 0)
  assert.ok(decision.proposalPriorAfter.profile > decision.proposalPriorAfter.skills)
  assert.equal(decision.promotedCandidateId, 'candidate-a')
})

test('GRHS 平分时 advantage 为零并用 Candidate ID 确定性决胜', () => {
  const decision = scoreGrhsGroup({
    configuration: configuration(),
    proposalPrior: { profile: 0.5, skills: 0.5 },
    candidates: [candidate('candidate-b', ['skills']), candidate('candidate-a', ['profile'])],
  })
  assert.deepEqual(decision.candidates.map((item) => item.advantage), [0, 0])
  assert.equal(decision.promotedCandidateId, 'candidate-a')
  assert.deepEqual(decision.proposalPriorAfter, { profile: 0.5, skills: 0.5 })
})

test('一个失败 Candidate 使组内有效样本不足，跳过 relative update 并 rollback', () => {
  const prior = { profile: 0.5, skills: 0.5 }
  const decision = scoreGrhsGroup({
    configuration: configuration(),
    proposalPrior: prior,
    candidates: [
      candidate('candidate-a', ['profile']),
      { id: 'candidate-b', parentId: 'h0', regionIds: ['skills'], valid: false, promotionEligible: false },
    ],
  })
  assert.equal(decision.relativeUpdateApplied, false)
  assert.equal(decision.promotedCandidateId, null)
  assert.equal(decision.rollbackReason, 'insufficient-valid-candidates')
  assert.deepEqual(decision.proposalPriorAfter, prior)
})

test('Candidate 预算全部耗尽时记录 rollback，且不产生非有限 JSON 数值', () => {
  const decision = scoreGrhsGroup({
    configuration: configuration(),
    proposalPrior: { profile: 0.5, skills: 0.5 },
    candidates: [
      { id: 'candidate-a', parentId: 'h0', regionIds: ['profile'], valid: false, promotionEligible: false },
      { id: 'candidate-b', parentId: 'h0', regionIds: ['skills'], valid: false, promotionEligible: false },
    ],
  })
  assert.equal(decision.validCandidates, 0)
  assert.equal(decision.rollbackReason, 'insufficient-valid-candidates')
  assert.doesNotMatch(JSON.stringify(decision), /Infinity|NaN/u)
})

test('LCB 未超过预注册 margin 时 rollback，即使 Candidate 通过普通 Gate', () => {
  const decision = scoreGrhsGroup({
    configuration: configuration({ promotionMargin: 0.15 }),
    proposalPrior: { profile: 0.5, skills: 0.5 },
    candidates: [candidate('candidate-a', ['profile']), candidate('candidate-b', ['skills'])],
  })
  assert.equal(decision.promotedCandidateId, null)
  assert.equal(decision.rollbackReason, 'utility-lcb-below-margin')
})

test('GRHS Controller Core E2E：H0 生成两个 sibling、评分类优势并晋升一个版本', () => {
  const prior = initialProposalPrior(catalog, 'l2')
  const plans = createGrhsMutationPlans({
    catalog,
    riskCeiling: 'l2',
    parentId: 'h0',
    generation: 1,
    groupSize: 2,
    proposalPrior: prior,
  })
  const decision = scoreGrhsGroup({
    configuration: configuration(),
    proposalPrior: prior,
    candidates: plans.map((plan, index) => candidate(
      `g001-grhs-s00${index + 1}-l2`,
      plan.spec.regionIds,
      index === 0
        ? { qualityDelta: 0.4, qualityLowerBound: 0.2 }
        : { qualityDelta: 0.1, qualityLowerBound: 0.05 },
    )),
  })
  assert.equal(decision.validCandidates, 2)
  assert.equal(decision.relativeUpdateApplied, true)
  assert.equal(decision.promotedCandidateId, 'g001-grhs-s001-l2')
  assert.equal(decision.rollbackReason, null)
  assert.ok(decision.candidates[0].advantage > decision.candidates[1].advantage)
})
