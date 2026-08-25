import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { ProtocolError } from './protocol.mjs'

export const HLE_DATASET_PIN = Object.freeze({
  dataset: 'cais/hle',
  revision: '5a81a4c7271a2a2a312b9a690f0c2fde837e4c29',
})
export const HLE_PARTITION_SIZE = 50
export const HLE_TOTAL_SAMPLE_SIZE = HLE_PARTITION_SIZE * 2

const INSTANCE_ID_PATTERN = /^hle_[a-f0-9]{24}$/u
const ANSWER_TYPES = new Set(['exactMatch', 'multipleChoice'])

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError(`${label} 必须是非空字符串`)
  }
  return value
}

function noImage(value) {
  return value === null || value === undefined || value === ''
}

/** The solver-visible modality filter. Rationale images are never solver input. */
export function isHleTextOnlyMath(row) {
  return row && typeof row === 'object'
    && String(row.category ?? '').trim().toLowerCase() === 'math'
    && noImage(row.image)
    && noImage(row.image_preview)
}

export function normalizeHleTextMathRow(value, index = 0) {
  const row = object(value, `HLE row ${index}`)
  if (!isHleTextOnlyMath(row)) {
    throw new ProtocolError(`HLE row ${index} 不是 text-only Math`)
  }
  const answerType = nonempty(row.answer_type, `HLE row ${index}.answer_type`)
  if (!ANSWER_TYPES.has(answerType)) {
    throw new ProtocolError(`HLE row ${index}.answer_type 不受支持：${answerType}`)
  }
  return Object.freeze({
    sourceId: nonempty(row.id, `HLE row ${index}.id`),
    question: nonempty(row.question, `HLE row ${index}.question`),
    answer: nonempty(row.answer, `HLE row ${index}.answer`),
    answerType,
    rawSubject: typeof row.raw_subject === 'string' && row.raw_subject.trim().length > 0
      ? row.raw_subject.trim()
      : 'Unspecified Math',
    category: 'Math',
  })
}

function digest(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(String(part)).update('\0')
  return hash.digest('hex')
}

function stratumKey(row) {
  return `${row.rawSubject}\u0000${row.answerType}`
}

function allocateLargestRemainder(groups, total, seed) {
  const population = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0)
  const entries = [...groups.entries()].map(([key, rows]) => {
    const exact = total * rows.length / population
    return {
      key,
      capacity: rows.length,
      quota: Math.min(rows.length, Math.floor(exact)),
      remainder: exact - Math.floor(exact),
      tie: digest('quota', seed, key),
    }
  })
  let assigned = entries.reduce((sum, entry) => sum + entry.quota, 0)
  while (assigned < total) {
    const available = entries
      .filter((entry) => entry.quota < entry.capacity)
      .sort((left, right) => right.remainder - left.remainder
        || left.tie.localeCompare(right.tie))
    if (available.length === 0) throw new ProtocolError('HLE 分层配额无法满足样本数')
    available[0].quota += 1
    // A stratum receives at most one largest-remainder seat before the next pass.
    available[0].remainder = -1
    assigned += 1
  }
  return new Map(entries.map((entry) => [entry.key, entry.quota]))
}

function opaqueId(seed, sourceId) {
  return `hle_${digest('opaque-instance-v1', seed, sourceId).slice(0, 24)}`
}

function publicRecord(row, seed) {
  return Object.freeze({
    instanceId: opaqueId(seed, row.sourceId),
    sourceId: row.sourceId,
    question: row.question,
    answer: row.answer,
    answerType: row.answerType,
    rawSubject: row.rawSubject,
    category: row.category,
  })
}

/**
 * Deterministically sample 100 rows, preserving raw_subject × answer_type.
 * Combined quotas use largest remainder; every stratum is then split as close
 * to 50/50 as arithmetically possible, so validation and test have 50 rows.
 */
