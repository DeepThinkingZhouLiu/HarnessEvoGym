import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { archiveIncompleteCoworkGeneration } from '../src/cowork-orchestrator.mjs'

function state() {
  return {
    metadata: { status: 'running' },
    spec: {
      generationsCompleted: 3,
      mutationLevel: 'l1',
      candidates: [
        { id: 'h0', digest: 'a'.repeat(64) },
        { id: 'g003-l1', digest: 'b'.repeat(64) },
      ],
    },
  }
}

async function exists(pathValue) {
  try {
    await stat(pathValue)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

test('Cowork 恢复归档未完成编排产物，但保留 Environment 管理的按题 Trial Root', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'cowork-recovery-'))
  const completed = join(runRoot, 'generations', 'generation-3')
  const generation = join(runRoot, 'generations', 'generation-4')
  const results = join(runRoot, 'results', 'generation-4')
  const candidate = join(runRoot, 'candidates', 'g004-l1')
  const outputPath = join(results, 'h0-feedback.jsonl')
  const executionId = createHash('sha256').update(resolve(outputPath)).digest('hex').slice(0, 12)
  const trial = join(runRoot, 'trials', executionId)
  await Promise.all([
    mkdir(completed, { recursive: true }),
    mkdir(generation, { recursive: true }),
    mkdir(results, { recursive: true }),
    mkdir(candidate, { recursive: true }),
    mkdir(trial, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(completed, 'keep.json'), '{}\n'),
    writeFile(join(generation, 'partial.json'), '{}\n'),
    writeFile(outputPath, '{"partial":true}\n'),
    writeFile(join(candidate, 'partial.txt'), 'partial\n'),
    writeFile(join(trial, 'partial.txt'), 'partial\n'),
  ])

  const archived = await archiveIncompleteCoworkGeneration({
    runRoot,
    state: state(),
    preserveTrialCheckpoints: true,
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  })

  assert.ok(archived)
  assert.equal(await exists(completed), true)
  for (const pathValue of [generation, results, candidate]) {
    assert.equal(await exists(pathValue), false)
  }
  assert.equal(await exists(trial), true)
  assert.deepEqual(archived.manifest.spec.archived.sort(), [
    'candidates/g004-l1',
    'generations/generation-4',
    'results/generation-4',
  ])
  assert.equal(
    JSON.parse(await readFile(join(archived.root, 'manifest.json'), 'utf8')).kind,
    'CoworkRecoveryArchive',
  )
})

test('不支持按题 Checkpoint 的环境仍归档未完成 Trial Root', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'cowork-recovery-legacy-'))
  const results = join(runRoot, 'results', 'generation-4')
  const outputPath = join(results, 'h0-feedback.jsonl')
  const executionId = createHash('sha256').update(resolve(outputPath)).digest('hex').slice(0, 12)
  const trial = join(runRoot, 'trials', executionId)
  await Promise.all([
    mkdir(results, { recursive: true }),
    mkdir(trial, { recursive: true }),
  ])
  await Promise.all([
    writeFile(outputPath, '{"partial":true}\n'),
    writeFile(join(trial, 'partial.txt'), 'partial\n'),
  ])

  const archived = await archiveIncompleteCoworkGeneration({
    runRoot,
    state: state(),
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  })

  assert.ok(archived)
  assert.equal(await exists(results), false)
  assert.equal(await exists(trial), false)
  assert.deepEqual(archived.manifest.spec.archived.sort(), [
    'results/generation-4',
    `trials/${executionId}`,
  ])
})

test('Cowork 恢复拒绝把符号链接当成 Controller 产物归档', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'cowork-recovery-link-'))
  await mkdir(join(runRoot, 'generations'), { recursive: true })
  await symlink('/tmp', join(runRoot, 'generations', 'generation-4'))
  await assert.rejects(
    archiveIncompleteCoworkGeneration({ runRoot, state: state() }),
    /普通目录/u,
  )
})

test('GRHS 恢复保留已完成 sibling，只归档半成品并保留共享 Group 产物', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'cowork-recovery-grhs-partial-'))
  const complete = join(runRoot, 'candidates', 'g001-grhs-s001-l2')
  const partial = join(runRoot, 'candidates', 'g001-grhs-s002-l2')
  const generation = join(runRoot, 'generations', 'generation-1')
  const groupRoot = join(generation, 'grhs-group')
  const shared = join(groupRoot, 'shared.checkpoint.json')
  const results = join(runRoot, 'results', 'generation-1')
  await Promise.all([
    mkdir(join(complete, 'workspace'), { recursive: true }),
    mkdir(partial, { recursive: true }),
    mkdir(groupRoot, { recursive: true }),
    mkdir(results, { recursive: true }),
  ])
  await writeFile(shared, '{"kind":"GrhsStageCheckpoint"}\n')
  await writeFile(join(groupRoot, 'sibling-001.checkpoint.json'), '{"kind":"GrhsStageCheckpoint"}\n')
  for (const name of ['manifest.json', 'mutation-diff.json', 'mutation-report.json']) {
    await writeFile(join(complete, name), '{}\n')
  }

  const archived = await archiveIncompleteCoworkGeneration({
    runRoot,
    state: {
      metadata: { status: 'running' },
      spec: {
        generationsCompleted: 0,
        mutationLevel: 'l2',
        searchStrategy: { id: 'group-relative-harness' },
        candidates: [{ id: 'h0', digest: 'a'.repeat(64) }],
      },
    },
    preserveTrialCheckpoints: true,
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  })

  assert.ok(archived)
  assert.equal(await exists(complete), true)
  assert.equal(await exists(partial), false)
  assert.equal(await exists(generation), true)
  assert.equal(await exists(shared), true)
  assert.equal(await exists(results), true)
  assert.deepEqual(archived.manifest.spec.archived, [
    'candidates/g001-grhs-s002-l2',
  ])
})
