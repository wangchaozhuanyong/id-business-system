"""Run the existing website-only staging, canary, and switch on the SSM host."""

import fcntl
import hashlib
import json
import os
import re
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
LAUNCHERS = ("run-app", "app-entry.mjs", "check-app.mjs")
MONITORING = FORMAL / "backup-monitoring"
MONITORING_RECEIPTS = MONITORING / "receipts"
MONITORING_UNIT = "id-business-independent-backup-monitoring"
MONITORING_ENV = "ID_MONITOR_BACKUP_RECEIPTS_DIR=/run/id-backup-monitoring"
MONITORING_MOUNT = '  --mount "type=bind,src=$formal/backup-monitoring/receipts,dst=/run/id-backup-monitoring,readonly"'
MONITORING_FILES = ("backup_monitoring.py", MONITORING_UNIT + ".service", MONITORING_UNIT + ".timer")
VERSIONED_ASSET = re.compile(r'\b(?:src|href)="(?:\./|/)?([a-zA-Z0-9.-]+\.(?:m?js|css))\?v=([a-zA-Z0-9.-]+)"')


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def run(args, timeout=25):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name):
    return json.loads(run(["docker", "inspect", "id-business-independent-" + name]))[0]


def identity(container):
    return {"id": container["Id"], "image": container["Image"],
            "running": container["State"]["Running"], "startedAt": container["State"]["StartedAt"],
            "revision": (container["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")}


def require_main(sha):
    remote = run(["git", "-c", "credential.helper=", "ls-remote", REPOSITORY, "refs/heads/main"])
    require(remote.decode().split() == [sha, "refs/heads/main"], "remote_main_changed")


def snapshot():
    components = {name: identity(inspect(name)) for name in (*WEBSITE, *PROTECTED)}
    base = components["app"]["revision"]
    require(isinstance(base, str) and re.fullmatch(r"[a-f0-9]{40}", base), "invalid_live_revision")
    require(all(components[name]["running"] and components[name]["revision"] == base for name in WEBSITE),
            "website_and_sidecars_not_on_one_live_revision")
    require("# BEGIN ID CORE RELEASE " not in GATEWAY.read_text(), "core_release_gate_active")
    require(DROP.read_text().count(base) == 1, "live_service_revision_mismatch")
    free = shutil.disk_usage(ROOT).free
    require(free > 12 * 1024**3, "insufficient_free_space")
    live = ROOT / "releases" / base
    return {"components": components, "unitSha256": digest(DROP), "gatewaySha256": digest(GATEWAY),
            "assetsSha256": digest(live / "assets.json"), "freeBytes": free,
            "launchers": {name: digest(live / "operations" / name) for name in LAUNCHERS}}


def check_baseline(current, expected):
    require(all(current[key] == expected[key] for key in
                ("components", "unitSha256", "gatewaySha256", "assetsSha256", "launchers")),
            "live_baseline_changed")


def write_new(path, value, mode):
    with path.open("x") as file:
        os.chmod(path, mode)
        file.write(value)
        file.flush()
        os.fsync(file.fileno())


def update_canary_asset_refs(content, previous_index, target_index):
    previous = dict(VERSIONED_ASSET.findall(previous_index))
    target = dict(VERSIONED_ASSET.findall(target_index))
    for name in previous.keys() & target.keys():
        if previous[name] == target[name]:
            continue
        for asset, query in ((name, "?"), (name.replace(".", r"\."), r"\?")):
            old = f"{asset}{query}v={previous[name]}"
            new = f"{asset}{query}v={target[name]}"
            pattern = rf"(?<![\w.-]){re.escape(old)}(?![\w.-])"
            content = re.sub(pattern, lambda _: new, content)
    return content


def mount_backup_monitoring(content):
    original = '  state=(--mount "type=bind,src=$formal/data,dst=/state")'
    mounted = original[:-1] + "\n" + MONITORING_MOUNT + f'\n  -e "{MONITORING_ENV}")'
    if content.count(mounted) == 1 and content.count(MONITORING_ENV) == 1:
        return content
    require(content.count(original) == 1 and "ID_MONITOR_BACKUP_RECEIPTS_DIR" not in content,
            "unexpected_backup_monitoring_launcher")
    return content.replace(original, mounted)


def stage(plan, release):
    sha = plan["sha"]
    before = plan["before"]
    base = before["components"]["app"]["revision"]
    require(sha != base, "release_revision_already_running")
    source_name = f"independent-source-{sha}.tar.gz"
    assets_name = f"independent-assets-{sha}.json"
    require(set(plan["artifacts"]) == {source_name, assets_name}, "invalid_artifact_names")
    require(plan["artifacts"][assets_name]["sha256"] == before["assetsSha256"], "recharge_assets_changed")
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
    (source / ".runtime").mkdir(mode=0o755)
    shutil.copyfile(artifacts / assets_name, release / "assets.json")
    os.chmod(release / "assets.json", 0o644)
    ops = release / "operations"
    ops.mkdir(mode=0o755)
    live = ROOT / "releases" / base
    for name in LAUNCHERS:
        previous = live / "operations" / name
        require(digest(previous) == before["launchers"][name], "live_launcher_changed")
        content = previous.read_text()
        if name == "run-app":
            require(content.count("sha=" + base) == 1, "live_launcher_revision_mismatch")
            content = mount_backup_monitoring(content.replace("sha=" + base, "sha=" + sha))
        elif name == "check-app.mjs":
            content = update_canary_asset_refs(content, (live / "source/frontend/index.html").read_text(),
                                               (source / "frontend/index.html").read_text())
        write_new(ops / name, content, 0o755 if name == "run-app" else 0o644)
    return source, ops


def canary(sha, ops):
    args = ["systemd-run", "--collect", "--wait", "--pipe", "--unit=id-website-release-canary-" + sha[:12],
            "--property=RuntimeMaxSec=225"]
    for name in ("independent-recharge-bridge", "independent-online-tools", "independent-vendure-integrations"):
        args.append(f"--property=LoadCredentialEncrypted={name}:{FORMAL / 'private' / (name + '.cred')}")
    with (ops / "app-canary.log").open("xb") as log:
        os.chmod(log.name, 0o600)
        result = subprocess.run([*args, str(ops / "run-app"), "canary"], stdout=log,
                                stderr=subprocess.STDOUT, timeout=240)
    require(result.returncode == 0, "isolated_app_canary_failed")


def canary_diagnostics(text):
    indicators = {
        "assertion": r"ERR_ASSERTION|AssertionError",
        "connection_refused": r"ECONNREFUSED|Connection refused",
        "address_in_use": r"EADDRINUSE|address already in use",
        "module_missing": r"ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND",
        "missing_file": r"ENOENT|No such file or directory",
        "permission_denied": r"EACCES|Permission denied",
        "systemd_start_failed": r"Failed to start transient|Failed to start.*service",
        "timeout": r"TimeoutError|timed out",
    }
    frames = re.findall(r"\b(check-app\.mjs|app-entry\.mjs|preview\.mjs):(\d+):(\d+)", text)
    assets = re.findall(r"\b(?:commerce-prototype\.js|prototype\.css|prototype\.js|"
                        r"subscription-management\.js|order-opening\.mjs)(?:\?v=[a-zA-Z0-9-]+)?", text)
    return {"indicators": [name for name, pattern in indicators.items() if re.search(pattern, text, re.I)],
            "frames": [list(frame) for frame in dict.fromkeys(frames)][:12],
            "assets": sorted(set(assets))[:20]}


def inspect_canary(sha):
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "invalid_canary_revision")
    log = ROOT / "releases" / sha / "operations/app-canary.log"
    with log.open("rb") as file:
        size = log.stat().st_size
        file.seek(max(size - 64 * 1024, 0))
        diagnostics = canary_diagnostics(file.read().decode(errors="replace"))
    return {"attemptSha": sha, "liveWebsiteSha": identity(inspect("app"))["revision"],
            "bytes": size, **diagnostics}


