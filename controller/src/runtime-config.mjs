import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { ProtocolError } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const KIND = 'PutnamBenchRuntime'

function object(value, path, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} 必须是对象`)
    return {}
  }
  return value
}

function integer(value, path, errors, { minimum, maximum }) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${path} 必须是 ${minimum}..${maximum} 的整数`)
  }
}

function text(value, path, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${path} 必须是非空字符串`)
}

function absolutePath(value, path, errors) {
  text(value, path, errors)
  if (typeof value === 'string' && !isAbsolute(value)) errors.push(`${path} 必须是绝对路径`)
}

function within(parent, child) {
  const relation = relative(resolve(parent), resolve(child))
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`))
}

function strictChild(parent, child) {
  return resolve(parent) !== resolve(child) && within(parent, child)
}

function assertDisjoint(left, leftName, right, rightName, errors) {
  if (typeof left !== 'string' || typeof right !== 'string'
      || !isAbsolute(left) || !isAbsolute(right)) return
  if (within(left, right) || within(right, left)) {
    errors.push(`${leftName} 与 ${rightName} 必须互不包含`)
  }
}

function validatePathTopology(paths, toolchain, errors) {
  const persistent = paths.persistentRoot
  const scratch = paths.scratchRoot
  if (typeof persistent !== 'string' || typeof scratch !== 'string'
      || !isAbsolute(persistent) || !isAbsolute(scratch)) return

  const broadPersistentRoots = new Set(['/', '/root', '/home', '/mnt', '/mnt/data', '/tmp', '/dev', '/dev/shm'])
  const broadScratchRoots = new Set(['/', '/tmp', '/dev', '/dev/shm'])
  if (broadPersistentRoots.has(resolve(persistent))) {
    errors.push('paths.persistentRoot 不能是宽泛系统目录')
  }
  if (broadScratchRoots.has(resolve(scratch))) errors.push('paths.scratchRoot 不能是宽泛系统目录')
  assertDisjoint(persistent, 'paths.persistentRoot', scratch, 'paths.scratchRoot', errors)

  for (const name of ['datasetRoot', 'pnpmStore', 'buildHome', 'runtimePatch']) {
    const value = paths[name]
    if (typeof value === 'string' && isAbsolute(value) && !strictChild(persistent, value)) {
      errors.push(`paths.${name} 必须严格位于 paths.persistentRoot 内`)
    }
  }
  for (const name of ['nodePath', 'pnpmPath', 'elanHome', 'lakePath']) {
    const value = toolchain[name]
    if (typeof value === 'string' && isAbsolute(value) && !strictChild(persistent, value)) {
      errors.push(`toolchain.${name} 必须严格位于 paths.persistentRoot 内`)
    }
  }

  const managed = [
    ['paths.datasetRoot', paths.datasetRoot],
    ['paths.pnpmStore', paths.pnpmStore],
    ['paths.buildHome', paths.buildHome],
  ]
  for (let left = 0; left < managed.length; left += 1) {
    for (let right = left + 1; right < managed.length; right += 1) {
      assertDisjoint(managed[left][1], managed[left][0], managed[right][1], managed[right][0], errors)
    }
  }
  for (const [name, value] of managed) {
    assertDisjoint(value, name, toolchain.elanHome, 'toolchain.elanHome', errors)
    if (typeof toolchain.nodePath === 'string') {
      assertDisjoint(value, name, toolchain.nodePath, 'toolchain.nodePath', errors)
    }
    if (typeof toolchain.pnpmPath === 'string') {
      assertDisjoint(value, name, toolchain.pnpmPath, 'toolchain.pnpmPath', errors)
    }
  }
  if (typeof toolchain.lakePath === 'string' && typeof toolchain.elanHome === 'string'
      && isAbsolute(toolchain.lakePath) && isAbsolute(toolchain.elanHome)
      && !strictChild(toolchain.elanHome, toolchain.lakePath)) {
    errors.push('toolchain.lakePath 必须严格位于 toolchain.elanHome 内')
  }
  if (toolchain.bwrapPath !== '/usr/bin/bwrap') {
    errors.push('toolchain.bwrapPath 必须冻结为 /usr/bin/bwrap')
  }
  if (toolchain.setprivPath !== '/usr/bin/setpriv') {
    errors.push('toolchain.setprivPath 必须冻结为 /usr/bin/setpriv')
  }
}

function exactKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} 是未知字段`)
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

export function validatePutnamRuntime(input) {
  const errors = []
  const root = object(input, 'runtime', errors)
  exactKeys(root, new Set([
    'apiVersion', 'kind', 'solver', 'updater', 'gateway', 'verifier',
    'testBroker', 'paths', 'toolchain', 'identities', 'secrets',
  ]), 'runtime', errors)
  if (root.apiVersion !== API_VERSION) errors.push(`apiVersion 必须是 ${API_VERSION}`)
  if (root.kind !== KIND) errors.push(`kind 必须是 ${KIND}`)

  const solver = object(root.solver, 'solver', errors)
  exactKeys(solver, new Set([
    'smokeConcurrency', 'initialConcurrency', 'maximumConcurrency',
    'taskTimeoutSeconds', 'maximumModelRequestsPerTask',
    'maximumResponseTokens', 'gatewayConcurrencyPerTask', 'infrastructureRetries',
  ]), 'solver', errors)
  integer(solver.smokeConcurrency, 'solver.smokeConcurrency', errors, { minimum: 1, maximum: 16 })
  integer(solver.initialConcurrency, 'solver.initialConcurrency', errors, { minimum: 1, maximum: 32 })
  integer(solver.maximumConcurrency, 'solver.maximumConcurrency', errors, { minimum: 1, maximum: 64 })
  if (Number.isInteger(solver.smokeConcurrency) && Number.isInteger(solver.initialConcurrency)
      && solver.smokeConcurrency > solver.initialConcurrency) {
    errors.push('solver.smokeConcurrency 不能大于 initialConcurrency')
  }
  if (Number.isInteger(solver.initialConcurrency) && Number.isInteger(solver.maximumConcurrency)
      && solver.initialConcurrency > solver.maximumConcurrency) {
    errors.push('solver.initialConcurrency 不能大于 maximumConcurrency')
  }
  integer(solver.taskTimeoutSeconds, 'solver.taskTimeoutSeconds', errors, { minimum: 60, maximum: 7200 })
  integer(solver.maximumModelRequestsPerTask, 'solver.maximumModelRequestsPerTask', errors, { minimum: 1, maximum: 64 })
  if (solver.maximumResponseTokens !== 32768) {
    errors.push('solver.maximumResponseTokens 必须冻结为 32768')
  }
  integer(solver.gatewayConcurrencyPerTask, 'solver.gatewayConcurrencyPerTask', errors, { minimum: 1, maximum: 16 })
  integer(solver.infrastructureRetries, 'solver.infrastructureRetries', errors, { minimum: 0, maximum: 5 })

  const updater = object(root.updater, 'updater', errors)
  exactKeys(updater, new Set([
    'timeoutSeconds', 'maximumModelRequestsPerPhase', 'gatewayConcurrency',
  ]), 'updater', errors)
  integer(updater.timeoutSeconds, 'updater.timeoutSeconds', errors, { minimum: 60, maximum: 7200 })
  integer(updater.maximumModelRequestsPerPhase, 'updater.maximumModelRequestsPerPhase', errors, { minimum: 1, maximum: 128 })
  integer(updater.gatewayConcurrency, 'updater.gatewayConcurrency', errors, { minimum: 1, maximum: 16 })

  const gateway = object(root.gateway, 'gateway', errors)
  exactKeys(gateway, new Set(['upstreamBaseUrl', 'requestTimeoutSeconds']), 'gateway', errors)
  text(gateway.upstreamBaseUrl, 'gateway.upstreamBaseUrl', errors)
  if (typeof gateway.upstreamBaseUrl === 'string') {
    try {
      const url = new URL(gateway.upstreamBaseUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        errors.push('gateway.upstreamBaseUrl 必须是无凭据、无 query/fragment 的 HTTPS URL')
      }
    } catch {
      errors.push('gateway.upstreamBaseUrl 不是合法 URL')
    }
  }
  integer(gateway.requestTimeoutSeconds, 'gateway.requestTimeoutSeconds', errors, { minimum: 30, maximum: 1800 })

  const verifier = object(root.verifier, 'verifier', errors)
  exactKeys(verifier, new Set(['concurrency', 'threadsPerProcess', 'timeoutSeconds']), 'verifier', errors)
  integer(verifier.concurrency, 'verifier.concurrency', errors, { minimum: 1, maximum: 128 })
  integer(verifier.threadsPerProcess, 'verifier.threadsPerProcess', errors, { minimum: 1, maximum: 16 })
  integer(verifier.timeoutSeconds, 'verifier.timeoutSeconds', errors, { minimum: 30, maximum: 1800 })

  const testBroker = object(root.testBroker, 'testBroker', errors)
  exactKeys(testBroker, new Set(['timeoutSeconds']), 'testBroker', errors)
  integer(testBroker.timeoutSeconds, 'testBroker.timeoutSeconds', errors, { minimum: 3600, maximum: 2_592_000 })

  const paths = object(root.paths, 'paths', errors)
  exactKeys(paths, new Set([
    'persistentRoot', 'scratchRoot', 'datasetRoot', 'pnpmStore', 'buildHome',
    'runtimePatch',
  ]), 'paths', errors)
  for (const name of [
    'persistentRoot', 'scratchRoot', 'datasetRoot', 'pnpmStore', 'buildHome', 'runtimePatch',
  ]) {
    absolutePath(paths[name], `paths.${name}`, errors)
  }

  const toolchain = object(root.toolchain, 'toolchain', errors)
  exactKeys(toolchain, new Set([
    'nodeVersion', 'nodePath', 'pnpmVersion', 'pnpmPath', 'elanHome',
    'lakePath', 'leanToolchain', 'bwrapPath', 'setprivPath',
  ]), 'toolchain', errors)
  if (toolchain.nodeVersion !== '24.19.0') errors.push('toolchain.nodeVersion 必须冻结为 24.19.0')
  if (toolchain.pnpmVersion !== '11.7.0') errors.push('toolchain.pnpmVersion 必须冻结为 11.7.0')
  if (toolchain.leanToolchain !== 'leanprover/lean4:v4.27.0') {
    errors.push('toolchain.leanToolchain 必须冻结为 leanprover/lean4:v4.27.0')
  }
  for (const name of ['nodePath', 'pnpmPath', 'elanHome', 'lakePath', 'bwrapPath', 'setprivPath']) {
    absolutePath(toolchain[name], `toolchain.${name}`, errors)
  }
  validatePathTopology(paths, toolchain, errors)

  const identities = object(root.identities, 'identities', errors)
  exactKeys(
    identities,
    new Set(['updaterUser', 'solverUser', 'buildUser', 'verifierUser']),
    'identities',
    errors,
  )
  for (const name of ['updaterUser', 'solverUser', 'buildUser', 'verifierUser']) {
    if (typeof identities[name] !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(identities[name])) {
      errors.push(`identities.${name} 不是合法的系统身份名`)
    }
  }
  const identityNames = [
    identities.updaterUser,
    identities.solverUser,
    identities.buildUser,
    identities.verifierUser,
  ]
  if (identityNames.every((name) => typeof name === 'string')
      && new Set(identityNames).size !== identityNames.length) {
    errors.push('Updater、Solver、Build、Verifier 必须使用不同系统身份')
  }

  const secrets = object(root.secrets, 'secrets', errors)
  exactKeys(secrets, new Set([
    'primaryKeyFdOption', 'backupPolicy', 'allowEnvironmentKeys',
  ]), 'secrets', errors)
  if (secrets.primaryKeyFdOption !== 'zcloud-key-fd') {
    errors.push('secrets.primaryKeyFdOption 必须是 zcloud-key-fd')
  }
  if (secrets.backupPolicy !== 'separate-campaign-only') {
    errors.push('secrets.backupPolicy 必须是 separate-campaign-only')
  }
  if (secrets.allowEnvironmentKeys !== false) errors.push('secrets.allowEnvironmentKeys 必须为 false')

  if (errors.length > 0) throw new ProtocolError('PutnamBenchRuntime 配置校验失败', errors)
  return structuredClone(root)
}

export async function loadPutnamRuntime(path) {
  const absolute = resolve(path)
  let input
  try {
    input = JSON.parse(await readFile(absolute, 'utf8'))
  } catch (error) {
    throw new ProtocolError(`无法读取 PutnamBenchRuntime：${absolute}`, [error.message])
  }
  const config = validatePutnamRuntime(input)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonical(config)))
    .digest('hex')
  return { config, fingerprint, path: absolute }
}

export function combineCampaignFingerprint(
  campaignFingerprint,
  runtimeFingerprint,
  implementationFingerprint,
) {
  if (!/^[a-f0-9]{64}$/u.test(campaignFingerprint ?? '')
      || !/^[a-f0-9]{64}$/u.test(runtimeFingerprint ?? '')
      || !/^[a-f0-9]{64}$/u.test(implementationFingerprint ?? '')) {
    throw new ProtocolError('Campaign/runtime/implementation fingerprint 必须是 sha256')
  }
  return createHash('sha256')
    .update('harness-rsi-campaign-runtime-implementation-v1\0')
    .update(campaignFingerprint)
    .update('\0')
    .update(runtimeFingerprint)
    .update('\0')
    .update(implementationFingerprint)
    .digest('hex')
}
