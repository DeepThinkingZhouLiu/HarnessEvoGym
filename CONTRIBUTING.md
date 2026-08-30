# HarnessEvoGym Contributor 开发指南

感谢你参与 HarnessEvoGym。根目录 [README](README.zh.md) 是对外项目首页；
这份文档面向实现 Target、Environment、Updater、SearchStrategy、评测协议和
Controller 算法的 Contributor。

项目目前处于 Research Preview。可以扩展，但任何新能力都必须保持三个条件：

- **可复现**：源码、Seed、配置、模型和评测来源都能固定身份。

- **可隔离**：Candidate 只能影响解题过程，不能修改裁判、凭据或晋升规则。

- **可比较**：相同实验必须复用同一 H0、Split、主指标、Budget 和 Trial 协议。

## 开发前先建立正确心智模型

平台不是“让一个 Agent 随便改自己”。它组合三个独立维度：

~~~
Target × Environment × EvolutionRecipe
~~~

| 维度                  | 回答的问题                     | 典型内容                                           |
| --------------------- | ------------------------------ | -------------------------------------------------- |
| Target                | 优化谁？哪些模块允许改？       | Harness Source、Seed、Runtime、Validator、Catalog |
| Environment           | 在哪里做题？怎么评分？         | Task、Workspace、Verifier、Metric、Split           |
| EvolutionRecipe       | 怎么组织和搜索？               | Mode、Branch、Budget、共享、SearchStrategy         |
| Trusted Controller    | 谁来强制规则并决定晋升？       | Lease、Diff、调度、谱系、评测、晋升、回滚         |

Controller 不应该出现“如果是 DSH 就这样，如果是 Cowork 就那样”的业务分支。
场景差异应进入带版本的 Adapter、Driver 或协议实现。

## 术语表

| 术语                  | 大白话解释                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| H0                    | 尚未进化的公共起点，所有可比较实验都从同一份 H0 开始                      |
| Candidate             | Updater 基于某个父版本改出来的一份完整 Harness 实例                        |
| Champion / Incumbent  | 当前已经通过 Gate、下一轮继续作为父版本的 Candidate                        |
| Branch                | 一条独立进化路线，有自己的 Champion、历史、Strategy State 和 Budget        |
| Population            | 同一 Mode 管理的一组 Branch                                                 |
| Population Mode       | Branch 怎么相处：独立、共享经验、竞争预算，或两者同时开启                  |
| Mutation Region       | Target 定义的一个稳定可优化模块，例如 `skill-guidance` 或 `agent-loop`   |
| L1/L2/L3              | Target 自己定义的累计风险上限，不是所有 Harness 共用的目录                 |
| SearchStrategy        | 决定下一轮开放哪些 Region；只返回 Region ID，不直接返回路径                |
| MutationPlan          | Strategy 提出的“父 Candidate + Region 组合”                                |
| MutationLease         | Controller 校验 Plan 后生成的单轮硬写权限                                  |
| Updater               | 读取 Bad Case、形成假设并实际修改 Candidate 的 Coding Agent                |
| Solver                | 使用 Candidate Harness 做 Environment 题目的执行角色                       |
| EvaluationSummary     | 不同场景统一输出的聚合评测结果                                             |
| Promotion Gate        | 判断 Candidate 是否严格优于配对 Baseline/Champion 的冻结规则               |
| Resume                | 基础设施中断后，从同一 Run 复用已原子提交的逐题结果继续                    |
| Sealed Final          | 进化过程完全不可见、全局最优版本锁定后只允许评一次的最终测试集             |

Candidate 和 Branch 的区别尤其重要：Candidate 是“某一版代码”，Branch 是“持续产生多版
Candidate 的进化路线”。一个 Branch 可以先后生成 `g001`、`g002`、`g003`；只有
通过 Gate 的版本才成为该 Branch 的新 Champion。

## 一轮进化的完整数据流

~~~
Target Source + CandidateSeed
  -> Materializer 生成 H0
  -> Environment 对 H0 做配对基线评测
  -> SearchStrategy 选择父 Candidate 与 Region ID
  -> Controller 验证风险、依赖、冲突并发放 MutationLease
  -> Updater 在 Lease 范围内生成新 Candidate
  -> Controller 重算完整 Diff + Semantic Validator
  -> Solver 在 feedback / selection 上运行
  -> Environment Verifier 生成 Result
  -> Evaluation Policy 生成 Promotion Decision
  -> 晋升新 Champion，或回滚并保留原 Champion
~~~

