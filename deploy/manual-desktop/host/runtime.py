#!/usr/bin/env python3
"""Run one pinned manual recharge broker or supervised workspace on the release host."""

import ipaddress
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys

UID = GID = 10001
USER = "id-manual-desktop"
BRIDGE = Path("/run/id-manual-bridge")
WORKERS = Path("/run/id-manual-workers")
INPUTS = Path("/run/id-manual-input")
STATE = Path("/var/lib/id-manual-desktop")
PROFILES = STATE / "profiles"
CLAIMS = STATE / "claims"
CONFIG = Path("/etc/id-manual-desktop/worker.json")
WORKER_MIB = 512
WORKER_UNIT = "id-manual-workspace@.service"
BROKER_UNIT = "id-manual-broker.service"
KEY = re.compile(r"manual-v1-[0-9a-f]{64}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
INVOCATION = re.compile(r"[0-9a-f]{32}")
SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"
ENV = {"PATH": SYSTEM_PATH, "LC_ALL": "C", "HOME": "/"}
DOCKER = ("/usr/bin/docker", "--config", "/var/empty", "--host", "unix:///var/run/docker.sock")
WORKER_LABEL = "com.id-business.manual-workspace"


class InvalidHost(RuntimeError):
    """A fixed, non-secret diagnostic for the release receipt or journal."""


def require(condition, reason):
    if not condition:
        raise InvalidHost(reason)


def checked_path(path, kind, mode=None, uid=0, gid=0):
    metadata = path.lstat()
    require(kind(metadata.st_mode) and metadata.st_uid == uid and metadata.st_gid == gid
            and (stat.S_IMODE(metadata.st_mode) == mode if mode is not None else not metadata.st_mode & 0o022),
            "invalid_host_path_permissions")
    return path


def release_path(path, kind):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path
            and re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)), "invalid_release_path")
    for parent in path.parents:
        checked_path(parent, stat.S_ISDIR)
    return checked_path(path, kind)


def memory_mib(path=Path("/proc/meminfo")):
    sample = path.read_text(encoding="ascii")
    amounts = []
    for field in ("MemTotal", "MemAvailable"):
        value = re.search(rf"^{field}:[ \t]+([1-9][0-9]*) kB$", sample, re.MULTILINE)
        require(value is not None, "host_memory_unavailable")
        amounts.append(int(value[1]) // 1024)
    require(amounts[0] >= amounts[1], "host_memory_unavailable")
    return tuple(amounts)


def validate_capacity(config, available=True):
    total, free = memory_mib()
    minimum = config["min_available_mib"]
    active = config["max_active"]
    require(type(minimum) is int and type(active) is int and minimum >= WORKER_MIB and active >= 1,
            "invalid_workspace_capacity")
    require(total >= minimum + (active - 1) * WORKER_MIB, "workspace_capacity_exceeds_host_memory")
    require(not available or free >= minimum, "insufficient_available_memory_for_workspace")


def config_from_file(path):
    checked_path(path, stat.S_ISREG, 0o644)
    with path.open(encoding="ascii") as source:
        config = json.load(source)
    require(set(config) == {"root", "desktop", "python", "image", "assets", "max_active",
                            "min_available_mib", "block_networks", "site_packages"}
            and bool(IMAGE.fullmatch(config["image"])),
            "invalid_worker_configuration")
    desktop = release_path(config["desktop"], stat.S_ISDIR)
    require(desktop == Path(__file__).resolve().parents[1], "worker_configuration_release_mismatch")
    return config


def worker_key(key):
    require(KEY.fullmatch(key) is not None, "invalid_workspace_key")
    return key


def ensure_directory(path, uid, gid, mode):
    try:
        path.mkdir(mode=mode)
    except FileExistsError:
        return checked_path(path, stat.S_ISDIR, mode, uid, gid)
    os.chown(path, uid, gid, follow_symlinks=False)
    path.chmod(mode)
    return checked_path(path, stat.S_ISDIR, mode, uid, gid)


def prepared_input(key):
    checked_path(INPUTS, stat.S_ISDIR, 0o700, UID, GID)
    source = checked_path(INPUTS / worker_key(key), stat.S_ISDIR, 0o710, UID, GID)
    checked_path(source / "bootstrap.sock", stat.S_ISSOCK, 0o660, UID, GID)
    checked_path(source / "egress.sock", stat.S_ISSOCK, 0o600, UID, GID)
    return source


def worker_command(key, invocation, config, profile, state, source):
    worker_key(key)
    require(INVOCATION.fullmatch(invocation) is not None, "invalid_systemd_invocation")
    require(IMAGE.fullmatch(config["image"]) is not None, "invalid_worker_image")
    seccomp = release_path(Path(config["desktop"]) / "chromium-seccomp.json", stat.S_ISREG)
    return [
        *DOCKER, "run", "--rm", "--pull=never", "--name", "id-" + key,
        "--hostname", key[:63], "--label", f"{WORKER_LABEL}={invocation}",
        "--network", "none", "--ipc", "private", "--cgroupns", "private", "--read-only",
        "--user", f"{UID}:{GID}", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true", "--security-opt", f"seccomp={seccomp}",
        "--memory", f"{WORKER_MIB}m", "--memory-swap", f"{WORKER_MIB}m",
        "--pids-limit", "512", "--shm-size", "128m", "--stop-timeout", "25",
        "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=128m",
        "--mount", f"type=bind,src={profile},dst=/profile,bind-propagation=rprivate",
        "--mount", f"type=bind,src={state},dst=/run/workspace,bind-propagation=rprivate",
        "--mount", f"type=bind,src={source},dst=/run/workspace-input,readonly,bind-propagation=rprivate",
        config["image"]
    ]


def command(args, timeout=8, allowed=(0,)):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=ENV, timeout=timeout, check=False)
    require(result.returncode in allowed and len(result.stdout) <= 32768, "host_command_failed")
    return result.stdout.decode("ascii").strip(), result.returncode


