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

admin_only="$(node --input-type=module - <<'JS'
import { execFileSync } from 'node:child_process';
import { isAdminOnly } from './scripts/ci-recharge-scope.mjs';
const changed = execFileSync('git', ['diff', '--name-only', process.env.EXPECTED_CURRENT, process.env.RELEASE_COMMIT], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
console.log(isAdminOnly(changed));
JS
)"
case "$admin_only" in true|false) ;; *) exit 1 ;; esac
echo "RELEASE_ADMIN_ONLY=$admin_only" >> "$GITHUB_ENV"
if [[ "$admin_only" != true ]]; then
  build_image media-resolver apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile ''
  build_image auto-recharge apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile ''
  build_image api apps/api/Dockerfile.mysql runtime
  build_image migrate apps/api/Dockerfile.mysql migration
fi
build_image admin apps/admin/Dockerfile runtime
