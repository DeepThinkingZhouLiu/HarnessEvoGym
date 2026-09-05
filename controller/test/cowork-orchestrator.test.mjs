import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  archiveFailedFinalAttempt,
  claimFinalAttempt,
  claimFinalRecoveryAttempt,
  deduplicateGrhsCandidates,
} from '../src/cowork-orchestrator.mjs'

test('Final Attempt 使用原子文件领取，并发调用也只能成功一次', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'rsi-final-claim-'))
  const claim = { attemptId: 'attempt-one', startedAt: '2026-08-24T00:00:00.000Z' }

  await claimFinalAttempt(runRoot, claim)
  await assert.rejects(claimFinalAttempt(runRoot, claim), /禁止重复解封/u)

  const saved = JSON.parse(await readFile(join(runRoot, 'final-attempt.json'), 'utf8'))
  assert.equal(saved.kind, 'FinalAttemptClaim')
  assert.equal(saved.metadata.attemptId, claim.attemptId)
})

test('Final Recovery Claim 保留原 Attempt 和前后 Controller Revision，且只能领取一次', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'rsi-final-recovery-claim-'))
  const claim = {
    attemptId: 'attempt-two',
    startedAt: '2026-08-27T00:00:00.000Z',
    recoveredFromAttemptId: 'attempt-one',
    evolutionControllerRevision: 'a'.repeat(40),
    finalizerControllerRevision: 'b'.repeat(40),
  }

  await claimFinalRecoveryAttempt(runRoot, claim)
  await assert.rejects(claimFinalRecoveryAttempt(runRoot, claim), /禁止再次恢复/u)

  const saved = JSON.parse(await readFile(join(runRoot, 'final-recovery-attempt.json'), 'utf8'))
  assert.equal(saved.kind, 'FinalRecoveryAttemptClaim')
  assert.equal(saved.spec.recoveredFromAttemptId, claim.recoveredFromAttemptId)
  assert.equal(saved.spec.evolutionControllerRevision, claim.evolutionControllerRevision)
  assert.equal(saved.spec.finalizerControllerRevision, claim.finalizerControllerRevision)
})

test('GRHS 组内相同 Digest 只保留第一个 sibling', () => {
  const candidates = [
    { id: 'sibling-1', digest: 'a'.repeat(64), valid: true, promotionEligible: true, qualityDelta: 0.2 },
    { id: 'sibling-2', digest: 'a'.repeat(64), valid: true, promotionEligible: true, qualityDelta: 0.3 },
    { id: 'sibling-3', digest: 'b'.repeat(64), valid: true, promotionEligible: true, qualityDelta: 0.1 },
  ]
  const result = deduplicateGrhsCandidates(candidates)
  assert.equal(result[0].valid, true)
  assert.equal(result[1].valid, false)
  assert.equal(result[1].promotionEligible, false)
  assert.equal(result[1].qualityDelta, null)
  assert.equal(result[1].rejection.stage, 'group-deduplication')
  assert.equal(result[2].valid, true)
})

function trialRoot(runRoot, candidateId, partition, attemptId) {
  const resultPartition = partition === 'feedback'
    ? `feedback-final-${attemptId}`
    : `final-${attemptId}`
  const outputPath = resolve(
    runRoot,
    'results',
    'generation-5',
    `${candidateId}-${resultPartition}.jsonl`,
  )
  const executionId = createHash('sha256').update(outputPath).digest('hex').slice(0, 12)
  return join(runRoot, 'trials', executionId)
}

test('Final Recovery 只归档 Feedback 产物，发现 sealed final 证据则拒绝', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'rsi-final-recovery-archive-'))
  const failedAttemptId = 'attempt-old'
  const feedbackRoot = trialRoot(runRoot, 'h0', 'feedback', failedAttemptId)
  const resultsRoot = join(runRoot, 'results', 'generation-5')
  await mkdir(feedbackRoot, { recursive: true })
  await mkdir(resultsRoot, { recursive: true })
  await writeFile(join(feedbackRoot, 'evidence.txt'), 'public feedback\n')
  await writeFile(join(resultsRoot, `h0-feedback-final-${failedAttemptId}.jsonl`), '{}\n')

  const archived = await archiveFailedFinalAttempt({
    runRoot,
    failedAttemptId,
    baselineId: 'h0',
    championId: 'g002-l1',
    generationsCompleted: 4,
    now: () => new Date('2026-08-27T01:02:03.000Z'),
  })
  assert.equal(archived.manifest.spec.sealedFinalAccessed, false)
  assert.deepEqual(archived.manifest.spec.archived.sort(), [
    `trials/${feedbackRoot.split('/').at(-1)}`,
    'results/generation-5',
  ].sort())
  await assert.rejects(access(feedbackRoot))
  await assert.rejects(access(resultsRoot))

  const blockedRoot = await mkdtemp(join(tmpdir(), 'rsi-final-recovery-blocked-'))
  await mkdir(trialRoot(blockedRoot, 'h0', 'final', failedAttemptId), { recursive: true })
  await assert.rejects(archiveFailedFinalAttempt({
    runRoot: blockedRoot,
    failedAttemptId,
    baselineId: 'h0',
    championId: 'g002-l1',
    generationsCompleted: 4,
  }), /sealed final/u)
})
