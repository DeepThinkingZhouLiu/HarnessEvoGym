#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=24.19.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
PNPM_VERSION=11.7.0
DEEPSEEK_HARNESS_REVISION=3289531e06e924abb790685f44baf67311f26ec9

runtime_root=/mnt/data/hzy/dsh-rsi-runtime
scratch_root=/dev/shm/dsh-rsi-hle
repository_root=

usage() {
  printf '%s\n' \
    'Usage: setup-hle-runtime.sh --repository-root PATH [options]' \
    '' \
    'Options:' \
    '  --runtime-root PATH  Persistent runtime root (default: /mnt/data/hzy/dsh-rsi-runtime)' \
    '  --scratch-root PATH  Local tmpfs root (default: /dev/shm/dsh-rsi-hle)' \
    '  --help'
}

while (($# > 0)); do
  case "$1" in
    --repository-root)
      repository_root=${2:?missing value for --repository-root}
      shift 2
      ;;
    --runtime-root)
      runtime_root=${2:?missing value for --runtime-root}
      shift 2
      ;;
    --scratch-root)
      scratch_root=${2:?missing value for --scratch-root}
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  printf 'This setup must run as root.\n' >&2
  exit 1
fi
if [[ -z ${repository_root} || ! -f ${repository_root}/package.json ]]; then
  printf '%s\n' '--repository-root must name the checked-out Harness RSI repository.' >&2
  exit 2
fi

repository_root=$(realpath "$repository_root")
runtime_root=$(realpath -m "$runtime_root")
scratch_root=$(realpath -m "$scratch_root")
is_within() {
  local parent=${1%/}
  local child=${2%/}
  [[ $child == "$parent" || $child == "$parent/"* ]]
}
for pair in \
  "$repository_root|$runtime_root|Repository and runtime roots" \
  "$repository_root|$scratch_root|Repository and scratch roots" \
  "$runtime_root|$scratch_root|Runtime and scratch roots"; do
  IFS='|' read -r left right label <<<"$pair"
  if is_within "$left" "$right" || is_within "$right" "$left"; then
    printf '%s must be disjoint: %s %s\n' "$label" "$left" "$right" >&2
    exit 2
  fi
done
case "$runtime_root" in
  /|/root|/home|/mnt|/mnt/data)
    printf 'Refusing broad runtime root: %s\n' "$runtime_root" >&2
    exit 2
    ;;
esac
case "$scratch_root" in
  /|/dev|/dev/shm|/tmp)
    printf 'Refusing broad scratch root: %s\n' "$scratch_root" >&2
    exit 2
    ;;
esac

for agent_user in dsh-rsi-updater dsh-rsi-solver dsh-rsi-build dsh-rsi-verifier; do
  if ! getent group "$agent_user" >/dev/null; then
    groupadd --system "$agent_user"
  fi
  if ! getent passwd "$agent_user" >/dev/null; then
    useradd \
      --system \
      --gid "$agent_user" \
      --home-dir /nonexistent \
      --no-create-home \
      --shell /usr/sbin/nologin \
      "$agent_user"
  fi
done

bwrap_path=$(command -v bwrap || true)
setpriv_path=$(command -v setpriv || true)
if [[ $bwrap_path != /usr/bin/bwrap || ! -x $bwrap_path ]]; then
  printf 'The frozen /usr/bin/bwrap executable is required.\n' >&2
  exit 1
fi
if [[ $setpriv_path != /usr/bin/setpriv || ! -x $setpriv_path ]]; then
  printf 'The frozen /usr/bin/setpriv executable is required.\n' >&2
  exit 1
fi
"$bwrap_path" --version >/dev/null
"$setpriv_path" --version >/dev/null

