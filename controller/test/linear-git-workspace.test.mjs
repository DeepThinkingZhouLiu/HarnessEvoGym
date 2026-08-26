import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LinearGitWorkspace } from '../src/linear-git-workspace.mjs'
import { MSA_MINIMAL_MUTATION_POLICY } from '../src/mutation.mjs'

const MUTATION_PATH = 'apps/cli/config/agent-presets/minimal/agent.cordis.yml'
const PRIVILEGED = (process.getuid?.() ?? 0) === 0
const UPDATER_UID = PRIVILEGED ? 65534 : process.getuid()
const UPDATER_GID = PRIVILEGED ? 65534 : process.getgid()

function updaterGit(manager, args) {
  const command = PRIVILEGED ? '/usr/bin/setpriv' : '/usr/bin/git'
  const privilegeArgs = PRIVILEGED ? [
    `--reuid=${UPDATER_UID}`, `--regid=${UPDATER_GID}`, '--clear-groups', '/usr/bin/git',
  ] : []
  return execFileSync(command, [
    ...privilegeArgs,
    `--git-dir=${manager.gitRoot}`,
    `--work-tree=${manager.workspace}`,
    ...args,
  ], {
    cwd: manager.workspace,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Updater Test',
      GIT_AUTHOR_EMAIL: 'updater@test.invalid',
      GIT_COMMITTER_NAME: 'Updater Test',
      GIT_COMMITTER_EMAIL: 'updater@test.invalid',
    },
  }).trim()
}

async function fixture({ mutationPolicy } = {}) {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'linear-git-source-'))
  const campaignRoot = await mkdtemp(join(tmpdir(), 'linear-git-campaign-'))
  const workspace = join(campaignRoot, 'candidates', 'baseline', 'workspace')
  await mkdir(join(sourceRoot, 'apps/cli/config/agent-presets/minimal'), { recursive: true })
  await mkdir(join(sourceRoot, 'profiles'), { recursive: true })
  await writeFile(join(sourceRoot, MUTATION_PATH), 'baseline\n')
  await writeFile(join(sourceRoot, 'profiles/math.json'), '{}\n')
  await writeFile(join(sourceRoot, 'agent.py'), 'print("baseline")\n')
  await writeFile(join(sourceRoot, 'README.md'), 'fixture\n')
  execFileSync('git', ['init', '-q'], { cwd: sourceRoot })
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: sourceRoot })
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: sourceRoot })
  execFileSync('git', ['add', '.'], { cwd: sourceRoot })
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: sourceRoot })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim()
  const manager = new LinearGitWorkspace({
    campaignRoot,
    sourceRoot,
    workspace,
    targetRevision: revision,
    updaterUid: UPDATER_UID,
    updaterGid: UPDATER_GID,
    mutationPolicy,
  })
  return { manager, workspace }
}

test('updater commits and controller keeps or resets in one worktree', async () => {
  const { manager, workspace } = await fixture()
  const baseline = await manager.prepareMutation()

  await writeFile(join(workspace, MUTATION_PATH), 'candidate one\n')
  updaterGit(manager, ['add', '--', MUTATION_PATH])
  updaterGit(manager, ['commit', '-qm', 'rsi(l1): first'])
  const first = await manager.inspectMutation(baseline.commit, 'l1')
  assert.deepEqual(first.changedFiles, [MUTATION_PATH])
  assert.equal(first.direction, 'first')
  await manager.acceptMutation(baseline.commit, first.commit)

  await manager.prepareMutation(first.commit)
  await writeFile(join(workspace, MUTATION_PATH), 'candidate two\n')
  updaterGit(manager, ['add', '--', MUTATION_PATH])
  updaterGit(manager, ['commit', '-qm', 'rsi(l1): second'])
  const second = await manager.inspectMutation(first.commit, 'l1')
  assert.notEqual(second.commit, first.commit)
  await manager.rejectMutation(first.commit)
  assert.equal((await manager.current()).commit, first.commit)
  assert.equal(await readFile(join(workspace, MUTATION_PATH), 'utf8'), 'candidate one\n')
})

test('controller rejects a committed path outside the active level', async () => {
  const { manager, workspace } = await fixture()
  const baseline = await manager.prepareMutation()
  await writeFile(join(workspace, 'README.md'), 'unauthorized\n')
  updaterGit(manager, ['add', '--', 'README.md'])
  updaterGit(manager, ['commit', '-qm', 'rsi(l1): escape'])
  await assert.rejects(() => manager.inspectMutation(baseline.commit, 'l1'), /path boundary/u)
  await manager.rejectMutation(baseline.commit)
  assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), 'fixture\n')
})

test('soft audit trusts the declared layer only within its configured path boundary', async () => {
  const { manager, workspace } = await fixture({ mutationPolicy: MSA_MINIMAL_MUTATION_POLICY })
  const baseline = await manager.prepareMutation()

  await writeFile(join(workspace, 'agent.py'), 'print("too wide for l1")\n')
  updaterGit(manager, ['add', '--', 'agent.py'])
  updaterGit(manager, ['commit', '-qm', 'rsi(l1): misclassified loop change'])
  await assert.rejects(() => manager.inspectMutation(baseline.commit), /L1 path boundary/u)
  await manager.rejectMutation(baseline.commit)

  await writeFile(join(workspace, 'agent.py'), 'print("valid l2")\n')
  updaterGit(manager, ['add', '--', 'agent.py'])
  updaterGit(manager, ['commit', '-qm', 'rsi(l2): adjust loop behavior'])
  const mutation = await manager.inspectMutation(baseline.commit)
  assert.equal(mutation.level, 'l2')
  assert.deepEqual(mutation.changedFiles, ['agent.py'])
  await manager.rejectMutation(baseline.commit)

  await writeFile(join(workspace, 'profiles/math.json'), '{"mode":"brief"}\n')
  updaterGit(manager, ['add', '--', 'profiles/math.json'])
  updaterGit(manager, ['commit', '-qm', 'missing soft layer declaration'])
  await assert.rejects(() => manager.inspectMutation(baseline.commit), /must declare/u)
})
