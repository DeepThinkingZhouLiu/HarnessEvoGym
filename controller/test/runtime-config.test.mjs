import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  combineCampaignFingerprint,
  loadPutnamRuntime,
  validatePutnamRuntime,
} from '../src/runtime-config.mjs'
import { ProtocolError } from '../src/protocol.mjs'

function fixture() {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'PutnamBenchRuntime',
    solver: {
      smokeConcurrency: 4,
      initialConcurrency: 8,
      maximumConcurrency: 16,
      taskTimeoutSeconds: 1800,
      maximumModelRequestsPerTask: 16,
      maximumResponseTokens: 32768,
      gatewayConcurrencyPerTask: 4,
      infrastructureRetries: 2,
      infrastructureRetryBaseDelaySeconds: 3,
    },
    updater: { timeoutSeconds: 1800, maximumModelRequestsPerPhase: 32, gatewayConcurrency: 4 },
    gateway: { upstreamBaseUrl: 'https://api.zcloudapi.com/v1', requestTimeoutSeconds: 600 },
    verifier: { concurrency: 24, threadsPerProcess: 2, timeoutSeconds: 300 },
    testBroker: { timeoutSeconds: 604800 },
    paths: {
      persistentRoot: '/runtime', scratchRoot: '/scratch', datasetRoot: '/runtime/dataset',
      pnpmStore: '/runtime/store', buildHome: '/runtime/build-home',
      runtimePatch: '/runtime/control/patch.yml',
    },
    toolchain: {
      nodeVersion: '24.19.0', nodePath: '/runtime/node',
      pnpmVersion: '11.7.0', pnpmPath: '/runtime/pnpm',
      elanHome: '/runtime/elan', lakePath: '/runtime/elan/bin/lake',
      leanToolchain: 'leanprover/lean4:v4.27.0',
      bwrapPath: '/usr/bin/bwrap', setprivPath: '/usr/bin/setpriv',
    },
    identities: {
      updaterUser: 'dsh-rsi-updater', solverUser: 'dsh-rsi-solver',
      buildUser: 'dsh-rsi-build', verifierUser: 'dsh-rsi-verifier',
    },
    secrets: {
      primaryKeyFdOption: 'zcloud-key-fd', backupPolicy: 'separate-campaign-only',
      allowEnvironmentKeys: false,
    },
  }
}

test('validates and fingerprints the complete frozen production runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-config-'))
  const path = join(root, 'runtime.json')
  const value = fixture()
  await writeFile(path, JSON.stringify(value))
  const loaded = await loadPutnamRuntime(path)
  assert.deepEqual(loaded.config, value)
  assert.match(loaded.fingerprint, /^[a-f0-9]{64}$/u)
  assert.equal(
    combineCampaignFingerprint('a'.repeat(64), loaded.fingerprint, 'b'.repeat(64)),
    combineCampaignFingerprint('a'.repeat(64), loaded.fingerprint, 'b'.repeat(64)),
  )
  assert.throws(() => combineCampaignFingerprint('a'.repeat(64), loaded.fingerprint), /implementation/u)
})

test('repository HLE runtime freezes one-hour partitions and the low-effort judge', async () => {
  const path = fileURLToPath(new URL('../../environments/hle-text-math/runtime.json', import.meta.url))
  const loaded = await loadPutnamRuntime(path)
  assert.equal(loaded.config.kind, 'HleTextMathRuntime')
  assert.equal(loaded.config.solver.initialConcurrency, 15)
  assert.equal(loaded.config.solver.partitionTimeoutSeconds, 3600)
  assert.equal(loaded.config.solver.maximumModelRequestsPerTask, 12)
  assert.equal(loaded.config.solver.infrastructureRetries, 2)
  assert.equal(loaded.config.solver.infrastructureRetryBaseDelaySeconds, 3)
  assert.equal(loaded.config.solver.maximumResponseTokens, 32768)
  assert.equal(loaded.config.gateway.requestTimeoutSeconds, 900)
  assert.equal(loaded.config.gateway.upstreamBaseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(loaded.config.verifier.judgeModel, 'qwen3.8-max')
  assert.equal(loaded.config.verifier.judgeReasoningEffort, 'low')
  assert.equal(loaded.config.secrets.primaryKeyFdOption, 'provider-key-fd')
  assert.equal(loaded.config.secrets.allowEnvironmentKeys, false)
  const patchPath = fileURLToPath(new URL(
    '../../environments/hle-text-math/dashscope-qwen38-max-headless.patch.yml',
    import.meta.url,
  ))
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /- id: session-title-llm\s+disabled: true/u)
})

