# 独立 RSI 控制平面架构

[English](architecture.md) | 中文

## 决策

DeepSeek Harness RSI 使用独立 GitHub 仓库作为可信控制平面，不再以 DeepSeek Harness Fork 作为主仓。官方 DeepSeek Harness 只以 Git Submodule 形式进入 `sources/deepseek-harness/`，Updater 永远不直接修改该目录。

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

所有可变状态都位于被 Git 忽略的 `.rsi/`，不污染 Source 或主仓历史：

```text
.rsi/
  runs/<run-id>/
    input/
      feedback-packet.json
      mutation-policy.json
    baseline/
      workspace/
    candidates/<candidate-id>/
      workspace/
      mutation-report.json
      diff.patch
      evaluation.json
    decision.json
  registry/
    candidates.jsonl
```

Controller 可以用上游子模块的 Git 对象创建工作树，但 Updater 容器只能看到 Candidate 文件挂载，不能看到 `.git` 文件或 Controller 的 Gitdir。Baseline 挂载为只读；Candidate 除本轮白名单外也挂载为只读。

## 变异边界

只靠 Prompt 不能限制 Updater，完整约束由三部分组成：

- 语义约束：Prompt 解释本轮目标、层级和禁止事项。
- 写入约束：沙箱仅把当前层级路径暴露为可写。
- 结果约束：Controller 重新计算 Diff，任何越界、凭据、安全根或协议破坏都直接淘汰。

L1、L2、L3 是 Target Adapter 的语义，不应假设所有 Agent 目录相同。DeepSeek Harness 的 L1 可以对应 Preset，pi-agent 的 L1 可能对应另一套配置；Controller 只理解“当前层级白名单”，不写死具体目录。

## 反馈与泛化

Feedback Packet 应包含聚合指标、代表性成功/失败案例、Trajectory、Verifier 输出、成本、延迟和环境信息，但不提前写死失败因果。Updater 负责从跨案例证据中判断应该改变哪种策略或实现。

为了避免只记住训练题，晋升至少同时检查：

- 训练分布是否提升。
- 独立隐藏分布是否提升。
- 历史回放是否在容忍范围内。
- 成本与延迟是否在预算内。
- 权限、跨任务污染和不可逆副作用是否通过安全检查。

Candidate 只能影响解题过程，不能影响题目、最终评分、资源计量或晋升规则。

## 子模块更新语义

主仓固定一个 DeepSeek Harness SHA，所以每轮实验的 Source 可复现。`git submodule update --remote` 只是在本地取得上游新提交；只有把新的子模块指针提交到主仓后，它才成为新的可信 Source Revision。旧 Candidate 仍记录旧 SHA，不随上游更新漂移。

## 实现顺序

1. Adapter Schema 与静态校验。
2. Source Revision 与 Candidate 实例化。
3. L1 可写挂载和最终 Diff 校验。
4. Feedback Packet 与单 Updater Session。
5. Baseline/Candidate 配对评测和不可变 Registry。
6. L2 沙箱与回滚。
7. L3 完整实例隔离。
8. 第二个 Agent Target，验证 Adapter 泛化。
