# pnx-dev 交接说明

## 版本边界

- 分叉基线：`lz-dev@918d8efe190fedbeb65b5ccde8371085f8037cf8`
- 当前 GRHS 语义提交：`7d311425ecdab87fb0e6bbdff1863d4913555920`
- `sources/deepseek-harness/` 始终是只读上游；RSI 功能由 Controller 在 `.rsi/` 中实例化并运行。
- liuzhou 原有的根 README、架构文档和 Cowork MVP 文档已保留，并恢复为分叉点内容。

## 分叉后实现概况

分叉后的有效代码扩展主要包括：

- 通用 Candidate、MutationLease、Mutation Catalog、Updater Runner 和 Diff Guard。
- 可插拔 Target、Environment、Updater、Search Strategy 与 Evolution Recipe。
- Cowork OfficeVal 环境、Model Gateway、AgentBay Docker bridge、按题 checkpoint 和基础设施恢复。
- MSA Minimal Cowork/Reasoning Target，以及 HLE、PutnamBench 和文本推理运行路径。
- Population Controller、五种演化模式、BaselinePack、sealed-final broker、资源计量和状态报告。
- 最小 GRHS Group Controller：从同一 Champion 生成 sibling MutationPlan，复用独立 Lease、Updater、Evaluator、promotion/rollback 和日志组件，再计算组内相对优势。

这些能力均位于 Controller 信任边界；Candidate 和 Updater 不能读取 sealed final、Evaluator Policy、凭据或 Controller 决策逻辑。

## 当前 GRHS 机制

当前实现与 liuzhou 原始线性 Controller 的晋升语义对齐：

```text
utility_g = selection_delta_mean_reward_g
advantage_g = (utility_g - group_mean) / (group_stddev + epsilon)
```

- `evaluation.decision.eligible` 是唯一晋升门槛。
- Group Controller 只在 eligible sibling 中按 `deltaMeanReward` 从高到低排序。
- 平分时按 Candidate ID 确定性决胜。
- 有效 sibling 少于 `minimumValidCandidates` 时不做 relative update，并回滚。
- 没有 sibling 通过 Evaluator Gate 时回滚。
- relative advantage 只用于更新 Region proposal prior，不增加第二套晋升 Policy。

旧实验性字段 `qualityLowerBound`、`regressionPenalty`、`costPenalty`、
`complexityPenalty` 和 `promotionMargin` 已移除。GRHS 配置只保留
`groupSize`、`minimumValidCandidates`、`advantageEpsilon` 和
`priorLearningRate`。

主要入口：

- `controller/src/grhs.mjs`：确定性 sibling 计划、组内打分和 proposal prior。
- `controller/src/cowork-orchestrator.mjs`：复用现有可信组件执行完整 GRHS round。
- `controller/test/grhs.test.mjs`：确定性、打分、Gate、平分、失败和 rollback 测试。
- `experiments/cowork-msa-grhs-smoke-codex.json`：一轮 smoke。
- `experiments/cowork-msa-grhs-formal32-codex.json`：32 轮正式配置。

## 已完成的 quick9 决策

最终可审计 Run：

```text
.rsi/runs/grhs-agentbay-quick9-liuzhou-20260904-01
```

该 Run 从 `grhs-agentbay-formal32-20260902-03` 复用了 H0、s001、s002
在同一组 9 个 Selection task 上的 committed checkpoint，没有重新调用
Updater、Solver、OfficeVal 或模型。使用的 task 为：

```text
officeval_002 officeval_034 officeval_036 officeval_040 officeval_049
officeval_055 officeval_062 officeval_064 officeval_075
```

因原网关空响应而未纳入本轮的两个 task 是 `officeval_058` 和
`officeval_076`。三方均按相同 9-task Selection 集合比较。

结果：

| Candidate | Eligible | Mean reward | Delta mean reward | 结果 |
| --- | ---: | ---: | ---: | --- |
| `g001-grhs-s001-l2` | true | 0.073523 | +0.019543 | promoted |
| `g001-grhs-s002-l2` | false | 0.003086 | -0.050894 | rejected |

新 Champion 是 `g001-grhs-s001-l2`，Run 状态为 `completed`，
`rollbackReason` 为 `null`。审计入口是该 Run 的 `state.json` 与
`generations/generation-1/grhs-group/group-decision.json`。

为保留证据链，当前只保留上述成功 Run 和它的源 Run
`grhs-agentbay-formal32-20260902-03`；其他本地试跑已清理。

## 验证状态

- `npm run check`：通过。
- GRHS 单测与配置测试：11/11 通过。
- 当前保留的 smoke 与 formal32 GRHS Experiment：均通过 `experiment validate`。
- 全套测试：447/448 通过。
- 唯一已知失败位于 `controller/test/cowork-recovery.test.mjs`：旧测试期待归档
  trial result，而当前恢复逻辑会保留可复用 checkpoint。这是清理前已存在的测试/行为
  不一致，不是当前 GRHS 晋升逻辑导致。

## 后续操作

运行正式实验前需要在运行时注入 Provider 与 AgentBay 凭据，并确保 OfficeVal
Dataset/Evaluator 固定版本通过 preflight。不要将凭据写入 Experiment、Candidate、
反馈包、轨迹或 Mutation Report。

下一步若继续扩展 GRHS，应优先增加 sibling 并行调度、组失败的有界重试和更多轮次
验证；不要把 LCB 或成本/复杂度惩罚重新放进 Group Controller。任何新的晋升约束都应
显式修改可信 Evaluator Policy，而不是建立第二套隐藏 Gate。
