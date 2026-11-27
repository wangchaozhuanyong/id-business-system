"""Host contract tests. All service-manager and Docker calls are mocked."""

from contextlib import ExitStack, nullcontext
import os
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import call, patch

import provision
import runtime

KEY = "manual-v1-" + "a" * 64
INVOCATION = "3" * 32
RELEASE = Path("/opt/id-business-independent/releases") / ("1" * 40)
DESKTOP = RELEASE / "source/deploy/manual-desktop"
CONFIG = {
    "root": str(RELEASE), "desktop": str(DESKTOP), "python": "/usr/bin/python3.9",
    "image": "sha256:" + "a" * 64, "assets": str(RELEASE / "manual-runtime/novnc"),
    "site_packages": str(RELEASE / "manual-runtime/site-packages"),
    "max_active": 1, "min_available_mib": 640, "block_networks": ["203.0.113.10/32"],
}


class HostDependency(unittest.TestCase):
    def test_existing_polkit_needs_no_package_changes(self):
        with patch.object(provision.os, "access", return_value=True), patch.object(provision, "command") as command:
            self.assertFalse(provision.prepare_host_tools(CONFIG))
            command.assert_not_called()

    def test_downloaded_packages_are_verified_before_an_install_only_transaction(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent, prefix=".test-") as staging:
            package = Path(staging) / "polkit-x86_64.rpm"
            package.touch()
            for installed, signature, failure in (
                    (1, "digests signatures OK", None),
                    (0, "digests signatures OK", "manual_host_dependency_would_upgrade_existing_package"),
                    (1, "digests OK", "manual_host_dependency_signature_invalid")):
                with self.subTest(installed=installed, signature=signature):
                    def system(args, **options):
                        if args[:2] == [provision.RPM_KEYS, "--checksig"]:
                            return f"package: {signature}", 0
                        if args[:2] == [provision.RPM, "-qp"]:
                            return "polkit", 0
                        if args[:2] == [provision.RPM, "-q"]:
                            return "", installed
                        return "", 0

                    with patch.object(provision.os, "access", side_effect=[False, True]), \
                         patch.object(Path, "read_text", return_value='ID="amzn"\nVERSION_ID="2023"\n'), \
                         patch.object(provision, "release_path", side_effect=lambda path, _: path), \
                         patch.object(provision.tempfile, "mkdtemp", return_value=staging), \
                         patch.object(provision, "command", side_effect=system) as command, \
                         patch.object(provision, "systemctl") as systemctl:
                        if failure:
                            with self.assertRaisesRegex(runtime.InvalidHost, failure):
                                provision.prepare_host_tools(CONFIG)
                            self.assertFalse(any(call.args[0][1] == "--install" for call in command.call_args_list))
                            systemctl.assert_not_called()
                        else:
                            self.assertTrue(provision.prepare_host_tools(CONFIG))
                            self.assertEqual(command.call_args_list[-2:], [
                                call([provision.RPM, "--install", "--test", str(package)], timeout=20),
                                call([provision.RPM, "--install", str(package)], timeout=35),
                            ])
                            systemctl.assert_called_once_with("daemon-reload")


