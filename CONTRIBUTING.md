# 参与开发

本项目仍处于协议与最小闭环搭建阶段。提交改动前请先确认它属于 Controller、Adapter、Environment、Prompt 或文档；不要把 RSI 代码写进上游子模块。

- 从 `main` 创建独立开发分支。
- 保持 `sources/deepseek-harness/` 指向可复现的上游提交；升级子模块应单独提交。
- Adapter 变更需要说明路径解析、输入输出、失败语义和向后兼容影响。
- Benchmark、Solver Result 或 Evaluation Policy 协议变更需要同步测试、示例与兼容性说明。
- 变异层级既要有 Prompt 说明，也必须能被可写路径与 Diff 校验强制执行。
- 不提交 API Key、隐藏题、最终 Rubric、真实用户轨迹或 `.rsi/` 运行产物。
- 代码实现加入后，优先运行与改动范围最接近的测试，再扩大到相关模块。
