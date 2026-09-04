import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  commitTrialCheckpoint,
  inspectTrialCheckpoint,
  quarantineTrialTask,
} from '../src/trial-checkpoint-store.mjs'

function identity(overrides = {}) {
  return {
    executionId: 'a'.repeat(12),
    candidate: { id: 'h0', digest: 'b'.repeat(64) },
    partition: 'feedback',
    instanceId: 'officeval_001',
    seeds: [20260827],
    ...overrides,
  }
}

test('Trial Checkpoint 原子提交后可复用，身份变化时只能作为 stale 归档', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'rsi-trial-checkpoint-'))
  const taskRoot = join(runRoot, 'trials', 'scope', 'h0', 'feedback', 'officeval_001')
  await mkdir(taskRoot, { recursive: true })
  const record = { instance_id: 'officeval_001', status: 'unresolved', reward: 0 }
  await commitTrialCheckpoint({ runRoot, taskRoot, identity: identity(), record })

  const committed = await inspectTrialCheckpoint({
    runRoot,
    taskRoot,
    identity: identity(),
    validateRecord: async (value) => value,
  })
  assert.equal(committed.status, 'committed')
  assert.deepEqual(committed.record, record)

  const stale = await inspectTrialCheckpoint({
    runRoot,
    taskRoot,
    identity: identity({ candidate: { id: 'h0', digest: 'c'.repeat(64) } }),
    validateRecord: async (value) => value,
  })
  assert.equal(stale.status, 'stale')
  const archived = await quarantineTrialTask({
    runRoot,
    taskRoot,
    reason: 'checkpoint-identity-changed',
  })
  assert.match(archived, /recovery\/trial-attempts/u)
  assert.equal(JSON.parse(await readFile(join(archived, 'recovery.json'), 'utf8')).spec.reason,
    'checkpoint-identity-changed')
})

test('Trial Checkpoint 摘要损坏时 fail closed，不能被当成未完成题静默重跑', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'rsi-trial-corrupt-'))
  const taskRoot = join(runRoot, 'trials', 'scope', 'h0', 'feedback', 'officeval_001')
  await mkdir(taskRoot, { recursive: true })
  const checkpointPath = await commitTrialCheckpoint({
    runRoot,
    taskRoot,
    identity: identity(),
    record: { instance_id: 'officeval_001', status: 'unresolved', reward: 0 },
  })
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  checkpoint.spec.record.reward = 1
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`)
  await assert.rejects(
    inspectTrialCheckpoint({
      runRoot,
      taskRoot,
      identity: identity(),
      validateRecord: async (value) => value,
    }),
    /内容摘要不一致/u,
  )
})

