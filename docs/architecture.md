# Independent RSI Control-Plane Architecture

English | [中文](architecture.zh.md)

## Decision

DeepSeek Harness RSI uses an independent GitHub repository as its trusted control plane. It is no longer a DeepSeek Harness fork. The official project history enters only through the pinned `sources/deepseek-harness/` integration submodule, and an Updater never edits that directory directly. The current development revision carries a reviewed headless preset integration commit on top of official history; `.gitmodules` still uses the official upstream, and any later update must preserve or replace that fix.

This separates the mutable Solver from the immutable evaluation root and allows projects such as DeepSeek Harness and pi-agent to become Targets or Updaters through adapters without changing the Controller loop.

## Five objects

| Object     | Responsibility                                                  | Updater-writable |
|------------|-----------------------------------------------------------------|------------------|
| Source     | Trusted, pinned upstream source revision                        | No               |
| Solver     | Performs tasks in an environment                               | Candidate only   |
| Updater    | Reads evidence and code, then analyzes and edits in one session | Not its runtime  |
| Controller | Materialization, permissions, scheduling, diff validation, lineage, promotion, rollback | No |
| Evaluator  | Frozen tasks, rubrics, cost, and safety gates                   | No               |

The Updater does not require fixed failure-analyzer, proposal, builder, or search-policy services. It reasons freely in one context; the Controller consumes structured evidence, a source diff, and a Mutation Report.

## One evolution round

```text
pin Source Revision
-> materialize Baseline and Candidate instances
-> run Baseline training tasks and produce an objective Feedback Packet
-> Controller selects L1, L2, or L3
-> launch one isolated Updater session
-> Updater analyzes a batch and edits Candidate
-> Controller rejects out-of-scope diffs and builds Candidate
-> run paired training, replay, and hidden evaluation
-> frozen gates choose Reject, Revise, or Promote
-> persist immutable Candidate, parent, results, and decision rationale
```

## Runtime layout

All mutable state lives under ignored `.rsi/` storage:

```text
.rsi/
  runs/<run-id>/
    input/
      feedback-packet.json
      mutation-policy.json
    baseline/
      workspace/
    candidates/<candidate-id>/
      workspace/
      mutation-report.json
      diff.patch
      evaluation.json
    decision.json
  registry/
    candidates.jsonl
```

The Controller may use the submodule Git objects to create worktrees, but the Updater container sees only Candidate file mounts, not `.git` or the Controller Gitdir. Baseline is read-only, and all Candidate paths outside the active allowlist are read-only.

## Mutation boundary

Prompt text alone cannot enforce scope. The complete boundary has three parts:

- Semantic guidance: the prompt explains the active level and prohibited changes.
- Write enforcement: only active-level paths are writable in the sandbox.
- Result enforcement: the Controller recomputes the diff and rejects scope violations, credentials, trust-root changes, or protocol breakage.

L1, L2, and L3 are Target Adapter semantics rather than universal directories. A DeepSeek Harness preset and a pi-agent strategy may live in different paths; the Controller understands only the selected level's validated allowlist.

## Feedback and generalization

A Feedback Packet contains aggregate metrics, representative successes and failures, trajectories, verifier outputs, cost, latency, and environment facts without prescribing a fixed causal taxonomy. The Updater infers the change from evidence across cases.

Promotion checks at least training improvement, held-out improvement, historical replay tolerance, cost/latency budgets, and safety against privilege changes, cross-task contamination, and irreversible effects. A Candidate may affect task-solving behavior but never tasks, final scoring, resource accounting, or promotion rules.

## Benchmark and two-level evaluation

A Task Evaluator decides whether one task is resolved; for SWE-bench, the official harness applies a Solver patch and runs tests. The RSI Evaluator consumes normalized per-instance results, compares Baseline and Candidate on the same instances and budgets, and applies quality, regression, cost, and safety gates.

The Benchmark manifest pins a dataset revision and three disjoint partitions: `feedback`, `selection`, and `final`. Feedback may expose detailed bad cases, selection is used for in-loop Candidate choice, and final remains sealed until the Final Candidate is locked. Reusing final every generation turns it into validation data.

`controller/src/cli.mjs` now implements manifest validation, normalized result validation, paired metrics, bootstrap intervals, Evolution Ledger accounting, and gates. The official SWE-bench Runner/Normalizer remains an Environment Adapter integration.

## Submodule update semantics

The superproject pins a DeepSeek Harness SHA, making every experiment reproducible. `git submodule update --remote` fetches an upstream revision locally; it becomes a trusted Source Revision only after the new submodule pointer is committed. Existing Candidates retain their original SHA.

## Implementation order

1. Benchmark manifest, normalized Solver Result, paired metrics, and Evaluation Policy. (Initial version available.)
2. SWE-bench Runner/Normalizer and a pinned 100-instance manifest.
3. Adapter schemas and static validation.
4. Source revision and Candidate materialization.
5. L1 writable mounts and final diff validation.
6. Feedback Packet and one Updater session.
7. Immutable registry, L2 sandbox, and rollback.
8. L3 full-instance isolation.
9. A second agent Target to test adapter generalization.
