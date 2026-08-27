# Cowork RSI L1/L2 MVP 运行与扩展说明

[English](cowork-mvp.md) | 中文

## 目标与边界

这条链路回答一个具体问题：**给 DeepSeek Harness 接上 Cowork 任务、客观评分和受控反馈后，它能否用另一个 DSH Session 改进自己的 Cowork Preset，并在没有给 Updater 看过的任务上稳定提升？**

H0、每代 Candidate 和 Champion 都是独立 Overlay。L1/L2 不修改 DSH 上游仓库；只有以后开放 L3 时，才需要完整源码实例、构建产物和更重的回归隔离。

## 模块职责

| 模块                                      | 负责什么                                             | 不负责什么                         |
|-------------------------------------------|------------------------------------------------------|------------------------------------|
| `controller/src/cowork-orchestrator.mjs`  | Cowork 一轮/多轮编排、状态、谱系、晋升、一次性 Final | 开放式失败归因                     |
| `controller/src/candidate.mjs`            | 复制、快照、哈希、Diff、Mutation Report 校验         | 判断改动是否提高任务能力           |
| `controller/src/path-policy.mjs`          | L1/L2 Glob、扩展名和只读优先级                       | 解释 Target 的业务语义             |
| `controller/src/factories.mjs`            | 按协议选择 Solver/Updater/Environment Driver         | 写死某个 Benchmark 的分支           |
| `controller/src/runtimes/dsh.mjs`         | DSH 设置、Solver/Updater 容器协议                    | SkillsBench 任务布局                |
| `controller/src/environments/skillsbench.mjs` | 构建任务、工作区、Verifier、Reward 归一化        | 决定 Candidate 是否晋升            |
| `controller/src/cowork-model-gateway.mjs` | Run 级内部网络、一次性令牌与网关生命周期             | 决定 Agent 如何解题                 |
| `controller/src/evaluator.mjs`            | 配对指标、Bootstrap、冻结 Gate                       | 相信 Candidate 自报分数             |
| `controller/src/feedback.mjs`             | 只从 feedback 生成脱敏证据                           | 把 selection/final 泄漏给 Updater  |
| Target Adapter                            | DSH Overlay、运行时和每层可写路径                    | 写死其他 Agent 的目录               |
| Updater Adapter                           | 独立 Updater Source、Runtime、Prompt 与报告协议       | 决定 Target 的可写边界               |
| Model Provider Adapter                    | 上游协议、凭据变量名、兼容参数和模型目录             | 保存真实 API Key                     |
| Environment Adapter                       | SkillsBench Revision、任务布局、Docker 与 Verifier   | 写死到 Controller 核心              |
| Experiment                                | 把 Target、Updater、Environment、Benchmark、Policy 组合 | 修改任一信任根                   |

## 一代数据流

```text
Champion Workspace（只读给 Solver）
-> feedback Trial 工作区
-> Verifier Reward + Solver Answer + Artifact
-> Feedback Packet（只含 feedback）
-> DSH Updater（Source 只读，Candidate 可写）
-> Candidate Snapshot/Diff/Mutation Report
-> Diff Guard
   -> 违规：Reject，Champion 不动
   -> 合法：Champion 与 Candidate 跑 selection
-> Evaluation Policy
   -> 全部 Gate 通过：Promote
   -> 任一 Gate 失败：Reject，Champion 不动
```

Updater 本身就是 Analyzer：它在一个 Session 中看多道题的证据、读上游接口、形成假设并修改 Candidate。Controller 不把它拆成固定 `failure-analyzer`、`mutation-proposer` 等规则服务。第二代开始还会看到历代假设、改动文件和 selection 聚合 Gate，避免重复已失败搜索；逐题 selection 证据始终不进入 Packet。历史条数与 JSON 字节数由 Environment Adapter 限制，防止无限挤占上下文。

Feedback Packet 会给它 feedback 题的任务要求、Reward、Solver 答复、Verifier 证据、运行错误、产物和延迟。Controller 会先从可信 `ctrf.json` 提取断言总数和失败测试，再附上原始运行日志，避免依赖安装输出挤掉真正的失败原因。文本按每题总字节预算截断，产物列表另受条目数和 JSON 字节预算限制，并明确记录省略数量。它不会收到 selection/final 的任务要求、回答或 Verifier 文本。

