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

ACCOUNT = "098208446664"
REGION = "ap-northeast-1"
INSTANCE = "i-0838cebf64f0e2a89"
BUCKET = f"id-business-v2-backups-{ACCOUNT}-{REGION}"
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / ".runtime/website-release"
SHA = re.compile(r"[a-f0-9]{40}\Z")
CORE_PATHS = ("deploy/recharge-core", "deploy/caddy", "modules/recharge/codexdaichong", "package.json")


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


def require_website_scope(base, sha):
    require_ancestor(base, sha)
    if git("diff", "--name-only", base, sha, "--", *CORE_PATHS):
        raise RuntimeError("recharge_core_or_runtime_changed")


def script_for(plan):
    script = Path(__file__).with_name("remote.py").read_text()
    return "set -eu\npython3 - <<'ID_WEBSITE_RELEASE'\n" + script + \
        f"\nmain(json.loads({json.dumps(plan)!r}))\nID_WEBSITE_RELEASE\n"


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
    try:
        result = aws("ssm", "send-command", "--instance-ids", INSTANCE, "--document-name", "AWS-RunShellScript",
                     "--timeout-seconds", "600", "--comment", comment, "--parameters",
                     json.dumps({"commands": [script_for(plan)], "executionTimeout": ["600"]}), once=True)
        command_id = result["Command"]["CommandId"]
    except AwsError as error:
        if error.code not in {"response_unavailable", "InternalServerError", "RequestTimeout", "ServiceUnavailable"}:
            raise
        command_id = recover_command(comment, started)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        command_id = recover_command(comment, started)
    print(f"SSM command: {command_id}", flush=True)
    until = time.monotonic() + 640
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
    if attempt:
        require_ancestor(attempt, sha)
        command_id, diagnostic = remote({"operation": "inspect", "sha": sha, "attemptSha": attempt})
        print(json.dumps({"command": command_id, "diagnostic": diagnostic}), flush=True)
        return
    preflight_id, before = remote({"operation": "preflight", "sha": sha})
    base = before["components"]["app"]["revision"]
    print(f"Live website: {base}; free bytes: {before['freeBytes']}", flush=True)
    if base == sha:
        raise RuntimeError("requested_revision_already_running_read_back_the_existing_release")
    require_website_scope(base, sha)
    names = (f"independent-source-{sha}.tar.gz", f"independent-assets-{sha}.json")
    if hashlib.sha256((OUTPUT / names[1]).read_bytes()).hexdigest() != before["assetsSha256"]:
        raise RuntimeError("website_release_would_change_recharge_assets")
    require_main(sha)
    artifacts = {name: put_artifact(OUTPUT / name, sha) for name in names}
    files = ("frontend/index.html", "frontend/commerce-prototype.js", "frontend/subscription-management.js",
             "frontend/prototype.css", "server/preview.mjs", "server/backup/cloud-drive.mjs",
             "server/backup/sheets-source.mjs")
    files += tuple(path for path in ("frontend/order-opening.mjs", "server/recharge-order-sync.mjs")
                   if (ROOT / path).is_file())
    plan = {"operation": "release", "sha": sha, "before": before, "artifacts": artifacts,
            "files": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
            "qualityRun": quality_run, "preflightCommand": preflight_id}
    require_main(sha)
    command_id, receipt = remote(plan)
    if receipt.get("mainSha") != sha or not receipt.get("appCanaryPassed"):
        raise RuntimeError(f"website_release_receipt_mismatch: {command_id}")
    receipt["releaseCommand"] = command_id
    print(json.dumps(receipt, sort_keys=True), flush=True)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Website release `{sha}`\n\nQuality run `{quality_run}` · SSM `{command_id}`\n")


if __name__ == "__main__":
    main()
