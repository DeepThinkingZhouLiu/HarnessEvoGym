#!/usr/bin/env node

import { resolve } from 'node:path'
import { loadExperimentBundle, validateAnyAdapter } from './adapters.mjs'
import { readConfigFile, REPOSITORY_ROOT } from './config.mjs'
import { evaluateBenchmark } from './evaluator.mjs'
import {
  buildExperimentRuntime,
  finalizeEvolution,
  preflightExperiment,
  resumePopulationEvolution,
  runConfiguredBaseline,
  runConfiguredEvolution,
} from './cowork-orchestrator.mjs'
import {
  PARTITION_NAMES,
  ProtocolError,
  readJsonFile,
  readResultFile,
  validateBenchmark,
  validateEvaluationPolicy,
  validateEvolutionLedger,
  validateResultRecords,
  writeJsonFile,
} from './protocol.mjs'
import { isCampaignCliCommand, runCampaignCliCommand } from './campaign-cli.mjs'
import { exportBaselinePackFromRun } from './baseline-pack.mjs'

const HELP = `HarnessEvoGym Controller

用法：
  harness-rsi adapter validate --config <adapter.yml>
  harness-rsi experiment validate --config <experiment.json>
  harness-rsi experiment preflight --config <experiment.json> [--skip-secrets]
  harness-rsi runtime build --experiment <experiment.json>
  harness-rsi experiment baseline --config <experiment.json> [--run-id <id>]
  harness-rsi experiment baseline-pack-export --run <run> --output <pack.json> --id <id> [--branch <branch-id>]
  harness-rsi experiment run --config <experiment.json> [--run-id <id>]
  harness-rsi experiment resume --run <population-run>
  harness-rsi experiment finalize --run <single-run | population-run> [--recover-infrastructure]
  harness-rsi benchmark validate --config <benchmark.json> [--output <report.json>]
  harness-rsi evaluate compare \\
    --benchmark <benchmark.json> \\
    --policy <policy.json> \\
    --baseline <baseline.jsonl> \\
    --candidate <candidate.jsonl> \\
    --run-id <run-id> \\
    --baseline-revision <revision> \\
    --candidate-revision <revision> \\
    [--partitions feedback,selection] \\
    [--evolution <ledger.json>] \\
    [--allow-sealed] \\
    [--output <report.json>]
  harness-rsi campaign validate [--config <campaign.json>] [--runtime <runtime.json>]
  harness-rsi campaign smoke [共同参数] --provider-key-fd <fd> [--tasks 1..8]
  harness-rsi evolve start|run|resume [共同参数] --provider-key-fd <fd>
  harness-rsi evolve status|report [共同参数]

共同参数：
  [--config <campaign.json>] [--runtime <runtime.json>]
  [--campaign-id <id>] [--campaigns-root <path>] [--source-root <path>]

说明：
  - 默认只评测 Policy 的 decisionPartition。
  - evolve 的 --round-limit 0 表示不设人工轮数上限，由 L1-L3 早停规则结束。
  - final Partition 标记为 sealed，必须显式提供 --allow-sealed。
  - 本入口消费标准化 Solver Result，不直接执行候选仓库里的任何命令。
  - experiment run 只使用 feedback 与 selection，永远不会读取 final。
  - experiment baseline 只评测 H0 selection，不启动 Updater，不消耗进化预算。
  - experiment baseline-pack-export 从已有 Run 固化 H0 Selection 与第一轮 Feedback，不读取 final。
  - experiment resume 只恢复同一 Controller Revision 下的 Cowork Population 检查点。
  - experiment finalize 是唯一允许解锁 Cowork sealed final 的入口。
  - --recover-infrastructure 只能在 Population 上次失败且从未访问 sealed final 时使用，并且只能恢复一次。
  - Provider 密钥只从运行时环境变量读取，不写入 Experiment 或 .rsi 产物。
`

