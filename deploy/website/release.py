"""Dispatch the independent website release from the checked main revision."""

import base64
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from remote import (CARD_IMPORT_ASSET_SOURCE, CARD_IMPORT_PRESENTATION_FILES, CARD_PLAN_PRESENTATION_FILES,
                    PRESENTATION_SCOPES,
                    REDEEM_PRESENTATION_FILES, TABLE_ACTIONS_STYLESHEET, WORKSPACE_PROGRESS_PRESENTATION_FILES)

ACCOUNT = "098208446664"
REGION = "ap-northeast-1"
INSTANCE = "i-0838cebf64f0e2a89"
BUCKET = f"id-business-v2-backups-{ACCOUNT}-{REGION}"
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / ".runtime/website-release"
SHA = re.compile(r"[a-f0-9]{40}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
PROXY_TYPE_CATALOG = "modules/recharge/bitbrowser/proxy-types.mjs"
CORE_PATHS = ("deploy/recharge-core", "deploy/caddy", "modules/recharge/codexdaichong", "package.json", PROXY_TYPE_CATALOG)
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
NATIVE_CORE_SCOPE = NATIVE_PATCH_FILES | {
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
    "modules/recharge/vendure/codexdaichong-worker.mjs",
}))


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


def require_presentation_approval(base, sha, manifest, approved_files):
    approval_file = ROOT / "deploy/website" / manifest
    try:
        approval = json.loads(approval_file.read_bytes())
        assets = {key: approval[key] for key in ("beforeAssetsSha256", "assetsSha256")}
        files = approval["files"]
        if (not all(isinstance(value, str) and SHA256.fullmatch(value) for value in assets.values()) or
                assets["beforeAssetsSha256"] == assets["assetsSha256"] or
                not isinstance(files, dict) or set(files) != set(approved_files) or
                not all(isinstance(pair, dict) and set(pair) == {"before", "after"} and
                        all(isinstance(value, str) and SHA256.fullmatch(value) for value in pair.values())
                        for pair in files.values())):
            raise ValueError("invalid scope")
    except (KeyError, OSError, TypeError, ValueError) as error:
        raise RuntimeError("recharge_presentation_approval_invalid") from error
    for name in approved_files:
        for side, revision in (("before", base), ("after", sha)):
            content = subprocess.check_output(["git", "show", f"{revision}:{name}"], cwd=ROOT, timeout=30)
            if hashlib.sha256(content).hexdigest() != files[name][side]:
                raise RuntimeError("recharge_presentation_source_mismatch")
    return assets


def require_redeem_presentation(base, sha):
    return require_presentation_approval(base, sha, "redeem-log-20261111.json", REDEEM_PRESENTATION_FILES)


def require_website_scope(base, sha, include_adapter=False, include_core=False):
    require_ancestor(base, sha)
    changed = set(git("diff", "--name-only", base, sha, "--", *CORE_PATHS).splitlines())
    if include_core:
        approved_patches = NATIVE_PATCH_FILES <= changed <= NATIVE_CORE_SCOPE
        if include_adapter or (not approved_patches and changed != PROXY_TYPE_CORE_SCOPE):
            raise RuntimeError("recharge_native_release_scope_mismatch")
    elif include_adapter:
        if not changed <= ADAPTER_SCOPE or not changed.intersection(ADAPTER_RUNTIME_FILES):
            raise RuntimeError("recharge_adapter_release_scope_mismatch")
    elif changed == set(REDEEM_PRESENTATION_FILES):
        return "redeemPresentation", require_redeem_presentation(base, sha)
    elif changed == set(WORKSPACE_PROGRESS_PRESENTATION_FILES):
        return "workspaceProgressPresentation", require_presentation_approval(
            base, sha, "workspace-progress-20261113.json", WORKSPACE_PROGRESS_PRESENTATION_FILES)
    elif changed == {TABLE_ACTIONS_STYLESHEET}:
        return "tableActionsPresentation", require_presentation_approval(
            base, sha, "table-actions-20261112.json", (TABLE_ACTIONS_STYLESHEET,))
    elif changed == {CARD_IMPORT_ASSET_SOURCE}:
        return "cardImportPresentation", require_presentation_approval(
            base, sha, "card-import-20261113.json", CARD_IMPORT_PRESENTATION_FILES)
    elif changed == set(CARD_PLAN_PRESENTATION_FILES):
        return "cardPlanPresentation", require_presentation_approval(
            base, sha, "card-plan-ui-20261113.json", CARD_PLAN_PRESENTATION_FILES)
    elif changed:
        raise RuntimeError("recharge_core_or_runtime_changed")


