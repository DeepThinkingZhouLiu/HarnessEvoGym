import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  diffSnapshots,
  enforceMutationPolicy,
  snapshotTree,
  treeDigest,
  validateCandidateSemantics,
} from '../src/candidate.mjs'

test('Candidate Snapshot 能稳定识别新增、修改和删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-candidate-'))
  await mkdir(join(root, 'skills'), { recursive: true })
  await writeFile(join(root, 'skills', 'one.md'), 'one\n')
  await writeFile(join(root, 'skills', 'deleted.md'), 'delete\n')
  const before = await snapshotTree(root)
  await writeFile(join(root, 'skills', 'one.md'), 'two\n')
  await writeFile(join(root, 'skills', 'added.md'), 'add\n')
  const { rm } = await import('node:fs/promises')
  await rm(join(root, 'skills', 'deleted.md'))
  const after = await snapshotTree(root)
  assert.notEqual(treeDigest(before), treeDigest(after))
  assert.deepEqual(diffSnapshots(before, after).map((item) => item.type), ['added', 'deleted', 'modified'])
})

test('Diff Guard 对越界文件给出机器可读违规', () => {
  const changes = [{ type: 'added', path: 'controller/hack.js', before: null, after: { bytes: 10 } }]
  const report = enforceMutationPolicy(changes, {
    metadata: { level: 'l1' },
    spec: {
      writable: ['preset/**/*.md'],
      readOnly: ['controller/**'],
      extensions: ['.md'],
      limits: { maximumChangedFiles: 2, maximumChangedBytes: 100 },
    },
  })
  assert.equal(report.valid, false)
  assert.match(report.violations[0].reason, /永久只读/u)
})

test('Diff Guard 拒绝零改动 Candidate，避免随机波动被误当成进化', () => {
  const report = enforceMutationPolicy([], {
    metadata: { level: 'l1' },
    spec: {
      writable: ['preset/**/*.md'],
      readOnly: [],
      extensions: ['.md'],
      limits: { maximumChangedFiles: 2, maximumChangedBytes: 100 },
    },
  })
  assert.equal(report.valid, false)
  assert.match(report.violations[0].reason, /未产生任何 Candidate 文件改动/u)
})

test('Candidate Snapshot 会限制目录项，空目录也不能用于资源消耗', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-candidate-limit-'))
  await mkdir(join(root, 'one'))
  await mkdir(join(root, 'two'))
  await assert.rejects(
    snapshotTree(root, { maximumTreeEntries: 1 }),
    /Candidate 目录项数量超过上限/u,
  )
})

test('Candidate Digest 覆盖空目录，Diff Guard 拒绝只改目录不改文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-candidate-directory-'))
  const before = await snapshotTree(root)
  await mkdir(join(root, 'empty'))
  const after = await snapshotTree(root)
  const changes = diffSnapshots(before, after)

  assert.notEqual(treeDigest(before), treeDigest(after))
  const report = enforceMutationPolicy(changes, {
    metadata: { level: 'l1' },
    spec: {
      writable: ['**/*.md'],
      readOnly: [],
      extensions: ['.md'],
      limits: { maximumChangedFiles: 2, maximumChangedBytes: 100 },
    },
  })
  assert.equal(report.valid, false)
  assert.equal(report.changedDirectories, 1)
  assert.ok(report.violations.some((item) => item.reason.includes('空目录')))
})

test('Diff Guard 拒绝把文件原地换成目录', () => {
  const report = enforceMutationPolicy([{
    type: 'modified',
    path: 'skills/cowork-document.md',
    before: { path: 'skills/cowork-document.md', kind: 'file', sha256: 'a', bytes: 1, executable: false },
    after: { path: 'skills/cowork-document.md', kind: 'directory', bytes: 0 },
  }], {
    metadata: { level: 'l1' },
    spec: {
      writable: ['skills/**/*.md'],
      readOnly: [],
      extensions: ['.md'],
      limits: { maximumChangedFiles: 2, maximumChangedBytes: 100 },
    },
  })
  assert.equal(report.valid, false)
  assert.ok(report.violations.some((item) => item.reason.includes('改变类型')))
})

test('Cordis 语义检查拒绝通过 YAML 注入未审查插件和 JavaScript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cordis-'))
  await writeFile(join(root, 'agent.cordis.yml'), [
    '- id: unsafe',
    "  name: '@deepseek-ai/dsh-tool-cordis'",
    '  disabled: !!js process.mainModule.require("node:fs")',
    '',
  ].join('\n'))
  const report = await validateCandidateSemantics(root, {
    mutation: {
      semanticChecks: {
        cordis: {
          path: 'agent.cordis.yml',
          allowedPluginNames: ['@deepseek-ai/dsh-persona'],
          allowedJsLines: [],
        },
      },
    },
  })
  assert.equal(report.valid, false)
  assert.equal(report.violations.length, 2)
})

test('Cordis 语义检查解析 YAML 树，行内对象也不能绕过插件与 Patch 白名单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cordis-inline-'))
  await writeFile(join(root, 'agent.cordis.yml'), [
    "- { id: unsafe, name: '@deepseek-ai/dsh-tool-cordis' }",
    "- { id: mutate-host, patch: { name: '@deepseek-ai/dsh-persona' } }",
    '',
  ].join('\n'))
  const report = await validateCandidateSemantics(root, {
    mutation: {
      semanticChecks: {
        cordis: {
          path: 'agent.cordis.yml',
          allowedPluginNames: ['@deepseek-ai/dsh-persona'],
          allowedJsLines: [],
        },
      },
    },
  })
  assert.equal(report.valid, false)
  assert.ok(report.violations.some((item) => item.reason.includes('dsh-tool-cordis')))
  assert.ok(report.violations.some((item) => item.reason.includes('Patch')))
})

test('Skill 语义检查强制命名空间，避免遮蔽 Benchmark Skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skills-'))
  await mkdir(join(root, 'skills', 'pdf'), { recursive: true })
  await writeFile(join(root, 'skills', 'pdf', 'SKILL.md'), [
    '---',
    'name: pdf',
    'description: 会遮蔽题目自带的 pdf Skill',
    '---',
    '',
  ].join('\n'))
  const report = await validateCandidateSemantics(root, {
    mutation: {
      semanticChecks: {
        skills: { root: 'skills', requiredNamePrefix: 'cowork-' },
      },
    },
  })
  assert.equal(report.valid, false)
  assert.match(report.violations[0].reason, /cowork-/u)
})
