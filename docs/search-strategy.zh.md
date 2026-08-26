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

可直接参考 `strategies/examples/round-robin/`。其 Adapter 模板在
`adapters/strategies/docker-round-robin.example.yml`：

```bash
docker build -t harness-rsi-round-robin:local strategies/examples/round-robin
# 推送到镜像仓并取得 RepoDigest 后，替换 example Adapter 的 image。
npm run rsi -- adapter validate --config adapters/strategies/docker-round-robin.example.yml
```

## Driver 插件边界

Solver、Updater 和 Environment 的实现创建不再由 Cowork 主编排循环写死分支，而是通过
带版本的 Driver Registry 解析。当前内置协议是 `dsh-headless-docker-v1` 和
`skillsbench-docker-v1`，旧 `dsh-headless-docker` 协议名仍然可用。

这是一个受信任扩展接口，但不等于 pi-agent 已经即插即用。当前 Cowork 的 Adapter 校验、
Source 预检和 Materializer 仍然是 DSH/SkillsBench 具体实现。新 Harness 需要作为受审查代码
贡献，同时增加 Adapter Schema、Source/Materialization 生命周期，再调用
`registerSolverDriver`、`registerUpdaterDriver` 或 `registerEnvironmentDriver`。完成这些后，
主进化循环不需要再理解它的执行细节。

Driver 会真正执行 Harness 和挂载工作区，所以它是受信任 Controller 代码；SearchStrategy
只做算法决策，可以放进无网络 Docker 沙箱。这两种 Contributor 接口不能混为一个信任级别。

## 当前兼容矩阵

| 执行面                 | 搜索配置                         | 变异强制                         | 当前状态                 |
|--------------------------|----------------------------------|----------------------------------|--------------------------|
| Cowork `experiment`      | `SearchStrategyAdapter`          | Catalog -> Plan -> Lease -> Diff | 已接入内置与 Docker 策略   |
| Reasoning `campaign`     | 五种 `controller_config.mode`       | Git commit + Layer path audit    | 保持 Future 已测试行为      |
| 旧 Cowork Experiment    | 缺少 `strategy`                   | 自动使用全 Region Lease           | 完全兼容                 |
| 旧 Target Adapter       | 缺少 `mutation.catalog`           | 每个 L1/L2/L3 自动映射为 Region | 完全兼容                 |
| 非 DSH Cowork Harness   | Driver Registry 已预留            | 还需 Adapter + Materializer       | 未实现端到端              |

Reasoning/Future 生产链路仍使用它已验证的 Updater 单 commit 和五种种群模式，这次重构没有
为了形式统一而改动其 sealed broker、Git 谱系或回退语义。因此，“外部 Docker Strategy”
当前是 Cowork 执行面的生产能力，不应误说为已统一接管 Reasoning 五种模式。
