# Adapter 协议

Adapter 让 Controller 不依赖某个 Coding Agent 的仓库布局或启动方式。所有相对路径均从本仓库根目录解析。

- Target Adapter：描述 Solver 源码、实例化方式、运行协议、Trajectory 以及 L1/L2/L3 可写路径。
- Updater Adapter：描述用哪个稳定 Coding Agent 启动一个 Updater Session，以及怎样传入 Prompt、Feedback 与 Candidate。
- Environment Adapter：描述任务工作区、可见反馈和外部评测命令；隐藏集与最终 Rubric 仍由 Controller 私有管理。

`dsh-headless` 协议支持 `preset` 参数。省略时由 Harness 的 preset 名单默认值决定；随附的 DeepSeek Harness Target 与 Updater Adapter 显式固定为 `standard`，避免开发机的个人设置改变 Solver/Updater 组装，并确保 L1 对 `apps/cli/config/agent-presets/**` 的变异会被实际挂载。

Target 与 Updater 是两个正交选择。例如，DeepSeek Harness Updater 可以修改 DeepSeek Harness Candidate；未来也可以让 pi-agent Updater 修改同一个 Candidate。

Adapter 目前是 `v1alpha1` 设计草案。Controller 实现前需要补充正式 Schema、版本迁移规则和命令协议；空命令或空白可写列表必须在启动前失败，不能静默降级。
