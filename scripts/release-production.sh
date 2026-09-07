#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connection_file="${AWS_PRODUCTION_CONNECTION_FILE:-${project_root}/.deploy/aws-production.local.env}"
requested_commit="${1:-}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in date gh git node ssh; do
  command -v "$command" >/dev/null 2>&1 || fail "固定发布入口依赖命令不存在：${command}"
done
[[ -f "$connection_file" ]] || fail '缺少本机 AWS 生产连接文件'
connection_mode="$(stat -f '%Lp' "$connection_file" 2>/dev/null || stat -c '%a' "$connection_file")"
[[ "$connection_mode" == 600 ]] || fail '本机 AWS 生产连接文件必须为 0600'

set -a
# shellcheck disable=SC1090
source "$connection_file"
set +a
for name in SERVER_SSH_HOST SERVER_SSH_USER SERVER_SSH_PORT SERVER_SSH_KEY SERVER_APP_DIR; do
  [[ -n "${!name:-}" ]] || fail "缺少本机 AWS 生产连接参数：${name}"
done
[[ "$SERVER_APP_DIR" == /opt/id-business-v2 ]] || fail '生产目录与仓库强制边界不一致'

cd "$project_root"
[[ -z "$(git status --porcelain)" ]] || fail '固定发布入口只允许在干净工作区运行'
[[ "$(git branch --show-current)" == main ]] || fail '固定发布入口只允许从 main 运行'
git fetch origin main --tags --prune
release_commit="${requested_commit:-$(git rev-parse HEAD)}"
[[ "$release_commit" =~ ^[a-f0-9]{40}$ ]] || fail '发布版本必须是完整 40 位 SHA'
[[ "$(git rev-parse HEAD)" == "$release_commit" ]] || fail '本地 HEAD 与待发布 SHA 不一致'
[[ "$(git rev-parse origin/main)" == "$release_commit" ]] || fail '待发布 SHA 不是当前 origin/main'

quality_record="$(
  gh run list \
    --workflow quality.yml \
    --commit "$release_commit" \
    --event push \
    --status success \
    --limit 50 \
    --json databaseId,headBranch,headSha,url \
    --jq ".[] | select(.headBranch == \"main\" and .headSha == \"${release_commit}\") | [.databaseId, .url] | @tsv" |
    head -n 1
)"
[[ -n "$quality_record" ]] || fail '该 origin/main SHA 尚无成功 Quality Gate，拒绝发布'
IFS=$'\t' read -r quality_run_id quality_run_url <<<"$quality_record"
echo "锁定发布版本：${release_commit}（Quality Gate ${quality_run_id}）"

ssh_options=(
  -i "$SERVER_SSH_KEY"
  -p "$SERVER_SSH_PORT"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
)
ssh_target="${SERVER_SSH_USER}@${SERVER_SSH_HOST}"
current_reader="${project_root}/scripts/read-current-production-release.sh"
current_json="$(
  ssh "${ssh_options[@]}" "$ssh_target" sudo bash -s -- "$SERVER_APP_DIR" --json \
    <"$current_reader"
)" || fail '无法读取当前生产发布清单'
current_record="$(CURRENT_RELEASE_JSON="$current_json" node --input-type=module <<'NODE'
const value = JSON.parse(process.env.CURRENT_RELEASE_JSON);
process.stdout.write([
  value.commit,
  value.releaseTag,
  String(value.schemaVersion),
  String(value.ciWorkflowRunId),
  value.controlArtifactName
].join('\t'));
NODE
)"
IFS=$'\t' read -r previous_commit previous_release_tag previous_schema_version \
  previous_ci_run_id previous_artifact_name <<<"$current_record"
[[ "$previous_commit" != "$release_commit" ]] || {
  echo '该准确版本已在生产，跳过制品构建与部署，只执行现有部署脚本的语义健康确认'
  exec bash scripts/deploy-aws-incremental-release.sh "$previous_release_tag"
}
git merge-base --is-ancestor "$previous_commit" "$release_commit" ||
  fail '当前生产 commit 不是待发布 main SHA 的祖先，拒绝跨历史发布'

