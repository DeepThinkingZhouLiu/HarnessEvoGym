import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MSA_MINIMAL_MUTATION_POLICY } from '../src/mutation.mjs'
import { EvolutionOrchestrator } from '../src/orchestrator.mjs'

const DIGEST = 'a'.repeat(64)
const MUTATION_PATH = 'apps/cli/config/agent-presets/minimal/agent.cordis.yml'
const SOFT_MUTATION_PATHS = Object.freeze({
  l1: 'profiles/math.json',
  l2: 'agent.py',
  l3: 'model.py',
})
const PRIVILEGED = (process.getuid?.() ?? 0) === 0
const UPDATER_UID = PRIVILEGED ? 65534 : process.getuid()
const UPDATER_GID = PRIVILEGED ? 65534 : process.getgid()

function updaterGit({ gitRoot, candidateRoot }, args) {
  const command = PRIVILEGED ? '/usr/bin/setpriv' : '/usr/bin/git'
  const privilegeArgs = PRIVILEGED ? [
    `--reuid=${UPDATER_UID}`, `--regid=${UPDATER_GID}`, '--clear-groups', '/usr/bin/git',
  ] : []
  return execFileSync(command, [
    ...privilegeArgs,
    `--git-dir=${gitRoot}`,
    `--work-tree=${candidateRoot}`,
    ...args,
  ], {
    cwd: candidateRoot,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Updater Test',
      GIT_AUTHOR_EMAIL: 'updater@test.invalid',
      GIT_COMMITTER_NAME: 'Updater Test',
      GIT_COMMITTER_EMAIL: 'updater@test.invalid',
    },
  }).trim()
}

async function fixture({
  baselineScore = 1,
  candidateScore = 2,
  updaterFailure = false,
  softLayers = false,
  layerSequence = ['l1'],
  stopAfter = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-light-'))
  await chmod(root, 0o711)
  const sourceRoot = join(root, 'source')
  const campaignsRoot = join(root, 'campaigns')
  await mkdir(join(sourceRoot, 'apps/cli/config/agent-presets/minimal'), { recursive: true })
  await mkdir(join(sourceRoot, 'profiles'), { recursive: true })
  await mkdir(campaignsRoot)
  await writeFile(join(sourceRoot, MUTATION_PATH), 'baseline\n')
  await writeFile(join(sourceRoot, 'profiles/math.json'), '{}\n')
  await writeFile(join(sourceRoot, 'agent.py'), 'print("agent")\n')
  await writeFile(join(sourceRoot, 'model.py'), 'print("model")\n')
  execFileSync('git', ['init', '-q'], { cwd: sourceRoot })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: sourceRoot })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: sourceRoot })
  execFileSync('git', ['add', '.'], { cwd: sourceRoot })
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: sourceRoot })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim()

  const calls = { mutations: 0, validations: [], tests: 0 }
  const runtime = {
    ...(softLayers ? { mutationPolicy: MSA_MINIMAL_MUTATION_POLICY } : {}),
    async buildCandidate({ candidateId, candidateRoot }) {
      return { ok: true, candidateId, runtimeRoot: candidateRoot }
    },
    async mutate(input) {
      calls.mutations += 1
      if (stopAfter === calls.mutations) {
        return { durationMs: 10, stopReason: 'no evidence-backed mutation remains' }
      }
      if (updaterFailure) throw new Error('candidate-side updater failure')
      const chosenLevel = softLayers
        ? layerSequence[(calls.mutations - 1) % layerSequence.length]
        : input.level
      const mutationPath = softLayers ? SOFT_MUTATION_PATHS[chosenLevel] : MUTATION_PATH
      await writeFile(join(input.candidateRoot, mutationPath), `${input.candidateId}\n`)
      updaterGit(input, ['add', '--', mutationPath])
      updaterGit(input, ['commit', '-qm', `rsi(${chosenLevel}): round ${input.candidateId}`])
      return { durationMs: 25 }
    },
    async evaluateValidation({ candidateId, instanceIds }) {
      calls.validations.push(candidateId)
      const verified = candidateId === 'baseline' ? baselineScore : candidateScore
      return {
        summary: {
          candidateId,
          verified,
          total: instanceIds.length,
          completedAt: '2026-01-01T00:00:10Z',
          usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        records: instanceIds.map((instanceId, index) => ({
          instanceId,
          status: index < verified ? 'resolved' : 'unresolved',
          latencyMs: 1,
        })),
        traces: {},
      }
    },
    async evaluateTest() {
      calls.tests += 1
      throw new Error('test must stay disabled')
    },
  }
  const config = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionCampaign',
    metadata: { id: 'light', name: 'light' },
    spec: {
      source: { format: 'putnambench-lean' },
      partitions: {
        validation: { expectedCount: 2 },
        test: { expectedCount: 1, sha256: DIGEST },
      },
      evolution: {
        levels: ['l1', 'l2', 'l3'],
        ...(softLayers
          ? { layerSelection: 'updater-soft' }
          : { layerSelection: 'controller-sequential', consecutiveMissesBeforeAdvance: 3 }),
        promotion: 'strict-validation-verified-count',
        testEvaluationInterval: 0,
      },
      solver: { targetRevision: revision },
    },
  }
  const orchestrator = new EvolutionOrchestrator({
    loadedCampaign: {
      config,
      manifests: { validation: ['putnam_3000_a1', 'putnam_3001_a1'] },
      fingerprint: DIGEST,
    },
    campaignsRoot,
    campaignId: 'campaign',
    sourceRoot,
    runtime,
    updaterUid: UPDATER_UID,
    updaterGid: UPDATER_GID,
  })
  return { orchestrator, calls, revision }
}

