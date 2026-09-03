# Cowork 主实验与消融协议

本文固定 OmegaUse-OfficeVal 主实验的配置口径。它描述的是实验入口和可复现约束，不包含任何 Final 逐题结果或 Provider 凭据。

## 数据与晋升口径

主表使用 `benchmarks/cowork-omegause-officeval-main-v1/benchmark.json`：

| Partition | 数量 | 用途                                     | Updater 可见性             |
| --------- | ---: | ---------------------------------------- | -------------------------- |
| Feedback  |   18 | 生成 Bad Case、轨迹与修改反馈            | 可见详细反馈               |
| Selection |    8 | Candidate 与当前 Champion 配对，决定晋升 | 不向 Updater 暴露逐题结果  |
| Final     |   18 | 进化结束后的密封泛化评测                 | 不可见                     |

默认 Policy 是 `evaluation/policies/cowork-officeval-rsi.json`，其 `decisionPartition` 为 `selection`。因此主表的流程是：

```text
Champion 做 18 道 Feedback
-> Updater 修改并生成 Candidate
-> Candidate 与 Champion 做同一组 8 道 Selection
-> 只在 Candidate 通过 Gate 时晋升
```

对照实验可以改用 `benchmarks/cowork-omegause-officeval-train-test-v1/benchmark.json` 和 `evaluation/policies/cowork-officeval-in-sample-rsi.json`。此时 `decisionPartition=feedback`，Selection 允许为空，产生反馈的同一组 18 道训练题同时决定晋升。两种口径都受同一 Controller 约束，但结果必须分列报告，不能直接混在同一主表里比较。

本次训练集内晋升主表使用 `benchmarks/cowork-omegause-officeval-train26-test18-v1/benchmark.json`：它把原来的 18 道 Feedback 与 8 道 Selection 合并成 26 道 Feedback，Selection 为空，Final 仍保留原来的 18 道密封题。因此 Updater 根据同一组 26 道题的详细轨迹修改 Candidate，Controller 也根据这 26 道题的配对 Reward 决定是否晋升。这一口径属于训练集内选优，必须与 18/8/18 的留出验证口径分开报告。

## 主表配置

| Mode        | Branch 数 N | 总 Candidate Budget B | Search Strategy   | 可变层级 |
| ----------- | -----------: | ---------------------: | ----------------- | -------- |
| single      |            1 |                     16 | linear-hill-climb | L1+L2+L3 |
| independent |            2 |                     16 | linear-hill-climb | L1+L2+L3 |
| mutualism   |            2 |                     16 | linear-hill-climb | L1+L2+L3 |
| competition |            2 |                     16 | linear-hill-climb | L1+L2+L3 |
| combined    |            2 |                     16 | linear-hill-climb | L1+L2+L3 |

这里的 B16 是整个 Mode 的总 Candidate 次数。Single 的一个 Branch 最多尝试 16 次；N2 Mode 的两个 Branch 合计最多尝试 16 次，基础预算通常各为 8 次，竞争模式可能重新分配剩余预算。

五个主表 Experiment 位于 `experiments/cowork-msa-main16-codex-*.json`，五个 Recipe 位于 `recipes/population-main-linear-16/`。

训练集内晋升版本位于 `experiments/cowork-msa-main16-in-sample-codex-*.json`。它复用同一组 Recipe，所以仍是 Single=N1-B16、其余 Mode=N2-B16、线性模块搜索和 L1+L2+L3 全搜索空间；唯一的评测差别是 26 道 Feedback 同时承担反馈与晋升决策。

## Checkpoint 口径

Checkpoint 只保存稳定状态下的 Candidate 身份、Champion、各 Branch Incumbent 和 Latest Attempt 索引，不会自动解封或评测 Final。

| 范围       | Single 里程碑       | N2 Mode 里程碑       | 含义                                  |
| ---------- | ------------------- | -------------------- | ------------------------------------- |
| Population | B0/2/4/6/8/10/12/16 | B0/4/8/12/16         | 所有 Branch 合计消耗的 Candidate Budget |
| Branch     | G2/4/6/8/10/12/16   | 每个 Branch G2/4/6/8 | 该 Branch 实际完成的 Candidate 次数  |

