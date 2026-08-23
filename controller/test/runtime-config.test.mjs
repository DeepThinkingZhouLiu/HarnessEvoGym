import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
