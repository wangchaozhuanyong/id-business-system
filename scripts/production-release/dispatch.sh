#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/validate-release-selection.sh"
[[ "${RELEASE_OPERATION:-release}" == release_online_recharge || "${RELEASE_OPERATION:-release}" == release_api_workspace || "${RELEASE_OPERATION:-release}" == release || "${RELEASE_OPERATION:-release}" == release_api_admin || "${RELEASE_OPERATION:-release}" == release_api_admin_migration || "${RELEASE_OPERATION:-release}" == release_api_registration ]] || exit 1

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

if [[ "${HISTORICAL_EXCEPTION:-none}" == registration-worker-95-20261008 ]]; then
  test "$EXPECTED_CURRENT" = 4c170e661c871dc14dccc98a8d6e5cf983141341
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-registration-scope --registration-profile registration-worker-95-20261008
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

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-pricing-045-20261008 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = e7c9862d58599995954883f1c1f6038283afffab
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}"
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
fi

if [[ "${HISTORICAL_EXCEPTION:-none}" == recharge-pro-6f5-20261008 ]]; then
  test "${RELEASE_OPERATION:-release}" = release
  test "$EXPECTED_CURRENT" = 6f5e5cc252886d5f86592e307147b40c13577585
  test "${RELEASE_ADMIN_ONLY:-false}" = false
  test -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}"
  test -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}"
  python3 "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" --check-fixed-recharge-scope --fixed-recharge-profile "$HISTORICAL_EXCEPTION"
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
                         'recharge-pro-6f5-20261008',
                         'recharge-pro-pricing-045-20261008',
                         'registration-worker-b8-80-20261006',
                         'registration-worker-956-20261006',
                         'registration-worker-85-20261006',
                         'registration-worker-86-20261006',
                         'registration-worker-87-20261006',
                         'registration-worker-88-20261006',
                         'registration-worker-89-20261006',
                         'registration-worker-90-20261007',
                         'registration-worker-91-20261007',
                         'registration-worker-92-20261007', 'registration-worker-93-20261007', 'registration-worker-94-20261007', 'registration-worker-95-20261008', 'registration-worker-96-20261008',
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
elif history_policy == 'recharge-pro-pricing-045-20261008':
    assert previous == 'e7c9862d58599995954883f1c1f6038283afffab' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256'))
    assert not os.environ.get('RELEASE_BROWSER_CACHE_IMAGE') and not os.environ.get('RELEASE_BROWSER_CACHE_IMAGE_ID')
    scope_flag += ' --recharge-pro-pricing'
elif history_policy == 'recharge-pro-6f5-20261008':
    assert previous == '6f5e5cc252886d5f86592e307147b40c13577585' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256'))
    assert not os.environ.get('RELEASE_BROWSER_CACHE_IMAGE') and not os.environ.get('RELEASE_BROWSER_CACHE_IMAGE_ID')
    scope_flag += ' --recharge-pro-6f5'
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
elif history_policy == 'registration-worker-96-20261008':
    assert previous == '04570d75c779fd91a0933ef9416f6d62698b6b91' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
        'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID'))
    scope_flag += ' --registration-worker-96'
elif history_policy == 'registration-worker-95-20261008':
    assert previous == '4c170e661c871dc14dccc98a8d6e5cf983141341' and admin_only == 'false'
    assert not any(os.environ.get(key) for key in (
        'REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'))
    scope_flag += ' --registration-worker-95'
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
if history_policy in ('registration-worker-b8-80-20261006', 'registration-worker-956-20261006', 'registration-worker-85-20261006', 'registration-worker-86-20261006', 'registration-worker-87-20261006', 'registration-worker-88-20261006', 'registration-worker-89-20261006', 'registration-worker-90-20261007', 'registration-worker-91-20261007', 'registration-worker-92-20261007', 'registration-worker-93-20261007', 'registration-worker-94-20261007', 'registration-worker-95-20261008', 'registration-worker-96-20261008'):
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
online_recharge = os.environ.get('RELEASE_OPERATION') == 'release_online_recharge'
api_admin = os.environ.get('RELEASE_OPERATION') in ('release_api_workspace', 'release_api_admin', 'release_api_admin_migration', 'release_api_registration')
if api_admin:
    import base64
    from pathlib import Path
    scope_name = {'release_api_workspace': 'api-workspace', 'release_api_registration': 'api-registration', 'release_api_admin_migration': 'api-admin-migration'}.get(os.environ['RELEASE_OPERATION'], 'api-admin')
    scope_flag = ' --' + scope_name + '-only --api-admin-build-proof ' + base64.b64encode(Path('.deploy/production-release/' + scope_name + '-build-proof.json').read_bytes()).decode()
    image_flags = ''
