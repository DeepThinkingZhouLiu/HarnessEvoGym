import { randomUUID } from 'node:crypto'
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { assertOpaqueTestReceipt } from './campaign.mjs'
import { ProtocolError } from './protocol.mjs'
import {
  assertInternalSealedReceipt,
  sealedArtifactSha256,
  sealedTraceDirectorySha256,
} from './sealed-test-broker.mjs'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const INSTANCE_PATTERN = /^(?:putnam_\d{4}_[ab][1-6]|hle_[a-f0-9]{24})$/u
const REPORTABLE_STATES = new Set(['CLOSED', 'REPORTED'])
const USAGE_FIELDS = ['requests', 'inputTokens', 'outputTokens', 'totalTokens']
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function assertId(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ProtocolError(`${name} 包含非法路径字符`)
  }
}

async function makePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function atomicWrite(path, text, mode = 0o600) {
  await makePrivateDirectory(dirname(path))
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode })
  try {
    await rename(temporary, path)
    await chmod(path, mode)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function atomicJson(path, value, mode = 0o600) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

async function atomicCreate(path, text, mode = 0o400) {
  await makePrivateDirectory(dirname(path))
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode })
  try {
    // link(2) is an atomic no-replace commit. Unlike rename(2), it cannot
    // silently replace an already-frozen ledger artifact after a crash.
    await link(temporary, path)
    await chmod(path, mode)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function readOptionalJson(path, label) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new ProtocolError(`无法读取 ${label}`, [error.message])
  }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a JSON object')
    }
    return value
  } catch (error) {
    throw new ProtocolError(`${label} JSON 损坏`, [error.message])
  }
}

function redactString(value, secrets) {
  let output = value
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]')
  return output
}

async function readJsonl(path, label) {
  const text = await readFile(path, 'utf8')
  const values = []
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue
    try {
      values.push(JSON.parse(line))
    } catch (error) {
      throw new ProtocolError(`${label} record ${index + 1} 损坏`, [error.message])
    }
  }
  return values
}

export function redactSecrets(value, secretValues = []) {
  const secrets = secretValues.filter((secret) => typeof secret === 'string' && secret.length >= 8)
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecrets(entry, secrets)]))
  }
  return value
}

function assertPublicStateSafe(state) {
  if (!state || state.kind !== 'CampaignState' || !Array.isArray(state.candidates)) {
    throw new ProtocolError('无法持久化非法 CampaignState')
  }
  for (const candidate of state.candidates) {
    const hasReceipt = candidate.testReceipt !== undefined && candidate.testReceipt !== null
    if (hasReceipt) assertOpaqueTestReceipt(candidate.testReceipt, candidate.candidateId)
    const evaluated = candidate.testEvaluated ?? hasReceipt
    if (evaluated !== hasReceipt) {
      throw new ProtocolError('Candidate testEvaluated 与 opaque receipt 状态不一致')
    }
    for (const key of Object.keys(candidate)) {
      if (/^test(?:Score|Verified|Resolved|Passed|Failed|Rate|Records|Trace)/iu.test(key)) {
        throw new ProtocolError(`Public state 不能包含 sealed 字段：${key}`)
      }
    }
  }
  if (state.inFlight?.testReceipt) {
    assertOpaqueTestReceipt(state.inFlight.testReceipt, state.inFlight.candidateId)
  }
  if (state.inFlight?.stage === 'test_sealed') {
    const hasReceipt = state.inFlight.testReceipt !== undefined && state.inFlight.testReceipt !== null
    if (state.inFlight.testEvaluated !== hasReceipt) {
      throw new ProtocolError('In-flight test checkpoint 与 opaque receipt 状态不一致')
    }
  }
  for (const event of state.events) {
    for (const key of Object.keys(event)) {
      if (/^test(?:Score|Verified|Resolved|Passed|Failed|Rate|Records|Trace)/iu.test(key)) {
        throw new ProtocolError(`Public event 不能包含 sealed 字段：${key}`)
      }
    }
  }
}

