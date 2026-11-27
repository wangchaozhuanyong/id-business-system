"""Read-only host observations for the manual browser workspace. No canary is started."""
import datetime
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess


SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"
APP = "id-business-independent-app"
SOCKET = "run/id-manual-bridge/site.sock"
UNIT = "id-manual-workspace@.service"
BROKER_UNIT = "id-manual-broker.service"
BROKER_JOURNAL_LINES = 24
BROKER_JOURNAL = ["/usr/bin/journalctl", "--quiet", "--no-pager", "--boot", "--since=-2h",
                  f"--lines={BROKER_JOURNAL_LINES}", f"--unit={BROKER_UNIT}", "--output=json",
                  "--output-fields=MESSAGE,_SYSTEMD_UNIT,UNIT,OBJECT_SYSTEMD_UNIT,_PID"]
BROKER_JOURNAL_BYTES = 128 * 1024
BROKER_STARTUP_PATTERNS = (
    ("python_open_permission", r"^(?:[^:\n]*/)?python(?:[0-9.]+)?: can't open file .*\[Errno 13\] Permission denied"),
    ("python_open_missing", r"^(?:[^:\n]*/)?python(?:[0-9.]+)?: can't open file .*\[Errno 2\] No such file"),
    ("python_open_failed", r"^(?:[^:\n]*/)?python(?:[0-9.]+)?: can't open file "),
    ("broker_argument_error", r"^(?:broker|runtime)\.py: error: "),
    ("broker_access_failure", r"^(?:invalid_host_path_permissions|invalid_release_path|invalid_broker_identity|"
                             r"worker_configuration_release_mismatch)$|^PermissionError: \[Errno (?:1|13)\]"),
    ("broker_runtime_failure", r"^(?:manual_workspace_runtime_unavailable|invalid_worker_configuration)$|"
                              r"^(?:ImportError|ModuleNotFoundError):"),
    ("systemd_sandbox_failure", r"\bstatus=(?:218/CAPABILITIES|225/NETWORK|226/NAMESPACE|"
                               r"227/NO_NEW_PRIVILEGES|228/SECCOMP|229/SELINUX_CONTEXT|"
                               r"231/APPARMOR_PROFILE|232/ADDRESS_FAMILIES|233/RUNTIME_DIRECTORY)\b|"
                               r"\bFailed (?:to set up mount namespacing|at step (?:CAPABILITIES|NETWORK|"
                               r"NAMESPACE|NO_NEW_PRIVILEGES|SECCOMP|SELINUX_CONTEXT|APPARMOR_PROFILE|"
                               r"ADDRESS_FAMILIES|RUNTIME_DIRECTORY))\b"),
    ("systemd_exec_failure", r"\bstatus=(?:200/CHDIR|203/EXEC|216/GROUP|217/USER)\b|"
                            r"\bFailed at step (?:CHDIR|EXEC|GROUP|USER)\b|\bFailed to locate executable\b"),
    ("systemd_exit_2", r"\bstatus=2/INVALIDARGUMENT\b"),
    ("systemd_failure", r"\b(?:Main process exited|Failed with result|Start request repeated too quickly|Failed to start)\b"),
    ("systemd_lifecycle", r"^(?:Starting|Started|Stopping|Stopped) |"
                          r"\b(?:Deactivated successfully|Scheduled restart job)\b"),
)
DOCKER = ("docker", "--config", "/var/empty/id-manual-preflight", "--host", "unix:///var/run/docker.sock")
DOCKER_INFO = ("{{.CgroupVersion}}|{{.MemoryLimit}}|{{.SwapLimit}}|{{.PidsLimit}}|"
               "{{range .SecurityOptions}}{{if eq (index (split . \",\" ) 0) \"name=seccomp\"}}seccomp{{end}}{{end}}")
APP_VIEW = ('{{.State.Running}}|{{.State.Pid}}|{{range .Mounts}}{{if eq .Type "bind"}}'
            '{{if eq .Destination "/run/id-manual-bridge"}}directory{{end}}'
            '{{if eq .Destination "/run/id-manual-bridge/site.sock"}}socket{{end}}{{end}}{{end}}')
MEMORY = ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")
FAMILY = {"amzn": "amazon-linux", "debian": "debian", "ubuntu": "ubuntu", "rhel": "rhel",
          "rocky": "rhel", "almalinux": "rhel", "centos": "rhel", "fedora": "fedora",
          "sles": "suse", "opensuse-leap": "suse", "alpine": "alpine"}


def _command(args):
    journal = args == BROKER_JOURNAL
    limit = BROKER_JOURNAL_BYTES if journal else 512
    try:
        proc = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              env={"PATH": SYSTEM_PATH, "LC_ALL": "C"}, timeout=4, check=False)
        if proc.returncode == 0 and len(proc.stdout) <= limit:
            return proc.stdout.decode("utf8" if journal else "ascii").strip()
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        pass
    return None


