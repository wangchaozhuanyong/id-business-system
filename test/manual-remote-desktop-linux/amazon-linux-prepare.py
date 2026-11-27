"""Exercise the release's actual AL2023 package transaction in a disposable base container."""

import os
from pathlib import Path
import platform
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, "/fixture/host")
import provision


def package_step(argv):
    if argv[0] == provision.DNF:
        return "dnf_download"
    if argv[0] == provision.RPM_KEYS:
        return "rpm_signature"
    if argv[0] == provision.RPM:
        if "--test" in argv:
            return "rpm_install_test"
        if "--install" in argv:
            return "rpm_install"
        return "rpm_package_query"
    return None


def main():
    if (not Path("/.dockerenv").is_file() or platform.machine() != "x86_64" or os.geteuid() != 0
            or Path("/proc/1/comm").read_text().strip() == "systemd"):
        raise RuntimeError("requires_disposable_x86_container")
    release = Path("/etc/os-release").read_text().splitlines()
    if 'ID="amzn"' not in release or 'VERSION_ID="2023"' not in release:
        raise RuntimeError("requires_amazon_linux_2023")

    # The ordinary AL2023 image ships the full AMI DNF backend, but the booted
    # release host already has systemd. Recreate that package baseline only.
    subprocess.run([provision.RPM, "-q", "dnf", "python3-dnf"], check=True)
    subprocess.run([provision.DNF, "-qy", "--disablerepo=*", "--enablerepo=amazonlinux",
                    "--setopt=gpgcheck=1", "--setopt=install_weak_deps=False", "install", "systemd"], check=True)
    if os.path.exists(provision.PKCHECK):
        raise RuntimeError("fixture_requires_initially_absent_pkcheck")

    steps = []

    def observe(event, args):
        if event == "subprocess.Popen":
            step = package_step(args[1])
            if step:
                steps.append(step)

    sys.addaudithook(observe)
    with TemporaryDirectory(dir="/opt", prefix="manual-prepare-") as root:
        artifacts = Path(root, "artifacts")
        artifacts.mkdir(mode=0o700)
        with patch.object(provision, "systemctl") as reload:
            try:
                if provision.prepare_host_tools({"root": root}) is not True:
                    raise RuntimeError("first_prepare_did_not_install")
            except Exception:
                print("last_package_step=" + (steps[-1] if steps else "none"), flush=True)
                print("downloaded_rpms=" + str(len(list(artifacts.glob("workspace-dependencies-*/*.rpm")))), flush=True)
                raise
            reload.assert_called_once()
            if reload.call_args.args[-1] != "daemon-reload":
                raise RuntimeError("unexpected_systemd_operation")
            previous = len(steps)
            if provision.prepare_host_tools({"root": root}) is not False or len(steps) != previous:
                raise RuntimeError("repeated_prepare_was_not_idempotent")
            reload.assert_called_once()

    if not {"dnf_download", "rpm_signature", "rpm_install_test", "rpm_install"}.issubset(steps):
        raise RuntimeError("missing_real_package_transaction")
    owner = subprocess.check_output([provision.RPM, "-qf", "--qf", "%{NAME}", provision.PKCHECK], text=True)
    if owner != "polkit" or not os.access(provision.PKCHECK, os.X_OK):
        raise RuntimeError("installed_pkcheck_owner_mismatch")
    subprocess.run([provision.PKCHECK, "--version"], check=True)
    print("amazon_linux_prepare=passed verified_rpms=" + str(steps.count("rpm_signature")), flush=True)


if __name__ == "__main__":
    main()
