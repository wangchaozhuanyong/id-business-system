#!/usr/bin/env bash
set -Eeuo pipefail

build_image() {
  local service="$1" dockerfile="$2" target="$3"
  local reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${service}"
  local -a options=(--platform linux/amd64 --label "org.opencontainers.image.revision=$RELEASE_COMMIT")
  if [[ -n "$target" ]]; then options+=(--target "$target"); fi
  if [[ "$service" == admin ]]; then
    options+=(--build-arg AUTH_PROVIDER=local --build-arg VITE_API_BASE_URL=/api)
  fi
  docker build "${options[@]}" -f "$dockerfile" -t "$reference" .
  echo "Built image: $service"
}

build_image media-resolver apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile ''
build_image auto-recharge apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile ''
build_image api apps/api/Dockerfile.mysql runtime
build_image migrate apps/api/Dockerfile.mysql migration
build_image admin apps/admin/Dockerfile runtime
