#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/validate-release-selection.sh"
[[ "${RELEASE_OPERATION:-release}" != verify_api_admin_migration && "${RELEASE_OPERATION:-release}" != verify_api_workspace ]] || exit 1

if [[ "${RELEASE_OPERATION:-release}" == release_api_admin_migration ]]; then
  services=(api admin migrate)
elif [[ "${RELEASE_OPERATION:-release}" == release_api_admin || "${RELEASE_OPERATION:-release}" == release_api_workspace ]]; then
  services=(api admin)
elif [[ "${RELEASE_OPERATION:-release}" == release_api_registration ]]; then
  services=(api auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-92-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 974c62cc1681012ecff897aefc90d2cd9900004a
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-92-20261007
  services=(api auto-recharge)
  registration_api_projection="$(read_registration_recovery_projection api)"
  registration_api_compiled_projection="$(read_registration_recovery_projection api-compiled)"
  registration_worker_projection="$(read_registration_recovery_projection worker)"
  for registration_service in "${services[@]}"; do
    registration_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${registration_service}"
    test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
    if [[ "$registration_service" == api ]]; then
      test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.api-projection-sha256" }}')" = "$registration_api_projection"
      test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.api-compiled-source-sha256" }}')" = "$registration_api_compiled_projection"
    else
      test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.worker-projection-sha256" }}')" = "$registration_worker_projection"
    fi
  done
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-90-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = c3cad767b372738b2193e60584b0a53daa53b65f
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-90-20261007
  services=(auto-recharge admin)
  registration_admin_projection="$(read_registration_admin_projection)"
  for registration_service in "${services[@]}"; do
    registration_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${registration_service}"
    test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
    if [[ "$registration_service" == admin ]]; then
      test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.admin-projection-sha256" }}')" = "$registration_admin_projection"
    fi
  done
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-96-20261008 ]]; then
  services=(auto-recharge)
  registration_worker_projection="$(read_registration_onboarding_projection)"
  registration_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-auto-recharge"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.worker-projection-sha256" }}')" = "$registration_worker_projection"
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-95-20261008 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 4c170e661c871dc14dccc98a8d6e5cf983141341
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-95-20261008
  services=(auto-recharge)
  registration_worker_projection="$(read_registration_interstitial_projection)"
  registration_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-auto-recharge"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.worker-projection-sha256" }}')" = "$registration_worker_projection"

elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-94-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 815fae391b172d6c368ea2ad25225f52a1272808
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-94-20261007
  services=(auto-recharge)
  registration_worker_projection="$(read_registration_followup_projection)"
  registration_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-auto-recharge"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.worker-projection-sha256" }}')" = "$registration_worker_projection"
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-93-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 2f24cf81007429ea474da404a30bc74da9d43ce1
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-93-20261007
  services=(auto-recharge)
  registration_worker_projection="$(read_registration_login_projection)"
  registration_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-auto-recharge"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
  test "$(docker image inspect "$registration_reference" --format '{{ index .Config.Labels "id-business-v2.worker-projection-sha256" }}')" = "$registration_worker_projection"
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-91-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-91-20261007
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-89-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = d2e22e623d0e19851c79ffe43396f5f97a99b8d3
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-89-20261006
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-88-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 4c200c4ae08bb8214ff8e0955f8237ce85069cc6
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-88-20261006
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-87-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 651f62902fba74ddd189b34932084573b39d245c
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-87-20261006
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-86-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = fd3a6da610c505c2b7a51601cf854182991ffd12
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-86-20261006
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-85-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 85e94572cd965dd993743d12d55a3e91d60b6444
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-85-20261006
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-956-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 9560d8038a39d4ded1e560d484bdcb941a5d9c43
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope --registration-profile registration-worker-956-20261006
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-b8-80-20261006 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-registration-scope
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-4c-20261008 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-6f5-20261008 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-pricing-045-20261008 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  case "$HISTORICAL_EXCEPTION" in
    recharge-pro-4c-20261008) test "$EXPECTED_CURRENT" = 4c170e661c871dc14dccc98a8d6e5cf983141341 ;;
    recharge-pro-pricing-045-20261008) test "$EXPECTED_CURRENT" = e7c9862d58599995954883f1c1f6038283afffab ;;
    recharge-pro-6f5-20261008) test "$EXPECTED_CURRENT" = 6f5e5cc252886d5f86592e307147b40c13577585 ;;
    *) exit 1 ;;
  esac
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}"
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
  services=(auto-recharge)
  recharge_worker_projection="$(python3 - <<'PY_D3FB_PUSH_PROJECTION'
import hashlib, json, os, re
from pathlib import Path

