#!/usr/bin/env bash
set -Eeuo pipefail

registry="${RELEASE_REPOSITORY%%/*}"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry" >/dev/null

build_and_push() {
  local service="$1" dockerfile="$2" target="$3"
  local reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${service}"
  local -a options=(--platform linux/amd64 --label "org.opencontainers.image.revision=$RELEASE_COMMIT")
  if [[ -n "$target" ]]; then options+=(--target "$target"); fi
  if [[ "$service" == admin ]]; then
    options+=(--build-arg AUTH_PROVIDER=local --build-arg VITE_API_BASE_URL=/api)
  fi
  docker build "${options[@]}" -f "$dockerfile" -t "$reference" .
  docker push "$reference"
  aws ecr describe-images --repository-name id-business-v2-release \
    --image-ids "imageTag=${RELEASE_COMMIT}-${service}" \
    --query 'imageDetails[0].imageDigest' --output text | grep -Eq '^sha256:[0-9a-f]{64}$'
  echo "Pushed verified image: $service"
}

build_and_push media-resolver apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile ''
build_and_push auto-recharge apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile ''
build_and_push api apps/api/Dockerfile.mysql runtime
build_and_push migrate apps/api/Dockerfile.mysql migration
build_and_push admin apps/admin/Dockerfile runtime
