# DeepSeek Harness RSI

English | [中文](README.zh.md)

An executable platform for evolving agent Harnesses on frozen validation tasks.
The same trusted Controller repository now supports both **Reasoning** and
**Cowork**: the Future branch population Controller is the base, while the
SkillsBench, DSH overlay, reward evaluation, and Docker isolation from `lz-dev`
are integrated as the Cowork increment.

## System design

```text
Frozen tasks -> Candidate Solver -> validation score + traces
                    ^                         |
                    |                         v
                Git commit <- Updater <- evolution log
                    |
                    v
              Controller keep/reset
```

| Component | Responsibility | Boundary |
|---|---|---|
| Source | Pinned Harness baseline | Read-only |
| Solver | Solves tasks with the Candidate Harness | Cannot read gold/test/credentials |
| Updater | Reads validation feedback, edits one Candidate, creates one commit | Only configured paths are writable |
| Controller | Scheduling, Budget, Git audit, evaluation, keep/reset, reports | Never writable |
| Evaluator/Gateway | Frozen score and model identity; credential isolation | Outside the Candidate |

One evolution round is:

```text
incumbent
  -> Updater reads source + validation feedback + history
  -> chooses L1/L2/L3, applies one coherent change, commits
  -> Controller checks one child commit and its changed paths
  -> Candidate runs validation
  -> score improves: keep; otherwise: git reset to incumbent
```

The Controller does not design mutation directions. Each branch reuses one Git
worktree; there is no per-round full-project copy or separate proposal/apply
session.

## Two scenario execution planes

| Scenario | CLI | Target / environment | Current algorithm |
|---|---|---|---|
| Reasoning | `campaign ...` / `evolve ...` | Minimal Harness + HLE, or DSH + PutnamBench | Future `single/independent/mutualism/competition/combined` population modes |
| Cowork | `experiment ...` | DSH `cowork-rsi` overlay + SkillsBench | Linear Champion evolution: `feedback -> update -> selection` |

Both planes share Benchmark, Policy, Solver Result, and Evaluator protocols,
but preserve their proven environment isolation. Reasoning uses host identities,
bubblewrap, and a sealed broker. Cowork uses task Docker images, a separate
Verifier, and a Model Gateway that gives agents only one-time tokens.

Cowork currently exposes L1 and L2. L1 changes declarative presets, prompts,
and Skill documents; L2 also allows Skill scripts. L3 remains disabled. The
Controller deterministically rechecks path allowlists, extensions, executable
bits, file limits, symlinks, and Cordis plugins after every Updater session.

## Minimal math/coding Harness

The committed baseline is
[`sources/msa-minimal-harness/`](sources/msa-minimal-harness/README.md):

```text
task -> model -> optional <bash> -> observation -> model -> <final>
```

| Layer | Writable files | Meaning |
|---|---|---|
| L1 | `profiles/**` | Prompt, strategy, answer/tool discipline, step/token budgets |
| L2 | L1 + `agent.py` + `tools.py` | Parsing, history, workflow, verification, Bash behavior |
| L3 | L2 + `model.py` + `run.py` | Agent-loop structure, Responses/SSE, session/runtime wiring |
| Never writable | Controller, evaluator, tasks/splits, gold, credentials, Budget and promotion | Trust root |

In `updater-soft` mode all three layer descriptions are injected on every
round. The Updater is guided to choose the smallest sufficient layer; the
Controller only performs a lightweight path audit.

## Population modes

| Mode | Branches | Coordination |
|---|---:|---|
| `single` | 1 | One branch owns all Budget |
| `independent` | N | Budget is divided; branches do not communicate |
| `mutualism` | N | Independent + read-only peer evolution logs |
| `competition` | N | Equal Base Budget + Bonus for the largest score delta |
| `combined` | N | Mutualism + Competition |

Competition and Combined use:

```text
base_per_branch = floor(total_budget * beta / n_branches)
bonus_pool      = total_budget - base_per_branch * n_branches
```

Branches advance in synchronized waves. Exhausted branches leave ranking; their
existing logs may still help peers in Combined mode.

## Key configuration

| Change | File / field |
|---|---|
| Mode, branches, Budget, beta | Campaign: `controller_config` |
| Dataset revision and validation/test manifests | Campaign: `spec.source`, `spec.partitions` |
| Frozen Solver model/effort | Campaign: `spec.solver` |
| Solver concurrency and timeouts | Runtime: `solver` |
| Updater backend/model/effort | Runtime: `updater` |
| Provider URL and request timeout | Runtime: `gateway` |
| L1/L2/L3 descriptions and paths | Runtime: `mutation.layers` |
| Harness implementation | `sources/msa-minimal-harness/` or another pinned Target |

Current examples:

- Campaigns:
  `benchmarks/hle-text-math/msa-population50-codex-terra-high/`
- Runtime:
  `environments/hle-text-math/msa-codex-terra-high-runtime.json`

### Mode and Budget

```json
{
  "controller_config": {
    "mode": "combined",
    "concurrency": { "n_branches": 2 },
    "budget": { "total_budget": 32, "beta": 0.5 },
    "peer_sharing": {
      "enabled": true,
      "log_path_template": "- Peer {peer_id}: {log_path}",
      "inject_position": "prompt_suffix"
    },
    "competition": {
      "enabled": true,
      "bonus_grant_unit": 1,
      "scoring_metric": "delta_score"
    }
  }
}
```

Single requires `n_branches=1`. Peer sharing is enabled only for
Mutualism/Combined; competition is enabled only for Competition/Combined.

### Models, concurrency, and timeout

```json
{
  "solver": {
    "initialConcurrency": 15,
    "taskTimeoutSeconds": 1800,
    "partitionTimeoutSeconds": 3600
  },
  "updater": {
    "backend": "codex-cli",
    "provider": "zcloud",
    "model": "gpt-5.6-terra",
    "reasoningEffort": "high"
  },
  "gateway": {
    "upstreamBaseUrl": "https://provider.example/v1",
    "requestTimeoutSeconds": 1800
  }
}
```

After changing a frozen field, use a new Campaign ID. Keep
`spec.solver.model/reasoningEffort` consistent with the runtime. Commit the
validation manifest and update its count/hash; validation and test IDs must be
disjoint. A real test stays sealed, while current HLE Math50 campaigns
explicitly disable test. Credentials are passed at runtime through an inherited
FD and must never enter config or Git.

## Run and outputs

```bash
npm test
node scripts/run-hle-population50-sequence.mjs
```

Cowork L1/L2:

```bash
npm run rsi -- experiment validate --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment preflight --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- runtime build --experiment experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment run --config experiments/cowork-skillsbench-dsh-l1.json --run-id <id>
npm run rsi -- experiment finalize --run .rsi/runs/<id>
```

`experiment run` reads only feedback/selection. `experiment finalize` unlocks
final once, after the Champion is frozen. The current 3/2/3 split is an
engineering end-to-end smoke set, not a statistical-significance claim.

For one campaign, call
`scripts/resume-hle-short-updater-root.mjs evolve start` with explicit config,
runtime, campaign ID, campaigns root, source root, and credential FD.

Each branch writes `public/state.json` and `public/evolution-log.jsonl`. A
closed population campaign reports every branch incumbent plus
`best-harness.json` and `best-harness.patch`.

More detail:

- [Controller modes](docs/controller-modes.md)
- [Architecture](docs/architecture.md)
- [HLE mutation workflow](docs/hle-mutation-workflow.zh.md)
- [Cowork L1/L2 workflow](docs/cowork-mvp.md)

Controller code is [MIT licensed](LICENSE). Vendored and submodule sources keep
their own licenses and notices.
