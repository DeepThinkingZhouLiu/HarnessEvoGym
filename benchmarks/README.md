# Benchmark

Benchmark 固定“评哪些任务”，不负责让 Solver 解题，也不负责修改 Candidate。Manifest 必须记录不可变数据版本、Evaluator Adapter、精确 Instance ID，以及三个互斥 Partition。

## Partition

| Partition   | Updater 可见性   | 用途                                                       |
|-------------|------------------|------------------------------------------------------------|
| `feedback`  | `detailed`       | 生成 Bad Case、Solver Answer、Verifier 证据，驱动修改       |
| `selection` | `aggregate-only` | 进化期晋升决策；逐题反馈不进入 Feedback Packet              |
| `final`     | `sealed`         | Champion 锁定后一次性最终报告，不参与晋升                   |

## Cowork POC

`cowork-skillsbench-poc/benchmark.json` 固定 SkillsBench `bf3793e9...`，使用 3 个 feedback、2 个 selection、3 个 final 任务。它用于验证 L1/L2 闭环，不是官方完整榜单。

这八个任务在当前固定 Revision 中都通过 `/logs/verifier/reward.txt` 返回二值 0/1。Controller 的结果协议支持 `[0,1]` 连续 Reward，但不能把当前 POC 描述成已经使用细粒度 Rubric 分数。

```bash
npm run rsi -- benchmark validate \
  --config benchmarks/cowork-skillsbench-poc/benchmark.json
```

校验会拒绝移动 Revision、空 Partition、重复 ID、跨 Partition 泄漏、数量不一致、错误可见性和不支持的结果协议。

## 扩大数据集

- 只提交固定 Revision 和 Instance ID，不提交 Gold Answer、隐藏 Rubric 或大体积任务镜像。
- feedback/selection/final 必须来自同一冻结数据版本且互斥。
- 正式报告应说明抽样方式、领域覆盖、难度与许可证，不把自定义子集冒充完整榜单。
- 如果计划“60 题进化、40 题测试”，建议把前 60 题再拆成 feedback 与 selection，最终 40 题始终 sealed。
- 不要把第三方 Task 自带 Skill 复制成项目 H0 Skill；运行任务与重新分发内容是两回事。
