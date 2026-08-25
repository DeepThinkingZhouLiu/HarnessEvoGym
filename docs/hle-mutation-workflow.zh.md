# HLE 单分支 Harness RSI 工作流

本文描述当前用于快速验证算法的线性实验。它刻意只保留进化所需的最小闭环，不再使用 Proposal/Apply 两阶段、逐轮完整目录复制、全仓快照或重复权限遍历。

## 当前实验配置

| 项目 | 值 |
|---|---|
| 数据 | HLE text-only Math，固定 validation 10 题 |
| Test | 本轮关闭，不创建或运行 test split |
| Solver | restricted minimal mode；`qwen3.8-max`，`max` effort |
| Updater | standard mode；`qwen3.8-max`，`max` effort |
| 并发 | 15 |
| 单题超时 | 600 秒；超时直接记 0 分 |
| 层级选择 | Updater 每轮从完整 L1/L2/L3 目录中选择最小充分层级 |
| 保留条件 | validation 正确数严格高于 incumbent |
| 停止 | 无固定三次 miss 规则；Updater 可在没有值得验证的方向时显式停止 |
| 网络 | 仅为 Controller 启动的子命令移除代理环境变量，不修改终端或系统代理 |

## 一轮进化

```text
incumbent Git commit
        │
        ▼
Controller 调用一次 Updater（standard mode）
        │ 输入：完整 L1/L2/L3 定义和允许路径、同一个可写工作区、
        │       incumbent 的 validation 日志/trace、历轮 evolution-log.jsonl
        │
        ▼
Updater 自主完成：读反馈 → 选择最小充分层级 → 选择一个改进方向
                  → 修改 → 最小检查 → git commit
        │
        ▼
Controller 检查：恰好新增 1 个 commit、工作区干净、commit 声明合法层级、
                 diff 路径位于该层配置边界
        │
        ├─ 不合法/Updater 失败：本轮记 0，git reset 到 incumbent
        ▼
构建 candidate，并用 candidate Solver 跑 10 题 validation
        │
        ▼
candidate score > incumbent score ?
        ├─ 是：保留 commit，成为新 incumbent
        └─ 否：git reset --hard incumbent
        │
        └─ 下一轮仍由 Updater 根据累计证据重新选择 L1/L2/L3
```

每轮只有一次 Updater 模型会话。Controller 不生成或审批 mutation direction，也不替 Updater 重放补丁；commit 本身就是 mutation 的冻结边界和可复现载体。

## Solver 与 Controller 的边界

Solver 的推理行为属于被进化的 Harness。`max_steps`、每次请求的 `max_output_tokens`、工具命令超时和 observation 长度都由 Candidate profile/代码决定，Controller 不覆盖这些值，也不限制单题内模型请求次数或请求并发。Updater 同样没有模型请求次数或总时长上限。

Controller 只冻结实验身份和隔离边界：模型与 reasoning effort、单题 600 秒硬超时、全局题目并发、无外网、不可见 gold answer、validation/test 隔离，以及可信 judge。模型 Gateway 仅隐藏凭据并固定模型参数，Candidate 提交的输出 token 预算保持原值。当前宿主不允许在嵌套 bubblewrap 中挂载 `/proc`，因此隔离环境提供空 `/proc`；普通 Bash、Python 和代码执行可用，Updater 通过精确路径读取反馈而不调用依赖 `/proc` 的 glob 排序。

## Updater 收到什么

Controller 把以下信息注入 `prompts/updater-mutate-soft.md`：

1. candidate ID 和 parent commit；
2. 完整 L1/L2/L3 的说明、累计可写路径以及永久禁止区域；
3. 唯一可写 candidate worktree 及其独立 Git 元数据目录；
4. incumbent 的 validation 根目录，包含分数、逐题 records 和 agent traces；
5. 只读 `evolution-log.jsonl`，包含此前每轮 commit、diff、分数、决策和耗时。

Updater 必须先选择能覆盖假设的最小层级，再实现一个可证伪、单变量的改进，并创建恰好一个 `rsi(l1|l2|l3): ...` commit。提示词引导它优先尝试 L1；只有验证证据显示小范围修改收益变少或无法触及故障机制时，才逐步外扩到 L2/L3。它不能读取 test、gold answer、credential、Controller 实现或其他 campaign 私有区，也不能执行 reset、checkout、rebase、merge、amend 或修改 Git 配置。

