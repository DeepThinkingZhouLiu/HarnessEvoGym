import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import { ensureDshRuntime, renderUpdaterPrompt, runDshSolver, runDshUpdater } from '../src/runtimes/dsh.mjs'

const provider = {
  id: 'zcloud-openai',
  name: 'ZCloud OpenAI-Compatible Gateway',
  protocol: 'openai-chat-completions',
  credentials: {
    apiKeyEnvironment: 'RSI_PROVIDER_API_KEY',
    baseUrlEnvironment: 'RSI_PROVIDER_BASE_URL',
  },
  compatibility: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  defaultContextWindow: 131072,
  models: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  ],
}

test('Updater Prompt 必须完整渲染受控变量', () => {
  const prompt = renderUpdaterPrompt('层级={{ mutation.level }}\n目标={{target.name}}', {
    'mutation.level': 'l1',
    'target.name': 'deepseek-harness',
  })
  assert.equal(prompt, '层级=l1\n目标=deepseek-harness')
})

test('Updater Prompt 拒绝未知模板变量', () => {
  assert.throws(() => renderUpdaterPrompt('{{ unknown.value }}', {}), /未知模板变量/u)
})

test('DSH Solver 写入显式模型上限，并把一次性令牌作为秘密环境传入 Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dsh-runtime-'))
  const workspace = join(root, 'workspace')
  const candidatePreset = join(root, 'preset')
  const dshHome = join(root, 'dsh-home')
  await Promise.all([
    mkdir(workspace),
    mkdir(candidatePreset),
    mkdir(dshHome),
  ])
  let runOptions
  const docker = {
    async run(options) {
      runOptions = options
      return { stdout: 'done\n', stderr: '', durationMs: 1, outputTruncated: false }
    },
  }
  await runDshSolver({
    docker,
    runtime: {
      profile: 'headless',
      preset: 'cowork-rsi',
      secretEnvironment: ['RSI_PROVIDER_API_KEY', 'RSI_PROVIDER_BASE_URL'],
    },
    image: 'solver:test',
    model: { provider: 'zcloud-openai', model: 'gpt-5.6-terra', maxTokens: 8192 },
    provider,
    candidatePreset,
    workspace,
    dshHome,
    modelAccess: {
      network: 'internal-net',
      environment: { RSI_PROVIDER_BASE_URL: 'http://model-gateway:8080' },
      secretEnvironment: { RSI_PROVIDER_API_KEY: 'ephemeral-token' },
    },
    task: '---\n完成任务',
    name: 'solver-test',
    timeoutMs: 1000,
  })

  const settings = await readFile(join(dshHome, 'settings.yaml'), 'utf8')
  const runtimePatch = await readFile(join(dshHome, 'cordis.patch.yml'), 'utf8')
  assert.match(settings, /maxTokens: 8192/u)
  assert.match(settings, /llm-pi-ai/u)
  assert.match(settings, /provider: zcloud-openai/u)
  assert.match(settings, /model: gpt-5\.6-terra/u)
  assert.deepEqual(parseYaml(runtimePatch), [
    { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox', disabled: true },
    { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox', disabled: true },
    { id: 'permission', name: '@deepseek-ai/dsh-permission-presets', disabled: true },
    {
      insert: [
        { id: 'bash-local', name: '@deepseek-ai/dsh-bash-local' },
        { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local' },
      ],
    },
  ])
  assert.equal(runOptions.environment.RSI_PROVIDER_API_KEY, undefined)
  assert.equal(runOptions.secretEnvironment.RSI_PROVIDER_API_KEY, 'ephemeral-token')
  assert.equal(runOptions.network, 'internal-net')
  assert.equal(runOptions.environment.HTTP_PROXY, '')
  assert.deepEqual(runOptions.command, [
    'dsh', '--profile', 'headless', '--preset', 'cowork-rsi', '--', '---\n完成任务',
  ])
})

test('DSH Updater 只挂载单个可写 Mutation Report，不暴露隐藏输出目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-dsh-updater-'))
  const candidateWorkspace = join(root, 'candidate')
  const upstreamSource = join(root, 'source')
  const contextDirectory = join(root, 'context')
  const outputDirectory = join(root, 'output')
  const dshHome = join(root, 'dsh-home')
  await Promise.all([
    mkdir(candidateWorkspace),
    mkdir(upstreamSource),
    mkdir(contextDirectory),
    mkdir(dshHome),
  ])
  let runOptions
  const docker = {
    async run(options) {
      runOptions = options
      const reportMount = options.mounts.find((mount) => mount.target.endsWith('/mutation-report.json'))
      await writeFile(reportMount.source, JSON.stringify({
        diagnosis: '诊断',
        hypothesis: '假设',
        changedFiles: [],
        expectedImpact: '预期',
        validation: [],
        remainingRisks: '风险',
      }))
      return { stdout: '', stderr: '', durationMs: 1, outputTruncated: false }
    },
  }

  await runDshUpdater({
    docker,
    runtime: {
      profile: 'headless',
      preset: 'standard',
      secretEnvironment: ['RSI_PROVIDER_API_KEY', 'RSI_PROVIDER_BASE_URL'],
    },
    image: 'updater:test',
    model: { provider: 'zcloud-openai', model: 'gpt-5.6-terra', maxTokens: 8192 },
    provider,
    candidateWorkspace,
    upstreamSource,
    contextDirectory,
    outputDirectory,
    dshHome,
    modelAccess: {
      network: 'internal-net',
      environment: { RSI_PROVIDER_BASE_URL: 'http://model-gateway:8080' },
      secretEnvironment: { RSI_PROVIDER_API_KEY: 'ephemeral-token' },
    },
    mutationLevel: 'l1',
    targetId: 'deepseek-harness',
    reportName: 'mutation-report.json',
    name: 'updater-test',
    timeoutMs: 1000,
  })

  const outputMounts = runOptions.mounts.filter((mount) => mount.target.startsWith('/candidate/.rsi-output'))
  assert.equal(outputMounts.length, 1)
  assert.equal(outputMounts[0].target, '/candidate/.rsi-output/mutation-report.json')
  assert.equal(outputMounts[0].readOnly, false)
  assert.equal(runOptions.command.at(-2), '--')
})

