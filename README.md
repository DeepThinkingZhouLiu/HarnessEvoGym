# HarnessEvoGym

English | [中文](README.zh.md)

An executable Harness self-evolution platform that configures **what to evolve**,
**where to evaluate it**, and **how to search** as independent components. The
same trusted Controller can now combine an MSA Minimal Target with either a real
SkillsBench Cowork environment or a synthetic text-Reasoning connectivity
environment and run all five population modes.

The central composition is:

```text
Target × Environment × EvolutionRecipe
```

- A Target owns the Harness source, Candidate seed, runtime, validator, and mutable regions.
- An Environment owns tasks, workspaces, verifiers, and metrics.
- An EvolutionRecipe owns population coordination and per-round module search.
- The trusted Controller owns scheduling, leases, diff checks, evaluation, promotion, and rollback.

## System design

```text
Target Source + CandidateSeed -> Candidate Materializer -> H0 / Candidate
             |                                               |
             v                                               v
      MutationCatalog -> Module Search -> MutationLease -> Updater
                                                            |
Environment -> Task Workspace -> Solver --------------------+
      |                         |
      +-> Verifier -> EvaluationSummary -> Population -> promote / rollback
```

| Component            | Responsibility                                                        | Boundary                                      |
|----------------------|-----------------------------------------------------------------------|-----------------------------------------------|
| Target               | Composes Source, Seed, Materializer, Solver Driver, Validator, Catalog | Does not provide tasks or scores              |
| CandidateSeed        | Supplies the H0 prompt, profile, skills, and tool starting point       | Contains no benchmark answers or credentials  |
| Environment          | Supplies tasks, workspaces, verifiers, and rewards                     | Does not declare Candidate write permissions  |
| Population           | Coordinates branches, peer sharing, competitive budget, and ranking   | Consumes only generic projections and metrics |
| Module Search        | Selects Region IDs from the Target Catalog                             | Cannot return file paths                      |
| Updater              | Diagnoses feedback and edits a Candidate                              | Writes only its MutationLease                 |
| Solver               | Solves tasks through the Candidate Harness                            | Cannot read gold, sealed final, or real keys  |
| Controller / Gateway | Issues leases, audits diffs, evaluates, promotes, and enforces models  | Frozen trust root                             |

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

## Pluggable Targets, Environments, and Recipes

| Scenario / object             | Implemented composition                                      | Purpose                                      |
|-------------------------------|--------------------------------------------------------------|----------------------------------------------|
| Cowork                        | MSA Minimal + Cowork Seed + SkillsBench                      | Real Office/PDF/PPTX/XLSX tasks and verifier |
| Reasoning engineering smoke   | MSA Minimal + Reasoning Seed + synthetic text reasoning      | Real model/mutation/scoring/five-mode wiring |
| Production Reasoning          | MSA + HLE, or DSH + PutnamBench                              | Preserved HZY production path                |
| Future Target                 | DSH, PI Agent, or another Harness + its Seed/Catalog/Driver   | Add adapters without changing Population     |

Experiments with `spec.recipe` use the generic Population path. Old Cowork
experiments without a Recipe retain their single-Champion layout, while old HZY
Reasoning campaigns retain their production runtime. These are compatibility
paths, not separate new algorithms.

The Model Gateway gives Controller, Solver, and Updater different tokens,
overrides agent-supplied model/token-limit fields with the frozen Experiment
values, and meters Solver and Updater usage separately.

At Population startup, the Controller also computes one `configDigest` over the
expanded Experiment, Recipe, adapters, benchmark, policy, and Updater-prompt
digest. Every Branch must reproduce it before creating its run directory or
calling a model, then uses a private read-only prompt copy. Host-side changes
therefore fail closed instead of silently giving Branches different experiments.

L1/L2/L3 are now Target-owned risk layers, not aliases for DSH directories.
Every Target declares its own paths and semantic validator. The Controller
deterministically rechecks path allowlists, extensions, executable bits, file
limits, symlinks, and semantic constraints after every Updater session.

The platform separates the search space from the search algorithm. `mutationLevel`
is only the experiment's risk ceiling; Target-owned `MutationCatalog.regions`
describe the modules that can be searched. An old experiment without a
`strategy` field automatically uses `linear-hill-climb`, which selects every
region under the ceiling and therefore preserves the old writable set exactly.

## Turning MSA Minimal into different Solvers

The shared minimal Agent loop is committed at
[`sources/msa-minimal-harness/`](sources/msa-minimal-harness/README.md):

```text
task -> model -> optional <bash> -> observation -> model -> <final>
```

The Controller copies that pinned Source and overlays a Target-owned CandidateSeed:

| Target                  | CandidateSeed                       | H0 starting point                                  |
|-------------------------|-------------------------------------|----------------------------------------------------|
| `msa-minimal`           | `targets/msa-minimal/cowork-v1/`    | Cowork prompt, four Office skills, Chat Completions |
| `msa-minimal-reasoning` | `targets/msa-minimal/reasoning-v1/` | Math profile, Chat Completions, Reasoning CLI       |

