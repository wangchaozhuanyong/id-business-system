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
  RELEASE_PREVIOUS_COMMIT \
  RELEASE_BACKUP_POLICY \
  RELEASE_MIGRATION_REQUIRED \
  RELEASE_ACCEPTANCE_SCOPES; do
  require_variable "$variable"
done

if [[ ! "$RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ||
      ! "$RELEASE_PREVIOUS_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo '发布 commit 和上一生产 commit 必须是完整 40 位 SHA' >&2
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
if [[ "$RELEASE_BACKUP_POLICY" != fresh && "$RELEASE_BACKUP_POLICY" != recent ]]; then
  echo '生产备份策略必须是 fresh 或 recent' >&2
  exit 1
fi
if [[ "$RELEASE_MIGRATION_REQUIRED" != true && "$RELEASE_MIGRATION_REQUIRED" != false ]]; then
  echo 'migration 标记必须是 true 或 false' >&2
  exit 1
fi

RELEASE_IMAGE_NAMES="${RELEASE_IMAGE_NAMES:-}"
normalized_image_names=",${RELEASE_IMAGE_NAMES},"
seen_image_names=','
IFS=',' read -r -a requested_image_names <<<"$RELEASE_IMAGE_NAMES"
for name in "${requested_image_names[@]}"; do
  [[ -n "$name" ]] || continue
  case "$name" in api|admin|migration|mediaResolver|recharge|gate) ;; *)
    echo "包含未知的发布镜像：${name}" >&2
    exit 1
  esac
  if [[ "$seen_image_names" == *",${name},"* ]]; then
    echo "发布镜像重复：${name}" >&2
    exit 1
  fi
  seen_image_names="${seen_image_names}${name},"
done
if [[ "$RELEASE_IMAGE_NAMES" != 'api,admin,migration,mediaResolver,recharge,gate' &&
      -z "${RELEASE_BASE_MANIFEST:-}" ]]; then
  echo '增量制品必须提供上一版 schema v2 清单' >&2
  exit 1
fi
if [[ -n "${RELEASE_BASE_MANIFEST:-}" && ! -f "$RELEASE_BASE_MANIFEST" ]]; then
  echo '上一版发布清单不存在' >&2
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

source_archive="$staging_directory/source.tar.gz"
artifact_file="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}-source.tar.gz"
artifact_path="$output_directory/$artifact_file"
manifest_file='release-manifest.json'
manifest_path="$output_directory/$manifest_file"
checksum_path="$output_directory/SHA256SUMS"
github_artifact_name="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}-control"

git archive --format=tar.gz --output="$source_archive" "$RELEASE_COMMIT"
source_archive_sha256="$(sha256sum "$source_archive" | awk '{print $1}')"
tar -czf "$artifact_path" -C "$staging_directory" source.tar.gz
artifact_sha256="$(sha256sum "$artifact_path" | awk '{print $1}')"

package_image() {
  local shell_name="$1"
  local manifest_name="$2"
  local reference="$3"
  local archive_file="image-${manifest_name}-${RELEASE_COMMIT}.tar.gz"
  local archive_path="${output_directory}/${archive_file}"
  local artifact_name="id-business-v2-${RELEASE_TAG}-${RELEASE_COMMIT}-image-${manifest_name}"
  local digest
  local size_bytes
  local archive_sha256

  if [[ -z "$reference" ]]; then
    echo "缺少 ${manifest_name} 发布镜像引用" >&2
    exit 1
  fi
  digest="$(docker image inspect "$reference" --format '{{.Id}}')"
  size_bytes="$(docker image inspect "$reference" --format '{{.Size}}')"
  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ||
        ! "$size_bytes" =~ ^[0-9]+$ || "$size_bytes" == 0 ]]; then
    echo "无法读取发布镜像元数据：${reference}" >&2
    exit 1
  fi

  docker save "$reference" | gzip -6 >"$archive_path"
  archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"

  printf -v "${shell_name}_reference" '%s' "$reference"
  printf -v "${shell_name}_digest" '%s' "$digest"
  printf -v "${shell_name}_size_bytes" '%s' "$size_bytes"
  printf -v "${shell_name}_archive_file" '%s' "$archive_file"
  printf -v "${shell_name}_archive_path" '%s' "$archive_path"
  printf -v "${shell_name}_archive_sha256" '%s' "$archive_sha256"
  printf -v "${shell_name}_github_artifact_name" '%s' "$artifact_name"
}

api_archive_path=''
admin_archive_path=''
migration_archive_path=''
media_resolver_archive_path=''
recharge_archive_path=''
gate_archive_path=''

if [[ "$normalized_image_names" == *',api,'* ]]; then
  package_image api api "${RELEASE_API_IMAGE:-}"
fi
if [[ "$normalized_image_names" == *',admin,'* ]]; then
  package_image admin admin "${RELEASE_ADMIN_IMAGE:-}"
fi
if [[ "$normalized_image_names" == *',migration,'* ]]; then
  package_image migration migration "${RELEASE_MIGRATION_IMAGE:-}"
fi
if [[ "$normalized_image_names" == *',mediaResolver,'* ]]; then
  package_image media_resolver mediaResolver "${RELEASE_MEDIA_RESOLVER_IMAGE:-}"
fi
if [[ "$normalized_image_names" == *',recharge,'* ]]; then
  package_image recharge recharge "${RELEASE_RECHARGE_IMAGE:-}"
fi
if [[ "$normalized_image_names" == *',gate,'* ]]; then
  package_image gate gate "${RELEASE_GATE_IMAGE:-}"
fi

