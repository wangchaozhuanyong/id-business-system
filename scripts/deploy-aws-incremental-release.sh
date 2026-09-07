#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connection_file="${AWS_PRODUCTION_CONNECTION_FILE:-${project_root}/.deploy/aws-production.local.env}"
release_tag="${1:-${RELEASE_TAG:-}}"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "$release_tag" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]] ||
  fail 'Usage: scripts/deploy-aws-incremental-release.sh <v2-production-YYYYMMDDTHHMMSSZ>'
[[ -f "$connection_file" ]] || fail '缺少本机 AWS 生产连接文件'
connection_mode="$(stat -f '%Lp' "$connection_file" 2>/dev/null || stat -c '%a' "$connection_file")"
[[ "$connection_mode" == 600 ]] || fail '本机 AWS 生产连接文件必须为 0600'

set -a
# shellcheck disable=SC1090
source "$connection_file"
set +a
for name in \
  SERVER_SSH_HOST \
  SERVER_SSH_USER \
  SERVER_SSH_PORT \
  SERVER_SSH_KEY \
  SERVER_APP_DIR \
  PRODUCTION_BASE_URL \
  PRODUCTION_COMPOSE_PROJECT; do
  [[ -n "${!name:-}" ]] || fail "缺少本机 AWS 生产连接参数：${name}"
done
[[ "$SERVER_APP_DIR" == /opt/id-business-v2 ]] || fail '生产目录与仓库强制边界不一致'
[[ -f "$SERVER_SSH_KEY" ]] || fail '生产 SSH 私钥不存在'
key_mode="$(stat -f '%Lp' "$SERVER_SSH_KEY" 2>/dev/null || stat -c '%a' "$SERVER_SSH_KEY")"
[[ "$key_mode" == 400 || "$key_mode" == 600 ]] || fail '生产 SSH 私钥权限必须为 0400 或 0600'
for command in gh git node scp sha256sum ssh; do
  command -v "$command" >/dev/null 2>&1 || fail "增量部署依赖命令不存在：${command}"
done

cd "$project_root"
[[ -z "$(git status --porcelain)" ]] || fail '生产部署前工作区必须完全干净'
[[ "$(git branch --show-current)" == main ]] || fail '生产部署必须在本地 main 分支执行'
git fetch origin main --tags --prune
release_commit="$(git rev-parse "${release_tag}^{commit}")"
[[ "$(git cat-file -t "$release_tag")" == tag ]] || fail '生产标签必须是带说明的正式标签'
[[ "$(git rev-parse HEAD)" == "$release_commit" ]] || fail '本地 HEAD 与生产标签 SHA 不一致'
[[ "$(git rev-parse origin/main)" == "$release_commit" ]] || fail '生产标签不是当前 origin/main'

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
current_reader="${project_root}/scripts/read-current-production-release.sh"
current_json="$(
  ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- "$SERVER_APP_DIR" --json \
    <"$current_reader"
)" || fail '读取当前生产发布清单失败'
current_record="$(CURRENT_RELEASE_JSON="$current_json" node --input-type=module <<'NODE'
const value = JSON.parse(process.env.CURRENT_RELEASE_JSON);
process.stdout.write([value.directory, value.commit, value.releaseTag].join('\t'));
NODE
)"
IFS=$'\t' read -r previous_release_directory previous_commit current_release_tag \
  <<<"$current_record"

if [[ "$previous_commit" == "$release_commit" ]]; then
  echo '生产已运行该准确 SHA；只执行语义健康确认'
  BASE_URL="$PRODUCTION_BASE_URL" bash scripts/deploy-smoke.sh
  echo "production_release=${current_release_tag}"
  echo "production_commit=${release_commit}"
  echo 'deployment_status=already_deployed'
  exit 0
fi

run_record="$(
  gh run list \
    --workflow production-release.yml \
    --commit "$release_commit" \
    --event workflow_dispatch \
    --status success \
    --limit 30 \
    --json databaseId,headBranch,headSha,url \
    --jq ".[] | select(.headBranch == \"${release_tag}\" and .headSha == \"${release_commit}\") | [.databaseId, .url] | @tsv" |
    head -n 1
)"
[[ -n "$run_record" ]] || fail '未找到该准确版本的成功 Production Release Artifact 运行'
IFS=$'\t' read -r ci_run_id ci_run_url <<<"$run_record"
control_artifact_name="id-business-v2-${release_tag}-${release_commit}-control"
artifact_record="$(
  gh api "repos/{owner}/{repo}/actions/runs/${ci_run_id}/artifacts" \
    --jq ".artifacts[] | select(.name == \"${control_artifact_name}\" and .expired == false) | [.id, .name, .digest] | @tsv" |
    head -n 1
)"
[[ -n "$artifact_record" ]] || fail '成功制品运行中缺少控制制品'
IFS=$'\t' read -r github_artifact_id github_artifact_name github_artifact_digest \
  <<<"$artifact_record"
