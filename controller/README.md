# Controller

Controller 是 RSI 系统的可信、确定性控制平面。这里将承载后续可执行实现，但不会把 Updater 的开放式推理拆成固定的 `failure-analyzer`、`mutation-proposer` 等规则服务。

Controller 只负责以下事情：

- 解析 Target、Updater 与 Environment Adapter。
- 从固定 Source Revision 创建彼此隔离的 Baseline 与 Candidate。
- 收集客观结果，生成不含隐藏答案的 Feedback Packet。
- 选择本轮 L1、L2 或 L3，并用沙箱可写路径实施限制。
- 启动一个 Updater Coding Agent Session，让它完成分析、假设和修改。
- 校验最终 Diff、构建 Candidate，并执行 Baseline/Candidate 配对评测。
- 根据冻结 Gate 登记 Candidate、晋升新 Baseline 或回滚。

Controller 不相信 Candidate 自报分数，不把隐藏任务交给 Updater，也不允许 Updater 直接操作 Source Submodule 或 Git 晋升指针。

第一版实现应保持粗粒度：`orchestrate -> materialize -> update -> evaluate -> decide`。只有出现明确复用边界后，再拆分内部模块。

## 当前可执行入口

`src/cli.mjs` 已实现第一段可信评测入口：

- `benchmark validate` 校验不可变数据版本、三段 Split、可见性、数量与重复 ID。
- `evaluate compare` 读取标准化 Baseline/Candidate JSONL，计算覆盖率、Resolved Rate、成本、Token、延迟和配对改进。
- Evaluation Policy 负责覆盖率、净提升、回退、成本与安全 Gate。
- sealed `final` 必须显式解锁，且单独运行时只形成最终报告，不参与 Candidate 选择。

它目前不负责启动 Solver、SWE-bench Docker Harness 或 Updater；这些仍属于后续的 `materialize/run/normalize` 闭环。
