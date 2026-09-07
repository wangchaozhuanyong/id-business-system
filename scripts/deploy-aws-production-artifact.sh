#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connection_file="${AWS_PRODUCTION_CONNECTION_FILE:-${project_root}/.deploy/aws-production.local.env}"
release_tag="${1:-${RELEASE_TAG:-}}"

if [[ ! -f "$connection_file" ]]; then
  echo '缺少本机 AWS 生产连接文件' >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$connection_file" 2>/dev/null || stat -c '%a' "$connection_file")" != 600 ]]; then
  echo '本机 AWS 生产连接文件必须为 0600' >&2
  exit 1
fi
set -a
# 该文件由仓库管理员在本机维护，或由受保护的 GitHub Environment 变量生成。
# shellcheck disable=SC1090
source "$connection_file"
set +a

require_variable() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "缺少生产发布参数：${name}" >&2
    exit 1
  fi
}

for variable in \
  AWS_REGION \
  AWS_PRODUCTION_INSTANCE_ID \
  AWS_PRODUCTION_RELEASE_BUCKET \
  AWS_PRODUCTION_READ_DOCUMENT \
  AWS_PRODUCTION_DEPLOY_DOCUMENT \
  PRODUCTION_BASE_URL \
  PRODUCTION_COMPOSE_PROJECT \
  GITHUB_REPOSITORY \
  GH_TOKEN; do
  require_variable "$variable"
