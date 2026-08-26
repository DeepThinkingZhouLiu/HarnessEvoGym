# Controller

Controller 是 RSI 系统的可信、确定性控制平面。Updater 负责开放式分析和修改，Controller 只做可以被审计和复现的实例化、权限、运行、评测、谱系和决策。

## 模块

| 文件                           | 职责                                                       |
|--------------------------------|------------------------------------------------------------|
| `src/cli.mjs`                  | 命令解析、sealed Final 显式入口、报告输出                   |
| `src/adapters.mjs`             | Target/Updater/Provider/Environment/Experiment 配置校验     |
| `src/candidate.mjs`            | Tree Snapshot、Digest、Diff Guard、Manifest、Mutation Report |
| `src/path-policy.mjs`          | 安全相对路径、Glob、只读优先级和扩展名策略                  |
| `src/docker.mjs`               | 无 Shell 的 Docker CLI、资源与权限限制                      |
| `src/process.mjs`              | 超时、输出上限、密钥脱敏的子进程协议                        |
| `src/factories.mjs`            | 按 Adapter Protocol 解析 Solver/Updater/Environment Driver  |
| `src/runtimes/dsh.mjs`         | DSH Runtime 构建、Solver 与 Updater Session                 |
| `src/environments/skillsbench.mjs` | SkillsBench Task、Workspace、Verifier 与 Reward         |
| `src/model-gateway.mjs`        | Reasoning Responses/Unix-socket 网关与凭据隔离          |
| `src/cowork-model-gateway.mjs` | Cowork Docker 内部网、一次性令牌、Usage 与清理    |
| `src/feedback.mjs`             | feedback-only 脱敏反馈包                                    |
| `src/protocol.mjs`             | Benchmark、Policy、Solver Result 和 Ledger 协议              |
| `src/evaluator.mjs`            | 配对指标、Bootstrap 与晋升 Gate                             |
| `src/orchestrator.mjs`         | Future Reasoning 单分支进化、Git 保留/回滚                 |
| `src/population-orchestrator.mjs` | Reasoning 五种种群模式和同步 Wave                    |
| `src/cowork-orchestrator.mjs`  | Cowork Champion/Proposal、晋升/回滚和一次性 Final       |

## 粗粒度主流程

```text
load/validate
-> preflight pinned sources
-> materialize H0
-> run feedback
-> build feedback packet
-> update disposable proposal
-> enforce full diff
-> paired selection evaluation
-> promote/reject
-> persist state
```

Updater 内部不拆成固定的 `failure-analyzer`、`mutation-proposer`、`candidate-builder` 或 `search-policy` 服务。它是一个完整 Coding Agent Session；Controller 只要求真实文件 Diff 和结构化 Mutation Report。

## 命令

```bash
npm run rsi -- adapter validate --config adapters/targets/deepseek-harness.yml
npm run rsi -- experiment validate --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment preflight --config experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- runtime build --experiment experiments/cowork-skillsbench-dsh-l1.json
npm run rsi -- experiment run --config experiments/cowork-skillsbench-dsh-l1.json --run-id <id>
npm run rsi -- experiment finalize --run .rsi/runs/<id>
```

`experiment validate` 不访问 Docker 或外部 Task Checkout；`preflight` 会分别检查已提交的 Controller 信任根、Target/Updater Gitlink 与干净 Revision、SkillsBench SHA、任务文件、Docker 和网关所需环境变量。DSH/SkillsBench 的干净性检查也包含 Git 已忽略文件，避免它们悄悄进入镜像或 Verifier。`experiment run` 永远不运行 final；`experiment finalize` 在配置、主仓/Source Revision 和 Candidate 完整性重验后，会原子创建 `final-attempt.json` 再解封，并发进程也只有一个能消耗唯一 Attempt。领取后无论成功、失败还是崩溃都不会默认重试。

## 失败语义

- 配置、Revision、密钥或 Docker 缺失：Run 启动前失败。
- Updater 或 Diff 失败：当前 Proposal 记录为 rejected，Champion 不变。
- Solver/Verifier 单题失败：标准结果为 `error`，完成率 Gate 决定不能静默晋升。
- Selection Gate 失败：保留父 Champion，不覆盖任何 Candidate。
- Final 实际回放成功或失败后重复调用：直接拒绝，避免把测试集变成选择集。

运行状态只写 `.rsi/`。Source Submodule、Benchmark、Evaluation Policy、Verifier、凭据和主仓 Git 元数据不会挂入 Updater 的可写面。Solver/Updater 只接入 Run 级 internal network；真实 Provider Key 仅由 Model Gateway 环境继承，Agent 收到的是一次性令牌。

`ModelProviderAdapter` 统一声明上游协议、凭据环境变量名、兼容参数与模型目录；Experiment 分别选择 Solver/Updater 的模型。DSH Runtime 将它翻译为 `llm-pi-ai` 配置，其他 Agent Runtime 只需实现自己的翻译层，不需要复制凭据管理逻辑。
