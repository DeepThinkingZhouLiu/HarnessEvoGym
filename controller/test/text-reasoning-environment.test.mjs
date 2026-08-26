import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  loadExperimentBundle,
  validateEnvironmentAdapter,
  validateTargetAdapter,
} from '../src/adapters.mjs'
import { materializeCandidate } from '../src/candidate-materializers.mjs'
import { validateCandidate } from '../src/candidate-validators.mjs'
import { readConfigFile } from '../src/config.mjs'
import { TextReasoningEnvironment } from '../src/environments/text-reasoning.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const modes = ['single', 'independent', 'mutualism', 'competition', 'combined']
const executeFile = promisify(execFile)

async function bundle(mode = 'single') {
  return await loadExperimentBundle(
    resolve(repositoryRoot, `experiments/reasoning-msa-smoke-${mode}.json`),
    repositoryRoot,
  )
}

function fakeDocker() {
  return {
    async info() { return { stdout: 'fixture' } },
    async imageExists() { return true },
    async imageId() { return `sha256:${'b'.repeat(64)}` },
  }
}

function answerForTask(task) {
  if (task.includes('increased by 25%')) return 'Explanation: the factors cancel.\nAnswer: 120\nConfidence: 100'
  if (task.includes('red, blue, and green')) return '<final>\nExplanation: pigeonhole principle\nAnswer: 4.\nConfidence: 100\n</final>'
  if (task.includes('3(x - 2)')) return '17'
  throw new Error(`unexpected fixture task: ${task}`)
}

test('Synthetic Text Reasoning 五种 Mode 共用同一 Target 与 Environment', async () => {
  for (const mode of modes) {
    const loaded = await bundle(mode)
    assert.equal(loaded.recipe.spec.population.mode, mode)
    assert.equal(loaded.environment.protocol, 'text-reasoning-deterministic-v1')
    assert.equal(loaded.target.id, 'msa-minimal-reasoning')
    assert.equal(loaded.experiment.models.solver.model, 'gpt-5.6-terra')
    assert.equal(loaded.experiment.models.updater.model, 'gpt-5.6-terra')
    assert.match(loaded.benchmark.name, /not HLE/iu)
  }
})

test('Synthetic Text Reasoning 只在 feedback 暴露逐题反馈，selection 仅输出标准聚合记录', async () => {
  const loaded = await bundle()
  const root = await mkdtemp(join(tmpdir(), 'rsi-text-reasoning-'))
  const candidateWorkspace = join(root, 'candidate')
  const runRoot = join(root, 'run')
  await Promise.all([mkdir(candidateWorkspace), mkdir(runRoot)])
  const calls = []
  const solverDriver = {
    cacheKey: 'fixture-solver',
    async ensureRuntime(options) {
      calls.push(['ensureRuntime', options])
      return { image: options.tag, built: true }
    },
    async run(options) {
      calls.push(['run', options.task])
      return {
        answer: answerForTask(options.task),
        durationMs: 7,
        modelUsage: { complete: true, inputTokens: 10, outputTokens: 3 },
      }
    },
  }
  const environment = new TextReasoningEnvironment({
    environment: loaded.environment,
    benchmark: loaded.benchmark,
    solverDriver,
    docker: fakeDocker(),
    runRoot,
    repositoryRoot,
  })
  const status = await environment.preflight()
  assert.equal(status.sourceRevision, loaded.environment.source.digest)
  const drawerInstruction = [
    'A drawer contains red, blue, and green socks, with at least two socks of each color.',
    'In the dark, what is the minimum number of socks you must draw to guarantee that at least',
    'two drawn socks have the same color? Return the final answer as an integer.',
  ].join(' ')
  assert.deepEqual(await environment.taskLayout('synthetic-drawer-guarantee'), {
    instanceId: 'synthetic-drawer-guarantee',
    partition: 'selection',
    instruction: drawerInstruction,
  })

  const feedback = await environment.runCandidatePartition({
    candidateId: 'h0',
    candidateWorkspace,
    model: loaded.experiment.models.solver,
    partition: 'feedback',
    seeds: [1],
    outputPath: join(runRoot, 'feedback.jsonl'),
  })
  const selection = await environment.runCandidatePartition({
    candidateId: 'h0',
    candidateWorkspace,
    model: loaded.experiment.models.solver,
    partition: 'selection',
    seeds: [1],
    outputPath: join(runRoot, 'selection.jsonl'),
  })

  assert.equal(feedback.get('synthetic-percent-reversal').reward, 1)
  assert.match(feedback.get('synthetic-percent-reversal').feedback.verifierFeedback, /匹配/u)
  assert.equal(selection.get('synthetic-drawer-guarantee').reward, 1)
  assert.equal(selection.get('synthetic-drawer-guarantee').feedback, undefined)
  assert.equal(calls.filter(([kind]) => kind === 'ensureRuntime').length, 1)
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 2)
  assert.equal((await readFile(join(runRoot, 'selection.jsonl'), 'utf8')).includes('feedback'), false)
})

