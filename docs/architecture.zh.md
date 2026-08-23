# 独立 RSI 控制平面架构

[English](architecture.md) | 中文

## 决策

DeepSeek Harness RSI 使用独立 GitHub 仓库作为可信控制平面，不再以 DeepSeek Harness Fork 作为主仓。官方 DeepSeek Harness 的历史只通过固定的 `sources/deepseek-harness/` 集成子模块进入系统，Updater 永远不直接修改该目录。在 `hzy_dev` 上，子模块指向开发 fork，使 headless preset 集成提交可被拉取，同时保留官方历史。

这个决策解决两个问题：一是把可变 Solver 与不可变评测根分开；二是让 DeepSeek Harness、pi-agent 等项目都能通过 Adapter 成为 Target 或 Updater，而不需要改变 Controller 的核心流程。

## 五类对象

| 对象        | 负责什么                                                   | 是否允许 Updater 修改 |
|-------------|------------------------------------------------------------|------------------------|
| Source      | 保存可信、固定的上游源码 Revision                          | 否                     |
| Solver      | 在任务环境中真正解题                                       | 只修改其 Candidate     |
| Updater     | 读取反馈和源码，在一个 Session 内分析、提出假设并改 Candidate | 不修改自身运行底座     |
| Controller  | 实例化、权限、调度、Diff 校验、谱系、晋升和回滚            | 否                     |
| Evaluator   | 用冻结任务、Rubric、成本和安全 Gate 比较 Baseline/Candidate | 否                     |

Updater 内部无需固定的失败分析器、提案器、构建器或搜索策略服务。它可以在一次上下文中自由推理；Controller 只接收结构化证据、源码 Diff 和 Mutation Report。

## 一轮进化

```text
固定 Source Revision
-> 创建 Baseline 实例和 Candidate 实例
-> Baseline 跑训练任务并生成客观 Feedback Packet
-> Controller 选择 L1、L2 或 L3
-> 启动一个独立 Updater Session
-> Updater 分析一批案例并修改 Candidate
-> Controller 拒绝越界 Diff，构建 Candidate
-> Baseline/Candidate 在同条件下运行训练、回放和隐藏评测
-> 冻结 Gate 决定 Reject、Revise 或 Promote
-> 保存不可变 Candidate、结果、父版本和决策原因
```

## 运行目录

生产 PutnamBench Campaign 的可变状态位于 Git 工作区之外。仓库、持久化根与临时根必须两两分离；sealed test 子树不会挂载进任何非可信阶段。默认开发机布局是：

```text
/mnt/data/hzy/dsh-rsi-runtime/
  campaigns/<campaign-id>/
    public/                 # 可恢复状态、摘要、提案、不透明 test receipt
    private/                # 验证逐题结果、Trace 与 Checkpoint
    candidates/             # 不可变 baseline/candidate 谱系
    sealed/test/            # Solver 与 Updater 均不可读的测试记录
    report/                 # Campaign 关闭后才生成
  runtimes/<campaign-id>/   # 离线构建并冻结的评测实例
  datasets/PutnamBench/     # 固定的数据与 mathlib 工程
  trusted-baseline/         # 预构建的固定 Harness Source
  pnpm-store/               # root 持有的离线构建输入
  control/                  # 经字节校验的 runtime patch

/dev/shm/dsh-rsi/
  <campaign-id>/            # 可丢弃的 Updater 与评测工作区
```

Candidate 从固定子模块做内容复制，不向非可信进程暴露其 Git 对象。Updater 只能看到当前 Candidate、验证反馈、提案和当前阶段可写路径，不能看到 `.git`、Controller 仓库、数据集、测试 Manifest、sealed vault、凭据或其他 Candidate。评测时 Candidate Source 只读挂载。Build、Solver、Updater、Verifier 使用不同宿主身份与 bubblewrap 挂载命名空间；只有当前网关的精确 UID/端口会获得临时防火墙租约，Verifier 则完全没有网络命名空间。

## 变异边界

只靠 Prompt 不能限制 Updater，完整约束由三部分组成：

- 语义约束：Prompt 解释本轮目标、层级和禁止事项。
- 写入约束：沙箱仅把当前层级路径暴露为可写。
- 结果约束：Controller 重新计算 Diff，任何越界、凭据、安全根或协议破坏都直接淘汰。

L1、L2、L3 是 Target Adapter 的语义，不应假设所有 Agent 目录相同。DeepSeek Harness 的 L1 可以对应 Preset，pi-agent 的 L1 可能对应另一套配置；Controller 只理解“当前层级白名单”，不写死具体目录。

## 反馈与泛化

Feedback Packet 应包含聚合指标、代表性成功/失败案例、Trajectory、Verifier 输出、成本、延迟和环境信息，但不提前写死失败因果。Updater 负责从跨案例证据中判断应该改变哪种策略或实现。

当前 PutnamBench 策略使用一个自适应验证 Partition 与一个操作上隐藏的 Test Partition。只有验证集 Lean kernel verified count 严格增加才能晋升。每个点仍会测 Test，但 Test 不能影响晋升、回滚、重试、层级切换或停止。Candidate 只能影响解题过程，不能影响题目、最终评分、资源计量或晋升规则。

## Benchmark 与双层评测

生产 Adapter 面向 PutnamBench-Lean。Manifest 固定数据集、Lean、mathlib、Harness Revision、模型契约，以及两个按完整年份切开的 Partition：500 道验证题和 172 道测试题。验证分数与 Trace 可以进入下一轮 Updater。主 Controller 只加载验证题 ID；只有独立 Broker 子进程会打开并校验测试 Manifest，并把逐题结果写进 sealed vault。Campaign 关闭前，父进程只能得到不透明完成回执。

Solver 给出主定理的 proof replacement。独立可信重放把证明放回冻结题面模板，再交给固定 Lean kernel 编译；占位证明、新公理、改题面、危险文件类型和越界写入都会被拒绝。因此，模型可以在没有人工失败分类器的情况下选择变异，而正确性仍由客观内核裁定。

通用标准结果与三 Partition API 仍可用于 Adapter 实验；SWE-bench YAML 目前只是契约占位，不属于已经实现的 PutnamBench 生产路径。

## 子模块更新语义

主仓固定一个 DeepSeek Harness SHA，所以每轮实验的 Source 可复现。`git submodule update --remote` 只是在本地取得上游新提交；只有把新的子模块指针提交到主仓后，它才成为新的可信 Source Revision。旧 Candidate 仍记录旧 SHA，不随上游更新漂移。

## 已实现的生产路径

PutnamBench 路径现已包括：冻结 Manifest、精确 Source 实例化、L1/L2/L3 Diff 边界、提案/应用两阶段 Updater、Candidate 离线构建、逐题 Checkpoint、验证反馈、仅子进程可见的 sealed test、严格晋升与回滚、崩溃安全 Campaign 状态、单写者锁、实现与 Runtime 证明、仅 FD 凭据，以及关闭后的 JSON/CSV/Markdown/SVG 报告。下一项泛化里程碑是实现第二个完整 Environment Adapter；仓库现有 SWE-bench 文件本身不代表已经完成该目标。
