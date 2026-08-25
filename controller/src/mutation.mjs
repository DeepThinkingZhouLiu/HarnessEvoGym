import { ProtocolError } from './protocol.mjs'

export const DEEPSEEK_HARNESS_MUTATION_POLICY = Object.freeze({
  alwaysReadOnly: [
    '.git',
    '.git/**',
    '.github/**',
    'vendor/**',
    'packages/credentials/**',
    'packages/interaction/permission-presets/**',
    'packages/interaction/user-approval/**',
    'packages/llm/token-meter/**',
    'packages/llm/llm-pi-ai/**',
    'packages/core/agent-default-model/**',
    'packages/sandbox/**',
    '**/.env',
    '**/.env.*',
    '**/*credentials*.yml',
    '**/*credentials*.yaml',
  ],
  levels: {
    l1: ['apps/cli/config/agent-presets/**'],
    l2: [
      'apps/cli/config/agent-presets/**',
      'packages/compaction/**',
      'packages/context/**',
      'packages/extensions/**',
      'packages/guard/**',
      'packages/hooks/**',
      'packages/llm/llm-retry/**',
      'packages/plan/**',
      'packages/preset/**',
      'packages/skill/**',
      'packages/subagent/**',
      'packages/todo/**',
      'packages/workflow/**',
      'packages/web/**',
      'packages/fs/tool-*/**',
      'packages/interaction/tool-*/**',
      'packages/shell/tool-*/**',
    ],
    l3: [
      'apps/**',
      'examples/**',
      'native/**',
      'packages/**',
      'python/**',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig*.json',
    ],
  },
})

export const MSA_MINIMAL_MUTATION_CONFIGURATION = Object.freeze({
  mode: 'updater-soft',
  alwaysReadOnly: [
    '.git',
    '.git/**',
    'LICENSE.md',
    'NOTICE.md',
    'README.md',
    '**/.env',
    '**/.env.*',
  ],
  layers: [
    {
      id: 'l1',
      description: 'Declarative strategy in profiles/**: Solver role, math/coding approach, Bash and final-answer protocol, response format, self-checking guidance, and step/token/tool budgets. Prefer this layer whenever behavior can change without new runtime state or control flow.',
      writablePaths: ['profiles/**'],
    },
    {
      id: 'l2',
      description: 'Behavioral extensions in profiles/**, agent.py, and tools.py: localized workflow/middleware, message history and context handling, action/final parsing and repair, step scheduling, trace events, Bash lifecycle, timeout handling, and observation encoding or trimming.',
      writablePaths: ['profiles/**', 'agent.py', 'tools.py'],
    },
    {
      id: 'l3',
      description: 'Solver core and runtime assembly in profiles/**, agent.py, tools.py, model.py, and run.py: structural loop changes, Responses request construction, streaming SSE decoding, error/retry semantics, session/CLI wiring, artifact lifecycles, and entrypoint composition.',
      writablePaths: ['profiles/**', 'agent.py', 'tools.py', 'model.py', 'run.py'],
    },
  ],
})

const LEVELS = new Set(['l1', 'l2', 'l3'])

function validPattern(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some((part) => ['', '.', '..'].includes(part))
}

/** Validate and normalize the target-owned soft layer catalogue. */
export function mutationPolicyFromConfiguration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || input.mode !== 'updater-soft'
      || !Array.isArray(input.alwaysReadOnly)
      || !Array.isArray(input.layers)) {
    throw new ProtocolError('Soft mutation configuration 格式错误')
  }
  const ids = input.layers.map((layer) => layer?.id)
  if (ids.length !== 3 || ids.some((id, index) => id !== ['l1', 'l2', 'l3'][index])) {
    throw new ProtocolError('Soft mutation layers 必须按顺序定义 l1、l2、l3')
  }
  if (input.alwaysReadOnly.length === 0 || input.alwaysReadOnly.some((path) => !validPattern(path))) {
    throw new ProtocolError('Soft mutation alwaysReadOnly 包含非法路径模式')
  }

  let previous = new Set()
  const levels = {}
  const layers = input.layers.map((layer) => {
    if (typeof layer.description !== 'string' || layer.description.trim().length === 0
        || !Array.isArray(layer.writablePaths) || layer.writablePaths.length === 0
        || layer.writablePaths.some((path) => !validPattern(path))) {
      throw new ProtocolError(`Soft mutation ${layer.id} 描述或 writablePaths 无效`)
    }
    const writablePaths = [...new Set(layer.writablePaths)]
    if ([...previous].some((path) => !writablePaths.includes(path))) {
      throw new ProtocolError(`Soft mutation ${layer.id} 必须包含上一层全部 writablePaths`)
    }
    previous = new Set(writablePaths)
    levels[layer.id] = writablePaths
    return {
      id: layer.id,
      description: layer.description.trim(),
      writablePaths,
    }
  })
  return {
    mode: 'updater-soft',
    alwaysReadOnly: [...new Set(input.alwaysReadOnly)],
    levels,
    layers,
  }
}

export const MSA_MINIMAL_MUTATION_POLICY = Object.freeze(
  mutationPolicyFromConfiguration(MSA_MINIMAL_MUTATION_CONFIGURATION),
)

function normalizePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\')
      || path.startsWith('/') || path.split('/').some((part) => ['', '.', '..'].includes(part))) {
    throw new ProtocolError(`非法 Candidate 相对路径：${String(path)}`)
  }
  return path
}

function globToRegExp(glob) {
  let source = '^'
  for (let index = 0; index < glob.length;) {
    const char = glob[index]
    if (char !== '*') {
      source += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
      index += 1
      continue
    }
    if (glob[index + 1] !== '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (glob[index + 2] === '/') {
      source += '(?:.*/)?'
      index += 3
    } else {
      source += '.*'
      index += 2
    }
  }
  return new RegExp(`${source}$`, 'u')
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path))
}

/** The only mutation audit: Git supplies changed paths; this enforces the level boundary. */
export function isPathAllowed(path, level, policy = DEEPSEEK_HARNESS_MUTATION_POLICY) {
  const normalized = normalizePath(path)
  if (!LEVELS.has(level)) throw new ProtocolError(`未知 mutation level：${level}`)
  if (matchesAny(normalized, policy.alwaysReadOnly)) return false
  return matchesAny(normalized, policy.levels[level])
}
