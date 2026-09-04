# HarnessEvoGym

[English](README.md) | 中文

一个把 **“优化谁”、“在哪里做题”、“怎么进化”** 拆开配置的 Harness
自进化实验平台。当前已经能用同一个 Controller 组合 MSA Minimal Target、
OmegaUse-OfficeVal Cowork 环境或文本 Reasoning 冒烟环境，并运行
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
| Cowork               | MSA Minimal + Cowork Seed + OmegaUse-OfficeVal               | 真实 Word/PPT/Excel 交付任务与加权 Rubric |
| Reasoning 工程冒烟   | MSA Minimal + Reasoning Seed + Synthetic Text Reasoning       | 证明真实模型、变异、评分与五种 Mode 链路      |
| Reasoning 正式路径   | MSA + HLE，或 DSH + PutnamBench                         | 保留 HZY 原有生产链路，需专用数据和运行时       |
| 未来 Target          | DSH、PI Agent 或其他 Harness + 自己的 Seed/Catalog/Driver | 新增 Adapter 即可，不改 Population 算法          |

Cowork 现在接的是更符合 Office Agent 场景的
`baidu-frontier-research/OmegaUse-OfficeVal`。上游共 100 道任务；当前 Linux
运行链使用 91 道静态 Verifier 任务，排除 9 道依赖 Windows Office COM
的题。固定划分是 `55 feedback / 18 selection / 18 sealed final`：
feedback 可以向 Updater 返回详细失败信息，selection 只用聚合分数决定是否晋升，
final 在 Champion 锁定后只解封一次。另有 3 道题的 Word/PPT/Excel Smoke，
三道题都从正式 feedback 集中取，只证明链路能跑，不消费正式验证集和测试集。

Solver 只能看到任务说明和原始 Office 文件；Rubric、Verifier 和
sealed final 不会挂载给 Solver/Updater。Solver 产出的变更文件会被复制到
独立 Submission，再交给无网络、只读根文件系统的 Verifier 容器评分。
Reward 是通过 Dim1 格式门槛后的加权 Dim2 得分，并归一化到 `[0,1]`，
不再是只有 0/1 的 Skill 命中信号。

新 Experiment 通过 `spec.recipe` 进入通用 Population。旧 Cowork Experiment 不写
Recipe 时仍保留原来的单 Champion 目录和行为；旧 Reasoning Campaign 仍可以使用
HZY 原有 Runtime。这是兼容层，不是两套新算法。

Model Gateway 给 Controller、Solver 和 Updater 分配不同令牌。Solver/Updater 即使在
请求体里伪造 `model` 或 `max_tokens`，网关也会用 Experiment 冻结值覆盖；
两个角色的 Usage 也分开计量。OmegaUse 正式环境把上游额外重试固定为 5 次：仅对
429/502/503/504、连接中断和上游超时重试，并且只允许发生在响应 Header/Body 下发前；
已经开始返回的流绝不会重播，同一模型逻辑请求在 Usage 中仍只计一次。

Population 启动时还会对展开后的 Experiment、Recipe、Adapter、Benchmark、Policy 和
Updater Prompt 摘要生成统一 `configDigest`。每个 Branch 在创建运行目录和调用模型前
都必须重新得到相同摘要；校验后使用自己的只读 Prompt 副本。因此长实验中宿主侧配置
被修改时会直接失败，不会让不同 Branch 静默运行不同版本。

L1/L2/L3 现在是 Target 自己的风险分层，不再隐含“一定是 DSH 目录”。
DSH 可以把 Preset/Skill 声明为 L1/L2，MSA Cowork 可以把 Profile/Skill/Agent Loop
声明为自己的 L1/L2/L3。路径白名单、扩展名、可执行位、文件大小、符号链接和
语义 Validator 都由 Controller 在 Updater 结束后重算，不依赖提示词自觉。

Target 的搜索空间现在从粗粒度层级中独立出来：`mutationLevel` 只是本次实验的
风险上限，`MutationCatalog.regions` 是 Target 自己的可搜索模块。例如 DSH L1 可以分成
`preset-composition` 和 `skill-guidance`，L2 再加 `skill-scripts`。搜索算法可以只选
其中一个，但无法绕过 L1/L2 上限。旧 Experiment 不写 `strategy` 时会自动使用
`linear-hill-climb`，它选择风险上限内全部 Region，所以权限和旧版完全一致。

