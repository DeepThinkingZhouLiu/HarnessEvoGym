# DeepSeek Harness RSI

English | [中文](README.zh.md)

An executable platform for evolving agent Harnesses on frozen validation tasks.
The same trusted Controller repository now supports both **Reasoning** and
**Cowork**: the Future branch population Controller is the base, while the
SkillsBench, DSH overlay, reward evaluation, and Docker isolation from `lz-dev`
are integrated as the Cowork increment.

## System design

```text
Target MutationCatalog -> SearchStrategy -> MutationPlan
          |                                    |
          |                                    v
Frozen tasks -> Candidate Solver <- Controller MutationLease <- Updater
                    |              |
                    v              v
            validation evidence -> frozen gates -> promote/reset
```

| Component | Responsibility | Boundary |
|---|---|---|
| Target | Declares the Harness baseline, evolvable regions, and L1/L2/L3 risk ceiling | Does not score |
| SearchStrategy | Selects a parent and region IDs | Cannot return paths or edit code |
| Updater | Diagnoses feedback and edits one Candidate inside its lease | Only lease paths are writable |
| Solver | Solves tasks with the Candidate Harness | Cannot read gold/final/credentials |
| Controller | Materialization, leases, scheduling, diff validation, evaluation, lineage, promotion/reset | Never Candidate-writable |
| Evaluator/Gateway | Frozen score and model identity; credential isolation | Outside the Candidate |

One evolution round is:

```text
incumbent
  -> SearchStrategy selects a parent and region IDs from the Target catalog
  -> Controller validates risk/dependencies/conflicts and issues a one-round lease
  -> Updater reads source + validation feedback + history and applies one falsifiable change
  -> Controller recomputes the complete diff instead of trusting self-reporting
  -> Candidate runs validation
  -> frozen gates pass: promote; otherwise: retain the incumbent
```

SearchStrategy controls where to search. The Updater remains a complete coding
agent that diagnoses, proposes, edits, and checks in one session. The Controller
does not hard-code causal analysis; it enforces permissions and objective gates.

## Two scenario execution planes

| Scenario | CLI | Target / environment | Current algorithm |
|---|---|---|---|
| Reasoning | `campaign ...` / `evolve ...` | Minimal Harness + HLE, or DSH + PutnamBench | Future `single/independent/mutualism/competition/combined` population modes |
| Cowork | `experiment ...` | DSH `cowork-rsi` overlay + SkillsBench | Pluggable SearchStrategy; the default preserves linear Champion evolution |

Both planes share Benchmark, Policy, Solver Result, and Evaluator protocols,
but preserve their proven environment isolation. Reasoning uses host identities,
bubblewrap, and a sealed broker. Cowork uses task Docker images, a separate
Verifier, and a Model Gateway that gives agents only one-time tokens.

Cowork currently exposes L1 and L2. L1 changes declarative presets, prompts,
and Skill documents; L2 also allows Skill scripts. L3 remains disabled. The
Controller deterministically rechecks path allowlists, extensions, executable
bits, file limits, symlinks, and Cordis plugins after every Updater session.

Cowork now separates the search space from the search algorithm. `mutationLevel`
is only the experiment's risk ceiling; Target-owned `MutationCatalog.regions`
describe the modules that can be searched. An old experiment without a
`strategy` field automatically uses `linear-hill-climb`, which selects every
region under the ceiling and therefore preserves the old writable set exactly.

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
| Cowork search algorithm | Experiment: `spec.adapters.strategy` |
| Cowork searchable modules | Target Adapter: `spec.mutation.catalog.regions` |
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
- [Search space, strategy, and compatibility](docs/search-strategy.md)
- [HLE mutation workflow](docs/hle-mutation-workflow.zh.md)
- [Cowork L1/L2 workflow](docs/cowork-mvp.md)

Controller code is [MIT licensed](LICENSE). Vendored and submodule sources keep
their own licenses and notices.
