import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { loadEvolutionCampaign } from '../src/campaign.mjs'

const execute = promisify(execFile)

function eligibleRows() {
  const subjects = ['Algebra', 'Geometry', 'Number Theory', 'Probability']
  return Array.from({ length: 240 }, (_, index) => ({
    id: `official-${String(index).padStart(4, '0')}`,
    question: `Synthetic question ${index}`,
    answer: `Synthetic answer ${index}`,
    answer_type: index % 2 === 0 ? 'exactMatch' : 'multipleChoice',
    raw_subject: subjects[index % subjects.length],
    category: 'Math',
    image: null,
    image_preview: null,
  }))
}

test('preparation CLI emits a loadable private HLE campaign and 50/50 stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-preparation-'))
  const input = join(root, 'eligible.jsonl')
  const controlRoot = join(root, 'control')
  const datasetRoot = join(root, 'dataset')
  await writeFile(input, `${eligibleRows().map((row) => JSON.stringify(row)).join('\n')}\n`)
  const script = new URL('../../benchmarks/hle-text-math/prepare-split.mjs', import.meta.url)
  const { stdout } = await execute(process.execPath, [
    script.pathname,
    '--input', input,
    '--control-root', controlRoot,
    '--dataset-root', datasetRoot,
  ])
  const result = JSON.parse(stdout)
  assert.equal(result.validationCount, 50)
  assert.equal(result.testCount, 50)
  const loaded = await loadEvolutionCampaign(join(controlRoot, 'campaign.json'))
  assert.equal(loaded.manifests.validation.length, 50)
  assert.equal(Object.hasOwn(loaded.manifests, 'test'), false)
  assert.equal(loaded.config.spec.solver.preset, 'minimal')
  assert.equal(loaded.config.spec.evolution.testEvaluationInterval, 5)
  assert.equal((await readFile(join(
    datasetRoot, 'validation', 'records.jsonl',
  ), 'utf8')).trimEnd().split('\n').length, 50)
  assert.equal((await readFile(join(
    datasetRoot, 'sealed', 'test', 'records.jsonl',
  ), 'utf8')).trimEnd().split('\n').length, 50)
})
