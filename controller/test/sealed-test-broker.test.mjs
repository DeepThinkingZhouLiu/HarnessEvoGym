import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SealedTestBrokerError,
  assertInternalSealedReceipt,
  assertOpaqueSealedReceipt,
  createSealedTestBroker,
  runSealedTest,
  runSealedTestInChild,
} from '../src/sealed-test-broker.mjs'

const CANDIDATE_ID = 'candidate-001'
const RECEIPT_ID = 'receipt-001'
const COMPLETED_AT = '2026-08-24T03:00:00.000Z'

function fixtureIds() {
  return Array.from({ length: 172 }, (_, index) => {
    const year = 1962 + Math.floor(index / 12)
    const withinYear = index % 12
    const session = withinYear < 6 ? 'a' : 'b'
    return `putnam_${year}_${session}${withinYear % 6 + 1}`
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sealed-test-broker-'))
  const ids = fixtureIds()
  const manifestPath = join(root, 'trusted-test.manifest')
  const sealedOutputPath = join(root, 'sealed', CANDIDATE_ID)
  const manifest = `${ids.join('\n')}\n`
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex')
  await writeFile(manifestPath, manifest, { mode: 0o400 })
  return { root, ids, manifestPath, manifestSha256, sealedOutputPath }
}

function recordsFor(ids, verified = 171, traceRef = 'sealed://trace/opaque') {
  return ids.map((instanceId, index) => ({
    instanceId,
    status: index < verified ? 'resolved' : 'unresolved',
    traceRef,
    privateScore: index < verified ? 1 : 0,
  }))
}

test('injectable broker returns only opaque receipt while all ids/scores/traces stay sealed', async () => {
  const testFixture = await fixture()
  const hiddenTrace = 'TRACE-ONLY-IN-SEALED'
  let received
  const broker = createSealedTestBroker({
    now: () => COMPLETED_AT,
    makeReceiptId: () => RECEIPT_ID,
    runPartition: async (options) => {
      received = options
      options.onProgress({
        problemId: options.instanceIds[0],
        score: 171,
        trace: hiddenTrace,
      })
      const traceRef = await options.onTrace({
        problemId: options.instanceIds[0],
        taskId: 'raw-task-id',
        text: `${options.instanceIds[0]} score=1 ${hiddenTrace}`,
      })
      return {
        summary: {
          candidateId: options.candidateId,
          verified: 171,
          total: 172,
          usage: {
            requests: 16,
            upstreamAttempts: 18,
            transientRetries: 2,
            inputTokens: 10000,
            outputTokens: 2345,
            totalTokens: 12345,
          },
        },
        records: recordsFor(options.instanceIds, 171, traceRef),
        traces: { [options.instanceIds[1]]: `${hiddenTrace}-returned` },
      }
    },
  })

  const receipt = await broker.run({
    candidateId: CANDIDATE_ID,
    testManifestPath: testFixture.manifestPath,
    testManifestSha256: testFixture.manifestSha256,
    sealedOutputPath: testFixture.sealedOutputPath,
    partitionOptions: { concurrency: 2 },
  })

  assert.deepEqual(receipt, {
    receiptId: RECEIPT_ID,
    candidateId: CANDIDATE_ID,
    status: 'sealed',
    completedAt: COMPLETED_AT,
  })
  assert.deepEqual(Object.keys(receipt).sort(), ['candidateId', 'completedAt', 'receiptId', 'status'])
  assert.equal(received.sealed, true)
  assert.equal(received.manifestPath, testFixture.manifestPath)
  assert.match(received.sealedOutputPath, /\.candidate-001\.partial-/u)
  assert.deepEqual(received.instanceIds, testFixture.ids)
  assert.equal(Object.hasOwn(receipt, 'verified'), false)
  assert.equal(JSON.stringify(receipt).includes(testFixture.ids[0]), false)
  assert.equal(JSON.stringify(receipt).includes(hiddenTrace), false)

  const summary = JSON.parse(await readFile(join(testFixture.sealedOutputPath, 'summary.json'), 'utf8'))
  const recordText = await readFile(join(testFixture.sealedOutputPath, 'records.jsonl'), 'utf8')
  const traceFiles = await readdir(join(testFixture.sealedOutputPath, 'traces'))
  const traceTexts = await Promise.all(traceFiles.map((name) => (
    readFile(join(testFixture.sealedOutputPath, 'traces', name), 'utf8')
  )))
  assert.equal(summary.verified, 171)
  assert.match(recordText, new RegExp(testFixture.ids[0], 'u'))
  assert.match(traceTexts.join('\n'), new RegExp(hiddenTrace, 'u'))
  assert.equal(traceFiles.some((name) => name.includes('putnam_')), false)
  const internal = assertInternalSealedReceipt(JSON.parse(await readFile(
    join(testFixture.sealedOutputPath, 'receipt.internal.json'),
    'utf8',
  )), CANDIDATE_ID)
  assert.equal(internal.manifestSha256, testFixture.manifestSha256)
  assert.equal(internal.recordCount, 172)
  assert.deepEqual(
    JSON.parse(await readFile(join(testFixture.sealedOutputPath, 'receipt.opaque.json'), 'utf8')),
    receipt,
  )
})

test('runner exception and malformed results become generic errors without hidden details', async (t) => {
  const hidden = 'putnam_1962_a1 score=171 TRACE-SECRET'

  await t.test('exception', async () => {
    const testFixture = await fixture()
    await assert.rejects(
      () => runSealedTest({
        candidateId: CANDIDATE_ID,
        testManifestPath: testFixture.manifestPath,
        testManifestSha256: testFixture.manifestSha256,
        sealedOutputPath: testFixture.sealedOutputPath,
        runPartition: async () => { throw new Error(hidden) },
      }),
      (error) => {
        assert.ok(error instanceof SealedTestBrokerError)
        assert.equal(error.code, 'SEALED_RUN_FAILED')
        assert.equal(`${error.name} ${error.message} ${error.code}`.includes(hidden), false)
        assert.equal(Object.hasOwn(error, 'cause'), false)
        return true
      },
    )
    await assert.rejects(() => readFile(testFixture.sealedOutputPath, 'utf8'))
    assert.equal((await readdir(join(testFixture.root, 'sealed'))).length, 0)
  })

  await t.test('score mismatch', async () => {
    const testFixture = await fixture()
    await assert.rejects(
      () => runSealedTest({
        candidateId: CANDIDATE_ID,
        testManifestPath: testFixture.manifestPath,
        testManifestSha256: testFixture.manifestSha256,
        sealedOutputPath: testFixture.sealedOutputPath,
        runPartition: async ({ instanceIds }) => ({
          summary: { candidateId: CANDIDATE_ID, verified: 172, total: 172 },
          records: recordsFor(instanceIds, 171),
        }),
      }),
      (error) => error instanceof SealedTestBrokerError
        && error.code === 'SEALED_OUTPUT_INVALID'
        && !error.message.includes(hidden),
    )
  })
})

test('opaque receipt enforces an exact whitelist without reflecting malicious fields', () => {
  const good = {
    receiptId: RECEIPT_ID,
    candidateId: CANDIDATE_ID,
    status: 'sealed',
    completedAt: COMPLETED_AT,
  }
  assert.deepEqual(assertOpaqueSealedReceipt(good, CANDIDATE_ID), good)
  assert.throws(
    () => assertOpaqueSealedReceipt({
      ...good,
      'putnam_1962_a1 score=171 TRACE-SECRET': 'leak',
    }, CANDIDATE_ID),
    (error) => error instanceof SealedTestBrokerError
      && error.code === 'SEALED_RECEIPT_INVALID'
      && !error.message.includes('putnam_1962_a1'),
  )
})

test('broker rejects a manifest that does not match the frozen digest before invoking the runner', async () => {
  const testFixture = await fixture()
  let invoked = false
  await assert.rejects(
    () => runSealedTest({
      candidateId: CANDIDATE_ID,
      testManifestPath: testFixture.manifestPath,
      testManifestSha256: 'f'.repeat(64),
      sealedOutputPath: testFixture.sealedOutputPath,
      runPartition: async () => {
        invoked = true
        throw new Error('must not run')
      },
    }),
    (error) => error instanceof SealedTestBrokerError
      && error.code === 'SEALED_MANIFEST_INVALID'
      && !error.message.includes(testFixture.ids[0]),
  )
  assert.equal(invoked, false)
})

test('broker never removes a pre-existing staging directory it did not create', async () => {
  const testFixture = await fixture()
  const sealedParent = join(testFixture.root, 'sealed')
  const staging = join(sealedParent, '.candidate-001.partial-preexisting')
  const sentinel = join(staging, 'must-survive.txt')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  await writeFile(sentinel, 'owned by another run')

  await assert.rejects(
    () => runSealedTest({
      candidateId: CANDIDATE_ID,
      testManifestPath: testFixture.manifestPath,
      testManifestSha256: testFixture.manifestSha256,
      sealedOutputPath: testFixture.sealedOutputPath,
      stagingOutputPath: staging,
      runPartition: async () => { throw new Error('must not run') },
    }),
    (error) => error instanceof SealedTestBrokerError && error.code === 'SEALED_STORAGE_FAILED',
  )
  assert.equal(await readFile(sentinel, 'utf8'), 'owned by another run')
})

async function writeRunnerModule(root) {
  const path = join(root, 'fixture-sealed-runner.mjs')
  await writeFile(path, `
export async function runPartition(options) {
  const hidden = options.instanceIds[0] + ' score=171 TRACE-CHILD-SECRET'
  let key = null
  process.stdout.write(hidden + '\\n')
  process.stderr.write(hidden + '\\n')
  if (process.send !== undefined) throw new Error('IPC channel must not exist: ' + hidden)
  if (options.fixtureUsesProvider) {
    key = await options.getApiKey()
    process.stdout.write('credential=' + key + '\\n')
    if (!key.startsWith('child-provider-key-')) throw new Error('bad credential ' + key)
  }
  if (options.fixtureFailure) throw new Error('worker failure ' + hidden)
  if (options.fixtureHang) await new Promise(() => { setInterval(() => {}, 1000) })
  const traceRef = await options.onTrace({
    problemId: options.instanceIds[0],
    taskId: 'raw-child-task',
    text: hidden,
  })
  const records = options.instanceIds.map((instanceId, index) => ({
    instanceId,
    status: index < 171 ? 'resolved' : 'unresolved',
    traceRef,
    credentialEcho: key,
  }))
  return {
    summary: { candidateId: options.candidateId, verified: 171, total: 172 },
    records,
    traces: { hidden, credentialEcho: key },
  }
}
`, { mode: 0o400 })
  return path
}

test('production child has no IPC/stdout/stderr return path and parent receives only receipt', async () => {
  const testFixture = await fixture()
  const runnerModulePath = await writeRunnerModule(testFixture.root)
  const providerKey = 'child-provider-key-123456789'
  const receipt = await runSealedTestInChild({
    candidateId: CANDIDATE_ID,
    testManifestPath: testFixture.manifestPath,
    testManifestSha256: testFixture.manifestSha256,
    sealedOutputPath: testFixture.sealedOutputPath,
    runnerModulePath,
    partitionOptions: { fixtureUsesProvider: true },
    getApiKey: async () => providerKey,
    timeoutMs: 5_000,
  })

  assert.deepEqual(Object.keys(receipt).sort(), ['candidateId', 'completedAt', 'receiptId', 'status'])
  const visible = JSON.stringify(receipt)
  assert.equal(visible.includes('putnam_'), false)
  assert.equal(visible.includes('171'), false)
  assert.equal(visible.includes('TRACE-CHILD-SECRET'), false)
  assert.equal(visible.includes(providerKey), false)
  const sealedRecords = await readFile(join(testFixture.sealedOutputPath, 'records.jsonl'), 'utf8')
  assert.match(sealedRecords, /putnam_/u)
  const sealedTree = [
    sealedRecords,
    await readFile(join(testFixture.sealedOutputPath, 'summary.json'), 'utf8'),
    ...(await Promise.all((await readdir(join(testFixture.sealedOutputPath, 'traces')))
      .map((name) => readFile(join(testFixture.sealedOutputPath, 'traces', name), 'utf8')))),
  ].join('\n')
  assert.equal(sealedTree.includes(providerKey), false)
  assert.match(sealedTree, /\[REDACTED\]/u)
})

test('production child failures, aborts, and timeouts expose only generic codes', async (t) => {
  await t.test('runner failure', async () => {
    const testFixture = await fixture()
    const runnerModulePath = await writeRunnerModule(testFixture.root)
    await assert.rejects(
      () => runSealedTestInChild({
        candidateId: CANDIDATE_ID,
        testManifestPath: testFixture.manifestPath,
        testManifestSha256: testFixture.manifestSha256,
        sealedOutputPath: testFixture.sealedOutputPath,
        runnerModulePath,
        partitionOptions: { fixtureFailure: true },
        timeoutMs: 5_000,
      }),
      (error) => error instanceof SealedTestBrokerError
        && error.code === 'SEALED_WORKER_FAILED'
        && !`${error.message} ${error.code}`.includes('putnam_'),
    )
  })

  await t.test('timeout', async () => {
    const testFixture = await fixture()
    const runnerModulePath = await writeRunnerModule(testFixture.root)
    await assert.rejects(
      () => runSealedTestInChild({
        candidateId: CANDIDATE_ID,
        testManifestPath: testFixture.manifestPath,
        testManifestSha256: testFixture.manifestSha256,
        sealedOutputPath: testFixture.sealedOutputPath,
        runnerModulePath,
        partitionOptions: { fixtureHang: true },
        timeoutMs: 100,
        killGraceMs: 50,
      }),
      (error) => error instanceof SealedTestBrokerError && error.code === 'SEALED_TEST_TIMEOUT',
    )
  })

  await t.test('abort', async () => {
    const testFixture = await fixture()
    const runnerModulePath = await writeRunnerModule(testFixture.root)
    const controller = new AbortController()
    const pending = runSealedTestInChild({
      candidateId: CANDIDATE_ID,
      testManifestPath: testFixture.manifestPath,
      testManifestSha256: testFixture.manifestSha256,
      sealedOutputPath: testFixture.sealedOutputPath,
      runnerModulePath,
      partitionOptions: { fixtureHang: true },
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 50,
    })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(
      pending,
      (error) => error instanceof SealedTestBrokerError && error.code === 'SEALED_TEST_ABORTED',
    )
  })
})

test('production options reject credential-shaped fields; secrets must use fd 4', async () => {
  const testFixture = await fixture()
  const runnerModulePath = await writeRunnerModule(testFixture.root)
  await assert.rejects(
    () => runSealedTestInChild({
      candidateId: CANDIDATE_ID,
      testManifestPath: testFixture.manifestPath,
      testManifestSha256: testFixture.manifestSha256,
      sealedOutputPath: testFixture.sealedOutputPath,
      runnerModulePath,
      partitionOptions: { apiKey: 'must-not-be-serialized' },
    }),
    (error) => error instanceof SealedTestBrokerError && error.code === 'SEALED_INPUT_INVALID',
  )
})
