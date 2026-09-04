# pnx-dev GRHS 交接

## liuzhou-dev 之后增加的内容

本分支从 `lz-dev@918d8ef` 分出。本次交付直接相关的新增内容只有：

- 在原有 Candidate、MutationLease、Updater、OfficeVal Evaluator、晋升/回滚和日志之上增加 GRHS Group Controller。
- 每轮从同一个 Champion 生成两个 sibling Candidate，共用同一份 Feedback 和 Selection 划分，分别运行完整 Updater Session。
- 用 Selection `deltaMeanReward` 作为 utility，在组内标准化为 relative advantage，并更新 Region proposal prior。
- 保持 liuzhou 原晋升语义：`evaluation.decision.eligible` 是唯一 Gate；Group Controller 只在 eligible sibling 中选择 utility 最大者。
- 增加按题 checkpoint、失败恢复，以及 Local Docker 和 AgentBay 两种 OfficeVal 执行 backend。

主要代码是 `controller/src/grhs.mjs` 和
`controller/src/cowork-orchestrator.mjs`。可直接复现的一轮配置是
`experiments/cowork-msa-grhs-one-round-codex.json`。

## 实验：12 → 9 → 5

实验使用 OmegaUse-OfficeVal 的 Linux static-verifier 任务：

- Feedback：12 题。只用于生成反馈包，Updater 可见详细反馈。
- Selection：9 题。H0 和两个 sibling 在同一组题上配对比较，只向 Controller 暴露聚合结果。
- Final：5 题。演化期间 sealed，不参与修改或晋升；只允许在 Champion 冻结后显式 finalize。

本轮结果：

| 对象 | 题数 | Mean reward | 相对 H0 | Eligible | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| H0 Feedback | 12 | 0.004545 | - | - | 生成反馈包 |
| H0 Selection | 9 | 0.053980 | - | - | baseline |
| s001 Selection | 9 | 0.073523 | +0.019543 | true | promoted |
| s002 Selection | 9 | 0.003086 | -0.050894 | false | rejected |

s001 在 9 题中相对 H0 提升 2 题、回退 0 题，因此新 Champion 是
`g001-grhs-s001-l2`。s002 提升 0 题、回退 2 题，没有通过
`minimum-mean-reward-delta` 和 `minimum-reward-improved` Gate。

本轮没有运行 sealed Final，因此不报告 Final 分数。Final 5 题用于上传后由复现者
通过 `experiment finalize` 独立评估，不能把它写成 Selection 结果。

## Benchmark 格式和接入

