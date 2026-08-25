import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, chown, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { prepareHleTextMathDataset } from './hle-dataset.mjs'
import { startModelGateway } from './model-gateway.mjs'
import { MODEL_GATEWAY_RELAY_URL } from './model-gateway-relay.mjs'
import {
  MSA_MINIMAL_MUTATION_POLICY,
  mutationPolicyFromConfiguration,
} from './mutation.mjs'
import { runPartition as runMsaHlePartition } from './msa-hle-partition-runner.mjs'
import { ProductionRuntimeError } from './production-runtime.mjs'
import { runProcess } from './subprocess.mjs'
import { runMutationPhase, UPDATER_SANDBOX_PATHS } from './updater-runner.mjs'

const PYTHON_SYNTAX_CHECK = [
  'import ast, pathlib, sys',
  'root = pathlib.Path(sys.argv[1])',
  'files = sorted(root.rglob("*.py"))',
  'assert files, "candidate contains no Python files"',
  'for path in files: ast.parse(path.read_text(encoding="utf-8"), filename=str(path))',
  'print(len(files))',
].join('\n')

function safeEnvironment(base = {}) {
  const env = {}
  for (const key of ['LANG', 'LC_ALL', 'PATH', 'TZ']) {
    if (typeof base[key] === 'string') env[key] = base[key]
  }
  return env
}

