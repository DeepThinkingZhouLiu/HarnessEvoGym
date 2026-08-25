# HLE text-only Math 50/50

This campaign pins the official `cais/hle` revision and retains only rows with `category=Math` and no `image` or `image_preview`. It deterministically samples 100 rows with largest-remainder quotas over `raw_subject × answer_type`, then splits each stratum as evenly as possible into 50 validation and 50 test rows. HLE has no official difficulty field, so question length is not presented as a synthetic difficulty stratum.

Validation questions, Solver traces, per-task status, and aggregate score may enter the next Updater feedback packet. Baseline test is measured once; Candidate test is then measured on deterministic candidate ordinals 5, 10, 15, and so on. `spec.evolution.testEvaluationInterval` configures this cadence and defaults to 5. The test manifest, questions, reference answers, judge process, and per-task results remain in the sealed vault throughout evolution. After campaign closure, reporting reads only the scheduled aggregate test points for the raw generalization curve. Test information never affects promotion, rollback, level transitions, or stopping.

The evaluated Solver baseline is the pinned DSH `minimal` preset in restricted-minimal mode. It has only a local persistent shell and editor: local Python/scratch computation is allowed, while the Solver sandbox uses a private network namespace (`--unshare-net`). The reference answer and dataset stores are Controller-only files and are never mounted into the Solver workspace. Thus “no search” and “no direct gold access” are enforced by process and mount boundaries in addition to the task prompt. Because the Controller already owns that hard bubblewrap boundary, DSH tool calls delegate confinement to it instead of attempting an unreliable nested OS sandbox; the inner DSH mode is `danger-full-access` only relative to the already isolated namespace, whose Candidate mount is read-only and whose task workspace is the sole writable task mount. The proposal/apply Updater is separate trusted infrastructure and is frozen in DSH `standard` mode; it uses the same delegation while outer read-only mounts and host ownership enforce proposal/apply phase boundaries. The implementation fingerprint and tests prevent Solver mutations or campaign configuration from weakening these Controller boundaries. Other infrastructure components are deterministic Controller/build processes or the direct trusted judge, not Candidate Harness sessions.

HLE is gated on Hugging Face. Accept the `cais/hle` access terms first, then download through an inherited file descriptor. Do not put the token in the command line, environment, or repository:

```bash
python3 scripts/download-hle-text-math.py \
  --output /mnt/data/hzy/dsh-rsi-runtime/datasets/hle-text-math/source/eligible.jsonl \
  --hf-token-fd 3 3</secure/path/to/hf-token

node benchmarks/hle-text-math/prepare-split.mjs \
  --input /mnt/data/hzy/dsh-rsi-runtime/datasets/hle-text-math/source/eligible.jsonl \
  --control-root benchmarks/hle-text-math/.private \
  --dataset-root /mnt/data/hzy/dsh-rsi-runtime/datasets/hle-text-math
```

The `.private/` directory is ignored by Git. Preparation is write-once; use a fresh private directory and campaign ID to change the seed instead of silently changing a frozen experiment.

Before production, run an eight-task validation-only smoke calibration. Production uses concurrency 15. The 50-task validation partition has a hard 3,600-second deadline; exceeding it pauses for infrastructure and does not count as a mutation miss.

Run API-bearing Controller commands through the command-scoped direct launcher below. It removes proxy endpoints only from the spawned Controller process and descendants; it does not mutate the parent terminal or Codex environment:

```bash
node scripts/run-controller-direct.mjs campaign smoke \
  --config benchmarks/hle-text-math/.private/campaign.json \
  --runtime environments/hle-text-math/runtime.json \
  --tasks 8 --provider-key-fd 3 3</secure/path/to/provider-key
```

Evolution is strictly L1 → L2 → L3. A Candidate is kept only on a strict validation-score increase; a tie or drop rolls back. Three consecutive misses advance the level while inheriting the best incumbent. Every proposal names one `before` → `after` variable, and the Controller rejects source edits outside its frozen `intendedFiles`.
