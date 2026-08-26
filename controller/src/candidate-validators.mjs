import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { validateCandidateSemantics } from './candidate.mjs'
import { normalizeRelativePath } from './path-policy.mjs'
import { ProtocolError } from './protocol.mjs'
import { runProcess } from './process.mjs'

const VALIDATORS = new Map()

export function registerCandidateValidator(protocol, validator) {
  if (typeof protocol !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+$/u.test(protocol)) {
    throw new ProtocolError('Candidate Validator Protocol 必须是带版本的 kebab-case')
  }
  if (typeof validator !== 'function') throw new ProtocolError('Candidate Validator 必须是函数')
  if (VALIDATORS.has(protocol)) throw new ProtocolError(`Candidate Validator 重复注册：${protocol}`)
  VALIDATORS.set(protocol, validator)
}

async function validateDsh({ workspace, target }) {
  return await validateCandidateSemantics(workspace, target)
}

async function validateMsaMinimal({ workspace, target }) {
  const policy = target.mutation.semanticChecks
  const checks = []
  const violations = []

  for (const pathValue of policy.requiredFiles) {
    const normalized = normalizeRelativePath(pathValue, 'MSA Required File')
    try {
      const info = await lstat(join(workspace, normalized))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('不是普通文件')
    } catch (error) {
      violations.push({ path: normalized, reason: `缺少必需普通文件：${error.message}` })
    }
  }
  checks.push({ id: 'msa-required-files', violations: [...violations] })

  const astViolations = []
  for (const pathValue of policy.pythonFiles) {
    const normalized = normalizeRelativePath(pathValue, 'MSA Python File')
    try {
      await runProcess('python3', [
        '-c',
        'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), filename=sys.argv[1])',
        join(workspace, normalized),
      ], { timeoutMs: 10_000 })
    } catch (error) {
      astViolations.push({ path: normalized, reason: `Python AST 校验失败：${error.message}` })
    }
  }
  checks.push({ id: 'msa-python-ast', violations: astViolations })
  violations.push(...astViolations)

  const profileViolations = []
  try {
    const profile = JSON.parse(await readFile(join(workspace, policy.profile.path), 'utf8'))
    for (const [field, maximum] of Object.entries(policy.profile.maximums)) {
      if (!Number.isSafeInteger(profile[field]) || profile[field] < 1 || profile[field] > maximum) {
        profileViolations.push({
          path: policy.profile.path,
          reason: `${field} 必须是 1..${maximum} 的整数`,
        })
      }
    }
  } catch (error) {
    profileViolations.push({ path: policy.profile.path, reason: `Profile JSON 无法读取：${error.message}` })
  }
  checks.push({ id: 'msa-profile-budget', path: policy.profile.path, violations: profileViolations })
  violations.push(...profileViolations)

  if (policy.skills) {
    const skillReport = await validateCandidateSemantics(workspace, {
      mutation: { semanticChecks: { skills: policy.skills } },
    })
    checks.push(...skillReport.checks)
    violations.push(...skillReport.violations)
  }
  return { valid: violations.length === 0, checks, violations }
}

registerCandidateValidator('dsh-cordis-v1', validateDsh)
registerCandidateValidator('msa-minimal-cowork-v1', validateMsaMinimal)
// Reasoning 与 Cowork 共用安全的 Python/Profile 验证核，但用独立协议名
// 表达两种 Target 的业务语义，避免 Controller 把 Reasoning 写死成 Cowork。
registerCandidateValidator('msa-minimal-reasoning-v1', validateMsaMinimal)

export async function validateCandidate({ workspace, target }) {
  const protocol = target?.mutation?.semanticChecks?.protocol ?? 'none-v1'
  if (protocol === 'none-v1') return { valid: true, checks: [], violations: [] }
  const validator = VALIDATORS.get(protocol)
  if (!validator) throw new ProtocolError(`未实现的 Candidate Validator：${protocol}`)
  return await validator({ workspace, target })
}

export function registeredCandidateValidators() {
  return Object.freeze([...VALIDATORS.keys()].sort())
}
