#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connection_file="${AWS_PRODUCTION_CONNECTION_FILE:-${project_root}/.deploy/aws-production.local.env}"
release_tag="${1:-${RELEASE_TAG:-}}"

if [[ -z "$release_tag" ]]; then
  echo 'Usage: scripts/deploy-aws-production-artifact.sh <v2-production-YYYYMMDDTHHMMSSZ>' >&2
  exit 1
fi
if [[ ! "$release_tag" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo '正式发布标签格式无效' >&2
  exit 1
fi
if [[ ! -f "$connection_file" ]]; then
  echo '缺少本机 AWS 生产连接文件' >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$connection_file" 2>/dev/null || stat -c '%a' "$connection_file")" != 600 ]]; then
  echo '本机 AWS 生产连接文件必须为 0600' >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$connection_file"
set +a

require_variable() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "缺少本机 AWS 生产连接参数：${name}" >&2
    exit 1
  fi
}

for variable in \
  SERVER_SSH_HOST \
  SERVER_SSH_USER \
  SERVER_SSH_PORT \
  SERVER_SSH_KEY \
  SERVER_APP_DIR \
  PRODUCTION_BASE_URL \
  PRODUCTION_COMPOSE_PROJECT; do
  require_variable "$variable"
done
if [[ "$SERVER_APP_DIR" != /opt/id-business-v2 ]]; then
  echo '生产目录与仓库强制边界不一致' >&2
  exit 1
fi
if [[ ! -f "$SERVER_SSH_KEY" ]]; then
  echo '生产 SSH 私钥不存在' >&2
  exit 1
fi
key_mode="$(stat -f '%Lp' "$SERVER_SSH_KEY" 2>/dev/null || stat -c '%a' "$SERVER_SSH_KEY")"
if [[ "$key_mode" != 400 && "$key_mode" != 600 ]]; then
  echo '生产 SSH 私钥权限必须为 0400 或 0600' >&2
  exit 1
fi
for command in gh git node scp ssh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "本机发布依赖命令不存在：${command}" >&2
    exit 1
  fi
done
retention_script="${project_root}/scripts/cleanup-aws-production-retention.sh"
if [[ ! -x "$retention_script" ]]; then
  echo '缺少可执行生产保留策略脚本' >&2
  exit 1
fi

cd "$project_root"
if [[ -n "$(git status --porcelain)" ]]; then
  echo '生产部署前工作区必须完全干净' >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != main ]]; then
  echo '生产部署必须在本地 main 分支执行' >&2
  exit 1
fi

git fetch origin main --tags --prune
release_commit="$(git rev-parse "${release_tag}^{commit}")"
if [[ "$(git cat-file -t "$release_tag")" != tag ]]; then
  echo '生产标签必须是带说明的正式标签' >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$release_commit" ||
      "$(git rev-parse origin/main)" != "$release_commit" ]]; then
  echo '本地 HEAD、origin/main 与生产标签的完整 SHA 不一致' >&2
  exit 1
fi
git merge-base --is-ancestor "$release_commit" origin/main

artifact_name="id-business-v2-${release_tag}-${release_commit}"
run_record="$({
  gh run list \
    --workflow quality.yml \
    --commit "$release_commit" \
    --event push \
    --status success \
    --limit 20 \
    --json databaseId,headBranch,headSha,url \
    --jq ".[] | select(.headBranch == \"${release_tag}\" and .headSha == \"${release_commit}\") | [.databaseId, .url] | @tsv"
} | head -n 1)"
if [[ -z "$run_record" ]]; then
  echo '未找到该正式标签对应的成功 Quality Gate 运行' >&2
  exit 1
fi
IFS=$'\t' read -r ci_run_id ci_run_url <<<"$run_record"

artifact_record="$({
  gh api "repos/{owner}/{repo}/actions/runs/${ci_run_id}/artifacts" \
    --jq ".artifacts[] | select(.name == \"${artifact_name}\" and .expired == false) | [.id, .name, .digest] | @tsv"
} | head -n 1)"
if [[ -z "$artifact_record" ]]; then
  echo '成功 CI 运行中没有找到预期的不可变发布制品' >&2
  exit 1
