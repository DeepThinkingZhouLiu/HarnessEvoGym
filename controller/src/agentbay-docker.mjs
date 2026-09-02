import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ProtocolError } from './protocol.mjs'
import { safeDockerName } from './docker.mjs'

const SECRET_ENV_MARKER = '__HARNESS_RSI_SECRET_ENV_FILE__'
const ALLOWED_CAPABILITIES = new Set([
  'AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD',
  'NET_BIND_SERVICE', 'NET_RAW', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT',
])

function validEnvironmentName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
}

function assertEnvironment(environment, label) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new ProtocolError(`${label} 必须是对象`)
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!validEnvironmentName(name) || typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
      throw new ProtocolError(`${label} 包含非法环境变量：${name}`)
    }
  }
}

function assertRemoteImageLabel(value, label) {
  if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) throw new ProtocolError(`${label} 无效`)
  return value
}

function resultOrThrow(result, operation, allowExitCodes = [0]) {
  if (!allowExitCodes.includes(result.exitCode)) {
    throw new ProtocolError(`AgentBay 远端 Docker ${operation} 失败`, [
      `exitCode=${result.exitCode}`,
      (result.stderr || result.stdout || '').slice(-4000),
    ])
  }
  return { ...result, durationMs: result.durationMs ?? 0, outputTruncated: false }
}

function redactResult(result, secretEnvironment) {
  const secrets = secretEnvironment.map((name) => process.env[name]).filter(Boolean)
  const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value ?? '')
  return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }
}

class AgentBayBridge {
  constructor({ pythonExecutable, bridgePath, environment }) {
    this.sequence = 0
    this.pending = new Map()
    this.stderr = ''
    this.child = spawn(pythonExecutable, [bridgePath], {
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384)
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.receive(line))
    this.child.once('error', (error) => this.failAll(error))
    this.child.once('close', (code, signal) => {
      this.failAll(new Error(`AgentBay bridge exited code=${code} signal=${signal ?? 'none'} ${this.stderr}`))
    })
    this.setReferenced(false)
  }

  setReferenced(referenced) {
    const method = referenced ? 'ref' : 'unref'
    this.child[method]?.()
    this.child.stdin[method]?.()
    this.child.stdout[method]?.()
    this.child.stderr[method]?.()
  }

  receive(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.failAll(new Error(`AgentBay bridge emitted invalid JSON: ${line.slice(0, 500)}`))
      return
    }
    if (message.id === null && message.error) {
      this.failAll(new Error(message.error))
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (this.pending.size === 0) this.setReferenced(false)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.setReferenced(false)
  }

