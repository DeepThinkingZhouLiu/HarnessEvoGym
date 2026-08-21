# DeepSeek Harness RSI

English | [中文](README.zh.md)

**An adapter-based recursive self-improvement control plane for coding agents, with DeepSeek Harness as the first Solver and Updater runtime.**

> [!IMPORTANT]
> The repository now has the independent control-plane layout, upstream submodule, and adapter/isolation contracts. The executable Controller loop is not implemented yet; this document defines intended system boundaries rather than claiming unattended self-evolution today.

## Why this is no longer a DeepSeek Harness fork

An RSI system must control source instances, Updaters, task environments, external evaluation, candidate lineage, and rollback. Keeping all of that inside a DeepSeek Harness fork mixes the system being optimized with the system judging it and makes other coding agents unnecessarily difficult to integrate.

The relationship is now:

```text
DeepSeek-Harness-RSI (independent trusted control plane)
  -> sources/deepseek-harness (read-only Git submodule of the official repo)
  -> .rsi/instances/... (Baseline and Candidate instances materialized by Controller)
  -> Updater edits one Candidate, never the source submodule
```

This preserves explicit upstream updates while allowing the same Controller to integrate other Solvers and Updaters through adapters.

## Core loop

```mermaid
flowchart LR
  ENV["Environment<br/>Tasks and feedback"] --> BASE["Baseline Solver<br/>Baseline instance"]
  ENV --> CAND["Candidate Solver<br/>Candidate instance"]
  BASE --> FEEDBACK["Feedback Packet<br/>Outcomes · trajectories · bad cases · cost"]
  FEEDBACK --> UPDATER["Updater Coding Agent<br/>Analyze + hypothesize + edit"]
  UPDATER --> CAND
  BASE --> EVAL["Frozen Evaluator"]
  CAND --> EVAL
  EVAL --> DECISION{"Keep improvement?"}
  DECISION -->|yes| PROMOTE["Promote<br/>Register new Baseline"]
  DECISION -->|no| REJECT["Reject / Rollback"]
  PROMOTE --> ENV
```

**The Updater is not a collection of fixed diagnosis modules.** It is one coding-agent session that reads code and a batch of failure evidence, forms a hypothesis, and edits the candidate. The Controller handles deterministic materialization, permissions, execution, collection, evaluation, and promotion; it does not replace open-ended diagnosis with a fixed taxonomy.

## Mutation levels

| Level          | Writable in this run                                      | Isolation                         |
|----------------|-----------------------------------------------------------|-----------------------------------|
| L1 strategy    | Presets, prompts, personas, skills, tool descriptions     | Path allowlist; fast experiments  |
| L2 behavior    | Middleware, hooks, memory/router, workflows, tools/plugins | Isolated Candidate build and run |
| L3 Solver core | Agent loop, session/context, registries, adapters          | Full instance and regression isolation |
| External trust root | **Never writable at any level**                      | Separate process and storage      |

The Controller chooses one level per run. Prompt instructions explain the scope, while two enforcement gates provide the actual boundary: only allowed paths are writable in the Updater sandbox, and the Controller rejects any out-of-scope final diff.

## Repository layout

```text
.
├── controller/                 # Trusted orchestration contract and future implementation
├── adapters/
│   ├── targets/                # Solver source, launch protocol, and L1/L2/L3 paths
│   └── updaters/               # Coding-agent runtime used for an Updater session
├── environments/              # Task, trajectory, and evaluation environment protocol
├── prompts/                    # Shared high-level Updater instruction
├── sources/
│   └── deepseek-harness/       # Official read-only Git submodule
├── docs/                       # Architecture and design documents
└── .rsi/                       # Local instances, feedback, artifacts, and lineage; ignored
```

## Source and instance isolation

- `sources/deepseek-harness/` stores the trusted, pinned upstream source revision.
- The Controller materializes separate Baseline and Candidate worktrees from that revision.
- The Updater may read the Candidate, but only active-level paths are writable; Controller Git metadata is not exposed.
- Baseline and Candidate run paired tasks with the same model, budgets, and seeds.
- Hidden tasks and final rubrics never enter the feedback packet, and self-reported candidate scores cannot promote a revision.
- Only the Controller can register a Candidate, advance the baseline pointer, or roll back.

See the [architecture document](docs/architecture.md) for the complete decision and runtime layout.

## Clone

```bash
git clone --recurse-submodules https://github.com/DeepThinkingZhouLiu/Deepseek-Harness-RSI.git
cd Deepseek-Harness-RSI
git submodule update --init --recursive
```

## Pull an upstream DeepSeek Harness update

```bash
git submodule update --remote sources/deepseek-harness
git add sources/deepseek-harness
git commit -m "chore: update DeepSeek Harness submodule"
```

The submodule is configured to follow upstream `master`, while the superproject always records a concrete SHA for reproducible experiments.

## Next steps

- Define and validate Target, Updater, and Environment Adapter schemas.
- Implement Candidate materialization, sandbox mounts, and final diff allowlist checks.
- Complete the minimal `task -> feedback -> Updater -> Candidate -> paired evaluation -> decision` loop.
- Start with DeepSeek Harness L1 experiments, then L2; enable L3 only after isolation and rollback are reliable.
- Add a pi-agent adapter to verify that the Controller is genuinely agent-agnostic.

## Upstream and license

This is not an official DeepSeek project. `sources/deepseek-harness/` comes from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and retains its own history and license. Controller, adapter, and documentation work in this repository is available under the [MIT License](LICENSE).
