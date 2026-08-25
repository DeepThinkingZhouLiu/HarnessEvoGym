import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  HleJudgeInfrastructureError,
  buildHleSolverSandboxInvocation,
  buildHleSolverPrompt,
  extractFinalAssistantText,
  parseHleJudgeDecision,
  prepareHleTask,
  verifyHleTask,
} from '../src/hle-partition-runner.mjs'

const ID = 'hle_0123456789abcdef01234567'

function record() {
  return {
    instanceId: ID,
    sourceId: 'official-private-id',
    question: 'What is 40 + 2?',
    answer: '42',
    answerType: 'exactMatch',
    rawSubject: 'Algebra',
    category: 'Math',
  }
}

test('HLE prompt exposes the question but never its trusted answer', () => {
  const prompt = buildHleSolverPrompt(record())
  assert.match(prompt, /What is 40 \+ 2\?/u)
  assert.match(prompt, /Explanation:/u)
  assert.match(prompt, /Restricted minimal mode/u)
  assert.match(prompt, /shell\/Python/u)
  assert.match(prompt, /External networking.*prohibited/u)
  assert.match(prompt, /reference\/gold answers/u)
  assert.equal(prompt.includes('Reference answer'), false)
  assert.equal(prompt.includes('\n42\n'), false)
})

test('pinned minimal preset exposes only local shell/editor stacks and no web tool', async () => {
  const path = fileURLToPath(new URL(
    '../../sources/deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml',
    import.meta.url,
  ))
  const preset = await readFile(path, 'utf8')
  assert.match(preset, /dsh-tool-bash-persistent/u)
  assert.match(preset, /dsh-tool-str-replace-editor/u)
  assert.doesNotMatch(preset, /dsh-tool-web/u)
  assert.doesNotMatch(preset, /dsh-subagent/u)
})

test('task preparation keeps the answer outside the solver workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-task-'))
  const store = join(root, 'store')
  await mkdir(store)
  await writeFile(join(store, 'records.jsonl'), `${JSON.stringify(record())}\n`)
  const task = await prepareHleTask({
    solutionsRoot: store,
    problemId: ID,
    taskRoot: join(root, 'tasks'),
    trustedRoot: join(root, 'trusted'),
  })
  assert.equal(await readFile(task.editablePath, 'utf8'), '')
  assert.equal((await readFile(task.trustedPath, 'utf8')).includes('"answer":"42"'), true)
  assert.equal((await readFile(task.editablePath, 'utf8')).includes('42'), false)
})

test('answer extraction selects the root session and ignores child agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-session-'))
  await mkdir(join(root, 'child'))
  const message = (text) => JSON.stringify({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  await writeFile(join(root, 'root.jsonl'), [
    JSON.stringify({ type: 'session', version: 0, id: 'root', createdAt: 1 }),
    message('Explanation: x\nAnswer: 42\nConfidence: 99'),
    '',
  ].join('\n'))
  await writeFile(join(root, 'child', 'child.jsonl'), [
    JSON.stringify({
      type: 'session', version: 0, id: 'child', createdAt: 2,
      parentSession: 'root', origin: 'subagent',
    }),
    message('Answer: WRONG'),
    '',
  ].join('\n'))
  assert.match(await extractFinalAssistantText(root), /Answer: 42/u)
})

test('sandbox invocation retains controller-only host output paths', () => {
  const gatewaySocketPath = '/dev/shm/rsi-gw-test/gateway.sock'
  const invocation = buildHleSolverSandboxInvocation({
    invocation: {
      command: '/candidate/bin/dsh',
      args: ['--session-root', '/task/.sessions'],
      cwd: '/task',
      env: {
        DSH_SESSION_ROOT: '/task/.sessions',
        RSI_HLE_ANSWER_PATH: '/task/answer.txt',
        RSI_MODEL_GATEWAY_SOCKET: gatewaySocketPath,
      },
    },
    candidateRoot: '/candidate',
    workdir: '/task',
    nodePath: '/usr/bin/node',
    patchPath: '/control/runtime.patch.yml',
    solverUid: 1102,
    solverGid: 1102,
    bwrapPath: '/usr/bin/bwrap',
    setprivPath: '/usr/bin/setpriv',
    gatewaySocketPath,
  })
  assert.equal(invocation.env.DSH_SESSION_ROOT, '/work/.sessions')
  assert.equal(invocation.env.RSI_HLE_ANSWER_PATH, '/work/answer.txt')
  assert.equal(invocation.env.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(invocation.rsiHostSessionRoot, '/task/.sessions')
  assert.equal(invocation.rsiHostAnswerPath, '/task/answer.txt')
  assert.equal(Object.hasOwn(invocation.env, 'rsiHostSessionRoot'), false)
  assert.ok(invocation.args.includes('--unshare-net'))
  assert.equal(invocation.args.includes('--proc'), false)
  assert.equal(invocation.env.RSI_MODEL_GATEWAY_SOCKET, '/opt/harness-rsi/gateway/gateway.sock')
  assert.ok(invocation.args.includes('/opt/harness-rsi/control/model-gateway-relay.mjs'))
  assert.equal(invocation.args.join('\n').includes('/task/trusted'), false)
  assert.equal(Object.values(invocation.env).join('\n').includes('/task/trusted'), false)
})

test('judge output accepts only one boolean field', () => {
  assert.deepEqual(parseHleJudgeDecision('{"correct":true}'), { correct: true })
  assert.deepEqual(parseHleJudgeDecision('```json\n{"correct":false}\n```'), { correct: false })
  assert.throws(() => parseHleJudgeDecision('{"correct":true,"answer":"42"}'))
})

test('LLM judge result maps to score and accounts for the extra request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-judge-'))
  const editablePath = join(root, 'answer.txt')
  const trustedPath = join(root, 'trusted.json')
  await writeFile(editablePath, 'Explanation: arithmetic\nAnswer: 42\nConfidence: 99\n')
  await writeFile(trustedPath, `${JSON.stringify(record())}\n`)
  let received
  const result = await verifyHleTask({
    editablePath,
    trustedPath,
    judge: async (value) => {
      received = value
      return {
        correct: true,
        usage: { requests: 1, inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      }
    },
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.failureKind, null)
  assert.equal(result.usage.requests, 1)
  assert.equal(received.record.answer, '42')
  assert.match(received.response, /Answer: 42/u)
})

test('judge infrastructure trace retains only the allowlisted failure code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hle-judge-error-'))
  const editablePath = join(root, 'answer.txt')
  const trustedPath = join(root, 'trusted.json')
  await writeFile(editablePath, 'Explanation: arithmetic\nAnswer: 42\nConfidence: 99\n')
  await writeFile(trustedPath, `${JSON.stringify(record())}\n`)
  const result = await verifyHleTask({
    editablePath,
    trustedPath,
    judge: async () => {
      throw new HleJudgeInfrastructureError('JUDGE_UPSTREAM_REJECTED')
    },
  })
  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.failureKind, 'infrastructure')
  assert.equal(result.reasonCode, 'judge_upstream_rejected')
  assert.equal(Object.hasOwn(result, 'error'), false)
})
