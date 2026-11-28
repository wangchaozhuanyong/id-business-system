import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import call, patch

import recharge_core
from remote import ContainerMetadataError, PINNED_UPSTREAM


REVISION = "a" * 40
IMAGE = "sha256:" + "b" * 64
NATIVE = {
    "Id": "native",
    "Image": IMAGE,
    "State": {"Running": True, "StartedAt": "2026-11-27T04:48:54Z"},
    "Config": {"Labels": {"org.opencontainers.image.revision": REVISION}},
    "NetworkSettings": {"Ports": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "44579"}]}},
}


class RechargeCoreReadinessTests(unittest.TestCase):
    def test_native_waits_for_container_creation_then_verifies_readiness_and_sources(self):
        sources = {
            "revision": PINNED_UPSTREAM,
            "files": 203,
            "originalFiles": 194,
            "plusTrialFiles": [
                "browser-pool.js", "chatgpt.js", "pricing-checkout.js", "session-auth.js", "stripe-payment.js",
            ],
            "retryFiles": ["server.js"],
            "paymentApprovalFiles": ["payment-retry.js", "server.js", "stripe-payment.js"],
        }
        mounts = {("source", "target", True)}
        with (
            patch.object(recharge_core, "inspect", side_effect=[
                ContainerMetadataError("recharge-native", "not_found"), NATIVE,
            ]) as inspect,
            patch.object(recharge_core, "media_mounts", return_value=mounts) as media_mounts,
            patch.object(recharge_core, "run", side_effect=[b'{"ready": true}', json.dumps(sources).encode()]) as run,
            patch.object(recharge_core.time, "sleep") as sleep,
        ):
            state = recharge_core.ready_native(REVISION, IMAGE, mounts)

        self.assertEqual(state["revision"], REVISION)
        self.assertEqual(state["image"], IMAGE)
        self.assertEqual(inspect.call_args_list, [call("recharge-native"), call("recharge-native")])
        self.assertEqual(run.call_count, 2)
        media_mounts.assert_called_once_with(NATIVE)
        sleep.assert_called_once_with(1)

    def test_worker_waits_for_container_before_verifying_polling_and_reopening_intake(self):
        source = Path("/candidate/source")
        release = recharge_core.CoreRelease({"sha": REVISION, "before": {}}, source, Path("/candidate/operations"))
        release.worker_expected = ("image", "user", str(source))
        worker = {"Id": "worker", "State": {"Running": True}}
        created = {**worker, "State": {"Running": False}}
        with (
            patch.object(recharge_core, "read_idle_queue", side_effect=[(40, 0), (41, 0)]),
            patch.object(recharge_core, "inspect", side_effect=[
                ContainerMetadataError("vendure-worker", "not_found"), created, worker,
            ]) as inspect,
            patch.object(recharge_core, "worker_runtime", return_value=release.worker_expected) as worker_runtime,
            patch.object(recharge_core, "run", side_effect=[b"", b"source-digest  worker\n"]),
            patch.object(recharge_core, "digest", return_value="source-digest") as digest,
            patch.object(release, "reopen") as reopen,
            patch.object(recharge_core.time, "sleep") as sleep,
        ):
            release.finish()

        self.assertEqual(inspect.call_args_list, [call("vendure-worker")] * 3)
        worker_runtime.assert_called_once_with(worker)
        digest.assert_called_once_with(source / "modules/recharge/vendure/codexdaichong-worker.mjs")
        self.assertEqual(sleep.call_args_list, [call(1), call(1)])
        reopen.assert_called_once_with()
        self.assertEqual(release.receipt, {
            "workerSourceRevision": REVISION, "workerPollingObserved": True, "ingressResumed": True,
        })

    def test_worker_readiness_does_not_retry_a_failed_intake_readback(self):
        source = Path("/candidate/source")
        worker = {"Id": "worker", "State": {"Running": True}}
        for failure in (
            ContainerMetadataError("caddy", "not_found"),
            subprocess.CalledProcessError(1, ["release-gate.py", "disable"]),
        ):
            release = recharge_core.CoreRelease({"sha": REVISION, "before": {}}, source, Path("/candidate/operations"))
            release.worker_expected = ("image", "user", str(source))
            with (
                self.subTest(error=type(failure).__name__),
                patch.object(recharge_core, "read_idle_queue", side_effect=[(40, 0), (41, 0)]),
                patch.object(recharge_core, "inspect", return_value=worker) as inspect,
                patch.object(recharge_core, "worker_runtime", return_value=release.worker_expected),
                patch.object(recharge_core, "run", side_effect=[b"", b"source-digest  worker\n"]),
                patch.object(recharge_core, "digest", return_value="source-digest"),
                patch.object(release, "reopen", side_effect=failure) as reopen,
                patch.object(recharge_core.time, "sleep") as sleep,
            ):
                with self.assertRaises(type(failure)) as error:
                    release.finish()

                self.assertIs(error.exception, failure)
                self.assertEqual(release.receipt, {})
                inspect.assert_called_once_with("vendure-worker")
                reopen.assert_called_once_with()
                sleep.assert_not_called()

    def test_readiness_rejects_other_container_metadata_failures_without_retrying(self):
        release = recharge_core.CoreRelease({"sha": REVISION, "before": {}}, Path("/source"), Path("/operations"))
        for reason in ("command_failed", "command_unavailable", "invalid_metadata", "timeout"):
            for name, read in (
                ("recharge-native", lambda: recharge_core.ready_native(REVISION, IMAGE, set())),
                ("vendure-worker", release.finish),
            ):
                with (
                    self.subTest(reason=reason, name=name),
                    patch.object(recharge_core, "inspect", side_effect=ContainerMetadataError(name, reason)) as inspect,
                    patch.object(recharge_core, "read_idle_queue", return_value=(40, 0)),
                    patch.object(recharge_core, "run"),
                    patch.object(release, "reopen") as reopen,
                    patch.object(recharge_core.time, "sleep") as sleep,
                ):
                    with self.assertRaises(ContainerMetadataError) as error:
                        read()
                    self.assertEqual(error.exception.reason, reason)
                    inspect.assert_called_once_with(name)
                    sleep.assert_not_called()
                    reopen.assert_not_called()
