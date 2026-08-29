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
  RELEASE_API_IMAGE \
  RELEASE_ADMIN_IMAGE \
  RELEASE_MIGRATION_IMAGE \
  RELEASE_GATE_IMAGE; do
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
if [[ "$(git rev-parse HEAD)" != "$RELEASE_COMMIT" ]]; then
  echo '当前检出与发布 commit 不一致' >&2
  exit 1
fi

mkdir -p "$RELEASE_OUTPUT_DIR"
output_directory="$(cd "$RELEASE_OUTPUT_DIR" && pwd)"
staging_directory="$(mktemp -d "${RUNNER_TEMP:-/tmp}/idv2-production-artifact.XXXXXX")"
case "$staging_directory" in
  */idv2-production-artifact.*) ;;
  *) echo '无法创建安全的制品临时目录' >&2; exit 1 ;;
esac

cleanup() {
  case "$staging_directory" in
    */idv2-production-artifact.*) rm -rf -- "$staging_directory" ;;
  esac
}
trap cleanup EXIT INT TERM

image_archive="$staging_directory/images.tar"
source_archive="$staging_directory/source.tar.gz"
artifact_file="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}.tar.gz"
artifact_path="$output_directory/$artifact_file"
manifest_file="release-manifest.json"
manifest_path="$output_directory/$manifest_file"
checksum_path="$output_directory/SHA256SUMS"
github_artifact_name="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}"

docker save \
  --output "$image_archive" \
  "$RELEASE_API_IMAGE" \
  "$RELEASE_ADMIN_IMAGE" \
  "$RELEASE_MIGRATION_IMAGE" \
  "$RELEASE_GATE_IMAGE"
git archive --format=tar.gz --output="$source_archive" "$RELEASE_COMMIT"

image_archive_sha256="$(sha256sum "$image_archive" | awk '{print $1}')"
source_archive_sha256="$(sha256sum "$source_archive" | awk '{print $1}')"
tar -czf "$artifact_path" -C "$staging_directory" images.tar source.tar.gz
artifact_sha256="$(sha256sum "$artifact_path" | awk '{print $1}')"

api_digest="$(docker image inspect "$RELEASE_API_IMAGE" --format '{{.Id}}')"
admin_digest="$(docker image inspect "$RELEASE_ADMIN_IMAGE" --format '{{.Id}}')"
migration_digest="$(docker image inspect "$RELEASE_MIGRATION_IMAGE" --format '{{.Id}}')"
gate_digest="$(docker image inspect "$RELEASE_GATE_IMAGE" --format '{{.Id}}')"

export artifact_file artifact_sha256 image_archive_sha256 source_archive_sha256
export api_digest admin_digest migration_digest gate_digest
node --input-type=module >"$manifest_path" <<'NODE'
const required = [
  'RELEASE_SOURCE_BRANCH',
  'RELEASE_COMMIT',
  'RELEASE_TAG',
  'RELEASE_CI_RUN_ID',
  'RELEASE_CI_RUN_NUMBER',
  'RELEASE_OPERATOR',
  'RELEASE_API_IMAGE',
  'RELEASE_ADMIN_IMAGE',
  'RELEASE_MIGRATION_IMAGE',
  'RELEASE_GATE_IMAGE',
  'artifact_file',
  'artifact_sha256',
  'image_archive_sha256',
  'source_archive_sha256',
  'api_digest',
  'admin_digest',
  'migration_digest',
  'gate_digest'
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing release manifest value: ${name}`);
}

const image = (reference, digest) => ({ reference, digest });
const manifest = {
  schemaVersion: 1,
  sourceBranch: process.env.RELEASE_SOURCE_BRANCH,
  commit: process.env.RELEASE_COMMIT,
  releaseTag: process.env.RELEASE_TAG,
  ciWorkflow: 'Quality Gate',
  ciWorkflowRunId: process.env.RELEASE_CI_RUN_ID,
  ciWorkflowRunNumber: process.env.RELEASE_CI_RUN_NUMBER,
  deploymentRun: null,
  artifact: {
    file: process.env.artifact_file,
    sha256: process.env.artifact_sha256,
    imageArchiveSha256: process.env.image_archive_sha256,
    sourceArchiveSha256: process.env.source_archive_sha256
  },
  images: {
    api: image(process.env.RELEASE_API_IMAGE, process.env.api_digest),
    admin: image(process.env.RELEASE_ADMIN_IMAGE, process.env.admin_digest),
    migration: image(process.env.RELEASE_MIGRATION_IMAGE, process.env.migration_digest),
    gate: image(process.env.RELEASE_GATE_IMAGE, process.env.gate_digest)
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