def mount_matches(container, source, destination=None):
    return any(mount["Source"] == str(source) and not mount["RW"]
               and (destination is None or mount["Destination"] == destination)
               for mount in container["Mounts"])


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
    status = json.loads(run(["docker", "exec", "id-business-independent-app", "node", "--input-type=module", "-e", check]))
    require(set(status) == {"backup", "recharge_backup"} and all(value != "disabled" for value in status.values()),
            "backup_monitor_check_missing")
    return status


def http(path):
    request = urllib.request.Request("http://127.0.0.1:44572" + path, headers={"Host": SITE_HOST})
    return urllib.request.urlopen(request, timeout=5)


def read_website(plan, release, source):
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
        time.sleep(1)
    else:
        raise ReleaseError("website_or_sidecar_readback_failed")
    require(mount_matches(containers["app"], release / "assets.json"), "live_assets_mount_mismatch")
    require(all(any(m["Destination"] == "/state" and not m["RW"] for m in containers[name]["Mounts"])
                for name in WEBSITE[1:]), "sidecar_state_mount_not_readonly")
    hash_files = """
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const files = JSON.parse(process.argv[1]);
const hashes = files.map(name => [name, createHash('sha256').update(readFileSync('/app/' + name)).digest('hex')]);
console.log(JSON.stringify(Object.fromEntries(hashes)));
"""
    running_hashes = json.loads(run(["docker", "exec", "id-business-independent-app", "node", "--input-type=module",
                                    "-e", hash_files, json.dumps(list(plan["files"]))]))
    require(running_hashes == plan["files"], "running_source_mismatch")
    for name, expected in plan["files"].items():
        if name.startswith("frontend/") and name != "frontend/index.html":
            with http("/" + Path(name).name) as response:
                require(hashlib.sha256(response.read()).hexdigest() == expected, "live_website_asset_mismatch")
    for path in ("/api/local/settings", "/api/local/inventory", "/api/local/commerce", "/api/local/order-sync",
                 "/api/local/system-monitoring"):
        try:
            with http(path):
                raise ReleaseError("anonymous_protected_read_allowed")
        except urllib.error.HTTPError as error:
            require(error.code in (401, 403), "protected_read_status_unexpected")
    require(all(identity(inspect(name)) == plan["before"]["components"][name] for name in PROTECTED),
            "protected_component_changed")
    require(digest(GATEWAY) == plan["before"]["gatewaySha256"], "gateway_changed")
    return states


