import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { isPathAllowed } from './mutation.mjs'
import { ProtocolError } from './protocol.mjs'
import { runProcess } from './subprocess.mjs'

const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u
const GIT_TIMEOUT_MS = 10 * 60 * 1000

function scoped(root, path, label) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  const rel = relative(resolvedRoot, resolvedPath)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new ProtocolError(`${label} escapes its trusted root`)
  }
  return resolvedPath
}

function digestTree(tree) {
  return createHash('sha256').update('linear-git-tree-v1\0').update(tree).digest('hex')
}

function parseNameStatus(output) {
  const fields = String(output).split('\0').filter(Boolean)
  if (fields.length % 2 !== 0) throw new ProtocolError('Git emitted malformed name-status output')
  const changes = []
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]
    const path = fields[index + 1]
    const kind = status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified'
    changes.push({ path, kind })
  }
  return changes
}

export class LinearGitWorkspace {
  constructor({
    campaignRoot,
    sourceRoot,
    workspace,
    targetRevision,
    updaterUid,
    updaterGid,
    mutationPolicy,
    gitPath = '/usr/bin/git',
    setprivPath = '/usr/bin/setpriv',
    execute = runProcess,
  }) {
    this.campaignRoot = resolve(campaignRoot)
    this.sourceRoot = resolve(sourceRoot)
    this.workspace = scoped(this.campaignRoot, workspace, 'Linear workspace')
    this.gitRoot = scoped(
      this.campaignRoot,
      join(this.campaignRoot, 'private', 'linear-git.git'),
      'Git root',
    )
    if (!COMMIT_PATTERN.test(targetRevision ?? '')) throw new ProtocolError('Invalid target revision')
    if (!Number.isInteger(updaterUid) || updaterUid < 1
        || !Number.isInteger(updaterGid) || updaterGid < 1) {
      throw new ProtocolError('Linear Git updater uid/gid must be positive integers')
    }
    this.targetRevision = targetRevision
    this.updaterUid = updaterUid
    this.updaterGid = updaterGid
    this.mutationPolicy = mutationPolicy
    this.gitPath = resolve(gitPath)
    this.setprivPath = resolve(setprivPath)
    this.execute = execute
    this.initialized = false
    this.updaterAccess = false
  }

