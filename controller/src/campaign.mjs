import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { ProtocolError } from './protocol.mjs'

export const CAMPAIGN_API_VERSION = 'harness-rsi/v1alpha1'
export const CAMPAIGN_LEVELS = Object.freeze(['l1', 'l2', 'l3'])
export const CAMPAIGN_TERMINAL_STATES = new Set([
  'CLOSED',
  'REPORTED',
  'ABORTED_SECURITY',
  'STOPPED_BUDGET',
])

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const REVISION_PATTERN = /^[a-f0-9]{40}$/u
const INSTANCE_PATTERN = /^putnam_\d{4}_[ab][1-6]$/u
const RECEIPT_KEYS = new Set(['receiptId', 'candidateId', 'status', 'completedAt'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function requireText(errors, value, path) {
  if (!hasText(value)) errors.push(`${path} 必须是非空字符串`)
}

function requireExactArray(errors, value, expected, path) {
  if (!Array.isArray(value) || value.length !== expected.length
      || value.some((entry, index) => entry !== expected[index])) {
    errors.push(`${path} 必须严格为 ${JSON.stringify(expected)}`)
  }
}

function assertState(state, expected) {
  if (!isObject(state) || state.kind !== 'CampaignState') {
    throw new ProtocolError('Campaign state 格式错误')
  }
  if (!expected.includes(state.status)) {
    throw new ProtocolError(`Campaign 状态 ${state.status} 不允许执行此操作`, [
      `期望状态：${expected.join(', ')}`,
    ])
  }
}

function withEvent(state, type, at, details = {}) {
  return {
    ...state,
    updatedAt: at,
    events: [
      ...state.events,
      {
        sequence: state.events.length + 1,
        type,
        at,
        ...details,
      },
    ],
  }
}

function safeManifestPath(baseDirectory, manifestPath, fieldPath, errors) {
  if (!hasText(manifestPath)) {
    errors.push(`${fieldPath} 必须是非空相对路径`)
    return null
  }
  if (isAbsolute(manifestPath)) {
    errors.push(`${fieldPath} 不能是绝对路径`)
    return null
  }
  const fullPath = resolve(baseDirectory, manifestPath)
  const rel = relative(baseDirectory, fullPath)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    errors.push(`${fieldPath} 不能逃出配置目录`)
    return null
  }
  return fullPath
}

function parseManifest(text, fieldPath, expectedCount, expectedDigest, errors) {
  if (!text.endsWith('\n')) errors.push(`${fieldPath} 必须保留末尾换行`)
  const ids = text.trimEnd().split(/\r?\n/u)
  if (ids.length !== expectedCount) {
    errors.push(`${fieldPath} 应有 ${expectedCount} 项，实际 ${ids.length} 项`)
  }
  if (new Set(ids).size !== ids.length) errors.push(`${fieldPath} 不能包含重复 ID`)
  if (ids.some((id) => !INSTANCE_PATTERN.test(id))) errors.push(`${fieldPath} 包含非法 PutnamBench ID`)
  if (ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) {
    errors.push(`${fieldPath} 必须按字典序严格递增`)
  }
  const actualDigest = createHash('sha256').update(text).digest('hex')
  if (actualDigest !== expectedDigest) {
    errors.push(`${fieldPath} sha256 不匹配：${actualDigest}`)
  }
  return ids
}

export function validateEvolutionCampaign(input) {
  const errors = []
  if (!isObject(input)) throw new ProtocolError('EvolutionCampaign 配置必须是 JSON 对象')
  if (input.apiVersion !== CAMPAIGN_API_VERSION) errors.push(`apiVersion 必须是 ${CAMPAIGN_API_VERSION}`)
  if (input.kind !== 'EvolutionCampaign') errors.push('kind 必须是 EvolutionCampaign')

  const metadata = isObject(input.metadata) ? input.metadata : {}
  requireText(errors, metadata.id, 'metadata.id')
  requireText(errors, metadata.name, 'metadata.name')

  const spec = isObject(input.spec) ? input.spec : {}
  const source = isObject(spec.source) ? spec.source : {}
  requireText(errors, source.dataset, 'spec.source.dataset')
  if (!REVISION_PATTERN.test(source.revision ?? '')) errors.push('spec.source.revision 必须是 40 位 Git SHA')
  requireText(errors, source.leanVersion, 'spec.source.leanVersion')
  if (!REVISION_PATTERN.test(source.mathlibRevision ?? '')) {
    errors.push('spec.source.mathlibRevision 必须是 40 位 Git SHA')
  }

  const partitions = isObject(spec.partitions) ? spec.partitions : {}
  const validation = isObject(partitions.validation) ? partitions.validation : {}
  const test = isObject(partitions.test) ? partitions.test : {}
  requireText(errors, validation.manifest, 'spec.partitions.validation.manifest')
  requireText(errors, test.manifest, 'spec.partitions.test.manifest')
  if (validation.expectedCount !== 500) errors.push('spec.partitions.validation.expectedCount 必须是 500')
  if (test.expectedCount !== 172) errors.push('spec.partitions.test.expectedCount 必须是 172')
  if (!SHA256_PATTERN.test(validation.sha256 ?? '')) errors.push('validation.sha256 必须是 64 位小写 sha256')
  if (!SHA256_PATTERN.test(test.sha256 ?? '')) errors.push('test.sha256 必须是 64 位小写 sha256')
  if (validation.visibility !== 'feedback') errors.push('validation.visibility 必须是 feedback')
  if (test.visibility !== 'sealed-until-closed') errors.push('test.visibility 必须是 sealed-until-closed')

  const evolution = isObject(spec.evolution) ? spec.evolution : {}
  requireExactArray(errors, evolution.levels, CAMPAIGN_LEVELS, 'spec.evolution.levels')
  if (evolution.consecutiveMissesBeforeAdvance !== 3) {
    errors.push('spec.evolution.consecutiveMissesBeforeAdvance 必须是 3')
  }
  if (evolution.promotion !== 'strict-validation-verified-count') {
    errors.push('spec.evolution.promotion 必须是 strict-validation-verified-count')
  }
  if (evolution.evaluateTestForEveryCandidate !== true) {
    errors.push('spec.evolution.evaluateTestForEveryCandidate 必须是 true')
  }

  const solver = isObject(spec.solver) ? spec.solver : {}
  if (!REVISION_PATTERN.test(solver.targetRevision ?? '')) {
    errors.push('spec.solver.targetRevision 必须是 40 位 Git SHA')
  }
  if (solver.profile !== 'headless') errors.push('spec.solver.profile 必须是 headless')
  requireText(errors, solver.preset, 'spec.solver.preset')
  if (solver.api !== 'openai-responses') errors.push('spec.solver.api 必须是 openai-responses')
  requireText(errors, solver.model, 'spec.solver.model')
  if (solver.reasoningEffort !== 'max') errors.push('spec.solver.reasoningEffort 必须是 max')

  if (errors.length > 0) throw new ProtocolError('EvolutionCampaign 配置校验失败', errors)
  return structuredClone(input)
}

export async function loadEvolutionCampaign(configPath) {
  let input
  try {
    input = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    throw new ProtocolError(`无法读取 EvolutionCampaign：${configPath}`, [error.message])
  }
  const config = validateEvolutionCampaign(input)
  const configDirectory = dirname(resolve(configPath))
  const errors = []
  const manifests = {}

  // The trusted Controller may retain validation IDs because they are model
  // feedback. It must never read or materialize sealed-test IDs. We still
  // validate the configured test path lexically here so a later broker call
  // cannot escape the campaign directory; the broker child is solely
  // responsible for opening it and checking its frozen digest/count.
  const validationPartition = config.spec.partitions.validation
  const validationPath = safeManifestPath(
    configDirectory,
    validationPartition.manifest,
    'spec.partitions.validation.manifest',
    errors,
  )
  safeManifestPath(
    configDirectory,
    config.spec.partitions.test.manifest,
    'spec.partitions.test.manifest',
    errors,
  )
  if (validationPath) {
    let text
    try {
      text = await readFile(validationPath, 'utf8')
    } catch (error) {
      errors.push(`无法读取 validation manifest：${error.message}`)
    }
    if (text !== undefined) {
      manifests.validation = parseManifest(
        text,
        'validation manifest',
        validationPartition.expectedCount,
        validationPartition.sha256,
        errors,
      )
    }
  }
  if (errors.length > 0) throw new ProtocolError('EvolutionCampaign manifest 校验失败', errors)

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(config))
    .update(config.spec.partitions.validation.sha256)
    .update(config.spec.partitions.test.sha256)
    .digest('hex')
  return { config, manifests, fingerprint }
}

