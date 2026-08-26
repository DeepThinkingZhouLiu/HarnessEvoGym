# DeepSeek Harness RSI

[English](README.md) | 中文

一个用冻结 validation 任务持续进化 Agent Harness 的 Adapter 化控制平面。当前轻量
Target 同时面向数学和 Coding，可以推理、执行本地 Bash/Python、读取 observation
并提交最终答案。

## 系统设计

```text
冻结题目 -> Candidate Solver -> validation 分数 + trace
                  ^                         |
                  |                         v
              Git commit <- Updater <- evolution log
                  |
                  v
            Controller 保留/回退
```

| 组件 | 职责 | 边界 |
|---|---|---|
| Source | 固定 Harness 基线 | 只读 |
| Solver | 使用 Candidate Harness 解题 | 看不到 gold/test/凭据 |
| Updater | 读取 validation 反馈，修改一个 Candidate，创建一个 commit | 只能写配置允许的路径 |
| Controller | 调度、Budget、Git 审核、评测、保留/回退、报告 | 永远不可写 |
| Evaluator/Gateway | 冻结分数与模型身份，隔离真实凭据 | 位于 Candidate 外部 |

一轮进化是：

```text
incumbent
  -> Updater 读取源码 + validation 反馈 + 历史
  -> 选择 L1/L2/L3，完成一个单变量方向并 commit
  -> Controller 检查一个子 commit 及其改动路径
  -> Candidate 跑 validation
  -> 分数上涨：保留；否则：git reset 回 incumbent
```

Controller 不替 Updater 设计 mutation direction。每个 branch 复用一个 Git
worktree，不逐轮复制完整工程，也不拆成 Proposal/Apply 两次会话。

## 最小 Math/Coding Harness

基础源码已提交到
[`sources/msa-minimal-harness/`](sources/msa-minimal-harness/README.md)：

```text
task -> model -> 可选 <bash> -> observation -> model -> <final>
```

| 层级 | 可写文件 | 含义 |
|---|---|---|
| L1 | `profiles/**` | Prompt、策略、答案/工具纪律、step/token budget |
| L2 | L1 + `agent.py` + `tools.py` | Parser、历史、workflow、验证、Bash 行为 |
| L3 | L2 + `model.py` + `run.py` | Agent loop 结构、Responses/SSE、session/runtime 组装 |
| 永不可写 | Controller、Evaluator、题目/split、gold、凭据、Budget 和晋升策略 | 信任根 |

`updater-soft` 每轮都把三层完整说明注入 Prompt，引导 Updater 选择最小充分层；
Controller 只做轻量路径审核。

## 五种种群模式

| 模式 | Branch 数 | 协作方式 |
|---|---:|---|
| `single` | 1 | 单 branch 独占全部 Budget |
| `independent` | N | 划分 Budget，branch 之间不通信 |
| `mutualism` | N | Independent + 只读 peer evolution log |
| `competition` | N | 均分 Base Budget，最大分数增量获得 Bonus |
| `combined` | N | Mutualism + Competition |

Competition 和 Combined 使用：

```text
base_per_branch = floor(total_budget * beta / n_branches)
bonus_pool      = total_budget - base_per_branch * n_branches
```

并行 branch 按同步 wave 前进。额度耗尽后退出排名；Combined 中已有日志仍可供其他
branch 参考。

## 关键配置怎么改

| 要修改的内容 | 文件 / 字段 |
|---|---|
| 模式、branch 数、Budget、beta | Campaign：`controller_config` |
| 数据版本和 validation/test manifest | Campaign：`spec.source`、`spec.partitions` |
| 冻结 Solver model/effort | Campaign：`spec.solver` |
| Solver 并发和超时 | Runtime：`solver` |
| Updater backend/model/effort | Runtime：`updater` |
| Provider URL 和请求超时 | Runtime：`gateway` |
| L1/L2/L3 说明与路径 | Runtime：`mutation.layers` |
| Harness 实现 | `sources/msa-minimal-harness/` 或其他固定 Target |

当前示例：

- Campaign：
  `benchmarks/hle-text-math/msa-population50-codex-terra-high/`
- Runtime：
  `environments/hle-text-math/msa-codex-terra-high-runtime.json`

### 模式与 Budget

```json
{
  "controller_config": {
    "mode": "combined",
    "concurrency": { "n_branches": 2 },
    "budget": { "total_budget": 32, "beta": 0.5 },
    "peer_sharing": {
      "enabled": true,
      "log_path_template": "- Peer {peer_id}: {log_path}",
      "inject_position": "prompt_suffix"
    },
    "competition": {
      "enabled": true,
      "bonus_grant_unit": 1,
      "scoring_metric": "delta_score"
    }
  }
}
```

Single 必须设 `n_branches=1`。Peer sharing 只在 Mutualism/Combined 开启；
Competition 只在 Competition/Combined 开启。

### 模型、并发与超时

```json
{
  "solver": {
    "initialConcurrency": 15,
    "taskTimeoutSeconds": 1800,
    "partitionTimeoutSeconds": 3600
  },
  "updater": {
    "backend": "codex-cli",
    "provider": "zcloud",
    "model": "gpt-5.6-terra",
    "reasoningEffort": "high"
  },
  "gateway": {
    "upstreamBaseUrl": "https://provider.example/v1",
    "requestTimeoutSeconds": 1800
  }
}
```

冻结字段变化后必须使用新的 Campaign ID。Campaign 的
`spec.solver.model/reasoningEffort` 要与 Runtime 保持一致。修改 split 时要提交
validation manifest 并同步更新数量/hash，validation/test ID 不得重合；正式 test
必须 sealed，当前 HLE Math50 Campaign 则显式关闭 test。凭据只能在运行时通过继承
FD 传入，不能进入配置或 Git。

## 启动与产物

```bash
npm test
node scripts/run-hle-population50-sequence.mjs
```

单个 Campaign 使用
`scripts/resume-hle-short-updater-root.mjs evolve start`，显式传入 config、
runtime、campaign ID、campaigns root、source root 和 credential FD。

每个 branch 写入 `public/state.json` 和 `public/evolution-log.jsonl`。种群关闭后
输出所有 branch incumbent，以及 `best-harness.json` 和
`best-harness.patch`。

详细说明：

- [Controller 五种模式](docs/controller-modes.zh.md)
- [架构与信任边界](docs/architecture.zh.md)
- [HLE 变异工作流](docs/hle-mutation-workflow.zh.md)

本仓 Controller 使用 [MIT License](LICENSE)，Vendored Source 与 Submodule 保留
各自许可证和 NOTICE。
