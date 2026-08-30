import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { writeJsonLines } from '../candidate.mjs'
import { REPOSITORY_ROOT, resolveInside } from '../config.mjs'
import { safeDockerName } from '../docker.mjs'
import { ProtocolError, validateResultRecords } from '../protocol.mjs'

const TASKS_API_VERSION = 'harness-rsi/v1alpha1'
const TASKS_KIND = 'SyntheticTextReasoningTasks'
const PARTITIONS = new Set(['feedback', 'selection', 'final'])
const MAXIMUM_TASK_FILE_BYTES = 1024 * 1024
const MAXIMUM_TASK_TEXT_BYTES = 64 * 1024
const RUNTIME_BUILDS = new Map()

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new ProtocolError(`${label} 含有未知字段`, unknown)
}

function text(value, label, maximumBytes = MAXIMUM_TASK_TEXT_BYTES) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError(`${label} 必须是非空字符串`)
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new ProtocolError(`${label} 超过 ${maximumBytes} 字节上限`)
  }
  return value.trim()
}

function safeSegment(value, label) {
  const normalized = text(value, label, 128)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new ProtocolError(`${label} 不是安全标识：${value}`)
  }
  return normalized
}

function assertInside(root, pathValue, label) {
  const rel = relative(root, pathValue)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 逃逸受控目录`)
  }
}

function normalizeAnswer(value) {
  let normalized = String(value ?? '').normalize('NFKC').trim()
  const final = normalized.match(/<final>\s*([\s\S]*?)\s*<\/final>/iu)
  if (final) normalized = final[1].trim()
  const answer = normalized.match(/(?:^|\n)\s*Answer\s*:\s*([^\n]+)/iu)
  if (answer) normalized = answer[1].trim()
  normalized = normalized
    .replace(/^\s*[`"']+|[`"']+\s*$/gu, '')
    .replace(/[\s\u00a0]+/gu, ' ')
    .replace(/[.。]\s*$/u, '')
    .trim()
    .toLocaleLowerCase('en-US')
  return normalized
}

function validateTaskDocument(input, benchmark) {
  const document = object(input, 'Synthetic Reasoning Task 文档')
  rejectUnknown(document, new Set(['apiVersion', 'kind', 'metadata', 'instances']), 'Synthetic Reasoning Task 文档')
  if (document.apiVersion !== TASKS_API_VERSION || document.kind !== TASKS_KIND) {
    throw new ProtocolError('Synthetic Reasoning Task 文档协议无效')
  }
  const metadata = object(document.metadata, 'Synthetic Reasoning Task.metadata')
  rejectUnknown(metadata, new Set(['id', 'notice']), 'Synthetic Reasoning Task.metadata')
  text(metadata.id, 'Synthetic Reasoning Task.metadata.id', 128)
  text(metadata.notice, 'Synthetic Reasoning Task.metadata.notice', 4096)
  if (!Array.isArray(document.instances) || document.instances.length === 0) {
    throw new ProtocolError('Synthetic Reasoning Task.instances 必须是非空数组')
  }
  const tasks = new Map()
  for (const [index, raw] of document.instances.entries()) {
    const label = `Synthetic Reasoning Task.instances[${index}]`
    const task = object(raw, label)
    rejectUnknown(task, new Set(['id', 'partition', 'instruction', 'answer']), label)
    const id = safeSegment(task.id, `${label}.id`)
    const partition = text(task.partition, `${label}.partition`, 32)
    if (!PARTITIONS.has(partition)) throw new ProtocolError(`${label}.partition 无效`)
    if (tasks.has(id)) throw new ProtocolError(`Synthetic Reasoning Task ID 重复：${id}`)
    const benchmarkPartition = benchmark.partitionByInstance.get(id)
    if (benchmarkPartition !== partition) {
      throw new ProtocolError(`Synthetic Reasoning Task 与 Benchmark Partition 不一致：${id}`, [
        `task=${partition}`,
        `benchmark=${benchmarkPartition ?? '(missing)'}`,
      ])
    }
    const answer = text(task.answer, `${label}.answer`, 4096)
    const normalizedAnswer = normalizeAnswer(answer)
    if (!normalizedAnswer) throw new ProtocolError(`${label}.answer 归一化后为空`)
    tasks.set(id, Object.freeze({
      id,
      partition,
      instruction: text(task.instruction, `${label}.instruction`),
      answer,
      normalizedAnswer,
    }))
  }
  const missing = [...benchmark.allInstanceIds].filter((id) => !tasks.has(id))
  const extra = [...tasks.keys()].filter((id) => !benchmark.allInstanceIds.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new ProtocolError('Synthetic Reasoning Task 与 Benchmark Instance 集合不一致', [
      ...missing.map((id) => `missing=${id}`),
      ...extra.map((id) => `extra=${id}`),
    ])
  }
  return tasks
}

