import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import { readConfigFile } from '../src/config.mjs'
import {
  concurrentMap,
  OmegaUseOfficeValEnvironment,
  normalizeOmegaUseVerifierReward,
  validateOmegaUseSourceManifest,
} from '../src/environments/omegause-officeval.mjs'
import { ProtocolError, validateBenchmark } from '../src/protocol.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

test('OmegaUse 受控并发不超过上限且保持 Benchmark 顺序', async () => {
  let active = 0
  let maximumActive = 0
  const result = await concurrentMap([30, 5, 20, 1], 2, async (value) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, value))
    active -= 1
    return value
  })
  assert.equal(maximumActive, 2)
  assert.deepEqual(result, [30, 5, 20, 1])
  await assert.rejects(
    concurrentMap([1], 201, async (value) => value),
    /并发执行参数无效/u,
  )
})

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function verifierResult(overrides = {}) {
  return {
    id: '060',
    file_name: 'deliverable.pptx',
    status: 'ok',
    error: null,
    dim1_pass: true,
    dim1_reason: '',
    dim2_items: [],
    total_score: 5,
    max_score: 10,
    ...overrides,
  }
}

test('OmegaUse 正式划分覆盖 91 道 Linux Task，训练/验证/测试互不重叠', async () => {
  const source = await readFile(
    resolve(repositoryRoot, 'benchmarks/omegause-officeval/source-manifest.json'),
  )
  assert.equal(digest(source), '8bf749b53988822a90520eba4761c6c311e17dd0e13bd78658b261a921128291')
  const manifest = validateOmegaUseSourceManifest(JSON.parse(source))
  assert.equal(manifest.instances.size, 100)
  assert.equal([...manifest.instances.values()].filter((entry) => !entry.comRequired).length, 91)
  assert.equal(manifest.excluded.size, 9)

  const formal = validateBenchmark(await readConfigFile(
    resolve(repositoryRoot, 'benchmarks/cowork-omegause-officeval-linux-v1/benchmark.json'),
  ))
  assert.equal(formal.partitions.feedback.instanceIds.length, 55)
  assert.equal(formal.partitions.selection.instanceIds.length, 18)
  assert.equal(formal.partitions.final.instanceIds.length, 18)
  assert.equal(formal.allInstanceIds.size, 91)
  assert.ok([...formal.allInstanceIds].every((id) => !manifest.instances.get(id).comRequired))

  const smoke = validateBenchmark(await readConfigFile(
    resolve(repositoryRoot, 'benchmarks/cowork-omegause-officeval-smoke/benchmark.json'),
  ))
  assert.deepEqual(
    [...smoke.allInstanceIds].sort(),
    ['officeval_003', 'officeval_060', 'officeval_090'],
  )
  assert.ok([...smoke.allInstanceIds].every((id) => formal.partitions.feedback.instanceIds.includes(id)))
})

test('OmegaUse 连续分数按 Dim1 门槛归一化到 [0,1]', () => {
  assert.equal(normalizeOmegaUseVerifierReward(verifierResult()), 0.5)
  assert.equal(normalizeOmegaUseVerifierReward(verifierResult({ total_score: -5 })), 0)
  assert.equal(normalizeOmegaUseVerifierReward(verifierResult({ total_score: 15 })), 1)
  assert.equal(normalizeOmegaUseVerifierReward(verifierResult({ dim1_pass: false })), 0)
  assert.equal(normalizeOmegaUseVerifierReward(verifierResult({
    status: 'error',
    error: '目录下未找到 .pptx 文档',
    max_score: 0,
  })), 0)
  assert.throws(
    () => normalizeOmegaUseVerifierReward(verifierResult({ max_score: 0 })),
    /max_score 必须为正数/u,
  )
})