  async request(operation, payload = {}) {
    if (!this.child.stdin.writable) throw new ProtocolError('AgentBay bridge 已关闭')
    const id = ++this.sequence
    if (this.pending.size === 0) this.setReferenced(true)
    const response = new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }))
    this.child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`)
    try {
      return await response
    } catch (error) {
      throw new ProtocolError(`AgentBay bridge ${operation} 失败`, [error.message])
    }
  }
}

function appendResources(args, resources) {
  args.push('--pids-limit', String(resources.pids), '--cpus', String(resources.cpus), '--memory', resources.memory)
}

function appendEnvironment(args, environment) {
  assertEnvironment(environment, 'Docker environment')
  for (const [name, value] of Object.entries(environment)) args.push('--env', `${name}=${value}`)
}

function collectSecrets(secretEnvironment, inheritEnvironment) {
  assertEnvironment(secretEnvironment, 'Docker secretEnvironment')
  const result = { ...secretEnvironment }
  for (const name of inheritEnvironment) {
    if (!validEnvironmentName(name)) throw new ProtocolError(`非法继承环境变量名：${name}`)
    if (Object.hasOwn(result, name)) throw new ProtocolError(`秘密环境变量重复：${name}`)
    if (!process.env[name]) throw new ProtocolError(`缺少运行时凭据环境变量：${name}`)
    result[name] = process.env[name]
  }
  return result
}

export class AgentBayDockerClient {
  constructor({ resources, network = 'bridge', runAsCurrentUser = true, agentBay, repositoryRoot }) {
    if (network === 'host') throw new ProtocolError('安全策略禁止 Docker host 网络')
    this.resources = resources ?? { cpus: 2, memory: '4g', pids: 512, timeoutSeconds: 900 }
    this.network = network
    this.runAsCurrentUser = runAsCurrentUser
    this.repositoryRoot = resolve(repositoryRoot)
    const environment = {}
    for (const [target, source] of [
      ['HARNESS_RSI_AGENTBAY_IMAGE_ID', agentBay.imageIdEnvironment],
      ['HARNESS_RSI_AGENTBAY_POLICY_ID', agentBay.policyIdEnvironment],
    ]) {
      if (!process.env[source]) throw new ProtocolError(`缺少 AgentBay 运行时配置：${source}`)
      environment[target] = process.env[source]
    }
    environment.HARNESS_RSI_AGENTBAY_REGISTRY_MIRROR = agentBay.registryMirror
    this.bridge = new AgentBayBridge({
      pythonExecutable: agentBay.pythonExecutable,
      bridgePath: resolve(this.repositoryRoot, agentBay.bridgePath),
      environment,
    })
    this.identity = null
  }

  async docker(args, {
    timeoutMs = 120_000,
    secretEnvironment = {},
    commandEnvironment = {},
    allowExitCodes = [0],
    operation = args[0],
  } = {}) {
    const started = Date.now()
    const result = await this.bridge.request('docker', {
      args,
      timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
      secretEnvironment,
      commandEnvironment,
    })
    return resultOrThrow({ ...result, durationMs: Date.now() - started }, operation, allowExitCodes)
  }

  async info() {
    return await this.docker(['version', '--format', '{{json .Server.Version}}'], { operation: 'info' })
  }

  async imageExists(image) {
    const result = await this.docker(['image', 'inspect', image], { allowExitCodes: [0, 1], operation: 'image inspect' })
    return result.exitCode === 0
  }

  async imageLabel(image, label) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(label)) throw new ProtocolError(`非法 Docker Label：${label}`)
    const result = await this.docker([
      'image', 'inspect', '--format', `{{ with .Config.Labels }}{{ index . ${JSON.stringify(label)} }}{{ end }}`, image,
    ])
    const value = result.stdout.trim()
    return value === '' || value === '<no value>' ? null : value
  }

  async imageId(image) {
    const result = await this.docker(['image', 'inspect', '--format', '{{.Id}}', image])
    const value = result.stdout.trim()
    if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new ProtocolError(`Docker Image ID 无效：${image}`)
    return value
  }

  async imageFileDigest(image, pathValue) {
    const result = await this.docker([
      'run', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--read-only', '--entrypoint', 'sha256sum', image, '--', pathValue,
    ])
    const match = result.stdout.match(/^([0-9a-f]{64})\s+/u)
    if (!match) throw new ProtocolError(`Docker Image 文件摘要无效：${image}:${pathValue}`)
    return match[1]
  }

  async build({ context, dockerfile, tag, buildArgs = {}, labels = {}, timeoutMs = 1_800_000 }) {
    const contextPath = resolve(context)
    const dockerfilePath = resolve(dockerfile)
    const relativeDockerfile = relative(contextPath, dockerfilePath)
    if (!relativeDockerfile || relativeDockerfile.startsWith(`..${sep}`) || isAbsolute(relativeDockerfile)) {
      throw new ProtocolError('AgentBay Dockerfile 必须位于 Build Context 内')
    }
    const remoteContext = (await this.bridge.request('allocatePath')).path
    try {
      await this.bridge.request('uploadDir', { localPath: contextPath, remotePath: remoteContext })
      const args = ['build', '--pull=false', '--file', `${remoteContext}/${relativeDockerfile.split(sep).join('/')}`, '--tag', tag]
      for (const [name, value] of Object.entries(buildArgs)) args.push('--build-arg', `${name}=${value}`)
      for (const [name, value] of Object.entries(labels)) args.push('--label', `${name}=${assertRemoteImageLabel(value, name)}`)
      args.push(remoteContext)
      return await this.docker(args, {
        timeoutMs,
        commandEnvironment: { DOCKER_BUILDKIT: '1' },
        operation: 'build',
      })
    } finally {
      await this.bridge.request('removePath', { remotePath: remoteContext }).catch(() => {})
    }
  }

  async create({ image, name }) {
    const safeName = safeDockerName(name)
    const result = await this.docker(['create', '--name', safeName, image])
    return { id: result.stdout.trim(), name: safeName }
  }

  async copyFrom() {
    throw new ProtocolError('AgentBay Docker MVP 尚不支持 copyFrom；Cowork/OfficeVal 路径不使用该操作')
  }

  async removeContainer(container) {
    return await this.docker(['rm', '--force', container], { allowExitCodes: [0, 1], operation: 'container rm' })
  }

  async createNetwork({ name, internal = true }) {
    const safeName = safeDockerName(name)
    const args = ['network', 'create']
    if (internal) args.push('--internal')
    args.push('--label', 'io.harness-rsi.managed=true', safeName)
    const result = await this.docker(args)
    return { id: result.stdout.trim(), name: safeName }
  }

  async connectNetwork({ network, container, alias }) {
    const args = ['network', 'connect']
    if (alias) args.push('--alias', safeDockerName(alias))
    args.push(network, container)
    return await this.docker(args)
  }

  async removeNetwork(network) {
    return await this.docker(['network', 'rm', network], { allowExitCodes: [0, 1] })
  }

  async containerHealth(container) {
    const result = await this.docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container])
    return result.stdout.trim()
  }

  async containerLogs(container, secretEnvironment = []) {
    return redactResult(
      await this.docker(['logs', '--tail', '200', container], { allowExitCodes: [0, 1] }),
      secretEnvironment,
    )
  }

  async exec({ container, command, timeoutMs = 30_000 }) {
    return await this.docker(['exec', container, ...command], { timeoutMs, operation: 'exec' })
  }

  async runDetached(options) {
    const {
      image, name, network = 'bridge', environment = {}, secretEnvironment = {}, inheritEnvironment = [],
      resources = { cpus: 1, memory: '512m', pids: 128 },
    } = options
    const containerName = safeDockerName(name)
    const secrets = collectSecrets(secretEnvironment, inheritEnvironment)
    const args = [
      'run', '--detach', '--name', containerName, '--label', 'io.harness-rsi.managed=true',
      '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    ]
    appendResources(args, resources)
    appendEnvironment(args, environment)
    if (Object.keys(secrets).length > 0) args.push(SECRET_ENV_MARKER)
    args.push(image)
    const result = await this.docker(args, { timeoutMs: 60_000, secretEnvironment: secrets, operation: 'run detached' })
    return { id: result.stdout.trim(), name: containerName }
  }

  async run(options) {
    const {
      image, name, command = [], mounts = [], environment = {}, secretEnvironment = {}, inheritEnvironment = [],
      entrypoint = null, workdir, network = this.network, runAsCurrentUser = this.runAsCurrentUser,
      readOnlyRoot = true, hostGateway = false, tmpfs = ['/tmp:rw,nosuid,nodev,size=1g', '/run:rw,nosuid,nodev,size=64m'],
      capabilities = [], timeoutMs = this.resources.timeoutSeconds * 1000, resources = this.resources,
    } = options
    if (options.input !== undefined) throw new ProtocolError('AgentBay Docker MVP 尚不支持 stdin 输入')
    if (hostGateway) throw new ProtocolError('AgentBay Docker 不支持指向 Controller 宿主的 hostGateway')
    if (network === 'host') throw new ProtocolError('安全策略禁止 Docker host 网络')
    const containerName = safeDockerName(name)
    const staged = []
    try {
      if (runAsCurrentUser && this.identity === null) this.identity = await this.bridge.request('identity')
      for (const mount of mounts) {
        if (!isAbsolute(mount.source) || !mount.target?.startsWith('/')) throw new ProtocolError('AgentBay mount 路径必须为绝对路径')
        const remotePath = (await this.bridge.request('allocatePath')).path
        await this.bridge.request('uploadDir', { localPath: mount.source, remotePath })
        if (runAsCurrentUser) {
          await this.bridge.request('preparePath', {
            remotePath,
            uid: this.identity.uid,
            gid: this.identity.gid,
          })
        }
        staged.push({ ...mount, remotePath })
      }
      const secrets = collectSecrets(secretEnvironment, inheritEnvironment)
      const args = [
        'run', '--name', containerName, '--label', 'io.harness-rsi.managed=true', '--network', network,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      ]
      appendResources(args, resources)
      if (readOnlyRoot) args.push('--read-only')
      if (runAsCurrentUser) args.push('--user', `${this.identity.uid}:${this.identity.gid}`)
      for (const value of tmpfs) args.push('--tmpfs', value)
      for (const capability of capabilities) {
        if (!ALLOWED_CAPABILITIES.has(capability)) throw new ProtocolError(`Docker capability 不在受控名单中：${capability}`)
        args.push('--cap-add', capability)
      }
      for (const mount of staged) {
        args.push('--mount', `type=bind,src=${mount.remotePath},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`)
      }
      appendEnvironment(args, environment)
      if (Object.keys(secrets).length > 0) args.push(SECRET_ENV_MARKER)
      if (workdir) args.push('--workdir', workdir)
      if (entrypoint) args.push('--entrypoint', entrypoint)
      args.push(image, ...command)
      let result
      try {
        result = await this.docker(args, { timeoutMs, secretEnvironment: secrets, operation: 'run' })
      } finally {
        for (const mount of staged.filter((value) => !value.readOnly)) {
          await this.bridge.request('downloadDir', { remotePath: mount.remotePath, localPath: mount.source })
        }
        await this.removeContainer(containerName).catch(() => {})
      }
      return result
    } finally {
      await Promise.all(staged.map((mount) => this.bridge.request('removePath', { remotePath: mount.remotePath }).catch(() => {})))
    }
  }
}
