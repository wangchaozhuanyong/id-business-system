"""Dispatch the independent website release from the checked main revision."""

import base64
import hashlib
import json
import lzma
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from remote import (ACTION_PASSWORD_PRESENTATION_FILES, ASSET_METADATA_REPAIR_BASE, ASSET_METADATA_REPAIR_DIGEST,
                    ASSET_METADATA_RELEASE_RUN,
                    BACKUP_OPERATION, CARD_IMPORT_ASSET_SOURCE, CARD_IMPORT_PRESENTATION_FILES,
                    CARD_FIRST_PAINT_PRESENTATION_FILES, CARD_LIST_TOOLBAR_PRESENTATION_FILES,
                    CARD_NUMBER_PRESENTATION_FILES, CARD_PLAN_PRESENTATION_FILES,
                    CHECKOUT_DIAGNOSTIC_PRESENTATION_FILES, PRESENTATION_SCOPES, SECURITY_PRESENTATION_FILES,
                    ORBITCARD_LAYOUT_PRESENTATION_FILES, CARD_POOL_LIMIT_PRESENTATION_FILES,
                    CARD_POOL_TOGGLE_PRESENTATION_FILES, CARD_REUSE_LIMITS_PRESENTATION_FILES,
                    CARD_IMPORT_PREVIEW_SOURCE, RECHARGE_REDEMPTION_CARD_IMPORT_FILES,
                    REDEEM_PRESENTATION_FILES, SUBSCRIPTION_INVOICE_PRESENTATION_FILES,
                    TABLE_ACTIONS_STYLESHEET, TASK_HISTORY_PRESENTATION_FILES,
                    WORKSPACE_PROGRESS_PRESENTATION_FILES, PRESENTATION_MOUNT_ERRORS, asset_bundle_summary)

ACCOUNT = "098208446664"
REGION = "ap-northeast-1"
INSTANCE = "i-0838cebf64f0e2a89"
BUCKET = f"id-business-v2-backups-{ACCOUNT}-{REGION}"
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / ".runtime/website-release"
SHA = re.compile(r"[a-f0-9]{40}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
PROXY_TYPE_CATALOG = "modules/recharge/bitbrowser/proxy-types.mjs"
TASK_HISTORY_MANIFEST = "recharge-task-history-20261114.json"
TASK_HISTORY_MANIFEST_PATH = f"deploy/website/{TASK_HISTORY_MANIFEST}"
ADMIN_WORKSPACE_MANIFEST = "recharge-admin-workspace-20261115.json"
ADMIN_WORKSPACE_MANIFEST_PATH = f"deploy/website/{ADMIN_WORKSPACE_MANIFEST}"
SUBSCRIPTION_INVOICE_MANIFEST = "recharge-subscription-invoice-20261116.json"
SUBSCRIPTION_INVOICE_MANIFEST_PATH = f"deploy/website/{SUBSCRIPTION_INVOICE_MANIFEST}"
ACTION_PASSWORD_MANIFEST = "action-password-20261116.json"
ACTION_PASSWORD_MANIFEST_PATH = f"deploy/website/{ACTION_PASSWORD_MANIFEST}"
CARD_NUMBER_MANIFEST = "card-number-display-20261121.json"
CARD_NUMBER_MANIFEST_PATH = f"deploy/website/{CARD_NUMBER_MANIFEST}"
CARD_FIRST_PAINT_MANIFEST = "recharge-card-first-paint-20261121.json"
CARD_FIRST_PAINT_MANIFEST_PATH = f"deploy/website/{CARD_FIRST_PAINT_MANIFEST}"
CARD_LIST_TOOLBAR_MANIFEST = "card-list-toolbar-20261121.json"
CARD_LIST_TOOLBAR_MANIFEST_PATH = f"deploy/website/{CARD_LIST_TOOLBAR_MANIFEST}"
RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST = "recharge-redemption-card-import-20261121.json"
RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST_PATH = f"deploy/website/{RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST}"
ORBITCARD_LAYOUT_MANIFEST = "orbitcard-layout-20261123.json"
ORBITCARD_LAYOUT_MANIFEST_PATH = f"deploy/website/{ORBITCARD_LAYOUT_MANIFEST}"
CARD_POOL_LIMIT_MANIFEST = "card-pool-limit-20261124.json"
CARD_POOL_LIMIT_MANIFEST_PATH = f"deploy/website/{CARD_POOL_LIMIT_MANIFEST}"
CARD_POOL_TOGGLE_MANIFEST = "card-pool-toggle-20261124.json"
CARD_POOL_TOGGLE_MANIFEST_PATH = f"deploy/website/{CARD_POOL_TOGGLE_MANIFEST}"
CARD_REUSE_LIMITS_MANIFEST = "card-reuse-limits-20261125.json"
CARD_REUSE_LIMITS_MANIFEST_PATH = f"deploy/website/{CARD_REUSE_LIMITS_MANIFEST}"
CORE_PATHS = ("deploy/recharge-core", "deploy/caddy", "modules/recharge/codexdaichong", "package.json",
              PROXY_TYPE_CATALOG, TASK_HISTORY_MANIFEST_PATH, ADMIN_WORKSPACE_MANIFEST_PATH,
              SUBSCRIPTION_INVOICE_MANIFEST_PATH, ACTION_PASSWORD_MANIFEST_PATH, CARD_NUMBER_MANIFEST_PATH,
              CARD_FIRST_PAINT_MANIFEST_PATH, CARD_LIST_TOOLBAR_MANIFEST_PATH,
              RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST_PATH, ORBITCARD_LAYOUT_MANIFEST_PATH,
              CARD_POOL_LIMIT_MANIFEST_PATH, CARD_POOL_TOGGLE_MANIFEST_PATH,
              CARD_REUSE_LIMITS_MANIFEST_PATH)
ADAPTER_SCOPE = {
    "modules/recharge/codexdaichong/gateway.mjs", "modules/recharge/codexdaichong/local-gateway.mjs",
    "modules/recharge/codexdaichong/native-adapter.mjs", "modules/recharge/codexdaichong/runtime.mjs",
    "deploy/recharge-core/canary.py", "deploy/recharge-core/health.mjs", "deploy/recharge-core/run-recharge.py",
}
ADAPTER_RUNTIME_FILES = (
    "modules/recharge/codexdaichong/native-adapter.mjs", "modules/recharge/codexdaichong/runtime.mjs",
    "deploy/recharge-core/health.mjs",
)
ADAPTER_FILES = (*ADAPTER_RUNTIME_FILES, "deploy/recharge-core/canary.py", "deploy/recharge-core/run-recharge.py")
NATIVE_PATCH_FILES = {
    f"modules/recharge/codexdaichong/{folder}/{name}"
    for folder, patch in (("card-plans", "upstream-card-plans.patch"),
                          ("provider-retirement", "upstream-provider-retirement.patch"))
    for name in ("manifest.json", patch)
}
CARD_REUSE_NATIVE_SCOPE = {
    "deploy/recharge-core/card-plans-canary.mjs", "deploy/recharge-core/health.mjs",
    "modules/recharge/codexdaichong/card-plans/manifest.json",
    "modules/recharge/codexdaichong/card-plans/upstream-card-plans.patch",
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/shell.css", "modules/recharge/codexdaichong/shell.js",
}
CARD_REUSE_AND_ROUTING_NATIVE_SCOPE = CARD_REUSE_NATIVE_SCOPE | {
    "modules/recharge/codexdaichong/gateway.mjs",
    "modules/recharge/codexdaichong/native-routing.mjs",
    "modules/recharge/codexdaichong/native-routing.test.mjs",
}
CARD_REUSE_ROUTING_AND_HEALTH_NATIVE_SCOPE = CARD_REUSE_AND_ROUTING_NATIVE_SCOPE | {
    "modules/recharge/codexdaichong/runtime-health.mjs",
}
CARD_REUSE_ROUTING_HEALTH_AND_CANARY_NATIVE_SCOPE = CARD_REUSE_ROUTING_AND_HEALTH_NATIVE_SCOPE | {
    "deploy/recharge-core/canary.py",
}
# 已批准的优惠及浏览器补丁独立核验，不与银行卡套餐或供应商退役批次绑定。
PLUS_TRIAL_PATCH_FILES = {
    f"modules/recharge/codexdaichong/plus-trial/{name}"
    for name in ("manifest.json", "upstream-plus-trial.patch")
}
PLUS_TRIAL_SCOPE = PLUS_TRIAL_PATCH_FILES | {"modules/recharge/codexdaichong/plus-trial.test.mjs"}
PLUS_TRIAL_MERGE = "f8c72030d2a820a62d35ad0fbfe588dd72c4a08b"
DEFERRED_DEBUG_BASE = "18ca7897c494352f5ab0ce0217d11b294ac645b8"
DEFERRED_DEBUG_MERGE = "47447e73c6562b43f27f9e1f80f82573b81ec00d"
DEFERRED_DEBUG_FILES = frozenset(PLUS_TRIAL_SCOPE)
PLUS_TRIAL_BUILD_INPUTS = PLUS_TRIAL_SCOPE | {"modules/recharge/codexdaichong/prepare.mjs"}
DEPLOYED_TRIAL_BUILD_INPUTS = PLUS_TRIAL_BUILD_INPUTS | {"deploy/recharge-core/canary.py"}
# Website-only release over the reviewed #1055 build inputs. The asset digest is
# the production readback for the base website (release run 44504400315).
DEFERRED_RETRY_BASE = "e4bd247086134fa75d49ffaa59d0e3507f67d430"
DEFERRED_RETRY_MERGE = "45ba71fbd4054669a029ab2b565f49ceb6a3242b"
DEFERRED_RETRY_ASSETS = "a67d83372c40fe5ca94d41ca075a889aa5b5bbeecb5202ae562e1a554728b1df"
DEFERRED_RETRY_INPUTS = frozenset({
    "deploy/recharge-core/canary.py", "modules/recharge/codexdaichong/prepare.mjs",
    "modules/recharge/codexdaichong/retry/manifest.json",
    "modules/recharge/codexdaichong/retry/upstream-retry.patch",
})
RETRY_DEPLOY_SCRIPT = "deploy/website/recharge_core.py"
NATIVE_CORE_SCOPE = NATIVE_PATCH_FILES | PLUS_TRIAL_SCOPE | {
    "deploy/recharge-core/README.md", "deploy/recharge-core/canary.py", "deploy/recharge-core/health.mjs",
    "deploy/recharge-core/card-plans-canary.mjs", "deploy/recharge-core/check-provider-cutover.mjs",
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/demo-site.mjs", "modules/recharge/codexdaichong/gateway.mjs",
    "modules/recharge/codexdaichong/local-gateway.mjs", "modules/recharge/codexdaichong/native-adapter.mjs",
    "modules/recharge/codexdaichong/prepare.mjs", "modules/recharge/codexdaichong/progress-presentation.mjs",
    "modules/recharge/codexdaichong/shell.css", "modules/recharge/codexdaichong/shell.js",
}
PROXY_TYPE_CORE_SCOPE = {
    PROXY_TYPE_CATALOG, "deploy/recharge-core/canary.py", "deploy/recharge-core/card-plans-canary.mjs",
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/gateway.mjs",
    "modules/recharge/codexdaichong/native-routing.mjs", "modules/recharge/codexdaichong/native-routing.test.mjs",
    "modules/recharge/codexdaichong/routing-admin.js",
    "modules/recharge/codexdaichong/shell.css", "modules/recharge/codexdaichong/shell.js",
}
NATIVE_RELEASE_FILES = tuple(sorted(NATIVE_CORE_SCOPE | PROXY_TYPE_CORE_SCOPE | set(ADAPTER_FILES) | {
    "deploy/recharge-core/Dockerfile", "deploy/recharge-core/entry.mjs", "deploy/recharge-core/release-gate.py",
    "deploy/recharge-core/snapshot.py", "deploy/recharge-core/seal-backup.mjs",
    "deploy/website/recharge_core.py", "deploy/website/remote.py", "deploy/website/vendure_admission.py",
    "modules/recharge/codexdaichong/runtime-health.mjs",
    "modules/recharge/vendure/codexdaichong-worker.mjs",
}))
VENDURE_REFRESH_FILES = (
    "deploy/website/vendure_admission.py",
    "modules/recharge/vendure/admission.mjs",
    "modules/recharge/vendure/isolated-task-store.mjs",
    "modules/recharge/vendure/loopback-bridge.mjs",
    "modules/recharge/codexdaichong/native-code-returns.mjs",
    "server/tools/read-tool-config.mjs",
    "server/vendure-task-service.mjs",
)
CUSTOMER_PROGRESS_FILES = (
    "modules/recharge/vendure/codexdaichong-worker.mjs",
    "modules/recharge/vendure/customer-progress.mjs", "modules/recharge/vendure/progress-stream.mjs",
    "modules/recharge/codexdaichong/progress-presentation.mjs", "deploy/website/recharge_core.py",
    "deploy/website/customer_progress.py",
)
PARTNER_API_FILES = (
    "server/recharge-partner-api.mjs", "server/recharge-partner-gateway.mjs", "server/recharge-code-requests.mjs",
    "frontend/recharge-partners.mjs", "frontend/recharge-partner-authorize.html",
    "frontend/recharge-partner-authorize.js", "frontend/recharge-partner.css",
)


class AwsError(RuntimeError):
    def __init__(self, operation, code):
        super().__init__(f"AWS {operation}: {code}")
        self.code = code


def aws(*args, once=False):
    env = os.environ | ({"AWS_MAX_ATTEMPTS": "1"} if once else {})
    result = subprocess.run(
        ["aws", "--region", REGION, "--no-cli-pager", "--cli-connect-timeout", "8",
         "--cli-read-timeout", "20", *args, "--output", "json"],
        capture_output=True, text=True, cwd=ROOT, env=env, timeout=60,
    )
    if result.returncode:
        error = re.search(r"An error occurred \(([^)]+)\)", result.stderr)
        raise AwsError(" ".join(args[:2]), error.group(1) if error else "response_unavailable")
    return json.loads(result.stdout)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, timeout=30).strip()


