import { join } from 'node:path'

import {
  checkpointCandidateRound,
  closeCampaign,
  createCampaignState,
  DEFAULT_TEST_EVALUATION_INTERVAL,
  freezeBaseline,
  markReported,
  pauseInfrastructure,
  recordBaselineEvaluation,
  recordCandidateEvaluation,
  resumeInfrastructure,
  startCandidateRound,
  stopEvolutionByUpdater,
} from './campaign.mjs'
import { CampaignStore, redactSecrets } from './campaign-store.mjs'
import { LinearGitWorkspace } from './linear-git-workspace.mjs'
import { ProtocolError } from './protocol.mjs'
import { writeCampaignReport } from './reporting.mjs'

function now(clock) {
  return clock().toISOString()
}

function candidateOrdinal(state) {
  return state.candidates.length.toString().padStart(4, '0')
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u
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
const EVOLVING_STATUSES = new Set([
  'EVOLVING',
  'EVOLVING_L1',
  'EVOLVING_L2',
  'EVOLVING_L3',
])

export function shouldEvaluateCandidateTest(
  candidateSequence,
  interval = DEFAULT_TEST_EVALUATION_INTERVAL,
) {
  if (!Number.isSafeInteger(candidateSequence) || candidateSequence < 1
      || !Number.isSafeInteger(interval) || interval < 0) {
    throw new ProtocolError('Candidate test schedule 参数无效')
  }
  return interval !== 0 && candidateSequence % interval === 0
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
    current = current.cause
  }
  return false
}

function publicFailure(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    details: Array.isArray(error?.details) ? error.details : [],
  }
}

function validateMutationArtifact(input, round, incumbent, { softLayers = false } = {}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('Mutation artifact 必须是对象')
  }
  if (input.apiVersion !== 'harness-rsi/v1alpha1') errors.push('apiVersion 无效')
  if (input.kind !== 'UpdaterMutation') errors.push('kind 必须是 UpdaterMutation')
  for (const field of ['candidateId', 'parentId']) {
    if (input[field] !== round[field]) errors.push(field + ' 与当前轮次不一致')
  }
  if (softLayers) {
    const validSelected = ['l1', 'l2', 'l3'].includes(input.level)
    const validUnselectedFailure = input.level === 'unselected'
      && input.outcome === 'candidate_failure'
    const validStop = input.level === 'unselected' && input.outcome === 'stopped'
    if (!validSelected && !validUnselectedFailure && !validStop) errors.push('level 无效')
    if (round.level !== 'unselected' && input.level !== round.level) {
      errors.push('level 与已选择层级不一致')
    }
  } else if (input.level !== round.level) {
    errors.push('level 与当前轮次不一致')
  }
  if (!['completed', 'candidate_failure', 'stopped'].includes(input.outcome)) errors.push('outcome 无效')
  if (!COMMIT_PATTERN.test(input.parentCommit ?? '')
      || input.parentCommit !== incumbent.commit) {
    errors.push('parentCommit 与 incumbent 不一致')
  }
  if (!SHA256_PATTERN.test(input.digest ?? '')) errors.push('digest 无效')
  if (!Number.isSafeInteger(input.updaterDurationMs) || input.updaterDurationMs < 0) {
    errors.push('updaterDurationMs 无效')
  }
  if (input.outcome === 'completed') {
    if (!COMMIT_PATTERN.test(input.commit ?? '') || input.commit === input.parentCommit) {
      errors.push('completed mutation commit 无效')
    }
    if (typeof input.direction !== 'string' || input.direction.trim().length === 0) {
      errors.push('completed mutation direction 无效')
    }
    if (!Array.isArray(input.changedFiles) || input.changedFiles.length === 0
        || !Array.isArray(input.changes) || input.changes.length === 0) {
      errors.push('completed mutation changes 无效')
    }
  } else if (input.outcome === 'candidate_failure') {
    if (input.digest !== incumbent.digest) errors.push('failure mutation 必须复用 incumbent digest')
    if (!input.failure || typeof input.failure !== 'object') errors.push('failure mutation 缺少 failure')
  } else if (input.outcome === 'stopped') {
    if (!softLayers || input.digest !== incumbent.digest
        || typeof input.direction !== 'string' || input.direction.trim().length === 0
        || input.commit !== undefined
        || !Array.isArray(input.changedFiles) || input.changedFiles.length !== 0
        || !Array.isArray(input.changes) || input.changes.length !== 0) {
      errors.push('stopped mutation 无效')
    }
  }
  if (errors.length > 0) throw new ProtocolError('Mutation artifact 校验失败', errors)
  return structuredClone(input)
}

