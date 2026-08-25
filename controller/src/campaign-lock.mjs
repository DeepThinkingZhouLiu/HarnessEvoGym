import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const RECENT_INCOMPLETE_LOCK_MS = 60_000

async function readText(path) {
  return (await readFile(path, 'utf8')).trim()
}

async function processStartToken(pid) {
  const text = await readText(`/proc/${pid}/stat`)
  const close = text.lastIndexOf(')')
  if (close < 0) throw new Error('invalid proc stat')
  const fields = text.slice(close + 1).trim().split(/\s+/u)
  // The remainder begins at field 3 (state), so field 22 is index 19.
  if (!fields[19]) throw new Error('proc stat lacks starttime')
  return fields[19]
}

async function currentIdentity() {
  return {
    host: hostname(),
    bootId: await readText('/proc/sys/kernel/random/boot_id'),
    startToken: await processStartToken(process.pid),
  }
}

async function readOwner(lockDirectory) {
  try {
    const value = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

async function ownerIsAlive(owner, identity) {
  if (!owner || owner.host !== identity.host || owner.bootId !== identity.bootId
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || typeof owner.startToken !== 'string') return false
  try {
    return await processStartToken(owner.pid) === owner.startToken
  } catch {
    return false
  }
}

async function recentIncompleteLock(lockDirectory, nowMs) {
  try {
    const stat = await lstat(lockDirectory)
    return nowMs - stat.mtimeMs < RECENT_INCOMPLETE_LOCK_MS
  } catch {
    return false
  }
}

/**
 * Acquire a crash-recoverable, campaign-wide single-writer lease. Atomic mkdir
 * works on the deployment NFS; boot-id + /proc starttime avoids PID reuse.
 */
export async function acquireCampaignLock({
  campaignsRoot,
  campaignId,
  command,
  now = () => new Date(),
} = {}) {
  if (typeof campaignsRoot !== 'string' || !campaignsRoot.startsWith('/')) {
    throw new ProtocolError('campaignsRoot 必须是绝对路径')
  }
  if (typeof campaignId !== 'string' || !ID_PATTERN.test(campaignId)) {
    throw new ProtocolError('campaignId 包含非法路径字符')
  }
  if (typeof command !== 'string' || command.length === 0) {
    throw new ProtocolError('campaign lock command 无效')
  }
  const identity = await currentIdentity()
  const lockRoot = join(resolve(campaignsRoot), '.locks')
  const lockDirectory = join(lockRoot, `${campaignId}.lock`)
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  await chmod(lockRoot, 0o700)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nonce = randomUUID()
    let created = false
    try {
      await mkdir(lockDirectory, { mode: 0o700 })
      created = true
      await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
        nonce,
        pid: process.pid,
        command,
        createdAt: now().toISOString(),
        ...identity,
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      let released = false
      return async () => {
        if (released) return
        released = true
        const owner = await readOwner(lockDirectory)
        if (owner?.nonce !== nonce) {
          throw new ProtocolError('Campaign lock ownership changed before release')
        }
        await rm(lockDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (created) await rm(lockDirectory, { recursive: true, force: true }).catch(() => {})
        throw new ProtocolError('无法获取 Campaign single-writer lock', [error.message])
      }
      const owner = await readOwner(lockDirectory)
      if (await ownerIsAlive(owner, identity)
          || (!owner && await recentIncompleteLock(lockDirectory, now().getTime()))) {
        throw new ProtocolError('Campaign 已有活动的 run/resume/smoke/report 进程')
      }
      // A lock from another live host is not safely reclaimable automatically.
      if (owner && owner.host !== identity.host) {
        throw new ProtocolError('Campaign lock 由另一台主机持有，拒绝自动回收')
      }
      const stale = join(dirname(lockDirectory), `.${basename(lockDirectory)}.stale-${randomUUID()}`)
      try {
        await rename(lockDirectory, stale)
        await rm(stale, { recursive: true, force: true })
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') {
          throw new ProtocolError('无法回收失效 Campaign lock', [renameError.message])
        }
      }
    }
  }
  throw new ProtocolError('Campaign lock 竞争过于频繁')
}
