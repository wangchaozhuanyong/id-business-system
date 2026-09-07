#!/usr/bin/env bash
set -Eeuo pipefail

require_variable() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "缺少发布制品变量：${name}" >&2
    exit 1
  fi
}

for variable in \
  RELEASE_SOURCE_BRANCH \
  RELEASE_COMMIT \
  RELEASE_TAG \
  RELEASE_CI_RUN_ID \
  RELEASE_CI_RUN_NUMBER \
  RELEASE_OPERATOR \
  RELEASE_OUTPUT_DIR \
  RELEASE_AWS_REGION \
  RELEASE_ECR_REGISTRY \
  RELEASE_API_IMAGE \
  RELEASE_API_DIGEST \
  RELEASE_ADMIN_IMAGE \
  RELEASE_ADMIN_DIGEST \
  RELEASE_MIGRATION_IMAGE \
  RELEASE_MIGRATION_DIGEST \
  RELEASE_MEDIA_RESOLVER_IMAGE \
  RELEASE_MEDIA_RESOLVER_DIGEST \
  RELEASE_RECHARGE_IMAGE \
  RELEASE_RECHARGE_DIGEST \
  RELEASE_GATE_IMAGE \
  RELEASE_GATE_DIGEST; do
  require_variable "$variable"
done

if [[ ! "$RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo '发布 commit 必须是完整 40 位 SHA' >&2
  exit 1
fi
if [[ ! "$RELEASE_TAG" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo '正式标签格式无效' >&2
  exit 1
fi
if [[ ! "$RELEASE_AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]]; then
  echo 'AWS 区域格式无效' >&2
  exit 1
fi
if [[ ! "$RELEASE_ECR_REGISTRY" =~ ^[0-9]{12}\.dkr\.ecr\.${RELEASE_AWS_REGION}\.amazonaws\.com(\.cn)?$ ]]; then
  echo 'ECR registry 与 AWS 区域不匹配' >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$RELEASE_COMMIT" ]]; then
  echo '当前检出与发布 commit 不一致' >&2
  exit 1
fi

for name in API ADMIN MIGRATION MEDIA_RESOLVER RECHARGE GATE; do
  image_variable="RELEASE_${name}_IMAGE"
  digest_variable="RELEASE_${name}_DIGEST"
  image_reference="${!image_variable}"
  image_digest="${!digest_variable}"
  if [[ "$image_reference" != "${RELEASE_ECR_REGISTRY}/"*":${RELEASE_COMMIT}" ]]; then
    echo "${name} 镜像不是当前 commit 的 ECR 标签" >&2
    exit 1
  fi
  if [[ ! "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "${name} ECR manifest digest 无效" >&2
    exit 1
  fi
done

mkdir -p "$RELEASE_OUTPUT_DIR"
output_directory="$(cd "$RELEASE_OUTPUT_DIR" && pwd)"
artifact_file="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}.tar.gz"
artifact_path="$output_directory/$artifact_file"
manifest_file='release-manifest.json'
manifest_path="$output_directory/$manifest_file"
checksum_path="$output_directory/SHA256SUMS"
github_artifact_name="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}"

# 正式制品只保存该 commit 的源码和部署脚本；运行镜像由 ECR 按 digest 提供。
git archive --format=tar.gz --output="$artifact_path" "$RELEASE_COMMIT"
artifact_sha256="$(sha256sum "$artifact_path" | awk '{print $1}')"

export artifact_file artifact_sha256 github_artifact_name
node --input-type=module >"$manifest_path" <<'NODE'
const required = [
  'RELEASE_SOURCE_BRANCH',
  'RELEASE_COMMIT',
  'RELEASE_TAG',
  'RELEASE_CI_RUN_ID',
  'RELEASE_CI_RUN_NUMBER',
  'RELEASE_OPERATOR',
  'RELEASE_AWS_REGION',
  'RELEASE_ECR_REGISTRY',
  'RELEASE_API_IMAGE',
  'RELEASE_API_DIGEST',
  'RELEASE_ADMIN_IMAGE',
  'RELEASE_ADMIN_DIGEST',
  'RELEASE_MIGRATION_IMAGE',
  'RELEASE_MIGRATION_DIGEST',
  'RELEASE_MEDIA_RESOLVER_IMAGE',
  'RELEASE_MEDIA_RESOLVER_DIGEST',
  'RELEASE_RECHARGE_IMAGE',
  'RELEASE_RECHARGE_DIGEST',
  'RELEASE_GATE_IMAGE',
  'RELEASE_GATE_DIGEST',
  'artifact_file',
  'artifact_sha256',
  'github_artifact_name'
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing release manifest value: ${name}`);
}

const commit = process.env.RELEASE_COMMIT;
const image = (taggedReference, digest) => {
  const tagSuffix = `:${commit}`;
  if (!taggedReference.endsWith(tagSuffix)) throw new Error('ECR image tag does not match commit');
  const repository = taggedReference.slice(0, -tagSuffix.length);
  return {
    taggedReference,
    reference: `${repository}@${digest}`,
    digest,
    platform: 'linux/amd64'
  };
};
const manifest = {
  schemaVersion: 2,
  delivery: 'aws-ecr',
  sourceBranch: process.env.RELEASE_SOURCE_BRANCH,
  commit,
  releaseTag: process.env.RELEASE_TAG,
  ciWorkflow: 'Quality Gate',
  ciWorkflowRunId: process.env.RELEASE_CI_RUN_ID,
  ciWorkflowRunNumber: process.env.RELEASE_CI_RUN_NUMBER,
  deploymentRun: null,
  artifact: {
    file: process.env.artifact_file,
    sha256: process.env.artifact_sha256,
    githubArtifactName: process.env.github_artifact_name
  },
  aws: {
    region: process.env.RELEASE_AWS_REGION,
    ecrRegistry: process.env.RELEASE_ECR_REGISTRY
  },
  images: {
    api: image(process.env.RELEASE_API_IMAGE, process.env.RELEASE_API_DIGEST),
    admin: image(process.env.RELEASE_ADMIN_IMAGE, process.env.RELEASE_ADMIN_DIGEST),
    migration: image(process.env.RELEASE_MIGRATION_IMAGE, process.env.RELEASE_MIGRATION_DIGEST),
    mediaResolver: image(
      process.env.RELEASE_MEDIA_RESOLVER_IMAGE,
      process.env.RELEASE_MEDIA_RESOLVER_DIGEST
    ),
    recharge: image(process.env.RELEASE_RECHARGE_IMAGE, process.env.RELEASE_RECHARGE_DIGEST),
    gate: image(process.env.RELEASE_GATE_IMAGE, process.env.RELEASE_GATE_DIGEST)
  },
  environment: 'production',
  builtAt: new Date().toISOString(),
  builtBy: process.env.RELEASE_OPERATOR,
  operator: process.env.RELEASE_OPERATOR,
  deployedAt: null,
  previousCommit: null
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE

manifest_sha256="$(sha256sum "$manifest_path" | awk '{print $1}')"
{
  printf '%s  %s\n' "$artifact_sha256" "$artifact_file"
  printf '%s  %s\n' "$manifest_sha256" "$manifest_file"
} >"$checksum_path"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "github_artifact_name=$github_artifact_name"
    echo "artifact_path=$artifact_path"
    echo "manifest_path=$manifest_path"
    echo "checksum_path=$checksum_path"
    echo "artifact_sha256=$artifact_sha256"
  } >>"$GITHUB_OUTPUT"
fi

echo "release_artifact=$artifact_file"
echo "release_artifact_sha256=$artifact_sha256"
