import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { evaluatePathPolicy, normalizeRelativePath } from './path-policy.mjs'
import { ProtocolError, writeJsonFile } from './protocol.mjs'

const DIRECTORY_MODE = 0o755
const FILE_MODE = 0o644

async function assertRegularTreeEntry(pathValue, label) {
  const info = await lstat(pathValue)
  if (info.isSymbolicLink()) throw new ProtocolError(`${label} 包含符号链接，拒绝实例化：${pathValue}`)
  if (!info.isDirectory() && !info.isFile()) throw new ProtocolError(`${label} 包含特殊文件，拒绝实例化：${pathValue}`)
  return info
}

export async function copyRegularTree(sourceRoot, destinationRoot) {
  try {
    await stat(destinationRoot)
    throw new ProtocolError(`目标目录已存在，拒绝覆盖：${destinationRoot}`)
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    if (error.code !== 'ENOENT') throw error
  }

  await mkdir(destinationRoot, { recursive: false, mode: DIRECTORY_MODE })

  async function visit(source, destination) {
    const entries = await readdir(source, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const destinationPath = join(destination, entry.name)
      const info = await assertRegularTreeEntry(sourcePath, '候选模板')
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: DIRECTORY_MODE })
        await visit(sourcePath, destinationPath)
        continue
      }
      await copyFile(sourcePath, destinationPath)
      await open(destinationPath, 'r+').then(async (handle) => {
        try {
          await handle.chmod(info.mode & 0o111 ? 0o755 : FILE_MODE)
        } finally {
          await handle.close()
        }
      })
    }
  }

  await visit(sourceRoot, destinationRoot)
  return destinationRoot
}

async function hashFile(filePath) {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

export async function snapshotTree(root, { maximumFileBytes = Infinity, maximumTreeEntries = Infinity } = {}) {
  const files = new Map()
  let treeEntries = 0

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      treeEntries += 1
      if (treeEntries > maximumTreeEntries) {
        throw new ProtocolError('Candidate 目录项数量超过上限', [
          `actual>${maximumTreeEntries}`,
          `limit=${maximumTreeEntries}`,
        ])
      }
      const absolute = join(directory, entry.name)
      const relativePath = normalizeRelativePath(relative(root, absolute))
      const info = await assertRegularTreeEntry(absolute, 'Candidate')
      if (info.isDirectory()) {
        files.set(relativePath, {
          path: relativePath,
          kind: 'directory',
          bytes: 0,
        })
        await visit(absolute)
        continue
      }
      if (info.size > maximumFileBytes) {
        throw new ProtocolError(`Candidate 文件超过单文件上限：${relativePath}`, [
          `actual=${info.size}`,
          `limit=${maximumFileBytes}`,
        ])
      }
      files.set(relativePath, {
        path: relativePath,
        kind: 'file',
        sha256: await hashFile(absolute),
        bytes: info.size,
        executable: Boolean(info.mode & 0o111),
      })
    }
  }

  await visit(root)
  return files
}

export function treeDigest(snapshot) {
  const hash = createHash('sha256')
  for (const record of [...snapshot.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(
      `${record.path}\0${record.kind ?? 'file'}\0${record.sha256 ?? ''}\0${record.bytes}\0${Number(record.executable ?? false)}\n`,
    )
  }
  return hash.digest('hex')
}

export function diffSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()])
  const changes = []
  for (const path of [...paths].sort()) {
    const previous = before.get(path)
    const current = after.get(path)
    if (!previous) changes.push({ type: 'added', path, before: null, after: current })
    else if (!current) changes.push({ type: 'deleted', path, before: previous, after: null })
    else if (
      previous.kind !== current.kind ||
      previous.sha256 !== current.sha256 ||
      previous.executable !== current.executable
    ) {
      changes.push({ type: 'modified', path, before: previous, after: current })
    }
  }
  return changes
}

export function mutationPolicyFor(target, levelName) {
  const level = target.mutation.levels[levelName]
  if (!level) throw new ProtocolError(`Target ${target.id} 不支持变异层级 ${levelName}`)
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationPolicy',
    metadata: { target: target.id, level: levelName },
    spec: {
      description: level.description,
      writable: level.writable,
      readOnly: target.mutation.alwaysReadOnly,
      extensions: level.extensions,
      limits: target.mutation.limits,
    },
  }
}

