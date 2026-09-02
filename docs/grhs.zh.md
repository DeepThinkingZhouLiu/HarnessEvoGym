# Group-Relative Harness Search MVP

[English](grhs.md) | 中文

GRHS 把 training-free GRPO 的“组内基线”思想迁移到离散 Harness Revision
搜索，全程不训练 Solver 或 Updater 的模型参数。每轮由可信 Controller 固定同一个
父版本、Feedback Packet、Selection Partition、Seed 和预算，再从 Target 自己的
Region Catalog 生成至少两个 sibling MutationPlan。每个 sibling 都获得独立的
MutationLease，并启动一个完整 Codex Updater Session。

对每个有效 sibling `g`，Controller 计算：

```text
utility_g = selection_reward_delta
            - regression_penalty * paired_regression_rate
            - cost_penalty * relative_token_delta
            - complexity_penalty * normalized_patch_complexity

advantage_g = (utility_g - group_mean) / (group_stddev + epsilon)
```

越界 Diff、不安全结果、不完整评测和重复 Patch 不进入组内统计。有效 sibling
少于两个时跳过 relative update 并回滚；否则用 advantage 更新 Target Region ID
上的分类 proposal prior。只有通过冻结 Gate 且惩罚后 paired-bootstrap LCB
严格超过预注册 margin 的最佳 sibling 才会晋升。平分按 Candidate ID 决胜，保证
重放确定性。

不可变 Group Decision 会记录父子谱系、MutationPlan 和 Region ID、utility
分项、relative advantage、更新前后 proposal prior、LCB、晋升结果和回滚原因。
Final 在 Champion 冻结并显式 finalize 前始终 sealed。

MVP 配置位于
[`experiments/cowork-msa-grhs-smoke-codex.json`](../experiments/cowork-msa-grhs-smoke-codex.json)：

- Solver 使用 MSA Minimal Cowork RSI；
- Updater 使用 Codex CLI；
- 两个角色都固定 `gpt-5.6-terra` + `reasoningEffort: high`；
- 一轮 L2、两个 sibling；
- OmegaUse-OfficeVal Smoke 各运行一道 feedback 和 selection 任务。

运行时值只通过 `RSI_PROVIDER_BASE_URL` 和 `RSI_PROVIDER_API_KEY` 注入。真实运行前，
Codex distribution、OfficeVal Dataset Root 和 Evaluator Root 都必须通过 preflight。
Experiment、Candidate、Feedback Packet、Trace 和 Mutation Report 均不得保存凭据。

Smoke 组合使用 AgentBay Environment 变体。Controller 每个 Run 保持一个 AgentBay VM，
并在 VM 内复用现有 Docker 隔离模型；每个 Trial 前上传挂载输入，结束后只回传可写挂载。
`AGENTBAY_API_KEY`、VM Image ID 与 Policy ID 都是运行时环境变量，不进入 Experiment。

当前限制：MVP 依次调度 sibling Updater/Solver，首版 AgentBay bridge 也会在单 VM 内
串行化远端控制面操作；Provider 没有可信 Rate Card，因此暂用
Token 增量作为成本代理；有效 sibling 少于两个时不在本轮预算内重试。更大候选组、
有界重试、并行调度和正式 OfficeVal Split 留到后续阶段。
