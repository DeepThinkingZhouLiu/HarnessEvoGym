#!/usr/bin/env node

import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExperimentBundle } from '../controller/src/adapters.mjs'
import { evaluateBenchmark } from '../controller/src/evaluator.mjs'
import { scoreGrhsGroup } from '../controller/src/grhs.mjs'
import { readJsonFile, readResultFile, validateResultRecords, writeJsonFile } from '../controller/src/protocol.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) {
      fail('Usage: finalize-grhs-continuation --run <path> --experiment <path>')
    }
    options.set(name.slice(2), value)
  }
  for (const name of ['run', 'experiment']) if (!options.has(name)) fail(`Missing --${name}`)
  return options
}

function resultPath(runRoot, generation, candidateId, partition) {
  return join(runRoot, 'results', `generation-${generation}`, `${candidateId}-${partition}.jsonl`)
}

function policyValid(evaluation) {
  const invalidGateIds = new Set([
    'baseline-record-coverage',
    'candidate-record-coverage',
    'baseline-completion',
    'candidate-completion',
    'maximum-policy-violations',
  ])
  return evaluation.decision.gates.every((gate) => !invalidGateIds.has(gate.id) || gate.passed)
}

function publicDecision(decision) {
  return {
    eligible: decision.eligible,
    gates: decision.gates.map(({ id, passed, actual, operator, expected }) => ({
      id,
      passed,
      actual,
      operator,
      expected,
    })),
  }
}

function patchComplexity(diff, limits) {
  return (
    diff.spec.changedFiles / limits.maximumChangedFiles
    + diff.spec.changedBytes / limits.maximumChangedBytes
  ) / 2
}

