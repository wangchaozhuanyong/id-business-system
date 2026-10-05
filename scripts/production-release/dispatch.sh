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
history_policy = os.environ.get('HISTORICAL_EXCEPTION', 'none')
assert history_policy in ('none', 'historical-finance-20261005',
                         'historical-finance-20261005-registration-continuation',
                         'historical-finance-20261005-recharge-diagnostics',
                         'historical-finance-20261005-maintenance-continuation',
                         'historical-finance-20261005-mailbox-batch')
if history_policy == 'historical-finance-20261005':
    assert previous == 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
    scope_flag += ' --historical-finance-exception'
elif history_policy == 'historical-finance-20261005-registration-continuation':
    assert previous == 'd0f359dc78b2d2b166893bfec8545609f5baa16d'
    scope_flag += ' --historical-finance-continuation'
elif history_policy == 'historical-finance-20261005-recharge-diagnostics':
    assert previous == '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
    assert admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --historical-finance-recharge-diagnostics'
elif history_policy == 'historical-finance-20261005-maintenance-continuation':
    assert previous == '6a82a774f2a65e00d4f260c629f7152bf7935d1d'
    assert admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --historical-finance-maintenance-continuation'
image_commit = os.environ.get('REUSE_IMAGE_COMMIT', sha)
image_run = os.environ.get('REUSE_IMAGE_RUN_ID', run_id)
image_attempt = os.environ.get('REUSE_IMAGE_RUN_ATTEMPT', attempt)
import re
assert re.fullmatch(r'[0-9a-f]{40}', image_commit)
assert re.fullmatch(r'[1-9][0-9]*', image_run)
assert re.fullmatch(r'[1-9][0-9]*', image_attempt)
if history_policy == 'historical-finance-20261005-mailbox-batch':
    assert previous == 'b8d643450ffa9012ccc09ead15e4681e3dee98d0' and admin_only == 'false'
    assert (image_commit, image_run, image_attempt) == ('f5826f9fb4ad0d846d9875c035c913a61eb68290', '37312405714', '1')
    scope_flag += ' --historical-finance-mailbox-batch'
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
      aws ssm get-command-invocation --region "$AWS_REGION" \
        --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" --output json \
        | python3 scripts/production-release/remote-deploy.py --summarize-command-result
      echo "Production command ended: $status" >&2
      exit 1 ;;
  esac
  sleep 10
done
echo 'Production command polling timed out' >&2
exit 1
