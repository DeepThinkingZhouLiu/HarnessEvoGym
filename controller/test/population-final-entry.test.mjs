import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { finalizeEvolution } from '../src/cowork-orchestrator.mjs'

const executeFile = promisify(execFile)

test('Population Final CLI 入口能加载 Store，不会因缺少运行时导入崩溃', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'population-final-entry-'))
  await executeFile('git', ['init', '-q'], { cwd: repositoryRoot })
  await executeFile('git', [
    '-c', 'user.name=HarnessEvoGym Test',
    '-c', 'user.email=test@invalid.local',
    'commit', '--allow-empty', '-q', '-m', 'fixture',
  ], { cwd: repositoryRoot })
  const { stdout } = await executeFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
  const controllerRevision = stdout.trim()
  const configDigest = 'a'.repeat(64)
  const configFingerprint = createHash('sha256').update(JSON.stringify({
    configDigest,
    controllerRevision,
  })).digest('hex')
  const runRoot = join(repositoryRoot, '.rsi/runs/populations/final-entry-fixture')
  await mkdir(join(runRoot, 'public'), { recursive: true })
  await writeFile(join(runRoot, 'public/state.json'), `${JSON.stringify({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'PopulationCampaignState',
    campaignId: 'final-entry-fixture',
    status: 'CLOSED',
    configDigest,
    configFingerprint,
    final: null,
    branches: [{
      branchId: 'branch-001',
      incumbent: { candidateId: 'h0', digest: 'b'.repeat(64), revision: 'b'.repeat(64) },
    }],
    best: {
      branchId: 'branch-001',
      candidateId: 'h0',
      digest: 'b'.repeat(64),
      revision: 'b'.repeat(64),
    },
    events: [],
  }, null, 2)}\n`)

  await assert.rejects(
    finalizeEvolution({ repositoryRoot, runDirectory: runRoot }),
    /Population report 不存在或损坏/u,
  )
})
