#!/usr/bin/env bash
set -Eeuo pipefail

read_registration_admin_projection() {
  python3 - <<'PY_ADMIN_PROJECTION'
import json, re
from pathlib import Path

def unique(items):
    values = {}
    for key, value in items:
        if key in values:
            raise ValueError('Fixed registration Admin projection changed')
        values[key] = value
    return values

raw = Path('.deploy/production-release/registration-build-projection.json').read_bytes()
if len(raw) > 128 * 1024:
    raise SystemExit('Fixed registration Admin projection unavailable')
value = json.loads(raw, object_pairs_hook=unique)
if (value.get('adminContextPath') != '.deploy/production-release/registration-admin-build-context'
        or not isinstance(value.get('adminProjectionSha256'), str)
        or not re.fullmatch(r'[a-f0-9]{64}', value['adminProjectionSha256'])):
    raise SystemExit('Fixed registration Admin projection unavailable')
print(value['adminProjectionSha256'])
PY_ADMIN_PROJECTION
}

read_registration_recovery_projection() {
  TASK_REGISTRATION_PROJECTION_KIND="$1" python3 - <<'PY_RECOVERY_PROJECTION'
import json, os, re
from pathlib import Path

def unique(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('Fixed registration recovery projection changed')
        value[key] = item
    return value

raw = Path('.deploy/production-release/registration-build-projection.json').read_bytes()
if len(raw) > 128 * 1024:
    raise SystemExit('Fixed registration recovery projection unavailable')
value = json.loads(raw, object_pairs_hook=unique)
profile = json.loads(Path('deploy/aws/registration-worker-92-20261007.json').read_bytes(), object_pairs_hook=unique)
kind = os.environ['TASK_REGISTRATION_PROJECTION_KIND']
keys = {'version', 'id', 'sourceCommit', 'sourceTree', 'registrationSourceCommit', 'workerBasisCommit',
    'workerProjectionSha256', 'apiBasisCommit', 'apiBasisProjectionSha256', 'apiProjectionSha256',
    'registrationSourceSha256', 'validationSourceSha256', 'contextPath', 'apiContextPath', 'apiCompiledSourceSha256', 'apiCompiledSourceProjectionSha256'}
if (kind not in ('api', 'worker', 'api-compiled') or set(value) != keys or type(value['version']) is not int
        or value['version'] != 1 or value['id'] != 'registration-worker-92-20261007'
        or profile.get('enabled') is not True or value['sourceCommit'] != os.environ['RELEASE_COMMIT']
        or not re.fullmatch(r'[a-f0-9]{40}', value['sourceTree'])
        or value['registrationSourceCommit'] != profile['registrationSourceCommit']
        or value['workerBasisCommit'] != profile['workerBasisCommit']
        or value['apiBasisCommit'] != profile['apiBasisCommit']
        or value['apiBasisProjectionSha256'] != profile['apiBasisProjectionSha256']
        or value['registrationSourceSha256'] != profile['registrationSourceSha256']
        or value['validationSourceSha256'] != profile['validationSourceSha256']
        or value['apiCompiledSourceSha256'] != profile['apiCompiledSourceSha256']
        or value['contextPath'] != '.deploy/production-release/registration-build-context'
        or value['apiContextPath'] != '.deploy/production-release/registration-api-build-context'
        or any(not isinstance(value[key], str) or not re.fullmatch(r'[a-f0-9]{64}', value[key])
            or value[key] != profile[key] for key in ('apiProjectionSha256', 'workerProjectionSha256', 'apiCompiledSourceProjectionSha256'))):
    raise SystemExit('Fixed registration recovery projection unavailable')
print(value['apiCompiledSourceProjectionSha256'] if kind == 'api-compiled' else value[kind + 'ProjectionSha256'])
PY_RECOVERY_PROJECTION
}

read_registration_interstitial_projection() {
  python3 - <<'PY_FOLLOWUP_PROJECTION'
import json, os, re
from pathlib import Path

def unique(items):
    value = {}
    for key, item in items:
        if key in value: raise ValueError('Fixed login projection changed')
        value[key] = item
    return value
raw = Path('.deploy/production-release/registration-build-projection.json').read_bytes()
if len(raw) > 128 * 1024: raise SystemExit('Fixed login projection unavailable')
v = json.loads(raw, object_pairs_hook=unique)
p = json.loads(Path('deploy/aws/registration-worker-95-20261008.json').read_bytes(), object_pairs_hook=unique)
keys = {'version', 'id', 'sourceCommit', 'sourceTree', 'registrationSourceCommit', 'workerBasisCommit',
    'workerProjectionSha256', 'registrationSourceSha256', 'validationSourceSha256', 'contextPath'}
if (set(v) != keys or type(v['version']) is not int or v['version'] != 1
        or v['id'] != 'registration-worker-95-20261008' or p.get('enabled') is not True
        or v['sourceCommit'] != os.environ['RELEASE_COMMIT'] or not re.fullmatch(r'[a-f0-9]{40}', v['sourceTree'])
        or v['contextPath'] != '.deploy/production-release/registration-build-context'
        or not isinstance(v['workerProjectionSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', v['workerProjectionSha256'])
        or any(v[k] != p[k] for k in ('registrationSourceCommit', 'workerBasisCommit', 'workerProjectionSha256',
            'registrationSourceSha256', 'validationSourceSha256'))):
    raise SystemExit('Fixed login projection unavailable')
print(v['workerProjectionSha256'])
PY_FOLLOWUP_PROJECTION
}

read_registration_followup_projection() {
  python3 - <<'PY_FOLLOWUP_PROJECTION'
import json, os, re
from pathlib import Path

def unique(items):
    value = {}
    for key, item in items:
        if key in value: raise ValueError('Fixed login projection changed')
        value[key] = item
    return value
raw = Path('.deploy/production-release/registration-build-projection.json').read_bytes()
if len(raw) > 128 * 1024: raise SystemExit('Fixed login projection unavailable')
v = json.loads(raw, object_pairs_hook=unique)
p = json.loads(Path('deploy/aws/registration-worker-94-20261007.json').read_bytes(), object_pairs_hook=unique)
keys = {'version', 'id', 'sourceCommit', 'sourceTree', 'registrationSourceCommit', 'workerBasisCommit',
    'workerProjectionSha256', 'registrationSourceSha256', 'validationSourceSha256', 'contextPath'}
if (set(v) != keys or type(v['version']) is not int or v['version'] != 1
        or v['id'] != 'registration-worker-94-20261007' or p.get('enabled') is not True
        or v['sourceCommit'] != os.environ['RELEASE_COMMIT'] or not re.fullmatch(r'[a-f0-9]{40}', v['sourceTree'])
        or v['contextPath'] != '.deploy/production-release/registration-build-context'
        or not isinstance(v['workerProjectionSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', v['workerProjectionSha256'])
        or any(v[k] != p[k] for k in ('registrationSourceCommit', 'workerBasisCommit', 'workerProjectionSha256',
            'registrationSourceSha256', 'validationSourceSha256'))):
    raise SystemExit('Fixed login projection unavailable')
print(v['workerProjectionSha256'])
PY_FOLLOWUP_PROJECTION
}

read_registration_login_projection() {
  python3 - <<'PY_LOGIN_PROJECTION'
import json, os, re
from pathlib import Path

def unique(items):
    value = {}
    for key, item in items:
        if key in value: raise ValueError('Fixed login projection changed')
        value[key] = item
    return value
raw = Path('.deploy/production-release/registration-build-projection.json').read_bytes()
if len(raw) > 128 * 1024: raise SystemExit('Fixed login projection unavailable')
v = json.loads(raw, object_pairs_hook=unique)
p = json.loads(Path('deploy/aws/registration-worker-93-20261007.json').read_bytes(), object_pairs_hook=unique)
keys = {'version', 'id', 'sourceCommit', 'sourceTree', 'registrationSourceCommit', 'workerBasisCommit',
    'workerProjectionSha256', 'registrationSourceSha256', 'validationSourceSha256', 'contextPath'}
if (set(v) != keys or type(v['version']) is not int or v['version'] != 1
        or v['id'] != 'registration-worker-93-20261007' or p.get('enabled') is not True
        or v['sourceCommit'] != os.environ['RELEASE_COMMIT'] or not re.fullmatch(r'[a-f0-9]{40}', v['sourceTree'])
        or v['contextPath'] != '.deploy/production-release/registration-build-context'
        or not isinstance(v['workerProjectionSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', v['workerProjectionSha256'])
        or any(v[k] != p[k] for k in ('registrationSourceCommit', 'workerBasisCommit', 'workerProjectionSha256',
            'registrationSourceSha256', 'validationSourceSha256'))):
    raise SystemExit('Fixed login projection unavailable')
print(v['workerProjectionSha256'])
PY_LOGIN_PROJECTION
}

registration96_baseline_sha256() {
  python3 - <<'PY_REGISTRATION96_BASELINE'
import hashlib, json, os, stat, sys
from pathlib import Path

def unique(items):
    result = {}
    for key, value in items:
        if key in result: raise ValueError('DUPLICATE_FIELD')
        result[key] = value
    return result

def read(path, cap):
    path = path.absolute()
    if path.resolve() != path: raise ValueError('PATH_CHANGED')
    identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    initial = path.lstat()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if (identity(initial) != identity(before) or not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) not in (0o644, 0o664)
                or not 0 < before.st_size <= cap): raise ValueError('STAT_CHANGED')
        raw = stream.read(cap + 1)
        if (len(raw) != before.st_size or identity(before) != identity(os.fstat(stream.fileno()))
                or identity(before) != identity(path.lstat())): raise ValueError('READ_CHANGED')
    return raw

try:
    profile = json.loads(read(Path('deploy/aws/registration-worker-96-20261008.json'), 128 * 1024), object_pairs_hook=unique)
    if profile.get('id') != 'registration-worker-96-20261008' or profile.get('enabled') is not True:
        raise ValueError('PROFILE_DISABLED')
    raw = read(Path('deploy/aws/registration-baseline-96-20261008.json'), 4 * 1024 * 1024)
    digest = hashlib.sha256(raw).hexdigest()
    if digest != profile.get('baselineCarrierSha256'): raise ValueError('BASELINE_CHANGED')
    print(digest)
except Exception:
    print('Fixed96 baseline unavailable; raw output suppressed', file=sys.stderr)
    raise SystemExit(2) from None
PY_REGISTRATION96_BASELINE
}

registration96_preflight() {
  local baseline_sha
  baseline_sha="$(registration96_baseline_sha256)" || return
  CI_RUN_ID="${QUALITY_RUN_ID:-${CI_RUN_ID:-${QUALITY_GATE_RUN_ID:-}}}" python3 -B "$(dirname "${BASH_SOURCE[0]}")/remote-deploy.py" \
    --check-fixed-registration-scope --registration-profile registration-worker-96-20261008 \
    --registration96-baseline-sha256 "$baseline_sha"
}

read_registration_onboarding_projection() {
  python3 - <<'PY_REGISTRATION96_PROJECTION'
import hashlib, json, os, re, stat, sys
from pathlib import Path

def unique(items):
    result = {}
    for key, value in items:
        if key in result: raise ValueError('DUPLICATE_FIELD')
        result[key] = value
    return result

try:
    inputs = []
    for path in ('deploy/aws/registration-worker-96-20261008.json', '.deploy/production-release/registration-build-projection.json'):
        p = Path(path).absolute()
        modes = (0o600, 0o644, 0o664) if path == '.deploy/production-release/registration-build-projection.json' else (0o644, 0o664)
        if p.resolve() != p: raise ValueError('PATH_CHANGED')
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        initial = p.lstat()
        with os.fdopen(os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
            before = os.fstat(stream.fileno())
            if (identity(initial) != identity(before) or not stat.S_ISREG(before.st_mode)
                    or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) not in modes
                    or not 0 < before.st_size <= 128 * 1024): raise ValueError('STAT_CHANGED')
            raw = stream.read(128 * 1024 + 1)
            if (len(raw) != before.st_size or identity(before) != identity(os.fstat(stream.fileno()))
                    or identity(before) != identity(p.lstat())): raise ValueError('READ_CHANGED')
        inputs.append(json.loads(raw, object_pairs_hook=unique))
    profile, value = inputs
    fields = {'version', 'id', 'sourceCommit', 'sourceTree', 'registrationSourceCommit', 'workerBasisCommit',
        'workerProjectionSha256', 'registrationSourceSha256', 'carriedSourceCommits', 'carriedSourceSha256',
        'baselineReceiptSha256', 'contextPath'}
    if (type(value) is not dict or set(value) != fields or type(value['version']) is not int or value['version'] != 1
            or value['id'] != 'registration-worker-96-20261008' or profile.get('enabled') is not True
            or os.environ.get('HISTORICAL_EXCEPTION') != value['id']
            or value['sourceCommit'] != os.environ['RELEASE_COMMIT'] or value['sourceTree'] != os.environ['SOURCE_TREE']
            or not re.fullmatch(r'[a-f0-9]{40}', value['sourceCommit']) or not re.fullmatch(r'[a-f0-9]{40}', value['sourceTree'])
            or value['contextPath'] != '.deploy/production-release/registration-build-context'
            or value['registrationSourceCommit'] != '3d71a44b30a798110d43c8b943d3f2cbac99efa9'
            or value['workerBasisCommit'] != '2f24cf81007429ea474da404a30bc74da9d43ce1'
            or any(value[key] != profile[key] for key in ('registrationSourceCommit', 'workerBasisCommit',
                'workerProjectionSha256', 'registrationSourceSha256', 'carriedSourceCommits', 'carriedSourceSha256', 'baselineReceiptSha256'))
            or not re.fullmatch(r'[a-f0-9]{64}', value['workerProjectionSha256'])
            or len(profile['workerProjection']) != 60
            or hashlib.sha256(json.dumps(profile['workerProjection'], sort_keys=True, separators=(',', ':')).encode()).hexdigest() != value['workerProjectionSha256']):
        raise ValueError('PROJECTION_CHANGED')
    print(value['workerProjectionSha256'])
except Exception:
    print('Fixed96 projection unavailable; raw output suppressed', file=sys.stderr)
    raise SystemExit(2) from None
PY_REGISTRATION96_PROJECTION
}

# Selection only; the remote policy still verifies the reviewed source proof.
validate_release_selection() {
  case "${RELEASE_OPERATION:-release}" in
    *_api_registration|*_registration_business|*_registration_handoff)
      echo 'Automatic registration has been removed; registration releases are disabled' >&2
      return 1 ;;
  esac
  if [[ "${RELEASE_OPERATION:-release}" == verify_release_archive_cache || "${RELEASE_OPERATION:-release}" == archive_release_cache ]]; then
    [[ "${HISTORICAL_EXCEPTION:-none}" == none && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
    [[ "${EXPECTED_CURRENT:-}" == e7c9862d58599995954883f1c1f6038283afffab ]] || return 1
    [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}" ]] || return 1
    if [[ "$RELEASE_OPERATION" == archive_release_cache ]]; then
      [[ "${CACHE_PLAN_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 1
    else
      [[ -z "${CACHE_PLAN_SHA256:-}" ]] || return 1
    fi
    return 0
  fi
  local policy="${HISTORICAL_EXCEPTION:-none}"
  if [[ "${RELEASE_OPERATION:-release}" == install_backup_retention_protection* ]]; then
    [[ "${RELEASE_OPERATION:-release}" == install_backup_retention_protection ]] || return 1
    [[ "$policy" == none && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
    [[ "${EXPECTED_CURRENT:-}" == 0a03fa28e6b844a18833d5c63f1de700f091fc64 ]] || return 1
    [[ "${RELEASE_COMMIT:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_REF:-}" == refs/heads/main ]] || return 1
    [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}${CACHE_PLAN_SHA256:-}${DIAGNOSTIC_COMMAND_ID:-}" ]] || return 1
    return 0
  fi
  if [[ "${RELEASE_OPERATION:-release}" == diagnose_online_backup_source* || "${RELEASE_OPERATION:-release}" == restore_online_backup_source* || "${RELEASE_OPERATION:-release}" == repair_online_backup_parent_owner* ]]; then
    [[ "${RELEASE_OPERATION:-release}" == diagnose_online_backup_source || "${RELEASE_OPERATION:-release}" == restore_online_backup_source || "${RELEASE_OPERATION:-release}" == repair_online_backup_parent_owner ]] || return 1
    [[ "$policy" == none && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
    [[ "${EXPECTED_CURRENT:-}" == 0a03fa28e6b844a18833d5c63f1de700f091fc64 ]] || return 1
    [[ "${RELEASE_COMMIT:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_REF:-}" == refs/heads/main ]] || return 1
    [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}${CACHE_PLAN_SHA256:-}${DIAGNOSTIC_COMMAND_ID:-}" ]] || return 1
    return 0
  fi
  if [[ "${RELEASE_OPERATION:-release}" == repair_online_source_permissions* ]]; then
    [[ "${RELEASE_OPERATION:-release}" == repair_online_source_permissions ]] || return 1
    [[ "$policy" == none && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
    [[ "${EXPECTED_CURRENT:-}" == 0a03fa28e6b844a18833d5c63f1de700f091fc64 ]] || return 1
    [[ "${RELEASE_COMMIT:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_REF:-}" == refs/heads/main ]] || return 1
    [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}${CACHE_PLAN_SHA256:-}${DIAGNOSTIC_COMMAND_ID:-}" ]] || return 1
    return 0
  fi
  if [[ "${RELEASE_OPERATION:-release}" == release_api_workspace || "${RELEASE_OPERATION:-release}" == verify_api_workspace ]]; then
    [[ "$policy" == none && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
    [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}${CACHE_PLAN_SHA256:-}${DIAGNOSTIC_COMMAND_ID:-}" ]] || return 1
    return 0
  fi
  case "$policy" in
    registration-worker-*|historical-finance-20261005-registration-continuation)
      echo 'Automatic registration has been removed; registration releases are disabled' >&2
      return 1 ;;
  esac
  if [[ "${RELEASE_OPERATION:-release}" == release_online_recharge || "${RELEASE_OPERATION:-release}" == verify_online_recharge || "${RELEASE_OPERATION:-release}" == release_api_admin_migration || "${RELEASE_OPERATION:-release}" == verify_api_admin_migration || "${RELEASE_OPERATION:-release}" == release_api_admin || "${RELEASE_OPERATION:-release}" == verify_api_admin ]]; then
    [[ "$policy" == none && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
    [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}" ]] || return 1
    return 0
  fi
  if [[ "$policy" != historical-finance-20261005-order-archive && -n "${ORDER_ARCHIVE_SEAL_SHA256:-}" ]]; then
    echo 'Order archive seal is valid only with its independent release policy' >&2
    return 1
  fi
  case "$policy" in
    none|historical-finance-20261005|historical-finance-20261005-registration-continuation|historical-finance-20261005-recharge-diagnostics) ;;
    registration-worker-b8-80-20261006)
      [[ "${EXPECTED_CURRENT:-}" == 80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-956-20261006)
      [[ "${EXPECTED_CURRENT:-}" == 9560d8038a39d4ded1e560d484bdcb941a5d9c43 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-85-20261006)
      [[ "${EXPECTED_CURRENT:-}" == 85e94572cd965dd993743d12d55a3e91d60b6444 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-86-20261006)
      [[ "${EXPECTED_CURRENT:-}" == fd3a6da610c505c2b7a51601cf854182991ffd12 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-87-20261006)
      [[ "${EXPECTED_CURRENT:-}" == 651f62902fba74ddd189b34932084573b39d245c ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-90-20261007)
      [[ "${EXPECTED_CURRENT:-}" == c3cad767b372738b2193e60584b0a53daa53b65f ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-92-20261007)
      [[ "${EXPECTED_CURRENT:-}" == 974c62cc1681012ecff897aefc90d2cd9900004a ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-96-20261008)
      [[ "${EXPECTED_CURRENT:-}" == 04570d75c779fd91a0933ef9416f6d62698b6b91 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}" ]] || return 1
      registration96_preflight
      return $? ;;
    registration-worker-95-20261008)
      [[ "${EXPECTED_CURRENT:-}" == 4c170e661c871dc14dccc98a8d6e5cf983141341 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-94-20261007)
      [[ "${EXPECTED_CURRENT:-}" == 815fae391b172d6c368ea2ad25225f52a1272808 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-93-20261007)
      [[ "${EXPECTED_CURRENT:-}" == 2f24cf81007429ea474da404a30bc74da9d43ce1 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-91-20261007)
      [[ "${EXPECTED_CURRENT:-}" == 01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-89-20261006)
      [[ "${EXPECTED_CURRENT:-}" == d2e22e623d0e19851c79ffe43396f5f97a99b8d3 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    registration-worker-88-20261006)
      [[ "${EXPECTED_CURRENT:-}" == 4c200c4ae08bb8214ff8e0955f8237ce85069cc6 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    historical-finance-20261005-maintenance-continuation)
      [[ "${EXPECTED_CURRENT:-}" == 6a82a774f2a65e00d4f260c629f7152bf7935d1d ]] || {
        echo 'Maintenance continuation requires its exact running baseline' >&2
        return 1
      }
      [[ "${RELEASE_OPERATION:-release}" == release ]] || return 1
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}" ]] || {
        echo 'Maintenance continuation requires a fresh image build and no post-cleanup seal' >&2
        return 1
      }
      return 0 ;;
    historical-finance-20261005-mailbox-batch)
      [[ "${EXPECTED_CURRENT:-}" == b8d643450ffa9012ccc09ead15e4681e3dee98d0 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${POST_CLEANUP_SEAL_SHA256:-}" && "${REUSE_IMAGE_RUN:-}" == 37312405714 ]] || return 1
      [[ -z "${REUSE_IMAGE_COMMIT:-}" || "${REUSE_IMAGE_COMMIT}" == f5826f9fb4ad0d846d9875c035c913a61eb68290 ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN_ID:-}" || "${REUSE_IMAGE_RUN_ID}" == 37312405714 ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN_ATTEMPT:-}" || "${REUSE_IMAGE_RUN_ATTEMPT}" == 1 ]] || return 1
      return 0 ;;
    recharge-pro-menu-b8-20261005)
      # Its independently approved manifest is validated before build or dispatch.
      [[ "${EXPECTED_CURRENT:-}" == b8d643450ffa9012ccc09ead15e4681e3dee98d0 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}" ]] || return 1
      return 0 ;;
    recharge-pro-menu-7f-20261005)
      [[ "${EXPECTED_CURRENT:-}" == 7f70688b9bf53a071a0a324ca558aeabc4ced2e3 ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}" ]] || return 1
      return 0 ;;
    recharge-pro-main80-20261006)
      [[ "${EXPECTED_CURRENT:-}" == b91b626a71ed2c7c2473d080551b3b10b693b0cb ]] || return 1
      [[ "${RELEASE_OPERATION:-release}" == release && "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      return 0 ;;
    recharge-pro-pricing-045-20261008)
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}" ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        release)
          [[ "${EXPECTED_CURRENT:-}" == e7c9862d58599995954883f1c1f6038283afffab ]] || return 1 ;;
        verify_recharge_release)
          [[ "${RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_CURRENT:-}" == "$RELEASE_COMMIT" && "$RELEASE_COMMIT" != e7c9862d58599995954883f1c1f6038283afffab ]] || return 1 ;;
        *) return 1 ;;
      esac
      return 0 ;;
    recharge-pro-6f5-20261008)
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}" ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        release)
          [[ "${EXPECTED_CURRENT:-}" == 6f5e5cc252886d5f86592e307147b40c13577585 ]] || return 1 ;;
        verify_recharge_release)
          [[ "${RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_CURRENT:-}" == "$RELEASE_COMMIT" && "$RELEASE_COMMIT" != 6f5e5cc252886d5f86592e307147b40c13577585 ]] || return 1 ;;
        *) return 1 ;;
      esac
      return 0 ;;
    recharge-pro-4c-20261008)
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${RELEASE_BROWSER_CACHE_IMAGE:-}${RELEASE_BROWSER_CACHE_IMAGE_ID:-}" ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        release)
          [[ "${EXPECTED_CURRENT:-}" == 4c170e661c871dc14dccc98a8d6e5cf983141341 ]] || return 1 ;;
        verify_recharge_release)
          [[ "${RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_CURRENT:-}" == "$RELEASE_COMMIT" && "$RELEASE_COMMIT" != 4c170e661c871dc14dccc98a8d6e5cf983141341 ]] || return 1 ;;
        *) return 1 ;;
      esac
      return 0 ;;
    recharge-pro-2f-20261007)
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        release)
          [[ "${EXPECTED_CURRENT:-}" == 2f24cf81007429ea474da404a30bc74da9d43ce1 ]] || return 1 ;;
        verify_recharge_release)
          [[ "${RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_CURRENT:-}" == "$RELEASE_COMMIT" && "$RELEASE_COMMIT" != 2f24cf81007429ea474da404a30bc74da9d43ce1 ]] || return 1 ;;
        *) return 1 ;;
      esac
      return 0 ;;
    recharge-pro-974-20261007)
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      [[ -z "${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}${POST_CLEANUP_SEAL_SHA256:-}${ORDER_ARCHIVE_SEAL_SHA256:-}${ORDER_ARCHIVE_PREPARED_IMAGES_SHA256:-}" ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        release)
          [[ "${EXPECTED_CURRENT:-}" == 974c62cc1681012ecff897aefc90d2cd9900004a ]] || return 1 ;;
        verify_recharge_release)
          [[ "${RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_CURRENT:-}" == "$RELEASE_COMMIT" && "$RELEASE_COMMIT" != 974c62cc1681012ecff897aefc90d2cd9900004a ]] || return 1 ;;
        *) return 1 ;;
      esac
      return 0 ;;
    historical-finance-20261005-order-archive)
      [[ "${EXPECTED_CURRENT:-}" == 3ca300486d0edfadda83c094a48474a63959fce7 ]] || return 1
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false && -z "${POST_CLEANUP_SEAL_SHA256:-}" ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        prepare_order_archive_release)
          [[ -z "${ORDER_ARCHIVE_SEAL_SHA256:-}${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}" ]] || return 1 ;;
        release)
          [[ "${ORDER_ARCHIVE_SEAL_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || {
            echo 'Order archive release requires the exact independently reviewed seal SHA256' >&2
            return 1
          }
          [[ "${REUSE_IMAGE_RUN:-}" =~ ^[1-9][0-9]*$ ]] || return 1
          [[ -z "${REUSE_IMAGE_COMMIT:-}" || "${REUSE_IMAGE_COMMIT}" == "${RELEASE_COMMIT:-}" ]] || return 1
          [[ -z "${REUSE_IMAGE_RUN_ID:-}" || "${REUSE_IMAGE_RUN_ID}" == "${REUSE_IMAGE_RUN}" ]] || return 1
          [[ -z "${REUSE_IMAGE_RUN_ATTEMPT:-}" || "${REUSE_IMAGE_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]] || return 1 ;;
        *) echo 'Order archive policy supports preparation or release only' >&2; return 1 ;;
      esac
      return 0 ;;
    historical-finance-20261005-post-cleanup)
      [[ "${EXPECTED_CURRENT:-}" == 6a82a774f2a65e00d4f260c629f7152bf7935d1d ]] || {
        echo 'Post-cleanup release requires its exact running baseline' >&2
        return 1
      }
      [[ "${RELEASE_ADMIN_ONLY:-false}" == false ]] || return 1
      case "${RELEASE_OPERATION:-release}" in
        prepare_post_cleanup_release)
          [[ -z "${POST_CLEANUP_SEAL_SHA256:-}${REUSE_IMAGE_RUN:-}${REUSE_IMAGE_COMMIT:-}${REUSE_IMAGE_RUN_ID:-}${REUSE_IMAGE_RUN_ATTEMPT:-}" ]] || {
            echo 'Post-cleanup preparation requires an empty seal and a fresh image build' >&2
            return 1
          } ;;
        release)
          [[ "${POST_CLEANUP_SEAL_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || {
            echo 'Post-cleanup release requires the exact reviewed seal SHA256' >&2
            return 1
          }
          [[ "${REUSE_IMAGE_RUN:-}" =~ ^[1-9][0-9]*$ ]] || {
            echo 'Post-cleanup release requires a completed preparation run for the same commit' >&2
            return 1
          }
          [[ -z "${REUSE_IMAGE_COMMIT:-}" || "${REUSE_IMAGE_COMMIT}" == "${RELEASE_COMMIT:-}" ]] || return 1
          [[ -z "${REUSE_IMAGE_RUN_ID:-}" || "${REUSE_IMAGE_RUN_ID}" == "${REUSE_IMAGE_RUN}" ]] || return 1
          [[ -z "${REUSE_IMAGE_RUN_ATTEMPT:-}" || "${REUSE_IMAGE_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]] || return 1 ;;
        *)
          echo 'Post-cleanup policy supports preparation or release only; use the read-only post-cleanup capture CLI for verification' >&2
          return 1 ;;
      esac
      return 0 ;;
    *) echo 'Unknown historical release policy' >&2; return 1 ;;
  esac
  [[ "${RELEASE_OPERATION:-release}" != prepare_order_archive_release ]] || {
    echo 'Order archive preparation requires its independent policy' >&2
    return 1
  }
  [[ "${RELEASE_OPERATION:-release}" != prepare_post_cleanup_release ]] || {
    echo 'Post-cleanup preparation requires its independent policy' >&2
    return 1
  }
  [[ -z "${POST_CLEANUP_SEAL_SHA256:-}" ]] || {
    echo 'Post-cleanup seal is valid only with the post-cleanup release policy' >&2
    return 1
  }
}

validate_release_selection
