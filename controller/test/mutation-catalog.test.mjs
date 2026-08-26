import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadExperimentBundle, validateTargetAdapter } from '../src/adapters.mjs'
import { readConfigFile } from '../src/config.mjs'
import { mutationPolicyFor } from '../src/candidate.mjs'
import {
  issueMutationLease,
  mutationCatalogFor,
  validateMutationPlan,
} from '../src/mutation-catalog.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function targetAndCatalog() {
  const bundle = await loadExperimentBundle(
    resolve(repositoryRoot, 'experiments/cowork-skillsbench-dsh-l2.json'),
    repositoryRoot,
  )
  return { target: bundle.target, catalog: mutationCatalogFor(bundle.target) }
}

function plan(regionIds, parentId = 'h0', generation = 1) {
  return {
    apiVersion: 'harness-rsi/v1alpha1',
    kind: 'MutationPlan',
    metadata: { id: `plan-${generation}` },
    spec: { generation, parentIds: [parentId], regionIds },
  }
}

test('Mutation Catalog 把 DSH 搜索空间拆成稳定 Region', async () => {
  const { catalog } = await targetAndCatalog()
  assert.deepEqual(
    catalog.spec.regions.map((region) => [region.id, region.riskLevel]),
    [
      ['preset-composition', 'l1'],
      ['skill-guidance', 'l1'],
      ['skill-scripts', 'l2'],
    ],
  )
})

test('旧 Target 不声明 Catalog 时把每个层级自动映射为兼容 Region', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/deepseek-harness.yml'))
  delete config.spec.mutation.catalog
  const target = validateTargetAdapter(config)
  const catalog = mutationCatalogFor(target)
  assert.equal(target.mutation.catalog.derivedFromLegacyLevels, true)
  assert.deepEqual(catalog.spec.regions.map((region) => region.id), ['l1', 'l2'])
})

test('兼容计划选择风险上限内全部 Region 时权限与旧层级完全一致', async () => {
  const { target, catalog } = await targetAndCatalog()
  for (const [level, regionIds] of [
    ['l1', ['preset-composition', 'skill-guidance']],
    ['l2', ['preset-composition', 'skill-guidance', 'skill-scripts']],
  ]) {
    const normalized = validateMutationPlan(plan(regionIds), {
      catalog,
      riskCeiling: level,
      allowedParentIds: ['h0'],
      expectedGeneration: 1,
    })
    const lease = issueMutationLease({ target, catalog, plan: normalized, riskCeiling: level })
    const legacy = mutationPolicyFor(target, level)
    assert.deepEqual(new Set(lease.spec.writable), new Set(legacy.spec.writable))
    assert.deepEqual(new Set(lease.spec.extensions), new Set(legacy.spec.extensions))
    assert.equal(lease.kind, 'MutationLease')
  }
})

test('Strategy 可以只选择一个 Region，且不能越过风险上限', async () => {
  const { target, catalog } = await targetAndCatalog()
  const normalized = validateMutationPlan(plan(['skill-guidance']), {
    catalog,
    riskCeiling: 'l1',
    allowedParentIds: ['h0'],
    expectedGeneration: 1,
  })
  const lease = issueMutationLease({ target, catalog, plan: normalized, riskCeiling: 'l1' })
  assert.ok(lease.spec.writable.every((path) => path.includes('/skills/')))
  assert.deepEqual(lease.metadata.regions, ['skill-guidance'])

  assert.throws(
    () => validateMutationPlan(plan(['skill-scripts']), {
      catalog,
      riskCeiling: 'l1',
      allowedParentIds: ['h0'],
      expectedGeneration: 1,
    }),
    /超出风险上限/u,
  )
})

test('MutationPlan 不能选择不存在的父 Candidate 或夹带路径', async () => {
  const { catalog } = await targetAndCatalog()
  assert.throws(
    () => validateMutationPlan(plan(['skill-guidance'], 'missing'), {
      catalog,
      riskCeiling: 'l1',
      allowedParentIds: ['h0'],
      expectedGeneration: 1,
    }),
    /不可用父 Candidate/u,
  )
  const forged = plan(['skill-guidance'])
  forged.spec.writable = ['controller/**']
  assert.throws(
    () => validateMutationPlan(forged, {
      catalog,
      riskCeiling: 'l1',
      allowedParentIds: ['h0'],
      expectedGeneration: 1,
    }),
    /未知字段/u,
  )
})

test('Target 加载时拒绝 Region 依赖环和向上风险依赖', async () => {
  const config = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/deepseek-harness.yml'))
  config.spec.mutation.catalog.regions[0].requires = ['skill-guidance']
  config.spec.mutation.catalog.regions[1].requires = ['preset-composition']
  assert.throws(() => validateTargetAdapter(config), /依赖图存在环/u)

  const upward = await readConfigFile(resolve(repositoryRoot, 'adapters/targets/deepseek-harness.yml'))
  upward.spec.mutation.catalog.regions[0].requires = ['skill-scripts']
  assert.throws(() => validateTargetAdapter(upward), /更高风险/u)
})