def require_main(sha):
    if not SHA.fullmatch(sha) or git("rev-parse", "HEAD") != sha:
        raise RuntimeError("release_checkout_mismatch")
    if git("ls-remote", "origin", "refs/heads/main").split() != [sha, "refs/heads/main"]:
        raise RuntimeError("remote_main_changed")


def require_ancestor(base, sha):
    if not SHA.fullmatch(base):
        raise RuntimeError("invalid_ancestor_revision")
    result = subprocess.run(["git", "merge-base", "--is-ancestor", base, sha], cwd=ROOT, timeout=15)
    if result.returncode:
        raise RuntimeError("requested_revision_not_an_ancestor_of_main")


def require_presentation_approval(base, sha, manifest, approved_files, *, added_files=()):
    approval_file = ROOT / "deploy/website" / manifest
    try:
        approval = json.loads(approval_file.read_bytes())
        assets = {key: approval[key] for key in ("beforeAssetsSha256", "assetsSha256")}
        files = approval["files"]
        if (not all(isinstance(value, str) and SHA256.fullmatch(value) for value in assets.values()) or
                assets["beforeAssetsSha256"] == assets["assetsSha256"] or
                not isinstance(files, dict) or set(files) != set(approved_files) or
                (added_files and approval.get("baseWebsiteSha") != base) or
                not all(isinstance(pair, dict) and set(pair) == {"before", "after"} and
                        isinstance(pair["after"], str) and SHA256.fullmatch(pair["after"]) and
                        (pair["before"] is None if name in added_files else
                         isinstance(pair["before"], str) and SHA256.fullmatch(pair["before"]))
                        for name, pair in files.items())):
            raise ValueError("invalid scope")
    except (KeyError, OSError, TypeError, ValueError) as error:
        raise RuntimeError("recharge_presentation_approval_invalid") from error
    for name in approved_files:
        for side, revision in (("before", base), ("after", sha)):
            expected = files[name][side]
            if expected is None:
                if git("ls-tree", revision, "--", name):
                    raise RuntimeError("recharge_presentation_source_mismatch")
                continue
            content = subprocess.check_output(["git", "show", f"{revision}:{name}"], cwd=ROOT, timeout=30)
            if hashlib.sha256(content).hexdigest() != expected:
                raise RuntimeError("recharge_presentation_source_mismatch")
    if added_files:
        assets["baseWebsiteSha"] = base
    return assets