## Candidate 实例

H0 模板在 `targets/deepseek-harness/cowork-rsi/`。Controller 会把它复制到：

```text
.rsi/runs/<run-id>/candidates/h0/workspace/
.rsi/runs/<run-id>/candidates/g001-l1/workspace/
.rsi/runs/<run-id>/candidates/g002-l1/workspace/
```

每个目录都有独立 `manifest.json`，记录 Source Revision、父 Candidate、所有文件的 SHA-256 和整棵树的 Digest。Solver 只读挂载 Candidate 中的 `cowork-rsi` Preset；Updater 只修改某个提案 Candidate，不修改 Champion。

## L1 与 L2 如何强制

一轮只有一个 `MutationPolicy`。Target Adapter 把 DSH 的层级翻译为具体路径：

- L1 只允许 Preset YAML、Skill Markdown/JSON/YAML/TXT，不允许任何可执行代码或可执行位。
- L2 在 L1 上增加 `skills/**/scripts/**` 下的 Python、JavaScript、MJS 和 Shell。
- `.rsi-context`、`.rsi-output`、`.git`、`.env`、credential/secret 路径永久只读。
- 零改动提案直接拒绝，不允许靠 selection 的随机波动“空手晋升”。
- 符号链接、特殊文件、超大文件、过多目录项、过多改动文件和总改动字节超限都拒绝。
- Candidate Skill 必须使用 `cowork-*` 前缀，且目录名必须与 frontmatter `name` 一致，避免遮蔽题目自带 Skill。

Docker 挂载减少可见面，最终 Diff Guard 才是确定性的最后一道门。即使 Agent 声称自己没有越界，也以 Controller 重算结果为准。

## 四种 Docker 角色

Solver 运行在每个 SkillsBench Task 的派生镜像中。原 Task 镜像提供 Office/Python 等任务依赖，`docker/dsh-runtime/Dockerfile` 从固定 Submodule SHA 完整安装依赖并构建 DSH，再把同一构建产物注入任务镜像。任务镜像会校验 SkillsBench Revision/Task 标签，派生镜像还会校验 DSH Source Revision、Runtime 定义摘要和 Task 镜像 ID。

**修改 Candidate Preset 不需要重新构建镜像。** Candidate 是运行时只读 Bind Mount；Task/SkillsBench Revision、DSH Source、Runtime Dockerfile/包装脚本或基础 Task 镜像身份改变时，缓存校验会触发重建。Task 自带 Skill 也不会烘焙进 Candidate，而是在单题运行时从固定 Checkout 只读挂载。

Updater 使用统一 DSH Runtime，挂载关系如下：

```text
/candidate                         Candidate，可写
/candidate/.rsi-context/upstream   DSH Source，只读
/candidate/.rsi-context/*.json     feedback 与 policy，只读
/candidate/.rsi-output/            独立可写目录；Session 后只接受约定的 Mutation Report 普通文件
/dsh-home                          本 Session 临时状态，可写
```

Verifier 与 Agent 分开启动。Solver 不挂载 Verifier；Verifier 能读 Trial 工作区和自己的评分脚本，但它的结果还要由 Controller 归一化、检查范围并参与 Gate。

上游 Verifier 若需要临时下载固定版本依赖，可以按 Environment Adapter 的标准代理白名单继承宿主已设置的代理变量；该白名单是唯一继承入口，其余标准代理键会显式传空，以覆盖 Docker 客户端配置可能注入的代理。当前 SkillsBench Adapter 使用空白名单直接出网。该能力只属于可信 Verifier，不会打通 Solver/Updater 的 internal network。

慢速环境还可以为可信 Verifier 映射固定版本的本机依赖缓存 URL；Controller 只接受 `UV_DOWNLOAD_URL`、`PIP_INDEX_URL`、`UV_INDEX_URL` 三个目标变量，并只为 Verifier 提供 `host.docker.internal`，Agent 仍无该入口。

第四个角色是 Model Gateway。每个 Run 都会创建一张新的 Docker internal network，Solver/Updater 只接入这张无外网路由的网络。网关同时接入 internal network 和配置的出口网络，持有真正的 Provider Key，只接受一次性 Bearer Token，并且只代理固定上游的 `POST /chat/completions`。Environment Adapter 还设置 Run 级总请求数和并发上限，防止 Agent 绕过正常 Loop 无限调用。网关解析上游流式响应末尾的 Usage，并在每次 Solver/Updater Session 前后做计数器差分；只要其中一个响应缺少合法 Usage，本 Session 的 Token 字段就保持未知。真实 Key 与一次性 Token 都通过子进程环境继承，不写进 Docker 命令参数；Run 结束后容器和 internal network 会清理。

