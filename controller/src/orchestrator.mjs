import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  abortSecurity,
  checkpointCandidateRound,
  closeCampaign,
  createCampaignState,
  freezeBaseline,
  markReported,
  pauseInfrastructure,
  recordBaselineEvaluation,
  recordCandidateEvaluation,
  resumeInfrastructure,
  startCandidateRound,
} from './campaign.mjs'
import { CampaignStore, redactSecrets } from './campaign-store.mjs'
import {
  applyMutationBoundary,
  candidateWorkspacePath,
  copyCandidate,
  freezeCandidatePermissions,
  materializePinnedSource,
} from './materializer.mjs'
import {
  digestSnapshot,
  snapshotTree,
  validateMutation,
  validateMutationProposal,
} from './mutation.mjs'
import { ProtocolError } from './protocol.mjs'
import { writeCampaignReport } from './reporting.mjs'

function now(clock) {
  return clock().toISOString()
}

function candidateOrdinal(state) {
  return state.candidates.length.toString().padStart(4, '0')
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const INFRASTRUCTURE_KINDS = new Set([
  'infrastructure',
  'provider',
  'timeout',
  'launcher',
  'cancelled',
  'operational',
])
const INFRASTRUCTURE_ERROR_CODES = new Set([
  'EACCES',
  'EAGAIN',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EMFILE',
  'ENFILE',
  'ENETUNREACH',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'EPIPE',
  'ETIMEDOUT',
])
const FAILURE_INTENDED_FILES = Object.freeze({
  l1: 'apps/cli/config/agent-presets/standard.yml',
  l2: 'packages/context/rsi-proposal-contract.ts',
  l3: 'packages/core/agent-loop/rsi-proposal-contract.ts',
})

// Updater prompts must not receive a wall-clock anchor. In particular, pairing
// a real proposal timestamp with validation completion metadata could reveal
// how long the intervening sealed evaluation took. The Controller replaces
// this logical marker with its trusted wall clock only in the frozen ledger.
export const UPDATER_LOGICAL_TIMESTAMP = '2000-01-01T00:00:00.000Z'

function updaterProposalProjection(proposal) {
  return { ...structuredClone(proposal), createdAt: UPDATER_LOGICAL_TIMESTAMP }
}

function isInfrastructureError(error) {
  const seen = new Set()
  let current = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof InfrastructureError || INFRASTRUCTURE_KINDS.has(current.kind)) return true
    if (INFRASTRUCTURE_ERROR_CODES.has(current.code)) return true
    if (current.result?.timedOut === true || current.result?.aborted === true
        || current.result?.outputExceeded === true) return true
    const stderr = current.result?.stderr
    if (typeof stderr === 'string' && /(?:^|\n)(?:bwrap|setpriv):/u.test(stderr)) return true
    current = current.cause
  }
  return false
}

function isFatalSecurityError(error) {
  return error instanceof ProtocolError
    && error.details.some((detail) => (
      /凭据|符号链接|逃出 Candidate|超出 .*可写边界|manifest|sha256/u.test(detail)
    ))
}

function publicFailure(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    details: Array.isArray(error?.details) ? error.details : [],
  }
}

function validateMutationReport(input, proposalId) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('Mutation report 必须是对象')
  }
  if (input.proposalId !== proposalId) errors.push('proposalId 与冻结 Proposal 不一致')
  if (typeof input.diagnosis !== 'string' || input.diagnosis.trim().length === 0) {
    errors.push('diagnosis 必须是非空字符串')
  }
  for (const field of ['changedFiles', 'checks', 'remainingRisks']) {
    if (!Array.isArray(input[field])) errors.push(`${field} 必须是数组`)
  }
  if (Array.isArray(input.changedFiles)
      && input.changedFiles.some((path) => typeof path !== 'string' || path.length === 0)) {
    errors.push('changedFiles 只能包含非空字符串')
  }
  if (errors.length > 0) throw new ProtocolError('Mutation report contract 校验失败', errors)
  return structuredClone(input)
}

