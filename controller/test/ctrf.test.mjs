import assert from 'node:assert/strict'
import test from 'node:test'
import { compactUtf8, summarizeCtrf } from '../src/ctrf.mjs'

test('CTRF 摘要优先保留失败断言', () => {
  const result = summarizeCtrf({
    results: {
      summary: { tests: 2, passed: 1, failed: 1, skipped: 0, pending: 0, other: 0 },
      tests: [
        { name: 'test_ok', status: 'passed' },
        {
          name: 'test_answer_value',
          status: 'failed',
          message: 'The test failed in the call phase',
          trace: 'value = 25\nE AssertionError: Expected 23, got 25\nE assert 2 == 0',
        },
      ],
    },
  }, 'verifier/ctrf.json')

  assert.equal(result.error, null)
  assert.match(result.summary, /tests=2 passed=1 failed=1/u)
  assert.match(result.summary, /FAILED test_answer_value :: E AssertionError: Expected 23, got 25/u)
})

test('CTRF 摘要拒绝损坏的计数', () => {
  const result = summarizeCtrf({
    results: {
      summary: { tests: 1, passed: 1, failed: 1, skipped: 0, pending: 0, other: 0 },
      tests: [{ name: 'test_ok', status: 'passed' }],
    },
  })
  assert.match(result.error, /结构无效/u)
})

test('UTF-8 截断不超过字节上限', () => {
  const value = compactUtf8('失败'.repeat(100), 64)
  assert.ok(Buffer.byteLength(value, 'utf8') <= 64)
  assert.match(value, /\[TRUNCATED\]$/u)
})
