# Adapter 协议

Adapter 把“通用进化算法”与“某个 Agent/Benchmark 的目录和命令”分开。所有仓库内相对路径从主仓根目录解析，并在启动前做路径包含检查。

## 六类配置

| Kind                  | 回答的问题                                                   |
|-----------------------|--------------------------------------------------------------|
| `TargetAdapter`       | 谁是 Solver、H0 在哪里、运行时是什么、L1/L2 能改哪些路径     |
| `UpdaterAdapter`      | 用谁启动 Updater、共享提示词在哪里、报告文件叫什么           |
| `ModelProviderAdapter` | 连接哪个模型网关、用哪些环境变量、有哪些固定模型与兼容开关 |
| `EnvironmentAdapter`  | 任务从哪里来、如何建容器、如何调用 Verifier 和读取 Reward    |
| `SearchStrategyAdapter` | 本轮从哪个父 Candidate 开始、搜哪些 Target Region         |
| `EvolutionExperiment` | 本次把哪个 Target/Updater/Provider/Environment/Benchmark/Policy 组合起来 |

Provider Adapter 只声明连接元数据和“环境变量名”，永远不写字面 Key。Experiment 分别声明 Solver/Updater 的 `provider`、`model` 与 `maxTokens`；当前低成本 POC 两个角色都用 `gpt-5.6-terra`，并共用 `zcloud-openai` 连接。

DSH Runtime 把 `openai-chat-completions` 协议翻译为它内置的 `llm-pi-ai` Profile，不再把非 DeepSeek 模型冒充成 `deepseek-official`。换 PI Agent 时，对应 Runtime Driver 应读取同一 Provider Adapter 并生成 PI 自己需要的环境或配置。
当前已完整支持 DSH Overlay Target 和 `repository-tree + CandidateSeed` 形式的
MSA Minimal Target。MSA 可以分别叠加 Cowork 或 Reasoning Seed，并通过各自的
Catalog 和语义 Validator 硬限制可变文件。PI Agent 仍是下一个 Adapter/Driver 实现任务，
不是已可运行的占位配置。

## 搜索策略与变异目录

Target 的 `mutation.catalog.regions` 定义可搜索模块、风险层级、路径、扩展名、依赖和冲突。
SearchStrategy 只返回父 Candidate 和 Region ID，Controller 校验后自己生成单轮
`MutationLease`。搜索算法不能返回文件路径，也看不到 final、trace 或凭据。

`builtin-v1` 用于仓库内受审查算法；`docker-json-v1` 用于 Contributor 算法。后者无网络、
无挂载、无宿主环境变量，且镜像必须固定 SHA-256 Digest。详见
[`docs/search-strategy.zh.md`](../docs/search-strategy.zh.md)。

## DeepSeek Harness Target

当前 Target 使用 `controller-owned-overlay`，不是完整上游 Worktree：

```text
Source:    sources/deepseek-harness                  # 固定且只读
H0:        targets/deepseek-harness/cowork-rsi       # 项目自有 Overlay
Runtime:   Source SHA 3289531e... / package 0.1.1-rc.1
Preset:    cowork-rsi
Candidate: .rsi/runs/<run>/candidates/<id>/workspace
```

L1 允许 Preset 与 Skill 文档；L2 额外允许 Skill Scripts；L3 未定义，因此配置成 L3 会在启动前失败。永久只读规则优先于 writable，最终还检查扩展名、可执行位、目录项、改动文件数、单文件和总字节上限。

`semanticChecks.skills` 另外强制 Candidate Skill 的根目录和命名前缀。DSH Cowork Target 使用 `cowork-*`，并校验目录/文件名与 frontmatter `name` 一致，用来防止高优先级 Candidate Skill 遮蔽 Benchmark Skill。

## MSA Minimal Target

MSA Target 使用 `repository-tree-v1` 固定主仓中的 Source Tree，再用
`source-plus-seed-overlay-v1` 叠加 Target 自有 Seed。Seed 覆盖 Source 里的文件必须在
`materialization.overrides` 显式声明；符号链接、特殊文件和未声明覆盖会失败。

```text
sources/msa-minimal-harness
  + targets/msa-minimal/cowork-v1       -> msa-minimal
  + targets/msa-minimal/reasoning-v1    -> msa-minimal-reasoning
```

两个 Target 共用 `msa-minimal-docker-v1` Solver Driver，但分别使用
`msa-minimal-cowork-v1` 和 `msa-minimal-reasoning-v1` Candidate Validator。

## DeepSeek Harness Updater

Updater Adapter 拥有自己独立的 `source.path` 与固定 Revision，不再暗中复用 Target Source。当前示例仍使用同一 DSH Submodule 和 `standard` Preset；以后把 Updater 换成 PI Agent 时，可以新增 Source、Runtime Driver 和 Adapter，而不用改变 Target Candidate 的实例化方式。在容器里看到的路径只有：

```text
/candidate                         # 提案 Overlay，可写
/candidate/.rsi-context/upstream   # DSH Source，只读
/candidate/.rsi-context/*.json     # 反馈与策略，只读
/candidate/.rsi-output             # Mutation Report 输出
```

Target/Updater Runtime 声明自己需要的环境变量名，Controller 会强制它们与 Provider Adapter 一致。真正的 Provider Base URL/Key 只由 Model Gateway 从宿主环境继承；Solver/Updater 得到的是内部 URL 与 Run 级一次性令牌。真实值和令牌都不会拼进 Docker argv、仓库 YAML 或报告。

## 校验

```bash
npm run rsi -- adapter validate --config adapters/targets/deepseek-harness.yml
npm run rsi -- adapter validate --config adapters/targets/msa-minimal.yml
npm run rsi -- adapter validate --config adapters/targets/msa-minimal-reasoning.yml
npm run rsi -- adapter validate --config adapters/updaters/deepseek-harness.yml
npm run rsi -- adapter validate --config adapters/providers/zcloud-openai.yml
npm run rsi -- adapter validate --config adapters/strategies/linear-hill-climb.yml
npm run rsi -- adapter validate --config adapters/strategies/progressive-risk-expansion.yml
npm run rsi -- adapter validate --config environments/skillsbench-cowork.yml
npm run rsi -- experiment validate --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment validate --config experiments/reasoning-msa-progressive-strict-smoke.json
```

未知 Kind、移动数据版本、空白可写列表、非法路径、重复 Seed、不匹配的 Environment/Benchmark、`host` 网络或没有对应变异层级都会失败，不会静默采用默认值。
