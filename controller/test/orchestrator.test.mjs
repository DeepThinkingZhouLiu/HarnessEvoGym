import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadEvolutionCampaign } from '../src/campaign.mjs'
import { EvolutionOrchestrator, UPDATER_LOGICAL_TIMESTAMP } from '../src/orchestrator.mjs'

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-source-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  for (const path of [
    'apps/cli/config/agent-presets',
    'packages/context/demo',
    'packages/core/agent-loop',
  ]) await mkdir(join(root, path), { recursive: true })
  await writeFile(join(root, 'apps/cli/config/agent-presets/standard.yml'), 'baseline\n')
  await writeFile(join(root, 'packages/context/demo/index.ts'), 'baseline\n')
  await writeFile(join(root, 'packages/core/agent-loop/index.ts'), 'baseline\n')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'source'], { cwd: root })
  return { root, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
}

async function campaignFixture(revision) {
  const directory = await mkdtemp(join(tmpdir(), 'orchestrator-config-'))
  const validationIds = Array.from({ length: 500 }, (_, index) => `putnam_${String(3000 + index).padStart(4, '0')}_a1`)
  const testIds = Array.from({ length: 172 }, (_, index) => `putnam_${String(4000 + index).padStart(4, '0')}_a1`)
  const validation = `${validationIds.join('\n')}\n`
  const hidden = `${testIds.join('\n')}\n`
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  await writeFile(join(directory, 'validation.ids'), validation)
  await writeFile(join(directory, 'test.ids'), hidden)
  const config = {
    apiVersion: 'harness-rsi/v1alpha1', kind: 'EvolutionCampaign',
    metadata: { id: 'fixture', name: 'fixture' },
    spec: {
      source: { dataset: 'fixture', revision: 'a'.repeat(40), leanVersion: 'v4.27.0', mathlibRevision: 'b'.repeat(40) },
      partitions: {
        validation: { manifest: 'validation.ids', expectedCount: 500, sha256: sha(validation), visibility: 'feedback' },
        test: { manifest: 'test.ids', expectedCount: 172, sha256: sha(hidden), visibility: 'sealed-until-closed' },
      },
      evolution: { levels: ['l1', 'l2', 'l3'], consecutiveMissesBeforeAdvance: 3, promotion: 'strict-validation-verified-count', evaluateTestForEveryCandidate: true },
      solver: { targetRevision: revision, profile: 'headless', preset: 'standard', api: 'openai-responses', model: 'gpt-5.6-sol', reasoningEffort: 'max' },
    },
  }
  const path = join(directory, 'campaign.json')
  await writeFile(path, JSON.stringify(config))
  return loadEvolutionCampaign(path)
}

function mutationPath(level) {
  return level === 'l1'
    ? 'apps/cli/config/agent-presets/standard.yml'
    : level === 'l2' ? 'packages/context/demo/index.ts' : 'packages/core/agent-loop/index.ts'
}

function validProposal({ campaignId, candidateId, parentId, level, proposalId, createdAt }) {
  return {
    apiVersion: 'harness-rsi/v1alpha1', kind: 'MutationProposal', proposalId,
    campaignId, candidateId, parentId, level, createdAt,
    model: { model: 'gpt-5.6-sol', effort: 'max' }, direction: `${level} fixture`,
    hypothesis: 'fixture hypothesis', evidence: [{ observation: 'aggregate validation evidence' }],
    intendedFiles: [mutationPath(level)], expectedEffect: 'fixture effect', risks: [],
  }
}

