import base64
import hashlib
import json
import os
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryFile
from unittest.mock import Mock, patch

import remote


REVISION = "a" * 40
CAPTURED = "20261119T050005Z"
PREFIX = f"mysql/daily/independent-recharge/{CAPTURED}/{REVISION}/"
KEY = PREFIX + "manifest.json"
PRIVATE = "synthetic-private-do-not-return"


class BackupHistoryTests(unittest.TestCase):
    def fixture(self, **changes):
        return {"capturedAt": CAPTURED, "revision": REVISION, "recoveryStateError": "capture_failed",
                "recoveryStateFailureStage": "source", "wrappedKey": PRIVATE, **changes}

    def read_fixture(self, body=None, metadata_changes=None, listed_changes=None, fail=False):
        raw = json.dumps(self.fixture() if body is None else body).encode()
        listed = {"Size": len(raw), "ETag": '"' + "a" * 32 + '"', **(listed_changes or {})}
        metadata = {"ContentLength": len(raw), "VersionId": "fixed-version",
                    "ChecksumSHA256": base64.b64encode(hashlib.sha256(raw).digest()).decode(),
                    **(metadata_changes or {})}
        runtime = Path(__file__).resolve().parents[2] / ".runtime"
        runtime.mkdir(exist_ok=True)
        owned = []

        def create(*args, **kwargs):
            fd = os.dup(fixture.fileno())
            owned.append(fd)
            return fd

        def get(args, **kwargs):
            self.assertEqual(args[:3], ["aws", "s3api", "get-object"])
            self.assertIn("--if-match", args)
            self.assertIn("--checksum-mode", args)
            self.assertIn("098208446664", args)
            self.assertEqual(kwargs["timeout"], 15)
            self.assertEqual(kwargs["pass_fds"], (owned[0],))
            self.assertEqual(args[-1], f"/proc/self/fd/{owned[0]}")
            if fail:
                raise subprocess.CalledProcessError(1, args, stderr=PRIVATE)
            os.write(owned[0], raw)
            return Mock(stdout=json.dumps(metadata).encode())

        with TemporaryFile(dir=runtime) as fixture, \
                patch.object(remote.os, "memfd_create", create, create=True), \
                patch.object(remote.subprocess, "run", side_effect=get):
            try:
                return remote.read_backup_failure_manifest(KEY, listed)
            finally:
                for fd in owned:
                    with self.assertRaises(OSError):
                        os.fstat(fd)

    def test_manifest_is_verified_in_memory_and_output_is_whitelisted(self):
        result = self.read_fixture()
        self.assertEqual(result["capturedAt"], CAPTURED)
        self.assertEqual(result["failureStage"], "source")
        self.assertEqual(set(result), {"capturedAt", "nativeRevision", "failureStage",
                                       "manifestVersionId", "manifestSha256"})
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertEqual(self.read_fixture(self.fixture(recoveryStateFailureStage=PRIVATE))["failureStage"], "unknown")
        self.assertIsNone(self.read_fixture(self.fixture(recoveryStateError=None)))

    def test_mismatch_or_unbounded_manifest_is_rejected_and_descriptor_closed(self):
        for changes in ({"ContentLength": 1}, {"ChecksumSHA256": "bad"}, {"VersionId": None},
                        {"VersionId": "null"}, {"VersionId": PRIVATE + "\n"}):
            with self.subTest(changes=changes), self.assertRaises(remote.ReleaseError):
                self.read_fixture(metadata_changes=changes)
        for changes in ({"Size": 16385}, {"Size": -1}, {"ETag": "unsafe"}):
            with self.subTest(changes=changes), self.assertRaises(remote.ReleaseError):
                self.read_fixture(listed_changes=changes)
        for changes in ({"capturedAt": "wrong"}, {"revision": "b" * 40}):
            with self.subTest(changes=changes), self.assertRaises(remote.ReleaseError):
                self.read_fixture(self.fixture(**changes))
        with self.assertRaises(subprocess.CalledProcessError):
            self.read_fixture(fail=True)

    def test_only_latest_three_incomplete_finalized_batches_are_read(self):
        items = []
        for hour in range(6):
            prefix = PREFIX.replace(CAPTURED, f"20261119T0{hour}0005Z")
            names = ["manifest.json", "mysql.sql.aes256gcm"]
            if hour == 5:
                names.append("recovery-state.idbackup")
            items.extend({"Key": prefix + name, "Size": 100} for name in names)
        items.extend([{"Key": PREFIX.replace("mysql/daily/", "other/") + "manifest.json"},
                      {"Key": PREFIX.replace(CAPTURED, "20261119T060005Z") + "manifest.json"}])
        fixed_clock = Mock()
        fixed_clock.now.return_value = datetime(2026, 11, 19, tzinfo=timezone.utc)
        with patch.object(remote.os, "memfd_create", create=True), patch.object(remote, "datetime", fixed_clock), \
                patch.object(remote, "run", side_effect=[json.dumps({"Contents": items}), "{}"]) as listing, \
                patch.object(remote, "read_backup_failure_manifest", return_value={"failureStage": "source"}) as read:
            report = remote.recent_recovery_failures()
        self.assertEqual(report["listedIncompleteBatches"], 5)
        self.assertEqual(read.call_count, 3)
        self.assertEqual([call.args[0].split("/")[3] for call in read.call_args_list],
                         [f"20261119T0{hour}0005Z" for hour in (4, 3, 2)])
        self.assertEqual(listing.call_count, 2)
        for call, day in zip(listing.call_args_list, ("20261119", "20261118")):
            self.assertIn("mysql/daily/independent-recharge/" + day, call.args[0])
            self.assertIn("--no-paginate", call.args[0])
        self.assertNotIn(PRIVATE, json.dumps(report))

    def test_failed_or_truncated_listing_returns_safe_unavailable(self):
        for failure in (subprocess.CalledProcessError(1, "aws", stderr=PRIVATE),
                        remote.ReleaseError(PRIVATE)):
            with patch.object(remote.os, "memfd_create", create=True), \
                    patch.object(remote, "run", side_effect=failure):
                self.assertEqual(remote.recent_recovery_failures(),
                                 {"available": False, "reason": "backup_history_unavailable"})
        with patch.object(remote.os, "memfd_create", create=True), \
                patch.object(remote, "run", return_value='{"IsTruncated": true}'):
            self.assertFalse(remote.recent_recovery_failures()["available"])

    def test_unsupported_platform_does_not_attempt_aws(self):
        with patch.dict(remote.os.__dict__):
            remote.os.__dict__.pop("memfd_create", None)
            with patch.object(remote, "run") as read:
                self.assertFalse(remote.recent_recovery_failures()["available"])
                read.assert_not_called()

    def test_oom_events_only_expose_owned_helpers_and_safe_time(self):
        event = {"Action": "oom", "time": 1000000, "Actor": {"Attributes": {
            "name": "id-recovery-capsule-" + "a" * 16, "org.id-business.backup": "portable-recovery",
            "private": PRIVATE}}}
        unrelated = {**event, "Actor": {"Attributes": {"name": PRIVATE}}}
        with patch.object(remote.time, "time", return_value=1000000), \
                patch.object(remote, "run", return_value=(json.dumps(event) + "\n" + json.dumps(unrelated)).encode()) as read:
            result = remote.recent_backup_oom_events()
        self.assertEqual(result, {"available": True, "historyMayBeIncomplete": True,
                                  "events": [{"at": 1000000, "helper": "capsule"}]})
        self.assertEqual(read.call_args.kwargs["timeout"], 5)
        self.assertNotIn(PRIVATE, json.dumps(result))
        with patch.object(remote, "run", side_effect=OSError(PRIVATE)):
            self.assertEqual(remote.recent_backup_oom_events(),
                             {"available": False, "historyMayBeIncomplete": True})


if __name__ == "__main__":
    unittest.main()
