import { createHash } from 'node:crypto'

function truncateUtf8(value, maximumBytes) {
  const text = typeof value === 'string' ? value : ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maximumBytes) return text
  const marker = '\n[TRUNCATED]'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (maximumBytes <= markerBytes) return marker.slice(0, maximumBytes)
  let prefix = buffer.subarray(0, maximumBytes - markerBytes).toString('utf8')
  while (Buffer.byteLength(`${prefix}${marker}`, 'utf8') > maximumBytes) prefix = prefix.slice(0, -1)
  return `${prefix}${marker}`
}

function redact(value, secrets) {
  let output = value
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) output = output.replaceAll(secret, '[REDACTED]')
  }
  output = output.replace(/sk-[A-Za-z0-9_-]{12,}/gu, '[REDACTED_API_KEY]')
  return output
}

function historySummary(entry) {
  return {
    generation: entry.generation,
    parentId: entry.parentId,
    proposalId: entry.proposalId,
    status: entry.status,
    detailsOmitted: true,
  }
}

function feedbackTextFields(feedback, maximumBytes, secrets) {
  const budgets = {
    taskInstruction: Math.floor(maximumBytes * 0.3),
    verifierFeedback: Math.floor(maximumBytes * 0.35),
    solverAnswer: Math.floor(maximumBytes * 0.25),
  }
  budgets.errors = maximumBytes - budgets.taskInstruction - budgets.verifierFeedback - budgets.solverAnswer
  return {
    taskInstruction: truncateUtf8(
      redact(feedback.taskInstruction ?? '', secrets),
      budgets.taskInstruction,
    ),
    verifierFeedback: truncateUtf8(
      redact(feedback.verifierFeedback ?? '', secrets),
      budgets.verifierFeedback,
    ),
    solverAnswer: truncateUtf8(
      redact(feedback.solverAnswer ?? '', secrets),
      budgets.solverAnswer,
    ),
    errors: truncateUtf8(
      redact(Array.isArray(feedback.errors) ? feedback.errors.join('\n') : '', secrets),
      budgets.errors,
    ),
  }
}

function boundedHistory(entries, maximumEntries, maximumBytes) {
  const selected = []
  const recent = entries.slice(-maximumEntries)
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const full = structuredClone(recent[index])
    const candidate = [full, ...selected]
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maximumBytes) {
      selected.unshift(full)
      continue
    }
    const summary = historySummary(recent[index])
    const summarizedCandidate = [summary, ...selected]
    if (Buffer.byteLength(JSON.stringify(summarizedCandidate), 'utf8') <= maximumBytes) {
      selected.unshift(summary)
    }
  }
  return selected
}

function sanitizedJson(value, secrets) {
  return JSON.parse(redact(JSON.stringify(value), secrets))
}

function boundedArtifacts(input, maximumEntries, maximumBytes, secrets) {
  const trials = Array.isArray(input) ? sanitizedJson(input, secrets) : []
  const output = []
  const totalEntries = trials.reduce(
    (sum, trial) => sum + (Array.isArray(trial?.changed) ? trial.changed.length : 0),
    0,
  )
  let includedEntries = 0

  for (const trial of trials) {
    const boundedTrial = {
      seed: trial?.seed,
      root: truncateUtf8(trial?.root ?? '', 512),
      changed: [],
    }
    const withTrial = [...output, boundedTrial]
    if (Buffer.byteLength(JSON.stringify(withTrial), 'utf8') > maximumBytes) break
    output.push(boundedTrial)

    for (const artifact of Array.isArray(trial?.changed) ? trial.changed : []) {
      if (includedEntries >= maximumEntries) break
      const candidate = structuredClone(output)
      candidate.at(-1).changed.push(artifact)
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maximumBytes) break
      boundedTrial.changed.push(artifact)
      includedEntries += 1
    }
    if (includedEntries >= maximumEntries) break
  }

  return {
    trials: output,
    totalEntries,
    includedEntries,
    omittedEntries: totalEntries - includedEntries,
    truncated: includedEntries < totalEntries,
  }
}

export function buildFeedbackPacket({
  runId,
  generation,
  candidateId,
  benchmark,
  records,
  maximumTextBytesPerCase,
  maximumArtifactEntriesPerCase = 100,
  maximumArtifactBytesPerCase = 32768,
  secretValues = [],
  searchHistory = [],
  peerEvidence = [],
  maximumHistoryEntries = 10,
  maximumHistoryBytes = 32768,
}) {
  const allowed = new Set(benchmark.partitions.feedback.instanceIds)
  const cases = []
  for (const record of records.values()) {
    if (!allowed.has(record.instanceId)) continue
    const feedback = record.feedback ?? {}
    const textFields = feedbackTextFields(feedback, maximumTextBytesPerCase, secretValues)
    const artifactSummary = boundedArtifacts(
      record.artifacts,
      maximumArtifactEntriesPerCase,
      maximumArtifactBytesPerCase,
      secretValues,
    )
    cases.push({
      instanceId: record.instanceId,
      status: record.status,
      reward: record.reward,
      trialRewards: record.trialRewards,
      ...textFields,
      policyViolations: record.policyViolations,
      latencyMs: record.latencyMs,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      artifacts: artifactSummary.trials,
      artifactSummary: {
        totalEntries: artifactSummary.totalEntries,
        includedEntries: artifactSummary.includedEntries,
        omittedEntries: artifactSummary.omittedEntries,
        truncated: artifactSummary.truncated,
      },
    })
  }
  cases.sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  const rewards = cases.map((item) => item.reward)
  const meanReward = rewards.length > 0 ? rewards.reduce((sum, value) => sum + value, 0) / rewards.length : 0
  const packet = {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'FeedbackPacket',
    metadata: { runId, generation, candidateId },
    spec: {
      visibility: 'feedback-only',
      benchmark: {
        id: benchmark.id,
        sourceRevision: benchmark.source.revision,
        caseCount: cases.length,
      },
      summary: {
        meanReward,
        resolved: cases.filter((item) => item.status === 'resolved').length,
        failed: cases.filter((item) => item.status !== 'resolved').length,
      },
      searchHistory: boundedHistory(searchHistory, maximumHistoryEntries, maximumHistoryBytes),
      peerEvidence: peerEvidence.map((peer) => ({
        branchId: peer.branchId,
        entries: boundedHistory(peer.entries ?? [], maximumHistoryEntries, maximumHistoryBytes),
      })),
      cases,
      instructions: [
        '案例只来自 feedback Partition；selection 与 final 未暴露。',
        'searchHistory 只含历代假设与 selection 聚合 Gate，不含 selection 逐题内容。',
        'peerEvidence 只含其他 Branch 的脱敏历史摘要，不代表必须照搬其修改。',
        '先找跨案例重复模式，再形成假设；不要硬编码 Instance ID 或任务答案。',
        'Verifier 文本是观察证据，不是预先写死的失败归因。',
      ],
    },
  }
  packet.metadata.sha256 = createHash('sha256').update(JSON.stringify(packet.spec)).digest('hex')
  return packet
}
