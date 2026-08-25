import { relative } from 'node:path'

import { redactSecrets } from './campaign-store.mjs'
import {
  buildCoordinationContext,
  createBudgetPlan,
  modeUsesCompetition,
  modeUsesPeerSharing,
  normalizeControllerConfig,
  selectCompetitionWinner,
  selectPopulationBest,
} from './evolution-modes.mjs'
import { PopulationStore } from './population-store.mjs'
import { ProtocolError } from './protocol.mjs'

const EVOLVING_CHILD_STATES = new Set([
  'EVOLVING', 'EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3',
])
const TERMINAL_CHILD_STATES = new Set(['CLOSED', 'REPORTED'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function iso(clock) {
  return clock().toISOString()
}

function event(state, type, at, details = {}) {
  return {
    sequence: state.events.length + 1,
    type,
    at,
    ...details,
  }
}

function publicIncumbent(childState) {
  const incumbent = childState?.incumbent
  if (!incumbent || !Number.isInteger(incumbent.validationVerified)) {
    throw new ProtocolError('Branch 缺少已评测 incumbent')
  }
  return {
    candidateId: incumbent.candidateId,
    digest: incumbent.digest,
    commit: incumbent.commit,
    validationVerified: incumbent.validationVerified,
    validationTotal: incumbent.validationTotal,
  }
}

function branchRemaining(branch) {
  return branch.baseBudget + branch.bonusBudget - branch.consumed
}

function childStopped(childState) {
  return TERMINAL_CHILD_STATES.has(childState.status)
}

function childPaused(childState) {
  return childState.status === 'PAUSED_INFRASTRUCTURE'
}

function branchStatus(branch, childState) {
  if (childStopped(childState)) return 'stopped'
  return branchRemaining(branch) > 0 ? 'active' : 'exhausted'
}

function assertRoundLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new ProtocolError('Population roundLimit 必须是 0..10000 的整数')
  }
}

function markdownReport(summary) {
  const lines = [
    '# Population Evolution Report',
    '',
    `- Mode: \`${summary.mode}\``,
    `- Total budget: ${summary.budget.totalBudget}`,
    `- Consumed budget: ${summary.budget.consumed}`,
    `- Unused budget: ${summary.budget.unused}`,
    `- Best branch: \`${summary.best.branchId}\``,
    `- Best validation: ${summary.best.validationVerified}/${summary.best.validationTotal}`,
    `- Best commit: \`${summary.best.commit}\``,
    `- Harness implementation: \`best-harness.json\` + \`best-harness.patch\``,
    '',
    '| Branch | Base | Bonus | Consumed | Best validation | Best candidate | Status |',
    '|---|---:|---:|---:|---:|---|---|',
    ...summary.branches.map((branch) => (
      `| ${branch.branchId} | ${branch.baseBudget} | ${branch.bonusBudget} | ${branch.consumed} | ${branch.incumbent.validationVerified}/${branch.incumbent.validationTotal} | ${branch.incumbent.candidateId} | ${branch.status} |`
    )),
    '',
    'Competition awards and per-round deltas are retained in the parent event log; each branch keeps its full mutation history in its own evolution log.',
    '',
  ]
  return lines.join('\n')
}

export function formatPopulationStatus(state) {
  if (!state || state.kind !== 'PopulationCampaignState') {
    throw new ProtocolError('Population status source 格式错误')
  }
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'PopulationCampaignStatus',
    campaignId: state.campaignId,
    mode: state.mode,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    closedAt: state.closedAt ?? null,
    reportAvailable: ['CLOSED', 'REPORTED'].includes(state.status),
    epoch: state.epoch,
    budget: structuredClone(state.budget),
    best: state.best === null ? null : structuredClone(state.best),
    branches: state.branches.map((branch) => ({
      branchId: branch.branchId,
      status: branch.status,
      baseBudget: branch.baseBudget,
      bonusBudget: branch.bonusBudget,
      consumed: branch.consumed,
      remaining: branchRemaining(branch),
      incumbent: branch.incumbent === null ? null : structuredClone(branch.incumbent),
      lastDeltaScore: branch.lastDeltaScore ?? null,
      peerLogPath: branch.peerLogPath,
    })),
  }
}

