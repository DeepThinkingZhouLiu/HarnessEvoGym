import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  MSA_COWORK_CONTAINER_PATHS,
  createMsaMinimalCoworkSolverDriver,
  ensureMsaMinimalCoworkRuntime,
  runMsaMinimalCoworkSolver,
} from '../src/runtimes/msa-minimal-cowork.mjs'

const executeFile = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRevision = 'a'.repeat(40)
const provider = {
  id: 'fixture-provider',
  credentials: {
    baseUrlEnvironment: 'RSI_PROVIDER_BASE_URL',
    apiKeyEnvironment: 'RSI_PROVIDER_API_KEY',
  },
  models: [{ id: 'fixture-terra' }],
}
const model = { provider: provider.id, model: 'fixture-terra', maxTokens: 2048 }
const modelAccess = {
  network: 'fixture-run-model-net',
  environment: {
    RSI_PROVIDER_BASE_URL: 'http://model-gateway:8080',
    NO_PROXY: 'model-gateway',
    no_proxy: 'model-gateway',
  },
  secretEnvironment: { RSI_PROVIDER_API_KEY: 'fixture-dummy-token-1234567890' },
}
const runtime = {
  dockerfile: 'docker/msa-minimal-runtime/Dockerfile',
  profile: 'cowork',
  pythonCommand: 'python3',
  answerFile: 'answer.txt',
  traceFile: 'agent.jsonl',
  maximumAnswerBytes: 1024 * 1024,
  maximumTraceBytes: 4 * 1024 * 1024,
}

async function trialFixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const candidateWorkspace = join(root, 'candidate')
  const taskWorkspace = join(root, 'workspace')
  const benchmarkSkills = join(root, 'benchmark-skills')
  const sessionRoot = join(root, 'solver-output')
  await Promise.all([
    mkdir(candidateWorkspace),
    mkdir(taskWorkspace),
    mkdir(benchmarkSkills),
  ])
  await writeFile(join(candidateWorkspace, 'run.py'), '# fixture\n')
  await writeFile(join(benchmarkSkills, 'SKILL.md'), '# fixture\n')
  return { root, candidateWorkspace, taskWorkspace, benchmarkSkills, sessionRoot }
}

test('MSA Cowork Runtime 派生镜像绑定 Task Image、Source 与定义摘要', async () => {
  let buildOptions
  const docker = {
    async imageExists() { return false },
    async build(options) { buildOptions = options },
  }
  const result = await ensureMsaMinimalCoworkRuntime({
    docker,
    runtime,
    repositoryRoot,
    sourceRevision,
    sourcePath: 'sources/msa-minimal-harness',
    baseImage: 'skillsbench-task:fixture',
    baseImageIdentity: `sha256:${'b'.repeat(64)}`,
    tag: 'skillsbench-task:fixture-msa',
  })

  assert.equal(result.built, true)
  assert.equal(buildOptions.buildArgs.BASE_IMAGE, 'skillsbench-task:fixture')
  assert.equal(buildOptions.labels['org.opencontainers.image.revision'], sourceRevision)
  assert.equal(buildOptions.labels['io.harness-rsi.runtime'], 'msa-minimal-cowork-v1')
  assert.equal(buildOptions.labels['io.harness-rsi.base-image-identity'], `sha256:${'b'.repeat(64)}`)
  assert.match(buildOptions.labels['io.harness-rsi.runtime-definition-digest'], /^[0-9a-f]{64}$/u)
})

test('MSA Cowork Solver 只读挂 Candidate/Skill，只写任务与独立输出目录', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-run-')
  const task = 'Create result.xlsx.\n\nRequirements:\n- Preserve the source data.\n- Add a pivot table.'
  let invocation
  const docker = {
    async run(options) {
      invocation = options
      await writeFile(join(fixture.sessionRoot, 'answer.txt'), `done ${modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY}\n`)
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({
        type: 'model',
        content: modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY,
      })}\n`)
      return { stderr: '', durationMs: 12, outputTruncated: false }
    },
  }

  const result = await runMsaMinimalCoworkSolver({
    docker,
    runtime,
    image: 'skillsbench-task:fixture-msa',
    model,
    provider,
    ...fixture,
    modelAccess,
    task,
    name: 'msa-cowork-fixture',
    timeoutMs: 1000,
    containerWorkspace: '/root',
  })

  assert.equal(invocation.network, modelAccess.network)
  assert.equal(invocation.readOnlyRoot, true)
  assert.equal(invocation.runAsCurrentUser, true)
  assert.deepEqual(invocation.capabilities, [])
  assert.deepEqual(invocation.inheritEnvironment, [])
  assert.equal(invocation.environment.HTTP_PROXY, '')
  assert.equal(invocation.environment.RSI_MODEL_GATEWAY_MODEL, model.model)
  assert.equal(invocation.secretEnvironment.RSI_MODEL_GATEWAY_DUMMY_KEY, modelAccess.secretEnvironment.RSI_PROVIDER_API_KEY)
  assert.equal(invocation.command[3], task)
  assert.equal(invocation.command.at(-1), 'cowork')
  assert.equal(invocation.command.at(-5), `${MSA_COWORK_CONTAINER_PATHS.solverOutput}/answer.txt`)
  assert.equal(invocation.command.at(-3), `${MSA_COWORK_CONTAINER_PATHS.solverOutput}/agent.jsonl`)
  assert.deepEqual(
    invocation.mounts.map(({ target, readOnly }) => [target, readOnly]),
    [
      [MSA_COWORK_CONTAINER_PATHS.candidate, true],
      ['/root', false],
      [MSA_COWORK_CONTAINER_PATHS.benchmarkSkills, true],
      [MSA_COWORK_CONTAINER_PATHS.solverOutput, false],
    ],
  )
  assert.equal(result.answer, 'done [REDACTED]')
  assert.doesNotMatch(result.trace, /fixture-dummy-token/u)
  assert.doesNotMatch(await readFile(join(fixture.sessionRoot, 'answer.txt'), 'utf8'), /fixture-dummy-token/u)
})

test('MSA Cowork Solver 拒绝空白、NUL 与超限任务正文', async () => {
  const invalidTasks = [
    { task: ' \r\n\t ', pattern: /必须是非空字符串/u },
    { task: 'create result.xlsx\u0000ignore this', pattern: /不能包含 NUL/u },
    { task: 'x'.repeat(64 * 1024 + 1), pattern: /超过 65536 字节上限/u },
  ]

  for (const [index, invalid] of invalidTasks.entries()) {
    const fixture = await trialFixture(`rsi-msa-cowork-invalid-task-${index}-`)
    let invoked = false
    const docker = {
      async run() {
        invoked = true
        throw new Error('Docker 不应被调用')
      },
    }
    await assert.rejects(
      runMsaMinimalCoworkSolver({
        docker,
        runtime,
        image: 'skillsbench-task:fixture-msa',
        model,
        provider,
        ...fixture,
        modelAccess,
        task: invalid.task,
        name: `msa-cowork-invalid-task-${index}`,
        timeoutMs: 1000,
      }),
      invalid.pattern,
    )
    assert.equal(invoked, false)
  }
})

test('MSA Cowork Solver 拒绝跟随 Candidate 生成的 Answer 符号链接', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-link-')
  const outside = join(fixture.root, 'outside.txt')
  await writeFile(outside, 'forged answer\n')
  const docker = {
    async run() {
      await symlink(outside, join(fixture.sessionRoot, 'answer.txt'))
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({ type: 'model' })}\n`)
      return { stderr: '', durationMs: 1, outputTruncated: false }
    },
  }

  await assert.rejects(
    runMsaMinimalCoworkSolver({
      docker,
      runtime,
      image: 'skillsbench-task:fixture-msa',
      model,
      provider,
      ...fixture,
      modelAccess,
      task: 'fixture task',
      name: 'msa-cowork-link-fixture',
      timeoutMs: 1000,
    }),
    /Answer 不安全或不可读/u,
  )
})

