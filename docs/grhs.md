# Group-Relative Harness Search MVP

English | [中文](grhs.zh.md)

GRHS transfers the within-group baseline idea of training-free GRPO to discrete
Harness revision search. It never trains Solver or Updater weights. In one
round, the trusted Controller freezes one parent, one feedback packet, one
selection partition, the seeds, and budgets, then creates at least two sibling
MutationPlans from the Target-owned Region catalog. Every sibling receives a
separate MutationLease and a complete Codex Updater session.

For valid sibling `g`, the Controller computes:

```text
utility_g = selection_reward_delta
            - regression_penalty * paired_regression_rate
            - cost_penalty * relative_token_delta
            - complexity_penalty * normalized_patch_complexity

advantage_g = (utility_g - group_mean) / (group_stddev + epsilon)
```

Invalid diffs, unsafe results, incomplete evaluations, and duplicate patches do
not enter group statistics. Fewer than two valid siblings skips the relative
update and rolls back. Otherwise, advantages update a categorical prior over
Target Region IDs. The best gate-eligible sibling is promoted only when its
penalized paired-bootstrap lower bound exceeds the precommitted margin. Ties are
resolved by Candidate ID, so replay is deterministic.

The immutable group decision records parent and sibling lineage, MutationPlan
and Region IDs, utility components, relative advantage, proposal prior before
and after the round, LCB, promotion, and rollback reason. Final remains sealed
until the frozen Champion is finalized.

The MVP composition is
[`experiments/cowork-msa-grhs-smoke-codex.json`](../experiments/cowork-msa-grhs-smoke-codex.json):

- MSA Minimal Cowork RSI Solver;
- Codex CLI Updater;
- `gpt-5.6-terra` with `reasoningEffort: high` for both roles;
- one L2 round with two siblings;
- one feedback and one selection OmegaUse-OfficeVal smoke task.

The full AgentBay composition is
[`experiments/cowork-msa-grhs-formal32-codex.json`](../experiments/cowork-msa-grhs-formal32-codex.json).
It freezes the same GRHS policy for 32 generations against the formal
55-feedback, 18-selection, and 18-sealed-final split. Evolution runs never read
the sealed-final partition.

Run-time values are injected only through `RSI_PROVIDER_BASE_URL` and
`RSI_PROVIDER_API_KEY`. The Codex distribution and the OfficeVal dataset and
evaluator roots must pass preflight before a real run. No credential belongs in
the Experiment, Candidate, feedback packet, trace, or Mutation Report.

The smoke composition uses the AgentBay Environment variant. The Controller
keeps one AgentBay VM per run and executes its existing Docker isolation model
inside that VM; mount inputs are uploaded before a trial and only writable
mounts are returned afterward. `AGENTBAY_API_KEY`, the VM image ID, and the
policy ID are runtime environment values, never Experiment values.

`experiment baseline` supports this recipe-free GRHS composition directly. It
runs only H0 selection, records zero mutation-budget consumption, and exits
without starting an Updater session.

On a root Controller host where unprivileged user namespaces are explicitly
disabled, Codex Updater uses a privileged Bubblewrap launcher only after
attesting `user.max_user_namespaces=0`. In this capability-limited fallback,
the frozen Codex process shares the host network solely to reach the
credential-hiding loopback relay; it receives only a one-time dummy key, no
provider secret or host configuration. The launcher constructs the existing
mount/PID/IPC/UTS/cgroup boundary and then
drops to UID/GID 65534 with supplementary groups and all capability sets
cleared plus `no_new_privs`. Other hosts retain the normal rootless launcher.
The isolated Codex session executes the static native binary from the pinned
npm distribution and uses a byte-stream loopback-to-Unix-socket relay, so no
host Node runtime or DSW dynamic-library tree enters the sandbox.
The frozen invocation also disables Codex plugins, browser/app integrations,
skill and workspace dependency discovery, shell snapshots, remote compaction,
and unbounded retries. Those interactive features are outside the Updater
contract and may otherwise block startup in the restricted Updater runtime.

Current limits: the MVP schedules sibling Updater and Solver calls
sequentially, and the first AgentBay bridge serializes remote control-plane
operations within one VM. It uses token delta as the available cost proxy because the provider
has no trusted rate card, and does not retry a group that has fewer than two
valid siblings. Larger groups, bounded retries, parallel execution, and formal
OfficeVal splits remain follow-up work.