export function stratifiedHleSplit(inputRows, {
  seed = 'hle-text-math-rsi-v1',
  validationCount = HLE_PARTITION_SIZE,
  testCount = HLE_PARTITION_SIZE,
} = {}) {
  if (!Array.isArray(inputRows)) throw new ProtocolError('HLE rows 必须是数组')
  if (!Number.isSafeInteger(validationCount) || validationCount < 1
      || !Number.isSafeInteger(testCount) || testCount < 1
      || typeof seed !== 'string' || seed.length === 0) {
    throw new ProtocolError('HLE split 参数无效')
  }
  const normalized = inputRows.map(normalizeHleTextMathRow)
  const sourceIds = normalized.map((row) => row.sourceId)
  if (new Set(sourceIds).size !== sourceIds.length) throw new ProtocolError('HLE source ID 不能重复')
  const total = validationCount + testCount
  if (normalized.length < total) {
    throw new ProtocolError(`HLE text-only Math 只有 ${normalized.length} 题，不足 ${total} 题`)
  }

  const groups = new Map()
  for (const row of normalized) {
    const key = stratumKey(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const quotas = allocateLargestRemainder(groups, total, seed)
  const oddStrata = [...quotas]
    .filter(([, quota]) => quota % 2 === 1)
    .sort(([left], [right]) => digest('odd', seed, left).localeCompare(digest('odd', seed, right)))
  let validationRemaining = validationCount
    - [...quotas.values()].reduce((sum, quota) => sum + Math.floor(quota / 2), 0)
  if (validationRemaining < 0 || validationRemaining > oddStrata.length) {
    throw new ProtocolError('HLE validation/test 分层无法保持目标数量')
  }
  const validationOdd = new Set(oddStrata.slice(0, validationRemaining).map(([key]) => key))

  const validation = []
  const test = []
  const strata = []
  for (const [key, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const quota = quotas.get(key)
    if (quota === 0) continue
    const selected = [...rows]
      .sort((left, right) => digest('row', seed, left.sourceId)
        .localeCompare(digest('row', seed, right.sourceId)))
      .slice(0, quota)
    const validationQuota = Math.floor(quota / 2) + (validationOdd.has(key) ? 1 : 0)
    const validationRows = selected.slice(0, validationQuota).map((row) => publicRecord(row, seed))
    const testRows = selected.slice(validationQuota).map((row) => publicRecord(row, seed))
    validation.push(...validationRows)
    test.push(...testRows)
    strata.push(Object.freeze({
      rawSubject: selected[0].rawSubject,
      answerType: selected[0].answerType,
      eligible: rows.length,
      sampled: quota,
      validation: validationRows.length,
      test: testRows.length,
    }))
  }

  validation.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  test.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  const validationIds = new Set(validation.map((row) => row.instanceId))
  const testIds = new Set(test.map((row) => row.instanceId))
  if (validation.length !== validationCount || test.length !== testCount
      || validationIds.size !== validation.length || testIds.size !== test.length
      || [...validationIds].some((id) => testIds.has(id))) {
    throw new ProtocolError('HLE split 不变式失败')
  }
  return Object.freeze({
    validation: Object.freeze(validation),
    test: Object.freeze(test),
    strata: Object.freeze(strata),
    seed,
    eligibleCount: normalized.length,
  })
}

export async function readHleJsonl(path) {
  const text = await readFile(resolve(path), 'utf8')
  if (!text.endsWith('\n')) throw new ProtocolError('HLE JSONL 必须保留末尾换行')
  return text.trimEnd().split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new ProtocolError(`HLE JSONL 第 ${index + 1} 行无法解析`, [error.message])
    }
  })
}

function manifestText(records) {
  return `${records.map((row) => row.instanceId).join('\n')}\n`
}

function recordsText(records) {
  return `${records.map((row) => JSON.stringify(row)).join('\n')}\n`
}

async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  await writeFile(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await chmod(path, 0o600)
}

/** Write restricted data only to ignored/private roots and return aggregate metadata. */
export async function writeHleSplit({ split, controlRoot, datasetRoot }) {
  object(split, 'split')
  const control = resolve(controlRoot)
  const dataset = resolve(datasetRoot)
  const validationManifest = manifestText(split.validation)
  const testManifest = manifestText(split.test)
  const validationStore = join(dataset, 'validation', 'records.jsonl')
  const testStore = join(dataset, 'sealed', 'test', 'records.jsonl')
  await privateWrite(join(control, 'validation.ids'), validationManifest)
  await privateWrite(join(control, 'test.ids'), testManifest)
  await privateWrite(validationStore, recordsText(split.validation))
  await privateWrite(testStore, recordsText(split.test))
  return Object.freeze({
    validationCount: split.validation.length,
    testCount: split.test.length,
    eligibleCount: split.eligibleCount,
    validationManifestSha256: createHash('sha256').update(validationManifest).digest('hex'),
    testManifestSha256: createHash('sha256').update(testManifest).digest('hex'),
    validationStore,
    testStore,
    strata: split.strata,
  })
}

export function assertHleInstanceId(value) {
  if (typeof value !== 'string' || !INSTANCE_ID_PATTERN.test(value)) {
    throw new ProtocolError('HLE instance ID 无效')
  }
  return value
}

/** Validate only the parent-visible validation store. The sealed child owns test checks. */
export async function prepareHleTextMathDataset({ datasetRoot }) {
  const root = resolve(datasetRoot)
  const validationRoot = join(root, 'validation')
  const validationPath = join(validationRoot, 'records.jsonl')
  const validationStat = await lstat(validationPath)
  if (!validationStat.isFile() || validationStat.isSymbolicLink() || validationStat.size < 2) {
    throw new ProtocolError('HLE validation private store 无效')
  }
  // The parent neither opens nor stats the sealed-test store. Its path is
  // re-derived by the broker and validated only in the sealed child.
  return Object.freeze({ solutionsRoot: validationRoot, leanRoot: root })
}