def require_redeem_presentation(base, sha):
    return require_presentation_approval(base, sha, "redeem-log-20261111.json", REDEEM_PRESENTATION_FILES)


def require_deferred_debug_inputs(base, sha):
    """Carry only reviewed build inputs; never switch the native runtime."""
    try:
        approval = json.loads((ROOT / "deploy/website/deferred-checkout-debug-20261116.json").read_bytes())
        if (base != DEFERRED_DEBUG_BASE or approval["baseWebsiteSha"] != base or
                approval["reviewedCommit"] != DEFERRED_DEBUG_MERGE or
                not SHA256.fullmatch(approval["assetsSha256"]) or
                not isinstance(approval["files"], dict) or
                set(approval["files"]) != DEFERRED_DEBUG_FILES or
                any(not isinstance(pair, dict) or set(pair) != {"before", "after"} or
                    any(not isinstance(value, str) or not SHA256.fullmatch(value) for value in pair.values())
                    for pair in approval["files"].values())):
            raise ValueError("invalid scope")
    except (KeyError, OSError, TypeError, ValueError) as error:
        raise RuntimeError("deferred_native_inputs_approval_invalid") from error
    require_ancestor(DEFERRED_DEBUG_MERGE, sha)
    for name, hashes in approval["files"].items():
        for side, revision in (("before", base), ("after", sha), ("after", DEFERRED_DEBUG_MERGE)):
            content = subprocess.check_output(["git", "show", f"{revision}:{name}"], cwd=ROOT, timeout=30)
            if hashlib.sha256(content).hexdigest() != hashes[side]:
                raise RuntimeError("deferred_native_inputs_source_mismatch")
    return approval


def verify_deferred_retry_baseline(before):
    mounted = before.get("mountedAssets", {})
    if (mounted.get("available") is not True or mounted.get("sha256") != DEFERRED_RETRY_ASSETS or
            any(before["components"].get(name, {}).get("running") is not True
                for name in ("recharge", "recharge-native"))):
        raise RuntimeError("deferred_retry_live_components_mismatch")


def verify_deferred_native_receipt(receipt, approval, before, expected_assets=None):
    assets_sha = approval["assetsSha256"] if expected_assets is None else expected_assets
    if (receipt.get("protectedComponentsUnchanged") is not True or
            receipt.get("liveAssetsSha256") != assets_sha or
            "rechargeCore" in receipt or "adapter" in receipt):
        raise RuntimeError("deferred_native_runtime_changed")
    return {"reviewedCommit": approval["reviewedCommit"], "nativeDeploymentPending": True,
            "nativeRevisionUnchanged": before["components"]["recharge-native"]["revision"],
            "assetsSha256": assets_sha}


def require_website_scope(base, sha, include_adapter=False, include_core=False, partner_api=False, native_publication=None):
    require_ancestor(base, sha)
    changed = set(git("diff", "--name-only", base, sha, "--", *CORE_PATHS).splitlines())
    # The host backup timer is managed independently from the immutable payment
    # image. This exact path is installed and read back by the website release.
    changed.discard(BACKUP_OPERATION)
    native = native_publication or {}
    native_revision = native.get("identity", {}).get("revision")
    if (changed in (PLUS_TRIAL_SCOPE, DEPLOYED_TRIAL_BUILD_INPUTS) and
            not any((include_adapter, include_core, partner_api)) and
            native.get("imageLabelsVerified") is True and
            isinstance(native_revision, str) and re.fullmatch(r"[a-f0-9]{40}", native_revision) and
            native["identity"].get("running") is True):
        require_ancestor(native_revision, sha)
        if git("diff", "--name-only", native_revision, sha, "--", *sorted(DEPLOYED_TRIAL_BUILD_INPUTS)).strip():
            raise RuntimeError("deployed_native_inputs_source_mismatch")
        return "deployedNativeBuildInputs", {"nativeRevision": native_revision, "image": native["identity"]["image"]}
    if include_core and base == DEFERRED_DEBUG_BASE and changed == DEFERRED_DEBUG_FILES:
        require_deferred_debug_inputs(base, sha)
        # A failed native preflight still stages releases/<sha>. Publish the
        # reviewed website first, before another native retry can reserve it.
        raise RuntimeError("publish_reviewed_website_before_deferred_native_retry")
    password_inputs = {*ACTION_PASSWORD_PRESENTATION_FILES, ACTION_PASSWORD_MANIFEST_PATH}
    if partner_api and changed:
        # The trial policy is already on main. Its only executable change is
        # applied when a native image is built. Keep the current native image
        # and verify the exact reviewed inputs before publishing the website.
        if (changed != PLUS_TRIAL_BUILD_INPUTS or include_adapter or include_core or
                git("diff", "--name-only", PLUS_TRIAL_MERGE + "^1", base, "--",
                    *sorted(PLUS_TRIAL_BUILD_INPUTS)).strip() or
                git("diff", "--name-only", PLUS_TRIAL_MERGE, sha, "--",
                    *sorted(PLUS_TRIAL_BUILD_INPUTS)).strip()):
            raise RuntimeError("partner_api_release_contains_unreviewed_native_inputs")
        require_ancestor(PLUS_TRIAL_MERGE, sha)
        return
    if include_core:
        reviewed_patches = NATIVE_PATCH_FILES | PLUS_TRIAL_PATCH_FILES
        approved_patches = any(required <= changed <= NATIVE_CORE_SCOPE
                               for required in (NATIVE_PATCH_FILES, PLUS_TRIAL_PATCH_FILES))
        # 原生容器可能落后于网站：受审查补丁已进入线上网站基线时不会出现在本次 diff，
        # 重建原生镜像是让这些输入生效的唯一途径，此时要求补丁集合完全未变。
        carried_patches = approved_patches or (
            changed <= NATIVE_CORE_SCOPE
            and not git("diff", "--name-only", base, sha, "--", *sorted(reviewed_patches)).strip())
        if include_adapter or (not carried_patches and changed not in (
                PROXY_TYPE_CORE_SCOPE, CARD_REUSE_NATIVE_SCOPE, CARD_REUSE_AND_ROUTING_NATIVE_SCOPE,
                CARD_REUSE_ROUTING_AND_HEALTH_NATIVE_SCOPE,
                CARD_REUSE_ROUTING_HEALTH_AND_CANARY_NATIVE_SCOPE)):
            raise RuntimeError("recharge_native_release_scope_mismatch")
    elif include_adapter:
        if not changed <= ADAPTER_SCOPE or not changed.intersection(ADAPTER_RUNTIME_FILES):
            raise RuntimeError("recharge_adapter_release_scope_mismatch")
    elif changed == set(REDEEM_PRESENTATION_FILES):
        return "redeemPresentation", require_redeem_presentation(base, sha)
    elif changed == set(WORKSPACE_PROGRESS_PRESENTATION_FILES):
        return "workspaceProgressPresentation", require_presentation_approval(
            base, sha, "workspace-progress-20261113.json", WORKSPACE_PROGRESS_PRESENTATION_FILES)
    elif changed == {*WORKSPACE_PROGRESS_PRESENTATION_FILES, ADMIN_WORKSPACE_MANIFEST_PATH}:
        return "rechargeAdminWorkspacePresentation", require_presentation_approval(
            base, sha, ADMIN_WORKSPACE_MANIFEST, WORKSPACE_PROGRESS_PRESENTATION_FILES)
    elif changed == {TABLE_ACTIONS_STYLESHEET}:
        return "tableActionsPresentation", require_presentation_approval(
            base, sha, "card-pool-touch-20261114.json", (TABLE_ACTIONS_STYLESHEET,))
    elif changed == {*TASK_HISTORY_PRESENTATION_FILES, TASK_HISTORY_MANIFEST_PATH}:
        return "taskHistoryPresentation", require_presentation_approval(
            base, sha, TASK_HISTORY_MANIFEST, TASK_HISTORY_PRESENTATION_FILES)
    elif changed == {*SUBSCRIPTION_INVOICE_PRESENTATION_FILES, SUBSCRIPTION_INVOICE_MANIFEST_PATH}:
        return "subscriptionInvoicePresentation", require_presentation_approval(
            base, sha, SUBSCRIPTION_INVOICE_MANIFEST, SUBSCRIPTION_INVOICE_PRESENTATION_FILES)
    elif changed == password_inputs:
        return "actionPasswordPresentation", require_presentation_approval(
            base, sha, ACTION_PASSWORD_MANIFEST, ACTION_PASSWORD_PRESENTATION_FILES)
    elif base == DEFERRED_DEBUG_BASE and changed == password_inputs | DEFERRED_DEBUG_FILES:
        deferred = require_deferred_debug_inputs(base, sha)
        assets = require_presentation_approval(base, sha, ACTION_PASSWORD_MANIFEST, ACTION_PASSWORD_PRESENTATION_FILES)
        return "actionPasswordPresentation", {**assets, "deferredNativeInputs": deferred}
    elif changed == {CARD_IMPORT_ASSET_SOURCE}:
        return "cardImportPresentation", require_presentation_approval(
            base, sha, "card-import-20261113.json", CARD_IMPORT_PRESENTATION_FILES)
    elif changed == set(CARD_PLAN_PRESENTATION_FILES):
        return "cardPlanPresentation", require_presentation_approval(
            base, sha, "card-plan-ui-20261114.json", CARD_PLAN_PRESENTATION_FILES)
    elif changed == {*CARD_NUMBER_PRESENTATION_FILES, CARD_NUMBER_MANIFEST_PATH}:
        return "cardNumberPresentation", require_presentation_approval(
            base, sha, CARD_NUMBER_MANIFEST, CARD_NUMBER_PRESENTATION_FILES)
    elif changed == {*CARD_FIRST_PAINT_PRESENTATION_FILES, CARD_FIRST_PAINT_MANIFEST_PATH}:
        return "cardFirstPaintPresentation", require_presentation_approval(
            base, sha, CARD_FIRST_PAINT_MANIFEST, CARD_FIRST_PAINT_PRESENTATION_FILES)
    elif changed == {*CARD_LIST_TOOLBAR_PRESENTATION_FILES, CARD_LIST_TOOLBAR_MANIFEST_PATH}:
        return "cardListToolbarPresentation", require_presentation_approval(
            base, sha, CARD_LIST_TOOLBAR_MANIFEST, CARD_LIST_TOOLBAR_PRESENTATION_FILES)
    elif changed == {*ORBITCARD_LAYOUT_PRESENTATION_FILES, ORBITCARD_LAYOUT_MANIFEST_PATH}:
        return "orbitcardLayoutPresentation", require_presentation_approval(
            base, sha, ORBITCARD_LAYOUT_MANIFEST, ORBITCARD_LAYOUT_PRESENTATION_FILES)
    elif changed == {*CARD_POOL_LIMIT_PRESENTATION_FILES, CARD_POOL_LIMIT_MANIFEST_PATH}:
        return "cardPoolLimitPresentation", require_presentation_approval(
            base, sha, CARD_POOL_LIMIT_MANIFEST, CARD_POOL_LIMIT_PRESENTATION_FILES)
    elif changed == {*CARD_POOL_TOGGLE_PRESENTATION_FILES, CARD_POOL_TOGGLE_MANIFEST_PATH}:
        return "cardPoolTogglePresentation", require_presentation_approval(
            base, sha, CARD_POOL_TOGGLE_MANIFEST, CARD_POOL_TOGGLE_PRESENTATION_FILES)
    elif changed == {*CARD_REUSE_LIMITS_PRESENTATION_FILES, CARD_REUSE_LIMITS_MANIFEST_PATH}:
        return "cardReuseLimitsPresentation", require_presentation_approval(
            base, sha, CARD_REUSE_LIMITS_MANIFEST, CARD_REUSE_LIMITS_PRESENTATION_FILES)
    elif changed == {*RECHARGE_REDEMPTION_CARD_IMPORT_FILES, RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST_PATH}:
        return "rechargeRedemptionCardImportPresentation", require_presentation_approval(
            base, sha, RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST, RECHARGE_REDEMPTION_CARD_IMPORT_FILES,
            added_files=(CARD_IMPORT_PREVIEW_SOURCE,))
    elif changed == set(CHECKOUT_DIAGNOSTIC_PRESENTATION_FILES):
        return "checkoutDiagnosticPresentation", require_presentation_approval(
            base, sha, "checkout-diagnostic-20261114.json", CHECKOUT_DIAGNOSTIC_PRESENTATION_FILES)
    elif changed == set(SECURITY_PRESENTATION_FILES):
        return "securityPresentation", require_presentation_approval(
            base, sha, "security-ui-20261114.json", SECURITY_PRESENTATION_FILES)
    elif base == DEFERRED_RETRY_BASE and changed == DEFERRED_RETRY_INPUTS:
        require_ancestor(DEFERRED_RETRY_MERGE, sha)
        if git("diff", "--name-only", DEFERRED_RETRY_MERGE, sha, "--", *CORE_PATHS, RETRY_DEPLOY_SCRIPT):
            raise RuntimeError("deferred_retry_inputs_source_mismatch")
        return "deferredNativeBuildInputs", {"reviewedCommit": DEFERRED_RETRY_MERGE,
                                             "assetsSha256": DEFERRED_RETRY_ASSETS}
    elif base == DEFERRED_DEBUG_BASE and changed == DEFERRED_DEBUG_FILES:
        return "deferredNativeBuildInputs", require_deferred_debug_inputs(base, sha)
    elif changed:
        raise RuntimeError("recharge_core_or_runtime_changed")


