import { createReadStream } from 'node:fs'

import { ProtocolError } from './protocol.mjs'

const MAXIMUM_SECRET_BYTES = 64 * 1024

export function parseSecretFd(value, optionName = 'zcloud-key-fd') {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    throw new ProtocolError(`--${optionName} 必须是文件描述符整数`)
  }
  const fd = Number(value)
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new ProtocolError(`--${optionName} 必须是不小于 3 的文件描述符`)
  }
  return fd
}

async function readInheritedFd(fd, maximumBytes = MAXIMUM_SECRET_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const stream = createReadStream('', { fd, autoClose: true })
    const wipeChunks = () => {
      for (const chunk of chunks) chunk.fill(0)
      chunks.length = 0
    }

    stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maximumBytes) {
        stream.destroy(new ProtocolError('凭据文件描述符内容过大'))
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', (error) => {
      wipeChunks()
      reject(error)
    })
    stream.once('end', () => {
      const value = Buffer.concat(chunks)
      wipeChunks()
      resolve(value)
    })
  })
}

function normalizeSecret(buffer, optionName) {
  const value = buffer.toString('utf8').trim()
  buffer.fill(0)
  if (value.length < 8 || Buffer.byteLength(value) > MAXIMUM_SECRET_BYTES || /[\r\n]/u.test(value)) {
    throw new ProtocolError(`--${optionName} 未提供合法凭据`)
  }
  return value
}

/**
 * Return an accessor that consumes the inherited descriptor at most once.
 * Provider code may request the key repeatedly; all later calls use the same
 * in-memory promise and never touch the descriptor or environment variables.
 */
export function createCachedSecretReader({
  fd,
  optionName = 'zcloud-key-fd',
  readFd = readInheritedFd,
} = {}) {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new ProtocolError(`--${optionName} 必须是不小于 3 的文件描述符`)
  }
  if (typeof readFd !== 'function') throw new TypeError('readFd must be a function')
  let cached
  return async function getSecret() {
    if (!cached) {
      cached = Promise.resolve()
        .then(() => readFd(fd, MAXIMUM_SECRET_BYTES))
        .then((value) => normalizeSecret(Buffer.isBuffer(value) ? value : Buffer.from(value), optionName))
        .catch((error) => {
          if (error instanceof ProtocolError) throw error
          throw new ProtocolError(`无法从 --${optionName} 读取凭据`, [error.message])
        })
    }
    return cached
  }
}
