#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if (($# != 8)); then
  echo 'Usage: pull-production-release-images.sh <aws-region> <ecr-registry> <api> <admin> <migration> <media-resolver> <recharge> <gate>' >&2
  exit 1
fi

aws_region="$1"
ecr_registry="$2"
shift 2
image_references=("$@")

if [[ ! "$aws_region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] ||
   [[ ! "$ecr_registry" =~ ^[0-9]{12}\.dkr\.ecr\.${aws_region}\.amazonaws\.com(\.cn)?$ ]]; then
  echo 'ECR 区域或 registry 无效' >&2
  exit 1
fi
for reference in "${image_references[@]}"; do
  if [[ ! "$reference" =~ ^${ecr_registry}/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$ ]]; then
    echo "ECR 镜像不是受控 digest 引用：${reference}" >&2
    exit 1
  fi
done
for command in aws docker mktemp rm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ECR 镜像拉取依赖命令不存在：${command}" >&2
    exit 1
  fi
done

docker_config="$(mktemp -d "${TMPDIR:-/tmp}/idv2-ecr-login.XXXXXX")"
case "$docker_config" in
  */idv2-ecr-login.*) ;;
  *) echo '无法创建隔离 Docker 登录目录' >&2; exit 1 ;;
esac
cleanup() {
  case "$docker_config" in
    */idv2-ecr-login.*) rm -rf -- "$docker_config" ;;
  esac
}
trap cleanup EXIT INT TERM
export DOCKER_CONFIG="$docker_config"

aws ecr get-login-password --region "$aws_region" |
  docker login --username AWS --password-stdin "$ecr_registry" >/dev/null

for reference in "${image_references[@]}"; do
  docker pull --platform linux/amd64 "$reference" >/dev/null
  platform="$(docker image inspect "$reference" --format '{{.Os}}/{{.Architecture}}')"
  repo_digests="$(docker image inspect "$reference" --format '{{json .RepoDigests}}')"
  if [[ "$platform" != linux/amd64 || "$repo_digests" != *"\"${reference}\""* ]]; then
    echo "ECR 镜像拉取结果与清单不一致：${reference}" >&2
    exit 1
  fi
done

echo "pulled_ecr_images=${#image_references[@]}"
