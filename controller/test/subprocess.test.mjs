import assert from 'node:assert/strict'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readSecretFd, redactText, runProcess } from '../src/subprocess.mjs'

test('redactText removes exact and credential-shaped secrets', () => {
  assert.equal(redactText(`a SECRET-VALUE b ${'ghp_' + 'x'.repeat(24)}`, ['SECRET-VALUE']), 'a [REDACTED] b [REDACTED]')
})

test('readSecretFd reads a descriptor and rejects low descriptors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'secret-fd-'))
  const path = join(directory, 'secret')
  await writeFile(path, 'one-line-secret\n')
  const fd = openSync(path, 'r')
  try {
    assert.equal(readSecretFd(fd), 'one-line-secret')
  } finally {
    closeSync(fd)
  }
  assert.throws(() => readSecretFd(2))
})

test('runProcess captures successful output and redacts it', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('SECRET-VALUE'); process.stderr.write('ok')"],
    timeoutMs: 5_000,
    secretValues: ['SECRET-VALUE'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, '[REDACTED]')
  assert.equal(result.stderr, 'ok')
})

test('runProcess terminates a timeout', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 30,
    killGraceMs: 30,
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('runProcess stops output floods at the cap', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(100000))"],
    timeoutMs: 5_000,
    outputLimitBytes: 128,
  })
  assert.equal(result.ok, false)
  assert.equal(result.outputExceeded, true)
  assert.equal(Buffer.byteLength(result.stdout), 128)
})