fi
IFS=$'\t' read -r github_artifact_id github_artifact_name github_artifact_digest \
  <<<"$artifact_record"
if [[ ! "$github_artifact_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'GitHub 制品未提供可校验 SHA-256 digest' >&2
  exit 1
fi

working_directory="$(mktemp -d "${TMPDIR:-/tmp}/idv2-production-deploy.XXXXXX")"
case "$working_directory" in
  */idv2-production-deploy.*) ;;
  *) echo '无法创建安全的本机发布临时目录' >&2; exit 1 ;;
esac
cleanup() {
  case "$working_directory" in
    */idv2-production-deploy.*) rm -rf -- "$working_directory" ;;
  esac
}
trap cleanup EXIT INT TERM

download_directory="${working_directory}/download"
mkdir -p "$download_directory"
gh run download "$ci_run_id" --name "$artifact_name" --dir "$download_directory"
node scripts/verify-production-release-artifact.mjs \
  --directory "$download_directory" \
  --expected-commit "$release_commit" \
  --expected-tag "$release_tag"

manifest_path="${download_directory}/release-manifest.json"
IFS=$'\t' read -r \
  artifact_file \
  artifact_sha256 \
  image_archive_sha256 \
  api_reference \
  api_digest \
  admin_reference \
  admin_digest \
  migration_reference \
  migration_digest \
  gate_reference \
  gate_digest \
  <<<"$(node --input-type=module - "$manifest_path" <<'NODE'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write([
  manifest.artifact.file,
  manifest.artifact.sha256,
  manifest.artifact.imageArchiveSha256,
  manifest.images.api.reference,
  manifest.images.api.digest,
  manifest.images.admin.reference,
  manifest.images.admin.digest,
  manifest.images.migration.reference,
  manifest.images.migration.digest,
  manifest.images.gate.reference,
  manifest.images.gate.digest
].join('\t'));
NODE
)"
artifact_path="${download_directory}/${artifact_file}"

ssh_options=(
  -i "$SERVER_SSH_KEY"
  -p "$SERVER_SSH_PORT"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
)
scp_options=(
  -i "$SERVER_SSH_KEY"
  -P "$SERVER_SSH_PORT"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
)
ssh_target="${SERVER_SSH_USER}@${SERVER_SSH_HOST}"

previous_release_directory="$(
  ssh "${ssh_options[@]}" "$ssh_target" \
    "sudo readlink -f '${SERVER_APP_DIR}/current'"
)"
case "$previous_release_directory" in
  "${SERVER_APP_DIR}/releases/"*) ;;
  *) echo '生产 current 未指向受控的不可变发布目录' >&2; exit 1 ;;
esac
previous_short_sha="${previous_release_directory##*-}"
previous_commit="$(git rev-parse "${previous_short_sha}^{commit}")"
if [[ ! "$previous_commit" =~ ^[a-f0-9]{40}$ ]]; then
  echo '无法将上一生产版本解析为完整 commit' >&2
  exit 1
fi

echo '执行生产发布磁盘与保留策略预检'
ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- --preflight <"$retention_script"

release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
short_commit="${release_commit:0:12}"
deployment_run="aws-${release_stamp}-${short_commit}"
release_directory="${SERVER_APP_DIR}/releases/${release_stamp}-${short_commit}"
incoming_directory="${SERVER_APP_DIR}/incoming/${deployment_run}"
operator="$(git config user.name || true)"
operator="${operator:-${USER:-codex}}"
deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deployment_manifest_path="${working_directory}/release-manifest.json"
ci_manifest_upload_path="${working_directory}/ci-release-manifest.json"
cp "$manifest_path" "$ci_manifest_upload_path"

node scripts/create-production-deployment-manifest.mjs \
  --input "$manifest_path" \
  --output "$deployment_manifest_path" \
  --deployment-run "$deployment_run" \
  --deployed-at "$deployed_at" \
  --operator "$operator" \
  --previous-commit "$previous_commit" \
  --github-artifact-id "$github_artifact_id" \
  --github-artifact-name "$github_artifact_name" \
  --github-artifact-digest "$github_artifact_digest" \
  --github-run-url "$ci_run_url"