test('Synthetic Text Reasoning 的 Solver 基础设施异常向上抛出而不是记成 0 分', async () => {
  const loaded = await bundle()
  const root = await mkdtemp(join(tmpdir(), 'rsi-text-reasoning-infra-'))
  const candidateWorkspace = join(root, 'candidate')
  const runRoot = join(root, 'run')
  await Promise.all([mkdir(candidateWorkspace), mkdir(runRoot)])
  const environment = new TextReasoningEnvironment({
    environment: loaded.environment,
    benchmark: loaded.benchmark,
    solverDriver: {
      cacheKey: 'fixture-solver',
      async ensureRuntime() { return { image: 'fixture', built: false } },
      async run() { throw new Error('fixture gateway unavailable') },
    },
    docker: fakeDocker(),
    runRoot,
    repositoryRoot,
  })
  await environment.preflight()
  await assert.rejects(
    environment.runCandidatePartition({
      candidateId: 'h0',
      candidateWorkspace,
      model: loaded.experiment.models.solver,
      partition: 'selection',
      seeds: [1],
      outputPath: join(runRoot, 'selection.jsonl'),
    }),
    (error) => error instanceof Error
      && /基础设施失败/u.test(error.message)
      && error.details.includes('fixture gateway unavailable'),
  )
})

test('Synthetic Text Reasoning preflight 拒绝摘要不匹配的题库', async () => {
  const loaded = await bundle()
  const root = await mkdtemp(join(tmpdir(), 'rsi-text-reasoning-tamper-'))
  const tasks = await readFile(resolve(repositoryRoot, 'benchmarks/text-reasoning-smoke/tasks.json'), 'utf8')
  await writeFile(join(root, 'tasks.json'), tasks.replace('"answer": "120"', '"answer": "121"'))
  const environment = new TextReasoningEnvironment({
    environment: {
      ...loaded.environment,
      source: { ...loaded.environment.source, tasksPath: 'tasks.json' },
    },
    benchmark: loaded.benchmark,
    solverDriver: {},
    docker: fakeDocker(),
    runRoot: join(root, 'run'),
    repositoryRoot: root,
  })
  await assert.rejects(environment.preflight(), /摘要/u)
})

test('Synthetic Text Reasoning Environment Adapter 拒绝未知字段和浮动 Base Image', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/text-reasoning-smoke.yml'))
  config.spec.unknown = true
  assert.throws(() => validateEnvironmentAdapter(config), /未知字段/u)
  delete config.spec.unknown
  config.spec.runtime.baseImage = 'python:3.12-slim'
  assert.throws(() => validateEnvironmentAdapter(config), /sha256 Digest/u)
})

test('MSA Reasoning CandidateSeed 物化后保留 Math Profile 并通过独立语义验证', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/msa-minimal-reasoning.yml'))
  const target = validateTargetAdapter(config)
  const root = await mkdtemp(join(tmpdir(), 'rsi-msa-reasoning-seed-'))
  const workspace = join(root, 'workspace')
  const composition = await materializeCandidate({
    repositoryRoot,
    target,
    sourceRoot: resolve(repositoryRoot, target.source.path),
    destination: workspace,
  })
  const report = await validateCandidate({ workspace, target })
  assert.equal(composition.protocol, 'source-plus-seed-overlay-v1')
  assert.equal(report.valid, true, JSON.stringify(report.violations))
  assert.match(await readFile(join(workspace, 'profiles/math.md'), 'utf8'), /mathematics and coding agent/u)
  assert.match(await readFile(join(workspace, 'model.py'), 'utf8'), /Chat Completions/u)
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ['msa-required-files', 'msa-python-ast', 'msa-profile-budget'],
  )
})

test('Synthetic Text Reasoning 任务文件摘要与 Adapter 固定值一致', async () => {
  const loaded = await bundle()
  const source = await readFile(resolve(repositoryRoot, loaded.environment.source.tasksPath))
  assert.equal(createHash('sha256').update(source).digest('hex'), loaded.environment.source.digest)
})

test('MSA Reasoning 物化 Candidate 可通过本地假网关完整运行一道题', async (context) => {
  const target = validateTargetAdapter(
    await readConfigFile(resolve(repositoryRoot, 'adapters/targets/msa-minimal-reasoning.yml')),
  )
  const root = await mkdtemp(join(tmpdir(), 'rsi-msa-reasoning-run-'))
  const workspace = join(root, 'candidate')
  await materializeCandidate({
    repositoryRoot,
    target,
    sourceRoot: resolve(repositoryRoot, target.source.path),
    destination: workspace,
  })

  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '<final>\nExplanation: pigeonhole\nAnswer: 4\nConfidence: 100\n</final>' } }] })}`,
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
  const answerPath = join(root, 'answer.txt')
  const tracePath = join(root, 'trace.jsonl')
  await executeFile('python3', [
    join(workspace, 'run.py'),
    '--task',
    'Three colors of socks: how many draws guarantee a repeated color?',
    '--answer',
    answerPath,
    '--trace',
    tracePath,
    '--profile',
    'math',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      RSI_MODEL_GATEWAY_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      RSI_MODEL_GATEWAY_DUMMY_KEY: 'fixture-dummy-token',
      RSI_MODEL_GATEWAY_MODEL: 'gpt-5.6-terra',
      RSI_MODEL_GATEWAY_MAX_TOKENS: '64',
    },
  })

  assert.match(await readFile(answerPath, 'utf8'), /Answer: 4/u)
  assert.match(await readFile(tracePath, 'utf8'), /"type": "model"/u)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'gpt-5.6-terra')
  assert.equal(requests[0].max_tokens, 64)
  assert.equal(requests[0].stream, true)
})