def script_for(plan):
    script = Path(__file__).with_name("remote.py").read_text()
    return "set -eu\npython3 - <<'ID_WEBSITE_RELEASE'\n" + script + \
        f"\nsys.modules['remote'] = sys.modules[__name__]\nmain(json.loads({json.dumps(plan)!r}))\nID_WEBSITE_RELEASE\n"


def release_failure_diagnostic(invocation):
    reasons = []
    for line in invocation["StandardErrorContent"].splitlines():
        message = re.fullmatch(r"(?:remote\.ReleaseError: )?([a-z][a-z0-9_]+(?:: [a-z][a-z0-9_]+)?)", line)
        if message and ("_" in message[1] or line.startswith("remote.ReleaseError: ")):
            reasons.append(message[1])
    markers = {
        "Building the exact main native recharge image": "native_build_started",
        "Switching the drained native recharge runtime": "native_cutover_started",
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
    execution_timeout = 1140 if plan.get("rechargeCore") else (900 if plan.get("adapter") and name == "release" else 600)
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
                if plan.get("rechargeCore"):
                    print(json.dumps(release_failure_diagnostic(invocation), sort_keys=True), flush=True)
                    for line in invocation["StandardOutputContent"].splitlines():
                        if re.fullmatch(r'\{"rechargePreflight": [a-zA-Z0-9_":{}, ]+\}', line):
                            print(line, flush=True)
                for detail in invocation["StandardErrorContent"].splitlines():
                    if re.fullmatch(r"[a-z_]+(?:: [a-z_]+)?", detail):
                        print(detail, flush=True)
                raise RuntimeError(f"SSM {name} {status}: {command_id}")
        time.sleep(5)
    raise RuntimeError(f"SSM {name} outcome still pending: {command_id}")


def put_artifact(path, sha):
    data = path.read_bytes()
    checksum = base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")
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
        checksum, len(data), "AES256"
    ) or not head.get("VersionId") or head["VersionId"] == "null":
        raise RuntimeError("formal_artifact_readback_mismatch")
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "version": head["VersionId"]}