function parseOptions(args, { valueOptions, booleanFlags = new Set() }) {
  const options = new Map()
  const flags = new Set()

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) throw new ProtocolError(`无法识别的位置参数：${token}`)
    const name = token.slice(2)
    if (booleanFlags.has(name)) {
      flags.add(name)
      continue
    }
    if (!valueOptions.has(name)) throw new ProtocolError(`未知参数 --${name}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ProtocolError(`参数 --${name} 缺少值`)
    if (options.has(name)) throw new ProtocolError(`参数 --${name} 重复`)
    options.set(name, value)
    index += 1
  }

  return { options, flags }
}

function requiredValue(options, name) {
  const value = options.get(name)
  if (!value) throw new ProtocolError(`缺少必填参数 --${name}`)
  return value
}

function requiredPath(options, name) {
  return resolve(requiredValue(options, name))
}

async function emit(value, outputPath) {
  if (outputPath) {
    await writeJsonFile(resolve(outputPath), value)
    process.stdout.write(`${resolve(outputPath)}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function progress(event) {
  const generation = event.generation ? ` generation=${event.generation}` : ''
  process.stderr.write(`[${event.stage}]${generation} ${event.message}\n`)
}

async function validateAdapterCommand(args) {
  const { options } = parseOptions(args, { valueOptions: new Set(['config', 'output']) })
  const adapter = await validateAnyAdapter(await readConfigFile(requiredPath(options, 'config')))
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'AdapterValidationReport',
    valid: true,
    adapter: { id: adapter.id, kind: adapter.kind },
  }, options.get('output'))
}

async function validateExperimentCommand(args) {
  const { options } = parseOptions(args, { valueOptions: new Set(['config', 'output']) })
  const bundle = await loadExperimentBundle(requiredPath(options, 'config'), REPOSITORY_ROOT)
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'ExperimentValidationReport',
    valid: true,
    experiment: bundle.experiment.id,
    target: bundle.target.id,
    updater: bundle.updater.id,
    provider: bundle.provider.id,
    providers: {
      solver: bundle.providers.solver.id,
      updater: bundle.providers.updater.id,
    },
    strategy: bundle.strategy.id,
    environment: bundle.environment.id,
    benchmark: bundle.benchmark.id,
    policy: bundle.policy.id,
    mutationLevel: bundle.experiment.evolution.mutationLevel,
    partitions: Object.fromEntries(
      Object.entries(bundle.benchmark.partitions).map(([name, value]) => [name, value.instanceIds.length]),
    ),
  }, options.get('output'))
}

async function preflightExperimentCommand(args) {
  const { options, flags } = parseOptions(args, {
    valueOptions: new Set(['config', 'output']),
    booleanFlags: new Set(['skip-secrets']),
  })
  const report = await preflightExperiment({
    repositoryRoot: REPOSITORY_ROOT,
    experimentPath: requiredPath(options, 'config'),
    requireSecrets: !flags.has('skip-secrets'),
  })
  await emit({ apiVersion: 'harness-rsi/v1alpha1', kind: 'PreflightReport', valid: true, ...report }, options.get('output'))
}

async function buildRuntimeCommand(args) {
  const { options } = parseOptions(args, { valueOptions: new Set(['experiment', 'output']) })
  const result = await buildExperimentRuntime({
    repositoryRoot: REPOSITORY_ROOT,
    experimentPath: requiredPath(options, 'experiment'),
  })
  await emit({ apiVersion: 'harness-rsi/v1alpha1', kind: 'RuntimeBuildReport', ...result }, options.get('output'))
}

async function evolveRunCommand(args) {
  const { options } = parseOptions(args, { valueOptions: new Set(['config', 'run-id', 'output']) })
  const result = await runConfiguredEvolution({
    repositoryRoot: REPOSITORY_ROOT,
    experimentPath: requiredPath(options, 'config'),
    ...(options.get('run-id') ? { runId: options.get('run-id') } : {}),
    onEvent: progress,
  })
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionRunReport',
    runId: result.runId,
    runRoot: result.runRoot,
    championId: result.championId,
    status: result.population ? result.state.status : result.state.metadata.status,
  }, options.get('output'))
}