[[ "$github_artifact_digest" =~ ^sha256:[a-f0-9]{64}$ ]] ||
  fail 'GitHub 控制制品缺少可校验 digest'

working_directory="$(mktemp -d "${TMPDIR:-/tmp}/idv2-incremental-deploy.XXXXXX")"
case "$working_directory" in */idv2-incremental-deploy.*) ;; *) fail '无法创建安全临时目录' ;; esac
cleanup() {
  case "$working_directory" in
    */idv2-incremental-deploy.*) rm -rf -- "$working_directory" ;;
  esac
}
trap cleanup EXIT INT TERM

download_directory="${working_directory}/control"
mkdir -p "$download_directory"
gh run download "$ci_run_id" --name "$control_artifact_name" --dir "$download_directory"
node scripts/verify-production-release-artifact.mjs \
  --directory "$download_directory" \
  --expected-commit "$release_commit" \
  --expected-tag "$release_tag" \
  --metadata-only true
manifest_path="${download_directory}/release-manifest.json"

manifest_record="$(node --input-type=module - "$manifest_path" "$previous_commit" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(manifest.schemaVersion, 2, '固定入口只部署 schema v2 增量制品');
assert.equal(manifest.previousCommit, process.argv[3], '制品基线已落后于当前生产版本');
process.stdout.write([
  manifest.artifact.file,
  manifest.artifact.sha256,
  manifest.artifact.sourceArchiveSha256,
  manifest.risk.backupPolicy,
  String(manifest.risk.migrationRequired),
  manifest.acceptanceScopes.join(','),
  manifest.changedImages.join(',')
].join('\t'));
NODE
)"
IFS=$'\t' read -r artifact_file artifact_sha256 source_archive_sha256 backup_policy \
  migration_required acceptance_scopes changed_images <<<"$manifest_record"
changed_images="${changed_images:-none}"
artifact_path="${download_directory}/${artifact_file}"

echo '执行生产磁盘与保留策略预检'
ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- --preflight \
  <"${project_root}/scripts/cleanup-aws-production-retention.sh"

release_stamp="${release_tag#v2-production-}"
short_commit="${release_commit:0:12}"
deployment_run="aws-$(date -u +%Y%m%dT%H%M%SZ)-${short_commit}"
release_directory="${SERVER_APP_DIR}/releases/${release_stamp}-${short_commit}"
artifact_directory="${SERVER_APP_DIR}/artifacts/${release_tag}-${release_commit}"
incoming_directory="${SERVER_APP_DIR}/incoming/${release_tag}-${short_commit}"
operator="$(git config user.name || true)"
operator="${operator:-${USER:-codex}}"
deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deployment_manifest_path="${working_directory}/deployment-${deployment_run}.json"

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

ssh "${ssh_options[@]}" "$ssh_target" bash -s -- \
  "$incoming_directory" "$artifact_directory" <<'REMOTE_PREPARE'
set -Eeuo pipefail
incoming_directory="$1"
artifact_directory="$2"
case "$incoming_directory" in /opt/id-business-v2/incoming/v2-production-*) ;; *) exit 1 ;; esac
case "$artifact_directory" in /opt/id-business-v2/artifacts/v2-production-*) ;; *) exit 1 ;; esac
remote_user="$(id -un)"
if [[ -L "$incoming_directory" ]] || sudo test -L "$artifact_directory"; then
  echo '生产暂存或制品目录不得为符号链接' >&2
  exit 1
fi
sudo install -d -m 700 -o "$remote_user" -g "$(id -gn)" "$incoming_directory"
sudo install -d -m 700 -o root -g root "$artifact_directory"
REMOTE_PREPARE

