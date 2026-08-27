import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readConfigFile } from '../src/config.mjs'
import {
  OmegaUseOfficeValEnvironment,
  normalizeOmegaUseVerifierReward,
  validateOmegaUseSourceManifest,
} from '../src/environments/omegause-officeval.mjs'
import { validateBenchmark } from '../src/protocol.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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
