#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTROLLER_PATH = join(REPOSITORY_ROOT, 'controller', 'src', 'cli.mjs')
const SUITE_PROFILES = Object.freeze({
  main16: Object.freeze({
    defaultSuiteId: 'cowork-main16-codex-terra-high-seed20260827-v1',
    experimentStem: 'cowork-msa-main16-codex',
  }),
  formal32: Object.freeze({
    defaultSuiteId: 'cowork-formal32-codex-terra-high-seed20260827-v1',
    experimentStem: 'cowork-msa-rsi-formal32-codex',
  }),
  pilot4: Object.freeze({
    defaultSuiteId: 'cowork-pilot4-codex-terra-high-seed20260827-v1',
    experimentStem: 'cowork-msa-rsi-pilot4-codex',
  }),
})
const PROFILE_ID = process.env.RSI_COWORK_SUITE_PROFILE?.trim() || 'formal32'
const SUITE_PROFILE = SUITE_PROFILES[PROFILE_ID]
if (SUITE_PROFILE === undefined) {
  throw new Error(`RSI_COWORK_SUITE_PROFILE 必须是：${Object.keys(SUITE_PROFILES).join(', ')}`)
}
const DEFAULT_SUITE_ID = SUITE_PROFILE.defaultSuiteId
const SUITE_ID = process.env.RSI_FORMAL_SUITE_ID?.trim() || DEFAULT_SUITE_ID
if (!/^[a-z0-9][a-z0-9._-]{2,119}$/u.test(SUITE_ID)) {
  throw new Error('RSI_FORMAL_SUITE_ID 只能包含小写字母、数字、点、下划线和连字符')
}
const OUTPUT_ROOT = join(REPOSITORY_ROOT, '.rsi', 'experiment-suites', SUITE_ID)
const RUNS_ROOT = join(REPOSITORY_ROOT, '.rsi', 'runs', 'populations')
const CONCURRENCY_ROOT = join(OUTPUT_ROOT, 'concurrency')
const RETRY_DELAY_MS = 60_000
const REQUIRED_ENVIRONMENT = Object.freeze([
  'RSI_PROVIDER_BASE_URL',
  'RSI_PROVIDER_API_KEY',
  'RSI_OFFICEVAL_DATASET_ROOT',
  'RSI_OFFICEVAL_EVALUATOR_ROOT',
])
const ALL_MODES = Object.freeze([
  'single',
  'independent',
  'mutualism',
  'competition',
  'combined',
])

function selectedModes() {
  const raw = process.env.RSI_SUITE_MODES?.trim()
  if (!raw) return [...ALL_MODES]
  const modes = raw.split(',').map((mode) => mode.trim()).filter(Boolean)
  if (modes.length === 0 || new Set(modes).size !== modes.length
      || modes.some((mode) => !ALL_MODES.includes(mode))) {
    throw new Error(`RSI_SUITE_MODES 必须是 ${ALL_MODES.join(',')} 的无重复子集`)
  }
  return modes
}

function configuredBaselinePack() {
  const pathValue = process.env.RSI_BASELINE_PACK_PATH?.trim()
  const sha256 = process.env.RSI_BASELINE_PACK_SHA256?.trim()
  if (!pathValue && !sha256) return null
  if (!pathValue || !sha256 || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error('RSI_BASELINE_PACK_PATH 与 RSI_BASELINE_PACK_SHA256 必须同时提供，摘要为 64 位小写 SHA-256')
  }
  const absolutePath = isAbsolute(pathValue) ? resolve(pathValue) : resolve(REPOSITORY_ROOT, pathValue)
  const relativePath = relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/')
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('RSI_BASELINE_PACK_PATH 必须位于仓库内')
  }
  return Object.freeze({ mode: 'reuse', path: relativePath, sha256 })
}

const BASELINE_PACK = configuredBaselinePack()
const CAMPAIGNS = selectedModes().map((mode) => ({
  mode,
  sourceConfig: join(REPOSITORY_ROOT, 'experiments', `${SUITE_PROFILE.experimentStem}-${mode}.json`),
  config: join(REPOSITORY_ROOT, 'experiments', `${SUITE_PROFILE.experimentStem}-${mode}.json`),
  runId: `${SUITE_ID}-${mode}`,
}))

const activeChildren = new Set()
const campaignStates = new Map(CAMPAIGNS.map(({ mode }) => [mode, { status: 'QUEUED' }]))
const sleepWaiters = new Set()
let stateWrite = Promise.resolve()
let shutdownSignal = null