Each Target owns its Mutation Catalog. MSA Cowork and MSA Reasoning may both
call a module “L1” while mapping it to different files. Controller, evaluator,
tasks/splits, gold, credentials, budgets, and promotion rules are always frozen.
Future PI Agent integration can declare entirely different regions without
changing the Population algorithm.

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

| Change                                  | File / field                                          |
|-----------------------------------------|-------------------------------------------------------|
| Harness source and pinned revision      | Target Adapter: `spec.source`                         |
| H0 prompt, skills, and tools            | Target Adapter: `spec.materialization.seedPath`       |
| Solver launch protocol                  | Target Adapter: `spec.solver.protocol/runtime`        |
| Mutable modules, dependencies, risk     | Target Adapter: `spec.mutation.catalog/levels`        |
| Tasks, workspaces, and verifier         | Environment Adapter                                   |
| Primary metric and promotion gates      | Benchmark + Evaluation Policy                         |
| Five modes, branches, budget, beta      | EvolutionRecipe: `spec.population`                    |
| Updater- or strategy-directed selection | EvolutionRecipe: `spec.moduleSearch.authority`        |
| Region-combination search algorithm     | SearchStrategy Adapter                                |
| Solver/Updater model and token limits   | Experiment: `spec.models`                             |
| MSA per-task Solver step limit          | Target Adapter: `spec.solver.runtime.maximumSteps`    |

Both smoke scenes reuse `recipes/population-smoke/*.yml` through:

- `experiments/cowork-msa-smoke-<mode>.json`
- `experiments/reasoning-msa-smoke-<mode>.json`
- `experiments/cowork-msa-smoke-l2-single.json` and
  `experiments/reasoning-msa-smoke-l2-single.json` exercise the L1+L2 lease and
  semantic-validation path for one generation only.

The Reasoning tasks are connectivity tests only. **They are not HLE and are not
a model-capability score.** Existing HLE/PutnamBench production campaigns remain
under `benchmarks/hle-text-math/` and `benchmarks/putnambench-lean/`.

The current `msa-minimal` Cowork adapter pins `maximumSteps` to `1` only to keep
real-model five-mode smoke tests inexpensive; raising Candidate `max_steps` does
not override it. A quality experiment should use a separate Target adapter with
an appropriate budget instead of interpreting smoke rewards as results. This is
a trusted hard cap for the current L1-only runs. If L2/L3 can mutate
`agent.py`/`run.py` and Candidates are treated as actively hostile, add a
per-Solver-session request quota at the Model Gateway as an additional boundary.

### Mode and Budget

```yaml
apiVersion: harness-rsi/v1alpha1
kind: EvolutionRecipe
spec:
  population:
    mode: combined
    concurrency: { n_branches: 2 }
    budget: { total_budget: 3, beta: 0.67 }
    peer_sharing: { enabled: true }
    competition: { enabled: true, bonus_grant_unit: 1 }
  moduleSearch:
    authority: strategy-directed
    riskCeiling: l1
    strategy: linear-hill-climb
```

Single requires `n_branches=1`. Peer sharing is enabled only for
Mutualism/Combined; competition is enabled only for Competition/Combined.

### Models and module search

An Experiment freezes Provider, model, and `maxTokens` separately for Solver
and Updater. `strategy-directed` asks a SearchStrategy to select Regions first;
`updater-directed` lets the Updater choose inside the risk ceiling from the Bad
Cases. Both paths still receive a Controller-issued MutationLease.

Credentials are injected only at runtime and must never enter an Experiment,
Adapter, Candidate, trace, or Git. Validation and sealed-final IDs must be
disjoint, and final data must never influence mutation, promotion, or stopping.

## Run and outputs

Validate the repository and all ten smoke compositions first:

```bash
npm run check
npm test
for scene in cowork reasoning; do
  for mode in single independent mutualism competition combined; do
    npm run rsi -- experiment validate \
      --config "experiments/${scene}-msa-smoke-${mode}.json"
  done
done
```

Real Cowork runs also require the SkillsBench checkout and runtime Provider
variables. Do not store the real key in shell history or the repository:

```bash
export RSI_SKILLSBENCH_ROOT=/absolute/path/to/skillsbench
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY && export RSI_PROVIDER_API_KEY

npm run rsi -- runtime build \
  --experiment experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment run \
  --config experiments/cowork-msa-smoke-single.json \
  --run-id cowork-single-smoke-001

unset RSI_PROVIDER_API_KEY
```

`experiment run` reads only feedback/selection while evolving. Generic
Population smoke runs currently do not unseal final; legacy single-Champion
Cowork runs retain one-time `experiment finalize`. These tiny datasets prove
engineering connectivity, not statistical significance.

The current generic Population boundary is explicit: infrastructure failures
become `PAUSED_INFRASTRUCTURE` and fail the command instead of masquerading as a
zero-score success, but cross-process resume is not yet exposed by the CLI. Use
a new run ID after fixing the fault. Gateway request limits are currently scoped
per Branch rather than being a Population-wide cost ceiling. Production
HLE/PutnamBench therefore keeps its existing recovery, sealed-test, and final
paths; the public smoke suite is not a substitute for a production benchmark.

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