test('DSH Runtime 构建显式绑定 Adapter 的 Source Path 与 Revision', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'rsi-dsh-build-'))
  await mkdir(join(repositoryRoot, 'docker', 'dsh-runtime'), { recursive: true })
  await writeFile(join(repositoryRoot, 'docker', 'dsh-runtime', 'Dockerfile'), 'FROM scratch\n')
  await writeFile(join(repositoryRoot, 'docker', 'dsh-runtime', 'dsh'), '#!/bin/sh\n')
  let buildOptions
  const docker = {
    async imageExists() { return false },
    async build(options) { buildOptions = options },
  }
  const result = await ensureDshRuntime({
    docker,
    runtime: {
      image: 'dsh:test',
      dockerfile: 'docker/dsh-runtime/Dockerfile',
      package: '@deepseek-ai/dsh',
      version: '0.1.1-rc.1',
    },
    repositoryRoot,
    sourceRevision: 'a'.repeat(40),
    sourcePath: 'sources/deepseek-harness',
    baseImage: 'task:test',
    baseImageIdentity: `sha256:${'b'.repeat(64)}`,
  })
  assert.equal(result.built, true)
  assert.equal(buildOptions.buildArgs.DSH_SOURCE_REVISION, 'a'.repeat(40))
  assert.equal(buildOptions.buildArgs.DSH_SOURCE_PATH, 'sources/deepseek-harness')
  assert.equal(buildOptions.buildArgs.DSH_RUNTIME_DEFINITION_DIGEST.length, 64)
  assert.equal(buildOptions.buildArgs.DSH_BASE_IMAGE_IDENTITY, `sha256:${'b'.repeat(64)}`)
})