export function enforceMutationPolicy(changes, mutationPolicy) {
  const policy = mutationPolicy.spec
  const violations = []
  let changedBytes = 0
  const isDirectory = (record) => record?.kind === 'directory'
  const directoryChanges = changes.filter(
    (change) => isDirectory(change.before) || isDirectory(change.after),
  )
  const fileChanges = changes.filter(
    (change) => (change.before && !isDirectory(change.before)) || (change.after && !isDirectory(change.after)),
  )

  if (fileChanges.length === 0) {
    violations.push({ path: '*', reason: 'Updater 未产生任何 Candidate 文件改动' })
  }

  for (const change of directoryChanges) {
    if (change.before && change.after && change.before.kind !== change.after.kind) {
      violations.push({ path: change.path, reason: '不允许在文件与目录之间改变类型' })
      continue
    }
    if (!fileChanges.some((fileChange) => fileChange.path.startsWith(`${change.path}/`))) {
      violations.push({ path: change.path, reason: '不允许单独新增或删除空目录' })
    }
  }

  for (const change of fileChanges) {
    const decision = evaluatePathPolicy(change.path, {
      writable: policy.writable,
      readOnly: policy.readOnly,
      extensions: policy.extensions,
    })
    if (!decision.allowed) violations.push({ path: change.path, reason: decision.reason })
    if (change.after?.executable) {
      const executableExtensions = ['.py', '.js', '.mjs', '.sh']
      const extension = change.path.slice(change.path.lastIndexOf('.')).toLowerCase()
      if (mutationPolicy.metadata.level === 'l1' || !executableExtensions.includes(extension)) {
        violations.push({ path: change.path, reason: '当前层级不允许该文件具有可执行位' })
      }
    }
    changedBytes += Math.max(change.before?.bytes ?? 0, change.after?.bytes ?? 0)
  }

  if (fileChanges.length > policy.limits.maximumChangedFiles) {
    violations.push({
      path: '*',
      reason: `改动文件数 ${fileChanges.length} 超过上限 ${policy.limits.maximumChangedFiles}`,
    })
  }
  if (changedBytes > policy.limits.maximumChangedBytes) {
    violations.push({
      path: '*',
      reason: `改动字节数 ${changedBytes} 超过上限 ${policy.limits.maximumChangedBytes}`,
    })
  }

  return {
    valid: violations.length === 0,
    level: mutationPolicy.metadata.level,
    changedFiles: fileChanges.length,
    changedDirectories: directoryChanges.length,
    changedBytes,
    changes: fileChanges,
    directoryChanges,
    violations,
  }
}

export async function validateCandidateSemantics(workspace, target) {
  const semanticChecks = target.mutation.semanticChecks
  if (!semanticChecks) return { valid: true, checks: [] }
  const checks = []
  const violations = []

  if (semanticChecks.skills) {
    const skillReport = await validateSkillCatalog(workspace, semanticChecks.skills)
    checks.push(skillReport)
    violations.push(...skillReport.violations)
  }

  const cordis = semanticChecks.cordis
  if (!cordis) return { valid: violations.length === 0, checks, violations }
  const pathValue = join(workspace, normalizeRelativePath(cordis.path, 'Cordis 语义检查路径'))
  let text
  try {
    text = await readFile(pathValue, 'utf8')
  } catch (error) {
    throw new ProtocolError('无法读取 Candidate Cordis Preset', [error.message])
  }
  const cordisViolations = []
  const allowedPlugins = new Set(cordis.allowedPluginNames)
  const allowedJsLines = new Set(cordis.allowedJsLines)
  const lines = text.split(/\r?\n/u)
  const sanitizedLines = []
  for (const [index, line] of lines.entries()) {
    if (!line.includes('!!js')) {
      sanitizedLines.push(line)
      continue
    }
    if (!allowedJsLines.has(line.trim())) {
      cordisViolations.push({ path: cordis.path, reason: `未审查的 !!js 表达式：${line.trim()}` })
    }
    sanitizedLines.push(line.replace(/!!js.*$/u, JSON.stringify(`__RSI_ALLOWED_JS_${index}__`)))
  }
  const customTags = text.match(/!(?:!|<)?[A-Za-z][^\s]*/gu) ?? []
  for (const tag of customTags) {
    if (tag !== '!!js') cordisViolations.push({ path: cordis.path, reason: `禁止自定义 YAML Tag：${tag}` })
  }

  let composition
  let parsedComposition = false
  try {
    composition = parseYaml(sanitizedLines.join('\n'))
    parsedComposition = true
  } catch (error) {
    cordisViolations.push({ path: cordis.path, reason: `Cordis YAML 无法安全解析：${error.message}` })
  }
  if (parsedComposition && !Array.isArray(composition)) {
    cordisViolations.push({ path: cordis.path, reason: 'Cordis Composition 顶层必须是数组' })
  }

  const forbiddenPatchKeys = new Set(['insert', 'remove', 'replace', 'patch'])
  function inspectComposition(value) {
    if (Array.isArray(value)) {
      for (const item of value) inspectComposition(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'name') {
        if (typeof child !== 'string') {
          cordisViolations.push({ path: cordis.path, reason: 'Plugin name 必须是静态字符串' })
        } else if (!allowedPlugins.has(child)) {
          cordisViolations.push({ path: cordis.path, reason: `Plugin 不在安全名单：${child}` })
        }
      }
      if (forbiddenPatchKeys.has(key)) {
        cordisViolations.push({
          path: cordis.path,
          reason: `Candidate Preset 禁止使用 Cordis Patch 指令：${key}`,
        })
      }
      inspectComposition(child)
    }
  }
  if (parsedComposition) inspectComposition(composition)
  checks.push({ id: 'cordis-safe-composition', path: cordis.path, violations: cordisViolations })
  violations.push(...cordisViolations)
  return {
    valid: violations.length === 0,
    checks,
    violations,
  }
}

