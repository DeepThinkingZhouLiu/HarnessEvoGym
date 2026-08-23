# Independent RSI Control-Plane Architecture

English | [中文](architecture.zh.md)

## Decision

DeepSeek Harness RSI uses an independent GitHub repository as its trusted control plane. It is no longer a DeepSeek Harness fork. The official project history enters only through the pinned `sources/deepseek-harness/` integration submodule, and an Updater never edits that directory directly. On `hzy_dev`, the submodule points to a development fork so the headless preset integration commit remains fetchable while retaining the official history.

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

The production PutnamBench campaign keeps mutable state outside the Git checkout. Repository, persistent root, and scratch root must be pairwise disjoint; the sealed-test subtree is never mounted into an untrusted phase. The default deployment uses:

```text
/mnt/data/hzy/dsh-rsi-runtime/
  campaigns/<campaign-id>/
    public/                 # resumable state, summaries, proposals, opaque receipts
    private/                # validation records, traces, and per-task checkpoints
    candidates/             # immutable baseline/candidate lineage
    sealed/test/            # test records; unreadable by Solver and Updater
    report/                 # emitted only after campaign closure
  runtimes/<campaign-id>/   # offline-built, frozen evaluation instances
  datasets/PutnamBench/     # pinned source and mathlib project
  trusted-baseline/         # prebuilt pinned Harness source
  pnpm-store/               # root-owned offline build inputs
  control/                  # attested runtime patch

/dev/shm/dsh-rsi/
  <campaign-id>/            # disposable Updater/evaluation workspaces
```

Candidate materialization uses a content copy of the pinned submodule rather than exposing its Git objects. The Updater sees only the active Candidate, validation feedback, proposal, and its phase-specific writable paths—not `.git`, the Controller repository, dataset, test manifest, sealed vault, credentials, or another Candidate. Evaluation mounts Candidate source read-only. Build, Solver, Updater, and verifier run under distinct host identities and bubblewrap mount namespaces; only the active gateway endpoint is admitted through a temporary UID/port firewall lease. The verifier has no network namespace.

## Mutation boundary

Prompt text alone cannot enforce scope. The complete boundary has three parts:

- Semantic guidance: the prompt explains the active level and prohibited changes.
- Write enforcement: only active-level paths are writable in the sandbox.
- Result enforcement: the Controller recomputes the diff and rejects scope violations, credentials, trust-root changes, or protocol breakage.

L1, L2, and L3 are Target Adapter semantics rather than universal directories. A DeepSeek Harness preset and a pi-agent strategy may live in different paths; the Controller understands only the selected level's validated allowlist.

## Feedback and generalization

A Feedback Packet contains aggregate metrics, representative successes and failures, trajectories, verifier outputs, cost, latency, and environment facts without prescribing a fixed causal taxonomy. The Updater infers the change from evidence across cases.

The implemented PutnamBench policy uses one adaptive validation partition and one operationally hidden test partition. Promotion is based exclusively on a strict increase in validation Lean-kernel verified count. Test is measured for every point but cannot affect promotion, rollback, retries, level changes, or stopping. A Candidate may affect task-solving behavior but never tasks, final scoring, resource accounting, or promotion rules.

## Benchmark and two-level evaluation

The production adapter targets PutnamBench-Lean. Its manifest pins the dataset, Lean, mathlib, Harness revision, model contract, and two whole-year partitions: 500 validation problems and 172 test problems. Validation score and traces are available to the next Updater session. The main Controller loads validation IDs only; a dedicated broker child alone opens and validates the test manifest and writes per-task results to the sealed vault. Before closure the parent receives only an opaque completion receipt.

The Solver proposes a replacement for the theorem proof. A separate trusted replay reconstructs that proof in the frozen source template and asks the pinned Lean kernel to compile it. It rejects placeholders, new axioms, changed statements, unsafe file types, and out-of-bound writes. Thus the model chooses mutations without a human-authored failure classifier while correctness remains objective.

The generic normalized-result and three-partition APIs remain available for adapter experiments, and the SWE-bench YAML is still a contract stub; it is not part of the implemented PutnamBench production path.

## Submodule update semantics

The superproject pins a DeepSeek Harness SHA, making every experiment reproducible. `git submodule update --remote` fetches an upstream revision locally; it becomes a trusted Source Revision only after the new submodule pointer is committed. Existing Candidates retain their original SHA.

## Implemented production path

The PutnamBench path now includes frozen manifests, exact source materialization, L1/L2/L3 diff enforcement, two-phase proposal/apply Updater sessions, offline Candidate builds, per-task checkpoints, validation feedback, child-only sealed-test execution, strict promotion and rollback, crash-safe campaign state, single-writer locking, implementation/runtime attestation, FD-only credentials, and post-closure JSON/CSV/Markdown/SVG reports. The next generalization milestone is a second fully implemented Environment Adapter; the existing SWE-bench files alone do not claim that milestone.