  #environment() {
    return {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    }
  }

  async #run(command, args, {
    cwd = this.workspace,
    allowedExitCodes = [0],
    outputLimitBytes = 8 * 1024 * 1024,
  } = {}) {
    const result = await this.execute({
      command,
      args,
      cwd,
      env: this.#environment(),
      timeoutMs: GIT_TIMEOUT_MS,
      outputLimitBytes,
    })
    if (result.timedOut || result.aborted || result.outputExceeded
        || !allowedExitCodes.includes(result.exitCode)) {
      const diagnostic = String(result.stderr ?? '').trim().slice(-1_000)
      throw new ProtocolError(`Linear Git command failed${diagnostic ? `: ${diagnostic}` : ''}`, [
        `${command} ${args.join(' ')}`,
        String(result.stderr ?? '').slice(-4_000),
      ])
    }
    return result
  }

  async #git(args, options = {}) {
    const gitArguments = [`--git-dir=${this.gitRoot}`, `--work-tree=${this.workspace}`, ...args]
    if (!this.updaterAccess) return this.#run(this.gitPath, gitArguments, options)
    return this.#run(this.setprivPath, [
      `--reuid=${this.updaterUid}`,
      `--regid=${this.updaterGid}`,
      '--clear-groups',
      this.gitPath,
      ...gitArguments,
    ], options)
  }

  async initialize() {
    if (this.initialized) return
    let repositoryExists = true
    try {
      const stat = await lstat(this.gitRoot)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ProtocolError('Linear Git root must be a real directory')
      }
    } catch (error) {
      if (error instanceof ProtocolError || error.code !== 'ENOENT') throw error
      repositoryExists = false
    }

    if (!repositoryExists) {
      await mkdir(this.workspace, { recursive: true, mode: 0o700 })
      await mkdir(dirname(this.gitRoot), { recursive: true, mode: 0o700 })
      const stage = `${this.gitRoot}.stage-${randomUUID()}`
      try {
        // A local bare clone hard-links objects but does not leave an
        // alternates pointer back into the source repository. The updater can
        // therefore use this repository without any source-tree mount.
        await this.#run(this.gitPath, ['clone', '--bare', this.sourceRoot, stage], {
          cwd: this.workspace,
        })
        await this.#run(this.gitPath, [`--git-dir=${stage}`, 'config', 'core.bare', 'false'])
        await this.#run(this.gitPath, [
          `--git-dir=${stage}`, 'config', 'core.worktree', this.workspace,
        ])
        await this.#run(this.gitPath, [
          `--git-dir=${stage}`, 'update-ref', 'refs/heads/incumbent', this.targetRevision,
        ])
        await this.#run(this.gitPath, [
          `--git-dir=${stage}`, 'symbolic-ref', 'HEAD', 'refs/heads/incumbent',
        ])
        await rename(stage, this.gitRoot)
        await this.#git(['reset', '--hard', this.targetRevision])
        await this.#git(['clean', '-ffdx'])
      } catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }

    const configuredWorktree = (await this.#git(['config', '--path', 'core.worktree'])).stdout.trim()
    if (resolve(configuredWorktree) !== this.workspace) {
      throw new ProtocolError('Linear Git repository points at a different worktree')
    }
    const head = (await this.#git(['symbolic-ref', '-q', 'HEAD'])).stdout.trim()
    if (head !== 'refs/heads/incumbent') {
      throw new ProtocolError('Linear Git HEAD must be the incumbent branch')
    }
    this.initialized = true
  }

  async grantUpdaterAccess() {
    await this.initialize()
    if (this.updaterAccess) return
    // These three parents only need execute permission for the updater to
    // traverse to the two explicitly mounted writable roots.
    const traversalRoots = new Set([
      dirname(this.campaignRoot),
      this.campaignRoot,
      dirname(dirname(this.workspace)),
      dirname(this.workspace),
      dirname(this.gitRoot),
    ])
    for (const path of traversalRoots) {
      await this.#run('/usr/bin/chown', ['0:' + this.updaterGid, '--', path], {
        cwd: this.campaignRoot,
      })
      await this.#run('/usr/bin/chmod', ['710', '--', path], { cwd: this.campaignRoot })
    }
    const roots = await Promise.all([this.workspace, this.gitRoot].map((path) => lstat(path)))
    if (roots.every((stat) => stat.uid === this.updaterUid
        && stat.gid === this.updaterGid && (stat.mode & 0o700) === 0o700)) {
      this.updaterAccess = true
      return
    }
    for (const path of [this.workspace, this.gitRoot]) {
      await this.#run('/usr/bin/chown', [
        '-R', `${this.updaterUid}:${this.updaterGid}`, '--', path,
      ], { cwd: this.campaignRoot })
      await this.#run('/usr/bin/chmod', ['-R', 'u+rwX', '--', path], {
        cwd: this.campaignRoot,
      })
    }
    this.updaterAccess = true
  }

  async current() {
    await this.initialize()
    const commit = (await this.#git(['rev-parse', 'HEAD'])).stdout.trim()
    const tree = (await this.#git(['rev-parse', `${commit}^{tree}`])).stdout.trim()
    if (!COMMIT_PATTERN.test(commit) || !COMMIT_PATTERN.test(tree)) {
      throw new ProtocolError('Linear Git HEAD metadata is invalid')
    }
    return { commit, tree, digest: digestTree(tree) }
  }

  async prepareMutation(expectedParent = null) {
    await this.grantUpdaterAccess()
    const current = await this.current()
    if (expectedParent !== null && current.commit !== expectedParent) {
      throw new ProtocolError('Linear Git HEAD does not match the expected incumbent')
    }
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (status.stdout.length !== 0) throw new ProtocolError('Linear Git worktree is dirty before mutation')
    return current
  }

  async inspectMutation(parentCommit, level = null) {
    await this.grantUpdaterAccess()
    if (!COMMIT_PATTERN.test(parentCommit ?? '')) throw new ProtocolError('Invalid parent commit')
    const current = await this.current()
    if (current.commit === parentCommit) throw new ProtocolError('Updater did not create a commit')
    const count = Number((await this.#git([
      'rev-list', '--count', `${parentCommit}..${current.commit}`,
    ])).stdout.trim())
    if (count !== 1) throw new ProtocolError('Updater must create exactly one commit')
    const ancestor = await this.#git(
      ['merge-base', '--is-ancestor', parentCommit, current.commit],
      { allowedExitCodes: [0, 1] },
    )
    if (ancestor.exitCode !== 0) throw new ProtocolError('Updater commit does not descend from incumbent')
    const status = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (status.stdout.length !== 0) throw new ProtocolError('Updater left a dirty worktree')

    const changes = parseNameStatus((await this.#git([
      'diff', '--name-status', '-z', '--no-renames', parentCommit, current.commit,
    ])).stdout)
    if (changes.length === 0) throw new ProtocolError('Updater commit has no source changes')
    const subject = (await this.#git(['log', '-1', '--format=%s', current.commit])).stdout.trim()
    const declared = subject.match(/^rsi\((l1|l2|l3)\):\s*\S/u)?.[1] ?? null
    const selectedLevel = level ?? declared
    if (selectedLevel === null) {
      throw new ProtocolError('Soft-layer Updater commit must declare rsi(l1|l2|l3)')
    }
    const invalid = changes.filter((change) => (
      !isPathAllowed(change.path, selectedLevel, this.mutationPolicy)
    ))
    if (invalid.length > 0) {
      throw new ProtocolError(`Updater commit exceeds ${selectedLevel.toUpperCase()} path boundary`, [
        ...invalid.map((change) => change.path),
      ])
    }
    const diffStat = (await this.#git([
      'diff', '--stat', '--no-renames', parentCommit, current.commit,
    ])).stdout.trim()
    const patch = (await this.#git([
      'diff', '--no-ext-diff', '--no-renames', '--unified=3', parentCommit, current.commit,
    ], { outputLimitBytes: 512 * 1024 })).stdout
    return {
      parentCommit,
      commit: current.commit,
      tree: current.tree,
      digest: current.digest,
      level: selectedLevel,
      direction: subject.replace(/^rsi\([^)]+\):\s*/u, '').trim() || subject,
      commitMessage: subject,
      changedFiles: changes.map((change) => change.path),
      changes,
      diffStat,
      patch,
    }
  }

  async acceptMutation(parentCommit, commit) {
    const current = await this.current()
    if (current.commit !== commit || current.commit === parentCommit) {
      throw new ProtocolError('Cannot accept a mutation that is not current HEAD')
    }
    return current
  }

  async rejectMutation(parentCommit) {
    await this.grantUpdaterAccess()
    if (!COMMIT_PATTERN.test(parentCommit ?? '')) throw new ProtocolError('Invalid reset target')
    await this.#git(['reset', '--hard', parentCommit])
    await this.#git(['clean', '-ffdx'])
    return this.current()
  }
}
