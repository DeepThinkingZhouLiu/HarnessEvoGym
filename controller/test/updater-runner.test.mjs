import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  INFRASTRUCTURE_UPDATER_PRESET,
  UPDATER_SANDBOX_PATHS,
  buildUpdaterInvocation,
  extractUpdaterStopReason,
  renderPrompt,
  runMutationPhase,
} from '../src/updater-runner.mjs'
import { ProtocolError } from '../src/protocol.mjs'

function mountMode(args, source, destination) {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (['--ro-bind', '--bind'].includes(args[index])
        && args[index + 1] === source && args[index + 2] === destination) return args[index]
  }
  return null
}

function invocationOptions() {
  return {
    nodeBinary: '/opt/node-dist/bin/node',
    updaterRuntime: '/srv/frozen-runtime',
    candidateRoot: '/srv/candidate',
    gitRoot: '/srv/candidate.git',
    feedbackRoot: '/srv/validation',
    evolutionLogPath: '/srv/evolution-log.jsonl',
    runRoot: '/srv/updater-run',
    runtimePatch: '/srv/control/runtime.patch.yml',
    gatewayUrl: 'http://127.0.0.1:1234/v1',
    gatewayDummyKey: 'local-dummy',
    prompt: 'work',
    uid: 1101,
    gid: 2101,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
    baseEnv: {
      PATH: '/opt/node-dist/bin:/usr/bin',
      NODE_OPTIONS: '--require=/host/leak.js',
      DASHSCOPE_API_KEY: 'must-not-pass',
    },
  }
}

test('renderPrompt resolves dotted values and rejects missing variables', () => {
  assert.equal(renderPrompt('x={{ a.b }} y={{ list }}', {
    a: { b: 1 }, list: ['l1', 'l2'],
  }), 'x=1 y=l1, l2')
  assert.throws(() => renderPrompt('{{ missing }}', {}), ProtocolError)
})

