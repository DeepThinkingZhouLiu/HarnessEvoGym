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

完整 AgentBay 组合位于
[`experiments/cowork-msa-grhs-formal32-codex.json`](../experiments/cowork-msa-grhs-formal32-codex.json)。
它在正式 55 feedback、18 selection、18 sealed-final Split 上冻结相同 GRHS 策略并运行
32 代；进化阶段永远不会读取 sealed-final Partition。

运行时值只通过 `RSI_PROVIDER_BASE_URL` 和 `RSI_PROVIDER_API_KEY` 注入。真实运行前，
Codex distribution、OfficeVal Dataset Root 和 Evaluator Root 都必须通过 preflight。
Experiment、Candidate、Feedback Packet、Trace 和 Mutation Report 均不得保存凭据。

Smoke 组合使用 AgentBay Environment 变体。Controller 每个 Run 保持一个 AgentBay VM，
并在 VM 内复用现有 Docker 隔离模型；每个 Trial 前上传挂载输入，结束后只回传可写挂载。
`AGENTBAY_API_KEY`、VM Image ID 与 Policy ID 都是运行时环境变量，不进入 Experiment。

`experiment baseline` 可直接用于这个不带 Recipe 的 GRHS 组合：它只运行 H0
selection，记录为零变异预算消耗，并在不启动 Updater Session 的情况下退出。

当 root Controller 宿主明确禁用非特权 user namespace 时，Codex Updater 只在核验
`user.max_user_namespaces=0` 后启用特权 Bubblewrap launcher。在这个 capability 受限的
fallback 内，冻结 Codex 进程只为访问隐藏凭据的 loopback relay 而共享宿主网络，它只能
拿到一次性 dummy key，不会拿到 Provider 密钥或宿主配置。随后 Launcher 建立现有
mount/PID/IPC/UTS/cgroup 边界，最后降到
UID/GID 65534，清空附加组与所有 capability set，并设置 `no_new_privs`。其他宿主
仍使用原有 rootless launcher。
隔离的 Codex Session 直接执行固定 npm distribution 内的静态原生二进制，并用字节流
loopback-to-Unix-socket relay 转发模型请求，不把宿主 Node runtime 或 DSW 动态库树带入沙箱。
冻结启动参数还会关闭 Codex 插件、浏览器/应用集成、Skill 与 Workspace 依赖发现、
shell snapshot、远端压缩和无限重试。这些交互功能不属于 Updater 合约，而且可能在受限
Updater runtime 内阻塞启动。

当前限制：MVP 依次调度 sibling Updater/Solver。AgentBay bridge 在单 VM 内串行启动
远端 Trial、并行执行已启动的 Trial；正式 feedback split 的 55 条 Trial 可全部并行，
通用平台并发上限为 200。Provider 没有可信 Rate Card，因此暂用
Token 增量作为成本代理；有效 sibling 少于两个时不在本轮预算内重试。更大候选组、
有界重试和 sibling 级并行调度留到后续阶段。
