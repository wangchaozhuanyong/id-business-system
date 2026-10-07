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
    if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-90-20261007 ]]; then
      [[ "${registration_admin_projection:-}" =~ ^[a-f0-9]{64}$ ]] || exit 1
      options+=(--label "id-business-v2.admin-projection-sha256=$registration_admin_projection")
      options+=(--build-arg "V2_BUILD_ID=v2-$RELEASE_COMMIT")
    fi
    if [[ "${HISTORICAL_EXCEPTION:-none}" == historical-finance-20261005-order-archive ]]; then
      options+=(--build-arg "V2_BUILD_ID=$archive_build_id")
    fi
  fi
  docker build "${options[@]}" -f "$dockerfile" -t "$reference" "$context"
  echo "Built image: $service"
}

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-90-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = c3cad767b372738b2193e60584b0a53daa53b65f
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-90-20261007
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-90-20261007
  registration_context=.deploy/production-release/registration-build-context
  registration_admin_context=.deploy/production-release/registration-admin-build-context
  registration_admin_projection="$(read_registration_admin_projection)"
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  build_image admin "$registration_admin_context/apps/admin/Dockerfile" runtime "$registration_admin_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-91-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-91-20261007
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-91-20261007
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi


if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-89-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = d2e22e623d0e19851c79ffe43396f5f97a99b8d3
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-89-20261006
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-89-20261006
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-88-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 4c200c4ae08bb8214ff8e0955f8237ce85069cc6
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-88-20261006
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-88-20261006
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-87-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 651f62902fba74ddd189b34932084573b39d245c
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-87-20261006
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-87-20261006
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-86-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = fd3a6da610c505c2b7a51601cf854182991ffd12
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-86-20261006
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-86-20261006
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-85-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 85e94572cd965dd993743d12d55a3e91d60b6444
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-85-20261006
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-85-20261006
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-956-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 9560d8038a39d4ded1e560d484bdcb941a5d9c43
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-956-20261006
  python3 scripts/production-release/remote-deploy.py --prepare-fixed-registration-build --registration-profile registration-worker-956-20261006
  registration_context=.deploy/production-release/registration-build-context
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  build_image auto-recharge "$registration_context/apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile" '' "$registration_context"
  exit 0
fi

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

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-974-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 974c62cc1681012ecff897aefc90d2cd9900004a
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
  echo 'RELEASE_ADMIN_ONLY=false' >> "$GITHUB_ENV"
  # Build directly from the reviewed latest source, including its carried
  # registration helpers; this branch selects only the recharge service image.
  build_image auto-recharge apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile ''
  exit 0
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-b8-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-7f-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-main80-20261006 ]]; then
  case "$HISTORICAL_EXCEPTION" in
    recharge-pro-menu-b8-20261005) test "$EXPECTED_CURRENT" = b8d643450ffa9012ccc09ead15e4681e3dee98d0 ;;
    recharge-pro-menu-7f-20261005) test "$EXPECTED_CURRENT" = 7f70688b9bf53a071a0a324ca558aeabc4ced2e3 ;;
    recharge-pro-main80-20261006) test "$EXPECTED_CURRENT" = b91b626a71ed2c7c2473d080551b3b10b693b0cb ;;
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
