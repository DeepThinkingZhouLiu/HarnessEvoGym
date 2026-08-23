# 独立 RSI 控制平面架构

[English](architecture.md) | 中文

## 决策

DeepSeek Harness RSI 使用独立 GitHub 仓库作为可信控制平面，不再以 DeepSeek Harness Fork 作为主仓。官方 DeepSeek Harness 的历史只通过固定的 `sources/deepseek-harness/` 集成子模块进入系统，Updater 永远不直接修改该目录。当前开发版本在官方历史之上固定了一笔经过审查的 headless preset 集成提交；`.gitmodules` 仍使用官方上游，后续更新必须保留这笔修复，或者用等价的上游修复替换它。

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
固定 Controller/Source Revision 与 H0 Overlay
-> 当前 Champion 跑 feedback 并生成客观 Feedback Packet
-> Controller 选择 L1 或 L2
-> 启动一个独立 Updater Session
-> Updater 分析一批案例并修改 Candidate
-> Controller 重新扫描全部文件并拒绝越界 Diff
-> Champion/Candidate 在 selection 上配对运行
-> 冻结 Gate 决定 Reject 或 Promote
-> 锁定 Champion 后用一次性 Attempt 运行 final
-> 保存不可变 Candidate、结果、父版本和决策原因
```

## 运行目录

所有可变状态都位于被 Git 忽略的 `.rsi/`，不污染 Source 或主仓历史：

```text
.rsi/
  runs/<run-id>/
    state.json
    final-attempt.json
    experiment.snapshot.json
    mutation-policy.json
    generations/<generation-id>/
      feedback-packet.json
      decision.json
    candidates/<candidate-id>/
      workspace/
      manifest.json
      mutation-report.json
      mutation-diff.json
      evaluation.json
    results/
    trials/
    final-evaluation.json
  registry/
    candidates.jsonl
```

L1/L2 的 Candidate 不是完整 DSH Worktree，而是项目自有 Preset Overlay。Updater 容器只能看到这个一次性 Overlay、只读上游源码和只读反馈，不能看到主仓、Benchmark、Verifier 或 Gitdir。Docker 无法按扩展名建立可写挂载，所以 Overlay 本身可写；当前层级的精确路径、扩展名、可执行位和大小限制由退出后的完整 Diff Guard 强制。文件和空目录都进入 Tree Digest，零改动或只改空目录的提案不会进入 selection。信任根从未进入可写挂载，H0 与 Champion 也不作为 Updater 的写入目标。

## 变异边界

只靠 Prompt 不能限制 Updater，完整约束由三部分组成：

- 语义约束：Prompt 解释本轮目标、层级和禁止事项。
- 实例约束：沙箱只提供一次性 Candidate Overlay，信任根不进入容器可写面。
- 结果约束：Controller 重新计算 Diff，任何越界、凭据、安全根或协议破坏都直接淘汰。

L1、L2、L3 是 Target Adapter 的语义，不应假设所有 Agent 目录相同。DeepSeek Harness 的 L1 可以对应 Preset，pi-agent 的 L1 可能对应另一套配置；Controller 只理解“当前层级白名单”，不写死具体目录。

运行网络也属于强制边界。Solver/Updater 只接入每个 Run 新建的 Docker internal network，拿到内部地址和一次性 Token；只有最小 Model Gateway 持有真正 Provider Key，并把请求限制为固定上游的 `POST /chat/completions`、Run 总量和并发预算。因此 L2 脚本即使尝试任意联网，也没有直接外网路由。

## 反馈与泛化

当前 Feedback Packet 包含 feedback 任务要求、聚合指标、逐题 Reward、Solver 最终答复、Verifier 输出、运行错误、受限产物摘要、Token Usage 和延迟，但不提前写死失败因果。Updater 负责从跨案例证据中判断应该改变哪种策略或实现。Model Gateway 已按 Session 采集流式 Token Usage；DSH 的完整逐工具 Trajectory 和可信美元成本尚未接入，对应字段不伪造。

为了避免只记住训练题，正式系统最终应同时检查：

- 训练分布是否提升。
- 独立隐藏分布是否提升。
- 历史回放是否在容忍范围内。
- 成本与延迟是否在预算内。
- 权限、跨任务污染和不可逆副作用是否通过安全检查。

Candidate 只能影响解题过程，不能影响题目、最终评分、资源计量或晋升规则。

当前八题 POC 已强制 selection 配对提升、零 Reward 回退、完整率和安全 Gate；固定 selection 每代都会重放，但尚未加入独立历史任务池。Token 涨幅 Gate 已有入口，美元成本 Gate 因缺少可信费率表而关闭。Final 只在 Champion 锁定后做一次报告，不参与晋升。

## Benchmark 与双层评测

Task Evaluator 负责判断单道任务是否解决，例如 SWE-bench 官方 Harness 应用 Solver Patch 并运行测试。RSI Evaluator 读取标准化逐题结果，在相同 Instance、模型与预算下配对比较 Baseline/Candidate，再执行质量、回退、成本和安全 Gate。

Benchmark Manifest 固定数据集 Revision 与 `feedback/selection/final` 三个互斥 Partition。`feedback` 可以返回详细 Bad Case；`selection` 只用于进化期 Candidate 选择；`final` 在 Final Candidate 锁定前保持 sealed。直接在每一代使用 Final Test 会把它降级为 Validation。

当前 `controller/src/cli.mjs` 已实现 Manifest/Adapter/Experiment 校验、Candidate 实例化、源代码构建的 DSH Docker Solver/Updater、SkillsBench Runner/Verifier、`[0,1]` Reward 协议、配对指标、Bootstrap 区间、谱系、晋升/回滚与一次性 Final。当前八个上游 Verifier 实际只返回 0/1；SWE-bench 仍是独立的后续 Environment Adapter，不影响 Cowork 闭环。

## 子模块更新语义

主仓固定一个 DeepSeek Harness SHA，所以每轮实验的 Source 可复现。`git submodule update --remote` 只是在本地取得上游新提交；只有把新的子模块指针提交到主仓后，它才成为新的可信 Source Revision。旧 Candidate 仍记录旧 SHA，不随上游更新漂移。

## 当前边界与后续

- Cowork SkillsBench L1/L2 MVP 已实现；L3 暂不开放。
- POC 只有 3/2/3 八道题，主要验证协议和运行链路。
- 当前 DSH Provider 不保证 Seed 真正控制采样；网关已采集完整响应的 Token Usage，但美元成本没有可信费率表时仍显式为未知。
- Agent internal network 和受限 Model Gateway 已实现；正式运行仍需在网关外层增加 DNS/IP 策略和调用审计。
- 正式运行还需要更大的冻结 Split、多 Trial、镜像/Verifier 供应链固定和 Provider 费率 Adapter。
- 下一类工作是增加第二个 Agent Target/Updater 与新的 Environment Adapter，验证通用 Controller 没有写死 DSH 或 SkillsBench。