export function assertOpaqueTestReceipt(receipt, expectedCandidateId) {
  if (!isObject(receipt)) throw new ProtocolError('Test receipt 必须是对象')
  const unknownKeys = Object.keys(receipt).filter((key) => !RECEIPT_KEYS.has(key))
  if (unknownKeys.length > 0) {
    throw new ProtocolError('Test receipt 包含可能泄漏 sealed 结果的字段', unknownKeys)
  }
  requireReceiptText(receipt.receiptId, 'receiptId')
  requireReceiptText(receipt.candidateId, 'candidateId')
  requireReceiptText(receipt.completedAt, 'completedAt')
  if (receipt.candidateId !== expectedCandidateId) throw new ProtocolError('Test receipt candidateId 不匹配')
  if (receipt.status !== 'sealed') throw new ProtocolError('Test receipt status 必须是 sealed')
  return structuredClone(receipt)
}

function requireReceiptText(value, name) {
  if (!hasText(value)) throw new ProtocolError(`Test receipt ${name} 必须是非空字符串`)
}

export function createCampaignState({ campaignId, configFingerprint, at }) {
  if (!hasText(campaignId) || !SHA256_PATTERN.test(configFingerprint ?? '') || !hasText(at)) {
    throw new ProtocolError('创建 Campaign state 的参数无效')
  }
  return {
    apiVersion: CAMPAIGN_API_VERSION,
    kind: 'CampaignState',
    campaignId,
    status: 'CONFIG_FROZEN',
    configFingerprint,
    createdAt: at,
    updatedAt: at,
    activeLevel: null,
    consecutiveMisses: 0,
    incumbent: null,
    candidates: [],
    events: [{ sequence: 1, type: 'CONFIG_FROZEN', at, configFingerprint }],
  }
}

