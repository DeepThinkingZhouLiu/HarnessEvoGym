# Benchmark

仓库包含两条生产 Campaign 路径：`putnambench-lean/` 固定 672 道 Lean 题并切成 500/172；`hle-text-math/` 从官方门控 HLE revision 按 `raw_subject × answer_type` 分层采样为 50/50。两者都只用验证集决策；PutnamBench 每个 Candidate 测 test，HLE 则在 baseline 和默认每 5 个 Candidate 的预定轮次测 sealed test。关闭前均不向 Controller/Updater 暴露测试题目、过程或分数。HLE 的私有 manifest 和答案库不提交 Git，详见 `hle-text-math/README.zh.md`。

Benchmark 固定“评哪些任务”，不负责让 Solver 解题，也不负责修改 Candidate。每份配置必须记录不可变数据版本、Evaluator Adapter、精确 Instance ID，以及 `feedback/selection/final` 三个互斥 Partition。

## 三种 Partition

| Partition   | Updater 可见性  | 用途                                                        |
|-------------|-----------------|-------------------------------------------------------------|
| `feedback`  | `detailed`      | 返回详细结果、Trajectory 与 Bad Case，驱动 Updater 修改     |
| `selection` | `aggregate-only` | Controller 在进化过程中选择 Candidate，不泄露逐题答案      |
| `final`     | `sealed`        | 锁定 Final Candidate 后才运行，只用于最终报告               |

如果目标是“60 道题用于进化、40 道题用于最终评测”，推荐把前 60 道继续拆成 48 道 `feedback` 和 12 道 `selection`。这仍然属于 60 道进化池，但可以避免 Updater 直接针对 Candidate 选择集优化。

## SWE-bench 子集

题目本身应来自固定版本的 SWE-bench 数据集；本仓库只提交数据来源、Revision 和 Instance ID Manifest，不复制 Gold Patch、测试答案或大体积仓库镜像。自定义 100 题子集应使用独立名称，例如 `swebench-verified-100-rsi-v1`，不能把成绩表述为完整官方榜单成绩。

`examples/swebench-rsi-smoke/benchmark.json` 是一个六题协议样例，Instance ID 是测试夹具，不是真实 SWE-bench 题目。真实实验需要替换为经过审查的固定 ID，并按研究目标选择随机、跨仓库或时间切分。

## 校验入口

```bash
npm run rsi -- benchmark validate \
  --config benchmarks/examples/swebench-rsi-smoke/benchmark.json
```

校验会拒绝移动数据版本、空 Partition、重复 ID、跨 Partition 泄漏、数量不一致和错误的可见性配置。

生产 PutnamBench 配置使用专用入口：

```bash
npm run rsi -- campaign validate
```
