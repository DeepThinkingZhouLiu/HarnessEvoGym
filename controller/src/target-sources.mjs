import { ProtocolError } from './protocol.mjs'
import { runProcess } from './process.mjs'
import { resolveCanonicalInside } from './trusted-path.mjs'

const RESOLVERS = new Map()

export function registerTargetSourceResolver(protocol, resolver) {
  if (typeof protocol !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+$/u.test(protocol)) {
    throw new ProtocolError('Target Source Protocol 必须是带版本的 kebab-case')
  }
  if (typeof resolver !== 'function') throw new ProtocolError('Target Source Resolver 必须是函数')
  if (RESOLVERS.has(protocol)) throw new ProtocolError(`Target Source Protocol 重复注册：${protocol}`)
  RESOLVERS.set(protocol, resolver)
}

async function scopedGitStatus(repositoryRoot, sourcePath) {
  return await runProcess('git', [
    '-C', repositoryRoot,
    'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching',
    '--', sourcePath,
  ], { timeoutMs: 30_000 })
}

async function resolveGitSubmodule({ repositoryRoot, source, label }) {
  const root = await resolveCanonicalInside(repositoryRoot, source.path, `${label} Path`)
  const [checkout, pinned] = await Promise.all([
    runProcess('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 }),
    runProcess('git', ['-C', repositoryRoot, 'ls-tree', 'HEAD', '--', source.path], { timeoutMs: 30_000 }),
  ])
  const pinnedMatch = pinned.stdout.match(/^160000\s+commit\s+([0-9a-f]{40})\t/u)
  if (!pinnedMatch) throw new ProtocolError(`HEAD 中没有固定的 Git Submodule：${source.path}`)
  const checkoutRevision = checkout.stdout.trim()
  const pinnedRevision = pinnedMatch[1]
  if (source.revision !== pinnedRevision || checkoutRevision !== pinnedRevision) {
    throw new ProtocolError(`${label} Revision 与固定 Submodule 不一致`, [
      `adapter=${source.revision}`,
      `pinned=${pinnedRevision}`,
      `checkout=${checkoutRevision}`,
    ])
  }
  const dirty = await runProcess(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'],
    { timeoutMs: 30_000 },
  )
  if (dirty.stdout.trim()) throw new ProtocolError(`${label} 存在未提交或已忽略的本地文件`)
  return Object.freeze({ protocol: 'git-submodule-v1', root, revision: pinnedRevision })
}

async function resolveRepositoryTree({ repositoryRoot, source, label }) {
  const root = await resolveCanonicalInside(repositoryRoot, source.path, `${label} Path`)
  const [tree, dirty] = await Promise.all([
    runProcess('git', ['-C', repositoryRoot, 'rev-parse', `HEAD:${source.path}`], { timeoutMs: 30_000 }),
    scopedGitStatus(repositoryRoot, source.path),
  ])
  const revision = tree.stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new ProtocolError(`${label} 无法解析固定 Tree Revision`)
  if (dirty.stdout.trim()) {
    throw new ProtocolError(`${label} 仓库内源码树存在未提交或已忽略的本地文件`, [dirty.stdout.trim()])
  }
  if (source.revision !== revision) {
    throw new ProtocolError(`${label} Adapter Revision 与 HEAD 中的源码树不一致`, [
      `adapter=${source.revision}`,
      `tree=${revision}`,
    ])
  }
  return Object.freeze({ protocol: 'repository-tree-v1', root, revision })
}

registerTargetSourceResolver('git-submodule-v1', resolveGitSubmodule)
registerTargetSourceResolver('repository-tree-v1', resolveRepositoryTree)

export async function resolveTargetSource({ repositoryRoot, source, label = 'Target Source' }) {
  const resolver = RESOLVERS.get(source?.protocol)
  if (!resolver) throw new ProtocolError(`未实现的 Target Source Protocol：${source?.protocol ?? '(missing)'}`)
  return await resolver({ repositoryRoot, source, label })
}

export function registeredTargetSourceProtocols() {
  return Object.freeze([...RESOLVERS.keys()].sort())
}
