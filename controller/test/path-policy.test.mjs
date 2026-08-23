import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePathPolicy, globToRegExp, normalizeRelativePath } from '../src/path-policy.mjs'

const base = 'apps/cli/config/agent-presets/cowork-rsi'

test('Glob 的 **/ 同时匹配直接子文件与深层文件', () => {
  const matcher = globToRegExp(`${base}/skills/**/*.md`)
  assert.equal(matcher.test(`${base}/skills/document/SKILL.md`), true)
  assert.equal(matcher.test(`${base}/skills/document/references/checklist.md`), true)
})

test('路径标准化拒绝目录逃逸与绝对路径', () => {
  assert.throws(() => normalizeRelativePath('../evaluation/policy.json'), /逃逸/u)
  assert.throws(() => normalizeRelativePath('/etc/passwd'), /绝对路径/u)
  assert.throws(() => normalizeRelativePath('skills/unsafe\nname.md'), /安全路径/u)
})

test('L1 允许 Skill 文档但拒绝可执行脚本', () => {
  const policy = {
    writable: [`${base}/skills/**/*.md`, `${base}/skills/**/scripts/**/*.py`],
    readOnly: ['.rsi-context/**', '**/.env'],
    extensions: ['.md'],
  }
  assert.equal(evaluatePathPolicy(`${base}/skills/document/SKILL.md`, policy).allowed, true)
  assert.equal(evaluatePathPolicy(`${base}/skills/document/scripts/fix.py`, policy).allowed, false)
})

test('永久只读规则优先于 writable', () => {
  const policy = { writable: ['**/*.md'], readOnly: ['protected/**'], extensions: ['.md'] }
  assert.equal(evaluatePathPolicy('protected/README.md', policy).allowed, false)
})