function normalizeStoredUsage(value, label) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} usage 格式错误`)
  }
  const usage = {}
  for (const field of USAGE_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new ProtocolError(`${label} usage.${field} 格式错误`)
    }
    usage[field] = value[field]
  }
  return usage
}

function aggregateLatencyFromText(text, label, expectedCount) {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0)
  if (expectedCount !== undefined && lines.length !== expectedCount) {
    throw new ProtocolError(`${label} records 数量错误：期望 ${expectedCount}，实际 ${lines.length}`)
  }
  if (lines.length === 0) return null

  let latencyMs = 0
  let complete = true
  for (const [index, line] of lines.entries()) {
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new ProtocolError(`${label} record ${index + 1} 损坏`, [error.message])
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new ProtocolError(`${label} record ${index + 1} 格式错误`)
    }
    // Older campaign fixtures did not persist latency. Treat the whole
    // aggregate as unavailable rather than publishing a misleading partial sum.
    if (record.latencyMs === undefined || record.latencyMs === null) {
      complete = false
      continue
    }
    if (!Number.isSafeInteger(record.latencyMs) || record.latencyMs < 0
        || !Number.isSafeInteger(latencyMs + record.latencyMs)) {
      throw new ProtocolError(`${label} record ${index + 1} latencyMs 格式错误`)
    }
    latencyMs += record.latencyMs
  }
  return complete ? latencyMs : null
}

async function readAggregateLatency(path, label, expectedCount) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ProtocolError(`无法读取 ${label} records`, [error.message])
  }
  return aggregateLatencyFromText(text, label, expectedCount)
}

function safeAggregate(summary, latencyMs, expectedCandidateId, expectedTotal, label) {
  if (summary?.candidateId !== expectedCandidateId || summary?.total !== expectedTotal
      || !Number.isInteger(summary?.verified) || summary.verified < 0
      || summary.verified > expectedTotal) {
    throw new ProtocolError(`${label} summary 损坏：${expectedCandidateId}`)
  }
  const aggregate = {
    candidateId: expectedCandidateId,
    verified: summary.verified,
    total: summary.total,
    usage: normalizeStoredUsage(summary.usage, `${label} ${expectedCandidateId}`),
    latencyMs,
  }
  if (summary.completedAt !== undefined) {
    if (typeof summary.completedAt !== 'string' || !Number.isFinite(Date.parse(summary.completedAt))) {
      throw new ProtocolError(`${label} completedAt 损坏：${expectedCandidateId}`)
    }
    aggregate.completedAt = summary.completedAt
  }
  return aggregate
}

export class CampaignStore {
  constructor(rootPath, campaignId) {
    assertId(campaignId, 'campaignId')
    this.root = resolve(rootPath, campaignId)
    this.publicRoot = join(this.root, 'public')
    this.privateRoot = join(this.root, 'private')
    this.validationRoot = join(this.root, 'private', 'validation')
    this.validationCheckpointRoot = join(this.root, 'private', 'checkpoints', 'validation')
    this.sealedRoot = join(this.root, 'sealed', 'test')
    this.candidatesRoot = join(this.root, 'candidates')
    this.reportRoot = join(this.root, 'report')
    this.evolutionLogPath = join(this.publicRoot, 'evolution-log.jsonl')
  }

  async grantCandidateAccess(candidateId, groupId) {
    assertId(candidateId, 'candidateId')
    if (!Number.isInteger(groupId) || groupId < 0) throw new ProtocolError('Candidate access groupId 无效')
    const candidateDirectory = join(this.candidatesRoot, candidateId)
    for (const path of [this.root, this.candidatesRoot, candidateDirectory]) {
      await chown(path, 0, groupId)
      await chmod(path, 0o710)
    }
  }

  async grantValidationAccess(candidateId, groupId) {
    assertId(candidateId, 'candidateId')
    if (!Number.isInteger(groupId) || groupId < 0) {
      throw new ProtocolError('Validation access groupId 无效')
    }
    for (const path of [this.root, this.privateRoot, this.validationRoot]) {
      await chown(path, 0, groupId)
      await chmod(path, 0o710)
    }
    const candidateRoot = join(this.validationRoot, candidateId)
    const visit = async (directory) => {
      await chown(directory, 0, groupId)
      await chmod(directory, 0o750)
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) {
          await chown(path, 0, groupId)
          await chmod(path, 0o440)
        }
      }
    }
    await visit(candidateRoot)
  }

  async grantEvolutionLogAccess(groupId) {
    if (!Number.isInteger(groupId) || groupId < 0) {
      throw new ProtocolError('Evolution log access groupId 无效')
    }
    for (const path of [this.root, this.publicRoot]) {
      await chown(path, 0, groupId)
      await chmod(path, 0o710)
    }
    await chown(this.evolutionLogPath, 0, groupId)
    await chmod(this.evolutionLogPath, 0o440)
  }

  async initialize({ config, state }) {
    assertPublicStateSafe(state)
    try {
      await mkdir(this.root, { recursive: false, mode: 0o700 })
    } catch (error) {
      throw new ProtocolError(`Campaign 目录已存在或不可创建：${this.root}`, [error.message])
    }
    await Promise.all([
      makePrivateDirectory(this.publicRoot),
      makePrivateDirectory(this.validationRoot),
      makePrivateDirectory(this.sealedRoot),
      makePrivateDirectory(this.candidatesRoot),
      makePrivateDirectory(this.reportRoot),
    ])
    await atomicJson(join(this.publicRoot, 'config.snapshot.json'), config)
    await atomicJson(join(this.publicRoot, 'state.json'), state)
    await atomicWrite(
      join(this.publicRoot, 'events.jsonl'),
      state.events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    )
    await atomicWrite(this.evolutionLogPath, '')
  }

  async readState() {
    try {
      return JSON.parse(await readFile(join(this.publicRoot, 'state.json'), 'utf8'))
    } catch (error) {
      throw new ProtocolError(`无法读取 Campaign state：${this.root}`, [error.message])
    }
  }

  async saveState(state, { expectedUpdatedAt } = {}) {
    assertPublicStateSafe(state)
    const previous = await this.readState()
    if (expectedUpdatedAt !== undefined && previous.updatedAt !== expectedUpdatedAt) {
      throw new ProtocolError('Campaign state 并发更新冲突')
    }
    if (state.events.length < previous.events.length) throw new ProtocolError('Campaign event log 不能回退')
    for (let index = 0; index < previous.events.length; index += 1) {
      if (JSON.stringify(previous.events[index]) !== JSON.stringify(state.events[index])) {
        throw new ProtocolError('Campaign event log 只能追加，不能改写历史')
      }
    }
    // state.json is authoritative. Commit it first, then rebuild the
    // derivative event stream from the complete history. A crash may leave
    // events.jsonl behind state, but it can never place events ahead of state.
    await atomicJson(join(this.publicRoot, 'state.json'), state)
    await atomicWrite(
      join(this.publicRoot, 'events.jsonl'),
      state.events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    )
  }

  async writeMutationArtifact(candidateId, mutation) {
    assertId(candidateId, 'candidateId')
    const directory = join(this.publicRoot, 'candidates', candidateId)
    await makePrivateDirectory(directory)
    const path = join(directory, 'mutation.json')
    try {
      await atomicCreate(path, `${JSON.stringify(mutation, null, 2)}\n`)
    } catch (error) {
      throw new ProtocolError(`Mutation artifact 已存在或无法写入：${candidateId}`, [error.message])
    }
    return path
  }

  async readMutationArtifactIfExists(candidateId) {
    assertId(candidateId, 'candidateId')
    return readOptionalJson(
      join(this.publicRoot, 'candidates', candidateId, 'mutation.json'),
      `Mutation artifact：${candidateId}`,
    )
  }

  async appendEvolutionLog(entry, secretValues = []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProtocolError('Evolution log entry 必须是对象')
    }
    const safe = redactSecrets(entry, secretValues)
    const entries = await this.readEvolutionLog()
    const existing = entries.find((candidate) => candidate.candidateId === safe.candidateId)
    if (existing) {
      if (isDeepStrictEqual(existing, safe)) return
      throw new ProtocolError('Evolution log candidateId 已存在且内容不同')
    }
    const current = await readFile(this.evolutionLogPath, 'utf8')
    await atomicWrite(this.evolutionLogPath, `${current}${JSON.stringify(safe)}\n`)
  }

  async readEvolutionLog() {
    return readJsonl(this.evolutionLogPath, 'Evolution log')
  }

  async writeCandidateArtifact(candidateId, name, value) {
    assertId(candidateId, 'candidateId')
    if (name !== 'build.json') {
      throw new ProtocolError(`不支持的 Candidate artifact：${name}`)
    }
    const directory = join(this.publicRoot, 'candidates', candidateId)
    await makePrivateDirectory(directory)
    const path = join(directory, name)
    try {
      await atomicCreate(path, `${JSON.stringify(value, null, 2)}\n`)
    } catch (error) {
      throw new ProtocolError(`Candidate artifact 已存在或无法写入：${candidateId}/${name}`, [error.message])
    }
    return path
  }

  async readCandidateArtifactIfExists(candidateId, name) {
    assertId(candidateId, 'candidateId')
    if (name !== 'build.json') throw new ProtocolError(`不支持的 Candidate artifact：${name}`)
    return readOptionalJson(
      join(this.publicRoot, 'candidates', candidateId, name),
      `Candidate artifact：${candidateId}/${name}`,
    )
  }

  async readCandidateArtifact(candidateId, name) {
    assertId(candidateId, 'candidateId')
    if (name !== 'build.json') {
      throw new ProtocolError(`不支持的 Candidate artifact：${name}`)
    }
    try {
      return JSON.parse(await readFile(join(this.publicRoot, 'candidates', candidateId, name), 'utf8'))
    } catch (error) {
      throw new ProtocolError(`无法读取 Candidate artifact：${candidateId}/${name}`, [error.message])
    }
  }

  async writeValidation(candidateId, { summary, records = [], traces = {} }, secretValues = []) {
    assertId(candidateId, 'candidateId')
    const validationTotal = (await this.#readFrozenPartitions()).validation.expectedCount
    if (summary?.candidateId !== candidateId || summary?.total !== validationTotal
        || !Number.isInteger(summary?.verified)
        || summary.verified < 0 || summary.verified > validationTotal) {
      throw new ProtocolError('Validation summary 格式错误')
    }
    const redacted = redactSecrets({ summary, records, traces }, secretValues)
    const publicDirectory = join(this.publicRoot, 'candidates', candidateId)
    const privateDirectory = join(this.validationRoot, candidateId)
    await Promise.all([makePrivateDirectory(publicDirectory), makePrivateDirectory(privateDirectory)])
    await atomicJson(join(privateDirectory, 'summary.json'), redacted.summary)
    await atomicWrite(
      join(privateDirectory, 'records.jsonl'),
      redacted.records.map((record) => JSON.stringify(record)).join('\n') + (redacted.records.length ? '\n' : ''),
    )
    for (const [name, trace] of Object.entries(redacted.traces)) {
      assertId(name, 'trace name')
      await atomicWrite(join(privateDirectory, 'traces', `${name}.jsonl`), String(trace))
    }
    // The public summary is the completion marker consumed by the
    // orchestrator. Publish it only after every feedback artifact is durable.
    await atomicJson(join(publicDirectory, 'validation-summary.json'), redacted.summary)
  }

  async writeValidationTrace(candidateId, taskId, text, secretValues = []) {
    assertId(candidateId, 'candidateId')
    assertId(taskId, 'taskId')
    if (typeof text !== 'string') throw new ProtocolError('Validation trace 必须是字符串')
    const relativeTrace = join('traces', `${taskId}.jsonl`)
    await atomicWrite(
      join(this.validationRoot, candidateId, relativeTrace),
      redactSecrets(text, secretValues),
    )
    return relativeTrace.split('\\').join('/')
  }

  async writeValidationCheckpoint(candidateId, record, secretValues = []) {
    assertId(candidateId, 'candidateId')
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || !INSTANCE_PATTERN.test(record.instanceId ?? '')
        || !['resolved', 'unresolved', 'timeout'].includes(record.status)) {
      throw new ProtocolError('Validation checkpoint record 格式错误')
    }
    const safeRecord = redactSecrets(record, secretValues)
    await atomicJson(
      join(this.validationCheckpointRoot, candidateId, `${record.instanceId}.json`),
      safeRecord,
    )
  }

  async readValidationCheckpoints(candidateId) {
    assertId(candidateId, 'candidateId')
    const directory = join(this.validationCheckpointRoot, candidateId)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new ProtocolError(`无法读取 Validation checkpoints：${candidateId}`, [error.message])
    }
    const records = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        throw new ProtocolError(`Validation checkpoint 目录包含非法条目：${entry.name}`)
      }
      let record
      try {
        record = JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
      } catch (error) {
        throw new ProtocolError(`Validation checkpoint 损坏：${entry.name}`, [error.message])
      }
      const expectedId = entry.name.slice(0, -'.json'.length)
      if (!record || typeof record !== 'object' || Array.isArray(record)
          || record.instanceId !== expectedId || !INSTANCE_PATTERN.test(record.instanceId)
          || !['resolved', 'unresolved', 'timeout'].includes(record.status)) {
        throw new ProtocolError(`Validation checkpoint 格式错误：${entry.name}`)
      }
      records.push(record)
    }
    return records
  }

  async readValidationSummary(candidateId) {
    assertId(candidateId, 'candidateId')
    const validationTotal = (await this.#readFrozenPartitions()).validation.expectedCount
    try {
      const summary = JSON.parse(await readFile(
        join(this.publicRoot, 'candidates', candidateId, 'validation-summary.json'),
        'utf8',
      ))
      if (summary.candidateId !== candidateId || summary.total !== validationTotal
          || !Number.isInteger(summary.verified)
          || summary.verified < 0 || summary.verified > validationTotal) {
        throw new Error('invalid validation summary')
      }
      return summary
    } catch (error) {
      throw new ProtocolError(`无法读取 Validation summary：${candidateId}`, [error.message])
    }
  }

  async readValidationSummaryIfExists(candidateId) {
    assertId(candidateId, 'candidateId')
    const validationTotal = (await this.#readFrozenPartitions()).validation.expectedCount
    const summary = await readOptionalJson(
      join(this.publicRoot, 'candidates', candidateId, 'validation-summary.json'),
      `Validation summary：${candidateId}`,
    )
    if (summary === null) return null
    if (summary.candidateId !== candidateId || summary.total !== validationTotal
        || !Number.isInteger(summary.verified)
        || summary.verified < 0 || summary.verified > validationTotal) {
      throw new ProtocolError(`Validation summary 损坏：${candidateId}`)
    }
    return summary
  }

  async sealTest(candidateId, {
    summary,
    records = [],
    traces = {},
    testManifestSha256,
  }, secretValues = []) {
    assertId(candidateId, 'candidateId')
    const partitions = await this.#readFrozenPartitions()
    const testTotal = partitions.test.expectedCount
    if (summary?.candidateId !== candidateId || summary?.total !== testTotal
        || !Number.isInteger(summary?.verified) || summary.verified < 0 || summary.verified > testTotal
        || !Array.isArray(records) || records.length !== testTotal
        || !SHA256_PATTERN.test(testManifestSha256 ?? '')) {
      throw new ProtocolError('Test summary 格式错误')
    }
    const directory = join(this.sealedRoot, candidateId)
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 })
    } catch (error) {
      throw new ProtocolError(`Test artifact 已存在或无法创建：${candidateId}`, [error.message])
    }
    const redacted = redactSecrets({ summary, records, traces }, secretValues)
    const summaryText = `${JSON.stringify(redacted.summary, null, 2)}\n`
    const recordsText = `${redacted.records.map((record) => JSON.stringify(record)).join('\n')}\n`
    const traceRoot = join(directory, 'traces')
    await makePrivateDirectory(traceRoot)
    await atomicWrite(join(directory, 'summary.json'), summaryText)
    await atomicWrite(join(directory, 'records.jsonl'), recordsText)
    for (const [name, trace] of Object.entries(redacted.traces)) {
      assertId(name, 'trace name')
      await atomicWrite(join(traceRoot, `${name}.jsonl`), String(trace))
    }
    const receipt = {
      receiptId: randomUUID(),
      candidateId,
      status: 'sealed',
      completedAt: summary.completedAt,
    }
    assertOpaqueTestReceipt(receipt, candidateId)
    const internalReceipt = assertInternalSealedReceipt({
      version: 1,
      receipt,
      manifestSha256: testManifestSha256,
      recordCount: testTotal,
      summarySha256: sealedArtifactSha256(summaryText),
      recordsSha256: sealedArtifactSha256(recordsText),
      tracesSha256: await sealedTraceDirectorySha256(traceRoot),
    }, candidateId, testTotal)
    await atomicJson(join(directory, 'receipt.opaque.json'), receipt)
    await atomicJson(join(directory, 'receipt.internal.json'), internalReceipt)
    return receipt
  }

  async readTestReceipt(candidateId) {
    assertId(candidateId, 'candidateId')
    try {
      const receipt = JSON.parse(await readFile(
        join(this.sealedRoot, candidateId, 'receipt.opaque.json'),
        'utf8',
      ))
      return assertOpaqueTestReceipt(receipt, candidateId)
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(`无法读取 opaque test receipt：${candidateId}`, [error.message])
    }
  }

  async readTestReceiptIfExists(candidateId) {
    assertId(candidateId, 'candidateId')
    const receipt = await readOptionalJson(
      join(this.sealedRoot, candidateId, 'receipt.opaque.json'),
      `opaque test receipt：${candidateId}`,
    )
    return receipt === null ? null : assertOpaqueTestReceipt(receipt, candidateId)
  }

  async #readTerminalState(requestedState) {
    const persistedState = await this.readState()
    if (!REPORTABLE_STATES.has(persistedState?.status)) {
      throw new ProtocolError('终态聚合结果只能在 Campaign CLOSED 后读取')
    }
    if (!Array.isArray(persistedState.candidates)) {
      throw new ProtocolError('持久化终态 Campaign 缺少候选账本')
    }
    if (requestedState !== undefined) {
      if (!REPORTABLE_STATES.has(requestedState?.status)
          || requestedState.campaignId !== persistedState.campaignId
          || !isDeepStrictEqual(requestedState.candidates, persistedState.candidates)) {
        throw new ProtocolError('请求的终态 Campaign 与持久化候选账本或 receipt 不一致')
      }
    }
    return persistedState
  }

  async #readFrozenPartitions() {
    let snapshot
    try {
      snapshot = JSON.parse(await readFile(join(this.publicRoot, 'config.snapshot.json'), 'utf8'))
    } catch (error) {
      throw new ProtocolError('无法读取冻结 Campaign 配置', [error.message])
    }
    const campaign = snapshot?.kind === 'CampaignRuntimeSnapshot' ? snapshot.campaign : snapshot
    const validation = campaign?.spec?.partitions?.validation
    const test = campaign?.spec?.partitions?.test
    const digest = test?.sha256
    if (!SHA256_PATTERN.test(digest ?? '')) {
      throw new ProtocolError('冻结 Campaign 缺少 sealed test manifest sha256')
    }
    // Snapshots written before partitionTotals were introduced are all from the
    // original fixed PutnamBench campaign. Keep those readable, but never infer
    // HLE sizes: a new HLE snapshot must explicitly freeze its partition sizes.
    const legacyPutnam = campaign?.spec?.source?.format !== 'hle-text-math'
    const counts = {
      validation: validation?.expectedCount ?? (legacyPutnam ? 500 : undefined),
      test: test?.expectedCount ?? (legacyPutnam ? 172 : undefined),
    }
    for (const name of ['validation', 'test']) {
      if (!Number.isSafeInteger(counts[name])
          || counts[name] < 1 || counts[name] > 10_000) {
        throw new ProtocolError(`冻结 Campaign 缺少 ${name} expectedCount`)
      }
    }
    return {
      validation: { ...validation, expectedCount: counts.validation },
      test: { ...test, expectedCount: counts.test },
    }
  }

  async #readInternalTestReceipt(candidateId, expectedCount) {
    try {
      const value = JSON.parse(await readFile(
        join(this.sealedRoot, candidateId, 'receipt.internal.json'),
        'utf8',
      ))
      return assertInternalSealedReceipt(value, candidateId, expectedCount)
    } catch (error) {
      throw new ProtocolError(`无法校验 sealed test internal receipt：${candidateId}`, [error.message])
    }
  }

  async readValidationAggregates(state) {
    const persistedState = await this.#readTerminalState(state)
    const partitions = await this.#readFrozenPartitions()
    const aggregates = []
    for (const candidate of persistedState.candidates) {
      const candidateId = candidate.candidateId
      assertId(candidateId, 'candidateId')
      let summary
      try {
        summary = JSON.parse(await readFile(
          join(this.publicRoot, 'candidates', candidateId, 'validation-summary.json'),
          'utf8',
        ))
      } catch (error) {
        throw new ProtocolError(`缺少 Validation summary：${candidateId}`, [error.message])
      }
      const latencyMs = await readAggregateLatency(
        join(this.validationRoot, candidateId, 'records.jsonl'),
        `Validation ${candidateId}`,
      )
      aggregates.push(safeAggregate(
        summary,
        latencyMs,
        candidateId,
        partitions.validation.expectedCount,
        'Validation',
      ))
    }
    return aggregates
  }

  async readSealedAggregates(state) {
    const persistedState = await this.#readTerminalState(state)
    const partitions = await this.#readFrozenPartitions()
    const frozenManifestSha256 = partitions.test.sha256
    const expectedCount = partitions.test.expectedCount
    const aggregates = []
    for (const candidate of persistedState.candidates) {
      assertId(candidate.candidateId, 'candidateId')
      if (candidate.testReceipt === undefined || candidate.testReceipt === null) continue
      const opaqueReceipt = await this.readTestReceipt(candidate.candidateId)
      if (!isDeepStrictEqual(opaqueReceipt, candidate.testReceipt)) {
        throw new ProtocolError(`Sealed test receipt 与候选账本不一致：${candidate.candidateId}`)
      }
      const attestation = await this.#readInternalTestReceipt(candidate.candidateId, expectedCount)
      if (!isDeepStrictEqual(attestation.receipt, candidate.testReceipt)
          || attestation.manifestSha256 !== frozenManifestSha256
          || attestation.recordCount !== expectedCount) {
        throw new ProtocolError(`Sealed test internal receipt 与冻结账本不一致：${candidate.candidateId}`)
      }
      const path = join(this.sealedRoot, candidate.candidateId, 'summary.json')
      let summaryBytes
      let summary
      try {
        summaryBytes = await readFile(path)
        summary = JSON.parse(summaryBytes.toString('utf8'))
      } catch (error) {
        throw new ProtocolError(`缺少 sealed test summary：${candidate.candidateId}`, [error.message])
      }
      const recordsPath = join(this.sealedRoot, candidate.candidateId, 'records.jsonl')
      let recordsBytes
      try {
        recordsBytes = await readFile(recordsPath)
      } catch (error) {
        throw new ProtocolError(`缺少 sealed test records：${candidate.candidateId}`, [error.message])
      }
      let tracesSha256
      try {
        tracesSha256 = await sealedTraceDirectorySha256(
          join(this.sealedRoot, candidate.candidateId, 'traces'),
        )
      } catch (error) {
        throw new ProtocolError(`无法校验 sealed test traces：${candidate.candidateId}`, [error.message])
      }
      if (sealedArtifactSha256(summaryBytes) !== attestation.summarySha256
          || sealedArtifactSha256(recordsBytes) !== attestation.recordsSha256
          || tracesSha256 !== attestation.tracesSha256) {
        throw new ProtocolError(`Sealed test 内容与 internal receipt 不一致：${candidate.candidateId}`)
      }
      // Parse the exact bytes covered by the internal receipt. Re-opening the
      // path here would create a time-of-check/time-of-use gap after hashing.
      const latencyMs = aggregateLatencyFromText(
        recordsBytes.toString('utf8'),
        `Sealed test ${candidate.candidateId}`,
        expectedCount,
      )
      aggregates.push(safeAggregate(
        summary,
        latencyMs,
        candidate.candidateId,
        expectedCount,
        'Sealed test',
      ))
    }
    return aggregates
  }
}
