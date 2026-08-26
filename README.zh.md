# DeepSeek Harness RSI

[English](README.md) | 中文

一个用冻结 validation 任务持续进化 Agent Harness 的可执行实验平台。当前同一个
Controller 仓库同时支持 **Reasoning** 和 **Cowork** 两条链路：Future 分支的种群
Controller 作为新基座，`lz-dev` 的 SkillsBench、DSH Overlay、Reward 评测和 Docker 隔离
作为 Cowork 增量接入。

## 系统设计

```text
Target MutationCatalog -> SearchStrategy -> MutationPlan
          |                                    |
          |                                    v
冻结题目 -> Candidate Solver <- Controller MutationLease <- Updater
                  |              |
                  v              v
           validation 证据 -> 冻结 Gate -> 晋升/回退
```

| 组件              | 职责                                                             | 边界                                  |
|-------------------|------------------------------------------------------------------|---------------------------------------|
| Target            | 声明 Harness 基线、可进化 Region 与 L1/L2/L3 风险上限     | 不参与打分                            |
| SearchStrategy    | 选父 Candidate 和 Region，决定“这轮搜哪里”                 | 只返回 ID，不能返回路径或修改代码       |
| Updater           | 读取 feedback，分析原因并在授权范围内真正改 Candidate         | 只能写本轮 MutationLease 允许的路径  |
| Solver            | 使用 Candidate Harness 解题                                     | 看不到 gold/final/真实凭据           |
| Controller        | 实例化、发权、调度、Diff 审核、评测、谱系、晋升/回退         | 不可被 Candidate 修改                  |
| Evaluator/Gateway | 冻结分数与模型身份，隔离真实凭据                         | 位于 Candidate 外部                     |

一轮进化是：

```text
incumbent
  -> SearchStrategy 从 Target Catalog 选父 Candidate + Region ID
  -> Controller 验证风险上限、依赖与冲突，生成一轮 MutationLease
  -> Updater 读取源码 + validation 反馈 + 历史，完成一个可证伪修改
  -> Controller 重新计算完整 Diff，不信任 Updater 自报
  -> Candidate 跑 validation
  -> 通过冻结 Gate：晋升；否则：保留 incumbent
```

SearchStrategy 只管“搜哪里”，Updater 仍是完整 Coding Agent，自己做失败归因、
提出假设、改代码和自检。Controller 不把归因写成固定规则，只强制权限与客观 Gate。

## 双场景执行面

| 场景       | 命令入口                         | Target / Environment                              | 当前算法                                                            |
|------------|----------------------------------|---------------------------------------------------|-----------------------------------------------------------------|
| Reasoning  | `campaign ...` / `evolve ...`    | MSA 轻量 Harness + HLE，或 DSH + PutnamBench | Future 的 `single/independent/mutualism/competition/combined` |
| Cowork     | `experiment ...`                 | DSH `cowork-rsi` Overlay + SkillsBench             | 可插拔 SearchStrategy；默认策略保持单 Champion 线性迭代          |

两条链路共用 Benchmark/Policy/Solver Result/Evaluator 协议，但保留各自的环境执行器和
安全隔离：Reasoning 使用宿主 UID + bubblewrap + sealed broker；Cowork 使用 Docker 任务镜像、
独立 Verifier 和只持有一次性令牌的 Model Gateway。这样不会为了“表面统一”而削弱
Future 已验证的 Reasoning 信任边界。

Cowork 当前开放 L1/L2：L1 只改 Preset/Prompt/Skill 文档，L2 额外允许 Skill
Script；L3 未开放。路径白名单、扩展名、可执行位、文件大小、符号链接和 Cordis
插件都由 Controller 在 Updater 结束后重算并强制检查，不依赖提示词自觉。

Cowork 的搜索空间现在从粗粒度层级中独立出来：`mutationLevel` 只是本次实验的
风险上限，`MutationCatalog.regions` 是 Target 自己的可搜索模块。例如 DSH L1 可以分成
`preset-composition` 和 `skill-guidance`，L2 再加 `skill-scripts`。搜索算法可以只选
其中一个，但无法绕过 L1/L2 上限。旧 Experiment 不写 `strategy` 时会自动使用
`linear-hill-climb`，它选择风险上限内全部 Region，所以权限和旧版完全一致。

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
| Cowork 搜索算法 | Experiment：`spec.adapters.strategy` |
| Cowork 可搜索模块 | Target Adapter：`spec.mutation.catalog.regions` |
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

Cowork L1/L2 入口：

```bash
npm run rsi -- experiment validate --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment preflight --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- runtime build --experiment experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment run --config experiments/cowork-skillsbench-dsh-l1.json --run-id <id>
npm run rsi -- experiment finalize --run .rsi/runs/<id>
```

`experiment run` 只读 feedback/selection，`experiment finalize` 在 Champion 锁定后才一次性解封
final。当前 3/2/3 题集用于跑通工程闭环，不代表统计显著性结论。

单个 Campaign 使用
`scripts/resume-hle-short-updater-root.mjs evolve start`，显式传入 config、
runtime、campaign ID、campaigns root、source root 和 credential FD。

每个 branch 写入 `public/state.json` 和 `public/evolution-log.jsonl`。种群关闭后
输出所有 branch incumbent，以及 `best-harness.json` 和
`best-harness.patch`。

详细说明：

- [Controller 五种模式](docs/controller-modes.zh.md)
- [架构与信任边界](docs/architecture.zh.md)
- [搜索空间、搜索策略与兼容边界](docs/search-strategy.zh.md)
- [HLE 变异工作流](docs/hle-mutation-workflow.zh.md)
- [Cowork L1/L2 运行与扩展](docs/cowork-mvp.zh.md)

本仓 Controller 使用 [MIT License](LICENSE)，Vendored Source 与 Submodule 保留
各自许可证和 NOTICE。
