# DeepSeek Harness RSI

English | [中文](README.zh.md)

**A trusted control plane that makes Coding/Cowork agents evaluable, evolvable, and rollback-safe. Its first complete path uses DeepSeek Harness as both Solver and Updater and evolves Cowork presets, prompts, skills, and constrained skill scripts on SkillsBench tasks.**

> [!IMPORTANT]
> The executable Cowork L1/L2 MVP is implemented, but the eight-task POC is only a pipeline smoke test. It is not a full SkillsBench result or evidence of general self-improvement. Formal experiments need a larger split, at least three repeated trials, provider price accounting, pinned image/verifier supply chains, quota- or tmpfs-backed write-time disk limits, and an outer gateway egress policy.

## Implemented loop

```text
pin Controller revision, DSH Source, and SkillsBench revision
-> materialize an immutable H0 candidate overlay
-> run the current champion on feedback tasks
-> create a feedback-only sanitized packet
-> launch one complete DSH Updater session
-> enforce the L1/L2 filesystem diff policy
-> compare champion and proposal on selection tasks
-> promote or reject through frozen gates
-> lock the champion and run final exactly once
```

The Controller implements independently pinned Target/Updater sources, adapter validation, SHA-256 candidate manifests that cover files and empty directories, lineage, Docker Solver/Updater/Gateway/Verifier isolation, SkillsBench task execution, streamed artifact hashing, workspace/artifact budgets and unsafe-file rejection, a continuous-reward protocol, paired bootstrap metrics, promotion/rollback, and a separately sealed finalization command. No-op proposals are rejected before selection so random model variance cannot masquerade as evolution. Verifier reward artifacts must be regular files no larger than 1 MiB. Candidate-owned generic skills must use the `cowork-*` namespace so they cannot shadow task-provided `pdf`, `xlsx`, or similar skills. Later generations receive prior hypotheses and aggregate selection gates, never per-instance selection evidence.

## Mutation boundary

| Level | Writable surface                                      | Status             |
|-------|-------------------------------------------------------|--------------------|
| L1    | Cowork preset, persona, prompt, and skill documents  | Implemented        |
| L2    | L1 plus scripts under `skills/**/scripts/**`         | Implemented        |
| L3    | DSH agent loop, session, context, and core packages  | Deliberately closed |
| Trust root | Controller, evaluator, tasks, rubrics, secrets | Never writable     |

The prompt is guidance, not the security boundary. Updater containers never receive benchmark or verifier mounts, and the Controller recomputes every file hash after the session. Out-of-scope edits, symlinks, executable files at L1, credential-like paths, excessive tree entries, and size-limit violations reject the candidate. Cordis composition checks sanitize only explicitly allowed `!!js` lines, parse the complete YAML tree, and recursively validate plugin names and patch directives, so flow-style YAML cannot bypass the allowlist.

## Isolation roles

| Role          | Reads                                                | Writes                         |
|---------------|------------------------------------------------------|--------------------------------|
| Solver        | One task workspace and read-only candidate/task skills | Disposable trial workspace   |
| Updater       | Read-only DSH source and feedback-only packet        | One candidate overlay          |
| Model Gateway | Real provider URL and key                            | No persistent data             |
| Verifier      | Trusted scoring script and solver artifacts          | Isolated verifier logs         |
| Controller    | Config, lineage, normalized outcomes                 | Ignored `.rsi/` state          |

Solver and Updater containers join a fresh Docker internal network for each run. They receive only an ephemeral gateway token and internal URL, have no external route, and never receive the real provider key. The dual-homed Model Gateway is the only egress role, proxies only `POST /chat/completions` to the configured base URL, and enforces per-run total-request and concurrency limits. Agent containers also drop all capabilities, enable `no-new-privileges`, use a read-only root filesystem, and receive CPU, memory, PID, and timeout limits. Production can add DNS/IP allowlists outside the gateway.

Solver workspaces and the Updater DSH home are currently host bind mounts. The Controller snapshots them after each session and rejects over-budget output, but this is not a write-time filesystem quota. Treating an Updater as adversarial in a long formal run requires quota-backed volumes or bounded tmpfs mounts.

## Quick start

Requirements: Node.js 20+, Git, Docker, and a local SkillsBench checkout pinned to `bf3793e9ec20e9682e6f18dbf4de3c69163dc9c7`. Run the Controller as a non-root user with Docker access. Before `preflight` or `evolve run`, the Controller trust-root paths (`controller/src`, `docker`, and the package manifests) must be committed. The run records the superproject SHA and Finalization requires the same revision. DSH is built completely from the pinned source submodule with Node.js 24; the first build is heavy, while candidate-only iterations reuse image caches.

```bash
npm install
git submodule update --init --recursive

export RSI_SKILLSBENCH_ROOT=/absolute/path/to/skillsbench
export DEEPSEEK_BASE_URL=https://your-provider.example/v1
export DEEPSEEK_API_KEY=your-runtime-secret

npm run check
npm test

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

Use `experiments/cowork-skillsbench-dsh-l2.json` for an independent L2 run. Runtime artifacts, candidate workspaces, results, and one-time final state are stored under `.rsi/runs/<run-id>/` and are ignored by Git. The real API key is inherited only by the Model Gateway, never placed in Docker arguments or Agent containers; Solver and Updater receive a run-scoped token. Finalization claims `final-attempt.json` with an atomic create-if-absent operation, so concurrent processes cannot both unlock the sealed set. Once claimed, success, failure, or a crash does not silently make Final reusable.

## POC split and metrics

The pinned manifest contains three feedback tasks, two selection tasks, and three sealed final tasks. The protocol accepts continuous `[0,1]` rewards and uses `meanReward` as its primary Cowork metric, but the eight selected upstream verifiers currently emit only 0/1, so `meanReward` equals resolved rate in this POC. Paired reward improvement/regression, bootstrap intervals, latency, policy violations, and feedback-to-final generalization gap are also reported.

The Model Gateway now measures request and token usage per Solver/Updater session from streamed provider usage. Token fields are emitted only when every response in the session reports valid usage; otherwise they remain unknown. Dollar cost remains unknown without a trusted provider rate card, so the POC cost gates stay disabled. A token-growth gate exists but has no arbitrary POC threshold. Results explicitly record `seed_controlled=false`: seeds are paired and recorded, but the current DSH model path does not guarantee deterministic sampling, so formal runs should use repeated trials.

## Documentation

- [Cowork MVP runbook](docs/cowork-mvp.md)
- [Control-plane architecture](docs/architecture.md)
- [Controller](controller/README.md)
- [Adapters](adapters/README.md)
- [Environments](environments/README.md)
- [Benchmarks](benchmarks/README.md)
- [Evaluation](evaluation/README.md)

## Upstream and license

This is not an official DeepSeek project. `sources/deepseek-harness/` comes from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), retains its own history and license, and is pinned by the superproject Gitlink. Updaters never edit it directly. Controller, adapter, preset, and documentation work in this repository is available under the [MIT License](LICENSE).
