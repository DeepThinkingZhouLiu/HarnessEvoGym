# Cowork GRHS Final 跨机器续跑交接

本文只适用于以下已经领取 sealed Final 的运行。目标是保留所有已提交的 Final
checkpoint，在另一台机器上继续同一个 Final attempt，不能创建第二个 attempt。

## 运行身份与当前状态

记录时间：2026-09-13 17:40 CST。

| 项目 | 值 |
| --- | --- |
| Population run ID | `cowork-native-grhs-claude-terra-c8-tmp2-20260912` |
| 当前 champion | `h0` |
| Final attempt ID | `8f7542e1-1553-47cb-9d42-a69f55e1fdaa` |
| Final startedAt | `2026-09-13T06:18:07.457Z` |
| Final checkpoint | 记录时 `42/60`，源机器仍在继续运行 |
| Final 状态 | `finalizing` |
| 冻结 Controller revision | `0c0b9f10cfac1839de3408556fd8d5705c376822` |
| Benchmark revision | `597038105268fa86ddb1c129c9c58db5f80a3a68` |
| Candidate digest | `a67ef5371cf77e34dd023e908464365ad7061b4db5b41c41b850cfcaa41fa25e` |
| Final claim SHA-256 | `0be435f7691afd74fd41dbcab297ff1464cb3ce6484de2b64af0fa9bf4feea76` |

实时完成数以运行目录为准：

```bash
RUN_ROOT=/tmp/HarnessEvoGym-run.Mj9CiN/.rsi/runs/populations/cowork-native-grhs-claude-terra-c8-tmp2-20260912
find "$RUN_ROOT/branches/branch-001/run" -type f \
  -name committed-result.json -path '*/final/*' | wc -l
```

## 模型与脱敏凭据

真实 key 不进入 Git、迁移包或命令历史。下表的末四位仅用于在目标机器确认拿到的是
同一组凭据。

| 阶段 | 角色与模型 | Base URL | Key 标识 |
| --- | --- | --- | --- |
| H0 Feedback 90 | Solver，`gpt-5.6-terra`，high | `https://api.zcloudapi.com/v1` | `sk-***s5Dt` |
| GRHS Update | Claude Code CLI，`claude-sonnet-5`，high | `https://api.zcloudapi.com/v1` | `sk-***4v46` |
| Sibling Selection 4 x 30 | Solver，`gpt-5.6-terra`，high | `https://api.zcloudapi.com/v1` | `sk-***s5Dt` |
| Sealed Final 60 | Solver，`gpt-5.6-terra`，high | `https://api.zcloudapi.com/v1` | `sk-***s5Dt` |

Final 不会调用 Updater，但冻结配置的 preflight 仍要求 Claude Provider 的两个环境变量
存在，所以续跑时两组凭据都必须提供。

## 必须迁移的目录

必须在源机器停止当前 Final 进程后，对以下两个目录制作同一时间点的一致快照：

1. `/tmp/HarnessEvoGym-run.Mj9CiN`，当前约 1.9 GiB。必须复制整个目录，包括 `.git`、
   `.rsi`、未提交的本地 Docker 配置和 `scripts/cowork-final-supervisor.sh`。不能只复制
   population 子目录。
2. `/tmp/cowork-evolution-benchmark-597038105`，当前约 887 MiB。Dataset 和 Evaluator
   都从这里读取，必须保持 revision `597038105268fa86ddb1c129c9c58db5f80a3a68`。

目标机器应恢复到完全相同的绝对路径。macOS 中 `/tmp` 映射到 `/private/tmp`；运行产物
内部同时出现两种路径，因此不要在迁移时重命名这两个目录。

不要把上述目录或 Final 逐题结果提交到 Git。`pnx-dev` 中的本文只负责记录交接方法；
真正续跑依赖单独传输的目录快照。

## 在源机器停止并打包

不要在 Controller 和 Solver 正在写文件时直接复制。准备迁移时先停止当前前台任务：

```bash
tmux send-keys -t cowork-final C-c

while pgrep -f 'experiment finalize.*cowork-native-grhs-claude-terra-c8-tmp2-20260912' >/dev/null; do
  sleep 2
done
```

确认没有属于本 run 的 Solver 容器仍在写入。只清理由本 run 创建的容器，不要使用广泛
匹配删除其他实验：

```bash
docker ps --format '{{.Names}}' | \
  grep '^84fd7d69cda0-h0-.*-solver$'
```

随后从文件系统根目录打包，以保留 `private/tmp/...` 路径。`HANDOFF_DEST` 应指向空间
充足的外接盘或传输目录：

```bash
export HANDOFF_DEST=/absolute/path/to/cowork-grhs-final-handoff-20260913.tar.gz

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
tar -C / -czf "$HANDOFF_DEST" \
  private/tmp/HarnessEvoGym-run.Mj9CiN \
  private/tmp/cowork-evolution-benchmark-597038105
shasum -a 256 "$HANDOFF_DEST" > "$HANDOFF_DEST.sha256"
```

在开始传输后不要让源机器继续同一个 Final，否则源、目标两份 checkpoint 会分叉。

## 在目标机器恢复

目标机器需要 macOS、Node.js 24、Docker Desktop 和 tmux。先验证压缩包，再恢复到文件
系统根目录：

