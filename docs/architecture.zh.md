# HarnessEvoGym 通用控制平面架构

[English](architecture.md) | 中文

## 决策

HarnessEvoGym 使用独立 GitHub 仓库作为可信控制平面，不再以 DeepSeek Harness Fork 作为主仓。官方 DeepSeek Harness 的历史只通过固定的 `sources/deepseek-harness/` 集成子模块进入系统，子模块远端保持官方 `deepseek-ai/deepseek-harness`，Updater 永远不直接修改该目录。

这个决策解决两个问题：一是把可变 Solver 与不可变评测根分开；二是让 DeepSeek Harness、pi-agent 等项目都能通过 Adapter 成为 Target 或 Updater，而不需要改变 Controller 的核心流程。

## Target × Environment × EvolutionRecipe

Future 分支的 Population Controller 保留为算法基座，但它现在只消费通用
`BranchEvolutionDriver` 和 `EvaluationSummary`。Target 定义优化对象及可变 Region，
Environment 定义题目与评分，EvolutionRecipe 组合五种 Population Mode 与 Module Search。

| 组合                         | Branch 执行层                    | 环境与隔离                                                   | 搜索形式                         |
|------------------------------|----------------------------------|--------------------------------------------------------------|----------------------------------|
| MSA Cowork + SkillsBench     | 通用 Cowork Branch Driver         | Task 镜像、独立 Verifier、Docker internal network              | Recipe + SearchStrategy          |
| MSA Text Reasoning smoke     | 同一 Cowork Branch Driver          | 固定文本题、受信精确匹配、Docker internal network                | 同一 Recipe + SearchStrategy      |
| HZY Reasoning production    | 兼容 Reasoning Branch Driver       | 宿主独立 UID、bubblewrap、Unix gateway、sealed broker              | 旧 Campaign 配置映射到五种 Mode       |

Experiment 的 Chat Completions 网关生命周期在 `cowork-model-gateway.mjs`；HZY 生产 Reasoning 的 Responses/Unix-socket
网关仍在 `model-gateway.mjs`。这两个文件分别对应 OpenAI Chat Completions Docker 隔离和
OpenAI Responses 宿主隔离，不是同一协议的重复实现。

## 核心对象

| 对象             | 负责什么                                                       | 是否允许 Updater 修改             |
|------------------|----------------------------------------------------------------|--------------------------------|
| Source           | 保存可信、固定的上游源码 Revision                              | 否                             |
| Target           | 声明 Source、CandidateSeed、Materializer、Driver、Validator 和 Catalog | 否                             |
| Environment      | 声明题目、任务工作区、Verifier 和评分指标                           | 否                             |
| EvolutionRecipe  | 组合 Population Mode、Module Search、Budget 和经验共享               | 否                             |
| SearchStrategy   | 从 Catalog 选父 Candidate 和 Region ID                             | 否；它也不能直接写 Candidate       |
| Solver           | 用 Candidate Harness 在任务环境中真正解题                         | 只通过 Candidate 间接改变行为         |
| Updater          | 读取反馈和源码，在一个 Session 内分析、提假设并改 Candidate     | 只能改本轮 Lease 允许的 Candidate 路径 |
| Controller       | 实例化、发权、调度、Diff 校验、谱系、晋升和回滚                     | 否                             |
| Evaluator        | 用冻结任务、Rubric、成本和安全 Gate 比较 Baseline/Candidate     | 否                             |

Updater 内部仍无需固定的失败分析器、提案器或构建器。它在一次上下文中完成推理、
修改和检查。SearchStrategy 是 Controller 侧的“搜索哪个模块”算法，不负责自然语言归因，
也不帮 Updater 写代码。

## 一轮进化

```text
固定 Source Revision
-> 创建 Baseline 实例和 Candidate 实例
-> SearchStrategy 从 Target Catalog 选父 Candidate 和 Region ID
-> Controller 验证 Plan 并发放本轮 MutationLease
-> 父 Candidate 跑 feedback 任务并生成客观 Feedback Packet
-> 启动一个独立 Updater Session
-> Updater 分析证据，在 Lease 内做最小完整修改
-> Controller 重算完整 Diff 并执行路径、资源和语义检查
-> Champion/Candidate 在同条件下运行配对 selection
-> 冻结 Gate 决定 Reject 或 Promote
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

MSA Cowork 和 Text Reasoning 的通用 Experiment 执行面使用
`MutationCatalog -> MutationPlan -> MutationLease -> full Diff Guard`。
L1/L2/L3 是风险上限，Catalog Region 是某个 Target 自己的可搜索模块。策略只能返回
Region ID，路径由 Controller 从受信 Target Adapter 中翻译。外部策略使用无网络、无挂载、
无宿主环境变量的 Docker JSON 协议。详见 [搜索策略与兼容边界](search-strategy.zh.md)。

Reasoning/Future 执行面继续保留下述已验证的软分层 Git 工作流：

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

## 已实现路径与当前边界

共享控制平面现已包括：冻结 Manifest、可注册 Source Resolver、Source+Seed Candidate 实例化、
可配置 L1/L2/L3 Diff 边界、Mutation Catalog/Plan/Lease、内置与沙箱 SearchStrategy、
通用 Population/Branch 协议、单 Session 变异、Candidate 构建、逐题 Checkpoint、验证反馈、
权限租约和实现/Runtime 证明。HZY 原有生产 Reasoning 链路继续提供仅子进程可见的
sealed test、严格晋升/回滚、崩溃恢复、单写者锁、FD 凭据和关闭后的完整报告。

通用 Experiment 已证明 MSA Minimal 在 Cowork 和 Text Reasoning 两个 Environment 上共用
五种 Mode 与 SearchStrategy。Text Reasoning 只是工程冒烟，HLE 生产评测仍使用其专用隔离链路；
通用 Population 当前遇到基础设施异常会 fail-closed 并写入 `PAUSED_INFRASTRUCTURE`，但尚未
提供跨进程 Resume 和 sealed Final；Gateway 请求预算也仍按 Branch 计算。仓库现有 SWE-bench
文件仍只是契约占位。
