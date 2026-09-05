import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  link,
  mkdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProtocolError, readJsonFile } from './protocol.mjs'

const API_VERSION = 'harness-rsi/v1alpha1'
const MAXIMUM_CHECKPOINT_BYTES = 4 * 1024 * 1024

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function readCheckpoint(path, identity) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()
        || info.size < 1 || info.size > MAXIMUM_CHECKPOINT_BYTES) {
      throw new ProtocolError('GRHS Checkpoint 必须是大小受限的普通文件')
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const record = await readJsonFile(path)
  if (record.apiVersion !== API_VERSION || record.kind !== 'GrhsStageCheckpoint'
      || record.identity !== identity || record.sha256 !== digest(record.payload)) {
    throw new ProtocolError('GRHS Checkpoint 身份或内容摘要不一致，禁止静默重跑')
  }
  return record.payload
}

async function commitCheckpoint(path, identity, payload) {
  const existing = await readCheckpoint(path, identity)
  if (existing !== null) {
    if (digest(existing) !== digest(payload)) throw new ProtocolError('GRHS 已完成阶段不能被覆盖')
    await chmod(path, 0o400)
    return
  }
  const record = {
    apiVersion: API_VERSION,
    kind: 'GrhsStageCheckpoint',
    identity,
    sha256: digest(payload),
    payload,
  }
  const text = `${JSON.stringify(record, null, 2)}\n`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    // 先把临时 inode 设为只读，再建立最终硬链接；即使进程在 link 后立刻崩溃，
    // 已发布的 Checkpoint 也不会短暂保持可写权限。
    await chmod(temporary, 0o400)
    try {
      // link() 提供 write-once 语义：并发恢复时只有一个进程能提交新文件。
      await link(temporary, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const committed = await readCheckpoint(path, identity)
      if (committed === null || digest(committed) !== digest(payload)) {
        throw new ProtocolError('GRHS 已完成阶段不能被覆盖')
      }
    }
    await chmod(path, 0o400)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** 同组重复 Patch 不作为额外独立样本，不允许靠重复评测的随机波动胜出。 */
export function deduplicateGrhsCandidates(candidates) {
  const owners = new Map()
  for (const candidate of candidates) {
    if (!candidate || !candidate.id) throw new ProtocolError('GRHS Candidate 缺少 ID')
    if (!candidate.digest) continue
    const owner = owners.get(candidate.digest)
    if (owner === undefined) {
      owners.set(candidate.digest, candidate.id)
      continue
    }
    candidate.valid = false
    candidate.promotionEligible = false
    candidate.qualityDelta = null
    candidate.rejection = {
      stage: 'group-deduplication',
      message: `Patch 与 sibling ${owner} 完全相同，不是离散 Candidate`,
      details: [],
    }
  }
  return candidates
}

/**
 * Controller 的分组执行层：只编排共享证据和 sibling 生命周期。
 * Region 提议及相对优势更新归 Strategy；变异权限、评分 Gate 归调用方的可信执行面。
 * 所有阶段落盘后才算完成。重启复用相同计划/证据/已完成结果，基础设施失败不计零分。
 */
export async function executeGrhsGroup({
  strategy,
  strategyContext,
  previousStrategyState,
  groupRoot,
  prepareSharedEvidence,
  runSibling,
  verifyCompletedSibling,
  onSiblingCompleted = async () => {},
}) {
  const { generation, championId, riskCeiling } = strategyContext
  const groupSize = strategy.groupSize
  if (!Number.isSafeInteger(groupSize) || groupSize < 2 || groupSize > 32) {
    throw new ProtocolError('GRHS groupSize 必须是 2..32 的整数')
  }
  const groupId = `generation-${String(generation).padStart(4, '0')}-grhs`
  const identity = digest({
    strategy: strategy.descriptor(), strategyContext, previousStrategyState,
  })
  const planPath = join(groupRoot, 'plans.checkpoint.json')
  let proposed = await readCheckpoint(planPath, identity)
  if (proposed === null) {
    proposed = await strategy.proposeGroup(strategyContext, previousStrategyState)
    await commitCheckpoint(planPath, identity, proposed)
  }
  // 重走 Strategy 协议校验，不能因为从磁盘读取就跳过父版本、Region 和 generation 校验。
  const verified = await strategy.proposeGroup(strategyContext, proposed.state)
  if (digest(verified.plans) !== digest(proposed.plans)) {
    throw new ProtocolError('GRHS 恢复得到不同的 sibling 计划')
  }
  const plans = proposed.plans
  for (const plan of plans) {
    if (plan.spec.parentIds.length !== 1 || plan.spec.parentIds[0] !== championId
        || plan.spec.generation !== generation) {
      throw new ProtocolError('GRHS sibling 必须共享当前 Champion 和同一 generation')
    }
    if (strategyContext.searchHistory.some((entry) => (
      entry.mutationPlanId === plan.metadata.id
      || entry.group?.candidates?.some((candidate) => candidate.mutationPlanId === plan.metadata.id)
    ))) throw new ProtocolError(`GRHS 重复使用 MutationPlan ID：${plan.metadata.id}`)
  }
  const sharedPath = join(groupRoot, 'shared.checkpoint.json')
  let shared = await readCheckpoint(sharedPath, identity)
  if (shared === null) {
    shared = await prepareSharedEvidence()
    await commitCheckpoint(sharedPath, identity, shared)
  }
  const candidates = []
  for (const [index, plan] of plans.entries()) {
    const candidateId = `g${String(generation).padStart(3, '0')}-grhs-s${String(index + 1).padStart(3, '0')}-${riskCeiling}`
    const member = {
      candidateId, plan, shared: structuredClone(shared),
      groupContext: {
        groupNumber: generation, memberIndex: index + 1, groupSize,
        proposalPrior: proposed.state.proposalPrior,
      },
    }
    const path = join(groupRoot, `sibling-${String(index + 1).padStart(3, '0')}.checkpoint.json`)
    let result = await readCheckpoint(path, identity)
    const reused = result !== null
    if (reused) await verifyCompletedSibling(result, member)
    else {
      result = await runSibling(member)
      await commitCheckpoint(path, identity, result)
    }
    if (result.id !== candidateId || result.parentId !== championId
        || result.mutationPlanId !== plan.metadata.id
        || JSON.stringify(result.regionIds) !== JSON.stringify(plan.spec.regionIds)) {
      throw new ProtocolError('GRHS sibling 结果与预提交计划身份不一致')
    }
    await onSiblingCompleted(result, { reused })
    candidates.push(result)
  }
  deduplicateGrhsCandidates(candidates)
  const observed = await strategy.observeGroup({
    ...strategyContext,
    candidates: candidates.map(({ id, regionIds, valid, promotionEligible, qualityDelta }) => ({
      id, regionIds, valid, promotionEligible, qualityDelta,
    })),
  }, proposed.state)
  const winner = candidates.find((candidate) => candidate.id === observed.decision.promotedCandidateId)
  if (observed.decision.promotedCandidateId !== null && (!winner?.valid || !winner.promotionEligible)) {
    throw new ProtocolError('GRHS Strategy 返回了不存在或不合格的 Winner')
  }
  return { groupId, groupSize, candidates, plans, ...observed }
}
