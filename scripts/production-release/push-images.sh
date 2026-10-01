#!/usr/bin/env bash
set -Eeuo pipefail

case "${RELEASE_ADMIN_ONLY:-false}" in
  true) services=(admin) ;;
  false) services=(media-resolver auto-recharge api migrate admin) ;;
  *) exit 1 ;;
esac
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