```bash
shasum -a 256 -c cowork-grhs-final-handoff-20260913.tar.gz.sha256
tar -C / -xzf cowork-grhs-final-handoff-20260913.tar.gz

git -C /tmp/HarnessEvoGym-run.Mj9CiN rev-parse HEAD
git -C /tmp/cowork-evolution-benchmark-597038105 rev-parse HEAD
shasum -a 256 \
  /tmp/HarnessEvoGym-run.Mj9CiN/.rsi/runs/populations/cowork-native-grhs-claude-terra-c8-tmp2-20260912/final-attempt.json
```

三项结果必须分别匹配本文顶部的 Controller revision、Benchmark revision 和 Final claim
SHA-256。不要在用于续跑的 checkout 中执行 `git pull`、切到最新 `pnx-dev`、清理 dirty
files 或重新生成配置；Final 会重验冻结 revision 和 bundle digest。

## 设置目标机器环境

所有下载和模型访问均清除代理变量。用隐藏输入读取真实 key，避免写入 shell history：

```bash
cd /tmp/HarnessEvoGym-run.Mj9CiN

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export RSI_PROVIDER_BASE_URL='https://api.zcloudapi.com/v1'
export RSI_CLAUDE_PROVIDER_BASE_URL='https://api.zcloudapi.com/v1'

read -rsp 'Solver key ending s5Dt: ' RSI_PROVIDER_API_KEY
printf '\n'
export RSI_PROVIDER_API_KEY
read -rsp 'Claude key ending 4v46: ' RSI_CLAUDE_PROVIDER_API_KEY
printf '\n'
export RSI_CLAUDE_PROVIDER_API_KEY

export RSI_COWORK_BENCH_DATASET_ROOT='/tmp/cowork-evolution-benchmark-597038105'
export RSI_COWORK_BENCH_EVALUATOR_ROOT='/tmp/cowork-evolution-benchmark-597038105'
export RSI_GLOBAL_CONCURRENCY_ROOT='/private/tmp/HarnessEvoGym-run.Mj9CiN/.rsi/global-concurrency-final-target'
export RSI_GLOBAL_SOLVER_CONCURRENCY=4
export RSI_GLOBAL_UPDATER_CONCURRENCY=1
```

目标机器没有本地镜像时，在上述环境中执行以下命令。它可能下载基础镜像，但不会读取
Final：

```bash
node controller/src/cli.mjs runtime build \
  --experiment experiments/cowork-bench-native-90-30-60-grhs-claude-qwen-local-docker.json
```

## 续跑同一个 Final attempt

严禁再次执行不带参数的 `experiment finalize`，也不要使用
`--recover-infrastructure`。唯一正确入口是 `--resume-final`：

```bash
node controller/src/cli.mjs experiment finalize \
  --run .rsi/runs/populations/cowork-native-grhs-claude-terra-c8-tmp2-20260912 \
  --resume-final
```

也可以在全新的 tmux server 中运行随快照迁移的 supervisor。它会检测现有
`finalizing/final-failed` 状态并自动使用 `--resume-final`：

```bash
tmux -L cowork-final-handoff new-session -d \
  -s cowork-final \
  -c /tmp/HarnessEvoGym-run.Mj9CiN \
  'exec /tmp/HarnessEvoGym-run.Mj9CiN/scripts/cowork-final-supervisor.sh'

tmux -L cowork-final-handoff has-session -t cowork-final
```

Controller 会复用每道题的 `committed-result.json`，只补跑剩余任务。看到日志中的
`[final-preflight]` 和 `[final-feedback]` 后，检查活动容器与完成数：

```bash
docker ps --format '{{.Names}}|{{.Status}}' | grep 'cowork'

RUN_ROOT=/tmp/HarnessEvoGym-run.Mj9CiN/.rsi/runs/populations/cowork-native-grhs-claude-terra-c8-tmp2-20260912
find "$RUN_ROOT/branches/branch-001/run" -type f \
  -name committed-result.json -path '*/final/*' | wc -l
tail -n 50 "$RUN_ROOT/recovery/final-supervisor.log"
```

完成后应生成：

```text
/tmp/HarnessEvoGym-run.Mj9CiN/.rsi/runs/populations/
  cowork-native-grhs-claude-terra-c8-tmp2-20260912/
    report/final-evaluation.json
```

并且 `public/state.json` 的 `final.evaluated` 应为 `true`。在该状态下不得再次运行 Final。

## 失败边界

- `Final Attempt Claim 与续跑状态不一致`：迁移包中的 `public/state.json`、branch
  `state.json` 和 `final-attempt.json` 不是同一快照，重新从停止后的源目录打包。
- `Controller Revision` 或 `Bundle` 不一致：使用了最新 `pnx-dev` 而不是原运行目录；恢复
  `/tmp/HarnessEvoGym-run.Mj9CiN` 的完整快照。
- Benchmark revision 不一致：恢复指定 benchmark 目录，不要用新的 main 分支替代。
- 凭据缺失：两组 Provider 环境变量都必须设置，即使 Final 实际只调用 Solver。
- HTTP 429：先保持并发 4；只有持续出现 429 时再将
  `RSI_GLOBAL_SOLVER_CONCURRENCY` 降到 2，并继续同一个 attempt。