function emptyUsage() {
  return {
    complete: true,
    requests: 0,
    usageResponses: 0,
    unknownUsageResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    observedInputTokens: 0,
    observedOutputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

const options = parseArgs(process.argv.slice(2))
const runRoot = resolve(options.get('run'))
const experimentPath = resolve(options.get('experiment'))
const bundle = await loadExperimentBundle(experimentPath, repositoryRoot)
const state = await readJsonFile(join(runRoot, 'state.json'))
if (state.metadata?.id !== basename(runRoot) || state.spec?.generationsCompleted !== 0) {
  fail('Run is not an incomplete generation-1 continuation')
}
if (bundle.experiment.evolution.grhs?.groupSize !== 2
    || bundle.experiment.evolution.generations !== 1) {
  fail('Experiment must define one generation with two GRHS siblings')
}

const generation = 1
const discardedFailure = state.spec.failure ? structuredClone(state.spec.failure) : null
const baselineId = state.spec.baselineId
const level = state.spec.mutationLevel
const siblingIds = [1, 2].map((member) =>
  `g001-grhs-s${String(member).padStart(3, '0')}-${level}`)
const baselineRecords = validateResultRecords(
  await readResultFile(resultPath(runRoot, generation, baselineId, 'selection')),
  bundle.benchmark,
  `${baselineId}/selection checkpoint-only continuation`,
)
const requiredIds = bundle.benchmark.partitions.selection.instanceIds
if (baselineRecords.size !== requiredIds.length
    || requiredIds.some((instanceId) => !baselineRecords.has(instanceId))) {
  fail('Baseline Selection does not exactly match the continuation benchmark')
}

const ledger = {
  generations: 1,
  candidatesEvaluated: 2,
  updaterTokens: 0,
  solverTokens: 0,
  updaterUsage: emptyUsage(),
  solverUsage: emptyUsage(),
  costUsd: null,
  wallTimeMs: 0,
}
const siblingResults = []
for (const [index, candidateId] of siblingIds.entries()) {
  const candidateRecords = validateResultRecords(
    await readResultFile(resultPath(runRoot, generation, candidateId, 'selection')),
    bundle.benchmark,
    `${candidateId}/selection checkpoint-only continuation`,
  )
  if (candidateRecords.size !== requiredIds.length
      || requiredIds.some((instanceId) => !candidateRecords.has(instanceId))) {
    fail(`${candidateId} Selection does not exactly match the continuation benchmark`)
  }
  const [manifest, diff, report, plan] = await Promise.all([
    readJsonFile(join(runRoot, 'candidates', candidateId, 'manifest.json')),
    readJsonFile(join(runRoot, 'candidates', candidateId, 'mutation-diff.json')),
    readJsonFile(join(runRoot, 'candidates', candidateId, 'mutation-report.json')),
    readJsonFile(join(
      runRoot,
      'generations',
      'generation-1',
      'grhs-group',
      'siblings',
      `s${String(index + 1).padStart(3, '0')}`,
      'mutation-plan.json',
    )),
  ])
  if (manifest.metadata?.id !== candidateId || manifest.metadata?.parentId !== baselineId
      || diff.spec?.valid !== true || typeof report.hypothesis !== 'string'
      || !Array.isArray(report.changedFiles)) {
    fail(`Candidate evidence is invalid: ${candidateId}`)
  }
  const evaluation = evaluateBenchmark({
    benchmark: bundle.benchmark,
    policy: bundle.policy,
    run: {
      id: state.metadata.id,
      baselineRevision: state.spec.candidates.find(({ id }) => id === baselineId)?.digest,
      candidateRevision: manifest.spec.treeDigest,
    },
    baselineRecords,
    candidateRecords,
    partitions: ['selection'],
    evolutionLedger: ledger,
  })
  await writeJsonFile(join(runRoot, 'candidates', candidateId, 'evaluation.json'), evaluation)
  const selection = evaluation.partitions.selection
  const tokenDelta = selection.deltas.tokens.relative
  siblingResults.push({
    id: candidateId,
    parentId: baselineId,
    regionIds: plan.spec.regionIds,
    valid: policyValid(evaluation),
    promotionEligible: evaluation.decision.eligible,
    qualityDelta: selection.paired.deltaMeanReward,
    qualityLowerBound:
      selection.paired.pairedRewardDeltaCi?.lower ?? selection.paired.deltaMeanReward,
    regressionRate: selection.paired.rewardRegressed / requiredIds.length,
    incrementalCost: typeof tokenDelta === 'number' ? tokenDelta : 0,
    patchComplexity: patchComplexity(diff, bundle.target.mutation.limits),
    manifest,
    report,
    plan,
    evaluation,
  })
}

if (new Set(siblingResults.map(({ manifest }) => manifest.spec.treeDigest)).size !== siblingResults.length) {
  fail('Sibling Candidates have duplicate tree digests')
}
const configuration = bundle.experiment.evolution.grhs
const groupDecision = scoreGrhsGroup({
  candidates: siblingResults.map(({ manifest, report, plan, evaluation, ...candidate }) => candidate),
  configuration,
  proposalPrior: state.spec.grhs.proposalPrior,
})
const promotedCandidateId = groupDecision.promotedCandidateId
const championId = promotedCandidateId ?? baselineId
const scoredById = new Map(groupDecision.candidates.map((candidate) => [candidate.id, candidate]))
const groupId = 'g001-grhs'

state.spec.candidates = state.spec.candidates.filter(({ id }) => id === baselineId)
state.spec.searchHistory = []
for (const sibling of siblingResults) {
  const scored = scoredById.get(sibling.id)
  const status = sibling.id === promotedCandidateId ? 'promoted' : 'rejected'
  state.spec.candidates.push({
    id: sibling.id,
    parentId: baselineId,
    digest: sibling.manifest.spec.treeDigest,
    status,
    groupId,
    mutationPlanId: sibling.plan.metadata.id,
    regionIds: sibling.regionIds,
    utility: scored.utility,
    relativeAdvantage: scored.advantage,
    utilityLowerBound: scored.utilityLowerBound,
    decision: sibling.evaluation.decision,
  })
  state.spec.searchHistory.push({
    generation,
    groupId,
    parentId: baselineId,
    proposalId: sibling.id,
    status,
    mutationPlanId: sibling.plan.metadata.id,
    regionIds: sibling.regionIds,
    utility: scored.utility,
    relativeAdvantage: scored.advantage,
    utilityLowerBound: scored.utilityLowerBound,
    hypothesis: sibling.report.hypothesis,
    changedFiles: sibling.report.changedFiles,
    expectedImpact: sibling.report.expectedImpact,
    selection: publicDecision(sibling.evaluation.decision),
    championBeforeId: baselineId,
    championAfterId: championId,
  })
}
state.metadata.status = 'completed'
state.spec.championId = championId
state.spec.generationsCompleted = 1
state.spec.grhs.proposalPrior = groupDecision.proposalPriorAfter
state.spec.grhs.groups = [{
  generation,
  groupId,
  parentId: baselineId,
  candidateIds: siblingIds,
  promotedCandidateId,
  rollbackReason: groupDecision.rollbackReason,
}]
state.spec.ledger = ledger
delete state.spec.failure
state.spec.recoveries = [
  ...(Array.isArray(state.spec.recoveries) ? state.spec.recoveries : []),
  {
    at: new Date().toISOString(),
    mode: 'checkpoint-only-quick9',
    selectionTasks: requiredIds.length,
    decisionModelRequests: 0,
    ...(discardedFailure ? {
      discardedFailedRuntimeAttempt: discardedFailure,
    } : {}),
  },
]

const groupRoot = join(runRoot, 'generations', 'generation-1', 'grhs-group')
await Promise.all([
  writeJsonFile(join(groupRoot, 'group-decision.json'), {
    ...groupDecision,
    evidence: { mode: 'checkpoint-only-quick9', selectionInstanceCount: requiredIds.length },
  }),
  writeJsonFile(join(runRoot, 'generations', 'generation-1', 'decision.json'), {
    generation,
    groupId,
    parentId: baselineId,
    championId,
    promotedCandidateId,
    rollbackReason: groupDecision.rollbackReason,
    evidence: { mode: 'checkpoint-only-quick9', selectionInstanceCount: requiredIds.length },
  }),
  writeJsonFile(join(runRoot, 'state.json'), state),
])

process.stdout.write(`${JSON.stringify({
  runId: state.metadata.id,
  status: state.metadata.status,
  championId,
  promotedCandidateId,
  rollbackReason: groupDecision.rollbackReason,
  candidates: siblingResults.map(({ id, evaluation }) => ({
    id,
    eligible: evaluation.decision.eligible,
    meanReward: evaluation.partitions.selection.candidate.meanReward,
    deltaMeanReward: evaluation.partitions.selection.paired.deltaMeanReward,
  })),
}, null, 2)}\n`)
