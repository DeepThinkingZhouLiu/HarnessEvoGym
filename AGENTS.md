# 项目内 Agent 工作约定

- 本仓库是 RSI Controller 与协议仓库，不是 DeepSeek Harness Fork。
- `sources/deepseek-harness/` 是只读上游子模块。不要直接在该目录开发 RSI 功能，也不要让 Updater 修改这里。
- Baseline 与 Candidate 必须由 Controller 从固定源码版本实例化到 `.rsi/`，Updater 只接触本轮 Candidate。
- Updater 是一个完整 Coding Agent Session：它读取反馈、分析原因、提出假设并修改代码，不把这些推理阶段拆成固定规则服务。
- 每轮只允许一个变异层级。Prompt 只负责说明；沙箱可写挂载与最终 Diff 白名单负责强制执行。
- Controller、Evaluator、隐藏任务、最终 Rubric、凭据、资源计量、晋升与回滚逻辑属于信任根，不能放入 Candidate。
- `benchmarks/`、`evaluation/` 及其 sealed Partition 属于 Controller 信任根；Updater 不得读取 Final Manifest 或修改指标 Policy。
- 新增 Target、Updater 或 Environment 时优先扩展 Adapter，不把具体 Agent 的分支逻辑写死在 Controller 中。
- 任何密钥只能在运行时注入，不得提交到仓库、反馈包、轨迹或 Mutation Report。
- 中英文 README 的架构结论应保持一致。
