import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEnvironmentRunner,
  createSolverDriver,
  createUpdaterDriver,
  registerEnvironmentDriver,
  registeredDriverProtocols,
  registerSolverDriver,
  registerUpdaterDriver,
} from '../src/factories.mjs'

test('Driver Registry 暴露带版本的内置协议', () => {
  const protocols = registeredDriverProtocols()
  assert.deepEqual(protocols.environment, ['skillsbench-docker-v1'])
  assert.deepEqual(protocols.solver, ['dsh-headless-docker-v1'])
  assert.deepEqual(protocols.updater, ['dsh-headless-docker-v1'])
})

test('受审查的 Contributor Driver 可以注册，编排器只依赖接口', () => {
  registerEnvironmentDriver('fixture-environment-v1', () => ({
    async preflight() {},
    async runCandidatePartition() {},
  }))
  registerSolverDriver('fixture-solver-v1', () => ({
    async ensureRuntime() {},
    async run() {},
    usage() { return {} },
  }))
  registerUpdaterDriver('fixture-updater-v1', () => ({
    async ensureRuntime() {},
    async stageContext() {},
    async run() {},
    usage() { return {} },
  }))

  assert.ok(createEnvironmentRunner({ environment: { protocol: 'fixture-environment-v1' } }))
  assert.ok(createSolverDriver({ target: { solver: { protocol: 'fixture-solver-v1' } } }))
  assert.ok(createUpdaterDriver({ updater: { protocol: 'fixture-updater-v1' } }))
})

test('Driver Registry 拒绝覆盖协议和不完整实现', () => {
  assert.throws(
    () => registerSolverDriver('dsh-headless-docker-v1', () => ({})),
    /重复注册/u,
  )
  registerSolverDriver('fixture-invalid-v1', () => ({ async run() {} }))
  assert.throws(
    () => createSolverDriver({ target: { solver: { protocol: 'fixture-invalid-v1' } } }),
    /缺少 ensureRuntime/u,
  )
})
