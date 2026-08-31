#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTROLLER_PATH = join(REPOSITORY_ROOT, 'controller', 'src', 'cli.mjs')
const RUNS_ROOT = join(REPOSITORY_ROOT, '.rsi', 'runs', 'populations')
const ALL_MODES = Object.freeze(['single', 'independent', 'mutualism', 'competition', 'combined'])
const REQUIRED_ENVIRONMENT = Object.freeze([
  'RSI_PROVIDER_BASE_URL',
  'RSI_PROVIDER_API_KEY',
  'RSI_OFFICEVAL_DATASET_ROOT',
  'RSI_OFFICEVAL_EVALUATOR_ROOT',
])
const activeChildren = new Set()
const failures = []
let shutdownSignal = null

function now() {
  return new Date().toISOString()
}

function suiteId() {
  const fallback = `cowork-mvp-codex-terra-high-${now().replace(/[:.]/gu, '-').toLowerCase()}`
  const value = process.env.RSI_MVP_SUITE_ID?.trim() || fallback
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(value)) {
    throw new Error('RSI_MVP_SUITE_ID 只能包含小写字母、数字、点、下划线和连字符')
  }
  return value
}

function selectedModes() {
  const raw = process.env.RSI_MVP_MODES?.trim()
  if (!raw) return [...ALL_MODES]
  const values = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))]
  if (values.length === 0 || values.some((value) => !ALL_MODES.includes(value))) {
    throw new Error(`RSI_MVP_MODES 必须来自：${ALL_MODES.join(',')}`)
  }
  return values
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}..${maximum} 的整数`)
  }
  return value
}

function assertEnvironment() {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) throw new Error(`缺少 MVP 运行变量：${missing.join(', ')}`)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function runController({ campaign, action, logPath }) {
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
  log.write(`${JSON.stringify({ type: 'mvp-command-started', at: now(), action })}\n`)
  const args = action === 'run'
    ? [CONTROLLER_PATH, 'experiment', 'run', '--config', campaign.config, '--run-id', campaign.runId]
    : [CONTROLLER_PATH, 'experiment', 'resume', '--run', join(RUNS_ROOT, campaign.runId)]
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const result = await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => accept({ code, signal }))
  })
  activeChildren.delete(child)
  log.write(`${JSON.stringify({ type: 'mvp-command-completed', at: now(), action, ...result })}\n`)
  await new Promise((accept) => log.end(accept))
  return result
}

async function runCampaign(campaign, outputRoot, maximumResumes) {
  let resumes = 0
  while (shutdownSignal === null) {
    const statePath = join(RUNS_ROOT, campaign.runId, 'public', 'state.json')
    const before = await readJson(statePath)
    if (before?.status === 'CLOSED') return before
    const action = before === null ? 'run' : before.status === 'PAUSED_INFRASTRUCTURE' ? 'resume' : null
    if (action === null) throw new Error(`${campaign.mode} 处于不可自动推进状态：${before.status}`)
    if (action === 'resume') {
      if (resumes >= maximumResumes) {
        throw new Error(`${campaign.mode} 超过 MVP 最大 Resume 次数 ${maximumResumes}`)
      }
      resumes += 1
    }
    const result = await runController({
      campaign,
      action,
      logPath: join(outputRoot, `${campaign.mode}.log`),
    })
    const after = await readJson(statePath)
    if (after?.status === 'CLOSED') return after
    if (after?.status === 'PAUSED_INFRASTRUCTURE') continue
    throw new Error(`${campaign.mode} ${action} 失败：code=${result.code} signal=${result.signal}`)
  }
  throw new Error(`MVP Suite 收到 ${shutdownSignal}`)
}

async function main() {
  assertEnvironment()
  const id = suiteId()
  const outputRoot = join(REPOSITORY_ROOT, '.rsi', 'experiment-suites', id)
  await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 })
  await mkdir(outputRoot, { recursive: false, mode: 0o700 })
  const modes = selectedModes()
  const maximumResumes = integerEnvironment('RSI_MVP_MAX_RESUMES', 1, 0, 2)
  const maximumConcurrentModes = integerEnvironment('RSI_MVP_MAX_CONCURRENT_MODES', 1, 1, 2)
  const campaigns = modes.map((mode) => ({
    mode,
    config: join(REPOSITORY_ROOT, 'experiments', `cowork-msa-mvp-codex-${mode}.json`),
    runId: `${id}-${mode}`,
  }))
  const queue = [...campaigns]
  const results = new Map()

  async function worker() {
    while (shutdownSignal === null) {
      const campaign = queue.shift()
      if (!campaign) return
      try {
        results.set(campaign.mode, await runCampaign(campaign, outputRoot, maximumResumes))
      } catch (error) {
        failures.push({ mode: campaign.mode, message: error.message })
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrentModes, campaigns.length) },
    () => worker(),
  ))
  const summary = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'CoworkMvpSuiteSummary',
    suiteId: id,
    completedAt: now(),
    requestedModes: modes,
    maximumConcurrentModes,
    maximumResumes,
    campaigns: campaigns.map(({ mode, runId }) => {
      const state = results.get(mode)
      const failure = failures.find((entry) => entry.mode === mode)
      return {
        mode,
        runId,
        status: state?.status ?? (shutdownSignal ? 'INTERRUPTED' : 'FAILED'),
        consumedBudget: state?.budget?.consumed ?? null,
        bestCandidateId: state?.best?.candidateId ?? null,
        failure: failure?.message ?? null,
      }
    }),
  }
  await writeFile(
    join(outputRoot, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (failures.length > 0 || shutdownSignal !== null) process.exitCode = 1
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdownSignal = signal
    for (const child of activeChildren) {
      child.kill(signal)
      const escalation = setTimeout(() => child.kill('SIGKILL'), 10_000)
      escalation.unref()
    }
  })
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
