import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { AgentBayDockerClient } from '../src/agentbay-docker.mjs'

test('AgentBay 每个 Task 独占 Session，Session 串行创建而 Task 并行执行', async () => {
  const imageName = 'RSI_TEST_AGENTBAY_IMAGE_ID'
  const policyName = 'RSI_TEST_AGENTBAY_POLICY_ID'
  const previousImage = process.env[imageName]
  const previousPolicy = process.env[policyName]
  process.env[imageName] = 'fixture-image'
  process.env[policyName] = 'fixture-policy'

  let bridgeSequence = 0
  let activeCreations = 0
  let maximumCreations = 0
  let activeTasks = 0
  let maximumTasks = 0
  let closedTaskBridges = 0
  const scopeKeys = []

  class FakeBridge {
    constructor() {
      this.id = ++bridgeSequence
    }

    async request(operation) {
      if (operation === 'session') {
        activeCreations += 1
        maximumCreations = Math.max(maximumCreations, activeCreations)
        await delay(20)
        activeCreations -= 1
        return { sessionId: `session-${this.id}` }
      }
      if (operation === 'docker') return { exitCode: 0, stdout: '"fixture"', stderr: '' }
      throw new Error(`unexpected operation: ${operation}`)
    }

    async close() {
      closedTaskBridges += 1
    }
  }

  try {
    const docker = new AgentBayDockerClient({
      agentBay: {
        imageIdEnvironment: imageName,
        policyIdEnvironment: policyName,
        pythonExecutable: '/fixture/python',
        bridgePath: 'scripts/agentbay-docker-bridge.py',
        registryMirror: '',
      },
      repositoryRoot: process.cwd(),
      bridgeFactory: () => new FakeBridge(),
    })

    await Promise.all(Array.from({ length: 3 }, () => docker.withTaskSession(async () => {
      scopeKeys.push(docker.scopeKey())
      activeTasks += 1
      maximumTasks = Math.max(maximumTasks, activeTasks)
      await docker.info()
      await delay(80)
      activeTasks -= 1
    })))

    assert.equal(maximumCreations, 1)
    assert.equal(maximumTasks, 3)
    assert.equal(new Set(scopeKeys).size, 3)
    assert.equal(closedTaskBridges, 3)
  } finally {
    if (previousImage === undefined) delete process.env[imageName]
    else process.env[imageName] = previousImage
    if (previousPolicy === undefined) delete process.env[policyName]
    else process.env[policyName] = previousPolicy
  }
})
