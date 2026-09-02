# OmegaUse-OfficeVal Cowork RSI 运行说明

[English](cowork-mvp.md) | 中文

## 目标

这条链路用于验证：MSA Minimal Harness 能否读取真实 Office 任务，在隔离工作区产出
Word、PowerPoint 或 Excel 文件；Updater 能否根据训练题反馈修改 Candidate，并由独立
Verifier 在验证题上决定是否晋升。它不再使用 SkillsBench，也不把“是否会加载某个
Skill”当成最终任务指标。

当前组合是：

```text
MSA Minimal Target
  + OmegaUse-OfficeVal Environment
  + 55/18/18 Benchmark
  + EvolutionRecipe / SearchStrategy
  + 通用 Population Controller
```

## 一条任务怎么执行

```text
固定 Source Manifest
-> 校验 Dataset/Evaluator Revision 与每个文件 SHA-256
-> 只把任务说明和原始 Office 输入交给 Solver
-> MSA 在一次性工作区内调用 Bash/Python/LibreOffice 生成交付文件
-> Controller 只提取新增或修改的普通文件，形成独立 Submission
-> 无网络 Verifier 容器读取 Submission 和受信评分代码
-> Dim1 格式门槛 + 加权 Dim2 Rubric
-> 归一化为 [0,1] Reward
-> feedback 返回详细证据；selection/final 只保留聚合信号
```

Solver 看不到 Rubric、Verifier 源码、验证集逐题反馈或 sealed final。Updater 只能读
feedback 题的失败证据，并且只能修改本轮 MutationLease 开放的 Candidate 文件。

## 模块职责

| 模块                                                | 职责                                                        |
|-----------------------------------------------------|-------------------------------------------------------------|
| `omegause-officeval.mjs`                           | 数据预检、任务工作区、Submission、Verifier 与 Reward        |
| `msa-minimal-cowork.mjs`                           | 把 MSA Candidate 挂入 Office 运行镜像并执行 Solver           |
| `cowork-model-gateway.mjs`                         | 隔离真实 Provider Key、固定模型/Token、分角色计量            |
| `candidate.mjs`                                    | Candidate 复制、摘要、Diff Guard 与 Mutation Report          |
| `evaluator.mjs`                                    | Champion/Candidate 配对指标与冻结晋升 Gate                   |
| `cowork-orchestrator.mjs`                          | Branch 单步进化、晋升、回滚和一次性 Final                    |
| `population-orchestrator.mjs`                      | 五种 Mode、同步 Wave、经验共享和竞争预算                     |
| Target Adapter                                      | MSA H0 Seed、启动协议、L1/L2/L3 Region 与语义 Validator      |
| Environment Adapter                                 | OfficeVal Source、工作区/Verifier 容器资源与反馈预算          |
| Benchmark / Policy                                  | 训练/验证/测试 ID、主指标和晋升条件                           |

## 数据固定与划分

上游数据是 `baidu-frontier-research/OmegaUse-OfficeVal`。仓库提交
`benchmarks/omegause-officeval/source-manifest.json`，固定：

- Dataset Revision：`cd6ba6d8fb83b3fb551e24eebc20e1fb0bd154a5`。
- Evaluator Revision：`ffbeecb8752447c8e40b594a0eeb1db7236ecb36`。
- 100 道任务的 instruction、rubric、输入文件、Verifier 和共享评分文件摘要。
- Linux 排除的 9 道 Windows Office COM 任务。

正式 Linux split 位于
`benchmarks/cowork-omegause-officeval-linux-v1/benchmark.json`：

| Partition                   | 数量 | Updater 可见性   | 用途                         |
|----------------------------|-----:|------------------|------------------------------|
| `feedback` / train         |   55 | 详细反馈         | 归因、修改 Candidate         |
| `selection` / validation  |   18 | 仅聚合           | 决定 Candidate 是否晋升      |
| `final` / test            |   18 | 一次性 sealed    | Champion 锁定后的最终报告    |

三个 Partition 完全互斥。3 题 Smoke 使用 `officeval_060 / 090 / 003`，三者都来自
正式 feedback 集，分别覆盖 PPT、Excel 和 Word；Smoke 只是低成本连通性测试，不会提前
查看正式 validation/test。

## 隔离边界

每个 Run 创建独立 Docker internal network。Solver 和 Updater 没有公网路由，只能通过
一次性角色 Token 调用 Model Gateway；Gateway 持有真实 Provider Key，并强制覆盖请求里的
模型、`max_tokens` 和多候选参数。正式 OmegaUse 配置允许 Gateway 在还没有向 Agent 下发
任何响应时，对 429/502/503/504、连接中断和上游超时最多额外重试 5 次；如果流已经开始，
则立即 fail-closed，绝不重播部分 Completion。