solver_uid=$(id -u dsh-rsi-solver)
solver_gid=$(id -g dsh-rsi-solver)
"$setpriv_path" \
  "--reuid=${solver_uid}" \
  "--regid=${solver_gid}" \
  --clear-groups \
  --no-new-privs \
  "$bwrap_path" \
  --die-with-parent \
  --new-session \
  --unshare-user \
  --unshare-pid \
  --unshare-ipc \
  --unshare-uts \
  --unshare-cgroup \
  --unshare-net \
  --uid 0 \
  --gid 0 \
  --cap-drop ALL \
  --hostname rsi-hle-attest \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/sbin /sbin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --dir /proc \
  --dev /dev \
  --dir /dev/shm \
  --tmpfs /dev/shm \
  --dir /tmp \
  --tmpfs /tmp \
  -- /usr/bin/true

install -d -o root -g root -m 0711 "$runtime_root" "$scratch_root"
download_root=$(mktemp -d "${scratch_root}/setup-download.XXXXXX")
trap 'rm -rf -- "$download_root"' EXIT

node_root="${runtime_root}/node-v${NODE_VERSION}-linux-x64"
if [[ ! -x ${node_root}/bin/node ]]; then
  node_archive="${download_root}/${NODE_ARCHIVE}"
  curl --fail --location --retry 4 --output "$node_archive" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
  printf '%s  %s\n' "$NODE_SHA256" "$node_archive" | sha256sum --check --status
  tar -xJf "$node_archive" -C "$runtime_root"
fi
if [[ $(${node_root}/bin/node --version) != "v${NODE_VERSION}" ]]; then
  printf 'Node version attestation failed.\n' >&2
  exit 1
fi

pnpm_root="${runtime_root}/pnpm-${PNPM_VERSION}"
if [[ ! -x ${pnpm_root}/bin/pnpm ]]; then
  install -d -o root -g root -m 0755 "$pnpm_root"
  PATH="${node_root}/bin:${PATH}" "${node_root}/bin/npm" install \
    --global \
    --prefix "$pnpm_root" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    "pnpm@${PNPM_VERSION}"
fi
if [[ $(PATH="${node_root}/bin:${PATH}" "${pnpm_root}/bin/pnpm" --version) != "$PNPM_VERSION" ]]; then
  printf 'pnpm version attestation failed.\n' >&2
  exit 1
fi

git -C "$repository_root" submodule update --init --recursive
harness_source="${repository_root}/sources/deepseek-harness"
if [[ $(git -C "$harness_source" rev-parse HEAD) != "$DEEPSEEK_HARNESS_REVISION" ]]; then
  printf 'DeepSeek Harness submodule revision attestation failed.\n' >&2
  exit 1
fi
if [[ -n $(git -C "$harness_source" status --porcelain=v1 --untracked-files=no) ]]; then
  printf 'DeepSeek Harness tracked source is dirty.\n' >&2
  exit 1
fi

control_root="${runtime_root}/control"
install -d -o root -g root -m 0755 "$control_root"
install -o root -g root -m 0444 \
  "${repository_root}/environments/hle-text-math/dashscope-qwen38-max-headless.patch.yml" \
  "${control_root}/hle-dashscope-qwen38-max-headless.patch.yml"
install -o root -g root -m 0444 \
  "${repository_root}/controller/src/model-gateway-relay.mjs" \
  "${control_root}/model-gateway-relay.mjs"

dataset_root="${runtime_root}/datasets/hle-text-math"
for required_store in \
  "${dataset_root}/validation/records.jsonl" \
  "${dataset_root}/sealed/test/records.jsonl"; do
  if [[ ! -f $required_store || -L $required_store ]]; then
    printf 'Missing prepared HLE private store: %s\n' "$required_store" >&2
    exit 1
  fi
  chmod 0600 "$required_store"
done
chmod 0700 "${dataset_root}/validation" "${dataset_root}/sealed/test"

pnpm_store_root="${runtime_root}/pnpm-store"
trusted_baseline_root="${runtime_root}/trusted-baseline"
dependency_marker="${runtime_root}/trusted-dependencies-hle-v2.txt"
lock_digest=$(sha256sum "${harness_source}/pnpm-lock.yaml" | cut -d ' ' -f 1)
dependency_fingerprint="harness=${DEEPSEEK_HARNESS_REVISION} lock=${lock_digest} node=${NODE_VERSION} pnpm=${PNPM_VERSION} host-build=v2"
installed_fingerprint=
if [[ -f $dependency_marker ]]; then
  installed_fingerprint=$(<"$dependency_marker")
