import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillsBenchEnvironment } from '../src/environments/skillsbench.mjs'

test('root Verifier 只读挂载 Solver 工作区并在退出时修复日志归属', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skillsbench-verifier-'))
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  await mkdir(workspace)
  let runOptions
  const docker = {
    async run(options) {
      runOptions = options
      await mkdir(join(logs, 'verifier'), { recursive: true })
      await writeFile(join(logs, 'verifier', 'reward.txt'), '1\n')
      return { stdout: '', stderr: '', durationMs: 1, outputTruncated: false }
    },
  }
  const environment = {
    task: { workspacePath: '/root', workspaceLimits: { maximumBytes: 1024 * 1024 } },
    verifier: {
      pythonCommand: 'python',
      shellCommand: 'bash',
      arguments: [],
      outputCandidates: ['/logs/verifier/reward.txt'],
      proxyEnvironment: ['HTTP_PROXY', 'HTTPS_PROXY'],
      network: 'bridge',
      runAsCurrentUser: false,
    },
  }
  const runner = new SkillsBenchEnvironment({
    environment,
    benchmark: {},
    target: {},
    solverDriver: {},
    docker,
    runRoot: root,
  })

  const result = await runner.runVerifier({
    layout: { verifierPath: '/trusted/verifier/test.sh' },
    image: 'task:test',
    workspace,
    logs,
    name: 'verifier-test',
  })

  assert.equal(result.reward, 1)
  assert.equal(runOptions.mounts.find((mount) => mount.source === workspace).readOnly, true)
  assert.equal(runOptions.mounts.find((mount) => mount.source === workspace).target, '/rsi-submission')
  assert.ok(runOptions.tmpfs.some((value) => value.startsWith('/root:') && value.includes('size=1048576')))
  assert.equal(runOptions.entrypoint, 'bash')
  assert.equal(runOptions.command[0], '-c')
  assert.match(runOptions.command[1], /chown -hR/u)
  assert.match(runOptions.command[1], /cp -a \/rsi-submission/u)
  assert.ok(runOptions.capabilities.includes('CHOWN'))
  assert.ok(!runOptions.capabilities.includes('SYS_ADMIN'))
  assert.equal(runOptions.environment.PYTHONDONTWRITEBYTECODE, '1')
  assert.deepEqual(
    runOptions.inheritEnvironment,
    ['HTTP_PROXY', 'HTTPS_PROXY'].filter((nameValue) => Boolean(process.env[nameValue])),
  )
})

test('Verifier Reward 符号链接不会被 Controller 跟随', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skillsbench-reward-link-'))
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  const outside = join(root, 'outside.txt')
  await mkdir(workspace)
  await writeFile(outside, '1\n')
  const docker = {
    async run() {
      await mkdir(join(logs, 'verifier'), { recursive: true })
      await symlink(outside, join(logs, 'verifier', 'reward.txt'))
      return { stdout: '', stderr: '', durationMs: 1, outputTruncated: false }
    },
  }
  const runner = new SkillsBenchEnvironment({
    environment: {
      task: { workspacePath: '/root', workspaceLimits: { maximumBytes: 1024 * 1024 } },
      verifier: {
        pythonCommand: 'python',
        shellCommand: 'bash',
        arguments: [],
        outputCandidates: ['/logs/verifier/reward.txt'],
        network: 'bridge',
        runAsCurrentUser: false,
      },
    },
    benchmark: {},
    target: {},
    solverDriver: {},
    docker,
    runRoot: root,
  })

  const result = await runner.runVerifier({
    layout: { verifierPath: '/trusted/verifier/test.sh' },
    image: 'task:test',
    workspace,
    logs,
    name: 'verifier-link-test',
  })

  assert.equal(result.reward, null)
  assert.match(result.error, /不安全或不可读/u)
})
