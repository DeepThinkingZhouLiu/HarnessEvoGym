# Cowork RSI L1/L2 MVP Runbook

English | [中文](cowork-mvp.zh.md)

## Scope

This path tests whether DeepSeek Harness can improve a Cowork candidate preset from objective task feedback and retain that gain on tasks not exposed to the Updater. H0, proposals, and champions are independent overlays; L1/L2 never edit the pinned DSH source submodule.

## Responsibilities

| Module | Responsibility |
|--------|----------------|
| `orchestrator.mjs` | Generations, state, lineage, promotion, rollback, one-time finalization |
| `candidate.mjs` | Copying, hashing, diffs, mutation policy and report validation |
| `factories.mjs` | Protocol-to-driver selection for Solver, Updater, and Environment implementations |
| `runtimes/dsh.mjs` | DSH model settings and Solver/Updater container protocol |
| `environments/skillsbench.mjs` | Task images, disposable workspaces, verifier execution, reward normalization |
| `model-gateway.mjs` | Per-run internal network, ephemeral token, usage accounting, and gateway lifecycle |
| `evaluator.mjs` | Paired metrics, bootstrap intervals, frozen gates |
| Target Adapter | Runtime and target-specific L1/L2 paths |
| Updater Adapter | Independent updater source, runtime, prompt, and report contract |
| Model Provider Adapter | Upstream protocol, credential environment names, compatibility, and model catalog |
| Environment Adapter | Dataset revision, task layout, Docker resources, verifier contract |

The Updater is one full coding-agent session. It performs cross-case diagnosis, hypothesis formation, and editing itself; the Controller does not replace it with fixed diagnosis/proposal services. Later generations receive bounded prior hypotheses, changed files, and aggregate selection gates so they do not repeat failed searches, while per-instance selection evidence remains hidden.

## Isolation and mutation

L1 permits only preset YAML and skill text/data. L2 adds Python, JavaScript, MJS, and Shell files under `skills/**/scripts/**`. The Controller rejects no-op proposals, symlinks, special files, L1 executable bits, credential-like paths, out-of-scope changes, excessive tree entries, and configured changed-file/byte limits after every Updater session. Rejecting no-op candidates prevents selection noise from being mistaken for evolution.

Solver, Updater, Verifier, and Model Gateway are separate Docker roles. Agent containers drop capabilities, use `no-new-privileges`, a read-only root filesystem, and explicit CPU/memory/PID/time/workspace limits. DSH is fully built from the pinned source submodule and injected into each task image. Candidate presets and task-provided skills are read-only bind mounts, so candidate changes do not rebuild an image. The trusted Verifier receives the host submission through a read-only mount, copies it into a private size-bounded tmpfs, and writes only an isolated log mount; this keeps upstream checks that need scratch files working without letting a root Verifier rewrite the submission. Root-run verifier logs are returned to the Controller user's UID/GID on exit. Because some pinned scripts install dependencies with apt/dpkg, only this trusted role restores Docker's default non-privileged capability subset, never `SYS_ADMIN`; Solver and Updater remain capability-free. Task images carry revision/task labels, and derived images are reused only when the DSH source, runtime-definition digest, and exact task-image identity all match. Candidate generic skills use the enforced `cowork-*` namespace so task-specific skills retain their own names and precedence.

Pinned upstream verifiers may download fixed dependency versions at scoring time. A verifier-only standard proxy allowlist can inherit proxy variables already present on the host; these variables are never passed to Solver or Updater and therefore do not open their internal network.

Slow environments may instead map a pinned local dependency-cache URL into the trusted Verifier. The Controller accepts only `UV_DOWNLOAD_URL`, `PIP_INDEX_URL`, or `UV_INDEX_URL` as target variables and exposes `host.docker.internal` only to this role, never to an Agent container.

The feedback packet includes the feedback task instruction, reward, final answer, verifier evidence, runtime errors, a bounded artifact summary, and latency. Text has a per-case byte budget; artifacts have separate entry and JSON-byte budgets with an explicit omitted count. It never includes selection/final instructions or per-instance evidence.

Each run creates a fresh Docker internal network. Solver and Updater have no external route and receive only an ephemeral token and internal URL. The dual-homed Model Gateway alone inherits the real provider key, proxies only the configured upstream `POST /chat/completions` endpoint, and enforces run-level request and concurrency caps. It parses streamed usage and measures each Solver/Updater session by counter deltas; if any response lacks valid usage, that session's token totals remain unknown. Real and ephemeral secrets are inherited through child-process environments rather than Docker command arguments.

## Commands

```bash
npm install
git submodule update --init --recursive
export RSI_SKILLSBENCH_ROOT=/absolute/path/to/skillsbench
export RSI_PROVIDER_BASE_URL=https://your-provider.example/v1
export RSI_PROVIDER_API_KEY=your-runtime-secret

npm run rsi -- experiment validate \
  --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment preflight \
  --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- runtime build \
  --experiment experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- evolve run \
  --experiment experiments/cowork-skillsbench-dsh-l1.json \
  --run-id cowork-l1-smoke-001
npm run rsi -- evolve finalize \
  --run .rsi/runs/cowork-l1-smoke-001
```

The run command uses only feedback and selection. The Controller trust-root paths must be committed before preflight/evolution; each run freezes the superproject SHA and Finalization requires the same revision. Finalization locks the champion, replays feedback for a comparable training gain, and evaluates sealed final in one consumed attempt. Integrity and revision checks happen before unlock; an atomic create-if-absent `final-attempt.json` claim prevents concurrent finalizers from both entering replay. Once claimed, success, failure, or a crash does not silently make the sealed set reusable.

The upstream connection is configured once through a `ModelProviderAdapter`: it owns the protocol, credential environment names, compatibility flags, and allowed model catalog, while real credentials remain runtime-only. Solver and Updater independently select `provider`, `model`, and `maxTokens` in the Experiment. The current low-cost POC uses `gpt-5.6-terra` for both roles, capped at 8192 tokens. The DSH runtime translates the shared provider contract into its `llm-pi-ai` OpenAI Chat Completions adapter; a future pi-agent integration needs only its own runtime translation rather than another credential configuration.

## Evaluation

The v2 result protocol accepts continuous `[0,1]` reward and records repeated trial rewards and seeds, deterministic-seed capability, latency, artifacts, and policy violations. The eight selected upstream verifiers currently emit binary 0/1 rewards. Selection promotion requires full coverage/completion, at least one reward improvement, non-negative mean reward delta, zero reward regressions, and zero safety violations.

`seed_controlled=false` is intentional: seeds are paired and recorded, but the current DSH provider path does not guarantee deterministic sampling. Formal runs should use at least three trials. Complete Solver token usage is written to per-instance results and Solver/Updater totals enter the evolution ledger. Dollar cost remains unknown without a trusted provider rate card, so POC cost gates stay disabled instead of reporting zero.

## Extending safely

- Add tasks by changing a pinned Benchmark manifest; keep feedback, selection, and final disjoint.
- Adapt verifier arguments and output files through the Environment Adapter rather than adding benchmark logic to the Controller.
- Start L1 and L2 from the same H0 with identical models, tasks, trials, and budgets.
- Do not copy third-party task skills into the candidate repository without compatible licensing.
- Before formal claims, add DNS/IP controls outside the existing gateway, pin all image and verifier dependency digests, configure trusted provider pricing, and expand the held-out set.