if online_recharge:
    import base64
    from pathlib import Path
    scope_flag = ' --online-recharge-only --online-recharge-build-proof ' + base64.b64encode(Path('.deploy/production-release/online-recharge-build-proof.json').read_bytes()).decode()
    image_flags = ''
commands = [
    'set -eu',
    f'mkdir -p /opt/id-business-v2/.staging/oidc-{sha}',
    f'curl -fsSL --retry 3 --max-time 30 {url} -o {script_path}',
    f'python3 {script_path} --commit {sha} --source-tree {tree} --repository {repo} --expected-current {previous} --run-id {run_id} --run-attempt {attempt} --ci-run-id {quality_run}{scope_flag}{image_flags}',
]
if history_policy == 'registration-worker-96-20261008':
    import hashlib, shlex, stat
    from pathlib import Path
    profile_name = 'registration-worker-96-20261008.json'
    module_name = 'registration-onboarding-96.py'
    baseline_name = 'registration-baseline-96-20261008.json'
    carriers = (
        (Path('scripts/production-release/remote-deploy.py'), Path(script_path), 1024 * 1024),
        (Path('deploy/aws') / profile_name, Path(script_path).with_name(profile_name), 128 * 1024),
        (Path('scripts/production-release') / module_name, Path(script_path).with_name(module_name), 128 * 1024),
        (Path('deploy/aws') / baseline_name, Path(script_path).with_name(baseline_name), 4 * 1024 * 1024),
    )
    def local_carrier(path, cap):
        path = path.absolute()
        assert path.resolve() == path
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        initial = path.lstat()
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
            before = os.fstat(stream.fileno())
            assert identity(initial) == identity(before) and stat.S_ISREG(before.st_mode)
            assert before.st_nlink == 1 and stat.S_IMODE(before.st_mode) in (0o644, 0o664) and 0 < before.st_size <= cap
            raw = stream.read(cap + 1)
            assert len(raw) == before.st_size and identity(before) == identity(os.fstat(stream.fileno())) == identity(path.lstat())
        return raw
    raw_carriers = [local_carrier(path, cap) for path, _, cap in carriers]
    baseline_hash = hashlib.sha256(raw_carriers[3]).hexdigest()
    def unique96(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('Fixed96 duplicate field')
            result[key] = value
        return result
    profile = json.loads(raw_carriers[1], object_pairs_hook=unique96)
    assert profile['enabled'] is True and profile['id'] == history_policy and profile['baselineCarrierSha256'] == baseline_hash
    commands[-1] += ' --registration96-baseline-sha256 ' + baseline_hash
    targets = [str(target) for _, target, _ in carriers]
    guard = ('import pathlib,stat;d=pathlib.Path(' + repr(str(Path(script_path).parent)) + ');'
        + '\nfor p in [d,d.parent,d.parent.parent]:\n if p.resolve()!=p or p.is_symlink():raise RuntimeError("Fixed96 staging changed")\n'
        + 'for p in [pathlib.Path(n) for n in ' + repr(targets) + ']:\n if p.is_symlink() or (p.exists() and (not p.is_file() or p.stat().st_nlink!=1)):raise RuntimeError("Fixed96 carrier changed")')
    verify = '''import hashlib,os,pathlib,stat
def read96(name,cap,expected):
    p=pathlib.Path(name)
    if p.resolve()!=p or p.parent.resolve()!=p.parent:raise RuntimeError('Fixed96 carrier path changed')
    identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    initial=p.lstat()
    with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        before=os.fstat(f.fileno())
        if identity(initial)!=identity(before) or not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode)!=0o644 or before.st_nlink!=1 or before.st_uid!=0 or not 0<before.st_size<=cap:raise RuntimeError('Fixed96 carrier stat changed')
        raw=f.read(cap+1)
        if len(raw)!=before.st_size or identity(before)!=identity(os.fstat(f.fileno())) or identity(before)!=identity(p.lstat()):raise RuntimeError('Fixed96 carrier read changed')
    if hashlib.sha256(raw).hexdigest()!=expected:raise RuntimeError('Fixed96 carrier hash changed')
'''
    verify += '\n'.join('read96(' + repr(str(target)) + ',' + str(cap) + ',' + repr(hashlib.sha256(raw).hexdigest()) + ')'
        for (_, target, cap), raw in zip(carriers, raw_carriers))
    downloads = []
    for path, target, _ in carriers:
        downloads.append(f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{sha}/{path.as_posix()} -o {target}')
    commands[1:3] = ['python3 -c ' + shlex.quote(guard), commands[1], *downloads,
        'chmod 0644 ' + ' '.join(targets), 'python3 -c ' + shlex.quote(verify)]
if history_policy == 'registration-worker-95-20261008':
    import hashlib, shlex
    from pathlib import Path
    source_raw=Path('scripts/production-release/remote-deploy.py').read_bytes()
    profile_name='registration-worker-95-20261008.json'
    module_name='registration-interstitial-95.py'
    profile_raw=Path('deploy/aws',profile_name).read_bytes()
    module_raw=Path('scripts/production-release',module_name).read_bytes()
    assert len(source_raw)<=1024*1024 and len(profile_raw)<=128*1024 and len(module_raw)<=128*1024
    profile_target=str(Path(script_path).parent/profile_name)
    module_target=str(Path(script_path).parent/module_name)
    guard=('import pathlib,stat;paths=[pathlib.Path('+repr(str(Path(script_path).parent))+')];'
        +'\nfor p in [paths[0],paths[0].parent,paths[0].parent.parent]:\n if p.resolve()!=p or p.is_symlink():raise RuntimeError("Fixed95 staging location changed")\n'
        +'for p in [pathlib.Path('+repr(script_path)+'),pathlib.Path('+repr(profile_target)+'),pathlib.Path('+repr(module_target)+')]:\n if p.is_symlink() or (p.exists() and (not p.is_file() or p.stat().st_nlink!=1)):raise RuntimeError("Fixed95 staging carrier changed")')
    verify=('import hashlib,pathlib;\n'+"import os,stat\n\ndef read95(path, cap, expected):\n    if path.resolve()!=path or path.is_symlink() or path.parent.resolve()!=path.parent:raise RuntimeError('Fixed95 carrier path changed')\n    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)\n    with os.fdopen(fd,'rb')as stream:\n        before=os.fstat(stream.fileno())\n        identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_ctime_ns)\n        if not stat.S_ISREG(before.st_mode)or stat.S_IMODE(before.st_mode)!=0o644 or before.st_nlink!=1 or before.st_size>cap:raise RuntimeError('Fixed95 carrier stat changed')\n        raw=stream.read(cap+1)\n        if len(raw)>cap or identity(before)!=identity(os.fstat(stream.fileno())) or identity(before)!=identity(os.stat(path,follow_symlinks=False)):raise RuntimeError('Fixed95 carrier read changed')\n    if hashlib.sha256(raw).hexdigest()!=expected:raise RuntimeError('Fixed95 carrier hash changed')\n    return raw\n"
        +'p=pathlib.Path('+repr(script_path)+');q=pathlib.Path('+repr(profile_target)+');m=pathlib.Path('+repr(module_target)+');'
        +'b=read95(p,1024*1024,'+repr(hashlib.sha256(source_raw).hexdigest())+');'
        +'read95(q,128*1024,'+repr(hashlib.sha256(profile_raw).hexdigest())+');'
        +'read95(m,128*1024,'+repr(hashlib.sha256(module_raw).hexdigest())+');'
        +'n={"__name__":"fixed95_staging_verify","__file__":str(p)};exec(compile(b,str(p),"exec"),n);'
        +'n["load_registration_interstitial95"]();'
        +'n["registration_interstitial_verify_carrier"]('+repr(hashlib.sha256(source_raw).hexdigest())+','+repr(hashlib.sha256(profile_raw).hexdigest())+')')
    commands[1:3]=['python3 -c '+shlex.quote(guard),commands[1],commands[2],
        f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{sha}/deploy/aws/{profile_name} -o {profile_target}',
        f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{sha}/scripts/production-release/{module_name} -o {module_target}',
        f'chmod 0644 {script_path} {profile_target} {module_target}','python3 -c '+shlex.quote(verify)]
if api_admin or online_recharge:
    import hashlib
    pinned = []
    for name in (('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py', 'online-recharge-recovery.json') if online_recharge else ('remote-deploy.py', 'api-admin-scope.py')):
        digest = hashlib.sha256(Path('scripts/production-release', name).read_bytes()).hexdigest()
        target_path = f'/opt/id-business-v2/.staging/oidc-{sha}/{name}'
        pinned.extend([f'curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/{sha}/scripts/production-release/{name} -o {target_path}',
                       f'echo "{digest}  {target_path}" | sha256sum -c - >/dev/null'])
    commands[2:3] = pinned
if online_recharge or history_policy == 'registration-worker-96-20261008':
    assert len(json.dumps({'commands': commands, 'executionTimeout': ['3600']}).encode('utf-8')) < 48 * 1024
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
      if [[ "${RELEASE_OPERATION:-release}" == release_online_recharge ]]; then
        aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" --output json \
          | python3 -B scripts/production-release/online-recharge-readonly.py filter-deploy
        exit 0
      fi
      aws ssm get-command-invocation --region "$AWS_REGION" \
        --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" \
        --query StandardOutputContent --output text
      exit 0 ;;
    Failed|Cancelled|TimedOut|Cancelling)
      if [[ "${RELEASE_OPERATION:-release}" == release_online_recharge ]]; then
        aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$PRODUCTION_INSTANCE_ID" --output json \
          | python3 -B scripts/production-release/online-recharge-readonly.py filter-deploy
        exit 1
      fi
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
