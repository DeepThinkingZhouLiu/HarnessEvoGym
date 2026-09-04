# Independent RSI Control-Plane Architecture

English | [中文](architecture.zh.md)

## Decision

DeepSeek Harness RSI uses an independent GitHub repository as its trusted control plane. It is no longer a DeepSeek Harness fork. The official project history enters only through the pinned `sources/deepseek-harness/` integration submodule, and an Updater never edits that directory directly. The current development revision carries a reviewed headless preset integration commit on top of official history; `.gitmodules` still uses the official upstream, and any later update must preserve or replace that fix.

This separates the mutable Solver from the immutable evaluation root and allows projects such as DeepSeek Harness and pi-agent to become Targets or Updaters through adapters without changing the Controller loop.

## Six objects

| Object     | Responsibility                                                  | Updater-writable |
|------------|-----------------------------------------------------------------|------------------|
| Source     | Trusted, pinned upstream source revision                        | No               |
| Solver     | Performs tasks in an environment                               | Candidate only   |
| Updater    | Reads evidence and code, then analyzes and edits in one session | Not its runtime  |
| Controller | Materialization, permissions, scheduling, diff validation, lineage, promotion, rollback | No |
| Evaluator  | Frozen tasks, rubrics, cost, and safety gates                   | No               |
| Model Provider | Shared upstream protocol, credential environment names, compatibility, and model catalog | No |

The Updater does not require fixed failure-analyzer, proposal, builder, or search-policy services. It reasons freely in one context; the Controller consumes structured evidence, a source diff, and a Mutation Report.

## One evolution round

```text
pin Controller/Source revisions and H0 overlay
-> run the current champion on feedback tasks
-> Controller selects L1 or L2
-> launch one isolated Updater session
-> Updater analyzes a batch and edits Candidate
-> Controller rescans the complete tree and rejects out-of-scope diffs
-> run Champion/Candidate paired selection evaluation
-> frozen gates choose Reject or Promote
-> consume one final-evaluation attempt after locking the champion
-> persist immutable Candidate, parent, results, and decision rationale
```

## Runtime layout

All mutable state lives under ignored `.rsi/` storage:

```text
.rsi/
  runs/<run-id>/
    state.json
    final-attempt.json
    experiment.snapshot.json
    mutation-policy.json
    generations/<generation-id>/
      feedback-packet.json
      decision.json
    candidates/<candidate-id>/
      workspace/
      manifest.json
      mutation-report.json
      mutation-diff.json
      evaluation.json
    results/
    trials/
    final-evaluation.json
  registry/
    candidates.jsonl
```

L1/L2 candidates are project-owned preset overlays, not full DSH worktrees. The Updater sees only a disposable writable overlay, read-only upstream source, and read-only feedback; it never receives the repository, benchmark, verifier, or Gitdir. Docker cannot make files writable by extension, so the post-session full-tree Diff Guard enforces exact path, extension, executable-bit, and size policy. Both files and empty directories contribute to the tree digest; no-op and empty-directory-only proposals never reach selection. Trust roots are never in a writable mount, and H0/champion are never the Updater target.

## Mutation boundary

Prompt text alone cannot enforce scope. The complete boundary has three parts:

- Semantic guidance: the prompt explains the active level and prohibited changes.
- Instance enforcement: only the disposable candidate overlay is writable; trust roots are absent.
- Result enforcement: the Controller recomputes the diff and rejects scope violations, credentials, trust-root changes, or protocol breakage.

L1, L2, and L3 are Target Adapter semantics rather than universal directories. A DeepSeek Harness preset and a pi-agent strategy may live in different paths; the Controller understands only the selected level's validated allowlist.

Network access is part of the enforced boundary. Solver and Updater join a fresh Docker internal network for each run and receive only an internal URL plus ephemeral token. A minimal Model Gateway alone holds the real provider key and restricts forwarding to the fixed upstream `POST /chat/completions` endpoint plus run-level request/concurrency budgets. L2 scripts therefore have no direct external route.

The Model Provider Adapter is the agent-independent connection contract. It declares the upstream protocol, credential environment names, compatibility flags, and model catalog, while the Experiment independently selects Solver and Updater models. The DSH runtime translates this contract into `llm-pi-ai` settings; a future pi-agent runtime translates it into its native configuration. Changing agents therefore does not duplicate API-key configuration, and changing models does not modify Controller core logic.

## Feedback and generalization

The current Feedback Packet contains feedback-task instructions, aggregate metrics, per-case rewards, Solver final answers, verifier outputs, runtime errors, bounded artifacts, token usage, and latency without prescribing a fixed causal taxonomy. The Updater infers the change from evidence across cases. The Model Gateway measures streamed token usage per session; full per-tool DSH trajectories and trusted dollar cost are not wired, and the system does not fabricate them.

A formal system should check training improvement, held-out improvement, historical replay tolerance, cost/latency budgets, and safety against privilege changes, cross-task contamination, and irreversible effects. A Candidate may affect task-solving behavior but never tasks, final scoring, resource accounting, or promotion rules.

The current eight-task POC enforces paired selection gain, zero reward regressions, completion, and safety gates. Its fixed selection set is replayed every generation, but it has no separate historical task pool. A token-growth gate is available; dollar-cost gates stay disabled without a trusted rate card. Final is a one-attempt report after champion lock and never participates in promotion.

## Benchmark and two-level evaluation

A Task Evaluator decides whether one task is resolved; for SWE-bench, the official harness applies a Solver patch and runs tests. The RSI Evaluator consumes normalized per-instance results, compares Baseline and Candidate on the same instances and budgets, and applies quality, regression, cost, and safety gates.

The Benchmark manifest pins a dataset revision and three disjoint partitions: `feedback`, `selection`, and `final`. Feedback may expose detailed bad cases, selection is used for in-loop Candidate choice, and final remains sealed until the Final Candidate is locked. Reusing final every generation turns it into validation data.

`controller/src/cli.mjs` now implements adapter/manifest validation, candidate materialization, source-built Docker DSH Solver/Updater, SkillsBench Runner/Verifier, a continuous `[0,1]` reward protocol, paired metrics, bootstrap intervals, lineage, promotion/rollback, and one-time finalization. The eight selected upstream verifiers currently return binary 0/1. SWE-bench remains a separate future Environment Adapter.

## Submodule update semantics

The superproject pins a DeepSeek Harness SHA, making every experiment reproducible. `git submodule update --remote` fetches an upstream revision locally; it becomes a trusted Source Revision only after the new submodule pointer is committed. Existing Candidates retain their original SHA.

## Current boundary

The Cowork SkillsBench L1/L2 MVP is implemented; L3 is closed. The 3/2/3 split is a pipeline POC and DSH sampling seeds are recorded but not guaranteed deterministic. The restricted gateway now measures complete streamed token usage, while provider pricing remains unconfigured. Formal experiments still need an outer DNS/IP policy, larger frozen splits, repeated trials, pinned image/verifier supply chains, and trusted price accounting. A second agent target and another environment are the next generality tests.
