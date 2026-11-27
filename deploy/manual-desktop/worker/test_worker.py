import os
from contextlib import contextmanager
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import worker


@contextmanager
def fixture_directory():
    previous = Path.cwd()
    with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as root:
        os.chdir(root)
        try:
            yield
        finally:
            os.chdir(previous)


class WorkerTest(unittest.TestCase):
    def test_runtime_requires_private_mounts_and_restricted_identity(self):
        mounts = "\n".join(
            f"1 0 2:3 / {path} {options} - {fs} source rw"
            for path, options, fs in (
                ("/", "ro", "overlay"), ("/profile", "rw", "ext4"),
                ("/run/workspace", "rw", "tmpfs"), ("/tmp", "rw", "tmpfs"),
            )
        )
        status = "CapEff: 0\nCapBnd: 0\nNoNewPrivs: 1\nSeccomp: 2"
        with patch.object(os, "getuid", return_value=10001), patch.object(os, "getgid", return_value=10001):
            worker.check_container(mounts, status)
            with patch.object(os, "getpid", return_value=1), self.assertRaisesRegex(RuntimeError, "tini"):
                worker.check_container(mounts, status)
            for altered in (mounts.replace(" / ro", " / rw"), mounts.replace("/profile", "/fake"),
                            mounts.replace("/tmp rw - tmpfs", "/tmp rw - ext4")):
                with self.subTest(mounts=altered), self.assertRaises(RuntimeError):
                    worker.check_container(altered, status)
            for before, after in (("NoNewPrivs: 1", "NoNewPrivs: 0"), ("Seccomp: 2", "Seccomp: 0"),
                                  ("CapEff: 0", "CapEff: 1"), ("CapBnd: 0", "CapBnd: 1")):
                with self.subTest(before=before), self.assertRaises(RuntimeError):
                    worker.check_container(mounts, status.replace(before, after))

    def test_directory_lock_excludes_duplicate_and_rejects_shared_or_redirected_mount(self):
        with fixture_directory():
            profile = Path("profile")
            profile.mkdir(mode=0o700)
            first = worker.lock_directory(profile)
            try:
                with self.assertRaises(BlockingIOError):
                    worker.lock_directory(profile)
            finally:
                os.close(first)
            os.close(worker.lock_directory(profile))
            Path("link").symlink_to(profile, target_is_directory=True)
            with self.assertRaises(OSError):
                worker.lock_directory(Path("link"))
            profile.chmod(0o755)
            with self.assertRaises(RuntimeError):
                worker.lock_directory(profile)

    def test_socket_recovery_preserves_unrelated_files(self):
        with fixture_directory():
            path = Path("rfb.sock")
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(path))
            worker.remove_owned_socket(path)
            self.assertFalse(path.exists())
            path.write_text("keep")
            link = Path("link")
            link.symlink_to(path)
            for entry in (path, link):
                with self.assertRaises(RuntimeError):
                    worker.remove_owned_socket(entry)
            self.assertEqual(path.read_text(), "keep")
            self.assertTrue(link.is_symlink())

    def test_first_visit_opens_the_site_and_reopens_leave_chromium_to_restore_tabs(self):
        with fixture_directory(), patch.object(worker, "PROFILE", Path(".")):
            self.assertEqual([arg for arg in worker.browser_command() if arg.startswith("http")], ["https://chatgpt.com/"])
            Path("Local State").touch()
            self.assertFalse(any(arg.startswith("http") for arg in worker.browser_command()))

    def test_gui_listens_only_on_private_unix_socket_and_disables_clipboard(self):
        args = worker.display_command(Path("rfb.sock"))
        for flag, value in (("-rfbport", "-1"), ("-rfbunixmode", "0600"), ("-nolisten", "tcp"),
                            ("-rfbunixpath", "rfb.sock"), ("-MaxDisconnectionTime", "0")):
            self.assertEqual(args[args.index(flag) + 1], value)
        for flag in ("-AcceptCutText=0", "-SendCutText=0", "-SendPrimary=0", "-SetPrimary=0",
                     "-AllowOverride="):
            self.assertIn(flag, args)
        browser = worker.browser_command()
        self.assertIn("--restore-last-session", browser)
        self.assertIn("--user-data-dir=/profile", browser)
        self.assertFalse(any(arg.startswith(("--no-sandbox", "--disable-setuid-sandbox",
                                             "--remote-debugging", "--proxy")) for arg in browser))

    def test_disconnect_reconnect_and_orderly_stop_without_exposing_child_environment(self):
        events = []
        with fixture_directory(), socket.socket(socket.AF_UNIX) as server:
            pending, published = Path(".starting.sock"), Path("rfb.sock")

            def start_child(args, **kwargs):
                binary = Path(args[0]).name
                self.assertNotIn("HOST_PRIVATE_FIXTURE", kwargs["env"])
                process = Mock()
                process.poll.return_value = None
                process.send_signal.side_effect = lambda sig: events.append((binary, sig))
                if binary == "Xtigervnc":
                    server.bind(str(pending))
                    pending.chmod(0o600)
                    server.listen()
                return process

            def run_command(args, **kwargs):
                if args[0].endswith("xprop"):
                    self.assertFalse(published.exists())
                    if args[-1] == "WM_CLASS":
                        props = b'WM_CLASS(STRING) = "chromium-browser (/profile)", "Chromium-browser"\n'
                        return subprocess.CompletedProcess(args, 0, props, b"")
                    return subprocess.CompletedProcess(args, 0, b"window id # 0x400001", b"")
                return subprocess.CompletedProcess(args, 0)

            def reconnect_and_stop(_seconds):
                for _ in range(2):
                    with socket.socket(socket.AF_UNIX) as client:
                        client.connect(str(published))
                        connection, _ = server.accept()
                        connection.close()
                    self.assertEqual(events, [])
                signal.raise_signal(signal.SIGTERM)

            with (patch.object(worker, "SOCKET", published), patch.object(worker, "STAGING_SOCKET", pending),
                  patch.dict(os.environ, HOST_PRIVATE_FIXTURE="synthetic"),
                  patch.object(subprocess, "Popen", side_effect=start_child),
                  patch.object(subprocess, "run", side_effect=run_command),
                  patch.object(worker.time, "sleep", side_effect=reconnect_and_stop)):
                worker.run_desktop(Path("."))
            self.assertFalse(published.exists())
            self.assertEqual(events, [("chromium", signal.SIGINT), ("matchbox-window-manager", signal.SIGTERM),
                                      ("Xtigervnc", signal.SIGTERM)])


if __name__ == "__main__":
    unittest.main()
