#!/usr/bin/env python3
"""Provision the manually launched browser runtime from an exact staged website release."""

import argparse
from contextlib import contextmanager, suppress
import fcntl
import grp
import hashlib
from http.client import HTTPResponse
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime import (
    BRIDGE, BROKER_UNIT, CLAIMS, CONFIG, DOCKER, GID, IMAGE, INPUTS, PROFILES, STATE, UID,
    USER, WORKER_UNIT, WORKERS, InvalidHost, checked_path, command, ensure_directory,
    release_path, require, validate_capacity,
)

SYSTEMCTL = "/usr/bin/systemctl"
TMPFILES = "/usr/bin/systemd-tmpfiles"
SYSUSERS = "/usr/bin/systemd-sysusers"
PKCHECK = "/usr/bin/pkcheck"
RPM = "/usr/bin/rpm"
RPM_KEYS = "/usr/bin/rpmkeys"
UNIT_DIR = Path("/etc/systemd/system")
SYSUSERS_FILE = Path("/etc/sysusers.d/id-manual-desktop.conf")
TMPFILES_FILE = Path("/etc/tmpfiles.d/id-manual-desktop.conf")
POLKIT_FILE = Path("/etc/polkit-1/rules.d/50-id-manual-desktop.rules")
LOCK = Path("/run/id-manual-desktop-install.lock")
PROBE_UNIT = "id-manual-workspace@manual-v1-" + "0" * 64 + ".service"
MANAGE_UNITS = "org.freedesktop.systemd1.manage-units"

POLICY = r"""
polkit.addRule(function(action, subject) {
    if (subject.user !== "id-manual-desktop" || action.id !== "org.freedesktop.systemd1.manage-units")
        return;
    var unit = action.lookup("unit");
    var verb = action.lookup("verb");
    if (typeof unit === "string" && /^id-manual-workspace@manual-v1-[a-f0-9]{64}\.service$/.test(unit)
        && (verb === "start" || verb === "stop"))
        return polkit.Result.YES;
});
""".lstrip()


def release_config(args):
    root = release_path(args.release_root, stat.S_ISDIR)
    require(re.fullmatch(r"[0-9a-f]{40}", root.name) is not None, "invalid_staged_release_revision")
    desktop = release_path(Path(__file__).resolve().parents[1], stat.S_ISDIR)
    require(desktop.is_relative_to(root), "provisioner_outside_staged_release")
    assets = release_path(args.assets, stat.S_ISDIR)
    require(assets.is_relative_to(root), "novnc_outside_staged_release")
    release_path(assets / "core/rfb.js", stat.S_ISREG)
    for file in ("broker.py", "egress.py", "worker/recharge_proxy.py", "chromium-seccomp.json",
                 "host/runtime.py", "host/check_renewal.py"):
        release_path(desktop / file, stat.S_ISREG)
    packages = release_path(args.site_packages, stat.S_ISDIR) if args.site_packages else None
    require(packages is None or packages.is_relative_to(root), "python_packages_outside_staged_release")
    python = release_path(Path(args.python).resolve(strict=True), stat.S_ISREG)
    require(python.is_relative_to(root) or python.parent == Path("/usr/bin"),
            "python_outside_trusted_paths")
    require(IMAGE.fullmatch(args.image_id) is not None, "invalid_worker_image")
    return {
        "root": str(root), "desktop": str(desktop), "python": str(python), "image": args.image_id,
        "assets": str(assets), "site_packages": str(packages) if packages else "",
        "max_active": args.max_active, "min_available_mib": args.min_available_mib,
        "block_networks": sorted({str(ipaddress.ip_network(net)) for net in args.block_network}),
    }


def existing_identity(required=False):
    def lookup(get, value):
        try:
            return get(value)
        except KeyError:
            return None

    user, uid = lookup(pwd.getpwnam, USER), lookup(pwd.getpwuid, UID)
    group, gid = lookup(grp.getgrnam, USER), lookup(grp.getgrgid, GID)
    require((user is None and uid is None) or
            (user == uid and user.pw_uid == UID and user.pw_gid == GID
             and Path(user.pw_shell).name in ("nologin", "false")),
            "broker_uid_already_in_use")
    require((group is None and gid is None) or
            (group == gid and group.gr_gid == GID and not group.gr_mem),
            "broker_gid_already_in_use")
    require(not required or (user is not None and group is not None), "broker_identity_unavailable")


