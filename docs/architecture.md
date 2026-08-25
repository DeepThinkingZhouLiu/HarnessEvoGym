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

The Updater does not require fixed failure-analyzer, proposal, builder, or search-policy services. It reasons, edits, checks, and commits in one context; the Controller consumes the resulting Git commit and objective validation result.

## One evolution round

```text
pin Source Revision
-> materialize Baseline and Candidate instances
-> run Baseline training tasks and produce an objective Feedback Packet
-> give the Updater the Target's configured L1/L2/L3 catalogue
-> launch one isolated Updater session
-> Updater analyzes evidence, chooses the smallest sufficient layer, edits, and commits
-> Controller checks commit shape and configured path scope, then builds Candidate
-> run paired training, replay, and hidden evaluation
-> frozen gates choose Reject, Revise, or Promote
-> persist immutable Candidate, parent, results, and decision rationale
```

## Runtime layout

The production PutnamBench campaign keeps mutable state outside the Git checkout. Repository, persistent root, and scratch root must be pairwise disjoint; the sealed-test subtree is never mounted into an untrusted phase. The default deployment uses:

```text
/mnt/data/hzy/03_dsh_rsi/dsh-rsi-runtime/
  campaigns/<campaign-id>/
    public/                 # resumable state, summaries, proposals, opaque receipts
    private/                # validation records, traces, and per-task checkpoints
    candidates/             # immutable baseline/candidate lineage
    sealed/test/            # test records; unreadable by Solver and Updater
    report/                 # emitted only after campaign closure
  runtimes/<campaign-id>/   # trusted aliases for frozen evaluation instances
  runtime-cache/v1/<sha256>/ # attested, content-addressed frozen builds
  datasets/PutnamBench/     # pinned source and mathlib project
  trusted-baseline/         # prebuilt pinned Harness source
  pnpm-store/               # root-owned offline build inputs
  control/                  # attested runtime patch

/mnt/data/hzy/03_dsh_rsi/s/
  <campaign-id>/            # disposable Updater/evaluation workspaces
```

Campaign runtime paths are trusted read-only aliases into the shared cache. The
cache key binds the Candidate source digest, benchmark, pinned Node/pnpm
versions, build recipe, OS, and architecture. A hit validates the frozen
attestation and critical launch closure before use; a mismatch fails closed.
Only a miss traverses the immutable dependency store and performs the offline
install/build/freeze sequence.

Infrastructure retries are phase-local: Solver and verifier each receive the
frozen retry allowance, so a recovered Solver request cannot consume the
verifier's allowance. Retries use exponential backoff with jitter. The gateway
also normalizes the provider's explicit HTTP 400 `upstream_error` marker into a
non-sensitive infrastructure audit classification while leaving ordinary 400
Candidate request failures unchanged.

The lightweight linear path creates one campaign-owned Git worktree and a separate Git metadata directory once, then reuses both across rounds. The Updater sees only that Candidate plus validation feedback and the append-only evolution log—not the Controller repository, dataset, test manifest, sealed vault, credentials, or another Candidate. Evaluation mounts Candidate source read-only. Build, Solver, Updater, and verifier run under distinct host identities and bubblewrap mount namespaces; the current HLE path reaches its credential-hiding gateway through a Unix-socket relay while keeping the Solver and Updater network namespaces isolated.

## Mutation boundary

L1, L2, and L3 are soft search categories whose descriptions and paths belong to the Target runtime configuration. In `updater-soft` mode the complete catalogue is inserted into every Updater prompt. The Updater is guided to start with the smallest plausible L1 change and expand to L2/L3 only when validation evidence indicates diminishing returns or a deeper mechanism.

- Semantic guidance: the prompt explains all three layers, cumulative writable paths, and prohibited changes.
- Self-declaration: the one allowed commit uses `rsi(l1|l2|l3): ...` to record the chosen layer and direction.
- Lightweight result enforcement: the Controller requires one descendant commit, a clean worktree, a known declared layer, and changed paths within that layer and outside permanent forbidden paths.

The Controller does not select a layer, count three misses, or automatically advance levels in this mode. It retains a commit only for a strict validation improvement and otherwise resets the same worktree to the incumbent. An Updater may explicitly stop an unbounded campaign when no evidence-backed mutation remains. The legacy `controller-sequential` mode remains available for frozen historical campaign definitions.

L1, L2, and L3 are Target Adapter semantics rather than universal directories. A DeepSeek Harness preset and an MSA-derived math Harness live at different paths; the Controller understands only the normalized configured allowlist.

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

The control plane now includes frozen manifests, exact source materialization, configurable L1/L2/L3 diff enforcement, one-session Git mutations, Candidate builds, per-task checkpoints, validation feedback, child-only sealed-test execution, strict promotion and rollback, crash-safe campaign state, single-writer locking, implementation/runtime attestation, FD-only credentials, and post-closure JSON/CSV/Markdown/SVG reports. The MSA-derived minimal Target provides the lightweight math/reasoning path; the existing SWE-bench files remain a contract stub rather than a completed production adapter.
