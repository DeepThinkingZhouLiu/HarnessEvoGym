# MSA-derived Minimal Harness

This directory is the reviewable source snapshot of the lightweight math and
coding Harness used by the HLE experiments. It is intentionally dependency
free and does not need compilation between mutations.

The baseline repeats one small loop:

```text
task -> model -> optional Bash -> observation -> model -> final answer
```

| File | Responsibility |
|---|---|
| `profiles/math.md` | Solver prompt, action contract, and answer format |
| `profiles/math.json` | Step, token, command-timeout, and observation budgets |
| `agent.py` | Message history and model/action/observation loop |
| `tools.py` | Local Bash execution and bounded output |
| `model.py` | Responses/SSE client over the Controller Unix socket |
| `run.py` | CLI, workspace, trace, and answer wiring |

The snapshot corresponds to standalone baseline commit
`4532f4b82424ed13de64b930e84b51914b7b7893`; the initial extraction commit was
`d9e0bb6`. The nested `.git` directory is deliberately not vendored. Campaigns
materialize a Candidate from a pinned Git source and never mutate this trusted
snapshot in place. See the repository root README for system design and
configuration entry points.
