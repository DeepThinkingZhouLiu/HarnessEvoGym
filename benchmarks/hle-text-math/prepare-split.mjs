#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  HLE_DATASET_PIN,
  HLE_PARTITION_SIZE,
  readHleJsonl,
  stratifiedHleSplit,
  writeHleSplit,
} from '../../controller/src/hle-dataset.mjs'

const TARGET_REVISION = '3289531e06e924abb790685f44baf67311f26ec9'

function options(args) {
  const parsed = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('usage: prepare-split.mjs --input PATH --control-root PATH --dataset-root PATH [--seed TEXT] [--validation-count N] [--test-count N] [--test-every N]')
    }
    parsed.set(name.slice(2), value)
  }
  for (const required of ['input', 'control-root', 'dataset-root']) {
    if (!parsed.has(required)) throw new Error(`missing --${required}`)
  }
  return parsed
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback
  if (!/^\d+$/u.test(value)) throw new Error(`--${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error(`--${name} must be in 1..10000`)
  }
  return parsed
}

function campaign(metadata) {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'EvolutionCampaign',
    metadata: {
      id: 'hle-math-restricted-minimal-dashscope-qwen38-32k',
      name: 'HLE Text-only Math Restricted-Minimal Harness RSI L1-L3 — DashScope Qwen3.8-Max',
    },
    spec: {
      source: {
        format: 'hle-text-math',
        dataset: HLE_DATASET_PIN.dataset,
        revision: HLE_DATASET_PIN.revision,
        filter: { category: 'Math', textOnly: true },
        sampling: {
          method: 'deterministic-largest-remainder',
          strata: ['raw_subject', 'answer_type'],
          seed: metadata.seed,
          eligibleCount: metadata.eligibleCount,
        },
      },
      partitions: {
        validation: {
          manifest: 'validation.ids',
          expectedCount: metadata.validationCount,
          sha256: metadata.validationManifestSha256,
          visibility: 'feedback',
        },
        test: {
          manifest: 'test.ids',
          expectedCount: metadata.testCount,
          sha256: metadata.testManifestSha256,
          visibility: 'sealed-until-closed',
        },
      },
      evolution: {
        levels: ['l1', 'l2', 'l3'],
        consecutiveMissesBeforeAdvance: 3,
        promotion: 'strict-validation-verified-count',
        testEvaluationInterval: metadata.testEvaluationInterval,
      },
      scoring: {
        method: 'trusted-llm-judge',
        judgeModel: 'qwen3.8-max',
        judgeReasoningEffort: 'low',
        exposeValidationTrace: true,
        exposeTestDetails: false,
      },
      solver: {
        targetRevision: TARGET_REVISION,
        profile: 'headless',
        preset: 'minimal',
        api: 'openai-responses',
        model: 'qwen3.8-max',
        reasoningEffort: 'max',
      },
    },
  }
}

const parsed = options(process.argv.slice(2))
const controlRoot = resolve(parsed.get('control-root'))
const datasetRoot = resolve(parsed.get('dataset-root'))
const seed = parsed.get('seed') ?? 'hle-text-math-rsi-v1'
const validationCount = positiveInteger(
  parsed.get('validation-count'), HLE_PARTITION_SIZE, 'validation-count',
)
const testCount = positiveInteger(parsed.get('test-count'), HLE_PARTITION_SIZE, 'test-count')
const testEvaluationInterval = positiveInteger(parsed.get('test-every'), 5, 'test-every')
const rows = await readHleJsonl(parsed.get('input'))
const split = stratifiedHleSplit(rows, { seed, validationCount, testCount })
const metadata = await writeHleSplit({ split, controlRoot, datasetRoot })
const configPath = join(controlRoot, 'campaign.json')
await writeFile(configPath, `${JSON.stringify(campaign({
  ...metadata,
  seed,
  testEvaluationInterval,
}), null, 2)}\n`, {
  encoding: 'utf8', flag: 'wx', mode: 0o600,
})
process.stdout.write(`${JSON.stringify({
  kind: 'HleTextMathPreparation',
  eligibleCount: metadata.eligibleCount,
  validationCount: metadata.validationCount,
  testCount: metadata.testCount,
  strataCount: metadata.strata.length,
  configPath,
})}\n`)
