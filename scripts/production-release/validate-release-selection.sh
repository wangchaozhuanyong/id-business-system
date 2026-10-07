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

# Selection only; the remote policy still verifies the reviewed source proof.
validate_release_selection() {
  local policy="${HISTORICAL_EXCEPTION:-none}"
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