class WorkerContract(unittest.TestCase):
    def test_worker_pins_image_and_has_only_its_own_mounts(self):
        with patch.object(runtime, "release_path", side_effect=lambda path, _: path):
            command = runtime.worker_command(KEY, INVOCATION, CONFIG, runtime.PROFILES / KEY, runtime.WORKERS / KEY,
                                             runtime.INPUTS / KEY)
        options = dict(zip(command, command[1:]))
        self.assertEqual(options["--network"], "none")
        self.assertEqual(options["--ipc"], "private")
        self.assertEqual(options["--cgroupns"], "private")
        self.assertEqual(options["--user"], "10001:10001")
        self.assertEqual(options["--cap-drop"], "ALL")
        self.assertEqual(options["--memory"], "512m")
        self.assertEqual(options["--memory-swap"], "512m")
        self.assertIn("--read-only", command)
        self.assertIn("--pull=never", command)
        self.assertIn("no-new-privileges=true", command)
        self.assertIn(f"seccomp={DESKTOP}/chromium-seccomp.json", command)
        self.assertNotIn("--privileged", command)
        self.assertNotIn("--pid", command)
        self.assertEqual(command[-1], CONFIG["image"])
        self.assertEqual([next_arg for arg, next_arg in zip(command, command[1:]) if arg == "--mount"], [
            f"type=bind,src={runtime.PROFILES / KEY},dst=/profile,bind-propagation=rprivate",
            f"type=bind,src={runtime.WORKERS / KEY},dst=/run/workspace,bind-propagation=rprivate",
            f"type=bind,src={runtime.INPUTS / KEY},dst=/run/workspace-input,readonly,bind-propagation=rprivate",
        ])

    def test_rejects_noncanonical_keys_before_directory_access(self):
        with patch.object(runtime, "checked_path") as check:
            for key in ("", "../" + KEY, KEY.upper(), KEY + "\n", KEY + "/other", "-" + KEY):
                with self.subTest(key=key), self.assertRaisesRegex(runtime.InvalidHost, "invalid_workspace_key"):
                    runtime.run_worker(CONFIG, key)
            check.assert_not_called()

    def test_refuses_to_launch_without_broker_socket_preparation(self):
        with patch.dict(os.environ, {"INVOCATION_ID": INVOCATION}), \
             patch.object(runtime, "prepared_input", side_effect=FileNotFoundError), \
             patch.object(runtime, "ensure_directory") as create, \
             patch.object(runtime.os, "execve") as execute:
            with self.assertRaises(FileNotFoundError):
                runtime.run_worker(CONFIG, KEY)
            create.assert_not_called()
            execute.assert_not_called()

    def test_input_permission_and_symlink_validation(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent, prefix=".test-") as testdir, \
             patch.object(runtime, "UID", os.getuid()), patch.object(runtime, "GID", os.getgid()):
            root = Path(testdir).resolve()
            path = root / KEY
            path.mkdir(mode=0o710)
            path.chmod(0o710)
            with patch.object(runtime, "INPUTS", root), self.assertRaises(FileNotFoundError):
                # Missing bootstrap must be rejected before touching egress or launching the worker.
                runtime.prepared_input(KEY)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as bootstrap, \
                 socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as egress:
                # Bind short basenames because AF_UNIX imposes a pathname length limit.
                existing = Path.cwd()
                try:
                    os.chdir(path)
                    bootstrap.bind("bootstrap.sock")
                    egress.bind("egress.sock")
                finally:
                    os.chdir(existing)
                (path / "bootstrap.sock").chmod(0o660)
                (path / "egress.sock").chmod(0o600)
                with patch.object(runtime, "INPUTS", root):
                    self.assertEqual(runtime.prepared_input(KEY), path)
                    (path / "bootstrap.sock").unlink()
                    (path / "bootstrap.sock").symlink_to(path / "egress.sock")
                    with self.assertRaisesRegex(runtime.InvalidHost, "invalid_host_path_permissions"):
                        runtime.prepared_input(KEY)

    def test_existing_profile_permissions_checked_without_changing_data(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent, prefix=".test-") as temp:
            profile = Path(temp).resolve() / "profile"
            profile.mkdir(mode=0o700)
            (profile / "Local State").write_text("saved")
            self.assertEqual(runtime.ensure_directory(profile, os.getuid(), os.getgid(), 0o700), profile)
            profile.chmod(0o750)
            with self.assertRaises(runtime.InvalidHost):
                runtime.ensure_directory(profile, os.getuid(), os.getgid(), 0o700)
            self.assertEqual((profile / "Local State").read_text(), "saved")
            self.assertEqual(stat.S_IMODE(profile.stat().st_mode), 0o750)

    def test_stop_uses_exact_container_id_and_rejects_a_name_collision(self):
        identifier = "f" * 64
        with patch.dict(os.environ, {"INVOCATION_ID": INVOCATION}), patch.object(runtime, "command") as command:
            command.return_value = (identifier + "|" + "4" * 32, 0)
            with self.assertRaisesRegex(runtime.InvalidHost, "ownership_mismatch"):
                runtime.stop_worker(KEY)
            command.assert_called_once()
            command.reset_mock()
            command.side_effect = [(identifier + "|" + INVOCATION, 0), ("", 0)]
            runtime.stop_worker(KEY)
            command.assert_has_calls([call([*runtime.DOCKER, "stop", "--time", "25", identifier], timeout=27)])

    def test_rejects_an_unsafe_memory_threshold_or_excess_concurrency(self):
        with patch.object(runtime, "memory_mib", return_value=(2048, 663)):
            runtime.validate_capacity(CONFIG)
            for updated, error in (
                ({"min_available_mib": 511}, "invalid_workspace_capacity"),
                ({"max_active": 4}, "workspace_capacity_exceeds_host_memory"),
                ({"min_available_mib": 664}, "insufficient_available_memory"),
            ):
                with self.subTest(updated=updated), self.assertRaisesRegex(runtime.InvalidHost, error):
                    runtime.validate_capacity(dict(CONFIG, **updated))