async function recoveryScenario({ firstProposal, firstApply } = {}) {
  const source = await sourceFixture()
  const loadedCampaign = await campaignFixture(source.revision)
  const campaignsRoot = await mkdtemp(join(tmpdir(), 'orchestrator-recovery-'))
  let activeOrchestrator
  let tick = Date.parse('2026-02-01T00:00:00Z')
  const calls = { proposals: [], applies: [], validations: [], tests: [] }
  const runtime = {
    buildCandidate: async ({ candidateId, candidateRoot }) => ({ ok: true, candidateId, runtimeRoot: candidateRoot }),
    propose: async (input) => {
      calls.proposals.push(input.candidateId)
      if (input.candidateId !== 'c0001-l1') {
        const error = new Error('deliberate scenario stop')
        error.kind = 'infrastructure'
        error.operation = 'scenario-stop'
        throw error
      }
      return firstProposal ? firstProposal(input) : validProposal(input)
    },
    apply: async (input) => {
      calls.applies.push(input.candidateId)
      if (firstApply) return firstApply(input)
      const path = mutationPath(input.level)
      await writeFile(join(input.candidateRoot, path), `${input.candidateId}\n`)
      return {
        proposalId: input.proposal.proposalId,
        diagnosis: 'fixture', changedFiles: [path], checks: [], remainingRisks: [],
      }
    },
    evaluateValidation: async ({ candidateId, candidateRoot }) => {
      calls.validations.push({ candidateId, candidateRoot })
      return {
        summary: { candidateId, verified: 100, total: 500, completedAt: new Date(tick).toISOString() },
        records: [], traces: {},
      }
    },
    evaluateTest: async ({ candidateId, candidateRoot }) => {
      calls.tests.push({ candidateId, candidateRoot })
      return activeOrchestrator.store.sealTest(candidateId, {
        summary: { candidateId, verified: 50, total: 172, completedAt: new Date(tick).toISOString() },
        records: Array.from({ length: 172 }, (_, index) => ({
          instanceId: `putnam_${String(4000 + index)}_a1`,
          status: index < 50 ? 'resolved' : 'unresolved',
          latencyMs: 0,
        })),
        traces: {},
        testManifestSha256: loadedCampaign.config.spec.partitions.test.sha256,
      })
    },
  }
  const createOrchestrator = () => {
    activeOrchestrator = new EvolutionOrchestrator({
      loadedCampaign,
      campaignsRoot,
      campaignId: 'recovery-run',
      sourceRoot: source.root,
      runtime,
      clock: () => { tick += 1_000; return new Date(tick) },
    })
    return activeOrchestrator
  }
  const orchestrator = createOrchestrator()
  await orchestrator.initialize()
  return { orchestrator, createOrchestrator, calls }
}

