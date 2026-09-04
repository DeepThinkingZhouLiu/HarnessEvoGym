# BaselinePack：跨 Mode 复用同一个 H0 起点

`BaselinePack` 用于固定一次 H0 运行产生的公共起点。它同时保存：

- H0 Candidate 摘要；
- Selection 的逐题记录和聚合分数；
- 第一轮 Feedback 的逐题记录；
- 第一轮 Updater 实际读取的 `FeedbackPacket`。

它不包含 `final` Partition、Provider 凭据、Updater 结果或任何 Candidate 变异。

## 从已有实验导出

```bash
node controller/src/cli.mjs experiment baseline-pack-export \
  --run .rsi/runs/populations/<single-run-id> \
  --output .rsi/baseline-packs/<pack-id>.json \
  --id <pack-id>
```

多 Branch Population 必须额外指定 `--branch branch-001`。输出文件使用独占创建，不会覆盖已有 Pack。

## 在 Experiment 中复用

```json
{
  "spec": {
    "baselinePack": {
      "mode": "reuse",
      "path": ".rsi/baseline-packs/<pack-id>.json",
      "sha256": "<BaselinePack metadata.sha256>"
    }
  }
}
```

Controller 会在任何模型调用前校验 Pack 摘要，以及 Target、H0 Candidate、Environment、Provider、Solver Model、Benchmark、Evaluation Policy、Trial Seed 和数据源版本。任意一项不同都会停止实验。

使用 Pack 后，每个 Branch 的 Generation 0 直接导入同一份 H0 Selection；第一轮直接导入同一份 H0 Feedback。只要 H0 仍是 Champion，后续配对 Selection 也继续使用 Pack 中的同一份 H0 记录。Candidate 自身仍需正常运行 Selection。

## 五 Mode Suite

Suite 可以只启动指定 Mode，并在运行时生成带 Pack 引用的冻结 Experiment：

```bash
RSI_COWORK_SUITE_PROFILE=pilot4 \
RSI_SUITE_MODES=independent,mutualism,competition,combined \
RSI_BASELINE_PACK_PATH=.rsi/baseline-packs/<pack-id>.json \
RSI_BASELINE_PACK_SHA256=<sha256> \
RSI_SUITE_MAX_CONCURRENT_MODES=2 \
node scripts/run-cowork-formal32-five-mode.mjs
```

不配置 `baselinePack` 的旧 Experiment 保持原行为：每个 Branch 独立运行 H0。
