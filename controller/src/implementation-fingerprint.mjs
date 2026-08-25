import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const EXPLICIT_RUNTIME_INPUTS = Object.freeze([
  'package.json',
  'adapters/targets/deepseek-harness.yml',
  'adapters/targets/msa-minimal.yml',
  'environments/putnambench-lean/zcloud-max-headless.patch.yml',
  'environments/hle-text-math/dashscope-qwen38-max-headless.patch.yml',
  'prompts/updater-mutate.md',
  'prompts/updater-mutate-soft.md',
])

async function requireRegularFile(root, relativePath) {
  const path = join(root, ...relativePath.split('/'))
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    throw new ProtocolError(`Controller implementation input 缺失：${relativePath}`, [error.message])
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ProtocolError(`Controller implementation input 必须是普通文件：${relativePath}`)
  }
  return path
}

/** Bind campaign state to the exact trusted code/prompts/patch that execute it. */
export async function fingerprintControllerImplementation(repositoryRoot) {
  const root = resolve(repositoryRoot)
  const sourceRoot = join(root, 'controller', 'src')
  let entries
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch (error) {
    throw new ProtocolError('无法枚举 Controller implementation', [error.message])
  }
  const inputs = [
    ...entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.mjs'))
      .map((entry) => `controller/src/${entry.name}`),
    ...EXPLICIT_RUNTIME_INPUTS,
  ].sort()
  if (inputs.length === EXPLICIT_RUNTIME_INPUTS.length) {
    throw new ProtocolError('Controller implementation 不包含任何 .mjs source')
  }
  const hash = createHash('sha256').update('harness-rsi-controller-implementation-v1\0')
  for (const relativePath of inputs) {
    const path = await requireRegularFile(root, relativePath)
    const normalized = relative(root, path).split(sep).join('/')
    if (normalized !== relativePath) throw new ProtocolError('Controller implementation 路径归一化失败')
    const content = await readFile(path)
    hash.update(relativePath).update('\0').update(content).update('\0')
  }
  return hash.digest('hex')
}
