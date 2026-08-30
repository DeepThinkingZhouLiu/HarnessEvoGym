import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = join(repositoryRoot, 'controller', 'src', 'cli.mjs')

async function runCli(args) {
  const { stdout } = await execute(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

test('CLI 用不冲突的命名空间同时暴露 Reasoning 与 Cowork', async () => {
  const help = await runCli(['--help'])
  assert.match(help, /experiment run --config/u)
  assert.match(help, /experiment baseline --config/u)
  assert.match(help, /evolve start\|run\|resume/u)
  assert.doesNotMatch(help, /evolve run --experiment/u)
})

test('Cowork Experiment 与 Future Reasoning Campaign 可在同一 CLI 分别校验', async () => {
  const experiment = JSON.parse(await runCli([
    'experiment',
    'validate',
    '--config',
    'experiments/cowork-omegause-dsh-l1.json',
  ]))
  assert.equal(experiment.kind, 'ExperimentValidationReport')
  assert.equal(experiment.mutationLevel, 'l1')

  const campaign = JSON.parse(await runCli([
    'campaign',
    'validate',
    '--config',
    'benchmarks/hle-text-math/msa-population50-codex-terra-high/single.json',
    '--runtime',
    'environments/hle-text-math/msa-codex-terra-high-runtime.json',
  ]))
  assert.equal(campaign.kind, 'CampaignValidationReport')
  assert.equal(campaign.controllerConfig.mode, 'single')
})
