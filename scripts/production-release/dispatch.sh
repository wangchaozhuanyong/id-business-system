#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
[[ "$EXPECTED_CURRENT" =~ ^[0-9a-f]{40}$ ]]
[[ "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]]
[[ "$QUALITY_RUN_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$RELEASE_REPOSITORY" =~ ^[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release$ ]]

mkdir -p .deploy/production-release
parameters_file=".deploy/production-release/ssm-${GITHUB_RUN_ID}.json"
python3 - "$parameters_file" <<'PY'
import json
import os
import sys

sha = os.environ['RELEASE_COMMIT']
repo = os.environ['RELEASE_REPOSITORY']
previous = os.environ['EXPECTED_CURRENT']
run_id = os.environ['GITHUB_RUN_ID']
attempt = os.environ['GITHUB_RUN_ATTEMPT']
tree = os.environ['SOURCE_TREE']
quality_run = os.environ['QUALITY_RUN_ID']
admin_only = os.environ.get('RELEASE_ADMIN_ONLY', 'false')
assert admin_only in ('true', 'false')
scope_flag = ' --admin-only' if admin_only == 'true' else ''
image_commit = os.environ.get('REUSE_IMAGE_COMMIT', sha)
image_run = os.environ.get('REUSE_IMAGE_RUN_ID', run_id)
image_attempt = os.environ.get('REUSE_IMAGE_RUN_ATTEMPT', attempt)
import re
assert re.fullmatch(r'[0-9a-f]{40}', image_commit)
assert re.fullmatch(r'[1-9][0-9]*', image_run)
assert re.fullmatch(r'[1-9][0-9]*', image_attempt)
image_flags = f' --image-commit {image_commit} --image-run-id {image_run} --image-run-attempt {image_attempt}'
script_path = f'/opt/id-business-v2/.staging/oidc-{sha}/remote-deploy.py'
url = f'https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{sha}/scripts/production-release/remote-deploy.py'
commands = [
    'set -eu',
    f'mkdir -p /opt/id-business-v2/.staging/oidc-{sha}',
    f'curl -fsSL --retry 3 --max-time 30 {url} -o {script_path}',
    f'python3 {script_path} --commit {sha} --source-tree {tree} --repository {repo} --expected-current {previous} --run-id {run_id} --run-attempt {attempt} --ci-run-id {quality_run}{scope_flag}{image_flags}',
]
with open(sys.argv[1], 'w', encoding='utf-8') as target:
    json.dump({'commands': commands, 'executionTimeout': ['3600']}, target)
PY

command_id="$(aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "$PRODUCTION_INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters "file://${parameters_file}" --timeout-seconds 3600 \
  --comment "ID business release ${RELEASE_COMMIT}" \
  --query 'Command.CommandId' --output text)"
echo "Production command: $command_id"

for attempt in $(seq 1 360); do
  status="$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" \
    --query Status --output text 2>/dev/null || true)"
  case "$status" in
    Success)
      aws ssm get-command-invocation --region "$AWS_REGION" \
        --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" \
        --query StandardOutputContent --output text
      exit 0 ;;
    Failed|Cancelled|TimedOut|Cancelling)
      aws ssm get-command-invocation --region "$AWS_REGION" \
        --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" \
        --query StandardOutputContent --output text
      echo "Production command ended: $status" >&2
      exit 1 ;;
  esac
  sleep 10
done
echo 'Production command polling timed out' >&2
exit 1
