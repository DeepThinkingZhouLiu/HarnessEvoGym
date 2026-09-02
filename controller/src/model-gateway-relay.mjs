import { spawn } from 'node:child_process'
import http from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MODEL_GATEWAY_RELAY_PORT = 43119
export const MODEL_GATEWAY_RELAY_URL = `http://127.0.0.1:${MODEL_GATEWAY_RELAY_PORT}/v1`

const MAXIMUM_SOCKET_PATH_BYTES = 100
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function protocolFailure(message) {
  const error = new Error(message)
  error.code = 'MODEL_GATEWAY_RELAY_PROTOCOL'
  return error
}

function validateSocketPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/u.test(value)
      || Buffer.byteLength(value) > MAXIMUM_SOCKET_PATH_BYTES) {
    throw protocolFailure('relay socket path must be a short absolute path')
  }
  return resolve(value)
}

function validateChild(command, args) {
  if (typeof command !== 'string' || !isAbsolute(command) || /[\r\n\0]/u.test(command)
      || !Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw protocolFailure('relay child invocation is invalid')
  }
  return { command: resolve(command), args: [...args] }
}

function forwardHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => (
    !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined
  )))
}

export function createModelGatewayRelay({ socketPath }) {
  const targetSocket = validateSocketPath(socketPath)
  return http.createServer((request, response) => {
    const upstream = http.request({
      socketPath: targetSocket,
      method: request.method,
      path: request.url,
      headers: forwardHeaders(request.headers),
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        forwardHeaders(upstreamResponse.headers),
      )
      upstreamResponse.pipe(response)
    })
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('model gateway relay unavailable')
    })
    request.once('aborted', () => upstream.destroy())
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy()
    })
    request.pipe(upstream)
  })
}

export async function runModelGatewayRelay({ socketPath, command, args = [] }) {
  const childInvocation = validateChild(command, args)
  const server = createModelGatewayRelay({ socketPath })
  await new Promise((accept, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      accept()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(MODEL_GATEWAY_RELAY_PORT, '127.0.0.1')
  })

  let child
  try {
    child = spawn(childInvocation.command, childInvocation.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: 'inherit',
    })
    const result = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => accept({ exitCode, signal }))
    })
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return 128
    }
    return Number.isInteger(result.exitCode) ? result.exitCode : 1
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await new Promise((accept) => server.close(() => accept()))
    server.closeAllConnections?.()
  }
}

export function relayWrappedInvocation({ invocation, nodePath, relayPath, socketPath }) {
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)
      || typeof invocation.command !== 'string' || !Array.isArray(invocation.args)
      || typeof invocation.cwd !== 'string' || !invocation.env || typeof invocation.env !== 'object') {
    throw protocolFailure('relay invocation is invalid')
  }
  if (typeof nodePath !== 'string' || !isAbsolute(nodePath)
      || typeof relayPath !== 'string' || !isAbsolute(relayPath)) {
    throw protocolFailure('relay executable paths must be absolute')
  }
  return {
    ...invocation,
    command: resolve(nodePath),
    args: [resolve(relayPath), validateSocketPath(socketPath), invocation.command, ...invocation.args],
  }
}

const SOCAT_RELAY_SCRIPT = [
  'set -eu',
  `/usr/bin/socat TCP4-LISTEN:${MODEL_GATEWAY_RELAY_PORT},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:"$RSI_MODEL_GATEWAY_SOCKET" &`,
  'relay_pid=$!',
  'trap \'kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true\' EXIT HUP INT TERM',
  '/usr/bin/sleep 0.1',
  'set +e',
  '"$@"',
  'child_status=$?',
  'set -e',
  'kill "$relay_pid" 2>/dev/null || true',
  'wait "$relay_pid" 2>/dev/null || true',
  'trap - EXIT HUP INT TERM',
  'exit "$child_status"',
].join('\n')

/** Wrap a static native child without importing the host Node runtime. */
export function socatRelayWrappedInvocation({ invocation, socketPath }) {
  const childInvocation = validateChild(invocation?.command, invocation?.args)
  if (typeof invocation?.cwd !== 'string' || !invocation.env || typeof invocation.env !== 'object') {
    throw protocolFailure('relay invocation is invalid')
  }
  return {
    ...invocation,
    command: '/bin/sh',
    args: ['-c', SOCAT_RELAY_SCRIPT, 'harness-rsi-relay', childInvocation.command, ...childInvocation.args],
    env: { ...invocation.env, RSI_MODEL_GATEWAY_SOCKET: validateSocketPath(socketPath) },
  }
}

async function main() {
  const [socketPath, command, ...args] = process.argv.slice(2)
  if (command === undefined) throw protocolFailure('relay child command is required')
  process.exitCode = await runModelGatewayRelay({ socketPath, command, args })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
