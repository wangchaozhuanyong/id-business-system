"""Run only as a service in the dedicated offline, booted Amazon Linux CI fixture."""

import ast
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import traceback
from types import SimpleNamespace
from unittest.mock import patch


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
import runtime


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


def broker_journal(config):
    # Print only fixed argparse reasons from this release. Never print journal lines or argv values.
    source = ast.parse((DESKTOP / "broker.py").read_text())
    known = {node.args[0].value for node in ast.walk(source) if isinstance(node, ast.Call)
             and isinstance(node.func, ast.Attribute) and node.func.attr == "error" and node.args
             and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)}
    records = run("/usr/bin/journalctl", "-b", "--no-pager", "-u", provision.BROKER_UNIT,
                  "-n", "60", "-o", "cat", check=False)
    errors = set()
    for line in records.stdout.splitlines():
        if ": error: " in line:
            reason = line.split(": error: ", 1)[1]
            errors.add(reason if reason in known else "other_argparse_error")
    print(json.dumps({"broker_argv_count": len(runtime.broker_arguments(config)) - 1,
                      "broker_cli_errors": sorted(errors), "journal_exit": records.returncode}))


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

    assert run("/usr/bin/rpm", "-q", "--qf", "%{NAME}", "dbus-broker").stdout == "dbus-broker"
    run(provision.SYSTEMCTL, "start", "dbus.socket", "dbus-broker.service")
    config = provision.release_config(SimpleNamespace(
        release_root=ROOT, assets=ROOT / "manual-runtime/novnc", site_packages=ROOT / "manual-runtime/site-packages",
        python="/usr/bin/python3", image_id="sha256:" + "1" * 64, max_active=1, min_available_mib=512,
        block_network=["203.0.113.1/32"]))
    try:
        # The guest has no Docker daemon/worker image. Only its pre-install host capability check is substituted.
        # The release installer writes all files, creates the user and directories, starts systemd and verifies Polkit.
        with patch.object(provision, "check_host") as preflight:
            assert provision.install(config) is True
            preflight.assert_called_once_with(config, available=False)
        for path, contents in provision.managed_files(config).items():
            assert provision.installed(path) == contents
        check_state("active", "enabled")
        for route, key in (("renewal", "renewalWorkspace"), ("recharge", "rechargeBootstrap")):
            status, body = provision.probe(provision.BRIDGE / "site.sock", f"/v1/{route}/status")
            assert status == 200 and json.loads(body) == {key: 1}, (route, status)
        print("actual_broker_unit=active actual_runtime=cp39 renewal=200 recharge=200 polkit_policy=passed")
    finally:
        broker_journal(config)

    # Check the active-worker guard without starting a business workspace or touching the installed template.
    instance = "id-manual-workspace@manual-v1-" + "f" * 64 + ".service"
    stage_unit(instance)
    run(provision.SYSTEMCTL, "daemon-reload")
    provision.require_no_workers()
    run(provision.SYSTEMCTL, "start", instance)
    try:
        provision.require_no_workers()
    except provision.InvalidHost as error:
        assert str(error) == "active_workspace_units_present"
    else:
        raise AssertionError("active_workspace_was_not_detected")
    run(provision.SYSTEMCTL, "stop", instance)
    provision.require_no_workers()
    run(provision.SYSTEMCTL, "stop", provision.BROKER_UNIT)
    check_state("inactive", "enabled")
    run(provision.SYSTEMCTL, "disable", provision.BROKER_UNIT)
    check_state("inactive", "disabled")
    print("worker_active_and_stopped=passed")
    Path("/fixture/systemd-first-install.passed").touch(exist_ok=False)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        Path("/fixture/systemd-first-install.error").write_text(traceback.format_exc()[-8192:])
        raise