remote_payload_state() {
  local file_name="$1"
  local expected_sha256="$2"
  ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- \
    "$artifact_directory" "$incoming_directory" "$file_name" "$expected_sha256" <<'REMOTE_STATE'
set -Eeuo pipefail
artifact_directory="$1"
incoming_directory="$2"
file_name="$3"
expected_sha256="$4"
[[ "$file_name" == "${file_name##*/}" && "$expected_sha256" =~ ^[a-f0-9]{64}$ ]] || exit 2
artifact_path="${artifact_directory}/${file_name}"
incoming_path="${incoming_directory}/${file_name}"
if [[ -f "$artifact_path" ]]; then
  [[ ! -L "$artifact_path" ]] || { echo '不可变制品不得为符号链接' >&2; exit 3; }
  [[ "$(sha256sum "$artifact_path" | awk '{print $1}')" == "$expected_sha256" ]] || {
    echo '已缓存的不可变制品校验失败' >&2
    exit 3
  }
  echo artifact
elif [[ -f "$incoming_path" && ! -L "$incoming_path" && "$(sha256sum "$incoming_path" | awk '{print $1}')" == "$expected_sha256" ]]; then
  echo incoming
else
  rm -f -- "$incoming_path"
  echo missing
fi
REMOTE_STATE
}

stage_payload() {
  local local_path="$1"
  local file_name="$2"
  local expected_sha256="$3"
  local state
  if ! state="$(remote_payload_state "$file_name" "$expected_sha256")"; then
    fail "服务端已存在但不可复用的制品：${file_name}"
  fi
  if [[ "$state" == missing ]]; then
    scp "${scp_options[@]}" "$local_path" "${ssh_target}:${incoming_directory}/${file_name}"
    state="$(remote_payload_state "$file_name" "$expected_sha256")"
  fi
  [[ "$state" == incoming || "$state" == artifact ]] || fail "服务端制品暂存失败：${file_name}"
}

stage_payload "$artifact_path" "$artifact_file" "$artifact_sha256"
ci_manifest_sha256="$(sha256sum "$manifest_path" | awk '{print $1}')"
checksums_sha256="$(sha256sum "${download_directory}/SHA256SUMS" | awk '{print $1}')"
stage_payload "$manifest_path" 'ci-release-manifest.json' "$ci_manifest_sha256"
stage_payload "${download_directory}/SHA256SUMS" 'SHA256SUMS' "$checksums_sha256"

image_rows="${working_directory}/images.tsv"
node --input-type=module - "$manifest_path" >"$image_rows" <<'NODE'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [name, image] of Object.entries(manifest.images)) {
  process.stdout.write([
    name,
    image.reference,
    image.digest,
    image.archive.file,
    image.archive.sha256,
    String(image.sizeBytes),
    String(image.archive.ciWorkflowRunId),
    image.archive.githubArtifactName
  ].join('\t') + '\n');
}
NODE

while IFS=$'\t' read -r image_name image_reference image_digest image_archive_file \
  image_archive_sha256 image_size_bytes image_ci_run_id image_artifact_name; do
  case "$image_name" in
    api) shell_name=API ;;
    admin) shell_name=ADMIN ;;
    migration) shell_name=MIGRATION ;;
    mediaResolver) shell_name=MEDIA_RESOLVER ;;
    recharge) shell_name=RECHARGE ;;
    gate) shell_name=GATE ;;
    *) fail "未知发布镜像：${image_name}" ;;
  esac
  actual_digest="$(
    ssh "${ssh_options[@]}" "$ssh_target" sudo docker image inspect "$image_reference" \
      --format '{{.Id}}' 2>/dev/null || true
  )"
  archive_remote_path='-'
  if [[ "$actual_digest" != "$image_digest" ]]; then
    archive_remote_path="${artifact_directory}/${image_archive_file}"
    if ! image_state="$(remote_payload_state "$image_archive_file" "$image_archive_sha256")"; then
      fail "服务端镜像归档校验失败：${image_archive_file}"
    fi
    if [[ "$image_state" == missing ]]; then
      image_download_directory="${working_directory}/image-${image_name}"
      mkdir -p "$image_download_directory"
      echo "仅下载缺失镜像制品：${image_name}"
      gh run download "$image_ci_run_id" --name "$image_artifact_name" --dir "$image_download_directory"
      image_local_path="${image_download_directory}/${image_archive_file}"
      [[ -f "$image_local_path" ]] || fail "镜像制品缺少预期归档：${image_archive_file}"
      [[ "$(sha256sum "$image_local_path" | awk '{print $1}')" == "$image_archive_sha256" ]] ||
        fail "下载的镜像制品校验失败：${image_archive_file}"
      stage_payload "$image_local_path" "$image_archive_file" "$image_archive_sha256"
    else
      echo "复用服务端镜像归档：${image_name}"
    fi
  else
    echo "复用服务端已验证镜像：${image_name}"
  fi
  printf -v "RELEASE_${shell_name}_IMAGE" '%s' "$image_reference"
  printf -v "RELEASE_${shell_name}_DIGEST" '%s' "$image_digest"
  printf -v "RELEASE_${shell_name}_ARCHIVE" '%s' "$archive_remote_path"
  printf -v "RELEASE_${shell_name}_ARCHIVE_SHA256" '%s' "$image_archive_sha256"
  printf -v "RELEASE_${shell_name}_SIZE_BYTES" '%s' "$image_size_bytes"