release_tag="$(
  git tag --points-at "$release_commit" --list 'v2-production-*' --sort=-creatordate | head -n 1
)"
if [[ -z "$release_tag" ]]; then
  release_tag="v2-production-$(date -u +%Y%m%dT%H%M%SZ)"
  git tag -a "$release_tag" "$release_commit" -m "Production release ${release_commit}"
else
  [[ "$(git cat-file -t "$release_tag")" == tag ]] || fail '现有生产标签不是带说明的不可变标签'
  [[ "$(git rev-parse "${release_tag}^{commit}")" == "$release_commit" ]] || fail '现有生产标签与准确 SHA 不一致'
fi
remote_release_commit="$(
  git ls-remote --tags origin "refs/tags/${release_tag}^{}" | awk 'NR == 1 { print $1 }'
)"
if [[ -z "$remote_release_commit" ]]; then
  git push origin "refs/tags/${release_tag}"
elif [[ "$remote_release_commit" != "$release_commit" ]]; then
  fail '远程生产标签已存在但指向其他 SHA，拒绝移动标签'
fi
echo "锁定不可变标签：${release_tag}"

find_release_run() {
  gh run list \
    --workflow production-release.yml \
    --commit "$release_commit" \
    --event workflow_dispatch \
    --limit 30 \
    --json databaseId,status,conclusion,headBranch,headSha,url,createdAt \
    --jq ".[] | select(.headBranch == \"${release_tag}\" and .headSha == \"${release_commit}\") | [.databaseId, .status, (.conclusion // \"\"), .url, .createdAt] | @tsv" |
    head -n 1
}

release_run_record="$(find_release_run)"
if [[ -z "$release_run_record" ]]; then
  dispatch_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh workflow run production-release.yml \
    --ref "$release_tag" \
    -f "release_commit=${release_commit}" \
    -f "previous_commit=${previous_commit}" \
    -f "previous_release_tag=${previous_release_tag}" \
    -f "previous_schema_version=${previous_schema_version}" \
    -f "previous_ci_run_id=${previous_ci_run_id}" \
    -f "previous_artifact_name=${previous_artifact_name}" \
    -f "quality_run_id=${quality_run_id}"
  for _attempt in {1..12}; do
    release_run_record="$(find_release_run)"
    if [[ -n "$release_run_record" ]]; then
      run_created_at="${release_run_record##*$'\t'}"
      [[ "$run_created_at" < "$dispatch_started" ]] || break
      release_run_record=''
    fi
    sleep 5
  done
  [[ -n "$release_run_record" ]] || fail '已派发制品工作流，但未能定位对应运行'
fi

IFS=$'\t' read -r release_run_id release_run_status release_run_conclusion release_run_url \
  _created_at <<<"$release_run_record"
case "$release_run_status:$release_run_conclusion" in
  completed:success)
    echo "复用已成功验证的制品运行：${release_run_id}"
    ;;
  completed:failure)
    release_run_attempt="$(gh api "repos/{owner}/{repo}/actions/runs/${release_run_id}" --jq .run_attempt)"
    if [[ ! "$release_run_attempt" =~ ^[0-9]+$ || "$release_run_attempt" -ge 2 ]]; then
      fail '该版本失败任务已重跑过；请通过修复 PR 产生新 SHA，禁止继续循环重跑'
    fi
    echo "同一版本制品运行失败，仅重跑失败任务一次：${release_run_id}"
    gh run rerun "$release_run_id" --failed
    gh run watch "$release_run_id" --exit-status ||
      fail '失败任务重跑后仍未通过；请通过修复 PR 产生新 SHA 后重新验证，禁止循环重跑'
    ;;
  completed:*)
    fail "制品运行状态为 ${release_run_conclusion:-unknown}，不自动整条重跑"
    ;;
  *)
    echo "等待现有制品运行完成：${release_run_id}"
    gh run watch "$release_run_id" --exit-status ||
      fail '制品运行失败；再次调用入口将只重跑失败任务一次'
    ;;
esac

final_conclusion="$(gh run view "$release_run_id" --json conclusion --jq .conclusion)"
[[ "$final_conclusion" == success ]] || fail '不可变制品未成功验证，拒绝进入部署'
echo "制品已验证：${release_run_url}"
exec bash scripts/deploy-aws-incremental-release.sh "$release_tag"
