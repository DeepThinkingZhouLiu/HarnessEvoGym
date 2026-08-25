import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isHleTextOnlyMath,
  prepareHleTextMathDataset,
  stratifiedHleSplit,
  writeHleSplit,
} from '../src/hle-dataset.mjs'

function rows() {
  const output = []
  const subjects = ['Algebra', 'Geometry', 'Number Theory', 'Probability']
  const answerTypes = ['exactMatch', 'multipleChoice']
  for (let index = 0; index < 320; index += 1) {
    output.push({
      id: `official-${String(index).padStart(4, '0')}`,
      question: `Question ${index}`,
      answer: `Answer ${index}`,
      answer_type: answerTypes[index % answerTypes.length],
      raw_subject: subjects[index % subjects.length],
      category: 'Math',
      image: null,
      image_preview: null,
    })
  }
  return output
}

test('text-only Math excludes image and non-Math rows', () => {
  const base = rows()[0]
  assert.equal(isHleTextOnlyMath(base), true)
  assert.equal(isHleTextOnlyMath({ ...base, category: 'Physics' }), false)
  assert.equal(isHleTextOnlyMath({ ...base, image: { bytes: 'x' } }), false)
  assert.equal(isHleTextOnlyMath({ ...base, image_preview: 'data:image/png;base64,x' }), false)
})

test('parent preparation never requires or reads the sealed-test store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-parent-store-'))
  const validationRoot = join(root, 'validation')
  await mkdir(validationRoot)
  await writeFile(join(validationRoot, 'records.jsonl'), '{"validation":true}\n')
  assert.deepEqual(await prepareHleTextMathDataset({ datasetRoot: root }), {
    solutionsRoot: validationRoot,
    leanRoot: root,
  })
})

test('50/50 split is deterministic, disjoint, opaque, and stratified', () => {
  const first = stratifiedHleSplit(rows())
  const second = stratifiedHleSplit(rows())
  assert.deepEqual(first, second)
  assert.equal(first.validation.length, 50)
  assert.equal(first.test.length, 50)
  const validationIds = new Set(first.validation.map((row) => row.instanceId))
  assert.equal(validationIds.size, 50)
  assert.equal(first.test.some((row) => validationIds.has(row.instanceId)), false)
  assert.equal(first.validation.every((row) => /^hle_[a-f0-9]{24}$/u.test(row.instanceId)), true)
  assert.equal(first.strata.reduce((sum, stratum) => sum + stratum.validation, 0), 50)
  assert.equal(first.strata.reduce((sum, stratum) => sum + stratum.test, 0), 50)
  assert.equal(first.strata.every((stratum) => Math.abs(stratum.validation - stratum.test) <= 1), true)
})

test('restricted manifests and answer stores are written only to caller-selected private roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-split-'))
  const controlRoot = join(root, 'control')
  const datasetRoot = join(root, 'dataset')
  const split = stratifiedHleSplit(rows())
  const result = await writeHleSplit({ split, controlRoot, datasetRoot })
  assert.equal(result.validationCount, 50)
  assert.equal(result.testCount, 50)
  const validationManifest = await readFile(join(controlRoot, 'validation.ids'), 'utf8')
  const testManifest = await readFile(join(controlRoot, 'test.ids'), 'utf8')
  assert.equal(validationManifest.trim().split('\n').length, 50)
  assert.equal(testManifest.trim().split('\n').length, 50)
  assert.equal(validationManifest.includes('official-'), false)
  assert.equal(testManifest.includes('official-'), false)
  assert.match(await readFile(result.validationStore, 'utf8'), /"answer":"Answer/u)
  assert.match(await readFile(result.testStore, 'utf8'), /"answer":"Answer/u)
})
