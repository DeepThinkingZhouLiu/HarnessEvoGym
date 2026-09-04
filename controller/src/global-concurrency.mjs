import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const ROLES = Object.freeze({
  solver: 'RSI_GLOBAL_SOLVER_CONCURRENCY',
  updater: 'RSI_GLOBAL_UPDATER_CONCURRENCY',
})

function configuration(role) {
  const environmentName = ROLES[role]
  if (!environmentName) throw new ProtocolError(`未知全局并发角色：${role}`)
  const rootValue = process.env.RSI_GLOBAL_CONCURRENCY_ROOT?.trim()
  const limitValue = process.env[environmentName]?.trim()
  if (!rootValue && !limitValue) return null
  if (!rootValue || !limitValue) {
    throw new ProtocolError(`全局并发必须同时配置 RSI_GLOBAL_CONCURRENCY_ROOT 与 ${environmentName}`)
  }
  if (!isAbsolute(rootValue) || rootValue.includes('\0')) {
    throw new ProtocolError('RSI_GLOBAL_CONCURRENCY_ROOT 必须是绝对路径')
  }
  const limit = Number(limitValue)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new ProtocolError(`${environmentName} 必须是 1..64 的整数`)
  }
  return { root: resolve(rootValue), limit }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function canonicalDirectory(pathValue) {
  await mkdir(pathValue, { recursive: true, mode: 0o700 })
  const actual = await realpath(pathValue)
  if (actual !== pathValue) {
    throw new ProtocolError('全局并发目录不能经过符号链接', [`requested=${pathValue}`, `actual=${actual}`])
  }
  return actual
}

async function staleOwner(slotPath) {
  try {
    const owner = JSON.parse(await readFile(join(slotPath, 'owner.json'), 'utf8'))
    return owner.hostname === hostname() && !processAlive(owner.pid)
  } catch {
    return false
  }
}

async function reclaimStaleSlot(slotPath, roleRoot) {
  if (!await staleOwner(slotPath)) return false
  const quarantine = join(roleRoot, `.stale-${randomUUID()}`)
  try {
    await rename(slotPath, quarantine)
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes(error?.code)) return false
    throw error
  }
  await rm(quarantine, { recursive: true, force: true })
  return true
}

async function acquire(role) {
  const config = configuration(role)
  if (config === null) return async () => {}
  const root = await canonicalDirectory(config.root)
  const roleRoot = await canonicalDirectory(join(root, role))
  const nonce = randomUUID()
  while (true) {
    for (let index = 1; index <= config.limit; index += 1) {
      const slotPath = join(roleRoot, `slot-${String(index).padStart(3, '0')}`)
      let createdSlot = false
      try {
        await mkdir(slotPath, { mode: 0o700 })
        createdSlot = true
        await writeFile(join(slotPath, 'owner.json'), `${JSON.stringify({
          apiVersion: 'harness-rsi/v1alpha1',
          kind: 'GlobalConcurrencyLease',
          role,
          slot: index,
          pid: process.pid,
          hostname: hostname(),
          nonce,
          acquiredAt: new Date().toISOString(),
        })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        return async () => {
          const ownerPath = join(slotPath, 'owner.json')
          let owner
          try {
            owner = JSON.parse(await readFile(ownerPath, 'utf8'))
          } catch (error) {
            throw new ProtocolError(`全局 ${role} 并发令牌丢失`, [error.message])
          }
          if (owner.nonce !== nonce || owner.pid !== process.pid) {
            throw new ProtocolError(`全局 ${role} 并发令牌所有者不匹配`)
          }
          await unlink(ownerPath)
          await rmdir(slotPath)
        }
      } catch (error) {
        // mkdir 成功、owner 写入失败时不能遗留一个永远没有 owner 的死槽位。
        if (createdSlot) {
          await rm(slotPath, { recursive: true, force: true }).catch(() => {})
          throw error
        }
        if (error?.code !== 'EEXIST') throw error
        await reclaimStaleSlot(slotPath, roleRoot)
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

export async function withGlobalPermit(role, operation) {
  if (typeof operation !== 'function') throw new ProtocolError('全局并发 operation 必须是函数')
  const release = await acquire(role)
  try {
    return await operation()
  } finally {
    await release()
  }
}

export function globalConcurrencyConfiguration() {
  return Object.freeze({
    solver: configuration('solver'),
    updater: configuration('updater'),
  })
}
