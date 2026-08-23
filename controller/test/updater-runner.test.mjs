import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  UPDATER_SANDBOX_PATHS,
  buildUpdaterInvocation,
  parseStrictJsonOutput,
  renderPrompt,
  runApplyPhase,
  runProposalPhase,
} from '../src/updater-runner.mjs'
import { ProtocolError } from '../src/protocol.mjs'

test('renderPrompt resolves dotted values and rejects missing variables', () => {
  assert.equal(renderPrompt('x={{ a.b }} y={{ list }}', { a: { b: 1 }, list: ['l1', 'l2'] }), 'x=1 y=l1, l2')
  assert.throws(() => renderPrompt('{{ missing }}', {}), ProtocolError)
})

test('strict JSON parser rejects markdown and wrong kind', () => {
  assert.equal(parseStrictJsonOutput('{"kind":"MutationProposal"}', 'MutationProposal').kind, 'MutationProposal')
  assert.throws(() => parseStrictJsonOutput('```json\n{}\n```'), ProtocolError)
  assert.throws(() => parseStrictJsonOutput('{}', 'MutationProposal'), ProtocolError)
})

test('source invocation keeps real provider keys out of Candidate environment', () => {
  const invocation = buildUpdaterInvocation({
    nodeBinary: '/runtime/node', updaterRuntime: '/runtime/harness', candidateRoot: '/campaign/candidate',
    runRoot: '/campaign/run', runtimePatch: '/control/patch.yml', gatewayUrl: 'http://127.0.0.1:1/v1',
    gatewayDummyKey: 'local-dummy', prompt: 'work', permissionMode: 'workspace-write',
    legacy: true,
    baseEnv: { PATH: '/bin', ZCLOUD_API_KEY: 'must-not-pass', DASHSCOPE_API_KEY: 'must-not-pass' },
  })
  assert.equal(invocation.env.ZCLOUD_API_KEY, undefined)
  assert.equal(invocation.env.DASHSCOPE_API_KEY, undefined)
  assert.equal(invocation.env.RSI_MODEL_GATEWAY_DUMMY_KEY, 'local-dummy')
  assert.equal(invocation.env.DSH_PERMISSION_MODE, 'workspace-write')
  assert.match(invocation.env.DSH_SOURCE_BIN, /apps\/cli\/src\/bin\.ts$/u)
})

test('updater invocation is fail-closed unless legacy mode is explicit', () => {
  assert.throws(() => buildUpdaterInvocation({
    nodeBinary: '/runtime/node', updaterRuntime: '/runtime/harness',
    candidateRoot: '/campaign/candidate', runRoot: '/campaign/run',
    runtimePatch: '/control/patch.yml', gatewayUrl: 'http://127.0.0.1:1/v1',
    gatewayDummyKey: 'local-dummy', prompt: 'work', permissionMode: 'read-only',
  }), /必须提供 uid\/gid/u)
})

function mountMode(args, source, destination) {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (['--ro-bind', '--bind'].includes(args[index])
        && args[index + 1] === source && args[index + 2] === destination) {
      return args[index]
    }
  }
  return null
}

function explicitMounts(args) {
  const mounts = []
  for (let index = 0; index < args.length - 2; index += 1) {
    if (['--ro-bind', '--bind'].includes(args[index]) && args[index + 1] !== '/usr') {
      mounts.push(args.slice(index, index + 3))
    }
  }
  return mounts
}

