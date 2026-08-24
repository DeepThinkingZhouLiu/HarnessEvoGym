const MAXIMUM_FAILURES = 20
const MAXIMUM_ASSERTION_BYTES = 512

export function compactUtf8(value, maximumBytes) {
  const text = typeof value === 'string' ? value.trim() : ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maximumBytes) return text
  const marker = ' [TRUNCATED]'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  let prefix = buffer.subarray(0, Math.max(0, maximumBytes - markerBytes)).toString('utf8')
  while (Buffer.byteLength(`${prefix}${marker}`, 'utf8') > maximumBytes) prefix = prefix.slice(0, -1)
  return `${prefix}${marker}`
}

function assertionSummary(testCase) {
  const candidates = []
  if (typeof testCase?.trace === 'string') {
    const assertionLines = testCase.trace
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^(?:E\s+|AssertionError\b|assert\b)/u.test(line))
    candidates.push(
      ...assertionLines.filter((line) => /AssertionError|expected|got/iu.test(line)),
      ...assertionLines.filter((line) => !/AssertionError|expected|got/iu.test(line)),
    )
  }
  candidates.push(testCase?.message)
  return compactUtf8(
    candidates.find((value) => typeof value === 'string' && value.trim()),
    MAXIMUM_ASSERTION_BYTES,
  )
}

export function summarizeCtrf(value, label = 'ctrf.json') {
  const results = value?.results
  const summary = results?.summary
  const tests = results?.tests
  const fields = ['tests', 'passed', 'failed', 'skipped', 'pending', 'other']
  if (
    !summary ||
    !Array.isArray(tests) ||
    fields.some((field) => !Number.isInteger(summary[field]) || summary[field] < 0) ||
    summary.tests !== tests.length ||
    summary.tests !== fields.slice(1).reduce((sum, field) => sum + summary[field], 0)
  ) {
    return { error: `Verifier CTRF 结构无效：${label}`, summary: '' }
  }

  const failed = tests.filter((testCase) => testCase?.status === 'failed')
  if (failed.length !== summary.failed) {
    return { error: `Verifier CTRF 失败计数不一致：${label}`, summary: '' }
  }
  const lines = [
    `[structured verifier evidence: ${label}]`,
    `tests=${summary.tests} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped} pending=${summary.pending} other=${summary.other}`,
  ]
  for (const testCase of failed.slice(0, MAXIMUM_FAILURES)) {
    const name = compactUtf8(testCase?.name ?? '(unnamed test)', 512)
    const assertion = assertionSummary(testCase)
    lines.push(`FAILED ${name}${assertion ? ` :: ${assertion}` : ''}`)
  }
  if (failed.length > MAXIMUM_FAILURES) {
    lines.push(`FAILED ... ${failed.length - MAXIMUM_FAILURES} more failures omitted`)
  }
  return { error: null, summary: lines.join('\n') }
}
