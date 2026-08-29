import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const CHECKPOINT_KIND = 'TaskTrialCheckpoint'
const CHECKPOINT_FILE = 'committed-result.json'
const MAXIMUM_CHECKPOINT_BYTES = 4 * 1024 * 1024

function canonicalJson(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`))
  if (!value || typeof value !== 'object') {
    throw new ProtocolError(`Trial Checkpoint 只接受普通 JSON：${path}`)
  }
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new ProtocolError(`Trial Checkpoint 不能包含 undefined：${path}.${key}`)
    output[key] = canonicalJson(value[key], `${path}.${key}`)
  }
  return output
}

export function trialCheckpointDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex')
}

function assertInside(root, pathValue, label) {
  const rel = relative(resolve(root), resolve(pathValue))
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ProtocolError(`${label} 逃逸受控 Run Root`)
  }
  return rel.replaceAll('\\', '/')
}

async function entry(pathValue, label) {
  try {
    const info = await lstat(pathValue)
    if (info.isSymbolicLink()) throw new ProtocolError(`${label} 不能是符号链接`)
    return info
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function readCheckpoint(pathValue) {
  const info = await entry(pathValue, 'Trial Checkpoint')
  if (info === null) return null
  if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAXIMUM_CHECKPOINT_BYTES) {
    throw new ProtocolError('Trial Checkpoint 必须是大小受限的独立普通文件')
  }
  let value
  try {
    value = JSON.parse(await readFile(pathValue, 'utf8'))
  } catch (error) {
    throw new ProtocolError('Trial Checkpoint JSON 已损坏', [error.message])
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.apiVersion !== API_VERSION || value.kind !== CHECKPOINT_KIND
      || !value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)
      || !value.spec || typeof value.spec !== 'object' || Array.isArray(value.spec)) {
    throw new ProtocolError('Trial Checkpoint 协议无效')
  }
  const identityDigest = trialCheckpointDigest(value.spec.identity)
  const recordDigest = trialCheckpointDigest(value.spec.record)
  if (value.metadata.identityDigest !== identityDigest || value.metadata.recordDigest !== recordDigest) {
    throw new ProtocolError('Trial Checkpoint 内容摘要不一致')
  }
  return value
}

export async function inspectTrialCheckpoint({ runRoot, taskRoot, identity, validateRecord }) {
  if (typeof validateRecord !== 'function') throw new ProtocolError('Trial Checkpoint 缺少 Record Validator')
  assertInside(runRoot, taskRoot, 'Trial Task Root')
  const taskInfo = await entry(taskRoot, 'Trial Task Root')
  if (taskInfo === null) return { status: 'missing' }
  if (!taskInfo.isDirectory()) throw new ProtocolError('Trial Task Root 必须是普通目录')

  const checkpoint = await readCheckpoint(join(taskRoot, CHECKPOINT_FILE))
  if (checkpoint === null) return { status: 'incomplete' }
  const expectedDigest = trialCheckpointDigest(identity)
  if (checkpoint.metadata.identityDigest !== expectedDigest) {
    return { status: 'stale', actualIdentity: checkpoint.spec.identity }
  }
  const record = await validateRecord(structuredClone(checkpoint.spec.record))
  return { status: 'committed', record }
}

export async function quarantineTrialTask({ runRoot, taskRoot, reason }) {
  const relativeTask = assertInside(runRoot, taskRoot, 'Trial Task Root')
  const taskInfo = await entry(taskRoot, 'Trial Task Root')
  if (taskInfo === null) return null
  if (!taskInfo.isDirectory()) throw new ProtocolError('Trial Task Root 必须是普通目录')
  const attemptId = `${new Date().toISOString().replace(/[:.]/gu, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`
  const destination = join(runRoot, 'recovery', 'trial-attempts', relativeTask, attemptId)
  assertInside(runRoot, destination, 'Trial Recovery Root')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await rename(taskRoot, destination)
  await writeFile(join(destination, 'recovery.json'), `${JSON.stringify({
    apiVersion: API_VERSION,
    kind: 'TrialRecoveryRecord',
    metadata: { attemptId, archivedAt: new Date().toISOString() },
    spec: { reason },
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return destination
}

export async function commitTrialCheckpoint({ runRoot, taskRoot, identity, record }) {
  assertInside(runRoot, taskRoot, 'Trial Task Root')
  const taskInfo = await entry(taskRoot, 'Trial Task Root')
  if (taskInfo === null || !taskInfo.isDirectory()) {
    throw new ProtocolError('提交 Trial Checkpoint 前 Task Root 必须存在')
  }
  const checkpointPath = join(taskRoot, CHECKPOINT_FILE)
  if (await entry(checkpointPath, 'Trial Checkpoint') !== null) {
    throw new ProtocolError('Trial Checkpoint 已提交，拒绝覆盖')
  }
  const checkpoint = {
    apiVersion: API_VERSION,
    kind: CHECKPOINT_KIND,
    metadata: {
      identityDigest: trialCheckpointDigest(identity),
      recordDigest: trialCheckpointDigest(record),
      committedAt: new Date().toISOString(),
    },
    spec: {
      identity: canonicalJson(identity),
      record: canonicalJson(record),
    },
  }
  const temporaryPath = `${checkpointPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, checkpointPath)
  return checkpointPath
}

