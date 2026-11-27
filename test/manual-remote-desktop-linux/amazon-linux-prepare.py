"""Exercise the real workspace RPM install twice in an offline AL2023 container."""

import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
from unittest.mock import patch


RELEASE = Path("/opt/id-business-independent/releases/" + "1" * 40)
DESKTOP = RELEASE / "source/deploy/manual-desktop"
RPMS = RELEASE / "manual-runtime/host-packages"
VERSION = "2023.12.20260817"
PACKAGE = "%{NAME}\\t%{ARCH}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\n"
sys.path.insert(0, str(DESKTOP / "host"))
import provision


def query(*args):
    return subprocess.check_output(["/usr/bin/rpm", *args], text=True).strip()


def inventory():
    return set(query("-qa", "--qf", PACKAGE).splitlines())


def main():
    active_interfaces = {dev.name for dev in Path("/sys/class/net").iterdir()
                         if int((dev / "flags").read_text(), 16) & 1}
    if (not Path("/.dockerenv").is_file() or os.geteuid() != 0 or platform.machine() != "x86_64"
            or active_interfaces != {"lo"}):
        raise RuntimeError("requires_isolated_x86_docker_without_network")
    if query("-q", "--qf", "%{VERSION}", "system-release") != VERSION:
        raise RuntimeError("wrong_amazon_linux_release")
    if Path(provision.PKCHECK).exists():
        raise RuntimeError("expected_initially_missing_pkcheck")
    manifest = DESKTOP / "host/polkit-rpms.json"
    files = sorted(RPMS.glob("*.rpm"))
    if not files or not manifest.is_file():
        raise RuntimeError("expected_staged_release_rpms")
    for path in (manifest, DESKTOP, RPMS, *files, *RPMS.parents, *manifest.parents):
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError("staging_path_not_root_controlled")

    before = inventory()
    shipped = set()
    for artifact in files:
        signed = subprocess.check_output(["/usr/bin/rpmkeys", "--checksig", str(artifact)], text=True)
        if not signed.strip().endswith("digests signatures OK"):
            raise RuntimeError("staged_rpm_signature_not_verified")
        shipped.add(query("-qp", "--qf", PACKAGE, str(artifact)))
    if not any(row.startswith("polkit\t") for row in shipped):
        raise RuntimeError("staged_rpms_missing_polkit")

    transactions = []
    signature_checks = []
    tools = []

    def observe(event, args):
        if event != "subprocess.Popen":
            return
        argv = args[1]
        tool = Path(argv[0]).name
        tools.append(tool)
        if tool == "rpmkeys" and "--checksig" in argv:
            signature_checks.append(Path(argv[-1]))
        if tool in {"dnf", "yum"}:
            raise RuntimeError("prepare_attempted_package_resolution")
        if tool == "rpm" and "--install" in argv:
            transactions.append("test" if "--test" in argv else "install")

    config = {"root": str(RELEASE), "desktop": str(DESKTOP)}
    sys.addaudithook(observe)
    # Only the systemd manager reload is unavailable in this non-booted container.
    with patch.object(provision, "systemctl", return_value=("", 0)) as reload:
        if provision.prepare_host_tools(config) is not True:
            raise RuntimeError("first_prepare_did_not_install")
        reload.assert_called_once_with("daemon-reload")
        if sorted(signature_checks) != files:
            raise RuntimeError("prepare_did_not_verify_every_rpm_signature")
        if transactions != ["test", "install"]:
            raise RuntimeError("expected_real_rpm_test_and_install")
        after = inventory()
        if not before < after or after - before != shipped - before:
            raise RuntimeError("installed_package_set_does_not_match_release")
        if query("-qf", "--qf", "%{NAME}", provision.PKCHECK) != "polkit" or not os.access(provision.PKCHECK, os.X_OK):
            raise RuntimeError("pkcheck_not_owned_by_installed_polkit")
        subprocess.run([provision.PKCHECK, "--version"], check=True)
        previous_calls = len(tools)
        if provision.prepare_host_tools(config) is not False or len(tools) != previous_calls:
            raise RuntimeError("repeat_prepare_started_a_process")
        if inventory() != after:
            raise RuntimeError("repeat_prepare_not_idempotent")
        reload.assert_called_once_with("daemon-reload")
        if transactions != ["test", "install"]:
            raise RuntimeError("repeat_prepare_started_an_rpm_transaction")
    print(f"offline_prepare=passed release={VERSION} signed_rpms={len(files)} newly_installed={len(after-before)} repeat=no-op")


if __name__ == "__main__":
    main()