export function freezeBaseline(state, { candidateId, digest, at }) {
  assertState(state, ['CONFIG_FROZEN'])
  if (!hasText(candidateId) || !SHA256_PATTERN.test(digest ?? '') || !hasText(at)) {
    throw new ProtocolError('Baseline freeze 参数无效')
  }
  const next = withEvent(state, 'BASELINE_FROZEN', at, { candidateId, digest })
  return {
    ...next,
    status: 'BASELINE_FROZEN',
    incumbent: { candidateId, digest, validationVerified: null },
  }
}

export function recordBaselineEvaluation(state, { validationVerified, validationTotal, testReceipt, at }) {
  assertState(state, ['BASELINE_FROZEN'])
  validateValidationScore(validationVerified, validationTotal)
  if (!hasText(at)) throw new ProtocolError('Baseline evaluation at 无效')
  const receipt = assertOpaqueTestReceipt(testReceipt, state.incumbent.candidateId)
  const next = withEvent(state, 'BASELINE_EVALUATED', at, {
    candidateId: state.incumbent.candidateId,
    validationVerified,
    validationTotal,
    testReceiptId: receipt.receiptId,
  })
  return {
    ...next,
    status: 'EVOLVING_L1',
    activeLevel: 'l1',
    incumbent: { ...state.incumbent, validationVerified, validationTotal },
    candidates: [{
      candidateId: state.incumbent.candidateId,
      parentId: null,
      level: 'baseline',
      digest: state.incumbent.digest,
      validationVerified,
      validationTotal,
      decision: 'baseline',
      testReceipt: receipt,
      evaluatedAt: at,
    }],
  }
}

