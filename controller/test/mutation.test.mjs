import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEEPSEEK_HARNESS_MUTATION_POLICY,
  MSA_MINIMAL_MUTATION_CONFIGURATION,
  MSA_MINIMAL_MUTATION_POLICY,
  isPathAllowed,
  mutationPolicyFromConfiguration,
} from '../src/mutation.mjs'
import { ProtocolError } from '../src/protocol.mjs'

test('mutation levels are cumulative and forbidden paths always win', () => {
  const preset = 'apps/cli/config/agent-presets/minimal/agent.cordis.yml'
  const workflow = 'packages/workflow/src/index.ts'
  const core = 'packages/core/src/index.ts'
  assert.equal(isPathAllowed(preset, 'l1'), true)
  assert.equal(isPathAllowed(workflow, 'l1'), false)
  assert.equal(isPathAllowed(preset, 'l2'), true)
  assert.equal(isPathAllowed(workflow, 'l2'), true)
  assert.equal(isPathAllowed(core, 'l2'), false)
  assert.equal(isPathAllowed(core, 'l3'), true)
  assert.equal(isPathAllowed('packages/credentials/key.ts', 'l3'), false)
  assert.equal(isPathAllowed('.github/workflows/ci.yml', 'l3'), false)
})

test('mutation path validation rejects absolute and traversing paths', () => {
  for (const path of ['/tmp/x', '../x', 'apps//x', 'apps/./x', 'apps\\x']) {
    assert.throws(() => isPathAllowed(path, 'l3'), ProtocolError)
  }
  assert.throws(() => isPathAllowed('apps/cli/src/bin.ts', 'l4'), ProtocolError)
})

test('policy sent to updater matches the hard-coded controller boundary', () => {
  assert.deepEqual(Object.keys(DEEPSEEK_HARNESS_MUTATION_POLICY.levels), ['l1', 'l2', 'l3'])
  assert.ok(DEEPSEEK_HARNESS_MUTATION_POLICY.alwaysReadOnly.includes('.git/**'))
})

test('MSA minimal levels expose prompt, loop, then transport', () => {
  assert.equal(isPathAllowed('profiles/math.md', 'l1', MSA_MINIMAL_MUTATION_POLICY), true)
  assert.equal(isPathAllowed('agent.py', 'l1', MSA_MINIMAL_MUTATION_POLICY), false)
  assert.equal(isPathAllowed('agent.py', 'l2', MSA_MINIMAL_MUTATION_POLICY), true)
  assert.equal(isPathAllowed('model.py', 'l2', MSA_MINIMAL_MUTATION_POLICY), false)
  assert.equal(isPathAllowed('model.py', 'l3', MSA_MINIMAL_MUTATION_POLICY), true)
  assert.equal(isPathAllowed('README.md', 'l3', MSA_MINIMAL_MUTATION_POLICY), false)
})

test('soft layer catalogue is configurable, ordered, and cumulative', () => {
  const configured = mutationPolicyFromConfiguration(MSA_MINIMAL_MUTATION_CONFIGURATION)
  assert.deepEqual(configured.layers.map((layer) => layer.id), ['l1', 'l2', 'l3'])
  assert.deepEqual(configured.levels.l2, ['profiles/**', 'agent.py', 'tools.py'])

  const nonCumulative = structuredClone(MSA_MINIMAL_MUTATION_CONFIGURATION)
  nonCumulative.layers[1].writablePaths = ['agent.py']
  assert.throws(() => mutationPolicyFromConfiguration(nonCumulative), /上一层/u)

  const wrongOrder = structuredClone(MSA_MINIMAL_MUTATION_CONFIGURATION)
  wrongOrder.layers.reverse()
  assert.throws(() => mutationPolicyFromConfiguration(wrongOrder), /l1、l2、l3/u)
})