class ProvisionContract(unittest.TestCase):
    def test_broker_unit_contract(self):
        files = provision.managed_files(CONFIG)
        broker = files[provision.UNIT_DIR / runtime.BROKER_UNIT]
        worker = files[provision.UNIT_DIR / runtime.WORKER_UNIT]
        inputs = files[provision.TMPFILES_FILE]
        self.assertIn("User=id-manual-desktop\nGroup=id-manual-desktop\n", broker)
        self.assertIn("NoNewPrivileges=yes\n", broker)
        self.assertIn("CapabilityBoundingSet=\n", broker)
        self.assertIn(f"InaccessiblePaths={runtime.PROFILES}\n", broker)
        self.assertIn("PartOf=id-manual-broker.service\n", worker)
        self.assertIn(f"d {runtime.BRIDGE} 0750 10001 10001 -\n", inputs)
        self.assertIn(f"d {runtime.INPUTS} 0700 10001 10001 -\n", inputs)
        arguments = runtime.broker_arguments(CONFIG)
        for option, expected in {
            "--socket": str(runtime.BRIDGE / "site.sock"), "--workers": str(runtime.WORKERS),
            "--claims": str(runtime.CLAIMS), "--assets": CONFIG["assets"], "--recharge-input": str(runtime.INPUTS),
            "--max-active": "1", "--min-available-mib": "640", "--recharge-block-network": "203.0.113.10/32",
        }.items():
            self.assertEqual(arguments[arguments.index(option) + 1], expected)
        self.assertIn("--start-units", arguments)

    def test_matching_active_release_is_not_restarted_and_another_is_refused(self):
        files = provision.managed_files(CONFIG)
        with patch.object(provision, "exclusive_install", side_effect=nullcontext), \
             patch.object(provision, "check_host"), patch.object(provision, "broker_active", return_value=True), \
             patch.object(provision, "installed", side_effect=files.__getitem__), \
             patch.object(provision, "verify") as verify, patch.object(provision, "systemctl") as systemctl:
            self.assertFalse(provision.install(CONFIG))
            verify.assert_called_once_with(CONFIG)
            with self.assertRaisesRegex(runtime.InvalidHost, "different_broker_release_active"):
                provision.install(dict(CONFIG, min_available_mib=672))
            systemctl.assert_not_called()

    def test_new_release_reverts_files_after_a_failed_readiness_probe(self):
        files = provision.managed_files(CONFIG)
        with ExitStack() as stack:
            for name, kwargs in {
                "exclusive_install": {"side_effect": nullcontext},
                "check_host": {},
                "validate_capacity": {},
                "verify_loaded_units": {},
                "broker_active": {"return_value": False},
                "require_no_workers": {},
                "existing_identity": {},
                "checked_path": {"side_effect": FileNotFoundError},
                "ensure_directory": {},
                "installed": {"return_value": None},
                "command": {},
                "verify": {"side_effect": runtime.InvalidHost("fixture_readiness_failure")},
            }.items():
                stack.enter_context(patch.object(provision, name, **kwargs))
            # The service fixture has already created its socket before the readiness check.
            stack.enter_context(patch.object(Path, "is_socket", return_value=True))
            systemctl = stack.enter_context(patch.object(provision, "systemctl", return_value=("not-found", 1)))
            write = stack.enter_context(patch.object(provision, "write_atomic"))
            with self.assertRaisesRegex(runtime.InvalidHost, "fixture_readiness_failure"):
                provision.install(CONFIG)
            self.assertEqual(write.call_args_list, [
                *(call(path, data) for path, data in files.items()),
                *(call(path, None) for path in reversed(files)),
            ])
            self.assertIn(call("stop", runtime.BROKER_UNIT), systemctl.call_args_list)
            self.assertNotIn(call("enable", runtime.BROKER_UNIT), systemctl.call_args_list)

    def test_rollback_only_deactivates_the_exact_broker_without_active_workers(self):
        files = provision.managed_files(CONFIG)
        with patch.object(provision, "exclusive_install", side_effect=nullcontext), \
             patch.object(provision, "installed", side_effect=files.__getitem__), \
             patch.object(provision, "broker_active", return_value=False), \
             patch.object(provision, "verify_loaded_units"), \
             patch.object(provision, "require_no_workers") as idle, \
             patch.object(provision, "write_atomic") as write, patch.object(provision, "systemctl") as systemctl:
            provision.deactivate(CONFIG)
            idle.assert_called_once_with()
            systemctl.assert_called_once_with("disable", "--now", runtime.BROKER_UNIT)
            write.assert_not_called()
            systemctl.reset_mock()
            with self.assertRaisesRegex(runtime.InvalidHost, "installed_manual_runtime_differs"):
                provision.deactivate(dict(CONFIG, min_available_mib=672))
            systemctl.assert_not_called()


if __name__ == "__main__":
    unittest.main()
