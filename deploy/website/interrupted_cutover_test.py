import stat
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import interrupted_cutover as recovery
from remote import ReleaseError


PREVIOUS = "a" * 40
TARGET = "b" * 40
NATIVE = {"id": "unchanged", "revision": PREVIOUS, "image": "sha256:" + "1" * 64}


class InterruptedCutoverTests(unittest.TestCase):
    def setUp(self):
        candidate = recovery.ROOT / "releases" / TARGET
        self.plan = {
            "sha": TARGET,
            "before": {"gatewaySha256": "current-gated-config"},
            "interruptedRelease": {
                "sha": PREVIOUS,
                "before": {"gatewaySha256": "original-ungated-config"},
                "native": NATIVE,
                "gateSha256": "reviewed-gate-program",
                "runtimeSources": dict.fromkeys(recovery.HELPER_FILES, "reviewed-source"),
            },
        }
        self.release = recovery.InterruptedCutover(self.plan, candidate / "source", candidate / "operations")

    def test_archive_allows_root_group_write_without_loosening_live_config(self):
        path = Mock()
        path.resolve.return_value = path
        path.lstat.return_value = SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFREG | 0o664)
        self.assertIs(recovery.trusted_file(path, archived=True), path)
        with self.assertRaisesRegex(ReleaseError, "interrupted_release_file_untrusted"):
            recovery.trusted_file(path)
        for mode, gid, uid in ((0o666, 0, 0), (0o664, 993, 0), (0o664, 0, 993)):
            path.lstat.return_value = SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFREG | mode)
            with self.subTest(mode=mode, gid=gid, uid=uid):
                with self.assertRaisesRegex(ReleaseError, "interrupted_archive_source_untrusted"):
                    recovery.trusted_file(path, archived=True)

    def test_distinguishes_gate_program_and_config_digests(self):
        self.assertEqual(self.release.gated_digest, "current-gated-config")
        self.assertEqual(self.release.gate_script_digest, "reviewed-gate-program")
        self.assertEqual(self.release.before["gatewaySha256"], "original-ungated-config")
        self.assertEqual(self.release.source, recovery.ROOT / "releases" / PREVIOUS / "source")

    def test_readonly_preflight_checks_original_runtime_without_requiring_candidate_files(self):
        preflight = recovery.InterruptedCutover(self.plan, None, None)
        with (
            patch.object(recovery, "require_main"),
            patch.object(recovery, "trusted_file", side_effect=lambda path, **options: path),
            patch.object(recovery, "digest", return_value="reviewed-source") as digest,
            patch.object(preflight, "require_native_unchanged", side_effect=ReleaseError("fixture_stop")),
        ):
            with self.assertRaisesRegex(ReleaseError, "fixture_stop"):
                preflight.prepare()
            self.assertEqual(digest.call_args_list, [call(preflight.source / name) for name in recovery.HELPER_FILES])
        with self.assertRaisesRegex(ReleaseError, "interrupted_release_candidate_not_staged"):
            with preflight.cutover():
                self.fail("preflight must not yield a cutover candidate")
        with self.assertRaisesRegex(ReleaseError, "interrupted_release_candidate_not_staged"):
            preflight.finish()
    def test_reuses_staged_worker_only_for_exact_source_change(self):
        old_source = recovery.ROOT / "releases" / ("c" * 40) / "source"
        approved_source = self.release.source
        base = f'#!/bin/bash\nexec docker run --mount "type=bind,src={old_source},dst=/app,readonly" worker\n'
        approved = base.replace(str(old_source), str(approved_source))
        self.assertTrue(recovery.staged_worker_matches(base, approved, approved_source))
        self.assertFalse(recovery.staged_worker_matches(base, approved.replace("readonly", "rw"), approved_source))
        self.assertFalse(recovery.staged_worker_matches(base, approved.replace(" worker", " other-image"), approved_source))

    def test_reuses_staged_worker_from_existing_revision_variable(self):
        older = "c" * 40
        base = (f"sha={older}\n" +
                'exec docker run --mount "type=bind,src=$root/releases/$sha/source,dst=/app,readonly" worker\n')
        self.assertTrue(recovery.staged_worker_matches(
            base, base.replace(f"sha={older}", f"sha={PREVIOUS}"), self.release.source))
        self.assertTrue(recovery.staged_worker_matches(
            base, base.replace("$root/releases/$sha/source", str(self.release.source)), self.release.source))
        with self.assertRaisesRegex(ReleaseError, "interrupted_worker_launcher_ambiguous"):
            recovery.staged_worker_matches(base + base, base, self.release.source)

    def test_refuses_native_launcher_replacement(self):
        stage = self.release.source / "deploy/recharge-core/run-recharge.py"
        command = ("{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 "
                   f"{stage} native {PREVIOUS} ; ignore_errors=no ; }}")
        with patch.object(recovery, "run", return_value=command.encode()):
            self.release.require_native_launcher()
        with patch.object(recovery, "run", return_value=command.replace(" native ", " adapter ").encode()):
            with self.assertRaisesRegex(ReleaseError, "interrupted_native_service_binding_mismatch"):
                self.release.require_native_launcher()

    def test_rejoin_yields_existing_native_with_no_service_operation(self):
        self.release.queue_before = (140, 10)
        with (
            patch.object(recovery, "require_main") as require_main,
            patch.object(self.release, "require_native_unchanged"),
            patch.object(self.release, "require_native_launcher"),
            patch.object(self.release, "require_paused"),
            patch.object(self.release, "require_worker_binding_unchanged"),
            patch.object(recovery, "read_idle_queue", return_value=self.release.queue_before),
            patch.object(recovery, "run") as run,
        ):
            with self.release.cutover() as current:
                self.assertEqual(current, NATIVE)
            require_main.assert_called_once_with(TARGET)
            run.assert_not_called()

    def test_does_not_resume_worker_on_changed_queue_or_expired_target(self):
        self.release.queue_before = (140, 10)
        calls = (
            ("new-main", ReleaseError("remote_main_changed"), self.release.queue_before),
            ("changed-queue", None, (141, 11)),
        )
        for label, freshness_failure, queue in calls:
            with (
                self.subTest(label=label),
                patch.object(recovery, "require_main", side_effect=freshness_failure),
                patch.object(self.release, "require_native_unchanged"),
                patch.object(self.release, "require_native_launcher"),
                patch.object(self.release, "require_paused"),
                patch.object(self.release, "require_worker_binding_unchanged"),
                patch.object(recovery, "read_idle_queue", return_value=queue),
                patch.object(recovery, "stopped") as stopped,
                patch.object(recovery.CoreRelease, "finish") as finish,
            ):
                with self.assertRaises(ReleaseError):
                    self.release.finish()
                stopped.assert_not_called()
                finish.assert_not_called()
