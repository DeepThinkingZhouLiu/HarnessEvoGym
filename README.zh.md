# DeepSeek Harness RSI

中文 | [English](README.md)

**一个把 Coding/Cowork Agent 变成“可评测、可迭代、可回滚”对象的可信 RSI 控制平面。第一条已实现的完整链路是：用 DeepSeek Harness 作为 Solver 和 Updater，在 SkillsBench Cowork 任务上进化 Prompt、Preset、Skill 与受控 Skill 脚本。**

> [!IMPORTANT]
> 仓库现在具备可执行的 Cowork L1/L2 MVP，但八题 POC 只用于跑通流程，不能当成正式 Benchmark 成绩或“系统已经实现通用自进化”的证据。正式实验应扩大任务数、使用至少三次重复 Trial，并补 Provider 费用计价、镜像/Verifier 供应链固定、基于 quota/tmpfs 的写入时磁盘硬上限和网关外层出口策略。

## 它现在能做什么

```text
固定 Controller Revision + DSH Source + SkillsBench Revision
-> 复制 H0 Candidate Overlay
-> H0/当前 Champion 跑 feedback 任务
-> 生成只含 feedback 的脱敏 Feedback Packet
-> 启动一个完整 DSH Updater Session
-> Updater 修改 L1 或 L2 Candidate
-> Controller 重新计算文件哈希与 Diff，拒绝越界改动
-> Champion/Candidate 在 selection 上配对评分
-> 通过 Gate 则晋升，否则保留原 Champion
-> 锁定 Champion 后，单独且仅一次运行 final
```

已经落地的能力包括：

- Target、Updater、Environment 与 Experiment Adapter 的强类型校验；Controller、Target/Updater Source 和 SkillsBench 分别固定 SHA。
- H0/Candidate 复制、覆盖文件与空目录的 SHA-256 Manifest、父子谱系、晋升与回滚记录。
- L1/L2 路径、扩展名、目录项、改动文件数、字节数和可执行位的最终 Diff Guard；零改动提案也会直接拒绝，避免把模型随机波动误当成进化。
- DSH Solver、DSH Updater、可信 Verifier 和最小模型网关四种 Docker 角色。
- Model Gateway 按 Session 差分采集请求数和 Token Usage；缺失 Usage 的响应会让对应 Token 指标保持未知。
- SkillsBench 任务镜像构建、一次性工作区、Verifier Reward 归一化、流式 Artifact 哈希、磁盘产物预算与非普通文件防刷分检查；Reward 文件必须是不超过 1 MiB 的普通文件。
- `feedback/selection/final` 三段隔离；selection 不进反馈，final 由原子文件锁保证跨进程并发也只能领取一次。
- 多代搜索会把历代假设、改动和 selection 聚合 Gate 结果带给下一轮，但永不泄漏 selection 逐题证据。
- 二值 Resolved Rate 与连续 Mean Reward、配对回退、Bootstrap 区间、成本/延迟/安全 Gate。
- 一轮或多轮 `feedback -> update -> selection -> promote/reject` 编排。

## 为什么 DSH 不直接放进 Solver 目录让 Updater 修改

`sources/deepseek-harness/` 是固定、只读的上游运行底座。当前 L1/L2 修改的是项目自己维护的 Candidate Overlay：

```text
targets/deepseek-harness/cowork-rsi/
  apps/cli/config/agent-presets/cowork-rsi/
    agent.cordis.yml
    preset.yml
    skills/
```

运行时 Controller 把这个 Preset 只读挂到 DSH 的 `$DSH_HOME/.agent-presets/cowork-rsi`。Updater 能读完整上游源码理解接口，但只能写 Candidate Overlay。因此每个 Candidate 都是独立实例，既不会污染 Submodule，也能精确知道本轮改了什么。

## 当前变异边界

| 层级       | 当前开放内容                                      | 当前状态           |
|------------|---------------------------------------------------|--------------------|
| L1 策略层  | `agent.cordis.yml`、`preset.yml`、Skill 文档      | 已实现，建议先使用 |
| L2 行为层  | L1 + `skills/**/scripts/**` 中的受控脚本          | 已实现，需 Docker  |
| L3 Core    | DSH Agent Loop、Session、Context、插件底层源码    | 暂未开放           |
| 信任根     | Controller、Evaluator、Benchmark、Rubric、密钥等  | 永久冻结           |