def script_for(plan):
    script = Path(__file__).with_name("remote.py").read_text()
    program = script + "\nsys.modules['remote'] = sys.modules[__name__]\n"
    if plan["operation"] in ("interrupted-preflight", "inspect-manual-workspace"):
        program += "from types import ModuleType\n"
        modules = (("manual_workspace_preflight",) if plan["operation"] == "inspect-manual-workspace"
                   else ("vendure_admission", "recharge_core", "interrupted_cutover"))
        for name in modules:
            source = Path(__file__).with_name(name + ".py").read_text()
            program += (f"module = sys.modules[{name!r}] = ModuleType({name!r})\n"
                        f"exec(compile({source!r}, {name + '.py'!r}, 'exec'), module.__dict__)\n")
    program += f"main(json.loads({json.dumps(plan)!r}))\n"
    program = program.encode("utf8")
    encoded = base64.b64encode(lzma.compress(program)).decode("ascii")
    checksum = hashlib.sha256(program).hexdigest()
    return ("set -eu\npython3 - <<'ID_WEBSITE_RELEASE'\n" +
            "import base64, hashlib, lzma\n" +
            f"program = lzma.decompress(base64.b64decode({encoded!r}, validate=True))\n" +
            f"if hashlib.sha256(program).hexdigest() != {checksum!r}:\n" +
            "    raise RuntimeError('release_program_digest_mismatch')\n" +
            "exec(compile(program, '<id-website-release>', 'exec'))\nID_WEBSITE_RELEASE\n")


CONTAINER_METADATA_FAILURE = re.compile(
    r"container_metadata_read_failed:"
    r"(?:app|drive-backup|sheets-sync|recharge|recharge-native|vendure|formal-mysql|media|caddy|unknown):"
    r"(?:not_found|command_failed|command_unavailable|timeout|invalid_metadata)"
)


def release_failure_diagnostic(invocation):
    reasons = []
    for line in invocation["StandardErrorContent"].splitlines():
        if CONTAINER_METADATA_FAILURE.fullmatch(line):
            reasons.append(line)
            continue
        message = re.fullmatch(r"(?:remote\.ReleaseError: )?([a-z][a-z0-9_]+(?:: [a-z][a-z0-9_]+)?)", line)
        if message and ("_" in message[1] or line.startswith("remote.ReleaseError: ")):
            reasons.append(message[1])
    markers = {
        "Building the exact main native recharge image": "native_build_started",
        "Switching the drained native recharge runtime": "native_cutover_started",
        "Verified the existing native runtime before resuming the interrupted release": "interrupted_preflight_verified",
        "Resuming the adapter and website with the existing native runtime": "interrupted_peripheral_switch_started",
        "Verified the interrupted adapter before the isolated website canary": "interrupted_adapter_ready",
    }
    stdout = invocation["StandardOutputContent"].splitlines()
    phases = [markers[line] for line in stdout if line in markers]
    if any(line.startswith('{"rechargePreflight": ') for line in stdout):
        phases.insert(0, "native_production_readonly_preflight_completed")
    return {"status": invocation["Status"], "phases": phases, "reasons": reasons}


