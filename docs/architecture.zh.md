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

Updater 内部无需固定的失败分析器、提案器、构建器或搜索策略服务。它在一次上下文中完成推理、修改、检查与提交；Controller 只接收 Git commit 和客观 validation 结果。

## 一轮进化

```text
固定 Source Revision
-> 创建 Baseline 实例和 Candidate 实例
-> Baseline 跑训练任务并生成客观 Feedback Packet
-> 向 Updater 提供 Target 配置的完整 L1/L2/L3 目录
-> 启动一个独立 Updater Session
-> Updater 分析证据、选择最小充分层级、修改并提交
-> Controller 检查 commit 形态与配置路径边界，再构建 Candidate
-> Baseline/Candidate 在同条件下运行训练、回放和隐藏评测
-> 冻结 Gate 决定 Reject、Revise 或 Promote
-> 保存不可变 Candidate、结果、父版本和决策原因
```

## 运行目录

生产 PutnamBench Campaign 的可变状态位于 Git 工作区之外。仓库、持久化根与临时根必须两两分离；sealed test 子树不会挂载进任何非可信阶段。默认开发机布局是：

```text
/mnt/data/hzy/03_dsh_rsi/dsh-rsi-runtime/
  campaigns/<campaign-id>/
    public/                 # 可恢复状态、摘要、提案、不透明 test receipt
    private/                # 验证逐题结果、Trace 与 Checkpoint
    candidates/             # 不可变 baseline/candidate 谱系
    sealed/test/            # Solver 与 Updater 均不可读的测试记录
    report/                 # Campaign 关闭后才生成
  runtimes/<campaign-id>/   # 指向冻结评测实例的受信别名
  runtime-cache/v1/<sha256>/ # 经证明的内容寻址冻结构建
  datasets/PutnamBench/     # 固定的数据与 mathlib 工程
  trusted-baseline/         # 预构建的固定 Harness Source
  pnpm-store/               # root 持有的离线构建输入
  control/                  # 经字节校验的 runtime patch

/mnt/data/hzy/03_dsh_rsi/s/
  <campaign-id>/            # 可丢弃的 Updater 与评测工作区
```

每个 Campaign 的 Runtime 路径都是指向共享缓存的受信只读别名。缓存键绑定
Candidate 源码摘要、Benchmark、固定 Node/pnpm 版本、构建配方、操作系统与架构。
命中时先校验冻结证明和关键启动闭包；任何不一致都 fail closed。只有 miss 才会
遍历不可变依赖仓，并执行离线安装、构建与全树冻结。

基础设施重试按阶段独立计数：Solver 与 Verifier 各自拥有冻结配置中的完整重试
额度，Solver 恢复时不会消耗 Verifier 的额度；重试采用带抖动的指数退避。网关还会
把 Provider 明确返回的 HTTP 400 `upstream_error` 归一化为不含敏感内容的基础设施
审计分类，普通的 Candidate 请求 400 仍保持 Candidate 错误。

轻量线性路径只在 Campaign 初始化时创建一个 Candidate Git worktree 和独立 Git 元数据目录，后续轮次反复复用。Updater 只能看到这个 Candidate、验证反馈和只读 evolution log，不能看到 Controller 仓库、数据集、测试 Manifest、sealed vault、凭据或其他 Candidate。评测时 Candidate Source 只读挂载。Build、Solver、Updater、Verifier 使用不同宿主身份与 bubblewrap 挂载命名空间；当前 HLE 路径通过 Unix socket relay 访问隐藏凭据的模型网关，同时保持 Solver 与 Updater 网络命名空间隔离。

## 变异边界

L1、L2、L3 是软搜索分类，其说明和路径属于 Target Runtime 配置。在 `updater-soft` 模式下，每轮 Prompt 都拼接完整三层目录；提示词指导 Updater 优先选择最小可行的 L1 改动，只有 validation 证据表明收益递减或故障机制更深时才外扩到 L2/L3。

- 语义指导：Prompt 说明三层、累计可写路径和禁止事项。
- 自声明：唯一 commit 必须使用 `rsi(l1|l2|l3): ...` 记录本轮选择和方向。
- 轻量结果审核：Controller 只要求一个后继 commit、干净 worktree、合法声明层级，以及全部改动路径位于该层且不属于永久禁止区。

该模式下 Controller 不替 Updater 选层，不累计三次 miss，也不自动升层。Validation 严格提升才保留 commit，否则同一 worktree reset 到 incumbent；若没有证据支持的新方向，Updater 可以显式结束无限轮次 Campaign。旧冻结实验仍可使用兼容的 `controller-sequential` 模式。

L1、L2、L3 是 Target Adapter 的语义，不应假设所有 Agent 目录相同。DeepSeek Harness Preset 与 MSA-derived math Harness 位于不同路径；Controller 只理解规范化后的配置白名单。

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

控制平面现已包括：冻结 Manifest、精确 Source 实例化、可配置 L1/L2/L3 Diff 边界、单 Session Git 变异、Candidate 构建、逐题 Checkpoint、验证反馈、仅子进程可见的 sealed test、严格晋升与回滚、崩溃安全 Campaign 状态、单写者锁、实现与 Runtime 证明、仅 FD 凭据，以及关闭后的 JSON/CSV/Markdown/SVG 报告。MSA-derived minimal Target 提供轻量 math/reasoning 路径；仓库现有 SWE-bench 文件仍只是契约占位。