test('OmegaUse 按题提交断点，恢复时保留 0 分结果并只补跑未完成题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-officeval-checkpoint-'))
  const candidateWorkspace = join(root, 'candidate')
  const outputPath = join(root, 'results', 'generation-2', 'h0-feedback.jsonl')
  await mkdir(candidateWorkspace)
  const instanceIds = ['officeval_001', 'officeval_002', 'officeval_003']
  const benchmark = {
    partitions: { feedback: { instanceIds } },
    allInstanceIds: new Set(instanceIds),
    partitionByInstance: new Map(instanceIds.map((id) => [id, 'feedback'])),
  }
  const environment = {
    id: 'omegause-officeval',
    protocol: 'omegause-officeval-docker-v1',
    task: { maximumConcurrentTrials: 2 },
    feedback: { maximumTextBytesPerCase: 32768 },
  }
  const firstCalls = []
  const secondCalls = []

  function runner(calls, failInstance = null) {
    const solverDriver = {
      id: 'msa-minimal-docker-v1',
      cacheKey: 'msa-fixture',
      async beginUsageBatch() { calls.push('batch:start') },
      async endUsageBatch() { calls.push('batch:end') },
    }
    const value = new OmegaUseOfficeValEnvironment({
      environment,
      benchmark,
      solverDriver,
      docker: {},
      runRoot: root,
      repositoryRoot,
    })
    value.manifest = {}
    value.sourceRevision = 'b'.repeat(64)
    value.ensureRuntime = async () => {
      value.runtimeRevision = 'c'.repeat(64)
      return { baseImage: 'fixture', solverImage: 'fixture' }
    }
    value.taskLayout = async (instanceId) => ({
      instanceId,
      task: { instruction: `完成 ${instanceId}` },
      inputs: [],
    })
    value.runTrial = async ({ candidateId, layout, partition, seed, trialIndex, executionId }) => {
      calls.push(layout.instanceId)
      const trialRoot = join(
        root,
        'trials',
        executionId,
        candidateId,
        partition,
        layout.instanceId,
        `trial-${trialIndex + 1}-seed-${seed}`,
      )
      await mkdir(trialRoot, { recursive: true })
      await writeFile(join(trialRoot, 'attempt.txt'), 'attempt\n')
      if (layout.instanceId === failInstance) throw new ProtocolError('fixture infrastructure failure')
      return {
        seed,
        reward: layout.instanceId === 'officeval_001' ? 0 : 0.5,
        latencyMs: 1,
        inputTokens: null,
        outputTokens: null,
        solverAnswer: `answer-${layout.instanceId}`,
        verifierFeedback: `feedback-${layout.instanceId}`,
        policyViolations: [],
        artifacts: [],
        trialRoot,
      }
    }
    return value
  }

  const options = {
    candidateId: 'h0',
    candidateDigest: 'a'.repeat(64),
    candidateWorkspace,
    model: {
      provider: 'fixture-provider',
      model: 'fixture-model',
      maxTokens: 128,
      reasoningEffort: 'high',
    },
    partition: 'feedback',
    seeds: [20260827],
    outputPath,
  }
  await assert.rejects(
    runner(firstCalls, 'officeval_003').runCandidatePartition(options),
    /fixture infrastructure failure/u,
  )
  assert.deepEqual(firstCalls.sort(), [
    'batch:end',
    'batch:start',
    'officeval_001',
    'officeval_002',
    'officeval_003',
  ])

  const resumed = await runner(secondCalls).runCandidatePartition(options)
  assert.deepEqual(secondCalls, ['batch:start', 'officeval_003', 'batch:end'])
  assert.equal(resumed.size, 3)
  assert.equal(resumed.get('officeval_001').reward, 0)
  assert.deepEqual(
    (await readFile(outputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).instance_id),
    instanceIds,
  )
  const executionId = digest(resolve(outputPath)).slice(0, 12)
  for (const instanceId of instanceIds) {
    const checkpoint = join(
      root,
      'trials',
      executionId,
      'h0',
      'feedback',
      instanceId,
      'committed-result.json',
    )
    assert.equal(JSON.parse(await readFile(checkpoint, 'utf8')).kind, 'TaskTrialCheckpoint')
  }
})

test('OmegaUse Verifier 只读取隔离 Submission，并在无网络容器中评分', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-officeval-verifier-'))
  const submission = join(root, 'submission')
  const logs = join(root, 'logs')
  const verifierCode = join(root, 'verifier-code')
  const sourceCode = join(root, 'source-code')
  await Promise.all([mkdir(submission), mkdir(sourceCode)])
  const verifierPath = join(sourceCode, 'officeval_060_verifier.py')
  const sharedPath = join(sourceCode, 'pdf_backend.py')
  await Promise.all([
    writeFile(verifierPath, 'def evaluate(path): return {}\n'),
    writeFile(sharedPath, '# shared\n'),
  ])
  let invocation
  const docker = {
    async run(options) {
      invocation = options
      await writeFile(join(logs, 'result.json'), `${JSON.stringify(verifierResult())}\n`)
      return { stdout: '', stderr: '', durationMs: 1 }
    },
  }
  const runner = new OmegaUseOfficeValEnvironment({
    environment: {
      verifier: {
        timeoutSeconds: 30,
        resources: { cpus: 1, memory: '1g', pids: 64 },
      },
    },
    benchmark: {},
    solverDriver: {},
    docker,
    runRoot: root,
    repositoryRoot,
  })
  runner.baseImage = 'harness-rsi/omegause-officeval:v1'
  const result = await runner.runVerifier({
    layout: {
      instanceId: 'officeval_060',
      verifierPath,
      sharedFiles: [{
        source: sharedPath,
        record: { sha256: digest(await readFile(sharedPath)) },
      }],
      record: { verifier: { sha256: digest(await readFile(verifierPath)) } },
    },
    submission,
    logs,
    verifierCode,
    name: 'officeval-verifier-fixture',
  })

  assert.equal(normalizeOmegaUseVerifierReward(result), 0.5)
  assert.equal(invocation.network, 'none')
  assert.equal(invocation.readOnlyRoot, true)
  assert.equal(invocation.runAsCurrentUser, true)
  assert.deepEqual(invocation.capabilities, [])
  assert.deepEqual(invocation.inheritEnvironment, [])
  assert.deepEqual(
    invocation.mounts.map(({ target, readOnly }) => [target, readOnly]),
    [['/submission', true], ['/verifier', true], ['/logs', false]],
  )
  for (const name of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]) assert.equal(invocation.environment[name], '')
})

test('OmegaUse Verifier Runner 可以加载包含 dataclass 的官方评分器', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-officeval-dataclass-'))
  const submission = join(root, 'submission')
  const output = join(root, 'result.json')
  const verifier = join(root, 'officeval_090_verifier.py')
  await mkdir(submission)
  await writeFile(verifier, `
from dataclasses import dataclass

@dataclass
class Score:
    value: float

def evaluate(path):
    score = Score(1.0)
    return {
        "id": "090", "file_name": "answer.xlsx", "status": "ok", "error": None,
        "dim1_pass": True, "dim1_reason": "", "dim2_items": [],
        "total_score": score.value, "max_score": 1.0,
    }
`, { encoding: 'utf8' })

  await execFileAsync('python3', [
    resolve(repositoryRoot, 'docker/omegause-officeval/run-verifier.py'),
    '--verifier', verifier,
    '--submission', submission,
    '--output', output,
    '--expected-id', 'officeval_090',
  ])

  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.status, 'ok')
  assert.equal(result.total_score, 1)
})