def release_website(plan):
    sha = plan["sha"]
    before = plan["before"]
    base = before["components"]["app"]["revision"]
    check_baseline(snapshot(), before)
    release = ROOT / "releases" / sha
    source, ops = stage(plan, release)
    canary(sha, ops)
    check_baseline(snapshot(), before)
    require_main(sha)
    install_backup_monitoring(source, sha)
    old = DROP.read_text()
    write_new(ops / "id-business-independent-app.service.before.conf", old, 0o600)
    pending = DROP.with_name(f".{DROP.name}.{sha[:12]}")
    write_new(pending, old.replace(base, sha), DROP.stat().st_mode & 0o777)
    os.replace(pending, DROP)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "restart", UNIT], timeout=55)
    live = read_website(plan, release, source)
    monitoring = read_backup_monitoring(inspect("app"))
    result = {"mainSha": sha, "previousWebsiteSha": base, "website": live["app"],
              "sidecars": {name: live[name] for name in WEBSITE[1:]},
              "sourceFilesVerified": len(plan["files"]), "artifacts": plan["artifacts"],
              "qualityRun": plan["qualityRun"], "preflightCommand": plan["preflightCommand"],
              "appCanaryPassed": True, "protectedComponentsUnchanged": True,
              "backupMonitoring": monitoring,
              "unauthenticatedProtectedReadsRejected": True, "productionBusinessTestWrites": False}
    write_new(ops / "release.receipt.json", json.dumps(result, indent=2) + "\n", 0o600)
    return result


def main(plan):
    try:
        require(re.fullmatch(r"[a-f0-9]{40}", plan["sha"]), "invalid_release_revision")
        with LOCK.open("r") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require_main(plan["sha"])
            if plan["operation"] == "preflight":
                result = snapshot()
            elif plan["operation"] == "inspect":
                result = inspect_canary(plan["attemptSha"])
            else:
                require(plan["operation"] == "release", "invalid_release_operation")
                result = release_website(plan)
            print(json.dumps(result, sort_keys=True), flush=True)
    except ReleaseError as error:
        sys.exit(str(error))
    except BlockingIOError:
        sys.exit("application_release_lock_busy")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as error:
        sys.exit("website_release_error: " + type(error).__name__.lower())
