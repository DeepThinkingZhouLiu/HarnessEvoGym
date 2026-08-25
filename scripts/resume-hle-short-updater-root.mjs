#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  attestRuntimePatch,
  isCampaignCliCommand,
  runCampaignCliCommand,
} from '../controller/src/campaign-cli.mjs'
import { loadEvolutionCampaign } from '../controller/src/campaign.mjs'
import { buildDirectCommandEnvironment } from '../controller/src/direct-environment.mjs'
import { InfrastructurePartitionError } from '../controller/src/partition-runner.mjs'
import { MsaMinimalEvolutionRuntime } from '../controller/src/msa-minimal-runtime.mjs'
import { runPartition as runMsaHlePartition } from '../controller/src/msa-hle-partition-runner.mjs'
import { ProductionRuntimeError, PutnamEvolutionRuntime } from '../controller/src/production-runtime.mjs'
import { ProtocolError } from '../controller/src/protocol.mjs'
import { loadPutnamRuntime as loadFrozenRuntime } from '../controller/src/runtime-config.mjs'
import { runProcess } from '../controller/src/subprocess.mjs'

const DIRECT_ENV_MARKER = 'RSI_HLE_RECOVERY_DIRECT_ENV'
const SCOPE_ROOT = '/mnt/data/hzy/03_dsh_rsi'
const LEGACY_RUNTIME_ROOT = '/mnt/data/hzy/dsh-rsi-runtime'
const RUNTIME_ROOT = join(SCOPE_ROOT, 'dsh-rsi-runtime')
const SCRATCH_ROOT = join(SCOPE_ROOT, 's')
const UPDATER_RUN_ROOT = join(SCOPE_ROOT, 'u')
const GATEWAY_SOCKET_ROOT = join(SCOPE_ROOT, 'g')

function withinScope(path) {
  const rel = relative(SCOPE_ROOT, resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

function requireScopedPath(path, name) {
  const resolved = resolve(path)
  if (!withinScope(resolved)) throw new ProtocolError(`${name} must stay below ${SCOPE_ROOT}`)
  return resolved
}

function relocateRuntimePath(path) {
  if (path === LEGACY_RUNTIME_ROOT) return RUNTIME_ROOT
  if (typeof path === 'string' && path.startsWith(`${LEGACY_RUNTIME_ROOT}${sep}`)) {
    return join(RUNTIME_ROOT, path.slice(LEGACY_RUNTIME_ROOT.length + 1))
  }
  return path
}

function relocateRuntimeConfig(runtimeConfig) {
  if (runtimeConfig.kind !== 'HleTextMathRuntime') {
    throw new ProtocolError('Scoped recovery is restricted to hle-text-math')
  }
  for (const [name, value] of Object.entries(runtimeConfig.paths)) {
    runtimeConfig.paths[name] = name === 'scratchRoot'
      ? SCRATCH_ROOT
      : relocateRuntimePath(value)
    requireScopedPath(runtimeConfig.paths[name], `runtime paths.${name}`)
  }
  for (const name of ['nodePath', 'pnpmPath', 'elanHome', 'lakePath']) {
    runtimeConfig.toolchain[name] = relocateRuntimePath(runtimeConfig.toolchain[name])
    requireScopedPath(runtimeConfig.toolchain[name], `runtime toolchain.${name}`)
  }
}

async function repairRelocatedRuntimeLinks(runtimeConfig, campaignId) {
  const runtimeCampaignRoot = requireScopedPath(
    join(runtimeConfig.paths.persistentRoot, 'runtimes', campaignId),
    'runtime campaign root',
  )
  let entries
  try {
    entries = await readdir(runtimeCampaignRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    const linkPath = requireScopedPath(join(runtimeCampaignRoot, entry.name), 'runtime link')
    const currentTarget = await readlink(linkPath)
    const relocatedTarget = relocateRuntimePath(currentTarget)
    if (relocatedTarget === currentTarget) continue
    requireScopedPath(relocatedTarget, 'relocated runtime target')
    const targetStat = await stat(relocatedTarget)
    if (!targetStat.isDirectory()) {
      throw new ProtocolError(`Relocated runtime target is not a directory: ${relocatedTarget}`)
    }

    const replacement = requireScopedPath(
      join(runtimeCampaignRoot, `.relocate-${entry.name}-${randomUUID()}`),
      'runtime link replacement',
    )
    await symlink(relocatedTarget, replacement, 'dir')
    await rename(replacement, linkPath)
  }
}

function credentialDescriptor(args) {
  const indices = ['--provider-key-fd', '--zcloud-key-fd']
    .map((name) => args.indexOf(name))
    .filter((index) => index >= 0)
  if (indices.length !== 1) {
    throw new ProtocolError('Recovery command requires exactly one credential FD option')
  }
  const descriptor = Number(args[indices[0] + 1])
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 64) {
    throw new ProtocolError('Recovery credential FD must be in 3..64')
  }
  return descriptor
}

async function reexecWithoutProxy(args) {
  const descriptor = credentialDescriptor(args)
  const stdio = ['inherit', 'inherit', 'inherit']
  while (stdio.length <= descriptor) stdio.push('ignore')
  stdio[descriptor] = descriptor
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    env: {
      ...buildDirectCommandEnvironment(process.env),
      [DIRECT_ENV_MARKER]: '1',
    },
    stdio,
  })
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  process.exitCode = result.code ?? (result.signal ? 1 : 0)
}

