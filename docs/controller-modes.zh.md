# Controller 五种进化模式

`controller_config` 在一个冻结 Campaign 内统一定义种群拓扑、总进化轮次、信息共享和竞争分配。仓库的 Campaign 文件使用 JSON；下面的字段名与 YAML 设计一一对应。

每个 branch 都复用原有轻量单线内核：一个长期存在的 Candidate worktree、一个独立 Git 仓库、自己的 validation feedback 和 `evolution-log.jsonl`。Controller 不在每轮复制工程，只在同步 wave 中并发推进不同 branch。

## 模式

| mode | 并发 branch | Budget | Prompt 注入 |
|---|---:|---|---|
| `single` | 强制 1 | 单 branch 使用全部 `total_budget` | 无 |
| `independent` | N | 总 Budget 尽量均匀地整数分配给 N 个 branch | 无 |
| `mutualism` | N | 与 Independent 相同 | 从第二个 wave 起注入其他 peer 的历史日志 |
| `competition` | N | 相同 Base Budget + 按本轮 `delta_score` 竞争 Bonus Budget | Competition Block |
| `combined` | N | 与 Competition 相同 | Peer Log Sharing Block + Competition Block |

并行模式采用同步 wave：本 wave 的参与 branch 同时执行一次完整的“Updater mutation → build → validation → keep/reset”，全部结束后 Controller 才写入 wave 结果并开始下一轮。已耗尽额度的 branch 不再参与同步或排名；Combined 中它的既有日志仍可被活跃 branch 读取。

## 统一配置

```yaml
controller_config:
  mode: combined
  concurrency:
    n_branches: 2
  budget:
    total_budget: 32
    beta: 0.5
  peer_sharing:
    enabled: true
    log_path_template: "- Peer {peer_id}: {log_path}"
    inject_position: prompt_suffix
  competition:
    enabled: true
    bonus_grant_unit: 1
    scoring_metric: delta_score
```

模式与两个 `enabled` 开关必须一致，避免配置看起来是 Mutualism/Competition，实际却悄悄关闭核心机制：

- `mutualism` / `combined` 要求 `peer_sharing.enabled=true`，其他模式要求 `false`。
- `competition` / `combined` 要求 `competition.enabled=true`，其他模式要求 `false`。
- `single` 强制 `n_branches=1`；其他模式至少为 2，最大为 32。
- `total_budget` 是 Candidate 变异及 validation 的全局整数次数；各 branch 的 baseline 不消耗该 Budget。
- `beta` 范围为 `[0,1]`，只在 Competition/Combined 中影响分配。

## Budget 的整数语义

Independent/Mutualism 使用稳定的近似均分。例如 `32/3` 分配为 `11, 11, 10`，总量严格等于 32。

Competition/Combined 使用：

```text
base_budget_per_branch = floor(total_budget * beta / n_branches)
bonus_budget_pool = total_budget - base_budget_per_branch * n_branches
```

这样每个 branch 的保证额度完全相同，所有小数和不可整除余数进入 Bonus Pool，不会随机偏袒某个 branch。每个同步 wave 后按 Candidate validation 分数相对 wave 开始前 incumbent 的变化量 `delta_score` 排名；最大者获得至多 `bonus_grant_unit` 个新额度。并列时先比较本轮 validation 分数，再按 branch ID 稳定排序。

`beta=0` 时没有初始 Base 轮次。Controller 使用各 branch 的 baseline validation 选择当前最优 branch，发放第一笔 Bonus，再继续按实际 delta 竞争。

## Prompt 与日志

Mutualism/Combined 不复制 peer 日志。Controller 把每个 peer 的真实 `evolution-log.jsonl` 只读挂载到 Updater 沙箱：

```text
/opt/harness-rsi/peer-logs/branch-001.jsonl
/opt/harness-rsi/peer-logs/branch-002.jsonl
```

`log_path_template` 支持 `{peer_id}` 和必需的 `{log_path}`。Peer Block 指导 Updater 借鉴已产生稳定增益的 feature，并规避 peer 已验证无效或错误的 feature。Competition Block 明确 `delta_score` 和额外轮次规则。两个 Block 都只是搜索先验；最终 writable layer、Git diff、validation 晋升和回退仍由原有硬边界控制。

## 最终产物

当总 Budget 用完，或所有 Updater 主动停止，父级 Population Campaign 自动关闭并输出：

- `population-summary.json`：模式、Budget、所有 branch incumbent 和完整 mutation history。
- `population-summary.md`：种群对比表和最佳结果。
- `best-harness.json`：最佳 branch、Candidate、commit/tree/digest、冻结 baseline revision 和可重建路径。
- `best-harness.patch`：从冻结 baseline 到种群最优 Harness 的完整 Git patch。

最佳 branch 按 validation 分数选择；同分时按 branch ID 稳定选择。隐藏 test 从不参与 branch 排名、Bonus 分配或最佳 Harness 选择。

## Terra-High 配置

可运行样例位于 `benchmarks/hle-text-math/msa-population10-codex-terra-high/campaign.json`，默认是 `single` 与总 Budget 32。它复用 `environments/hle-text-math/msa-codex-terra-high-runtime.json`：Solver 和 Codex Updater 都是 `gpt-5.6-terra/high`，模型请求与 Solver 单题上限均为 1800 秒。切换模式时使用新的 Campaign ID，并同步修改 `mode`、`n_branches` 和两个 `enabled` 字段，避免污染已冻结实验。

`--round-limit` 在 Population 模式下只限制本次命令最多推进多少个同步 wave，不改变冻结的 `total_budget`；省略或设为 0 会一直运行到 Budget/Updater 的算法终止条件。