内置 `progressive-risk-expansion` 是与 Target 无关的渐进风险扩展策略：每个
Branch 先搜 L1，连续指定次数没有 Candidate 晋升时再扩大到 L2/L3；在风险
上限仍连续无晋升时，Strategy 标记该 Branch 搜索耗尽，Population 保留未用预算。
它是旧 `controller-sequential` 层级推进的通用 SearchStrategy 表达，不再使用
`legacy-*` 命名。

该策略是显式启用的，现有十个五 Mode 工程冒烟仍保留默认
`linear-hill-climb`。完整可运行组合位于
`experiments/reasoning-msa-progressive-strict-smoke.json`：它绑定 Single Population、
L1 -> L2 -> L3 的 9 轮最大 Budget、`progressive-risk-expansion` 以及严格
Reward 晋升 Policy。平分不会晋升，因此会正确累计未提升次数。
该 Synthetic Reasoning 配置只用于验证完整接线和层级过渡，不是 HLE 成绩。

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
| `msa-minimal-cowork-rsi`   | `targets/msa-minimal/cowork-v1/`      | 同一 H0，但开放完整 12 步 Cowork 工具循环 |
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
| MSA Solver 单题交互步数上限       | Target Adapter：`spec.solver.runtime.maximumSteps`          |

当前通用示例使用同一组
`recipes/population-smoke/*.yml`，分别组合为：

- `experiments/cowork-msa-smoke-<mode>.json`
- `experiments/reasoning-msa-smoke-<mode>.json`
- `experiments/cowork-msa-smoke-l2-single.json` 与
  `experiments/reasoning-msa-smoke-l2-single.json`：只用一代验证 L1+L2 Lease 与语义校验

Reasoning 冒烟题只用来验证工程链路，**不是 HLE，不能当作模型能力成绩**。
HZY 原有 HLE/PutnamBench 生产 Campaign 仍位于 `benchmarks/hle-text-math/` 和
`benchmarks/putnambench-lean/`。

当前 `msa-minimal` Cowork Adapter 把 `maximumSteps` 固定为 `1`，只用于低成本验证
五种 Mode 的真实模型闭环；Candidate Profile 即使把 `max_steps` 调高也不会生效。
已提供的 `msa-minimal-cowork-rsi` 则开放与 Profile 一致的 12 步上限，用于
55/18/18 OmegaUse-OfficeVal 受控 RSI 实验；不要直接拿 3 题 Smoke 分数做能力结论。
该限制对本轮只开放 L1 的实验是可信硬上限；若未来开放可修改 `agent.py/run.py` 的
L2/L3 并把 Candidate 视为主动恶意代码，还应在 Model Gateway 增加每个 Solver Session
的独立请求硬配额。

### 五种 Mode 公平线性 RSI 配置

`recipes/population-fair-linear/*.yml` 把五种 Mode 的可变异 Candidate 总预算统一为
4，搜索策略统一为 `linear-hill-climb`，只开放 MSA Cowork L1。对应实验是：

- `experiments/cowork-msa-rsi-linear-single.json`
- `experiments/cowork-msa-rsi-linear-independent.json`
- `experiments/cowork-msa-rsi-linear-mutualism.json`
- `experiments/cowork-msa-rsi-linear-competition.json`
- `experiments/cowork-msa-rsi-linear-combined.json`

五份配置共用同一 H0、Terra Solver/Updater、55 道 feedback、18 道 selection、
18 道 sealed final 与同一 Reward Gate。这是一套“流程完整、可变异预算对齐”的正式
配置起点，但当前每题仍只有 1 个 Trial，**不等于统计显著的 Benchmark
结论**。正式对外比较应将 Trial 提高到至少 3，预注册随机种子和 Gate。
多 Branch Mode 还会多做一次 H0 基线评测，所以最终比较时必须同时
报告 Solver/Updater Token 和墙钟时间，不能只看最终分数。

### Codex 0.149 Updater 对照实验

