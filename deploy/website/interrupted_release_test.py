import hashlib
import json
import unittest
from unittest.mock import Mock, call, patch

import interrupted_release as release


INSTANCE = "i-0838cebf64f0e2a89"


def command_receipts(operation, command_id, status, code, output, error=""):
    common = {
        "CommandId": command_id,
        "DocumentName": "AWS-RunShellScript",
        "Comment": f"ID website {operation} d7a9b22909ea run 45941856485/1",
        "Status": status,
        "StatusDetails": status,
    }
    history = {"Commands": [{**common, "InstanceIds": [INSTANCE], "CompletedCount": 1, "ErrorCount": code}]}
    invocation = {**common, "InstanceId": INSTANCE, "ResponseCode": code, "PluginName": "aws:runShellScript",
                  "StandardOutputContent": output, "StandardErrorContent": error}
    return history, invocation


class InterruptedReleaseTest(unittest.TestCase):
    def setUp(self):
        self.release_id = "b431b85c-90aa-4357-9c4d-43bdb8f541af"
        self.preflight_id = "f2aaffba-7a9c-407e-ab3c-989d09f82a89"
        site = {"revision": release.INTERRUPTED_WEBSITE_SHA, "running": True}
        native = {"revision": release.INTERRUPTED_OLD_NATIVE_SHA, "running": True,
                  "image": release.INTERRUPTED_OLD_NATIVE_IMAGE}
        self.before = {
            "assetsSha256": release.INTERRUPTED_OLD_ASSETS,
            "gatewaySha256": release.INTERRUPTED_GATEWAY_SHA256,
            "mountedAssets": {"available": True, "sha256": release.INTERRUPTED_OLD_ASSETS},
            "components": {**{name: dict(site) for name in ("app", "drive-backup", "sheets-sync")},
                           "recharge": dict(native), "recharge-native": dict(native)},
            "nativePublication": {"identity": native, "imageLabelsVerified": True},
        }
        self.release_history, self.release_invocation = command_receipts(
            "release", self.release_id, "Failed", 1, "Switching the drained native recharge runtime\n",
            "container_metadata_read_failed:recharge-native:not_found\nfailed to run commands: exit status 1\n",
        )
        self.preflight_history, self.preflight_invocation = command_receipts(
            "preflight", self.preflight_id, "Success", 0, json.dumps(self.before, sort_keys=True) + "\n",
        )

    def aws(self):
        return Mock(side_effect=[self.release_history, self.release_invocation,
                                 self.preflight_history, self.preflight_invocation])

    def baseline(self):
        output = self.preflight_invocation["StandardOutputContent"].strip().encode()
        with patch.object(release, "_PREFLIGHT_OUTPUT_SHA256", hashlib.sha256(output).hexdigest()):
            return release.original_baseline(self.aws(), INSTANCE)

    def test_reads_the_two_exact_ssm_commands_without_sending_a_command(self):
        aws = self.aws()
        output = self.preflight_invocation["StandardOutputContent"].strip().encode()
        with patch.object(release, "_PREFLIGHT_OUTPUT_SHA256", hashlib.sha256(output).hexdigest()):
            self.assertEqual(release.original_baseline(aws, INSTANCE), self.before)
        self.assertEqual(aws.call_args_list, [
            call("ssm", "list-commands", "--command-id", self.release_id),
            call("ssm", "get-command-invocation", "--command-id", self.release_id, "--instance-id", INSTANCE),
            call("ssm", "list-commands", "--command-id", self.preflight_id),
            call("ssm", "get-command-invocation", "--command-id", self.preflight_id, "--instance-id", INSTANCE),
        ])

    def test_wrong_run_or_invocation_cannot_supply_baseline(self):
        for record, field, value, error in (
            (self.release_history["Commands"][0], "Comment", "ID website release unrelated",
             "interrupted_release_command_not_verified"),
            (self.release_invocation, "ResponseCode", True, "interrupted_release_invocation_not_verified"),
            (self.preflight_invocation, "InstanceId", "i-00000000000000000",
             "interrupted_release_invocation_not_verified"),
            (self.preflight_invocation, "DocumentName", "AWS-RunPowerShellScript",
             "interrupted_release_invocation_not_verified"),
        ):
            with self.subTest(field=field), patch.dict(record, {field: value}), self.assertRaisesRegex(RuntimeError, error):
                self.baseline()

    def test_requires_the_observed_failure_after_native_cutover_starts(self):
        for field, value in (
            ("StandardErrorContent", "container_metadata_read_failed:recharge:not_found\n"),
            ("StandardOutputContent", "Building the exact main native recharge image\n"),
        ):
            with self.subTest(field=field), patch.dict(self.release_invocation, {field: value}):
                with self.assertRaisesRegex(RuntimeError, "interrupted_release_failure_not_verified"):
                    self.baseline()

    def test_requires_exact_preflight_output_digest(self):
        with self.assertRaisesRegex(RuntimeError, "interrupted_release_preflight_not_verified"):
            release.original_baseline(self.aws(), INSTANCE)

    def test_rejects_malformed_or_unexpected_original_snapshot(self):
        for output in ("invalid JSON", "[]", json.dumps({**self.before, "gatewaySha256": "0" * 64})):
            with self.subTest(output=output[:30]), patch.dict(self.preflight_invocation, {"StandardOutputContent": output}):
                with self.assertRaisesRegex(RuntimeError, "interrupted_release_preflight_baseline_mismatch"):
                    self.baseline()


if __name__ == "__main__":
    unittest.main()