fi
if [[ $installed_fingerprint != "$dependency_fingerprint" \
      || ! -d $pnpm_store_root \
      || ! -f ${trusted_baseline_root}/apps/cli/src/bin.ts \
      || ! -f ${trusted_baseline_root}/node_modules/tsx/dist/esm/index.mjs ]]; then
  dependency_stage=$(mktemp -d "${runtime_root}/.hle-dependency-stage.XXXXXX")
  trusted_baseline_stage="${dependency_stage}/baseline"
  pnpm_store_stage="${dependency_stage}/store"
  dependency_home="${dependency_stage}/home"
  install -d -o root -g root -m 0755 \
    "$trusted_baseline_stage" \
    "$pnpm_store_stage" \
    "$dependency_home"
  (
    cd "$harness_source"
    tar --exclude='./.git' --exclude='./node_modules' -cf - .
  ) | tar -xf - -C "$trusted_baseline_stage"
  (
    cd "$trusted_baseline_stage"
    HOME="$dependency_home" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${pnpm_root}/bin/pnpm" install \
        --frozen-lockfile \
        --ignore-scripts \
        --store-dir "$pnpm_store_stage" \
        --package-import-method=copy \
        --reporter=append-only
    HOME="$dependency_home" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${pnpm_root}/bin/pnpm" run build:lib:host
    HOME="$dependency_home" \
      PATH="${node_root}/bin:/usr/bin:/bin" \
      "${node_root}/bin/node" \
        --import tsx/esm \
        apps/cli/src/bin.ts \
        --version >/dev/null
  )
  chown -R root:root "$trusted_baseline_stage" "$pnpm_store_stage"
  chmod -R a-w "$trusted_baseline_stage" "$pnpm_store_stage"
  rm -rf -- "$trusted_baseline_root" "$pnpm_store_root"
  mv "$trusted_baseline_stage" "$trusted_baseline_root"
  mv "$pnpm_store_stage" "$pnpm_store_root"
  marker_stage="${dependency_stage}/trusted-dependencies-hle-v2.txt"
  printf '%s\n' "$dependency_fingerprint" >"$marker_stage"
  install -o root -g root -m 0444 "$marker_stage" "$dependency_marker"
  rm -rf -- "$dependency_stage"
fi
if find "$pnpm_store_root" -xdev \
    \( -not -user root -o \( ! -type l -perm /022 \) \) -print -quit \
    | grep -q .; then
  printf 'Pinned pnpm store is not root-owned and immutable: %s\n' "$pnpm_store_root" >&2
  exit 1
fi

install -d -o root -g root -m 0711 "${runtime_root}/build-home"
# Agent sandboxes consume copied/frozen trees. Keeping this trust root private
# prevents them from discovering Controller code or either private manifest.
chmod 0700 "$repository_root"

printf '%s\n' \
  "runtime_root=${runtime_root}" \
  "scratch_root=${scratch_root}" \
  "node=${node_root}/bin/node" \
  "pnpm=${pnpm_root}/bin/pnpm" \
  "dataset_root=${dataset_root}" \
  "trusted_baseline=${trusted_baseline_root}" \
  "pnpm_store=${pnpm_store_root}" \
  "runtime_patch=${control_root}/hle-dashscope-qwen38-max-headless.patch.yml" \
  "bwrap=${bwrap_path}" \
  "setpriv=${setpriv_path}" \
  "updater_uid=$(id -u dsh-rsi-updater)" \
  "updater_gid=$(id -g dsh-rsi-updater)" \
  "solver_uid=${solver_uid}" \
  "solver_gid=${solver_gid}" \
  "verifier_uid=$(id -u dsh-rsi-verifier)" \
  "verifier_gid=$(id -g dsh-rsi-verifier)" \
  "build_uid=$(id -u dsh-rsi-build)" \
  "build_gid=$(id -g dsh-rsi-build)" \
  'egress_guard=network-namespace-unix-gateway'
