import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyMutationBoundary,
  copyCandidate,
  freezeCandidatePermissions,
  materializePinnedSource,
} from '../src/materializer.mjs'
import { ProtocolError } from '../src/protocol.mjs'

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'materializer-source-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  await mkdir(join(root, 'apps/cli/config/agent-presets'), { recursive: true })
  await writeFile(join(root, 'apps/cli/config/agent-presets/standard.yml'), 'one\n')
  await mkdir(join(root, 'packages/context/demo'), { recursive: true })
  await writeFile(join(root, 'packages/context/demo/index.ts'), 'one\n')
  await symlink('apps', join(root, 'apps-link'))
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root })
  return { root, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
}

test('materializePinnedSource uses an exact git archive without metadata', async () => {
  const fixture = await gitFixture()
  const parent = await mkdtemp(join(tmpdir(), 'materializer-target-'))
  const target = join(parent, 'baseline')
  await materializePinnedSource({ sourceRoot: fixture.root, revision: fixture.revision, destination: target })
  assert.equal(await readFile(join(target, 'apps/cli/config/agent-presets/standard.yml'), 'utf8'), 'one\n')
  await assert.rejects(() => lstat(join(target, '.git')))
  assert.equal((await lstat(join(target, 'apps-link'))).isSymbolicLink(), true)
})

test('materializer rejects an escaping symlink and cleans the destination', async () => {
  const fixture = await gitFixture()
  await symlink('/tmp', join(fixture.root, 'escape'))
  execFileSync('git', ['add', 'escape'], { cwd: fixture.root })
  execFileSync('git', ['commit', '-qm', 'escape'], { cwd: fixture.root })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim()
  const parent = await mkdtemp(join(tmpdir(), 'materializer-target-'))
  const target = join(parent, 'baseline')
  await assert.rejects(
    () => materializePinnedSource({ sourceRoot: fixture.root, revision, destination: target }),
    ProtocolError,
  )
  await assert.rejects(() => lstat(target))
})

test('materializer failure exposes only safe process diagnostics', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'materializer-diagnostics-'))
  const target = join(parent, 'baseline')
  const revision = 'a'.repeat(40)
  const secret = 'sk-materializer-secret-value'
  let invocation = 0
  const execute = async () => {
    invocation += 1
    if (invocation === 1) {
      return { ok: true, stdout: `${revision}\n` }
    }
    if (invocation === 2) return { ok: true }
    return {
      ok: false,
      timedOut: true,
      durationMs: 120_123,
      exitCode: null,
      signal: 'SIGTERM',
      stderr: `failed below ${parent}/${secret}`,
    }
  }
  await assert.rejects(
    () => materializePinnedSource({
      sourceRoot: join(parent, secret),
      revision,
      destination: target,
      timeoutMs: 120_000,
      execute,
    }),
    (error) => {
      assert.equal(error instanceof ProtocolError, true)
      assert.equal(error.message, '无法展开冻结 Source')
      assert.deepEqual(error.details, [
        'timedOut=true',
        'durationMs=120123',
        'exitCode=<none>',
        'signal=SIGTERM',
      ])
      const rendered = `${error.message}\n${error.details.join('\n')}`
      assert.doesNotMatch(rendered, new RegExp(secret, 'u'))
      assert.doesNotMatch(rendered, new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
      return true
    },
  )
  assert.equal(invocation, 3)
  await assert.rejects(() => lstat(target))
})

test('materializer validates timeout and process seam before execution', async () => {
  await assert.rejects(
    () => materializePinnedSource({
      sourceRoot: '/unused', revision: 'a'.repeat(40), destination: '/unused-target', timeoutMs: 0,
    }),
    /timeoutMs/u,
  )
  await assert.rejects(
    () => materializePinnedSource({
      sourceRoot: '/unused', revision: 'a'.repeat(40), destination: '/unused-target', execute: null,
    }),
    /execute/u,
  )
})

test('copyCandidate preserves source and rejects an existing destination', async () => {
  const fixture = await gitFixture()
  const parent = await mkdtemp(join(tmpdir(), 'materializer-copy-'))
  const target = join(parent, 'candidate')
  await copyCandidate({ incumbentRoot: fixture.root, destination: target })
  assert.equal(await readFile(join(target, 'packages/context/demo/index.ts'), 'utf8'), 'one\n')
  await assert.rejects(() => copyCandidate({ incumbentRoot: fixture.root, destination: target }), ProtocolError)
})

test('mutation boundary makes only active paths writable, then freezes all', async () => {
  const fixture = await gitFixture()
  await chmod(fixture.root, 0o755)
  const uid = process.getuid()
  const gid = process.getgid()
  const boundary = await applyMutationBoundary({
    candidateRoot: fixture.root, level: 'l1', updaterUid: uid, updaterGid: gid,
    trustedUid: uid, trustedGid: gid,
  })
  assert.equal(boundary.writableEntries.includes('apps/cli/config/agent-presets/standard.yml'), true)
  assert.equal((await lstat(join(fixture.root, 'apps/cli/config/agent-presets/standard.yml'))).mode & 0o200, 0o200)
  assert.equal((await lstat(join(fixture.root, 'packages/context/demo/index.ts'))).mode & 0o200, 0)
  await freezeCandidatePermissions({ candidateRoot: fixture.root, trustedUid: uid, trustedGid: gid })
  assert.equal((await lstat(join(fixture.root, 'apps/cli/config/agent-presets/standard.yml'))).mode & 0o200, 0)
})
