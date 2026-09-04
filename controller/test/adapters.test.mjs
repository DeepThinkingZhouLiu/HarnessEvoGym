import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  defaultSearchStrategyAdapter,
  loadExperimentBundle,
  validateEnvironmentAdapter,
  validateExperiment,
  validateModelProviderAdapter,
  validateTargetAdapter,
  validateUpdaterAdapter,
} from '../src/adapters.mjs'
import { readConfigFile } from '../src/config.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('Cowork Experiment 分别固定 Target/Updater Source 和模型上限', async () => {
  const bundle = await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/cowork-omegause-dsh-l1.json'),
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
  assert.equal(bundle.environment.modelGateway.maximumRequestsPerRun, 4096)
  assert.equal(bundle.environment.modelGateway.maximumUpstreamRetries, 5)
  assert.equal(bundle.environment.protocol, 'omegause-officeval-docker-v1')
  assert.equal(bundle.environment.verifier.timeoutSeconds, 300)
  assert.equal(bundle.environment.feedback.maximumHistoryEntries, 10)
  assert.equal(bundle.environment.feedback.maximumArtifactEntriesPerCase, 200)
  assert.equal(bundle.environment.task.workspaceLimits.maximumChangedBytes, 536870912)
  assert.equal(bundle.target.mutation.limits.maximumTreeEntries, 1000)
  assert.equal(bundle.target.mutation.semanticChecks.skills.requiredNamePrefix, 'cowork-')
  assert.equal(bundle.strategy.id, 'linear-hill-climb')
  assert.deepEqual(
    bundle.target.mutation.catalog.regions.map((region) => region.id),
    ['preset-composition', 'skill-guidance', 'skill-scripts'],
  )
})

test('旧 Cowork Experiment 不声明 Strategy 时保持线性策略兼容', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'experiments/cowork-omegause-dsh-l1.json'))
  delete config.spec.adapters.strategy
  const experiment = validateExperiment(config)
  assert.equal(experiment.adapters.strategy, null)
  assert.equal(defaultSearchStrategyAdapter().id, 'linear-hill-climb')
})

test('Evolution Experiment 只接受可审计的模型思考深度', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'experiments/cowork-msa-rsi-linear-single.json'))
  assert.equal(validateExperiment(config).models.solver.reasoningEffort, 'high')
  config.spec.models.solver.reasoningEffort = 'untrusted-auto'
  assert.throws(() => validateExperiment(config), /reasoningEffort 无效/u)
})

test('Evolution Experiment 可固定可复用 BaselinePack，旧配置保持为空', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'experiments/cowork-msa-rsi-linear-single.json'))
  assert.equal(validateExperiment(config).baselinePack, null)
  config.spec.baselinePack = {
    mode: 'reuse',
    path: '.rsi/baseline-packs/common-h0.json',
    sha256: 'a'.repeat(64),
  }
  assert.deepEqual(validateExperiment(config).baselinePack, config.spec.baselinePack)
  config.spec.baselinePack.mode = 'prepare'
  assert.throws(() => validateExperiment(config), /只能是 reuse/u)
  config.spec.baselinePack.mode = 'reuse'
  config.spec.baselinePack.extra = true
  assert.throws(() => validateExperiment(config), /未知字段/u)
})

test('DSH Driver 同时接受旧协议名和带版本协议名', async () => {
  const target = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/deepseek-harness.yml'))
  assert.equal(validateTargetAdapter(target).solver.protocol, 'dsh-headless-docker')
  target.spec.solver.protocol = 'dsh-headless-docker-v1'
  assert.equal(validateTargetAdapter(target).solver.protocol, 'dsh-headless-docker-v1')

  const updater = await readConfigFile(resolve(repositoryRoot, 'adapters/updaters/deepseek-harness.yml'))
  assert.equal(validateUpdaterAdapter(updater).protocol, 'dsh-headless-docker')
  updater.spec.protocol = 'dsh-headless-docker-v1'
  assert.equal(validateUpdaterAdapter(updater).protocol, 'dsh-headless-docker-v1')
})

