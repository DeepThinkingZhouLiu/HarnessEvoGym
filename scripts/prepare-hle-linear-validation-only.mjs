#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const SCOPE_ROOT = '/mnt/data/hzy/03_dsh_rsi'
const INSTANCE_ID = /^hle_[a-f0-9]{24}$/u

function scoped(path, label) {
  const absolute = resolve(path)
  const rel = relative(SCOPE_ROOT, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay below ${SCOPE_ROOT}`)
  }
  return absolute
}

function parseArgs(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('usage: prepare-hle-linear-validation-only.mjs --records PATH --base-campaign PATH --output-root PATH [--count 10] [--seed TEXT] [--campaign-id ID]')
    }
    options.set(name.slice(2), value)
  }
  for (const required of ['records', 'base-campaign', 'output-root']) {
    if (!options.has(required)) throw new Error(`missing --${required}`)
  }
  const count = Number(options.get('count') ?? '10')
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new Error('--count must be in 1..10000')
  }
  return {
    recordsPath: scoped(options.get('records'), 'records'),
    baseCampaignPath: scoped(options.get('base-campaign'), 'base campaign'),
    outputRoot: scoped(options.get('output-root'), 'output root'),
    count,
    seed: options.get('seed') ?? 'hle-linear-validation-only-v1',
    campaignId: options.get('campaign-id') ?? 'hle-math-linear10-validation-only-qwen38',
  }
}

function digest(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(String(part)).update('\0')
  return hash.digest('hex')
}

function stratum(row) {
  return `${row.rawSubject}\0${row.answerType}`
}

function validateRecord(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || !INSTANCE_ID.test(row.instanceId ?? '')
      || typeof row.rawSubject !== 'string' || row.rawSubject.length === 0
      || !['exactMatch', 'multipleChoice'].includes(row.answerType)) {
    throw new Error(`invalid validation record at line ${index + 1}`)
  }
  return row
}

function allocate(groups, count, seed) {
  const population = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0)
  if (count > population) throw new Error(`requested ${count} rows from only ${population}`)
  const quotas = [...groups].map(([key, rows]) => {
    const exact = count * rows.length / population
    return {
      key,
      capacity: rows.length,
      quota: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      tie: digest('quota', seed, key),
    }
  })
  let assigned = quotas.reduce((sum, entry) => sum + entry.quota, 0)
  while (assigned < count) {
    const next = quotas
      .filter((entry) => entry.quota < entry.capacity)
      .sort((left, right) => right.remainder - left.remainder
        || left.tie.localeCompare(right.tie))[0]
    if (!next) throw new Error('unable to allocate validation subset')
    next.quota += 1
    next.remainder = -1
    assigned += 1
  }
  return new Map(quotas.map((entry) => [entry.key, entry.quota]))
}

async function exclusive(path, contents) {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await chmod(path, 0o600)
}

const options = parseArgs(process.argv.slice(2))
const rowsText = await readFile(options.recordsPath, 'utf8')
if (!rowsText.endsWith('\n')) throw new Error('validation records must end with a newline')
const rows = rowsText.trimEnd().split(/\r?\n/u).map((line, index) => {
  try {
    return validateRecord(JSON.parse(line), index)
  } catch (error) {
    throw new Error(`cannot parse validation line ${index + 1}: ${error.message}`)
  }
})
if (new Set(rows.map((row) => row.instanceId)).size !== rows.length) {
  throw new Error('validation records contain duplicate instance IDs')
}

const groups = new Map()
for (const row of rows) {
  const key = stratum(row)
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}
const quotas = allocate(groups, options.count, options.seed)
const selected = []
const selectedStrata = []
for (const [key, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
  const quota = quotas.get(key)
  if (quota === 0) continue
  const chosen = [...group]
    .sort((left, right) => digest('row', options.seed, left.instanceId)
      .localeCompare(digest('row', options.seed, right.instanceId)))
    .slice(0, quota)
  selected.push(...chosen)
  selectedStrata.push({
    rawSubject: chosen[0].rawSubject,
    answerType: chosen[0].answerType,
    available: group.length,
    selected: chosen.length,
  })
}
selected.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
if (selected.length !== options.count) throw new Error('validation subset count mismatch')

const manifest = `${selected.map((row) => row.instanceId).join('\n')}\n`
const manifestSha256 = createHash('sha256').update(manifest).digest('hex')
const baseCampaign = JSON.parse(await readFile(options.baseCampaignPath, 'utf8'))
const campaign = structuredClone(baseCampaign)
campaign.metadata.id = options.campaignId
campaign.metadata.name = `HLE Math linear ${options.count}-validation-only Harness RSI`
campaign.metadata.setting = 'single-branch-linear-validation-only'
campaign.spec.source.sampling = {
  method: 'deterministic-largest-remainder-from-frozen-validation',
  strata: ['raw_subject', 'answer_type'],
  seed: options.seed,
  eligibleCount: rows.length,
  parentValidationManifestSha256: baseCampaign.spec.partitions.validation.sha256,
}
campaign.spec.partitions.validation = {
  manifest: 'validation.ids',
  expectedCount: options.count,
  sha256: manifestSha256,
  visibility: 'feedback',
}
// A deliberately absent sentinel makes accidental test execution fail closed.
// testEvaluationInterval=0 means the normal baseline and candidate paths never
// invoke the sealed-test runner or open this path.
campaign.spec.partitions.test = {
  manifest: 'TEST_DISABLED_DO_NOT_CREATE.ids',
  expectedCount: baseCampaign.spec.partitions.test.expectedCount,
  sha256: '0'.repeat(64),
  visibility: 'sealed-until-closed',
}
campaign.spec.evolution = {
  ...campaign.spec.evolution,
  topology: 'single-branch-linear',
  testEvaluationInterval: 0,
}

await mkdir(options.outputRoot, { recursive: false, mode: 0o700 })
await chmod(options.outputRoot, 0o700)
await exclusive(join(options.outputRoot, 'validation.ids'), manifest)
await exclusive(join(options.outputRoot, 'campaign.json'), `${JSON.stringify(campaign, null, 2)}\n`)
await exclusive(join(options.outputRoot, 'selection.json'), `${JSON.stringify({
  kind: 'HleLinearValidationSubset',
  count: options.count,
  eligibleCount: rows.length,
  seed: options.seed,
  manifestSha256,
  selectedStrata,
  sourceRecords: options.recordsPath,
  sourceCampaign: options.baseCampaignPath,
}, null, 2)}\n`)

process.stdout.write(`${JSON.stringify({
  campaignId: options.campaignId,
  count: options.count,
  testEvaluationInterval: 0,
  manifestSha256,
  strataRepresented: selectedStrata.length,
  configPath: join(options.outputRoot, 'campaign.json'),
}, null, 2)}\n`)
