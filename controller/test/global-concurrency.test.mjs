import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { withGlobalPermit } from '../src/global-concurrency.mjs'

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

test('跨 Mode 共享令牌池分别限制 Solver 与 Updater 并发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-rsi-global-concurrency-'))
  const previous = {
    root: process.env.RSI_GLOBAL_CONCURRENCY_ROOT,
    solver: process.env.RSI_GLOBAL_SOLVER_CONCURRENCY,
    updater: process.env.RSI_GLOBAL_UPDATER_CONCURRENCY,
  }
  process.env.RSI_GLOBAL_CONCURRENCY_ROOT = root
  process.env.RSI_GLOBAL_SOLVER_CONCURRENCY = '2'
  process.env.RSI_GLOBAL_UPDATER_CONCURRENCY = '1'
  try {
    let activeSolvers = 0
    let maximumSolvers = 0
    await Promise.all(Array.from({ length: 5 }, () => withGlobalPermit('solver', async () => {
      activeSolvers += 1
      maximumSolvers = Math.max(maximumSolvers, activeSolvers)
      await delay(20)
      activeSolvers -= 1
    })))
    assert.equal(maximumSolvers, 2)

    let activeUpdaters = 0
    let maximumUpdaters = 0
    await Promise.all(Array.from({ length: 3 }, () => withGlobalPermit('updater', async () => {
      activeUpdaters += 1
      maximumUpdaters = Math.max(maximumUpdaters, activeUpdaters)
      await delay(10)
      activeUpdaters -= 1
    })))
    assert.equal(maximumUpdaters, 1)
  } finally {
    for (const [name, value] of [
      ['RSI_GLOBAL_CONCURRENCY_ROOT', previous.root],
      ['RSI_GLOBAL_SOLVER_CONCURRENCY', previous.solver],
      ['RSI_GLOBAL_UPDATER_CONCURRENCY', previous.updater],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('全局并发可回收同机崩溃进程遗留的槽位', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-rsi-stale-concurrency-'))
  const previous = {
    root: process.env.RSI_GLOBAL_CONCURRENCY_ROOT,
    solver: process.env.RSI_GLOBAL_SOLVER_CONCURRENCY,
  }
  process.env.RSI_GLOBAL_CONCURRENCY_ROOT = root
  process.env.RSI_GLOBAL_SOLVER_CONCURRENCY = '1'
  const staleSlot = join(root, 'solver', 'slot-001')
  await mkdir(staleSlot, { recursive: true })
  await writeFile(join(staleSlot, 'owner.json'), `${JSON.stringify({
    hostname: (await import('node:os')).hostname(),
    pid: 2147483647,
    nonce: 'stale-owner',
  })}\n`)
  try {
    let entered = false
    await withGlobalPermit('solver', async () => {
      entered = true
    })
    assert.equal(entered, true)
  } finally {
    if (previous.root === undefined) delete process.env.RSI_GLOBAL_CONCURRENCY_ROOT
    else process.env.RSI_GLOBAL_CONCURRENCY_ROOT = previous.root
    if (previous.solver === undefined) delete process.env.RSI_GLOBAL_SOLVER_CONCURRENCY
    else process.env.RSI_GLOBAL_SOLVER_CONCURRENCY = previous.solver
    await rm(root, { recursive: true, force: true })
  }
})