export class PopulationOrchestrator {
  constructor({
    loadedCampaign,
    campaignsRoot,
    campaignId,
    createBranch,
    clock = () => new Date(),
    progress = () => {},
    frozenConfig = null,
    secretValues = [],
  }) {
    if (!loadedCampaign?.config?.controller_config
        || !SHA256_PATTERN.test(loadedCampaign?.fingerprint ?? '')) {
      throw new ProtocolError('PopulationOrchestrator 需要带 controller_config 的冻结 Campaign')
    }
    if (typeof createBranch !== 'function') {
      throw new ProtocolError('PopulationOrchestrator 需要 createBranch()')
    }
    this.loaded = loadedCampaign
    this.config = loadedCampaign.config
    this.controller = normalizeControllerConfig(this.config.controller_config)
    this.plan = createBudgetPlan(this.controller)
    this.campaignId = campaignId
    this.createBranch = createBranch
    this.clock = clock
    this.progress = progress
    this.frozenConfig = frozenConfig ?? this.config
    this.secretValues = secretValues
    this.store = new PopulationStore(campaignsRoot, campaignId)
    this.handles = new Map()
  }

  async #handle(branchId) {
    if (!this.handles.has(branchId)) {
      this.handles.set(branchId, Promise.resolve(this.createBranch({
        branchId,
        branchesRoot: this.store.branchesRoot,
      })).then((handle) => {
        if (!handle?.orchestrator || typeof handle.orchestrator.initialize !== 'function'
            || typeof handle.orchestrator.run !== 'function'
            || typeof handle.orchestrator.resume !== 'function'
            || !handle.orchestrator.store || !handle.orchestrator.linearGit) {
          throw new ProtocolError(`createBranch(${branchId}) 返回值无效`)
        }
        if (handle.setCoordinationContext !== undefined
            && typeof handle.setCoordinationContext !== 'function') {
          throw new ProtocolError(`createBranch(${branchId}).setCoordinationContext 无效`)
        }
        return handle
      }))
    }
    return this.handles.get(branchId)
  }

  #initialState(at) {
    const branches = this.plan.branches.map(({ branchId, baseBudget }) => ({
      branchId,
      status: 'pending',
      baseBudget,
      bonusBudget: 0,
      consumed: 0,
      incumbent: null,
      lastDeltaScore: null,
      peerLogPath: `/opt/harness-rsi/peer-logs/${branchId}.jsonl`,
    }))
    return {
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'PopulationCampaignState',
      campaignId: this.campaignId,
      configFingerprint: this.loaded.fingerprint,
      mode: this.controller.mode,
      status: 'CONFIG_FROZEN',
      createdAt: at,
      updatedAt: at,
      epoch: 0,
      budget: {
        totalBudget: this.plan.totalBudget,
        consumed: 0,
        beta: this.plan.beta,
        bonusPool: this.plan.bonusPool,
        bonusRemaining: this.plan.bonusPool,
        bonusGranted: 0,
      },
      branches,
      best: null,
      events: [{
        sequence: 1,
        type: 'POPULATION_CONFIG_FROZEN',
        at,
        mode: this.controller.mode,
        totalBudget: this.plan.totalBudget,
      }],
    }
  }

  async initialize() {
    const at = iso(this.clock)
    let state = this.#initialState(at)
    await this.store.initialize({ config: this.frozenConfig, state })
    state = {
      ...state,
      status: 'BASELINE_RUNNING',
      updatedAt: iso(this.clock),
      events: [...state.events, event(state, 'POPULATION_BASELINE_STARTED', iso(this.clock))],
    }
    await this.store.saveState(state)

    const childStates = await Promise.all(state.branches.map(async ({ branchId }) => {
      const handle = await this.#handle(branchId)
      await handle.orchestrator.initialize()
      return handle.orchestrator.run({ baselineOnly: true })
    }))
    const branches = state.branches.map((branch, index) => ({
      ...branch,
      incumbent: publicIncumbent(childStates[index]),
      status: branchStatus(branch, childStates[index]),
    }))
    const bestBranch = selectPopulationBest(branches)
    const completedAt = iso(this.clock)
    state = {
      ...state,
      status: 'EVOLVING',
      updatedAt: completedAt,
      branches,
      best: { branchId: bestBranch.branchId, ...bestBranch.incumbent },
      events: [...state.events, event(state, 'POPULATION_BASELINE_EVALUATED', completedAt, {
        branches: branches.map((branch) => ({
          branchId: branch.branchId,
          validationVerified: branch.incumbent.validationVerified,
        })),
      })],
    }
    await this.store.saveState(state)
    this.progress({ type: 'population-baseline-evaluated', branches: branches.length })
    return state
  }

  async #readState() {
    const state = await this.store.readState()
    if (state.configFingerprint !== this.loaded.fingerprint) {
      throw new ProtocolError('Population 配置或 Runtime 指纹与冻结 state 不一致')
    }
    return state
  }

  async run({ roundLimit = 0 } = {}) {
    assertRoundLimit(roundLimit)
    const waveLimit = roundLimit === 0 ? Number.POSITIVE_INFINITY : roundLimit
    let state = await this.#readState()
    if (state.status === 'PAUSED_INFRASTRUCTURE') {
      throw new ProtocolError('Population 当前暂停；请使用 evolve resume')
    }
    let completedWaves = 0
    while (state.status === 'EVOLVING' && completedWaves < waveLimit) {
      if (!state.inFlightWave) state = await this.#startWave(state)
      if (state.status !== 'EVOLVING') break
      state = await this.#runWave(state)
      if (state.status === 'EVOLVING' && !state.inFlightWave) completedWaves += 1
      if (state.status === 'PAUSED_INFRASTRUCTURE') break
    }
    if (state.status === 'EVOLVING' && !state.inFlightWave
        && !this.#hasRemainingParticipant(state)) {
      state = await this.#close(state)
    }
    if (state.status === 'CLOSED') await this.report()
    return state
  }

  #hasRemainingParticipant(state) {
    if (state.branches.some((branch) => (
      branch.status !== 'stopped' && branchRemaining(branch) > 0
    ))) return true
    return modeUsesCompetition(state.mode)
      && state.budget.bonusRemaining > 0
      && state.branches.some((branch) => branch.status !== 'stopped')
  }

  async resume(options = {}) {
    let state = await this.#readState()
    if (state.status !== 'PAUSED_INFRASTRUCTURE') {
      throw new ProtocolError('Population 当前不是 PAUSED_INFRASTRUCTURE')
    }
    const resumedAt = iso(this.clock)
    state = {
      ...state,
      status: 'EVOLVING',
      updatedAt: resumedAt,
      events: [...state.events, event(state, 'POPULATION_INFRASTRUCTURE_RESUMED', resumedAt)],
    }
    await this.store.saveState(state)
    return this.run(options)
  }

  async #ensureBonusParticipant(state) {
    if (!modeUsesCompetition(state.mode) || state.budget.bonusRemaining === 0) return state
    if (state.branches.some((branch) => branch.status !== 'stopped' && branchRemaining(branch) > 0)) {
      return state
    }
    const eligible = state.branches.filter((branch) => branch.status !== 'stopped')
    if (eligible.length === 0) return state
    const winner = selectPopulationBest(eligible)
    const grant = Math.min(
      this.controller.competition.bonus_grant_unit,
      state.budget.bonusRemaining,
    )
    const at = iso(this.clock)
    return {
      ...state,
      updatedAt: at,
      budget: {
        ...state.budget,
        bonusRemaining: state.budget.bonusRemaining - grant,
        bonusGranted: state.budget.bonusGranted + grant,
      },
      branches: state.branches.map((branch) => branch.branchId === winner.branchId
        ? { ...branch, bonusBudget: branch.bonusBudget + grant, status: 'active' }
        : branch),
      events: [...state.events, event(state, 'COMPETITION_BOOTSTRAP_GRANTED', at, {
        branchId: winner.branchId,
        grant,
        reason: 'no-funded-branch-select-best-incumbent',
      })],
    }
  }

  async #startWave(initialState) {
    let state = await this.#ensureBonusParticipant(initialState)
    const participants = state.branches.filter((branch) => (
      branch.status !== 'stopped' && branchRemaining(branch) > 0
    ))
    if (participants.length === 0) return this.#close(state)

    const snapshots = await Promise.all(participants.map(async (branch) => {
      const handle = await this.#handle(branch.branchId)
      const childState = await handle.orchestrator.store.readState()
      return {
        branchId: branch.branchId,
        beforeCandidates: childState.candidates.length,
        beforeScore: childState.incumbent.validationVerified,
      }
    }))
    const startedAt = iso(this.clock)
    const inFlightWave = {
      epoch: state.epoch + 1,
      startedAt,
      participants: snapshots,
    }
    state = {
      ...state,
      updatedAt: startedAt,
      inFlightWave,
      events: [...state.events, event(state, 'POPULATION_WAVE_STARTED', startedAt, {
        epoch: inFlightWave.epoch,
        participants: snapshots.map((entry) => entry.branchId),
      })],
    }
    await this.#applyCoordinationContexts(state)
    await this.store.saveState(state)
    this.progress({
      type: 'population-wave-started',
      epoch: inFlightWave.epoch,
      branches: snapshots.length,
    })
    return state
  }

  async #applyCoordinationContexts(state) {
    const sharingReady = modeUsesPeerSharing(state.mode) && state.epoch > 0
    const handles = new Map(await Promise.all(state.branches.map(async (branch) => (
      [branch.branchId, await this.#handle(branch.branchId)]
    ))))
    await Promise.all(state.inFlightWave.participants.map(async ({ branchId }) => {
      const handle = handles.get(branchId)
      if (!handle.setCoordinationContext) return
      const peers = sharingReady
        ? state.branches.filter((branch) => (
            branch.branchId !== branchId && branch.consumed > 0
          )).map((branch) => ({
            branchId: branch.branchId,
            sourcePath: handles.get(branch.branchId).orchestrator.store.evolutionLogPath,
          }))
        : []
      handle.setCoordinationContext(buildCoordinationContext({
        controllerConfig: this.controller,
        branchId,
        peerLogs: peers,
        competitionState: { bonusRemaining: state.budget.bonusRemaining },
      }))
    }))
  }

  async #runChildRound(participant) {
    const handle = await this.#handle(participant.branchId)
    let childState = await handle.orchestrator.store.readState()
    if (childState.candidates.length > participant.beforeCandidates + 1) {
      throw new ProtocolError(`${participant.branchId} 超前于 Population wave`)
    }
    if (childState.candidates.length === participant.beforeCandidates + 1
        && !childState.inFlight) return childState
    if (childPaused(childState)) {
      return handle.orchestrator.resume({ roundLimit: 1 })
    }
    if (TERMINAL_CHILD_STATES.has(childState.status)) return childState
    if (!EVOLVING_CHILD_STATES.has(childState.status)) {
      throw new ProtocolError(`${participant.branchId} 状态不能执行进化轮次：${childState.status}`)
    }
    return handle.orchestrator.run({ roundLimit: 1 })
  }

  async #runWave(state) {
    await this.#applyCoordinationContexts(state)
    const childStates = await Promise.all(
      state.inFlightWave.participants.map((participant) => this.#runChildRound(participant)),
    )
    if (childStates.some(childPaused)) {
      const pausedAt = iso(this.clock)
      const paused = {
        ...state,
        status: 'PAUSED_INFRASTRUCTURE',
        updatedAt: pausedAt,
        events: [...state.events, event(state, 'POPULATION_INFRASTRUCTURE_PAUSED', pausedAt, {
          epoch: state.inFlightWave.epoch,
          branches: childStates.flatMap((childState, index) => (
            childPaused(childState) ? [state.inFlightWave.participants[index].branchId] : []
          )),
        })],
      }
      await this.store.saveState(paused)
      return paused
    }

    const results = state.inFlightWave.participants.map((participant, index) => {
      const childState = childStates[index]
      const candidate = childState.candidates[participant.beforeCandidates] ?? null
      const stopped = childStopped(childState)
      if (!stopped && candidate === null) {
        throw new ProtocolError(`${participant.branchId} 未产生本轮 Candidate`)
      }
      const validationScore = candidate?.validationVerified ?? participant.beforeScore
      return {
        branchId: participant.branchId,
        validationScore,
        deltaScore: validationScore - participant.beforeScore,
        candidateId: candidate?.candidateId ?? null,
        decision: candidate?.decision ?? 'stopped',
        eligible: !stopped,
        stopped,
        childState,
      }
    })

    let branches = state.branches.map((branch) => {
      const result = results.find((entry) => entry.branchId === branch.branchId)
      if (!result) return branch
      const consumed = branch.consumed + 1
      const updated = {
        ...branch,
        consumed,
        incumbent: publicIncumbent(result.childState),
        lastDeltaScore: result.deltaScore,
      }
      return { ...updated, status: branchStatus(updated, result.childState) }
    })
    let budget = {
      ...state.budget,
      consumed: state.budget.consumed + results.length,
    }
    let bonusWinner = null
    let bonusGrant = 0
    if (modeUsesCompetition(state.mode) && budget.bonusRemaining > 0) {
      bonusWinner = selectCompetitionWinner(results)
      if (bonusWinner) {
        bonusGrant = Math.min(
          this.controller.competition.bonus_grant_unit,
          budget.bonusRemaining,
        )
        budget = {
          ...budget,
          bonusRemaining: budget.bonusRemaining - bonusGrant,
          bonusGranted: budget.bonusGranted + bonusGrant,
        }
        branches = branches.map((branch) => branch.branchId === bonusWinner.branchId
          ? {
              ...branch,
              bonusBudget: branch.bonusBudget + bonusGrant,
              status: branch.status === 'stopped' ? 'stopped' : 'active',
            }
          : branch)
      }
    }
    const bestBranch = selectPopulationBest(branches)
    const completedAt = iso(this.clock)
    const next = {
      ...state,
      status: 'EVOLVING',
      updatedAt: completedAt,
      epoch: state.inFlightWave.epoch,
      budget,
      branches,
      best: { branchId: bestBranch.branchId, ...bestBranch.incumbent },
      inFlightWave: undefined,
      events: [...state.events, event(state, 'POPULATION_WAVE_COMPLETED', completedAt, {
        epoch: state.inFlightWave.epoch,
        results: results.map((result) => ({
          branchId: result.branchId,
          candidateId: result.candidateId,
          validationScore: result.validationScore,
          deltaScore: result.deltaScore,
          decision: result.decision,
        })),
        ...(bonusWinner ? { bonusWinner: bonusWinner.branchId, bonusGrant } : {}),
      })],
    }
    await this.store.saveState(next)
    this.progress({
      type: 'population-wave-completed',
      epoch: next.epoch,
      branches: results.length,
      ...(bonusWinner ? { branchId: bonusWinner.branchId, bonusGrant } : {}),
    })
    return next
  }

  async #close(state) {
    const closedAt = iso(this.clock)
    const closed = {
      ...state,
      status: 'CLOSED',
      updatedAt: closedAt,
      closedAt,
      events: [...state.events, event(state, 'POPULATION_CLOSED', closedAt, {
        consumedBudget: state.budget.consumed,
        unusedBudget: state.budget.totalBudget - state.budget.consumed,
        bestBranch: state.best.branchId,
      })],
    }
    await this.store.saveState(closed)
    this.progress({ type: 'population-closed', branchId: closed.best.branchId })
    return closed
  }

  async report() {
    const state = await this.#readState()
    if (!['CLOSED', 'REPORTED'].includes(state.status)) {
      throw new ProtocolError('Population 关闭前不能生成报告')
    }
    try {
      const existing = await this.store.readReport()
      return { state, ...existing }
    } catch {
      // Generate the immutable summary from child ledgers below.
    }
    const bestBranch = state.branches.find((branch) => branch.branchId === state.best.branchId)
    const bestHandle = await this.#handle(bestBranch.branchId)
    const implementation = await bestHandle.orchestrator.linearGit.implementation(
      this.config.spec.solver.targetRevision,
      bestBranch.incumbent.commit,
    )
    const branchDetails = await Promise.all(state.branches.map(async (branch) => {
      const handle = await this.#handle(branch.branchId)
      const mutations = await handle.orchestrator.store.readEvolutionLog()
      return {
        ...branch,
        remaining: branchRemaining(branch),
        evolutionLog: relative(this.store.root, handle.orchestrator.store.evolutionLogPath),
        mutations,
      }
    }))
    const summary = redactSecrets({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'PopulationEvolutionReport',
      campaignId: state.campaignId,
      mode: state.mode,
      closedAt: state.closedAt,
      budget: {
        ...state.budget,
        unused: state.budget.totalBudget - state.budget.consumed,
      },
      best: {
        branchId: bestBranch.branchId,
        ...bestBranch.incumbent,
        changedFiles: implementation.changedFiles,
        diffStat: implementation.diffStat,
      },
      branches: branchDetails,
    }, this.secretValues)
    const bestHarness = redactSecrets({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'BestHarnessImplementation',
      campaignId: state.campaignId,
      mode: state.mode,
      branchId: bestBranch.branchId,
      candidateId: bestBranch.incumbent.candidateId,
      baseRevision: implementation.baseCommit,
      commit: implementation.commit,
      tree: implementation.tree,
      digest: implementation.digest,
      validationVerified: bestBranch.incumbent.validationVerified,
      validationTotal: bestBranch.incumbent.validationTotal,
      changedFiles: implementation.changedFiles,
      diffStat: implementation.diffStat,
      patchArtifact: 'best-harness.patch',
      workspace: bestHandle.orchestrator.workspace,
      gitRoot: bestHandle.orchestrator.linearGit.gitRoot,
    }, this.secretValues)
    const report = await this.store.writeReport({
      summary,
      markdown: markdownReport(summary),
      bestHarness,
      patch: redactSecrets(implementation.patch, this.secretValues),
    })
    return { state, ...report, summary, bestHarness }
  }
}