test('soft mutation prompt receives the complete configurable L1-L3 catalogue', async () => {
  const promptPath = fileURLToPath(new URL('../../prompts/updater-mutate-soft.md', import.meta.url))
  const runtimePath = fileURLToPath(new URL(
    '../../environments/hle-text-math/msa-runtime.json',
    import.meta.url,
  ))
  const [template, runtimeText] = await Promise.all([
    readFile(promptPath, 'utf8'), readFile(runtimePath, 'utf8'),
  ])
  const mutation = JSON.parse(runtimeText).mutation
  const rendered = renderPrompt(template, {
    campaign: { id: 'soft' },
    candidate: { id: 'c0001', parentId: 'baseline', root: '/candidate' },
    feedback: { root: '/feedback', log: '/feedback/evolution-log.jsonl' },
    controller: { promptPrefix: '', promptSuffix: '' },
    mutation: {
      layers: mutation.layers,
      readOnlyPaths: mutation.alwaysReadOnly,
    },
  })
  for (const token of ['"id": "l1"', '"id": "l2"', '"id": "l3"',
    'profiles/**', 'agent.py', 'model.py', 'run.py']) {
    assert.match(rendered, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  assert.match(rendered, /organizes the mutable Harness surface into three ordered mutation layers/u)
  assert.match(rendered, /scope boundary and search prior/u)
  assert.match(rendered, /L1 is the narrow declarative surface/u)
  assert.match(rendered, /Controller does not assign an active layer/u)
  assert.match(rendered, /Declarative strategy/u)
  assert.match(rendered, /middleware, hooks, memory\/router, workflow/u)
  assert.match(rendered, /streaming SSE\/event decoding/u)
  assert.match(rendered, /consider multiple plausible explanations/u)
  assert.match(rendered, /not as an exhaustive list of allowed ideas/u)
})

test('single updater call gets one writable worktree and read-only feedback', () => {
  const invocation = buildUpdaterInvocation(invocationOptions())
  assert.equal(INFRASTRUCTURE_UPDATER_PRESET, 'standard')
  assert.equal(invocation.command, '/usr/bin/setpriv')
  assert.equal(mountMode(invocation.args, '/srv/candidate', UPDATER_SANDBOX_PATHS.candidate), '--bind')
  assert.equal(mountMode(invocation.args, '/srv/candidate.git', UPDATER_SANDBOX_PATHS.git), '--bind')
  assert.equal(mountMode(invocation.args, '/srv/validation', UPDATER_SANDBOX_PATHS.feedback), '--ro-bind')
  assert.equal(mountMode(
    invocation.args,
    '/srv/evolution-log.jsonl',
    UPDATER_SANDBOX_PATHS.evolutionLog,
  ), '--ro-bind')
  assert.equal(invocation.env.DASHSCOPE_API_KEY, undefined)
  assert.equal(invocation.env.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(invocation.env.GIT_DIR, UPDATER_SANDBOX_PATHS.git)
  assert.equal(invocation.env.GIT_WORK_TREE, UPDATER_SANDBOX_PATHS.candidate)
  const preset = invocation.args.lastIndexOf('--preset')
  assert.equal(invocation.args[preset + 1], 'standard')
})

test('peer histories are mounted read-only at stable branch paths', () => {
  const options = invocationOptions()
  options.peerLogs = [{
    branchId: 'branch-002',
    sourcePath: '/srv/population/branch-002/evolution-log.jsonl',
    sandboxPath: '/opt/harness-rsi/peer-logs/branch-002.jsonl',
  }]
  const invocation = buildUpdaterInvocation(options)
  assert.equal(mountMode(
    invocation.args,
    '/srv/population/branch-002/evolution-log.jsonl',
    '/opt/harness-rsi/peer-logs/branch-002.jsonl',
  ), '--ro-bind')
})

test('isolated updater reaches the gateway only through the Unix relay', () => {
  const options = invocationOptions()
  options.gatewaySocketPath = '/srv/updater-run/model-gateway.sock'
  const invocation = buildUpdaterInvocation(options)
  assert.ok(invocation.args.includes('--unshare-net'))
  assert.equal(invocation.args.includes('--proc'), false)
  assert.equal(invocation.env.RSI_MODEL_GATEWAY_SOCKET, '/work/model-gateway.sock')
  assert.ok(invocation.args.includes(UPDATER_SANDBOX_PATHS.relay))
})

test('Codex updater uses only the isolated local configuration and keeps DSH available', () => {
  const options = invocationOptions()
  Object.assign(options, {
    backend: 'codex-cli',
    codexPath: '/srv/codex-cli/bin/codex.js',
    updaterProvider: 'zcloud',
    updaterModel: 'gpt-5.6-terra',
    updaterReasoningEffort: 'max',
    gatewaySocketPath: '/srv/updater-run/model-gateway.sock',
    baseEnv: {
      ...options.baseEnv,
      CODEX_HOME: '/host/codex-home',
      HTTP_PROXY: 'http://proxy.invalid:8017',
    },
  })
  const invocation = buildUpdaterInvocation(options)
  assert.ok(invocation.args.includes('/opt/harness-rsi/updater-runtime/bin/codex.js'))
  for (const flag of [
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
  ]) assert.ok(invocation.args.includes(flag))
  assert.equal(invocation.args.includes('--json'), false)
  assert.ok(invocation.args.includes('model_provider="zcloud"'))
  assert.ok(invocation.args.includes('model_reasoning_effort="max"'))
  assert.equal(invocation.env.CODEX_HOME, '/work/home')
  assert.equal(invocation.env.HTTP_PROXY, undefined)
  assert.equal(invocation.env.DSH_HOME, undefined)
  assert.equal(invocation.env.DSH_PERMISSION_MODE, undefined)
  assert.equal(
    mountMode(invocation.args, '/srv/codex-cli', UPDATER_SANDBOX_PATHS.runtime),
    '--ro-bind',
  )
  assert.ok(invocation.args.includes('--unshare-net'))
  assert.equal(invocation.args.includes('--proc'), false)
  assert.ok(invocation.args.includes('/proc/self/exe'))
})

test('extracts RSI_STOP from Codex JSONL final agent message', () => {
  const output = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'RSI_STOP: no general mutation remains' },
    }),
  ].join('\n')
  assert.equal(
    extractUpdaterStopReason('codex-cli', output),
    'no general mutation remains',
  )
  assert.equal(extractUpdaterStopReason('codex-cli', 'RSI_STOP: plain output'), 'plain output')
  assert.equal(extractUpdaterStopReason('deepseek-harness', 'RSI_STOP: done'), 'done')
})

test('mutation phase accepts free-text output and only checks process success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'updater-mutation-'))
  const templatePath = join(directory, 'prompt.md')
  await writeFile(templatePath, 'mutate {{ candidate.id }}')
  const success = await runMutationPhase({
    templatePath,
    templateValues: { candidate: { id: 'c0001-l1' } },
    invocationOptions: invocationOptions(),
    timeoutMs: 1000,
    execute: async () => ({ ok: true, stdout: 'done', stderr: '', durationMs: 12 }),
  })
  assert.equal(success.result.stdout, 'done')
  await assert.rejects(() => runMutationPhase({
    templatePath,
    templateValues: { candidate: { id: 'c0001-l1' } },
    invocationOptions: invocationOptions(),
    timeoutMs: 1000,
    execute: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'failed' }),
  }), /updater_failure/u)
})