ssh "${ssh_options[@]}" "$ssh_target" bash -s -- "$incoming_directory" <<'REMOTE_PREPARE'
set -Eeuo pipefail
incoming_directory="$1"
case "$incoming_directory" in
  /opt/id-business-v2/incoming/aws-*) ;;
  *) echo '远程制品接收目录无效' >&2; exit 1 ;;
esac
if [[ -e "$incoming_directory" ]]; then
  echo '远程制品接收目录已存在' >&2
  exit 1
fi
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" "$incoming_directory"
REMOTE_PREPARE

scp "${scp_options[@]}" \
  "$artifact_path" \
  "$ci_manifest_upload_path" \
  "$deployment_manifest_path" \
  "${download_directory}/SHA256SUMS" \
  "${ssh_target}:${incoming_directory}/"

echo "开始部署不可变制品：${release_tag} ${release_commit}"
ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- \
  "$incoming_directory" \
  "$release_directory" \
  "$previous_release_directory" \
  "$artifact_file" \
  "$artifact_sha256" \
  "$image_archive_sha256" \
  "$release_commit" \
  "$release_tag" \
  "$deployment_run" \
  "$api_reference" \
  "$api_digest" \
  "$admin_reference" \
  "$admin_digest" \
  "$migration_reference" \
  "$migration_digest" \
  "$gate_reference" \
  "$gate_digest" \
  "$PRODUCTION_BASE_URL" \
  "$PRODUCTION_COMPOSE_PROJECT" <<'REMOTE_DEPLOY'
set -Eeuo pipefail
umask 077

incoming_directory="$1"
release_directory="$2"
previous_release_directory="$3"
artifact_file="$4"
artifact_sha256="$5"
image_archive_sha256="$6"
release_commit="$7"
release_tag="$8"
deployment_run="$9"
shift 9
api_reference="$1"
api_digest="$2"
admin_reference="$3"
admin_digest="$4"
migration_reference="$5"
migration_digest="$6"
gate_reference="$7"
gate_digest="$8"
production_base_url="$9"
production_compose_project="${10}"

deployment_root='/opt/id-business-v2'
artifact_path="${incoming_directory}/${artifact_file}"
uploaded_deployment_manifest="${incoming_directory}/release-manifest.json"
if [[ -f "${incoming_directory}/release-manifest.json" &&
      -f "${incoming_directory}/SHA256SUMS" ]]; then
  :
else
  echo '远程制品文件不完整' >&2
  exit 1
fi

if [[ ! -f "${incoming_directory}/ci-release-manifest.json" ]]; then
  echo '缺少 CI 原始发布清单' >&2
  exit 1
fi

exec 9>"${deployment_root}/.deploy.lock"
if ! flock -n 9; then
  echo '另一个生产发布正在进行' >&2
  exit 1
fi

case "$incoming_directory" in "${deployment_root}/incoming/"*) ;; *) exit 1 ;; esac
case "$release_directory" in "${deployment_root}/releases/"*) ;; *) exit 1 ;; esac
cleanup_incoming() {
  case "$incoming_directory" in
    "${deployment_root}/incoming/"*) rm -rf -- "$incoming_directory" ;;
  esac
}
trap cleanup_incoming EXIT INT TERM
if [[ -e "$release_directory" ]]; then
  echo '目标不可变发布目录已存在' >&2
  exit 1
fi
available_kib="$(df -Pk "$deployment_root" | awk 'NR == 2 { print $4 }')"
if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || ((available_kib < 8388608)); then
  echo '远程制品上传后可用空间低于 8 GiB，停止解包和镜像加载' >&2
  exit 1
fi
if [[ "$(sha256sum "$artifact_path" | awk '{print $1}')" != "$artifact_sha256" ]]; then
  echo '远程发布制品 SHA-256 校验失败' >&2
  exit 1
fi
if [[ "$(tar -tzf "$artifact_path" | sed 's#^\./##' | sort | tr '\n' ' ')" != 'images.tar source.tar.gz ' ]]; then
  echo '远程发布制品内容无效' >&2
  exit 1
fi

