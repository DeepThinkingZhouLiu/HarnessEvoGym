# Environment Adapter

Environment 把“什么叫做更好”接入 RSI 闭环，但不把最终裁判权交给 Solver 或 Updater。

一个 Environment Adapter 至少需要描述：

- 如何为每道任务创建一次性工作区。
- 如何启动 Solver，并收集标准化结果与 Trajectory。
- 哪些训练反馈可以进入 Feedback Packet。
- 如何对 Baseline 与 Candidate 使用相同模型、预算、种子和超时配对运行。
- 如何调用 Controller 私有的隐藏任务、Rubric 与安全检查。
- 质量、回归、成本和安全 Gate 如何共同决定 Candidate 是否有资格晋升。

`examples/coding-task.example.yml` 只是协议占位。真实接入时，训练任务可以向 Updater 返回详细 Bad Case；隐藏任务只能返回聚合信号，不能泄露题目、答案或 Rubric 细节。