function diagnosticText(value, secret) {
  const text = typeof value === 'string' ? value : ''
  const redacted = secret ? text.split(secret).join('[REDACTED_DUMMY_KEY]') : text
  return redacted.length <= 8_000 ? redacted : redacted.slice(-8_000)
}

function scoredTaskBudgetTimeout(record, taskTimeoutMs) {
  const durationMs = record?.latencyMs
  const reachedTaskBudget = Number.isFinite(durationMs)
    && durationMs >= taskTimeoutMs - 1_000
    && durationMs <= taskTimeoutMs + 5_000
  if (record?.status !== 'error'
      || record.failureKind !== 'infrastructure'
      || record.solverStatus !== 'infrastructure_error'
      || record.verifierStatus !== 'not_attempted'
      || record.attempts !== 1
      || !reachedTaskBudget) {
    return record
  }
  return {
    ...record,
    status: 'timeout',
    failureKind: 'candidate',
    solverStatus: 'timeout',
  }
}

function partitionUsage(records) {
  return records.reduce((total, record) => ({
    requests: total.requests + (record.usage?.requests ?? 0),
    inputTokens: total.inputTokens + (record.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (record.usage?.outputTokens ?? 0),
    totalTokens: total.totalTokens + (record.usage?.totalTokens ?? 0),
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
}

/** Keep a task-level budget exhaustion as a zero-scoring Candidate outcome. */
function scoreTaskBudgetTimeouts(partitionRunner) {
  return async (options) => {
    const completed = new Map()
    const converted = new Set()
    const originalOnRecord = options.onRecord
    const originalOnProgress = options.onProgress
    try {
      return await partitionRunner({
        ...options,
        onRecord: async (rawRecord) => {
          const record = scoredTaskBudgetTimeout(rawRecord, options.taskTimeoutMs)
          if (record !== rawRecord) converted.add(record.instanceId)
          if (originalOnRecord) await originalOnRecord(record)
          completed.set(record.instanceId, record)
        },
        onProgress: originalOnProgress
          ? (event) => originalOnProgress(converted.has(event.problemId)
              ? { ...event, status: 'timeout' }
              : event)
          : undefined,
      })
    } catch (error) {
      const ordered = options.instanceIds.map((id) => completed.get(id))
      const recoverable = error instanceof InfrastructurePartitionError
        && converted.size > 0
        && ordered.every((record) => record && record.status !== 'error')
      if (!recoverable) throw error
      return {
        summary: {
          candidateId: options.candidateId,
          verified: ordered.filter((record) => record.status === 'resolved').length,
          total: ordered.length,
          completedAt: new Date().toISOString(),
          usage: partitionUsage(ordered),
        },
        records: ordered,
        traces: {},
      }
    }
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) {
    throw new ProtocolError(`Recovery command requires ${name}`)
  }
  return args[index + 1]
}

async function main() {
  const commandArgs = process.argv.slice(2)
  if (process.env[DIRECT_ENV_MARKER] !== '1') {
    await reexecWithoutProxy(commandArgs)
    return
  }

  const [group, action, ...args] = commandArgs
  const supported = (group === 'evolve' && ['start', 'run', 'resume'].includes(action))
    || (group === 'campaign' && action === 'smoke')
  if (!isCampaignCliCommand(group, action) || !supported) {
    throw new ProtocolError('Scoped HLE runner supports campaign smoke and evolve start|run|resume')
  }

  const selectedCampaignId = optionValue(args, '--campaign-id')
  const loadedCampaign = await loadEvolutionCampaign(optionValue(args, '--config'))
  const setting = loadedCampaign.config.metadata?.setting
  if (!['single-branch-linear-validation-only', 'msa-minimal-linear-validation-only'].includes(setting)) {
    throw new ProtocolError('Scoped HLE runner requires a linear validation-only setting')
  }
  for (const option of ['--config', '--runtime', '--campaigns-root', '--source-root']) {
    requireScopedPath(optionValue(args, option), option)
  }
  await mkdir(GATEWAY_SOCKET_ROOT, { recursive: true, mode: 0o711 })
  await chmod(GATEWAY_SOCKET_ROOT, 0o711)
  const environment = buildDirectCommandEnvironment(process.env)

  await runCampaignCliCommand(group, action, args, {
    environment,
    async loadPutnamRuntime(path) {
      const loaded = await loadFrozenRuntime(path)
      relocateRuntimeConfig(loaded.config)
      await repairRelocatedRuntimeLinks(loaded.config, selectedCampaignId)
      return loaded
    },
    async attestRuntimePatch(runtimeConfig) {
      relocateRuntimeConfig(runtimeConfig)
      await attestRuntimePatch(runtimeConfig)
    },
    runSealedTestInChild() {
      throw new ProtocolError('Validation-only linear Campaign 禁止调用 sealed-test runner')
    },
    createRuntime(options) {
      if (options.benchmark !== 'hle-text-math') {
        throw new ProtocolError('Short updater-root recovery is restricted to hle-text-math')
      }
      const updaterExecute = async (invocation) => {
        const result = await runProcess(invocation)
        if (!result.ok) {
          const dummyKey = invocation.env?.RSI_MODEL_GATEWAY_DUMMY_KEY
          process.stderr.write(`${JSON.stringify({
            type: 'updater-process-diagnostic',
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            aborted: result.aborted,
            stdoutTail: diagnosticText(result.stdout, dummyKey),
            stderrTail: diagnosticText(result.stderr, dummyKey),
          })}\n`)
        }
        return result
      }
      const common = {
        ...options,
        updaterRunRoot: UPDATER_RUN_ROOT,
        partitionOptions: {
          ...options.partitionOptions,
          gatewaySocketRoot: GATEWAY_SOCKET_ROOT,
        },
        updaterExecute,
      }
      if (setting === 'msa-minimal-linear-validation-only') {
        return new MsaMinimalEvolutionRuntime({
          ...common,
          updaterRuntimeRoot: join(RUNTIME_ROOT, 'trusted-baseline'),
          partitionRunner: scoreTaskBudgetTimeouts(runMsaHlePartition),
        })
      }
      return new PutnamEvolutionRuntime({
        ...common,
        slimSingleBranch: true,
        partitionRunner: scoreTaskBudgetTimeouts(options.partitionRunner),
      })
    },
  })
}

main().catch((error) => {
  if (error instanceof ProtocolError || error instanceof ProductionRuntimeError) {
    process.stderr.write(`${error.message}\n`)
    for (const detail of error.details ?? []) process.stderr.write(`- ${detail}\n`)
    process.exitCode = 2
    return
  }
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
