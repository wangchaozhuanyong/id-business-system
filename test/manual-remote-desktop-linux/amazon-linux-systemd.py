"""Run only as a service in the dedicated offline, booted Amazon Linux CI fixture."""

import json
import os
from pathlib import Path
import platform
import subprocess
import sys


ROOT = Path("/opt/id-business-independent/releases/" + "1" * 40)
DESKTOP = ROOT / "source/deploy/manual-desktop"
UNIT_DIR = Path("/etc/systemd/system")
FIXTURE_UNIT = """[Unit]
Description=Disposable first-install test service
[Service]
Type=oneshot
ExecStart=/usr/bin/true
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
"""
sys.path.insert(0, str(DESKTOP / "host"))
import provision


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=12,
                          env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})


def raw_absence():
    # Record the literal 252 outputs/exit codes for these three fixed queries only.
    records = []
    for args in (("list-unit-files", "--no-legend", "--no-pager", provision.BROKER_UNIT),
                 ("show", provision.BROKER_UNIT, "-p", "ActiveState", "-p", "LoadState"),
                 ("is-enabled", provision.BROKER_UNIT)):
        result = run(provision.SYSTEMCTL, *args, check=False)
        records.append({"absent_query": args[0], "exit": result.returncode,
                        "stdout": result.stdout.strip(), "stderr": result.stderr.strip()})
    Path("/fixture/missing-unit-results.json").write_text(json.dumps(records) + "\n")


def stage_unit(name):
    with (UNIT_DIR / name).open("x") as output:
        output.write(FIXTURE_UNIT)


def check_state(expected_state, expected_enablement):
    actual_state = provision.broker_state()
    assert actual_state == ("inactive" if expected_state == "absent" else expected_state), expected_state
    assert provision.broker_active() == (expected_state == "active"), expected_state
    # Use the same systemctl wrapper and accepted exit codes as the provisioner.
    value, code = provision.systemctl("is-enabled", provision.BROKER_UNIT, allowed=(0, 1, 3, 4))
    if expected_state == "absent":
        assert value in ("not-found", "") and code in (1, 3, 4), (value, code)
    else:
        assert (value, code) == (expected_enablement, 0 if expected_enablement == "enabled" else 1)
    print(f"fixture={expected_state} broker_state={actual_state} is_enabled={value!r} exit={code}")


def main():
    assert os.geteuid() == 0 and platform.machine() == "x86_64"
    assert Path("/proc/1/comm").read_text().strip() == "systemd"
    assert run("/usr/bin/systemd-detect-virt", "--container").stdout.strip() == "systemd-nspawn"
    assert os.uname().nodename == "manual-first-install"
    assert run("/usr/bin/rpm", "-q", "--qf", "%{VERSION}", "system-release").stdout == "2023.12.20260817"
    assert {dev.name for dev in Path("/sys/class/net").iterdir()
            if int((dev / "flags").read_text(), 16) & 1} == {"lo"}
    assert not Path("/var/run/docker.sock").exists()
    assert not (UNIT_DIR / provision.BROKER_UNIT).exists()
    print(run(provision.SYSTEMCTL, "--version").stdout.splitlines()[0])

    # The installer checks for a known installed/running unit as its positive control.
    # This isolated guest supplies the unit name, without running a Docker engine.
    stage_unit("docker.service")
    run(provision.SYSTEMCTL, "daemon-reload")
    run(provision.SYSTEMCTL, "start", "docker.service")
    assert run(provision.SYSTEMCTL, "is-active", "docker.service").stdout.strip() == "active"

    raw_absence()
    check_state("absent", "not-found")
    provision.require_no_workers()

    assert provision.prepare_host_tools({"root": str(ROOT), "desktop": str(DESKTOP)}) is True
    assert run(provision.SYSTEMCTL, "show", "polkit.service", "-p", "LoadState", "--value").stdout.strip() == "loaded"
    assert run("/usr/bin/rpm", "-qf", "--qf", "%{NAME}", provision.PKCHECK).stdout == "polkit"
    assert provision.prepare_host_tools({"root": str(ROOT), "desktop": str(DESKTOP)}) is False
    print("polkit=loaded real_daemon_reload=passed")

    stage_unit(provision.BROKER_UNIT)
    stage_unit(provision.WORKER_UNIT)
    run(provision.SYSTEMCTL, "daemon-reload")
    # With the actual manager and newly loaded template, the same unprivileged broker must report ready.
    subprocess.run(["/usr/bin/python3", "-IBu", "/fixture/broker-check.py", "--with-systemd"],
                   user=10001, group=10001, extra_groups=[], check=True, timeout=25)
    check_state("inactive", "disabled")
    run(provision.SYSTEMCTL, "enable", "--now", provision.BROKER_UNIT)
    check_state("active", "enabled")
    provision.require_no_workers()
    run(provision.SYSTEMCTL, "start", provision.PROBE_UNIT)
    try:
        provision.require_no_workers()
    except provision.InvalidHost as error:
        assert str(error) == "active_workspace_units_present"
    else:
        raise AssertionError("active_workspace_was_not_detected")
    run(provision.SYSTEMCTL, "stop", provision.PROBE_UNIT)
    provision.require_no_workers()
    run(provision.SYSTEMCTL, "stop", provision.BROKER_UNIT)
    check_state("inactive", "enabled")
    print("worker_active_and_stopped=passed")
    Path("/fixture/systemd-first-install.passed").touch(exist_ok=False)


if __name__ == "__main__":
    main()