async function baselineRunCommand(args) {
  const { options } = parseOptions(args, { valueOptions: new Set(['config', 'run-id', 'output']) })
  const result = await runConfiguredBaseline({
    repositoryRoot: REPOSITORY_ROOT,
    experimentPath: requiredPath(options, 'config'),
    ...(options.get('run-id') ? { runId: options.get('run-id') } : {}),
    onEvent: progress,
  })
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BaselineRunReport',
    runId: result.runId,
    runRoot: result.runRoot,
    baselinePath: result.baselinePath,
    baselineId: result.state.best.candidateId,
    status: result.state.status,
    primary: result.state.best.evaluation.primary,
    budgetConsumed: result.state.budget.consumed,
  }, options.get('output'))
}

async function baselinePackExportCommand(args) {
  const { options } = parseOptions(args, {
    valueOptions: new Set(['run', 'output', 'id', 'branch']),
  })
  const result = await exportBaselinePackFromRun({
    repositoryRoot: REPOSITORY_ROOT,
    runDirectory: requiredPath(options, 'run'),
    outputPath: requiredPath(options, 'output'),
    id: requiredValue(options, 'id'),
    ...(options.get('branch') ? { branchId: options.get('branch') } : {}),
    secrets: [process.env.RSI_PROVIDER_API_KEY].filter(Boolean),
  })
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BaselinePackExportReport',
    id: result.pack.metadata.id,
    path: result.path,
    sha256: result.pack.metadata.sha256,
    source: result.pack.spec.source,
    primary: result.pack.spec.selection.evaluation.primary,
    selectionCases: result.pack.spec.selection.records.length,
    feedbackCases: result.pack.spec.feedback.records.length,
  })
}

async function evolveResumeCommand(args) {
  const { options } = parseOptions(args, { valueOptions: new Set(['run', 'output']) })
  const result = await resumePopulationEvolution({
    repositoryRoot: REPOSITORY_ROOT,
    runDirectory: requiredPath(options, 'run'),
    onEvent: progress,
  })
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionRunReport',
    runId: result.runId,
    runRoot: result.runRoot,
    championId: result.championId,
    status: result.state.status,
  }, options.get('output'))
}

async function evolveFinalizeCommand(args) {
  const { options, flags } = parseOptions(args, {
    valueOptions: new Set(['run', 'output']),
    booleanFlags: new Set(['recover-infrastructure']),
  })
  const result = await finalizeEvolution({
    repositoryRoot: REPOSITORY_ROOT,
    runDirectory: requiredPath(options, 'run'),
    recoverInfrastructure: flags.has('recover-infrastructure'),
    onEvent: progress,
  })
  await emit({
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'FinalEvaluationRunReport',
    runId: result.runId,
    reportPath: result.reportPath,
    metrics: result.report.rsiMetrics,
  }, options.get('output'))
}

async function validateBenchmarkCommand(args) {
  const { options } = parseOptions(args, {
    valueOptions: new Set(['config', 'output']),
  })
  const configPath = requiredPath(options, 'config')
  const benchmark = validateBenchmark(await readJsonFile(configPath))
  const report = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'BenchmarkValidationReport',
    valid: true,
    benchmark: {
      id: benchmark.id,
      name: benchmark.name,
      source: benchmark.source,
      expectedTotal: benchmark.expectedTotal,
      partitions: Object.fromEntries(
        Object.entries(benchmark.partitions).map(([name, partition]) => [
          name,
          {
            visibility: partition.visibility,
            count: partition.instanceIds.length,
          },
        ]),
      ),
    },
  }
  await emit(report, options.get('output'))
}