本实验的完整 Benchmark 文件是
`benchmarks/cowork-omegause-officeval-linux-v1/benchmark-grhs-12-9-5.json`。
它是 JSON，不依赖 `.rsi/`。以下只展示字段结构，数组内容已省略，不能直接拿这段
示意做 validation；可运行内容以仓库中的完整文件为准：

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "Benchmark",
  "metadata": { "id": "unique-id", "name": "human-readable name" },
  "spec": {
    "source": {
      "adapter": "omegause-officeval",
      "dataset": "baidu-frontier-research/OmegaUse-OfficeVal",
      "split": "immutable-split-name",
      "revision": "sha256-of-source-manifest"
    },
    "evaluator": {
      "adapter": "omegause-officeval",
      "resultFormat": "harness-rsi/solver-result-jsonl-v2"
    },
    "partitions": {
      "feedback": { "visibility": "detailed", "expectedCount": 12, "instanceIds": [] },
      "selection": { "visibility": "aggregate-only", "expectedCount": 9, "instanceIds": [] },
      "final": { "visibility": "sealed", "expectedCount": 5, "instanceIds": [] }
    },
    "expectedTotal": 26
  }
}
```

接入时必须满足：

- 三个 Partition 都非空，ID 不能重复，`expectedCount` 必须等于 ID 数量，`expectedTotal` 必须等于三者总数。
- visibility 固定为 `detailed`、`aggregate-only`、`sealed`，不能互换。
- OfficeVal ID 必须存在于 Source Manifest，Linux backend 不能选择 `comRequired: true` 的任务。
- `spec.source.revision` 必须等于 Source Manifest 文件的 SHA-256；不能使用 `main`、`HEAD` 或 `latest`。
- Experiment 的 `spec.benchmark` 指向 Benchmark JSON，`spec.policy` 指向可信 Evaluation Policy。

Solver 每题产生一行 `harness-rsi/solver-result-jsonl-v2` JSONL。最小记录如下：

```json
{"instance_id":"officeval_002","status":"unresolved","reward":0.23,"trial_rewards":[0.23],"trial_seeds":[20260827],"policy_violations":[]}
```

`status` 只能是 `resolved`、`unresolved`、`error`、`timeout` 或
`not_attempted`；reward 范围是 `[0, 1]`。只有 feedback Partition 可以包含
`feedback` 对象。Controller 会负责收集 Solver 输出，通常不需要手工创建 JSONL。

## Dataset、Evaluator 和路径

OfficeVal Dataset Root 需要包含：

```text
task-en/officeval_NNN.json
rubrics-en/officeval_NNN.json
task_files/officeval_NNN/*
```

Evaluator Root 是干净的 Git checkout，需要包含：

```text
verifiers/officeval_NNN_verifier.py
verifiers/pdf_backend.py
```

设置绝对路径：

```bash
export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
```

当前冻结版本写在 `environments/omegause-officeval.yml` 的 `spec.source` 中。
如果替换 Dataset 或 Evaluator，需要重新生成 Source Manifest：

```bash
node scripts/generate-omegause-officeval-manifest.mjs \
  "$RSI_OFFICEVAL_DATASET_ROOT" \
  "$RSI_OFFICEVAL_EVALUATOR_ROOT" \
  benchmarks/omegause-officeval/source-manifest.json
sha256sum benchmarks/omegause-officeval/source-manifest.json
```

然后同步更新 Environment Adapter 的 `datasetRevision`、`evaluatorRevision`、
`manifestDigest`，以及 Benchmark 的 `spec.source.revision`。不要只改 Benchmark
里的字符串绕过文件摘要校验。

## Backend 设置

Experiment 通过 `spec.adapters.environment` 选择执行 backend：

| Backend | Environment Adapter | 额外要求 |
| --- | --- | --- |
| Local Docker | `environments/omegause-officeval.yml` | 本机 Docker daemon 可用，当前用户有权限执行 `docker` |
| AgentBay | `environments/omegause-officeval-agentbay.yml` | AgentBay SDK、API key、Image ID 和 Policy ID |

仓库提供的一轮配置默认使用 Local Docker。切换到 AgentBay 时，把 Experiment 中的
environment 改为 `environments/omegause-officeval-agentbay.yml`，并把该文件中的
`spec.docker.agentBay.pythonExecutable` 改成安装了 AgentBay SDK 的 Python 绝对路径。
运行前再设置：

```bash
export AGENTBAY_API_KEY=your-agentbay-key
export HARNESS_RSI_AGENTBAY_IMAGE_ID=your-image-id
export HARNESS_RSI_AGENTBAY_POLICY_ID=your-policy-id
```

`spec.docker.backend` 只允许 `local` 或 `agentbay`。Updater backend 由
`spec.adapters.updater` 单独控制，本实验固定为 `adapters/updaters/codex-cli.yml`。

## 完整运行一轮进化

以下命令使用默认 Local Docker backend，依次完成配置检查、preflight、镜像构建、
一轮 GRHS 进化，以及对最终 Champion 的 5 题 sealed Final：

```bash
npm ci
git submodule update --init --recursive

export RSI_OFFICEVAL_DATASET_ROOT=/absolute/path/to/OmegaUse-OfficeVal-Dataset
export RSI_OFFICEVAL_EVALUATOR_ROOT=/absolute/path/to/OmegaUse-OfficeVal
export RSI_PROVIDER_BASE_URL=https://api.zcloudapi.com/v1
read -rsp "Provider API key: " RSI_PROVIDER_API_KEY && echo
export RSI_PROVIDER_API_KEY

GRHS_CONFIG=experiments/cowork-msa-grhs-one-round-codex.json
GRHS_RUN_ID=grhs-one-round-$(date -u +%Y%m%d-%H%M%S)

npm run check
npm run rsi -- benchmark validate \
  --config benchmarks/cowork-omegause-officeval-linux-v1/benchmark-grhs-12-9-5.json
npm run rsi -- experiment validate --config "$GRHS_CONFIG"
npm run rsi -- experiment preflight --config "$GRHS_CONFIG"
npm run rsi -- runtime build --experiment "$GRHS_CONFIG"
npm run rsi -- experiment run --config "$GRHS_CONFIG" --run-id "$GRHS_RUN_ID"
npm run rsi -- experiment finalize --run ".rsi/runs/$GRHS_RUN_ID"
```

`experiment run` 只读取 Feedback 和 Selection；只有最后一条 `experiment finalize`
能够读取 Final。`.rsi/` 是本地运行状态和结果目录，不会随 GitHub 上传；可复现所需的
Benchmark、Environment、Policy 和 Experiment 配置均已提交到仓库。
