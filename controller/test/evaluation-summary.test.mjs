import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEvaluationSummary,
  primaryMetricDelta,
  validateEvaluationSummary,
} from '../src/evaluation-summary.mjs'
import { ProtocolError } from '../src/protocol.mjs'

test('EvaluationSummary 将 Reasoning 和 Cowork 分数投影成通用主指标', () => {
  const reasoning = createEvaluationSummary({
    candidateId: 'c0001',
    metric: 'validation-verified-count',
    value: 7,
    total: 10,
  })
  const cowork = createEvaluationSummary({
    candidateId: 'g001-l1',
    metric: 'mean-reward',
    value: 0.75,
  })
  assert.equal(reasoning.primary.value, 7)
  assert.equal(reasoning.primary.total, 10)
  assert.equal(cowork.primary.value, 0.75)
  assert.equal(cowork.primary.total, null)
})

test('primaryMetricDelta 无论方向都以正数表示改善', () => {
  const maximizeBaseline = createEvaluationSummary({
    candidateId: 'base', metric: 'mean-reward', value: 0.5,
  })
  const maximizeCandidate = createEvaluationSummary({
    candidateId: 'next', metric: 'mean-reward', value: 0.7,
  })
  assert.ok(Math.abs(primaryMetricDelta(maximizeCandidate, maximizeBaseline) - 0.2) < 1e-12)

  const minimizeBaseline = createEvaluationSummary({
    candidateId: 'base', metric: 'error-rate', value: 0.4, direction: 'minimize',
  })
  const minimizeCandidate = createEvaluationSummary({
    candidateId: 'next', metric: 'error-rate', value: 0.1, direction: 'minimize',
  })
  assert.ok(Math.abs(primaryMetricDelta(minimizeCandidate, minimizeBaseline) - 0.3) < 1e-12)
})

test('EvaluationSummary 严格拒绝未知字段、非有限值和不同指标比较', () => {
  assert.throws(
    () => validateEvaluationSummary({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvaluationSummary',
      candidateId: 'c1',
      primary: { metric: 'score', value: Number.NaN, direction: 'maximize' },
    }),
    (error) => error instanceof ProtocolError && /有限数字/u.test(error.message),
  )
  assert.throws(
    () => validateEvaluationSummary({
      apiVersion: 'harness-rsi/v1alpha1',
      kind: 'EvaluationSummary',
      candidateId: 'c1',
      primary: { metric: 'score', value: 1, direction: 'maximize' },
      trace: 'forbidden',
    }),
    (error) => error instanceof ProtocolError && /未知字段/u.test(error.message),
  )
  assert.throws(
    () => primaryMetricDelta(
      createEvaluationSummary({ candidateId: 'a', metric: 'mean-reward', value: 1 }),
      createEvaluationSummary({ candidateId: 'b', metric: 'resolved-rate', value: 1 }),
    ),
    /\u4e3b指标不一致/u,
  )
})
