<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/harness-evo-gym-hero.png" />
    <img src="docs/assets/harness-evo-gym-loop.gif" width="100%" alt="HarnessEvoGym composes a Target, Environment, and Evolution Recipe into a trusted self-evolution loop." />
  </picture>
</p>

<h1 align="center">HarnessEvoGym</h1>

<p align="center">
  <strong>A trusted, reproducible gym for evolving agent harnesses—not just their prompts.</strong>
</p>

<p align="center">
  <a href="README.zh.md">中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributor guide</a>
</p>

<p align="center">
  <img alt="status research preview" src="https://img.shields.io/badge/status-research_preview-f4a261?style=flat-square" />
  <img alt="license MIT" src="https://img.shields.io/badge/controller_license-MIT-4c8bf5?style=flat-square" />
  <img alt="population modes five" src="https://img.shields.io/badge/population_modes-5-8b5cf6?style=flat-square" />
  <img alt="tests 413 passing" src="https://img.shields.io/badge/tests-413_passing-20a36a?style=flat-square" />
</p>

HarnessEvoGym turns harness self-improvement into an experiment you can inspect:
choose **what evolves**, **where it works**, and **how evolution searches** as
independent components, while a frozen Controller owns permissions, evaluation,
promotion, rollback, and lineage.

~~~
Target × Environment × EvolutionRecipe
~~~

This separation lets the same population algorithm evolve an MSA Minimal Cowork
agent on real Office tasks, exercise a Reasoning pipeline, or accept a new
Harness and Benchmark through adapters—without moving the evaluator into the
mutable system.

## Why this exists

Letting a coding agent edit itself is easy. Knowing whether the new version is
actually better is the hard part. A useful RSI loop must stop the evolving agent
from changing its judge, leaking hidden tasks, writing outside the selected
module, or promoting a noisy tie.

HarnessEvoGym makes those boundaries executable:

| Concern                | HarnessEvoGym answer                                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| **What may change?**   | Target-owned Mutation Regions, translated into a one-round hard lease  |
| **Who may change it?** | A pluggable Updater such as Codex CLI or DeepSeek Harness               |
| **What proves value?** | Environment-owned tasks, verifier, metrics, and strict promotion gates |
| **How is it searched?**| Population topology + an independent module SearchStrategy             |
| **What stays trusted?**| Controller, Gateway, evaluator, split, credentials, and final set      |

## The model

| Layer                | Owns                                                                    | Does not own                         |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| **Target**           | Harness source, H0 seed, runtime, validator, and mutable Region catalog | Tasks, scores, or promotion rules    |
| **Environment**      | Tasks, isolated workspace, verifier, and metrics                        | Candidate write permissions          |
| **Evolution Recipe** | Population mode, branches, budget, sharing, and module search           | Harness-specific file paths          |
| **Controller**       | Scheduling, MutationLease, Diff Guard, lineage, promotion, and rollback | A mutable solution strategy           |

One Candidate generation follows:

~~~
Champion
  -> SearchStrategy selects Target Region IDs
  -> Controller issues a MutationLease
  -> Updater diagnoses failures and edits one Candidate
  -> Controller recomputes and validates the full diff
  -> Solver runs feedback + selection tasks
  -> strict gates promote the Candidate, or retain the Champion
~~~

The prompt tells the Updater *why* and *how* to improve. The MutationLease,
semantic validator, and Diff Guard enforce *where* it can write.

## What works today

| Capability              | Implemented                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| Harness Targets         | MSA Minimal Cowork, MSA Minimal Reasoning, DeepSeek Harness path   |
| Updaters                | Isolated Codex CLI 0.149.1 and DeepSeek Harness                    |
| Environments            | OmegaUse-OfficeVal, synthetic text Reasoning, HLE/Putnam paths     |
| Population topologies   | Single, Independent, Mutualism, Competition, Combined              |
| Module search           | Linear hill climb, progressive risk expansion, Docker strategy API |
| Mutable risk ceilings   | Target-defined L1/L2/L3 with different files for every Harness     |
| Reliability             | Provider retries, per-task checkpoints, explicit Resume, sealed Final |