done
if [[ ! "$release_tag" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]] ||
   [[ ! "$AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] ||
   [[ ! "$AWS_PRODUCTION_INSTANCE_ID" =~ ^i-[a-f0-9]{8,17}$ ]] ||
   [[ ! "$AWS_PRODUCTION_RELEASE_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
   [[ ! "$AWS_PRODUCTION_READ_DOCUMENT" =~ ^[A-Za-z0-9_.-]{3,128}$ ]] ||
   [[ ! "$AWS_PRODUCTION_DEPLOY_DOCUMENT" =~ ^[A-Za-z0-9_.-]{3,128}$ ]] ||
   [[ ! "$PRODUCTION_COMPOSE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]{1,62}$ ]] ||
   [[ ! "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo '生产发布参数格式无效' >&2
  exit 1
fi
for command in aws curl gh git node sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "生产发布依赖命令不存在：${command}" >&2
    exit 1
  }
done

cd "$project_root"
if [[ -n "$(git status --porcelain)" ]] || [[ "$(git branch --show-current)" != main ]]; then
  echo '生产部署必须在干净的本地 main 分支执行' >&2
  exit 1
fi
git fetch origin main --tags --prune
release_commit="$(git rev-parse "${release_tag}^{commit}")"
if [[ "$(git cat-file -t "$release_tag")" != tag ]] ||
   [[ "$(git rev-parse HEAD)" != "$release_commit" ]] ||
   [[ "$(git rev-parse origin/main)" != "$release_commit" ]]; then
  echo '本地 HEAD、origin/main 与带说明正式标签的完整 SHA 不一致' >&2
  exit 1
fi
git merge-base --is-ancestor "$release_commit" origin/main

send_ssm_command() {
  local document_name="$1"
  local parameters_json="$2"
  local command_id status stdout stderr
  command_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --document-name "$document_name" \
    --instance-ids "$AWS_PRODUCTION_INSTANCE_ID" \
    --parameters "$parameters_json" \
    --query 'Command.CommandId' \
    --output text)"
  if [[ ! "$command_id" =~ ^[a-f0-9-]{36}$ ]]; then
    echo 'SSM 未返回有效命令 ID' >&2
    return 1
  fi
  for _attempt in $(seq 1 180); do
    status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$command_id" \
      --instance-id "$AWS_PRODUCTION_INSTANCE_ID" \
      --query Status \
      --output text 2>/dev/null || true)"
    case "$status" in
      Success)
        aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" \
          --instance-id "$AWS_PRODUCTION_INSTANCE_ID" --query StandardOutputContent --output text
        return 0
        ;;
      Failed|Cancelled|TimedOut|Undeliverable|Terminated|DeliveryTimedOut|ExecutionTimedOut)
        stdout="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$AWS_PRODUCTION_INSTANCE_ID" --query StandardOutputContent --output text 2>/dev/null || true)"
        stderr="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$AWS_PRODUCTION_INSTANCE_ID" --query StandardErrorContent --output text 2>/dev/null || true)"
        printf '%s\n%s\n' "$stdout" "$stderr" >&2
        return 1
        ;;
    esac
    sleep 5
  done
  echo 'SSM 生产发布命令等待超时' >&2
  return 1
}

current_release_record="$(send_ssm_command "$AWS_PRODUCTION_READ_DOCUMENT" '{}')"
IFS=$'\t' read -r previous_release_directory previous_commit current_release_tag \
  <<<"$(printf '%s\n' "$current_release_record" | tail -n 1)"
if [[ "$previous_release_directory" != /opt/id-business-v2/releases/* ]] ||
   [[ ! "$previous_commit" =~ ^[a-f0-9]{40}$ ]] ||
   [[ ! "$current_release_tag" =~ ^v2-production-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo 'SSM 返回的当前生产清单无效' >&2
  exit 1
fi
if [[ "$previous_commit" == "$release_commit" ]]; then
  BASE_URL="$PRODUCTION_BASE_URL" bash scripts/deploy-smoke.sh
  echo "production_release=${current_release_tag}"
  echo "requested_release=${release_tag}"
  echo "production_commit=${release_commit}"
  echo 'deployment_status=already_deployed'
  exit 0
fi

artifact_name="id-business-v2-${release_tag}-${release_commit}"
run_record="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow quality.yml --commit "$release_commit" \
  --event push --status success --limit 20 --json databaseId,headBranch,headSha,url \
  --jq ".[] | select(.headBranch == \"${release_tag}\" and .headSha == \"${release_commit}\") | [.databaseId, .url] | @tsv" | head -n 1)"
if [[ -z "$run_record" ]]; then
  echo '未找到该正式标签对应的成功 Quality Gate 运行' >&2
  exit 1
fi
IFS=$'\t' read -r ci_run_id ci_run_url <<<"$run_record"
artifact_record="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${ci_run_id}/artifacts" \
  --jq ".artifacts[] | select(.name == \"${artifact_name}\" and .expired == false) | [.id, .name, .digest] | @tsv" | head -n 1)"
if [[ -z "$artifact_record" ]]; then
  echo '成功 CI 运行中没有预期的不可变发布制品' >&2
  exit 1
fi
IFS=$'\t' read -r github_artifact_id github_artifact_name github_artifact_digest <<<"$artifact_record"
if [[ ! "$github_artifact_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'GitHub 制品缺少有效 digest' >&2
  exit 1
fi

working_directory="$(mktemp -d "${TMPDIR:-/tmp}/idv2-production-deploy.XXXXXX")"
case "$working_directory" in */idv2-production-deploy.*) ;; *) exit 1 ;; esac
cleanup() {
  case "$working_directory" in */idv2-production-deploy.*) rm -rf -- "$working_directory" ;; esac
}
trap cleanup EXIT INT TERM
download_directory="${working_directory}/download"
mkdir -p "$download_directory"
gh run download --repo "$GITHUB_REPOSITORY" "$ci_run_id" --name "$artifact_name" --dir "$download_directory"
node scripts/verify-production-release-artifact.mjs --directory "$download_directory" \
  --expected-commit "$release_commit" --expected-tag "$release_tag"

manifest_path="${download_directory}/release-manifest.json"
manifest_values="$(node --input-type=module - "$manifest_path" <<'NODE'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const values = [manifest.artifact.file, manifest.artifact.sha256, manifest.aws.region,
  manifest.aws.ecrRegistry, ...['api','admin','migration','mediaResolver','recharge','gate']
    .flatMap((name) => [manifest.images[name].reference, manifest.images[name].digest])];
if (values.some((value) => typeof value !== 'string' || /[\t\r\n]/u.test(value))) process.exit(2);
process.stdout.write(values.join('\t'));
NODE
)"
IFS=$'\t' read -r artifact_file artifact_sha256 release_region ecr_registry \
  api_reference api_digest admin_reference admin_digest migration_reference migration_digest \
  media_resolver_reference media_resolver_digest recharge_reference recharge_digest \
  gate_reference gate_digest <<<"$manifest_values"