function validateBundle(input, round, incumbentDigest) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('Mutation bundle 必须是对象')
  }
  if (input.apiVersion !== 'harness-rsi/v1alpha1') errors.push('apiVersion 无效')
  if (input.kind !== 'MutationBundle') errors.push('kind 必须是 MutationBundle')
  for (const field of ['candidateId', 'parentId', 'level', 'proposalId']) {
    if (input[field] !== round[field]) errors.push(`${field} 与 in-flight round 不一致`)
  }
  if (!['completed', 'candidate_failure'].includes(input.outcome)) errors.push('outcome 无效')
  if (round.outcome !== undefined && input.outcome !== round.outcome) {
    errors.push('outcome 与 proposal checkpoint 不一致')
  }
  for (const field of ['workspaceDigest', 'candidateDigest']) {
    if (!SHA256_PATTERN.test(input[field] ?? '')) errors.push(`${field} 必须是 sha256`)
  }
  if (input.outcome === 'completed') {
    if (input.evaluationCandidateId !== round.candidateId) errors.push('completed evaluationCandidateId 无效')
    if (input.candidateDigest !== input.workspaceDigest) errors.push('completed digest 不一致')
  } else {
    if (input.evaluationCandidateId !== round.parentId) errors.push('failure evaluationCandidateId 无效')
    if (input.candidateDigest !== incumbentDigest || input.workspaceDigest !== incumbentDigest) {
      errors.push('failure bundle 必须绑定 incumbent digest')
    }
  }
  try {
    validateMutationReport(input.mutationReport, round.proposalId)
  } catch (error) {
    errors.push(...(error.details?.length ? error.details : [error.message]))
  }
  if (!input.diff || typeof input.diff !== 'object' || Array.isArray(input.diff)
      || input.diff.level !== round.level) {
    errors.push('diff 与 mutation level 不一致')
  }
  if (input.outcome === 'completed' && input.diff?.afterDigest !== input.workspaceDigest) {
    errors.push('diff.afterDigest 与 workspaceDigest 不一致')
  }
  if (errors.length > 0) throw new ProtocolError('Mutation bundle 校验失败', errors)
  return structuredClone(input)
}

function proposalDisposition(proposal) {
  return proposal.controllerDisposition?.outcome === 'candidate_failure'
    && proposal.controllerDisposition?.failureKind === 'proposal_contract'
    ? 'candidate_failure'
    : 'completed'
}

export class InfrastructureError extends Error {
  constructor(operation, message, cause) {
    super(message)
    this.name = 'InfrastructureError'
    this.kind = 'infrastructure'
    this.operation = operation
    this.cause = cause
  }
}

export class EvolutionOrchestrator {
  constructor({
    loadedCampaign,
    campaignsRoot,
    campaignId,
    sourceRoot,
    runtime,
    clock = () => new Date(),
    progress = () => {},
    updaterUid = process.getuid?.() ?? 0,
    updaterGid = process.getgid?.() ?? 0,
    trustedUid = process.getuid?.() ?? 0,
    trustedGid = process.getgid?.() ?? 0,
    secretValues = [],
    runtimeSnapshot = null,
    implementationFingerprint = null,
  }) {
    if (!loadedCampaign?.config || !loadedCampaign?.manifests || !loadedCampaign?.fingerprint) {
      throw new ProtocolError('EvolutionOrchestrator 需要已校验的 loadedCampaign')
    }
    for (const method of ['buildCandidate', 'propose', 'apply', 'evaluateValidation', 'evaluateTest']) {
      if (typeof runtime?.[method] !== 'function') throw new ProtocolError(`Runtime 缺少 ${method}()`)
    }
    this.loaded = loadedCampaign
    this.config = loadedCampaign.config
    this.campaignId = campaignId
    this.sourceRoot = sourceRoot
    this.runtime = runtime
    this.clock = clock
    this.progress = progress
    this.updaterUid = updaterUid
    this.updaterGid = updaterGid
    this.trustedUid = trustedUid
    this.trustedGid = trustedGid
    this.secretValues = secretValues
    if (runtimeSnapshot !== null && !SHA256_PATTERN.test(implementationFingerprint ?? '')) {
      throw new ProtocolError('runtimeSnapshot 需要 64 位 implementationFingerprint')
    }
    this.frozenConfig = runtimeSnapshot === null
      ? this.config
      : {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'CampaignRuntimeSnapshot',
          campaign: this.config,
          runtime: structuredClone(runtimeSnapshot),
          implementationFingerprint,
        }
    this.store = new CampaignStore(campaignsRoot, campaignId)
  }

