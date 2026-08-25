import assert from 'node:assert/strict'
import test from 'node:test'

import { recommendHleConcurrency } from '../src/hle-concurrency.mjs'

test('concurrency uses end-to-end p90 and keeps a five-minute reserve', () => {
  const result = recommendHleConcurrency({
    latenciesMs: [120_000, 130_000, 140_000, 150_000, 160_000, 170_000, 180_000, 190_000],
  })
  assert.equal(result.p90LatencyMs, 190_000)
  assert.equal(result.concurrency, 7)
  assert.equal(result.projectedMs < 55 * 60 * 1000, true)
  assert.equal(result.feasible, true)
})

test('calibration fails closed when the one-hour target needs unsafe concurrency', () => {
  const result = recommendHleConcurrency({
    latenciesMs: [900_000, 900_000, 900_000, 900_000],
    maximumConcurrency: 24,
  })
  assert.equal(result.requiredConcurrency > 24, true)
  assert.equal(result.feasible, false)
})
