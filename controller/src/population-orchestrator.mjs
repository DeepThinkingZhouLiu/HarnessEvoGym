import { relative } from 'node:path'

import {
  validateBranchEvolutionDriver,
  validateBranchProjection,
} from './branch-evolution-driver.mjs'
import { createReasoningBranchDriver } from './branches/reasoning.mjs'
import { redactSecrets } from './campaign-store.mjs'
import { primaryMetricDelta } from './evaluation-summary.mjs'
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

function publicIncumbent(projection) {
  const incumbent = projection?.incumbent
  const primary = incumbent?.evaluation?.primary
  if (!incumbent || !Number.isFinite(primary?.value)) {
    throw new ProtocolError('Branch 缺少已评测 incumbent')
  }
  return {
    candidateId: incumbent.candidateId,
    digest: incumbent.digest,
    revision: incumbent.revision,
    evaluation: incumbent.evaluation,
    primaryMetric: primary.metric,
    primaryValue: primary.value,
    primaryDirection: primary.direction,
    primaryTotal: primary.total,
    // 兼容旧 Reasoning State/Report；新场景只消费上面的通用字段。
    ...(primary.metric === 'validation-verified-count'
      ? {
          commit: incumbent.revision,
          validationVerified: primary.value,
          validationTotal: primary.total,
        }
      : {}),
  }
}

function incumbentScore(incumbent) {
  return incumbent.primaryDirection === 'minimize' ? -incumbent.primaryValue : incumbent.primaryValue
}

function branchRemaining(branch) {
  return branch.baseBudget + branch.bonusBudget - branch.consumed
}

function branchStatus(branch, projection) {
  if (projection.status === 'stopped') return 'stopped'
  return branchRemaining(branch) > 0 ? 'active' : 'exhausted'
}

function assertRestoredIncumbent(branch, projection) {
  const expected = branch.incumbent
  const actual = projection.incumbent
  if (!expected || !actual
      || expected.candidateId !== actual.candidateId
      || expected.digest !== actual.digest
      || expected.revision !== actual.revision
      || JSON.stringify(expected.evaluation) !== JSON.stringify(actual.evaluation)) {
    throw new ProtocolError(`${branch.branchId} 恢复后 incumbent 与 Population 冻结状态不一致`)
  }
}

function assertRoundLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new ProtocolError('Population roundLimit 必须是 0..10000 的整数')
  }
}

function markdownReport(summary) {
  const bestMetric = summary.best.evaluation.primary
  const lines = [
    '# Population Evolution Report',
    '',
    `- Mode: \`${summary.mode}\``,
    `- Total budget: ${summary.budget.totalBudget}`,
    `- Consumed budget: ${summary.budget.consumed}`,
    `- Unused budget: ${summary.budget.unused}`,
    `- Best branch: \`${summary.best.branchId}\``,
    `- Best metric: ${bestMetric.metric}=${bestMetric.value}${bestMetric.total === null ? '' : `/${bestMetric.total}`}`,
    `- Best revision: \`${summary.best.revision}\``,
    `- Harness implementation: \`best-harness.json\` + \`best-harness.patch\``,
    '',
    '| Branch | Base | Bonus | Consumed | Best metric | Best candidate | Status |',
    '|---|---:|---:|---:|---:|---|---|',
    ...summary.branches.map((branch) => (
      `| ${branch.branchId} | ${branch.baseBudget} | ${branch.bonusBudget} | ${branch.consumed} | ${branch.incumbent.primaryMetric}=${branch.incumbent.primaryValue} | ${branch.incumbent.candidateId} | ${branch.status} |`
    )),
    '',
    'Competition awards and per-round deltas are retained in the parent event log; each branch keeps its full mutation history in its own evolution log.',
    '',
  ]
  return lines.join('\n')
}