def inspect_release_command(attempt, command_id):
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", command_id):
        raise RuntimeError("invalid_inspection_command")
    rows = aws("ssm", "list-commands", "--command-id", command_id)["Commands"]
    if (len(rows) != 1 or rows[0]["InstanceIds"] != [INSTANCE] or
            rows[0]["DocumentName"] != "AWS-RunShellScript" or
            not re.fullmatch(rf"ID website release {attempt[:12]} run [0-9]+/[0-9]+", rows[0]["Comment"])):
        raise RuntimeError("inspection_command_outside_reviewed_release")
    invocation = aws("ssm", "get-command-invocation", "--command-id", command_id, "--instance-id", INSTANCE)
    return {"command": command_id, "attemptSha": attempt, **release_failure_diagnostic(invocation)}


def recover_command(comment, started):
    for _ in range(3):
        result = aws("ssm", "list-commands", "--filters", f"key=InvokedAfter,value={started}")
        ids = [row["CommandId"] for row in result["Commands"] if row["Comment"] == comment]
        if len(ids) == 1:
            return ids[0]
        if ids:
            break
        time.sleep(3)
    raise RuntimeError("ssm_dispatch_unconfirmed_check_by_comment_before_retry")


def remote(plan):
    name = plan["operation"]
    comment = f"ID website {name} {plan['sha'][:12]} run {os.environ['GITHUB_RUN_ID']}/{os.environ['GITHUB_RUN_ATTEMPT']}"
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"SSM request: {comment}", flush=True)
    execution_timeout = 1140 if plan.get("rechargeCore") else (
        900 if name == "release" and (plan.get("adapter") or plan.get("manualWorkspace")) else 600)
    try:
        result = aws("ssm", "send-command", "--instance-ids", INSTANCE, "--document-name", "AWS-RunShellScript",
                     "--timeout-seconds", "600", "--comment", comment, "--parameters",
                     json.dumps({"commands": [script_for(plan)], "executionTimeout": [str(execution_timeout)]}), once=True)
        command_id = result["Command"]["CommandId"]
    except AwsError as error:
        if error.code not in {"response_unavailable", "InternalServerError", "RequestTimeout", "ServiceUnavailable"}:
            raise
        command_id = recover_command(comment, started)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        command_id = recover_command(comment, started)
    print(f"SSM command: {command_id}", flush=True)
    until = time.monotonic() + execution_timeout + 40
    while time.monotonic() < until:
        try:
            invocation = aws("ssm", "get-command-invocation", "--command-id", command_id, "--instance-id", INSTANCE)
        except AwsError as error:
            if error.code != "InvocationDoesNotExist":
                raise
        else:
            status = invocation["Status"]
            if status == "Success":
                return command_id, json.loads(invocation["StandardOutputContent"].strip().splitlines()[-1])
            if status not in {"Pending", "InProgress", "Delayed", "Cancelling"}:
                report_details = plan.get("rechargeCore") or plan.get("interruptedRelease")
                if report_details:
                    print(json.dumps(release_failure_diagnostic(invocation), sort_keys=True), flush=True)
                    for line in invocation["StandardOutputContent"].splitlines():
                        if re.fullmatch(r'\{"rechargePreflight": [a-zA-Z0-9_":{}, ]+\}', line):
                            print(line, flush=True)
                if plan.get("manualWorkspace"):
                    for line in invocation["StandardOutputContent"].splitlines():
                        if (re.fullmatch(r"manual_workspace_(prepare|check|install|verify|smoke|deactivate)_(started|completed)", line)
                                or re.fullmatch(r'\{"websiteAssetFailure": \{"path": "/[a-zA-Z0-9_./-]{1,150}", '
                                                r'"status": [45][0-9]{2}\}\}', line)):
                            print(line, flush=True)
                for detail in invocation["StandardErrorContent"].splitlines():
                    if re.fullmatch(r"[a-z_]+(?:: [a-z_]+)?", detail) or (
                            not report_details and CONTAINER_METADATA_FAILURE.fullmatch(detail)) or (
                            plan.get("manualWorkspace") and re.fullmatch(
                                r"manual_broker_startup_exit_(1|2|203|216|217|226)|renewal_probe_(open|stop)_http_[1-5][0-9]{2}",
                                detail)):
                        print(detail, flush=True)
                raise RuntimeError(f"SSM {name} {status}: {command_id}")
        time.sleep(5)
    raise RuntimeError(f"SSM {name} outcome still pending: {command_id}")


def put_artifact(path, sha):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            digest.update(chunk)
    size = path.stat().st_size
    checksum = base64.b64encode(digest.digest()).decode("ascii")
    common = ("--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT,
              "--key", f"release-artifacts/formal/{sha}/{path.name}")
    try:
        aws("s3api", "put-object", *common, "--body", str(path), "--if-none-match", "*",
            "--server-side-encryption", "AES256", "--checksum-sha256", checksum)
    except AwsError as error:
        if error.code not in {"PreconditionFailed", "ConditionalRequestConflict", "412", "409"}:
            raise
    head = aws("s3api", "head-object", *common, "--checksum-mode", "ENABLED")
    if (head.get("ChecksumSHA256"), head.get("ContentLength"), head.get("ServerSideEncryption")) != (
        checksum, size, "AES256"
    ) or not head.get("VersionId") or head["VersionId"] == "null":
        raise RuntimeError("formal_artifact_readback_mismatch")
    return {"sha256": digest.hexdigest(), "bytes": size, "version": head["VersionId"]}


def published_asset_receipt():
    command = ["gh", "run", "view", str(ASSET_METADATA_RELEASE_RUN), "--repo",
               "wangchaozhuanyong/id-business-system"]
    fields = "databaseId,workflowDatabaseId,headSha,headBranch,event,status,conclusion"
    run = json.loads(subprocess.check_output(command + ["--json", fields], text=True, timeout=30))
    expected = {"databaseId": ASSET_METADATA_RELEASE_RUN, "workflowDatabaseId": 414321281,
                "headSha": ASSET_METADATA_REPAIR_BASE, "headBranch": "main", "event": "workflow_dispatch",
                "status": "completed", "conclusion": "success"}
    if run != expected:
        raise RuntimeError("asset_metadata_original_release_unverified")
    log = subprocess.check_output(command + ["--log"], text=True, timeout=60)
    receipts = []
    for line in log.splitlines():
        start = line.find('{"appCanaryPassed":')
        if start >= 0:
            value = json.loads(line[start:])
            receipts.append({name: value.get(name) for name in
                             ("mainSha", "appCanaryPassed", "liveAssetsSha256")})
    expected_receipt = {"mainSha": ASSET_METADATA_REPAIR_BASE, "appCanaryPassed": True,
                        "liveAssetsSha256": ASSET_METADATA_REPAIR_DIGEST}
    if receipts != [expected_receipt]:
        raise RuntimeError("asset_metadata_original_receipt_mismatch")
    return {"runId": ASSET_METADATA_RELEASE_RUN, **expected_receipt}


INTERRUPTED_RELEASE_FILES = {
    ".github/workflows/production-website-release.yml",
    "deploy/website/interrupted_cutover.py",
    "deploy/website/interrupted_cutover_test.py",
    "deploy/website/interrupted_release.py",
    "deploy/website/interrupted_release_test.py",
    "deploy/website/recharge_core.py",
    "deploy/website/recharge_core_test.py",
    "deploy/website/release.py",
    "deploy/website/release_test.py",
    "deploy/website/remote.py",
    "deploy/website/vendure_admission.py",
    "docs/PRODUCTION_OPERATIONS.md",
    "frontend/bitbrowser-local.html",
    "frontend/bitbrowser-local.mjs",
    "server/local-business.mjs",
    "server/preview.mjs",
    "test/check-ui-contract.mjs",
    "test/native-browser-store.test.mjs",
    "test/workbench-cloud-hold.browser.mjs",
}
INTERRUPTED_GATE_SOURCE = "deploy/recharge-core/release-gate.py"
INTERRUPTED_NATIVE = {
    "id": "1eda0d9c13d2693de133f5af566fb231b30550ab1b00defc14e88e57ad4a3984",
    "image": "sha256:b5d33ff0bfd6b6b66f9af2a2069e707dc5a0edcf4b29a62e90c238db78fe43c8",
    "startedAt": "2026-11-27T04:48:54.715428665Z",
    "running": True,
}


