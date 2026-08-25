#!/usr/bin/env node

import { chmod, chown, lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import {
  runtimeBuildCacheAttestation,
  validateFrozenEvaluationRuntime,
} from '../controller/src/production-runtime.mjs'

const ATTESTATION_FILE = '.harness-rsi-runtime-cache-v1.json'

function fail(message) {
  throw new Error(message)
}

function parseOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) fail('Options must be --name value pairs')
    if (values.has(name)) fail(`Duplicate option: ${name}`)
    values.set(name, value)
  }
  const absolute = (name) => {
    const value = values.get(name)
    if (!value || !isAbsolute(value)) fail(`${name} must be an absolute path`)
    return resolve(value)
  }
  const allowed = new Set(['--campaign-root', '--cache-root'])
  for (const name of values.keys()) if (!allowed.has(name)) fail(`Unknown option: ${name}`)
  return {
    campaignRoot: absolute('--campaign-root'),
    cacheRoot: absolute('--cache-root'),
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function activateAlias(runtimeRoot, cacheEntry) {
  const temporary = `${runtimeRoot}.link-${process.pid}`
  await unlink(temporary).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  try {
    await symlink(cacheEntry, temporary, 'dir')
    await rename(temporary, runtimeRoot)
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function validateExistingAlias(runtimeRoot, cacheEntry) {
  const stat = await lstat(runtimeRoot)
  if (!stat.isSymbolicLink()) return false
  const lexical = resolve(dirname(runtimeRoot), await readlink(runtimeRoot))
  if (lexical !== cacheEntry || await realpath(runtimeRoot) !== cacheEntry) {
    fail('Existing runtime alias does not point at the expected cache entry')
  }
  return true
}

async function main() {
  const { campaignRoot, cacheRoot } = parseOptions(process.argv.slice(2))
  const state = await readJson(join(campaignRoot, 'public', 'state.json'))
  const build = await readJson(join(
    campaignRoot,
    'public',
    'candidates',
    'baseline',
    'build.json',
  ))
  if (state.campaignId !== basename(campaignRoot)
      || state.incumbent?.candidateId !== 'baseline'
      || !/^[a-f0-9]{64}$/u.test(state.incumbent.digest ?? '')
      || build?.ok !== true || build.candidateId !== 'baseline' || build.level !== 'baseline'
      || !isAbsolute(build.runtimeRoot)) {
    fail('Campaign baseline state/build provenance is invalid')
  }
  const runtimeRoot = resolve(build.runtimeRoot)
  const attestation = runtimeBuildCacheAttestation({
    candidateDigest: state.incumbent.digest,
    benchmark: state.benchmark,
    nodeVersion: build.nodeVersion,
    pnpmVersion: build.pnpmVersion,
  })
  const cacheEntry = join(cacheRoot, attestation.cacheKey)
  await mkdir(cacheRoot, { recursive: true, mode: 0o711 })
  await chmod(cacheRoot, 0o711)

  if (await exists(cacheEntry)) {
    const metadata = await readJson(join(cacheEntry, ATTESTATION_FILE))
    if (JSON.stringify(metadata) !== JSON.stringify(attestation)) {
      fail('Existing cache entry attestation does not match the campaign baseline')
    }
    await validateFrozenEvaluationRuntime({ root: cacheEntry, trustedUid: 0 })
    if (await exists(runtimeRoot)) {
      if (!await validateExistingAlias(runtimeRoot, cacheEntry)) {
        fail('Both the legacy runtime and cache entry exist; refusing to delete either')
      }
    } else {
      await activateAlias(runtimeRoot, cacheEntry)
    }
    process.stdout.write(`${JSON.stringify({ status: 'already-cached', cacheKey: attestation.cacheKey })}\n`)
    return
  }

  const runtimeStat = await lstat(runtimeRoot)
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== 0
      || (runtimeStat.mode & 0o222) !== 0) {
    fail('Legacy runtime is not a trusted frozen directory')
  }
  await validateFrozenEvaluationRuntime({ root: runtimeRoot, trustedUid: 0 })
  const metadataPath = join(runtimeRoot, ATTESTATION_FILE)
  if (await exists(metadataPath)) {
    if (JSON.stringify(await readJson(metadataPath)) !== JSON.stringify(attestation)) {
      fail('Legacy runtime contains a conflicting cache attestation')
    }
  } else {
    await writeFile(metadataPath, `${JSON.stringify(attestation, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o400,
    })
    await chown(metadataPath, runtimeStat.uid, runtimeStat.gid)
    await chmod(metadataPath, 0o444)
  }

  let moved = false
  try {
    await rename(runtimeRoot, cacheEntry)
    moved = true
    await activateAlias(runtimeRoot, cacheEntry)
  } catch (error) {
    if (moved && !await exists(runtimeRoot)) await rename(cacheEntry, runtimeRoot).catch(() => {})
    throw error
  }
  process.stdout.write(`${JSON.stringify({ status: 'adopted', cacheKey: attestation.cacheKey })}\n`)
}

await main()
