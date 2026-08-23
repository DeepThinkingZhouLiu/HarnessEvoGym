#!/usr/bin/env node

import { resolve } from 'node:path'
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
import { evaluateBenchmark } from './evaluator.mjs'
import { isCampaignCliCommand, runCampaignCliCommand } from './campaign-cli.mjs'

const HELP = `DeepSeek Harness RSI Controller

用法：
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
  harness-rsi campaign smoke [共同参数] --zcloud-key-fd <fd> [--tasks 1..8]
  harness-rsi evolve start|run|resume [共同参数] --zcloud-key-fd <fd>
  harness-rsi evolve status|report [共同参数]

共同参数：
  [--config <campaign.json>] [--runtime <runtime.json>]
  [--campaign-id <id>] [--campaigns-root <path>] [--source-root <path>]

说明：
  - 默认只评测 Policy 的 decisionPartition。
  - final Partition 标记为 sealed，必须显式提供 --allow-sealed。
  - 本入口消费标准化 Solver Result，不直接执行候选仓库里的任何命令。
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
  if (group === 'benchmark' && action === 'validate') {
    await validateBenchmarkCommand(args)
    return
  }
  if (group === 'evaluate' && action === 'compare') {
    await compareCommand(args)
    return
  }
  if (isCampaignCliCommand(group, action)) {
    await runCampaignCliCommand(group, action, args)
    return
  }
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