function validateValidationScore(verified, total) {
  if (!Number.isInteger(verified) || !Number.isInteger(total) || total !== 500
      || verified < 0 || verified > total) {
    throw new ProtocolError('Validation score 必须是 0..500 的 verified 整数，total 必须为 500')
  }
}

export function recordCandidateEvaluation(state, candidate) {
  assertState(state, ['EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3'])
  const {
    candidateId,
    parentId,
    level,
    digest,
    proposalId,
    validationVerified,
    validationTotal,
    testReceipt,
    at,
    outcome = 'completed',
  } = candidate
  if (!hasText(candidateId) || state.candidates.some((entry) => entry.candidateId === candidateId)) {
    throw new ProtocolError('Candidate ID 为空或重复')
  }
  if (state.inFlight && (state.inFlight.candidateId !== candidateId
      || state.inFlight.proposalId !== proposalId
      || state.inFlight.parentId !== parentId
      || state.inFlight.level !== level)) {
    throw new ProtocolError('Candidate evaluation 与 in-flight round 不匹配')
  }
  if (parentId !== state.incumbent.candidateId) throw new ProtocolError('Candidate parent 必须是当前 incumbent')
  if (level !== state.activeLevel) throw new ProtocolError('Candidate mutation level 必须等于 activeLevel')
  if (!SHA256_PATTERN.test(digest ?? '') || !hasText(proposalId) || !hasText(at)) {
    throw new ProtocolError('Candidate digest/proposalId/at 无效')
  }
  if (!['completed', 'candidate_failure'].includes(outcome)) {
    throw new ProtocolError('Candidate outcome 只能是 completed 或 candidate_failure')
  }
  validateValidationScore(validationVerified, validationTotal)
  const receipt = assertOpaqueTestReceipt(testReceipt, candidateId)
  const promoted = outcome === 'completed'
    && validationVerified > state.incumbent.validationVerified
  const decision = promoted ? 'promoted' : 'rejected'
  const misses = promoted ? 0 : state.consecutiveMisses + 1
  let activeLevel = state.activeLevel
  let status = state.status
  let nextMisses = misses
  let transition = null

  if (!promoted && misses === 3) {
    const currentIndex = CAMPAIGN_LEVELS.indexOf(state.activeLevel)
    if (currentIndex === CAMPAIGN_LEVELS.length - 1) {
      status = 'CLOSING'
      activeLevel = null
      transition = 'CLOSING'
    } else {
      activeLevel = CAMPAIGN_LEVELS[currentIndex + 1]
      status = `EVOLVING_${activeLevel.toUpperCase()}`
      nextMisses = 0
      transition = activeLevel
    }
  }

  const record = {
    candidateId,
    parentId,
    level,
    digest,
    proposalId,
    validationVerified,
    validationTotal,
    outcome,
    decision,
    testReceipt: receipt,
    evaluatedAt: at,
  }
  let next = withEvent(state, 'CANDIDATE_EVALUATED', at, {
    candidateId,
    parentId,
    level,
    validationVerified,
    validationTotal,
    outcome,
    decision,
    testReceiptId: receipt.receiptId,
  })
  if (transition) {
    next = withEvent(next, transition === 'CLOSING' ? 'CAMPAIGN_CLOSING' : 'LEVEL_ADVANCED', at, {
      fromLevel: level,
      ...(transition === 'CLOSING' ? {} : { toLevel: transition }),
      reason: 'three-consecutive-non-improvements',
    })
  }
  return {
    ...next,
    status,
    activeLevel,
    consecutiveMisses: nextMisses,
    incumbent: promoted
      ? { candidateId, digest, validationVerified, validationTotal }
      : state.incumbent,
    candidates: [...state.candidates, record],
    inFlight: null,
  }
}

const ROUND_STAGES = [
  'started',
  'proposal_frozen',
  'mutation_frozen',
  'built',
  'validation_complete',
  'test_sealed',
]