The real Cowork path uses
[OmegaUse-OfficeVal](https://github.com/baidu-frontier-research/OmegaUse-OfficeVal).
Of 100 upstream tasks, 91 have a registered Linux path:
**55 feedback/train + 18 selection/validation + 18 one-time sealed final**.
The Solver receives only the task and original Office inputs; scoring runs
offline in a separate read-only verifier container.

Synthetic text Reasoning is a connectivity test, not an HLE score. PI Agent
files are adapter examples, not a completed integration. See
[current boundaries](docs/architecture.md#implemented-paths-and-current-boundary) before reporting results.

## Five population modes

| Mode              | Branch behavior                                             |
| ----------------- | ----------------------------------------------------------- |
| `single`          | One Branch receives the entire Candidate budget             |
| `independent`     | Multiple Branches search without sharing history            |
| `mutualism`       | Independent search plus read-only peer evolution evidence   |
| `competition`     | Branches compete for an additional Candidate budget pool    |
| `combined`        | Peer evidence sharing plus budget competition               |

Population mode and module search are orthogonal. For example,
`combined + linear-hill-climb` and
`combined + progressive-risk-expansion` are both valid recipes.

## Quick start

Requirements: Linux, Docker, Node.js 20+, npm, and Git.

~~~bash
git clone https://github.com/DeepThinkingZhouLiu/HarnessEvoGym.git
cd HarnessEvoGym
npm ci
npm run check
npm test
~~~

Validate a complete composition without calling a model:

~~~bash
npm run rsi -- experiment validate \
  --config experiments/reasoning-msa-progressive-strict-smoke.json
~~~

Real runs inject credentials only at runtime:

~~~bash
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY
export RSI_PROVIDER_API_KEY

npm run rsi -- runtime build \
  --experiment experiments/reasoning-msa-progressive-strict-smoke.json
npm run rsi -- experiment run \
  --config experiments/reasoning-msa-progressive-strict-smoke.json \
  --run-id reasoning-progressive-001

unset RSI_PROVIDER_API_KEY
~~~

Never write a real key into an Experiment, Adapter, Candidate, trace, or Git.
For OfficeVal dataset setup, task images, Resume, and sealed Final, use the
[Cowork runbook](docs/cowork-mvp.md).

## Registered five-mode Cowork suite

The repository includes a fixed formal training configuration:

| Setting                 | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| Target / Solver         | MSA Minimal Cowork, full 12-step runtime                  |
| Updater                 | Isolated Codex CLI 0.149.1                                |
| Solver + Updater model  | `gpt-5.6-terra`, high reasoning, 8192 output tokens       |
| Search space            | L1 prompt/skills + L2 agent loop/tool runtime             |
| Search strategy         | `linear-hill-climb`                                       |
| Candidate budget        | 32 per Mode                                               |
| Branches                | Single = 1; the other four Modes = 2                      |
| Suite concurrency       | Up to 2 Modes; up to 2 Office tasks per Branch            |
| Data                    | 55 feedback + 18 selection; sealed final remains unopened |
| Seed / trials           | One preregistered seed, one trial per task                |

The five Experiments live under
[`experiments/cowork-msa-rsi-formal32-codex-*.json`](experiments/), and the
auditable runner is
[`scripts/run-cowork-formal32-five-mode.mjs`](scripts/run-cowork-formal32-five-mode.mjs).

~~~bash
export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
export RSI_SUITE_MAX_CONCURRENT_MODES=2

node scripts/run-cowork-formal32-five-mode.mjs
~~~

This is a complete RSI configuration, not yet a publication-grade statistical
claim. A formal comparison should preregister multiple seeds/trials and report
reward, Solver/Updater tokens, wall time, infrastructure failures, and the
one-time sealed-final result.

## Build your own composition

- Add a **Target** when you want to evolve a new Harness. Define its Source,
  CandidateSeed, Solver Driver, semantic Validator, and Mutation Catalog.
- Add an **Environment** when you want a new task domain. Define task
  materialization, isolation, verifier, Result protocol, split, and metric.
- Add a **SearchStrategy** when you want a new Region-selection algorithm. It
  may return Region IDs, never file paths or credentials.
- Add an **EvolutionRecipe** when you want to recombine an existing population
  topology, branch count, budget, sharing rule, and search strategy.

The full file map, protocols, extension checklist, and test matrix are in the
[Contributor guide](CONTRIBUTING.md).

## Trust and reproducibility

- Controller, Gateway, evaluator, hidden split, credentials, and promotion
  policy are outside the Candidate write set.
- Target Source, CandidateSeed, Updater distribution, Benchmark source, and
  expanded Experiment bundle are content-addressed or revision-pinned.
- Solver, Updater, verifier, and external SearchStrategy run with distinct
  isolation and least-privilege mounts.
- A Provider or verifier failure pauses the experiment instead of becoming a
  fake zero score. Resume reuses atomically committed per-task results.
- Sealed Final is unavailable during evolution and may be opened only once
  after the global best Candidate is locked.

## Documentation

| If you want to…                  | Read                                                     |
| -------------------------------- | -------------------------------------------------------- |
| Understand the trust boundaries  | [Architecture](docs/architecture.md)                     |
| Understand Mode and Branch       | [Controller modes](docs/controller-modes.md)             |
| Understand Region search         | [Search strategy](docs/search-strategy.md)               |
| Run the Cowork experiment        | [OmegaUse Cowork runbook](docs/cowork-mvp.md)            |
| Extend or review the platform    | [Contributor guide](CONTRIBUTING.md)                     |

The Controller is [MIT licensed](LICENSE). Vendored and submodule Sources keep
their own licenses and notices.
