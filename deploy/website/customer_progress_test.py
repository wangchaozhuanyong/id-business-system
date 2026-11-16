import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, call, patch

import customer_progress
import recharge_core
import remote
import vendure_admission


class CustomerProgressReleaseTests(unittest.TestCase):
    def test_only_the_active_project_worker_launcher_can_be_rewritten(self):
        with TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / ".runtime") as directory:
            root = Path(directory)
            formal = root / "formal"
            launcher = formal / "operations/run-vendure-worker"
            launcher.parent.mkdir(parents=True)
            launcher.write_text("echo synthetic")
            binding = (f"argv[]=/bin/bash {launcher} ;".encode(), "synthetic-hash")
            with patch.object(customer_progress, "ROOT", root), patch.object(customer_progress, "FORMAL", formal):
                self.assertEqual(customer_progress.active_launcher(binding), launcher)
                for command in ("/bin/bash /tmp/run-vendure-worker", f"/bin/bash {launcher} --extra",
                                f"/bin/sh {launcher}", f"/bin/bash {launcher} ; argv[]=/bin/bash {launcher}"):
                    with self.assertRaises(remote.ReleaseError):
                        customer_progress.active_launcher((f"argv[]={command} ;".encode(), "hash"))

    def test_scoped_worker_switch_preserves_image_user_and_verifies_every_loaded_file(self):
        with TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / ".runtime") as directory:
            root = Path(directory)
            formal = root / "formal"
            old = root / "releases" / ("a" * 40) / "source"
            source = root / "releases" / ("b" * 40) / "source"
            operations = source.parent / "operations"
            operations.mkdir(parents=True)
            for name in customer_progress.FILES:
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("synthetic-source:" + name)
            previous = formal / "operations/run-vendure-worker"
            previous.parent.mkdir(parents=True)
            previous.write_text(f'#!/bin/bash\nsha={"a" * 40}\ndocker run --read-only immutable-image '
                                f'--mount "type=bind,src={old},dst=/app,readonly" node worker.mjs\n')
            binding = (f"argv[]=/bin/bash {previous} ;".encode(), "hash")
            container = {"Id": "synthetic-worker", "Image": "immutable-image", "Config": {"User": "993:992"},
                         "State": {"Running": True}, "Mounts": [{"Source": str(old), "Destination": "/app", "RW": False}]}
            override = (operations / "pending.conf", operations / "current.conf")
            with patch.object(customer_progress, "ROOT", root), patch.object(customer_progress, "FORMAL", formal), \
                    patch.object(recharge_core, "ROOT", root), patch.object(customer_progress, "worker_binding", return_value=binding), \
                    patch.object(customer_progress, "inspect", return_value=container), \
                    patch.object(customer_progress, "run", return_value=b"") as run, \
                    patch.object(recharge_core, "stage_override", return_value=override), \
                    patch.object(customer_progress.os, "replace") as replace:
                plan = customer_progress.stage_worker(source, operations)
                self.assertEqual(plan["runtime"], ("immutable-image", "993:992", str(source)))
                self.assertEqual(plan["launcher"].read_text(), previous.read_text().replace("a" * 40, "b" * 40))
                run.return_value = b"active\n"
                with self.assertRaisesRegex(remote.ReleaseError, "not_drained"):
                    customer_progress.activate_worker(plan)
                replace.assert_not_called()
                run.return_value = b"inactive\n"
                customer_progress.activate_worker(plan)
                replace.assert_called_once_with(*override)
                container["Mounts"][0]["Source"] = str(source)
                run.side_effect = lambda args: (plan["files"][args[-1].removeprefix("/app/")] + " file\n").encode()
                customer_progress.verify_worker(plan)
                run.side_effect = lambda _args: b"wrong-hash file\n"
                with self.assertRaisesRegex(remote.ReleaseError, "source_mismatch"):
                    customer_progress.verify_worker(plan)
                container["Image"] = "another-image"
                with self.assertRaisesRegex(remote.ReleaseError, "runtime_changed"):
                    customer_progress.verify_worker(plan)

    def test_customer_progress_requires_separate_scope_and_uses_the_existing_gateway_transaction(self):
        for extra in ({"rechargePartnerApi": True}, {"vendureRetryReceipt": "e" * 64},
                      {"rechargeCore": {}}, {"adapter": {"runtimeFiles": ["unexpected"]}}):
            # A truthy core plan, as supplied by the existing native release.
            if "rechargeCore" in extra:
                extra["rechargeCore"] = {"assetsSha256": "e" * 64}
            with self.assertRaises(remote.ReleaseError):
                remote.release_with_optional_vendure_refresh({"customerProgress": True, **extra})
        target = "b" * 40
        before = {key: None for key in ("components", "gatewaySha256", "unitSha256", "assetsSha256", "launchers", "monitoring")}
        plan = {"sha": target, "before": before, "customerProgress": True}
        release = remote.ROOT / "releases" / target
        staged = (release / "source", release / "operations")
        calls = Mock()
        calls.stage.return_value = staged
        calls.website.return_value = {"mainSha": target}
        calls.gateway.return_value = {"gatewaySha": target, "workerSourceRevision": target}
        with patch.object(remote, "snapshot", return_value=before), patch.object(remote, "stage", calls.stage), \
                patch.object(remote, "release_website", calls.website), patch.object(remote, "verify_partner_ingress", calls.ingress), \
                patch.object(vendure_admission, "check_refresh_baseline", calls.baseline), \
                patch.object(vendure_admission, "cutover", calls.gateway), patch.object(remote, "write_new"), \
                patch.object(remote.os, "replace"):
            receipt = remote.release_with_optional_vendure_refresh(plan)
        self.assertEqual(receipt["vendureGateway"]["workerSourceRevision"], target)
        self.assertEqual(calls.mock_calls, [call.stage(plan, release),
            call.baseline(target, None, partner_api=True, customer_progress=True),
            call.website(plan, staged=staged), call.ingress(),
            call.gateway(target, release, refresh=True, retry_receipt=None, partner_api=True, customer_progress=True)])