`adapters/updaters/codex-cli.yml` 把 Updater 从 DSH 换成官方 Codex CLI 0.149.1，
并固定 npm distribution 的绝对路径、包版本和完整 SHA-256 摘要。Codex 使用隔离的
`CODEX_HOME`，忽略用户配置与 Rules；它只读 feedback 和上游 Harness 源码，只能写
当前 Candidate 与独立 Mutation Report 目录。真实 Provider Key 只由 Controller-owned
Responses Gateway 持有，Codex 通过无网络 Bubblewrap 内的 Unix socket relay 调用
`gpt-5.6-terra/high`。Provider 请求和流中断最多重试 5 次。

可运行配置是
`experiments/cowork-msa-rsi-linear-single-l2-one-generation-codex.json`：从全新 H0
开始，使用 Single + `linear-hill-climb`，开放 MSA Cowork L1+L2，只生成一个
Candidate；feedback/selection 仍为同一组 55/18 OmegaUse-OfficeVal 任务，因此可用于和
DSH Updater 做同协议对照。自构建 `codex-dev --provider zcloud` 在模型协议上也可用，
但正式实验不能读取个人 `~/.codex`；应先把它安装到独立只读目录，固定版本和摘要，再用
新的 Updater Adapter 替换本配置，不要直接复用开发中的可变二进制。

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
npm run rsi -- experiment validate \
  --config experiments/reasoning-msa-progressive-strict-smoke.json
```

### Progressive 严格晋升示例

`reasoning-msa-progressive-strict-smoke` 不是只能通过单元测试调用的策略，
而是一套可以直接交给 `experiment run` 的完整组合：

```text
MSA Minimal Reasoning Target
  + Synthetic Text Reasoning Environment
  + Single Population / 9 轮最大 Budget
  + progressive-risk-expansion
  + strict-mean-reward-improvement-v1
```

严格 Policy 同时检查“至少一题 Reward 提升”、“平均 Reward 不下降”和
“Reward/resolved 零回退”。因此平分只能保留旧 Champion，不会被写成一次虚假晋升：

| Candidate 对比 | 是否晋升 | 原因                           |
|----------------|----------|--------------------------------|
| `0 -> 0`       | 否       | 没有任务真正提升               |
| `1 -> 1`       | 否       | 只是平分，不是进化               |
| `0 -> 1`       | 是       | Reward 提升且没有任务回退   |

仅执行前面的 `experiment validate` 不会请求模型。真实运行可能消耗最多
9 轮 Solver/Updater 预算；它用于验证严格拒绝和 L1 -> L2 -> L3 扩层，
不能宣传成 HLE 或正式 Benchmark 成绩。

### 真实运行

真实运行需要在运行时注入 Provider 环境变量。下面只展示变量名，
不要把真实 Key 写入 shell 历史或仓库：

```bash
export RSI_PROVIDER_BASE_URL=https://provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY && export RSI_PROVIDER_API_KEY

# Progressive Synthetic Reasoning：不需要外部 Office 数据。
npm run rsi -- runtime build \
  --experiment experiments/reasoning-msa-progressive-strict-smoke.json
npm run rsi -- experiment run \
  --config experiments/reasoning-msa-progressive-strict-smoke.json \
  --run-id reasoning-progressive-strict-001

# Cowork 需要固定版本的 OmegaUse Dataset 和 Evaluator Checkout。
export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
npm run rsi -- runtime build \
  --experiment experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment run \
  --config experiments/cowork-msa-smoke-single.json \
  --run-id cowork-single-smoke-001

# 受控 RSI：五种 Mode 的可变异总预算都是 4。
for mode in single independent mutualism competition combined; do
  npm run rsi -- experiment run \
    --config "experiments/cowork-msa-rsi-linear-${mode}.json" \
    --run-id "cowork-rsi-linear-${mode}-001"

  # 若 Provider/Docker/Verifier 异常导致暂停，修复后继续同一个 Run。
  # npm run rsi -- experiment resume \
  #   --run ".rsi/runs/populations/cowork-rsi-linear-${mode}-001"

  # Population 关闭并锁定全局最优 Branch 后，只解封一次 final。
  npm run rsi -- experiment finalize \
    --run ".rsi/runs/populations/cowork-rsi-linear-${mode}-001"

  # 仅当 Final 因基础设施失败，且 Controller 证明尚未创建任何 sealed-final
  # 产物时，可显式执行一次受审计恢复：
  # npm run rsi -- experiment finalize \
  #   --run ".rsi/runs/populations/cowork-rsi-linear-${mode}-001" \
  #   --recover-infrastructure
