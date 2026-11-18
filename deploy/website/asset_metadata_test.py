import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import remote


class CurrentAssetMetadataTests(unittest.TestCase):
    def setUp(self):
        runtime = Path(__file__).resolve().parents[2] / ".runtime"
        runtime.mkdir(exist_ok=True)
        directory = TemporaryDirectory(dir=runtime)
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.base, self.target = "a" * 40, "b" * 40
        self.public = b'{"assets":{"/admin":{"body":"synthetic public page"}}}'
        self.expected = hashlib.sha256(self.public).hexdigest()
        self.formal = self.root / "formal"
        (self.formal / "backups").mkdir(parents=True)
        operations = self.root / "releases" / self.base / "operations"
        operations.mkdir(parents=True)
        self.asset = operations.parent / "assets.json"
        self.previous = b'{"assets":{"/admin":{"body":"previous public metadata"}}}'
        self.asset.write_bytes(self.previous)
        self.asset.chmod(0o644)
        self.published = {"runId": remote.ASSET_METADATA_RELEASE_RUN, "mainSha": self.base,
                          "appCanaryPassed": True, "liveAssetsSha256": self.expected}
        drop = self.formal / "current-release.conf"
        drop.write_text("[Service]\nExecStart=" + str(operations / "run-app") + " live\n")
        self.mounted = {"available": True, "sha256": self.expected}
        self.container = "synthetic-container"
        self.run = Mock(return_value=self.public)
        original_lstat = Path.lstat

        def metadata(path, *args, **kwargs):
            value = original_lstat(path, *args, **kwargs)
            if path == self.asset:
                return SimpleNamespace(st_uid=0, st_gid=0, st_mode=value.st_mode, st_nlink=value.st_nlink)
            return value

        contexts = (
            patch.multiple(remote, ROOT=self.root, FORMAL=self.formal, DROP=drop,
                           ASSET_METADATA_REPAIR_BASE=self.base, ASSET_METADATA_REPAIR_DIGEST=self.expected,
                           snapshot=self.snapshot, mounted_asset_bytes=self.run),
            patch.object(Path, "lstat", metadata),
            patch.object(remote.os, "geteuid", return_value=0),
            patch.object(remote.os, "chown"),
        )
        for context in contexts:
            context.start()
            self.addCleanup(context.stop)
        self.plan = {"sha": self.target, "before": self.snapshot(),
                     "publishedAssetReceipt": self.published,
                     "expectedAssetsSha256": self.expected, "expectedAssetsBytes": len(self.public)}

    def snapshot(self):
        return {"components": {"app": {"revision": self.base, "id": self.container}},
                "unitSha256": "unit", "gatewaySha256": "gateway", "launchers": {},
                "assetsSha256": remote.digest(self.asset), "mountedAssets": dict(self.mounted)}

    def test_repairs_only_the_current_bundle_and_preserves_the_original_file(self):
        result = remote.repair_current_asset_metadata(self.plan)
        self.assertEqual(self.asset.read_bytes(), self.public)
        self.assertEqual(result["before"]["assetsSha256"], self.expected)
        self.assertTrue(result["repair"]["runtimeIdentityUnchanged"])
        archive = self.root / result["repair"]["archive"]
        self.assertEqual((archive / "assets.previous.json").read_bytes(), self.previous)
        self.assertTrue((archive / "receipt.json").is_file())
        self.assertEqual(json.loads((archive / "receipt.json").read_text())["publishedAssetReceipt"], self.published)
        repeated = remote.repair_current_asset_metadata(self.plan | {"before": self.snapshot()})
        self.assertFalse(repeated["repair"]["repaired"])
        self.assertEqual(self.run.call_count, 1)

    def test_rejects_unverified_receipts_mounts_bytes_and_concurrent_runtime_changes(self):
        for field, value in (("runId", 1), ("mainSha", "c" * 40),
                             ("appCanaryPassed", False), ("liveAssetsSha256", "c" * 64)):
            with self.subTest(field=field), self.assertRaisesRegex(remote.ReleaseError, "published_receipt"):
                remote.repair_current_asset_metadata(self.plan | {"publishedAssetReceipt": self.published | {field: value}})
        with self.assertRaisesRegex(remote.ReleaseError, "published_receipt"):
            remote.repair_current_asset_metadata(self.plan | {"publishedAssetReceipt": None})
        self.mounted["sha256"] = "c" * 64
        with self.assertRaisesRegex(remote.ReleaseError, "live_mount"):
            remote.repair_current_asset_metadata(self.plan)
        self.mounted["sha256"] = self.expected
        self.run.return_value = b"incorrect"
        with self.assertRaisesRegex(remote.ReleaseError, "recovery_bytes"):
            remote.repair_current_asset_metadata(self.plan)
        self.container = "changed-container"
        with self.assertRaisesRegex(remote.ReleaseError, "live_baseline_changed"):
            remote.repair_current_asset_metadata(self.plan)
        self.assertEqual(self.asset.read_bytes(), self.previous)
        self.assertEqual(list((self.formal / "backups").iterdir()), [])

    def test_creates_the_missing_recovery_parent_and_rejects_a_symlink(self):
        parent = self.formal / "backups"
        parent.rmdir()
        result = remote.repair_current_asset_metadata(self.plan)
        self.assertEqual((self.root / result["repair"]["archive"] / "assets.previous.json").read_bytes(), self.previous)
        self.asset.write_bytes(self.previous)
        real = self.formal / "real-backups"
        parent.rename(real)
        parent.symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(remote.ReleaseError, "archive_directory"):
            remote.repair_current_asset_metadata(self.plan)

    def test_restores_the_original_file_if_atomic_install_fails(self):
        replace = os.replace

        def fail_install(source, destination):
            if Path(source).name == "assets.prepared.json":
                raise OSError("synthetic install failure")
            replace(source, destination)

        with patch.object(remote.os, "replace", fail_install), self.assertRaises(OSError):
            remote.repair_current_asset_metadata(self.plan)
        self.assertEqual(self.asset.read_bytes(), self.previous)


if __name__ == "__main__":
    unittest.main()