test('orchestrator runs baseline then 3 misses per L1/L2/L3 with sealed tests', async () => {
  const source = await sourceFixture()
  const loadedCampaign = await campaignFixture(source.revision)
  const campaignsRoot = await mkdtemp(join(tmpdir(), 'orchestrator-runs-'))
  let orchestrator
  let tick = Date.parse('2026-01-01T00:00:00Z')
  const runtime = {
    buildCandidate: async ({ candidateId, candidateRoot }) => ({ ok: true, candidateId, runtimeRoot: candidateRoot }),
    propose: async ({ campaignId, candidateId, parentId, level, proposalId, createdAt }) => ({
      apiVersion: 'harness-rsi/v1alpha1', kind: 'MutationProposal', proposalId,
      campaignId, candidateId, parentId, level, createdAt,
      model: { model: 'gpt-5.6-sol', effort: 'max' }, direction: `${level} fixture`,
      hypothesis: 'fixture hypothesis', evidence: [{ observation: 'aggregate validation evidence' }],
      intendedFiles: [level === 'l1'
        ? 'apps/cli/config/agent-presets/standard.yml'
        : level === 'l2' ? 'packages/context/demo/index.ts' : 'packages/core/agent-loop/index.ts'],
      expectedEffect: 'fixture effect', risks: [],
    }),
    apply: async ({ candidateRoot, candidateId, level, proposal }) => {
      const path = level === 'l1'
        ? 'apps/cli/config/agent-presets/standard.yml'
        : level === 'l2' ? 'packages/context/demo/index.ts' : 'packages/core/agent-loop/index.ts'
      await writeFile(join(candidateRoot, path), `${candidateId}\n`)
      return { proposalId: proposal.proposalId, diagnosis: 'fixture', changedFiles: [path], checks: [], remainingRisks: [] }
    },
    evaluateValidation: async ({ candidateId }) => ({
      summary: { candidateId, verified: 100, total: 500, completedAt: new Date(tick).toISOString() },
      records: [], traces: {},
    }),
    evaluateTest: async (input) => {
      assert.deepEqual(Object.keys(input).sort(), ['candidateId', 'candidateRoot'])
      const { candidateId } = input
      return orchestrator.store.sealTest(candidateId, {
        summary: { candidateId, verified: 50, total: 172, completedAt: new Date(tick).toISOString() },
        records: Array.from({ length: 172 }, (_, index) => ({
          instanceId: `putnam_${String(4000 + index)}_a1`,
          status: index < 50 ? 'resolved' : 'unresolved',
          latencyMs: 0,
        })),
        traces: {},
        testManifestSha256: loadedCampaign.config.spec.partitions.test.sha256,
      })
    },
  }
  orchestrator = new EvolutionOrchestrator({
    loadedCampaign, campaignsRoot, campaignId: 'fixture-run', sourceRoot: source.root, runtime,
    clock: () => { tick += 60_000; return new Date(tick) },
    runtimeSnapshot: { frozenRuntime: true },
    implementationFingerprint: 'c'.repeat(64),
  })
  await orchestrator.initialize()
  const frozenConfig = JSON.parse(await readFile(
    join(orchestrator.store.publicRoot, 'config.snapshot.json'),
    'utf8',
  ))
  assert.equal(frozenConfig.kind, 'CampaignRuntimeSnapshot')
  assert.deepEqual(frozenConfig.runtime, { frozenRuntime: true })
  assert.equal(frozenConfig.implementationFingerprint, 'c'.repeat(64))
  const state = await orchestrator.run()
  assert.equal(state.status, 'CLOSED')
  assert.equal(state.candidates.length, 10)
  assert.equal(Object.hasOwn(loadedCampaign.manifests, 'test'), false)
  assert.deepEqual(state.candidates.slice(1).map((candidate) => candidate.level), [
    'l1', 'l1', 'l1', 'l2', 'l2', 'l2', 'l3', 'l3', 'l3',
  ])
  assert.equal(state.candidates.every((candidate) => candidate.testReceipt.score === undefined), true)
  const publicState = await readFile(join(orchestrator.store.publicRoot, 'state.json'), 'utf8')
  assert.equal(publicState.includes('"testVerified"'), false)
  assert.equal(publicState.includes('"verified": 50'), false)

  const report = await orchestrator.report()
  assert.equal(report.state.status, 'REPORTED')
  const curve = JSON.parse(await readFile(report.paths['curve.json'], 'utf8'))
  assert.equal(curve.points.length, 10)
  assert.equal(curve.points.every((point) => point.test.verified === 50), true)

  const mismatched = new EvolutionOrchestrator({
    loadedCampaign: { ...loadedCampaign, fingerprint: 'f'.repeat(64) },
    campaignsRoot,
    campaignId: 'fixture-run',
    sourceRoot: source.root,
    runtime,
  })
  await assert.rejects(() => mismatched.run(), /指纹/u)
})