Controller 不信任 Updater 自报“我只改了某些文件”，而是对前后 Candidate 做完整快照和
Diff。基础设施错误必须向上抛出并暂停实验，不能伪装成合法 0 分。

## 仓库结构

~~~
HarnessEvoGym/
├── adapters/                 # Target / Updater / Provider / Strategy 的声明
├── benchmarks/               # Benchmark 元数据、Split 和来源摘要
├── controller/
│   ├── src/                  # 冻结的调度、协议、安全和评测主逻辑
│   └── test/                 # 单元、协议、隔离和端到端测试
├── docker/                   # Gateway、Solver、Verifier 等隔离 Runtime
├── environments/             # Environment Adapter 与只读场景资产
├── evaluation/               # 指标、Policy 和结果示例
├── experiments/              # Target × Environment × Recipe 的最终组合
├── prompts/                  # Updater 等受信 Prompt 模板
├── recipes/                  # 五种 Mode、Branch、Budget 与模块搜索配置
├── sources/                  # 固定的 Harness Source / Submodule
├── strategies/               # 内置或外部 SearchStrategy 实现
├── targets/                  # Target-owned CandidateSeed
├── scripts/                  # 可复现的数据准备、运行和恢复脚本
├── docs/                     # 架构、搜索、Mode 和场景 Runbook
└── media/readme-hero/        # README Remotion 动效源码
~~~

不要把 RSI Controller 逻辑直接写入 `sources/deepseek-harness/` 或其他上游 Source。
Source 是被优化或被调用的对象，Controller 才是冻结实验底座。

## 协议边界

### Target

Target Adapter 组合：

| 部件                  | 职责                                                         |
| --------------------- | ------------------------------------------------------------ |
| Source Resolver       | 解析并固定 Harness 源码身份                                  |
| CandidateSeed         | 提供 H0 的 Prompt、Profile、Skill 与必要工具                 |
| Materializer          | 把 Source + Seed 合成为一份独立 Candidate                    |
| Solver Driver         | 在 Environment 工作区中启动 Candidate                        |
| Semantic Validator    | 检查语法、必需文件、Profile 和 Target 私有约束               |
| Mutation Catalog      | 声明 Region、路径、扩展名、依赖、冲突和风险层                |

现有 MSA Cowork 示例：

- Adapter：[`adapters/targets/msa-minimal-cowork-rsi.yml`](adapters/targets/msa-minimal-cowork-rsi.yml)

- Source：[`sources/msa-minimal-harness/`](sources/msa-minimal-harness/)

- Seed：[`targets/msa-minimal/cowork-v1/`](targets/msa-minimal/cowork-v1/)

- Runtime：[`controller/src/runtimes/msa-minimal-cowork.mjs`](controller/src/runtimes/msa-minimal-cowork.mjs)

- 通用注册入口：[`controller/src/factories.mjs`](controller/src/factories.mjs)

L1/L2/L3 必须由每个 Target 自己解释。MSA Cowork 的 L1 是 Profile/Skill，L2 是
`agent.py/tools.py`；另一个 Harness 可以使用完全不同的路径和 Region 名称。

### Environment

Environment 负责：

- 读取并固定 Benchmark 与 Split；

- 为每道题创建隔离工作区，并只放入题目允许的输入；

- 选择或构建 Task Image；

- 启动 Solver Driver，但不理解 Candidate 内部实现；

- 在 Solver 退出后启动冻结 Verifier；

- 输出统一 Result 和 EvaluationSummary；

- 区分 feedback、selection 和 sealed final 的信息可见性。

OmegaUse 实现位于
[`controller/src/environments/omegause-officeval.mjs`](controller/src/environments/omegause-officeval.mjs)，
配置位于 [`environments/omegause-officeval-formal.yml`](environments/omegause-officeval-formal.yml)。

feedback 可以向 Updater 暴露 Bad Case 证据；selection 只能输出用于晋升的受控结果；
sealed final 在进化期间不能被 Loader、Solver、Updater 或 Strategy 打开。

### EvolutionRecipe 与 Population

Recipe 只描述算法组合，不描述某个 Harness 的目录：

~~~yaml
apiVersion: harness-rsi/v1alpha1
kind: EvolutionRecipe
spec:
  population:
    mode: combined
    concurrency: { n_branches: 2 }
    budget: { total_budget: 32, beta: 0.5 }
    peer_sharing: { enabled: true }
    competition: { enabled: true, bonus_grant_unit: 1 }
  moduleSearch:
    authority: strategy-directed
    riskCeiling: l2
    strategy: linear-hill-climb
~~~

五种 Mode 的职责只有 Population Topology：

