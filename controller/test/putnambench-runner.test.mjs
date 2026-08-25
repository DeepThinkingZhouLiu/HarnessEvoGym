import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import {
  CONTROLLER_GATEWAY_DUMMY_KEY,
  CommandAbortedError,
  CommandTimeoutError,
  PUTNAMBENCH_LEAN_PIN,
  acquirePutnamBenchDatasetLock,
  buildHarnessInvocation,
  extractProofReplacement,
  preparePutnamBenchDataset,
  prepareTask,
  runHarnessSolver,
  verifyTask,
} from '../src/putnambench-runner.mjs'
import { ProtocolError } from '../src/protocol.mjs'

async function datasetFixture() {
  const root = await mkdtemp(join(tmpdir(), 'putnambench-dataset-'))
  const leanRoot = join(root, 'lean4')
  await mkdir(join(leanRoot, 'scripts'), { recursive: true })
  await mkdir(join(leanRoot, 'src'), { recursive: true })
  await writeFile(join(leanRoot, 'lean-toolchain'), `${PUTNAMBENCH_LEAN_PIN.leanToolchain}\n`)
  await writeFile(join(leanRoot, 'lake-manifest.json'), JSON.stringify({
    packages: [{ name: 'mathlib', rev: PUTNAMBENCH_LEAN_PIN.mathlibRevision }],
  }))
  await writeFile(join(leanRoot, 'scripts', 'rewrite_solutions.py'), '# official fixture\n')
  const ids = []
  for (let index = 0; index < PUTNAMBENCH_LEAN_PIN.taskCount; index += 1) {
    const year = 1900 + Math.floor(index / 12)
    const session = index % 12 < 6 ? 'a' : 'b'
    const number = index % 6 + 1
    const id = `putnam_${year}_${session}${number}`
    ids.push(id)
    await writeFile(join(leanRoot, 'src', `${id}.lean`), `import Mathlib\ntheorem ${id} : True := sorry\n`)
  }
  return { root, leanRoot, ids }
}

function frozenCheckoutResult(invocation) {
  if (invocation.args.includes('status')) return { exitCode: 0, stdout: '', stderr: '' }
  return { exitCode: 0, stdout: `${PUTNAMBENCH_LEAN_PIN.datasetRevision}\n`, stderr: '' }
}

async function writeRewrittenFixture(invocation, fixture, { limit = fixture.ids.length } = {}) {
  const output = join(dirname(dirname(invocation.args[0])), 'solutions_replaced_new')
  await mkdir(output, { recursive: true })
  await Promise.all(fixture.ids.slice(0, limit).map((id) => writeFile(
    join(output, `${id}_sol.lean`),
    `import Mathlib\ntheorem ${id} : True := sorry\n`,
  )))
}

