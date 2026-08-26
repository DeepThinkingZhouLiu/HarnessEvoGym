import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { validateTargetAdapter } from '../src/adapters.mjs'
import { snapshotTree, treeDigest } from '../src/candidate.mjs'
import { materializeCandidate } from '../src/candidate-materializers.mjs'
import { validateCandidate } from '../src/candidate-validators.mjs'
import { readConfigFile } from '../src/config.mjs'
import { resolveTargetSource } from '../src/target-sources.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function msaTarget() {
  return validateTargetAdapter(await readConfigFile(
    join(REPOSITORY_ROOT, 'adapters', 'targets', 'msa-minimal.yml'),
  ))
}

test('repository-tree Source + CandidateSeed 产生可复现且可校验的 MSA Candidate', async () => {
  const target = await msaTarget()
  const source = await resolveTargetSource({
    repositoryRoot: REPOSITORY_ROOT,
    source: target.source,
  })
  const root = await mkdtemp(join(tmpdir(), 'target-components-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  const firstComposition = await materializeCandidate({
    repositoryRoot: REPOSITORY_ROOT,
    target,
    sourceRoot: source.root,
    destination: first,
  })
  const secondComposition = await materializeCandidate({
    repositoryRoot: REPOSITORY_ROOT,
    target,
    sourceRoot: source.root,
    destination: second,
  })

  assert.deepEqual(firstComposition, secondComposition)
  assert.equal(firstComposition.sourceRevision, source.revision)
  assert.equal(firstComposition.seedDigest, target.materialization.seedDigest)
  assert.match(await readFile(join(first, 'model.py'), 'utf8'), /Chat Completions/u)
  const report = await validateCandidate({ workspace: first, target })
  assert.equal(report.valid, true)
  assert.deepEqual(report.checks.map((check) => check.id), [
    'msa-required-files',
    'msa-python-ast',
    'msa-profile-budget',
    'skill-catalog-namespace',
  ])
})

test('source-plus-seed-overlay 拒绝未声明覆盖和符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'target-overlay-'))
  const source = join(root, 'source')
  const seed = join(root, 'seed')
  await Promise.all([mkdir(source), mkdir(seed)])
  await writeFile(join(source, 'agent.py'), 'print("source")\n')
  await writeFile(join(seed, 'agent.py'), 'print("seed")\n')
  const seedDigest = treeDigest(await snapshotTree(seed))
  const target = {
    source: { revision: 'a'.repeat(40) },
    materialization: {
      protocol: 'source-plus-seed-overlay-v1',
      seedPath: 'seed',
      seedDigest,
      overrides: [],
    },
  }
  await assert.rejects(
    () => materializeCandidate({
      repositoryRoot: root,
      target,
      sourceRoot: source,
      destination: join(root, 'undeclared'),
    }),
    /未声明覆盖/u,
  )

  target.materialization.overrides = ['agent.py']
  await symlink('agent.py', join(seed, 'linked.py'))
  await assert.rejects(
    () => materializeCandidate({
      repositoryRoot: root,
      target,
      sourceRoot: source,
      destination: join(root, 'symlink'),
    }),
    /符号链接/u,
  )
})

test('source-plus-seed-overlay 在复制前拒绝 Seed Digest 不匹配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'target-seed-digest-'))
  const source = join(root, 'source')
  const seed = join(root, 'seed')
  await Promise.all([mkdir(source), mkdir(seed)])
  await writeFile(join(source, 'agent.py'), 'print("source")\n')
  await writeFile(join(seed, 'profile.md'), 'seed\n')
  const target = {
    source: { revision: 'a'.repeat(40) },
    materialization: {
      protocol: 'source-plus-seed-overlay-v1',
      seedPath: 'seed',
      seedDigest: '0'.repeat(64),
      overrides: [],
    },
  }
  const destination = join(root, 'candidate')

  await assert.rejects(
    () => materializeCandidate({ repositoryRoot: root, target, sourceRoot: source, destination }),
    /Seed Digest .*不一致/u,
  )
  await assert.rejects(() => readFile(join(destination, 'agent.py'), 'utf8'), /ENOENT/u)
})

test('Target Source 与 Candidate Seed 拒绝通过中间符号链接逃逸仓库', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'target-path-root-'))
  const externalRoot = await mkdtemp(join(tmpdir(), 'target-path-external-'))
  await Promise.all([
    mkdir(join(externalRoot, 'source')),
    mkdir(join(externalRoot, 'seed')),
    mkdir(join(repositoryRoot, 'source')),
  ])
  await writeFile(join(externalRoot, 'seed', 'profile.md'), 'external seed\n')
  await symlink(externalRoot, join(repositoryRoot, 'external'), 'dir')

  await assert.rejects(
    () => resolveTargetSource({
      repositoryRoot,
      source: {
        protocol: 'repository-tree-v1',
        path: 'external/source',
        revision: 'a'.repeat(40),
      },
    }),
    /符号链接解析后逃逸/u,
  )

  const externalSeedDigest = treeDigest(await snapshotTree(join(externalRoot, 'seed')))
  await assert.rejects(
    () => materializeCandidate({
      repositoryRoot,
      sourceRoot: join(repositoryRoot, 'source'),
      destination: join(repositoryRoot, 'candidate'),
      target: {
        source: { revision: 'a'.repeat(40) },
        materialization: {
          protocol: 'source-plus-seed-overlay-v1',
          seedPath: 'external/seed',
          seedDigest: externalSeedDigest,
          overrides: [],
        },
      },
    }),
    /符号链接解析后逃逸/u,
  )
})

test('TargetAdapter 要求 source-plus-seed-overlay 固定 64 位小写 Seed Digest', async () => {
  const raw = await readConfigFile(join(REPOSITORY_ROOT, 'adapters', 'targets', 'msa-minimal.yml'))
  raw.spec.materialization.seedDigest = 'A'.repeat(64)
  assert.throws(
    () => validateTargetAdapter(raw),
    /seedDigest 必须是 64 位小写 SHA-256/u,
  )
})

test('MSA Candidate Validator 拒绝损坏的 Python 与越界 Profile 预算', async () => {
  const target = await msaTarget()
  const source = await resolveTargetSource({
    repositoryRoot: REPOSITORY_ROOT,
    source: target.source,
  })
  const root = await mkdtemp(join(tmpdir(), 'target-validator-'))
  const workspace = join(root, 'candidate')
  await materializeCandidate({
    repositoryRoot: REPOSITORY_ROOT,
    target,
    sourceRoot: source.root,
    destination: workspace,
  })
  await writeFile(join(workspace, 'agent.py'), 'def broken(:\n')
  const profilePath = join(workspace, 'profiles', 'cowork.json')
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.max_steps = target.mutation.semanticChecks.profile.maximums.max_steps + 1
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`)

  const report = await validateCandidate({ workspace, target })
  assert.equal(report.valid, false)
  assert.ok(report.violations.some((violation) => violation.path === 'agent.py'))
  assert.ok(report.violations.some((violation) => violation.reason.includes('max_steps')))
})
