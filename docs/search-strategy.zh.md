# 搜索空间、搜索策略与兼容边界

[English](search-strategy.md) | 中文

## 一句话说明

Target 负责说“我哪些模块可以改”，SearchStrategy 负责说“这轮试哪些模块”，
Updater 负责“根据 Bad Case 真正分析并改代码”，Controller 负责“发权、验收、评分和回退”。

```text
Target Catalog              SearchStrategy              Controller
哪些 Region 可搜  ->  父 Candidate + Region ID  ->  校验 + MutationLease
                                                              |
                                                              v
Feedback ---------------------------> Updater ---------> Candidate Diff
                                                              |
                                                              v
                                                   Solver -> Evaluator -> Gate
```

这样拆开后，搜索算法可以是线性 hill climbing、round robin、bandit、进化算法或种群算法；
它们都不需要知道 DSH 或 pi-agent 的真实目录。

## 三个不同概念

| 概念                 | 由谁定义       | 作用                                                   |
|----------------------|----------------|--------------------------------------------------------|
| Risk Level           | Target         | L1/L2/L3 只表示风险上限，不是搜索算法              |
| Mutation Region      | Target         | 某个 Harness 的稳定可搜索模块，包含路径、扩展名和依赖 |
| Search Strategy      | Controller 贡献者 | 只选父 Candidate 和 Region ID，不拥有写入权限          |

DSH Cowork 的当前 Catalog 是：

| Region ID             | 风险 | 含义                              |
|-----------------------|------|-----------------------------------|
| `preset-composition`  | L1   | Preset 组合和声明式配置             |
| `skill-guidance`      | L1   | Skill 文档、Prompt 和工作方法      |
| `skill-scripts`       | L2   | Skill 内受控脚本实现               |

## 四层强制边界

- Target Adapter 先声明旧 L1/L2/L3 权限和新 Catalog。Controller 会证明“风险上限内所有
  Region 的并集”与旧权限完全一致，否则配置不能启动。

- SearchStrategy 返回 `MutationPlan`，其中只允许 `generation`、`parentIds` 和 `regionIds`。
  夹带 `writable`、任务记录、final 结果或凭据字段会直接拒绝。

- Controller 验证父 Candidate、风险上限、Region 依赖和冲突，再自己把 Region 翻译成
  一轮 `MutationLease`。SearchStrategy 永远不能自己指定路径。

- Updater 结束后，Controller 对完整 Candidate Tree 重做 Snapshot 和 Diff，强制检查路径、扩展名、
  文件大小、可执行位、符号链接和 DSH/Cordis 语义。Mutation Report 不是权限证据。

## 内置兼容策略

`adapters/strategies/linear-hill-climb.yml` 是默认策略。它每轮：

- 选当前 Champion 为父 Candidate。

- 选风险上限内全部 Region。

- 评测通过就晋升，否则保留 Champion。

旧 `EvolutionExperiment` 没有 `spec.adapters.strategy` 时，Loader 自动注入这个策略。因为 Catalog
在启动时已做权限等价性检查，所以旧 L1/L2 Experiment 的实际可写集合不变。

## 渐进风险扩展策略

`adapters/strategies/progressive-risk-expansion.yml` 是 HZY 层级推进逻辑的通用化实现。
它不认识 DSH、MSA 或 PI Agent 路径，只使用当前 Target Catalog 声明的风险层和
Region：

- 每个 Branch 从 `startRiskLevel` 开始，默认是 L1。

- 本轮选择不高于当前活跃风险层的全部 Region。

- Candidate 晋升时清空连续未晋升计数，并留在当前层。

- 连续 `missesBeforeExpansion` 次未晋升后扩大到 Target 的下一个已定义层级。

- 在 Recipe `riskCeiling` 内已无更高层且再次达到阈值时，返回
  `exhausted=true`。Controller 将该 Branch 标记为 stopped，Population 不再向它分配预算。

因此 `combined + progressive-risk-expansion` 表示：Branch 之间共享经验并竞争预算，
每个 Branch 内部独立执行 L1 -> L2 -> L3 渐进扩展。

## 外部 Contributor Strategy

外部算法使用 `docker-json-v1`，通过 stdin/stdout 交换一个 JSON，不 import 进 Controller。运行时固定为：

