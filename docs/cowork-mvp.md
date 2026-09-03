# OmegaUse-OfficeVal Cowork RSI Runbook

English | [中文](cowork-mvp.zh.md)

## Goal

This path evaluates whether the MSA Minimal Harness can produce real Word,
PowerPoint, and Excel deliverables in an isolated workspace, and whether an
Updater can improve a Candidate from training feedback without reading validation
or test evidence. It replaces SkillsBench and measures completed Office tasks
rather than skill-loading behavior.

```text
MSA Minimal Target
  + OmegaUse-OfficeVal Environment
  + 55/18/18 Benchmark
  + EvolutionRecipe / SearchStrategy
  + generic Population Controller
```

## Per-task flow

```text
pinned Source Manifest
-> verify Dataset/Evaluator revisions and every source SHA-256
-> expose only instruction and original Office inputs to Solver
-> run MSA with Bash/Python/LibreOffice in a disposable workspace
-> copy only changed regular artifacts into a separate submission
-> score in an offline verifier container
-> apply the Dim1 gate and weighted Dim2 rubric
-> normalize reward to [0,1]
-> disclose detailed feedback only for the feedback partition
```

Solver never sees rubrics, verifier source, per-instance validation evidence, or
sealed-final data. Updater sees only feedback evidence and can edit only the
Candidate paths in the current MutationLease.

## Responsibilities

| Module                                              | Responsibility                                             |
|-----------------------------------------------------|------------------------------------------------------------|
| `omegause-officeval.mjs`                           | Source checks, workspaces, submissions, verifier, reward   |
| `msa-minimal-cowork.mjs`                           | Run an MSA Candidate inside the Office runtime             |
| `cowork-model-gateway.mjs`                         | Hide provider keys, enforce model/token settings, meter use |
| `candidate.mjs`                                    | Candidate copies, digests, diff guard, mutation reports    |
| `evaluator.mjs`                                    | Paired metrics and frozen promotion gates                  |
| `cowork-orchestrator.mjs`                          | Branch steps, promotion, rollback, one-time final          |
| `population-orchestrator.mjs`                      | Five modes, synchronized waves, sharing, competition       |
| Target Adapter                                      | H0 Seed, runtime, L1/L2/L3 regions, semantic validator     |
| Environment Adapter                                 | OfficeVal source, runtime resources, feedback limits       |
| Benchmark / Policy                                  | train/validation/test IDs, metric, promotion policy        |

## Pinned data and split

The upstream dataset is `baidu-frontier-research/OmegaUse-OfficeVal`. The
committed `benchmarks/omegause-officeval/source-manifest.json` pins:

- Dataset revision `cd6ba6d8fb83b3fb551e24eebc20e1fb0bd154a5`.
- Evaluator revision `ffbeecb8752447c8e40b594a0eeb1db7236ecb36`.
- Instructions, rubrics, inputs, per-task verifiers, and shared verifier files for all 100 tasks.
- The nine Windows Office COM tasks excluded from the Linux path.

The registered Linux split is:

| Partition                   | Count | Updater visibility | Purpose                         |
|----------------------------|------:|--------------------|---------------------------------|
| `feedback` / train         |    55 | detailed           | diagnosis and Candidate updates |
| `selection` / validation  |    18 | aggregate only     | promotion decisions             |
| `final` / test            |    18 | one-time sealed    | final report after lock-in       |

The three-task smoke uses `officeval_060 / 090 / 003`, all drawn from the
formal feedback partition, to cover PPT, Excel, and Word without consuming formal
validation or test data.

## Isolation

Every run creates an internal Docker network. Solver and Updater have no external
route and call only the Model Gateway using role-scoped ephemeral tokens. The
Gateway owns the real provider key and overwrites model, token-limit, and
multi-candidate fields.

The Office runtime includes LibreOffice Writer/Calc/Impress, Python Office
libraries, fonts, and PDF/ZIP tools. Candidate and environment assets are
read-only; task and session workspaces are writable. The Controller rejects
symlinks, special files, and artifacts over the configured count and byte limits
before verification.

Verifier runs in a distinct container with no network, empty proxy variables,
a read-only root, no additional capabilities, read-only submission/code mounts,
and a separate writable log mount. Per-task and shared verifier files are
re-hashed after staging. A well-formed upstream `status:error` is a legitimate
candidate zero. Import failures, process errors, protocol corruption, or source
drift are infrastructure failures and fail closed.

## Configuration

```text
environments/omegause-officeval.yml
benchmarks/omegause-officeval/source-manifest.json
benchmarks/cowork-omegause-officeval-smoke/benchmark.json
benchmarks/cowork-omegause-officeval-linux-v1/benchmark.json
evaluation/policies/cowork-officeval-rsi.json
adapters/targets/msa-minimal.yml
adapters/targets/msa-minimal-cowork-rsi.yml
experiments/cowork-msa-smoke-<mode>.json
experiments/cowork-msa-rsi-linear-<mode>.json
```

`msa-minimal` caps each Solver task at one step for inexpensive connectivity
smoke. `msa-minimal-cowork-rsi` allows the profile's 12-step loop for the
registered 55/18/18 experiments.

## Commands

```bash
npm install
export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
export RSI_PROVIDER_BASE_URL=https://your-provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY && export RSI_PROVIDER_API_KEY

npm run check
npm test
npm run rsi -- experiment validate \
  --config experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment preflight \
  --config experiments/cowork-msa-smoke-single.json
npm run rsi -- runtime build \
  --experiment experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment run \
  --config experiments/cowork-msa-smoke-single.json \
  --run-id cowork-officeval-smoke-001
npm run rsi -- experiment finalize \
  --run .rsi/runs/populations/cowork-officeval-smoke-001

unset RSI_PROVIDER_API_KEY
```

Evolution reads only feedback and selection. Finalization becomes available only
after Population locks `best-harness.json`, and rechecks state, Candidate digest,
configuration digest, and source revisions before one-time unsealing. Once an
attempt has touched sealed data, it cannot be rerun regardless of success.

## Reward and claims

OfficeVal applies a Dim1 deliverable-validity gate and weighted Dim2 rubric items:

```text
reward = dim1_pass ? clamp(total_score / max_score, 0, 1) : 0
```

Partial improvement such as 0.35 to 0.60 is therefore visible. The current
engineering policy requires complete coverage, non-decreasing mean reward, at
least one improved task, and zero policy violations, while provisionally allowing
up to three reward regressions.

Before publishing a formal benchmark claim:

- Run at least three preregistered seeds per task instead of one trial.
- Give every population mode identical Candidate budgets, models, tokens, and tasks.
- Preregister regression limits, confidence-interval gates, and stopping rules before final.
- Report reward, generalization gap, Solver/Updater tokens, wall time, and all failed runs.
- Never tune a Candidate against a final result and rerun the same test set.

## Current boundaries

- The Linux path excludes nine Windows Office COM tasks; they require a separate Windows worker/verifier adapter.
- The three-task smoke proves only Dataset -> MSA -> Office artifact -> Verifier -> Reward connectivity.
- A one-seed 55/18/18 run is useful for development but is not a statistical significance claim.
- PI Agent still needs its own Source/Seed/Runtime/Validator adapter.
