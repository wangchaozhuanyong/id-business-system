"""Stage, verify and switch the website and its explicitly selected adapter on the SSM host."""

import base64
import fcntl
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
import runpy
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/opt/id-business-independent")
FORMAL = ROOT / "formal"
UNIT = "id-business-independent-app.service"
DROP = Path("/etc/systemd/system") / f"{UNIT}.d/90-current-release.conf"
GATEWAY = FORMAL / "gateway/Caddyfile"
LOCK = FORMAL / ".application-release.lock"
REPOSITORY = "https://github.com/wangchaozhuanyong/id-business-system.git"
BUCKET = "id-business-v2-backups-098208446664-ap-northeast-1"
SITE_HOST = "54-249-61-238.sslip.io"
WEBSITE = ("app", "drive-backup", "sheets-sync")
PROTECTED = ("recharge", "recharge-native", "vendure", "formal-mysql", "media", "caddy")
ADAPTER_UNIT = "id-business-independent-recharge.service"
ADAPTER_DROP = DROP.parent.parent / (ADAPTER_UNIT + ".d") / "99-id-managed-adapter-release.conf"
PINNED_UPSTREAM = "4e9bb201cf481d4bcc85da34970fc26c63ab818a"
REDEEM_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/gateway.mjs",
    "modules/recharge/codexdaichong/progress-presentation.mjs", "modules/recharge/codexdaichong/shell.js",
    "modules/recharge/codexdaichong/shell.css",
)
REDEEM_PRESENTATION_ASSETS = {"/workspace", "/shell.js", "/shell.css"}
WORKSPACE_PROGRESS_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/shell.js",
    "modules/recharge/codexdaichong/shell.css",
)
TABLE_ACTIONS_STYLESHEET = "modules/recharge/codexdaichong/shell.css"
CARD_IMPORT_ASSET_SOURCE = "modules/recharge/codexdaichong/assets.mjs"
CARD_IMPORT_PRESENTATION_FILES = (CARD_IMPORT_ASSET_SOURCE, "frontend/pagination.js", "frontend/tabs.css")
CARD_IMPORT_PREVIEW_SOURCE = "modules/recharge/codexdaichong/card-import-preview.mjs"
RECHARGE_REDEMPTION_CARD_IMPORT_FILES = (CARD_IMPORT_ASSET_SOURCE, CARD_IMPORT_PREVIEW_SOURCE)
CARD_PLAN_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/shell.css",
)
CARD_NUMBER_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/gateway.mjs",
    "modules/recharge/codexdaichong/local-gateway.mjs",
    "modules/recharge/codexdaichong/shell.css",
)
CARD_FIRST_PAINT_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/shell.js",
)
CARD_LIST_TOOLBAR_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/shell.css",
)
ORBITCARD_LAYOUT_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/shell.css",
)
CHECKOUT_DIAGNOSTIC_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/routing-admin-ui.mjs",
    "modules/recharge/codexdaichong/routing-admin.js",
    "modules/recharge/codexdaichong/shell.css",
)
SECURITY_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/gateway.mjs",
)
TASK_HISTORY_PRESENTATION_FILES = ("modules/recharge/codexdaichong/assets.mjs",)
SUBSCRIPTION_INVOICE_PRESENTATION_FILES = ("modules/recharge/codexdaichong/assets.mjs",)
SUBSCRIPTION_INVOICE_ASSET = "/subscription"
ACTION_PASSWORD_PRESENTATION_FILES = ("modules/recharge/codexdaichong/assets.mjs",)
PRESENTATION_SCOPES = {
    "redeemPresentation": (REDEEM_PRESENTATION_FILES, REDEEM_PRESENTATION_ASSETS),
    "workspaceProgressPresentation": (WORKSPACE_PROGRESS_PRESENTATION_FILES, REDEEM_PRESENTATION_ASSETS),
    "rechargeAdminWorkspacePresentation": (WORKSPACE_PROGRESS_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.js", "/shell.css"}),
    "tableActionsPresentation": ((TABLE_ACTIONS_STYLESHEET,), {"/shell.css"}),
    "cardImportPresentation": (CARD_IMPORT_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.css"}),
    "cardPlanPresentation": (CARD_PLAN_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.css"}),
    "cardNumberPresentation": (CARD_NUMBER_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.css"}),
    "cardFirstPaintPresentation": (CARD_FIRST_PAINT_PRESENTATION_FILES, {"/admin.js", "/shell.js"}),
    "cardListToolbarPresentation": (CARD_LIST_TOOLBAR_PRESENTATION_FILES, {"/admin", "/shell.css"}),
    "rechargeRedemptionCardImportPresentation": (RECHARGE_REDEMPTION_CARD_IMPORT_FILES,
                                                {"/redeem", "/workspace", "/admin", "/admin.js"}),
    "checkoutDiagnosticPresentation": (CHECKOUT_DIAGNOSTIC_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.css"}),
    "securityPresentation": (SECURITY_PRESENTATION_FILES, {"/admin.js"}),
    "taskHistoryPresentation": (TASK_HISTORY_PRESENTATION_FILES, {"/admin", "/admin.js"}),
    "subscriptionInvoicePresentation": (SUBSCRIPTION_INVOICE_PRESENTATION_FILES, {SUBSCRIPTION_INVOICE_ASSET}),
    "actionPasswordPresentation": (ACTION_PASSWORD_PRESENTATION_FILES, {"/admin.js"}),
    "orbitcardLayoutPresentation": (ORBITCARD_LAYOUT_PRESENTATION_FILES, {"/admin", "/shell.css"}),
}
PRESENTATION_MOUNT_ERRORS = {
    "orbitcardLayoutPresentation": "recharge_presentation_mount_mismatch",
    "cardNumberPresentation": "card_number_presentation_mount_mismatch",
    "cardFirstPaintPresentation": "recharge_presentation_mount_mismatch",
    "cardListToolbarPresentation": "recharge_presentation_mount_mismatch",
    "rechargeRedemptionCardImportPresentation": "recharge_presentation_mount_mismatch",
}
ADAPTER_MOUNTS = ("modules", "deploy/recharge-core")
LAUNCHERS = ("run-app", "app-entry.mjs", "check-app.mjs")
CANARY_LOG = "app-canary.log"
CANARY_RETRY_LOG = "app-canary.retry.log"
CANARY_MAILBOX_UNAVAILABLE = r"(?m)^RelayError: Vendure 邮箱服务暂时不可用，请重试\r?$"
CANARY_MAILBOX_RETRY_DELAY = 30
MONITORING = FORMAL / "backup-monitoring"
MONITORING_RECEIPTS = MONITORING / "receipts"
MONITORING_UNIT = "id-business-independent-backup-monitoring"
MONITORING_ENV = "ID_MONITOR_BACKUP_RECEIPTS_DIR=/run/id-backup-monitoring"
BACKUP_OPERATION = "deploy/recharge-core/scheduled-backup.py"
MONITORING_MOUNT = '  --mount "type=bind,src=$formal/backup-monitoring/receipts,dst=/run/id-backup-monitoring,readonly"'
ADMISSION_ENV = "ID_VENDURE_ADMISSION_DIRECTORY=/state/vendure-admission"
PARTNER_API_ENV = "ID_RECHARGE_PARTNER_API=1"
MONITORING_FILES = ("backup_monitoring.py", MONITORING_UNIT + ".service", MONITORING_UNIT + ".timer")
VERSIONED_ASSET = re.compile(r'\b(?:src|href)="(?:\./|/)?([a-zA-Z0-9.-]+\.(?:m?js|css))\?v=([a-zA-Z0-9.-]+)"')
ASSET_METADATA_REPAIR_BASE = "b4c42f63bc0b06570feea30e821fa3750d33ad83"
ASSET_METADATA_REPAIR_DIGEST = "a67d83372c40fe5ca94d41ca075a889aa5b5bbeecb5202ae562e1a554728b1df"
ASSET_METADATA_RELEASE_RUN = 43927104206
INTERRUPTED_BACKUP_INSTALL_BASE = "75dc2e3c858d0689cd5429d9b254631a2f791a63"


class ReleaseError(RuntimeError):
    pass


class ContainerMetadataError(ReleaseError):
    def __init__(self, component, reason):
        super().__init__("container_metadata_read_failed")
        self.component = component if component in (*WEBSITE, *PROTECTED) else "unknown"
        self.reason = reason if isinstance(reason, str) and reason in {"not_found", "command_failed", "command_unavailable",
                                          "timeout", "invalid_metadata"} else "command_failed"

    def public_code(self):
        return f"container_metadata_read_failed:{self.component}:{self.reason}"


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def run(args, timeout=25):
    try:
        return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.CalledProcessError as error:
        if args[:2] == ["docker", "inspect"]:
            component = (args[2].removeprefix("id-business-independent-")
                         if len(args) == 3 and isinstance(args[2], str) and
                            args[2].startswith("id-business-independent-") else "unknown")
            details = error.stderr or b""
            if isinstance(details, str):
                details = details.encode()
            reason = "not_found" if any(value in details.lower() for value in
                                        (b"no such object", b"no such container")) else "command_failed"
            raise ContainerMetadataError(component, reason) from None
        if args[:4] == ["docker", "exec", "id-business-independent-app", "cat"]:
            raise ReleaseError("mounted_public_asset_read_failed") from None
        if args[:3] == ["git", "-c", "credential.helper="]:
            raise ReleaseError("release_repository_read_failed") from None
        raise


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name, timeout=None):
    command = ["docker", "inspect", "id-business-independent-" + name]
    try:
        raw = run(command) if timeout is None else run(command, timeout=timeout)
        containers = json.loads(raw)
        if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
            raise ValueError("invalid metadata")
        return containers[0]
    except ContainerMetadataError:
        raise
    except subprocess.TimeoutExpired:
        raise ContainerMetadataError(name, "timeout") from None
    except OSError:
        raise ContainerMetadataError(name, "command_unavailable") from None
    except (ValueError, TypeError, IndexError):
        raise ContainerMetadataError(name, "invalid_metadata") from None


def component_metadata_status():
    """Fixed component names and states only; Docker environments never leave memory."""
    result = {}
    for name in (*WEBSITE, *PROTECTED):
        try:
            container = inspect(name, timeout=5)
            running = container["State"]["Running"]
            if type(running) is not bool:
                raise ValueError("invalid state")
            revision = (container["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")
            result[name] = {"available": True, "running": running,
                            "revision": revision if isinstance(revision, str) and
                                re.fullmatch(r"[a-f0-9]{40}", revision) else None}
        except ContainerMetadataError as error:
            result[name] = {"available": False, "reason": error.reason}
        except ReleaseError:
            result[name] = {"available": False, "reason": "command_failed"}
        except (ValueError, TypeError, KeyError, AttributeError):
            result[name] = {"available": False, "reason": "invalid_metadata"}
    return result


def identity(container):
    return {"id": container["Id"], "image": container["Image"],
            "running": container["State"]["Running"], "startedAt": container["State"]["StartedAt"],
            "revision": (container["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")}


def asset_bundle_summary(path):
    raw = path.read_bytes()
    summary = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "entries": None}
    try:
        bundle = json.loads(raw)
    except ValueError:
        return summary
    routes = ("/redeem", "/workspace", "/admin", "/subscription", "/admin.js", "/admin.css",
              "/style.css", "/favicon.svg", "/lucide.js", "/shell.js", "/shell.css")
    assets = bundle.get("assets") if isinstance(bundle, dict) else None
    if isinstance(assets, dict):
        summary["entries"] = {name: hashlib.sha256(json.dumps(assets[name], sort_keys=True, ensure_ascii=False,
                             separators=(",", ":")).encode()).hexdigest() for name in routes if name in assets}
    return summary


def mounted_asset_bytes():
    container = inspect("app")
    revision = (container["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        return None
    source = re.escape(str(ROOT / "releases")) + r"/[a-f0-9]{40}/assets\.json"
    mounts = [mount for mount in container["Mounts"] if re.fullmatch(source, mount["Source"]) and not mount["RW"]]
    if len(mounts) != 1:
        return None
    destination = mounts[0]["Destination"]
    if (not isinstance(destination, str) or not destination.startswith("/") or
            not destination.endswith(".json") or ".." in Path(destination).parts):
        return None
    pid = container["State"].get("Pid")
    require(container["State"]["Running"] and type(pid) is int and pid > 0,
            "mounted_public_asset_runtime_unavailable")
    try:
        content = (Path("/proc") / str(pid) / "root" / destination.lstrip("/")).read_bytes()
    except OSError:
        raise ReleaseError("mounted_public_asset_namespace_read_failed") from None
    after = inspect("app")
    require(identity(after) == identity(container) and after["State"].get("Pid") == pid,
            "mounted_public_asset_container_changed")
    return content


def mounted_assets_digest():
    content = mounted_asset_bytes()
    if content is None:
        return {"available": False}
    return {"available": True, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}


def native_publication_state():
    native = identity(inspect("recharge-native"))
    labels = json.loads(run(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", native["image"]])) or {}
    return {"identity": native, "imageLabelsVerified": native["running"] and
            labels.get("org.opencontainers.image.revision") == native["revision"] and
            labels.get("org.id-business.upstream.revision") == PINNED_UPSTREAM}


def app_exec_status():
    report = {"pidsLimit": inspect("app").get("HostConfig", {}).get("PidsLimit")}
    for name, options in (("default", []), ("root", ["--workdir", "/"])):
        try:
            result = subprocess.run(["docker", "exec", *options, "id-business-independent-app", "/bin/true"],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=5)
            detail = result.stderr.decode(errors="replace").lower()
            report[name] = {"exitCode": result.returncode, "indicators": [code for code, pattern in (
                ("working_directory", r"working directory|chdir"),
                ("program_missing", r"executable file not found|no such file"),
                ("resource_limit", "resource temporarily unavailable"), ("permission", "permission denied"),
                ("runtime_exec", "unable to start container process")) if re.search(pattern, detail)]}
        except (OSError, subprocess.TimeoutExpired):
            report[name] = {"unavailable": True}
    try:
        value = run(["docker", "stats", "--no-stream", "--format", "{{.PIDs}}", "id-business-independent-app"], timeout=5)
        report["pidsCurrent"] = int(value.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        report["pidsCurrent"] = None
    return report


def read_process_memory(pid):
    report = {"rssPeakBytes": None, "cgroupPeakBytes": None}
    if type(pid) is not int or pid <= 0:
        return report
    process = Path("/proc") / str(pid)
    try:
        match = re.search(r"(?m)^VmHWM:\s+([0-9]+)\s+kB$", (process / "status").read_text())
        if match:
            report["rssPeakBytes"] = int(match[1]) * 1024
        groups = (process / "cgroup").read_text().splitlines()
    except OSError:
        return report
    for group in groups:
        parts = group.split(":", 2)
        if len(parts) != 3 or not parts[2].startswith("/") or parts[2] == "/" or ".." in Path(parts[2]).parts:
            continue
        if parts[:2] == ["0", ""]:
            peak = Path("/sys/fs/cgroup") / parts[2].lstrip("/") / "memory.peak"
        elif "memory" in parts[1].split(","):
            peak = Path("/sys/fs/cgroup/memory") / parts[2].lstrip("/") / "memory.max_usage_in_bytes"
        else:
            continue
        try:
            value = peak.read_text().strip()
            if value.isdecimal() and int(value) < 2**63:
                report["cgroupPeakBytes"] = int(value)
        except OSError:
            pass
    return report


def observe_backup_resources(seconds=60):
    require(type(seconds) is int and 1 <= seconds <= 60, "invalid_backup_observation_window")
    report = {"startedAt": time.time_ns() // 1_000_000, "samples": 0, "readFailures": 0,
              "minHostAvailableBytes": None, "lastActiveContainers": None}
    services, containers = {}, {}

    def remember(group, key, role, pid):
        measured = read_process_memory(pid)
        entry = group.setdefault(key, {"id": key, "role": role, **measured})
        for name, value in measured.items():
            if value is not None:
                entry[name] = max(entry.get(name) or 0, value)

    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            available = re.search(r"(?m)^MemAvailable:\s+([0-9]+)\s+kB$", Path("/proc/meminfo").read_text())
            if available:
                value = int(available[1]) * 1024
                minimum = report["minHostAvailableBytes"]
                report["minHostAvailableBytes"] = value if minimum is None else min(minimum, value)
            pid = run(["systemctl", "show", "--property=MainPID", "--value",
                       "id-business-independent-recharge-backup.service"], timeout=3).strip()
            if pid.isdigit() and int(pid) > 0:
                remember(services, pid.decode(), "backup-service", int(pid))
        except (OSError, ValueError, subprocess.SubprocessError, ReleaseError):
            report["readFailures"] += 1
        try:
            rows = run(["docker", "ps", "--filter", "label=org.id-business.backup=portable-recovery",
                        "--format", "{{.ID}} {{.Names}}"], timeout=3).decode().splitlines()
            report["lastActiveContainers"] = 0
            for row in rows:
                match = re.fullmatch(r"([a-f0-9]{12,64}) id-recovery-(snapshot|capsule)-[a-f0-9]{16}", row)
                if not match:
                    continue
                report["lastActiveContainers"] += 1
                pid = run(["docker", "inspect", "--format", "{{.State.Pid}}", match[1]], timeout=3).strip()
                if pid.isdigit() and int(pid) > 0:
                    remember(containers, match[1], match[2], int(pid))
        except (OSError, ValueError, subprocess.SubprocessError, ReleaseError):
            report["readFailures"] += 1
        report["samples"] += 1
        time.sleep(1)
    report.update(finishedAt=time.time_ns() // 1_000_000, backupService=list(services.values()),
                  containers=list(containers.values()), backupObserved=bool(services or containers))
    report["peakObserved"] = any(row[name] is not None for row in (*services.values(), *containers.values())
                                 for name in ("rssPeakBytes", "cgroupPeakBytes"))
    return report


def require_main(sha):
    remote = run(["git", "-c", "credential.helper=", "ls-remote", REPOSITORY, "refs/heads/main"])
    require(remote.decode().split() == [sha, "refs/heads/main"], "remote_main_changed")


def adapter_unit_state(components):
    adapter, native = components["recharge"], components["recharge-native"]
    image, revision = adapter["image"], adapter["revision"]
    require(adapter["running"] and native["running"] and image == native["image"] and
            re.fullmatch(r"sha256:[a-f0-9]{64}", image or "") and
            re.fullmatch(r"[a-f0-9]{40}", revision or "") and
            re.fullmatch(r"[a-f0-9]{40}", native["revision"] or ""), "adapter_runtime_identity_mismatch")
    labels = json.loads(run(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image]))
    require(labels.get("org.id-business.upstream.revision") == PINNED_UPSTREAM and
            labels.get("org.opencontainers.image.revision") == native["revision"], "adapter_runtime_source_mismatch")
    binding = inspect("recharge-native")["NetworkSettings"]["Ports"].get("3000/tcp")
    require(binding == [{"HostIp": "127.0.0.1", "HostPort": "44579"}], "native_binding_mismatch")
    require(run(["systemctl", "is-active", ADAPTER_UNIT]).strip() == b"active", "adapter_unit_not_active")
    command = run(["systemctl", "show", "--property=ExecStart", "--value", ADAPTER_UNIT]).decode()
    require(re.search(r"/run-recharge\.py adapter " + revision + r"(?=[ ;}]|$)", command), "adapter_unit_launch_mismatch")
    override = None
    if ADAPTER_DROP.exists() or ADAPTER_DROP.is_symlink():
        info = ADAPTER_DROP.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                ADAPTER_DROP.read_text() == adapter_override(revision, native["revision"], image),
                "adapter_override_not_managed")
        override = digest(ADAPTER_DROP)
    return {"commandSha256": hashlib.sha256(command.encode()).hexdigest(), "overrideSha256": override}


def website_launcher(content, revision):
    commands = list(re.finditer(r"(?m)^[ \t]*ExecStart=[ \t]*(?P<path>[^ \t\r\n]+)", content))
    release = re.escape(str(ROOT / "releases" / revision))
    expected = release + r"/operations(?:-[a-zA-Z0-9_-]+)?/run-app"
    require(len(commands) == 1 and re.fullmatch(expected, commands[0]["path"]),
            "live_website_launcher_unrecognized")
    return commands[0]


def website_release_dropin(content, base, launcher):
    active = website_launcher(content, base)
    return content[:active.start("path")] + str(launcher) + content[active.end("path"):]


def snapshot(include_adapter=False):
    components = {name: identity(inspect(name)) for name in (*WEBSITE, *PROTECTED)}
    base = components["app"]["revision"]
    require(isinstance(base, str) and re.fullmatch(r"[a-f0-9]{40}", base), "invalid_live_revision")
    require(all(components[name]["running"] and components[name]["revision"] == base for name in WEBSITE),
            "website_and_sidecars_not_on_one_live_revision")
    require("# BEGIN ID CORE RELEASE " not in GATEWAY.read_text(), "core_release_gate_active")
    dropin = DROP.read_text()
    require(dropin.count(base) == 1, "live_service_revision_mismatch")
    live_operations = Path(website_launcher(dropin, base)["path"]).parent
    free = shutil.disk_usage(ROOT).free
    require(free > 12 * 1024**3, "insufficient_free_space")
    live = ROOT / "releases" / base
    state = {"components": components, "unitSha256": digest(DROP), "gatewaySha256": digest(GATEWAY),
             "assetsSha256": digest(live / "assets.json"), "assetsSummary": asset_bundle_summary(live / "assets.json"),
             "mountedAssets": mounted_assets_digest(),
             "nativePublication": native_publication_state(),
             "freeBytes": free,
             "launchers": {name: digest(live_operations / name) for name in LAUNCHERS}}
    if include_adapter:
        state["adapterUnit"] = adapter_unit_state(components)
    require(state["nativePublication"]["identity"] == components["recharge-native"],
            "native_publication_changed_during_read")
    return state


def check_baseline(current, expected, *, asset_mount_error=None):
    require(all(current[key] == expected[key] for key in
                ("components", "unitSha256", "gatewaySha256", "assetsSha256", "launchers")),
            "live_baseline_changed")
    require(current.get("adapterUnit") == expected.get("adapterUnit"), "live_adapter_unit_changed")
    if asset_mount_error:
        require(current.get("mountedAssets") == expected.get("mountedAssets"), asset_mount_error)


def write_new(path, value, mode):
    with path.open("x") as file:
        os.chmod(path, mode)
        file.write(value)
        file.flush()
        os.fsync(file.fileno())


def repair_current_asset_metadata(plan):
    """Recover the current release's public bundle from its verified live mount."""
    before = plan["before"]
    current = snapshot()
    check_baseline(current, before)
    base = current["components"]["app"]["revision"]
    expected = plan["expectedAssetsSha256"]
    require(base == ASSET_METADATA_REPAIR_BASE and expected == ASSET_METADATA_REPAIR_DIGEST,
            "asset_metadata_repair_outside_reviewed_baseline")
    require(current["mountedAssets"].get("available") is True and
            current["mountedAssets"].get("sha256") == expected, "asset_metadata_live_mount_mismatch")
    published = plan.get("publishedAssetReceipt")
    require(published == {"runId": ASSET_METADATA_RELEASE_RUN, "mainSha": base,
                          "appCanaryPassed": True, "liveAssetsSha256": expected},
            "asset_metadata_published_receipt_mismatch")
    asset = ROOT / "releases" / base / "assets.json"
    info = asset.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() == 0 and
            info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o644,
            "asset_metadata_file_identity_invalid")
    if current["assetsSha256"] == expected:
        return {"before": current, "repair": {"repaired": False, "baseWebsiteSha": base}}
    content = mounted_asset_bytes()
    require(content is not None and len(content) == plan["expectedAssetsBytes"] and
            hashlib.sha256(content).hexdigest() == expected, "asset_metadata_recovery_bytes_mismatch")
    require(digest(asset) == current["assetsSha256"], "asset_metadata_changed_during_recovery")
    parent = FORMAL / "backups"
    require(not parent.is_symlink(), "asset_metadata_archive_directory_invalid")
    parent.mkdir(mode=0o700, exist_ok=True)
    archive = parent / ("asset-metadata-" + plan["sha"][:12] + "-" + str(time.time_ns()))
    archive.mkdir(mode=0o700)
    prepared, previous = archive / "assets.prepared.json", archive / "assets.previous.json"
    write_new(prepared, content.decode("utf8"), 0o644)
    os.chown(prepared, info.st_uid, info.st_gid)
    require(digest(prepared) == expected, "asset_metadata_prepared_digest_mismatch")
    os.replace(asset, previous)
    try:
        os.replace(prepared, asset)
    except OSError:
        os.replace(previous, asset)
        raise
    after = snapshot()
    check_baseline(after, current | {"assetsSha256": expected})
    require(after["mountedAssets"].get("sha256") == expected, "asset_metadata_mount_changed")
    receipt = {"repaired": True, "baseWebsiteSha": base, "beforeSha256": current["assetsSha256"],
               "afterSha256": expected, "archive": str(archive.relative_to(ROOT)),
               "publishedAssetReceipt": published,
               "runtimeIdentityUnchanged": True}
    write_new(archive / "receipt.json", json.dumps(receipt, indent=2) + "\n", 0o600)
    return {"before": after, "repair": receipt}


def update_canary_asset_refs(content, previous_index, target_index):
    previous = dict(VERSIONED_ASSET.findall(previous_index))
    target = dict(VERSIONED_ASSET.findall(target_index))
    for name in previous.keys() & target.keys():
        for asset, query in ((name, "?"), (name.replace(".", r"\."), r"\?")):
            new = f"{asset}{query}v={target[name]}"
            # The inherited checker can predate the active index. Bind its
            # known asset assertions to the exact prepared index each time.
            pattern = rf"(?<![\w.-]){re.escape(asset + query)}v=[a-zA-Z0-9.-]+(?![\w.-])"
            content = re.sub(pattern, lambda _: new, content)
    return content


def wire_canary_authenticator(content):
    marker = "  // Enrollment for the synthetic canary administrator.\n"
    if marker in content:
        return content
    credentials = "  const login = await send('/api/local/auth/login', {method:'POST',body:credentials});\n"
    previous = credentials + """  assert.equal(login.status,200);
  const session = login.headers['set-cookie'][0].split(';')[0];
"""
    require(content.count(previous) == 1, "isolated_login_contract_changed")
    updated = credentials + """  assert.equal(login.status,200);
  const enrollmentSession = login.headers['set-cookie'][0].split(';')[0];
""" + marker + """  const beforeSecurity = await send('/api/local/auth/security', {session:enrollmentSession});
  assert.equal(beforeSecurity.status,200);
  assert.equal(JSON.parse(beforeSecurity.body).bound,false);
  const start = await send('/api/local/auth/security/start', {method:'POST',session:enrollmentSession,
    body:{password:credentials.password}});
  assert.equal(start.status,200);
  const {enrollment,setupKey} = JSON.parse(start.body);
  const {calculateTotp} = await import('/app/modules/tools/totp.mjs');
  const {code} = await calculateTotp(setupKey, Date.now());
  const bound = await send('/api/local/auth/security/confirm', {method:'POST',session:enrollmentSession,
    body:{enrollment,code}});
  assert.equal(bound.status,200);
  const session = bound.headers['set-cookie'][0].split(';')[0];
  const verified = await send('/api/local/auth/security', {session});
  assert.equal(verified.status,200);
  assert.equal(JSON.parse(verified.body).recentlyVerified,true);
"""
    return content.replace(previous, updated)


def wire_canary_business_confirmation(content):
    marker = "  // Verify business action confirmation with the isolated account.\n"
    if marker in content:
        return content
    content = wire_canary_authenticator(content)
    previous = "  assert.equal(JSON.parse(verified.body).recentlyVerified,true);\n"
    require(content.count(previous) == 1, "isolated_action_password_contract_changed")
    return content.replace(previous, previous + marker + """  const { confirmSyntheticBusinessAction } = await import('/app/deploy/website/check-business-action.mjs');
  await confirmSyntheticBusinessAction(send, session, credentials, JSON.parse(verified.body));
""")


def mount_backup_monitoring(content):
    original = '  state=(--mount "type=bind,src=$formal/data,dst=/state")'
    mounted = original[:-1] + "\n" + MONITORING_MOUNT + f'\n  -e "{MONITORING_ENV}")'
    if content.count(mounted) == 1 and content.count(MONITORING_ENV) == 1:
        return content
    require(content.count(original) == 1 and "ID_MONITOR_BACKUP_RECEIPTS_DIR" not in content,
            "unexpected_backup_monitoring_launcher")
    return content.replace(original, mounted)


def mount_storefront_admission(content):
    monitored = f'  -e "{MONITORING_ENV}")'
    configured = monitored + f'\n  state+=(-e "{ADMISSION_ENV}")'
    if content.count(configured) == 1 and content.count(ADMISSION_ENV) == 1:
        return content
    require(content.count(monitored) == 1 and "ID_VENDURE_ADMISSION_DIRECTORY" not in content,
            "unexpected_storefront_admission_launcher")
    return content.replace(monitored, configured)


def wire_partner_api(content, enable):
    anchor = f'  state+=(-e "{ADMISSION_ENV}")'
    configured = anchor + f'\n  state+=(-e "{PARTNER_API_ENV}")'
    if PARTNER_API_ENV in content:
        require(content.count(configured) == 1 and content.count(PARTNER_API_ENV) == 1,
                "unexpected_partner_api_launcher")
        return content
    if not enable:
        return content
    require(content.count(anchor) == 1, "partner_api_requires_admission")
    return content.replace(anchor, configured)


def wire_storefront_analytics(content):
    """Read the optional Cloudflare configuration from the existing sealed tools credential."""
    replacements = (
        ("const { analytics, visits, microsoft } = JSON.parse(toolConfig);",
         "const { analytics, visits, microsoft, cloudflare } = JSON.parse(toolConfig);"),
        ("  ['microsoft', JSON.stringify(microsoft)]\n",
         "  ['microsoft', JSON.stringify(microsoft)],\n"
         "  ...(cloudflare === undefined ? [] : [['cloudflare', JSON.stringify(cloudflare)]])\n"),
        ("const [websiteAnalyticsConfig, websiteVisitsSecret, microsoftMailboxConfig] = await Promise.all([",
         "const [websiteAnalyticsConfig, websiteVisitsSecret, microsoftMailboxConfig, websiteCloudflareConfig] = await Promise.all(["),
        ("  readToolConfig('/credentials/microsoft', 'microsoft-mailbox')\n",
         "  readToolConfig('/credentials/microsoft', 'microsoft-mailbox'),\n"
         "  readToolConfig(cloudflare === undefined ? undefined : '/credentials/cloudflare', 'website-cloudflare')\n"),
        ("  websiteAnalyticsConfig,\n", "  websiteAnalyticsConfig,\n  websiteCloudflareConfig,\n"),
    )
    if "websiteCloudflareConfig" in content or "['cloudflare'," in content:
        require(all(content.count(new) == 1 for _, new in replacements),
                "unexpected_storefront_analytics_launcher")
        return content
    require(all(content.count(old) == 1 for old, _ in replacements),
            "unexpected_storefront_analytics_launcher")
    for old, new in replacements:
        content = content.replace(old, new)
    return content


def normalize_tools_credential_stream(content):
    # The app-entry protocol has one line per credential. A valid JSON file may
    # contain formatting or a final newline; preserve its values before framing.
    original = '  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"'
    normalized = (
        "  python3 -c 'import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin), separators=(\",\", \":\")))'"
        ' < "$CREDENTIALS_DIRECTORY/independent-online-tools"'
    )
    if normalized in content:
        require(content.count(normalized) == 1 and original not in content,
                "unexpected_tools_credential_stream")
        return content
    require(content.count(original) == 1, "unexpected_tools_credential_stream")
    return content.replace(original, normalized)


def wire_canary_card_details(content):
    """Update the inherited check for the approved administrator detail contract."""
    legacy = re.compile(
        r"""^([ \t]*)assert\.ok\(!details\.body\.includes\(cardNumber\), """
        r"""(?:'[^'\r\n]*'|"[^"\r\n]*")\);$""",
        re.MULTILINE,
    )
    checks = (
        "const { number: detailCardNumber, ...maskedCard } = summary.card;",
        "assert.ok(detailCardNumber === cardNumber, 'authorized card details returned an unexpected number');",
        "assert.ok(!JSON.stringify({ ...json(details), order: { ...summary, card: maskedCard } }).includes(cardNumber),",
        "  'card details exposed the number outside the authorized field');",
    )
    if any(check in content for check in checks):
        require(all(content.count(check) == 1 for check in checks) and not legacy.search(content),
                "unexpected_card_details_canary")
        return content
    matches = list(legacy.finditer(content))
    require(len(matches) == 1, "unexpected_card_details_canary")
    match = matches[0]
    replacement = "\n".join(match.group(1) + check for check in checks)
    return content[:match.start()] + replacement + content[match.end():]


def wire_event_launcher(content):
    credential = '  cat "$CREDENTIALS_DIRECTORY/independent-vendure-integrations"'
    framed = (
        "  python3 -c 'import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin), separators=(\",\", \":\")))'"
        ' < "$CREDENTIALS_DIRECTORY/independent-vendure-integrations"\n'
        "  printf '\\n'\n"
        '  if [ "$mode" = live ]; then\n'
        '    cat "$CREDENTIALS_DIRECTORY/independent-recharge-events"\n'
        "  else printf disabled; fi"
    )
    state = f'  state+=(-e "{ADMISSION_ENV}")'
    if PARTNER_API_ENV in content:
        state += f'\n  state+=(-e "{PARTNER_API_ENV}")'
    mounted = state + '\n  state+=(\n' + \
        '    --mount "type=bind,src=$root/releases/$sha/runtime/external-events,dst=/external-events-runtime,readonly"\n' + \
        '    --mount "type=bind,src=$root/releases/$sha/runtime/mysql-ca.pem,dst=/run/recharge-mysql-ca.pem,readonly")'
    if 'independent-recharge-events' in content:
        require(content.count(framed) == 1 and content.count(mounted) == 1, 'unexpected_event_launcher')
        return content
    require(content.count(credential) == 1 and content.count(state) == 1, 'unexpected_event_launcher')
    return content.replace(credential, framed).replace(state, mounted)


def wire_event_entry(content):
    old = 'const [toolConfig, vendureConfig] = '
    new = 'const [toolConfig, vendureConfig, eventPassword] = '
    anchor = '  relayConfig,\n'
    configured = anchor + "  rechargeEventsConfig: mode === 'live' ? {\n" + \
        "    host: '127.0.0.1', port: 44576, user: 'id_recharge_events', password: eventPassword,\n" + \
        "    database: 'id_redesign_codexdaichong_prod', serverId: 3511012,\n" + \
        "    caFile: '/run/recharge-mysql-ca.pem', pythonPath: '/external-events-runtime',\n" + \
        "    checkpointPath: '/state/recharge-events.checkpoint.json'\n" + \
        "  } : undefined,\n"
    guard = "if (mode === 'live' && !/^[a-f0-9]{64}$/.test(eventPassword || '')) throw new Error('event_credential_required');\n"
    start = 'const service = await startPreview('
    if 'eventPassword' in content:
        require(content.count(new) == 1 and content.count(configured) == 1 and content.count(guard) == 1,
                'unexpected_event_entry')
        return content
    require(content.count(old) == 1 and content.count(anchor) == 1 and content.count(start) == 1,
            'unexpected_event_entry')
    return content.replace(old, new).replace(anchor, configured).replace(start, guard + start)


def wire_event_credential(content):
    line = 'LoadCredentialEncrypted=independent-recharge-events:' + str(FORMAL / 'private/independent-recharge-events.cred')
    if 'independent-recharge-events' in content:
        require(content.splitlines().count(line) == 1, 'unexpected_event_credential_unit')
        return content
    require(content.count('[Service]') == 1 and (FORMAL / 'private/independent-recharge-events.cred').is_file(),
            'event_prerequisites_missing')
    return content.rstrip() + '\n' + line + '\n'


def stage_event_runtime(plan, release):
    require((FORMAL / 'private/independent-recharge-events.cred').is_file(), 'event_prerequisites_missing')
    require('path /shop-api /storefront-realtime/mail-events' in GATEWAY.read_text(), 'mail_event_gateway_missing')
    runtime = release / 'runtime'
    target = runtime / 'external-events'
    target.mkdir(parents=True, mode=0o755)
    run(['tar', '-xzf', str(release / 'artifacts' / f"independent-event-runtime-{plan['sha']}.tar.gz"), '-C', str(target)])
    manifest = json.loads((target / 'manifest.json').read_text())
    require(manifest['sha'] == plan['sha'] and bool(manifest['files']) and
            all(digest(target / name) == value for name, value in manifest['files'].items()), 'event_runtime_hash_mismatch')
    certificate = run(['docker', 'exec', 'id-business-independent-formal-mysql', 'cat', '/var/lib/mysql/ca.pem']).decode()
    require(certificate.startswith('-----BEGIN CERTIFICATE-----') and 'PRIVATE KEY' not in certificate,
            'mysql_ca_certificate_invalid')
    write_new(runtime / 'mysql-ca.pem', certificate, 0o644)


def presentation_scope(plan):
    scopes = [name for name in PRESENTATION_SCOPES if name in plan]
    require(len(scopes) <= 1, "recharge_presentation_approval_mismatch")
    return scopes[0] if scopes else None


def require_asset_digest(plan, candidate_sha):
    before = plan["before"]["assetsSha256"]
    scope = presentation_scope(plan)
    if plan.get("rechargeCore"):
        require(scope is None and plan.get("adapter") and
                plan["rechargeCore"]["assetsSha256"] == candidate_sha and
                re.fullmatch(r"[a-f0-9]{64}", candidate_sha), "native_recharge_asset_digest_mismatch")
        return
    if scope is None:
        require(candidate_sha == before, "recharge_assets_changed")
        return
    presentation = plan[scope]
    approved_files, _ = PRESENTATION_SCOPES[scope]
    require(isinstance(presentation, dict) and not plan.get("adapter") and
            set(approved_files) <= set(plan["files"]) and
            presentation.get("beforeAssetsSha256") == before and presentation.get("assetsSha256") == candidate_sha and
            candidate_sha != before and re.fullmatch(r"[a-f0-9]{64}", candidate_sha),
            "recharge_presentation_approval_mismatch")
    if scope == "rechargeRedemptionCardImportPresentation":
        require(presentation.get("baseWebsiteSha") == plan["before"]["components"]["app"]["revision"] and
                not any(plan.get(name) for name in ("rechargePartnerApi", "vendureRetryReceipt", "customerProgress")),
                "recharge_presentation_approval_mismatch")
    if scope in PRESENTATION_MOUNT_ERRORS:
        mounted = plan["before"].get("mountedAssets", {})
        require(mounted.get("available") is True and mounted.get("sha256") == before,
                PRESENTATION_MOUNT_ERRORS[scope])
    return scope


def verify_presentation_bundle(previous, candidate, approved_assets):
    old, new = (json.loads(path.read_bytes()) for path in (previous, candidate))
    require(old["revision"] == new["revision"] == PINNED_UPSTREAM and
            old["assets"].keys() == new["assets"].keys(), "recharge_presentation_bundle_scope_mismatch")
    changes = {name for name, asset in old["assets"].items() if new["assets"][name] != asset}
    require(changes == approved_assets, "recharge_presentation_bundle_scope_mismatch")


def stage(plan, release):
    sha = plan["sha"]
    before = plan["before"]
    base = before["components"]["app"]["revision"]
    require(sha != base, "release_revision_already_running")
    live_operations = Path(website_launcher(DROP.read_text(), base)["path"]).parent
    source_name = f"independent-source-{sha}.tar.gz"
    assets_name = f"independent-assets-{sha}.json"
    expected_names = {source_name, assets_name}
    if plan.get('externalEvents'):
        expected_names.add(f"independent-event-runtime-{sha}.tar.gz")
    require(set(plan["artifacts"]) == expected_names, "invalid_artifact_names")
    scope = require_asset_digest(plan, plan["artifacts"][assets_name]["sha256"])
    require(not release.exists(), "release_directory_already_exists_inspect_before_retry")
    release.mkdir(mode=0o755)
    artifacts = release / "artifacts"
    artifacts.mkdir(mode=0o700)
    for name, expected in plan["artifacts"].items():
        target = artifacts / name
        run(["aws", "s3", "cp", f"s3://{BUCKET}/release-artifacts/formal/{sha}/{name}", str(target),
             "--region", "ap-northeast-1", "--only-show-errors"], timeout=75)
        require(target.stat().st_size == expected["bytes"] and digest(target) == expected["sha256"],
                "downloaded_artifact_mismatch")
    source = release / "source"
    source.mkdir(mode=0o755)
    run(["tar", "-xzf", str(artifacts / source_name), "-C", str(source)])
    require(all(digest(source / name) == expected for name, expected in plan["files"].items()),
            "prepared_source_mismatch")
    if plan.get('externalEvents'):
        stage_event_runtime(plan, release)
    live = ROOT / "releases" / base
    if scope:
        verify_presentation_bundle(live / "assets.json", artifacts / assets_name, PRESENTATION_SCOPES[scope][1])
    (source / ".runtime").mkdir(mode=0o755)
    shutil.copyfile(artifacts / assets_name, release / "assets.json")
    os.chmod(release / "assets.json", 0o644)
    ops = release / "operations"
    ops.mkdir(mode=0o755)
    for name in LAUNCHERS:
        previous = live_operations / name
        require(digest(previous) == before["launchers"][name], "live_launcher_changed")
        content = previous.read_text()
        if live_operations.name != "operations":
            content = re.sub(rf"/{re.escape(live_operations.name)}(?![a-zA-Z0-9_.-])", "/operations", content)
        if name == "run-app":
            require(content.count("sha=" + base) == 1, "live_launcher_revision_mismatch")
            content = normalize_tools_credential_stream(mount_storefront_admission(
                mount_backup_monitoring(content.replace("sha=" + base, "sha=" + sha))))
            content = wire_partner_api(content, plan.get("rechargePartnerApi"))
        elif name == "app-entry.mjs":
            content = wire_storefront_analytics(content)
        elif name == "check-app.mjs":
            content = update_canary_asset_refs(content, (live / "source/frontend/index.html").read_text(),
                                               (source / "frontend/index.html").read_text())
            if scope == "securityPresentation":
                content = wire_canary_authenticator(content)
            elif scope == "rechargeAdminWorkspacePresentation":
                content = wire_canary_business_confirmation(content)
            elif scope == "cardNumberPresentation":
                content = wire_canary_card_details(content)
        if plan.get('externalEvents'):
            if name == 'run-app':
                content = wire_event_launcher(content)
            elif name == 'app-entry.mjs':
                content = wire_event_entry(content)
        write_new(ops / name, content, 0o755 if name == "run-app" else 0o644)
    return source, ops


def write_website_version(source, sha):
    path = source / "server/.website-version.json"
    write_new(path, json.dumps({"version": sha, "updatedAt": time.time_ns() // 1_000_000}) + "\n", 0o444)


def read_canary_log(path):
    with path.open("rb") as file:
        size = path.stat().st_size
        file.seek(max(size - 64 * 1024, 0))
        return size, file.read().decode(errors="replace")


def canary(sha, ops):
    deadline = time.monotonic() + 240
    names = ("independent-recharge-bridge", "independent-online-tools", "independent-vendure-integrations")
    credentials = [f"--property=LoadCredentialEncrypted={name}:{FORMAL / 'private' / (name + '.cred')}"
                   for name in names]
    for log_name, unit_suffix in ((CANARY_LOG, ""), (CANARY_RETRY_LOG, "-retry")):
        remaining = int(deadline - time.monotonic())
        require(remaining >= 16, "isolated_app_canary_retry_timeout")
        unit = "id-website-release-canary-" + sha[:12] + unit_suffix
        args = ["systemd-run", "--collect", "--wait", "--pipe", "--unit=" + unit,
                f"--property=RuntimeMaxSec={min(225, remaining - 15)}", *credentials]
        log_path = ops / log_name
        with log_path.open("xb") as log:
            os.chmod(log.name, 0o600)
            result = subprocess.run([*args, str(ops / "run-app"), "canary"], stdout=log,
                                    stderr=subprocess.STDOUT, timeout=remaining)
        if result.returncode == 0:
            return bool(unit_suffix)
        if unit_suffix or not re.search(CANARY_MAILBOX_UNAVAILABLE, read_canary_log(log_path)[1]):
            raise ReleaseError("isolated_app_canary_failed")
        # Leave time for the mailbox API to recover from a runtime restart.
        require(deadline - time.monotonic() >= CANARY_MAILBOX_RETRY_DELAY + 16,
                "isolated_app_canary_retry_timeout")
        time.sleep(CANARY_MAILBOX_RETRY_DELAY)


def canary_diagnostics(text):
    indicators = {
        "assertion": r"ERR_ASSERTION|AssertionError",
        "connection_refused": r"ECONNREFUSED|Connection refused",
        "address_in_use": r"EADDRINUSE|address already in use",
        "module_missing": r"ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND",
        "missing_file": r"ENOENT|No such file or directory",
        "permission_denied": r"EACCES|Permission denied",
        "vendure_mailbox_unavailable": CANARY_MAILBOX_UNAVAILABLE,
        "systemd_start_failed": r"Failed to start transient|Failed to start.*service",
        "timeout": r"TimeoutError|timed out",
    }
    frames = re.findall(r"\b(check-app\.mjs|app-entry\.mjs|preview\.mjs):(\d+):(\d+)", text)
    assets = re.findall(r"\b(?:commerce-prototype\.js|prototype\.css|prototype\.js|"
                        r"subscription-management\.js|order-opening\.mjs)(?:\?v=[a-zA-Z0-9-]+)?", text)
    result = {"indicators": [name for name, pattern in indicators.items() if re.search(pattern, text, re.I)],
              "frames": [list(frame) for frame in dict.fromkeys(frames)][:12],
              "assets": sorted(set(assets))[:20]}
    if re.search(r"(?m)^AssertionError \[ERR_ASSERTION\]:|^\s*code: 'ERR_ASSERTION',?$", text):
        assertion = {"code": "ERR_ASSERTION"}
        operator = re.search(r"(?m)^\s*operator: '([^'\r\n]{1,24})',?$", text)
        if operator and operator[1] in {
            "==", "!=", "===", "!==", "deepEqual", "deepStrictEqual", "strictEqual", "notDeepEqual",
            "notDeepStrictEqual", "notStrictEqual", "match", "doesNotMatch", "throws", "rejects",
            "doesNotThrow", "doesNotReject", "ifError",
        }:
            assertion["operator"] = operator[1]
        result["assertion"] = assertion
    return result


CANARY_CHECKER_TOKENS = re.compile(
    r"(?P<comment>//[^\n]*|/\*[\s\S]*?(?:\*/|\Z))"
    r"""|(?P<literal>'(?:\\[\s\S]|[^'\\])*(?:'|\Z)|"(?:\\[\s\S]|[^"\\])*(?:"|\Z))"""
    r"|(?P<template>\x60(?:\\[\s\S]|[^\x60\\])*(?:\x60|\Z))"
    r"|(?P<regex>/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])+/[a-z]*)"
    r"|(?P<number>(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)n?)"
    r"|(?P<name>[$\w]+)|(?P<space>\s+)|(?P<punct>[.,;:?!&|=<>+*%(){}\[\]-])|(?P<other>[\s\S])"
)
CANARY_CHECKER_NAMES = set(
    "assert equal strictEqual deepEqual deepStrictEqual notEqual notStrictEqual notDeepEqual notDeepStrictEqual "
    "ok match doesNotMatch throws rejects doesNotThrow doesNotReject ifError "
    "const let await return new if else for of typeof null true false undefined "
    "send fetch JSON Object Array parse stringify keys hasOwn isArray includes startsWith endsWith test find map "
    "status headers body method data items cards cardNumber card_number card_cvc last4 payment order orders "
    "customer customers number code".split()
)
CANARY_CHECKER_LITERALS = {
    "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "cardNumber", "card_number", "card_cvc", "last4",
    "/health/ready", "/api/local/auth/login", "/api/local/auth/security", "/api/local/commerce",
    "/api/local/inventory", "/api/local/order-completion", "/api/local/renewals",
    "/api/local/subscriptions", "/api/local/tenant-cards", "/api/local/staff/finance/cards",
    "/api/local/bitbrowser-login-windows", "/api/local/customer-query",
    "/integrations/codexdaichong/admin", "/integrations/codexdaichong/api/admin/cards",
    "/integrations/codexdaichong/api/admin/sessions",
}


def canary_checker_outline(checker, frames):
    line = next((int(number) for name, number, _ in frames
                 if name == "check-app.mjs" and len(number) <= 6), None)
    if line is None or checker.is_symlink():
        return {}
    try:
        with checker.open("rb") as file:
            raw = file.read(65537)
    except OSError:
        return {}
    if len(raw) > 65536:
        return {}

    def safe_token(match):
        kind = match.lastgroup
        token = match[0]
        if kind in {"space", "punct"} or (kind == "name" and token in CANARY_CHECKER_NAMES):
            return token
        if kind == "literal":
            value = token[1:-1]
            if re.fullmatch(r"\*{4}[0-9]{4}", value):
                return "<masked-pan>"
            if re.fullmatch(r"[0-9]{12,19}", value):
                return "<pan-like>"
            value, query, _ = value.partition("?")
            if value in CANARY_CHECKER_LITERALS:
                return '"' + value + ("?<redacted>" if query else "") + '"'
        return {"comment": "<comment>", "literal": "<string>", "template": "<template>",
                "regex": "<regex>", "number": "<number>"}.get(kind, "<token>") + "\n" * token.count("\n")

    source = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    lines = CANARY_CHECKER_TOKENS.sub(safe_token, source).split("\n")
    if not 0 < line <= len(lines):
        return {}
    return {
        "checkerSha256": hashlib.sha256(raw).hexdigest(),
        "checkerOutline": [{"line": index + 1, "syntax": lines[index].strip()[:240]}
                           for index in range(max(0, line - 3), min(len(lines), line + 2)) if lines[index].strip()],
    }


def inspect_canary(sha, sample_backup_resources=False):
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "invalid_canary_revision")
    ops = ROOT / "releases" / sha / "operations"
    retried = (ops / CANARY_RETRY_LOG).is_file()
    size, log = read_canary_log(ops / (CANARY_RETRY_LOG if retried else CANARY_LOG))
    diagnostic = canary_diagnostics(log)
    live = identity(inspect("app"))["revision"]
    result = {"attemptSha": sha, "liveWebsiteSha": live,
            "nativePublication": native_publication_state(),
            "coreReleaseGateActive": "# BEGIN ID CORE RELEASE " in GATEWAY.read_text(),
            "appExec": app_exec_status(),
            "liveAssets": {"host": asset_bundle_summary(ROOT / "releases" / live / "assets.json"),
                           "mounted": mounted_assets_digest()},
            "bytes": size, "retried": retried, "backupResources": backup_resource_summary(),
            **diagnostic, **canary_checker_outline(ops / "check-app.mjs", diagnostic["frames"])}
    if sample_backup_resources:
        result["backupResourcesBefore"] = result["backupResources"]
        result["backupObservation"] = observe_backup_resources()
        result["backupResources"] = backup_resource_summary()
    result["recentRecoveryFailures"] = recent_recovery_failures()
    result["recentBackupOomEvents"] = recent_backup_oom_events()
    result["componentMetadata"] = component_metadata_status()
    return result


def mount_matches(container, source, destination=None):
    return any(mount["Source"] == str(source) and not mount["RW"]
               and (destination is None or mount["Destination"] == destination)
               for mount in container["Mounts"])


def adapter_canary(plan, source, ops):
    image = plan["before"]["components"]["recharge"]["image"]
    with (ops / "adapter-canary.log").open("xb") as log:
        os.chmod(log.name, 0o600)
        outcome = subprocess.run(["python3", str(source / "deploy/recharge-core/canary.py"), plan["sha"], image],
                                 stdout=log, stderr=subprocess.STDOUT, timeout=260)
    if outcome.returncode:
        try:
            reason = json.loads((ops / "adapter-canary.log").read_text().splitlines()[-1]).get("reason", "")
        except (IndexError, ValueError):
            reason = ""
        raise ReleaseError("adapter_canary_failed" + (": " + reason if re.fullmatch("[a-z0-9_]+", reason) else ""))
    receipt = json.loads((ops / "native-canary.receipt.json").read_text())
    checks = {"source_203_native", "source_203_adapter", "synthetic_card_stop_and_retry_preserved_history",
              "no_payment_or_activation_requests", "owned_temporary_containers_removed"}
    require(receipt.get("mainSha") == plan["sha"] and receipt.get("productionWrites") is False and
            checks.issubset(receipt["checks"]), "adapter_canary_receipt_mismatch")


def adapter_override(sha, native, image):
    launcher = ROOT / "releases" / sha / "source/deploy/recharge-core/run-recharge.py"
    return f"[Service]\nExecStart=\nExecStart=/usr/bin/python3 {launcher} adapter {sha} {native} {image}\n"


def require_native_idle():
    request = urllib.request.Request("http://127.0.0.1:44579/api/public/runtime")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        with opener.open(request, timeout=5) as response:
            status = json.loads(response.read(8192))
        active = status.get("runtime", {}).get("active_foreground_jobs")
        require(status.get("success") is True and type(active) is int and active >= 0, "native_runtime_unavailable")
        if active == 0:
            return
        time.sleep(3)
    raise ReleaseError("native_recharge_work_in_progress")


def switch_adapter(plan, source, ops, native_runtime=None):
    before, sha = plan["before"], plan["sha"]
    native = native_runtime or before["components"]["recharge-native"]
    image = native["image"]
    require(identity(inspect("recharge-native")) == native, "live_native_baseline_changed")
    if not native_runtime:
        require(adapter_unit_state(before["components"]) == before["adapterUnit"], "live_adapter_baseline_changed")
        require_native_idle()
    require_main(sha)
    ADAPTER_DROP.parent.mkdir(mode=0o755, exist_ok=True)
    directory = ADAPTER_DROP.parent.lstat()
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and directory.st_mode & 0o022 == 0,
            "adapter_override_directory_mismatch")
    if ADAPTER_DROP.exists():
        write_new(ops / "recharge-adapter.before.conf", ADAPTER_DROP.read_text(), 0o600)
    pending = ADAPTER_DROP.with_name(f".{ADAPTER_DROP.name}.{sha[:12]}")
    write_new(pending, adapter_override(sha, native["revision"], image), 0o644)
    os.replace(pending, ADAPTER_DROP)
    run(["systemctl", "daemon-reload"])
    command = run(["systemctl", "show", "--property=ExecStart", "--value", ADAPTER_UNIT]).decode()
    require(str(source / "deploy/recharge-core/run-recharge.py") + f" adapter {sha} {native['revision']} {image}" in command,
            "adapter_effective_command_mismatch")
    run(["systemctl", "restart", ADAPTER_UNIT], timeout=55)
    deadline = time.monotonic() + 55
    while time.monotonic() < deadline:
        try:
            container = inspect("recharge")
            state = identity(container)
            if (state["running"] and state["revision"] == sha and state["image"] == image and
                    all(mount_matches(container, source / name, "/candidate/" + name) for name in ADAPTER_MOUNTS)):
                flag = "--check-card-plans" if native_runtime else "--check-card-stop"
                ready = json.loads(run(["docker", "exec", state["id"], "node",
                                        "/candidate/deploy/recharge-core/health.mjs", flag], timeout=14))
                expected = ({"ready": True, "cardPlansReady": True, "retiredProviderRoute": 404}
                            if native_runtime else {"ready": True, "cardStopRouteReady": True})
                if ready == expected:
                    break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
            pass
        time.sleep(1)
    else:
        raise ReleaseError("adapter_readback_failed")
    for name in plan["adapter"]["runtimeFiles"]:
        reported = run(["docker", "exec", state["id"], "sha256sum", "/candidate/" + name]).decode().split()[0]
        require(reported == plan["files"][name], "adapter_source_mismatch")
    require(identity(inspect("recharge-native")) == native, "native_engine_changed")
    return state


def install_backup_monitoring(source, sha):
    user = inspect("app")["Config"]["User"]
    data = (FORMAL / "data").lstat()
    require(data.st_uid > 0 and user == f"{data.st_uid}:{data.st_gid}", "backup_monitor_site_identity_mismatch")
    scripts = FORMAL / "ops/backup-monitoring"
    for directory, group, mode in ((MONITORING, 0, 0o755), (MONITORING_RECEIPTS, data.st_gid, 0o750),
                                   (scripts, 0, 0o755)):
        if not directory.exists():
            directory.mkdir(mode=mode)
            os.chown(directory, 0, group)
            directory.chmod(mode)
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and directory.resolve() == directory and info.st_uid == 0 and
                info.st_gid == group and stat.S_IMODE(info.st_mode) == mode, "backup_monitor_directory_mismatch")
    for name in MONITORING_FILES:
        target = (scripts if name.endswith(".py") else DROP.parent.parent) / name
        content = (source / "deploy/website" / name).read_text()
        if target.exists() or target.is_symlink():
            info = target.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o644,
                    "backup_monitor_managed_file_mismatch")
            if target.read_text() == content:
                continue
        pending = target.with_name(f".{name}.{sha[:12]}")
        write_new(pending, content, 0o644)
        os.replace(pending, target)
    timer, service = MONITORING_UNIT + ".timer", MONITORING_UNIT + ".service"
    run(["systemd-analyze", "verify", str(DROP.parent.parent / service), str(DROP.parent.parent / timer)])
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", timer])
    run(["systemctl", "start", service])
    require(run(["systemctl", "is-active", timer]).strip() == b"active" and
            (MONITORING_RECEIPTS / "backup-status.json").is_file(), "backup_monitor_timer_unavailable")


def read_backup_monitoring(container):
    require(mount_matches(container, MONITORING_RECEIPTS, "/run/id-backup-monitoring") and
            MONITORING_ENV in container["Config"]["Env"], "backup_monitor_mount_mismatch")
    check = """
import { createMonitoringSources } from '/app/server/monitoring-sources.mjs';
import { readBackupMonitorReceipt } from '/app/server/monitoring-worker-receipts.mjs';
const directory = process.env.ID_MONITOR_BACKUP_RECEIPTS_DIR;
if (!await readBackupMonitorReceipt(directory)) throw Error('invalid backup monitor receipt');
const states = {};
const monitor = { probeAt: () => 0, observe(samples) {
  for (const { code, status } of samples)
    if (code === 'backup' || code === 'recharge_backup') states[code] = status;
} };
const source = createMonitoringSources({ monitor, databasePath: '/state/local-business.sqlite',
  backupReceiptDirectory: directory });
await source.tick();
source.close();
console.log(JSON.stringify(states));
"""
    status = json.loads(run(["docker", "exec", "--workdir", "/", "id-business-independent-app", "node", "--input-type=module", "-e", check]))
    require(set(status) == {"backup", "recharge_backup"} and all(value != "disabled" for value in status.values()),
            "backup_monitor_check_missing")
    return status


RECOVERY_FAILURE_STAGES = {"application", "collector", "source", "sqlite", "credentials",
                           "services", "size_limit", "encryption", "verification", "unknown"}
RECOVERY_FAILURE_REASONS = {
    "recovery_sqlite_snapshot_failed", "recovery_sqlite_replaced", "recovery_snapshot_runtime_required",
    "recovery_credential_name_invalid", "recovery_credential_unavailable", "recovery_credential_binding_requires_review",
    "recovery_service_inventory_unavailable", "recovery_service_definition_unavailable",
    "recovery_active_operations_missing", "recovery_native_launcher_unavailable", "recovery_native_source_mismatch",
    "recovery_native_runtime_changed", "recovery_source_changed", "recovery_regular_file_required",
    "recovery_directory_invalid", "recovery_required_directory_missing", "recovery_symlink_forbidden",
    "recovery_state_too_large", "recovery_recipient_changed", "recovery_capsule_encryption_failed",
    "recovery_capsule_digest_mismatch", "application_unavailable", "collector_load_failed", "source_missing",
    "permission_denied", "operation_timeout", "invalid_output", "validation_failed", "unexpected", "unknown",
}
BACKUP_HISTORY_KEY = re.compile(r"mysql/daily/independent-recharge/([0-9]{8}T[0-9]{6}Z)/"
                                r"([a-f0-9]{40})/(manifest.json|mysql.sql.aes256gcm|recovery-state.idbackup)")


def recent_backup_oom_events():
    """Docker retains only its last 256 events; an empty result cannot exclude past OOM."""
    try:
        now = int(time.time())
        raw = run(["docker", "events", "--since", str(now - 2 * 86400), "--until", str(now),
                   "--filter", "type=container", "--filter", "event=oom", "--filter",
                   "label=org.id-business.backup=portable-recovery", "--format", "{{json .}}"], timeout=5)
        events = []
        for line in raw.splitlines()[:256]:
            event = json.loads(line)
            attributes = event.get("Actor", {}).get("Attributes", {})
            name = attributes.get("name", "")
            matched = re.fullmatch(r"id-recovery-(snapshot|capsule)-[a-f0-9]{16}", name)
            at = event.get("time")
            if (event.get("Action") == "oom" and attributes.get("org.id-business.backup") == "portable-recovery"
                    and matched and type(at) is int and now - 2 * 86400 <= at <= now):
                events.append({"at": at, "helper": matched[1]})
        return {"available": True, "historyMayBeIncomplete": True, "events": events}
    except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
        return {"available": False, "historyMayBeIncomplete": True}


def read_backup_failure_manifest(key, listed):
    """Read a bounded manifest in anonymous memory; return only validated safe metadata."""
    match = BACKUP_HISTORY_KEY.fullmatch(key)
    require(match and match[3] == "manifest.json", "backup_history_manifest_key")
    require(type(listed.get("Size")) is int and 0 < listed["Size"] <= 16384,
            "backup_history_manifest_size")
    etag = listed.get("ETag")
    require(isinstance(etag, str) and re.fullmatch(r'"[a-f0-9]{32}"', etag), "backup_history_etag")
    fd = os.memfd_create("id-backup-history", flags=0)
    try:
        os.fchmod(fd, 0o600)
        outcome = subprocess.run(["aws", "s3api", "get-object", "--bucket", BUCKET, "--key", key,
            "--expected-bucket-owner", "098208446664", "--region", "ap-northeast-1",
            "--checksum-mode", "ENABLED", "--if-match", etag,
            f"/proc/self/fd/{fd}"], pass_fds=(fd,), capture_output=True, check=True, timeout=15)
        metadata = json.loads(outcome.stdout)
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 16385)
    finally:
        os.close(fd)
    digest = hashlib.sha256(raw).digest()
    version = metadata.get("VersionId")
    require(len(raw) == listed["Size"] == metadata.get("ContentLength") and
            metadata.get("ChecksumSHA256") == base64.b64encode(digest).decode() and
            isinstance(version, str) and re.fullmatch(r"[a-zA-Z0-9_./+=\-]{1,1024}", version) and version != "null",
            "backup_history_manifest_unverified")
    manifest = json.loads(raw)
    require(isinstance(manifest, dict) and match and match[3] == "manifest.json" and
            manifest.get("capturedAt") == match[1] and manifest.get("revision") == match[2],
            "backup_history_manifest_identity")
    if manifest.get("recoveryStateError") != "capture_failed":
        return None
    stage = manifest.get("recoveryStateFailureStage")
    reason = manifest.get("recoveryStateFailureReason")
    return {"capturedAt": match[1], "nativeRevision": match[2],
            "failureStage": stage if isinstance(stage, str) and stage in RECOVERY_FAILURE_STAGES else "unknown",
            "failureReason": reason if isinstance(reason, str) and reason in RECOVERY_FAILURE_REASONS else "unknown",
            "manifestVersionId": version, "manifestSha256": digest.hex()}


def recent_recovery_failures():
    """Inspect at most three incomplete finalized batches from two UTC calendar days."""
    unavailable = {"available": False, "reason": "backup_history_unavailable"}
    if not hasattr(os, "memfd_create"):
        return unavailable
    try:
        groups = {}
        today = datetime.now(timezone.utc)
        for day in (today, today - timedelta(days=1)):
            prefix = "mysql/daily/independent-recharge/" + day.strftime("%Y%m%d")
            listing = json.loads(run(["aws", "s3api", "list-objects-v2", "--bucket", BUCKET,
                "--prefix", prefix, "--expected-bucket-owner", "098208446664", "--region", "ap-northeast-1",
                "--max-keys", "1000", "--no-paginate"], timeout=15))
            require(isinstance(listing, dict) and not listing.get("IsTruncated"), "backup_history_listing")
            for item in listing.get("Contents", []):
                key = item.get("Key")
                match = BACKUP_HISTORY_KEY.fullmatch(key) if isinstance(key, str) else None
                if match and key.startswith(prefix):
                    groups.setdefault((match[1], match[2]), {})[match[3]] = item
        candidates = sorted((identity for identity, files in groups.items()
            if "manifest.json" in files and "mysql.sql.aes256gcm" in files and
            "recovery-state.idbackup" not in files), reverse=True)
        failures = []
        for captured, revision in candidates[:3]:
            listed = groups[(captured, revision)]["manifest.json"]
            failure = read_backup_failure_manifest(listed["Key"], listed)
            if failure:
                failures.append(failure)
        return {"available": True, "listedIncompleteBatches": len(candidates), "failures": failures}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError, ReleaseError):
        return unavailable


def backup_resource_summary():
    """Read resource metadata without collecting backup or credential contents."""
    report = {"at": time.time_ns() // 1_000_000}
    try:
        receipt = json.loads((ROOT / "backups/scheduled-recharge/last-upload.json").read_bytes())
        if not isinstance(receipt, dict):
            raise ValueError("invalid receipt")
        report["lastUpload"] = {}
        for name in ("capturedAt", "verifiedAt", "lastCompleteCapturedAt"):
            value = receipt.get(name)
            report["lastUpload"][name] = value if isinstance(value, str) and re.fullmatch(r"[0-9TZ:+.\-]{1,40}", value) else None
        report["lastUpload"]["recoveryStateStatus"] = (receipt.get("recoveryStateStatus")
            if receipt.get("recoveryStateStatus") in {"verified", "capture_failed", "unavailable"} else None)
        report["lastUpload"]["recoveryStateFailureStage"] = (receipt.get("recoveryStateFailureStage")
            if receipt.get("recoveryStateFailureStage") in RECOVERY_FAILURE_STAGES else None)
        reason = receipt.get("recoveryStateFailureReason")
        report["lastUpload"]["recoveryStateFailureReason"] = (reason
            if isinstance(reason, str) and reason in RECOVERY_FAILURE_REASONS else None)
    except (OSError, ValueError, TypeError):
        report["lastUpload"] = None
    try:
        memory = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, _, value = line.partition(":")
            if name in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
                memory[name] = int(value.split()[0]) * 1024
        report["hostMemoryBytes"] = memory
    except (OSError, ValueError):
        report["hostMemoryBytes"] = None
    try:
        fields = run(["systemctl", "show", "id-business-independent-recharge-backup.service",
                      "--property=MemoryPeak,CPUUsageNSec,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic"],
                     timeout=5).decode()
        values = dict(line.split("=", 1) for line in fields.splitlines() if "=" in line)
        report["backupService"] = {name: int(value) if value.isdecimal() and int(value) < 2**64 - 1 else None
                                   for name, value in values.items()}
    except (OSError, ValueError, subprocess.SubprocessError):
        report["backupService"] = None

    def directory_summary(directory):
        if not directory.exists():
            return {"exists": False}
        if directory.is_symlink() or not directory.is_dir():
            raise OSError("backup_resource_directory_invalid")
        files = [path.stat().st_size for path in directory.rglob("*")
                 if not path.is_symlink() and path.is_file()]
        return {"exists": True, "files": len(files), "bytes": sum(files)}

    try:
        report["releaseOperations"] = {}
        for name in ("app", "recharge-native"):
            revision = (inspect(name)["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")
            if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
                raise ValueError("invalid release identity")
            release = ROOT / "releases" / revision
            report["releaseOperations"][name] = {"revision": revision,
                "operations": directory_summary(release / "operations"),
                "variants": {path.name: directory_summary(path) for path in release.glob("operations-*")
                    if re.fullmatch(r"operations-[a-zA-Z0-9_-]+", path.name) and path.is_dir() and not path.is_symlink()}}
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, ReleaseError):
        report["releaseOperations"] = None
    try:
        spool = ROOT / "backups/scheduled-recharge"
        report["spool"] = {name: directory_summary(spool / name) for name in ("pending", ".uploaded")}
        captures = [path for path in spool.glob(".capture-*") if path.is_dir() and not path.is_symlink()]
        report["spool"]["captureDirectories"] = len(captures)
        captured = [directory_summary(path) for path in captures]
        report["spool"]["captureBytes"] = (sum(item["bytes"] for item in captured)
                                         if all(item["exists"] for item in captured) else None)
    except OSError:
        report["spool"] = None
    try:
        categories = ("operations", "ops", "private", "vendure-state", "data/vendure-admission",
                      "recharge-data/product_files", "recharge-data/data", "recharge-data/data/browser-pool",
                      "google-drive-backup/outbox")
        report["recoverySourceBytes"] = {name: directory_summary(FORMAL / name) for name in categories}
        report["sqliteFileBytes"] = (FORMAL / "data/local-business.sqlite").stat().st_size
    except OSError:
        report["recoverySourceBytes"] = None
    return report


@contextmanager
def prepare_backup_recovery(source, operations, base, sha):
    """Verify the host baseline and reserve its lock before the website cutover."""
    target = FORMAL / "ops/recharge-core/scheduled-backup.py"
    previous = ROOT / "releases" / base / "source" / BACKUP_OPERATION
    candidate = source / BACKUP_OPERATION
    before, after = digest(previous), digest(candidate)
    receipt = {"sourceRevision": sha, "programSha256": after, "previousProgramSha256": before}
    content = candidate.read_text()
    compile(content, str(candidate), "exec")

    def current_program():
        info = target.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o644 and
                target.resolve() == target, "backup_program_baseline_changed")
        return digest(target)

    def confirm_installed():
        require(digest(target) == after, "backup_program_readback_mismatch")
        return receipt

    current = current_program()
    if current not in (before, after) and base == INTERRUPTED_BACKUP_INSTALL_BASE:
        previous_ops = ROOT / "releases" / base / "operations"
        saved = previous_ops / "scheduled-backup.py.before"
        completed = previous_ops / "release.receipt.json"
        require(not completed.exists() and not completed.is_symlink(), "backup_program_baseline_changed")
        info = saved.lstat()
        original = ROOT / "releases" / ASSET_METADATA_REPAIR_BASE / "source" / BACKUP_OPERATION
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == 0o600 and digest(saved) == digest(original) == current,
                "backup_program_baseline_changed")
        before = current
        receipt["previousProgramSha256"] = before
        receipt["resumedBackupBaseline"] = {"websiteSha": base, "programSourceSha": ASSET_METADATA_REPAIR_BASE}
    require(current in (before, after), "backup_program_baseline_changed")
    if current == after:
        yield confirm_installed
        return
    lock_path = ROOT / "backups/scheduled-recharge/.lock"
    lock_fd = os.open(lock_path, os.O_WRONLY | os.O_NOFOLLOW)
    with os.fdopen(lock_fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError("backup_upload_in_progress_retry_installation") from None
        require(current_program() == before, "backup_program_changed_during_release")
        write_new(operations / "scheduled-backup.py.before", target.read_text(), 0o600)
        pending = target.with_name(f".scheduled-backup.{sha[:12]}.py")
        write_new(pending, content, 0o644)

        def install():
            require(current_program() == before, "backup_program_changed_during_release")
            os.replace(pending, target)
            return confirm_installed()

        try:
            yield install
        finally:
            pending.unlink(missing_ok=True)


def http(path):
    request = urllib.request.Request("http://127.0.0.1:44572" + path, headers={"Host": SITE_HOST})
    return urllib.request.urlopen(request, timeout=5)


def read_event_runtime():
    name = 'independent-mysql-root'
    password = run(['systemd-creds', 'decrypt', '--name=' + name,
                    str(FORMAL / 'private' / (name + '.cred')), '-']).decode().strip()
    require(re.fullmatch('[a-f0-9]{64}', password), 'event_health_credential_invalid')
    query = ("SELECT @@server_uuid, @@binlog_row_metadata, "
             "(SELECT COUNT(*) FROM performance_schema.threads WHERE PROCESSLIST_USER='id_recharge_events' "
             "AND PROCESSLIST_COMMAND LIKE 'Binlog Dump%');\n")
    checkpoint = FORMAL / 'data/recharge-events.checkpoint.json'
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        result = subprocess.run(['docker', 'exec', '-i', 'id-business-independent-formal-mysql', 'bash', '-ec',
            'IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec mysql --host=127.0.0.1 --user=root --batch --skip-column-names'],
            input=(password + '\n' + query).encode(), capture_output=True, timeout=15)
        if result.returncode == 0:
            fields = result.stdout.decode().strip().split('\t')
            if len(fields) == 3 and fields[1:] == ['FULL', '1'] and checkpoint.is_file():
                state = json.loads(checkpoint.read_text())
                if state.get('snapshotDone') is True and state.get('source') == fields[0]:
                    require(checkpoint.stat().st_mode & 0o777 == 0o600, 'event_checkpoint_permissions_invalid')
                    return {'readerConnected': True, 'snapshotAcknowledged': True, 'metadata': 'FULL',
                            'checkpointPrivate': True, 'businessTestWrites': 0}
        time.sleep(3)
    raise ReleaseError('event_runtime_not_ready')


def read_website(plan, release, source, adapter=None, core=None):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        try:
            containers = {name: inspect(name) for name in WEBSITE}
            states = {name: identity(value) for name, value in containers.items()}
            running_expected = all(state["running"] and state["revision"] == plan["sha"] and
                                   state["image"] == plan["before"]["components"][name]["image"]
                                   for name, state in states.items())
            if running_expected and all(mount_matches(containers[name], source, "/app") for name in WEBSITE[1:]):
                with http("/") as response:
                    require(response.status == 200, "website_home_unavailable")
                break
        except (subprocess.CalledProcessError, urllib.error.URLError, TimeoutError):
            pass
        except ReleaseError as error:
            if str(error) != "container_metadata_read_failed":
                raise
        time.sleep(1)
    else:
        raise ReleaseError("website_or_sidecar_readback_failed")
    require(mount_matches(containers["app"], release / "assets.json"), "live_assets_mount_mismatch")
    live_assets = digest(release / "assets.json")
    scope = require_asset_digest(plan, live_assets)
    if scope in PRESENTATION_MOUNT_ERRORS:
        mounted = mounted_assets_digest()
        require(mounted.get("available") is True and mounted.get("sha256") == live_assets,
                PRESENTATION_MOUNT_ERRORS[scope])
    require(all(any(m["Destination"] == "/state" and not m["RW"] for m in containers[name]["Mounts"])
                for name in WEBSITE[1:]), "sidecar_state_mount_not_readonly")
    hash_files = """
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const files = JSON.parse(process.argv[1]);
const hashes = files.map(name => [name, createHash('sha256').update(readFileSync('/app/' + name)).digest('hex')]);
console.log(JSON.stringify(Object.fromEntries(hashes)));
"""
    running_hashes = json.loads(run(["docker", "exec", "--workdir", "/", "id-business-independent-app", "node", "--input-type=module",
                                    "-e", hash_files, json.dumps(list(plan["files"]))]))
    require(running_hashes == plan["files"], "running_source_mismatch")
    module_paths = {
        "frontend/staff-workspaces.mjs": "/assets/website/pages/staff-workspaces.mjs",
        "frontend/finance-reconciliation.mjs": "/assets/website/pages/finance-reconciliation.mjs",
        "frontend/recharge-partners.mjs": "/assets/website/pages/recharge-partners.mjs",
        "frontend/recharge-partner-authorize.html": "/recharge/authorize",
        "modules/website/pages.mjs": "/assets/website/pages.mjs",
        "modules/recharge/bitbrowser/login/index.mjs": "/assets/bitbrowser/login/index.mjs",
        "modules/recharge/bitbrowser/login/direct-login.mjs": "/assets/bitbrowser/login/direct-login.mjs",
        **{name: "/" + name for name in (
            "modules/orders/order-opening.mjs", "modules/orders/list-order.mjs",
            "modules/orders/order-customer-match.mjs", "modules/orders/order-whatsapp.mjs",
            "modules/orders/renewal-reminders.mjs", "modules/finance/apple-funding.mjs",
            "modules/data/document-delta.mjs", "modules/orders/order-list.mjs", "modules/inventory/list.mjs",
            "modules/finance/accounting.mjs", "modules/data/record-edit.mjs",
            "modules/recharge/codexdaichong/card-import-preview.mjs"
        )},
    }
    for name, expected in plan["files"].items():
        route = module_paths.get(name)
        if not route and name.startswith("frontend/") and name != "frontend/index.html":
            route = "/" + Path(name).name
        if route:
            with http(route) as response:
                require(hashlib.sha256(response.read()).hexdigest() == expected, "live_website_asset_mismatch")
    protected_reads = ("/api/local/settings", "/api/local/inventory", "/api/local/commerce", "/api/local/order-sync",
                       "/api/local/system-monitoring", "/api/local/recharge-activity")
    if (source / "server/site-management.mjs").is_file():
        protected_reads += ("/api/local/site-management?view=information", "/api/local/site-management?view=backups",
                            "/api/local/renewals?view=finance", "/api/local/staff/finance/cards",
                            "/api/local/auth/security/network")
        version = json.loads(run(["docker", "exec", "--workdir", "/", "id-business-independent-app", "cat", "/app/server/.website-version.json"]))
        require(version == json.loads((source / "server/.website-version.json").read_text()) and
                version.get("version") == plan["sha"], "website_version_receipt_mismatch")
    if (source / "modules/website/pages.mjs").is_file():
        protected_reads += ("/api/local/staff/finance/reconciliation", "/api/local/renewal-sidebar")
    if adapter:
        protected_reads += ("/api/local/subscription-card-status",)
    if presentation_scope(plan) == "subscriptionInvoicePresentation":
        protected_reads += ("/integrations/codexdaichong" + SUBSCRIPTION_INVOICE_ASSET,)
    if scope == "cardNumberPresentation":
        protected_reads += ("/integrations/codexdaichong/admin", "/integrations/codexdaichong/api/admin/cards",
                            "/integrations/codexdaichong/api/admin/sessions", "/api/local/bitbrowser-login-windows")
    if scope == "cardFirstPaintPresentation":
        protected_reads += ("/api/local/staff/finance/cards/pending",)
    for path in protected_reads:
        try:
            with http(path):
                raise ReleaseError("anonymous_protected_read_allowed")
        except urllib.error.HTTPError as error:
            require(error.code in (401, 403), "protected_read_status_unexpected")
    expected = plan["before"]["components"] | ({"recharge": adapter} if adapter else {})
    gateway_digest = plan["before"]["gatewaySha256"]
    if core:
        expected = expected | {"recharge-native": core.receipt["native"], "caddy": core.gated_gateway}
        gateway_digest = core.gated_digest
    require(all(identity(inspect(name)) == expected[name] for name in PROTECTED),
            "protected_component_changed")
    require(digest(GATEWAY) == gateway_digest, "gateway_changed")
    return states


def check_native_recovery_source(plan, source):
    if plan.get("rechargeCore"):
        return
    revision = plan["before"]["components"]["recharge-native"]["revision"]
    require(isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{40}", revision), "invalid_native_recovery_revision")
    operations = ROOT / "releases" / revision / "operations"
    if operations.is_dir() and not operations.is_symlink():
        return
    require(not operations.exists() and not operations.is_symlink(), "recovery_active_operations_missing")
    collector = runpy.run_path(str(source / "deploy/website/recovery_capsule.py"))
    try:
        definition = run(["systemctl", "cat", collector["NATIVE_UNIT"]])
        collector["native_source_launcher"](ROOT, revision, definition)
    except collector["RecoveryError"] as error:
        raise ReleaseError(str(error)) from None
    except subprocess.CalledProcessError:
        raise ReleaseError("recovery_service_definition_unavailable") from None


def release_website(plan, staged=None):
    sha = plan["sha"]
    before = plan["before"]
    base = before["components"]["app"]["revision"]
    include_adapter = bool(plan.get("adapter"))
    asset_mount_error = PRESENTATION_MOUNT_ERRORS.get(presentation_scope(plan))
    if plan.get("deployedNativeBuildInputs"):
        native = before.get("nativePublication", {})
        require(not any(name in plan for name in ("adapter", "rechargeCore", "vendureRetryReceipt",
                                                  "rechargePartnerApi", "customerProgress")) and
                native.get("imageLabelsVerified") is True and
                native["identity"] == before["components"]["recharge-native"] and
                plan["deployedNativeBuildInputs"] == {"nativeRevision": native["identity"]["revision"],
                                                       "image": native["identity"]["image"]},
                "deployed_native_inputs_not_verified")
    check_baseline(snapshot(include_adapter), before, asset_mount_error=asset_mount_error)
    release = ROOT / "releases" / sha
    source, ops = staged or stage(plan, release)
    check_native_recovery_source(plan, source)
    core = None
    if plan.get("rechargeCore"):
        sys.path.insert(0, str(source / "deploy/website"))
        try:
            from recharge_core import CoreRelease
        finally:
            sys.path.pop(0)
        core = CoreRelease(plan, source, ops)
    canary_retried = canary(sha, ops)
    if include_adapter and not core:
        adapter_canary(plan, source, ops)
    if core:
        core.prepare()
    check_baseline(snapshot(include_adapter), before, asset_mount_error=asset_mount_error)
    old = DROP.read_text()
    launcher = ops / "run-app"
    require(launcher.is_file() and os.access(launcher, os.X_OK), "staged_website_launcher_not_executable")
    new = website_release_dropin(old, base, launcher)
    if plan.get('externalEvents'):
        new = wire_event_credential(new)
    require_main(sha)
    if (source / "server/site-management.mjs").is_file():
        write_website_version(source, sha)
    backup = prepare_backup_recovery(source, ops, base, sha)
    with backup as install_recovery:
        install_backup_monitoring(source, sha)
        with core.cutover() if core else nullcontext() as native:
            adapter = switch_adapter(plan, source, ops, native) if native else (
                switch_adapter(plan, source, ops) if include_adapter else None)
            require_main(sha)
            require(digest(DROP) == before["unitSha256"], "live_service_override_changed")
            write_new(ops / "id-business-independent-app.service.before.conf", old, 0o600)
            pending = DROP.with_name(f".{DROP.name}.{sha[:12]}")
            write_new(pending, new, DROP.stat().st_mode & 0o777)
            os.replace(pending, DROP)
            run(["systemctl", "daemon-reload"])
            run(["systemctl", "restart", UNIT], timeout=55)
            live = read_website(plan, release, source, adapter, core) if core else read_website(plan, release, source, adapter)
            events = read_event_runtime() if plan.get('externalEvents') else None
            monitoring = read_backup_monitoring(inspect("app"))
            recovery = install_recovery()
            if core:
                core.finish()
    result = {"mainSha": sha, "previousWebsiteSha": base, "website": live["app"],
              "sidecars": {name: live[name] for name in WEBSITE[1:]},
              "sourceFilesVerified": len(plan["files"]), "artifacts": plan["artifacts"],
              "qualityRun": plan["qualityRun"], "preflightCommand": plan["preflightCommand"],
              "appCanaryPassed": True, "appCanaryRetried": canary_retried,
              "protectedComponentsUnchanged": not include_adapter,
              "liveAssetsSha256": digest(release / "assets.json"),
              "backupMonitoring": monitoring,
              "backupResources": backup_resource_summary(),
              "portableRecoveryBackup": recovery,
              "unauthenticatedProtectedReadsRejected": True, "productionBusinessTestWrites": False}
    if plan.get("assetMetadataRepair"):
        result["assetMetadataRepair"] = plan["assetMetadataRepair"]
    if plan.get("deployedNativeBuildInputs"):
        result["deployedNativeBuildInputs"] = plan["deployedNativeBuildInputs"]
    if events:
        result['externalEvents'] = events
    scope = presentation_scope(plan)
    if scope:
        result[scope + "Verified"] = True
    if core:
        result.update(adapter=adapter, rechargeCore=core.receipt)
    elif adapter:
        result.update(adapter=adapter, adapterCanaryPassed=True, nativeEngineUnchanged=True,
                      otherProtectedComponentsUnchanged=True)
    write_new(ops / "release.receipt.json", json.dumps(result, indent=2) + "\n", 0o600)
    return result


def release_with_optional_vendure_refresh(plan):
    retry_receipt = plan.get("vendureRetryReceipt")
    partner_api = plan.get("rechargePartnerApi") is True
    customer_progress = plan.get("customerProgress") is True
    require(not (customer_progress and (partner_api or retry_receipt)), "customer_progress_release_scope_mixed")
    require(not (partner_api and retry_receipt), "partner_api_and_retry_review_require_separate_releases")
    if not retry_receipt and not partner_api and not customer_progress:
        return release_website(plan)
    require(not plan.get("adapter") and not plan.get("rechargeCore") and
            (not retry_receipt or isinstance(retry_receipt, str) and re.fullmatch(r"[a-f0-9]{64}", retry_receipt)),
            "invalid_vendure_gateway_refresh")
    # Validate the old runtime and signed receipt before restarting the website.
    sha = plan["sha"]
    release = ROOT / "releases" / sha
    check_baseline(snapshot(False), plan["before"])
    source, operations = stage(plan, release)
    sys.path.insert(0, str(source / "deploy/website"))
    try:
        from vendure_admission import check_refresh_baseline, cutover
        partner_options = {"partner_api": True} if partner_api or customer_progress else {}
        if customer_progress:
            partner_options["customer_progress"] = True
        check_refresh_baseline(sha, retry_receipt, **partner_options)
        result = release_website(plan, staged=(source, operations))
        if partner_api or customer_progress:
            verify_partner_ingress()
        result["vendureGateway"] = cutover(sha, release, refresh=True, retry_receipt=retry_receipt, **partner_options)
        if partner_api or customer_progress:
            receipt_path = release / "operations/release.receipt.json"
            revised_receipt = receipt_path.with_suffix(".complete.json")
            write_new(revised_receipt, json.dumps(result, indent=2) + "\n", 0o600)
            os.replace(revised_receipt, receipt_path)
        return result
    finally:
        sys.path.pop(0)


def verify_partner_ingress():
    endpoint = "https://" + SITE_HOST + "/api/recharge/v1/config"
    try:
        with urllib.request.urlopen(endpoint, timeout=8):
            raise ReleaseError("partner_api_anonymous_request_not_rejected")
    except urllib.error.HTTPError as error:
        require(error.code == 401 and error.geturl() == endpoint and json.loads(error.read(1024)).get("code") == "invalid_api_key",
                "partner_api_ingress_not_verified")


def main(plan):
    try:
        require(re.fullmatch(r"[a-f0-9]{40}", plan["sha"]), "invalid_release_revision")
        with LOCK.open("r") as lock:
            mode = fcntl.LOCK_SH if plan["operation"] == "inspect" else fcntl.LOCK_EX
            fcntl.flock(lock, mode | fcntl.LOCK_NB)
            require_main(plan["sha"])
            if plan["operation"] == "preflight":
                result = snapshot(plan.get("adapter") is True)
            elif plan["operation"] == "inspect":
                result = inspect_canary(plan["attemptSha"], plan.get("sampleBackupResources") is True)
            elif plan["operation"] == "repair-assets":
                result = repair_current_asset_metadata(plan)
            else:
                require(plan["operation"] == "release", "invalid_release_operation")
                result = release_with_optional_vendure_refresh(plan)
            print(json.dumps(result, sort_keys=True), flush=True)
    except ReleaseError as error:
        sys.exit(error.public_code() if isinstance(error, ContainerMetadataError) else str(error))
    except BlockingIOError:
        sys.exit("application_release_lock_busy")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as error:
        sys.exit("website_release_error: " + type(error).__name__.lower())