def run_worker(config, key):
    worker_key(key)
    invocation = os.environ.get("INVOCATION_ID", "")
    require(INVOCATION.fullmatch(invocation) is not None, "invalid_systemd_invocation")
    source = prepared_input(key)
    validate_capacity(config)
    checked_path(PROFILES, stat.S_ISDIR, 0o700)
    checked_path(WORKERS, stat.S_ISDIR, 0o750, 0, GID)
    profile = ensure_directory(PROFILES / key, UID, GID, 0o700)
    runtime = ensure_directory(WORKERS / key, UID, GID, 0o700)
    args = worker_command(key, invocation, config, profile, runtime, source)
    os.execve(args[0], args, ENV)


def stop_worker(key):
    worker_key(key)
    invocation = os.environ.get("INVOCATION_ID", "")
    require(INVOCATION.fullmatch(invocation) is not None, "invalid_systemd_invocation")
    display = "{{.ID}}|{{.Label \"" + WORKER_LABEL + "\"}}"
    existing, _ = command([*DOCKER, "ps", "--all", "--no-trunc", "--filter", f"name=^/id-{key}$",
                           "--format", display], timeout=3)
    if existing:
        identifier, _, owner = existing.partition("|")
        require(re.fullmatch(r"[a-f0-9]{64}", identifier) and owner == invocation,
                "managed_worker_container_ownership_mismatch")
        command([*DOCKER, "stop", "--time", "25", identifier], timeout=27)


def broker_arguments(config):
    blocked = []
    for network in config["block_networks"]:
        blocked.extend(("--recharge-block-network", str(ipaddress.ip_network(network))))
    return [
        str(Path(config["desktop"]) / "broker.py"),
        "--socket", str(BRIDGE / "site.sock"),
        "--workers", str(WORKERS), "--claims", str(CLAIMS), "--assets", config["assets"],
        "--start-units", "--max-active", str(config["max_active"]),
        "--min-available-mib", str(config["min_available_mib"]),
        "--recharge-input", str(INPUTS), *blocked
    ]


def run_broker(config):
    require((os.geteuid(), os.getegid()) == (UID, GID), "invalid_broker_identity")
    checked_path(BRIDGE, stat.S_ISDIR, 0o750, UID, GID)
    checked_path(CLAIMS, stat.S_ISDIR, 0o700, UID, GID)
    checked_path(INPUTS, stat.S_ISDIR, 0o700, UID, GID)
    checked_path(WORKERS, stat.S_ISDIR, 0o750, 0, GID)
    sys.argv = broker_arguments(config)
    if config["site_packages"]:
        packages = release_path(config["site_packages"], stat.S_ISDIR)
        require(packages.is_relative_to(config["root"]), "python_packages_outside_staged_release")
        sys.path.insert(0, str(packages))
    sys.path.insert(0, config["desktop"])
    runpy.run_path(sys.argv[0], run_name="__main__")


def main(action, config, *keys):
    require((action == "broker" and not keys) or (action in ("worker", "stop") and len(keys) == 1),
            "invalid_runtime_operation")
    if action == "stop":
        stop_worker(keys[0])
    elif action == "worker":
        run_worker(config_from_file(Path(config)), keys[0])
    else:
        run_broker(config_from_file(Path(config)))


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except InvalidHost as error:
        sys.exit(str(error))
    except (OSError, TypeError, ValueError, subprocess.SubprocessError):
        sys.exit("manual_workspace_runtime_unavailable")