def unique(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('Fixed 4c push projection changed')
        result[key] = value
    return result

def read(path):
    raw = path.read_bytes()
    if not 0 < len(raw) <= 128 * 1024:
        raise ValueError('Fixed 4c push projection unavailable')
    return json.loads(raw, object_pairs_hook=unique)

identity = os.environ['HISTORICAL_EXCEPTION']
if identity not in ('recharge-pro-4c-20261008', 'recharge-pro-6f5-20261008', 'recharge-pro-pricing-045-20261008'):
    raise SystemExit('Fixed recharge push identity unavailable')
profile = read(Path('deploy/aws/' + identity + '.json'))
marker = read(Path('.deploy/production-release/fixed-recharge-build-projection.json'))
projection = profile.get('workerProjection') if isinstance(profile, dict) else None
if (not isinstance(projection, dict) or len(projection) != 60
        or not isinstance(marker, dict)
        or set(marker) != {'version', 'id', 'contextPath', 'workerProjectionSha256'}
        or type(marker['version']) is not int or marker['version'] != 1
        or marker['id'] != identity
        or not isinstance(marker['contextPath'], str)
        or Path(marker['contextPath']).resolve() != Path('.deploy/production-release/fixed-recharge-context').resolve()
        or not isinstance(marker['workerProjectionSha256'], str)
        or not re.fullmatch(r'[a-f0-9]{64}', marker['workerProjectionSha256'])):
    raise SystemExit('Fixed 4c push projection unavailable')
digest = hashlib.sha256(json.dumps(projection, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
if digest != marker['workerProjectionSha256']:
    raise SystemExit('Fixed 4c push projection changed')
print(digest)
PY_D3FB_PUSH_PROJECTION
  )"
  recharge_reference="${RELEASE_REPOSITORY}:${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-auto-recharge"
  test "$(docker image inspect "$recharge_reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
  test "$(docker image inspect "$recharge_reference" --format '{{ index .Config.Labels "id-business-v2.worker-projection-sha256" }}')" = "$recharge_worker_projection"
elif [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-2f-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 2f24cf81007429ea474da404a30bc74da9d43ce1
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-974-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 974c62cc1681012ecff897aefc90d2cd9900004a
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-b8-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-7f-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-main80-20261006 ]]; then
  case "$HISTORICAL_EXCEPTION" in
    recharge-pro-menu-b8-20261005) test "$EXPECTED_CURRENT" = b8d643450ffa9012ccc09ead15e4681e3dee98d0 ;;
    recharge-pro-menu-7f-20261005) test "$EXPECTED_CURRENT" = 7f70688b9bf53a071a0a324ca558aeabc4ced2e3 ;;
    recharge-pro-main80-20261006) test "$EXPECTED_CURRENT" = b91b626a71ed2c7c2473d080551b3b10b693b0cb ;;
    *) exit 1 ;;
  esac
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_COMMIT:-}"
  test -z "${REUSE_IMAGE_RUN_ID:-}"
  test -z "${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
  services=(auto-recharge)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == historical-finance-20261005-post-cleanup ]]; then
  [[ "${RELEASE_OPERATION:-release}" == prepare_post_cleanup_release ]] || exit 1
  services=(api migrate)
elif [[ "${HISTORICAL_EXCEPTION:-none}" == historical-finance-20261005-order-archive ]]; then
  [[ "${RELEASE_OPERATION:-release}" == prepare_order_archive_release ]] || exit 1
  services=(api migrate admin)
else
  case "${RELEASE_ADMIN_ONLY:-false}" in
    true) services=(admin) ;;
    false) services=(media-resolver auto-recharge api migrate admin) ;;
    *) exit 1 ;;
  esac
fi
registry="${RELEASE_REPOSITORY%%/*}"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry" >/dev/null
for service in "${services[@]}"; do
  image_tag="${RELEASE_COMMIT}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${service}"
  reference="${RELEASE_REPOSITORY}:${image_tag}"
  test "$(docker image inspect "$reference" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$RELEASE_COMMIT"
  if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-90-20261007 && "$service" == admin ]]; then
    test "$(docker image inspect "$reference" --format '{{ index .Config.Labels "id-business-v2.admin-projection-sha256" }}')" = "$registration_admin_projection"
  fi
  docker push "$reference"
  aws ecr describe-images --repository-name id-business-v2-release \
    --image-ids "imageTag=${image_tag}" \
    --query 'imageDetails[0].imageDigest' --output text | grep -Eq '^sha256:[0-9a-f]{64}$'
  echo "Pushed verified image: $service"
done

docker logout "$registry" >/dev/null
