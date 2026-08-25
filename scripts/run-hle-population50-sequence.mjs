#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE_ROOT = resolve(REPOSITORY_ROOT, '..')
const CONFIG_ROOT = join(
  REPOSITORY_ROOT,
  'benchmarks',
  'hle-text-math',
  'msa-population50-codex-terra-high',
)
const RUNTIME_PATH = join(
  REPOSITORY_ROOT,
  'environments',
  'hle-text-math',
  'msa-codex-terra-high-runtime.json',
)
const RUNNER_PATH = join(REPOSITORY_ROOT, 'scripts', 'resume-hle-short-updater-root.mjs')
const SOURCE_ROOT = join(SCOPE_ROOT, 'sources', 'msa-minimal-harness')
const CAMPAIGNS_ROOT = join(SCOPE_ROOT, 'dsh-rsi-runtime', 'campaigns')
const OUTPUT_ROOT = join(
  SCOPE_ROOT,
  'dsh-rsi-runtime',
  'experiments',
  'hle-math50-five-mode-terra-high',
)
const KEY_PATH = join(SCOPE_ROOT, 'zcloud.txt')
const RETRY_DELAY_MS = 60_000

const CAMPAIGNS = Object.freeze([
  {
    mode: 'single',
    config: 'single.json',
    campaignId: 'hle-math50-terra-high-single-b32',
  },
  {
    mode: 'independent',
    config: 'independent.json',
    campaignId: 'hle-math50-terra-high-independent-n2-b32',
  },
  {
    mode: 'mutualism',
    config: 'mutualism.json',
    campaignId: 'hle-math50-terra-high-mutualism-n2-b32',
  },
  {
    mode: 'competition',
    config: 'competition.json',
    campaignId: 'hle-math50-terra-high-competition-n2-b32-beta05',
  },
  {
    mode: 'combined',
    config: 'combined.json',
    campaignId: 'hle-math50-terra-high-combined-n2-b32-beta05',
  },
])

let activeChild = null

function now() {
  return new Date().toISOString()
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function writeSequenceState(value) {
  await writeFile(
    join(OUTPUT_ROOT, 'sequence-state.json'),
    `${JSON.stringify({ pid: process.pid, updatedAt: now(), ...value }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

async function readProviderConfiguration() {
  const lines = (await readFile(KEY_PATH, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 2 || !lines[0].startsWith('https://') || lines[1].length < 8) {
    throw new Error('zcloud.txt 必须恰好包含 API URL 和 API key 两行')
  }
  const runtime = JSON.parse(await readFile(RUNTIME_PATH, 'utf8'))
  if (runtime.gateway?.upstreamBaseUrl !== lines[0]) {
    throw new Error('zcloud.txt API URL 与冻结 Runtime 不一致')
  }
  return lines[1]
}

async function readCampaignState(campaignId) {
  const path = join(CAMPAIGNS_ROOT, campaignId, 'public', 'state.json')
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function nextAction(state) {
  if (state === null) return 'start'
  if (state.status === 'PAUSED_INFRASTRUCTURE') return 'resume'
  if (state.status === 'EVOLVING') return 'run'
  if (state.status === 'CLOSED' || state.status === 'REPORTED') return null
  throw new Error(`Campaign 无法自动续跑，当前状态：${state.status}`)
}

async function runController(campaign, action) {
  const key = await readProviderConfiguration()
  const log = createWriteStream(join(OUTPUT_ROOT, `${campaign.mode}.log`), {
    flags: 'a',
    mode: 0o600,
  })
  log.write(`${JSON.stringify({ type: 'sequence-command-started', at: now(), action })}\n`)
  const args = [
    RUNNER_PATH,
    'evolve',
    action,
    '--config', join(CONFIG_ROOT, campaign.config),
    '--runtime', RUNTIME_PATH,
    '--campaign-id', campaign.campaignId,
    '--campaigns-root', CAMPAIGNS_ROOT,
    '--source-root', SOURCE_ROOT,
    '--zcloud-key-fd', '3',
  ]
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  activeChild = child
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  child.stdio[3].end(`${key}\n`)
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  activeChild = null
  log.write(`${JSON.stringify({
    type: 'sequence-command-completed',
    at: now(),
    action,
    ...result,
  })}\n`)
  await new Promise((resolvePromise) => log.end(resolvePromise))
  if (result.code !== 0) {
    throw new Error(`${campaign.mode} ${action} 失败：code=${result.code} signal=${result.signal}`)
  }
}

async function runCampaign(campaign) {
  while (true) {
    const state = await readCampaignState(campaign.campaignId)
    const action = nextAction(state)
    if (action === null) return state
    await writeSequenceState({
      status: 'RUNNING',
      mode: campaign.mode,
      campaignId: campaign.campaignId,
      action,
    })
    await runController(campaign, action)
    const updated = await readCampaignState(campaign.campaignId)
    if (updated?.status === 'PAUSED_INFRASTRUCTURE') {
      await writeSequenceState({
        status: 'RETRY_WAIT',
        mode: campaign.mode,
        campaignId: campaign.campaignId,
        retryAfterSeconds: RETRY_DELAY_MS / 1000,
      })
      await sleep(RETRY_DELAY_MS)
    }
  }
}

async function main() {
  await mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 })
  await writeSequenceState({ status: 'STARTING', order: CAMPAIGNS.map(({ mode }) => mode) })
  for (const campaign of CAMPAIGNS) {
    const state = await runCampaign(campaign)
    await writeSequenceState({
      status: 'MODE_COMPLETED',
      mode: campaign.mode,
      campaignId: campaign.campaignId,
      best: state.best,
      consumedBudget: state.budget?.consumed,
    })
  }
  await writeSequenceState({ status: 'COMPLETED', order: CAMPAIGNS.map(({ mode }) => mode) })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (activeChild) activeChild.kill(signal)
  })
}

main().catch(async (error) => {
  await mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 }).catch(() => {})
  await writeSequenceState({ status: 'FAILED', error: error.message }).catch(() => {})
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