| Mode            | Branch 数 | 经验共享 | Budget 竞争 |
| --------------- | --------: | -------- | ----------- |
| Single          | 1         | 否       | 否          |
| Independent     | N         | 否       | 否          |
| Mutualism       | N         | 是       | 否          |
| Competition     | N         | 否       | 是          |
| Combined        | N         | 是       | 是          |

Mode 不负责决定“这轮改 Skill 还是 Agent Loop”；那是 SearchStrategy 的职责。

### SearchStrategy

SearchStrategy 输入的是脱敏 Candidate 摘要、Target Catalog、风险上限和历史收益，输出：

- 父 Candidate ID；

- 本轮 Region ID 列表；

- 可序列化的 Strategy State；

- 可选的 Branch `exhausted` 状态。

它不能指定文件路径、修改 Candidate、读取凭据或接触隐藏评测。Controller 会把 Region ID
翻译成可信路径，再发放 MutationLease。

内置策略：

- `linear-hill-climb`：每轮开放风险上限以内的全部 Region，保持旧流程兼容；

- `progressive-risk-expansion`：从低风险层开始，连续未晋升后扩大到下一个
  Target-defined 风险层；

- Docker Strategy API：无网络、无挂载、只交换受大小限制的 JSON。

新增策略前先读 [搜索策略协议](docs/search-strategy.zh.md)。

### Updater

Updater 是完整 Coding Agent，通常同时完成 Bad Case 分析、修改提案、代码编辑和局部检查。
它不是 Controller 的一部分，也不拥有晋升权。

通用 Prompt 模板位于 [`prompts/updater.md`](prompts/updater.md)。Controller 会填入：

- Target 名称和当前 Candidate；

- feedback 与历史证据；

- 本轮 Region、可写/只读路径和语义限制；

- Mutation Report 输出位置。

软 Prompt 负责指导推理，硬 Lease 负责约束写入。新 Updater 必须有独立 Driver、固定
Distribution/Revision、隔离的 HOME、最小挂载和单独模型令牌。

Codex 示例：

- Adapter：[`adapters/updaters/codex-cli.yml`](adapters/updaters/codex-cli.yml)

- Driver：[`controller/src/runtimes/codex-updater.mjs`](controller/src/runtimes/codex-updater.mjs)

## 如何新增一个 Target

1. 在 `sources/` 中固定 Harness Source。使用 Git Revision 或 Repository Tree 指纹，
   不允许运行时下载浮动主分支。

2. 在 `targets/<target>/<profile>/` 创建最小 CandidateSeed。Seed 只提供起点，不包含
   Benchmark 答案、Rubric、真实轨迹或凭据。

3. 在 `adapters/targets/` 声明 Source、Materializer、Solver Runtime、Validator、
   Mutation Catalog 和 L1/L2/L3。

4. 若现有 Driver 协议不能运行该 Harness，在 `controller/src/runtimes/` 实现新 Driver，
   再通过 `controller/src/factories.mjs` 注册带版本协议。

5. 为 Target 实现语义 Validator。至少检查必需文件、可执行语法、配置预算和
   Target-specific 不变量。

6. 为每个 Region 声明稳定 ID、路径白名单、扩展名、依赖、冲突和风险层。Strategy 永远
   只能看到 ID。

7. 添加物化确定性、路径逃逸、坏语法、越权 Diff、Runtime 挂载和最小假网关 E2E 测试。

8. 创建一个不改 Controller 主循环的 Experiment，证明新 Target 能在至少一个
   Environment 中从 H0 运行到 Promotion Decision。

## 如何新增一个 Environment

1. 定义任务协议、输入文件、允许的工具和隔离资源；

2. 固定 Benchmark Source 与 Split 摘要；

3. 把 feedback、selection、sealed final 做成互斥集合；

4. 实现 Workspace Materialization 和 Solver 调用；

5. 在独立只读 Verifier 中实现评分，不允许 Solver 看到 Verifier 或 Gold；

6. 输出标准 Result v2 / EvaluationSummary，并明确主指标；

7. 把超时、Provider、Docker 和 Verifier 故障区分于合法 0 分；

8. 覆盖并发、代理环境、符号链接、产物大小、Resume 和重复 Final 测试。

只更换训练题目不等于接入了新 Environment。工具、工作区、Verifier、指标和 Split
协议都必须明确。

## 如何新增一个 SearchStrategy

内置策略实现放在 `controller/src/strategies/`；配置 Adapter 放在
`adapters/strategies/`。如果希望第三方 Contributor 独立发布算法，优先使用
`strategies/examples/round-robin/` 展示的 Docker 协议。

