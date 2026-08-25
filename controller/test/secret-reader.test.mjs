import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCachedSecretReader,
  parseSecretFd,
} from '../src/secret-reader.mjs'

test('secret fd must be inherited descriptor 3 or greater', () => {
  assert.equal(parseSecretFd('3'), 3)
  assert.equal(parseSecretFd('27'), 27)
  for (const value of ['-1', '2', '3.1', 'x', '']) {
    assert.throws(() => parseSecretFd(value), /文件描述符/u)
  }
})

test('cached secret reader consumes the descriptor exactly once', async () => {
  let reads = 0
  const reader = createCachedSecretReader({
    fd: 9,
    async readFd(fd, maximumBytes) {
      reads += 1
      assert.equal(fd, 9)
      assert.equal(maximumBytes, 64 * 1024)
      return Buffer.from('  provider-secret-value  \n')
    },
  })

  const [first, second, third] = await Promise.all([reader(), reader(), reader()])
  assert.equal(first, 'provider-secret-value')
  assert.equal(second, first)
  assert.equal(third, first)
  assert.equal(reads, 1)
  assert.equal(await reader(), first)
  assert.equal(reads, 1)
})

test('cached secret reader rejects multiline and short values without retrying the fd', async () => {
  for (const value of ['short', 'secret-one\nsecret-two']) {
    let reads = 0
    const reader = createCachedSecretReader({
      fd: 8,
      async readFd() {
        reads += 1
        return Buffer.from(value)
      },
    })
    await assert.rejects(reader, /合法凭据/u)
    await assert.rejects(reader, /合法凭据/u)
    assert.equal(reads, 1)
  }
})
