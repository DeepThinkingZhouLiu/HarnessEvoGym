import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  loadExperimentBundle,
  validateEnvironmentAdapter,
  validateModelProviderAdapter,
  validateTargetAdapter,
} from '../src/adapters.mjs'
import { readConfigFile } from '../src/config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('Cowork Experiment 分别固定 Target/Updater Source 和模型上限', async () => {
  const bundle = await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/cowork-skillsbench-dsh-l1.json'),
    repositoryRoot,
  )
  assert.equal(bundle.target.source.revision.length, 40)
  assert.equal(bundle.updater.source.revision.length, 40)
  assert.equal(bundle.experiment.models.solver.maxTokens, 8192)
  assert.equal(bundle.experiment.models.updater.maxTokens, 8192)
  assert.equal(bundle.provider.id, 'zcloud-openai')
  assert.equal(bundle.experiment.models.solver.model, 'gpt-5.6-terra')
  assert.equal(bundle.experiment.models.updater.model, 'gpt-5.6-terra')
  assert.equal(bundle.environment.modelGateway.upstreamApiKeyEnvironment, 'RSI_PROVIDER_API_KEY')
  assert.equal(bundle.environment.modelGateway.maximumRequestsPerRun, 512)
  assert.ok(bundle.environment.verifier.proxyEnvironment.includes('HTTPS_PROXY'))
  assert.equal(bundle.environment.feedback.maximumHistoryEntries, 10)
  assert.equal(bundle.environment.feedback.maximumArtifactEntriesPerCase, 100)
  assert.equal(bundle.environment.task.workspaceLimits.maximumChangedBytes, 536870912)
  assert.equal(bundle.target.mutation.limits.maximumTreeEntries, 1000)
  assert.equal(bundle.target.mutation.semanticChecks.skills.requiredNamePrefix, 'cowork-')
})

test('Environment Adapter 拒绝让 Verifier 继承非代理宿主变量', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/skillsbench-cowork.yml'))
  config.spec.verifier.proxyEnvironment.push('HOME')
  assert.throws(() => validateEnvironmentAdapter(config), /只能继承标准代理环境变量/u)
})

test('Model Provider Adapter 拒绝重复模型目录', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/providers/zcloud-openai.yml'))
  config.spec.models.push({ ...config.spec.models[0] })
  assert.throws(() => validateModelProviderAdapter(config), /重复声明模型/u)
})

test('Environment Adapter 拒绝把 Model Gateway 命名为 localhost', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/skillsbench-cowork.yml'))
  config.spec.modelGateway.alias = 'localhost'
  assert.throws(() => validateEnvironmentAdapter(config), /不能使用 localhost/u)
})

test('Environment Adapter 拒绝互相矛盾的工作区预算', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/skillsbench-cowork.yml'))
  config.spec.task.workspaceLimits.maximumChangedFiles = config.spec.task.workspaceLimits.maximumFiles + 1
  assert.throws(() => validateEnvironmentAdapter(config), /maximumChangedFiles 不能大于 maximumFiles/u)
})

test('Environment Adapter 拒绝与可信评分挂载冲突的工作区', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/skillsbench-cowork.yml'))
  config.spec.task.workspacePath = '/logs/submission'
  assert.throws(() => validateEnvironmentAdapter(config), /RSI 保留挂载冲突/u)
})

test('Target Adapter 拒绝改动文件预算大于 Candidate 目录项预算', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/deepseek-harness.yml'))
  config.spec.mutation.limits.maximumChangedFiles = config.spec.mutation.limits.maximumTreeEntries + 1
  assert.throws(() => validateTargetAdapter(config), /maximumChangedFiles 不能大于 maximumTreeEntries/u)
})
