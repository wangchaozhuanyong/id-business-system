#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/validate-release-selection.sh"

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-92-20261007 ]]; then
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