function publicPopulationFinal(final) {
  if (final === null || final === undefined || typeof final !== 'object' || Array.isArray(final)) {
    return null
  }
  const safeId = (value, pattern) => (
    typeof value === 'string' && pattern.test(value) ? value : null
  )
  const safeTime = (value) => (
    typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
  )
  const completed = final.evaluated === true
  const failed = !completed && safeTime(final.failedAt) !== null
  return {
    status: completed ? 'completed' : failed ? 'failed' : 'running',
    evaluated: completed,
    branchId: safeId(final.branchId, /^branch-[0-9]{3}$/u),
    baselineId: safeId(final.baselineId, /^[a-z0-9][a-z0-9._-]{1,119}$/u),
    candidateId: safeId(final.candidateId, /^[a-z0-9][a-z0-9._-]{1,119}$/u),
    startedAt: safeTime(final.startedAt),
    completedAt: safeTime(final.completedAt),
    failedAt: safeTime(final.failedAt),
    report: final.report === 'report/final-evaluation.json'
      ? 'report/final-evaluation.json'
      : null,
  }
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
    // Status 是公开投影：不反射 failure.details、Final 指标或未知字段。
    final: publicPopulationFinal(state.final),
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
    const populationConfig = loadedCampaign?.recipe?.spec?.population
      ?? loadedCampaign?.config?.controller_config
    if (!populationConfig || !SHA256_PATTERN.test(loadedCampaign?.fingerprint ?? '')) {
      throw new ProtocolError('PopulationOrchestrator 需要带 EvolutionRecipe 或 controller_config 的冻结配置')
    }
    if (loadedCampaign.configDigest !== undefined
        && !SHA256_PATTERN.test(loadedCampaign.configDigest)) {
      throw new ProtocolError('PopulationOrchestrator configDigest 必须是 64 位小写 SHA-256')
    }
    if (typeof createBranch !== 'function') {
      throw new ProtocolError('PopulationOrchestrator 需要 createBranch()')
    }
    this.loaded = loadedCampaign
    this.config = loadedCampaign.config
    this.controller = normalizeControllerConfig(populationConfig)
    this.plan = createBudgetPlan(this.controller)
    this.campaignId = campaignId
    this.createBranch = createBranch
    this.clock = clock
    this.progress = progress
    this.frozenConfig = frozenConfig ?? this.config
    this.configDigest = loadedCampaign.configDigest ?? null
    this.secretValues = secretValues
    this.store = new PopulationStore(campaignsRoot, campaignId)
    this.handles = new Map()
    this.coordinationContexts = new Map()
  }

  async #handle(branchId) {
    if (!this.handles.has(branchId)) {
      this.handles.set(branchId, Promise.resolve(this.createBranch({
        branchId,
        branchesRoot: this.store.branchesRoot,
      })).then((handle) => {
        const driver = handle?.orchestrator
          ? createReasoningBranchDriver({
              branchId,
              handle,
              baseRevision: this.config.spec?.solver?.targetRevision,
            })
          : handle
        return validateBranchEvolutionDriver(driver)
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
      ...(this.configDigest === null ? {} : { configDigest: this.configDigest }),
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
      final: null,
      events: [{
        sequence: 1,
        type: 'POPULATION_CONFIG_FROZEN',
        at,
        mode: this.controller.mode,
        totalBudget: this.plan.totalBudget,
        ...(this.configDigest === null ? {} : { configDigest: this.configDigest }),
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

    const baselineSettlements = await Promise.allSettled(state.branches.map(async ({ branchId }) => {
      const driver = await this.#handle(branchId)
      return await driver.initialize()
    }))
    const baselineFailures = baselineSettlements.flatMap((settlement, index) => (
      settlement.status === 'rejected'
        ? [{ branchId: state.branches[index].branchId, error: settlement.reason }]
        : []
    ))
    if (baselineFailures.length > 0) {
      return await this.#pauseInfrastructure(state, baselineFailures, 'baseline')
    }
    const projections = baselineSettlements.map((settlement) => settlement.value)
    const branches = state.branches.map((branch, index) => ({
      ...branch,
      incumbent: publicIncumbent(projections[index]),
      status: branchStatus(branch, projections[index]),
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
          primaryMetric: branch.incumbent.primaryMetric,
          primaryValue: branch.incumbent.primaryValue,
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
    if (this.configDigest !== null && state.configDigest !== this.configDigest) {
      throw new ProtocolError('Population Bundle 摘要与冻结 state 不一致')
    }
    return state
  }

  /** 只固化 H0 评测，不启动 Updater，也不消耗进化 Budget。 */
  async freezeBaseline() {
    const state = await this.#readState()
    if (state.status === 'PAUSED_INFRASTRUCTURE') {
      throw new ProtocolError('Population Baseline 因基础设施故障暂停')
    }
    if (state.status !== 'EVOLVING' || state.epoch !== 0
        || state.budget.consumed !== 0 || state.inFlightWave !== undefined) {
      throw new ProtocolError('Population 只能在 H0 评测后、第一轮进化前固化 Baseline')
    }
    const frozenAt = iso(this.clock)
    const baseline = redactSecrets({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'PopulationBaselineReport',
      campaignId: state.campaignId,
      mode: state.mode,
      frozenAt,
      configFingerprint: state.configFingerprint,
      ...(state.configDigest === undefined ? {} : { configDigest: state.configDigest }),
      budgetConsumed: 0,
      best: structuredClone(state.best),
      branches: state.branches.map((branch) => ({
        branchId: branch.branchId,
        incumbent: structuredClone(branch.incumbent),
      })),
    }, this.secretValues)
    const baselinePath = await this.store.writeBaselineSummary(baseline)
    const frozen = {
      ...state,
      status: 'BASELINE_FROZEN',
      updatedAt: frozenAt,
      baseline: { path: 'public/baseline-summary.json', frozenAt },
      events: [...state.events, event(state, 'POPULATION_BASELINE_FROZEN', frozenAt, {
        branchId: state.best.branchId,
        candidateId: state.best.candidateId,
        primaryMetric: state.best.primaryMetric,
        primaryValue: state.best.primaryValue,
      })],
    }
    await this.store.saveState(frozen)
    this.progress({
      type: 'population-baseline-frozen',
      branchId: frozen.best.branchId,
      primaryMetric: frozen.best.primaryMetric,
      primaryValue: frozen.best.primaryValue,
    })
    return { state: frozen, baseline, baselinePath }
  }

  async #pauseInfrastructure(state, failures, phase) {
    const pausedAt = iso(this.clock)
    const publicFailures = redactSecrets(failures.map(({ branchId, error }) => ({
      branchId,
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      details: Array.isArray(error?.details) ? error.details : [],
    })), this.secretValues)
    const paused = {
      ...state,
      status: 'PAUSED_INFRASTRUCTURE',
      updatedAt: pausedAt,
      events: [...state.events, event(state, 'POPULATION_INFRASTRUCTURE_PAUSED', pausedAt, {
        phase,
        ...(state.inFlightWave ? { epoch: state.inFlightWave.epoch } : {}),
        failures: publicFailures,
      })],
    }
    await this.store.saveState(paused)
    this.progress({
      type: 'population-infrastructure-paused',
      branches: publicFailures.map((failure) => failure.branchId),
    })
    return paused
  }

  async run({ roundLimit = 0 } = {}) {
    assertRoundLimit(roundLimit)
    const waveLimit = roundLimit === 0 ? Number.POSITIVE_INFINITY : roundLimit
    let state = await this.#readState()
    if (state.status === 'PAUSED_INFRASTRUCTURE') {
      throw new ProtocolError('Population 当前暂停；请使用 evolve resume')
    }
    if (state.status === 'BASELINE_FROZEN') {
      throw new ProtocolError('Population 已固化为 H0 Baseline，不能在同一 Run 中继续进化')
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
    const pauseEvent = [...state.events].reverse().find((entry) => (
      entry.type === 'POPULATION_INFRASTRUCTURE_PAUSED'
    ))
    const baselineRecovery = pauseEvent?.phase === 'baseline'
    const restoredProjections = await Promise.all(state.branches.map(async (branch) => {
      const driver = await this.#handle(branch.branchId)
      const restored = typeof driver.restore === 'function'
        ? await driver.restore()
        : await driver.inspect()
      const projection = validateBranchProjection(restored)
      if (projection.branchId !== branch.branchId) {
        throw new ProtocolError(`Population 恢复得到了错误的 Branch：${projection.branchId}`)
      }
      const inFlight = state.inFlightWave?.participants.find(
        (participant) => participant.branchId === branch.branchId,
      )
      const maximumCompleted = inFlight ? inFlight.beforeSteps + 1 : branch.consumed
      if (projection.completedSteps < branch.consumed
          || projection.completedSteps > maximumCompleted) {
        throw new ProtocolError(`${branch.branchId} 恢复后 Step 与 Population Budget 不一致`, [
          `population=${branch.consumed}`,
          `branch=${projection.completedSteps}`,
        ])
      }
      if (baselineRecovery) {
        if (branch.consumed !== 0 || projection.completedSteps !== 0 || state.inFlightWave) {
          throw new ProtocolError(`${branch.branchId} Baseline 恢复后出现非法进化 Step`)
        }
      } else if (projection.completedSteps === branch.consumed) {
        assertRestoredIncumbent(branch, projection)
      } else if (!inFlight || projection.lastStep === null) {
        throw new ProtocolError(`${branch.branchId} 超前 Step 缺少对应的 in-flight 记录`)
      }
      return projection
    }))
    const resumedAt = iso(this.clock)

    if (baselineRecovery) {
      const resumed = {
        ...state,
        updatedAt: resumedAt,
        events: [...state.events, event(
          state,
          'POPULATION_INFRASTRUCTURE_RESUMED',
          resumedAt,
          { phase: 'baseline' },
        )],
      }
      const branches = resumed.branches.map((branch, index) => ({
        ...branch,
        incumbent: publicIncumbent(restoredProjections[index]),
        status: branchStatus(branch, restoredProjections[index]),
      }))
      const bestBranch = selectPopulationBest(branches)
      const completedAt = iso(this.clock)
      state = {
        ...resumed,
        status: 'EVOLVING',
        updatedAt: completedAt,
        branches,
        best: { branchId: bestBranch.branchId, ...bestBranch.incumbent },
        events: [...resumed.events, event(
          resumed,
          'POPULATION_BASELINE_EVALUATED',
          completedAt,
          {
            recovered: true,
            branches: branches.map((branch) => ({
              branchId: branch.branchId,
              primaryMetric: branch.incumbent.primaryMetric,
              primaryValue: branch.incumbent.primaryValue,
            })),
          },
        )],
      }
      await this.store.saveState(state)
      this.progress({ type: 'population-baseline-evaluated', branches: branches.length })
      return this.run(options)
    }

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
      const driver = await this.#handle(branch.branchId)
      const projection = await driver.inspect()
      return {
        branchId: branch.branchId,
        beforeSteps: projection.completedSteps,
        beforeScore: incumbentScore(publicIncumbent(projection)),
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
    const drivers = new Map(await Promise.all(state.branches.map(async (branch) => (
      [branch.branchId, await this.#handle(branch.branchId)]
    ))))
    const evidence = new Map(await Promise.all(state.branches.map(async (branch) => (
      [branch.branchId, await drivers.get(branch.branchId).exportPeerEvidence()]
    ))))
    await Promise.all(state.inFlightWave.participants.map(async ({ branchId }) => {
      const peers = sharingReady
        ? state.branches.filter((branch) => (
            branch.branchId !== branchId && branch.consumed > 0
          )).map((branch) => ({
            branchId: branch.branchId,
            sourcePath: evidence.get(branch.branchId).sourcePath,
          }))
        : []
      this.coordinationContexts.set(branchId, buildCoordinationContext({
        controllerConfig: this.controller,
        branchId,
        peerLogs: peers,
        competitionState: { bonusRemaining: state.budget.bonusRemaining },
      }))
    }))
  }

  async #runChildRound(participant, epoch) {
    const driver = await this.#handle(participant.branchId)
    const projection = await driver.inspect()
    if (projection.completedSteps > participant.beforeSteps + 1) {
      throw new ProtocolError(`${participant.branchId} 超前于 Population wave`)
    }
    if (projection.completedSteps === participant.beforeSteps + 1) {
      return {
        apiVersion: 'harness-rsi/v1alpha1',
        kind: 'BranchStepResult',
        stepId: projection.lastStep.stepId,
        budgetConsumed: 1,
        projection,
      }
    }
    return await driver.advanceOne({
      stepId: `epoch-${String(epoch).padStart(4, '0')}-${participant.branchId}`,
      coordination: this.coordinationContexts.get(participant.branchId),
    })
  }

  async #runWave(state) {
    await this.#applyCoordinationContexts(state)
    const settlements = await Promise.allSettled(
      state.inFlightWave.participants.map((participant) => (
        this.#runChildRound(participant, state.inFlightWave.epoch)
      )),
    )
    const failures = settlements.flatMap((settlement, index) => (
      settlement.status === 'rejected'
        ? [{ branchId: state.inFlightWave.participants[index].branchId, error: settlement.reason }]
        : []
    ))
    if (failures.length > 0) return await this.#pauseInfrastructure(state, failures, 'wave')
    const stepResults = settlements.map((settlement) => settlement.value)
    if (stepResults.some((result) => result.projection.status === 'paused')) {
      return await this.#pauseInfrastructure(state, stepResults.flatMap((result, index) => (
        result.projection.status === 'paused'
          ? [{
              branchId: state.inFlightWave.participants[index].branchId,
              error: new ProtocolError('Branch Driver 报告基础设施暂停'),
            }]
          : []
      )), 'wave')
    }

    const results = state.inFlightWave.participants.map((participant, index) => {
      const stepResult = stepResults[index]
      const projection = stepResult.projection
      const candidate = projection.lastStep
      const stopped = projection.status === 'stopped'
      if (!stopped && stepResult.budgetConsumed === 0) {
        throw new ProtocolError(`${participant.branchId} 未产生本轮 Candidate`)
      }
      const primary = candidate?.ranking?.evaluation?.primary
      const validationScore = primary
        ? (primary.direction === 'minimize' ? -primary.value : primary.value)
        : participant.beforeScore
      const deltaScore = primary && candidate.ranking.baselineEvaluation
        // Cowork 等随机 Environment 会在同一评测窗口重跑 Baseline；必须沿用
        // Branch 的同期配对口径，不能再与 Population 初始化时的旧分数比较。
        ? primaryMetricDelta(candidate.ranking.evaluation, candidate.ranking.baselineEvaluation)
        : validationScore - participant.beforeScore
      return {
        branchId: participant.branchId,
        validationScore,
        deltaScore,
        candidateId: candidate?.candidateId ?? null,
        decision: candidate?.decision ?? 'stopped',
        // Competition 可以比较已评测但未晋升的 Candidate；无评测的 invalid/stopped
        // 提案不能靠 delta=0 赢得额外预算。
        eligible: !stopped && primary !== undefined,
        stopped,
        budgetConsumed: stepResult.budgetConsumed,
        projection,
      }
    })

    let branches = state.branches.map((branch) => {
      const result = results.find((entry) => entry.branchId === branch.branchId)
      if (!result) return branch
      const consumed = branch.consumed + result.budgetConsumed
      const updated = {
        ...branch,
        consumed,
        incumbent: publicIncumbent(result.projection),
        lastDeltaScore: result.deltaScore,
      }
      return { ...updated, status: branchStatus(updated, result.projection) }
    })
    let budget = {
      ...state.budget,
      consumed: state.budget.consumed + results.reduce((sum, result) => sum + result.budgetConsumed, 0),
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
    const bestDriver = await this.#handle(bestBranch.branchId)
    const implementation = await bestDriver.exportBest()
    const branchDetails = await Promise.all(state.branches.map(async (branch) => {
      const driver = await this.#handle(branch.branchId)
      const evidence = await driver.exportPeerEvidence()
      return {
        ...branch,
        remaining: branchRemaining(branch),
        evolutionLog: relative(this.store.root, evidence.sourcePath),
        mutations: evidence.entries,
        ...(evidence.evolution ? { evolution: evidence.evolution } : {}),
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
        ...(implementation.evolution ? { evolution: implementation.evolution } : {}),
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
      revision: implementation.revision,
      evaluation: implementation.evaluation,
      ...(implementation.baseRevision ? { baseRevision: implementation.baseRevision } : {}),
      ...(implementation.revision ? { commit: implementation.revision } : {}),
      ...(implementation.tree ? { tree: implementation.tree } : {}),
      digest: implementation.digest,
      ...(bestBranch.incumbent.validationVerified === undefined
        ? {}
        : {
            validationVerified: bestBranch.incumbent.validationVerified,
            validationTotal: bestBranch.incumbent.validationTotal,
          }),
      changedFiles: implementation.changedFiles,
      diffStat: implementation.diffStat,
      ...(implementation.evolution ? { evolution: implementation.evolution } : {}),
      patchArtifact: 'best-harness.patch',
      workspace: implementation.workspace,
      implementationRoot: implementation.implementationRoot,
      ...(implementation.implementationRoot ? { gitRoot: implementation.implementationRoot } : {}),
    }, this.secretValues)
    const report = await this.store.writeReport({
      summary,
      markdown: markdownReport(summary),
      bestHarness,
      patch: redactSecrets(implementation.patch ?? '', this.secretValues),
    })
    return { state, ...report, summary, bestHarness }
  }
}
