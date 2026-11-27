import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import manual_workspace_preflight as probe


class WorkspacePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.previous = Path.cwd()
        # UNIX socket paths are short on macOS. Keep all fixtures inside this project.
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, self.previous)
        self.root = Path(".")
        self.commands = []
        self.docker_info = "2|true|true|false|seccomp"
        self.daemon_state = "active"
        self.app_views = ["true|123|directory"]
        self.unit = probe.UNIT + " static -"
        self.broker_journal = None

    def write(self, path, value):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def command(self, args):
        self.commands.append(args)
        if args[0] == "/usr/bin/journalctl":
            self.assertIn("--unit=id-manual-broker.service", args)
            self.assertIn("--lines=1", args)
            return self.broker_journal
        if args == ["systemctl", "--no-pager", "--no-legend", "--plain", "list-unit-files", probe.UNIT]:
            return self.unit
        if args == ["systemctl", "--no-pager", "show", "--property=ActiveState", "--value", "docker.service"]:
            return self.daemon_state
        if args == [*probe.DOCKER, "info", "--format", probe.DOCKER_INFO]:
            return self.docker_info
        self.assertEqual(args, [*probe.DOCKER, "inspect", "--type", "container", "--format", probe.APP_VIEW, probe.APP])
        return self.app_views.pop(0) if len(self.app_views) > 1 else self.app_views[0]

    def inspect(self):
        with patch.object(probe.shutil, "which", side_effect=lambda name, path: "/bin/nft" if name == "nft" else None):
            return probe.summary(root=self.root, command=self.command, machine=lambda: "x86_64")

    def mount_socket(self):
        path = self.root / probe.SOCKET
        path.parent.mkdir(parents=True)
        with socket.socket(socket.AF_UNIX) as endpoint:
            endpoint.bind(str(path))
        namespace = self.root / "proc/123/root"
        namespace.parent.mkdir(parents=True)
        namespace.symlink_to(Path.cwd())

    def test_observes_fixed_host_capabilities_without_claiming_a_canary(self):
        self.write("etc/os-release", 'ID=debian\nVERSION_ID="13.2"\nPRETTY_NAME=synthetic-private\n')
        self.write("proc/sys/kernel/osrelease", "6.12.50-private-build\n")
        self.write("proc/meminfo", "MemTotal: 2048 kB\nMemAvailable: 1536 kB\nSwapTotal: 128 kB\nSwapFree: 32 kB\n")
        self.write("sys/fs/cgroup/cgroup.controllers", "cpu memory pids")
        self.write("proc/sys/user/max_user_namespaces", "31800\n")
        self.write("proc/sys/kernel/unprivileged_userns_clone", "1\n")
        self.mount_socket()
        result = self.inspect()
        observed = result["observed"]
        self.assertEqual(observed["platform"],
                         {"family": "debian", "majorVersion": 13, "architecture": "x86_64"})
        self.assertEqual(observed["hostMemoryBytes"], {"MemTotal": 2097152, "MemAvailable": 1572864,
                                                       "SwapTotal": 131072, "SwapFree": 32768})
        self.assertEqual(observed["userns"], {"userNamespacesConfigured": True, "unprivilegedUsernsCloneEnabled": True,
                                               "apparmorUsernsRestrictionEnabled": None})
        for raw in ("31800", "6.12.50", "13.2"):
            self.assertNotIn(raw, json.dumps(observed))
        self.assertEqual(observed["cgroup"], {"v2AtDefaultMount": True, "memoryController": True})
        self.assertEqual(observed["packetFilterCommands"], {"nft": True, "iptables": False})
        self.assertEqual(observed["docker"], {"daemonActive": True, "cgroupV2": True, "memoryLimit": True,
                                              "swapLimit": True, "pidsLimit": False, "seccompAdvertised": True})
        self.assertEqual(observed["workerTemplateAvailable"], True)
        self.assertEqual(observed["website"], {"running": True, "expectedBindMount": True, "hostExpectedSocket": True,
                                               "expectedSocketVisible": True, "sameHostSocket": True, "processSocketSetting": None})
        self.assertEqual(set(result["actualChecks"].values()), {"not-run"})
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("123", json.dumps(observed["website"]))
        self.assertTrue(all("Env" not in " ".join(argv) and "NetworkSettings" not in " ".join(argv)
                            and "exec" not in argv for argv in self.commands))

    def test_missing_files_malformed_responses_and_privilege_failures_are_unknown(self):
        self.docker_info = "unexpected-private-diagnostic"
        self.unit = "other.service disabled -"
        self.app_views = [None]
        self.write("proc/meminfo", "MemAvailable: broken\nSwapFree: -1 kB\n")
        result = self.inspect()
        obs = result["observed"]
        self.assertIsNone(obs["workerTemplateAvailable"])
        self.assertIsNone(obs["hostMemoryBytes"]["MemAvailable"])
        self.assertIsNone(obs["website"]["expectedBindMount"])
        self.assertFalse(obs["website"]["hostExpectedSocket"])
        self.assertTrue(all(value is None for key, value in obs["docker"].items() if key != "daemonActive"))
        self.assertNotIn("diagnostic", json.dumps(result))
        self.assertIs(obs["cgroup"]["v2AtDefaultMount"], False)
        for error in (OSError("private"), subprocess.TimeoutExpired("private", 4)):
            with patch.object(probe.subprocess, "run", side_effect=error):
                self.assertIsNone(probe._command(["systemctl", "--version"]))
        with patch.object(probe.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"private", b"private")):
            self.assertIsNone(probe._command(["systemctl", "--version"]))

    def test_workspace_package_log_reports_only_a_fixed_diagnostic(self):
        self.write("usr/bin/pkcheck", "fixture")
        (self.root / "usr/bin/pkcheck").chmod(0o755)
        self.write("var/log/dnf.log", "\nDEBUG Command: dnf install polkit --destdir=/private/workspace-dependencies-example\n"
                   "ERROR Failed to download metadata for repo fixture-private\n")
        details = self.inspect()["observed"]["workspaceTools"]
        self.assertTrue(details["executables"]["pkcheck"])
        self.assertEqual(details["packageDownload"], "repository_access")
        self.assertNotIn("private", json.dumps(details))

    def test_broker_startup_reports_only_a_known_argument_error(self):
        self.broker_journal = "broker.py: error: Invalid recharge input directory or blocked network"
        self.assertEqual(self.inspect()["observed"]["brokerStartupError"], "invalid_input_directory_or_network")
        self.broker_journal += " with a private detail"
        self.assertIsNone(self.inspect()["observed"]["brokerStartupError"])
        self.broker_journal = ("/usr/bin/python3: can't open file '/private/deploy/manual-desktop/host/runtime.py': "
                               "[Errno 13] Permission denied")
        self.assertEqual(self.inspect()["observed"]["brokerStartupError"], "runtime_file_permission_denied")

    def test_broker_release_access_probes_run_as_the_broker_identity(self):
        self.write("usr/bin/setpriv", "fixture")
        (self.root / "usr/bin/setpriv").chmod(0o755)

        def access(args):
            self.assertEqual(args[:5], ["/usr/bin/setpriv", "--reuid=10001", "--regid=10001",
                                       "--clear-groups", "/usr/bin/test"])
            return "" if args[5] == "-x" else None

        result = probe._broker_release_access(self.root, access, "f" * 40)
        self.assertTrue(result["releaseParent"])
        self.assertTrue(result["runtimePython"])
        self.assertFalse(result["brokerLauncher"])
        self.assertFalse(result["brokerCode"])

    def test_stopped_app_stale_socket_and_pid_reuse_do_not_prove_configuration(self):
        self.unit = ""
        self.docker_info = "1|false|false|true|"
        self.app_views = ["false|0|"]
        observed = self.inspect()["observed"]
        self.assertEqual(observed["workerTemplateAvailable"], False)
        self.assertEqual(observed["website"]["expectedBindMount"], False)
        self.assertIsNone(observed["website"]["expectedSocketVisible"])
        self.assertFalse(observed["docker"]["seccompAdvertised"])
        self.mount_socket()
        self.app_views = ["true|123|directory", "true|456|directory"]
        stale = self.inspect()["observed"]["website"]
        for key in ("running", "expectedBindMount", "expectedSocketVisible", "sameHostSocket", "processSocketSetting"):
            self.assertIsNone(stale[key])
        path = self.root / probe.SOCKET
        path.unlink()
        path.symlink_to("elsewhere")
        self.app_views = ["true|123|directory"]
        website = self.inspect()["observed"]["website"]
        self.assertFalse(website["expectedSocketVisible"])
        self.assertFalse(website["sameHostSocket"])

    def test_inactive_or_unknown_daemon_is_not_contacted(self):
        for state, expected in (("inactive", False), (None, None), ("activating", None)):
            self.commands.clear()
            self.daemon_state = state
            observed = self.inspect()["observed"]
            self.assertIs(observed["docker"]["daemonActive"], expected)
            self.assertIsNone(observed["website"]["running"])
            self.assertFalse(any(args[0] == "docker" for args in self.commands))


if __name__ == "__main__":
    unittest.main()
