#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/validate-release-selection.sh"

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-b8-20261005 ]]; then
  test "$EXPECTED_CURRENT" = b8d643450ffa9012ccc09ead15e4681e3dee98d0
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  python3 scripts/production-release/remote-deploy.py --check-fixed-recharge-scope
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
  docker push "$reference"
  aws ecr describe-images --repository-name id-business-v2-release \
    --image-ids "imageTag=${image_tag}" \
    --query 'imageDetails[0].imageDigest' --output text | grep -Eq '^sha256:[0-9a-f]{64}$'
  echo "Pushed verified image: $service"
done

docker logout "$registry" >/dev/null
