#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExperimentBundle } from '../controller/src/adapters.mjs'
import { readResultFile, validateResultRecords, writeJsonFile } from '../controller/src/protocol.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) fail('Usage: prepare-grhs-continuation --source-run <path> --output-run <path> --experiment <path>')
    options.set(name.slice(2), value)
  }
  for (const name of ['source-run', 'output-run', 'experiment']) {
    if (!options.has(name)) fail(`Missing --${name}`)
  }
  return options
}

function publicBundleSnapshot(bundle) {
  return {
    experiment: bundle.experiment,
    recipe: bundle.recipe,
    target: bundle.target,
    updater: bundle.updater,
    provider: bundle.provider,
    environment: bundle.environment,
    strategy: bundle.strategy,
    benchmark: {
      id: bundle.benchmark.id,
      name: bundle.benchmark.name,
      source: bundle.benchmark.source,
      evaluator: bundle.benchmark.evaluator,
      expectedTotal: bundle.benchmark.expectedTotal,
      partitions: bundle.benchmark.partitions,
    },
    policy: bundle.policy,
  }
}

function jsonDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
}

async function checkpointRecords(sourceRun, candidateId, partition) {
  const records = new Map()
  const trialsRoot = join(sourceRun, 'trials')
  for (const executionId of await readdir(trialsRoot)) {
    const partitionRoot = join(trialsRoot, executionId, candidateId, partition)
    try {
      if (!(await stat(partitionRoot)).isDirectory()) continue
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const instanceId of await readdir(partitionRoot)) {
      const checkpointPath = join(partitionRoot, instanceId, 'committed-result.json')
      let checkpoint
      try {
        checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (checkpoint.spec?.identity?.candidate?.id !== candidateId
          || checkpoint.spec?.identity?.partition !== partition
          || checkpoint.spec?.identity?.instanceId !== instanceId
          || checkpoint.spec?.record?.instance_id !== instanceId) {
        fail(`Invalid checkpoint identity: ${checkpointPath}`)
      }
      if (records.has(instanceId)) fail(`Duplicate checkpoint for ${candidateId}/${partition}/${instanceId}`)
      records.set(instanceId, checkpoint.spec.record)
    }
  }
  return records
}

async function recordsFor(sourceRun, generation, candidateId, partition) {
  const output = join(sourceRun, 'results', `generation-${generation}`, `${candidateId}-${partition}.jsonl`)
  try {
    const records = await readResultFile(output)
    return new Map(records.map((record) => [record.instance_id, record]))
  } catch (error) {
    if (!error.message.includes('无法访问结果文件')) throw error
    return checkpointRecords(sourceRun, candidateId, partition)
  }
}

const options = parseArgs(process.argv.slice(2))
const sourceRun = await realpath(resolve(options.get('source-run')))
const outputRun = resolve(options.get('output-run'))
const runsRoot = await realpath(join(repositoryRoot, '.rsi', 'runs'))
if (relative(runsRoot, sourceRun).startsWith('..') || relative(runsRoot, outputRun).startsWith('..')) {
  fail('Source and output runs must be inside .rsi/runs')
}
if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(basename(outputRun))) fail('Invalid output run id')
try {
  await stat(outputRun)
  fail(`Output run already exists: ${outputRun}`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const experimentPath = resolve(repositoryRoot, options.get('experiment'))
const bundle = await loadExperimentBundle(experimentPath, repositoryRoot)
if (bundle.experiment.evolution.grhs?.groupSize !== 2 || bundle.experiment.evolution.generations !== 1) {
  fail('Continuation requires one generation with exactly two GRHS siblings')
}
const selectionIds = bundle.benchmark.partitions.selection.instanceIds
const sourceState = JSON.parse(await readFile(join(sourceRun, 'state.json'), 'utf8'))
if (sourceState.metadata?.status !== 'failed' || sourceState.spec?.generationsCompleted !== 0) {
  fail('Source run must be a failed generation-1 checkpoint')
}
const generation = 1
const level = sourceState.spec.mutationLevel
const baselineId = sourceState.spec.baselineId
const siblingIds = [1, 2].map((member) =>
  `g001-grhs-s${String(member).padStart(3, '0')}-${level}`)
const candidateIds = [baselineId, ...siblingIds]

const selectionRecords = new Map()
for (const candidateId of candidateIds) {
  const available = await recordsFor(sourceRun, generation, candidateId, 'selection')
  const selected = selectionIds.map((instanceId) => available.get(instanceId))
  const missing = selectionIds.filter((_, index) => !selected[index])
  if (missing.length > 0) fail(`${candidateId} is missing Selection checkpoints: ${missing.join(', ')}`)
  validateResultRecords(selected, bundle.benchmark, `${candidateId}/selection continuation`)
  selectionRecords.set(candidateId, selected)
}
const feedbackRecords = await recordsFor(sourceRun, generation, baselineId, 'feedback')
const selectedFeedback = bundle.benchmark.partitions.feedback.instanceIds.map((instanceId) => feedbackRecords.get(instanceId))
if (selectedFeedback.some((record) => !record)) fail('Baseline is missing required Feedback checkpoints')
validateResultRecords(selectedFeedback, bundle.benchmark, `${baselineId}/feedback continuation`)

await mkdir(outputRun, { recursive: false, mode: 0o700 })
for (const candidateId of candidateIds) {
  await cp(join(sourceRun, 'candidates', candidateId), join(outputRun, 'candidates', candidateId), {
    recursive: true,
    errorOnExist: true,
  })
}
await Promise.all([
  cp(join(sourceRun, 'mutation-catalog.json'), join(outputRun, 'mutation-catalog.json')),
  cp(join(sourceRun, 'mutation-policy.json'), join(outputRun, 'mutation-policy.json')),
])
for (const [candidateId, records] of selectionRecords) {
  await writeText(join(outputRun, 'results', 'generation-1', `${candidateId}-selection.jsonl`), jsonl(records))
}
await writeText(join(outputRun, 'results', 'generation-1', `${baselineId}-feedback.jsonl`), jsonl(selectedFeedback))

const snapshot = publicBundleSnapshot(bundle)
const controllerRevision = execFileSync(
  'git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
).trim()
const state = structuredClone(sourceState)
state.metadata.id = basename(outputRun)
state.metadata.status = 'failed'
state.spec.experimentPath = relative(repositoryRoot, experimentPath).replaceAll('\\', '/')
state.spec.controllerRevision = controllerRevision
state.spec.configDigest = jsonDigest(snapshot)
state.spec.generationsRequested = 1
state.spec.generationsCompleted = 0
state.spec.championId = baselineId
state.spec.candidates = state.spec.candidates.filter(({ id }) => id === baselineId)
state.spec.searchHistory = []
state.spec.grhs.groups = []
state.spec.failure = {
  message: '基础设施失败：从原 11-task Run 派生显式 quick9 continuation',
  details: [
    `sourceRun=${basename(sourceRun)}`,
    `selectionTasks=${selectionIds.length}`,
    'excluded=officeval_058,officeval_076',
  ],
}
state.spec.recoveries = [
  ...(Array.isArray(state.spec.recoveries) ? state.spec.recoveries : []),
  {
    at: new Date().toISOString(),
    fromRunId: sourceState.metadata.id,
    reason: 'explicit quick9 continuation; compare all candidates on the same completed Selection tasks',
    preservedSourceRun: true,
  },
]
await Promise.all([
  writeJsonFile(join(outputRun, 'experiment.snapshot.json'), snapshot),
  writeJsonFile(join(outputRun, 'state.json'), state),
])

process.stdout.write(`${JSON.stringify({
  sourceRun,
  outputRun,
  experiment: bundle.experiment.id,
  selectionIds,
  candidates: candidateIds,
}, null, 2)}\n`)
