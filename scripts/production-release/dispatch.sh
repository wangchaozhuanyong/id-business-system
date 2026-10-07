#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/validate-release-selection.sh"
[[ "${RELEASE_OPERATION:-release}" == release || "${RELEASE_OPERATION:-release}" == release_api_admin ]] || exit 1

[[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$EXPECTED_CURRENT" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$QUALITY_RUN_ID" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ "$RELEASE_REPOSITORY" =~ ^[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release$ ]] || exit 1

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-92-20261007 ]]; then
  test "$EXPECTED_CURRENT" = 974c62cc1681012ecff897aefc90d2cd9900004a
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-92-20261007
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-90-20261007 ]]; then
  test "$EXPECTED_CURRENT" = c3cad767b372738b2193e60584b0a53daa53b65f
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-90-20261007
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-94-20261007 ]]; then
  test "$EXPECTED_CURRENT" = 815fae391b172d6c368ea2ad25225f52a1272808
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-94-20261007
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-93-20261007 ]]; then
  test "$EXPECTED_CURRENT" = 2f24cf81007429ea474da404a30bc74da9d43ce1
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-93-20261007
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-91-20261007 ]]; then
  test "$EXPECTED_CURRENT" = 01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-91-20261007
fi


if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-89-20261006 ]]; then
  test "$EXPECTED_CURRENT" = d2e22e623d0e19851c79ffe43396f5f97a99b8d3
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-89-20261006
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-88-20261006 ]]; then
  test "$EXPECTED_CURRENT" = 4c200c4ae08bb8214ff8e0955f8237ce85069cc6
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-88-20261006
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-87-20261006 ]]; then
  test "$EXPECTED_CURRENT" = 651f62902fba74ddd189b34932084573b39d245c
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-87-20261006
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-86-20261006 ]]; then
  test "$EXPECTED_CURRENT" = fd3a6da610c505c2b7a51601cf854182991ffd12
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-86-20261006
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-85-20261006 ]]; then
  test "$EXPECTED_CURRENT" = 85e94572cd965dd993743d12d55a3e91d60b6444
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-85-20261006
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-956-20261006 ]]; then
  test "$EXPECTED_CURRENT" = 9560d8038a39d4ded1e560d484bdcb941a5d9c43
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-956-20261006
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-b8-80-20261006 ]]; then
  test "$EXPECTED_CURRENT" = 80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-4c-20261008 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 4c170e661c871dc14dccc98a8d6e5cf983141341
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}"
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
fi
if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-2f-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 2f24cf81007429ea474da404a30bc74da9d43ce1
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-974-20261007 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 974c62cc1681012ecff897aefc90d2cd9900004a
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-b8-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-menu-7f-20261005 || "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-main80-20261006 ]]; then
  case "$HISTORICAL_EXCEPTION" in
    recharge-pro-menu-b8-20261005) test "$EXPECTED_CURRENT" = b8d643450ffa9012ccc09ead15e4681e3dee98d0 ;;
    recharge-pro-menu-7f-20261005) test "$EXPECTED_CURRENT" = 7f70688b9bf53a071a0a324ca558aeabc4ced2e3 ;;
    recharge-pro-main80-20261006) test "$EXPECTED_CURRENT" = b91b626a71ed2c7c2473d080551b3b10b693b0cb ;;
    *) exit 1 ;;
  esac
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
fi

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
                         'historical-finance-20261005-mailbox-batch',
                         'recharge-pro-menu-b8-20261005',
                         'recharge-pro-menu-7f-20261005',
                         'recharge-pro-main80-20261006',
                         'recharge-pro-974-20261007',
                         'recharge-pro-2f-20261007',
                         'recharge-pro-4c-20261008',
                         'registration-worker-b8-80-20261006',
                         'registration-worker-956-20261006',
                         'registration-worker-85-20261006',
                         'registration-worker-86-20261006',
                         'registration-worker-87-20261006',
                         'registration-worker-88-20261006',
                         'registration-worker-89-20261006',
                         'registration-worker-90-20261007',
                         'registration-worker-91-20261007',
                         'registration-worker-92-20261007', 'registration-worker-93-20261007', 'registration-worker-94-20261007',
                         'historical-finance-20261005-order-archive',
                         'historical-finance-20261005-post-cleanup')
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
elif history_policy == 'recharge-pro-menu-b8-20261005':
    assert previous == 'b8d643450ffa9012ccc09ead15e4681e3dee98d0' and admin_only == 'false'
    scope_flag += ' --recharge-pro-menu-b8'
elif history_policy == 'recharge-pro-menu-7f-20261005':
    assert previous == '7f70688b9bf53a071a0a324ca558aeabc4ced2e3' and admin_only == 'false'
    scope_flag += ' --recharge-pro-menu-7f'
elif history_policy == 'recharge-pro-main80-20261006':
    assert previous == 'b91b626a71ed2c7c2473d080551b3b10b693b0cb' and admin_only == 'false'
    scope_flag += ' --recharge-pro-main80'
elif history_policy == 'recharge-pro-4c-20261008':
    assert previous == '4c170e661c871dc14dccc98a8d6e5cf983141341' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256'))
    assert not os.environ.get('RELEASE_BROWSER_CACHE_IMAGE') and not os.environ.get('RELEASE_BROWSER_CACHE_IMAGE_ID')
    scope_flag += ' --recharge-pro-d3fb'
elif history_policy == 'recharge-pro-2f-20261007':
    assert previous == '2f24cf81007429ea474da404a30bc74da9d43ce1' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256'))
    scope_flag += ' --recharge-pro-2f'
