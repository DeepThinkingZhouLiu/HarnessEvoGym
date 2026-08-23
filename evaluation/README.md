# Evaluator 与指标入口

评测分两层：Environment Verifier 判断单道 Cowork 任务产物质量；可信 RSI Evaluator 在同一 Instance 上配对比较 Champion/Candidate，并执行冻结晋升 Gate。

## Solver Result v2

```json
{
  "instance_id": "xlsx-recover-data",
  "status": "unresolved",
  "reward": 0.75,
  "trial_rewards": [0.5, 1.0],
  "trial_seeds": [20260824, 20260825],
  "seed_controlled": false,
  "input_tokens": 12000,
  "output_tokens": 3000,
  "latency_ms": 180000,
  "policy_violations": [],
  "artifacts": []
}
```

`reward` 必须位于 `[0,1]`，并等于 `trial_rewards` 的均值。v1 没有 Reward 时继续兼容：`resolved=1`，其他状态为 0。只有 feedback 记录允许携带详细 `feedback`；selection/final 一旦出现逐题反馈会被协议层拒绝。当前 Cowork POC 的八个上游 Verifier 实际只返回 0/1，因此连续 Reward 是接口能力，不是这批题已经具备的细粒度标签。

## 指标

| 指标                           | 含义                                                     |
|--------------------------------|----------------------------------------------------------|
| `meanReward`                   | Partition 上连续 Reward 平均值                           |
| `deltaMeanReward`              | Candidate-Baseline 的逐题配对 Reward 差均值              |
| `rewardImproved/Regressed`     | Reward 提升/回退的任务数                                 |
| `pairedRewardDeltaCi`          | 对逐题 Reward 差做确定性 Bootstrap                       |
| `resolvedRate`                 | 达到全通过阈值的比例                                     |
| `newlyResolved/regressed`      | 二值全通过状态的新解决与回退                             |
| `rewardGeneralizationGap`      | feedback Reward 提升减 final Reward 提升                 |
| `tokens` / Token Delta         | 完整 Usage 下的输入+输出 Token 与 Candidate 相对涨幅     |
| `policyViolations`             | 越权、非法 Reward 等安全违规                             |

Policy 还能检查记录覆盖、完成率、Token/延迟涨幅、推理费用涨幅和总进化费用。未知指标保持 `null`；启用相关 Gate 后，未知值会失败，不能被当作零。

## 手工比较入口

```bash
npm run rsi -- evaluate compare \
  --benchmark benchmarks/cowork-skillsbench-poc/benchmark.json \
  --policy evaluation/policies/cowork-rsi-poc.json \
  --baseline <baseline-selection.jsonl> \
  --candidate <candidate-selection.jsonl> \
  --run-id <run-id> \
  --baseline-revision <digest> \
  --candidate-revision <digest> \
  --partitions selection
```

完整进化通常不需要手工调用；`evolve run` 会在 selection 上生成 promotion 决策，`evolve finalize` 会单独解封 final 并生成 report-only 报告。Final 的配置和 Candidate 完整性预检通过后，实际回放只有一次 Attempt；成功或失败都不能再次解封。

## 小样本解释

当前 selection 只有两题，Policy 仅要求至少一题 Reward 提升、均值不下降且无回退，没有要求 Bootstrap 下界大于零。这是工程 Smoke Gate，不是统计显著性声明。扩大正式 selection 后，应增加 Trial，并启用 `requirePositiveRewardCiLowerBound` 或预先注册更合适的统计准则。
