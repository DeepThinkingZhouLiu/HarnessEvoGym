import process from 'node:process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { ProtocolError } from './protocol.mjs'
import { runProcess, secretValuesFromEnvironment } from './process.mjs'

function safeDockerName(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (!normalized) throw new ProtocolError(`无法生成安全的 Docker 名称：${value}`)
  if (normalized.length <= 120) return normalized
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return `${normalized.slice(0, 103)}-${digest}`
}

function mountArgument({ source, target, readOnly = true }) {
  if (!isAbsolute(source) || !target.startsWith('/')) {
    throw new ProtocolError('Docker mount 必须提供绝对 source 与 container target')
  }
  if (source.includes(',') || target.includes(',')) throw new ProtocolError('Docker mount 路径不能包含逗号')
  return `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`
}

const ALLOWED_CAPABILITIES = new Set([
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
])

function appendCapabilities(args, capabilities) {
  if (!Array.isArray(capabilities)) throw new ProtocolError('Docker capabilities 必须是数组')
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ProtocolError('Docker capabilities 不能重复')
  }
  for (const capability of capabilities) {
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw new ProtocolError(`Docker capability 不在受控名单中：${capability}`)
    }
    args.push('--cap-add', capability)
  }
}

export class DockerClient {
  constructor({ binary = 'docker', network = 'bridge', resources, runAsCurrentUser = true } = {}) {
    if (network === 'host') throw new ProtocolError('安全策略禁止 Docker host 网络')
    if (runAsCurrentUser && typeof process.getuid === 'function' && process.getuid() === 0) {
      throw new ProtocolError('请用普通用户启动 Controller；安全策略拒绝宿主 root 身份')
    }
    this.binary = binary
    this.network = network
    this.resources = resources ?? { cpus: 2, memory: '4g', pids: 512, timeoutSeconds: 900 }
    this.runAsCurrentUser = runAsCurrentUser
  }

  async info() {
    return await runProcess(this.binary, ['version', '--format', '{{json .Server.Version}}'], { timeoutMs: 30_000 })
  }

  async imageExists(image) {
    try {
      await runProcess(this.binary, ['image', 'inspect', image], { timeoutMs: 30_000 })
      return true
    } catch {
      return false
    }
  }

