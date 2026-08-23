# PutnamBench-Lean Harness RSI 实验协议

[English](putnambench-evolution.md) | 中文

## 实验问题

本实验只回答一个问题：在模型、推理强度、单题预算和数据集固定时，让 Updater 根据验证集表现与 Solver trace 开放式分析并依次修改 Harness 的 L1、L2、L3，能否提高 Candidate Harness 的 Lean 证明通过率。

验证集参与提案和晋升；测试集只记录冻结 Candidate 的表现，在整个进化闭环结束前不向 Updater、Controller 决策分支或实验操作者返回分数、逐题结果和 trace。PutnamBench 是公开数据，因此这里的 hidden 指防止实验内自适应泄漏，而不是宣称模型未在预训练中见过题目。

## 冻结输入

| 项目 | 固定值 |
|---|---|
| PutnamBench revision | `dfb0a47a1c1ec3a10f2a9acfdf41a2043920f33c` |
| Lean | `v4.27.0` |
| mathlib | `a3a10db0e9d66acbebf76c5e6a135066525ac900` |
| Harness source | `3289531e06e924abb790685f44baf67311f26ec9` |
| 主模型 | `gpt-5.6-sol`，Responses API，reasoning effort `max` |
| Solver preset | `standard`，headless profile |
| 验证集 | 500 题，48 个完整年份 |
| 测试集 | 172 题，16 个完整年份 |
| 晋升指标 | 验证集 Lean kernel verified 数量 |
| 层级耐心 | 每层连续 3 次无严格提升后进入下一层 |

主曲线在 request、题目、分区或 Candidate 任一粒度都不自动切换 Provider。ZCloud 持续发生基础设施故障时只暂停该 campaign；DashScope 的 `qwen3.8-max` 或 `deepseek-v4-pro` 只能用新的 provider/model fingerprint 启动独立 campaign，并单独画曲线。Provider、模型、effort 或预算变化均不能续接主曲线。凭据只从继承的匿名文件描述符读取一次，不进入 argv、环境变量、文件或实验产物。

## 按来源和类别拆分

拆分的基本分组是竞赛年份，同一年的 A/B 题不会跨验证集和测试集。测试年份为：

```text
1964, 1969, 1972, 1975, 1986, 1988, 1991, 1997,
1998, 2003, 2007, 2014, 2016, 2017, 2020, 2024
```

剩余年份进入验证集。选择该组合时同时平衡官方多标签类别、A/B、题号和年代；类别保留多标签，不把一道题强制压成单一类别。最终以排序后的 ID manifest 为准：

```text
validation.ids  sha256 0a9c8fb73194e023da449a7bc41755d07c7aaf3d7ec461c47c765541571f2760
test.ids        sha256 2204168d092c0c322d1eedf952bd6e57def58985f35fc24564458aec74e78236
```

数据发现以 672 个 Lean 文件为主表，再 inner join `informal/putnam.json`；元数据中没有 Lean 文件的 `putnam_1997_a1` 必须排除。

## 进化状态机

```text
CREATED -> CONFIG_FROZEN -> BASELINE_FROZEN -> BASELINE_EVALUATED
        -> EVOLVING_L1 -> EVOLVING_L2 -> EVOLVING_L3
        -> CLOSING -> CLOSED -> REPORTED
```

基础设施故障进入 `PAUSED_INFRASTRUCTURE` 并重试，不计入一次无效 mutation；凭据泄漏、manifest/hash 变化或越权 diff 进入 `ABORTED_SECURITY`；显式预算上限耗尽进入 `STOPPED_BUDGET`。

核心循环如下：

1. 从当前 incumbent 复制不可变 Candidate，先冻结 mutation proposal，再允许 Updater 改动。
2. Controller 校验 Candidate 只修改当前层级允许路径，构建并冻结内容 digest。
3. Candidate Harness 在相同模型、effort、预算下分别运行 500 道验证题和 172 道测试题。
4. 验证结果与 trace 写入反馈区；测试结果与 trace 只写入 sealed vault，主循环只得到不含分数的完成 receipt。
5. 只有 `candidate.validation_verified > incumbent.validation_verified` 才晋升；持平、下降或 Candidate 自身失败均回退，incumbent 不变。
6. 晋升后当前层的连续无效计数清零；连续三次没有严格提升则继承当前最佳 Candidate 进入下一层。
7. L3 连续三次没有严格提升后关闭实验，随后一次性解封所有测试聚合分数用于报告。测试结果从不参与晋升、层级迁移、停止或重试决策。

基线和每个 Candidate 都必须运行两个分区，所以即使某轮验证失败也保留对应测试点。系统不承诺测试曲线单调上涨；报告必须展示原始点，不能平滑、挑点或用测试集选最好版本。

## L1、L2、L3

三个层级是从外到内、自顶向下的风险递增搜索：先改声明式解题策略，再改扩展能力，最后改 Solver 核心。每一轮只激活一个层级；进入更高层时继承上一层最佳状态。

- L1：`apps/cli/config/agent-presets/**`。可改变系统提示、工作流、默认工具组合、上下文/计划策略等声明式配置，不改执行实现。
- L2：compaction、context、extensions、guard、hooks、LLM retry、plan、preset、skill、subagent、todo、workflow、web，以及文件/交互/shell 工具实现。不可改 Agent Loop、Session Core 和信任根。
- L3：Candidate 内的 apps、packages、native、python 与构建配置，可修改 Solver Core。Controller、Evaluator、数据 manifest、vault、凭据、计量、晋升逻辑和固定 Source 始终在 Candidate 外。

