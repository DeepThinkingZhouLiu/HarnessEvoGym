# HarnessEvoGym

[English](README.md) | 中文

一个把 **“优化谁”、“在哪里做题”、“怎么进化”** 拆开配置的 Harness
自进化实验平台。当前已经能用同一个 Controller 组合 MSA Minimal Target、
SkillsBench Cowork 环境或文本 Reasoning 冒烟环境，并运行
`single / independent / mutualism / competition / combined` 五种种群模式。

平台的核心公式是：

```text
Target × Environment × EvolutionRecipe
```

- Target 决定被优化的 Harness 是谁、初始 Candidate 是什么、怎么启动，以及哪些模块可以改。
- Environment 决定题目、任务工作区、Verifier 和评分指标。
- EvolutionRecipe 决定 Branch 如何组织、经验是否共享、Budget 怎么分配，以及每轮搜索哪些可进化模块。
- Controller 只做受信调度、授权、Diff 审核、评测、晋升和回滚，不知道 DSH、MSA 或某个 Benchmark 的业务细节。

## 系统设计

```text
Target Source + CandidateSeed -> Candidate Materializer -> H0 / Candidate
             |                                               |
             v                                               v
      MutationCatalog -> Module Search -> MutationLease -> Updater
                                                            |
Environment -> Task Workspace -> Solver --------------------+
      |                         |
      +-> Verifier -> EvaluationSummary -> Population -> 晋升 / 回滚
```

| 组件                 | 职责                                                               | 边界                                      |
|----------------------|--------------------------------------------------------------------|-------------------------------------------|
| Target               | 组合 Source、Seed、Materializer、Solver Driver、Validator 和 Catalog | 不提供题目，不参与打分                |
| CandidateSeed        | 提供 H0 必需的 Prompt、Profile、Skill 和工具起点              | 不包含 Benchmark 答案或凭据            |
| Environment          | 提供题目、工作区、Verifier 和 Reward                          | 不声明 Candidate 哪些文件可写          |
| Population           | 管理 Branch 数量、经验共享、竞争 Budget 和最优 Candidate        | 只消费通用 BranchProjection 和评分         |
| Module Search        | 从 Target Catalog 选择本轮 Region 组合                           | 只返回 Region ID，不能指定文件路径      |
| Updater              | 读取 feedback，形成假设并修改 Candidate                         | 只能写 MutationLease 允许的路径          |
| Solver               | 使用 Candidate Harness 解题                                       | 看不到 gold、sealed final 和真实 API Key  |
| Controller / Gateway | 发权、调度、审核、评测、晋升/回滚；强制模型与 Token 上限       | 是冻结信任根，不允许 Candidate 修改       |

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

## 可插拔 Target、Environment 与 Recipe

| 场景 / 对象          | 已实现的组合                                               | 用途                                      |
|----------------------|--------------------------------------------------------------|-------------------------------------------|
| Cowork               | MSA Minimal + Cowork Seed + SkillsBench                      | 真实 Office/PDF/PPTX/XLSX 任务与 Verifier |
| Reasoning 工程冒烟   | MSA Minimal + Reasoning Seed + Synthetic Text Reasoning       | 证明真实模型、变异、评分与五种 Mode 链路      |
| Reasoning 正式路径   | MSA + HLE，或 DSH + PutnamBench                         | 保留 HZY 原有生产链路，需专用数据和运行时       |
| 未来 Target          | DSH、PI Agent 或其他 Harness + 自己的 Seed/Catalog/Driver | 新增 Adapter 即可，不改 Population 算法          |

新 Experiment 通过 `spec.recipe` 进入通用 Population。旧 Cowork Experiment 不写
Recipe 时仍保留原来的单 Champion 目录和行为；旧 Reasoning Campaign 仍可以使用
HZY 原有 Runtime。这是兼容层，不是两套新算法。

Model Gateway 给 Controller、Solver 和 Updater 分配不同令牌。Solver/Updater 即使在
请求体里伪造 `model` 或 `max_tokens`，网关也会用 Experiment 冻结值覆盖；
两个角色的 Usage 也分开计量。

L1/L2/L3 现在是 Target 自己的风险分层，不再隐含“一定是 DSH 目录”。
DSH 可以把 Preset/Skill 声明为 L1/L2，MSA Cowork 可以把 Profile/Skill/Agent Loop
声明为自己的 L1/L2/L3。路径白名单、扩展名、可执行位、文件大小、符号链接和
语义 Validator 都由 Controller 在 Updater 结束后重算，不依赖提示词自觉。

Target 的搜索空间现在从粗粒度层级中独立出来：`mutationLevel` 只是本次实验的
风险上限，`MutationCatalog.regions` 是 Target 自己的可搜索模块。例如 DSH L1 可以分成
`preset-composition` 和 `skill-guidance`，L2 再加 `skill-scripts`。搜索算法可以只选
其中一个，但无法绕过 L1/L2 上限。旧 Experiment 不写 `strategy` 时会自动使用
`linear-hill-climb`，它选择风险上限内全部 Region，所以权限和旧版完全一致。

## MSA Minimal 怎么变成不同 Solver

共享的最小 Agent Loop 已提交到
[`sources/msa-minimal-harness/`](sources/msa-minimal-harness/README.md)：

```text
task -> model -> 可选 <bash> -> observation -> model -> <final>
```

Controller 先复制这份固定 Source，再叠加 Target 自己的 CandidateSeed：