done <"$image_rows"

release_input_path="${working_directory}/release-input-${deployment_run}.env"
{
  for name in \
    RELEASE_API_IMAGE RELEASE_API_DIGEST RELEASE_API_ARCHIVE RELEASE_API_ARCHIVE_SHA256 RELEASE_API_SIZE_BYTES \
    RELEASE_ADMIN_IMAGE RELEASE_ADMIN_DIGEST RELEASE_ADMIN_ARCHIVE RELEASE_ADMIN_ARCHIVE_SHA256 RELEASE_ADMIN_SIZE_BYTES \
    RELEASE_MIGRATION_IMAGE RELEASE_MIGRATION_DIGEST RELEASE_MIGRATION_ARCHIVE RELEASE_MIGRATION_ARCHIVE_SHA256 RELEASE_MIGRATION_SIZE_BYTES \
    RELEASE_MEDIA_RESOLVER_IMAGE RELEASE_MEDIA_RESOLVER_DIGEST RELEASE_MEDIA_RESOLVER_ARCHIVE RELEASE_MEDIA_RESOLVER_ARCHIVE_SHA256 RELEASE_MEDIA_RESOLVER_SIZE_BYTES \
    RELEASE_RECHARGE_IMAGE RELEASE_RECHARGE_DIGEST RELEASE_RECHARGE_ARCHIVE RELEASE_RECHARGE_ARCHIVE_SHA256 RELEASE_RECHARGE_SIZE_BYTES \
    RELEASE_GATE_IMAGE RELEASE_GATE_DIGEST RELEASE_GATE_ARCHIVE RELEASE_GATE_ARCHIVE_SHA256 RELEASE_GATE_SIZE_BYTES; do
    printf '%s=%q\n' "$name" "${!name}"
  done
  printf 'RELEASE_MANIFEST_SCHEMA=2\n'
  printf 'RELEASE_ARTIFACT_ARCHIVE=%q\n' "${artifact_directory}/${artifact_file}"
  printf 'RELEASE_IMAGE_ARCHIVE_SHA256=-\n'
  printf 'RELEASE_ARTIFACT_SHA256=%q\n' "$artifact_sha256"
  printf 'RELEASE_SOURCE_ARCHIVE_SHA256=%q\n' "$source_archive_sha256"
  printf 'RELEASE_CI_MANIFEST_SHA256=%q\n' "$ci_manifest_sha256"
  printf 'RELEASE_CHECKSUMS_SHA256=%q\n' "$checksums_sha256"
  printf 'RELEASE_COMMIT=%q\n' "$release_commit"
  printf 'RELEASE_TAG=%q\n' "$release_tag"
  printf 'RELEASE_DEPLOYMENT_RUN=%q\n' "$deployment_run"
  printf 'RELEASE_BACKUP_POLICY=%q\n' "$backup_policy"
  printf 'RELEASE_MIGRATION_REQUIRED=%q\n' "$migration_required"
  printf 'RELEASE_ACCEPTANCE_SCOPES=%q\n' "$acceptance_scopes"
  printf 'RELEASE_CHANGED_IMAGES=%q\n' "$changed_images"
  printf 'PRODUCTION_BASE_URL=%q\n' "$PRODUCTION_BASE_URL"
  printf 'PRODUCTION_COMPOSE_PROJECT=%q\n' "$PRODUCTION_COMPOSE_PROJECT"
} >"$release_input_path"
release_input_sha256="$(sha256sum "$release_input_path" | awk '{print $1}')"
deployment_manifest_sha256="$(sha256sum "$deployment_manifest_path" | awk '{print $1}')"
scp "${scp_options[@]}" \
  "$release_input_path" \
  "$deployment_manifest_path" \
  "${ssh_target}:${incoming_directory}/"