def _text(path):
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


def _number(value):
    return int(value) if value and re.fullmatch(r"[0-9]{1,18}", value.strip()) else None


def _socket(path):
    try:
        metadata = path.lstat()
        return (metadata.st_dev, metadata.st_ino) if stat.S_ISSOCK(metadata.st_mode) else False
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError:
        return None


def _broker_startup(command):
    output = command(BROKER_JOURNAL)
    if output is None:
        return {"journalReadable": False, "recentCategories": []}
    rows = output.split("\n")
    if len(output) > BROKER_JOURNAL_BYTES or len(rows) > BROKER_JOURNAL_LINES:
        return {"journalReadable": False, "recentCategories": []}
    recent = {}
    for row in reversed(rows):
        try:
            entry = json.loads(row)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        service_entry = entry.get("_SYSTEMD_UNIT") == BROKER_UNIT
        manager_entry = entry.get("_PID") == "1" and BROKER_UNIT in (
            entry.get("UNIT"), entry.get("OBJECT_SYSTEMD_UNIT")
        )
        message = entry.get("MESSAGE")
        if not (service_entry or manager_entry) or not isinstance(message, str) or len(message) > 4096:
            continue
        label = next((label for label, pattern in BROKER_STARTUP_PATTERNS if re.search(pattern, message)), None)
        if label:
            recent[label] = None
    return {"journalReadable": True, "recentCategories": list(recent)}


def _package_observation(root):
    tools = {name: os.access(root / "usr/bin" / name, os.X_OK) for name in
             ("dnf", "rpm", "rpmkeys", "systemd-sysusers", "systemd-tmpfiles", "pkcheck")}
    log = root / "var/log/dnf.log"
    try:
        metadata = log.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            return {"executables": tools, "packageDownload": "unavailable"}
        with log.open("rb") as stream:
            stream.seek(max(0, metadata.st_size - 65_536))
            latest = stream.read(65_536).decode("utf8", errors="replace")
    except OSError:
        return {"executables": tools, "packageDownload": "unavailable"}
    commands = re.split(r"\n[^\n]*\bCommand: ", latest)
    entry = next((item.lower() for item in reversed(commands[1:]) if
                  "workspace-dependencies-" in item.partition("\n")[0] and "polkit" in item.partition("\n")[0]), "")
    categories = (
        ("repository_missing", ("unknown repo", "no matching repo", "repository not found")),
        ("signature", ("public key", "gpg signature", "repomd.xml gpg", "bad signature")),
        ("repository_access", ("failed to download metadata", "curl error", "cannot prepare internal mirrorlist")),
        ("package_unavailable", ("no match for argument", "unable to find a match")),
        ("package_conflict", ("conflicting requests", "nothing provides", "problem with installed package")),
        ("installation_error", ("transaction check error", "errors during downloading")),
    )
    outcome = next((label for label, markers in categories if any(value in entry for value in markers)),
                   "unclassified" if entry else "no_recent_workspace_transaction")
    return {"executables": tools, "packageDownload": outcome}


def _staged_packages(root, command, revision):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("manual_workspace_attempt_revision_invalid")
    target = root / "opt/id-business-independent/releases" / revision / "artifacts"
    folders = [folder for folder in target.glob("workspace-dependencies-*")
               if folder.is_dir() and not folder.is_symlink()]
    paths = [path for folder in folders[:4] for path in folder.glob("*.rpm")
             if path.is_file() and not path.is_symlink()]
    if len(folders) > 4 or len(paths) > 20:
        raise ValueError("manual_workspace_package_report_limit")
    verified = sum((command(["/usr/bin/rpmkeys", "--checksig", str(path)]) or "").endswith("digests signatures OK")
                   for path in paths)
    version = command(["/usr/bin/rpm", "-q", "--qf", "%{VERSION}", "system-release"])
    return {"release": revision, "downloadDirectories": len(folders), "rpmFiles": len(paths),
            "signatureChecksPassed": verified,
            "systemRelease": version if version and re.fullmatch(r"2023\.[0-9]+\.[0-9]{8}", version) else None}


def _docker_info(command, daemon_active):
    output = command([*DOCKER, "info", "--format", DOCKER_INFO]) if daemon_active else None
    fields = (output or "").split("|")
    if len(fields) != 5:
        fields = [""] * 5
        seccomp = None
    else:
        seccomp = {"seccomp": True, "": False}.get(fields[4])
    return {"daemonActive": daemon_active, "cgroupV2": {"1": False, "2": True}.get(fields[0]),
            "memoryLimit": {"true": True, "false": False}.get(fields[1]),
            "swapLimit": {"true": True, "false": False}.get(fields[2]),
            "pidsLimit": {"true": True, "false": False}.get(fields[3]),
            "seccompAdvertised": seccomp}


