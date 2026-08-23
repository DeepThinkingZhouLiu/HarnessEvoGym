# Adapter 协议

Adapter 把“通用进化算法”与“某个 Agent/Benchmark 的目录和命令”分开。所有仓库内相对路径从主仓根目录解析，并在启动前做路径包含检查。

## 四类配置

| Kind                  | 回答的问题                                                   |
|-----------------------|--------------------------------------------------------------|
| `TargetAdapter`       | 谁是 Solver、H0 在哪里、运行时是什么、L1/L2 能改哪些路径     |
| `UpdaterAdapter`      | 用谁启动 Updater、共享提示词在哪里、报告文件叫什么           |
| `EnvironmentAdapter`  | 任务从哪里来、如何建容器、如何调用 Verifier 和读取 Reward    |
| `EvolutionExperiment` | 本次把哪个 Target/Updater/Environment/Benchmark/Policy 组合起来 |

Experiment 分别声明 Solver/Updater 的 `provider`、`model` 与 `maxTokens`。当前 POC 对 `deepseek-chat` 显式使用 8192，避免把 DSH 面向新模型的较大默认输出上限误传给兼容网关。

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

## DeepSeek Harness Updater

Updater Adapter 拥有自己独立的 `source.path` 与固定 Revision，不再暗中复用 Target Source。当前示例仍使用同一 DSH Submodule 和 `standard` Preset；以后把 Updater 换成 PI Agent 时，可以新增 Source、Runtime Driver 和 Adapter，而不用改变 Target Candidate 的实例化方式。在容器里看到的路径只有：

```text
/candidate                         # 提案 Overlay，可写
/candidate/.rsi-context/upstream   # DSH Source，只读
/candidate/.rsi-context/*.json     # 反馈与策略，只读
/candidate/.rsi-output             # Mutation Report 输出
```

Adapter 只声明 DSH 所期待的环境变量名。真正的 Provider Base URL/Key 只由 Model Gateway 从宿主环境继承；Solver/Updater 得到的是内部 URL 与 Run 级一次性令牌。真实值和令牌都不会拼进 Docker argv、YAML 或报告。

## 校验

```bash
npm run rsi -- adapter validate --config adapters/targets/deepseek-harness.yml
npm run rsi -- adapter validate --config adapters/updaters/deepseek-harness.yml
npm run rsi -- adapter validate --config environments/skillsbench-cowork.yml
npm run rsi -- experiment validate --config experiments/cowork-skillsbench-dsh-l1.json
```

未知 Kind、移动数据版本、空白可写列表、非法路径、重复 Seed、不匹配的 Environment/Benchmark、`host` 网络或没有对应变异层级都会失败，不会静默采用默认值。