def interrupted_release_plan(sha):
    from interrupted_cutover import HELPER_FILES
    from interrupted_release import INTERRUPTED_SHA, INTERRUPTED_WEBSITE_SHA, INTERRUPTED_NEW_ASSETS, original_baseline

    require_ancestor(INTERRUPTED_SHA, sha)
    delta = set(git("diff", "--name-only", INTERRUPTED_SHA, sha).splitlines())
    from_live = set(git("diff", "--name-only", INTERRUPTED_WEBSITE_SHA, INTERRUPTED_SHA, "--", *CORE_PATHS).splitlines())
    if (not delta or not delta <= INTERRUPTED_RELEASE_FILES or
            from_live != CARD_REUSE_ROUTING_HEALTH_AND_CANARY_NATIVE_SCOPE):
        raise RuntimeError("interrupted_release_scope_mismatch")
    previous = original_baseline(aws, INSTANCE)
    baseline = {name: previous[name] for name in
                ("components", "unitSha256", "gatewaySha256", "assetsSha256", "launchers", "adapterUnit")}
    runtime_sources = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in HELPER_FILES}
    return {"sha": INTERRUPTED_SHA, "before": baseline,
            "native": INTERRUPTED_NATIVE | {"revision": INTERRUPTED_SHA},
            "assetsSha256": INTERRUPTED_NEW_ASSETS, "runtimeSources": runtime_sources,
            "gateSha256": runtime_sources[INTERRUPTED_GATE_SOURCE]}


