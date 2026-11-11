"""Run the existing website-only staging, canary, and switch on the SSM host."""

import fcntl
import hashlib
import json
import os
import re
import shutil
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
    for name in LAUNCHERS:
        previous = ROOT / "releases" / base / "operations" / name
        require(digest(previous) == before["launchers"][name], "live_launcher_changed")
        content = previous.read_text()
        if name == "run-app":
            require(content.count("sha=" + base) == 1, "live_launcher_revision_mismatch")
            content = content.replace("sha=" + base, "sha=" + sha)
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
    for path in ("/api/local/settings", "/api/local/inventory", "/api/local/commerce", "/api/local/order-sync"):
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
    old = DROP.read_text()
    write_new(ops / "id-business-independent-app.service.before.conf", old, 0o600)
    pending = DROP.with_name(f".{DROP.name}.{sha[:12]}")
    write_new(pending, old.replace(base, sha), DROP.stat().st_mode & 0o777)
    os.replace(pending, DROP)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "restart", UNIT], timeout=55)
    live = read_website(plan, release, source)
    result = {"mainSha": sha, "previousWebsiteSha": base, "website": live["app"],
              "sidecars": {name: live[name] for name in WEBSITE[1:]},
              "sourceFilesVerified": len(plan["files"]), "artifacts": plan["artifacts"],
              "qualityRun": plan["qualityRun"], "preflightCommand": plan["preflightCommand"],
              "appCanaryPassed": True, "protectedComponentsUnchanged": True,
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