echo "开始增量部署准确版本：${release_tag} ${release_commit}"
ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- \
  "$incoming_directory" \
  "$artifact_directory" \
  "$release_directory" \
  "$previous_release_directory" \
  "$(basename "$release_input_path")" \
  "$release_input_sha256" \
  "$(basename "$deployment_manifest_path")" \
  "$deployment_manifest_sha256" <<'REMOTE_DEPLOY'
set -Eeuo pipefail
umask 077
incoming_directory="$1"
artifact_directory="$2"
release_directory="$3"
previous_release_directory="$4"
release_input_file="$5"
release_input_sha256="$6"
deployment_manifest_file="$7"
deployment_manifest_sha256="$8"
deployment_root='/opt/id-business-v2'

case "$incoming_directory" in "${deployment_root}/incoming/v2-production-"*) ;; *) exit 1 ;; esac
case "$artifact_directory" in "${deployment_root}/artifacts/v2-production-"*) ;; *) exit 1 ;; esac
case "$release_directory" in "${deployment_root}/releases/"*) ;; *) exit 1 ;; esac
case "$previous_release_directory" in "${deployment_root}/releases/"*) ;; *) exit 1 ;; esac
[[ "$release_input_file" == "${release_input_file##*/}" ]] || exit 1
[[ "$deployment_manifest_file" == "${deployment_manifest_file##*/}" ]] || exit 1

exec 9>"${deployment_root}/.deploy.lock"
flock -n 9 || { echo '另一个生产发布正在进行' >&2; exit 1; }
[[ "$(sha256sum "${incoming_directory}/${release_input_file}" | awk '{print $1}')" == "$release_input_sha256" ]] || {
  echo '发布输入校验失败' >&2; exit 1;
}
[[ "$(sha256sum "${incoming_directory}/${deployment_manifest_file}" | awk '{print $1}')" == "$deployment_manifest_sha256" ]] || {
  echo '部署清单校验失败' >&2; exit 1;
}
# shellcheck disable=SC1090
source "${incoming_directory}/${release_input_file}"

promote_payload() {
  local file_name="$1"
  local expected_sha256="$2"
  local incoming_path="${incoming_directory}/${file_name}"
  local artifact_path="${artifact_directory}/${file_name}"
  if [[ -f "$artifact_path" ]]; then
    [[ "$(sha256sum "$artifact_path" | awk '{print $1}')" == "$expected_sha256" ]] || return 1
    rm -f -- "$incoming_path"
    return 0
  fi
  [[ -f "$incoming_path" ]] || return 1
  [[ "$(sha256sum "$incoming_path" | awk '{print $1}')" == "$expected_sha256" ]] || return 1
  chown root:root "$incoming_path"
  chmod 600 "$incoming_path"
  mv -- "$incoming_path" "$artifact_path"
}

artifact_file="${RELEASE_ARTIFACT_ARCHIVE##*/}"
promote_payload "$artifact_file" "$RELEASE_ARTIFACT_SHA256"
promote_payload 'ci-release-manifest.json' "$RELEASE_CI_MANIFEST_SHA256"
promote_payload 'SHA256SUMS' "$RELEASE_CHECKSUMS_SHA256"

for archive_path in \
  "$RELEASE_API_ARCHIVE" "$RELEASE_ADMIN_ARCHIVE" "$RELEASE_MIGRATION_ARCHIVE" \
  "$RELEASE_MEDIA_RESOLVER_ARCHIVE" "$RELEASE_RECHARGE_ARCHIVE" "$RELEASE_GATE_ARCHIVE"; do
  [[ "$archive_path" != '-' ]] || continue
  archive_file="${archive_path##*/}"
  case "$archive_file" in image-*-"${RELEASE_COMMIT}".tar.gz) ;; image-*.tar.gz) ;; *) exit 1 ;; esac
  expected_name="RELEASE_API_ARCHIVE_SHA256"
  for prefix in API ADMIN MIGRATION MEDIA_RESOLVER RECHARGE GATE; do
    value_name="RELEASE_${prefix}_ARCHIVE"
    if [[ "${!value_name}" == "$archive_path" ]]; then expected_name="RELEASE_${prefix}_ARCHIVE_SHA256"; break; fi
  done
  promote_payload "$archive_file" "${!expected_name}"
