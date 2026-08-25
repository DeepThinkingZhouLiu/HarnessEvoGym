# Five Controller evolution modes

`controller_config` freezes population topology, total evolution rounds, peer sharing, and competitive allocation in one Campaign. Campaign files in this repository are JSON; the field names map directly to the YAML design.

Every branch reuses the lightweight linear kernel: one persistent Candidate worktree, one independent Git repository, its own validation feedback, and its own `evolution-log.jsonl`. The Controller does not copy a project per round. It only advances distinct branches concurrently in synchronized waves.

## Modes

| mode | concurrent branches | budget | prompt injection |
|---|---:|---|---|
| `single` | exactly 1 | the branch owns all `total_budget` rounds | none |
| `independent` | N | the total budget is divided as evenly as integers allow | none |
| `mutualism` | N | same as Independent | peer history logs from the second wave onward |
| `competition` | N | equal Base Budget plus `delta_score` competition for Bonus Budget | Competition Block |
| `combined` | N | same as Competition | Peer Log Sharing Block and Competition Block |

Parallel modes execute synchronized waves. Each participating branch completes one full “Updater mutation → build → validation → keep/reset” round, and the Controller waits for every participant before recording the wave and starting another. A branch with no remaining credits leaves synchronization and ranking. In Combined mode, its existing log remains available to active peers.

## Unified configuration

```yaml
controller_config:
  mode: combined
  concurrency:
    n_branches: 2
  budget:
    total_budget: 32
    beta: 0.5
  peer_sharing:
    enabled: true
    log_path_template: "- Peer {peer_id}: {log_path}"
    inject_position: prompt_suffix
  competition:
    enabled: true
    bonus_grant_unit: 1
    scoring_metric: delta_score
```

The mode and capability switches must agree, preventing a configuration that appears mutualistic or competitive while silently disabling its defining mechanism:

- `mutualism` and `combined` require `peer_sharing.enabled=true`; other modes require `false`.
- `competition` and `combined` require `competition.enabled=true`; other modes require `false`.
- `single` requires `n_branches=1`; other modes require 2–32.
- `total_budget` counts global Candidate mutation-and-validation rounds. Branch baselines do not consume it.
- `beta` is in `[0,1]` and affects only Competition/Combined.

## Integer budget semantics

Independent/Mutualism use a stable near-even allocation. For example, `32/3` becomes `11, 11, 10`, preserving exactly 32 rounds.

Competition/Combined use:

```text
base_budget_per_branch = floor(total_budget * beta / n_branches)
bonus_budget_pool = total_budget - base_budget_per_branch * n_branches
```

Every branch therefore receives the same guaranteed Base Budget. Fractional and indivisible remainders enter the Bonus Pool instead of arbitrarily favoring one branch. After a synchronized wave, branches are ranked by Candidate validation score minus the incumbent score at the start of that wave. The largest `delta_score` receives up to `bonus_grant_unit` new rounds. Ties use the current validation score and then stable branch ID order.

With `beta=0`, the Controller uses independently evaluated baseline scores to select the first Bonus recipient, then continues with observed mutation deltas.

## Prompts and logs

Mutualism/Combined do not copy peer histories. The Controller mounts each real peer `evolution-log.jsonl` read-only inside the Updater sandbox:

```text
/opt/harness-rsi/peer-logs/branch-001.jsonl
/opt/harness-rsi/peer-logs/branch-002.jsonl
```

`log_path_template` supports `{peer_id}` and the required `{log_path}`. The Peer Block asks the Updater to reuse features with demonstrated gains and avoid features peers already found ineffective or incorrect. The Competition Block explains `delta_score` and bonus rounds. These blocks are search priors only; writable layers, Git diff checks, validation promotion, and rollback remain hard Controller boundaries.

## Final artifacts

When the total budget is exhausted, or every Updater stops, the parent Population Campaign closes and writes:

- `population-summary.json`: mode, budget, every branch incumbent, and mutation history.
- `population-summary.md`: population comparison and best result.
- `best-harness.json`: best branch/Candidate, commit/tree/digest, frozen baseline revision, and reconstruction paths.
- `best-harness.patch`: the complete Git patch from the frozen baseline to the population-best Harness.

The best branch is selected by validation score, with branch ID as the deterministic tie-breaker. Hidden test data never affects ranking, bonus allocation, or best-Harness selection.

## Terra-High profile

The runnable example is `benchmarks/hle-text-math/msa-population10-codex-terra-high/campaign.json`, defaulting to Single with a total budget of 32. It reuses `environments/hle-text-math/msa-codex-terra-high-runtime.json`: Solver and Codex Updater both use `gpt-5.6-terra/high`; model-request and Solver task timeouts are both 1800 seconds. Use a new Campaign ID when changing modes, and update `mode`, `n_branches`, and both `enabled` fields together so a frozen experiment is never mutated in place.

In Population mode, `--round-limit` caps synchronization waves for the current command only; it does not alter frozen `total_budget`. Omit it or use 0 to run until the configured budget or Updater stop condition terminates the algorithm.