  async #readState() {
    const state = await this.store.readState()
    if (state.configFingerprint !== this.loaded.fingerprint) {
      throw new ProtocolError('Campaign 配置或 Runtime 指纹与冻结 state 不一致')
    }
    return state
  }

  async initialize() {
    const state = createCampaignState({
      campaignId: this.campaignId,
      configFingerprint: this.loaded.fingerprint,
      at: now(this.clock),
    })
    await this.store.initialize({ config: this.frozenConfig, state })
    return this.#freezeBaseline(state)
  }

  async #freezeBaseline(initialState) {
    let state = initialState
    const workspace = candidateWorkspacePath(this.store.root, 'baseline')
    // CONFIG_FROZEN is the only recovery point before the immutable baseline
    // digest is committed. A prior crash may have left a partial extraction;
    // remove only that exact campaign-owned workspace and materialize it again.
    await rm(workspace, { recursive: true, force: true })
    this.progress({ type: 'baseline-materialize-started', candidateId: 'baseline' })
    await materializePinnedSource({
      sourceRoot: this.sourceRoot,
      revision: this.config.spec.solver.targetRevision,
      destination: workspace,
    })
    await freezeCandidatePermissions({
      candidateRoot: workspace,
      trustedUid: this.trustedUid,
      trustedGid: this.trustedGid,
    })
    const digest = digestSnapshot(await snapshotTree(workspace))
    state = freezeBaseline(state, { candidateId: 'baseline', digest, at: now(this.clock) })
    await this.store.saveState(state)
    this.progress({ type: 'baseline-frozen', candidateId: 'baseline', digest })
    return state
  }

  async resume() {
    let state = await this.#readState()
    if (state.status !== 'PAUSED_INFRASTRUCTURE') throw new ProtocolError('Campaign 当前不是 PAUSED_INFRASTRUCTURE')
    state = resumeInfrastructure(state, { at: now(this.clock) })
    await this.store.saveState(state)
    return this.run()
  }

  async run() {
    let state = await this.#readState()
    try {
      if (state.status === 'CONFIG_FROZEN') state = await this.#freezeBaseline(state)
      if (state.status === 'BASELINE_FROZEN') state = await this.#runBaseline(state)
      while (['EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3'].includes(state.status)) {
        if (!state.inFlight) state = await this.#startRound(state)
        state = await this.#continueRound(state)
      }
      if (state.status === 'CLOSING') {
        state = closeCampaign(state, { at: now(this.clock) })
        await this.store.saveState(state)
        this.progress({ type: 'campaign-closed', candidateId: state.incumbent.candidateId })
      }
      return state
    } catch (error) {
      if (isInfrastructureError(error)) {
        const current = await this.#readState()
        if (current.status !== 'PAUSED_INFRASTRUCTURE') {
          const paused = pauseInfrastructure(current, {
            operation: error.operation ?? 'runtime',
            message: error.message,
            at: now(this.clock),
          })
          await this.store.saveState(paused)
          this.progress({ type: 'infrastructure-paused', operation: error.operation ?? 'runtime' })
          return paused
        }
      }
      throw error
    }
  }

  async report() {
    let state = await this.#readState()
    if (!['CLOSED', 'REPORTED'].includes(state.status)) throw new ProtocolError('Campaign 关闭前不能生成报告')
    const validationAggregates = await this.store.readValidationAggregates(state)
    const testAggregates = await this.store.readSealedAggregates(state)
    const proposals = []
    for (const candidate of state.candidates.slice(1)) proposals.push(await this.store.readProposal(candidate.candidateId))
    const result = await writeCampaignReport(this.store.reportRoot, {
      campaignState: state,
      validationAggregates,
      testAggregates,
      proposals,
    })
    if (state.status === 'CLOSED') {
      state = markReported(state, { at: now(this.clock) })
      await this.store.saveState(state)
    }
    return { state, ...result }
  }

  async #runBaseline(state) {
    const candidateId = 'baseline'
    const workspace = candidateWorkspacePath(this.store.root, candidateId)
    let build = await this.store.readCandidateArtifactIfExists(candidateId, 'build.json')
    if (!build) {
      this.progress({ type: 'build-started', candidateId })
      build = await this.runtime.buildCandidate({ candidateId, candidateRoot: workspace, level: 'baseline' })
      await this.store.writeCandidateArtifact(candidateId, 'build.json', build)
    }
    if (!build?.ok) throw new InfrastructureError('baseline-build', '冻结 Baseline 无法构建')
    if (typeof build.runtimeRoot !== 'string') throw new InfrastructureError('baseline-build', 'Baseline build 缺少 runtimeRoot')
    const validation = await this.#validation(candidateId, build.runtimeRoot)
    const testReceipt = await this.#test(candidateId, build.runtimeRoot)
    state = recordBaselineEvaluation(state, {
      validationVerified: validation.verified,
      validationTotal: validation.total,
      testReceipt,
      at: now(this.clock),
    })
    await this.store.saveState(state)
    this.progress({ type: 'baseline-evaluated', candidateId, validationVerified: validation.verified })
    return state
  }

  async #startRound(state) {
    const ordinal = candidateOrdinal(state)
    const candidateId = `c${ordinal}-${state.activeLevel}`
    const proposalId = `p${ordinal}-${state.activeLevel}`
    state = startCandidateRound(state, { candidateId, proposalId, at: now(this.clock) })
    await this.store.saveState(state)
    this.progress({ type: 'round-started', candidateId, level: state.activeLevel })
    return state
  }

  async #continueRound(initialState) {
    let state = initialState
    while (state.inFlight) {
      switch (state.inFlight.stage) {
        case 'started':
          state = await this.#proposalStage(state)
          break
        case 'proposal_frozen':
          state = await this.#mutationStage(state)
          break
        case 'mutation_frozen':
          state = await this.#buildStage(state)
          break
        case 'built':
          state = await this.#validationStage(state)
          break
        case 'validation_complete':
          state = await this.#testStage(state)
          break
        case 'test_sealed':
          state = await this.#decisionStage(state)
          break
        default:
          throw new ProtocolError(`未知 in-flight stage：${state.inFlight.stage}`)
      }
    }
    return state
  }

  async #resetCandidateWorkspace(state) {
    const workspace = candidateWorkspacePath(this.store.root, state.inFlight.candidateId)
    await rm(workspace, { recursive: true, force: true })
    const incumbent = candidateWorkspacePath(this.store.root, state.incumbent.candidateId)
    await copyCandidate({ incumbentRoot: incumbent, destination: workspace })
    return workspace
  }

  #validateRoundProposal(round, input) {
    const proposal = validateMutationProposal(input, {
      campaignId: this.campaignId,
      candidateId: round.candidateId,
      parentId: round.parentId,
      level: round.level,
      validationIds: this.loaded.manifests.validation,
    })
    if (proposal.proposalId !== round.proposalId) {
      throw new ProtocolError('MutationProposal proposalId 与 in-flight round 不一致')
    }
    return proposal
  }

  #proposalContractFailure(round, createdAt) {
    return this.#validateRoundProposal(round, {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'MutationProposal',
      proposalId: round.proposalId,
      campaignId: this.campaignId,
      candidateId: round.candidateId,
      parentId: round.parentId,
      level: round.level,
      createdAt,
      model: { model: 'gpt-5.6-sol', effort: 'max' },
      direction: 'Proposal contract failure',
      hypothesis: 'The updater did not produce a proposal that the frozen Controller contract can apply.',
      evidence: [{ observation: 'The Controller rejected the updater proposal output before source mutation.' }],
      intendedFiles: [FAILURE_INTENDED_FILES[round.level]],
      expectedEffect: 'No mutation is applied; the incumbent is evaluated under this candidate ID.',
      risks: ['This round is counted as a non-improving candidate failure.'],
      controllerDisposition: {
        outcome: 'candidate_failure',
        failureKind: 'proposal_contract',
      },
    })
  }

  async #checkpointProposal(state, proposal, { recovered = false } = {}) {
    const outcome = proposalDisposition(proposal)
    const details = {
      proposalId: proposal.proposalId,
      ...(outcome === 'candidate_failure' ? {
        outcome,
        candidateDigest: state.incumbent.digest,
        evaluationCandidateId: state.inFlight.parentId,
      } : {}),
    }
    const next = checkpointCandidateRound(state, {
      stage: 'proposal_frozen',
      at: now(this.clock),
      details,
    })
    await this.store.saveState(next)
    this.progress({
      type: 'proposal-frozen',
      candidateId: state.inFlight.candidateId,
      direction: proposal.direction,
      ...(recovered ? { recovered: true } : {}),
    })
    return next
  }

  async #proposalStage(state) {
    const round = state.inFlight
    const frozen = await this.store.readProposalIfExists(round.candidateId)
    if (frozen) {
      const proposal = this.#validateRoundProposal(round, frozen)
      return this.#checkpointProposal(state, proposal, { recovered: true })
    }
    const workspace = await this.#resetCandidateWorkspace(state)
    await this.store.grantCandidateAccess(round.candidateId, this.updaterGid)
    const feedbackRoot = await this.store.prepareUpdaterFeedbackProjection()
    await this.store.grantFeedbackAccess(this.updaterGid)
    let proposal
    const createdAt = now(this.clock)
    try {
      const updaterProposal = await this.runtime.propose({
        campaignId: this.campaignId,
        candidateId: round.candidateId,
        parentId: round.parentId,
        level: round.level,
        candidateRoot: workspace,
        feedbackRoot,
        proposalId: round.proposalId,
        createdAt: UPDATER_LOGICAL_TIMESTAMP,
      })
      proposal = this.#validateRoundProposal(round, updaterProposal)
      if (proposal.createdAt !== UPDATER_LOGICAL_TIMESTAMP) {
        throw new ProtocolError('Updater 必须原样返回 Controller 的 logical createdAt')
      }
      proposal = this.#validateRoundProposal(round, { ...proposal, createdAt })
    } catch (error) {
      if (isInfrastructureError(error)) throw error
      proposal = this.#proposalContractFailure(round, createdAt)
    }
    proposal = this.#validateRoundProposal(round, redactSecrets(proposal, this.secretValues))
    await this.store.writeProposal(round.candidateId, proposal)
    return this.#checkpointProposal(state, proposal)
  }

  async #mutationStage(state) {
    const round = state.inFlight
    const proposal = await this.store.readProposal(round.candidateId)
    this.#validateRoundProposal(round, proposal)

    const frozenBundle = await this.store.readMutationBundleIfExists(round.candidateId)
    if (frozenBundle) return this.#checkpointMutation(state, frozenBundle, { recovered: true })

    let workspace = await this.#resetCandidateWorkspace(state)
    let outcome = round.outcome ?? 'completed'
    let candidateDigest = state.incumbent.digest
    let evaluationCandidateId = round.parentId
    let mutationReport
    let diff

    if (outcome === 'candidate_failure') {
      mutationReport = {
        proposalId: proposal.proposalId,
        diagnosis: 'Updater proposal output did not satisfy the frozen Controller contract.',
        changedFiles: [],
        checks: [],
        remainingRisks: ['The incumbent is reused and this round counts as a miss.'],
      }
      diff = {
        level: round.level,
        valid: false,
        failure: { name: 'ProposalContractFailure', message: 'No source mutation was applied.', details: [] },
        changes: [],
      }
      await freezeCandidatePermissions({
        candidateRoot: workspace,
        trustedUid: this.trustedUid,
        trustedGid: this.trustedGid,
      })
      candidateDigest = digestSnapshot(await snapshotTree(workspace))
      if (candidateDigest !== state.incumbent.digest) {
        throw new ProtocolError('Proposal failure workspace 与 incumbent digest 不一致')
      }
    } else {
      await this.store.grantCandidateAccess(round.candidateId, this.updaterGid)
      await applyMutationBoundary({
        candidateRoot: workspace,
        level: round.level,
        updaterUid: this.updaterUid,
        updaterGid: this.updaterGid,
        trustedUid: this.trustedUid,
        trustedGid: this.trustedGid,
      })
      const before = await snapshotTree(workspace)
      try {
        mutationReport = await this.runtime.apply({
          campaignId: this.campaignId,
          candidateId: round.candidateId,
          parentId: round.parentId,
          level: round.level,
          candidateRoot: workspace,
          proposal: updaterProposalProjection(proposal),
        })
        mutationReport = validateMutationReport(mutationReport, proposal.proposalId)
        const after = await snapshotTree(workspace)
        diff = await validateMutation({
          before,
          after,
          candidateRoot: workspace,
          level: round.level,
          secretValues: this.secretValues,
        })
        await freezeCandidatePermissions({
          candidateRoot: workspace,
          trustedUid: this.trustedUid,
          trustedGid: this.trustedGid,
        })
        candidateDigest = digestSnapshot(await snapshotTree(workspace))
        diff = { ...diff, afterDigest: candidateDigest }
        evaluationCandidateId = round.candidateId
      } catch (error) {
        if (isInfrastructureError(error)) throw error
        if (isFatalSecurityError(error)) {
          const aborted = abortSecurity(state, { reason: error.message, at: now(this.clock) })
          await this.store.saveState(aborted)
          throw error
        }
        outcome = 'candidate_failure'
        evaluationCandidateId = round.parentId
        workspace = await this.#resetCandidateWorkspace(state)
        await freezeCandidatePermissions({
          candidateRoot: workspace,
          trustedUid: this.trustedUid,
          trustedGid: this.trustedGid,
        })
        candidateDigest = digestSnapshot(await snapshotTree(workspace))
        if (candidateDigest !== state.incumbent.digest) {
          throw new ProtocolError('Apply failure rollback 与 incumbent digest 不一致')
        }
        const failure = redactSecrets(publicFailure(error), this.secretValues)
        mutationReport = {
          proposalId: proposal.proposalId,
          diagnosis: 'Updater mutation did not satisfy the frozen Controller contract.',
          changedFiles: [],
          checks: [],
          remainingRisks: [failure],
        }
        diff = { level: round.level, valid: false, failure, changes: [] }
      }
    }

    const bundle = validateBundle(redactSecrets({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'MutationBundle',
      candidateId: round.candidateId,
      parentId: round.parentId,
      level: round.level,
      proposalId: round.proposalId,
      outcome,
      workspaceDigest: candidateDigest,
      candidateDigest,
      evaluationCandidateId,
      mutationReport,
      diff,
    }, this.secretValues), round, state.incumbent.digest)
    await this.store.writeMutationBundle(round.candidateId, bundle)
    return this.#checkpointMutation(state, bundle)
  }

  async #checkpointMutation(state, input, { recovered = false } = {}) {
    const round = state.inFlight
    const bundle = validateBundle(input, round, state.incumbent.digest)
    const workspace = candidateWorkspacePath(this.store.root, round.candidateId)
    let actualDigest
    try {
      actualDigest = digestSnapshot(await snapshotTree(workspace))
    } catch (error) {
      const reason = `Frozen mutation workspace unavailable: ${error.message}`
      const aborted = abortSecurity(state, { reason, at: now(this.clock) })
      await this.store.saveState(aborted)
      throw new ProtocolError(reason)
    }
    if (actualDigest !== bundle.workspaceDigest) {
      const reason = 'Frozen mutation workspace digest does not match mutation bundle'
      const aborted = abortSecurity(state, { reason, at: now(this.clock) })
      await this.store.saveState(aborted)
      throw new ProtocolError(reason, [
        `expected sha256 ${bundle.workspaceDigest}`,
        `actual sha256 ${actualDigest}`,
      ])
    }
    const next = checkpointCandidateRound(state, {
      stage: 'mutation_frozen',
      at: now(this.clock),
      details: {
        outcome: bundle.outcome,
        candidateDigest: bundle.candidateDigest,
        evaluationCandidateId: bundle.evaluationCandidateId,
      },
    })
    await this.store.saveState(next)
    this.progress({
      type: 'mutation-frozen',
      candidateId: round.candidateId,
      outcome: bundle.outcome,
      ...(recovered ? { recovered: true } : {}),
    })
    return next
  }

  async #buildStage(state) {
    const round = state.inFlight
    let build = await this.store.readCandidateArtifactIfExists(round.candidateId, 'build.json')
    let outcome = round.outcome
    let evaluationCandidateId = round.evaluationCandidateId
    let candidateDigest = round.candidateDigest
    let evaluationRoot
    if (!build) {
      if (outcome === 'candidate_failure') {
        const incumbentBuild = await this.store.readCandidateArtifact(evaluationCandidateId, 'build.json')
        if (!incumbentBuild.ok || typeof incumbentBuild.runtimeRoot !== 'string') {
          throw new InfrastructureError('candidate-build', '无法复用 incumbent runtime')
        }
        evaluationRoot = incumbentBuild.runtimeRoot
        build = { ok: true, reusedIncumbent: true, candidateId: evaluationCandidateId, runtimeRoot: evaluationRoot }
      } else {
        this.progress({ type: 'build-started', candidateId: round.candidateId })
        try {
          build = await this.runtime.buildCandidate({
            candidateId: round.candidateId,
            candidateRoot: candidateWorkspacePath(this.store.root, round.candidateId),
            level: round.level,
          })
        } catch (error) {
          if (isInfrastructureError(error)) throw error
          throw new InfrastructureError('candidate-build', 'Candidate 构建运行器失败', error)
        }
        if (!build?.ok) {
          if (build?.kind === 'infrastructure') {
            throw new InfrastructureError('candidate-build', build.message ?? 'Candidate build infrastructure failure')
          }
          const failedBuild = build
          outcome = 'candidate_failure'
          evaluationCandidateId = round.parentId
          candidateDigest = state.incumbent.digest
          const incumbentBuild = await this.store.readCandidateArtifact(evaluationCandidateId, 'build.json')
          if (!incumbentBuild.ok || typeof incumbentBuild.runtimeRoot !== 'string') {
            throw new InfrastructureError('candidate-build', '无法复用 incumbent runtime')
          }
          evaluationRoot = incumbentBuild.runtimeRoot
          build = {
            ok: true,
            reusedIncumbent: true,
            candidateId: evaluationCandidateId,
            runtimeRoot: evaluationRoot,
            candidateBuild: failedBuild,
          }
        } else {
          evaluationRoot = build.runtimeRoot
        }
      }
      await this.store.writeCandidateArtifact(round.candidateId, 'build.json', build)
    } else {
      evaluationRoot = build.runtimeRoot
      if (build.reusedIncumbent === true) {
        if (build.candidateId !== round.parentId) {
          throw new ProtocolError('Frozen reused build 与 in-flight parent 不一致')
        }
        outcome = 'candidate_failure'
        evaluationCandidateId = round.parentId
        candidateDigest = state.incumbent.digest
      }
    }
    if (typeof evaluationRoot !== 'string') throw new InfrastructureError('candidate-build', 'Candidate build 缺少 runtimeRoot')
    state = checkpointCandidateRound(state, {
      stage: 'built',
      at: now(this.clock),
      details: { outcome, candidateDigest, evaluationCandidateId, evaluationRoot },
    })
    await this.store.saveState(state)
    return state
  }

  async #validationStage(state) {
    const round = state.inFlight
    const summary = await this.#validation(round.candidateId, round.evaluationRoot)
    state = checkpointCandidateRound(state, {
      stage: 'validation_complete',
      at: now(this.clock),
      details: { validationVerified: summary.verified, validationTotal: summary.total },
    })
    await this.store.saveState(state)
    this.progress({
      type: 'validation-complete',
      candidateId: round.candidateId,
      validationVerified: summary.verified,
    })
    return state
  }

  async #testStage(state) {
    const round = state.inFlight
    const receipt = await this.#test(round.candidateId, round.evaluationRoot)
    state = checkpointCandidateRound(state, {
      stage: 'test_sealed', at: now(this.clock), details: { testReceipt: receipt },
    })
    await this.store.saveState(state)
    this.progress({ type: 'test-sealed', candidateId: round.candidateId, receiptId: receipt.receiptId })
    return state
  }

  async #decisionStage(state) {
    const round = state.inFlight
    state = recordCandidateEvaluation(state, {
      candidateId: round.candidateId,
      parentId: round.parentId,
      level: round.level,
      digest: round.candidateDigest,
      proposalId: round.proposalId,
      validationVerified: round.validationVerified,
      validationTotal: round.validationTotal,
      testReceipt: round.testReceipt,
      outcome: round.outcome,
      at: now(this.clock),
    })
    await this.store.saveState(state)
    const record = state.candidates.at(-1)
    this.progress({
      type: 'candidate-decided',
      candidateId: record.candidateId,
      level: record.level,
      decision: record.decision,
      validationVerified: record.validationVerified,
    })
    return state
  }

  async #validation(candidateId, candidateRoot) {
    const existing = await this.store.readValidationSummaryIfExists(candidateId)
    if (existing) return existing
    let result
    try {
      result = await this.runtime.evaluateValidation({
        candidateId,
        candidateRoot,
        instanceIds: this.loaded.manifests.validation,
      })
    } catch (error) {
      throw new InfrastructureError('validation-evaluation', 'Validation evaluation infrastructure failure', error)
    }
    await this.store.writeValidation(candidateId, result, this.secretValues)
    return result.summary
  }

  async #test(candidateId, candidateRoot) {
    const existing = await this.store.readTestReceiptIfExists(candidateId)
    if (existing) return existing
    this.progress({ type: 'test-started', candidateId })
    try {
      return await this.runtime.evaluateTest({
        candidateId,
        candidateRoot,
      })
    } catch (error) {
      throw new InfrastructureError('sealed-test-evaluation', 'Sealed test evaluation infrastructure failure', error)
    }
  }
}