test('Codex Updater 固定官方 distribution、版本与内容摘要', async () => {
  const bundle = await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/cowork-grhs-one-round.json'),
    repositoryRoot,
  )
  assert.equal(bundle.updater.protocol, 'codex-exec-v1')
  assert.equal(bundle.updater.source, null)
  assert.equal(bundle.updater.runtime.package, '@openai/codex')
  assert.equal(bundle.updater.runtime.version, '0.149.1')
  assert.equal(bundle.updater.runtime.providerId, 'zcloud')
  assert.equal(bundle.updater.runtime.distributionDigest.length, 64)

  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/updaters/codex-cli.yml'))
  config.spec.runtime.executable = 'codex'
  assert.throws(() => validateUpdaterAdapter(config), /必须是绝对路径/u)
})

test('OmegaUse Environment Adapter 拒绝给 Verifier 增加宿主环境继承入口', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.verifier.proxyEnvironment = ['HTTP_PROXY']
  assert.throws(() => validateEnvironmentAdapter(config), /未知字段/u)
})

test('AgentBay Docker backend 固定 bridge 路径并拒绝内联凭据', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval-agentbay.yml'))
  const environment = validateEnvironmentAdapter(config)
  assert.equal(environment.docker.backend, 'agentbay')
  assert.equal(environment.docker.agentBay.bridgePath, 'scripts/agentbay-docker-bridge.py')
  config.spec.docker.agentBay.apiKey = 'must-not-be-configured-here'
  assert.throws(() => validateEnvironmentAdapter(config), /未知字段/u)
})

test('OmegaUse Environment Adapter 要求 Dataset 与 Evaluator 使用不同根变量', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.source.evaluatorRootEnvironment = config.spec.source.datasetRootEnvironment
  assert.throws(() => validateEnvironmentAdapter(config), /必须使用不同/u)
})

test('OmegaUse Environment Adapter 要求 Source Manifest 与 Revision 完整固定', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.source.manifestDigest = 'floating'
  assert.throws(() => validateEnvironmentAdapter(config), /64 位小写 SHA-256/u)
})

test('Model Provider Adapter 拒绝重复模型目录', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/providers/zcloud-openai.yml'))
  config.spec.models.push({ ...config.spec.models[0] })
  assert.throws(() => validateModelProviderAdapter(config), /重复声明模型/u)
})

test('Environment Adapter 拒绝把 Model Gateway 命名为 localhost', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.modelGateway.alias = 'localhost'
  assert.throws(() => validateEnvironmentAdapter(config), /非 localhost/u)
})

test('Environment Adapter 拒绝互相矛盾的工作区预算', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.task.workspaceLimits.maximumFiles = 1000
  config.spec.task.workspaceLimits.maximumChangedFiles = config.spec.task.workspaceLimits.maximumFiles + 1
  assert.throws(() => validateEnvironmentAdapter(config), /子上限不能超过对应总上限/u)
})

test('OmegaUse Environment 并发 Trial 不能超过可审计上限', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  assert.equal(validateEnvironmentAdapter(config).task.maximumConcurrentTrials, 4)
  config.spec.task.maximumConcurrentTrials = 201
  assert.throws(() => validateEnvironmentAdapter(config), /maximumConcurrentTrials/u)
})

test('Environment Adapter 将上游模型额外重试限制在 0..5 次', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.modelGateway.maximumUpstreamRetries = 6
  assert.throws(() => validateEnvironmentAdapter(config), /maximumUpstreamRetries/u)
})

test('Environment Adapter 拒绝与可信评分挂载冲突的工作区', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'environments/omegause-officeval.yml'))
  config.spec.task.workspacePath = '/logs/submission'
  assert.throws(() => validateEnvironmentAdapter(config), /RSI 保留挂载冲突/u)
})

test('Target Adapter 拒绝改动文件预算大于 Candidate 目录项预算', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/deepseek-harness.yml'))
  config.spec.mutation.limits.maximumChangedFiles = config.spec.mutation.limits.maximumTreeEntries + 1
  assert.throws(() => validateTargetAdapter(config), /maximumChangedFiles 不能大于 maximumTreeEntries/u)
})