def systemctl(*args, allowed=(0,), timeout=10):
    return command([SYSTEMCTL, "--no-ask-password", "--no-pager", *args], allowed=allowed, timeout=timeout)


def prepare_host_tools(config):
    if os.access(PKCHECK, os.X_OK):
        return False
    distribution = Path("/etc/os-release").read_text(encoding="utf8")
    require(re.search(r'^ID="?amzn"?$', distribution, re.MULTILINE) and
            re.search(r'^VERSION_ID="?2023"?$', distribution, re.MULTILINE),
            "manual_host_package_platform_unsupported")
    inventory = release_path(Path(config["desktop"]) / "host/polkit-rpms.json", stat.S_ISREG)
    catalog = json.loads(inventory.read_text(encoding="ascii"))
    release, _ = command([RPM, "-q", "--qf", "%{VERSION}", "system-release"],
                         failure="manual_host_package_inventory_failed")
    require(release == catalog["systemRelease"] and platform.machine() == catalog["architecture"] == "x86_64",
            "manual_host_package_release_mismatch")
    package_dir = release_path(Path(config["root"]) / "manual-runtime/host-packages", stat.S_ISDIR)
    packages = catalog["packages"]
    require({item["name"] for item in packages} == {"polkit", "polkit-libs", "duktape"} and len(packages) == 3
            and {item["file"] for item in packages} == {path.name for path in package_dir.iterdir()},
            "manual_host_dependency_bundle_invalid")
    package_paths = []
    for item in packages:
        filename = item["file"]
        require(re.fullmatch(r"[A-Za-z0-9._+-]+\.x86_64\.rpm", filename) is not None,
                "manual_host_dependency_name_invalid")
        package = release_path(package_dir / filename, stat.S_ISREG)
        require(0 < item["bytes"] <= 2_000_000 and package.stat().st_size == item["bytes"]
                and hashlib.sha256(package.read_bytes()).hexdigest() == item["sha256"],
                "manual_host_dependency_digest_mismatch")
        signature, _ = command([RPM_KEYS, "--checksig", str(package)],
                               failure="manual_host_dependency_verification_failed")
        require(signature.endswith("digests signatures OK"), "manual_host_dependency_signature_invalid")
        name, _ = command([RPM, "-qp", "--qf", "%{NAME}", str(package)],
                          failure="manual_host_dependency_header_failed")
        require(name == item["name"], "manual_host_dependency_name_invalid")
        _, status = command([RPM, "-q", item["name"]], allowed=(0, 1), failure="manual_host_package_inventory_failed")
        if status == 1:
            package_paths.append(str(package))
    require(package_paths, "manual_host_dependency_install_unverified")
    command([RPM, "--install", "--test", *package_paths], timeout=20, failure="manual_host_dependency_rpm_check_failed")
    command([RPM, "--install", *package_paths], timeout=35, failure="manual_host_dependency_rpm_install_failed")
    require(os.access(PKCHECK, os.X_OK), "manual_host_dependency_install_unverified")
    systemctl("daemon-reload")
    return True


