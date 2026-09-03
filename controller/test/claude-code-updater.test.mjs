import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MODEL_GATEWAY_RELAY_URL } from '../src/model-gateway-relay.mjs'
import { createClaudeCodeUpdaterDriver } from '../src/runtimes/claude-code-updater.mjs'

function fixtureDistributionDigest(files) {
  const hash = createHash('sha256')
  for (const [pathValue, source] of Object.entries(files).sort(([left], [right]) => (
    left.localeCompare(right, 'en')
  ))) {
    hash.update(pathValue)
    hash.update('\0')
    hash.update(source)
    hash.update('\0')
  }
  return hash.digest('hex')
}

test('Claude Code Updater 固定 distribution，通过 Anthropic Gateway 隔离修改 Candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-code-updater-test-'))
  const previousKey = process.env.RSI_CLAUDE_PROVIDER_API_KEY
  const previousBaseUrl = process.env.RSI_CLAUDE_PROVIDER_BASE_URL
  try {
    const distributionRoot = join(root, 'claude-code')
    const executable = join(distributionRoot, 'bin', 'claude')
    const packageSource = `${JSON.stringify({ name: '@fixture/claude-code', version: '1.2.3' }, null, 2)}\n`
    const executableSource = '#!/bin/sh\nprintf \'1.2.3 (Claude Code)\\n\'\n'
    const files = {
      'bin/claude': executableSource,
      'package.json': packageSource,
    }
    await mkdir(join(distributionRoot, 'bin'), { recursive: true })
    await Promise.all([
      writeFile(executable, executableSource),
      writeFile(join(distributionRoot, 'package.json'), packageSource),
    ])
    await chmod(executable, 0o755)

    const candidateRoot = join(root, 'candidate')
    const candidateWorkspace = join(candidateRoot, 'workspace')
    const contextDirectory = join(candidateRoot, 'updater-input')
    const outputDirectory = join(candidateRoot, 'updater-output')
    const upstreamSource = join(root, 'upstream')
    await Promise.all([
      mkdir(candidateWorkspace, { recursive: true }),
      mkdir(contextDirectory, { recursive: true }),
      mkdir(upstreamSource, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(candidateWorkspace, 'agent.py'), 'BASELINE = True\n'),
      writeFile(join(contextDirectory, 'updater.md'), 'fixture\n'),
      writeFile(join(contextDirectory, 'mutation-policy.json'), '{}\n'),
      writeFile(join(contextDirectory, 'feedback-packet.json'), '{"cases":[]}\n'),
      writeFile(join(upstreamSource, 'agent.py'), 'UPSTREAM = True\n'),
    ])

    process.env.RSI_CLAUDE_PROVIDER_API_KEY = 'sk-fixture-claude-provider-key'
    process.env.RSI_CLAUDE_PROVIDER_BASE_URL = 'https://provider.invalid/v1'
    const rotations = []
    let gatewayOptions
    let invocation
    const driver = createClaudeCodeUpdaterDriver({
      updater: {
        protocol: 'claude-code-exec-v1',
        runtime: {
          executable,
          distributionRoot,
          nodeBinary: process.execPath,
          bwrapPath: '/usr/bin/bwrap',
          setprivPath: '/usr/bin/setpriv',
          package: '@fixture/claude-code',
          version: '1.2.3',
          distributionDigest: fixtureDistributionDigest(files),
          maximumModelRequests: 5,
        },
      },
      provider: {
        id: 'zcloud-anthropic',
        protocol: 'anthropic-messages',
        credentials: {
          apiKeyEnvironment: 'RSI_CLAUDE_PROVIDER_API_KEY',
          baseUrlEnvironment: 'RSI_CLAUDE_PROVIDER_BASE_URL',
        },
      },
      repositoryRoot: root,
      modelGateway: {
        async rotateRoleToken(role) { rotations.push(role) },
      },
      startGateway: async (options) => {
        gatewayOptions = options
        return {
          url: MODEL_GATEWAY_RELAY_URL,
          socketPath: options.socketPath,
          async close() {},
        }
      },
      execute: async (options) => {
        invocation = options
        await Promise.all([
          writeFile(join(candidateWorkspace, 'agent.py'), 'BASELINE = False\n'),
          writeFile(join(outputDirectory, 'mutation-report.json'), `${JSON.stringify({
            diagnosis: '跨案例诊断',
            hypothesis: '最小假设',
            changedFiles: ['agent.py'],
            expectedImpact: '提高完成率',
            validation: ['fixture'],
            remainingRisks: '需要 selection 验证',
          })}\n`),
        ])
        return {
          ok: true,
          stdout: `${JSON.stringify({ type: 'result', result: 'done' })}\n`,
          stderr: '',
          durationMs: 10,
          outputExceeded: false,
        }
      },
    })

    const runtime = await driver.ensureRuntime()
    assert.equal(runtime.version, '1.2.3')
    const result = await driver.run({
      model: {
        provider: 'zcloud-anthropic',
        model: 'claude-sonnet-4-6',
        maxTokens: 8192,
        reasoningEffort: 'high',
      },
      candidateWorkspace,
      upstreamSource,
      contextDirectory,
      outputDirectory,
      dshHome: join(candidateRoot, 'claude-home'),
      mutationLevel: 'l2',
      targetId: 'msa-minimal-cowork-rsi',
      reportName: 'mutation-report.json',
      timeoutMs: 60_000,
    })

    assert.deepEqual(rotations, ['solver'])
    assert.equal(gatewayOptions.wireProtocol, 'anthropic-messages')
    assert.equal(gatewayOptions.upstreamBaseUrl, 'https://provider.invalid/v1')
    assert.equal(gatewayOptions.trustedModel, 'claude-sonnet-4-6')
    assert.equal(gatewayOptions.trustedReasoningEffort, 'high')
    assert.equal(gatewayOptions.maxOutputTokens, 8192)
    assert.deepEqual(result.report.changedFiles, ['agent.py'])
    assert.equal(await readFile(join(candidateWorkspace, 'agent.py'), 'utf8'), 'BASELINE = False\n')
    assert.equal(invocation.env.RSI_CLAUDE_PROVIDER_API_KEY, undefined)
    assert.equal(invocation.env.RSI_CLAUDE_PROVIDER_BASE_URL, undefined)
    assert.equal(invocation.env.ANTHROPIC_API_KEY, invocation.env.RSI_MODEL_GATEWAY_DUMMY_KEY)
    assert.equal(invocation.env.ANTHROPIC_BASE_URL, MODEL_GATEWAY_RELAY_URL)
    assert.ok(invocation.args.includes('--unshare-net'))
    assert.ok(invocation.args.includes('--keep-groups'))
    assert.ok(invocation.args.includes('--proc'))
    assert.equal(driver.usage().requests, 0)
  } finally {
    if (previousKey === undefined) delete process.env.RSI_CLAUDE_PROVIDER_API_KEY
    else process.env.RSI_CLAUDE_PROVIDER_API_KEY = previousKey
    if (previousBaseUrl === undefined) delete process.env.RSI_CLAUDE_PROVIDER_BASE_URL
    else process.env.RSI_CLAUDE_PROVIDER_BASE_URL = previousBaseUrl
    await rm(root, { recursive: true, force: true })
  }
})
