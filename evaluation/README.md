# Evaluator 与指标入口

评测分为两层：外部 Task Evaluator 判断单道任务是否解决；本目录的 RSI Evaluator 在冻结边界内聚合 Baseline/Candidate 结果，计算配对指标并执行晋升 Gate。

## 标准化 Solver Result

Task Evaluator 需要把结果归一化为 JSONL，每行对应一道题：

```json
{
  "instance_id": "owner__repo-123",
  "status": "resolved",
  "cost_usd": 0.42,
  "input_tokens": 12000,
  "output_tokens": 1800,
  "latency_ms": 93000,
  "policy_violations": []
}
```

`status` 只能是 `resolved`、`unresolved`、`error`、`timeout` 或 `not_attempted`。指标字段可以暂时省略，但启用对应成本 Gate 后，缺失指标会导致 Gate 失败，不能被当作零成本。

## 配对评测入口

```bash
npm run rsi -- evaluate compare \
  --benchmark benchmarks/examples/swebench-rsi-smoke/benchmark.json \
  --policy evaluation/policies/rsi-mvp.json \
  --baseline evaluation/examples/selection-baseline.jsonl \
  --candidate evaluation/examples/selection-candidate.jsonl \
  --run-id smoke-selection-001 \
  --baseline-revision baseline-demo-v1 \
  --candidate-revision candidate-demo-v2 \
  --partitions feedback,selection \
  --evolution evaluation/examples/evolution-ledger.json \
  --output .rsi/reports/selection.json
```

最终评测需要显式解锁 sealed Partition：

```bash
npm run rsi -- evaluate compare \
  --benchmark benchmarks/examples/swebench-rsi-smoke/benchmark.json \
  --policy evaluation/policies/rsi-mvp.json \
  --baseline evaluation/examples/final-baseline.jsonl \
  --candidate evaluation/examples/final-candidate.jsonl \
  --run-id smoke-final-001 \
  --baseline-revision baseline-demo-v1 \
  --candidate-revision candidate-demo-v2 \
  --partitions final \
  --allow-sealed \
  --output .rsi/reports/final.json
```

报告固定记录 Run ID、Baseline Revision 与 Candidate Revision，并包含每个 Partition 的记录覆盖率、任务完成率、Resolved Rate、Wilson 区间、成本、Token、延迟、违规数量，以及配对的 `newlyResolved/regressed/netResolved/deltaResolvedRate` 和确定性 Bootstrap 区间。Policy 可以分别要求完整结果记录和足够的完成率，避免把大量 `not_attempted/error/timeout` 当作有效评测。

只有 Policy 的 `decisionPartition` 会产生 `promotion` 决策；单独运行 `final` 时只生成 `report-only` 报告，避免使用 Final Test 反复选择 Candidate。未提供 `--allow-sealed` 时，CLI 不仅拒绝请求 `final`，也会拒绝任何提前混入 Final Instance 的结果文件。

## 当前边界

本入口已经实现 Benchmark/Policy/Result 校验、配对指标和 Gate，但不直接启动 SWE-bench Docker Harness。`environments/swe-bench.yml` 定义官方 Harness 的外部执行契约；下一步需要实现 Runner 与 Normalizer，把官方逐题结果转换成上述标准 JSONL。Evaluator 代码、Policy、Benchmark Manifest 和 sealed 数据必须由 Controller 管理，不能挂进 Updater Candidate。
