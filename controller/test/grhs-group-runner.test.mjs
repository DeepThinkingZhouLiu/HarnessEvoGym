import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeGrhsGroup } from '../src/grhs-group-runner.mjs'

function strategy() {
  return {
    groupSize: 4,
    descriptor: () => ({
      id: 'group-relative-harness',
      protocol: 'builtin-v1',
      implementation: 'group-relative-harness',
      configuration: { groupSize: 4 },
    }),
    async proposeGroup(context, previousState) {
      const state = previousState ?? {
        proposalPrior: { 'profile-policy': 0.5, 'agent-loop': 0.5 },
      }
      return {
        state: { ...state, pendingGroup: { parentId: context.championId } },
        plans: Array.from({ length: 4 }, (_, index) => ({
          metadata: { id: 'plan-' + (index + 1) },
          spec: {
            generation: context.generation,
            parentIds: [context.championId],
            regionIds: [index % 2 === 0 ? 'profile-policy' : 'agent-loop'],
          },
        })),
      }
    },
    async observeGroup(context, previousState) {
      const winner = context.candidates.find((candidate) => candidate.qualityDelta > 0)
      return {
        state: { ...previousState, pendingGroup: null },
        exhausted: false,
        decision: {
          candidates: context.candidates.map((candidate) => ({
            ...candidate,
            utility: candidate.qualityDelta,
            advantage: candidate.qualityDelta,
          })),
          promotedCandidateId: winner?.id ?? null,
          rollbackReason: winner ? null : 'no-candidate-passed-gates',
          proposalPriorBefore: previousState.proposalPrior,
          proposalPriorAfter: previousState.proposalPrior,
        },
      }
    },
  }
}

function context() {
  return {
    runId: 'grhs-test-run',
    generation: 1,
    riskCeiling: 'l3',
    championId: 'h0',
    catalog: { spec: { regions: [] } },
    allowedParentIds: ['h0'],
    candidates: [],
    searchHistory: [],
  }
}

function siblingResult(member) {
  return {
    id: member.candidateId,
    parentId: 'h0',
    mutationPlanId: member.plan.metadata.id,
    regionIds: member.plan.spec.regionIds,
    digest: member.candidateId + '-digest',
    valid: true,
    promotionEligible: member.candidateId.endsWith('s003-l3'),
    qualityDelta: member.candidateId.endsWith('s003-l3') ? 0.2 : 0,
    evaluation: { candidateId: member.candidateId },
    baselineEvaluation: { candidateId: 'h0' },
  }
}

test('GRHS 执行四个 sibling，Selection 只在完整组完成后返回 Winner', async () => {
  const groupRoot = await mkdtemp(join(tmpdir(), 'grhs-group-'))
  let sharedCalls = 0
  let runCalls = 0
  const result = await executeGrhsGroup({
    strategy: strategy(),
    strategyContext: context(),
    previousStrategyState: null,
    groupRoot,
    async prepareSharedEvidence() {
      sharedCalls += 1
      return { feedbackPacket: { candidateId: 'h0' }, baselineRecords: [['task-1', { reward: 0 }]] }
    },
    async runSibling(member) {
      runCalls += 1
      return siblingResult(member)
    },
    async verifyCompletedSibling() {},
  })
  assert.equal(sharedCalls, 1)
  assert.equal(runCalls, 4)
  assert.equal(result.groupSize, 4)
  assert.equal(result.candidates.length, 4)
  assert.equal(result.decision.promotedCandidateId, 'g001-grhs-s003-l3')
  const checkpointPath = join(groupRoot, 'sibling-004.checkpoint.json')
  assert.equal((await readFile(checkpointPath, 'utf8')).includes('GrhsStageCheckpoint'), true)
  assert.equal((await stat(checkpointPath)).mode & 0o777, 0o400)
})

test('GRHS 中断恢复时复用已完成 sibling，只重跑未提交 sibling', async () => {
  const groupRoot = await mkdtemp(join(tmpdir(), 'grhs-group-resume-'))
  let firstRunCalls = 0
  await assert.rejects(
    executeGrhsGroup({
      strategy: strategy(),
      strategyContext: context(),
      previousStrategyState: null,
      groupRoot,
      async prepareSharedEvidence() {
        return { feedbackPacket: { candidateId: 'h0' }, baselineRecords: [] }
      },
      async runSibling(member) {
        firstRunCalls += 1
        if (firstRunCalls === 3) throw new Error('模拟中断')
        return siblingResult(member)
      },
      async verifyCompletedSibling() {},
    }),
    /模拟中断/u,
  )
  assert.equal(firstRunCalls, 3)

  const reused = []
  const rerun = []
  const result = await executeGrhsGroup({
    strategy: strategy(),
    strategyContext: context(),
    previousStrategyState: null,
    groupRoot,
    async prepareSharedEvidence() {
      throw new Error('不应重新计算共享证据')
    },
    async runSibling(member) {
      rerun.push(member.candidateId)
      return siblingResult(member)
    },
    async verifyCompletedSibling(resultValue) {
      reused.push(resultValue.id)
    },
  })
  assert.deepEqual(reused, ['g001-grhs-s001-l3', 'g001-grhs-s002-l3'])
  assert.deepEqual(rerun, ['g001-grhs-s003-l3', 'g001-grhs-s004-l3'])
  assert.equal(result.candidates.length, 4)
})