if [[ "$release_region" != "$AWS_REGION" ]]; then
  echo 'CI 镜像区域与部署区域不一致' >&2
  exit 1
fi

release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
deployment_run="github-${GITHUB_RUN_ID:-${release_stamp}}-${GITHUB_RUN_ATTEMPT:-1}-${release_commit:0:12}"
release_directory="/opt/id-business-v2/releases/${release_stamp}-${release_commit:0:12}"
release_prefix="releases/${release_tag}/${release_commit}/deployments/${deployment_run}"
operator="github-actions:${GITHUB_ACTOR:-unknown}"
deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
deployment_manifest_path="${working_directory}/release-manifest.json"
ci_manifest_path="${working_directory}/ci-release-manifest.json"
cp "$manifest_path" "$ci_manifest_path"
node scripts/create-production-deployment-manifest.mjs \
  --input "$manifest_path" --output "$deployment_manifest_path" \
  --deployment-run "$deployment_run" --deployed-at "$deployed_at" --operator "$operator" \
  --previous-commit "$previous_commit" --github-artifact-id "$github_artifact_id" \
  --github-artifact-name "$github_artifact_name" --github-artifact-digest "$github_artifact_digest" \
  --github-run-url "$ci_run_url" --aws-region "$AWS_REGION" \
  --release-bucket "$AWS_PRODUCTION_RELEASE_BUCKET" --release-prefix "$release_prefix" \
  --production-base-url "$PRODUCTION_BASE_URL" --production-compose-project "$PRODUCTION_COMPOSE_PROJECT"

ci_manifest_sha256="$(sha256sum "$ci_manifest_path" | awk '{print $1}')"
deployment_manifest_sha256="$(sha256sum "$deployment_manifest_path" | awk '{print $1}')"
checksums_sha256="$(sha256sum "${download_directory}/SHA256SUMS" | awk '{print $1}')"
inputs_path="${working_directory}/release-inputs.env"
export \
  RELEASE_DIRECTORY="$release_directory" \
  PREVIOUS_RELEASE_DIRECTORY="$previous_release_directory" \
  RELEASE_SOURCE_ARCHIVE="/opt/id-business-v2/artifacts/${release_tag}-${release_commit}/${artifact_file}" \
  RELEASE_SOURCE_ARCHIVE_SHA256="$artifact_sha256" \
  RELEASE_AWS_REGION="$AWS_REGION" \
  RELEASE_ECR_REGISTRY="$ecr_registry" \
  RELEASE_COMMIT="$release_commit" \
  RELEASE_TAG="$release_tag" \
  RELEASE_DEPLOYMENT_RUN="$deployment_run" \
  RELEASE_CI_MANIFEST_SHA256="$ci_manifest_sha256" \
  RELEASE_DEPLOYMENT_MANIFEST_SHA256="$deployment_manifest_sha256" \
  RELEASE_CHECKSUMS_SHA256="$checksums_sha256" \
  RELEASE_API_IMAGE="$api_reference" RELEASE_API_DIGEST="$api_digest" \
  RELEASE_ADMIN_IMAGE="$admin_reference" RELEASE_ADMIN_DIGEST="$admin_digest" \
  RELEASE_MIGRATION_IMAGE="$migration_reference" RELEASE_MIGRATION_DIGEST="$migration_digest" \
  RELEASE_MEDIA_RESOLVER_IMAGE="$media_resolver_reference" \
  RELEASE_MEDIA_RESOLVER_DIGEST="$media_resolver_digest" \
  RELEASE_RECHARGE_IMAGE="$recharge_reference" RELEASE_RECHARGE_DIGEST="$recharge_digest" \
  RELEASE_GATE_IMAGE="$gate_reference" RELEASE_GATE_DIGEST="$gate_digest"