新 Strategy 必须证明：

- 同一 Context + State 得到可复现输出，或显式固定随机 Seed；

- 只返回 Catalog 中存在的 Region；

- 不超出 Recipe 的 Risk Ceiling 与最大 Region 数；

- State 是严格 JSON，可做大小限制和摘要；

- Promotion、Reject、Invalid Proposal 与 Infrastructure Failure 的观察语义不同；

- 不通过 Context、State、日志或错误消息夹带敏感字段。

## 如何新增或修改 Population 算法

普通实验算法优先通过 Recipe 和 Strategy 组合，避免新建 Mode。只有当 Branch 之间的
拓扑关系真的变化时，才修改 `controller/src/population-orchestrator.mjs`。

PopulationOrchestrator 只消费：

- `BranchProjection`；

- `BranchStepResult`；

- `EvaluationSummary`；

- 通用 Budget 与 Peer Evidence。

它不能依赖 `validationVerified`、Office 文件、Reasoning 答案或某个 Harness 的目录。
改 Population 属于高风险变更，必须同时回归五种 Mode、Cowork 与 Reasoning。

## Experiment 配置

Experiment 是最终可执行组合，只做引用和冻结：

~~~json
{
  "spec": {
    "recipe": "recipes/population-formal-linear-32/single.yml",
    "adapters": {
      "target": "adapters/targets/msa-minimal-cowork-rsi.yml",
      "updater": "adapters/updaters/codex-cli.yml",
      "environment": "environments/omegause-officeval-formal.yml",
      "provider": "adapters/providers/zcloud-openai.yml",
      "strategy": "adapters/strategies/linear-hill-climb.yml"
    },
    "benchmark": "benchmarks/cowork-omegause-officeval-linux-v1/benchmark.json",
    "policy": "evaluation/policies/cowork-officeval-rsi.json"
  }
}
~~~

不要在 Experiment 中复制 Adapter 的业务字段，也不要写真实 API Key。任何会改变
Candidate、题目、评分、Budget、模型或晋升语义的配置变化，都必须使用新 Experiment ID
和新 Run ID。

## 当前正式五 Mode 配置

正式配置位于 `experiments/cowork-msa-rsi-formal32-codex-*.json`：

| 维度             | 固定值                                                       |
| ---------------- | ------------------------------------------------------------ |
| Solver           | MSA Minimal Cowork，12 步                                    |
| Updater          | Codex CLI 0.149.1                                            |
| Model            | `gpt-5.6-terra/high`，Solver 与 Updater 分别计量             |
| Search           | `linear-hill-climb`，Risk Ceiling = L2                       |
| Budget           | 每个 Mode 32 Candidate Credit                                |
| Branch           | Single = 1；其余 Mode = 2                                   |
| Suite 并发       | 最多 2 个 Mode；每 Branch 最多 2 道题                        |
| Split            | 55 feedback / 18 selection / 18 sealed final                 |
| Seed / Trial     | `20260827` / 每题 1 Trial                                    |

运行器 [`scripts/run-cowork-formal32-five-mode.mjs`](scripts/run-cowork-formal32-five-mode.mjs)
会持久化 Suite State，按最多两个 Mode 并发调度；只会自动恢复 Controller 已经原子标记为
`PAUSED_INFRASTRUCTURE` 的 Run，不会不安全地重启仍处于 `EVOLVING` 的 Run。

## 安全不变量

以下内容不能由 Candidate、Updater 或 SearchStrategy 修改：

- Judge / Evaluator / Verifier 代码与 Rubric；

- Benchmark Split、Gold、Sealed Final；

- Controller、Promotion / Rollback Policy、事件格式；

- Sandbox、资源上限、Credential 与 Model Gateway；

- Target 的 Catalog、风险上限和 Validator；

- Experiment 冻结的模型、Token 上限、Budget 和 Seed。

需要同时维护以下隔离：

| 角色             | 必须满足的边界                                                |
| ---------------- | ------------------------------------------------------------- |
| Solver           | Candidate 只读、Task Workspace 可写、看不到 Gold/Key          |
| Updater          | 当前 Candidate 可写、反馈只读、只能经过隔离 Gateway           |
| Verifier         | Submission 只读、Evaluator 只读、无模型 Key                   |
| SearchStrategy   | 无网络、无挂载、无代理凭据，只交换脱敏 JSON                   |
| Controller       | 持有真实身份、Lease、摘要和状态机，不执行 Candidate 决策逻辑  |

## 测试与验证