test('sandboxed updater rewrites host paths and exposes only phase-scoped mounts', () => {
  const base = {
    nodeBinary: '/opt/node-dist/bin/node',
    updaterRuntime: '/srv/frozen-runtime',
    candidateRoot: '/srv/candidate',
    feedbackRoot: '/srv/validation-feedback',
    runRoot: '/srv/updater-run',
    runtimePatch: '/srv/control/runtime.patch.yml',
    gatewayUrl: 'http://127.0.0.1:1234/v1',
    gatewayDummyKey: 'local-dummy',
    prompt: 'inspect /srv/candidate with /srv/validation-feedback',
    uid: 1101,
    gid: 2101,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
    baseEnv: {
      PATH: '/opt/node-dist/bin:/usr/bin',
      NODE_OPTIONS: '--require=/host/repo/leak.js',
      ZCLOUD_API_KEY: 'must-not-pass',
    },
  }
  const proposal = buildUpdaterInvocation({
    ...base,
    permissionMode: 'read-only',
  })
  const apply = buildUpdaterInvocation({
    ...base,
    permissionMode: 'workspace-write',
  })

  for (const invocation of [proposal, apply]) {
    assert.equal(invocation.command, '/usr/bin/setpriv')
    assert.deepEqual(invocation.args.slice(0, 4), [
      '--reuid=1101', '--regid=2101', '--clear-groups', '--no-new-privs',
    ])
    assert.equal(invocation.args[4], '/usr/bin/bwrap')
    assert.equal(invocation.args.includes('--unshare-net'), false)
    assert.equal(explicitMounts(invocation.args).length, 6)
    assert.equal(mountMode(
      invocation.args,
      '/srv/frozen-runtime',
      UPDATER_SANDBOX_PATHS.runtime,
    ), '--ro-bind')
    assert.equal(mountMode(
      invocation.args,
      '/srv/validation-feedback',
      UPDATER_SANDBOX_PATHS.feedback,
    ), '--ro-bind')
    assert.equal(mountMode(
      invocation.args,
      '/srv/updater-run',
      UPDATER_SANDBOX_PATHS.run,
    ), '--bind')
    assert.equal(mountMode(
      invocation.args,
      '/srv/control/runtime.patch.yml',
      UPDATER_SANDBOX_PATHS.runtimePatch,
    ), '--ro-bind')
    assert.equal(mountMode(
      invocation.args,
      '/opt/node-dist',
      UPDATER_SANDBOX_PATHS.nodeToolchain,
    ), '--ro-bind')

    const boundary = invocation.args.lastIndexOf('--')
    const inner = invocation.args.slice(boundary + 1).join(' ')
    for (const hostPath of [
      '/srv/frozen-runtime', '/srv/candidate', '/srv/validation-feedback',
      '/srv/updater-run', '/srv/control/runtime.patch.yml', '/opt/node-dist',
    ]) assert.equal(inner.includes(hostPath), false)
    assert.match(inner, /\/opt\/harness-rsi\/candidate/u)
    assert.match(inner, /\/opt\/harness-rsi\/feedback/u)
    assert.equal(invocation.cwd, '/')
    assert.equal(invocation.env.HOME, '/work/home')
    assert.equal(invocation.env.TMPDIR, '/work/tmp')
    assert.equal(invocation.env.TASK_CWD, UPDATER_SANDBOX_PATHS.candidate)
    assert.match(invocation.env.DSH_SOURCE_BIN, /\/opt\/harness-rsi\/updater-runtime/u)
    assert.equal(
      invocation.env.TSX_TSCONFIG_PATH,
      `${UPDATER_SANDBOX_PATHS.runtime}/tsconfig.json`,
    )
    assert.equal(invocation.env.NODE_OPTIONS, undefined)
    assert.equal(invocation.env.ZCLOUD_API_KEY, undefined)
  }
  assert.equal(mountMode(
    proposal.args,
    '/srv/candidate',
    UPDATER_SANDBOX_PATHS.candidate,
  ), '--ro-bind')
  assert.equal(mountMode(
    apply.args,
    '/srv/candidate',
    UPDATER_SANDBOX_PATHS.candidate,
  ), '--bind')
})

test('proposal and apply phases enforce output contracts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'updater-runner-'))
  const template = join(directory, 'prompt.md')
  await writeFile(template, 'candidate {{ candidate.id }}')
  const invocationOptions = {
    nodeBinary: '/runtime/node', updaterRuntime: '/runtime/harness', candidateRoot: '/campaign/candidate',
    runRoot: '/campaign/run', runtimePatch: '/control/patch.yml', gatewayUrl: 'http://127.0.0.1:1/v1',
    gatewayDummyKey: 'local-dummy', baseEnv: { PATH: '/bin' },
    legacy: true,
  }
  const executeProposal = async (options) => ({
    ok: true, stdout: JSON.stringify({ kind: 'MutationProposal', proposalId: 'p1' }), stderr: '', options,
  })
  const proposal = await runProposalPhase({
    templatePath: template, templateValues: { candidate: { id: 'c1' } }, invocationOptions,
    timeoutMs: 1000, execute: executeProposal,
  })
  assert.equal(proposal.proposal.proposalId, 'p1')

  const executeApply = async () => ({
    ok: true,
    stdout: JSON.stringify({
      proposalId: 'p1', diagnosis: 'x', changedFiles: ['a'], checks: [], remainingRisks: [],
    }),
    stderr: '',
  })
  const applied = await runApplyPhase({
    templatePath: template, templateValues: { candidate: { id: 'c1' } }, invocationOptions,
    timeoutMs: 1000, execute: executeApply,
  })
  assert.equal(applied.report.proposalId, 'p1')
})
