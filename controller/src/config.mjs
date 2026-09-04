import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { ProtocolError } from './protocol.mjs'

export const API_VERSION = 'harness-rsi/v1alpha1'
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function expectObject(value, label) {
  if (!isObject(value)) throw new ProtocolError(`${label} 必须是对象`)
  return value
}

export function expectText(value, label) {
  if (!hasText(value)) throw new ProtocolError(`${label} 必须是非空字符串`)
  return value.trim()
}

export function expectBoolean(value, label) {
  if (typeof value !== 'boolean') throw new ProtocolError(`${label} 必须是布尔值`)
  return value
}

export function expectNumber(value, label, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${label} 必须是有限数字`)
  }
  if (integer && !Number.isInteger(value)) throw new ProtocolError(`${label} 必须是整数`)
  if (value < min || value > max) throw new ProtocolError(`${label} 必须位于 ${min} 到 ${max} 之间`)
  return value
}

export function expectStringArray(value, label, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new ProtocolError(`${label} 必须是${nonEmpty ? '非空' : ''}字符串数组`)
  }
  const output = value.map((item, index) => expectText(item, `${label}[${index}]`))
  if (new Set(output).size !== output.length) throw new ProtocolError(`${label} 不能包含重复值`)
  return output
}

export async function readConfigFile(filePath) {
  await assertPathKind(filePath, '配置文件', 'file')
  let source
  try {
    source = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new ProtocolError(`无法读取配置文件：${filePath}`, [error.message])
  }

  try {
    if (filePath.endsWith('.json')) return JSON.parse(source)
    if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
      return parseYaml(source)
    }
  } catch (error) {
    throw new ProtocolError(`配置文件格式错误：${filePath}`, [error.message])
  }
  throw new ProtocolError(`不支持的配置格式：${filePath}`, ['只支持 .json、.yml 或 .yaml'])
}

export function resolveInside(root, pathValue, label) {
  const input = expectText(pathValue, label)
  if (isAbsolute(input)) throw new ProtocolError(`${label} 必须是相对路径`)
  const absolute = resolve(root, input)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 不能逃逸受控目录`)
  }
  return absolute
}

export async function assertPathKind(pathValue, label, expected = 'directory') {
  let info
  try {
    info = await lstat(pathValue)
  } catch (error) {
    throw new ProtocolError(`${label} 不存在：${pathValue}`, [error.message])
  }
  if (info.isSymbolicLink()) {
    throw new ProtocolError(`${label} 不能是符号链接：${pathValue}`)
  }
  const valid = expected === 'file' ? info.isFile() : info.isDirectory()
  if (!valid) throw new ProtocolError(`${label} 必须是${expected === 'file' ? '文件' : '目录'}：${pathValue}`)
  return pathValue
}

export function assertApiObject(input, kind, label = kind) {
  expectObject(input, label)
  if (input.apiVersion !== API_VERSION) throw new ProtocolError(`${label}.apiVersion 必须是 ${API_VERSION}`)
  if (input.kind !== kind) throw new ProtocolError(`${label}.kind 必须是 ${kind}`)
  return input
}