def _website(root, command, daemon_active):
    view = [*DOCKER, "inspect", "--type", "container", "--format", APP_VIEW, APP]
    before = command(view) if daemon_active else None
    fields = (before or "").split("|")
    host = _socket(root / SOCKET)
    report = {"running": None, "expectedBindMount": None,
              "hostExpectedSocket": None if host is None else bool(host),
              "expectedSocketVisible": None, "sameHostSocket": None, "processSocketSetting": None}
    if len(fields) != 3 or fields[0] not in ("true", "false") or _number(fields[1]) is None:
        return report
    report["running"] = fields[0] == "true"
    report["expectedBindMount"] = {"": False, "directory": True, "socket": True,
                                   "directorysocket": True, "socketdirectory": True}.get(fields[2])
    if report["running"] and int(fields[1]) > 0:
        ns_root = root / "proc" / fields[1] / "root"
        remote = _socket(ns_root / SOCKET)
        # A stopped/restarted website may have released its original PID during the stat.
        if command(view) != before:
            report["running"] = report["expectedBindMount"] = None
        else:
            try:
                ns_root.stat()
            except OSError:
                return report
            report["expectedSocketVisible"] = None if remote is None else bool(remote)
            if remote is not None and host is not None:
                report["sameHostSocket"] = bool(remote and host and remote == host)
    return report


def summary(*, root=Path("/"), command=_command, machine=platform.machine, attempt_sha=None):
    root = Path(root)
    os_text = _text(root / "etc/os-release")
    if os_text is None:
        os_text = _text(root / "usr/lib/os-release")
    distro = re.search(r"""^ID=["']?([a-z0-9_-]+)["']?$""", os_text or "", re.M)
    version = re.search(r"""^VERSION_ID=["']?([0-9]{1,4})(?:\.[a-zA-Z0-9._-]+)?["']?$""", os_text or "", re.M)
    arch = machine()
    platform_info = {"family": FAMILY.get(distro[1]) if distro else None,
                     "majorVersion": int(version[1]) if version else None,
                     "architecture": arch if arch in ("aarch64", "x86_64", "armv7l", "i686", "ppc64le", "s390x", "riscv64") else None}
    meminfo = _text(root / "proc/meminfo") or ""
    memory = {}
    for key in MEMORY:
        match = re.search(r"^" + key + r":[ \t]*([0-9]{1,16}) kB$", meminfo, re.M)
        memory[key] = int(match[1]) * 1024 if match else None
    controller_file = root / "sys/fs/cgroup/cgroup.controllers"
    try:
        controllers = controller_file.read_text(encoding="ascii").split()
        unified = True
    except FileNotFoundError:
        controllers, unified = [], False
    except (OSError, UnicodeError):
        controllers, unified = [], None
    template = command(["systemctl", "--no-pager", "--no-legend", "--plain", "list-unit-files", UNIT])
    template_available = None
    if template == "":
        template_available = False
    elif template:
        fields = template.split()
        modes = {"enabled", "enabled-runtime", "disabled", "static", "indirect", "linked", "linked-runtime",
                 "alias", "generated", "transient", "masked", "masked-runtime", "bad"}
        if len(template.splitlines()) == 1 and len(fields) >= 2 and fields[0] == UNIT and fields[1] in modes:
            template_available = fields[1] not in ("masked", "masked-runtime", "bad")
    # An active docker.socket can start an inactive daemon on connection.
    daemon_state = command(["systemctl", "--no-pager", "show", "--property=ActiveState", "--value", "docker.service"])
    daemon_active = {"active": True, "inactive": False, "failed": False}.get(daemon_state)
    namespace_limit = _number(_text(root / "proc/sys/user/max_user_namespaces"))
    return {
        "sampledAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "observed": {
            "platform": platform_info, "hostMemoryBytes": memory,
            "cgroup": {"v2AtDefaultMount": unified, "memoryController": None if unified is None else "memory" in controllers},
            "userns": {
                "userNamespacesConfigured": None if namespace_limit is None else namespace_limit > 0,
                "unprivilegedUsernsCloneEnabled": {0: False, 1: True}.get(_number(_text(root / "proc/sys/kernel/unprivileged_userns_clone"))),
                "apparmorUsernsRestrictionEnabled": {0: False, 1: True}.get(_number(_text(root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns"))),
            },
            "packetFilterCommands": {name: shutil.which(name, path=SYSTEM_PATH) is not None for name in ("nft", "iptables")},
            "workspaceTools": {**_package_observation(root),
                               **({"failedReleasePackageState": _staged_packages(root, command, attempt_sha)}
                                  if attempt_sha else {})},
            "docker": _docker_info(command, daemon_active), "workerTemplateAvailable": template_available,
            "brokerStartup": _broker_startup(command),
            "website": _website(root, command, daemon_active),
        },
        "actualChecks": {name: "not-run" for name in
                         ("chromiumSandbox", "egressIsolation", "brokerConnection", "singleWorkspacePeakMemory")},
    }