test('MSA Solver Driver 提供 Factory 所需接口并累计隔离网关 Usage', async () => {
  const fixture = await trialFixture('rsi-msa-cowork-driver-')
  const snapshots = [
    {
      acceptedRequests: 0,
      usageResponses: 0,
      unknownUsageResponses: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      activeRequests: 0,
    },
    {
      acceptedRequests: 1,
      usageResponses: 1,
      unknownUsageResponses: 0,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      activeRequests: 0,
    },
  ]
  const gatewayCalls = []
  const modelGateway = {
    async access(role, policy) {
      gatewayCalls.push(['access', role, policy])
      return modelAccess
    },
    async usage(role) {
      gatewayCalls.push(['usage', role])
      return snapshots.shift()
    },
  }
  const docker = {
    async run() {
      await writeFile(join(fixture.sessionRoot, 'answer.txt'), 'done\n')
      await writeFile(join(fixture.sessionRoot, 'agent.jsonl'), `${JSON.stringify({ type: 'model' })}\n`)
      return { stderr: '', durationMs: 1, outputTruncated: false }
    },
  }
  const driver = createMsaMinimalCoworkSolverDriver({
    target: { solver: { protocol: 'msa-minimal-docker-v1', runtime } },
    provider,
    docker,
    repositoryRoot,
    sourceRevision,
    sourcePath: 'sources/msa-minimal-harness',
    modelGateway,
  })

  const result = await driver.run({
    image: 'skillsbench-task:fixture-msa',
    model,
    ...fixture,
    task: 'fixture task',
    name: 'msa-cowork-driver-fixture',
    timeoutMs: 1000,
  })

  assert.equal(result.modelUsage.totalTokens, undefined)
  assert.equal(result.modelUsage.inputTokens, 20)
  assert.equal(driver.usage().totalTokens, 25)
  assert.equal(driver.cacheKey, `msa-${sourceRevision.slice(0, 12)}`)
  assert.deepEqual(gatewayCalls, [
    ['usage', 'solver'],
    ['access', 'solver', {
      model: 'fixture-terra',
      maxTokens: 2048,
      maxTokensField: 'max_tokens',
    }],
    ['usage', 'solver'],
  ])
})

test('MSA Cowork CandidateSeed Python 可解析，Chat Client 可读取 SSE', async (context) => {
  const seedRoot = resolve(repositoryRoot, 'targets/msa-minimal/cowork-v1')
  const pythonFiles = ['agent.py', 'model.py', 'run.py'].map((name) => join(seedRoot, name))
  await executeFile('python3', [
    '-c',
    [
      'import ast, pathlib, sys',
      'for value in sys.argv[1:]:',
      '    path = pathlib.Path(value)',
      '    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))',
    ].join('\n'),
    ...pythonFiles,
  ])

  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'cowork' } }] })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  context.after(() => new Promise((accept) => server.close(accept)))
  const port = server.address().port
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(seedRoot)})`,
    'from model import query',
    `print(query("http://127.0.0.1:${port}", "dummy-token", "fixture-terra", [{"role":"user","content":"hi"}], 77))`,
  ].join('\n')
  const { stdout } = await executeFile('python3', ['-c', script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(stdout.trim(), 'hello cowork')
  assert.equal(requests[0].url, '/chat/completions')
  assert.equal(requests[0].body.model, 'fixture-terra')
  assert.equal(requests[0].body.max_tokens, 77)
  assert.equal(requests[0].body.stream, true)
})