test('resume adopts an atomically frozen proposal instead of rerunning the updater', async () => {
  const scenario = await recoveryScenario()
  const originalSave = scenario.orchestrator.store.saveState.bind(scenario.orchestrator.store)
  let crashed = false
  scenario.orchestrator.store.saveState = async (state, options) => {
    if (!crashed && state.inFlight?.stage === 'proposal_frozen') {
      crashed = true
      throw new Error('crash after proposal commit')
    }
    return originalSave(state, options)
  }
  await assert.rejects(() => scenario.orchestrator.run(), /crash after proposal/u)
  assert.equal((await scenario.orchestrator.store.readState()).inFlight.stage, 'started')
  assert.equal((await scenario.orchestrator.store.readProposal('c0001-l1')).proposalId, 'p0001-l1')

  const resumed = await scenario.createOrchestrator().run()
  assert.equal(resumed.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(resumed.candidates.length, 2)
  assert.equal(scenario.calls.proposals.filter((id) => id === 'c0001-l1').length, 1)
})

test('proposal and apply receive only the normalized timing projection', async () => {
  let proposalInput
  let applyInput
  let visibleSummary
  const scenario = await recoveryScenario({
    firstProposal: async (input) => {
      proposalInput = input
      visibleSummary = await readFile(join(input.feedbackRoot, 'baseline', 'summary.json'), 'utf8')
      return validProposal(input)
    },
    firstApply: async (input) => {
      applyInput = input
      const path = mutationPath(input.level)
      await writeFile(join(input.candidateRoot, path), 'timing-projection mutation\n')
      return {
        proposalId: input.proposal.proposalId,
        diagnosis: 'fixture', changedFiles: [path], checks: [], remainingRisks: [],
      }
    },
  })
  const state = await scenario.orchestrator.run()
  assert.equal(state.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(proposalInput.createdAt, UPDATER_LOGICAL_TIMESTAMP)
  assert.equal(applyInput.proposal.createdAt, UPDATER_LOGICAL_TIMESTAMP)
  assert.equal(proposalInput.feedbackRoot, scenario.orchestrator.store.feedbackRoot)
  assert.deepEqual(JSON.parse(visibleSummary), {
    candidateId: 'baseline', verified: 100, total: 500,
  })
  assert.doesNotMatch(visibleSummary, /completedAt|2026-/u)
  assert.equal(
    (await stat(join(proposalInput.feedbackRoot, 'baseline', 'summary.json'))).mtime.toISOString(),
    '2000-01-01T00:00:00.000Z',
  )

  // The trusted frozen ledger keeps real wall-clock time for final audit and
  // reporting, but that value was not passed to either Updater phase.
  const frozen = await scenario.orchestrator.store.readProposal('c0001-l1')
  assert.notEqual(frozen.createdAt, UPDATER_LOGICAL_TIMESTAMP)
  assert.match(frozen.createdAt, /^2026-/u)
})

test('resume verifies workspace digest and adopts a frozen mutation bundle', async () => {
  const scenario = await recoveryScenario()
  const originalSave = scenario.orchestrator.store.saveState.bind(scenario.orchestrator.store)
  let crashed = false
  scenario.orchestrator.store.saveState = async (state, options) => {
    if (!crashed && state.inFlight?.stage === 'mutation_frozen') {
      crashed = true
      throw new Error('crash after mutation bundle commit')
    }
    return originalSave(state, options)
  }
  await assert.rejects(() => scenario.orchestrator.run(), /crash after mutation bundle/u)
  assert.equal((await scenario.orchestrator.store.readState()).inFlight.stage, 'proposal_frozen')
  assert.equal(
    (await scenario.orchestrator.store.readMutationBundleIfExists('c0001-l1')).kind,
    'MutationBundle',
  )

  const resumed = await scenario.createOrchestrator().run()
  assert.equal(resumed.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(scenario.calls.applies.filter((id) => id === 'c0001-l1').length, 1)
})

test('resume aborts when a frozen mutation workspace no longer matches its bundle', async () => {
  const scenario = await recoveryScenario()
  const originalSave = scenario.orchestrator.store.saveState.bind(scenario.orchestrator.store)
  let crashed = false
  scenario.orchestrator.store.saveState = async (state, options) => {
    if (!crashed && state.inFlight?.stage === 'mutation_frozen') {
      crashed = true
      throw new Error('crash after mutation bundle commit')
    }
    return originalSave(state, options)
  }
  await assert.rejects(() => scenario.orchestrator.run(), /crash after mutation bundle/u)
  const workspace = join(scenario.orchestrator.store.candidatesRoot, 'c0001-l1', 'workspace')
  await writeFile(join(workspace, mutationPath('l1')), 'tampered after freeze\n')

  const resumed = scenario.createOrchestrator()
  await assert.rejects(() => resumed.run(), /workspace digest/u)
  assert.equal((await resumed.store.readState()).status, 'ABORTED_SECURITY')
})

test('out-of-scope mutation aborts the campaign as a security boundary violation', async () => {
  const scenario = await recoveryScenario({
    firstApply: async (input) => {
      await writeFile(join(input.candidateRoot, 'outside-l1-boundary.txt'), 'unauthorized\n')
      return {
        proposalId: input.proposal.proposalId,
        diagnosis: 'attempted out-of-scope write',
        changedFiles: ['outside-l1-boundary.txt'],
        checks: [],
        remainingRisks: [],
      }
    },
  })
  await assert.rejects(() => scenario.orchestrator.run(), /mutation 校验失败/u)
  assert.equal((await scenario.orchestrator.store.readState()).status, 'ABORTED_SECURITY')
})

test('malformed proposal is a candidate miss that fully evaluates the incumbent', async () => {
  const scenario = await recoveryScenario({ firstProposal: () => ({ malformed: true }) })
  const state = await scenario.orchestrator.run()
  assert.equal(state.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(state.candidates[1].outcome, 'candidate_failure')
  assert.equal(state.candidates[1].decision, 'rejected')
  assert.equal(state.consecutiveMisses, 1)
  assert.equal(scenario.calls.applies.length, 0)
  assert.deepEqual(scenario.calls.validations.map((entry) => entry.candidateId), ['baseline', 'c0001-l1'])
  assert.deepEqual(scenario.calls.tests.map((entry) => entry.candidateId), ['baseline', 'c0001-l1'])
  assert.equal(scenario.calls.validations[1].candidateRoot, scenario.calls.validations[0].candidateRoot)
  assert.equal(scenario.calls.tests[1].candidateRoot, scenario.calls.tests[0].candidateRoot)
})

test('malformed apply report rolls back and fully evaluates the incumbent as a miss', async () => {
  const scenario = await recoveryScenario({
    firstApply: async (input) => {
      await writeFile(join(input.candidateRoot, mutationPath(input.level)), 'partial mutation\n')
      return { proposalId: input.proposal.proposalId }
    },
  })
  const state = await scenario.orchestrator.run()
  assert.equal(state.status, 'PAUSED_INFRASTRUCTURE')
  assert.equal(state.candidates[1].outcome, 'candidate_failure')
  assert.equal(state.consecutiveMisses, 1)
  assert.equal(scenario.calls.applies.length, 1)
  assert.deepEqual(scenario.calls.validations.map((entry) => entry.candidateId), ['baseline', 'c0001-l1'])
  assert.deepEqual(scenario.calls.tests.map((entry) => entry.candidateId), ['baseline', 'c0001-l1'])
  assert.equal(scenario.calls.validations[1].candidateRoot, scenario.calls.validations[0].candidateRoot)
  const bundle = await scenario.orchestrator.store.readMutationBundleIfExists('c0001-l1')
  assert.equal(bundle.outcome, 'candidate_failure')
  assert.equal(bundle.workspaceDigest, state.candidates[0].digest)
})

test('provider, timeout, and launcher failures pause infrastructure without counting a miss', async (context) => {
  for (const [name, failure] of [
    ['provider', Object.assign(new Error('provider unavailable'), { kind: 'provider' })],
    ['timeout', Object.assign(new Error('updater timed out'), { kind: 'timeout' })],
    ['launcher', Object.assign(new Error('updater failed'), {
      kind: 'updater_failure',
      result: { stderr: 'bwrap: Creating new namespace failed' },
    })],
  ]) {
    await context.test(name, async () => {
      const scenario = await recoveryScenario({ firstProposal: () => { throw failure } })
      const state = await scenario.orchestrator.run()
      assert.equal(state.status, 'PAUSED_INFRASTRUCTURE')
      assert.equal(state.candidates.length, 1)
      assert.equal(state.consecutiveMisses, 0)
      assert.equal(state.inFlight.stage, 'started')
    })
  }
})
