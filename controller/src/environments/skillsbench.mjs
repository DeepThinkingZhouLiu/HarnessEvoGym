import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  readlink,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { copyRegularTree, writeJsonLines } from '../candidate.mjs'
import { assertPathKind } from '../config.mjs'
import { safeDockerName } from '../docker.mjs'
import { ProtocolError, validateResultRecords } from '../protocol.mjs'
import { runProcess } from '../process.mjs'

// SkillsBench 的可信 Verifier 会在首次执行时用 apt/dpkg 补依赖。
// 它保留 Docker 默认非特权能力子集，但没有 SYS_ADMIN；Solver/Updater 仍然是零 capability。
const TRUSTED_VERIFIER_CAPABILITIES = [
  'AUDIT_WRITE',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'MKNOD',
  'NET_BIND_SERVICE',
  'NET_RAW',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_CHROOT',
]
const MAXIMUM_VERIFIER_REWARD_BYTES = 1024 * 1024
// `/opt/venv` 是部分固定 Task Image 在构建期创建的只读可信环境，不来自 Solver 提交物。
const TRUSTED_VERIFIER_PATH = '/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new ProtocolError(`${label} 不是安全的目录标识：${value}`)
  }
  return value
}

function assertContained(root, pathValue, label) {
  const rel = relative(root, pathValue)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 逃逸 SkillsBench 根目录：${pathValue}`)
  }
}

async function containedRealpath(root, pathValue, label) {
  let actual
  try {
    actual = await realpath(pathValue)
  } catch (error) {
    throw new ProtocolError(`${label} 不存在：${pathValue}`, [error.message])
  }
  assertContained(root, actual, label)
  return actual
}

async function firstExisting(root, candidates, label) {
  for (const candidate of candidates) {
    const pathValue = resolve(root, candidate)
    assertContained(root, pathValue, label)
    try {
      const actual = await realpath(pathValue)
      assertContained(root, actual, label)
      if ((await stat(actual)).isFile()) return actual
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new ProtocolError(`${label} 缺失`, candidates.map((candidate) => `尝试过：${candidate}`))
}

async function resolveSourceRoot(environment) {
  const configured = process.env[environment.source.rootEnvironment]
  if (!configured) {
    throw new ProtocolError(`缺少 SkillsBench 根目录环境变量：${environment.source.rootEnvironment}`)
  }
  const root = await realpath(resolve(configured))
  await assertPathKind(root, 'SkillsBench 根目录')
  return root
}

async function currentGitRevision(root) {
  const result = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  const dirty = await runProcess(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'],
    { timeoutMs: 30_000 },
  )
  if (dirty.stdout.trim()) {
    throw new ProtocolError(`SkillsBench Source 存在未提交或已忽略的本地文件：${root}`)
  }
  return result.stdout.trim()
}

async function hashFile(pathValue) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(pathValue)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function snapshotWorkspace(root, limits) {
  const files = new Map()
  let totalBytes = 0
  let treeEntries = 0
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      treeEntries += 1
      if (treeEntries > limits.maximumFiles) {
        throw new ProtocolError('Trial 工作区目录项数超限', [
          `actual>${limits.maximumFiles}`,
          `limit=${limits.maximumFiles}`,
        ])
      }
      const absolute = join(directory, entry.name)
      const pathValue = relative(root, absolute).replaceAll('\\', '/')
      const info = await lstat(absolute)
      if (info.isDirectory()) {
        await visit(absolute)
      } else if (info.isSymbolicLink()) {
        files.set(pathValue, { path: pathValue, kind: 'symlink', target: await readlink(absolute), bytes: 0 })
      } else if (info.isFile()) {
        totalBytes += info.size
        if (info.size > limits.maximumFileBytes) {
          throw new ProtocolError(`Trial 工作区单文件超限：${pathValue}`, [
            `actual=${info.size}`,
            `limit=${limits.maximumFileBytes}`,
          ])
        }
        if (totalBytes > limits.maximumBytes) {
          throw new ProtocolError('Trial 工作区总字节超限', [
            `actual>${limits.maximumBytes}`,
            `limit=${limits.maximumBytes}`,
          ])
        }
        files.set(pathValue, { path: pathValue, kind: 'file', sha256: await hashFile(absolute), bytes: info.size })
      } else {
        files.set(pathValue, { path: pathValue, kind: 'special', bytes: 0 })
      }
    }
  }
  await visit(root)
  return files
}

function artifactBudgetError(artifacts, limits) {
  if (artifacts.length > limits.maximumChangedFiles) {
    return `Solver 改动文件数 ${artifacts.length} 超过上限 ${limits.maximumChangedFiles}`
  }
  const materialized = artifacts.filter((artifact) => artifact.change !== 'deleted')
  const changedBytes = materialized.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0)
  if (changedBytes > limits.maximumChangedBytes) {
    return `Solver 改动文件总字节 ${changedBytes} 超过上限 ${limits.maximumChangedBytes}`
  }
  return null
}

function changedArtifacts(before, after) {
  const changed = []
  for (const pathValue of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(pathValue)
    const current = after.get(pathValue)
    if (!previous && current) changed.push({ change: 'added', ...current })
    else if (previous && !current) changed.push({ change: 'deleted', ...previous })
    else if (JSON.stringify(previous) !== JSON.stringify(current)) changed.push({ change: 'modified', ...current })
  }
  return changed.sort((left, right) => left.path.localeCompare(right.path))
}

function rewardFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') return null
  for (const key of ['reward', 'score', 'total_reward', 'totalScore']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key]
  }
  if (value.result && typeof value.result === 'object') return rewardFromValue(value.result)
  return null
}

function rewardFromText(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return numeric
  const lines = trimmed.split(/\r?\n/u).reverse()
  for (const line of lines) {
    try {
      const reward = rewardFromValue(JSON.parse(line))
      if (reward !== null) return reward
    } catch {
      // Verifier 可以同时输出日志与最后一行 JSON；非 JSON 行直接略过。
    }
  }
  try {
    return rewardFromValue(JSON.parse(trimmed))
  } catch {
    return null
  }
}

async function loadVerifierReward(logDirectory, candidates, stdout) {
  for (const candidate of candidates) {
    const relativeCandidate = candidate.startsWith('/logs/') ? candidate.slice('/logs/'.length) : candidate
    const pathValue = resolve(logDirectory, relativeCandidate)
    assertContained(logDirectory, pathValue, 'Verifier 输出')
    try {
      const info = await lstat(pathValue)
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ProtocolError(`Verifier Reward 必须是普通文件：${relativeCandidate}`)
      }
      if (info.size > MAXIMUM_VERIFIER_REWARD_BYTES) {
        throw new ProtocolError(`Verifier Reward 文件超过上限：${relativeCandidate}`, [
          `actual=${info.size}`,
          `limit=${MAXIMUM_VERIFIER_REWARD_BYTES}`,
        ])
      }
      const text = await readFile(pathValue, 'utf8')
      try {
        const reward = rewardFromValue(JSON.parse(text))
        if (reward !== null) return { reward, evidence: text }
      } catch {
        const reward = rewardFromText(text)
        if (reward !== null) return { reward, evidence: text }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const reward = rewardFromText(stdout)
  return reward === null ? null : { reward, evidence: stdout }
}

async function missingVerifierEvidence(logDirectory, candidates) {
  for (const candidate of candidates) {
    const relativeCandidate = candidate.startsWith('/logs/') ? candidate.slice('/logs/'.length) : candidate
    const pathValue = resolve(logDirectory, relativeCandidate)
    assertContained(logDirectory, pathValue, 'Verifier 评分证据')
    try {
      const info = await lstat(pathValue)
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ProtocolError(`Verifier 评分证据必须是普通文件：${relativeCandidate}`)
      }
      if (info.size === 0) return `Verifier 评分证据为空：${relativeCandidate}`
    } catch (error) {
      if (error.code === 'ENOENT') return `Verifier 缺少评分证据：${relativeCandidate}`
      throw error
    }
  }
  return null
}

function verifierEvidence(result, parsed) {
  return [result.stdout?.trim(), result.stderr?.trim(), parsed?.evidence?.trim()]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join('\n\n[verifier output]\n')
}

function verifierCommand(layout, environment) {
  const extension = extname(layout.verifierPath).toLowerCase()
  const script = `/verifier/${basename(layout.verifierPath)}`
  const argumentsList = environment.verifier.arguments.map((value) =>
    value
      .replaceAll('{{workspace}}', environment.task.workspacePath)
      .replaceAll('{{outputDir}}', '/logs')
      .replaceAll('{{script}}', script),
  )
  if (extension === '.py') return [environment.verifier.pythonCommand, script, ...argumentsList]
  if (extension === '.sh') return [environment.verifier.shellCommand, script, ...argumentsList]
  throw new ProtocolError(`不支持的 Verifier 脚本类型：${extension}`)
}

function isolatedVerifierCommand(command, environment) {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new ProtocolError('无法确定 Verifier 私有工作区的宿主用户 UID/GID')
  }
  const repairLogs = environment.verifier.runAsCurrentUser
    ? 'repair_logs() { :; }'
    : 'repair_logs() { chown -hR "${RSI_HOST_UID}:${RSI_HOST_GID}" /logs >/dev/null 2>&1 || true; }'
  const wrapper = [
    'set -eu',
    repairLogs,
    'trap repair_logs EXIT',
    'cp -a /rsi-submission/. "${RSI_VERIFIER_WORKSPACE}/"',
    'cd -- "${RSI_VERIFIER_WORKSPACE}"',
    '"$@"',
  ].join('\n')
  return ['-c', wrapper, 'harness-rsi-verifier', ...command]
}

function verifierWorkspaceTmpfs(environment) {
  const uid = environment.verifier.runAsCurrentUser ? process.getuid() : 0
  const gid = environment.verifier.runAsCurrentUser ? process.getgid() : 0
  return `${environment.task.workspacePath}:rw,nosuid,nodev,size=${environment.task.workspaceLimits.maximumBytes},mode=0755,uid=${uid},gid=${gid}`
}

export class SkillsBenchEnvironment {
  constructor({ environment, benchmark, target, solverDriver, docker, runRoot }) {
    this.environment = environment
    this.benchmark = benchmark
    this.target = target
    this.docker = docker
    this.runRoot = runRoot
    this.solverDriver = solverDriver
    this.sourceRoot = null
    this.sourceRevision = null
  }

  async preflight() {
    this.sourceRoot = await resolveSourceRoot(this.environment)
    this.sourceRevision = await currentGitRevision(this.sourceRoot)
    if (this.sourceRevision !== this.environment.source.revision) {
      throw new ProtocolError('SkillsBench Revision 与 Environment Adapter 不一致', [
        `expected=${this.environment.source.revision}`,
        `actual=${this.sourceRevision}`,
      ])
    }
    if (this.benchmark.source.revision !== this.sourceRevision) {
      throw new ProtocolError('Benchmark Revision 与 SkillsBench Checkout 不一致', [
        `benchmark=${this.benchmark.source.revision}`,
        `checkout=${this.sourceRevision}`,
      ])
    }
    await this.docker.info()
    return { sourceRoot: this.sourceRoot, sourceRevision: this.sourceRevision }
  }

  async taskLayout(instanceId) {
    if (!this.sourceRoot) throw new ProtocolError('必须先执行 SkillsBench preflight')
    safeSegment(instanceId, 'SkillsBench Instance ID')
    const tasksRoot = await containedRealpath(
      this.sourceRoot,
      resolve(this.sourceRoot, this.environment.source.tasksSubdirectory),
      'SkillsBench Tasks Root',
    )
    const taskRoot = await containedRealpath(tasksRoot, resolve(tasksRoot, instanceId), 'SkillsBench Task')
    await assertPathKind(taskRoot, `Task ${instanceId}`)
    const instructionPath = await firstExisting(
      taskRoot,
      this.environment.task.instructionCandidates,
      `Task ${instanceId} 的 instruction`,
    )
    const dockerfile = await containedRealpath(
      taskRoot,
      resolve(taskRoot, this.environment.task.dockerfile),
      'Task Dockerfile',
    )
    const dockerContext = await containedRealpath(
      taskRoot,
      resolve(taskRoot, this.environment.task.dockerContext),
      'Task Docker Context',
    )
    const skillsDirectory = await containedRealpath(
      taskRoot,
      resolve(taskRoot, this.environment.task.skillsDirectory),
      'Task Skills Directory',
    )
    assertContained(taskRoot, dockerfile, 'Task Dockerfile')
    assertContained(taskRoot, dockerContext, 'Task Docker Context')
    assertContained(taskRoot, skillsDirectory, 'Task Skills Directory')
    await assertPathKind(dockerfile, `Task ${instanceId} Dockerfile`, 'file')
    await assertPathKind(dockerContext, `Task ${instanceId} Docker Context`)
    await assertPathKind(skillsDirectory, `Task ${instanceId} Skills Directory`)
    const verifierPath = await firstExisting(
      taskRoot,
      this.environment.task.verifierCandidates,
      `Task ${instanceId} 的 Verifier`,
    )
    return { instanceId, taskRoot, instructionPath, dockerfile, dockerContext, skillsDirectory, verifierPath }
  }

  imageNames(instanceId) {
    const key = sha256(`${this.sourceRevision}:${instanceId}`).slice(0, 12)
    const task = safeDockerName(`harness-rsi-skillsbench-${instanceId}-${key}`)
    const solver = safeDockerName(`${task}-solver-${this.solverDriver.cacheKey}`)
    return { task, solver }
  }

  async ensureImages(layout) {
    const images = this.imageNames(layout.instanceId)
    const taskImageCurrent = await this.docker.imageExists(images.task) &&
      await this.docker.imageLabel(images.task, 'io.harness-rsi.skillsbench-revision') === this.sourceRevision &&
      await this.docker.imageLabel(images.task, 'io.harness-rsi.skillsbench-task') === layout.instanceId
    if (!taskImageCurrent) {
      await this.docker.build({
        context: layout.dockerContext,
        dockerfile: layout.dockerfile,
        tag: images.task,
        labels: {
          'io.harness-rsi.skillsbench-revision': this.sourceRevision,
          'io.harness-rsi.skillsbench-task': layout.instanceId,
        },
      })
    }
    const taskImageIdentity = await this.docker.imageId(images.task)
    await this.solverDriver.ensureRuntime({
      baseImage: images.task,
      baseImageIdentity: taskImageIdentity,
      tag: images.solver,
    })
    return images
  }

  async extractWorkspace({ image, destination, name }) {
    await mkdir(destination, { recursive: false })
    const container = await this.docker.create({ image, name })
    try {
      await this.docker.copyFrom(container.id, `${this.environment.task.workspacePath}/.`, destination)
    } finally {
      await this.docker.removeContainer(container.id)
    }
  }

  async runVerifier({ layout, image, workspace, logs, name }) {
    await mkdir(logs, { recursive: true })
    await Promise.all([
      mkdir(join(logs, 'agent'), { recursive: true }),
      mkdir(join(logs, 'verifier'), { recursive: true }),
    ])
    const maximumAttempts = this.environment.verifier.maximumAttempts ?? 1
    const attemptFailures = []
    let totalDurationMs = 0
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let result
      const command = verifierCommand(layout, this.environment)
      const dependencyEnvironment = Object.fromEntries(
        Object.entries(this.environment.verifier.dependencyEnvironment ?? {})
          .flatMap(([containerName, hostName]) => process.env[hostName]
            ? [[containerName, process.env[hostName]]]
            : []),
      )
      try {
        result = await this.docker.run({
          image,
          name: attempt === 1 ? name : `${name}-attempt-${attempt}`,
          command: isolatedVerifierCommand(command, this.environment),
          // 不信任 Task Image 自带的 ENTRYPOINT；评分只能从受控 Shell Wrapper 进入。
          entrypoint: this.environment.verifier.shellCommand,
          workdir: this.environment.task.workspacePath,
          mounts: [
            // 宿主提交物永久只读；Verifier 在容器私有 tmpfs 副本上运行。
            { source: workspace, target: '/rsi-submission', readOnly: true },
            { source: dirname(layout.verifierPath), target: '/verifier', readOnly: true },
            { source: logs, target: '/logs', readOnly: false },
          ],
          environment: {
            WORKSPACE: this.environment.task.workspacePath,
            OUTPUT_DIR: '/logs',
            LOG_DIR: '/logs',
            HOME: '/tmp/home',
            XDG_CONFIG_HOME: '/tmp/verifier-config',
            XDG_CACHE_HOME: '/tmp/verifier-cache',
            PYTHONSAFEPATH: '1',
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONPATH: '',
            PYTEST_ADDOPTS: '',
            PIP_CONFIG_FILE: '/dev/null',
            UV_NO_CONFIG: '1',
            BASH_ENV: '/dev/null',
            ENV: '/dev/null',
            PATH: TRUSTED_VERIFIER_PATH,
            RSI_HOST_UID: String(typeof process.getuid === 'function' ? process.getuid() : ''),
            RSI_HOST_GID: String(typeof process.getgid === 'function' ? process.getgid() : ''),
            RSI_VERIFIER_WORKSPACE: this.environment.task.workspacePath,
            ...dependencyEnvironment,
          },
          // 只有可信 Verifier 可以按 Adapter 白名单继承代理；Solver/Updater 仍在 internal network。
          inheritEnvironment: (this.environment.verifier.proxyEnvironment ?? [])
            .filter((nameValue) => Boolean(process.env[nameValue])),
          network: this.environment.verifier.network,
          // 仅可信 Verifier 可解析宿主工具缓存；Agent 容器从不启用此入口。
          hostGateway: true,
          runAsCurrentUser: this.environment.verifier.runAsCurrentUser,
          readOnlyRoot: false,
          tmpfs: [
            // 上游 Verifier 会把固定版本的 uv/uvx 安装到 $HOME=/tmp/home 后执行。
            // Docker 的 tmpfs 默认带 noexec，因此仅对可信 Verifier 显式开启 exec。
            '/tmp:rw,exec,nosuid,nodev,size=1g',
            '/run:rw,nosuid,nodev,size=64m',
            verifierWorkspaceTmpfs(this.environment),
          ],
          capabilities: this.environment.verifier.runAsCurrentUser ? [] : TRUSTED_VERIFIER_CAPABILITIES,
        })
        totalDurationMs += result.durationMs
      } catch (error) {
        const evidence = [error.message, ...(error.details ?? [])].filter(Boolean).join('\n')
        return { reward: null, evidence, error: error.message }
      }

      let parsed
      try {
        parsed = await loadVerifierReward(logs, this.environment.verifier.outputCandidates, result.stdout)
        const missingEvidence = await missingVerifierEvidence(
          logs,
          this.environment.verifier.requiredEvidenceCandidates ?? [],
        )
        if (missingEvidence) {
          attemptFailures.push(`attempt ${attempt}/${maximumAttempts}: ${missingEvidence}`)
          if (attempt < maximumAttempts) continue
          return {
            reward: null,
            evidence: [...attemptFailures, verifierEvidence(result, parsed)].filter(Boolean).join('\n'),
            error: 'Verifier 缺少必需评分证据',
          }
        }
      } catch (error) {
        return {
          reward: null,
          evidence: [error.message, ...(error.details ?? [])].filter(Boolean).join('\n'),
          error: 'Verifier Reward 或评分证据不安全或不可读',
        }
      }
      if (!parsed) {
        return {
          reward: null,
          evidence: verifierEvidence(result, null),
          error: 'Verifier 未产出可解析的 reward',
        }
      }
      return {
        ...parsed,
        evidence: [...attemptFailures, verifierEvidence(result, parsed)].filter(Boolean).join('\n'),
        error: null,
        durationMs: totalDurationMs,
      }
    }
    throw new ProtocolError('Verifier 重试循环异常结束')
  }

  async runTrial({ candidateId, candidatePreset, instanceId, seed, model, partition, trialIndex, executionId }) {
    const layout = await this.taskLayout(instanceId)
    const images = await this.ensureImages(layout)
    const trialRoot = join(
      this.runRoot,
      'trials',
      executionId,
      safeSegment(candidateId, 'Candidate ID'),
      partition,
      safeSegment(instanceId, 'Instance ID'),
      `trial-${trialIndex + 1}-seed-${seed}`,
    )
    await mkdir(trialRoot, { recursive: true })
    const workspace = join(trialRoot, 'workspace')
    const dshHome = join(trialRoot, 'dsh-home')
    const logs = join(trialRoot, 'verifier-logs')
    await mkdir(dshHome, { recursive: true })
    await this.extractWorkspace({
      image: images.task,
      destination: workspace,
      name: `${executionId}-${candidateId}-${instanceId}-${seed}-extract`,
    })
    const before = await snapshotWorkspace(workspace, this.environment.task.workspaceLimits)
    const instruction = await readFile(layout.instructionPath, 'utf8')
    let solver
    let solverError = null
    const startedAt = Date.now()
    try {
      solver = await this.solverDriver.run({
        image: images.solver,
        model,
        candidatePreset,
        workspace,
        dshHome,
        benchmarkSkills: layout.skillsDirectory,
        task: instruction,
        name: `${executionId}-${candidateId}-${instanceId}-${seed}-solver`,
        timeoutMs: this.environment.docker.resources.timeoutSeconds * 1000,
        containerWorkspace: this.environment.task.workspacePath,
      })
    } catch (error) {
      solverError = error.message
      solver = {
        answer: '',
        stderr: [error.message, ...(error.details ?? [])].filter(Boolean).join('\n'),
        durationMs: Date.now() - startedAt,
        outputTruncated: false,
        modelUsage: error.modelUsage ?? null,
      }
    }
    let artifacts = []
    let artifactError = null
    try {
      const after = await snapshotWorkspace(workspace, this.environment.task.workspaceLimits)
      artifacts = changedArtifacts(before, after)
      artifactError = artifactBudgetError(artifacts, this.environment.task.workspaceLimits)
    } catch (error) {
      artifactError = [error.message, ...(error.details ?? [])].join('\n')
    }
    const unsafeArtifacts = artifacts.filter(
      (artifact) => artifact.change !== 'deleted' && artifact.kind !== 'file',
    )
    const verifier = artifactError
      ? {
          reward: null,
          evidence: artifactError,
          error: '拒绝超出工作区或 Artifact 预算的 Solver 输出',
        }
      : unsafeArtifacts.length > 0
        ? {
            reward: null,
            evidence: JSON.stringify(unsafeArtifacts, null, 2),
            error: 'Solver 产生了符号链接或特殊文件，拒绝交给 Verifier',
          }
        : await this.runVerifier({
            layout,
            image: images.task,
            workspace,
            logs,
            name: `${executionId}-${candidateId}-${instanceId}-${seed}-verifier`,
          })
    await writeFile(join(trialRoot, 'solver-answer.txt'), `${solver.answer}\n`, 'utf8')
    await writeFile(join(trialRoot, 'solver-stderr.txt'), `${solver.stderr}\n`, 'utf8')
    await writeFile(join(trialRoot, 'verifier-evidence.txt'), `${verifier.evidence ?? ''}\n`, 'utf8')
    await writeFile(join(trialRoot, 'artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8')

    const reward = verifier.reward
    const inRange =
      typeof reward === 'number' &&
      reward >= this.environment.reward.minimum &&
      reward <= this.environment.reward.maximum
    const policyViolations = []
    if (artifactError) policyViolations.push('solver-artifact-budget')
    if (unsafeArtifacts.length > 0) policyViolations.push('solver-unsafe-artifact')
    if (typeof reward === 'number' && !inRange) policyViolations.push('verifier-reward-out-of-range')
    const rewardError = typeof reward === 'number' && !inRange ? 'Verifier reward 超出声明范围' : null
    const failed = Boolean(verifier.error || solverError || rewardError)
    const normalizedReward = failed ? 0 : reward
    return {
      seed,
      reward: normalizedReward,
      status: failed
        ? 'error'
        : normalizedReward >= this.environment.reward.resolvedThreshold
          ? 'resolved'
          : 'unresolved',
      latencyMs: Date.now() - startedAt,
      inputTokens: solver.modelUsage?.complete ? solver.modelUsage.inputTokens : null,
      outputTokens: solver.modelUsage?.complete ? solver.modelUsage.outputTokens : null,
      taskInstruction: instruction,
      solverAnswer: solver.answer,
      verifierFeedback: verifier.evidence ?? verifier.error ?? '',
      policyViolations,
      artifacts,
      errors: [solverError, verifier.error, rewardError].filter(Boolean),
      trialRoot,
    }
  }

  async runCandidatePartition({ candidateId, candidateWorkspace, model, partition, seeds, outputPath }) {
    const partitionSpec = this.benchmark.partitions[partition]
    if (!partitionSpec) throw new ProtocolError(`Benchmark 不存在 Partition：${partition}`)
    const candidatePreset = resolve(candidateWorkspace, this.target.materialization.presetRelativePath)
    await assertPathKind(candidatePreset, `Candidate ${candidateId} Preset`)
    const executionId = sha256(resolve(outputPath)).slice(0, 12)
    const records = []

    for (const instanceId of partitionSpec.instanceIds) {
      const trials = []
      for (const [trialIndex, seed] of seeds.entries()) {
        trials.push(
          await this.runTrial({
            candidateId,
            candidatePreset,
            instanceId,
            seed,
            model,
            partition,
            trialIndex,
            executionId,
          }),
        )
      }
      const meanReward = trials.reduce((sum, trial) => sum + trial.reward, 0) / trials.length
      const anyError = trials.some((trial) => trial.status === 'error')
      const policyViolations = [...new Set(trials.flatMap((trial) => trial.policyViolations))]
      const usageComplete = trials.every(
        (trial) => typeof trial.inputTokens === 'number' && typeof trial.outputTokens === 'number',
      )
      const record = {
        instance_id: instanceId,
        status: anyError
          ? 'error'
          : meanReward >= this.environment.reward.resolvedThreshold
            ? 'resolved'
            : 'unresolved',
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
        policy_violations: policyViolations,
        artifacts: trials.map((trial) => ({
          seed: trial.seed,
          root: relative(this.runRoot, trial.trialRoot).replaceAll('\\', '/'),
          changed: trial.artifacts,
        })),
      }
      if (partition === 'feedback') {
        record.feedback = {
          taskInstruction: trials[0]?.taskInstruction ?? '',
          solverAnswer: trials.map((trial) => trial.solverAnswer).join('\n\n'),
          verifierFeedback: trials.map((trial) => trial.verifierFeedback).join('\n\n'),
          errors: trials.flatMap((trial) => trial.errors),
        }
      }
      records.push(record)
    }

    await writeJsonLines(outputPath, records)
    return validateResultRecords(records, this.benchmark, `${candidateId}/${partition}`)
  }
}