限制不是只写在提示词里。Updater 容器拿不到 Benchmark/Verifier/主仓 Git 元数据，结束后 Controller 还会重新扫描所有文件；任何不在当前层级白名单中的新增、修改、删除或符号链接都会让 Candidate 直接被拒绝。配置、固定 Source 和 Candidate 入口也拒绝符号链接，避免“看起来在仓库内，实际指向外部”。

Candidate 自带的通用 Skill 统一使用 `cowork-*` 命名空间，Controller 会校验目录名、frontmatter `name`、描述与前缀。`agent.cordis.yml` 也不是靠逐行关键字判断，而是在替换唯一允许的 `!!js` 表达式后解析完整 YAML 树，递归检查插件名和 Cordis Patch 指令，因此改成行内 YAML 也无法绕过白名单。这些检查会避免 Candidate 的通用 `pdf`/`xlsx` 说明因 DSH 优先级而遮蔽题目自带的专用 Skill。

## Docker 职责

| 角色          | 可读内容                                   | 可写内容                 | 是否持有裁判权 |
|---------------|--------------------------------------------|--------------------------|----------------|
| Solver        | 单题工作区、只读 Candidate Preset/Task Skill | 该 Trial 的一次性工作区  | 否             |
| Updater       | 只读 DSH Source、feedback、Mutation Policy | 某一个 Candidate Overlay | 否             |
| Model Gateway | 真正 Provider 地址和 Key                   | 无持久数据               | 否             |
| Verifier      | 评分脚本、Solver 产物                      | 独立日志目录             | 是，单题评分   |
| Controller    | 配置、谱系、全部标准化结果                 | `.rsi/`                  | 是，晋升决策   |

Solver/Updater 只接入每次 Run 新建的 Docker internal network，拿到的是一次性网关令牌和内部地址，既没有外网路由，也拿不到真实 Provider Key。只有 Model Gateway 同时接入 internal network 与出口网络，而且只代理固定 Base URL 的 `POST /chat/completions`，并执行 Run 级总请求数和并发上限。Agent 容器还默认 `cap-drop=ALL`、`no-new-privileges`、只读 RootFS，并限制 CPU、内存、PID 和超时；正式环境可在网关之外继续叠加 DNS/IP Allowlist。

当前 Solver Workspace 和 Updater DSH Home 仍是宿主机 Bind Mount：Controller 会在 Session 结束后快照并拒绝超额产物，但这不是“写入当下就阻止”的硬配额。当 Updater 被当作对抗性代码运行时，应换成 quota-backed Volume 或有限 tmpfs，再进行长时正式实验。

## Cowork POC 任务

固定 SkillsBench Revision：`bf3793e9ec20e9682e6f18dbf4de3c69163dc9c7`。

| Partition   | 数量 | 任务                                                                                 | Updater 可见性 |
|-------------|------|--------------------------------------------------------------------------------------|----------------|
| feedback    | 3    | `offer-letter-generator`、`xlsx-recover-data`、`invoice-fraud-detection`            | 详细反馈       |
| selection   | 2    | `sales-pivot-analysis`、`exceltable-in-ppt`                                          | 仅 Controller  |
| final       | 3    | `weighted-gdp-calc`、`financial-modeling-qa`、`pptx-reference-formatting`            | Finalize 才解封 |

任务清单在 [benchmark.json](benchmarks/cowork-skillsbench-poc/benchmark.json)，不是完整 SkillsBench 排行榜 Split。

## 快速开始

需要 Node.js 20+、Git、Docker，以及固定 Revision 的 SkillsBench 本地 Checkout。请用已加入 Docker 权限组的普通用户运行 Controller，不要用 root。正式开始 `preflight`/`evolve run` 前，`controller/src`、`docker`、`package.json` 和 `package-lock.json` 必须已提交；Run 会记录当前主仓 SHA，Finalize 必须在同一 SHA 上执行。DSH 会从 `sources/deepseek-harness` 的固定 SHA 在 Docker 中用 Node.js 24 完整构建；第一次构建较慢，后续 Candidate 迭代会复用镜像缓存。

```bash
npm install
git submodule update --init --recursive

export RSI_SKILLSBENCH_ROOT=/absolute/path/to/skillsbench
export DEEPSEEK_BASE_URL=https://your-provider.example/v1
export DEEPSEEK_API_KEY=your-runtime-secret
```

