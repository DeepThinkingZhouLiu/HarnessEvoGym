import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MODEL_GATEWAY_RELAY_PORT,
  MODEL_GATEWAY_RELAY_URL,
  createModelGatewayRelay,
  relayWrappedInvocation,
} from '../src/model-gateway-relay.mjs'

function requestRelay() {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: MODEL_GATEWAY_RELAY_PORT,
      path: '/v1/responses',
      method: 'POST',
      headers: { authorization: 'Bearer dummy', connection: 'close' },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end('{"input":"hello"}')
  })
}

test('relay forwards the fixed loopback endpoint only through its Unix socket', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-relay-'))
  const socketPath = join(root, 'gateway.sock')
  let received
  const upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.once('end', () => {
      received = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(socketPath, resolve)
  })
  const relay = createModelGatewayRelay({ socketPath })
  await new Promise((resolve, reject) => {
    relay.once('error', reject)
    relay.listen(MODEL_GATEWAY_RELAY_PORT, '127.0.0.1', resolve)
  })
  t.after(async () => {
    await new Promise((resolve) => relay.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const response = await requestRelay()
  assert.deepEqual(response, { status: 201, body: '{"ok":true}' })
  assert.deepEqual(received, {
    method: 'POST',
    path: '/v1/responses',
    authorization: 'Bearer dummy',
    body: '{"input":"hello"}',
  })
  assert.equal(MODEL_GATEWAY_RELAY_URL, 'http://127.0.0.1:43119/v1')
})

test('relay wrapper preserves the original command as inert arguments', () => {
  const invocation = relayWrappedInvocation({
    invocation: { command: '/candidate/dsh', args: ['--flag'], cwd: '/work', env: {} },
    nodePath: '/toolchain/bin/node',
    relayPath: '/controller/model-gateway-relay.mjs',
    socketPath: '/gateway/gateway.sock',
  })
  assert.equal(invocation.command, '/toolchain/bin/node')
  assert.deepEqual(invocation.args, [
    '/controller/model-gateway-relay.mjs',
    '/gateway/gateway.sock',
    '/candidate/dsh',
    '--flag',
  ])
})