如果一个 N2 Wave 跨过某个 Population 里程碑，Checkpoint 会同时记录请求里程碑与实际到达的总 Budget。竞争模式中 Branch 获得的次数可能不均匀，因此 Branch Checkpoint 按每个 Branch 的实际完成次数单独捕获。被拒绝 Candidate 也保留在 Run 目录中，Checkpoint 的 `latestAttempt` 可以定位相应版本。

## 层级消融

完整配置开放 MSA Minimal Target 声明的全部六个 Region：

| 层级 | Region                          |
| ---- | ------------------------------- |
| L1   | profile-policy、skill-guidance  |
| L2   | agent-loop、tool-runtime        |
| L3   | model-transport、runtime-wiring |

消融 Recipe 位于 `recipes/population-layer-ablation-linear-16/`。`without-l1`、`without-l2`、`without-l3` 使用 `excludeRegions` 精确移除对应层，其余层仍保持开放。该约束会投影到 Mutation Catalog、Mutation Lease 和最终 Diff Guard，不能由 Updater 绕过。

## Updater 消融

当前已提供 Codex、Claude Code 和 DSH 三种 Updater 配置。Solver 固定为 MSA Minimal，Solver Provider 与 Updater Provider 可以分别配置。已知配置如下：

| Updater     | 配置入口                                             | 默认示例模型    |
| ----------- | ---------------------------------------------------- | --------------- |
| Codex CLI   | `experiments/cowork-msa-main16-codex-combined.json`  | gpt-5.6-terra   |
| Claude Code | `experiments/cowork-msa-main16-claude-combined.json` | claude-sonnet-5 |
| DSH         | `experiments/cowork-msa-main16-dsh-combined.json`    | gpt-5.6-terra   |

DeepSeek 4 Flash 必须在 Provider Adapter 中使用服务端真实模型 ID；在模型 ID 未确认前不创建猜测配置。

## 共用 H0 与并发启动

主表多个 Mode 必须导入同一份 Baseline Pack。启动脚本在同时运行多个 Mode 且没有配置公共 Pack 时会直接拒绝，避免五个 Mode 各自重跑出不同的 H0 轨迹和基线分数。

```bash
RSI_BASELINE_PACK_PATH=/absolute/path/to/baseline-pack.json \
RSI_BASELINE_PACK_SHA256=<sha256> \
RSI_SUITE_MAX_CONCURRENT_MODES=5 \
RSI_SUITE_MAX_CONCURRENT_SOLVER_TRIALS=6 \
RSI_SUITE_MAX_CONCURRENT_UPDATERS=2 \
node scripts/run-cowork-main16-five-mode.mjs
```

26 道训练集内晋升版本使用相同的公共 Pack 约束，入口是：

```bash
RSI_BASELINE_PACK_PATH=/absolute/path/to/baseline-pack.json \
RSI_BASELINE_PACK_SHA256=<sha256> \
RSI_SUITE_MAX_CONCURRENT_MODES=5 \
RSI_SUITE_MAX_CONCURRENT_SOLVER_TRIALS=6 \
RSI_SUITE_MAX_CONCURRENT_UPDATERS=2 \
node scripts/run-cowork-main16-in-sample26-five-mode.mjs
```

由于该版本的决策 Partition 就是 Feedback，公共 H0 可以由一次 Baseline-only Run 的 26 道 H0 结果直接导出。导出时会生成一份无搜索历史、无 Peer Evidence 的标准 FeedbackPacket，不会额外启动 Updater，也不会重复执行这 26 道题。

`RSI_SUITE_MAX_CONCURRENT_MODES` 控制同时启动多少个 Mode；另外两个参数是跨所有 Mode 共用的硬并发上限。默认允许五个 Mode 同时推进，但最多并发 6 个 Solver Trial 和 2 个 Updater Session，避免 Docker 与 Provider 瞬间过载。

## 验收边界

- 主表与消融必须固定同一 Target Seed、Solver 模型、题目 Split、Trial Seed、资源限制和晋升 Policy。
- H0 Baseline Pack 必须固定路径和 SHA-256；身份不匹配时 Controller 会拒绝导入。
- Checkpoint 只提供后续消融与离线评测所需的不可变索引，不会自动生成测试曲线。
- Final 只在进化配置冻结后运行；看到 Final 结果后不能再据此修改 Candidate 并重复宣称同一次密封测试。
- 五个 Mode 全开只提高墙钟速度，不减少 Solver/Updater 的总计算量和 Provider 成本。