async function readTrustedTaskFile(pathValue, expectedDigest, benchmark) {
  const info = await lstat(pathValue).catch((error) => {
    throw new ProtocolError(`Synthetic Reasoning Task 文件不存在：${pathValue}`, [error.message])
  })
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ProtocolError('Synthetic Reasoning Task 必须是普通文件')
  }
  if (info.size < 1 || info.size > MAXIMUM_TASK_FILE_BYTES) {
    throw new ProtocolError('Synthetic Reasoning Task 文件大小无效')
  }
  const source = await readFile(pathValue)
  const actualDigest = sha256(source)
  if (actualDigest !== expectedDigest) {
    throw new ProtocolError('Synthetic Reasoning Task 摘要与 Environment Adapter 不一致', [
      `expected=${expectedDigest}`,
      `actual=${actualDigest}`,
    ])
  }
  let document
  try {
    document = JSON.parse(source.toString('utf8'))
  } catch (error) {
    throw new ProtocolError('Synthetic Reasoning Task JSON 格式错误', [error.message])
  }
  return { tasks: validateTaskDocument(document, benchmark), digest: actualDigest }
}

function trialRecord({ task, partition, trials, runRoot }) {
  const meanReward = trials.reduce((sum, trial) => sum + trial.reward, 0) / trials.length
  const anyError = trials.some((trial) => trial.error)
  const usageComplete = trials.every(
    (trial) => Number.isFinite(trial.inputTokens) && Number.isFinite(trial.outputTokens),
  )
  const record = {
    instance_id: task.id,
    status: anyError ? 'error' : meanReward === 1 ? 'resolved' : 'unresolved',
    reward: meanReward,
    trial_rewards: trials.map((trial) => trial.reward),
    trial_seeds: trials.map((trial) => trial.seed),
    seed_controlled: false,
    ...(usageComplete
      ? {
          input_tokens: trials.reduce((sum, trial) => sum + trial.inputTokens, 0),
          output_tokens: trials.reduce((sum, trial) => sum + trial.outputTokens, 0),
        }
      : {}),
    latency_ms: trials.reduce((sum, trial) => sum + trial.durationMs, 0),
    policy_violations: [],
    artifacts: trials.map((trial) => ({
      seed: trial.seed,
      root: relative(runRoot, trial.trialRoot).replaceAll('\\', '/'),
    })),
  }
  if (partition === 'feedback') {
    record.feedback = {
      taskInstruction: task.instruction,
      solverAnswer: trials.map((trial) => trial.answer).join('\n\n'),
      verifierFeedback: trials.map((trial) => trial.error
        ? `Solver 运行失败：${trial.error}`
        : trial.reward === 1
          ? '归一化答案匹配可信标准答案。'
          : `归一化答案不匹配。期望答案：${task.answer}`)
        .join('\n\n'),
      errors: trials.flatMap((trial) => trial.error ? [trial.error] : []),
    }
  }
  return record
}

/**
 * 只用于证明 Target -> Solver -> Evaluator -> Population 链路可运行的合成 Reasoning 环境。
 * 它不是 HLE、不是能力 Benchmark，也不应用于对外声称 Reasoning 能力提升。
 */
export class TextReasoningEnvironment {
  constructor({
    environment,
    benchmark,
    solverDriver,
    docker,
    runRoot,
    repositoryRoot = REPOSITORY_ROOT,
  }) {
    this.environment = environment
    this.benchmark = benchmark
    this.solverDriver = solverDriver
    this.docker = docker
    this.runRoot = runRoot
    this.repositoryRoot = repositoryRoot
    this.tasks = null
    this.sourceRevision = null
    this.runtimeImage = null
  }

  async preflight() {
    const tasksPath = resolveInside(
      this.repositoryRoot,
      this.environment.source.tasksPath,
      'Synthetic Reasoning Task 路径',
    )
    const trusted = await readTrustedTaskFile(
      tasksPath,
      this.environment.source.digest,
      this.benchmark,
    )
    if (this.benchmark.source.revision !== trusted.digest) {
      throw new ProtocolError('Benchmark Revision 与 Synthetic Reasoning Task 摘要不一致', [
        `benchmark=${this.benchmark.source.revision}`,
        `tasks=${trusted.digest}`,
      ])
    }
    await this.docker.info()
    if (!(await this.docker.imageExists(this.environment.runtime.baseImage))) {
      throw new ProtocolError('Synthetic Reasoning 的固定 Base Image 未安装', [
        `image=${this.environment.runtime.baseImage}`,
        '请先用 docker pull 拉取该 Digest。',
      ])
    }
    this.tasks = trusted.tasks
    this.sourceRevision = trusted.digest
    return { sourceRoot: await realpath(resolve(tasksPath, '..')), sourceRevision: trusted.digest }
  }

