import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFeedbackPacket } from '../src/feedback.mjs'

function record(instanceId) {
  return {
    instanceId,
    status: 'unresolved',
    reward: 0,
    trialRewards: [0],
    latencyMs: 10,
    policyViolations: [],
    artifacts: [{
      seed: 1,
      root: 'trials/example',
      changed: [
        { path: 'sk-example-secret-token-123456.txt', change: 'added', bytes: 1 },
        { path: 'safe.txt', change: 'added', bytes: 1 },
      ],
    }],
    feedback: {
      taskInstruction: '创建一份真实交付文件',
      solverAnswer: 'answer',
      verifierFeedback: 'failed',
      errors: ['tool failed'],
    },
  }
}

test('Feedback Packet 只包含 feedback 案例并限制搜索历史体积', () => {
  const packet = buildFeedbackPacket({
    runId: 'run-one',
    generation: 3,
    candidateId: 'h0',
    benchmark: {
      id: 'bench',
      source: { revision: 'a'.repeat(40) },
      partitions: { feedback: { instanceIds: ['feedback-one'] } },
    },
    records: new Map([
      ['feedback-one', record('feedback-one')],
      ['selection-one', record('selection-one')],
    ]),
    maximumTextBytesPerCase: 1024,
    maximumArtifactEntriesPerCase: 1,
    maximumArtifactBytesPerCase: 1024,
    maximumHistoryEntries: 2,
    maximumHistoryBytes: 1024,
    searchHistory: [
      { generation: 1, parentId: 'h0', proposalId: 'g001-l1', status: 'rejected' },
      { generation: 2, parentId: 'h0', proposalId: 'g002-l1', status: 'rejected', hypothesis: 'x'.repeat(4096) },
    ],
  })

  assert.deepEqual(packet.spec.cases.map((item) => item.instanceId), ['feedback-one'])
  assert.equal(packet.spec.cases[0].taskInstruction, '创建一份真实交付文件')
  assert.equal(packet.spec.cases[0].errors, 'tool failed')
  const feedbackTextBytes = ['taskInstruction', 'verifierFeedback', 'solverAnswer', 'errors']
    .reduce((sum, field) => sum + Buffer.byteLength(packet.spec.cases[0][field], 'utf8'), 0)
  assert.ok(feedbackTextBytes <= 1024)
  assert.equal(packet.spec.cases[0].artifactSummary.totalEntries, 2)
  assert.equal(packet.spec.cases[0].artifactSummary.includedEntries, 1)
  assert.equal(packet.spec.cases[0].artifactSummary.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(packet.spec.cases[0].artifacts), 'utf8') <= 1024)
  assert.doesNotMatch(JSON.stringify(packet.spec.cases[0].artifacts), /sk-example-secret-token/u)
  assert.equal(packet.spec.searchHistory.at(-1).proposalId, 'g002-l1')
  assert.equal(packet.spec.searchHistory.at(-1).detailsOmitted, true)
  assert.ok(Buffer.byteLength(JSON.stringify(packet.spec.searchHistory), 'utf8') <= 1024)
})