test('MSA runtime leaves Solver-owned model budgets unfrozen', async () => {
  const path = fileURLToPath(new URL('../../environments/hle-text-math/msa-runtime.json', import.meta.url))
  const loaded = await loadPutnamRuntime(path)
  assert.equal(loaded.config.solver.taskTimeoutSeconds, 600)
  assert.equal(loaded.config.solver.maximumModelRequestsPerTask, undefined)
  assert.equal(loaded.config.solver.maximumResponseTokens, undefined)
  assert.equal(loaded.config.solver.gatewayConcurrencyPerTask, undefined)
  assert.equal(loaded.config.updater.timeoutSeconds, undefined)
  assert.equal(loaded.config.updater.maximumModelRequestsPerPhase, undefined)
  assert.equal(loaded.config.mutation.mode, 'updater-soft')
  assert.deepEqual(loaded.config.mutation.layers.map((layer) => layer.id), ['l1', 'l2', 'l3'])
  assert.deepEqual(loaded.config.mutation.layers[0].writablePaths, ['profiles/**'])
  assert.deepEqual(
    loaded.config.mutation.layers[2].writablePaths,
    ['profiles/**', 'agent.py', 'tools.py', 'model.py', 'run.py'],
  )
})

test('Codex/Terra runtime externalizes updater backend and model configuration', async () => {
  const path = fileURLToPath(new URL(
    '../../environments/hle-text-math/msa-codex-terra-runtime.json',
    import.meta.url,
  ))
  const loaded = await loadPutnamRuntime(path)
  assert.equal(loaded.config.updater.backend, 'codex-cli')
  assert.equal(loaded.config.updater.provider, 'zcloud')
  assert.equal(loaded.config.updater.model, 'gpt-5.6-terra')
  assert.equal(loaded.config.updater.reasoningEffort, 'max')
  assert.equal(loaded.config.gateway.upstreamBaseUrl, 'https://api.zcloudapi.com/v1')
  assert.equal(loaded.config.verifier.judgeModel, 'gpt-5.6-terra')
  assert.match(loaded.config.toolchain.codexPath, /codex-cli-0\.149\.0/u)
})

test('rejects unknown fields, mutable secrets, unsafe endpoints, and incompatible limits', () => {
  const value = fixture()
  value.secretKey = 'must-not-exist'
  value.secrets.allowEnvironmentKeys = true
  value.gateway.upstreamBaseUrl = 'http://user:pass@example.test/v1?x=1'
  value.solver.smokeConcurrency = 12
  value.solver.initialConcurrency = 8
  value.identities.verifierUser = value.identities.solverUser
  assert.throws(() => validatePutnamRuntime(value), (error) => {
    assert.ok(error instanceof ProtocolError)
    assert.match(error.details.join('\n'), /未知字段/u)
    assert.match(error.details.join('\n'), /allowEnvironmentKeys/u)
    assert.match(error.details.join('\n'), /HTTPS URL/u)
    assert.match(error.details.join('\n'), /smokeConcurrency 不能/u)
    assert.match(error.details.join('\n'), /不同系统身份/u)
    return true
  })
})

test('rejects overlapping or escaped managed roots and mutable sandbox executables', () => {
  const value = fixture()
  value.paths.scratchRoot = '/runtime/scratch'
  value.paths.datasetRoot = '/outside/dataset'
  value.paths.pnpmStore = '/runtime/build-home/nested-store'
  value.toolchain.bwrapPath = '/tmp/bwrap'
  assert.throws(() => validatePutnamRuntime(value), (error) => {
    assert.ok(error instanceof ProtocolError)
    const details = error.details.join('\n')
    assert.match(details, /persistentRoot.*scratchRoot/u)
    assert.match(details, /datasetRoot.*persistentRoot/u)
    assert.match(details, /pnpmStore.*buildHome/u)
    assert.match(details, /bwrapPath/u)
    return true
  })
})
