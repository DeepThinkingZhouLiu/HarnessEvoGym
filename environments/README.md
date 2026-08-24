# Environment Adapter

Environment 负责把“任务如何运行、单题如何客观评分”接入 RSI；它不拥有 Candidate 晋升权。

## SkillsBench Cowork 实现

`skillsbench-cowork.yml` 固定 Task Source Revision，并描述：

- 本地 Checkout 环境变量和 `tasks/` 子目录。
- instruction、Dockerfile、Build Context 和 Verifier 的候选路径。
- 容器工作目录、网络、CPU、内存、PID 和超时。
- Model Gateway 镜像、内部 DNS、出口网络、总请求预算和并发上限；上游环境变量名由独立 Model Provider Adapter 提供。
- Verifier 命令参数与 Reward 输出候选文件。
- Reward 合法范围、全通过阈值、反馈文本与产物摘要上限、工作区/Artifact 磁盘预算和跨代搜索历史上限。

Runner 对每道题执行：

```text
构建/复用原 Task Image
-> 派生并注入固定 DSH Runtime
-> 从镜像复制一次性 Workspace
-> 记录初始 Artifact Snapshot
-> Solver 容器修改 Workspace
-> 流式重算 Artifact Hash，拒绝新增/修改的符号链接与特殊文件
-> 独立 Verifier 容器评分
-> 记录最终 Snapshot 和变化 Artifact
-> 归一化为 solver-result-jsonl-v2
```

Solver 看不到主机 Task Root 或 Verifier 挂载，只额外获得该任务自带 Skill 的只读目录。Candidate 通用 Skill 必须用 `cowork-*` 命名空间，不能遮蔽题目自带 Skill。Verifier 属于可信控制平面：宿主上的 Solver 产物以只读方式挂入，再复制到容器私有 tmpfs 工作区执行检查，因此需要生成临时文件的上游脚本仍能运行，但无法反向改写提交物。它只向独立日志目录写入评分产物，不会运行 Candidate 自带的“自报分数”。root Verifier 退出前会把日志归属恢复为启动 Controller 的普通用户。评分前会拒绝 Solver 新增/修改的符号链接、FIFO 等非普通文件，并清空 Python/Bash/uv 的工作区配置入口，降低通过导入劫持影响 Verifier 的风险。Reward 文件本身还必须是不超过 1 MiB 的普通文件，Controller 不会跟随符号链接读取宿主其他路径。当前固定 Revision 的脚本把分数写到 `/logs/verifier/reward.txt`。

## 运行前提

```bash
export RSI_SKILLSBENCH_ROOT=/absolute/path/to/skillsbench
export RSI_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
export RSI_PROVIDER_API_KEY=your-runtime-secret

npm run rsi -- experiment preflight \
  --config experiments/cowork-skillsbench-dsh-l1.json
```

Preflight 会拒绝错误 Revision、缺少的八道题、未知 Dockerfile/Verifier、脏的 DSH Source 和不可用 Docker。Verifier 版本若需要参数，可在 `spec.verifier.arguments` 使用 `{{workspace}}`、`{{outputDir}}`、`{{script}}`，无需修改 Controller。

## 已知边界

- Solver Workspace 和 Updater DSH Home 当前是宿主机 Bind Mount，磁盘预算在 Session 结束后通过快照强制，不是写入时文件系统硬配额；长时、对抗性正式实验应换成 quota-backed Volume 或有限 tmpfs。
- Solver/Updater 使用每个 Run 独立的 Docker internal network，没有外网路由；只有 Model Gateway 位于双网络，并只代理固定上游的 `POST /chat/completions`。
- 网关已经隔离真实 Key，但正式环境仍建议在其外层增加 DNS/IP Allowlist 和请求/费用审计。
- 部分 Verifier 首次运行需要安装依赖，因此可信 Verifier 默认可联网、RootFS 可写，并只恢复 apt/dpkg 需要的 Docker 默认能力子集（不含 `SYS_ADMIN`）；Solver/Updater 仍保持只读 RootFS 与零 capability。
- 当前八道 POC 题的上游 Reward 是二值 0/1；Environment/Result 协议已支持 `[0,1]` 连续 Reward。
- Model Gateway 会采集完整流式响应的 Token Usage；任何响应缺失 Usage 时，该 Session 的 Token 保持未知，美元成本仍需独立费率配置。
- DSH 当前不保证模型 Seed 控制，结果会记录 `seed_controlled=false`；正式实验应多次 Trial。
- SWE-bench 仍需独立 Environment Adapter，不能把 Coding Patch 逻辑塞进 SkillsBench Runner。
