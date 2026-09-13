import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import test from 'node:test'

import { acquireCampaignLock } from '../src/campaign-lock.mjs'

test('campaign lock excludes a second writer and releases idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-lock-'))
  const release = await acquireCampaignLock({
    campaignsRoot: root,
    campaignId: 'campaign-1',
    command: 'evolve run',
  })
  await assert.rejects(
    () => acquireCampaignLock({ campaignsRoot: root, campaignId: 'campaign-1', command: 'evolve resume' }),
    /已有活动/u,
  )
  await release()
  await release()
  const releaseAgain = await acquireCampaignLock({
    campaignsRoot: root,
    campaignId: 'campaign-1',
    command: 'evolve resume',
  })
  await releaseAgain()
})

test('campaign lock reclaims a dead same-host owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'campaign-lock-stale-'))
  const lock = join(root, '.locks', 'campaign-2.lock')
  await mkdir(lock, { recursive: true })
  const host = (await import('node:os')).hostname()
  const bootId = process.platform === 'linux'
    ? (await (await import('node:fs/promises')).readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    : String(Math.floor(Date.now() / 1000 - uptime()))
  await writeFile(join(lock, 'owner.json'), JSON.stringify({
    nonce: 'stale',
    pid: 2_147_483_647,
    host,
    bootId,
    startToken: '0',
  }))
  const release = await acquireCampaignLock({
    campaignsRoot: root,
    campaignId: 'campaign-2',
    command: 'evolve resume',
  })
  await release()
})
