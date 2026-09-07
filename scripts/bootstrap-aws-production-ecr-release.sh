#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if (($# != 4)); then
  echo 'Usage: bootstrap-aws-production-ecr-release.sh <bucket> <prefix> <inputs-sha256> <aws-region>' >&2
  exit 1
fi

release_bucket="$1"
release_prefix="$2"
inputs_sha256="$3"
aws_region="$4"
deployment_root='/opt/id-business-v2'

if [[ ! "$release_bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
   [[ ! "$release_prefix" =~ ^releases/v2-production-[0-9]{8}T[0-9]{6}Z/[a-f0-9]{40}/deployments/[A-Za-z0-9._-]{3,128}$ ]] ||
   [[ ! "$inputs_sha256" =~ ^[a-f0-9]{64}$ ]] ||
   [[ ! "$aws_region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]]; then
  echo '生产引导参数无效' >&2
  exit 1
fi
for command in aws flock install readlink sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "生产引导依赖命令不存在：${command}" >&2
    exit 1
  }
done

exec 9>"${deployment_root}/.deploy.lock"
if ! flock -n 9; then
  echo '另一个生产发布正在进行' >&2
  exit 1
fi

current_release="$(readlink -f "${deployment_root}/current")"
case "$current_release" in
  "${deployment_root}/releases/"*) ;;
  *) echo '当前生产发布目录无效' >&2; exit 1 ;;
esac
if [[ ! -x "${current_release}/scripts/cleanup-aws-production-retention.sh" ]]; then
  echo '当前发布缺少保留策略脚本' >&2
  exit 1
fi

echo '执行生产发布磁盘与保留策略预检'
DEPLOY_LOCK_HELD=1 bash "${current_release}/scripts/cleanup-aws-production-retention.sh" --preflight

incoming_directory="$(mktemp -d "${deployment_root}/incoming/ssm-release.XXXXXX")"
case "$incoming_directory" in
  "${deployment_root}/incoming/ssm-release."*) ;;
  *) echo '无法创建受控发布接收目录' >&2; exit 1 ;;
esac
cleanup() {
  case "$incoming_directory" in
    "${deployment_root}/incoming/ssm-release."*) rm -rf -- "$incoming_directory" ;;
  esac
}
trap cleanup EXIT INT TERM

s3_copy() {
  local name="$1"
  aws s3 cp --only-show-errors --region "$aws_region" \
    "s3://${release_bucket}/${release_prefix}/${name}" "${incoming_directory}/${name}"
}

s3_copy release-inputs.env
if [[ "$(sha256sum "${incoming_directory}/release-inputs.env" | awk '{print $1}')" != "$inputs_sha256" ]]; then
  echo '发布输入校验失败' >&2
  exit 1
fi
# release-inputs.env 只含经发布器严格校验并且由 SSM 参数锁定校验值的非敏感发布元数据。
# shellcheck disable=SC1091
source "${incoming_directory}/release-inputs.env"

required_variables=(
  RELEASE_DIRECTORY PREVIOUS_RELEASE_DIRECTORY RELEASE_SOURCE_ARCHIVE RELEASE_SOURCE_ARCHIVE_SHA256
  RELEASE_AWS_REGION RELEASE_ECR_REGISTRY RELEASE_COMMIT RELEASE_TAG RELEASE_DEPLOYMENT_RUN
  RELEASE_CI_MANIFEST_SHA256 RELEASE_DEPLOYMENT_MANIFEST_SHA256 RELEASE_CHECKSUMS_SHA256
  RELEASE_API_IMAGE RELEASE_API_DIGEST RELEASE_ADMIN_IMAGE RELEASE_ADMIN_DIGEST
  RELEASE_MIGRATION_IMAGE RELEASE_MIGRATION_DIGEST RELEASE_MEDIA_RESOLVER_IMAGE
  RELEASE_MEDIA_RESOLVER_DIGEST RELEASE_RECHARGE_IMAGE RELEASE_RECHARGE_DIGEST
  RELEASE_GATE_IMAGE RELEASE_GATE_DIGEST PRODUCTION_BASE_URL PRODUCTION_COMPOSE_PROJECT
)
for variable in "${required_variables[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    echo "发布输入缺少：${variable}" >&2
    exit 1
  fi