function zeroUsage() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
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
    for (const method of ['buildCandidate', 'mutate', 'evaluateValidation', 'evaluateTest']) {
      if (typeof runtime?.[method] !== 'function') {
        throw new ProtocolError('Runtime 缺少 ' + method + '()')
      }
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
    this.store = new CampaignStore(campaignsRoot, campaignId, { trustedUid })
    this.workspace = join(this.store.candidatesRoot, 'baseline', 'workspace')
    this.linearGit = new LinearGitWorkspace({
      campaignRoot: this.store.root,
      sourceRoot: this.sourceRoot,
      workspace: this.workspace,
      targetRevision: this.config.spec.solver.targetRevision,
      updaterUid,
      updaterGid,
      trustedUid,
      mutationPolicy: runtime.mutationPolicy,
    })
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
      benchmark: this.config.spec.source.format ?? 'putnambench-lean',
      partitionTotals: {
        validation: this.config.spec.partitions.validation.expectedCount,
        test: this.config.spec.partitions.test.expectedCount,
      },
      layerSelection: this.config.spec.evolution.layerSelection,
    })
    await this.store.initialize({ config: this.frozenConfig, state })
    return this.#freezeBaseline(state)
  }

  async #freezeBaseline(initialState) {
    this.progress({ type: 'baseline-materialize-started', candidateId: 'baseline' })
    await this.linearGit.initialize()
    const baseline = await this.linearGit.current()
    if (baseline.commit !== this.config.spec.solver.targetRevision) {
      throw new ProtocolError('Linear baseline commit 与冻结 targetRevision 不一致')
    }
    const state = freezeBaseline(initialState, {
      candidateId: 'baseline',
      digest: baseline.digest,
      commit: baseline.commit,
      at: now(this.clock),
    })
    await this.store.saveState(state)
    this.progress({ type: 'baseline-frozen', candidateId: 'baseline', digest: baseline.digest })
    return state
  }

  async resume(options = {}) {
    let state = await this.#readState()
    if (state.status !== 'PAUSED_INFRASTRUCTURE') {
      throw new ProtocolError('Campaign 当前不是 PAUSED_INFRASTRUCTURE')
    }
    state = resumeInfrastructure(state, { at: now(this.clock) })
    await this.store.saveState(state)
    return this.run(options)
  }

  async run({ roundLimit = 0, baselineOnly = false } = {}) {
    if (!(roundLimit === Number.POSITIVE_INFINITY
        || (Number.isSafeInteger(roundLimit) && roundLimit >= 0))) {
      throw new ProtocolError('roundLimit 必须是非负整数')
    }
    if (typeof baselineOnly !== 'boolean') {
      throw new ProtocolError('baselineOnly 必须是 boolean')
    }
    const effectiveRoundLimit = roundLimit === 0
      ? Number.POSITIVE_INFINITY
      : roundLimit
    let state = await this.#readState()
    let completedRounds = 0
    try {
      if (state.status === 'CONFIG_FROZEN') state = await this.#freezeBaseline(state)
      if (state.status === 'BASELINE_FROZEN') state = await this.#runBaseline(state)
      if (baselineOnly) return state
      while (EVOLVING_STATUSES.has(state.status)
          && completedRounds < effectiveRoundLimit) {
        if (!state.inFlight) state = await this.#startRound(state)
        state = await this.#continueRound(state)
        completedRounds += 1
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
    if (!['CLOSED', 'REPORTED'].includes(state.status)) {
      throw new ProtocolError('Campaign 关闭前不能生成报告')
    }
    const validationAggregates = await this.store.readValidationAggregates(state)
    const testAggregates = await this.store.readSealedAggregates(state)
    const mutations = await this.store.readEvolutionLog()
    const result = await writeCampaignReport(this.store.reportRoot, {
      campaignState: state,
      validationAggregates,
      testAggregates,
      mutations,
    })
    if (state.status === 'CLOSED') {
      state = markReported(state, { at: now(this.clock) })
      await this.store.saveState(state)
    }
    return { state, ...result }
  }

  async #runBaseline(state) {
    const candidateId = 'baseline'
    let build = await this.store.readCandidateArtifactIfExists(candidateId, 'build.json')
    if (!build) {
      this.progress({ type: 'build-started', candidateId })
      build = await this.runtime.buildCandidate({
        candidateId,
        candidateRoot: this.workspace,
        level: 'baseline',
        candidateDigest: state.incumbent.digest,
      })
      await this.store.writeCandidateArtifact(candidateId, 'build.json', build)
    }
    if (!build?.ok || typeof build.runtimeRoot !== 'string') {
      throw new InfrastructureError('baseline-build', '冻结 Baseline 无法构建')
    }
    const validation = await this.#validation(candidateId, build.runtimeRoot)
    const testReceipt = this.config.spec.evolution.testEvaluationInterval === 0
      ? null
      : await this.#test(candidateId, build.runtimeRoot)
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
    const candidateId = state.layerSelection === 'updater-soft'
      ? 'c' + candidateOrdinal(state)
      : 'c' + candidateOrdinal(state) + '-' + state.activeLevel
    state = startCandidateRound(state, { candidateId, at: now(this.clock) })
    await this.store.saveState(state)
    this.progress({ type: 'round-started', candidateId, level: state.activeLevel })
    return state
  }

  async #continueRound(initialState) {
    let state = initialState
    while (state.inFlight) {
      switch (state.inFlight.stage) {
        case 'started':
          state = await this.#mutationStage(state)
          break
        case 'mutated':
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
          throw new ProtocolError('未知 in-flight stage：' + state.inFlight.stage)
      }
    }
    return state
  }

  async #verifyMutationWorkspace(artifact) {
    const current = await this.linearGit.current()
    const expected = artifact.outcome === 'completed' ? artifact.commit : artifact.parentCommit
    if (current.commit !== expected) {
      throw new ProtocolError('Git HEAD 与已记录 Mutation artifact 不一致')
    }
  }

  async #mutationStage(state) {
    const round = state.inFlight
    const softLayers = this.config.spec.evolution.layerSelection === 'updater-soft'
    let artifact = await this.store.readMutationArtifactIfExists(round.candidateId)
    if (artifact) {
      artifact = validateMutationArtifact(artifact, round, state.incumbent, { softLayers })
      await this.#verifyMutationWorkspace(artifact)
    } else {
      const parentCommit = state.incumbent.commit
      if (!COMMIT_PATTERN.test(parentCommit ?? '')) {
        throw new ProtocolError('Incumbent 缺少有效 Git commit')
      }
      await this.store.grantCandidateAccess('baseline', this.updaterGid)
      await this.store.grantEvolutionLogAccess(this.updaterGid)
      await this.linearGit.prepareMutation(parentCommit)
      let updaterDurationMs = 0
      try {
        const updater = await this.runtime.mutate({
          campaignId: this.campaignId,
          candidateId: round.candidateId,
          parentId: round.parentId,
          level: softLayers ? null : round.level,
          candidateRoot: this.workspace,
          gitRoot: this.linearGit.gitRoot,
          feedbackRoot: this.store.validationRoot,
          evolutionLogPath: this.store.evolutionLogPath,
        })
        updaterDurationMs = updater?.durationMs ?? 0
        if (softLayers && updater?.stopReason) {
          await this.linearGit.prepareMutation(parentCommit)
          artifact = {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'UpdaterMutation',
            candidateId: round.candidateId,
            parentId: round.parentId,
            level: 'unselected',
            outcome: 'stopped',
            parentCommit,
            digest: state.incumbent.digest,
            direction: updater.stopReason,
            changedFiles: [],
            changes: [],
            diffStat: '',
            patch: '',
            updaterDurationMs,
          }
        } else {
          const mutation = await this.linearGit.inspectMutation(
            parentCommit,
            softLayers ? null : round.level,
          )
          artifact = {
            apiVersion: 'harness-rsi/v1alpha1',
            kind: 'UpdaterMutation',
            candidateId: round.candidateId,
            parentId: round.parentId,
            level: mutation.level ?? round.level,
            outcome: 'completed',
            updaterDurationMs,
            ...mutation,
          }
        }
      } catch (error) {
        await this.linearGit.rejectMutation(parentCommit)
        if (isInfrastructureError(error)) throw error
        updaterDurationMs = error?.result?.durationMs ?? updaterDurationMs
        artifact = {
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'UpdaterMutation',
          candidateId: round.candidateId,
          parentId: round.parentId,
          level: round.level,
          outcome: 'candidate_failure',
          parentCommit,
          digest: state.incumbent.digest,
          direction: 'updater failure',
          changedFiles: [],
          changes: [],
          diffStat: '',
          patch: '',
          updaterDurationMs,
          failure: publicFailure(error),
        }
      }
      artifact = validateMutationArtifact(
        redactSecrets(artifact, this.secretValues),
        round,
        state.incumbent,
        { softLayers },
      )
      await this.store.writeMutationArtifact(round.candidateId, artifact)
    }

    if (artifact.outcome === 'stopped') {
      const stopped = stopEvolutionByUpdater(state, {
        candidateId: round.candidateId,
        reason: artifact.direction,
        at: now(this.clock),
      })
      await this.store.saveState(stopped)
      this.progress({ type: 'updater-stopped', candidateId: round.candidateId })
      return stopped
    }

    const next = checkpointCandidateRound(state, {
      stage: 'mutated',
      at: now(this.clock),
      details: {
        level: artifact.level,
        outcome: artifact.outcome,
        candidateDigest: artifact.digest,
        parentCommit: artifact.parentCommit,
        ...(artifact.commit === undefined ? {} : { commit: artifact.commit }),
        direction: artifact.direction,
        changedFiles: artifact.changedFiles,
        updaterDurationMs: artifact.updaterDurationMs,
      },
    })
    await this.store.saveState(next)
    this.progress({
      type: 'mutation-committed',
      candidateId: round.candidateId,
      outcome: artifact.outcome,
      direction: artifact.direction,
      updaterDurationMs: artifact.updaterDurationMs,
    })
    return next
  }

  async #buildStage(state) {
    const round = state.inFlight
    let build = await this.store.readCandidateArtifactIfExists(round.candidateId, 'build.json')
    let outcome = round.outcome
    let buildDurationMs = 0
    if (!build) {
      if (outcome === 'candidate_failure') {
        build = { ok: false, skipped: true, reason: 'updater mutation failed' }
      } else {
        this.progress({ type: 'build-started', candidateId: round.candidateId })
        const started = Date.now()
        try {
          build = await this.runtime.buildCandidate({
            candidateId: round.candidateId,
            candidateRoot: this.workspace,
            level: round.level,
            candidateDigest: round.candidateDigest,
          })
        } catch (error) {
          if (isInfrastructureError(error)) throw error
          throw new InfrastructureError('candidate-build', 'Candidate 构建运行器失败', error)
        } finally {
          buildDurationMs = Date.now() - started
        }
        if (!build?.ok) {
          if (build?.kind === 'infrastructure') {
            throw new InfrastructureError(
              'candidate-build',
              build.message ?? 'Candidate build infrastructure failure',
            )
          }
          outcome = 'candidate_failure'
        }
      }
      build = { ...build, durationMs: buildDurationMs }
      await this.store.writeCandidateArtifact(round.candidateId, 'build.json', build)
    } else {
      buildDurationMs = build.durationMs ?? 0
      if (!build.ok) outcome = 'candidate_failure'
    }
    if (outcome === 'completed' && typeof build.runtimeRoot !== 'string') {
      throw new InfrastructureError('candidate-build', 'Candidate build 缺少 runtimeRoot')
    }
    const next = checkpointCandidateRound(state, {
      stage: 'built',
      at: now(this.clock),
      details: {
        outcome,
        buildDurationMs,
        ...(outcome === 'completed' ? { evaluationRoot: build.runtimeRoot } : {}),
      },
    })
    await this.store.saveState(next)
    return next
  }

  async #failedValidation(candidateId, reason) {
    const existing = await this.store.readValidationSummaryIfExists(candidateId)
    if (existing) return existing
    const records = this.loaded.manifests.validation.map((instanceId) => ({
      instanceId,
      status: 'unresolved',
      failureKind: 'candidate',
      solverStatus: 'not_attempted',
      verifierStatus: 'not_attempted',
      attempts: 0,
      verifierAttempts: 0,
      usage: zeroUsage(),
      latencyMs: 0,
      reason,
    }))
    const result = {
      summary: {
        candidateId,
        verified: 0,
        total: records.length,
        completedAt: now(this.clock),
        usage: zeroUsage(),
      },
      records,
      traces: {},
    }
    await this.store.writeValidation(candidateId, result, this.secretValues)
    return result.summary
  }

  async #validationStage(state) {
    const round = state.inFlight
    const started = Date.now()
    const summary = round.outcome === 'completed'
      ? await this.#validation(round.candidateId, round.evaluationRoot)
      : await this.#failedValidation(round.candidateId, 'mutation-or-build-failure')
    const validationDurationMs = Date.now() - started
    const next = checkpointCandidateRound(state, {
      stage: 'validation_complete',
      at: now(this.clock),
      details: {
        validationVerified: summary.verified,
        validationTotal: summary.total,
        validationDurationMs,
      },
    })
    await this.store.saveState(next)
    this.progress({
      type: 'validation-complete',
      candidateId: round.candidateId,
      validationVerified: summary.verified,
      validationDurationMs,
    })
    return next
  }

  async #testStage(state) {
    const round = state.inFlight
    const interval = this.config.spec.evolution.testEvaluationInterval
    const candidateSequence = state.candidates.length
    if (round.outcome !== 'completed'
        || !shouldEvaluateCandidateTest(candidateSequence, interval)) {
      const next = checkpointCandidateRound(state, {
        stage: 'test_sealed',
        at: now(this.clock),
        details: { testEvaluated: false },
      })
      await this.store.saveState(next)
      this.progress({
        type: 'test-skipped',
        candidateId: round.candidateId,
        candidateSequence,
        interval,
      })
      return next
    }
    const receipt = await this.#test(round.candidateId, round.evaluationRoot)
    const next = checkpointCandidateRound(state, {
      stage: 'test_sealed',
      at: now(this.clock),
      details: { testEvaluated: true, testReceipt: receipt },
    })
    await this.store.saveState(next)
    this.progress({
      type: 'test-sealed',
      candidateId: round.candidateId,
      receiptId: receipt.receiptId,
    })
    return next
  }

  async #decisionStage(state) {
    const round = state.inFlight
    const incumbentScore = state.incumbent.validationVerified
    const decidedAt = now(this.clock)
    const next = recordCandidateEvaluation(state, {
      candidateId: round.candidateId,
      parentId: round.parentId,
      level: round.level,
      digest: round.candidateDigest,
      commit: round.commit,
      direction: round.direction,
      validationVerified: round.validationVerified,
      validationTotal: round.validationTotal,
      testReceipt: round.testReceipt,
      testEvaluated: round.testEvaluated,
      outcome: round.outcome,
      at: decidedAt,
    })
    const record = next.candidates.at(-1)
    if (record.decision === 'promoted') {
      await this.linearGit.acceptMutation(round.parentCommit, round.commit)
    } else {
      await this.linearGit.rejectMutation(round.parentCommit)
    }
    const mutation = await this.store.readMutationArtifactIfExists(round.candidateId)
    await this.store.appendEvolutionLog({
      candidateId: record.candidateId,
      parentId: record.parentId,
      level: record.level,
      parentCommit: round.parentCommit,
      commit: round.commit ?? null,
      direction: round.direction,
      commitMessage: mutation?.commitMessage ?? null,
      changedFiles: mutation?.changedFiles ?? [],
      diffStat: mutation?.diffStat ?? '',
      patch: mutation?.patch ?? '',
      incumbentScore,
      validationScore: record.validationVerified,
      validationTotal: record.validationTotal,
      delta: record.validationVerified - incumbentScore,
      outcome: record.outcome,
      decision: record.decision,
      updaterDurationMs: round.updaterDurationMs ?? 0,
      buildDurationMs: round.buildDurationMs ?? 0,
      validationDurationMs: round.validationDurationMs ?? 0,
      roundDurationMs: Math.max(0, Date.parse(decidedAt) - Date.parse(round.startedAt)),
      decidedAt,
    }, this.secretValues)
    await this.store.saveState(next)
    this.progress({
      type: 'candidate-decided',
      candidateId: record.candidateId,
      level: record.level,
      decision: record.decision,
      validationVerified: record.validationVerified,
    })
    return next
  }

  async #validation(candidateId, candidateRoot) {
    const existing = await this.store.readValidationSummaryIfExists(candidateId)
    if (existing) {
      await this.store.grantValidationAccess(candidateId, this.updaterGid)
      return existing
    }
    let result
    try {
      result = await this.runtime.evaluateValidation({
        candidateId,
        candidateRoot,
        instanceIds: this.loaded.manifests.validation,
      })
    } catch (error) {
      throw new InfrastructureError(
        'validation-evaluation',
        'Validation evaluation infrastructure failure',
        error,
      )
    }
    await this.store.writeValidation(candidateId, result, this.secretValues)
    await this.store.grantValidationAccess(candidateId, this.updaterGid)
    return result.summary
  }

  async #test(candidateId, candidateRoot) {
    const existing = await this.store.readTestReceiptIfExists(candidateId)
    if (existing) return existing
    this.progress({ type: 'test-started', candidateId })
    try {
      return await this.runtime.evaluateTest({ candidateId, candidateRoot })
    } catch (error) {
      throw new InfrastructureError(
        'sealed-test-evaluation',
        'Sealed test evaluation infrastructure failure',
        error,
      )
    }
  }
}