def main():
    sha = os.environ["RELEASE_SHA"]
    quality_run = os.environ["QUALITY_RUN_ID"]
    require_main(sha)
    attempt = os.environ.get("INSPECT_CANARY_SHA")
    inspect_command = os.environ.get("INSPECT_RELEASE_COMMAND")
    include_adapter = os.environ.get("RELEASE_RECHARGE_ADAPTER") == "true"
    include_core = os.environ.get("RELEASE_RECHARGE_CORE") == "true"
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
        command_id, diagnostic = remote({"operation": "inspect", "sha": sha, "attemptSha": attempt})
        print(json.dumps({"command": command_id, "diagnostic": diagnostic}), flush=True)
        return
    preflight_id, before = remote({"operation": "preflight", "sha": sha, "adapter": include_adapter or include_core})
    base = before["components"]["app"]["revision"]
    print(f"Live website: {base}; free bytes: {before['freeBytes']}", flush=True)
    if base == sha:
        raise RuntimeError("requested_revision_already_running_read_back_the_existing_release")
    presentation_scope, presentation = require_website_scope(base, sha, include_adapter, include_core) or (None, None)
    if include_adapter or include_core:
        for name in ("recharge", "recharge-native"):
            require_ancestor(before["components"][name]["revision"], sha)
    names = (f"independent-source-{sha}.tar.gz", f"independent-assets-{sha}.json", f"independent-event-runtime-{sha}.tar.gz")
    expected_assets = before["assetsSha256"]
    actual_assets = hashlib.sha256((OUTPUT / names[1]).read_bytes()).hexdigest()
    if include_core:
        expected_assets = actual_assets
    if presentation:
        if presentation["beforeAssetsSha256"] != expected_assets:
            raise RuntimeError("recharge_presentation_live_baseline_mismatch")
        expected_assets = presentation["assetsSha256"]
    if actual_assets != expected_assets:
        raise RuntimeError("website_release_would_change_recharge_assets")
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
             "server/local-business.mjs", "server/recharge-activity.mjs",
             "server/backup/sheets-source.mjs", "server/monitoring-policy.mjs",
             "server/tools/website-analytics.mjs", "server/tools/sheets-status.mjs",
             "server/monitoring-sources.mjs", "server/monitoring-worker-receipts.mjs", "server/system-monitoring.mjs",
             "deploy/website/backup_monitoring.py", "deploy/website/id-business-independent-backup-monitoring.service",
             "deploy/website/id-business-independent-backup-monitoring.timer")
    files += tuple(path for path in ("frontend/order-opening.mjs", "server/recharge-order-sync.mjs")
                   if (ROOT / path).is_file())
    files += ('server/recharge-events.mjs', 'server/apple-relay/mail-updates.mjs',
              'server/apple-relay/local-service.mjs', 'server/order-recharge-client.mjs', 'modules/external-events/recharge_cdc.py',
              'modules/external-events/committed-jobs.mjs', 'modules/external-events/vendure-mail.mjs',
              'modules/external-events/requirements.txt')
    if presentation_scope:
        files += PRESENTATION_SCOPES[presentation_scope][0]
    if presentation_scope == "redeemPresentation":
        files += ("modules/finance/accounting.mjs",)
    if include_adapter:
        files += ("server/card-management.mjs",
                  "server/order-auxiliary.mjs", "server/order-recharge-client.mjs",
                  "modules/recharge/codexdaichong/gateway.mjs", "modules/recharge/codexdaichong/local-gateway.mjs",
                  *ADAPTER_FILES)
    if include_core:
        files = tuple(dict.fromkeys((*files, *NATIVE_RELEASE_FILES)))
    plan = {"operation": "release", "sha": sha, "before": before, "artifacts": artifacts,
            "files": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
            "qualityRun": quality_run, "preflightCommand": preflight_id, 'externalEvents': True}
    if include_adapter:
        plan["adapter"] = {"runtimeFiles": ADAPTER_RUNTIME_FILES}
    if include_core:
        plan["rechargeCore"] = {"assetsSha256": expected_assets}
        plan["adapter"] = {"runtimeFiles": ADAPTER_RUNTIME_FILES}
    if presentation_scope:
        plan[presentation_scope] = presentation
    require_main(sha)
    command_id, receipt = remote(plan)
    if receipt.get("mainSha") != sha or not receipt.get("appCanaryPassed"):
        raise RuntimeError(f"website_release_receipt_mismatch: {command_id}")
    if include_adapter and (receipt.get("adapter", {}).get("revision") != sha or
                            not receipt.get("adapterCanaryPassed") or not receipt.get("nativeEngineUnchanged")):
        raise RuntimeError(f"adapter_release_receipt_mismatch: {command_id}")
    if include_core:
        core = receipt.get("rechargeCore", {})
        if (core.get("native", {}).get("revision") != sha or receipt.get("adapter", {}).get("revision") != sha or
                core.get("workerSourceRevision") != sha or core.get("ingressResumed") is not True or
                core.get("nativeCanaryPassed") is not True or receipt.get("liveAssetsSha256") != expected_assets):
            raise RuntimeError(f"recharge_core_release_receipt_mismatch: {command_id}")
    if presentation_scope and (receipt.get(presentation_scope + "Verified") is not True or
                               receipt.get("liveAssetsSha256") != expected_assets or
                               receipt.get("protectedComponentsUnchanged") is not True):
        raise RuntimeError(f"recharge_presentation_release_receipt_mismatch: {command_id}")
    receipt["releaseCommand"] = command_id
    print(json.dumps(receipt, sort_keys=True), flush=True)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Website release `{sha}`\n\nQuality run `{quality_run}` · SSM `{command_id}`\n")


if __name__ == "__main__":
    main()