- `--network none`；

- 没有 bind mount；

- 不传入宿主环境变量或凭据；

- 只读 root filesystem，只有 16 MiB 临时目录；

- CPU、内存、PID 和超时必须由 Adapter 限制；

- 镜像必须固定到 `sha256` RepoDigest。

`propose` 请求的核心字段是：

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "SearchStrategyRequest",
  "operation": "propose",
  "strategy": { "id": "my-strategy", "configuration": {} },
  "state": null,
  "context": {
    "generation": 1,
    "riskCeiling": "l1",
    "catalog": {},
    "championId": "h0",
    "allowedParentIds": ["h0"],
    "candidates": [],
    "searchHistory": []
  }
}
```

响应只能返回策略状态和 Plan：

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "SearchStrategyResponse",
  "operation": "propose",
  "state": { "cursor": 1 },
  "plan": {
    "apiVersion": "harness-rsi/v1alpha1",
    "kind": "MutationPlan",
    "metadata": { "id": "generation-0001-my-strategy" },
    "spec": {
      "generation": 1,
      "parentIds": ["h0"],
      "regionIds": ["skill-guidance"]
    }
  }
}
```

`observe` 响应除了更新后的 `state`，还可返回 `exhausted: true`，请求 Controller
将当前 Branch 标记为搜索耗尽。该信号只能停止当前 Branch，不能扩大权限或修改评分。

可直接参考 `strategies/examples/round-robin/`。其 Adapter 模板在
`adapters/strategies/docker-round-robin.example.yml`：

```bash
docker build -t harness-rsi-round-robin:local strategies/examples/round-robin
# 推送到镜像仓并取得 RepoDigest 后，替换 example Adapter 的 image。
npm run rsi -- adapter validate --config adapters/strategies/docker-round-robin.example.yml
```

## Driver 插件边界

Solver、Updater 和 Environment 的实现创建不再由主编排循环写死分支，而是通过
带版本的 Driver Registry 解析。当前内置了 DSH、MSA Minimal、SkillsBench 和
Synthetic Text Reasoning 协议；旧 `dsh-headless-docker` 协议名仍然可用。

这是一个受信任扩展接口，但不等于 pi-agent 已经即插即用。仓库已经实现可注册的
Source Resolver、Candidate Materializer 和 Candidate Validator，并用 MSA Minimal 完成了一个
非 DSH Target 的端到端链路。新 Harness 仍需作为受审查代码贡献它自己的 Adapter Schema、
Source/Seed/Materialization 生命周期，再调用
`registerSolverDriver`、`registerUpdaterDriver` 或 `registerEnvironmentDriver`。完成这些后，
主进化循环不需要再理解它的执行细节。

Driver 会真正执行 Harness 和挂载工作区，所以它是受信任 Controller 代码；SearchStrategy
只做算法决策，可以放进无网络 Docker 沙箱。这两种 Contributor 接口不能混为一个信任级别。

## 当前兼容矩阵

| 执行面                    | 搜索配置                              | 变异强制                         | 当前状态                 |
|-----------------------------|---------------------------------------|----------------------------------|--------------------------|
| 通用 `experiment` Population | EvolutionRecipe + SearchStrategy     | Catalog -> Plan -> Lease -> Diff | Cowork/Reasoning 已共用       |
| 旧 Reasoning `campaign`        | 五种 `controller_config.mode`        | Git commit + Layer path audit    | 保持 HZY 已测试行为         |
| 旧 Cowork Experiment           | 缺少 Recipe/Strategy                  | 自动使用 Single + 全 Region Lease   | 完全兼容                 |
| 旧 Target Adapter              | 缺少 `mutation.catalog`              | 每个 L1/L2/L3 自动映射为 Region | 完全兼容                 |
| MSA Minimal Target          | Target 自有 Cowork/Reasoning Catalog | 硬 Lease + 语义 Validator          | 已实现端到端              |

Reasoning/Future 生产链路仍使用它已验证的 Updater 单 commit、sealed broker 和 Git 谱系。
新的 Text Reasoning smoke 走通用 Experiment 链路，已能使用同一个 SearchStrategy 和五种
Population Mode；它只证明工程兼容性，不代表 HLE 生产评测已被替换。
