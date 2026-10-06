#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/validate-release-selection.sh"

build_image() {
  local service="$1" dockerfile="$2" target="$3" context="${4:-.}"
  local reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${service}"
  local -a options=(--platform linux/amd64 --label "org.opencontainers.image.revision=$RELEASE_COMMIT")
  if [[ -n "$target" ]]; then options+=(--target "$target"); fi
  if [[ "$service" == admin ]]; then
    options+=(--build-arg AUTH_PROVIDER=local --build-arg VITE_API_BASE_URL=/api)
    if [[ "${HISTORICAL_EXCEPTION:-none}" == historical-finance-20261005-order-archive ]]; then
      options+=(--build-arg "V2_BUILD_ID=$archive_build_id")
    fi
  fi
  docker build "${options[@]}" -f "$dockerfile" -t "$reference" "$context"
  echo "Built image: $service"
}

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-b8-80-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-b8-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-7f-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-main80-20261006 ]]; then
  case "$HISTORICAL_EXCEPTION" in
    recharge-pro-menu-b8-20261005) test "$EXPECTED_CURRENT" = b8d643450ffa9012ccc09ead15e4681e3dee98d0 ;;
    recharge-pro-menu-7f-20261005) test "$EXPECTED_CURRENT" = 7f70688b9bf53a071a0a324ca558aeabc4ced2e3 ;;
    recharge-pro-main80-20261006) test "$EXPECTED_CURRENT" = 80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b ;;
    *) exit 1 ;;
  esac
  test -z "${REUSE_IMAGE_COMMIT:-}"
  test -z "${REUSE_IMAGE_RUN_ID:-}"
  test -z "${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile ''
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == historical-finance-20261005-post-cleanup ]]; then
  [[ "${RELEASE_OPERATION:-release}" == prepare_post_cleanup_release ]] || exit 1
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image api apps/api/Dockerfile.mysql runtime
  build_image migrate apps/api/Dockerfile.mysql migration
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == historical-finance-20261005-order-archive ]]; then
  [[ "${RELEASE_OPERATION:-release}" == prepare_order_archive_release ]] || exit 1
  archive_build_id="$(node --input-type=module - <<'JS'
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { ORDER_ARCHIVE_POLICY_FILE, verifyOrderArchiveSourceBindings } from './scripts/lib/v2-order-archive-release-policy.mjs';
const policy = JSON.parse(readFileSync(ORDER_ARCHIVE_POLICY_FILE, 'utf8'));
if (policy.id !== 'historical-finance-20261005-order-archive'
    || policy.scope !== 'API_ADMIN_ORDER_ARCHIVE' || policy.userApproved !== false
    || !/^[a-f0-9]{40}$/.test(policy.candidateBindings?.sourceTree ?? '')) {
  throw new Error('Order archive deterministic Admin source binding missing');
}
const entries = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((record) => record.slice(record.indexOf('\t') + 1) !== ORDER_ARCHIVE_POLICY_FILE)
  .map((record) => {
    const separator = record.indexOf('\t');
    const [mode, kind] = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    const metadata = lstatSync(path);
    if (kind !== 'blob' || !['100644', '100755'].includes(mode) || !metadata.isFile()
        || (metadata.mode & 0o111 ? '100755' : '100644') !== mode) {
      throw new Error('Order archive deterministic Admin source file changed');
    }
    return { path, mode, bytes: readFileSync(path) };
  });
const verified = verifyOrderArchiveSourceBindings(policy, entries);
process.stdout.write(`v2-${verified.sourceTree}`);
JS
)"
  [[ "$archive_build_id" =~ ^v2-[a-f0-9]{40}$ ]] || exit 1
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image api apps/api/Dockerfile.mysql runtime
  build_image migrate apps/api/Dockerfile.mysql migration
  build_image admin apps/admin/Dockerfile runtime
  exit 0
fi

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
