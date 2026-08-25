#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=24.19.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
PNPM_VERSION=11.7.0
ELAN_VERSION=4.2.3
ELAN_SHA256=df0b2b3a439961ffcbb3985214365ffe40f49bc871df04dff268c7d8e21ca8b2
LEAN_VERSION=4.27.0
LEAN_TOOLCHAIN=leanprover/lean4:v4.27.0
PUTNAMBENCH_REVISION=dfb0a47a1c1ec3a10f2a9acfdf41a2043920f33c
DEEPSEEK_HARNESS_REVISION=3289531e06e924abb790685f44baf67311f26ec9

runtime_root=/mnt/data/hzy/dsh-rsi-runtime
scratch_root=/dev/shm/dsh-rsi
repository_root=

usage() {
  printf '%s\n' \
    'Usage: setup-putnambench-runtime.sh --repository-root PATH [options]' \
    '' \
    'Options:' \
    '  --runtime-root PATH       Persistent runtime root (default: /mnt/data/hzy/dsh-rsi-runtime)' \
    '  --scratch-root PATH       Local tmpfs scratch root (default: /dev/shm/dsh-rsi)' \
    '  Egress isolation is mandatory and is always installed for untrusted UIDs.' \
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
if is_within "$repository_root" "$runtime_root" || is_within "$runtime_root" "$repository_root"; then
  printf 'Repository and runtime roots must be disjoint siblings: repo=%s runtime=%s\n' \
    "$repository_root" "$runtime_root" >&2
  exit 2
fi
if is_within "$repository_root" "$scratch_root" || is_within "$scratch_root" "$repository_root"; then
  printf 'Repository and scratch roots must be disjoint: repo=%s scratch=%s\n' \
    "$repository_root" "$scratch_root" >&2
  exit 2
fi
if is_within "$runtime_root" "$scratch_root" || is_within "$scratch_root" "$runtime_root"; then
  printf 'Runtime and scratch roots must be disjoint: runtime=%s scratch=%s\n' \
    "$runtime_root" "$scratch_root" >&2
  exit 2
fi
case "$runtime_root" in
  /|/root|/home|/mnt|/mnt/data)
    printf 'Refusing broad runtime root: %s\n' "$runtime_root" >&2
    exit 2
    ;;
esac
case "$scratch_root" in
  /|/dev|/dev/shm)
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
if [[ -z $bwrap_path || ! -x $bwrap_path ]]; then
  printf 'bubblewrap (bwrap) is required for the production sandbox.\n' >&2
  exit 1
fi
if [[ -z $setpriv_path || ! -x $setpriv_path ]]; then
  printf 'setpriv is required for the production sandbox.\n' >&2
  exit 1
fi
if ! "$bwrap_path" --version >/dev/null 2>&1 || ! "$setpriv_path" --version >/dev/null 2>&1; then
  printf 'Unable to attest bwrap/setpriv versions.\n' >&2
  exit 1
fi
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
  --hostname rsi-attest \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/sbin /sbin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --proc /proc \
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

elan_home="${runtime_root}/elan"
if [[ ! -x ${elan_home}/bin/elan ]]; then
  elan_archive="${download_root}/elan-x86_64-unknown-linux-gnu.tar.gz"
  curl --fail --location --retry 4 --output "$elan_archive" \
    "https://github.com/leanprover/elan/releases/download/v${ELAN_VERSION}/elan-x86_64-unknown-linux-gnu.tar.gz"
  printf '%s  %s\n' "$ELAN_SHA256" "$elan_archive" | sha256sum --check --status
  tar -xzf "$elan_archive" -C "$download_root"
  ELAN_HOME="$elan_home" "${download_root}/elan-init" -y --no-modify-path --default-toolchain none
fi
if ! ELAN_HOME="$elan_home" "${elan_home}/bin/elan" toolchain list \
    | awk '{ print $1 }' \
    | grep -Fxq "$LEAN_TOOLCHAIN"; then
  ELAN_HOME="$elan_home" "${elan_home}/bin/elan" toolchain install "$LEAN_TOOLCHAIN"
fi
lean_version=$(ELAN_HOME="$elan_home" "${elan_home}/bin/elan" \
  run "$LEAN_TOOLCHAIN" lean --version)