export artifact_file artifact_sha256 source_archive_sha256 github_artifact_name
export api_reference api_digest api_size_bytes api_archive_file api_archive_sha256
export api_github_artifact_name
export admin_reference admin_digest admin_size_bytes admin_archive_file admin_archive_sha256
export admin_github_artifact_name
export migration_reference migration_digest migration_size_bytes migration_archive_file
export migration_archive_sha256 migration_github_artifact_name
export media_resolver_reference media_resolver_digest media_resolver_size_bytes
export media_resolver_archive_file media_resolver_archive_sha256
export media_resolver_github_artifact_name
export recharge_reference recharge_digest recharge_size_bytes recharge_archive_file
export recharge_archive_sha256 recharge_github_artifact_name
export gate_reference gate_digest gate_size_bytes gate_archive_file gate_archive_sha256
export gate_github_artifact_name

node --input-type=module >"$manifest_path" <<'NODE'
import { readFileSync } from 'node:fs';

const changed = new Set(process.env.RELEASE_IMAGE_NAMES.split(',').filter(Boolean));
const basePath = process.env.RELEASE_BASE_MANIFEST;
const base = basePath ? JSON.parse(readFileSync(basePath, 'utf8')) : null;
if (base && base.schemaVersion !== 2) throw new Error('增量继承只支持 schema v2 清单');

const specs = [
  ['api', 'api'],
  ['admin', 'admin'],
  ['migration', 'migration'],
  ['mediaResolver', 'media_resolver'],
  ['recharge', 'recharge'],
  ['gate', 'gate']
];

const image = (manifestName, shellName) => {
  if (!changed.has(manifestName)) {
    const inherited = structuredClone(base?.images?.[manifestName]);
    if (!inherited?.reference || !inherited?.digest || !inherited?.archive?.sha256) {
      throw new Error(`上一版清单缺少可继承的 ${manifestName} 镜像`);
    }
    return { ...inherited, inherited: true };
  }

  const read = (suffix) => process.env[`${shellName}_${suffix}`];
  for (const suffix of [
    'reference',
    'digest',
    'size_bytes',
    'archive_file',
    'archive_sha256',
    'github_artifact_name'
  ]) {
    if (!read(suffix)) throw new Error(`缺少 ${manifestName} 镜像元数据：${suffix}`);
  }
  return {
    reference: read('reference'),
    digest: read('digest'),
    sizeBytes: Number(read('size_bytes')),
    inherited: false,
    archive: {
      file: read('archive_file'),
      sha256: read('archive_sha256'),
      githubArtifactName: read('github_artifact_name'),
      ciWorkflowRunId: process.env.RELEASE_CI_RUN_ID,
      sourceCommit: process.env.RELEASE_COMMIT,
      sourceReleaseTag: process.env.RELEASE_TAG
    }
  };
};

const manifest = {
  schemaVersion: 2,
  sourceBranch: process.env.RELEASE_SOURCE_BRANCH,
  commit: process.env.RELEASE_COMMIT,
  releaseTag: process.env.RELEASE_TAG,
  ciWorkflow: 'Production Release Artifact',
  ciWorkflowRunId: process.env.RELEASE_CI_RUN_ID,
  ciWorkflowRunNumber: process.env.RELEASE_CI_RUN_NUMBER,
  deploymentRun: null,
  artifact: {
    file: process.env.artifact_file,
    sha256: process.env.artifact_sha256,
    sourceArchiveSha256: process.env.source_archive_sha256,
    githubArtifactName: process.env.github_artifact_name
  },
  images: Object.fromEntries(
    specs.map(([manifestName, shellName]) => [manifestName, image(manifestName, shellName)])
  ),
  changedImages: specs.map(([manifestName]) => manifestName).filter((name) => changed.has(name)),
  risk: {
    backupPolicy: process.env.RELEASE_BACKUP_POLICY,
    migrationRequired: process.env.RELEASE_MIGRATION_REQUIRED === 'true'
  },
  acceptanceScopes: process.env.RELEASE_ACCEPTANCE_SCOPES.split(',').filter(Boolean),
  environment: 'production',
  builtAt: new Date().toISOString(),
  builtBy: process.env.RELEASE_OPERATOR,
  operator: process.env.RELEASE_OPERATOR,
  deployedAt: null,
  previousCommit: process.env.RELEASE_PREVIOUS_COMMIT
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE

manifest_sha256="$(sha256sum "$manifest_path" | awk '{print $1}')"
{
  printf '%s  %s\n' "$artifact_sha256" "$artifact_file"
  for archive in \
    "$api_archive_path" \
    "$admin_archive_path" \
    "$migration_archive_path" \
    "$media_resolver_archive_path" \
    "$recharge_archive_path" \
    "$gate_archive_path"; do
    if [[ -n "$archive" ]]; then
      sha256sum "$archive" | sed 's#  .*/#  #'
    fi
  done
  printf '%s  %s\n' "$manifest_sha256" "$manifest_file"
} >"$checksum_path"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "github_artifact_name=$github_artifact_name"
    echo "artifact_path=$artifact_path"
    echo "manifest_path=$manifest_path"
    echo "checksum_path=$checksum_path"
    echo "artifact_sha256=$artifact_sha256"
    echo "changed_images=$RELEASE_IMAGE_NAMES"
    for shell_name in api admin migration media_resolver recharge gate; do
      archive_path_name="${shell_name}_archive_path"
      artifact_name="${shell_name}_github_artifact_name"
      echo "${shell_name}_archive_path=${!archive_path_name:-}"
      echo "${shell_name}_github_artifact_name=${!artifact_name:-}"
    done
  } >>"$GITHUB_OUTPUT"
fi

echo "release_artifact=$artifact_file"
echo "release_artifact_sha256=$artifact_sha256"
echo "release_images=$RELEASE_IMAGE_NAMES"
