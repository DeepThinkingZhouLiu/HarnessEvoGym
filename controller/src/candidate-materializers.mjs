import { copyFile, lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { copyRegularTree, snapshotTree, treeDigest } from './candidate.mjs'
import { normalizeRelativePath } from './path-policy.mjs'
import { ProtocolError } from './protocol.mjs'
import { canonicalPathInside, resolveCanonicalInside } from './trusted-path.mjs'

const MATERIALIZERS = new Map()

export function registerCandidateMaterializer(protocol, materializer) {
  if (typeof protocol !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+$/u.test(protocol)) {
    throw new ProtocolError('Candidate Materializer Protocol 必须是带版本的 kebab-case')
  }
  if (typeof materializer !== 'function') throw new ProtocolError('Candidate Materializer 必须是函数')
  if (MATERIALIZERS.has(protocol)) throw new ProtocolError(`Candidate Materializer 重复注册：${protocol}`)
  MATERIALIZERS.set(protocol, materializer)
}

async function overlayRegularTree(sourceRoot, destinationRoot, allowedOverrides) {
  async function visit(source, destination) {
    const entries = await readdir(source, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const destinationPath = join(destination, entry.name)
      const pathValue = normalizeRelativePath(relative(sourceRoot, sourcePath).replaceAll('\\', '/'))
      const sourceInfo = await lstat(sourcePath)
      if (sourceInfo.isSymbolicLink() || (!sourceInfo.isDirectory() && !sourceInfo.isFile())) {
        throw new ProtocolError(`Candidate Seed 包含非普通文件：${pathValue}`)
      }
      if (sourceInfo.isDirectory()) {
        try {
          const destinationInfo = await lstat(destinationPath)
          if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
            throw new ProtocolError(`Candidate Seed 目录与 Source 文件冲突：${pathValue}`)
          }
        } catch (error) {
          if (error instanceof ProtocolError) throw error
          if (error.code !== 'ENOENT') throw error
          await mkdir(destinationPath, { mode: 0o755 })
        }
        await visit(sourcePath, destinationPath)
        continue
      }
      try {
        const destinationInfo = await lstat(destinationPath)
        if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
          throw new ProtocolError(`Candidate Seed 文件与 Source 目录冲突：${pathValue}`)
        }
        if (!allowedOverrides.has(pathValue)) {
          throw new ProtocolError(`Candidate Seed 未声明覆盖 Source 文件：${pathValue}`)
        }
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        if (error.code !== 'ENOENT') throw error
      }
      await copyFile(sourcePath, destinationPath)
      const handle = await open(destinationPath, 'r+')
      try {
        await handle.chmod(sourceInfo.mode & 0o111 ? 0o755 : 0o644)
      } finally {
        await handle.close()
      }
    }
  }
  await visit(sourceRoot, destinationRoot)
}

async function materializeControllerOverlay({ repositoryRoot, target, destination }) {
  const baseline = await resolveCanonicalInside(
    repositoryRoot,
    target.materialization.baselinePath,
    'Target Baseline Template',
  )
  await copyRegularTree(baseline, destination)
  const snapshot = await snapshotTree(baseline)
  return Object.freeze({
    protocol: 'controller-owned-overlay-v1',
    sourceRevision: target.source.revision,
    seedDigest: treeDigest(snapshot),
  })
}

async function materializeSourceWithSeed({ repositoryRoot, target, sourceRoot, destination }) {
  const [canonicalSource, seed] = await Promise.all([
    canonicalPathInside(repositoryRoot, sourceRoot, 'Resolved Target Source'),
    resolveCanonicalInside(repositoryRoot, target.materialization.seedPath, 'Candidate Seed'),
  ])
  const seedSnapshot = await snapshotTree(seed)
  const actualSeedDigest = treeDigest(seedSnapshot)
  if (actualSeedDigest !== target.materialization.seedDigest) {
    throw new ProtocolError('Candidate Seed Digest 与 Target Adapter 固定值不一致', [
      `expected=${target.materialization.seedDigest}`,
      `actual=${actualSeedDigest}`,
    ])
  }
  await copyRegularTree(canonicalSource, destination)
  await overlayRegularTree(seed, destination, new Set(target.materialization.overrides))
  const copiedSeedDigest = treeDigest(await snapshotTree(seed))
  if (copiedSeedDigest !== actualSeedDigest) {
    throw new ProtocolError('Candidate Seed 在实例化过程中发生变化', [
      `before=${actualSeedDigest}`,
      `after=${copiedSeedDigest}`,
    ])
  }
  return Object.freeze({
    protocol: 'source-plus-seed-overlay-v1',
    sourceRevision: target.source.revision,
    seedDigest: actualSeedDigest,
  })
}

registerCandidateMaterializer('controller-owned-overlay-v1', materializeControllerOverlay)
registerCandidateMaterializer('source-plus-seed-overlay-v1', materializeSourceWithSeed)

export async function materializeCandidate({ repositoryRoot, target, sourceRoot, destination }) {
  const materializer = MATERIALIZERS.get(target?.materialization?.protocol)
  if (!materializer) {
    throw new ProtocolError(`未实现的 Candidate Materializer：${target?.materialization?.protocol ?? '(missing)'}`)
  }
  return await materializer({ repositoryRoot, target, sourceRoot, destination })
}

export function registeredCandidateMaterializers() {
  return Object.freeze([...MATERIALIZERS.keys()].sort())
}