done

# 单次 L1+L2 Probe：正式 55/18 feedback/selection，只产生一个 Candidate。
npm run rsi -- experiment run \
  --config experiments/cowork-msa-rsi-linear-single-l2-one-generation.json \
  --run-id cowork-rsi-linear-single-l2-one-generation-001

unset RSI_PROVIDER_API_KEY
```

`experiment run` 进化期只读 feedback/selection。单 Champion 与通用 Population 都使用
`experiment finalize` 做一次性 final 评测；Population 入口会核对父状态、
`best-harness.json`、Best Branch Champion 和 Candidate Digest，然后仅比较该最优
Champion 与冻结 H0。父目录中的 `final-attempt.json` 使并发进程无法反复查看
sealed final，报告写入 `report/final-evaluation.json`。如果第一次 Final 在仅回放公开
feedback 时因上游 502/503/504 等基础设施故障失败，Controller 会在确认没有任何
sealed-final 路径或结果后，允许显式的 `--recover-infrastructure` 恢复一次。原 Claim
与失败事件始终保留，未完成的 feedback 证据会归档到 `final-recovery/`；一旦已接触
sealed final，或 Recovery 自身再失败，都会永久拒绝再次解封。

Reasoning 的 Synthetic Text 五 Mode 仍只是工程冒烟。HLE 正式实验必须先准备门控
`cais/hle` 数据、sealed split、固定 MSA Source 与专用 Runtime；这些条件缺失时，
不能把 Synthetic 结果替代为正式 Reasoning 成绩。

当前通用 Population 的边界也需要明确：基础设施异常会被标成
`PAUSED_INFRASTRUCTURE` 并让命令失败，绝不会冒充 0 分成功结束。Cowork Population 可以用
`experiment resume --run <population-run>` 在同一个 Controller Revision 下继续；恢复时会重验冻结
Bundle、Source、Candidate Digest 和 Mutation 边界，并把未完成轮次归档到 `recovery/`
后重跑。OmegaUse 会进一步按题读取原子提交的 `committed-result.json`：已经完成的题目
（包括合法 0 分）直接复用，只运行没有完成的题目；半成品会先移入 `recovery/trial-attempts/`
保留审计证据。基础设施失败不会在同一命令里自动重跑整题，必须由用户显式执行 Resume，
失败尝试的 Token/时间仍计入 Ledger。普通进化恢复必须是同一 Controller
Revision；只有上述“尚未访问 sealed final”的 Final Recovery 可以在显式参数下使用一个
继承原 Revision 的新 Controller，并同时记录进化版本和 Finalizer 版本。修改冻结配置后仍必须
使用新 Run ID。Model Gateway 的请求上限目前按 Branch 生效，还不是整个 Population 的全局费用上限。
生产 HLE/PutnamBench 继续使用原有的恢复、
sealed test 与 Final 链路，不能把这里的公开 Smoke 替代为正式评测。

单个 Campaign 使用
`scripts/resume-hle-short-updater-root.mjs evolve start`，显式传入 config、
runtime、campaign ID、campaigns root、source root 和 credential FD。

每个 branch 写入 `public/state.json` 和 `public/evolution-log.jsonl`。种群关闭后
输出所有 branch incumbent，以及 `best-harness.json` 和
`best-harness.patch`；一次性 Final 成功后还会写入
`report/final-evaluation.json`，并在父 `public/state.json` 中记录可审计的 Final 状态。

详细说明：

Updater 的通用提示词模板位于 [`prompts/updater.md`](prompts/updater.md)。Controller 会在
启动前把 Target 名称、当前 Candidate、Mutation Region、可写/只读路径、语义约束和报告路径
填入模板，并把冻结副本写进 Run 的 `trusted-inputs/updater-prompt.md`。

- [Controller 五种模式](docs/controller-modes.zh.md)
- [架构与信任边界](docs/architecture.zh.md)
- [搜索空间、搜索策略与兼容边界](docs/search-strategy.zh.md)
- [HLE 变异工作流](docs/hle-mutation-workflow.zh.md)
- [Cowork L1/L2 运行与扩展](docs/cowork-mvp.zh.md)

本仓 Controller 使用 [MIT License](LICENSE)，Vendored Source 与 Submodule 保留
各自许可证和 NOTICE。