当前层 Candidate 可以保留从较低层继承的改动，但本轮新增 diff 必须至少触及当前层专属路径，且不能触及更高层或永久只读路径。

## Updater 与 Solver 的职责

Solver 是被评测对象：它一次只看到一道 solution-patched Lean 题，在隔离工作目录中尝试填主 theorem 证明。Updater 是进化模型：它读取 incumbent 的验证集汇总、代表性成功/失败 trace 与 Candidate 源码，先写一份可证伪的 proposal，再做最小完整代码修改。Controller 不提供人工错误类别或固定 mutation 模板。

每份 proposal 在修改前冻结，至少包含：主要改进方向、跨案例证据、假设、预期机制、目标文件和风险。最终折线图上的改进标签来自这份事前 proposal，不能看完测试结果后补写故事。

## 正确性与隔离边界

“不用 rule-based verifier”不等于让模型自己宣布证明正确。分数必须由可信 Lean kernel replay 给出；人工规则不参与失败归因或提案生成。运行器使用官方 `rewrite_solutions.py` 生成给定答案版本，只允许 Solver 填主 theorem proof，并在可信模板中重建后编译。`sorry`、`admit`、新增公理、statement 变化以及越权写入均不能计分。

验证与测试任务使用不同的短生命周期目录和独立 `DSH_HOME`。Solver、Updater、Build、Verifier 使用不同的宿主 UID/GID；不可信阶段经 `setpriv` 与 bubblewrap 运行，具有私有进程/临时目录 namespace、显式最小挂载和双栈 fail-closed egress，Verifier 还使用无网络 namespace。Candidate 源码在评测时只读；每个进程只获得当前题目。Updater 不挂载 Controller 仓库、数据集根、测试 manifest、sealed vault、测试 receipt 明细或其他 Candidate 的工作目录。只有 sealed broker 子进程能打开并按冻结 digest 校验测试 manifest；主 Controller 在关闭前不会实例化测试 ID。

可信验证账本保留真实完成时间和延迟，供终态墙钟报告使用，但绝不挂载给 Updater。每次生成 proposal 前，Controller 都重新构建一个独立只读投影，其中只有验证分数、逐题结果和清洗后的 trace 内容；投影会移除绝对时间戳字段、规范化文本时间戳和所有文件 mtime，并在 proposal/apply prompt 中使用逻辑 `createdAt` 标记。相对的验证耗时、延迟、token 用量和推理内容仍作为有用验证证据保留。因此 Updater 无法从“验证结束到下一次 proposal”的间隔推测 sealed test 耗时，也不需要昂贵的固定时长 padding。

## 不可变产物

```text
/mnt/data/hzy/dsh-rsi-runtime/campaigns/<campaign-id>/
  public/
    config.snapshot.json
    state.json
    events.jsonl
    candidates/<id>/proposal.json
    candidates/<id>/mutation-bundle.json
    candidates/<id>/build.json
    candidates/<id>/validation-summary.json
  private/
    validation/<candidate-id>/...     # 可信原始验证账本，不挂载给 Updater
    feedback/<candidate-id>/...       # 每轮重建的无时间反馈投影
    checkpoints/validation/...
  sealed/
    test/<candidate-id>/summary.json
    test/<candidate-id>/records.jsonl
    test/<candidate-id>/receipt.opaque.json
    test/<candidate-id>/receipt.internal.json
    test/<candidate-id>/traces/...
  candidates/<id>/workspace/          # frozen after mutation
  report/curve.csv
  report/curve.svg
  report/improvements.md
```

Proposal 使用原子 write-once 提交。Mutation report、经校验的 diff、round outcome、实际评测目标和冻结 workspace digest 合并为单个原子 `mutation-bundle.json`；恢复时必须重新计算 workspace digest，一致才推进 checkpoint，不一致直接安全终止。`state.json` 是权威账本，`events.jsonl` 则在 state 提交后从完整事件历史原子重建，因此崩溃最多让派生日志暂时落后，不能让日志领先于 state。

Proposal 或 apply 输出不符合 contract 时记为 `candidate_failure`：Controller 恢复 incumbent，但仍以本轮 Candidate ID 完整运行验证集与 sealed test，并计一次 miss。Provider、timeout、launcher 及其他被明确分类的运行故障只进入基础设施暂停，不消耗 patience。每个 Candidate 记录 parent digest、content digest、层级、模型/预算 fingerprint、起止时间、验证决策和 opaque test receipt。关闭前的普通状态与日志中不得出现测试题 ID、测试分数或可反推出分数的字段。

## 最终报告

横轴使用从 baseline freeze 开始的累计墙钟小时，纵轴同时画 validation 500 与 test 172 的通过率。图中保留 baseline、所有晋升/回退 Candidate、L1/L2/L3 区域、proposal 方向和晋升标记；另输出机器可读 CSV/JSON。报告同时列出每层尝试次数、主要改进方向、API/基础设施事件、总调用量、token、延迟和已知有效性威胁。