if [[ $lean_version != "Lean (version ${LEAN_VERSION},"* ]]; then
  printf 'Lean version attestation failed: %s\n' "$lean_version" >&2
  exit 1
fi

dataset_parent="${runtime_root}/datasets"
dataset_root="${dataset_parent}/PutnamBench"
install -d -o root -g root -m 0755 "$dataset_parent"
if [[ ! -d ${dataset_root}/.git ]]; then
  git clone https://github.com/trishullab/PutnamBench.git "$dataset_root"
  git -C "$dataset_root" checkout --detach "$PUTNAMBENCH_REVISION"
fi
actual_dataset_revision=$(git -C "$dataset_root" rev-parse HEAD)
if [[ $actual_dataset_revision != "$PUTNAMBENCH_REVISION" ]]; then
  printf 'PutnamBench checkout has the wrong revision: %s\n' "$actual_dataset_revision" >&2
  exit 1
fi
if [[ -n $(git -C "$dataset_root" status --porcelain=v1 --untracked-files=no) ]]; then
  printf 'PutnamBench tracked files are dirty; refusing to alter them.\n' >&2
  exit 1
fi

git -C "$repository_root" submodule update --init --recursive
if [[ $(git -C "${repository_root}/sources/deepseek-harness" rev-parse HEAD) != "$DEEPSEEK_HARNESS_REVISION" ]]; then
  printf 'DeepSeek Harness submodule revision attestation failed.\n' >&2
  exit 1
fi
chmod 0600 "${repository_root}/benchmarks/putnambench-lean/test.ids"
chmod 0644 "${repository_root}/benchmarks/putnambench-lean/validation.ids"
control_root="${runtime_root}/control"
install -d -o root -g root -m 0755 "$control_root"
install -o root -g root -m 0444 \
  "${repository_root}/environments/putnambench-lean/zcloud-max-headless.patch.yml" \
  "${control_root}/zcloud-max-headless.patch.yml"
# Candidate/Updater processes must not traverse the repository trust root: the
# test split, Controller implementation, prompts, and source checkout stay here.
chmod 0700 "$repository_root"

export ELAN_HOME="$elan_home"
export PATH="${elan_home}/bin:${node_root}/bin:${PATH}"
(
  cd "${dataset_root}/lean4"
  lake exe cache get
)
if [[ -n $(git -C "$dataset_root" status --porcelain=v1 --untracked-files=no) ]]; then
  printf 'Lean setup changed tracked PutnamBench files.\n' >&2
  exit 1
fi

build_uid=$(id -u dsh-rsi-build)
build_gid=$(id -g dsh-rsi-build)
pnpm_store_root="${runtime_root}/pnpm-store"
trusted_baseline_root="${runtime_root}/trusted-baseline"
dependency_marker="${runtime_root}/trusted-dependencies.txt"
lock_digest=$(sha256sum "${repository_root}/sources/deepseek-harness/pnpm-lock.yaml" | cut -d ' ' -f 1)
dependency_fingerprint="harness=${DEEPSEEK_HARNESS_REVISION} lock=${lock_digest} node=${NODE_VERSION} pnpm=${PNPM_VERSION}"

# Networked dependency resolution happens once, here, from the attested upstream
# source and lockfile. Campaign builds never traverse the repository and never
# receive network access: they consume this root-owned store through a read-only
# bwrap mount with --offline --ignore-scripts.
installed_fingerprint=
if [[ -f $dependency_marker ]]; then
  installed_fingerprint=$(<"$dependency_marker")
