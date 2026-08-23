import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  diffSnapshots,
  isPathAllowed,
  snapshotTree,
  validateMutation,
  validateMutationProposal,
} from '../src/mutation.mjs'
import { ProtocolError } from '../src/protocol.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mutation-test-'))
  await mkdir(join(root, 'apps/cli/config/agent-presets'), { recursive: true })
  await mkdir(join(root, 'packages/context/demo'), { recursive: true })
  await mkdir(join(root, 'packages/core/agent-loop'), { recursive: true })
  await writeFile(join(root, 'apps/cli/config/agent-presets/standard.yml'), 'one\n')
  await writeFile(join(root, 'packages/context/demo/index.ts'), 'one\n')
  await writeFile(join(root, 'packages/core/agent-loop/index.ts'), 'one\n')
  return root
}

test('path policy is cumulative but always-read-only wins', () => {
  assert.equal(isPathAllowed('apps/cli/config/agent-presets/standard.yml', 'l1'), true)
  assert.equal(isPathAllowed('packages/context/demo/index.ts', 'l1'), false)
  assert.equal(isPathAllowed('packages/context/demo/index.ts', 'l2'), true)
  assert.equal(isPathAllowed('packages/core/agent-loop/index.ts', 'l3'), true)
  assert.equal(isPathAllowed('packages/llm/token-meter/src/index.ts', 'l3'), false)
  assert.equal(isPathAllowed('nested/.env.local', 'l3'), false)
})

test('snapshot diff and L1 validation accept a preset edit', async () => {
  const root = await fixture()
  const before = await snapshotTree(root)
  await writeFile(join(root, 'apps/cli/config/agent-presets/standard.yml'), 'two\n')
  const after = await snapshotTree(root)
  assert.deepEqual(diffSnapshots(before, after).map(({ path, kind }) => ({ path, kind })), [{
    path: 'apps/cli/config/agent-presets/standard.yml', kind: 'modified',
  }])
  const result = await validateMutation({ before, after, candidateRoot: root, level: 'l1' })
  assert.equal(result.changes.length, 1)
})

test('L2 must touch an L2-exclusive path', async () => {
  const root = await fixture()
  const before = await snapshotTree(root)
  await writeFile(join(root, 'apps/cli/config/agent-presets/standard.yml'), 'two\n')
  const after = await snapshotTree(root)
  await assert.rejects(
    () => validateMutation({ before, after, candidateRoot: root, level: 'l2' }),
    (error) => error instanceof ProtocolError && error.details.some((detail) => /专属路径/u.test(detail)),
  )
})

test('mutation rejects higher-level files, symlinks, and credentials', async () => {
  const root = await fixture()
  let before = await snapshotTree(root)
  await writeFile(join(root, 'packages/core/agent-loop/index.ts'), 'two\n')
  let after = await snapshotTree(root)
  await assert.rejects(() => validateMutation({ before, after, candidateRoot: root, level: 'l2' }), ProtocolError)

  const root2 = await fixture()
  before = await snapshotTree(root2)
  await symlink('/tmp', join(root2, 'apps/cli/config/agent-presets/external'))
  after = await snapshotTree(root2)
  await assert.rejects(
    () => validateMutation({ before, after, candidateRoot: root2, level: 'l1' }),
    (error) => error instanceof ProtocolError && error.details.some((detail) => /符号链接/u.test(detail)),
  )

  const root3 = await fixture()
  before = await snapshotTree(root3)
  await writeFile(join(root3, 'apps/cli/config/agent-presets/standard.yml'), `token: ${'sk-' + 'x'.repeat(24)}\n`)
  after = await snapshotTree(root3)
  await assert.rejects(
    () => validateMutation({ before, after, candidateRoot: root3, level: 'l1' }),
    (error) => error instanceof ProtocolError && error.details.some((detail) => /凭据/u.test(detail)),
  )
})

test('proposal accepts validation evidence and rejects hidden evidence', () => {
  const base = {
    apiVersion: 'harness-rsi/v1alpha1', kind: 'MutationProposal', proposalId: 'p1',
    campaignId: 'campaign', candidateId: 'candidate', parentId: 'baseline', level: 'l1',
    createdAt: '2026-01-01T00:00:00Z', direction: 'improve planning',
    hypothesis: 'a shared checklist prevents premature final answers',
    expectedEffect: 'more valid proofs', model: { model: 'gpt-5.6-sol', effort: 'max' },
    evidence: [{ problemId: 'putnam_1962_a1', observation: 'trace ended before kernel replay' }],
    intendedFiles: ['apps/cli/config/agent-presets/standard.yml'], risks: [],
  }
  const options = {
    campaignId: 'campaign', candidateId: 'candidate', parentId: 'baseline', level: 'l1',
    validationIds: ['putnam_1962_a1'],
  }
  assert.equal(validateMutationProposal(base, options).proposalId, 'p1')
  assert.throws(
    () => validateMutationProposal({ ...base, evidence: [{ problemId: 'putnam_1963_a1', observation: 'hidden' }] }, options),
    /MutationProposal 校验失败/u,
  )
})
