# Search Space, Strategy, and Compatibility

English | [中文](search-strategy.zh.md)

## Responsibilities

The Target declares which stable mutation regions exist. SearchStrategy chooses
a parent Candidate and region IDs for one generation. The Updater diagnoses
feedback and edits the Candidate. The trusted Controller validates the plan,
issues a one-round lease, recomputes the complete diff, evaluates the result,
and promotes or rejects it.

```text
Target Catalog -> SearchStrategy -> MutationPlan -> Controller MutationLease
       feedback -> Updater -> Candidate -> Solver -> Evaluator -> frozen gates
```

L1/L2/L3 are risk ceilings, not algorithms. Regions are Target-specific stable
modules. A strategy never submits filesystem paths; the Controller alone maps
validated region IDs to writable paths.

## Enforcement

- A Target catalog must preserve the exact legacy writable and extension sets
  when all regions under a risk ceiling are selected.

- MutationPlan v1 accepts only `generation`, one `parentIds` entry, and
  `regionIds`. Unknown fields, invalid parents, dependency conflicts, and
  regions above the risk ceiling fail closed.

- The Controller generates MutationLease from trusted Target configuration.
  It then validates the full post-session tree diff and DSH/Cordis semantics;
  an Updater's Mutation Report is not an authorization artifact.

- External `docker-json-v1` strategies run with no network, no bind mounts, no
  host environment or credentials, a read-only root, a small tmpfs, bounded
  resources, and an image pinned to a SHA-256 repository digest.

The default `linear-hill-climb` strategy chooses the Champion and every region
under the current risk ceiling. Experiments without `spec.adapters.strategy`
receive this default automatically, preserving legacy Cowork behavior.

## Progressive risk expansion

`adapters/strategies/progressive-risk-expansion.yml` generalizes HZY's level
progression without knowing any Harness path. Each Branch starts at the
configured risk level, keeps the same level after a promotion, expands to the
next Target-defined level after `missesBeforeExpansion` consecutive
non-promotions, and returns `exhausted=true` after the same threshold is reached
at the Recipe risk ceiling. The Controller then stops that Branch and preserves
unused Population budget.

It remains opt-in and does not replace the default strategy of existing smoke
experiments. The complete configuration chain is:

```text
experiments/reasoning-msa-progressive-strict-smoke.json
  -> recipes/progressive-risk-expansion/single.yml
  -> adapters/strategies/progressive-risk-expansion.yml
  -> evaluation/policies/strict-mean-reward-improvement.json
```

The Single Branch receives at most nine rounds, covering the default
`three L1 misses -> three L2 misses -> three L3 misses -> exhausted` path. The
strict policy requires at least one Reward improvement and zero Reward
regressions, so ties cannot reset the strategy's consecutive-miss counter.

## Contributor example

See `strategies/examples/round-robin/` and
`adapters/strategies/docker-round-robin.example.yml`. The process reads one
`SearchStrategyRequest` JSON object from stdin and writes one strict
`SearchStrategyResponse` object to stdout. `propose` returns state plus a
MutationPlan; `observe` returns updated state and may return `exhausted=true`
to stop the current Branch.

Solver, Updater, and Environment implementation creation uses the versioned
trusted Driver Registry. The main evolution loop no longer branches on those
protocols. Registries now also cover Target Source resolution, Candidate
materialization, and Candidate validation; MSA Minimal proves a non-DSH Target
end to end. This is still not a claim that pi-agent is already plug-and-play: a
new Harness contribution must add its reviewed schema and Source/Seed/runtime
lifecycle pieces, then register through `registerSolverDriver`,
`registerUpdaterDriver`, or `registerEnvironmentDriver`. Drivers execute and
mount Harness workspaces, so unlike a search algorithm they are trusted
Controller code rather than arbitrary sandboxed plugins.

## Compatibility matrix

| Plane                         | Search configuration                  | Enforcement                       | Status                    |
|-------------------------------|---------------------------------------|-----------------------------------|---------------------------|
| Generic `experiment` Population | EvolutionRecipe + SearchStrategy   | Catalog -> Plan -> Lease -> Diff  | Cowork/Reasoning shared   |
| Legacy Reasoning `campaign`   | Five `controller_config.mode`s        | Git commit + layer path audit     | Existing HZY behavior     |
| Legacy Cowork experiment      | No Recipe/Strategy                    | Single + default all-region lease | Backward compatible       |
| Legacy Target adapter         | No `mutation.catalog`                 | L1/L2/L3 mapped to regions        | Backward compatible       |
| MSA Minimal Target            | Cowork/Reasoning Target-owned Catalog | Hard lease + semantic validator   | End-to-end implemented    |

This refactor does not alter the proven Future Reasoning sealed broker, Git
lineage, or rollback semantics. The new text-Reasoning smoke uses the generic
Experiment path and can combine the same SearchStrategy with all five
Population modes; it proves engineering compatibility, not replacement of HLE
production evaluation.
