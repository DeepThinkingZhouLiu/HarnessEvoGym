# PutnamBench-Lean Harness RSI Experiment Protocol

English | [中文](putnambench-evolution.zh.md)

## Decision

The campaign evolves a frozen DeepSeek Harness candidate in L1, L2, then L3 order. The Updater may use the 500-problem validation score and Solver traces to form open-ended mutation proposals. The 172-problem test partition is evaluated for the baseline and every candidate but remains sealed until the campaign is closed. Test data never influences promotion, rollback, level transitions, retries, or stopping.

PutnamBench is public. “Hidden” therefore means operationally hidden from the adaptive RSI loop, not guaranteed absent from model pretraining.

## Frozen inputs

| Item | Value |
|---|---|
| PutnamBench revision | `dfb0a47a1c1ec3a10f2a9acfdf41a2043920f33c` |
| Lean / mathlib | `v4.27.0` / `a3a10db0e9d66acbebf76c5e6a135066525ac900` |
| Harness source | `3289531e06e924abb790685f44baf67311f26ec9` |
| Primary model | `gpt-5.6-sol`, Responses API, reasoning effort `max` |
| Solver runtime | headless profile, `standard` preset |
| Promotion metric | validation Lean-kernel verified count |
| Patience | advance after 3 consecutive non-improving mutations per level |

The primary curve never falls back per request, task, partition, or candidate. A persistent ZCloud failure pauses that campaign. DashScope (`qwen3.8-max` or `deepseek-v4-pro`) may be used only by starting a separately fingerprinted campaign and therefore produces a separate curve. Provider, model, effort, or budget changes never continue the primary curve. Credentials are consumed once from inherited file descriptors, kept out of argv/environment/files, and are never artifacts.

## Split

The split groups complete contest years so one Putnam source year cannot cross partitions. Test years are:

```text
1964, 1969, 1972, 1975, 1986, 1988, 1991, 1997,
1998, 2003, 2007, 2014, 2016, 2017, 2020, 2024
```

They contain exactly 172 available Lean files; all remaining years contain 500. The selection balances the official multi-label categories, A/B session, problem number, and era. Sorted newline-terminated manifests are frozen by digest:

```text
validation.ids  sha256 0a9c8fb73194e023da449a7bc41755d07c7aaf3d7ec461c47c765541571f2760
test.ids        sha256 2204168d092c0c322d1eedf952bd6e57def58985f35fc24564458aec74e78236
```

Dataset discovery starts from the 672 Lean files and inner-joins metadata. The metadata-only `putnam_1997_a1` record is excluded.

## State machine and selection

```text
CREATED -> CONFIG_FROZEN -> BASELINE_FROZEN -> BASELINE_EVALUATED
        -> EVOLVING_L1 -> EVOLVING_L2 -> EVOLVING_L3
        -> CLOSING -> CLOSED -> REPORTED
```

`PAUSED_INFRASTRUCTURE` is retryable and does not consume patience. Manifest/hash or mutation-boundary violations produce `ABORTED_SECURITY`. An explicit campaign budget produces `STOPPED_BUDGET`.

For each round the Controller copies the incumbent, freezes a pre-mutation proposal, enforces the active-level writable boundary, builds and content-addresses the candidate, and launches both partitions. Validation records and traces become feedback. The Test Broker returns only an opaque completion receipt while writing all test material to a sealed vault.

Proposal and mutation commits are crash-recoverable. A proposal is an atomic write-once artifact. The mutation report, validated diff, disposition, evaluation target, and frozen workspace digest are committed as one atomic `mutation-bundle.json`; recovery re-hashes the workspace before advancing the checkpoint and aborts on a mismatch. `state.json` is the authoritative ledger, while `events.jsonl` is atomically rebuilt from its complete event history after each state commit. Malformed proposal/apply output is a candidate failure: the Controller restores the incumbent and still runs a fresh validation and sealed-test point under that candidate ID. Provider, timeout, launcher, and other explicitly classified operational failures pause infrastructure without consuming patience.

A candidate is promoted only when its validation verified count is strictly greater than the incumbent's. A tie, regression, or candidate-caused failure is rejected and increments the active level's consecutive-miss counter. Promotion resets that counter. Three consecutive misses advance to the next level while inheriting the best incumbent; three L3 misses close the campaign. Every candidate still has a test point. The final plot shows raw results and is never smoothed or selected by test score.

## Mutation hierarchy

The search proceeds outside-in, from lower-risk declarative behavior to higher-risk Solver internals:

- L1 changes only `apps/cli/config/agent-presets/**`.
- L2 changes extension points and tools: compaction, context, extensions, guards, hooks, retry, plan, preset, skill, subagent, todo, workflow, web, file, interaction, and shell tools. Agent Loop and Session Core remain frozen.
- L3 may change Candidate apps, packages, native/python code, and build configuration. The external Controller, Evaluator, manifests, vault, credentials, metering, promotion logic, and pinned Source remain immutable.

An inherited candidate retains lower-level improvements. Each new mutation must touch at least one path exclusive to its active level and may not touch a higher level or an always-read-only path.

## Roles and trust boundary

The Solver sees one solution-patched Lean task at a time and attempts the main theorem proof in an ephemeral workspace. The Updater sees incumbent validation summaries, representative validation traces, and candidate source. It writes a falsifiable proposal before editing and then makes a minimal complete change. No human-authored failure taxonomy or fixed mutation template directs this reasoning.

The absence of a rule-based mutation judge does not make correctness subjective. A trusted Lean kernel replay scores proofs. The runner reconstructs the proof inside the frozen theorem template and rejects `sorry`, `admit`, new axioms, statement changes, or unauthorized writes. Solver, Updater, build, and verifier use distinct host identities. Untrusted phases run through `setpriv` and bubblewrap with private process/tmp namespaces, explicit mounts, and fail-closed dual-stack egress; the verifier additionally has no network namespace. Candidate source is read-only during evaluation; validation and test use separate task roots and `DSH_HOME` directories. The Updater cannot mount the Controller repository, dataset root, test manifest, sealed vault, or other candidates. Only the sealed broker child opens and validates the test manifest; the main Controller never materializes test IDs before closure.

The trusted validation ledger retains real completion times and latency for the terminal wall-clock report, but it is never mounted into the Updater. Immediately before each proposal, the Controller rebuilds a separate read-only projection containing only validation scores, outcomes, and sanitized trace content. It removes absolute timestamp fields, normalizes timestamp text and every projected file mtime, and gives proposal/apply prompts a logical `createdAt` marker. Relative validation duration, latency, token usage, and reasoning remain available as useful validation evidence. Thus the interval between validation completion and the next proposal cannot reveal sealed-test duration; no fixed-time padding is required.

Each immutable candidate records its parent/content digests, active level, frozen proposal, model-budget fingerprint, timing, validation decision, and an opaque test receipt. Until closure, public state and logs contain no test IDs, scores, traces, or proxy fields. After closure, the reporter emits raw validation/test curves against elapsed wall-clock hours, level regions, promotion markers, pre-declared improvement directions, resource usage, infrastructure events, and validity threats.