先跑最小相关测试，再扩大范围：

~~~bash
# 静态语法与脚本检查
npm run check

# 全量 Controller 测试
npm test

# 校验一个 Experiment，不调用模型
npm run rsi -- experiment validate \
  --config experiments/cowork-msa-rsi-formal32-codex-single.json
~~~

变更类型与最低验证：

| 变更类型                    | 最低验证                                                         |
| --------------------------- | ---------------------------------------------------------------- |
| README / 文档               | Markdown 链接、命令路径、生成素材、`git diff --check`            |
| Target / CandidateSeed      | Digest、物化确定性、Semantic Validator、Solver 假网关 E2E         |
| Environment / Verifier      | Split、Workspace、隔离、合法 0 分与基础设施错误、Resume            |
| Updater                     | Distribution 摘要、HOME/网络/挂载、Lease、报告与 Stop 协议         |
| SearchStrategy              | Context 脱敏、Region 白名单、State JSON、风险层与 Exhaustion       |
| Population / Evaluation     | 五 Mode、两类 Environment、Budget、Delta、Promotion 与 Final       |
| Gateway / Sandbox           | 令牌隔离、强制模型参数、重试、流中断、代理清空和无凭据日志          |

不要用一次真实 Provider 成功替代确定性测试；也不要只用 Mock 测试就声称真实 E2E 已完成。

## Git 与 PR 工作流

- 从最新 `main` 创建独立开发分支和命名清楚的 Worktree；

- 不覆盖、不重置其他 Contributor 的工作；

- 保持提交单一职责，协议变更、数据变更和大规模文档改版尽量分开；

- Source/Submodule 升级应单独提交，并记录上游 Revision 与许可证影响；

- 不提交 `.rsi/`、API Key、隐藏题、Final Rubric、真实用户轨迹或本地缓存；

- 修改公开协议时，同步检查 Producer、Consumer、默认值、迁移和兼容路径；

- PR 描述必须写清“改了什么、为什么、信任边界、验证证据、未验证风险”。

建议提交前执行：

~~~bash
npm run check
npm test
git diff --check
git status --short
~~~

## PR Checklist

- [ ] 变更归属 Target、Environment、Recipe/Strategy、Updater、Controller 或文档中的明确一层
- [ ] 没有把场景或 Harness 私有逻辑写进通用 Population 主循环
- [ ] 新配置固定了 Source、Seed、模型、Budget、Split 与 Policy 身份
- [ ] Updater 写权限能被 MutationLease 和最终 Diff 硬校验
- [ ] Solver、Updater、Verifier、Strategy 没有拿到不需要的网络、挂载或凭据
- [ ] 基础设施错误不会被记成合法 0 分或错误晋升
- [ ] 新增/修改协议有 Producer、Consumer、默认值和向后兼容测试
- [ ] Smoke 与正式 Benchmark 的结论边界写清楚
- [ ] 相关测试、`npm run check` 和 `git diff --check` 已通过
- [ ] 文档、示例命令和路径已同步更新

## README 动效怎么维护

对外 README 动效源码位于 [`media/readme-hero/`](media/readme-hero/)，使用独立 Remotion
依赖，不影响 Controller 的根 `package.json`：

~~~bash
cd media/readme-hero
npm ci
npm run render:still
npm run render:gif
~~~

生成文件：

- `docs/assets/harness-evo-gym-hero.png`：静态预览和降级素材；

- `docs/assets/harness-evo-gym-loop.gif`：根 README 使用的循环动效。

修改动画时必须从 `useCurrentFrame()` 驱动，不要使用 CSS Animation/Transition；渲染后
至少人工检查一张完整帧，并确认 GIF 大小适合 GitHub。

## 当前边界

- Synthetic Text Reasoning 只验证通用链路，不能替代 HLE 正式结果；

- PI Agent 仍是 Example Adapter，尚未完成 Runtime、Seed、Validator 和 E2E；

- 正式 Cowork 目前一个 Seed、每题一个 Trial，不能直接声称统计显著；

- Model Gateway 请求配额目前按 Branch 统计，不是全 Population 的统一费用上限；

- Sealed Final 一旦成功打开并生成结果，就不能根据该结果继续修改 Candidate 后重测。

更多设计细节：

- [总体架构](docs/architecture.zh.md)

- [Population 五种 Mode](docs/controller-modes.zh.md)

- [搜索空间与 SearchStrategy](docs/search-strategy.zh.md)

- [OmegaUse Cowork Runbook](docs/cowork-mvp.zh.md)

- [评测协议](evaluation/README.md)
