# Updater Provider 与消融 Checkpoint

## 两个独立选择

Experiment 现在把“用哪个 Updater”和“这个 Updater 连哪个 Provider”分开。
`adapters.updater` 选 Updater Driver，`adapters.providers` 分别选 Solver 和 Updater
Provider。

```json
{
  "adapters": {
    "target": "adapters/targets/msa-minimal.yml",
    "updater": "adapters/updaters/claude-code-cli.yml",
    "environment": "environments/omegause-officeval-mvp.yml",
    "providers": {
      "solver": "adapters/providers/zcloud-openai.yml",
      "updater": "adapters/providers/zcloud-anthropic.yml"
    },
    "strategy": "adapters/strategies/linear-hill-climb.yml"
  }
}
```

旧 Experiment 的单个 `adapters.provider` 仍然可用；Controller 会将它兼容映射为
Solver/Updater 共用同一 Provider。新配置必须在 `provider` 和 `providers` 中二选一。

| Updater Driver       | Provider 协议             | 凭据隔离                                      |
|----------------------|---------------------------|-----------------------------------------------|
| DeepSeek Harness     | OpenAI Chat Completions   | Docker Model Gateway 的 Updater 角色令牌      |
| Codex CLI            | OpenAI Responses          | 无网 Bubblewrap + Unix Socket 本地网关       |
| Claude Code CLI      | Anthropic Messages        | 无网 Bubblewrap + Unix Socket 本地网关       |

Claude Code 配置会固定本机 CLI 版本和整个 distribution 摘要。Controller
持有真实 ZCloud Key，Claude Code 只能看到一次性假 Key。网关会强制覆盖
Provider、模型、adaptive thinking、思考深度和 Token 上限，不允许
Candidate 修改这些实验条件。

本地凭据仅通过环境变量注入：

```bash
export RSI_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
read -rsp 'Solver Provider API Key: ' RSI_PROVIDER_API_KEY && export RSI_PROVIDER_API_KEY
export RSI_CLAUDE_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
read -rsp 'Claude Updater API Key: ' RSI_CLAUDE_PROVIDER_API_KEY && export RSI_CLAUDE_PROVIDER_API_KEY
```

可运行的最小示例是
`experiments/cowork-msa-mvp-claude-single.json`。

## 按 Budget 保留消融 Checkpoint

`checkpointing.budgetMilestones` 指的是全部 Branch 合计已消耗的 Candidate
Budget，不是单个 Branch 的轮次。例如 N=2、B=16 时，每个同步 Wave
通常消耗 2 个 Budget；配置 B0/B4/B8/B12/B16 就能保留五个可审计时点。

```yaml
spec:
  population:
    mode: independent
    concurrency: { n_branches: 2 }
    budget: { total_budget: 16, beta: 0 }
    peer_sharing: { enabled: false }
    competition: { enabled: false }
  moduleSearch:
    authority: strategy-directed
    riskCeiling: l2
    strategy: linear-hill-climb
  checkpointing:
    budgetMilestones: [0, 4, 8, 12, 16]
    capture:
      populationBest: true
      branchIncumbents: true
      latestAttempts: true
```

五种 Mode 的同预算示例都在 `recipes/population-ablation-linear-16/`；除 Single
按定义只能使用一个 Branch 外，其余示例均为 N=2、B=16。运行时会生成：

```text
<population-run>/public/checkpoints/
  budget-0000.json
  budget-0004.json
  budget-0008.json
  budget-0012.json
  budget-0016.json
```

每个文件记录当时的 Population Best、每个 Branch Incumbent，以及当轮
尝试过的 Candidate ID/Revision/Digest。因此即使 B8 的当轮 Candidate 被拒绝，
也能根据不可变身份找回它做消融；下一轮仍然从历史最好 Champion 出发。

并发 Wave 是原子单位，Controller 不会为了凑一个数字拆开同一 Wave。
如果某个里程碑不是 Wave 大小的整数倍，Checkpoint 会同时写入
`requestedBudget` 和实际稳定点 `actualConsumedBudget`，避免把未完成的并发状态伪装成可复现 Checkpoint。

Checkpoint 文件先以原子 write-once 方式落盘，再记入 Population state。
如果进程恰好在这两步之间被强制终止，`experiment resume` 只会在不存在
in-flight Wave 的稳定 `EVOLVING` 状态下恢复 Branch，重算 Candidate 身份，并幂等
补全 Checkpoint 总账。半轮状态仍会 fail-closed，不会被伪装成稳定检查点。