| Target                     | CandidateSeed                         | H0 起点                                      |
|----------------------------|---------------------------------------|----------------------------------------------|
| `msa-minimal`              | `targets/msa-minimal/cowork-v1/`      | Cowork Prompt、4 类 Office Skill、Chat Completions |
| `msa-minimal-reasoning`    | `targets/msa-minimal/reasoning-v1/`   | Math Profile、Chat Completions 和 Reasoning CLI     |

两个 Target 共用同一份 Agent Loop Source，但各自声明自己的 Catalog：

| 层级       | MSA Cowork 例子                            | MSA Reasoning 例子                     |
|------------|--------------------------------------------|--------------------------------------------|
| L1         | Cowork Profile 与 Office Skill 文档          | Math Profile 与答案/自检策略             |
| L2         | `agent.py` + `tools.py`                    | `agent.py` + `tools.py`                    |
| L3         | `model.py` + `run.py`                      | `model.py` + `run.py`                      |
| 永不可写   | Controller、Evaluator、题目/split、gold、凭据、Budget 和晋升策略 | 同左                                         |

不同 Target 不需要共用相同目录名。Controller 只消费标准化 Region、路径权限和
Validator 结果；因此未来接 PI Agent 时，它可以声明完全不同的 L1/L2/L3。

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

| 要修改的内容                    | 文件 / 字段                                              |
|---------------------------------|------------------------------------------------------------|
| Harness 源码和固定 Revision        | Target Adapter：`spec.source`                               |
| H0 Prompt、Skill、工具起点       | Target Adapter：`spec.materialization.seedPath`              |
| Solver 怎么启动                   | Target Adapter：`spec.solver.protocol/runtime`                |
| 可进化模块、依赖和风险层         | Target Adapter：`spec.mutation.catalog/levels`                |
| 题目、工作区和 Verifier           | Environment Adapter                                          |
| 主指标和晋升 Gate               | Benchmark + Evaluation Policy                                |
| 五种 Mode、Branch、Budget、beta      | EvolutionRecipe：`spec.population`                           |
| Updater 自选模块或外部策略选模块    | EvolutionRecipe：`spec.moduleSearch.authority`                |
| 模块组合搜索算法                 | SearchStrategy Adapter                                       |
| Solver / Updater 模型与 Token 上限 | Experiment：`spec.models`                                  |

当前通用示例使用同一组
`recipes/population-smoke/*.yml`，分别组合为：

- `experiments/cowork-msa-smoke-<mode>.json`
- `experiments/reasoning-msa-smoke-<mode>.json`

Reasoning 冒烟题只用来验证工程链路，**不是 HLE，不能当作模型能力成绩**。
HZY 原有 HLE/PutnamBench 生产 Campaign 仍位于 `benchmarks/hle-text-math/` 和
`benchmarks/putnambench-lean/`。

### 模式与 Budget

```yaml
apiVersion: harness-rsi/v1alpha1
kind: EvolutionRecipe
spec:
  population:
    mode: combined
    concurrency: { n_branches: 2 }
    budget: { total_budget: 4, beta: 0.5 }
    peer_sharing: { enabled: true }
    competition: { enabled: true, bonus_grant_unit: 1 }
  moduleSearch:
    authority: strategy-directed
    riskCeiling: l1
    strategy: linear-hill-climb
```

Single 必须设 `n_branches=1`。Peer sharing 只在 Mutualism/Combined 开启；
Competition 只在 Competition/Combined 开启。

### 模型与模块搜索

Experiment 分别冻结 Solver 和 Updater 的 Provider、Model 与 `maxTokens`。
`strategy-directed` 由 SearchStrategy 先选 Region，`updater-directed` 则把风险上限内的
Region 交给 Updater 结合 Bad Case 自己选择。无论哪种方式，最终可写路径都由
Controller 生成 MutationLease，不靠 Prompt 软约束。

凭据只能在运行时注入，不能进入 Experiment、Adapter、Candidate、Trace 或 Git。
正式 Benchmark 的 validation/test ID 必须互斥，sealed final 不得参与变异、晋升或早停。

## 启动与产物

先做静态校验：

```bash
npm run check
npm test
for scene in cowork reasoning; do
  for mode in single independent mutualism competition combined; do
    npm run rsi -- experiment validate \
      --config "experiments/${scene}-msa-smoke-${mode}.json"
  done
done
```

真实 Cowork 运行还需要配置 SkillsBench 根目录和 Provider 环境变量。下面只展示
变量名，不要把真实 Key 写入 shell 历史或仓库：

```bash
export RSI_SKILLSBENCH_ROOT=/absolute/path/to/skillsbench
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY && export RSI_PROVIDER_API_KEY

npm run rsi -- runtime build \
  --experiment experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment run \
  --config experiments/cowork-msa-smoke-single.json \
  --run-id cowork-single-smoke-001

unset RSI_PROVIDER_API_KEY
```

`experiment run` 进化期只读 feedback/selection。当前通用 Population smoke 不解封 final；
旧单 Champion Cowork Run 仍使用 `experiment finalize` 做一次性 final 评测。
这些小题集只用于跑通工程闭环，不代表统计显著性结论。

当前通用 Population 的边界也需要明确：基础设施异常会被标成
`PAUSED_INFRASTRUCTURE` 并让命令失败，绝不会冒充 0 分成功结束；但跨进程恢复尚未接入
CLI，排除故障后应使用新 Run ID 重跑。Model Gateway 的请求上限目前按 Branch 生效，
还不是整个 Population 的全局费用上限。生产 HLE/PutnamBench 继续使用原有的恢复、
sealed test 与 Final 链路，不能把这里的公开 Smoke 替代为正式评测。

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