## 配置和入口

静态配置：

```text
adapters/targets/deepseek-harness.yml
adapters/updaters/deepseek-harness.yml
adapters/providers/zcloud-openai.yml
environments/skillsbench-cowork.yml
benchmarks/cowork-skillsbench-poc/benchmark.json
evaluation/policies/cowork-rsi-poc.json
experiments/cowork-skillsbench-dsh-l1.json
experiments/cowork-skillsbench-dsh-l2.json
```

命令职责：

```bash
# 只校验配置引用和协议
npm run rsi -- experiment validate --config experiments/cowork-skillsbench-dsh-l1.json

# 再检查 Submodule Gitlink、SkillsBench SHA、八道题布局、Docker 和凭据环境变量
npm run rsi -- experiment preflight --config experiments/cowork-skillsbench-dsh-l1.json

# 可选：提前构建固定 DSH Runtime 与 Model Gateway；Task 派生镜像仍按需构建
npm run rsi -- runtime build --experiment experiments/cowork-skillsbench-dsh-l1.json

# 只使用 feedback/selection 做一轮进化
npm run rsi -- experiment run \
  --config experiments/cowork-skillsbench-dsh-l1.json \
  --run-id cowork-l1-smoke-001

# Champion 锁定后，一次性回放 feedback 并评测 sealed final
npm run rsi -- experiment finalize --run .rsi/runs/cowork-l1-smoke-001
```

`preflight --skip-secrets` 只适合检查数据和 Docker 布局，真正运行仍会强制要求网关声明的 Provider 环境变量。Controller 信任根路径必须先提交，Run 会冻结主仓 SHA，Finalize 也必须在该 SHA 上执行；如果中间只改了文档，也需先 checkout 回运行时提交再做 Final，这是为了保守保证 Evaluator 没被替换。Solver/Updater Adapter 中同名字段表达“DSH 期待哪些变量”，实际收到的是内部地址和一次性令牌，不是真实 Provider 凭据。

上游连接只在 `ModelProviderAdapter` 配一次：协议、Base URL/API Key 的环境变量名、兼容参数和允许使用的模型目录都由它统一声明，真实凭据仍只在运行时注入。Solver 与 Updater 在 Experiment 中分别选择 `provider`、`model` 和 `maxTokens`；当前低成本 POC 两个角色都使用 `gpt-5.6-terra`，并固定为 8192 Token。DSH Runtime 会把这份通用配置翻译到其 `llm-pi-ai` OpenAI Chat Completions Adapter；后续接 pi-agent 时，只增加对应 Runtime 翻译，不复制凭据配置。

## Verifier 接口

Environment Adapter 会按顺序寻找 instruction、Dockerfile 和 verifier。Python/Shell Verifier 默认无参数运行，同时收到：

```text
WORKSPACE=/root
OUTPUT_DIR=/logs
LOG_DIR=/logs
```

如果某一版本的 SkillsBench Verifier 需要参数，可在 `spec.verifier.arguments` 使用 `{{workspace}}`、`{{outputDir}}` 和 `{{script}}`。Reward 可以来自配置列出的 JSON/TXT 文件，或 stdout 最后一段数字/JSON；支持 `reward`、`score`、`total_reward` 和嵌套 `result`。Reward 产物必须是不超过 1 MiB 的普通文件，符号链接或超大文件会让 Trial 安全失败，Controller 不会跟随它读取其他宿主路径。当前固定 SkillsBench Revision 把结果写到 `/logs/verifier/reward.txt`，八道 POC 题都是 0/1，但 Runner 已支持 `[0,1]` 连续值。超范围结果会记录安全违规并按零分处理。

Solver 工作区还有总目录项数（文件+目录）、总字节、单文件、改动文件数和改动字节上限。超限时不把产物交给 Verifier，该 Trial 记为 `error` 和安全违规。

## 评测逻辑

单题结果是 `solver-result-jsonl-v2`：