node --input-type=module - "$inputs_path" <<'NODE'
import { writeFileSync } from 'node:fs';
const names = ['RELEASE_DIRECTORY','PREVIOUS_RELEASE_DIRECTORY','RELEASE_SOURCE_ARCHIVE','RELEASE_SOURCE_ARCHIVE_SHA256',
  'RELEASE_AWS_REGION','RELEASE_ECR_REGISTRY','RELEASE_COMMIT','RELEASE_TAG','RELEASE_DEPLOYMENT_RUN',
  'RELEASE_CI_MANIFEST_SHA256','RELEASE_DEPLOYMENT_MANIFEST_SHA256','RELEASE_CHECKSUMS_SHA256',
  'RELEASE_API_IMAGE','RELEASE_API_DIGEST','RELEASE_ADMIN_IMAGE','RELEASE_ADMIN_DIGEST',
  'RELEASE_MIGRATION_IMAGE','RELEASE_MIGRATION_DIGEST','RELEASE_MEDIA_RESOLVER_IMAGE',
  'RELEASE_MEDIA_RESOLVER_DIGEST','RELEASE_RECHARGE_IMAGE','RELEASE_RECHARGE_DIGEST',
  'RELEASE_GATE_IMAGE','RELEASE_GATE_DIGEST','PRODUCTION_BASE_URL','PRODUCTION_COMPOSE_PROJECT'];
const lines = names.map((name) => {
  const value = process.env[name];
  if (!value || !/^[A-Za-z0-9_./:@-]+$/u.test(value)) throw new Error(`Unsafe release input: ${name}`);
  return `${name}='${value}'`;
});
writeFileSync(process.argv[2], `${lines.join('\n')}\n`, { mode: 0o600 });
NODE
inputs_sha256="$(sha256sum "$inputs_path" | awk '{print $1}')"
bootstrap_path="${project_root}/scripts/bootstrap-aws-production-ecr-release.sh"
bootstrap_sha256="$(sha256sum "$bootstrap_path" | awk '{print $1}')"

upload_immutable() {
  local source="$1"
  local name="$2"
  local digest
  digest="$(sha256sum "$source" | awk '{print $1}')"
  existing="$(aws s3api head-object --region "$AWS_REGION" --bucket "$AWS_PRODUCTION_RELEASE_BUCKET" \
    --key "${release_prefix}/${name}" --query 'Metadata.sha256' --output text 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != None ]]; then
    [[ "$existing" == "$digest" ]] || { echo "S3 不可变文件冲突：${name}" >&2; exit 1; }
    return
  fi
  aws s3 cp --only-show-errors --region "$AWS_REGION" --sse AES256 --metadata "sha256=${digest}" \
    "$source" "s3://${AWS_PRODUCTION_RELEASE_BUCKET}/${release_prefix}/${name}"
}

upload_immutable "${download_directory}/${artifact_file}" "$artifact_file"
upload_immutable "$ci_manifest_path" ci-release-manifest.json
upload_immutable "$deployment_manifest_path" release-manifest.json
upload_immutable "${download_directory}/SHA256SUMS" SHA256SUMS
upload_immutable "$inputs_path" release-inputs.env
upload_immutable "$bootstrap_path" bootstrap-aws-production-ecr-release.sh

ssm_parameters="$(node --input-type=module - "$AWS_PRODUCTION_RELEASE_BUCKET" "$release_prefix" "$bootstrap_sha256" "$inputs_sha256" "$AWS_REGION" <<'NODE'
const [bucket, prefix, bootstrapSha256, inputsSha256, region] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ Bucket: [bucket], Prefix: [prefix], BootstrapSha256: [bootstrapSha256], InputsSha256: [inputsSha256], AwsRegion: [region] }));
NODE
)"
echo "开始通过 SSM 部署不可变制品：${release_tag} ${release_commit}"
deployment_output="$(send_ssm_command "$AWS_PRODUCTION_DEPLOY_DOCUMENT" "$ssm_parameters")"
printf '%s\n' "$deployment_output"
deployed_release_record="$(send_ssm_command "$AWS_PRODUCTION_READ_DOCUMENT" '{}')"
IFS=$'\t' read -r deployed_release_directory deployed_commit deployed_release_tag \
  <<<"$(printf '%s\n' "$deployed_release_record" | tail -n 1)"
if [[ "$deployed_release_directory" != "$release_directory" ]] ||
   [[ "$deployed_commit" != "$release_commit" ]] ||
   [[ "$deployed_release_tag" != "$release_tag" ]]; then
  echo 'SSM 部署后 current 清单与本次发布不一致' >&2
  exit 1
fi

echo "artifact_sha256=${artifact_sha256}"
echo "ecr_registry=${ecr_registry}"
echo 'deployment_status=deployed'