test('one round is one updater call, one commit, validation, and promotion', async () => {
  const { orchestrator, calls, revision } = await fixture()
  await orchestrator.initialize()
  const result = await orchestrator.run({ roundLimit: 1 })
  assert.equal(calls.mutations, 1)
  assert.deepEqual(calls.validations, ['baseline', 'c0001-l1'])
  assert.equal(calls.tests, 0)
  assert.equal(result.candidates.at(-1).decision, 'promoted')
  assert.notEqual(result.incumbent.commit, revision)
  assert.equal((await orchestrator.linearGit.current()).commit, result.incumbent.commit)
  const log = await orchestrator.store.readEvolutionLog()
  assert.equal(log.length, 1)
  assert.equal(log[0].commit, result.incumbent.commit)
  assert.equal(log[0].validationScore, 2)
  assert.equal(log[0].decision, 'promoted')
})

test('baselineOnly creates feedback without consuming a mutation round', async () => {
  const { orchestrator, calls, revision } = await fixture()
  await orchestrator.initialize()
  const result = await orchestrator.run({ baselineOnly: true })
  assert.equal(calls.mutations, 0)
  assert.deepEqual(calls.validations, ['baseline'])
  assert.equal(result.candidates.length, 1)
  assert.equal(result.incumbent.commit, revision)
  assert.equal(result.status, 'EVOLVING_L1')
})

test('non-improvement resets the same worktree to the incumbent commit', async () => {
  const { orchestrator, revision } = await fixture({ baselineScore: 2, candidateScore: 1 })
  await orchestrator.initialize()
  const result = await orchestrator.run({ roundLimit: 1 })
  assert.equal(result.candidates.at(-1).decision, 'rejected')
  assert.equal(result.incumbent.commit, revision)
  assert.equal((await orchestrator.linearGit.current()).commit, revision)
  assert.equal(
    await readFile(join(orchestrator.workspace, MUTATION_PATH), 'utf8'),
    'baseline\n',
  )
})

test('updater failure scores zero and three misses advance L1 to L2', async () => {
  const { orchestrator, calls, revision } = await fixture({
    baselineScore: 1,
    candidateScore: 0,
    updaterFailure: true,
  })
  await orchestrator.initialize()
  const result = await orchestrator.run({ roundLimit: 3 })
  assert.equal(calls.mutations, 3)
  assert.equal(result.status, 'EVOLVING_L2')
  assert.equal(result.activeLevel, 'l2')
  assert.equal(result.candidates.slice(1).every((candidate) => (
    candidate.outcome === 'candidate_failure'
      && candidate.validationVerified === 0
      && candidate.decision === 'rejected'
  )), true)
  assert.equal((await orchestrator.linearGit.current()).commit, revision)
  assert.equal((await orchestrator.store.readEvolutionLog()).length, 3)
})

test('roundLimit zero runs until the L1-L3 early-stop rule closes the campaign', async () => {
  const { orchestrator, calls, revision } = await fixture({
    baselineScore: 1,
    candidateScore: 0,
    updaterFailure: true,
  })
  await orchestrator.initialize()
  const result = await orchestrator.run({ roundLimit: 0 })
  assert.equal(calls.mutations, 9)
  assert.equal(result.status, 'CLOSED')
  assert.equal(result.activeLevel, null)
  assert.equal(result.incumbent.commit, revision)
  assert.equal((await orchestrator.store.readEvolutionLog()).length, 9)
})

test('soft mode keeps evolving across non-improvements and records updater-selected layers', async () => {
  const { orchestrator, calls, revision } = await fixture({
    baselineScore: 2,
    candidateScore: 1,
    softLayers: true,
    layerSequence: ['l1', 'l2', 'l1', 'l3'],
  })
  await orchestrator.initialize()
  const result = await orchestrator.run({ roundLimit: 4 })
  assert.equal(calls.mutations, 4)
  assert.equal(result.status, 'EVOLVING')
  assert.equal(result.activeLevel, null)
  assert.equal(Object.hasOwn(result, 'consecutiveMisses'), false)
  assert.deepEqual(result.candidates.slice(1).map((entry) => entry.level), [
    'l1', 'l2', 'l1', 'l3',
  ])
  assert.deepEqual(result.candidates.slice(1).map((entry) => entry.candidateId), [
    'c0001', 'c0002', 'c0003', 'c0004',
  ])
  assert.equal((await orchestrator.linearGit.current()).commit, revision)
})

test('soft mode with roundLimit zero closes only when the updater explicitly stops', async () => {
  const { orchestrator, calls, revision } = await fixture({
    baselineScore: 2,
    candidateScore: 1,
    softLayers: true,
    stopAfter: 1,
  })
  await orchestrator.initialize()
  const result = await orchestrator.run({ roundLimit: 0 })
  assert.equal(calls.mutations, 1)
  assert.equal(result.status, 'CLOSED')
  assert.equal(result.incumbent.commit, revision)
  assert.equal(result.events.some((event) => event.type === 'UPDATER_STOPPED'), true)
})
