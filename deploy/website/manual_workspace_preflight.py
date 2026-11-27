"""Read-only host observations for the manual browser workspace. No canary is started."""
import datetime
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
    try:
        proc = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              env={"PATH": SYSTEM_PATH, "LC_ALL": "C"}, timeout=4, check=False)
        if proc.returncode == 0 and len(proc.stdout) <= 512:
            return proc.stdout.decode("ascii").strip()
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


def summary(*, root=Path("/"), command=_command, machine=platform.machine):
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
            "docker": _docker_info(command, daemon_active), "workerTemplateAvailable": template_available,
            "website": _website(root, command, daemon_active),
        },
        "actualChecks": {name: "not-run" for name in
                         ("chromiumSandbox", "egressIsolation", "brokerConnection", "singleWorkspacePeakMemory")},
    }