elif history_policy == 'recharge-pro-974-20261007':
    assert previous == '974c62cc1681012ecff897aefc90d2cd9900004a' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256'))
    scope_flag += ' --recharge-pro-974'
elif history_policy == 'registration-worker-b8-80-20261006':
    assert previous == '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-b8-80'
elif history_policy == 'registration-worker-956-20261006':
    assert previous == '9560d8038a39d4ded1e560d484bdcb941a5d9c43' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-956'
elif history_policy == 'registration-worker-85-20261006':
    assert previous == '85e94572cd965dd993743d12d55a3e91d60b6444' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-85'
elif history_policy == 'registration-worker-86-20261006':
    assert previous == 'fd3a6da610c505c2b7a51601cf854182991ffd12' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-86'
elif history_policy == 'registration-worker-87-20261006':
    assert previous == '651f62902fba74ddd189b34932084573b39d245c' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-87'
elif history_policy == 'registration-worker-88-20261006':
    assert previous == '4c200c4ae08bb8214ff8e0955f8237ce85069cc6' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-88'
elif history_policy == 'registration-worker-92-20261007':
    assert previous == '974c62cc1681012ecff897aefc90d2cd9900004a' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-92'
elif history_policy == 'registration-worker-94-20261007':
    assert previous == '815fae391b172d6c368ea2ad25225f52a1272808' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-94'
elif history_policy == 'registration-worker-93-20261007':
    assert previous == '2f24cf81007429ea474da404a30bc74da9d43ce1' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-93'
elif history_policy == 'registration-worker-91-20261007':
    assert previous == '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-91'
elif history_policy == 'registration-worker-89-20261006':
    assert previous == 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-89'
elif history_policy == 'registration-worker-90-20261007':
    assert previous == 'c3cad767b372738b2193e60584b0a53daa53b65f' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-90'
elif history_policy == 'historical-finance-20261005-post-cleanup':
    # The shared entry guard has already verified the baseline, scope and seal.
    assert os.environ.get('RELEASE_OPERATION', 'release') == 'release'
    assert os.environ.get('REUSE_IMAGE_COMMIT') == sha
    assert os.environ.get('REUSE_IMAGE_RUN_ID') == os.environ['REUSE_IMAGE_RUN']
    assert __import__('re').fullmatch(r'[1-9][0-9]*', os.environ.get('REUSE_IMAGE_RUN_ATTEMPT', ''))
    scope_flag += ' --historical-finance-post-cleanup --post-cleanup-seal-sha256 ' + os.environ['POST_CLEANUP_SEAL_SHA256']
elif history_policy == 'historical-finance-20261005-order-archive':
    assert previous == '3ca300486d0edfadda83c094a48474a63959fce7'
    assert os.environ.get('RELEASE_OPERATION', 'release') == 'release'
    assert admin_only == 'false' and os.environ.get('REUSE_IMAGE_COMMIT') == sha
    assert os.environ.get('REUSE_IMAGE_RUN_ID') == os.environ['REUSE_IMAGE_RUN']
    assert __import__('re').fullmatch(r'[1-9][0-9]*', os.environ.get('REUSE_IMAGE_RUN_ATTEMPT', ''))
    assert __import__('re').fullmatch(r'[a-f0-9]{64}', os.environ.get('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256', ''))
    scope_flag += (' --historical-finance-order-archive --order-archive-seal-sha256 '
                   + os.environ['ORDER_ARCHIVE_SEAL_SHA256']
                   + ' --order-archive-prepared-images-sha256 ' + os.environ['ORDER_ARCHIVE_PREPARED_IMAGES_SHA256'])
if history_policy in ('registration-worker-b8-80-20261006', 'registration-worker-956-20261006', 'registration-worker-85-20261006', 'registration-worker-86-20261006', 'registration-worker-87-20261006', 'registration-worker-88-20261006', 'registration-worker-89-20261006', 'registration-worker-90-20261007', 'registration-worker-91-20261007', 'registration-worker-92-20261007', 'registration-worker-93-20261007', 'registration-worker-94-20261007'):
    image_commit, image_run, image_attempt = sha, run_id, attempt
else:
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
api_admin = os.environ.get('RELEASE_OPERATION') == 'release_api_admin'
if api_admin:
    import base64
    from pathlib import Path
    scope_flag = ' --api-admin-only --api-admin-build-proof ' + base64.b64encode(Path('.deploy/production-release/api-admin-build-proof.json').read_bytes()).decode()
    image_flags = ''
commands = [
    'set -eu',
    f'mkdir -p /opt/id-business-v2/.staging/oidc-{sha}',
    f'curl -fsSL --retry 3 --max-time 30 {url} -o {script_path}',
    f'python3 {script_path} --commit {sha} --source-tree {tree} --repository {repo} --expected-current {previous} --run-id {run_id} --run-attempt {attempt} --ci-run-id {quality_run}{scope_flag}{image_flags}',
]
if api_admin:
    import hashlib
    pinned = []
    for name in ('remote-deploy.py', 'api-admin-scope.py'):
        digest = hashlib.sha256(Path('scripts/production-release', name).read_bytes()).hexdigest()
        target_path = f'/opt/id-business-v2/.staging/oidc-{sha}/{name}'
        pinned.extend([f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{sha}/scripts/production-release/{name} -o {target_path}',
                       f'echo "{digest}  {target_path}" | sha256sum -c - >/dev/null'])
    commands[2:3] = pinned
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