artifact_directory="${deployment_root}/artifacts/${release_tag}-${release_commit}"
if [[ -e "$artifact_directory" ]]; then
  if [[ ! -f "$artifact_directory/$artifact_file" ]] ||
     [[ "$(sha256sum "$artifact_directory/$artifact_file" | awk '{print $1}')" != "$artifact_sha256" ]]; then
    echo '已存在的正式标签制品与本次发布不一致' >&2
    exit 1
  fi
else
  install -d -m 700 -o root -g root "$artifact_directory"
  install -m 600 -o root -g root "$artifact_path" "$artifact_directory/$artifact_file"
  install -m 600 -o root -g root "${incoming_directory}/ci-release-manifest.json" \
    "$artifact_directory/ci-release-manifest.json"
  install -m 600 -o root -g root "${incoming_directory}/SHA256SUMS" \
    "$artifact_directory/SHA256SUMS"
fi
install -d -m 700 -o root -g root "$artifact_directory/deployments"
install -m 600 -o root -g root "$uploaded_deployment_manifest" \
  "$artifact_directory/deployments/${deployment_run}.json"

extraction_directory="${incoming_directory}/extracted"
install -d -m 700 -o root -g root "$extraction_directory"
tar -xzf "$artifact_path" -C "$extraction_directory"
if [[ "$(sha256sum "${extraction_directory}/images.tar" | awk '{print $1}')" != "$image_archive_sha256" ]]; then
  echo '远程镜像归档 SHA-256 校验失败' >&2
  exit 1
fi

while IFS= read -r entry; do
  entry="${entry#./}"
  case "$entry" in
    /*|../*|*/../*|.git|.git/*|.deploy|.deploy/*|.env|.env.local|.env.production|.env.aws.production)
      echo '源码归档包含禁止路径' >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "${extraction_directory}/source.tar.gz")

install -d -m 700 -o root -g root "$release_directory"
tar -xzf "${extraction_directory}/source.tar.gz" -C "$release_directory"
if [[ ! -x "${release_directory}/scripts/install-aws-production-artifact.sh" ]]; then
  echo '发布源码缺少可执行生产安装器' >&2
  exit 1
fi
install -m 600 -o root -g root "$uploaded_deployment_manifest" \
  "$release_directory/release-manifest.json"
install -m 600 -o root -g root "${incoming_directory}/ci-release-manifest.json" \
  "$release_directory/ci-release-manifest.json"

DEPLOY_LOCK_HELD=1 \
RELEASE_DIRECTORY="$release_directory" \
PREVIOUS_RELEASE_DIRECTORY="$previous_release_directory" \
RELEASE_IMAGE_ARCHIVE="${extraction_directory}/images.tar" \
RELEASE_IMAGE_ARCHIVE_SHA256="$image_archive_sha256" \
RELEASE_ARTIFACT_SHA256="$artifact_sha256" \
RELEASE_COMMIT="$release_commit" \
RELEASE_TAG="$release_tag" \
RELEASE_DEPLOYMENT_RUN="$deployment_run" \
RELEASE_API_IMAGE="$api_reference" \
RELEASE_API_DIGEST="$api_digest" \
RELEASE_ADMIN_IMAGE="$admin_reference" \
RELEASE_ADMIN_DIGEST="$admin_digest" \
RELEASE_MIGRATION_IMAGE="$migration_reference" \
RELEASE_MIGRATION_DIGEST="$migration_digest" \
RELEASE_GATE_IMAGE="$gate_reference" \
RELEASE_GATE_DIGEST="$gate_digest" \
PRODUCTION_BASE_URL="$production_base_url" \
PRODUCTION_COMPOSE_PROJECT="$production_compose_project" \
  bash "${release_directory}/scripts/install-aws-production-artifact.sh"
REMOTE_DEPLOY

deployed_release="$(
  ssh "${ssh_options[@]}" "$ssh_target" \
    "sudo readlink -f '${SERVER_APP_DIR}/current'"
)"
if [[ "$deployed_release" != "$release_directory" ]]; then
  echo '生产 current 没有指向本次已验证发布' >&2
  exit 1
fi

echo "production_release=${release_tag}"
echo "production_commit=${release_commit}"
echo "deployment_run=${deployment_run}"
echo "artifact_sha256=${artifact_sha256}"