```json
{
  "instance_id": "xlsx-recover-data",
  "status": "unresolved",
  "reward": 0.75,
  "trial_rewards": [0.5, 1.0],
  "trial_seeds": [20260824, 20260825],
  "seed_controlled": false,
  "input_tokens": 12000,
  "output_tokens": 3000,
  "latency_ms": 180000,
  "policy_violations": []
}
```

晋升使用 selection 上的配对差值，不比较两批无关任务。当前 POC Policy 要求记录与完成率完整、至少一题 Reward 提升、平均 Reward 不下降、没有 Reward 回退、没有安全违规。两道 selection 题样本太小，所以没有要求 Bootstrap 下界大于零；扩大正式集后应开启该 Gate。Solver 的完整 Usage 会写入逐题 `input_tokens`/`output_tokens`，Solver 与 Updater 总 Token 则进入 Evolution Ledger；没有可信费率表时 `costUsd` 继续为 `null`。

Finalize 会用冻结 H0 与锁定 Champion 同时跑 feedback 和 final，报告 `rewardGeneralizationGap = feedback gain - final gain`。Final 报告不再产生晋升决策。真正开始回放前，Controller 会先重验配置摘要、Source Revision 和 Candidate Tree Digest；随后用原子 create-if-absent 写入 `final-attempt.json`，因此并发进程也只有一个能领取。实际评测成功会进入 `finalized`，已接触 sealed final 后失败也会永久禁止重试。唯一例外是第一次尝试在公开 feedback 回放阶段因基础设施失败：用户可显式传入 `--recover-infrastructure`，Controller 只有在未发现任何 sealed-final 路径或结果、原 Claim 与父子失败状态完全一致时，才会发放一个原子的 `final-recovery-attempt.json`。原失败证据不删除，未完成 feedback 会归档；Recovery 再失败时不会有第三次机会。

## 失败与回滚

- Updater 没有写 Mutation Report、报告路径与真实 Diff 不一致：拒绝该 Candidate。
- Updater 零改动、越界、创建符号链接、改动过大：拒绝，不运行 selection。
- Solver/Verifier 超时或报错：单题为 `error`，完成率 Gate 默认失败。
- Candidate Reward 提升不足或发生回退：拒绝，Champion 指针保持不变。
- Final 已执行：默认拒绝再次解封；只有未接触 sealed final 的失败 Population 可以执行一次受审计恢复，不允许用 Final 反复挑 Candidate。
- Source/SkillsBench Checkout 与冻结 SHA 不一致：Preflight 失败，不开始实验。

拒绝不会修改父 Candidate。每代提案都在新目录中，调试证据保留在 `.rsi/`，可以审计但不会进入 Git。

## 扩大成正式实验

1. 先确认所有任务许可证和可重分发边界；不要把第三方 Task Skill 复制进本仓 Candidate。
2. 扩大 manifest，保持 feedback、selection、final 互斥；final 在 Champion 锁定前不得运行。
3. 把 `trialsPerInstance` 提高到至少 3，并提供同样数量的不重复 seeds。
4. L1 和 L2 分别从同一个 H0 开始，使用相同模型、题目、Trial 数和预算。
5. 按实际 Provider 费率接入 Cost Adapter 后再启用美元成本 Gate；可以按预注册阈值启用现有 Token 涨幅 Gate，未知值不能记为零。
6. 保留现有 Agent internal network + Model Gateway，并在网关外层增加 DNS/IP Allowlist；同时固定镜像 Digest、Task Source 和 Verifier 依赖。
7. 报告每代完整谱系、所有回退、总 Solver/Updater 调用和 Final 一次性状态，不只挑最好的一次。

## 接入其他 Agent 或 Benchmark

换 Solver/Updater 时新增独立 Source Adapter 和 Runtime 实现，不改 SkillsBench Evaluator；Target Source 与 Updater Source 会分别固定和验 SHA。换 Benchmark 时新增 Environment Adapter，不改 Candidate/Diff/谱系逻辑。这是当前接口拆分的核心：

```text
通用 Controller
  -> Target Adapter（谁被改、哪些路径可改）
  -> Updater Adapter（谁来改、如何启动）
  -> Model Provider Adapter（接哪个上游、可选哪些模型）
  -> Environment Adapter（在哪里做题、如何得到客观 Reward）
  -> Evaluation Policy（什么条件下允许晋升）
```