  async imageLabel(image, label) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(label)) throw new ProtocolError(`非法 Docker Label：${label}`)
    const result = await runProcess(
      this.binary,
      ['image', 'inspect', '--format', `{{ with .Config.Labels }}{{ index . ${JSON.stringify(label)} }}{{ end }}`, image],
      { timeoutMs: 30_000 },
    )
    const value = result.stdout.trim()
    return value === '' || value === '<no value>' ? null : value
  }

  async imageId(image) {
    const result = await runProcess(
      this.binary,
      ['image', 'inspect', '--format', '{{.Id}}', image],
      { timeoutMs: 30_000 },
    )
    const value = result.stdout.trim()
    if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new ProtocolError(`Docker Image ID 无效：${image}`)
    return value
  }

  async build({ context, dockerfile, tag, buildArgs = {}, labels = {}, timeoutMs = 1_800_000 }) {
    const args = ['build', '--pull=false', '--file', dockerfile, '--tag', tag]
    for (const [name, value] of Object.entries(buildArgs)) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new ProtocolError(`非法 Docker build arg：${name}`)
      args.push('--build-arg', `${name}=${value}`)
    }
    for (const [name, value] of Object.entries(labels)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(name)) throw new ProtocolError(`非法 Docker Label：${name}`)
      if (typeof value !== 'string' || /[\u0000\r\n]/u.test(value)) throw new ProtocolError(`Docker Label 值无效：${name}`)
      args.push('--label', `${name}=${value}`)
    }
    args.push(context)
    return await runProcess(this.binary, args, { timeoutMs, maxOutputBytes: 16 * 1024 * 1024 })
  }

  async create({ image, name }) {
    const safeName = safeDockerName(name)
    const result = await runProcess(this.binary, ['create', '--name', safeName, image], { timeoutMs: 60_000 })
    return { id: result.stdout.trim(), name: safeName }
  }

  async copyFrom(container, source, destination) {
    return await runProcess(this.binary, ['cp', `${container}:${source}`, destination], { timeoutMs: 300_000 })
  }

  async removeContainer(container) {
    return await runProcess(this.binary, ['rm', '--force', container], {
      timeoutMs: 60_000,
      allowExitCodes: [0, 1],
    })
  }

  async createNetwork({ name, internal = true }) {
    const safeName = safeDockerName(name)
    const args = ['network', 'create']
    if (internal) args.push('--internal')
    args.push('--label', 'io.harness-rsi.managed=true', safeName)
    const result = await runProcess(this.binary, args, { timeoutMs: 60_000 })
    return { id: result.stdout.trim(), name: safeName }
  }

  async connectNetwork({ network, container, alias }) {
    const args = ['network', 'connect']
    if (alias) args.push('--alias', safeDockerName(alias))
    args.push(network, container)
    return await runProcess(this.binary, args, { timeoutMs: 60_000 })
  }

  async removeNetwork(network) {
    return await runProcess(this.binary, ['network', 'rm', network], {
      timeoutMs: 60_000,
      allowExitCodes: [0, 1],
    })
  }

  async containerHealth(container) {
    const result = await runProcess(
      this.binary,
      ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container],
      { timeoutMs: 30_000 },
    )
    return result.stdout.trim()
  }

  async containerLogs(container, secretEnvironment = []) {
    return await runProcess(this.binary, ['logs', '--tail', '200', container], {
      timeoutMs: 30_000,
      allowExitCodes: [0, 1],
      secretValues: secretValuesFromEnvironment(secretEnvironment),
    })
  }

  async exec({ container, command, timeoutMs = 30_000, secretValues = [] }) {
    if (!Array.isArray(command) || command.length === 0 || command.some((value) => typeof value !== 'string')) {
      throw new ProtocolError('Docker exec command 必须是非空字符串数组')
    }
    return await runProcess(this.binary, ['exec', container, ...command], {
      timeoutMs,
      secretValues,
    })
  }

  async runDetached(options) {
    const {
      image,
      name,
      network = 'bridge',
      environment = {},
      secretEnvironment = {},
      inheritEnvironment = [],
      resources = { cpus: 1, memory: '512m', pids: 128 },
    } = options
    if (network === 'host') throw new ProtocolError('安全策略禁止 Docker host 网络')
    const containerName = safeDockerName(name)
    const args = [
      'run',
      '--detach',
      '--name',
      containerName,
      '--label',
      'io.harness-rsi.managed=true',
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=64m',
      '--pids-limit',
      String(resources.pids),
      '--cpus',
      String(resources.cpus),
      '--memory',
      resources.memory,
    ]
    for (const [nameValue, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nameValue)) throw new ProtocolError(`非法环境变量名：${nameValue}`)
      args.push('--env', `${nameValue}=${value}`)
    }
    for (const [nameValue, value] of Object.entries(secretEnvironment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nameValue)) throw new ProtocolError(`非法环境变量名：${nameValue}`)
      if (typeof value !== 'string' || value.length === 0) throw new ProtocolError(`秘密环境变量不能为空：${nameValue}`)
      if (Object.hasOwn(environment, nameValue) || inheritEnvironment.includes(nameValue)) {
        throw new ProtocolError(`环境变量重复声明：${nameValue}`)
      }
      args.push('--env', nameValue)
    }
    for (const nameValue of inheritEnvironment) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nameValue)) throw new ProtocolError(`非法环境变量名：${nameValue}`)
      if (Object.hasOwn(environment, nameValue)) throw new ProtocolError(`环境变量重复声明：${nameValue}`)
      if (!process.env[nameValue]) throw new ProtocolError(`缺少运行时凭据环境变量：${nameValue}`)
      args.push('--env', nameValue)
    }
    args.push(image)
    const result = await runProcess(this.binary, args, {
      timeoutMs: 60_000,
      env: { ...process.env, ...secretEnvironment },
      secretValues: [
        ...Object.values(secretEnvironment),
        ...secretValuesFromEnvironment(inheritEnvironment),
      ],
    })
    return { id: result.stdout.trim(), name: containerName }
  }

  async run(options) {
    const {
      image,
      name,
      command = [],
      mounts = [],
      environment = {},
      secretEnvironment = {},
      inheritEnvironment = [],
      entrypoint = null,
      workdir,
      network = this.network,
      runAsCurrentUser = this.runAsCurrentUser,
      readOnlyRoot = true,
      hostGateway = false,
      tmpfs = ['/tmp:rw,nosuid,nodev,size=1g', '/run:rw,nosuid,nodev,size=64m'],
      capabilities = [],
      timeoutMs = this.resources.timeoutSeconds * 1000,
      resources = this.resources,
    } = options
    if (network === 'host') throw new ProtocolError('安全策略禁止 Docker host 网络')
    if (typeof hostGateway !== 'boolean') throw new ProtocolError('Docker hostGateway 必须是布尔值')
    if (
      entrypoint !== null &&
      (typeof entrypoint !== 'string' || entrypoint.length === 0 || entrypoint.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(entrypoint))
    ) {
      throw new ProtocolError('Docker entrypoint 必须是安全的非空字符串')
    }
    const containerName = safeDockerName(name)
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--label',
      'io.harness-rsi.managed=true',
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      String(resources.pids),
      '--cpus',
      String(resources.cpus),
      '--memory',
      resources.memory,
    ]
    appendCapabilities(args, capabilities)
    if (hostGateway) args.push('--add-host', 'host.docker.internal:host-gateway')
    if (readOnlyRoot) args.push('--read-only')
    if (runAsCurrentUser && typeof process.getuid === 'function') {
      if (process.getuid() === 0) {
        throw new ProtocolError('拒绝把 Solver/Updater 以宿主 root 身份运行；请用普通用户启动 Controller')
      }
      args.push('--user', `${process.getuid()}:${process.getgid()}`)
    }
    for (const value of tmpfs) args.push('--tmpfs', value)
    for (const mount of mounts) args.push('--mount', mountArgument(mount))
    for (const [nameValue, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nameValue)) throw new ProtocolError(`非法环境变量名：${nameValue}`)
      args.push('--env', `${nameValue}=${value}`)
    }
    for (const [nameValue, value] of Object.entries(secretEnvironment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nameValue)) throw new ProtocolError(`非法环境变量名：${nameValue}`)
      if (typeof value !== 'string' || value.length === 0) throw new ProtocolError(`秘密环境变量不能为空：${nameValue}`)
      if (Object.hasOwn(environment, nameValue) || inheritEnvironment.includes(nameValue)) {
        throw new ProtocolError(`环境变量重复声明：${nameValue}`)
      }
      args.push('--env', nameValue)
    }
    for (const nameValue of inheritEnvironment) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nameValue)) throw new ProtocolError(`非法环境变量名：${nameValue}`)
      if (Object.hasOwn(environment, nameValue)) throw new ProtocolError(`环境变量重复声明：${nameValue}`)
      if (!process.env[nameValue]) throw new ProtocolError(`缺少运行时凭据环境变量：${nameValue}`)
      args.push('--env', nameValue)
    }
    if (workdir) args.push('--workdir', workdir)
    if (entrypoint) args.push('--entrypoint', entrypoint)
    args.push(image, ...command)
    try {
      return await runProcess(this.binary, args, {
        timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024,
        env: { ...process.env, ...secretEnvironment },
        secretValues: [
          ...Object.values(secretEnvironment),
          ...secretValuesFromEnvironment(inheritEnvironment),
        ],
      })
    } catch (error) {
      try {
        await this.removeContainer(containerName)
      } catch {
        // 保留原始运行错误；清理失败不会把根因覆盖掉。
      }
      throw error
    }
  }
}

export { safeDockerName }
