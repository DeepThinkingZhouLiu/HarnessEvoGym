# Cowork RSI 端到端 MVP

这个切分只用来验证 `Solver -> Updater -> Solver -> Evaluator -> Promotion` 链路，不用于对外报告 Benchmark 能力。

- Feedback：`officeval_060`，向 Updater 暴露一道题的详细失败证据。
- Selection：`officeval_003`，只向 Controller 返回聚合 Reward。非 UTF-8 Office 字节由独立回归测试覆盖，避免为连通性验证消耗正式 Validation 题。
- Final 占位：`officeval_090`，满足三分区协议，普通 `experiment run` 不会解封或运行它。

三道题都来自正式切分的 Feedback/Training 区，不消耗 Validation 或 Final 集。一次 MVP 实际只运行前两道题。