fi
if [[ $installed_fingerprint != "$dependency_fingerprint" \
      || ! -d $pnpm_store_root \
      || ! -f ${trusted_baseline_root}/apps/cli/src/bin.ts \
      || ! -f ${trusted_baseline_root}/node_modules/tsx/dist/esm/index.mjs ]]; then
  dependency_stage=$(mktemp -d "${runtime_root}/.dependency-stage.XXXXXX")
  trusted_baseline_stage="${dependency_stage}/baseline"
  pnpm_store_stage="${dependency_stage}/store"
  dependency_home="${dependency_stage}/home"
  install -d -o root -g root -m 0755 \
    "$trusted_baseline_stage" \
    "$pnpm_store_stage" \
    "$dependency_home"
  (
    cd "${repository_root}/sources/deepseek-harness"
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
  marker_stage="${dependency_stage}/trusted-dependencies.txt"
  printf '%s\n' "$dependency_fingerprint" >"$marker_stage"
  install -o root -g root -m 0444 "$marker_stage" "$dependency_marker"
  rm -rf -- "$dependency_stage"
fi
# Linux symlink mode is always reported as 0777 and cannot be changed with
# chmod. Match the Controller's runtime attestation: every entry must be
# root-owned, while write-bit checks apply to real files/directories only.
if find "$pnpm_store_root" -xdev \
    \( -not -user root -o \( ! -type l -perm /022 \) \) -print -quit \
    | grep -q .; then
  printf 'Pinned pnpm store is not root-owned and immutable: %s\n' "$pnpm_store_root" >&2
  exit 1
fi
install -d -o root -g root -m 0711 "${runtime_root}/build-home"

for firewall in /usr/sbin/iptables /usr/sbin/ip6tables; do
  if [[ ! -x $firewall ]]; then
    printf 'Missing mandatory firewall command: %s\n' "$firewall" >&2
    exit 1
  fi
  if ! "$firewall" -w 5 -n -L DSH_RSI_EGRESS >/dev/null 2>&1; then
    "$firewall" -w 5 -N DSH_RSI_EGRESS
  fi
  "$firewall" -w 5 -F DSH_RSI_EGRESS
  "$firewall" -w 5 -A DSH_RSI_EGRESS -j REJECT

  for restricted_user in dsh-rsi-updater dsh-rsi-solver dsh-rsi-build dsh-rsi-verifier; do
    restricted_uid=$(id -u "$restricted_user")
    while "$firewall" -w 5 -C OUTPUT -m owner --uid-owner "$restricted_uid" \
      -j DSH_RSI_EGRESS >/dev/null 2>&1; do
      "$firewall" -w 5 -D OUTPUT -m owner --uid-owner "$restricted_uid" -j DSH_RSI_EGRESS
    done
    "$firewall" -w 5 -I OUTPUT 1 -m owner --uid-owner "$restricted_uid" -j DSH_RSI_EGRESS
  done

  "$firewall" -w 5 -C DSH_RSI_EGRESS -j REJECT >/dev/null
  chain_rule_count=$("$firewall" -w 5 -S DSH_RSI_EGRESS \
    | awk '$1 == "-A" && $2 == "DSH_RSI_EGRESS" { count += 1 } END { print count + 0 }')
  if [[ $chain_rule_count -ne 1 ]]; then
    printf 'DSH_RSI_EGRESS must contain only its terminal REJECT rule: %s\n' "$firewall" >&2
    exit 1
  fi
  for restricted_user in dsh-rsi-updater dsh-rsi-solver dsh-rsi-build dsh-rsi-verifier; do
    restricted_uid=$(id -u "$restricted_user")
    "$firewall" -w 5 -C OUTPUT -m owner --uid-owner "$restricted_uid" \
      -j DSH_RSI_EGRESS >/dev/null
  done
done

printf '%s\n' \
  "runtime_root=${runtime_root}" \
  "scratch_root=${scratch_root}" \
  "node=${node_root}/bin/node" \
  "pnpm=${pnpm_root}/bin/pnpm" \
  "elan_home=${elan_home}" \
  "lake=${elan_home}/bin/lake" \
  "dataset_root=${dataset_root}" \
  "trusted_baseline=${trusted_baseline_root}" \
  "pnpm_store=${pnpm_store_root}" \
  "runtime_patch=${control_root}/zcloud-max-headless.patch.yml" \
  "bwrap=${bwrap_path}" \
  "setpriv=${setpriv_path}" \
  'iptables=/usr/sbin/iptables' \
  'ip6tables=/usr/sbin/ip6tables' \
  "updater_uid=$(id -u dsh-rsi-updater)" \
  "updater_gid=$(id -g dsh-rsi-updater)" \
  "solver_uid=$(id -u dsh-rsi-solver)" \
  "solver_gid=$(id -g dsh-rsi-solver)" \
  "verifier_uid=$(id -u dsh-rsi-verifier)" \
  "verifier_gid=$(id -g dsh-rsi-verifier)" \
  "build_uid=${build_uid}" \
  "build_gid=${build_gid}" \
  "egress_guard=1"
