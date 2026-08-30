import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MODEL_GATEWAY_RELAY_URL } from '../src/model-gateway-relay.mjs'
import { createCodexUpdaterDriver } from '../src/runtimes/codex-updater.mjs'

function fixtureDistributionDigest(files) {
  const hash = createHash('sha256')
  for (const [pathValue, source] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    hash.update(pathValue)
    hash.update('\0')
    hash.update(source)
    hash.update('\0')
  }
  return hash.digest('hex')
}

test('Codex Updater 固定 distribution，通过 Responses Gateway 隔离修改 Candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-updater-test-'))
  const previousKey = process.env.RSI_PROVIDER_API_KEY
  const previousBaseUrl = process.env.RSI_PROVIDER_BASE_URL
  try {
    const distributionRoot = join(root, 'codex')
    const executable = join(distributionRoot, 'bin', 'codex.js')
    const packageSource = `${JSON.stringify({ name: '@fixture/codex', version: '1.2.3' }, null, 2)}\n`
    const executableSource = "if (process.argv.includes('--version')) console.log('codex-cli 1.2.3')\n"
    const files = {
      'bin/codex.js': executableSource,
      'package.json': packageSource,
    }
    await mkdir(join(distributionRoot, 'bin'), { recursive: true })
    await Promise.all([
      writeFile(executable, executableSource, { mode: 0o755 }),
      writeFile(join(distributionRoot, 'package.json'), packageSource),
    ])

    const candidateRoot = join(root, 'candidate')
    const candidateWorkspace = join(candidateRoot, 'workspace')
    const contextDirectory = join(candidateRoot, 'updater-input')
    const outputDirectory = join(candidateRoot, 'updater-output')
    const upstreamSource = join(root, 'upstream')
    await Promise.all([
      mkdir(candidateWorkspace, { recursive: true }),
      mkdir(upstreamSource, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(candidateWorkspace, 'agent.py'), 'BASELINE = True\n'),
      writeFile(join(upstreamSource, 'agent.py'), 'UPSTREAM = True\n'),
      writeFile(join(root, 'prompt.md'), '报告输出：{{ output.mutationReportPath }}\n'),
    ])

    process.env.RSI_PROVIDER_API_KEY = 'sk-fixture-provider-key'
    process.env.RSI_PROVIDER_BASE_URL = 'https://provider.invalid/v1'
    const rotations = []
    let invocation
    const driver = createCodexUpdaterDriver({
      updater: {
        protocol: 'codex-exec-v1',
        runtime: {
          executable,
          distributionRoot,
          nodeBinary: process.execPath,
          bwrapPath: '/usr/bin/bwrap',
          setprivPath: '/usr/bin/setpriv',
          package: '@fixture/codex',
          version: '1.2.3',
          distributionDigest: fixtureDistributionDigest(files),
          providerId: 'zcloud',
          maximumModelRequests: 5,
        },
      },
      provider: {
        id: 'zcloud-openai',
        credentials: {
          apiKeyEnvironment: 'RSI_PROVIDER_API_KEY',
          baseUrlEnvironment: 'RSI_PROVIDER_BASE_URL',
        },
      },
      repositoryRoot: root,
      modelGateway: {
        async rotateRoleToken(role) { rotations.push(role) },
      },
      startGateway: async (options) => ({
        url: MODEL_GATEWAY_RELAY_URL,
        socketPath: options.socketPath,
        async close() {},
      }),
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
          stdout: '{"type":"turn.completed"}\n',
          stderr: '',
          durationMs: 10,
          outputExceeded: false,
        }
      },
    })

    await driver.stageContext({
      destination: contextDirectory,
      promptPath: join(root, 'prompt.md'),
      promptVariables: {
        'output.mutationReportPath': '.rsi-output/mutation-report.json',
      },
      feedbackPacket: { cases: [] },
      mutationPolicy: { metadata: { level: 'l2' } },
    })
    assert.match(
      await readFile(join(contextDirectory, 'updater.md'), 'utf8'),
      /\/opt\/harness-rsi\/output\/mutation-report\.json/u,
    )

    const runtime = await driver.ensureRuntime()
    assert.equal(runtime.version, '1.2.3')
    const result = await driver.run({
      model: {
        provider: 'zcloud-openai',
        model: 'gpt-5.6-terra',
        maxTokens: 8192,
        reasoningEffort: 'high',
      },
      candidateWorkspace,
      upstreamSource,
      contextDirectory,
      outputDirectory,
      dshHome: join(candidateRoot, 'codex-home'),
      mutationLevel: 'l2',
      targetId: 'msa-minimal-cowork-rsi',
      reportName: 'mutation-report.json',
      timeoutMs: 60_000,
    })
    assert.deepEqual(rotations, ['solver'])
    assert.deepEqual(result.report.changedFiles, ['agent.py'])
    assert.equal(invocation.env.RSI_PROVIDER_API_KEY, undefined)
    assert.equal(invocation.env.RSI_PROVIDER_BASE_URL, undefined)
    assert.ok(invocation.args.includes('--unshare-net'))
    assert.ok(invocation.args.includes('model_providers.zcloud.request_max_retries=5'))
    assert.equal(driver.usage().requests, 0)
  } finally {
    if (previousKey === undefined) delete process.env.RSI_PROVIDER_API_KEY
    else process.env.RSI_PROVIDER_API_KEY = previousKey
    if (previousBaseUrl === undefined) delete process.env.RSI_PROVIDER_BASE_URL
    else process.env.RSI_PROVIDER_BASE_URL = previousBaseUrl
    await rm(root, { recursive: true, force: true })
  }
})
