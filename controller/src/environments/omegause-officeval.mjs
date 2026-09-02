import { constants as fsConstants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { writeJsonLines } from '../candidate.mjs'
import { assertPathKind, resolveInside } from '../config.mjs'
import { safeDockerName } from '../docker.mjs'
import { ProtocolError, validateResultRecords } from '../protocol.mjs'
import { runProcess } from '../process.mjs'
import {
  commitTrialCheckpoint,
  inspectTrialCheckpoint,
  quarantineTrialTask,
} from '../trial-checkpoint-store.mjs'

const INSTANCE_ID = /^officeval_[0-9]{3}$/u
const MANIFEST_API_VERSION = 'harness-rsi/omegause-officeval-manifest-v1'
const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024
const MAXIMUM_RESULT_BYTES = 4 * 1024 * 1024
const RUNTIME_BUILDS = new Map()
const STANDARD_PROXY_ENVIRONMENT = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  return value
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new ProtocolError(`${label} 不是安全标识：${value}`)
  }
  return value
}

function assertInside(root, pathValue, label) {
  const rel = relative(root, pathValue)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 逃逸受控目录：${pathValue}`)
  }
}

async function fileSha256(pathValue) {
  return await new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(pathValue)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveDigest(hash.digest('hex')))
  })
}

async function regularFile(pathValue, label, maximumBytes = Infinity) {
  const info = await lstat(pathValue).catch((error) => {
    throw new ProtocolError(`${label} 不存在：${pathValue}`, [error.message])
  })
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new ProtocolError(`${label} 必须是独立普通文件：${pathValue}`)
  }
  if (info.size < 1 || info.size > maximumBytes) {
    throw new ProtocolError(`${label} 文件大小无效`, [`bytes=${info.size}`, `maximum=${maximumBytes}`])
  }
  return info
}

async function resolveRootFromEnvironment(name, label) {
  const configured = process.env[name]
  if (!configured) throw new ProtocolError(`缺少 ${label} 环境变量：${name}`)
  const root = await realpath(resolve(configured)).catch((error) => {
    throw new ProtocolError(`${label} 不存在：${configured}`, [error.message])
  })
  await assertPathKind(root, label)
  return root
}

async function currentGitRevision(root, label) {
  const revision = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  const status = await runProcess(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'],
    { timeoutMs: 30_000 },
  )
  if (status.stdout.trim()) throw new ProtocolError(`${label} 存在未提交文件，拒绝评测`)
  return revision.stdout.trim()
}

function manifestFileRecord(value, label) {
  const record = object(value, label)
  if (typeof record.path !== 'string' || record.path.startsWith('/') || record.path.includes('..')) {
    throw new ProtocolError(`${label}.path 不是安全相对路径`)
  }
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 1) {
    throw new ProtocolError(`${label}.bytes 必须是正整数`)
  }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sha256)) {
    throw new ProtocolError(`${label}.sha256 必须是完整 SHA-256`)
  }
  return Object.freeze({ path: record.path, bytes: record.bytes, sha256: record.sha256 })
}

export function validateOmegaUseSourceManifest(input) {
  const manifest = object(input, 'OmegaUse Source Manifest')
  if (manifest.apiVersion !== MANIFEST_API_VERSION) {
    throw new ProtocolError(`OmegaUse Source Manifest apiVersion 必须是 ${MANIFEST_API_VERSION}`)
  }
  const dataset = object(manifest.dataset, 'OmegaUse Source Manifest.dataset')
  const evaluator = object(manifest.evaluator, 'OmegaUse Source Manifest.evaluator')
  const platform = object(manifest.platform, 'OmegaUse Source Manifest.platform')
  const rawInstances = object(manifest.instances, 'OmegaUse Source Manifest.instances')
  if (!/^[0-9a-f]{40}$/u.test(dataset.revision ?? '') || !/^[0-9a-f]{40}$/u.test(evaluator.revision ?? '')) {
    throw new ProtocolError('OmegaUse Source Manifest Revision 无效')
  }
  const excluded = new Set(platform.excludedComRequired)
  if (excluded.size !== 9 || [...excluded].some((id) => !INSTANCE_ID.test(id))) {
    throw new ProtocolError('OmegaUse Source Manifest COM 排除列表无效')
  }
  if (!Array.isArray(evaluator.sharedFiles) || evaluator.sharedFiles.length < 1) {
    throw new ProtocolError('OmegaUse Source Manifest 缺少共享 Verifier 文件')
  }
  const sharedFiles = evaluator.sharedFiles.map((entry, index) =>
    manifestFileRecord(entry, `OmegaUse Source Manifest.evaluator.sharedFiles[${index}]`))
  const instances = new Map()
  for (const [id, raw] of Object.entries(rawInstances)) {
    if (!INSTANCE_ID.test(id)) throw new ProtocolError(`OmegaUse Source Manifest Instance ID 无效：${id}`)
    const record = object(raw, `OmegaUse Source Manifest.instances.${id}`)
    if (record.comRequired !== excluded.has(id)) {
      throw new ProtocolError(`OmegaUse Source Manifest COM 标记不一致：${id}`)
    }
    if (!Array.isArray(record.inputs) || record.inputs.length < 1) {
      throw new ProtocolError(`OmegaUse Source Manifest Task 缺少输入文件：${id}`)
    }
    instances.set(id, Object.freeze({
      id,
      comRequired: record.comRequired,
      task: manifestFileRecord(record.task, `${id}.task`),
      rubric: manifestFileRecord(record.rubric, `${id}.rubric`),
      inputs: record.inputs.map((entry, index) => manifestFileRecord(entry, `${id}.inputs[${index}]`)),
      verifier: manifestFileRecord(record.verifier, `${id}.verifier`),
    }))
  }
  if (instances.size !== 100 || [...instances.keys()].some((id) => !rawInstances[id])) {
    throw new ProtocolError('OmegaUse Source Manifest 必须完整包含 100 道题')
  }
  return Object.freeze({
    datasetRevision: dataset.revision,
    evaluatorRevision: evaluator.revision,
    sharedFiles,
    instances,
    excluded,
  })
}

async function loadManifest(repositoryRoot, environment, benchmark) {
  const pathValue = resolveInside(repositoryRoot, environment.source.manifestPath, 'OmegaUse Source Manifest')
  await regularFile(pathValue, 'OmegaUse Source Manifest', MAXIMUM_MANIFEST_BYTES)
  const source = await readFile(pathValue)
  const digest = sha256(source)
  if (digest !== environment.source.manifestDigest || digest !== benchmark.source.revision) {
    throw new ProtocolError('OmegaUse Source Manifest 摘要与冻结配置不一致', [
      `actual=${digest}`,
      `environment=${environment.source.manifestDigest}`,
      `benchmark=${benchmark.source.revision}`,
    ])
  }
  let parsed
  try {
    parsed = JSON.parse(source.toString('utf8'))
  } catch (error) {
    throw new ProtocolError('OmegaUse Source Manifest JSON 无效', [error.message])
  }
  return { digest, path: pathValue, manifest: validateOmegaUseSourceManifest(parsed) }
}

async function verifyManifestFile(root, record, label) {
  const pathValue = resolve(root, record.path)
  assertInside(root, pathValue, label)
  const info = await regularFile(pathValue, label)
  const actual = await realpath(pathValue)
  assertInside(root, actual, label)
  if (info.size !== record.bytes) {
    throw new ProtocolError(`${label} 字节数与 Source Manifest 不一致`)
  }
  const digest = await fileSha256(actual)
  if (digest !== record.sha256) {
    throw new ProtocolError(`${label} 摘要与 Source Manifest 不一致`, [
      `expected=${record.sha256}`,
      `actual=${digest}`,
    ])
  }
  return actual
}

async function snapshotWorkspace(root, limits) {
  const files = new Map()
  let entriesSeen = 0
  let totalBytes = 0
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > limits.maximumFiles) throw new ProtocolError('Trial 工作区目录项数超限')
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).replaceAll('\\', '/')
      const info = await lstat(absolute)
      if (info.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (info.isSymbolicLink()) {
        files.set(path, { path, kind: 'symlink', bytes: 0 })
        continue
      }
      if (!info.isFile()) {
        files.set(path, { path, kind: 'special', bytes: 0 })
        continue
      }
      if (info.size > limits.maximumFileBytes) throw new ProtocolError(`Trial 单文件超限：${path}`)
      totalBytes += info.size
      if (totalBytes > limits.maximumBytes) throw new ProtocolError('Trial 工作区总字节数超限')
      files.set(path, { path, kind: 'file', bytes: info.size, sha256: await fileSha256(absolute) })
    }
  }
  await visit(root)
  return files
}

function changedArtifacts(before, after) {
  const output = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(path)
    const current = after.get(path)
    if (!previous && current) output.push({ change: 'added', ...current })
    else if (previous && !current) output.push({ change: 'deleted', ...previous })
    else if (JSON.stringify(previous) !== JSON.stringify(current)) output.push({ change: 'modified', ...current })
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function artifactPolicyViolation(artifacts, limits) {
  if (artifacts.length > limits.maximumChangedFiles) return 'solver-artifact-count'
  const bytes = artifacts
    .filter((artifact) => artifact.change !== 'deleted')
    .reduce((sum, artifact) => sum + artifact.bytes, 0)
  if (bytes > limits.maximumChangedBytes) return 'solver-artifact-bytes'
  if (artifacts.some((artifact) => artifact.change !== 'deleted' && artifact.kind !== 'file')) {
    return 'solver-unsafe-artifact'
  }
  return null
}

async function materializeInputs(layout, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 })
  for (const input of layout.inputs) {
    const target = join(destination, input.name)
    assertInside(destination, target, 'Task Input')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(input.source, target)
    const info = await regularFile(target, '已物化 Task Input')
    if (info.size !== input.record.bytes || await fileSha256(target) !== input.record.sha256) {
      throw new ProtocolError(`Task Input 物化后摘要不一致：${input.name}`)
    }
  }
}

async function materializeSubmission(workspace, artifacts, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 })
  for (const artifact of artifacts) {
    if (artifact.change === 'deleted') continue
    const source = resolve(workspace, artifact.path)
    const target = resolve(destination, artifact.path)
    assertInside(workspace, source, 'Solver Artifact')
    assertInside(destination, target, 'Verifier Submission')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(source, target)
    if (await fileSha256(target) !== artifact.sha256) {
      throw new ProtocolError(`Verifier Submission 物化后摘要不一致：${artifact.path}`)
    }
  }
}

async function readResult(pathValue) {
  let handle
  try {
    handle = await open(pathValue, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > MAXIMUM_RESULT_BYTES) {
      throw new Error('不是大小合规的独立普通文件')
    }
    return JSON.parse((await handle.readFile()).toString('utf8'))
  } catch (error) {
    throw new ProtocolError('OmegaUse Verifier Result 不安全或不可读', [error.message])
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function normalizeOmegaUseVerifierReward(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProtocolError('OmegaUse Verifier Result 不是对象')
  }
  if (!['ok', 'error'].includes(result.status) || typeof result.dim1_pass !== 'boolean') {
    throw new ProtocolError('OmegaUse Verifier Result 状态字段无效')
  }
  if (!Array.isArray(result.dim2_items)) throw new ProtocolError('OmegaUse Verifier dim2_items 无效')
  const total = result.total_score
  const maximum = result.max_score
  if (![total, maximum].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new ProtocolError('OmegaUse Verifier 分数字段无效')
  }
  if (result.status === 'error' || !result.dim1_pass) return 0
  if (maximum <= 0) throw new ProtocolError('OmegaUse Verifier max_score 必须为正数')
  return Math.max(0, Math.min(1, total / maximum))
}

function compactText(value, maximumBytes) {
  const source = String(value ?? '')
  if (Buffer.byteLength(source, 'utf8') <= maximumBytes) return source
  const suffix = '\n[内容因反馈预算被截断]'
  const maximum = Math.max(0, maximumBytes - Buffer.byteLength(suffix, 'utf8'))
  let text = source
  while (Buffer.byteLength(text, 'utf8') > maximum) text = text.slice(0, Math.floor(text.length * 0.9))
  return `${text}${suffix}`
}

function verifierFeedback(result, maximumBytes) {
  const lines = [
    `status=${result.status}`,
    `dim1_pass=${result.dim1_pass}`,
    `dim1_reason=${result.dim1_reason || '(none)'}`,
    `score=${result.total_score}/${result.max_score}`,
  ]
  if (result.error) lines.push(`error=${result.error}`)
  for (const [index, item] of result.dim2_items.entries()) {
    if (!item || typeof item !== 'object') continue
    lines.push(
      `rubric[${index + 1}] hit=${Boolean(item.hit)} delta=${item.delta ?? 0}/${item.max_delta ?? 0}`
      + ` rule=${item.rule ?? ''} detail=${item.detail ?? ''}`,
    )
  }
  return compactText(lines.join('\n'), maximumBytes)
}

function trustedTaskInstruction(task, inputNames) {
  return [
    task.instruction.trim(),
    '',
    'Execution contract:',
    `- The current workspace already contains these input files: ${inputNames.join(', ')}.`,
    '- Create or modify the requested editable Office deliverable in the current workspace.',
    '- The final deliverable must be a regular .docx, .xlsx, .xlsm, .pptx, or .pdf file.',
    '- Do not only describe the answer in chat; the saved file is what will be evaluated.',
    '- Do not use the network or inspect evaluator, rubric, answer, or files outside the workspace.',
  ].join('\n')
}

async function runtimeDefinitionDigest(repositoryRoot, environment) {
  const files = [environment.runtime.dockerfile, environment.runtime.verifierRunner]
  const hash = createHash('sha256')
  for (const path of files) {
    const actual = resolveInside(repositoryRoot, path, `OmegaUse Runtime 文件 ${path}`)
    await regularFile(actual, `OmegaUse Runtime 文件 ${path}`)
    hash.update(path).update('\0').update(await readFile(actual)).update('\0')
  }
  return hash.digest('hex')
}

function recordForTask({ layout, partition, trials, runRoot, feedbackLimit }) {
  const meanReward = trials.reduce((sum, trial) => sum + trial.reward, 0) / trials.length
  const usageComplete = trials.every(
    (trial) => Number.isFinite(trial.inputTokens) && Number.isFinite(trial.outputTokens),
  )
  const violations = [...new Set(trials.flatMap((trial) => trial.policyViolations))]
  const record = {
    instance_id: layout.instanceId,
    status: meanReward >= 1 ? 'resolved' : 'unresolved',
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
    latency_ms: trials.reduce((sum, trial) => sum + trial.latencyMs, 0),
    policy_violations: violations,
    artifacts: trials.map((trial) => ({
      seed: trial.seed,
      root: relative(runRoot, trial.trialRoot).replaceAll('\\', '/'),
      changed: trial.artifacts,
    })),
  }
  if (partition === 'feedback') {
    record.feedback = {
      taskInstruction: compactText(layout.task.instruction, feedbackLimit),
      solverAnswer: compactText(trials.map((trial) => trial.solverAnswer).join('\n\n'), feedbackLimit),
      verifierFeedback: compactText(trials.map((trial) => trial.verifierFeedback).join('\n\n'), feedbackLimit),
      errors: [],
    }
  }
  return record
}

export class OmegaUseOfficeValEnvironment {
  constructor({ environment, benchmark, solverDriver, docker, runRoot, repositoryRoot }) {
    this.environment = environment
    this.benchmark = benchmark
    this.solverDriver = solverDriver
    this.docker = docker
    this.runRoot = runRoot
    this.repositoryRoot = repositoryRoot
    this.datasetRoot = null
    this.evaluatorRoot = null
    this.manifest = null
    this.sourceRevision = null
    this.baseImage = null
    this.solverImage = null
    this.runtimeRevision = null
    this.runtimeByScope = new Map()
  }

  async preflight() {
    const loaded = await loadManifest(this.repositoryRoot, this.environment, this.benchmark)
    const [datasetRoot, evaluatorRoot] = await Promise.all([
      resolveRootFromEnvironment(this.environment.source.datasetRootEnvironment, 'OmegaUse Dataset Root'),
      resolveRootFromEnvironment(this.environment.source.evaluatorRootEnvironment, 'OmegaUse Evaluator Root'),
    ])
    const evaluatorRevision = await currentGitRevision(evaluatorRoot, 'OmegaUse Evaluator')
    if (
      loaded.manifest.datasetRevision !== this.environment.source.datasetRevision
      || loaded.manifest.evaluatorRevision !== this.environment.source.evaluatorRevision
      || evaluatorRevision !== this.environment.source.evaluatorRevision
    ) {
      throw new ProtocolError('OmegaUse Source Revision 与 Environment Adapter 不一致', [
        `dataset-manifest=${loaded.manifest.datasetRevision}`,
        `dataset-config=${this.environment.source.datasetRevision}`,
        `evaluator-checkout=${evaluatorRevision}`,
        `evaluator-config=${this.environment.source.evaluatorRevision}`,
      ])
    }
    const benchmarkIds = [...this.benchmark.allInstanceIds]
    const unsupported = benchmarkIds.filter((id) => loaded.manifest.instances.get(id)?.comRequired)
    if (unsupported.length > 0) {
      throw new ProtocolError('Linux OmegaUse Benchmark 不能包含 Office COM 任务', unsupported)
    }
    const missing = benchmarkIds.filter((id) => !loaded.manifest.instances.has(id))
    if (missing.length > 0) throw new ProtocolError('Benchmark 包含未知 OmegaUse Task', missing)
    await this.docker.info()
    this.datasetRoot = datasetRoot
    this.evaluatorRoot = evaluatorRoot
    this.manifest = loaded.manifest
    this.sourceRevision = loaded.digest
    return { sourceRoot: datasetRoot, sourceRevision: loaded.digest }
  }

  async taskLayout(instanceId) {
    if (!this.manifest) throw new ProtocolError('必须先执行 OmegaUse-OfficeVal preflight')
    if (!INSTANCE_ID.test(instanceId)) throw new ProtocolError(`OmegaUse Instance ID 无效：${instanceId}`)
    const record = this.manifest.instances.get(instanceId)
    if (!record || record.comRequired) throw new ProtocolError(`当前平台不支持 OmegaUse Task：${instanceId}`)
    const [taskPath, rubricPath, verifierPath, ...sharedPaths] = await Promise.all([
      verifyManifestFile(this.datasetRoot, record.task, `${instanceId} Task`),
      verifyManifestFile(this.datasetRoot, record.rubric, `${instanceId} Rubric`),
      verifyManifestFile(this.evaluatorRoot, record.verifier, `${instanceId} Verifier`),
      ...this.manifest.sharedFiles.map((entry) =>
        verifyManifestFile(this.evaluatorRoot, entry, `${instanceId} Shared Verifier File`)),
    ])
    const inputs = await Promise.all(record.inputs.map(async (input) => ({
      record: input,
      source: await verifyManifestFile(this.datasetRoot, input, `${instanceId} Input`),
      name: relative(`task_files/${instanceId}`, input.path).replaceAll('\\', '/'),
    })))
    if (inputs.some((input) => input.name === '..' || input.name.startsWith('../') || isAbsolute(input.name))) {
      throw new ProtocolError(`OmegaUse Task Input 路径无效：${instanceId}`)
    }
    let task
    try {
      task = JSON.parse(await readFile(taskPath, 'utf8'))
    } catch (error) {
      throw new ProtocolError(`OmegaUse Task JSON 无效：${instanceId}`, [error.message])
    }
    if (task.id !== instanceId || typeof task.instruction !== 'string' || task.instruction.trim().length === 0) {
      throw new ProtocolError(`OmegaUse Task 定义无效：${instanceId}`)
    }
    const environmentAssets = resolveInside(
      this.repositoryRoot,
      this.environment.task.environmentAssets,
      'OmegaUse Environment Assets',
    )
    await assertPathKind(environmentAssets, 'OmegaUse Environment Assets')
    return Object.freeze({
      instanceId,
      record,
      task,
      taskPath,
      rubricPath,
      verifierPath,
      sharedFiles: sharedPaths.map((source, index) => Object.freeze({
        source,
        record: this.manifest.sharedFiles[index],
      })),
      inputs,
      environmentAssets,
    })
  }

  async ensureRuntime() {
    const scopeKey = this.docker.scopeKey?.() ?? 'default'
    if (this.runtimeByScope.has(scopeKey)) return this.runtimeByScope.get(scopeKey)
    const digest = this.runtimeRevision ?? await runtimeDefinitionDigest(this.repositoryRoot, this.environment)
    const labels = {
      'io.harness-rsi.runtime': 'omegause-officeval-linux-v1',
      'io.harness-rsi.officeval-runtime-revision': digest,
    }
    const tag = this.environment.runtime.image
    const buildKey = `${scopeKey}\0${tag}`
    const current = await this.docker.imageExists(tag)
      && (await Promise.all(Object.keys(labels).map((label) => this.docker.imageLabel(tag, label))))
        .every((value, index) => value === Object.values(labels)[index])
    if (!current) {
      if (!RUNTIME_BUILDS.has(buildKey)) {
        RUNTIME_BUILDS.set(buildKey, this.docker.build({
          context: this.repositoryRoot,
          dockerfile: resolveInside(this.repositoryRoot, this.environment.runtime.dockerfile, 'OmegaUse Dockerfile'),
          tag,
          buildArgs: { OFFICEVAL_RUNTIME_REVISION: digest },
          labels,
        }).finally(() => RUNTIME_BUILDS.delete(buildKey)))
      }
      await RUNTIME_BUILDS.get(buildKey)
    }
    const identity = await this.docker.imageId(tag)
    const solverTag = safeDockerName(`${tag}-msa-${this.solverDriver.cacheKey}-${digest.slice(0, 12)}`)
    const runtime = await this.solverDriver.ensureRuntime({
      baseImage: tag,
      baseImageIdentity: identity,
      tag: solverTag,
    })
    this.baseImage = tag
    this.solverImage = runtime.image
    this.runtimeRevision = digest
    const result = Object.freeze({ baseImage: tag, solverImage: runtime.image })
    this.runtimeByScope.set(scopeKey, result)
    return result
  }

  async runVerifier({ image, layout, submission, logs, verifierCode, name }) {
    await Promise.all([
      mkdir(logs, { recursive: false, mode: 0o700 }),
      mkdir(verifierCode, { recursive: false, mode: 0o700 }),
    ])
    const stagedVerifier = join(verifierCode, basename(layout.verifierPath))
    await copyFile(layout.verifierPath, stagedVerifier)
    for (const shared of layout.sharedFiles) {
      const staged = join(verifierCode, basename(shared.source))
      await copyFile(shared.source, staged)
      if (await fileSha256(staged) !== shared.record.sha256) {
        throw new ProtocolError(`OmegaUse 共享 Verifier 文件 staging 后摘要不一致：${basename(shared.source)}`)
      }
    }
    if (await fileSha256(stagedVerifier) !== layout.record.verifier.sha256) {
      throw new ProtocolError('OmegaUse Verifier staging 后摘要不一致')
    }
    const output = join(logs, 'result.json')
    const proxyEnvironment = Object.fromEntries(STANDARD_PROXY_ENVIRONMENT.map((key) => [key, '']))
    await this.docker.run({
      image,
      name,
      command: [
        'python',
        '/opt/harness-rsi/run-officeval-verifier.py',
        '--verifier',
        `/verifier/${basename(stagedVerifier)}`,
        '--submission',
        '/submission',
        '--output',
        '/logs/result.json',
        '--expected-id',
        layout.instanceId,
      ],
      workdir: '/submission',
      mounts: [
        { source: submission, target: '/submission', readOnly: true },
        { source: verifierCode, target: '/verifier', readOnly: true },
        { source: logs, target: '/logs', readOnly: false },
      ],
      environment: {
        HOME: '/tmp/home',
        TMPDIR: '/tmp',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONSAFEPATH: '1',
        PYTHONPATH: '',
        ...proxyEnvironment,
      },
      inheritEnvironment: [],
      network: 'none',
      runAsCurrentUser: true,
      readOnlyRoot: true,
      capabilities: [],
      timeoutMs: this.environment.verifier.timeoutSeconds * 1000,
      resources: this.environment.verifier.resources,
    })
    return await readResult(output)
  }

  async runTrial(options) {
    if (!this.docker.withTaskSession) return await this.runTrialInCurrentSession(options)
    return await this.docker.withTaskSession(async () => {
      try {
        return await this.runTrialInCurrentSession(options)
      } finally {
        try {
          await this.solverDriver.cleanupRuntimeScope?.()
        } finally {
          this.runtimeByScope.delete(this.docker.scopeKey())
        }
      }
    })
  }

  async runTrialInCurrentSession({ candidateId, candidateWorkspace, layout, model, partition, seed, trialIndex, executionId }) {
    const trialRoot = join(
      this.runRoot,
      'trials',
      executionId,
      safeSegment(candidateId, 'Candidate ID'),
      partition,
      layout.instanceId,
      `trial-${trialIndex + 1}-seed-${seed}`,
    )
    assertInside(this.runRoot, trialRoot, 'OmegaUse Trial')
    await mkdir(trialRoot, { recursive: true, mode: 0o700 })
    const workspace = join(trialRoot, 'workspace')
    const sessionRoot = join(trialRoot, 'solver-session')
    const submission = join(trialRoot, 'submission')
    const logs = join(trialRoot, 'verifier-logs')
    const verifierCode = join(trialRoot, 'verifier-code')
    await materializeInputs(layout, workspace)
    const before = await snapshotWorkspace(workspace, this.environment.task.workspaceLimits)
    const runtime = await this.ensureRuntime()
    const instruction = trustedTaskInstruction(layout.task, layout.inputs.map((input) => input.name))
    const startedAt = Date.now()
    let solver
    try {
      solver = await this.solverDriver.run({
        image: runtime.solverImage,
        model,
        candidateWorkspace,
        taskWorkspace: workspace,
        environmentAssets: layout.environmentAssets,
        sessionRoot,
        task: instruction,
        name: `${executionId}-${candidateId}-${layout.instanceId}-${seed}-solver`,
        timeoutMs: this.environment.docker.resources.timeoutSeconds * 1000,
        containerWorkspace: this.environment.task.workspacePath,
      })
    } catch (cause) {
      throw new ProtocolError('OmegaUse Solver 基础设施失败', [
        cause?.message ?? String(cause),
        ...(cause?.details ?? []),
        `candidate=${candidateId}`,
        `task=${layout.instanceId}`,
      ])
    }

    let artifacts = []
    let policyViolation = null
    try {
      artifacts = changedArtifacts(before, await snapshotWorkspace(workspace, this.environment.task.workspaceLimits))
      policyViolation = artifactPolicyViolation(artifacts, this.environment.task.workspaceLimits)
    } catch (error) {
      policyViolation = 'solver-artifact-budget'
      await writeFile(join(trialRoot, 'artifact-error.txt'), `${error.message}\n`, 'utf8')
    }

    let result
    if (policyViolation) {
      result = {
        status: 'error',
        error: `Controller 拒绝不安全或超出预算的 Solver Artifact：${policyViolation}`,
        dim1_pass: false,
        dim1_reason: 'Solver Artifact 未进入 Verifier',
        dim2_items: [],
        total_score: 0,
        max_score: 1,
      }
      await mkdir(submission, { recursive: false, mode: 0o700 })
    } else {
      await materializeSubmission(workspace, artifacts, submission)
      try {
        result = await this.runVerifier({
          image: runtime.baseImage,
          layout,
          submission,
          logs,
          verifierCode,
          name: `${executionId}-${candidateId}-${layout.instanceId}-${seed}-verifier`,
        })
      } catch (cause) {
        throw new ProtocolError('OmegaUse Verifier 基础设施失败', [
          cause?.message ?? String(cause),
          ...(cause?.details ?? []),
          `candidate=${candidateId}`,
          `task=${layout.instanceId}`,
        ])
      }
    }
    const reward = normalizeOmegaUseVerifierReward(result)
    const feedback = verifierFeedback(result, this.environment.feedback.maximumTextBytesPerCase)
    await Promise.all([
      writeFile(join(trialRoot, 'solver-answer.txt'), `${solver.answer}\n`, { encoding: 'utf8', mode: 0o600 }),
      writeFile(join(trialRoot, 'artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
      writeFile(join(trialRoot, 'verifier-feedback.txt'), `${feedback}\n`, { encoding: 'utf8', mode: 0o600 }),
    ])
    return {
      seed,
      reward,
      latencyMs: Date.now() - startedAt,
      inputTokens: solver.modelUsage?.complete ? solver.modelUsage.inputTokens : null,
      outputTokens: solver.modelUsage?.complete ? solver.modelUsage.outputTokens : null,
      solverAnswer: solver.answer,
      verifierFeedback: feedback,
      policyViolations: policyViolation ? [policyViolation] : [],
      artifacts,
      trialRoot,
    }
  }

  async runCandidatePartition({
    candidateId,
    candidateDigest,
    candidateWorkspace,
    model,
    partition,
    seeds,
    outputPath,
  }) {
    if (!this.manifest) throw new ProtocolError('必须先执行 OmegaUse-OfficeVal preflight')
    const partitionSpec = this.benchmark.partitions[partition]
    if (!partitionSpec) throw new ProtocolError(`Benchmark 不存在 Partition：${partition}`)
    if (typeof candidateDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(candidateDigest)) {
      throw new ProtocolError(`Candidate ${candidateId} 缺少可用于 Trial Checkpoint 的完整 Digest`)
    }
    const candidate = await realpath(resolve(candidateWorkspace)).catch((error) => {
      throw new ProtocolError(`Candidate Workspace 不存在：${candidateWorkspace}`, [error.message])
    })
    await assertPathKind(candidate, `Candidate ${candidateId} Workspace`)
    const executionId = sha256(resolve(outputPath)).slice(0, 12)
    if (this.docker.withTaskSession) {
      this.runtimeRevision ??= await runtimeDefinitionDigest(this.repositoryRoot, this.environment)
    } else {
      await this.ensureRuntime()
    }
    const plans = await concurrentMap(
      partitionSpec.instanceIds,
      this.environment.task.maximumConcurrentTrials ?? 1,
      async (instanceId) => {
        const layout = await this.taskLayout(instanceId)
        const taskRoot = join(
          this.runRoot,
          'trials',
          executionId,
          safeSegment(candidateId, 'Candidate ID'),
          partition,
          layout.instanceId,
        )
        assertInside(this.runRoot, taskRoot, 'OmegaUse Task Trial')
        const identity = {
          executionId,
          environment: {
            id: this.environment.id,
            protocol: this.environment.protocol,
            sourceRevision: this.sourceRevision,
            runtimeRevision: this.runtimeRevision,
          },
          solver: {
            id: this.solverDriver.id,
            cacheKey: this.solverDriver.cacheKey ?? null,
          },
          candidate: { id: candidateId, digest: candidateDigest },
          partition,
          instanceId,
          seeds: [...seeds],
          model: {
            provider: model.provider,
            model: model.model,
            maxTokens: model.maxTokens,
            reasoningEffort: model.reasoningEffort ?? null,
          },
        }
        const validateCheckpointRecord = async (record) => {
          const normalized = validateResultRecords(
            [record],
            this.benchmark,
            `${candidateId}/${partition}/${instanceId}/checkpoint`,
          )
          if (!normalized.has(instanceId) || record.instance_id !== instanceId
              || JSON.stringify(record.trial_seeds) !== JSON.stringify(seeds)) {
            throw new ProtocolError(`OmegaUse Trial Checkpoint 与 Task/Seed 不一致：${instanceId}`)
          }
          if (!Array.isArray(record.artifacts) || record.artifacts.length !== seeds.length) {
            throw new ProtocolError(`OmegaUse Trial Checkpoint Artifact 数量无效：${instanceId}`)
          }
          for (const [trialIndex, seed] of seeds.entries()) {
            const expectedRoot = join(taskRoot, `trial-${trialIndex + 1}-seed-${seed}`)
            const expectedRelative = relative(this.runRoot, expectedRoot).replaceAll('\\', '/')
            const artifact = record.artifacts[trialIndex]
            if (!artifact || artifact.seed !== seed || artifact.root !== expectedRelative
                || !Array.isArray(artifact.changed)) {
              throw new ProtocolError(`OmegaUse Trial Checkpoint Artifact 身份无效：${instanceId}/${seed}`)
            }
            const info = await lstat(expectedRoot).catch((error) => {
              throw new ProtocolError(`OmegaUse Trial Checkpoint Artifact Root 不存在：${instanceId}/${seed}`, [
                error.message,
              ])
            })
            if (info.isSymbolicLink() || !info.isDirectory()) {
              throw new ProtocolError(`OmegaUse Trial Checkpoint Artifact Root 必须是普通目录：${instanceId}/${seed}`)
            }
          }
          return record
        }
        const checkpoint = await inspectTrialCheckpoint({
          runRoot: this.runRoot,
          taskRoot,
          identity,
          validateRecord: validateCheckpointRecord,
        })
        return { layout, taskRoot, identity, validateCheckpointRecord, checkpoint }
      },
    )
    const pending = plans.filter(({ checkpoint }) => checkpoint.status !== 'committed')
    const freshRecords = new Map()
    let runError
    if (pending.length > 0) {
      await this.solverDriver.beginUsageBatch?.()
      try {
        await concurrentMap(
          pending,
          this.environment.task.maximumConcurrentTrials ?? 1,
          async ({ layout, taskRoot, identity, validateCheckpointRecord, checkpoint }) => {
            if (checkpoint.status !== 'missing') {
              await quarantineTrialTask({
                runRoot: this.runRoot,
                taskRoot,
                reason: checkpoint.status === 'stale'
                  ? 'checkpoint-identity-changed'
                  : 'task-attempt-incomplete',
              })
            }
            const trials = []
            for (const [trialIndex, seed] of seeds.entries()) {
              trials.push(await this.runTrial({
                candidateId,
                candidateWorkspace: candidate,
                layout,
                model,
                partition,
                seed,
                trialIndex,
                executionId,
              }))
            }
            const record = recordForTask({
              layout,
              partition,
              trials,
              runRoot: this.runRoot,
              feedbackLimit: this.environment.feedback.maximumTextBytesPerCase,
            })
            await validateCheckpointRecord(record)
            await commitTrialCheckpoint({ runRoot: this.runRoot, taskRoot, identity, record })
            freshRecords.set(layout.instanceId, record)
          },
        )
      } catch (error) {
        runError = error
      }
      try {
        await this.solverDriver.endUsageBatch?.()
      } catch (error) {
        if (!runError) throw error
        runError.details = [...(runError.details ?? []), `Solver Usage Batch 收尾失败：${error.message}`]
      }
    }
    if (runError) throw runError
    const records = plans.map(({ layout, checkpoint }) => (
      checkpoint.status === 'committed' ? checkpoint.record : freshRecords.get(layout.instanceId)
    ))
    if (records.some((record) => record === undefined)) {
      throw new ProtocolError(`${candidateId}/${partition} Trial Checkpoint 合并不完整`)
    }
    await writeJsonLines(outputPath, records)
    return validateResultRecords(records, this.benchmark, `${candidateId}/${partition}`)
  }
}

export async function concurrentMap(values, maximumConcurrency, operation) {
  if (!Array.isArray(values) || !Number.isSafeInteger(maximumConcurrency)
      || maximumConcurrency < 1 || maximumConcurrency > 200 || typeof operation !== 'function') {
    throw new ProtocolError('OmegaUse 并发执行参数无效')
  }
  const results = new Array(values.length)
  const failures = []
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await operation(values[index], index)
      } catch (error) {
        failures.push({ index, error })
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrency, values.length) },
    () => worker(),
  ))
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index)
    const first = failures[0].error
    if (failures.length > 1) {
      first.details = [...(first.details ?? []), `同批共 ${failures.length} 个 Trial 失败`]
    }
    throw first
  }
  return results
}