先做静态配置和运行环境检查：

```bash
npm run check
npm test

npm run rsi -- experiment validate \
  --config experiments/cowork-skillsbench-dsh-l1.json

npm run rsi -- experiment preflight \
  --config experiments/cowork-skillsbench-dsh-l1.json

npm run rsi -- runtime build \
  --experiment experiments/cowork-skillsbench-dsh-l1.json
```

启动一轮 L1 进化：

```bash
npm run rsi -- evolve run \
  --experiment experiments/cowork-skillsbench-dsh-l1.json \
  --run-id cowork-l1-smoke-001
```

检查 `.rsi/runs/cowork-l1-smoke-001/state.json` 和 Candidate 的 `evaluation.json`。确认 Champion 锁定后，才执行一次 Final：

```bash
npm run rsi -- evolve finalize \
  --run .rsi/runs/cowork-l1-smoke-001
```

L2 使用 `experiments/cowork-skillsbench-dsh-l2.json`，建议从新的 Run 开始，保证 L1/L2 都从同一个 H0 出发。

## 运行产物

```text
.rsi/runs/<run-id>/
  state.json                         # Controller/Source SHA、Champion 与 Final 状态
  final-attempt.json                 # 原子创建的 Final 唯一领取记录
  experiment.snapshot.json           # 不含密钥的冻结配置摘要
  mutation-policy.json               # 本 Run 的硬边界
  generations/generation-*/
    feedback-packet.json
    decision.json
  candidates/h0|g*/
    workspace/                        # 独立 Candidate Overlay
    manifest.json                     # 内容哈希和父版本
    mutation-diff.json
    mutation-report.json
    evaluation.json
  results/                            # 标准化 Solver Result JSONL
  trials/                             # 每次 Trial 的工作区、回答、Verifier 与 Artifact
  final-evaluation.json               # 仅 Finalize 生成
```

`.rsi/` 已被 Git 忽略。真实 API Key 只由 Model Gateway 通过环境继承，既不写入配置、Docker 命令参数、Agent 容器，也不写入报告；Solver/Updater 只拿到 Run 级一次性令牌。Finalize 会用文件系统的原子“不存在才创建”操作领取 Attempt，所以两个进程同时启动也只有一个能进入实际回放；成功、失败或中途崩溃都不会默认重新解封 Final。

## 指标怎么理解

- `meanReward`：Cowork Verifier 的 `[0,1]` Reward 均值，是协议主指标；当前八个上游 Verifier 只产出 0/1，所以本 POC 中它与 `resolvedRate` 数值相同。
- `deltaMeanReward`：同一任务上 Candidate Reward 减 Baseline Reward 的配对均值。
- `rewardImproved/rewardRegressed`：提升与回退的任务数。
- `resolvedRate`：达到 `resolvedThreshold` 的全通过比例，作为辅助指标保留。
- `rewardGeneralizationGap`：feedback 提升减 final 提升；数值过大通常意味着只学会了反馈题。
- `decision.gates`：覆盖率、完成率、Reward 提升、回退、成本和安全条件；全部通过才晋升。

Model Gateway 会从流式响应采集逐 Session 的输入/输出 Token；只有本 Session 的每个模型响应都带合法 Usage 时，结果才写入 Token，缺失时保持 `null`。当前没有可信的 Provider 费率表，所以美元成本仍为未知，Cowork POC 的成本 Gate 保持 `null`；Token 涨幅 Gate 已有入口，但 POC 暂不设置任意阈值。`seed_controlled=false` 也会写入结果：Controller 会复用相同 Trial Seed，但当前 DSH 模型接口不保证真正固定采样随机性，正式报告应使用多 Trial 降低噪声。

## 模块入口

- [Cowork MVP 运行与扩展说明](docs/cowork-mvp.zh.md)
- [控制平面架构](docs/architecture.zh.md)
- [Controller](controller/README.md)
- [Adapter 协议](adapters/README.md)
- [Environment](environments/README.md)
- [Benchmark](benchmarks/README.md)
- [Evaluator](evaluation/README.md)

## 上游与许可

本项目不是 DeepSeek 官方项目。`sources/deepseek-harness/` 来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，保留独立历史和许可证；主仓固定其 Gitlink Revision，Updater 永远不直接修改它。本仓库自己的 Controller、Adapter、Preset 和文档使用 [MIT License](LICENSE)。