Office 任务运行时统一提供 LibreOffice Writer/Calc/Impress、Python Office 库、字体、
PDF/ZIP 工具。Candidate 和 Environment Assets 只读挂载，任务工作区和 Session 输出可写。
Solver 结束后，Controller 会检查目录项、总字节、单文件、变更文件数、符号链接和特殊文件；
越界产物不会进入 Verifier。

Verifier 是另一个容器，使用：

- `network=none`，并显式清空所有标准代理环境变量。
- 只读根文件系统、无额外 capability。
- Submission 与评分代码只读，日志目录单独可写。
- 每题 Verifier 和共享文件在 staging 后重新校验 SHA-256。

上游 Verifier 正常返回 `status:error`，例如 Candidate 没有生成目标文件，属于合法零分；
Verifier 无法导入、进程异常、输出协议损坏或摘要漂移属于基础设施失败，整个 Branch
fail-closed，不会伪装成 Candidate 的零分。

## 配置入口

```text
environments/omegause-officeval.yml
benchmarks/omegause-officeval/source-manifest.json
benchmarks/cowork-omegause-officeval-smoke/benchmark.json
benchmarks/cowork-omegause-officeval-linux-v1/benchmark.json
evaluation/policies/cowork-officeval-rsi.json
adapters/targets/msa-minimal.yml
adapters/targets/msa-minimal-cowork-rsi.yml
experiments/cowork-msa-smoke-<mode>.json
experiments/cowork-msa-rsi-linear-<mode>.json
```

`msa-minimal` 把 Solver 单题最多限制为 1 步，用于便宜的工程 Smoke；
`msa-minimal-cowork-rsi` 不限制交互步数、只保留单题墙钟预算，用于正式 55/18/18 配置。两者共用相同 Source
和 Cowork CandidateSeed，但预算目的不同。

## 命令

```bash
npm install
export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
export RSI_PROVIDER_BASE_URL=https://your-provider.example/v1
read -rsp 'Provider API Key: ' RSI_PROVIDER_API_KEY && export RSI_PROVIDER_API_KEY

npm run check
npm test
npm run rsi -- experiment validate \
  --config experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment preflight \
  --config experiments/cowork-msa-smoke-single.json
npm run rsi -- runtime build \
  --experiment experiments/cowork-msa-smoke-single.json
npm run rsi -- experiment run \
  --config experiments/cowork-msa-smoke-single.json \
  --run-id cowork-officeval-smoke-001
npm run rsi -- experiment finalize \
  --run .rsi/runs/populations/cowork-officeval-smoke-001

unset RSI_PROVIDER_API_KEY
```

`experiment run` 只使用 feedback 和 selection。Population 关闭并锁定
`best-harness.json` 后，`experiment finalize` 才能一次性解封 final；父状态、
Candidate Digest、配置摘要和 Source Revision 都会重验。若 Final 已接触 sealed 数据，
无论成功或失败都不能重新运行。

进化期若因 Provider、Docker 或 Verifier 基础设施异常暂停，使用
`experiment resume --run <population-run>` 显式恢复。OmegaUse 以“Candidate + Partition +
Task + 全部 Seed”为一个题目断点，评分完成后原子写入 `committed-result.json`；Resume 会
复用已提交结果（包括 0 分），只补跑未完成题。半成品目录会归档到
`recovery/trial-attempts/`，同一条失败命令不会自动重跑整题。

## Reward 与晋升

OfficeVal Verifier 先做 Dim1 交付合法性检查，再按多个 Dim2 Rubric 项给出加权分数。
Controller 使用：

```text
reward = dim1_pass ? clamp(total_score / max_score, 0, 1) : 0
```

因此 Candidate 可以从 0.35 提升到 0.60，系统能看到局部进步。正式 selection 使用
18 道配对任务；当前 Policy 要求完整覆盖、平均 Reward 不下降、至少一题提升、策略违规
为零，同时暂时允许最多 3 道 Reward 回退。这个 Gate 是可运行的工程默认值，不是已经
预注册的论文统计准则。

如果要发布正式 Benchmark 结论，还应：

- 每题至少运行 3 个预注册 seed，而不是当前 1 个 Trial。
- 为五种 Mode 使用完全一致的 Candidate 预算、模型、Token 和任务。
- 在看 final 之前预注册回退上限、置信区间 Gate 和停止规则。
- 同时报告最终 Reward、泛化差、Solver/Updater Token、墙钟时间和全部失败 Run。
- Final 一旦解封，不得根据结果继续修改 Candidate 后重测同一测试集。

## 当前边界

- Linux 路径暂不执行 9 道需要 Windows Office COM 的题；若要覆盖它们，需要独立
  Windows Worker/Verifier Adapter，不能在 Linux 上假装运行。
- 三题 Smoke 只证明 Dataset -> MSA -> Office 文件 -> Verifier -> Reward 的链路连通。
- 单个 seed 的 55/18/18 配置可以做研发实验，但不能单独支撑统计显著性声明。
- PI Agent 仍需自己的 Source/Seed/Runtime/Validator Adapter；不会因为换了 Benchmark
  就自动可运行。
