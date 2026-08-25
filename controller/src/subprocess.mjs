import { spawn } from 'node:child_process'
import { readSync } from 'node:fs'

import { ProtocolError } from './protocol.mjs'

const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024
const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9]{12,}\b/gu,
  /\bsk-[A-Za-z0-9._-]{12,}\b/gu,
  /-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH|RSA|EC) PRIVATE KEY-----/gu,
]

export function redactText(value, secretValues = []) {
  let text = String(value)
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]')
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]')
  return text
}

export function readSecretFd(fd, { maximumBytes = 16 * 1024 } = {}) {
  if (!Number.isInteger(fd) || fd < 3) throw new ProtocolError('Secret FD 必须是 >= 3 的整数')
  const chunks = []
  let total = 0
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(4096, maximumBytes + 1 - total))
    let bytes
    try {
      bytes = readSync(fd, buffer, 0, buffer.length, null)
    } catch (error) {
      buffer.fill(0)
      throw new ProtocolError(`无法读取 secret FD ${fd}`, [error.message])
    }
    if (bytes === 0) {
      buffer.fill(0)
      break
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)))
    buffer.fill(0)
    total += bytes
    if (total > maximumBytes) {
      chunks.forEach((chunk) => chunk.fill(0))
      throw new ProtocolError(`Secret FD ${fd} 超过 ${maximumBytes} bytes`)
    }
  }
  const combined = Buffer.concat(chunks)
  chunks.forEach((chunk) => chunk.fill(0))
  const value = combined.toString('utf8').replace(/[\r\n]+$/u, '')
  combined.fill(0)
  if (value.length === 0) throw new ProtocolError(`Secret FD ${fd} 为空`)
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new ProtocolError(`Secret FD ${fd} 必须只包含单行凭据`)
  }
  return value
}

function capture(stream, limit, onLimit) {
  const chunks = []
  let bytes = 0
  stream.on('data', (chunk) => {
    const buffer = Buffer.from(chunk)
    const remaining = Math.max(0, limit - bytes)
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining))
    bytes += buffer.length
    if (bytes > limit) onLimit()
  })
  return () => ({
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
    truncated: bytes > limit,
  })
}

export async function runProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  input,
  timeoutMs,
  signal,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT,
  secretValues = [],
  killGraceMs = 5_000,
}) {
  if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)) {
    throw new ProtocolError('runProcess command/args 无效')
  }
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new ProtocolError('runProcess timeoutMs 必须为正数或 null')
  }
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let timedOut = false
  let outputExceeded = false
  let abortHandler
  let forceTimer

  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const killGroup = (kind) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (process.platform === 'win32') child.kill(kind)
      else process.kill(-child.pid, kind)
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill(kind)
    }
  }
  const requestStop = () => {
    killGroup('SIGTERM')
    if (!forceTimer) {
      forceTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs)
      forceTimer.unref()
    }
  }
  const stdout = capture(child.stdout, outputLimitBytes, () => {
    if (!outputExceeded) {
      outputExceeded = true
      requestStop()
    }
  })
  const stderr = capture(child.stderr, outputLimitBytes, () => {
    if (!outputExceeded) {
      outputExceeded = true
      requestStop()
    }
  })

  if (input === undefined) child.stdin.end()
  else child.stdin.end(input)

  const timeout = timeoutMs === null ? null : setTimeout(() => {
    timedOut = true
    requestStop()
  }, timeoutMs)
  timeout?.unref()
  if (signal) {
    abortHandler = () => requestStop()
    if (signal.aborted) abortHandler()
    else signal.addEventListener('abort', abortHandler, { once: true })
  }

  let result
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, childSignal) => resolve({ code, signal: childSignal }))
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    if (forceTimer) clearTimeout(forceTimer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
  const out = stdout()
  const err = stderr()
  return {
    command,
    args: args.map((arg) => redactText(arg, secretValues)),
    cwd,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    aborted: signal?.aborted === true,
    outputExceeded,
    stdout: redactText(out.text, secretValues),
    stderr: redactText(err.text, secretValues),
    stdoutBytes: out.bytes,
    stderrBytes: err.bytes,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    ok: result.code === 0 && !timedOut && !outputExceeded && signal?.aborted !== true,
  }
}
