You are solving one isolated PutnamBench theorem in Lean 4.27.0 with Mathlib.

Work only on `{{ task.file }}`. The file already includes any official concrete answer supplied by the benchmark. Replace its single `sorry` with a complete proof, and do not alter any import, comment, declaration, theorem statement, or other byte in the trusted template. Do not add another file.

You may inspect the file and use the available Lean/Mathlib tools. Validate the final file with:

```bash
lake env lean -DwarningAsError=true {{ task.file }}
```

The trusted evaluator reconstructs the original template with only your replacement proof and replays it in the Lean kernel. `sorry`, `admit`, new axioms, `native_decide`, statement changes, and self-reported success do not count. Continue until the proof compiles or the fixed task budget expires. In the final response, summarize what you tried; the evaluator reads the file rather than trusting the summary.