function summarize(candidateId, ids, records) {
  const usage = records.reduce((total, record) => ({
    requests: total.requests + (record.usage?.requests ?? 0),
    inputTokens: total.inputTokens + (record.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (record.usage?.outputTokens ?? 0),
    totalTokens: total.totalTokens + (record.usage?.totalTokens ?? 0),
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  return {
    summary: {
      candidateId,
      verified: records.filter((record) => record.status === 'resolved').length,
      total: ids.length,
      completedAt: new Date().toISOString(),
      usage,
    },
    records,
    traces: {},
  }
}

async function updaterDirectory(path, uid, gid) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chown(path, uid, gid)
  await chmod(path, 0o700)
}

export class MsaMinimalEvolutionRuntime {
  constructor(options) {
    this.store = options.store
    this.validationExpectedCount = options.validationExpectedCount
    this.updaterRunRoot = resolve(options.updaterRunRoot)
    this.validationScratchRoot = resolve(options.validationScratchRoot)
    this.smokeScratchRoot = resolve(options.smokeScratchRoot)
    this.datasetRoot = resolve(options.datasetRoot)
    this.nodePath = resolve(options.nodePath)
    this.runtimePatch = resolve(options.runtimePatch)
    this.mutationTemplatePath = resolve(options.mutationTemplatePath)
    this.updaterRuntimeRoot = resolve(options.updaterRuntimeRoot)
    this.pythonPath = resolve(options.pythonPath ?? '/usr/bin/python3')
    this.bwrapPath = resolve(options.bwrapPath)
    this.setprivPath = resolve(options.setprivPath)
    this.upstreamBaseUrl = options.upstreamBaseUrl
    this.getApiKey = options.getApiKey
    this.model = options.model
    this.reasoningEffort = options.reasoningEffort
    this.updaterBackend = options.updaterBackend ?? 'deepseek-harness'
    this.updaterProvider = options.updaterProvider ?? 'gateway'
    this.updaterModel = options.updaterModel ?? this.model
    this.updaterReasoningEffort = options.updaterReasoningEffort ?? this.reasoningEffort
    this.codexPath = options.codexPath === undefined ? undefined : resolve(options.codexPath)
    this.baseEnvironment = options.baseEnvironment
    this.secretValues = options.secretValues ?? []
    this.partitionOptions = options.partitionOptions ?? {}
    this.gatewayOptions = options.gatewayOptions ?? {}
    this.updaterUid = options.updaterUid
    this.updaterGid = options.updaterGid
    this.solverUid = options.solverUid
    this.solverGid = options.solverGid
    this.verifierUid = options.verifierUid
    this.verifierGid = options.verifierGid
    this.signal = options.signal
    this.onProgress = options.onProgress ?? (() => {})
    this.updaterExecute = options.updaterExecute
    this.partitionRunner = options.partitionRunner ?? runMsaHlePartition
    this.mutationTimeoutMs = options.mutationTimeoutMs
    this.sealedTestRunner = options.sealedTestRunner
    this.mutationPolicy = options.mutationConfiguration
      ? mutationPolicyFromConfiguration(options.mutationConfiguration)
      : MSA_MINIMAL_MUTATION_POLICY
    this.datasetPromise = null
  }

  async buildCandidate({ candidateId, candidateRoot, level }) {
    const root = resolve(candidateRoot)
    const access = await runProcess({
      command: '/usr/bin/chmod',
      args: [
        'o+x',
        dirname(root),
        dirname(dirname(root)),
        dirname(dirname(dirname(root))),
        dirname(dirname(dirname(dirname(root)))),
      ],
      cwd: root,
      env: safeEnvironment(this.baseEnvironment),
      timeoutMs: 30_000,
      signal: this.signal,
      outputLimitBytes: 1024 * 1024,
    })
    const readable = access.ok && (await runProcess({
      command: '/usr/bin/chmod',
      args: ['-R', 'a+rX', root],
      cwd: root,
      env: safeEnvironment(this.baseEnvironment),
      timeoutMs: 30_000,
      signal: this.signal,
      outputLimitBytes: 1024 * 1024,
    })).ok
    if (!readable) {
      throw new ProductionRuntimeError('candidate-build', 'Unable to expose Candidate read-only to Solver')
    }
    const result = await runProcess({
      command: this.pythonPath,
      args: ['-c', PYTHON_SYNTAX_CHECK, root],
      cwd: root,
      env: { ...safeEnvironment(this.baseEnvironment), PYTHONDONTWRITEBYTECODE: '1' },
      timeoutMs: 30_000,
      signal: this.signal,
      outputLimitBytes: 1024 * 1024,
      secretValues: this.secretValues,
    })
    return result.ok
      ? { ok: true, candidateId, level, runtimeRoot: root, checkedPythonFiles: Number(result.stdout.trim()) }
      : { ok: false, candidateId, level, kind: 'candidate', message: result.stderr || result.stdout }
  }

  #templateValues({ campaignId, candidateId, parentId, level }) {
    const mutation = level === null || level === undefined
      ? {
          mode: this.mutationPolicy.mode,
          layers: this.mutationPolicy.layers,
          readOnlyPaths: this.mutationPolicy.alwaysReadOnly,
        }
      : {
          level,
          writablePaths: this.mutationPolicy.levels[level],
          readOnlyPaths: this.mutationPolicy.alwaysReadOnly,
        }
    return {
      campaign: { id: campaignId },
      candidate: { id: candidateId, parentId, root: UPDATER_SANDBOX_PATHS.candidate },
      mutation,
      feedback: {
        root: UPDATER_SANDBOX_PATHS.feedback,
        log: UPDATER_SANDBOX_PATHS.evolutionLog,
      },
    }
  }

  async mutate({
    campaignId,
    candidateId,
    parentId,
    level,
    candidateRoot,
    gitRoot,
    feedbackRoot,
    evolutionLogPath,
  }) {
    const runRoot = join(this.updaterRunRoot, `${candidateId}-${randomUUID()}`)
    const home = join(runRoot, 'home')
    const temporary = join(runRoot, 'tmp')
    await updaterDirectory(runRoot, this.updaterUid, this.updaterGid)
    await Promise.all([
      updaterDirectory(home, this.updaterUid, this.updaterGid),
      updaterDirectory(temporary, this.updaterUid, this.updaterGid),
    ])
    const dummyKey = `rsi-${randomBytes(24).toString('base64url')}`
    let gateway
    try {
      gateway = await startModelGateway({
        ...this.gatewayOptions,
        upstreamBaseUrl: this.upstreamBaseUrl,
        getApiKey: this.getApiKey,
        trustedModel: this.updaterModel,
        trustedReasoningEffort: this.updaterReasoningEffort,
        candidateApiKey: dummyKey,
        socketPath: join(runRoot, 'model-gateway.sock'),
        publicUrl: MODEL_GATEWAY_RELAY_URL,
        socketUid: this.updaterUid,
        socketGid: this.updaterGid,
      })
      const { result, stopReason } = await runMutationPhase({
        templatePath: this.mutationTemplatePath,
        templateValues: this.#templateValues({ campaignId, candidateId, parentId, level }),
        invocationOptions: {
          backend: this.updaterBackend,
          nodeBinary: this.nodePath,
          updaterRuntime: this.updaterRuntimeRoot,
          codexPath: this.codexPath,
          updaterProvider: this.updaterProvider,
          updaterModel: this.updaterModel,
          updaterReasoningEffort: this.updaterReasoningEffort,
          candidateRoot: resolve(candidateRoot),
          gitRoot: resolve(gitRoot),
          runRoot,
          runtimePatch: this.runtimePatch,
          gatewayUrl: gateway.url,
          gatewaySocketPath: gateway.socketPath,
          gatewayDummyKey: dummyKey,
          uid: this.updaterUid,
          gid: this.updaterGid,
          feedbackRoot: resolve(feedbackRoot),
          evolutionLogPath: resolve(evolutionLogPath),
          bwrapPath: this.bwrapPath,
          setprivPath: this.setprivPath,
          baseEnv: { ...safeEnvironment(this.baseEnvironment), HOME: home, TMPDIR: temporary },
        },
        timeoutMs: this.mutationTimeoutMs,
        signal: this.signal,
        ...(this.updaterExecute ? { execute: this.updaterExecute } : {}),
      })
      return {
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        stopReason,
      }
    } catch (error) {
      if (error?.kind === 'infrastructure') {
        throw new ProductionRuntimeError('updater-mutation', 'Updater infrastructure failure', error)
      }
      throw error
    } finally {
      if (gateway) await gateway.close().catch(() => {})
      await rm(runRoot, { recursive: true, force: true })
    }
  }

  async #dataset() {
    this.datasetPromise ??= prepareHleTextMathDataset({ datasetRoot: this.datasetRoot })
    return this.datasetPromise
  }

  async #evaluate(candidateId, candidateRoot, ids, scratchRoot, checkpoint = true) {
    if (!Array.isArray(ids) || ids.length === 0
        || (checkpoint && ids.length !== this.validationExpectedCount)) {
      throw new ProductionRuntimeError('validation-evaluation', 'Unexpected validation manifest size')
    }
    const existing = checkpoint ? await this.store.readValidationCheckpoints(candidateId) : []
    const records = new Map(existing.map((record) => [record.instanceId, record]))
    const completedBeforeRun = records.size
    const remaining = ids.filter((id) => !records.has(id))
    if (remaining.length > 0) {
      const dataset = await this.#dataset()
      const result = await this.partitionRunner({
        ...this.partitionOptions,
        candidateId,
        instanceIds: remaining,
        candidateRoot: resolve(candidateRoot),
        solutionsRoot: dataset.solutionsRoot,
        leanRoot: dataset.leanRoot,
        scratchRoot,
        nodePath: this.nodePath,
        lakePath: 'unused',
        patchPath: this.runtimePatch,
        upstreamBaseUrl: this.upstreamBaseUrl,
        getApiKey: this.getApiKey,
        baseEnvironment: safeEnvironment(this.baseEnvironment),
        preset: 'minimal',
        solverUid: this.solverUid,
        solverGid: this.solverGid,
        verifierUid: this.verifierUid,
        verifierGid: this.verifierGid,
        bwrapPath: this.bwrapPath,
        setprivPath: this.setprivPath,
        sealed: false,
        signal: this.signal,
        onProgress: (event) => this.onProgress({
          ...event,
          completed: completedBeforeRun + (event.completed ?? 0),
          total: ids.length,
        }),
        onTrace: ({ taskId, text }) => this.store.writeValidationTrace(
          candidateId,
          taskId,
          text,
          this.secretValues,
        ),
        onRecord: async (record) => {
          records.set(record.instanceId, record)
          if (checkpoint) {
            await this.store.writeValidationCheckpoint(candidateId, record, this.secretValues)
          }
        },
      })
      for (const record of result.records) records.set(record.instanceId, record)
    }
    return summarize(candidateId, ids, ids.map((id) => records.get(id)))
  }

  evaluateValidation({ candidateId, candidateRoot, instanceIds }) {
    return this.#evaluate(
      candidateId,
      candidateRoot,
      instanceIds,
      this.validationScratchRoot,
      true,
    )
  }

  smoke({ candidateRoot, instanceIds }) {
    return this.#evaluate('baseline-smoke', candidateRoot, instanceIds, this.smokeScratchRoot, false)
  }

  async evaluateTest({ candidateId, candidateRoot }) {
    if (typeof this.sealedTestRunner !== 'function') {
      throw new ProductionRuntimeError('sealed-test-evaluation', 'Sealed test runner is unavailable')
    }
    return this.sealedTestRunner({ candidateId, candidateRoot })
  }
}
