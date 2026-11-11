import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import release
import remote

BASE = "a" * 40
TARGET = "b" * 40


class WebsiteReleaseTests(unittest.TestCase):
    @patch("release.git")
    def test_rejects_a_main_that_changed(self, git):
        git.side_effect = [TARGET, f"{BASE}\trefs/heads/main"]
        with self.assertRaisesRegex(RuntimeError, "remote_main_changed"):
            release.require_main(TARGET)

    @patch("release.git", return_value="deploy/recharge-core/Dockerfile")
    @patch("release.subprocess.run", return_value=Mock(returncode=0))
    def test_website_workflow_rejects_core_changes(self, run, git):
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        git.assert_called_once_with("diff", "--name-only", BASE, TARGET, "--", *release.CORE_PATHS)

    def test_ssm_payload_is_one_quoted_program(self):
        shell = release.script_for({"operation": "preflight", "sha": TARGET})
        self.assertTrue(shell.startswith("set -eu\npython3 - <<'ID_WEBSITE_RELEASE'\n"))
        body, end = shell.split("\n", 2)[2].rsplit("\nID_WEBSITE_RELEASE\n", 1)
        self.assertEqual(end, "")
        compile(body, "<ssm-release>", "exec")

    @patch("remote.stage")
    @patch("remote.snapshot")
    def test_stops_before_staging_if_live_state_changed(self, snapshot, stage):
        before = {"components": {"app": {"revision": BASE}}, "unitSha256": "unit",
                  "gatewaySha256": "gateway", "assetsSha256": "assets", "launchers": {}}
        snapshot.return_value = before | {"unitSha256": "changed"}
        with self.assertRaisesRegex(remote.ReleaseError, "live_baseline_changed"):
            remote.release_website({"sha": TARGET, "before": before})
        stage.assert_not_called()

    def test_runtime_mount_must_match_exact_readonly_source(self):
        source = Path("/opt/id-business-independent/releases") / TARGET / "source"
        mount = {"Source": str(source), "Destination": "/app", "RW": False}
        self.assertTrue(remote.mount_matches({"Mounts": [mount]}, source, "/app"))
        self.assertFalse(remote.mount_matches({"Mounts": [mount | {"RW": True}]}, source, "/app"))
        self.assertFalse(remote.mount_matches({"Mounts": [mount]}, source.parent, "/app"))

    def test_canary_diagnostic_outputs_only_recognized_indicators_and_locations(self):
        result = remote.canary_diagnostics("AssertionError [ERR_ASSERTION]: synthetic secret input\n"
                                           "at /ops/check-app.mjs:24:5\n"
                                           "prototype.css?v=20261111-confirmed-orders")
        self.assertEqual(result, {"indicators": ["assertion"], "frames": [["check-app.mjs", "24", "5"]],
                                  "assets": ["prototype.css?v=20261111-confirmed-orders"]})

    def test_canary_uses_exact_target_versions_and_keeps_other_assertions(self):
        old = '<link href="./prototype.css?v=old"><script src="./subscription-management.js?v=old"></script>'
        new = '<link href="./prototype.css?v=new"><script src="./subscription-management.js?v=new"></script>'
        check = ("assert(index.includes('prototype.css?v=old'));\n"
                 r"assert.match(index, /subscription-management\.js\?v=old/);" "\n"
                 "assert(index.includes('overview-prototype.css?v=old'));\n"
                 "assert.equal(response.status, 200);")
        expected = check.replace("'prototype.css?v=old'", "'prototype.css?v=new'") \
            .replace(r"subscription-management\.js\?v=old", r"subscription-management\.js\?v=new")
        self.assertEqual(remote.update_canary_asset_refs(check, old, new), expected)


if __name__ == "__main__":
    unittest.main()
