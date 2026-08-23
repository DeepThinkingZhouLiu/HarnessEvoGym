# Environment Adapter

`putnambench-lean/runtime.json` 是当前已经接入的生产 Adapter Runtime：它固定模型预算、并发、超时、宿主身份、Node/pnpm/Lean 工具链与互不重叠的持久化/临时路径。Controller 会在读取凭据和启动候选代码之前校验 Schema、路径拓扑、实现指纹及安装产物。

Environment 把“什么叫做更好”接入 RSI 闭环，但不把最终裁判权交给 Solver 或 Updater。

一个 Environment Adapter 至少需要描述：

- 如何为每道任务创建一次性工作区。
- 如何启动 Solver，并收集标准化结果与 Trajectory。
- 哪些训练反馈可以进入 Feedback Packet。
- 如何对 Baseline 与 Candidate 使用相同模型、预算、种子和超时配对运行。
- 如何调用 Controller 私有的隐藏任务、Rubric 与安全检查。
- 质量、回归、成本和安全 Gate 如何共同决定 Candidate 是否有资格晋升。

`examples/coding-task.example.yml` 只是协议占位。真实接入时，训练任务可以向 Updater 返回详细 Bad Case；隐藏任务只能返回聚合信号，不能泄露题目、答案或 Rubric 细节。

`swe-bench.yml` 定义官方 SWE-bench Docker Harness 的外部执行与结果归一化契约。Controller 能消费标准 JSONL 并计算通用指标，但该 Harness Runner/Normalizer 尚未实现，不能与 PutnamBench 生产 Campaign 的完成度混淆。
