import { spawn } from 'node:child_process'
import { ProtocolError } from './protocol.mjs'

function redact(text, secretValues) {
  let output = text
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 4) output = output.replaceAll(secret, '[REDACTED]')
  }
  return output
}

export async function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 300_000,
    maxOutputBytes = 4 * 1024 * 1024,
    allowExitCodes = [0],
    input,
    secretValues = [],
  } = options
  if (typeof command !== 'string' || command.trim().length === 0) throw new ProtocolError('进程命令不能为空')
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new ProtocolError('进程参数必须是字符串数组')
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow = false
    let timedOut = false
    const startedAt = Date.now()

    function collect(chunks, chunk, currentBytes) {
      if (currentBytes >= maxOutputBytes) {
        overflow = true
        return currentBytes
      }
      const remaining = maxOutputBytes - currentBytes
      chunks.push(chunk.subarray(0, remaining))
      if (chunk.length > remaining) overflow = true
      return currentBytes + Math.min(chunk.length, remaining)
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes = collect(stderrChunks, chunk, stderrBytes)
    })
    child.on('error', (error) => reject(new ProtocolError(`无法启动命令：${command}`, [error.message])))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, timeoutMs)
    timer.unref()

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = {
        command,
        args,
        exitCode: code,
        signal,
        timedOut,
        outputTruncated: overflow,
        durationMs: Date.now() - startedAt,
        stdout: redact(Buffer.concat(stdoutChunks).toString('utf8'), secretValues),
        stderr: redact(Buffer.concat(stderrChunks).toString('utf8'), secretValues),
      }
      if (timedOut || !allowExitCodes.includes(code)) {
        const reason = timedOut ? `命令超时（${timeoutMs}ms）` : `命令退出码 ${code}`
        reject(new ProtocolError(`${reason}：${command}`, [result.stderr.slice(-4000), result.stdout.slice(-2000)].filter(Boolean)))
        return
      }
      resolve(result)
    })

    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function secretValuesFromEnvironment(names, environment = process.env) {
  return names.map((name) => environment[name]).filter((value) => typeof value === 'string' && value.length > 0)
}