test('validates frozen revisions, runs official rewrite, and attests all 672 templates', async () => {
  const fixture = await datasetFixture()
  const calls = []
  const execute = async (invocation) => {
    calls.push(invocation)
    if (invocation.command === 'git') return frozenCheckoutResult(invocation)
    await writeRewrittenFixture(invocation, fixture)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const prepared = await preparePutnamBenchDataset({ datasetRoot: fixture.root, execute })
  assert.equal(prepared.taskCount, 672)
  assert.deepEqual(prepared.problemIds, [...fixture.ids].sort())
  assert.equal(calls[2].command, 'python3')
  assert.match(calls[2].args[0], /\.harness-rsi-dataset-stage-[^/]+\/scripts\/rewrite_solutions\.py$/u)
  assert.equal(prepared.solutionsRoot, join(fixture.leanRoot, 'solutions_replaced_new'))
  assert.equal((await lstat(prepared.solutionsRoot)).mode & 0o222, 0)
})

test('serializes concurrent Campaign preparation and reuses one immutable attested output', async () => {
  const fixture = await datasetFixture()
  let rewriteCalls = 0
  let activeRewrites = 0
  let maximumActiveRewrites = 0
  const execute = async (invocation) => {
    if (invocation.command === 'git') return frozenCheckoutResult(invocation)
    rewriteCalls += 1
    activeRewrites += 1
    maximumActiveRewrites = Math.max(maximumActiveRewrites, activeRewrites)
    await new Promise((accept) => setTimeout(accept, 30))
    await writeRewrittenFixture(invocation, fixture)
    activeRewrites -= 1
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  const [first, second] = await Promise.all([
    preparePutnamBenchDataset({
      datasetRoot: fixture.root,
      execute,
      lockPollIntervalMs: 5,
    }),
    preparePutnamBenchDataset({
      datasetRoot: fixture.root,
      execute,
      lockPollIntervalMs: 5,
    }),
  ])
  const third = await preparePutnamBenchDataset({ datasetRoot: fixture.root, execute })

  assert.equal(rewriteCalls, 1)
  assert.equal(maximumActiveRewrites, 1)
  assert.equal(first.outputSha256, second.outputSha256)
  assert.equal(second.outputSha256, third.outputSha256)
  assert.equal(first.taskCount, PUTNAMBENCH_LEAN_PIN.taskCount)
  assert.equal((await lstat(first.solutionsRoot)).mode & 0o222, 0)
})

test('never publishes a partial rewrite and recovers cleanly on the next attempt', async () => {
  const fixture = await datasetFixture()
  let partial = true
  const execute = async (invocation) => {
    if (invocation.command === 'git') return frozenCheckoutResult(invocation)
    await writeRewrittenFixture(invocation, fixture, {
      limit: partial ? PUTNAMBENCH_LEAN_PIN.taskCount - 1 : PUTNAMBENCH_LEAN_PIN.taskCount,
    })
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await assert.rejects(
    () => preparePutnamBenchDataset({ datasetRoot: fixture.root, execute }),
    /文件数不正确/u,
  )
  await assert.rejects(
    () => lstat(join(fixture.leanRoot, 'solutions_replaced_new')),
    (error) => error.code === 'ENOENT',
  )
  assert.equal(
    (await readdir(fixture.root)).some((name) => name.startsWith('.harness-rsi-dataset-stage-')),
    false,
  )

  partial = false
  const prepared = await preparePutnamBenchDataset({ datasetRoot: fixture.root, execute })
  assert.equal(prepared.taskCount, PUTNAMBENCH_LEAN_PIN.taskCount)
})

test('filesystem dataset lock excludes a live other process and reclaims it after SIGKILL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'putnambench-cross-process-lock-'))
  const moduleUrl = new URL('../src/putnambench-runner.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', [
    `import { acquirePutnamBenchDatasetLock } from ${JSON.stringify(moduleUrl)}`,
    `await acquirePutnamBenchDatasetLock({ datasetRoot: ${JSON.stringify(root)} })`,
    "process.stdout.write('locked\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const [chunk] = await once(child.stdout, 'data')
  assert.equal(String(chunk), 'locked\n')

  await assert.rejects(
    () => acquirePutnamBenchDatasetLock({
      datasetRoot: root,
      timeoutMs: 80,
      pollIntervalMs: 10,
    }),
    (error) => error instanceof CommandTimeoutError,
  )
  child.kill('SIGKILL')
  await once(child, 'close')

  const release = await acquirePutnamBenchDatasetLock({
    datasetRoot: root,
    timeoutMs: 2_000,
    pollIntervalMs: 10,
  })
  await release()
  await release()
})

test('filesystem dataset lock recovers a crash before owner metadata was written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'putnambench-incomplete-lock-'))
  await mkdir(join(root, '.harness-rsi-dataset-prepare.lock'))
  const release = await acquirePutnamBenchDatasetLock({
    datasetRoot: root,
    timeoutMs: 2_000,
    pollIntervalMs: 5,
    incompleteLockGraceMs: 0,
  })
  await release()
})

test('rejects a checkout whose frozen toolchain or revision drifts', async () => {
  const fixture = await datasetFixture()
  await writeFile(join(fixture.leanRoot, 'lean-toolchain'), 'leanprover/lean4:nightly\n')
  const execute = async () => ({
    exitCode: 0, stdout: '', stderr: '',
  })
  let calls = 0
  await assert.rejects(
    () => preparePutnamBenchDataset({
      datasetRoot: fixture.root,
      execute: async (invocation) => {
        calls += 1
        if (calls === 1) {
          return { exitCode: 0, stdout: `${PUTNAMBENCH_LEAN_PIN.datasetRevision}\n`, stderr: '' }
        }
        return execute(invocation)
      },
    }),
    (error) => error instanceof ProtocolError && /toolchain/u.test(error.message),
  )
})

async function taskFixture() {
  const root = await mkdtemp(join(tmpdir(), 'putnam-task-test-'))
  const solutionsRoot = join(root, 'solutions')
  const taskRoot = join(root, 'tasks')
  const trustedRoot = join(root, 'trusted')
  await mkdir(solutionsRoot)
  const problemId = 'putnam_1962_a1'
  const template = `import Mathlib\n\ntheorem ${problemId} : True :=\nsorry\n`
  await writeFile(join(solutionsRoot, `${problemId}_sol.lean`), template)
  const prepared = await prepareTask({ solutionsRoot, problemId, taskRoot, trustedRoot })
  return { root, template, prepared }
}

test('prepares an anonymous task directory and keeps trusted template outside it', async () => {
  const { template, prepared } = await taskFixture()
  assert.match(basename(prepared.workdir), /^task-[A-Za-z0-9]+$/u)
  assert.equal(prepared.workdir.includes(prepared.problemId), false)
  assert.equal(basename(prepared.editablePath), 'Main.lean')
  assert.equal(prepared.trustedPath.startsWith(prepared.workdir), false)
  assert.equal(await readFile(prepared.editablePath, 'utf8'), template)
  assert.equal(await readFile(prepared.trustedPath, 'utf8'), template)
  assert.equal(/validation|test partition|hidden/iu.test(prepared.prompt), false)
})

test('proof extractor accepts only an exact replacement of the unique sorry', () => {
  const template = 'import Mathlib\ntheorem demo : True := sorry\n'
  const result = extractProofReplacement(template, 'import Mathlib\ntheorem demo : True := by exact True.intro\n')
  assert.equal(result.replacement, 'by exact True.intro')
  assert.throws(
    () => extractProofReplacement(template, 'import Mathlib\n\ntheorem demo : True := by exact True.intro\n'),
    /唯一 sorry 以外/u,
  )
  assert.throws(
    () => extractProofReplacement(template, 'import Mathlib\ntheorem demo : True := by admit\n'),
    /禁用项/u,
  )
})

test('external verifier reports kernel success without accepting a self-reported score', async () => {
  const { root, prepared } = await taskFixture()
  await writeFile(prepared.editablePath, prepared.prompt.includes('Main.lean')
    ? `import Mathlib\n\ntheorem ${prepared.problemId} : True :=\nby exact True.intro\n`
    : 'unreachable')
  const result = await verifyTask({
    editablePath: prepared.editablePath,
    trustedPath: prepared.trustedPath,
    verificationRoot: join(root, 'verification'),
    leanRoot: join(root, 'lean-project'),
    execute: async (invocation) => {
      assert.equal(invocation.command, 'lake')
      assert.deepEqual(invocation.args.slice(0, 3), ['env', 'lean', '-DwarningAsError=true'])
      assert.equal(Object.hasOwn(invocation.env, 'ZCLOUD_API_KEY'), false)
      assert.equal((await readFile(invocation.args[3], 'utf8')).includes('by exact True.intro'), true)
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
    baseEnvironment: { PATH: '/usr/bin', ZCLOUD_API_KEY: 'must-not-reach-lean' },
    recordTrace: async () => 'trace://validation/opaque',
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.failureKind, null)
  assert.equal(result.traceRef, 'trace://validation/opaque')
  assert.equal(Object.hasOwn(result, 'score'), false)
  assert.equal(Object.hasOwn(result, 'solved'), false)
})

test('external verifier treats Lean rejection as a candidate failure', async () => {
  const { root, prepared } = await taskFixture()
  const source = await readFile(prepared.editablePath, 'utf8')
  await writeFile(prepared.editablePath, source.replace('sorry', 'by exact False.elim (by contradiction)'))
  const result = await verifyTask({
    editablePath: prepared.editablePath,
    trustedPath: prepared.trustedPath,
    verificationRoot: join(root, 'verification'),
    leanRoot: root,
    execute: async () => ({ exitCode: 1, stdout: '', stderr: 'type mismatch' }),
  })
  assert.equal(result.status, 'rejected')
  assert.equal(result.failureKind, 'candidate')
  assert.equal(result.reasonCode, 'lean_rejected')
})

test('external verifier rejects template tampering before invoking Lean', async () => {
  const { root, prepared } = await taskFixture()
  let invoked = false
  const source = await readFile(prepared.editablePath, 'utf8')
  await writeFile(prepared.editablePath, source.replace('import Mathlib', 'import Mathlib.Data.Nat.Basic'))
  const result = await verifyTask({
    editablePath: prepared.editablePath,
    trustedPath: prepared.trustedPath,
    verificationRoot: join(root, 'verification'),
    leanRoot: root,
    execute: async () => { invoked = true; return { exitCode: 0 } },
  })
  assert.equal(invoked, false)
  assert.equal(result.status, 'rejected')
  assert.equal(result.phase, 'integrity')
})

test('external verifier never follows a Candidate-controlled source symlink', async () => {
  const { root, prepared } = await taskFixture()
  await rm(prepared.editablePath)
  await symlink('/dev/zero', prepared.editablePath)
  let invoked = false
  const result = await verifyTask({
    editablePath: prepared.editablePath,
    trustedPath: prepared.trustedPath,
    verificationRoot: join(root, 'verification'),
    leanRoot: root,
    execute: async () => { invoked = true; return { exitCode: 0 } },
  })
  assert.equal(invoked, false)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reasonCode, 'candidate_file_unavailable')
})

test('verifier timeout is infrastructure while solver timeout is a candidate budget outcome', async () => {
  const { root, prepared } = await taskFixture()
  const source = await readFile(prepared.editablePath, 'utf8')
  await writeFile(prepared.editablePath, source.replace('sorry', 'by exact True.intro'))
  const verifier = await verifyTask({
    editablePath: prepared.editablePath,
    trustedPath: prepared.trustedPath,
    verificationRoot: join(root, 'verification'),
    leanRoot: root,
    execute: async () => { throw new CommandTimeoutError() },
  })
  assert.equal(verifier.status, 'timeout')
  assert.equal(verifier.failureKind, 'infrastructure')

  const solver = await runHarnessSolver({
    invocation: { command: '/usr/bin/node', args: [], cwd: root, env: {} },
    timeoutMs: 1,
    execute: async () => { throw new CommandTimeoutError() },
  })
  assert.equal(solver.status, 'timeout')
  assert.equal(solver.failureKind, 'candidate')
})

test('Abort is represented separately from infrastructure and candidate failures', async () => {
  const result = await runHarnessSolver({
    invocation: { command: '/usr/bin/node', args: [], cwd: '/tmp', env: {} },
    execute: async () => { throw new CommandAbortedError() },
  })
  assert.equal(result.status, 'aborted')
  assert.equal(result.failureKind, 'cancelled')
})

test('Harness nonzero exit is candidate failure unless the sandbox launcher failed', async () => {
  const invocation = { command: '/usr/bin/setpriv', args: [], cwd: '/tmp', env: {} }
  const candidate = await runHarnessSolver({
    invocation,
    sandboxed: true,
    execute: async () => ({ exitCode: 1, stdout: '', stderr: 'candidate crashed' }),
  })
  assert.equal(candidate.status, 'candidate_error')
  assert.equal(candidate.failureKind, 'candidate')
  assert.equal(candidate.reasonCode, 'harness_nonzero_exit')

  const launcher = await runHarnessSolver({
    invocation,
    sandboxed: true,
    execute: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'bwrap: Can\'t mkdir parents for /opt/harness-rsi/lean-project/missing',
    }),
  })
  assert.equal(launcher.status, 'infrastructure_error')
  assert.equal(launcher.failureKind, 'infrastructure')

  const unsandboxed = await runHarnessSolver({
    invocation,
    execute: async () => ({ exitCode: 1, stdout: '', stderr: 'setpriv: synthetic candidate output' }),
  })
  assert.equal(unsandboxed.failureKind, 'candidate')
})

test('Harness invocation carries only a dummy Controller-gateway key', () => {
  const invocation = buildHarnessInvocation({
    candidateRoot: '/candidate',
    nodePath: '/usr/bin/node',
    patchPath: '/controller/model.patch.yml',
    dshHome: '/controller/dsh/task-opaque',
    workdir: '/tasks/task-opaque',
    leanRoot: '/controller/lean-runtime',
    prompt: 'solve Main.lean',
    gatewayBaseUrl: 'http://127.0.0.1:8787/v1',
    baseEnvironment: {
      PATH: '/usr/bin',
      ZCLOUD_API_KEY: 'must-not-leak',
      DASHSCOPE_API_KEY: 'must-not-leak-either',
    },
  })
  assert.equal(invocation.env.RSI_MODEL_GATEWAY_DUMMY_KEY, CONTROLLER_GATEWAY_DUMMY_KEY)
  assert.equal(invocation.env.RSI_MODEL_GATEWAY_URL, 'http://127.0.0.1:8787/v1')
  assert.equal(invocation.env.DSH_SESSION_ROOT, '/controller/dsh/task-opaque/sessions')
  assert.equal(invocation.env.DSH_PERMISSION_MODE, 'workspace-write')
  assert.equal(invocation.env.RSI_LEAN_PROJECT_ROOT, '/controller/lean-runtime')
  assert.equal(invocation.env.RSI_TASK_FILE, '/tasks/task-opaque/Main.lean')
  assert.equal(invocation.env.TASK_CWD, '/tasks/task-opaque')
  assert.match(invocation.env.DSH_SOURCE_BIN, /^file:\/\/\/candidate\/apps\/cli\/src\/bin\.ts$/u)
  assert.equal(invocation.env.TSX_TSCONFIG_PATH, '/candidate/tsconfig.json')
  assert.equal(Object.hasOwn(invocation.env, 'ZCLOUD_API_KEY'), false)
  assert.equal(Object.hasOwn(invocation.env, 'DASHSCOPE_API_KEY'), false)
  assert.deepEqual(invocation.args.slice(6, 12), [
    '--profile', 'headless', '--patch', '/controller/model.patch.yml', '--preset', 'standard',
  ])
  assert.equal(invocation.cwd, '/candidate')
})
