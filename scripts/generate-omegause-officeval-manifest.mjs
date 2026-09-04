import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { runProcess } from '../controller/src/process.mjs'

const COM_REQUIRED = new Set([
  'officeval_001',
  'officeval_008',
  'officeval_019',
  'officeval_022',
  'officeval_023',
  'officeval_030',
  'officeval_039',
  'officeval_074',
  'officeval_081',
])
const INSTANCE_ID = /^officeval_[0-9]{3}$/u

function fail(message) {
  throw new Error(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fileRecord(root, pathValue) {
  const actualRoot = await realpath(root)
  const actual = await realpath(pathValue)
  const path = relative(actualRoot, actual).replaceAll('\\', '/')
  if (path === '..' || path.startsWith('../')) fail(`文件逃逸受信根目录：${pathValue}`)
  const info = await lstat(actual)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`不是独立普通文件：${pathValue}`)
  const source = await readFile(actual)
  return { path, bytes: source.byteLength, sha256: sha256(source) }
}

async function evaluatorRevision(root) {
  const result = await runProcess('git', ['-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  const status = await runProcess(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'],
    { timeoutMs: 30_000 },
  )
  if (status.stdout.trim()) fail(`Evaluator Checkout 不是干净状态：${root}`)
  return result.stdout.trim()
}

async function datasetRevision(root) {
  const cacheRoot = join(root, '.cache', 'huggingface', 'trees')
  const entries = (await readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[0-9a-f]{40}\.json$/u.test(entry.name))
    .map((entry) => entry.name.slice(0, 40))
  if (entries.length !== 1) fail(`无法唯一确定 Hugging Face Dataset Revision：${entries.join(', ')}`)
  return entries[0]
}

async function main() {
  const [datasetInput, evaluatorInput, outputInput] = process.argv.slice(2)
  if (!datasetInput || !evaluatorInput || !outputInput) {
    fail('用法：node scripts/generate-omegause-officeval-manifest.mjs <dataset-root> <evaluator-root> <output>')
  }
  const datasetRoot = await realpath(resolve(datasetInput))
  const evaluatorRoot = await realpath(resolve(evaluatorInput))
  const output = resolve(outputInput)
  const instances = {}

  for (let number = 1; number <= 100; number += 1) {
    const id = `officeval_${String(number).padStart(3, '0')}`
    if (!INSTANCE_ID.test(id)) fail(`非法 Instance ID：${id}`)
    const taskPath = join(datasetRoot, 'task-en', `${id}.json`)
    const rubricPath = join(datasetRoot, 'rubrics-en', `${id}.json`)
    const verifierPath = join(evaluatorRoot, 'verifiers', `${id}_verifier.py`)
    const task = JSON.parse(await readFile(taskPath, 'utf8'))
    if (task.id !== id || typeof task.instruction !== 'string' || !Array.isArray(task.origin_files)) {
      fail(`Task 定义无效：${id}`)
    }
    const inputDirectory = join(datasetRoot, 'task_files', id)
    const entries = await readdir(inputDirectory, { withFileTypes: true })
    if (entries.some((entry) => !entry.isFile())) fail(`Task 输入目录只能包含普通文件：${id}`)
    const expectedNames = task.origin_files.map((item) => item.dest).sort()
    const actualNames = entries.map((entry) => entry.name).sort()
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
      fail(`Task 输入文件与 origin_files 不一致：${id}`)
    }
    instances[id] = {
      comRequired: COM_REQUIRED.has(id),
      task: await fileRecord(datasetRoot, taskPath),
      rubric: await fileRecord(datasetRoot, rubricPath),
      inputs: await Promise.all(actualNames.map((name) => fileRecord(datasetRoot, join(inputDirectory, name)))),
      verifier: await fileRecord(evaluatorRoot, verifierPath),
    }
  }

  const manifest = {
    apiVersion: 'harness-rsi/omegause-officeval-manifest-v1',
    dataset: {
      id: 'baidu-frontier-research/OmegaUse-OfficeVal',
      revision: await datasetRevision(datasetRoot),
    },
    evaluator: {
      repository: 'baidu-frontier-research/OmegaUse-OfficeVal',
      revision: await evaluatorRevision(evaluatorRoot),
      sharedFiles: [await fileRecord(evaluatorRoot, join(evaluatorRoot, 'verifiers', 'pdf_backend.py'))],
    },
    platform: {
      linuxStaticVerifierCount: 91,
      excludedComRequired: [...COM_REQUIRED].sort(),
    },
    instances,
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(output, serialized, { encoding: 'utf8', mode: 0o644 })
  process.stdout.write(`${basename(output)} sha256=${sha256(serialized)} instances=${Object.keys(instances).length}\n`)
}

await main()
