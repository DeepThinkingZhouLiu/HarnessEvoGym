import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
