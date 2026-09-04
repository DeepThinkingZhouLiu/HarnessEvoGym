import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

function assertId(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ProtocolError(`${name} 包含非法路径字符`)
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

async function traversalDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o711 })
  await chmod(path, 0o711)
}

async function atomicWrite(path, text, mode = 0o600) {
  await privateDirectory(dirname(path))
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode })
  try {
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function atomicJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function immutableJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  await privateDirectory(dirname(path))
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    try {
      await link(temporary, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await readFile(path, 'utf8')
      if (existing !== text) {
        throw new ProtocolError(`Population Checkpoint 已存在但内容不一致：${basename(path)}`)
      }
    }
    await chmod(path, 0o400)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function assertPopulationState(state) {
  if (!state || state.kind !== 'PopulationCampaignState'
      || !Array.isArray(state.branches) || !Array.isArray(state.events)) {
    throw new ProtocolError('Population state 格式错误')
  }
  for (const branch of state.branches) assertId(branch.branchId, 'branchId')
}

export class PopulationStore {
  constructor(rootPath, campaignId) {
    assertId(campaignId, 'campaignId')
    this.root = resolve(rootPath, campaignId)
    this.publicRoot = join(this.root, 'public')
    this.branchesRoot = join(this.root, 'branches')
    this.reportRoot = join(this.root, 'report')
    this.statePath = join(this.publicRoot, 'state.json')
    this.eventsPath = join(this.publicRoot, 'events.jsonl')
    this.configPath = join(this.publicRoot, 'config.snapshot.json')
    this.baselinePath = join(this.publicRoot, 'baseline-summary.json')
    this.checkpointsRoot = join(this.publicRoot, 'checkpoints')
  }

  async initialize({ config, state }) {
    assertPopulationState(state)
    try {
      await mkdir(this.root, { recursive: false, mode: 0o711 })
      await chmod(this.root, 0o711)
    } catch (error) {
      throw new ProtocolError(`Population Campaign 目录已存在或不可创建：${this.root}`, [
        error.message,
      ])
    }
    await Promise.all([
      privateDirectory(this.publicRoot),
      traversalDirectory(this.branchesRoot),
      privateDirectory(this.reportRoot),
    ])
    await atomicJson(this.configPath, config)
    await atomicJson(this.statePath, state)
    await atomicWrite(
      this.eventsPath,
      `${state.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    )
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'))
      assertPopulationState(state)
      return state
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(`无法读取 Population state：${this.root}`, [error.message])
    }
  }

  async saveState(state, { expectedUpdatedAt } = {}) {
    assertPopulationState(state)
    const previous = await this.readState()
    if (expectedUpdatedAt !== undefined && previous.updatedAt !== expectedUpdatedAt) {
      throw new ProtocolError('Population state 并发更新冲突')
    }
    if (state.events.length < previous.events.length) {
      throw new ProtocolError('Population event log 不能回退')
    }
    for (let index = 0; index < previous.events.length; index += 1) {
      if (JSON.stringify(previous.events[index]) !== JSON.stringify(state.events[index])) {
        throw new ProtocolError('Population event log 只能追加，不能改写历史')
      }
    }
    await atomicJson(this.statePath, state)
    if (state.events.length > previous.events.length) {
      await atomicWrite(
        this.eventsPath,
        `${state.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      )
    }
  }

  async writeBaselineSummary(summary) {
    await atomicJson(this.baselinePath, summary)
    return this.baselinePath
  }

  async writeBudgetCheckpoint(requestedBudget, checkpoint) {
    if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 0 || requestedBudget > 10_000) {
      throw new ProtocolError('Population Checkpoint Budget 必须是 0..10000 的整数')
    }
    const name = `budget-${String(requestedBudget).padStart(4, '0')}.json`
    const path = join(this.checkpointsRoot, name)
    await immutableJson(path, checkpoint)
    return { path, relativePath: `public/checkpoints/${name}` }
  }

  async writeBranchGenerationCheckpoint(branchId, requestedGeneration, checkpoint) {
    assertId(branchId, 'branchId')
    if (!Number.isSafeInteger(requestedGeneration)
        || requestedGeneration < 1 || requestedGeneration > 10_000) {
      throw new ProtocolError('Branch Checkpoint Generation 必须是 1..10000 的整数')
    }
    const directory = join(this.checkpointsRoot, 'branches', branchId)
    const name = `generation-${String(requestedGeneration).padStart(4, '0')}.json`
    const path = join(directory, name)
    await immutableJson(path, checkpoint)
    return {
      path,
      relativePath: `public/checkpoints/branches/${branchId}/${name}`,
    }
  }

  async writeReport({ summary, markdown, bestHarness, patch }) {
    const paths = {
      summary: join(this.reportRoot, 'population-summary.json'),
      markdown: join(this.reportRoot, 'population-summary.md'),
      bestHarness: join(this.reportRoot, 'best-harness.json'),
      patch: join(this.reportRoot, 'best-harness.patch'),
    }
    await Promise.all([
      atomicJson(paths.summary, summary),
      atomicWrite(paths.markdown, markdown),
      atomicJson(paths.bestHarness, bestHarness),
      atomicWrite(paths.patch, patch),
    ])
    return { directory: this.reportRoot, paths }
  }

  async writeFinalReport(report) {
    const path = join(this.reportRoot, 'final-evaluation.json')
    await atomicJson(path, report)
    return path
  }

  async readReport() {
    try {
      const [summary, bestHarness] = await Promise.all([
        readFile(join(this.reportRoot, 'population-summary.json'), 'utf8').then(JSON.parse),
        readFile(join(this.reportRoot, 'best-harness.json'), 'utf8').then(JSON.parse),
      ])
      return {
        directory: this.reportRoot,
        paths: {
          summary: join(this.reportRoot, 'population-summary.json'),
          markdown: join(this.reportRoot, 'population-summary.md'),
          bestHarness: join(this.reportRoot, 'best-harness.json'),
          patch: join(this.reportRoot, 'best-harness.patch'),
        },
        summary,
        bestHarness,
      }
    } catch (error) {
      throw new ProtocolError('Population report 不存在或损坏', [error.message])
    }
  }
}
