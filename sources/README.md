# Sources

这里保存 Controller 信任的外部源码基准。每个 Source 必须是固定 Revision 的 Git Submodule 或由未来 Source Adapter 提供的等价只读快照。

- `deepseek-harness/`：官方 `deepseek-ai/deepseek-harness` 子模块，用于完整 Harness 集成路径。
- `msa-minimal-harness/`：HLE math/coding 轻量实验所用基础 Harness 的只读源码快照；对应独立 baseline commit `4532f4b82424ed13de64b930e84b51914b7b7893`，不包含嵌套 `.git`。
- 不在 Source 目录直接做 Candidate 修改。
- 上游更新通过子模块指针的独立提交进入主仓，已有实验继续引用原固定 SHA。
- Controller 从 Source 创建 `.rsi/instances/` 下的 Baseline 与 Candidate；Updater 只接触 Candidate 挂载。
