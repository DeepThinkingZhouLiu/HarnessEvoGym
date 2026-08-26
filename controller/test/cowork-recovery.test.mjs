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

test('Cowork 恢复归档未完成 Generation 和 Trial，保留已完成历史', async () => {
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
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  })

  assert.ok(archived)
  assert.equal(await exists(completed), true)
  for (const pathValue of [generation, results, candidate, trial]) {
    assert.equal(await exists(pathValue), false)
  }
  assert.deepEqual(archived.manifest.spec.archived.sort(), [
    'candidates/g004-l1',
    'generations/generation-4',
    'results/generation-4',
    `trials/${executionId}`,
  ])
  assert.equal(
    JSON.parse(await readFile(join(archived.root, 'manifest.json'), 'utf8')).kind,
    'CoworkRecoveryArchive',
  )
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