def main(sample_backup_resources=False):
    sha = os.environ["RELEASE_SHA"]
    quality_run = os.environ["QUALITY_RUN_ID"]
    require_main(sha)
    attempt = os.environ.get("INSPECT_CANARY_SHA")
    inspect_command = os.environ.get("INSPECT_RELEASE_COMMAND")
    include_adapter = os.environ.get("RELEASE_RECHARGE_ADAPTER") == "true"
    include_core = os.environ.get("RELEASE_RECHARGE_CORE") == "true"
    retry_receipt = os.environ.get("VENDURE_RETRY_RECEIPT_SHA256", "")
    partner_api = os.environ.get("RELEASE_RECHARGE_PARTNER_API") == "true"
    customer_progress = os.environ.get("RELEASE_CUSTOMER_PROGRESS") == "true"
    resume_interrupted = os.environ.get("RESUME_INTERRUPTED_RELEASE") == "true"
    manual_workspace = os.environ.get("RELEASE_MANUAL_WORKSPACE") == "true"
    if manual_workspace and any((attempt, inspect_command, include_adapter, include_core, retry_receipt,
                                 partner_api, customer_progress, resume_interrupted, sample_backup_resources,
                                 os.environ.get("INSPECT_MANUAL_WORKSPACE_HOST") == "true")):
        raise RuntimeError("manual_workspace_release_requires_its_own_operation")
    if os.environ.get("INSPECT_MANUAL_WORKSPACE_HOST") == "true":
        if any((inspect_command, include_adapter, include_core, retry_receipt, partner_api,
                customer_progress, resume_interrupted, sample_backup_resources)):
            raise RuntimeError("manual_workspace_inspection_requires_its_own_operation")
        plan = {"operation": "inspect-manual-workspace", "sha": sha}
        if attempt:
            if not SHA.fullmatch(attempt):
                raise RuntimeError("invalid_manual_workspace_attempt_revision")
            require_ancestor(attempt, sha)
            plan["attemptSha"] = attempt
        command_id, host = remote(plan)
        print(json.dumps({"command": command_id, "workspaceHost": host}), flush=True)
        return
    if resume_interrupted and any((attempt, inspect_command, include_adapter, include_core, retry_receipt,
                                  partner_api, customer_progress, sample_backup_resources)):
        raise RuntimeError("interrupted_release_requires_its_own_operation")
    if sample_backup_resources and (not attempt or inspect_command or include_adapter or include_core or
                                    retry_receipt or partner_api or customer_progress):
        raise RuntimeError("backup_observation_requires_readonly_inspection")
    if customer_progress and (include_adapter or include_core or partner_api or attempt or inspect_command or retry_receipt):
        raise RuntimeError("customer_progress_release_requires_its_own_operation")
    if partner_api and (include_adapter or include_core or attempt or inspect_command or retry_receipt):
        raise RuntimeError("partner_api_release_requires_its_own_operation")
    if retry_receipt and (not SHA256.fullmatch(retry_receipt) or
                          include_adapter or include_core or attempt or inspect_command):
        raise RuntimeError("vendure_gateway_refresh_requires_one_reviewed_receipt")
    if inspect_command and not attempt:
        raise RuntimeError("inspection_requires_attempt_revision")
    if include_core and (include_adapter or attempt):
        raise RuntimeError("recharge_core_release_requires_its_own_operation")
    if attempt:
        if include_adapter:
            raise RuntimeError("inspect_and_release_are_separate")
        require_ancestor(attempt, sha)
        if inspect_command:
            print(json.dumps(inspect_release_command(attempt, inspect_command), sort_keys=True), flush=True)
            return
        plan = {"operation": "inspect", "sha": sha, "attemptSha": attempt}
        if sample_backup_resources:
            plan["sampleBackupResources"] = True
        command_id, diagnostic = remote(plan)
        print(json.dumps({"command": command_id, "diagnostic": diagnostic}), flush=True)
        return
    interrupted = interrupted_release_plan(sha) if resume_interrupted else None
    if interrupted:
        preflight_id, before = remote({"operation": "interrupted-preflight", "sha": sha,
                                      "interruptedRelease": interrupted})
    else:
        preflight_id, before = remote({"operation": "preflight", "sha": sha, "adapter": include_adapter or include_core})
    base = before["components"]["app"]["revision"]
    print(f"Live website: {base}; free bytes: {before['freeBytes']}", flush=True)
    if base == sha:
        raise RuntimeError("requested_revision_already_running_read_back_the_existing_release")
    presentation_scope, presentation = None, None
    if not interrupted:
        presentation_scope, presentation = require_website_scope(base, sha, include_adapter, include_core,
            partner_api=partner_api, native_publication=before.get("nativePublication")) or (None, None)
    if presentation_scope == "rechargeRedemptionCardImportPresentation" and (retry_receipt or customer_progress):
        raise RuntimeError("recharge_presentation_requires_plain_website")
    deferred_native = None
    deployed_native = None
    if presentation_scope == "deployedNativeBuildInputs":
        deployed_native = presentation
        presentation_scope, presentation = None, None
        if retry_receipt or customer_progress:
            raise RuntimeError("deployed_native_inputs_require_plain_website")
    if presentation_scope == "deferredNativeBuildInputs":
        deferred_native = presentation
        presentation_scope, presentation = None, None
    elif presentation:
        presentation = dict(presentation)
        deferred_native = presentation.pop("deferredNativeInputs", None)
    if deferred_native and (retry_receipt or customer_progress or
                            before["assetsSha256"] != deferred_native["assetsSha256"]):
        raise RuntimeError("deferred_native_inputs_live_baseline_mismatch")
    retry_inputs_only = deferred_native is not None and deferred_native["reviewedCommit"] == DEFERRED_RETRY_MERGE
    if retry_inputs_only:
        verify_deferred_retry_baseline(before)
    if include_adapter or include_core:
        for name in ("recharge", "recharge-native"):
            require_ancestor(before["components"][name]["revision"], sha)
    names = (f"independent-source-{sha}.tar.gz", f"independent-assets-{sha}.json", f"independent-event-runtime-{sha}.tar.gz")
    expected_assets = before["assetsSha256"]
    actual_assets = hashlib.sha256((OUTPUT / names[1]).read_bytes()).hexdigest()
    asset_repair = None
    if interrupted:
        expected_assets = interrupted["assetsSha256"]
        if actual_assets != expected_assets:
            raise RuntimeError("interrupted_release_asset_digest_mismatch")
    elif include_core:
        expected_assets = actual_assets
    if presentation:
        if presentation["beforeAssetsSha256"] != expected_assets:
            raise RuntimeError("recharge_presentation_live_baseline_mismatch")
        if presentation_scope in PRESENTATION_MOUNT_ERRORS and (
                before.get("mountedAssets", {}).get("available") is not True or
                before["mountedAssets"].get("sha256") != expected_assets):
            raise RuntimeError(PRESENTATION_MOUNT_ERRORS[presentation_scope])
        expected_assets = presentation["assetsSha256"]
    if (actual_assets != expected_assets and base == ASSET_METADATA_REPAIR_BASE and
            actual_assets == ASSET_METADATA_REPAIR_DIGEST and not any((include_core, include_adapter, presentation,
            partner_api, customer_progress, retry_receipt, deferred_native)) and
            before.get("mountedAssets", {}).get("available") is True and
            before["mountedAssets"].get("sha256") == actual_assets):
        repair_id, repaired = remote({"operation": "repair-assets", "sha": sha, "before": before,
                                     "publishedAssetReceipt": published_asset_receipt(),
                                     "expectedAssetsSha256": actual_assets,
                                     "expectedAssetsBytes": (OUTPUT / names[1]).stat().st_size})
        before = repaired["before"]
        expected_assets = before["assetsSha256"]
        asset_repair = {"command": repair_id, **repaired["repair"]}
    if actual_assets != expected_assets:
        print(json.dumps({"assetVerification": {
            "baseWebsiteSha": base, "expectedSha256": expected_assets,
            "live": before.get("assetsSummary"),
            "candidate": asset_bundle_summary(OUTPUT / names[1])
        }}, sort_keys=True), flush=True)
        raise RuntimeError("website_release_would_change_recharge_assets")
    image_id = None
    if manual_workspace:
        image_id = (OUTPUT / f"independent-manual-image-{sha}.id").read_text().strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
            raise RuntimeError("manual_workspace_image_identity_missing")
        names += (f"independent-manual-image-{sha}.tar.gz", f"independent-manual-runtime-{sha}.tar.gz")
    require_main(sha)
    artifacts = {name: put_artifact(OUTPUT / name, sha) for name in names}
    files = ("frontend/index.html", "frontend/commerce-prototype.js", "frontend/subscription-management.js",
             "frontend/prototype.css", "server/preview.mjs", "server/backup/cloud-drive.mjs",
             "frontend/prototype.js", "frontend/interaction-preferences.js", "frontend/change-sync.js",
             "frontend/local-data.js", "frontend/operations-prototype.js", "frontend/apple-balance-prototype.js",
             "frontend/customer-query.js", "frontend/mailbox-delivery.js", "frontend/inventory-prototype.js",
             "frontend/apple-relay-prototype.js", "server/customer-query.mjs", "server/tools/mailbox-pool.mjs",
             "frontend/system-monitoring.js", "server/monitoring-route.mjs",
             "server/tools/website-analytics.mjs", "server/tools/read-tool-config.mjs",
             "frontend/recharge-integration.css", "frontend/bitbrowser-addresses.css",
             "frontend/recharge-activity.js", "frontend/recharge-activity.css",
             "frontend/data-center.js", "frontend/data-center.css", "frontend/sheets-status.js", "frontend/sheets-status.css",
             "frontend/site-management.js", "frontend/site-management.css", "frontend/site-timing.js", "frontend/local-auth.js",
             "frontend/account-security.js", "frontend/staff-workspaces.mjs",
             "frontend/page-modules.mjs", "frontend/finance-reconciliation.mjs", "frontend/renewal-reminders.mjs",
             "frontend/apple-funding.mjs", "frontend/list-order.mjs",
             "modules/website/pages.mjs", "modules/orders/order-opening.mjs", "modules/orders/list-order.mjs",
             "modules/orders/order-customer-match.mjs", "modules/orders/order-whatsapp.mjs", "server/order-customer-write.mjs",
             "modules/finance/apple-funding.mjs", "modules/orders/renewal-reminders.mjs", "modules/data/document-delta.mjs",
             "modules/orders/order-list.mjs", "modules/inventory/list.mjs", "modules/finance/accounting.mjs",
             "modules/data/record-edit.mjs", "modules/recharge/codexdaichong/card-import-preview.mjs",
             "server/business-lists.mjs", "server/record-edit.mjs",
             "server/renewal-sidebar.mjs", "server/account-lifecycle.mjs", "server/finance/recharge-reconciliation.mjs",
             "server/site-management.mjs", "server/site-observations.mjs", "server/access-roles.mjs",
             "server/local-auth.mjs", "server/login-security.mjs", "server/staff-workspaces.mjs",
             "frontend/renewal-handoff.js", "server/renewal-handoff.mjs", "server/backup/cloud-cli.mjs",
             "server/backup/cloud-worker.mjs", "server/backup/local-sqlite.mjs",
             "server/local-business.mjs", "server/native-browser-workbench.mjs",
             "frontend/bitbrowser-local.mjs",
             "server/native-chrome-runner.mjs", "server/recharge-activity.mjs",
             "server/backup/sheets-source.mjs", "server/monitoring-policy.mjs",
             "server/tools/website-analytics.mjs", "server/tools/sheets-status.mjs",
             "server/monitoring-sources.mjs", "server/monitoring-worker-receipts.mjs", "server/system-monitoring.mjs",
             "deploy/website/backup_monitoring.py", "deploy/website/id-business-independent-backup-monitoring.service",
             "deploy/website/id-business-independent-backup-monitoring.timer")
    files += (BACKUP_OPERATION, "deploy/website/recovery_capsule.py",
              "server/backup/recovery-archive.mjs", "server/backup/recovery-archive-cli.mjs")
    files += tuple(path for path in ("frontend/order-opening.mjs", "server/recharge-order-sync.mjs")
                   if (ROOT / path).is_file())
    files += ('server/recharge-events.mjs', 'server/apple-relay/mail-updates.mjs',
              'server/apple-relay/local-service.mjs', 'server/order-recharge-client.mjs', 'modules/external-events/recharge_cdc.py',
              'modules/external-events/committed-jobs.mjs', 'modules/external-events/vendure-mail.mjs',
              'modules/external-events/requirements.txt')
    if presentation_scope:
        files += PRESENTATION_SCOPES[presentation_scope][0]
    if presentation_scope == "cardNumberPresentation":
        files += (CARD_NUMBER_MANIFEST_PATH, "frontend/order-completion.js", "server/card-management.mjs",
                  "server/order-auxiliary.mjs", "server/order-completion.mjs", "server/order-recovery.mjs",
                  "server/subscription-management.mjs", "modules/recharge/bitbrowser/login/index.mjs",
                  "modules/recharge/bitbrowser/login/direct-login.mjs")
    if presentation_scope == "cardFirstPaintPresentation":
        files += (CARD_FIRST_PAINT_MANIFEST_PATH,)
    if presentation_scope == "cardListToolbarPresentation":
        files += (CARD_LIST_TOOLBAR_MANIFEST_PATH,)
    if presentation_scope == "orbitcardLayoutPresentation":
        files += (ORBITCARD_LAYOUT_MANIFEST_PATH,)
    if presentation_scope == "cardPoolLimitPresentation":
        files += (CARD_POOL_LIMIT_MANIFEST_PATH,)
    if presentation_scope == "cardPoolTogglePresentation":
        files += (CARD_POOL_TOGGLE_MANIFEST_PATH, "server/card-management.mjs")
    if presentation_scope == "cardReuseLimitsPresentation":
        files += (CARD_REUSE_LIMITS_MANIFEST_PATH,)
    if presentation_scope == "rechargeRedemptionCardImportPresentation":
        files += (RECHARGE_REDEMPTION_CARD_IMPORT_MANIFEST_PATH, "frontend/order-operations.js",
                  "frontend/recharge-partners.mjs")
    if presentation_scope == "rechargeAdminWorkspacePresentation":
        files += ("frontend/finance-collection.js", "server/finance/collection-route.mjs", "server/card-management.mjs",
                  "deploy/website/check-business-action.mjs")
    if presentation_scope == "actionPasswordPresentation":
        files += ("server/finance/collection-route.mjs", "server/card-management.mjs",
                  "server/recharge-partner-api.mjs", "deploy/website/check-business-action.mjs")
    if presentation_scope == "redeemPresentation":
        files += ("modules/finance/accounting.mjs",)
    if include_adapter:
        files += ("server/card-management.mjs",
                  "server/order-auxiliary.mjs", "server/order-recharge-client.mjs",
                  "modules/recharge/codexdaichong/gateway.mjs", "modules/recharge/codexdaichong/local-gateway.mjs",
                  *ADAPTER_FILES)
    if include_core or interrupted:
        files = tuple(dict.fromkeys((*files, *NATIVE_RELEASE_FILES)))
    if interrupted:
        files += ("deploy/website/interrupted_cutover.py", INTERRUPTED_GATE_SOURCE)
    if retry_receipt or partner_api or customer_progress:
        files += VENDURE_REFRESH_FILES
    if partner_api or customer_progress:
        files += PARTNER_API_FILES
    if customer_progress:
        files += CUSTOMER_PROGRESS_FILES
    if retry_inputs_only:
        files += (*sorted(DEFERRED_RETRY_INPUTS), RETRY_DEPLOY_SCRIPT)
    elif deferred_native:
        files += ("frontend/recharge-partners.mjs", *sorted(DEFERRED_DEBUG_FILES))
    if deployed_native:
        files += tuple(sorted(DEPLOYED_TRIAL_BUILD_INPUTS))
    if manual_workspace:
        files += ("frontend/native-workbench-prototype.html", "frontend/native-workbench-prototype.mjs",
                  "frontend/native-workbench-prototype.css", "server/manual-remote-access.mjs",
                  "server/manual-desktop-workspace.mjs", "frontend/bitbrowser-addresses.js",
                  "frontend/operations-prototype.js", "deploy/manual-desktop/broker.py",
                  "deploy/manual-desktop/worker/recharge_proxy.py", "deploy/manual-desktop/worker/worker.py",
                  "deploy/manual-desktop/egress.py", "deploy/manual-desktop/host/provision.py",
                  "deploy/manual-desktop/host/runtime.py", "deploy/manual-desktop/host/check_renewal.py",
                  "deploy/manual-desktop/host/polkit-rpms.json")
    plan = {"operation": "release", "sha": sha, "before": before, "artifacts": artifacts,
            "files": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
            "qualityRun": quality_run, "preflightCommand": preflight_id, 'externalEvents': True}
    if asset_repair:
        plan["assetMetadataRepair"] = asset_repair
    if deployed_native:
        plan["deployedNativeBuildInputs"] = deployed_native
    if include_adapter or interrupted:
        plan["adapter"] = {"runtimeFiles": ADAPTER_RUNTIME_FILES}
    if interrupted:
        plan["interruptedRelease"] = interrupted
    if include_core:
        plan["rechargeCore"] = {"assetsSha256": expected_assets}
        plan["adapter"] = {"runtimeFiles": ADAPTER_RUNTIME_FILES}
    if retry_receipt:
        plan["vendureRetryReceipt"] = retry_receipt
    if partner_api:
        plan["rechargePartnerApi"] = True
    if customer_progress:
        plan["customerProgress"] = True
    if presentation_scope:
        plan[presentation_scope] = presentation
    if manual_workspace:
        plan["manualWorkspace"] = {"imageId": image_id}
    require_main(sha)
    command_id, receipt = remote(plan)
    if receipt.get("mainSha") != sha or not receipt.get("appCanaryPassed"):
        raise RuntimeError(f"website_release_receipt_mismatch: {command_id}")
    if manual_workspace:
        desktop = receipt.get("manualWorkspace", {})
        if (desktop.get("imageId") != image_id or desktop.get("browserSandboxVerified") is not True
                or desktop.get("websiteBrokerVerified") is not True or desktop.get("renewalLifecycleVerified") is not True
                or desktop.get("maxActive") != 1 or receipt.get("protectedComponentsUnchanged") is not True):
            raise RuntimeError(f"manual_workspace_release_receipt_mismatch: {command_id}")
    recovery = receipt.get("portableRecoveryBackup", {})
    if recovery.get("sourceRevision") != sha or recovery.get("programSha256") != plan["files"][BACKUP_OPERATION]:
        raise RuntimeError(f"backup_program_release_receipt_mismatch: {command_id}")
    if interrupted:
        resumed = receipt.get("interruptedRelease", {})
        if (resumed.get("native") != interrupted["native"] or
                any(resumed.get(name) is not True for name in ("nativeEngineUnchanged", "nativeCanaryPassed",
                    "encryptedSnapshotVerified", "workerPollingObserved", "ingressResumed")) or
                resumed.get("workerSourceRevision") != interrupted["sha"] or
                receipt.get("adapter", {}).get("revision") != sha or
                receipt.get("website", {}).get("revision") != sha or
                receipt.get("productionBusinessTestWrites") is not False or
                receipt.get("liveAssetsSha256") != expected_assets):
            raise RuntimeError(f"interrupted_release_receipt_mismatch: {command_id}")
    if include_adapter and (receipt.get("adapter", {}).get("revision") != sha or
                            not receipt.get("adapterCanaryPassed") or not receipt.get("nativeEngineUnchanged")):
        raise RuntimeError(f"adapter_release_receipt_mismatch: {command_id}")
    if include_core:
        core = receipt.get("rechargeCore", {})
        if (core.get("native", {}).get("revision") != sha or receipt.get("adapter", {}).get("revision") != sha or
                core.get("workerSourceRevision") != sha or core.get("ingressResumed") is not True or
                core.get("nativeCanaryPassed") is not True or receipt.get("liveAssetsSha256") != expected_assets):
            raise RuntimeError(f"recharge_core_release_receipt_mismatch: {command_id}")
    if retry_receipt:
        gateway = receipt.get("vendureGateway", {})
        if (gateway.get("gatewaySha") != sha or gateway.get("accepting") is not True or
                gateway.get("singleRetryReceiptVerified") is not True or
                gateway.get("originalRuntimeUnchanged") is not True or
                gateway.get("workerPollingObserved") is not True):
            raise RuntimeError(f"vendure_gateway_release_receipt_mismatch: {command_id}")
    if partner_api:
        gateway = receipt.get("vendureGateway", {})
        if (gateway.get("gatewaySha") != sha or gateway.get("partnerSocketVerified") is not True or
                gateway.get("accepting") is not True or gateway.get("workerPollingObserved") is not True or
                gateway.get("originalRuntimeUnchanged") is not True):
            raise RuntimeError(f"recharge_partner_api_release_receipt_mismatch: {command_id}")
    if customer_progress:
        gateway = receipt.get("vendureGateway", {})
        if (gateway.get("gatewaySha") != sha or gateway.get("workerSourceRevision") != sha or
                gateway.get("workerFilesVerified") is not True or gateway.get("workerPollingObserved") is not True or
                gateway.get("originalRuntimeUnchanged") is not True or gateway.get("partnerSocketVerified") is not True or
                gateway.get("accepting") is not True):
            raise RuntimeError(f"customer_progress_release_receipt_mismatch: {command_id}")
    if presentation_scope and (receipt.get(presentation_scope + "Verified") is not True or
                               receipt.get("liveAssetsSha256") != expected_assets or
                               receipt.get("protectedComponentsUnchanged") is not True):
        raise RuntimeError(f"recharge_presentation_release_receipt_mismatch: {command_id}")
    if deferred_native:
        receipt["deferredNativeBuildInputs"] = verify_deferred_native_receipt(
            receipt, deferred_native, before, expected_assets=expected_assets)
    if deployed_native and (receipt.get("deployedNativeBuildInputs") != deployed_native or
            receipt.get("protectedComponentsUnchanged") is not True or
            any(name in receipt for name in ("adapter", "rechargeCore"))):
        raise RuntimeError("deployed_native_runtime_changed")
    receipt["releaseCommand"] = command_id
    print(json.dumps(receipt, sort_keys=True), flush=True)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Website release `{sha}`\n\nQuality run `{quality_run}` · SSM `{command_id}`\n")


if __name__ == "__main__":
    if sys.argv[1:] not in ([], ["--sample-backup-resources"]):
        raise RuntimeError("unsupported_release_argument")
    main(sample_backup_resources=bool(sys.argv[1:]))
