#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_YEARS = new Set([
  1964, 1969, 1972, 1975, 1986, 1988, 1991, 1997,
  1998, 2003, 2007, 2014, 2016, 2017, 2020, 2024,
])
const EXPECTED = {
  validation: {
    count: 500,
    sha256: '0a9c8fb73194e023da449a7bc41755d07c7aaf3d7ec461c47c765541571f2760',
  },
  test: {
    count: 172,
    sha256: '2204168d092c0c322d1eedf952bd6e57def58985f35fc24564458aec74e78236',
  },
}

function fail(message) {
  throw new Error(message)
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const datasetRoot = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  fail('用法：node generate-manifests.mjs <PutnamBench checkout>')
} else {
  const leanRoot = join(datasetRoot, 'lean4', 'src')
  const metadataPath = join(datasetRoot, 'informal', 'putnam.json')
  const filenames = (await readdir(leanRoot)).filter((name) => name.endsWith('.lean')).sort()
  const ids = filenames.map((name) => basename(name, '.lean'))
  const malformed = ids.filter((id) => !/^putnam_\d{4}_[ab][1-6]$/u.test(id))
  if (malformed.length > 0) fail(`非法 problem id：${malformed.join(', ')}`)

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const metadataIds = new Set(metadata.map((entry) => entry.problem_name))
  const missingMetadata = ids.filter((id) => !metadataIds.has(id))
  if (missingMetadata.length > 0) fail(`Lean problem 缺少元数据：${missingMetadata.join(', ')}`)

  const split = { validation: [], test: [] }
  for (const id of ids) {
    const year = Number(id.slice(7, 11))
    split[TEST_YEARS.has(year) ? 'test' : 'validation'].push(id)
  }

  for (const name of ['validation', 'test']) {
    const text = `${split[name].join('\n')}\n`
    const actual = { count: split[name].length, sha256: digest(text) }
    if (actual.count !== EXPECTED[name].count || actual.sha256 !== EXPECTED[name].sha256) {
      fail(`${name} manifest 不匹配：${JSON.stringify(actual)}`)
      continue
    }
    await writeFile(join(benchmarkRoot, `${name}.ids`), text, 'utf8')
    process.stdout.write(`${name}: ${actual.count} ${actual.sha256}\n`)
  }
}
