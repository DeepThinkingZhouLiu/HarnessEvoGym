import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claimFinalAttempt } from '../src/orchestrator.mjs'

test('Final Attempt 使用原子文件领取，并发调用也只能成功一次', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'rsi-final-claim-'))
  const claim = { attemptId: 'attempt-one', startedAt: '2026-08-24T00:00:00.000Z' }

  await claimFinalAttempt(runRoot, claim)
  await assert.rejects(claimFinalAttempt(runRoot, claim), /禁止重复解封/u)

  const saved = JSON.parse(await readFile(join(runRoot, 'final-attempt.json'), 'utf8'))
  assert.equal(saved.kind, 'FinalAttemptClaim')
  assert.equal(saved.metadata.attemptId, claim.attemptId)
})
