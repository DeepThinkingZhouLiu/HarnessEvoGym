import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { ProtocolError } from './protocol.mjs'

export const DEEPSEEK_HARNESS_MUTATION_POLICY = Object.freeze({
  alwaysReadOnly: [
    '.git',
    '.git/**',
    '.github/**',
    'vendor/**',
    'packages/credentials/**',
    'packages/interaction/permission-presets/**',
    'packages/interaction/user-approval/**',
    'packages/llm/token-meter/**',
    'packages/llm/llm-pi-ai/**',
    'packages/core/agent-default-model/**',
    'packages/sandbox/**',
    '**/.env',
    '**/.env.*',
    '**/*credentials*.yml',
    '**/*credentials*.yaml',
  ],
  levels: {
    l1: ['apps/cli/config/agent-presets/**'],
    l2: [
      'apps/cli/config/agent-presets/**',
      'packages/compaction/**',
      'packages/context/**',
      'packages/extensions/**',
      'packages/guard/**',
      'packages/hooks/**',
      'packages/llm/llm-retry/**',
      'packages/plan/**',
      'packages/preset/**',
      'packages/skill/**',
      'packages/subagent/**',
      'packages/todo/**',
      'packages/workflow/**',
      'packages/web/**',
      'packages/fs/tool-*/**',
      'packages/interaction/tool-*/**',
      'packages/shell/tool-*/**',
    ],
    l3: [
      'apps/**',
      'examples/**',
      'native/**',
      'packages/**',
      'python/**',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig*.json',
    ],
  },
})

const LEVELS = ['l1', 'l2', 'l3']
const CREDENTIAL_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9._-]{20,}\b/u,
  /-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/u,
]

function normalizePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || path.startsWith('/')) {
    throw new ProtocolError(`非法 Candidate 相对路径：${String(path)}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ProtocolError(`非法 Candidate 相对路径：${path}`)
  }
  return path
}

function globToRegExp(glob) {
  let source = '^'
  for (let index = 0; index < glob.length;) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 3
        } else {
          source += '.*'
          index += 2
        }
      } else {
        source += '[^/]*'
        index += 1
      }
      continue
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
    index += 1
  }
  return new RegExp(`${source}$`, 'u')
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path))
}

function contentDigest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function walk(root, directory, output) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name)
    const rel = relative(root, fullPath).split(sep).join('/')
    normalizePath(rel)
    const stat = await lstat(fullPath)
    if (stat.isSymbolicLink()) {
      const target = await readlink(fullPath)
      output.set(rel, { type: 'symlink', mode: stat.mode & 0o777, target })
      continue
    }
    if (stat.isDirectory()) {
      await walk(root, fullPath, output)
      continue
    }
    if (!stat.isFile()) throw new ProtocolError(`Candidate 包含不支持的文件类型：${rel}`)
    const content = await readFile(fullPath)
    output.set(rel, {
      type: 'file',
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: contentDigest(content),
    })
  }
}

export async function snapshotTree(rootPath) {
  const root = resolve(rootPath)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProtocolError(`Candidate root 必须是真实目录：${root}`)
  }
  const files = new Map()
  await walk(root, root, files)
  return files
}

export function digestSnapshot(snapshot) {
  const hash = createHash('sha256')
  for (const [path, descriptor] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update('\0').update(JSON.stringify(descriptor)).update('\0')
  }
  return hash.digest('hex')
}

function descriptorEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function diffSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()])
  const changes = []
  for (const path of [...paths].sort()) {
    const previous = before.get(path)
    const current = after.get(path)
    if (!previous) changes.push({ path, kind: 'added', before: null, after: current })
    else if (!current) changes.push({ path, kind: 'deleted', before: previous, after: null })
    else if (!descriptorEqual(previous, current)) changes.push({ path, kind: 'modified', before: previous, after: current })
  }
  return changes
}

export function isPathAllowed(path, level, policy = DEEPSEEK_HARNESS_MUTATION_POLICY) {
  normalizePath(path)
  if (!LEVELS.includes(level)) throw new ProtocolError(`未知 mutation level：${level}`)
  if (matchesAny(path, policy.alwaysReadOnly)) return false
  return matchesAny(path, policy.levels[level])
}

function isExclusiveToLevel(path, level, policy) {
  if (!isPathAllowed(path, level, policy)) return false
  const index = LEVELS.indexOf(level)
  if (index === 0) return true
  return !LEVELS.slice(0, index).some((lowerLevel) => isPathAllowed(path, lowerLevel, policy))
}

export async function validateMutation({
  before,
  after,
  candidateRoot,
  level,
  policy = DEEPSEEK_HARNESS_MUTATION_POLICY,
  secretValues = [],
}) {
  const errors = []
  const changes = diffSnapshots(before, after)
  if (changes.length === 0) errors.push('Candidate 没有源码改动')
  for (const change of changes) {
    if (!isPathAllowed(change.path, level, policy)) {
      errors.push(`${change.path} 超出 ${level.toUpperCase()} 可写边界`)
    }
    if (change.after?.type === 'symlink' || change.before?.type === 'symlink') {
      errors.push(`${change.path} 不允许新增、删除或修改符号链接`)
    }
  }
  if (changes.length > 0 && !changes.some((change) => isExclusiveToLevel(change.path, level, policy))) {
    errors.push(`本轮必须至少修改一个 ${level.toUpperCase()} 专属路径`)
  }

  const normalizedSecrets = secretValues.filter((value) => typeof value === 'string' && value.length >= 8)
  for (const change of changes) {
    if (!change.after || change.after.type !== 'file') continue
    const fullPath = resolve(candidateRoot, change.path)
    const rel = relative(resolve(candidateRoot), fullPath)
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      errors.push(`${change.path} 解析后逃出 Candidate root`)
      continue
    }
    const content = await readFile(fullPath)
    const text = content.toString('utf8')
    if (normalizedSecrets.some((secret) => text.includes(secret))) {
      errors.push(`${change.path} 包含运行时凭据值`)
    }
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push(`${change.path} 疑似包含硬编码凭据`)
    }
  }
  if (errors.length > 0) throw new ProtocolError('Candidate mutation 校验失败', errors)
  return {
    level,
    changes: changes.map(({ path, kind }) => ({ path, kind })),
    beforeDigest: digestSnapshot(before),
    afterDigest: digestSnapshot(after),
  }
}

export function validateMutationProposal(input, {
  campaignId,
  candidateId,
  parentId,
  level,
  validationIds,
  policy = DEEPSEEK_HARNESS_MUTATION_POLICY,
}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('MutationProposal 必须是 JSON 对象')
  }
  if (input.apiVersion !== 'harness-rsi/v1alpha1') errors.push('apiVersion 无效')
  if (input.kind !== 'MutationProposal') errors.push('kind 必须是 MutationProposal')
  if (input.campaignId !== campaignId) errors.push('campaignId 不匹配')
  if (input.candidateId !== candidateId) errors.push('candidateId 不匹配')
  if (input.parentId !== parentId) errors.push('parentId 不匹配')
  if (input.level !== level) errors.push('level 不匹配')
  for (const field of ['proposalId', 'createdAt', 'direction', 'hypothesis', 'expectedEffect']) {
    if (typeof input[field] !== 'string' || input[field].trim().length === 0) errors.push(`${field} 必须是非空字符串`)
  }
  if (input.model?.model !== 'gpt-5.6-sol' || input.model?.effort !== 'max') {
    errors.push('proposal model 必须是 gpt-5.6-sol/max')
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    errors.push('evidence 必须是非空数组')
  } else {
    const allowedIds = new Set(validationIds)
    input.evidence.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`evidence[${index}] 必须是对象`)
        return
      }
      if (entry.problemId !== undefined && !allowedIds.has(entry.problemId)) {
        errors.push(`evidence[${index}].problemId 不属于 validation`)
      }
      if (typeof entry.observation !== 'string' || entry.observation.trim().length === 0) {
        errors.push(`evidence[${index}].observation 必须是非空字符串`)
      }
    })
  }
  if (!Array.isArray(input.intendedFiles) || input.intendedFiles.length === 0) {
    errors.push('intendedFiles 必须是非空数组')
  } else {
    input.intendedFiles.forEach((path, index) => {
      try {
        if (!isPathAllowed(path, level, policy)) errors.push(`intendedFiles[${index}] 超出 ${level.toUpperCase()} 边界`)
      } catch (error) {
        errors.push(`intendedFiles[${index}] 非法：${error.message}`)
      }
    })
    if (!input.intendedFiles.some((path) => {
      try { return isExclusiveToLevel(path, level, policy) } catch { return false }
    })) errors.push(`intendedFiles 必须至少包含一个 ${level.toUpperCase()} 专属路径`)
  }
  if (!Array.isArray(input.risks)) errors.push('risks 必须是数组')
  if (errors.length > 0) throw new ProtocolError('MutationProposal 校验失败', errors)
  return structuredClone(input)
}