  async taskLayout(instanceId) {
    if (!this.tasks) throw new ProtocolError('必须先执行 Synthetic Reasoning preflight')
    const task = this.tasks.get(safeSegment(instanceId, 'Synthetic Reasoning Instance ID'))
    if (!task) throw new ProtocolError(`Synthetic Reasoning Task 不存在：${instanceId}`)
    return Object.freeze({ instanceId: task.id, partition: task.partition, instruction: task.instruction })
  }

  async ensureRuntime() {
    if (this.runtimeImage) return this.runtimeImage
    const baseImageIdentity = await this.docker.imageId(this.environment.runtime.baseImage)
    const tag = safeDockerName(
      `${this.environment.runtime.imagePrefix}-${this.solverDriver.cacheKey}-${this.sourceRevision.slice(0, 12)}`,
    )
    if (!RUNTIME_BUILDS.has(tag)) {
      const build = this.solverDriver.ensureRuntime({
        baseImage: this.environment.runtime.baseImage,
        baseImageIdentity,
        tag,
      }).finally(() => RUNTIME_BUILDS.delete(tag))
      RUNTIME_BUILDS.set(tag, build)
    }
    // Population 的多个 Branch 会并行做 Baseline；同一派生镜像只构建一次。
    const runtime = await RUNTIME_BUILDS.get(tag)
    this.runtimeImage = runtime.image
    return this.runtimeImage
  }

  async runTrial({ candidateId, candidateWorkspace, task, model, partition, seed, trialIndex, executionId }) {
    const trialRoot = join(
      this.runRoot,
      'trials',
      executionId,
      safeSegment(candidateId, 'Candidate ID'),
      partition,
      task.id,
      `trial-${trialIndex + 1}-seed-${seed}`,
    )
    assertInside(this.runRoot, trialRoot, 'Synthetic Reasoning Trial')
    const taskWorkspace = join(trialRoot, 'workspace')
    const environmentAssets = join(trialRoot, 'environment-assets')
    const sessionRoot = join(trialRoot, 'solver-session')
    await Promise.all([
      mkdir(taskWorkspace, { recursive: true, mode: 0o700 }),
      mkdir(environmentAssets, { recursive: true, mode: 0o700 }),
    ])
    const startedAt = Date.now()
    try {
      const solver = await this.solverDriver.run({
        image: await this.ensureRuntime(),
        model,
        candidateWorkspace,
        taskWorkspace,
        environmentAssets,
        sessionRoot,
        task: task.instruction,
        name: `${executionId}-${candidateId}-${task.id}-${seed}-solver`,
        timeoutMs: this.environment.docker.resources.timeoutSeconds * 1000,
        containerWorkspace: this.environment.task.workspacePath,
      })
      const answer = solver.answer ?? ''
      const reward = normalizeAnswer(answer) === task.normalizedAnswer ? 1 : 0
      return {
        seed,
        answer,
        reward,
        error: null,
        durationMs: solver.durationMs ?? Date.now() - startedAt,
        inputTokens: solver.modelUsage?.complete ? solver.modelUsage.inputTokens : null,
        outputTokens: solver.modelUsage?.complete ? solver.modelUsage.outputTokens : null,
        trialRoot,
      }
    } catch (cause) {
      // Runtime、Docker、Gateway 或 Provider 失败不是“模型答错”，不能被伪装成 0 分。
      throw new ProtocolError('Synthetic Reasoning Solver 基础设施失败', [
        cause?.message ?? String(cause),
        ...(cause?.details ?? []),
        `candidate=${candidateId}`,
        `partition=${partition}`,
        `task=${task.id}`,
      ])
    }
  }

  async runCandidatePartition({ candidateId, candidateWorkspace, model, partition, seeds, outputPath }) {
    if (!this.tasks) throw new ProtocolError('必须先执行 Synthetic Reasoning preflight')
    const partitionSpec = this.benchmark.partitions[partition]
    if (!partitionSpec) throw new ProtocolError(`Benchmark 不存在 Partition：${partition}`)
    const candidate = await realpath(resolve(candidateWorkspace)).catch((error) => {
      throw new ProtocolError(`Candidate Workspace 不存在：${candidateWorkspace}`, [error.message])
    })
    const executionId = sha256(resolve(outputPath)).slice(0, 12)
    const records = []
    for (const instanceId of partitionSpec.instanceIds) {
      const task = this.tasks.get(instanceId)
      const trials = []
      for (const [trialIndex, seed] of seeds.entries()) {
        trials.push(await this.runTrial({
          candidateId,
          candidateWorkspace: candidate,
          task,
          model,
          partition,
          seed,
          trialIndex,
          executionId,
        }))
      }
      records.push(trialRecord({ task, partition, trials, runRoot: this.runRoot }))
    }
    await writeJsonLines(outputPath, records)
    return validateResultRecords(records, this.benchmark, `${candidateId}/${partition}`)
  }
}

export const TEXT_REASONING_ANSWER_NORMALIZATION = 'trim-collapse-casefold-v1'
