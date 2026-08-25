import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { fingerprintControllerImplementation } from '../src/implementation-fingerprint.mjs'

const INPUTS = [
  'package.json',
  'adapters/targets/deepseek-harness.yml',
  'adapters/targets/msa-minimal.yml',
  'environments/putnambench-lean/zcloud-max-headless.patch.yml',
  'environments/hle-text-math/dashscope-qwen38-max-headless.patch.yml',
  'prompts/updater-mutate.md',
  'prompts/updater-mutate-soft.md',
  'controller/src/a.mjs',
]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'implementation-fingerprint-'))
  for (const path of INPUTS) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), `${path}\n`)
  }
  return root
}

test('implementation fingerprint is stable and changes with trusted source bytes', async () => {
  const root = await fixture()
  const first = await fingerprintControllerImplementation(root)
  assert.match(first, /^[a-f0-9]{64}$/u)
  assert.equal(await fingerprintControllerImplementation(root), first)
  await writeFile(join(root, 'controller/src/a.mjs'), 'changed\n')
  assert.notEqual(await fingerprintControllerImplementation(root), first)
})
