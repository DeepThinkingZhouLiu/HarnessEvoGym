import { randomUUID } from 'node:crypto'
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  utimes,
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
const INSTANCE_PATTERN = /^putnam_\d{4}_[ab][1-6]$/u
const REPORTABLE_STATES = new Set(['CLOSED', 'REPORTED'])
const USAGE_FIELDS = ['requests', 'inputTokens', 'outputTokens', 'totalTokens']
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const UPDATER_FEEDBACK_MTIME = new Date('2000-01-01T00:00:00.000Z')
const ABSOLUTE_TIME_TEXT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/gu
const ABSOLUTE_TIME_FIELDS = new Set([
  'accessedat',
  'atime',
  'birthtime',
  'completedat',
  'createdat',
  'ctime',
  'date',
  'endedat',
  'epochtime',
  'evaluatedat',
  'finishedat',
  'modifiedat',
  'mtime',
  'startedat',
  'time',
  'timestamp',
  'updatedat',
])
const UPDATER_RECORD_FIELDS = Object.freeze([
  'instanceId',
  'status',
  'failureKind',
  'solverStatus',
  'verifierStatus',
  'attempts',
  'verifierAttempts',
  'usage',
  'latencyMs',
  'traceRef',
])

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

function scrubAbsoluteTimeText(value) {
  return value.replace(ABSOLUTE_TIME_TEXT, '[NORMALIZED_TIME]')
}

function isTemporalField(key) {
  const normalized = key.replace(/[_-]/gu, '').toLowerCase()
  return ABSOLUTE_TIME_FIELDS.has(normalized) || normalized.endsWith('timestamp')
}

/**
 * Remove wall-clock metadata from material shown to the Updater while keeping
 * relative validation duration, latency, and usage as useful trace evidence.
 * The trusted validation ledger remains byte-for-byte unchanged for terminal
 * reporting; this transformation is used only for the read-only feedback view.
 */
function projectTraceValue(value) {
  if (typeof value === 'string') return scrubAbsoluteTimeText(value)
  if (Array.isArray(value)) return value.map(projectTraceValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isTemporalField(key))
      .map(([key, entry]) => [key, projectTraceValue(entry)]))
  }
  return value
}

function projectTraceText(text) {
  return text.split(/(?<=\n)/u).map((line) => {
    const newline = line.endsWith('\n') ? '\n' : ''
    const body = newline ? line.slice(0, -1) : line
    if (body.length === 0) return line
    try {
      return `${JSON.stringify(projectTraceValue(JSON.parse(body)))}${newline}`
    } catch {
      return `${scrubAbsoluteTimeText(body)}${newline}`
    }
  }).join('')
}

function projectValidationRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ProtocolError('Validation feedback record 格式错误')
  }
  return Object.fromEntries(UPDATER_RECORD_FIELDS
    .filter((field) => record[field] !== undefined)
    .map((field) => [field, projectTraceValue(record[field])]))
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

