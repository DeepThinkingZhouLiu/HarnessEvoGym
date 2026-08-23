import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { DEEPSEEK_HARNESS_MUTATION_POLICY } from './mutation.mjs'
import { ProtocolError } from './protocol.mjs'
import { runProcess } from './subprocess.mjs'

const REVISION_PATTERN = /^[a-f0-9]{40}$/u

function globToRegExp(glob) {
  let source = '^'
  for (let index = 0; index < glob.length;) {
    if (glob[index] === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 3
        } else {
          source += '.*'
          index += 2
        }
      } else {
        source += '[^/]*'
        index += 1
      }
    } else {
      source += glob[index].replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
      index += 1
    }
  }
  return new RegExp(`${source}$`, 'u')
}

function matches(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path))
}

function assertDescendant(root, path, label) {
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new ProtocolError(`${label} 必须位于指定 root 之下`)
  }
}

async function walk(root, directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const rel = relative(root, path).split(sep).join('/')
    const stat = await lstat(path)
    await visit({ path, rel, stat })
    if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(root, path, visit)
  }
}

async function assertSafeSymlinks(root) {
  await walk(root, root, async ({ path, rel, stat }) => {
    if (!stat.isSymbolicLink()) return
    const target = await readlink(path)
    const resolvedTarget = resolve(dirname(path), target)
    const targetRelative = relative(root, resolvedTarget)
    if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
      throw new ProtocolError(`Source 包含逃出 Candidate 的符号链接：${rel}`)
    }
  })
}

export async function materializePinnedSource({ sourceRoot, revision, destination, timeoutMs = 120_000 }) {
  const source = resolve(sourceRoot)
  const target = resolve(destination)
  if (!REVISION_PATTERN.test(revision)) throw new ProtocolError('Source revision 必须是 40 位 Git SHA')
  try {
    await lstat(target)
    throw new ProtocolError(`Candidate destination 已存在：${target}`)
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(dirname(target), '.materialize-'))
  const archive = join(temporary, 'source.tar')
  try {
    const resolved = await runProcess({
      command: 'git', args: ['-C', source, 'rev-parse', 'HEAD'], cwd: source,
      timeoutMs, outputLimitBytes: 1024 * 1024,
    })
    if (!resolved.ok || resolved.stdout.trim() !== revision) {
      throw new ProtocolError('Source checkout 与冻结 revision 不一致', [
        `expected=${revision}`,
        `actual=${resolved.stdout.trim() || '<unavailable>'}`,
        resolved.stderr,
      ])
    }
    const archived = await runProcess({
      command: 'git', args: ['-C', source, 'archive', '--format=tar', `--output=${archive}`, revision],
      cwd: source, timeoutMs, outputLimitBytes: 4 * 1024 * 1024,
    })
    if (!archived.ok) throw new ProtocolError('无法归档冻结 Source', [archived.stderr])
    await mkdir(target, { recursive: false, mode: 0o700 })
    const extracted = await runProcess({
      command: 'tar', args: ['-xf', archive, '-C', target], cwd: target,
      timeoutMs, outputLimitBytes: 4 * 1024 * 1024,
    })
    if (!extracted.ok) throw new ProtocolError('无法展开冻结 Source', [extracted.stderr])
    await assertSafeSymlinks(target)
    return target
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function copyCandidate({ incumbentRoot, destination }) {
  const source = resolve(incumbentRoot)
  const target = resolve(destination)
  assertDescendant(dirname(target), target, 'Candidate destination')
  try {
    await lstat(target)
    throw new ProtocolError(`Candidate destination 已存在：${target}`)
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try {
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      mode: fsConstants.COPYFILE_FICLONE,
    })
    await assertSafeSymlinks(target)
    return target
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw new ProtocolError('无法复制 incumbent Candidate', [error.message])
  }
}

async function setEntryPermissions({ path, stat }, { uid, gid, writable }) {
  if (stat.isSymbolicLink()) return
  if (uid !== undefined && gid !== undefined) await chown(path, uid, gid)
  if (stat.isDirectory()) await chmod(path, writable ? 0o750 : 0o550)
  else if (stat.isFile()) await chmod(path, writable ? (stat.mode & 0o111 ? 0o750 : 0o640) : (stat.mode & 0o111 ? 0o550 : 0o440))
}

function permissionForPath(rel, level, policy) {
  if (matches(rel, policy.alwaysReadOnly)) return false
  return matches(rel, policy.levels[level])
}

function directoryCanCreate(rel, level, policy) {
  if (matches(rel, policy.alwaysReadOnly) || matches(`${rel}/sentinel`, policy.alwaysReadOnly)) return false
  return policy.levels[level].some((pattern) => {
    if (!pattern.endsWith('/**')) return false
    const rootPattern = pattern.slice(0, -3)
    return globToRegExp(rootPattern).test(rel) || globToRegExp(pattern).test(`${rel}/sentinel`)
  })
}

export async function applyMutationBoundary({
  candidateRoot,
  level,
  updaterUid,
  updaterGid,
  trustedUid = 0,
  trustedGid = 0,
  policy = DEEPSEEK_HARNESS_MUTATION_POLICY,
}) {
  if (!policy.levels[level]) throw new ProtocolError(`未知 mutation level：${level}`)
  const root = resolve(candidateRoot)
  const entries = []
  await walk(root, root, async (entry) => entries.push(entry))
  await setEntryPermissions({ path: root, stat: await lstat(root) }, {
    uid: trustedUid, gid: trustedGid, writable: false,
  })
  for (const entry of entries) {
    const writable = entry.stat.isDirectory()
      ? directoryCanCreate(entry.rel, level, policy)
      : permissionForPath(entry.rel, level, policy)
    await setEntryPermissions(entry, {
      uid: writable ? updaterUid : trustedUid,
      gid: writable ? updaterGid : trustedGid,
      writable,
    })
  }
  return {
    root,
    level,
    writableEntries: entries.filter((entry) => entry.stat.isDirectory()
      ? directoryCanCreate(entry.rel, level, policy)
      : permissionForPath(entry.rel, level, policy)).map((entry) => entry.rel),
  }
}

export async function freezeCandidatePermissions({ candidateRoot, trustedUid = 0, trustedGid = 0 }) {
  const root = resolve(candidateRoot)
  const entries = []
  await walk(root, root, async (entry) => entries.push(entry))
  await setEntryPermissions({ path: root, stat: await lstat(root) }, {
    uid: trustedUid, gid: trustedGid, writable: false,
  })
  for (const entry of entries) {
    await setEntryPermissions(entry, { uid: trustedUid, gid: trustedGid, writable: false })
  }
}

export function candidateWorkspacePath(campaignRoot, candidateId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidateId)) throw new ProtocolError('非法 candidateId')
  return join(resolve(campaignRoot), 'candidates', candidateId, 'workspace')
}
