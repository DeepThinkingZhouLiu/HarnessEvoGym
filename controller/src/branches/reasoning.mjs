import { createEvaluationSummary } from '../evaluation-summary.mjs'
import {
  validateBranchProjection,
  validateBranchStepResult,
} from '../branch-evolution-driver.mjs'
import { ProtocolError } from '../protocol.mjs'

const EVOLVING = new Set(['EVOLVING', 'EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3'])
const TERMINAL = new Set(['CLOSED', 'REPORTED'])

function publicStatus(state) {
  if (state.status === 'PAUSED_INFRASTRUCTURE') return 'paused'
  if (TERMINAL.has(state.status)) return 'stopped'
  return 'active'
}

function candidateEvaluation(candidate) {
  if (!candidate || !Number.isInteger(candidate.validationVerified)) return null
  return createEvaluationSummary({
    candidateId: candidate.candidateId,
    metric: 'validation-verified-count',
    value: candidate.validationVerified,
    total: candidate.validationTotal ?? null,
  })
}

function projection(branchId, state, stepId = null) {
  const completedSteps = Math.max(0, (state.candidates?.length ?? 1) - 1)
  const incumbentEvaluation = candidateEvaluation(state.incumbent)
  if (!incumbentEvaluation) throw new ProtocolError(`${branchId} 缺少已评测 Reasoning incumbent`)
  const candidate = completedSteps > 0 ? state.candidates.at(-1) : null
  const evaluation = candidateEvaluation(candidate)
  const decision = candidate?.decision === 'promoted'
    ? 'promoted'
    : candidate?.decision === 'rejected'
      ? 'rejected'
      : candidate
        ? 'invalid'
        : null
  return validateBranchProjection({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BranchProjection',
    branchId,
    status: publicStatus(state),
    completedSteps,
    incumbent: {
      candidateId: state.incumbent.candidateId,
      revision: state.incumbent.commit,
      digest: state.incumbent.digest,
      evaluation: incumbentEvaluation,
    },
    lastStep: candidate
      ? {
          stepId: stepId ?? `reasoning-step-${completedSteps}`,
          stepNumber: completedSteps,
          candidateId: candidate.candidateId ?? null,
          decision,
          ranking: { eligible: decision === 'promoted', evaluation },
        }
      : null,
  })
}

/** 把 HZY 原有 EvolutionOrchestrator 包装成通用 BranchEvolutionDriver。 */
export function createReasoningBranchDriver({ branchId, handle, baseRevision }) {
  const orchestrator = handle?.orchestrator
  if (!orchestrator?.store || !orchestrator?.linearGit
      || typeof orchestrator.initialize !== 'function'
      || typeof orchestrator.run !== 'function'
      || typeof orchestrator.resume !== 'function') {
    throw new ProtocolError(`Reasoning Branch ${branchId} Handle 无效`)
  }
  if (handle.setCoordinationContext !== undefined
      && typeof handle.setCoordinationContext !== 'function') {
    throw new ProtocolError(`Reasoning Branch ${branchId} setCoordinationContext 无效`)
  }

  return {
    async initialize() {
      await orchestrator.initialize()
      return projection(branchId, await orchestrator.run({ baselineOnly: true }))
    },
    async inspect() {
      return projection(branchId, await orchestrator.store.readState())
    },
    async advanceOne({ stepId, coordination }) {
      if (handle.setCoordinationContext) handle.setCoordinationContext(coordination)
      let before = await orchestrator.store.readState()
      const beforeSteps = Math.max(0, (before.candidates?.length ?? 1) - 1)
      if (TERMINAL.has(before.status)) {
        return validateBranchStepResult({
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'BranchStepResult',
          stepId,
          budgetConsumed: 0,
          projection: projection(branchId, before),
        })
      }
      if (before.status !== 'PAUSED_INFRASTRUCTURE' && !EVOLVING.has(before.status)) {
        throw new ProtocolError(`${branchId} 状态不能执行进化轮次：${before.status}`)
      }
      const after = before.status === 'PAUSED_INFRASTRUCTURE'
        ? await orchestrator.resume({ roundLimit: 1 })
        : await orchestrator.run({ roundLimit: 1 })
      const afterSteps = Math.max(0, (after.candidates?.length ?? 1) - 1)
      return validateBranchStepResult({
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'BranchStepResult',
        stepId,
        budgetConsumed: afterSteps > beforeSteps ? 1 : 0,
        projection: projection(branchId, after, afterSteps > beforeSteps ? stepId : null),
      })
    },
    async exportPeerEvidence() {
      return {
        sourcePath: orchestrator.store.evolutionLogPath,
        entries: await orchestrator.store.readEvolutionLog(),
      }
    },
    async exportBest() {
      const state = await orchestrator.store.readState()
      const implementation = await orchestrator.linearGit.implementation(
        baseRevision,
        state.incumbent.commit,
      )
      return {
        candidateId: state.incumbent.candidateId,
        baseRevision: implementation.baseCommit,
        revision: state.incumbent.commit,
        digest: state.incumbent.digest,
        evaluation: candidateEvaluation(state.incumbent),
        changedFiles: implementation.changedFiles,
        diffStat: implementation.diffStat,
        patch: implementation.patch,
        tree: implementation.tree,
        workspace: orchestrator.workspace,
        implementationRoot: orchestrator.linearGit.gitRoot,
      }
    },
  }
}