async function validateSkillCatalog(workspace, policy) {
  const relativeRoot = normalizeRelativePath(policy.root, 'Skill 语义检查路径')
  const root = join(workspace, relativeRoot)
  const violations = []
  const names = new Map()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    throw new ProtocolError('Candidate Skill 根目录不可读', [error.message])
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    let skillPath
    let expectedName
    if (entry.isDirectory()) {
      skillPath = join(root, entry.name, 'SKILL.md')
      expectedName = entry.name
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      skillPath = join(root, entry.name)
      expectedName = basename(entry.name, extname(entry.name))
    } else {
      violations.push({ path: `${relativeRoot}/${entry.name}`, reason: 'Skill 根目录只允许目录包或 Markdown Skill' })
      continue
    }

    const relativeSkillPath = relative(workspace, skillPath).replaceAll('\\', '/')
    let source
    try {
      source = await readFile(skillPath, 'utf8')
    } catch (error) {
      violations.push({ path: relativeSkillPath, reason: `Skill 缺少可读的 SKILL.md：${error.message}` })
      continue
    }
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
    if (!frontmatter) {
      violations.push({ path: relativeSkillPath, reason: 'Skill 必须包含 YAML frontmatter' })
      continue
    }
    if (/(^|\s)![^\s]/u.test(frontmatter[1])) {
      violations.push({ path: relativeSkillPath, reason: 'Skill frontmatter 禁止自定义 YAML Tag' })
      continue
    }
    let metadata
    try {
      metadata = parseYaml(frontmatter[1])
    } catch (error) {
      violations.push({ path: relativeSkillPath, reason: `Skill frontmatter 无法解析：${error.message}` })
      continue
    }
    const name = metadata?.name
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      violations.push({ path: relativeSkillPath, reason: 'Skill name 必须是 kebab-case 字符串' })
      continue
    }
    if (name !== expectedName) {
      violations.push({ path: relativeSkillPath, reason: `Skill name 必须与目录或文件名一致：expected=${expectedName}, actual=${name}` })
    }
    if (!name.startsWith(policy.requiredNamePrefix)) {
      violations.push({ path: relativeSkillPath, reason: `Skill name 必须使用受控前缀 ${policy.requiredNamePrefix}` })
    }
    if (typeof metadata?.description !== 'string' || metadata.description.trim().length === 0) {
      violations.push({ path: relativeSkillPath, reason: 'Skill description 必须是非空字符串' })
    }
    if (names.has(name)) {
      violations.push({ path: relativeSkillPath, reason: `Skill name 重复，首次出现在 ${names.get(name)}` })
    } else {
      names.set(name, relativeSkillPath)
    }
  }

  return { id: 'skill-catalog-namespace', path: relativeRoot, violations }
}

export async function writeCandidateManifest(pathValue, { candidateId, parentId, snapshot, sourceRevision }) {
  const entries = [...snapshot.values()].sort((left, right) => left.path.localeCompare(right.path))
  await writeJsonFile(pathValue, {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'CandidateManifest',
    metadata: { id: candidateId, parentId },
    spec: {
      sourceRevision,
      treeDigest: treeDigest(snapshot),
      files: entries.filter((entry) => entry.kind !== 'directory'),
      directories: entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
    },
  })
}

export function validateMutationReport(input, expectedChanges) {
  const errors = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('Mutation Report 必须是 JSON 对象')
  }
  for (const field of ['diagnosis', 'hypothesis', 'expectedImpact', 'remainingRisks']) {
    if (typeof input[field] !== 'string' || input[field].trim().length === 0) errors.push(`${field} 必须是非空字符串`)
  }
  if (!Array.isArray(input.changedFiles) || input.changedFiles.some((value) => typeof value !== 'string')) {
    errors.push('changedFiles 必须是字符串数组')
  } else {
    const actual = new Set(expectedChanges.map((change) => change.path))
    const normalizedReported = input.changedFiles.map((pathValue) => normalizeRelativePath(pathValue))
    const reported = new Set(normalizedReported)
    if (reported.size !== normalizedReported.length) errors.push('changedFiles 不能包含重复路径')
    const missing = [...actual].filter((pathValue) => !reported.has(pathValue))
    const extra = [...reported].filter((pathValue) => !actual.has(pathValue))
    if (missing.length > 0) errors.push(`changedFiles 漏报：${missing.join('、')}`)
    if (extra.length > 0) errors.push(`changedFiles 多报：${extra.join('、')}`)
  }
  if (errors.length > 0) throw new ProtocolError('Mutation Report 校验失败', errors)
  return {
    diagnosis: input.diagnosis.trim(),
    hypothesis: input.hypothesis.trim(),
    changedFiles: [...input.changedFiles],
    expectedImpact: input.expectedImpact.trim(),
    validation: Array.isArray(input.validation)
      ? input.validation.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
      : [],
    remainingRisks: input.remainingRisks.trim(),
  }
}

export async function writeJsonLines(filePath, records) {
  await mkdir(dirname(filePath), { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n')
  await writeFile(filePath, `${body}${body ? '\n' : ''}`, 'utf8')
}
