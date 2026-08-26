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

## Contributor example

See `strategies/examples/round-robin/` and
`adapters/strategies/docker-round-robin.example.yml`. The process reads one
`SearchStrategyRequest` JSON object from stdin and writes one strict
`SearchStrategyResponse` object to stdout. `propose` returns state plus a
MutationPlan; `observe` returns only updated state.

Solver, Updater, and Environment implementation creation uses the versioned
trusted Driver Registry. The main evolution loop no longer branches on those
protocols. This is an extension seam, not a claim that pi-agent is already
plug-and-play: Cowork adapter validation, source preflight, and materialization
are still DSH/SkillsBench-specific. A new Harness contribution must add those
lifecycle pieces and then register through `registerSolverDriver`,
`registerUpdaterDriver`, or `registerEnvironmentDriver`. Drivers execute and
mount Harness workspaces, so unlike a search algorithm they are trusted
Controller code rather than arbitrary sandboxed plugins.

## Compatibility matrix

| Plane                    | Search configuration              | Enforcement                       | Status                         |
|--------------------------|-----------------------------------|-----------------------------------|--------------------------------|
| Cowork `experiment`      | `SearchStrategyAdapter`           | Catalog -> Plan -> Lease -> Diff  | Builtin and Docker strategies  |
| Reasoning `campaign`     | Five `controller_config.mode`s    | Git commit + layer path audit     | Existing Future behavior       |
| Legacy Cowork experiment | No `strategy` field               | Default all-region lease          | Backward compatible            |
| Legacy Target adapter    | No `mutation.catalog`             | L1/L2/L3 mapped to regions        | Backward compatible            |
| Non-DSH Cowork Harness   | Driver Registry seam              | Needs adapter + materializer      | Not end-to-end yet             |

This refactor intentionally does not alter the proven Future Reasoning sealed
broker, Git lineage, or rollback semantics. External Docker SearchStrategy is
currently a production capability of the Cowork plane; it does not yet replace
the five Reasoning population modes.
