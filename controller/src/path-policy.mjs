import { extname, isAbsolute, posix } from 'node:path'
import { ProtocolError } from './protocol.mjs'

export function normalizeRelativePath(input, label = '路径') {
  if (typeof input !== 'string' || input.length === 0 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new ProtocolError(`${label} 必须是非空安全路径`)
  }
  const unix = input.replaceAll('\\', '/')
  if (isAbsolute(unix) || /^[A-Za-z]:\//u.test(unix)) throw new ProtocolError(`${label} 不能是绝对路径`)
  const normalized = posix.normalize(unix)
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new ProtocolError(`${label} 不能逃逸候选目录`)
  }
  return normalized.replace(/^\.\//u, '')
}

function escapeRegex(character) {
  return /[\\^$+.()|{}[\]]/u.test(character) ? `\\${character}` : character
}

export function globToRegExp(pattern) {
  const normalized = normalizeRelativePath(pattern, 'Glob')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*') {
      const isDouble = normalized[index + 1] === '*'
      if (isDouble) {
        index += 1
        if (normalized[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    source += escapeRegex(character)
  }
  return new RegExp(`${source}$`, 'u')
}

export function matchesAny(pathValue, patterns) {
  const normalized = normalizeRelativePath(pathValue)
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized))
}

export function extensionOf(pathValue) {
  return extname(pathValue).toLowerCase()
}

export function evaluatePathPolicy(pathValue, policy) {
  const path = normalizeRelativePath(pathValue)
  if (matchesAny(path, policy.readOnly)) {
    return { allowed: false, path, reason: '命中永久只读规则' }
  }
  if (!matchesAny(path, policy.writable)) {
    return { allowed: false, path, reason: '不在当前变异层级白名单中' }
  }
  const extension = extensionOf(path)
  if (!policy.extensions.includes(extension)) {
    return { allowed: false, path, reason: `文件扩展名 ${extension || '(无)'} 不在当前层级白名单中` }
  }
  return { allowed: true, path, reason: null }
}