export function startCandidateRound(state, { candidateId, proposalId, at }) {
  assertState(state, ['EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3'])
  if (state.inFlight) throw new ProtocolError('已有 in-flight Candidate round')
  if (!hasText(candidateId) || !hasText(proposalId) || !hasText(at)
      || state.candidates.some((entry) => entry.candidateId === candidateId)) {
    throw new ProtocolError('Candidate round 参数无效')
  }
  const inFlight = {
    candidateId,
    proposalId,
    parentId: state.incumbent.candidateId,
    level: state.activeLevel,
    stage: 'started',
    startedAt: at,
  }
  const next = withEvent(state, 'CANDIDATE_ROUND_STARTED', at, { ...inFlight })
  return { ...next, inFlight }
}

export function checkpointCandidateRound(state, { stage, at, details = {} }) {
  assertState(state, ['EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3'])
  if (!state.inFlight) throw new ProtocolError('没有 in-flight Candidate round')
  const currentIndex = ROUND_STAGES.indexOf(state.inFlight.stage)
  const nextIndex = ROUND_STAGES.indexOf(stage)
  if (nextIndex !== currentIndex + 1) {
    throw new ProtocolError(`Candidate round stage 必须从 ${state.inFlight.stage} 前进一格`)
  }
  if (!hasText(at) || !isObject(details)) throw new ProtocolError('Candidate checkpoint 参数无效')
  const inFlight = { ...state.inFlight, stage, ...details, updatedAt: at }
  const next = withEvent(state, 'CANDIDATE_ROUND_CHECKPOINT', at, {
    candidateId: inFlight.candidateId,
    stage,
    ...details,
  })
  return { ...next, inFlight }
}

export function pauseInfrastructure(state, { operation, message, at }) {
  assertState(state, ['BASELINE_FROZEN', 'EVOLVING_L1', 'EVOLVING_L2', 'EVOLVING_L3'])
  if (!hasText(operation) || !hasText(message) || !hasText(at)) {
    throw new ProtocolError('Infrastructure pause 参数无效')
  }
  const next = withEvent(state, 'INFRASTRUCTURE_PAUSED', at, {
    operation,
    message,
    resumeStatus: state.status,
  })
  return { ...next, status: 'PAUSED_INFRASTRUCTURE', pause: { operation, message, resumeStatus: state.status } }
}

export function resumeInfrastructure(state, { at }) {
  assertState(state, ['PAUSED_INFRASTRUCTURE'])
  if (!hasText(at)) throw new ProtocolError('Infrastructure resume at 无效')
  const next = withEvent(state, 'INFRASTRUCTURE_RESUMED', at, {
    resumeStatus: state.pause.resumeStatus,
  })
  const { pause: _pause, ...withoutPause } = next
  return { ...withoutPause, status: state.pause.resumeStatus }
}

export function closeCampaign(state, { at }) {
  assertState(state, ['CLOSING'])
  if (!hasText(at)) throw new ProtocolError('Campaign close at 无效')
  const next = withEvent(state, 'CAMPAIGN_CLOSED', at)
  return { ...next, status: 'CLOSED', closedAt: at }
}

export function markReported(state, { at }) {
  assertState(state, ['CLOSED'])
  if (!hasText(at)) throw new ProtocolError('Campaign report at 无效')
  const next = withEvent(state, 'CAMPAIGN_REPORTED', at)
  return { ...next, status: 'REPORTED', reportedAt: at }
}

export function abortSecurity(state, { reason, at }) {
  if (CAMPAIGN_TERMINAL_STATES.has(state.status)) {
    throw new ProtocolError(`终态 ${state.status} 不能再次 abort`)
  }
  if (!hasText(reason) || !hasText(at)) throw new ProtocolError('Security abort 参数无效')
  const next = withEvent(state, 'SECURITY_ABORTED', at, { reason })
  return { ...next, status: 'ABORTED_SECURITY', activeLevel: null, securityReason: reason }
}