done

artifact_path="${artifact_directory}/${artifact_file}"
[[ "$(tar -tzf "$artifact_path" | sed 's#^\./##' | sort | tr '\n' ' ')" == 'source.tar.gz ' ]] || {
  echo '控制制品内容无效' >&2; exit 1;
}
extraction_directory="${incoming_directory}/extracted"
rm -rf -- "$extraction_directory"
install -d -m 700 -o root -g root "$extraction_directory"
tar -xzf "$artifact_path" -C "$extraction_directory" source.tar.gz
[[ "$(sha256sum "${extraction_directory}/source.tar.gz" | awk '{print $1}')" == "$RELEASE_SOURCE_ARCHIVE_SHA256" ]] || {
  echo '源码归档校验失败' >&2; exit 1;
}
while IFS= read -r entry; do
  entry="${entry#./}"
  case "$entry" in
    /*|../*|*/../*|.git|.git/*|.deploy|.deploy/*|.env|.env.local|.env.production|.env.aws.production)
      echo '源码归档包含禁止路径' >&2; exit 1 ;;
  esac
done < <(tar -tzf "${extraction_directory}/source.tar.gz")

if [[ -e "$release_directory" || -L "$release_directory" ]]; then
  [[ -d "$release_directory" && ! -L "$release_directory" ]] || {
    echo '同名候选发布路径不是受控目录' >&2; exit 1;
  }
  existing_commit="$(sed -nE 's/^[[:space:]]*"commit":[[:space:]]*"([a-f0-9]{40})"[,]?.*$/\1/p' "${release_directory}/ci-release-manifest.json" | head -n 1)"
  existing_tag="$(sed -nE 's/^[[:space:]]*"releaseTag":[[:space:]]*"([^" ]+)"[,]?.*$/\1/p' "${release_directory}/ci-release-manifest.json" | head -n 1)"
  [[ "$existing_commit" == "$RELEASE_COMMIT" && "$existing_tag" == "$RELEASE_TAG" ]] || {
    echo '同名候选发布目录属于其他版本' >&2; exit 1;
  }
  echo '复用同一版本的服务端候选发布目录'
else
  staging_release_directory="${release_directory}.staging"
  case "$staging_release_directory" in "${deployment_root}/releases/"*.staging) ;; *) exit 1 ;; esac
  rm -rf -- "$staging_release_directory"
  install -d -m 700 -o root -g root "$staging_release_directory"
  tar -xzf "${extraction_directory}/source.tar.gz" -C "$staging_release_directory"
  install -m 600 -o root -g root "${artifact_directory}/ci-release-manifest.json" \
    "${staging_release_directory}/ci-release-manifest.json"
  mv -- "$staging_release_directory" "$release_directory"
fi
[[ -x "${release_directory}/scripts/install-aws-production-artifact.sh" ]] || {
  echo '候选源码缺少生产安装器' >&2; exit 1;
}
install -d -m 700 -o root -g root "${artifact_directory}/deployments"
install -m 600 -o root -g root "${incoming_directory}/${deployment_manifest_file}" \
  "${artifact_directory}/deployments/${RELEASE_DEPLOYMENT_RUN}.json"
install -m 600 -o root -g root "${incoming_directory}/${deployment_manifest_file}" \
  "${release_directory}/release-manifest.json"

DEPLOY_LOCK_HELD=1 \
RELEASE_DIRECTORY="$release_directory" \
PREVIOUS_RELEASE_DIRECTORY="$previous_release_directory" \
RELEASE_MANIFEST_SCHEMA="$RELEASE_MANIFEST_SCHEMA" \
RELEASE_ARTIFACT_ARCHIVE="$RELEASE_ARTIFACT_ARCHIVE" \
RELEASE_IMAGE_ARCHIVE_SHA256="$RELEASE_IMAGE_ARCHIVE_SHA256" \
RELEASE_ARTIFACT_SHA256="$RELEASE_ARTIFACT_SHA256" \
RELEASE_COMMIT="$RELEASE_COMMIT" \
RELEASE_TAG="$RELEASE_TAG" \
RELEASE_DEPLOYMENT_RUN="$RELEASE_DEPLOYMENT_RUN" \
RELEASE_API_IMAGE="$RELEASE_API_IMAGE" RELEASE_API_DIGEST="$RELEASE_API_DIGEST" \
RELEASE_API_ARCHIVE="$RELEASE_API_ARCHIVE" RELEASE_API_ARCHIVE_SHA256="$RELEASE_API_ARCHIVE_SHA256" RELEASE_API_SIZE_BYTES="$RELEASE_API_SIZE_BYTES" \
RELEASE_ADMIN_IMAGE="$RELEASE_ADMIN_IMAGE" RELEASE_ADMIN_DIGEST="$RELEASE_ADMIN_DIGEST" \
RELEASE_ADMIN_ARCHIVE="$RELEASE_ADMIN_ARCHIVE" RELEASE_ADMIN_ARCHIVE_SHA256="$RELEASE_ADMIN_ARCHIVE_SHA256" RELEASE_ADMIN_SIZE_BYTES="$RELEASE_ADMIN_SIZE_BYTES" \
RELEASE_MIGRATION_IMAGE="$RELEASE_MIGRATION_IMAGE" RELEASE_MIGRATION_DIGEST="$RELEASE_MIGRATION_DIGEST" \
RELEASE_MIGRATION_ARCHIVE="$RELEASE_MIGRATION_ARCHIVE" RELEASE_MIGRATION_ARCHIVE_SHA256="$RELEASE_MIGRATION_ARCHIVE_SHA256" RELEASE_MIGRATION_SIZE_BYTES="$RELEASE_MIGRATION_SIZE_BYTES" \
RELEASE_MEDIA_RESOLVER_IMAGE="$RELEASE_MEDIA_RESOLVER_IMAGE" RELEASE_MEDIA_RESOLVER_DIGEST="$RELEASE_MEDIA_RESOLVER_DIGEST" \
RELEASE_MEDIA_RESOLVER_ARCHIVE="$RELEASE_MEDIA_RESOLVER_ARCHIVE" RELEASE_MEDIA_RESOLVER_ARCHIVE_SHA256="$RELEASE_MEDIA_RESOLVER_ARCHIVE_SHA256" RELEASE_MEDIA_RESOLVER_SIZE_BYTES="$RELEASE_MEDIA_RESOLVER_SIZE_BYTES" \
RELEASE_RECHARGE_IMAGE="$RELEASE_RECHARGE_IMAGE" RELEASE_RECHARGE_DIGEST="$RELEASE_RECHARGE_DIGEST" \
RELEASE_RECHARGE_ARCHIVE="$RELEASE_RECHARGE_ARCHIVE" RELEASE_RECHARGE_ARCHIVE_SHA256="$RELEASE_RECHARGE_ARCHIVE_SHA256" RELEASE_RECHARGE_SIZE_BYTES="$RELEASE_RECHARGE_SIZE_BYTES" \
RELEASE_GATE_IMAGE="$RELEASE_GATE_IMAGE" RELEASE_GATE_DIGEST="$RELEASE_GATE_DIGEST" \
RELEASE_GATE_ARCHIVE="$RELEASE_GATE_ARCHIVE" RELEASE_GATE_ARCHIVE_SHA256="$RELEASE_GATE_ARCHIVE_SHA256" RELEASE_GATE_SIZE_BYTES="$RELEASE_GATE_SIZE_BYTES" \
RELEASE_BACKUP_POLICY="$RELEASE_BACKUP_POLICY" \
RELEASE_MIGRATION_REQUIRED="$RELEASE_MIGRATION_REQUIRED" \
RELEASE_ACCEPTANCE_SCOPES="$RELEASE_ACCEPTANCE_SCOPES" \
RELEASE_CHANGED_IMAGES="$RELEASE_CHANGED_IMAGES" \
PRODUCTION_BASE_URL="$PRODUCTION_BASE_URL" \
PRODUCTION_COMPOSE_PROJECT="$PRODUCTION_COMPOSE_PROJECT" \
  bash "${release_directory}/scripts/install-aws-production-artifact.sh"

rm -rf -- "$incoming_directory"
REMOTE_DEPLOY

deployed_release="$(
  ssh "${ssh_options[@]}" "$ssh_target" sudo readlink -f "${SERVER_APP_DIR}/current"
)"
[[ "$deployed_release" == "$release_directory" ]] || fail '生产 current 未指向本次已验证版本'
echo "production_release=${release_tag}"
echo "production_commit=${release_commit}"
echo "deployment_run=${deployment_run}"
echo "deployment_status=deployed"