若三个层级都没有值得验证的新方向，Updater 保持 worktree 不变并返回 `RSI_STOP: ...`；这才会结束无限轮次模式。Controller 不根据连续未提升次数替 Updater 切层或停止。

## Controller 保留的硬约束

轻量化不等于完全信任模型。Controller 只保留便宜且决定实验语义的检查：

- HEAD 必须是 parent 的恰好一个直接子 commit；
- worktree 在提交后必须干净；
- commit subject 必须声明一个已配置层级，`git diff --name-status parent..HEAD` 的每个路径必须属于该层；
- candidate 必须能构建；
- 只有 validation 严格提升才保留，否则回退；
- validation 失败和 candidate timeout 记 0，基础设施失败则暂停，避免把服务故障误当进化信号。

不再执行逐轮全目录复制、before/after 全文件 hash、mutation bundle、二次 freeze、Proposal JSON schema 或第二次 Apply 会话。

## L1–L3

层级按修改自由度从低到高、由外到内展开：先改声明式策略，再进入 agent loop，最后开放传输与启动核心。它们是软分类和搜索先验，不是 Controller 的固定时序状态机。

- L1 声明式策略：`profiles/**`。`math.md` 管理 Solver 角色、math/coding 策略、何时用 Bash、`<bash>/<final>` 契约、答案格式和自检提示；`math.json` 管理 step、token、命令超时和 observation 预算。可探索问题分解、验证习惯、工具阈值、及时提交和置信度校准等泛化假设。
- L2 行为扩展：在 L1 基础上开放 `agent.py`、`tools.py`。这个最小 Harness 把大型系统中的 middleware、hook、memory/router、workflow、tool/plugin 折叠在这里，包括消息历史、model→action→observation 循环、局部 parser/repair、step 调度、上下文保留、trace、Bash 生命周期及输出裁剪。L2 用于增加一个局部行为机制，不用于整体重写核心。
- L3 Solver core：在 L1/L2 基础上开放 `model.py`、`run.py`，并允许对已有 loop 做结构性改变。覆盖 Responses 请求、Unix socket、SSE 解析、输出恢复、HTTP timeout/error/retry、CLI/profile/session 组装以及 trace/answer 生命周期；对应大型 Harness 的 agent loop、session/context、registry、adapter 和 build/runtime wiring。

所有层都不能修改或绕过信任根：Controller、Evaluator/judge、题目与 split、gold/reference answer、预算计量、credential、gateway 信任配置、test 可见性、promotion/rollback，以及 Candidate 内的 `README.md`、`NOTICE.md`、`LICENSE.md`、`.gitignore`、`.git` 和环境密钥。

三层说明与路径是 Runtime 参数，当前定义位于 `environments/hle-text-math/msa-runtime.json` 的 `mutation.layers`；Controller 和 Updater 使用同一份规范化配置。更换 math/reasoning Harness 时可以调整说明和文件路径，无需改进化状态机代码，但三层必须保持 L1 ⊆ L2 ⊆ L3。

## 单工作区与 Git

campaign 初始化时只创建一次 candidate worktree 和一个独立 Git repository。后续所有轮次都复用它：

```text
<campaign>/
  candidates/baseline/workspace/   # 唯一 candidate 工作区
  private/linear-git.git/           # 独立 Git 对象与 refs
  private/validation/<candidate>/   # validation 结果与 trace
  public/evolution-log.jsonl        # 每轮审计和曲线数据
  public/state.json                 # incumbent、轮次与分数；不维护层级 misses
```

接受时不复制目录，只移动 incumbent commit 指针；拒绝时只对这个工作区执行 `git reset --hard <incumbent>`。初次 checkout 和首次构建仍然各发生一次，后续轮次不重复复制完整源码。

## 每轮日志

Controller 在 Updater 完成、validation 决策落定后追加一条日志，至少记录：

- candidate、level、parent commit、mutation commit；
- Updater 的 commit subject（主要改进方向）；
- `git diff --stat` 与 patch；
- incumbent/candidate validation 分数；
- keep 或 rollback；
- updater、build、validation 和总耗时。

这份日志既用于最终曲线和结果汇总，也作为下一轮 Updater 的进化记忆。当前快速实验不运行 test，因此不会产生或泄露任何 test 反馈。