def check_host(config, available=True):
    require(platform.system() == "Linux" and os.geteuid() == 0, "requires_root_linux_release_host")
    require(Path("/proc/1/comm").read_text().strip() == "systemd", "systemd_host_required")
    for name, tool in (("docker", DOCKER[0]), ("systemctl", SYSTEMCTL), ("tmpfiles", TMPFILES),
                       ("sysusers", SYSUSERS), ("pkcheck", PKCHECK), ("python", config["python"])):
        require(os.access(tool, os.X_OK), f"manual_host_{name}_unavailable")
    require(systemctl("show", "polkit.service", "-p", "LoadState", "--value")[0] == "loaded",
            "polkit_service_unavailable")
    existing_identity()
    validate_capacity(config, available)
    require(systemctl("is-active", "docker.service", allowed=(0, 3, 4))[1] == 0, "docker_service_not_active")
    context, _ = command([*DOCKER, "info", "--format",
                          '{{.OSType}}|{{.Architecture}}|{{.CgroupVersion}}|{{.MemoryLimit}}|'
                          '{{.SwapLimit}}|{{.PidsLimit}}|{{json .SecurityOptions}}'])
    operating_system, arch, cgroup, memory, swap, pids, security = context.split("|")
    architecture = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(arch)
    security = {item.split(",", 1)[0] for item in json.loads(security)}
    require(architecture and (operating_system, cgroup, memory, swap, pids) == ("linux", "2", "true", "true", "true")
            and "name=seccomp" in security and security.isdisjoint(("name=userns", "name=rootless")),
            "docker_workspace_isolation_unavailable")
    image, _ = command([*DOCKER, "image", "inspect", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}|{{.Config.User}}",
                        config["image"]])
    require(image == f'{config["image"]}|linux|{architecture}|{UID}:{GID}', "staged_worker_image_mismatch")
    require(int(Path("/proc/sys/user/max_user_namespaces").read_text()) > 0, "user_namespaces_unavailable")
    with suppress(FileNotFoundError):
        require(Path("/proc/sys/kernel/unprivileged_userns_clone").read_text().strip() == "1",
                "unprivileged_user_namespaces_unavailable")
    python_check = (
        "import os, sys; assert sys.version_info >= (3, 9) and hasattr(os, 'O_PATH'); "
        "sys.path[0:0] = sys.argv[1:]; import aiohttp"
    )
    command([config["python"], "-IB", "-c", python_check] +
            ([config["site_packages"]] if config["site_packages"] else []),
            failure="manual_broker_python_runtime_unavailable")


def managed_files(config):
    runner = str(Path(config["desktop"]) / "host/runtime.py")
    broker = f"""[Unit]
Description=ID manual recharge browser broker
After=docker.service systemd-tmpfiles-setup.service polkit.service
Requires=docker.service
Wants=polkit.service

[Service]
Type=exec
User={USER}
Group={USER}
ExecStart={config["python"]} -IB {runner} broker {CONFIG}
Restart=on-failure
RestartSec=3s
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
InaccessiblePaths={PROFILES}
ReadWritePaths={BRIDGE} {CLAIMS} {INPUTS}
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
"""
    worker = f"""[Unit]
Description=ID manual recharge browser workspace
After=docker.service
Requires=docker.service
PartOf={BROKER_UNIT}

[Service]
Type=exec
ExecStart=/usr/bin/python3 -IB {runner} worker {CONFIG} %i
ExecStop=/usr/bin/python3 -IB {runner} stop {CONFIG} %i
TimeoutStopSec=31s
UMask=0077
KillMode=mixed
"""
    return {
        SYSUSERS_FILE: f'g {USER} {GID}\nu {USER} {UID}:{GID} "ID manual desktop broker" -\n',
        TMPFILES_FILE: (f"d {BRIDGE} 0750 {UID} {GID} -\n"
                        f"d {WORKERS} 0750 0 {GID} -\n"
                        f"d {INPUTS} 0700 {UID} {GID} -\n"),
        POLKIT_FILE: POLICY,
        UNIT_DIR / BROKER_UNIT: broker,
        UNIT_DIR / WORKER_UNIT: worker,
        CONFIG: json.dumps(config, sort_keys=True, indent=2) + "\n",
    }


def installed(path):
    try:
        checked_path(path, stat.S_ISREG, 0o644)
        return path.read_text(encoding="ascii")
    except FileNotFoundError:
        return None


def ensure_sysusers_directory():
    parent = SYSUSERS_FILE.parent
    checked_path(parent.parent, stat.S_ISDIR)
    parent.mkdir(mode=0o755, exist_ok=True)
    checked_path(parent, stat.S_ISDIR)


def write_atomic(path, content):
    if content is None:
        path.unlink(missing_ok=True)
    else:
        with tempfile.NamedTemporaryFile(mode="w", encoding="ascii", dir=path.parent,
                                         prefix=".id-manual-", delete=False) as pending:
            staged = Path(pending.name)
            try:
                pending.write(content)
                pending.flush()
                os.fchmod(pending.fileno(), 0o644)
                os.fsync(pending.fileno())
                os.replace(staged, path)
            finally:
                staged.unlink(missing_ok=True)


