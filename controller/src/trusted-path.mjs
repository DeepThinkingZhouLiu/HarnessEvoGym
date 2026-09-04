import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { assertPathKind, resolveInside } from './config.mjs'
import { ProtocolError } from './protocol.mjs'

function assertContained(canonicalRoot, canonicalPath, label) {
  const pathFromRoot = relative(canonicalRoot, canonicalPath)
  if (pathFromRoot === '..' || pathFromRoot.startsWith('../') || isAbsolute(pathFromRoot)) {
    throw new ProtocolError(`${label} 经过符号链接解析后逃逸受信目录`, [
      `root=${canonicalRoot}`,
      `actual=${canonicalPath}`,
    ])
  }
}

export async function canonicalPathInside(root, pathValue, label, expected = 'directory') {
  await assertPathKind(pathValue, label, expected)
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(resolve(root)),
    realpath(resolve(pathValue)),
  ])
  assertContained(canonicalRoot, canonicalPath, label)
  return canonicalPath
}

export async function resolveCanonicalInside(root, relativePath, label, expected = 'directory') {
  const requestedPath = resolveInside(root, relativePath, label)
  return await canonicalPathInside(root, requestedPath, label, expected)
}