done
if [[ "$RELEASE_AWS_REGION" != "$aws_region" ]] ||
   [[ "$RELEASE_DIRECTORY" != "${deployment_root}/releases/"* ]] ||
   [[ "$PREVIOUS_RELEASE_DIRECTORY" != "$current_release" ]] ||
   [[ "$RELEASE_SOURCE_ARCHIVE" != "${deployment_root}/artifacts/${RELEASE_TAG}-${RELEASE_COMMIT}/id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}.tar.gz" ]]; then
  echo '发布输入与当前生产状态不一致' >&2
  exit 1
fi
if [[ -e "$RELEASE_DIRECTORY" ]]; then
  echo '目标不可变发布目录已存在' >&2
  exit 1
fi

artifact_file="$(basename "$RELEASE_SOURCE_ARCHIVE")"
for name in "$artifact_file" ci-release-manifest.json release-manifest.json SHA256SUMS; do
  s3_copy "$name"
done
verify_file() {
  local path="$1"
  local expected="$2"
  if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]] ||
     [[ "$(sha256sum "$path" | awk '{print $1}')" != "$expected" ]]; then
    echo "S3 发布文件校验失败：$(basename "$path")" >&2
    exit 1
  fi
}
verify_file "${incoming_directory}/${artifact_file}" "$RELEASE_SOURCE_ARCHIVE_SHA256"
verify_file "${incoming_directory}/ci-release-manifest.json" "$RELEASE_CI_MANIFEST_SHA256"
verify_file "${incoming_directory}/release-manifest.json" "$RELEASE_DEPLOYMENT_MANIFEST_SHA256"
verify_file "${incoming_directory}/SHA256SUMS" "$RELEASE_CHECKSUMS_SHA256"

while IFS= read -r entry; do
  entry="${entry#./}"
  case "$entry" in
    /*|../*|*/../*|.git|.git/*|.deploy|.deploy/*|.env|.env.local|.env.production|.env.aws.production)
      echo '源码归档包含禁止路径' >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "${incoming_directory}/${artifact_file}")

artifact_directory="$(dirname "$RELEASE_SOURCE_ARCHIVE")"
if [[ -e "$artifact_directory" ]]; then
  verify_file "$RELEASE_SOURCE_ARCHIVE" "$RELEASE_SOURCE_ARCHIVE_SHA256"
  verify_file "$artifact_directory/ci-release-manifest.json" "$RELEASE_CI_MANIFEST_SHA256"
  verify_file "$artifact_directory/SHA256SUMS" "$RELEASE_CHECKSUMS_SHA256"
else
  install -d -m 700 -o root -g root "$artifact_directory"
  install -m 600 -o root -g root "${incoming_directory}/${artifact_file}" "$RELEASE_SOURCE_ARCHIVE"
  install -m 600 -o root -g root "${incoming_directory}/ci-release-manifest.json" "$artifact_directory/ci-release-manifest.json"
  install -m 600 -o root -g root "${incoming_directory}/SHA256SUMS" "$artifact_directory/SHA256SUMS"
fi
install -d -m 700 -o root -g root "$artifact_directory/deployments" "$RELEASE_DIRECTORY"
install -m 600 -o root -g root "${incoming_directory}/release-manifest.json" \
  "$artifact_directory/deployments/${RELEASE_DEPLOYMENT_RUN}.json"
tar -xzf "$RELEASE_SOURCE_ARCHIVE" -C "$RELEASE_DIRECTORY"
install -m 600 -o root -g root "${incoming_directory}/release-manifest.json" "$RELEASE_DIRECTORY/release-manifest.json"
install -m 600 -o root -g root "${incoming_directory}/ci-release-manifest.json" "$RELEASE_DIRECTORY/ci-release-manifest.json"

if [[ ! -x "${RELEASE_DIRECTORY}/scripts/install-aws-production-artifact.sh" ]]; then
  echo '发布源码缺少可执行生产安装器' >&2
  exit 1
fi
export DEPLOY_LOCK_HELD=1
bash "${RELEASE_DIRECTORY}/scripts/install-aws-production-artifact.sh"

if [[ "$(readlink -f "${deployment_root}/current")" != "$RELEASE_DIRECTORY" ]]; then
  echo '生产 current 没有指向本次已验证发布' >&2
  exit 1
fi
echo "production_release=${RELEASE_TAG}"
echo "production_commit=${RELEASE_COMMIT}"
echo "deployment_run=${RELEASE_DEPLOYMENT_RUN}"