async function normalizeTreeMtime(root) {
  const paths = []
  const visit = async (directory) => {
    paths.push(directory)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new ProtocolError('Updater feedback projection 不能包含符号链接')
      if (stat.isDirectory()) await visit(path)
      else if (stat.isFile()) paths.push(path)
      else throw new ProtocolError('Updater feedback projection 只能包含普通文件和目录')
    }
  }
  await visit(root)
  // Normalize children first so later directory traversal does not alter a
  // directory timestamp after it has been fixed.
  for (const path of paths.reverse()) {
    await utimes(path, UPDATER_FEEDBACK_MTIME, UPDATER_FEEDBACK_MTIME)
  }
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
    assertOpaqueTestReceipt(candidate.testReceipt, candidate.candidateId)
    for (const key of Object.keys(candidate)) {
      if (/^test(?:Score|Verified|Resolved|Passed|Failed|Rate|Records|Trace)/iu.test(key)) {
        throw new ProtocolError(`Public state 不能包含 sealed 字段：${key}`)
      }
    }
  }
  if (state.inFlight?.testReceipt) {
    assertOpaqueTestReceipt(state.inFlight.testReceipt, state.inFlight.candidateId)
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
    // Only this projected tree is ever mounted into an Updater sandbox.
    this.feedbackRoot = join(this.root, 'private', 'feedback')
    this.validationCheckpointRoot = join(this.root, 'private', 'checkpoints', 'validation')
    this.sealedRoot = join(this.root, 'sealed', 'test')
    this.candidatesRoot = join(this.root, 'candidates')
    this.reportRoot = join(this.root, 'report')
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

  async grantFeedbackAccess(groupId) {
    if (!Number.isInteger(groupId) || groupId < 0) throw new ProtocolError('Feedback access groupId 无效')
    for (const path of [this.root, this.privateRoot]) {
      await chown(path, 0, groupId)
      await chmod(path, 0o710)
    }
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
    await visit(this.feedbackRoot)
  }

  /**
   * Rebuild the complete Updater-visible validation view after the previous
   * candidate's sealed evaluation has finished. Rewriting every projected
   * file and assigning a fixed mtime removes validation-completion anchors:
   * file metadata cannot reveal the elapsed interval spent in sealed test.
   */
  async prepareUpdaterFeedbackProjection() {
    const state = await this.readState()
    if (!Array.isArray(state?.candidates)) throw new ProtocolError('Campaign state 缺少候选账本')
    const candidateIds = state.candidates.map((candidate) => {
      assertId(candidate?.candidateId, 'candidateId')
      return candidate.candidateId
    })
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new ProtocolError('Campaign 候选账本包含重复 candidateId')
    }

    const stage = await mkdtemp(join(this.privateRoot, '.feedback-stage-'))
    let stageCommitted = false
    try {
      await chmod(stage, 0o700)
      for (const candidateId of candidateIds) {
        const source = join(this.validationRoot, candidateId)
        const destination = join(stage, candidateId)
        const summary = JSON.parse(await readFile(join(source, 'summary.json'), 'utf8'))
        if (summary?.candidateId !== candidateId || summary?.total !== 500
            || !Number.isInteger(summary?.verified) || summary.verified < 0 || summary.verified > 500) {
          throw new ProtocolError(`Validation feedback summary 损坏：${candidateId}`)
        }
        await makePrivateDirectory(destination)
        await atomicJson(join(destination, 'summary.json'), {
          candidateId,
          verified: summary.verified,
          total: summary.total,
          ...(summary.usage === undefined ? {} : { usage: projectTraceValue(summary.usage) }),
        })
        const records = await readJsonl(
          join(source, 'records.jsonl'),
          `Validation feedback ${candidateId}`,
        )
        await atomicWrite(
          join(destination, 'records.jsonl'),
          records.map((record) => JSON.stringify(projectValidationRecord(record))).join('\n')
            + (records.length > 0 ? '\n' : ''),
        )

        const traceSource = join(source, 'traces')
        let traceEntries
        try {
          traceEntries = await readdir(traceSource, { withFileTypes: true })
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          traceEntries = []
        }
        for (const entry of traceEntries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
            throw new ProtocolError(`Validation trace 目录包含非法条目：${entry.name}`)
          }
          const sourcePath = join(traceSource, entry.name)
          const stat = await lstat(sourcePath)
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new ProtocolError(`Validation trace 必须是普通文件：${entry.name}`)
          }
          await atomicWrite(
            join(destination, 'traces', entry.name),
            projectTraceText(await readFile(sourcePath, 'utf8')),
          )
        }
      }
      await normalizeTreeMtime(stage)

      const retired = `${this.feedbackRoot}.retired-${process.pid}-${randomUUID()}`
      let hadPrevious = true
      try {
        await rename(this.feedbackRoot, retired)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        hadPrevious = false
      }
      try {
        await rename(stage, this.feedbackRoot)
        stageCommitted = true
      } catch (error) {
        if (hadPrevious) await rename(retired, this.feedbackRoot).catch(() => {})
        throw error
      }
      if (hadPrevious) await rm(retired, { recursive: true, force: true })
      return this.feedbackRoot
    } finally {
      if (!stageCommitted) await rm(stage, { recursive: true, force: true }).catch(() => {})
    }
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
      makePrivateDirectory(this.feedbackRoot),
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

  async writeProposal(candidateId, proposal) {
    assertId(candidateId, 'candidateId')
    const directory = join(this.publicRoot, 'candidates', candidateId)
    await makePrivateDirectory(directory)
    const path = join(directory, 'proposal.json')
    try {
      await atomicCreate(path, `${JSON.stringify(proposal, null, 2)}\n`)
    } catch (error) {
      throw new ProtocolError(`Proposal 已冻结或无法写入：${candidateId}`, [error.message])
    }
    return path
  }

  async readProposalIfExists(candidateId) {
    assertId(candidateId, 'candidateId')
    return readOptionalJson(
      join(this.publicRoot, 'candidates', candidateId, 'proposal.json'),
      `冻结 Proposal：${candidateId}`,
    )
  }

  async readProposal(candidateId) {
    assertId(candidateId, 'candidateId')
    try {
      return JSON.parse(await readFile(join(this.publicRoot, 'candidates', candidateId, 'proposal.json'), 'utf8'))
    } catch (error) {
      throw new ProtocolError(`无法读取冻结 Proposal：${candidateId}`, [error.message])
    }
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

  async writeMutationBundle(candidateId, bundle) {
    assertId(candidateId, 'candidateId')
    const path = join(this.publicRoot, 'candidates', candidateId, 'mutation-bundle.json')
    try {
      await atomicCreate(path, `${JSON.stringify(bundle, null, 2)}\n`)
    } catch (error) {
      throw new ProtocolError(`Mutation bundle 已冻结或无法写入：${candidateId}`, [error.message])
    }
    return path
  }

  async readMutationBundleIfExists(candidateId) {
    assertId(candidateId, 'candidateId')
    return readOptionalJson(
      join(this.publicRoot, 'candidates', candidateId, 'mutation-bundle.json'),
      `Mutation bundle：${candidateId}`,
    )
  }

  async writeValidation(candidateId, { summary, records = [], traces = {} }, secretValues = []) {
    assertId(candidateId, 'candidateId')
    if (summary?.candidateId !== candidateId || summary?.total !== 500
        || !Number.isInteger(summary?.verified) || summary.verified < 0 || summary.verified > 500) {
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
    try {
      const summary = JSON.parse(await readFile(
        join(this.publicRoot, 'candidates', candidateId, 'validation-summary.json'),
        'utf8',
      ))
      if (summary.candidateId !== candidateId || summary.total !== 500
          || !Number.isInteger(summary.verified) || summary.verified < 0 || summary.verified > 500) {
        throw new Error('invalid validation summary')
      }
      return summary
    } catch (error) {
      throw new ProtocolError(`无法读取 Validation summary：${candidateId}`, [error.message])
    }
  }

  async readValidationSummaryIfExists(candidateId) {
    assertId(candidateId, 'candidateId')
    const summary = await readOptionalJson(
      join(this.publicRoot, 'candidates', candidateId, 'validation-summary.json'),
      `Validation summary：${candidateId}`,
    )
    if (summary === null) return null
    if (summary.candidateId !== candidateId || summary.total !== 500
        || !Number.isInteger(summary.verified) || summary.verified < 0 || summary.verified > 500) {
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
    if (summary?.candidateId !== candidateId || summary?.total !== 172
        || !Number.isInteger(summary?.verified) || summary.verified < 0 || summary.verified > 172
        || !Array.isArray(records) || records.length !== 172
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
      recordCount: 172,
      summarySha256: sealedArtifactSha256(summaryText),
      recordsSha256: sealedArtifactSha256(recordsText),
      tracesSha256: await sealedTraceDirectorySha256(traceRoot),
    }, candidateId)
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

  async #readFrozenTestManifestSha256() {
    let snapshot
    try {
      snapshot = JSON.parse(await readFile(join(this.publicRoot, 'config.snapshot.json'), 'utf8'))
    } catch (error) {
      throw new ProtocolError('无法读取冻结 Campaign 配置', [error.message])
    }
    const campaign = snapshot?.kind === 'CampaignRuntimeSnapshot' ? snapshot.campaign : snapshot
    const digest = campaign?.spec?.partitions?.test?.sha256
    if (!SHA256_PATTERN.test(digest ?? '')) {
      throw new ProtocolError('冻结 Campaign 缺少 sealed test manifest sha256')
    }
    return digest
  }

  async #readInternalTestReceipt(candidateId) {
    try {
      const value = JSON.parse(await readFile(
        join(this.sealedRoot, candidateId, 'receipt.internal.json'),
        'utf8',
      ))
      return assertInternalSealedReceipt(value, candidateId)
    } catch (error) {
      throw new ProtocolError(`无法校验 sealed test internal receipt：${candidateId}`, [error.message])
    }
  }

  async readValidationAggregates(state) {
    const persistedState = await this.#readTerminalState(state)
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
      aggregates.push(safeAggregate(summary, latencyMs, candidateId, 500, 'Validation'))
    }
    return aggregates
  }

  async readSealedAggregates(state) {
    const persistedState = await this.#readTerminalState(state)
    const frozenManifestSha256 = await this.#readFrozenTestManifestSha256()
    const aggregates = []
    for (const candidate of persistedState.candidates) {
      assertId(candidate.candidateId, 'candidateId')
      const opaqueReceipt = await this.readTestReceipt(candidate.candidateId)
      if (!isDeepStrictEqual(opaqueReceipt, candidate.testReceipt)) {
        throw new ProtocolError(`Sealed test receipt 与候选账本不一致：${candidate.candidateId}`)
      }
      const attestation = await this.#readInternalTestReceipt(candidate.candidateId)
      if (!isDeepStrictEqual(attestation.receipt, candidate.testReceipt)
          || attestation.manifestSha256 !== frozenManifestSha256
          || attestation.recordCount !== 172) {
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
        172,
      )
      aggregates.push(safeAggregate(summary, latencyMs, candidate.candidateId, 172, 'Sealed test'))
    }
    return aggregates
  }
}
