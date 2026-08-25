# HLE Text-only Math 50/50

本 Campaign 固定官方 `cais/hle` revision，仅保留 `category=Math` 且题目没有 `image`/`image_preview` 的样本。随后按 `raw_subject × answer_type` 使用 largest-remainder 配额分层抽取 100 题，并在每层内尽量均衡分为 50 道验证题和 50 道测试题。HLE 没有官方难度字段，因此这里不把题长伪装成“难度分层”。

验证集题目、Solver trace、逐题状态和总分可进入下一轮 Updater feedback。Baseline 固定测一次 test；之后只在候选轮次 5、10、15……测 test，周期由 `spec.evolution.testEvaluationInterval` 配置，默认 5。测试集 manifest、题目、参考答案、judge 过程和逐题结果始终留在 sealed vault；Campaign 关闭后报告器只读取这些预定测试点的聚合分数来画泛化曲线，测试数据从不参与晋升、回退、层级切换或停止决策。

被评测的 Solver Baseline 固定为 DSH `minimal` preset，并以 restricted-minimal mode 运行。它只带本地持久 shell 和编辑器：允许在任务工作区内使用 Python/草稿文件计算；Solver 沙箱同时使用独立网络 namespace（`--unshare-net`）。参考答案和数据集 store 是 Controller 私有文件，绝不会挂载到 Solver 工作区。因此“不联网搜索”和“不直接访问 gold”除了提示词外还有进程及 mount 硬边界。由于 Controller 已拥有这层强制 bubblewrap 边界，DSH 工具调用把隔离职责委托给外层，而不再尝试不可靠的嵌套 OS 沙箱；内层 `danger-full-access` 仅相对于已经隔离的 namespace，Candidate mount 仍只读，任务工作区仍是唯一可写的任务 mount。Proposal/apply Updater 是独立的可信进化基础设施，冻结使用 DSH `standard` mode；它使用相同委托方式，同时由外层只读 mount 和宿主文件所有权强制 Proposal/apply 阶段边界。实现指纹和测试保证 Solver 变异或 Campaign 配置不能削弱这些 Controller 边界。其余 infra 是确定性的 Controller/build 进程或直接调用的可信 judge，不是 Candidate Harness 会话。

HLE 是 Hugging Face 门控数据。先在 Hugging Face 接受 `cais/hle` 的访问条件，再通过继承 FD 下载；不要把 token 放到命令行、环境变量或仓库：

```bash
python3 scripts/download-hle-text-math.py \
  --output /mnt/data/hzy/dsh-rsi-runtime/datasets/hle-text-math/source/eligible.jsonl \
  --hf-token-fd 3 3</secure/path/to/hf-token

node benchmarks/hle-text-math/prepare-split.mjs \
  --input /mnt/data/hzy/dsh-rsi-runtime/datasets/hle-text-math/source/eligible.jsonl \
  --control-root benchmarks/hle-text-math/.private \
  --dataset-root /mnt/data/hzy/dsh-rsi-runtime/datasets/hle-text-math
```

`.private/` 被 Git 忽略。准备脚本采用 write-once，不覆盖已有 manifest/store；要更换 seed 时应使用新的私有目录和 Campaign ID，避免无声改变已冻结实验。

正式运行前先做 8 题 validation-only 校准。正式运行并发为 15；50 题 validation partition 在 3600 秒硬截止，超时属于基础设施暂停，不记作 mutation miss。

所有会调用 API 的 Controller 命令都通过下面的命令级直连启动器执行。它只从新启动的 Controller 及其子进程中移除代理地址，不修改当前终端或 Codex 的环境：

```bash
node scripts/run-controller-direct.mjs campaign smoke \
  --config benchmarks/hle-text-math/.private/campaign.json \
  --runtime environments/hle-text-math/runtime.json \
  --tasks 8 --provider-key-fd 3 3</secure/path/to/provider-key
```

进化严格按 L1 → L2 → L3。只有 validation 分数严格上涨才保留 Candidate；持平或下降立即回退。连续三次无效才进入下一层，并继承此前最优 incumbent。每轮 Proposal 必须只声明一个 `before` → `after` 变量，Controller 会拒绝冻结 `intendedFiles` 之外的任何源码改动。