@contextmanager
def exclusive_install():
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        checked_path(LOCK, stat.S_ISREG, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def broker_state():
    output, status = systemctl("show", "--all", BROKER_UNIT, "-p", "LoadState", "-p", "ActiveState", allowed=(0, 1, 4))
    properties = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    load = properties.get("LoadState")
    active = properties.get("ActiveState")
    if load == "not-found" and active in (None, "inactive"):
        return "inactive"
    if not output and status in (1, 4):
        # Some systemctl builds return no properties for a unit the manager
        # has never loaded. Establish that the unit is absent from both views.
        units, _ = systemctl("list-units", "--all", "--plain", "--no-legend", BROKER_UNIT)
        files, _ = systemctl("list-unit-files", "--plain", "--no-legend", BROKER_UNIT, allowed=(0, 1, 4))
        if not units and not files:
            return "inactive"
    require(load == "loaded" and active is not None, "broker_service_state_unverified")
    return active


def broker_active():
    state = broker_state()
    require(state in ("active", "inactive", "failed"), "broker_service_is_transitioning")
    return state == "active"


def wait_for_broker_ready():
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = broker_state()
        if state == "active" and (BRIDGE / "site.sock").is_socket():
            return
        if state == "failed":
            break
        time.sleep(0.2)
    raise InvalidHost("manual_broker_startup_failed")


def require_no_workers():
    workers, _ = systemctl("list-units", "--plain", "--no-legend",
                           "--state=activating,active,deactivating,reloading,refreshing,maintenance",
                           "id-manual-workspace@*.service")
    require(not workers, "active_workspace_units_present")


def verify_loaded_units():
    for instance, fragment in ((BROKER_UNIT, BROKER_UNIT), (PROBE_UNIT, WORKER_UNIT)):
        display, _ = systemctl("show", instance, "-p", "FragmentPath", "-p", "DropInPaths")
        properties = dict(line.split("=", 1) for line in display.splitlines() if "=" in line)
        require(properties.get("FragmentPath") == str(UNIT_DIR / fragment)
                and not properties.get("DropInPaths"), "unexpected_manual_workspace_unit_configuration")


def probe(path, target):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(2)
        stream.connect(str(path))
        stream.sendall(f"GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode("ascii"))
        with HTTPResponse(stream) as response:
            response.begin()
            return response.status, response.read(1024)


def verify_policy():
    pid, _ = systemctl("show", BROKER_UNIT, "-p", "MainPID", "--value")
    require(re.fullmatch("[1-9][0-9]*", pid) is not None, "broker_pid_missing")
    proc = Path("/proc") / pid
    require(proc.stat().st_uid == UID, "broker_running_as_unexpected_user")
    fields = (proc / "stat").read_text().rpartition(") ")[2].split()
    require(len(fields) >= 20 and fields[19].isdigit(), "broker_pid_unverified")
    test = [PKCHECK, "--action-id", MANAGE_UNITS, "--process", f"{pid},{fields[19]},{UID}"]
    for unit, verb, expected in ((PROBE_UNIT, "start", True), (PROBE_UNIT, "stop", True),
                                 (PROBE_UNIT, "restart", False), ("docker.service", "stop", False)):
        _, status = command([*test, "--detail", "unit", unit, "--detail", "verb", verb], allowed=(0, 1, 2))
        require((status == 0) == expected, "broker_unit_permissions_mismatch")


def verify(config):
    require(all(installed(path) == data for path, data in managed_files(config).items()),
            "installed_manual_runtime_differs_from_release")
    require(broker_active(), "manual_broker_is_not_active")
    existing_identity(required=True)
    verify_loaded_units()
    checked_path(BRIDGE, stat.S_ISDIR, 0o750, UID, GID)
    path = BRIDGE / "site.sock"
    checked_path(path, stat.S_ISSOCK, 0o660, UID, GID)
    status, body = probe(path, "/v1/recharge/status")
    require(status == 200 and json.loads(body) == {"rechargeBootstrap": 1}, "manual_broker_not_ready")
    status, body = probe(path, "/v1/renewal/status")
    require(status == 200 and json.loads(body) == {"renewalWorkspace": 1}, "renewal_workspace_not_ready")
    status, body = probe(path, "/v1/client/core/rfb.js")
    require(status == 200 and bool(body), "novnc_client_unavailable")
    verify_policy()


def install(config):
    files = managed_files(config)
    with exclusive_install():
        check_host(config, available=False)
        before = {path: installed(path) for path in files}
        if broker_active():
            require(before == files, "different_broker_release_active")
            verify(config)
            return False
        require_no_workers()
        validate_capacity(config)
        require(before[CONFIG] is not None or all(data is None for data in before.values()),
                "unmanaged_manual_runtime_files_present")
        previous_enabled, _ = systemctl("is-enabled", BROKER_UNIT, allowed=(0, 1, 3, 4))
        require(previous_enabled in ("enabled", "disabled", "not-found", ""), "unsupported_broker_enablement")
        ensure_sysusers_directory()
        for directory, uid, gid, mode in ((CONFIG.parent, 0, 0, 0o755), (STATE, 0, 0, 0o711),
                                          (PROFILES, 0, 0, 0o700), (CLAIMS, UID, GID, 0o700)):
            ensure_directory(directory, uid, gid, mode)
        # Refuse to adopt or change permissions on directories from another runtime.
        for directory, uid, gid, mode in ((BRIDGE, UID, GID, 0o750), (WORKERS, 0, GID, 0o750), (INPUTS, UID, GID, 0o700)):
            with suppress(FileNotFoundError):
                checked_path(directory, stat.S_ISDIR, mode, uid, gid)
        changed = []
        start_attempted = enable_attempted = False
        try:
            for path, data in files.items():
                if data != before[path]:
                    write_atomic(path, data)
                    changed.append(path)
            command([SYSUSERS, str(SYSUSERS_FILE)])
            existing_identity(required=True)
            command([TMPFILES, "--create", str(TMPFILES_FILE)])
            systemctl("daemon-reload")
            verify_loaded_units()
            start_attempted = True
            systemctl("start", BROKER_UNIT)
            wait_for_broker_ready()
            verify(config)
            enable_attempted = previous_enabled != "enabled"
            systemctl("enable", BROKER_UNIT)
        except (OSError, ValueError, subprocess.SubprocessError, InvalidHost):
            if start_attempted:
                systemctl("stop", BROKER_UNIT)
                require(not broker_active(), "manual_broker_deactivation_not_verified")
            if enable_attempted:
                systemctl("disable", BROKER_UNIT)
            for path in reversed(changed):
                write_atomic(path, before[path])
            systemctl("daemon-reload")
            raise
        return True


def deactivate(config):
    with exclusive_install():
        require(all(installed(path) == data for path, data in managed_files(config).items()),
                "installed_manual_runtime_differs_from_release")
        verify_loaded_units()
        require_no_workers()
        systemctl("disable", "--now", BROKER_UNIT)
        require(not broker_active(), "manual_broker_deactivation_not_verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "check", "install", "verify", "smoke", "deactivate"))
    parser.add_argument("--release-root", required=True, type=Path)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--site-packages", type=Path)
    parser.add_argument("--python", type=Path, default=Path("/usr/bin/python3"))
    parser.add_argument("--max-active", required=True, type=int)
    parser.add_argument("--min-available-mib", required=True, type=int)
    parser.add_argument("--block-network", action="append", default=[])
    args = parser.parse_args()
    require(platform.system() == "Linux" and os.geteuid() == 0, "requires_root_linux_release_host")
    config = release_config(args)
    result = {"operation": args.operation, "revision": Path(config["root"]).name}
    if args.operation == "prepare":
        result["systemDependencyInstalled"] = prepare_host_tools(config)
    elif args.operation == "install":
        result["started"] = install(config)
    elif args.operation == "deactivate":
        deactivate(config)
    else:
        check_host(config, available=args.operation == "check")
        if args.operation in ("verify", "smoke"):
            verify(config)
        if args.operation == "smoke":
            if config["site_packages"]:
                sys.path.append(config["site_packages"])
            from check_renewal import run as check_renewal
            check_renewal()
            result["renewalLifecycleVerified"] = True
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except InvalidHost as error:
        sys.exit(str(error))
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        sys.exit("manual_workspace_host_operation_failed")
