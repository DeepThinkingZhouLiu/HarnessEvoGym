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
  const previousUvDownloadUrl = process.env.RSI_TEST_VERIFIER_UV_DOWNLOAD_URL
  process.env.RSI_TEST_VERIFIER_UV_DOWNLOAD_URL = 'http://host.docker.internal:17891'
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
      dependencyEnvironment: { UV_DOWNLOAD_URL: 'RSI_TEST_VERIFIER_UV_DOWNLOAD_URL' },
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
  if (previousUvDownloadUrl === undefined) delete process.env.RSI_TEST_VERIFIER_UV_DOWNLOAD_URL
  else process.env.RSI_TEST_VERIFIER_UV_DOWNLOAD_URL = previousUvDownloadUrl

  assert.equal(result.reward, 1)
  assert.equal(runOptions.mounts.find((mount) => mount.source === workspace).readOnly, true)
  assert.equal(runOptions.mounts.find((mount) => mount.source === workspace).target, '/rsi-submission')
  assert.ok(runOptions.tmpfs.some((value) => value.startsWith('/root:') && value.includes('size=1048576')))
  assert.ok(runOptions.tmpfs.includes('/tmp:rw,exec,nosuid,nodev,size=1g'))
  assert.equal(runOptions.entrypoint, 'bash')
  assert.equal(runOptions.command[0], '-c')
  assert.match(runOptions.command[1], /chown -hR/u)
  assert.match(runOptions.command[1], /cp -a \/rsi-submission/u)
  assert.ok(runOptions.capabilities.includes('CHOWN'))
  assert.ok(!runOptions.capabilities.includes('SYS_ADMIN'))
  assert.equal(runOptions.environment.PYTHONDONTWRITEBYTECODE, '1')
  assert.ok(runOptions.environment.PATH.startsWith('/opt/venv/bin:'))
  assert.equal(runOptions.environment.UV_DOWNLOAD_URL, 'http://host.docker.internal:17891')
  assert.equal(runOptions.hostGateway, true)
  assert.deepEqual(
    runOptions.inheritEnvironment,
    ['HTTP_PROXY', 'HTTPS_PROXY'].filter((nameValue) => Boolean(process.env[nameValue])),
  )
})

test('Verifier 缺少结构化评分证据时自动重试，不能把基础设施故障记成 0 分', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skillsbench-verifier-retry-'))
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  await mkdir(workspace)
  const names = []
  let attempts = 0
  const docker = {
    async run(options) {
      attempts += 1
      names.push(options.name)
      await mkdir(join(logs, 'verifier'), { recursive: true })
      await writeFile(join(logs, 'verifier', 'reward.txt'), attempts === 1 ? '0\n' : '1\n')
      if (attempts === 2) {
        await writeFile(join(logs, 'verifier', 'ctrf.json'), JSON.stringify({
          results: {
            summary: { tests: 1, passed: 1, failed: 0, skipped: 0, pending: 0, other: 0 },
            tests: [{ name: 'test_ok', status: 'passed' }],
          },
        }))
      }
      return { stdout: '', stderr: attempts === 1 ? 'dependency download failed' : '', durationMs: 1 }
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
        requiredEvidenceCandidates: ['/logs/verifier/ctrf.json'],
        maximumAttempts: 2,
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
    name: 'verifier-retry-test',
  })

  assert.equal(attempts, 2)
  assert.deepEqual(names, ['verifier-retry-test', 'verifier-retry-test-attempt-2'])
  assert.equal(result.reward, 1)
  assert.equal(result.error, null)
  assert.equal(result.durationMs, 2)
  assert.match(result.evidence, /attempt 1\/2/u)
  assert.match(result.evidence, /tests=1 passed=1 failed=0/u)
})

test('Verifier 将 CTRF 失败断言置于安装日志之前', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skillsbench-verifier-feedback-'))
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  await mkdir(workspace)
  const docker = {
    async run() {
      await mkdir(join(logs, 'verifier'), { recursive: true })
      await writeFile(join(logs, 'verifier', 'reward.txt'), '0\n')
      await writeFile(join(logs, 'verifier', 'ctrf.json'), JSON.stringify({
        results: {
          summary: { tests: 2, passed: 1, failed: 1, skipped: 0, pending: 0, other: 0 },
          tests: [
            { name: 'test_ok', status: 'passed' },
            {
              name: 'test_answer_value',
              status: 'failed',
              message: 'The test failed in the call phase',
              trace: 'value = 25\nE AssertionError: Expected 23, got 25\nE assert 2 == 0',
            },
          ],
        },
      }))
      return { stdout: 'apt install output'.repeat(1000), stderr: '', durationMs: 1 }
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
        requiredEvidenceCandidates: ['/logs/verifier/ctrf.json'],
        maximumAttempts: 1,
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
    name: 'verifier-feedback-test',
  })

  assert.equal(result.reward, 0)
  assert.ok(result.evidence.indexOf('[structured verifier evidence') < result.evidence.indexOf('apt install output'))
  assert.match(result.evidence, /FAILED test_answer_value :: E AssertionError: Expected 23, got 25/u)
})

test('Verifier CTRF 结构损坏时按基础设施错误处理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skillsbench-verifier-invalid-ctrf-'))
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  await mkdir(workspace)
  let attempts = 0
  const docker = {
    async run() {
      attempts += 1
      await mkdir(join(logs, 'verifier'), { recursive: true })
      await writeFile(join(logs, 'verifier', 'reward.txt'), '0\n')
      await writeFile(join(logs, 'verifier', 'ctrf.json'), '{"results":{}}\n')
      return { stdout: '', stderr: '', durationMs: 1 }
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
        requiredEvidenceCandidates: ['/logs/verifier/ctrf.json'],
        maximumAttempts: 2,
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
    name: 'verifier-invalid-ctrf-test',
  })

  assert.equal(attempts, 2)
  assert.equal(result.reward, null)
  assert.equal(result.error, 'Verifier 缺少必需评分证据')
  assert.match(result.evidence, /CTRF 结构无效/u)
})

test('Verifier 多次缺少结构化评分证据时返回基础设施错误而不是 0 分', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skillsbench-verifier-evidence-'))
  const workspace = join(root, 'workspace')
  const logs = join(root, 'logs')
  await mkdir(workspace)
  let attempts = 0
  const docker = {
    async run() {
      attempts += 1
      await mkdir(join(logs, 'verifier'), { recursive: true })
      await writeFile(join(logs, 'verifier', 'reward.txt'), '0\n')
      return { stdout: '', stderr: 'dependency download failed', durationMs: 1 }
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
        requiredEvidenceCandidates: ['/logs/verifier/ctrf.json'],
        maximumAttempts: 2,
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
    name: 'verifier-evidence-test',
  })

  assert.equal(attempts, 2)
  assert.equal(result.reward, null)
  assert.equal(result.error, 'Verifier 缺少必需评分证据')
  assert.match(result.evidence, /attempt 2\/2/u)
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