async function compareCommand(args) {
  const { options, flags } = parseOptions(args, {
    valueOptions: new Set([
      'benchmark',
      'policy',
      'baseline',
      'candidate',
      'run-id',
      'baseline-revision',
      'candidate-revision',
      'partitions',
      'evolution',
      'output',
    ]),
    booleanFlags: new Set(['allow-sealed']),
  })
  const benchmark = validateBenchmark(await readJsonFile(requiredPath(options, 'benchmark')))
  const policy = validateEvaluationPolicy(await readJsonFile(requiredPath(options, 'policy')))

  const requestedPartitions = (options.get('partitions') ?? policy.decisionPartition)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (requestedPartitions.length === 0) throw new ProtocolError('--partitions 不能为空')
  if (new Set(requestedPartitions).size !== requestedPartitions.length) {
    throw new ProtocolError('--partitions 不能包含重复 Partition')
  }
  for (const partition of requestedPartitions) {
    if (!PARTITION_NAMES.includes(partition)) throw new ProtocolError(`未知 Partition：${partition}`)
    if (benchmark.partitions[partition].visibility === 'sealed' && !flags.has('allow-sealed')) {
      throw new ProtocolError(`Partition ${partition} 是 sealed；最终评测必须显式提供 --allow-sealed`)
    }
  }

  const baselineInput = await readResultFile(requiredPath(options, 'baseline'))
  const candidateInput = await readResultFile(requiredPath(options, 'candidate'))
  const baselineRecords = validateResultRecords(baselineInput, benchmark, 'Baseline')
  const candidateRecords = validateResultRecords(candidateInput, benchmark, 'Candidate')
  const evolutionLedger = options.get('evolution')
    ? validateEvolutionLedger(await readJsonFile(resolve(options.get('evolution'))))
    : null

  const report = evaluateBenchmark({
    benchmark,
    policy,
    run: {
      id: requiredValue(options, 'run-id'),
      baselineRevision: requiredValue(options, 'baseline-revision'),
      candidateRevision: requiredValue(options, 'candidate-revision'),
    },
    baselineRecords,
    candidateRecords,
    partitions: requestedPartitions,
    evolutionLedger,
    allowSealed: flags.has('allow-sealed'),
  })
  await emit(report, options.get('output'))
}

async function main() {
  const [group, action, ...args] = process.argv.slice(2)
  if (!group || group === '--help' || group === '-h') {
    process.stdout.write(HELP)
    return
  }
  if (group === 'adapter' && action === 'validate') return await validateAdapterCommand(args)
  if (group === 'experiment' && action === 'validate') return await validateExperimentCommand(args)
  if (group === 'experiment' && action === 'preflight') return await preflightExperimentCommand(args)
  if (group === 'experiment' && action === 'baseline') return await baselineRunCommand(args)
  if (group === 'experiment' && action === 'baseline-pack-export') return await baselinePackExportCommand(args)
  if (group === 'experiment' && action === 'run') return await evolveRunCommand(args)
  if (group === 'experiment' && action === 'resume') return await evolveResumeCommand(args)
  if (group === 'experiment' && action === 'finalize') return await evolveFinalizeCommand(args)
  if (group === 'runtime' && action === 'build') return await buildRuntimeCommand(args)
  if (group === 'benchmark' && action === 'validate') return await validateBenchmarkCommand(args)
  if (group === 'evaluate' && action === 'compare') return await compareCommand(args)
  if (isCampaignCliCommand(group, action)) return await runCampaignCliCommand(group, action, args)
  throw new ProtocolError(`未知命令：${[group, action].filter(Boolean).join(' ')}`, ['使用 --help 查看入口'])
}

main().catch((error) => {
  if (error instanceof ProtocolError) {
    process.stderr.write(`${error.message}\n`)
    for (const detail of error.details) process.stderr.write(`- ${detail}\n`)
    process.exitCode = 2
    return
  }
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