function now() {
  return new Date().toISOString()
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => {
    if (shutdownSignal !== null) {
      resolvePromise()
      return
    }
    let timer
    const wake = () => {
      clearTimeout(timer)
      sleepWaiters.delete(wake)
      resolvePromise()
    }
    timer = setTimeout(wake, milliseconds)
    sleepWaiters.add(wake)
  })
}

function assertNotInterrupted() {
  if (shutdownSignal !== null) throw new Error(`Suite 收到 ${shutdownSignal}，已停止排队与重试`)
}

function maximumConcurrentModes() {
  const raw = process.env.RSI_SUITE_MAX_CONCURRENT_MODES ?? '5'
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new Error('RSI_SUITE_MAX_CONCURRENT_MODES 必须是 1..5 的整数')
  }
  return value
}

function globalConcurrency(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} 必须是 1..${maximum} 的整数`)
  }
  return value
}

function controllerEnvironment() {
  return {
    ...process.env,
    RSI_GLOBAL_CONCURRENCY_ROOT: CONCURRENCY_ROOT,
    RSI_GLOBAL_SOLVER_CONCURRENCY: String(globalConcurrency(
      'RSI_SUITE_MAX_CONCURRENT_SOLVER_TRIALS',
      6,
      32,
    )),
    RSI_GLOBAL_UPDATER_CONCURRENCY: String(globalConcurrency(
      'RSI_SUITE_MAX_CONCURRENT_UPDATERS',
      2,
      16,
    )),
  }
}

function assertEnvironment() {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => (
    typeof process.env[name] !== 'string' || process.env[name].trim().length === 0
  ))
  if (missing.length > 0) throw new Error(`缺少正式实验运行变量：${missing.join(', ')}`)
  if (PROFILE_ID === 'main16' && CAMPAIGNS.length > 1 && BASELINE_PACK === null) {
    throw new Error(
      'main16 多 Mode 主表必须配置同一 RSI_BASELINE_PACK_PATH 与 RSI_BASELINE_PACK_SHA256',
    )
  }
}

function publicStatePath(campaign) {
  return join(RUNS_ROOT, campaign.runId, 'public', 'state.json')
}

async function readCampaignState(campaign) {
  try {
    return JSON.parse(await readFile(publicStatePath(campaign), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeSuiteState() {
  const snapshot = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionExperimentSuiteState',
    suiteId: SUITE_ID,
    pid: process.pid,
    updatedAt: now(),
    maximumConcurrentModes: maximumConcurrentModes(),
    maximumConcurrentSolverTrials: globalConcurrency(
      'RSI_SUITE_MAX_CONCURRENT_SOLVER_TRIALS',
      6,
      32,
    ),
    maximumConcurrentUpdaters: globalConcurrency(
      'RSI_SUITE_MAX_CONCURRENT_UPDATERS',
      2,
      16,
    ),
    baselinePack: BASELINE_PACK,
    campaigns: CAMPAIGNS.map(({ mode, runId }) => ({
      mode,
      runId,
      ...campaignStates.get(mode),
    })),
  }
  stateWrite = stateWrite.then(() => writeFile(
    join(OUTPUT_ROOT, 'suite-state.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { mode: 0o600 },
  ))
  await stateWrite
}

async function prepareCampaignConfigs() {
  if (BASELINE_PACK === null) return
  const configRoot = join(OUTPUT_ROOT, 'configs')
  await mkdir(configRoot, { recursive: true, mode: 0o700 })
  for (const campaign of CAMPAIGNS) {
    const config = JSON.parse(await readFile(campaign.sourceConfig, 'utf8'))
    if (!config.spec || typeof config.spec !== 'object' || Array.isArray(config.spec)) {
      throw new Error(`Experiment 缺少 spec：${campaign.sourceConfig}`)
    }
    config.spec.baselinePack = BASELINE_PACK
    const outputPath = join(configRoot, `${campaign.mode}.json`)
    await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    campaign.config = outputPath
  }
}

async function updateCampaign(mode, patch) {
  campaignStates.set(mode, { ...campaignStates.get(mode), ...patch, updatedAt: now() })
  await writeSuiteState()
}

function nextAction(state) {
  if (state === null) return 'run'
  if (state.status === 'CLOSED') return null
  if (state.status === 'PAUSED_INFRASTRUCTURE') return 'resume'
  // experiment resume 只接受 Controller 已原子标记的基础设施暂停。若进程在
  // EVOLVING/BASELINE_RUNNING 中被强杀，必须先人工审计是否仍有活跃 Writer。
  throw new Error(`Population 状态不能由 Suite 自动推进：${state.status}`)
}

async function runController(campaign, action) {
  const log = createWriteStream(join(OUTPUT_ROOT, `${campaign.mode}.log`), {
    flags: 'a',
    mode: 0o600,
  })
  log.write(`${JSON.stringify({ type: 'suite-command-started', at: now(), action })}\n`)
  const args = action === 'run'
    ? [CONTROLLER_PATH, 'experiment', 'run', '--config', campaign.config, '--run-id', campaign.runId]
    : [CONTROLLER_PATH, 'experiment', 'resume', '--run', join(RUNS_ROOT, campaign.runId)]
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: controllerEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  activeChildren.delete(child)
  log.write(`${JSON.stringify({ type: 'suite-command-completed', at: now(), action, ...result })}\n`)
  await new Promise((resolvePromise) => log.end(resolvePromise))
  return result
}

async function buildSharedRuntime() {
  const log = createWriteStream(join(OUTPUT_ROOT, 'runtime-build.log'), {
    flags: 'a',
    mode: 0o600,
  })
  log.write(`${JSON.stringify({ type: 'suite-runtime-build-started', at: now() })}\n`)
  const child = spawn(process.execPath, [
    CONTROLLER_PATH,
    'runtime',
    'build',
    '--experiment',
    CAMPAIGNS[0].config,
  ], {
    cwd: REPOSITORY_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  activeChildren.delete(child)
  log.write(`${JSON.stringify({ type: 'suite-runtime-build-completed', at: now(), ...result })}\n`)
  await new Promise((resolvePromise) => log.end(resolvePromise))
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`正式实验 Runtime 预构建失败：code=${result.code} signal=${result.signal}`)
  }
}

async function runCampaign(campaign) {
  while (true) {
    assertNotInterrupted()
    const before = await readCampaignState(campaign)
    const action = nextAction(before)
    if (action === null) {
      await updateCampaign(campaign.mode, {
        status: 'COMPLETED',
        consumedBudget: before.budget?.consumed ?? null,
        bestCandidateId: before.best?.candidateId ?? null,
      })
      return
    }
    await updateCampaign(campaign.mode, { status: 'RUNNING', action })
    const result = await runController(campaign, action)
    const after = await readCampaignState(campaign)
    if (after?.status === 'CLOSED') continue
    if (after?.status === 'PAUSED_INFRASTRUCTURE') {
      await updateCampaign(campaign.mode, {
        status: 'RETRY_WAIT',
        action: 'resume',
        retryAfterSeconds: RETRY_DELAY_MS / 1000,
      })
      await sleep(RETRY_DELAY_MS)
      assertNotInterrupted()
      continue
    }
    throw new Error(
      `${campaign.mode} ${action} 失败：code=${result.code} signal=${result.signal}`,
    )
  }
}

async function worker(workerId, queue) {
  while (true) {
    const campaign = queue.shift()
    if (!campaign) return
    await updateCampaign(campaign.mode, { status: 'STARTING', workerId })
    await runCampaign(campaign)
  }
}

async function main() {
  assertEnvironment()
  await mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 })
  await mkdir(CONCURRENCY_ROOT, { recursive: true, mode: 0o700 })
  await prepareCampaignConfigs()
  await writeSuiteState()
  await buildSharedRuntime()
  assertNotInterrupted()
  const queue = [...CAMPAIGNS]
  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrentModes(), queue.length) },
    (_, index) => worker(index + 1, queue),
  ))
  await writeSuiteState()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdownSignal = signal
    for (const wake of [...sleepWaiters]) wake()
    for (const child of activeChildren) {
      child.kill(signal)
      const escalation = setTimeout(() => child.kill('SIGKILL'), 10_000)
      escalation.unref()
    }
  })
}

main().catch(async (error) => {
  await mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 }).catch(() => {})
  for (const [mode, state] of campaignStates) {
    if (['RUNNING', 'STARTING', 'RETRY_WAIT'].includes(state.status)) {
      campaignStates.set(mode, {
        ...state,
        status: shutdownSignal === null ? 'FAILED' : 'INTERRUPTED',
        updatedAt: now(),
      })
    }
  }
  await writeSuiteState().catch(() => {})
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = shutdownSignal === 'SIGINT' ? 130 : shutdownSignal === 'SIGTERM' ? 143 : 1
})
