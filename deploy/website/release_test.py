import hashlib
import json
import os
import sqlite3
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import release
import remote
import backup_monitoring
import recharge_core
import vendure_admission

BASE = "a" * 40
TARGET = "b" * 40

ANALYTICS_LAUNCHER = """const { analytics, visits, microsoft } = JSON.parse(toolConfig);
for (const [name, value] of [
  ['analytics', JSON.stringify(analytics)],
  ['visits', visits],
  ['microsoft', JSON.stringify(microsoft)]
]) writeFileSync('/credentials/' + name, value, { flag: 'wx', mode: 0o600 });
const [websiteAnalyticsConfig, websiteVisitsSecret, microsoftMailboxConfig] = await Promise.all([
  readToolConfig('/credentials/analytics', 'website-analytics'),
  readToolConfig('/credentials/visits', 'website-visits'),
  readToolConfig('/credentials/microsoft', 'microsoft-mailbox')
]);
await startPreview(port, {
  websiteAnalyticsConfig,
  websiteVisitsSecret,
  microsoftMailboxConfig
});
"""


class WebsiteReleaseTests(unittest.TestCase):
    def test_native_diagnostic_uses_only_release_phases_and_fixed_error_codes(self):
        invocation = {"Status": "Failed",
                      "StandardOutputContent": '{"rechargePreflight": {"readOnly": true}}\n'
                                               'Building the exact main native recharge image\n'
                                               'unrelated terminal detail\n',
                      "StandardErrorContent": "Traceback (most recent call last):\n"
                                              "remote.ReleaseError: native_canary_failed: controlled_command_failed\n"}
        self.assertEqual(release.release_failure_diagnostic(invocation), {
            "status": "Failed",
            "phases": ["native_production_readonly_preflight_completed", "native_build_started"],
            "reasons": ["native_canary_failed: controlled_command_failed"]
        })

    def test_tools_credential_json_keeps_values_and_line_boundaries(self):
        launcher = '''{
  cat "$CREDENTIALS_DIRECTORY/independent-recharge-bridge"
  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"
  printf '\\n'
  cat "$CREDENTIALS_DIRECTORY/independent-vendure-integrations"
}'''
        tools = {"analytics": {"key": "synthetic" + chr(10) + "multiline"}, "visits": "synthetic-visits",
                 "microsoft": {"value": "synthetic-microsoft"}, "cloudflare": {"value": "synthetic-token"}}
        vendure = {"mailboxApiKey": "synthetic-vendure"}
        transformed = remote.normalize_tools_credential_stream(launcher)
        self.assertEqual(remote.normalize_tools_credential_stream(transformed), transformed)
        with TemporaryDirectory() as directory:
            paths = Path(directory)
            (paths / "independent-recharge-bridge").write_text("b" * 64 + "\n")
            (paths / "independent-vendure-integrations").write_text(json.dumps(vendure))
            for payload in (json.dumps(tools), json.dumps(tools) + "\n", json.dumps(tools, indent=2) + "\r\n"):
                with self.subTest(trailing_newline=payload.endswith("\n")):
                    (paths / "independent-online-tools").write_text(payload)
                    result = subprocess.check_output(["bash", "-euo", "pipefail", "-c", transformed],
                        env=os.environ | {"CREDENTIALS_DIRECTORY": directory}, text=True)
                    bridge, tool_line, vendure_line = result.splitlines()
                    self.assertEqual(bridge, "b" * 64)
                    self.assertEqual(json.loads(tool_line), tools)
                    self.assertEqual(json.loads(vendure_line), vendure)

    def test_tools_credential_stream_rejects_drift(self):
        for source in ("different input", '  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"\n' * 2):
            with self.assertRaisesRegex(remote.ReleaseError, "unexpected_tools_credential_stream"):
                remote.normalize_tools_credential_stream(source)

    def test_tools_credential_stream_stops_on_invalid_json_without_echoing_it(self):
        script = remote.normalize_tools_credential_stream(
            '  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"')
        with TemporaryDirectory() as directory:
            (Path(directory) / "independent-online-tools").write_text('{"value":"synthetic-not-for-log",}')
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script], capture_output=True,
                env=os.environ | {"CREDENTIALS_DIRECTORY": directory}, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("synthetic-not-for-log", result.stderr)

    def test_storefront_analytics_uses_private_config_and_is_idempotent(self):
        result = remote.wire_storefront_analytics(ANALYTICS_LAUNCHER)
        self.assertIn("readToolConfig(cloudflare === undefined ? undefined : '/credentials/cloudflare', 'website-cloudflare')", result)
        self.assertIn("...(cloudflare === undefined ? [] : [['cloudflare', JSON.stringify(cloudflare)]])", result)
        self.assertIn("{ flag: 'wx', mode: 0o600 }", result)
        self.assertIn("  websiteAnalyticsConfig,\n  websiteCloudflareConfig,\n  websiteVisitsSecret,", result)
        self.assertEqual(remote.wire_storefront_analytics(result), result)
        # Original credentials and launcher behavior outside these anchors stay intact.
        prefix, suffix = "const bridgeSecret = source;\n", "\ncheckOriginalIntegrations();\n"
        self.assertEqual(remote.wire_storefront_analytics(prefix + ANALYTICS_LAUNCHER + suffix),
                         prefix + result + suffix)

    def test_storefront_analytics_rejects_drift_or_partial_wiring(self):
        for content in (
            ANALYTICS_LAUNCHER.replace("JSON.parse(toolConfig)", "loadDifferentConfig()"),
            ANALYTICS_LAUNCHER + "\n  websiteAnalyticsConfig,\n",
            ANALYTICS_LAUNCHER.replace("  websiteAnalyticsConfig,", "  websiteAnalyticsConfig,\n  websiteCloudflareConfig,"),
            remote.wire_storefront_analytics(ANALYTICS_LAUNCHER)
                .replace("'website-cloudflare'", "'website-analytics'"),
        ):
            with self.subTest(content=content), self.assertRaisesRegex(
                    remote.ReleaseError, "unexpected_storefront_analytics_launcher"):
                remote.wire_storefront_analytics(content)

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

    @patch("release.require_ancestor")
    @patch("release.git")
    def test_adapter_requires_explicit_selection_and_exact_scope(self, git, ancestor):
        git.return_value = "modules/recharge/codexdaichong/native-adapter.mjs\ndeploy/recharge-core/run-recharge.py"
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        release.require_website_scope(BASE, TARGET, True)
        for path in ("deploy/recharge-core/Dockerfile", "deploy/recharge-core/entry.mjs",
                     "modules/recharge/codexdaichong/prepare.mjs", "deploy/caddy/vendure.caddy"):
            git.return_value = "modules/recharge/codexdaichong/native-adapter.mjs\n" + path
            with self.assertRaisesRegex(RuntimeError, "recharge_adapter_release_scope_mismatch"):
                release.require_website_scope(BASE, TARGET, True)
        git.return_value = "modules/recharge/codexdaichong/gateway.mjs"
        with self.assertRaisesRegex(RuntimeError, "recharge_adapter_release_scope_mismatch"):
            release.require_website_scope(BASE, TARGET, True)
        ancestor.assert_called_with(BASE, TARGET)

    @patch("release.require_ancestor")
    @patch("release.git")
    def test_native_release_requires_both_reviewed_patches_and_rejects_unrelated_runtime_changes(self, git, _ancestor):
        approved = sorted(release.NATIVE_CORE_SCOPE)
        git.return_value = "\n".join(approved)
        self.assertIsNone(release.require_website_scope(BASE, TARGET, include_core=True))
        with self.assertRaisesRegex(RuntimeError, "recharge_native_release_scope_mismatch"):
            release.require_website_scope(BASE, TARGET, include_adapter=True, include_core=True)
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        for paths in (approved + ["deploy/recharge-core/Dockerfile"],
                      sorted(set(approved) - release.NATIVE_PATCH_FILES)):
            git.return_value = "\n".join(paths)
            with self.assertRaisesRegex(RuntimeError, "recharge_native_release_scope_mismatch"):
                release.require_website_scope(BASE, TARGET, include_core=True)

    @patch("release.require_ancestor")
    @patch("release.git")
    def test_proxy_types_require_exact_native_scope_and_joint_website_release(self, git, _ancestor):
        approved = release.PROXY_TYPE_CORE_SCOPE
        git.return_value = "\n".join(sorted(approved))
        self.assertIsNone(release.require_website_scope(BASE, TARGET, include_core=True))
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        for paths in (approved - {release.PROXY_TYPE_CATALOG}, approved | release.NATIVE_PATCH_FILES):
            git.return_value = "\n".join(sorted(paths))
            with self.assertRaisesRegex(RuntimeError, "recharge_native_release_scope_mismatch"):
                release.require_website_scope(BASE, TARGET, include_core=True)

    def test_worker_source_cutover_requires_the_actual_previous_launcher_reference(self):
        previous = remote.ROOT / "releases" / BASE / "source"
        target = remote.ROOT / "releases" / TARGET / "source"
        before = f"sha={BASE}\ndocker run --mount type=bind,src={previous},dst=/app,readonly image\n"
        expected = before.replace(BASE, TARGET)
        self.assertEqual(recharge_core.stage_worker_launcher(before, str(previous), target), expected)
        with self.assertRaisesRegex(remote.ReleaseError, "worker_source_reference_ambiguous"):
            recharge_core.stage_worker_launcher(before + f"# also {previous}\n", str(previous), target)
        with self.assertRaisesRegex(remote.ReleaseError, "worker_source_launcher_mismatch"):
            recharge_core.stage_worker_launcher("docker run image\n", str(previous), target)

    def test_core_assets_are_bound_to_the_exact_approved_bundle_digest(self):
        old, new = "a" * 64, "b" * 64
        plan = {"before": {"assetsSha256": old}, "adapter": True, "rechargeCore": {"assetsSha256": new}}
        self.assertIsNone(remote.require_asset_digest(plan, new))
        with self.assertRaisesRegex(remote.ReleaseError, "native_recharge_asset_digest_mismatch"):
            remote.require_asset_digest(plan, old)

    @patch("recharge_core.worker_binding")
    def test_worker_drain_compares_the_command_and_digest_without_runtime_timestamps(self, binding):
        path = str(recharge_core.WORKER_LAUNCHER)
        command = f"{{ path={path} ; argv[]={path} ; "
        binding.side_effect = [(f"{command}start_time=100 ; stop_time=none }}".encode(), "hash"),
                               (f"{command}start_time=100 ; stop_time=200 }}".encode(), "hash")]
        self.assertEqual(recharge_core.worker_launch_binding(), recharge_core.worker_launch_binding())

    def test_native_cutover_reads_snapshot_identity_from_the_verified_manifest(self):
        with TemporaryDirectory() as temporary, patch("recharge_core.ROOT", Path(temporary)):
            folder = Path(temporary) / "backups" / ("recharge-core-" + TARGET)
            folder.mkdir(parents=True)
            (folder / "mysql.sql.aes256gcm").write_bytes(b"encrypted fixture")
            summary = {"backup": str(folder), "verified": True, "plainBytes": 80}
            manifest = {"revision": TARGET, "encrypted": True, "verified": True, "plainBytes": 80,
                        "database": "id_redesign_codexdaichong_prod", "plainSha256": "a" * 64, "cipherSha256": "b" * 64}
            path = folder / "manifest.json"
            path.write_text(json.dumps(manifest))
            self.assertEqual(recharge_core.verify_snapshot_receipt(TARGET, summary),
                             {"plainBytes": 80, "cipherSha256": "b" * 64})
            path.write_text(json.dumps({**manifest, "revision": BASE}))
            with self.assertRaisesRegex(remote.ReleaseError, "sealed_recharge_backup_not_verified"):
                recharge_core.verify_snapshot_receipt(TARGET, summary)

    @patch("release.require_redeem_presentation")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_workspace_release_requires_the_exact_reviewed_file_set(self, git, ancestor, approval):
        git.return_value = "\n".join(remote.REDEEM_PRESENTATION_FILES)
        self.assertEqual(release.require_website_scope(BASE, TARGET), ("redeemPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET)
        for extra in ("modules/recharge/codexdaichong/native-adapter.mjs", "deploy/recharge-core/Dockerfile"):
            git.return_value = "\n".join((*remote.REDEEM_PRESENTATION_FILES, extra))
            with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
                release.require_website_scope(BASE, TARGET)
        self.assertEqual(approval.call_count, 1)

    @patch("release.require_presentation_approval")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_workspace_progress_release_checks_only_the_reviewed_presentation(self, git, ancestor, approval):
        files = remote.WORKSPACE_PROGRESS_PRESENTATION_FILES
        git.return_value = "\n".join(files)
        self.assertEqual(release.require_website_scope(BASE, TARGET),
                         ("workspaceProgressPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET, "workspace-progress-20261113.json", files)
        git.return_value += "\nmodules/recharge/codexdaichong/gateway.mjs"
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        self.assertEqual(approval.call_count, 1)

    @patch("release.require_presentation_approval")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_card_import_release_checks_the_adapter_and_shared_asset_inputs(self, git, ancestor, approval):
        git.return_value = remote.CARD_IMPORT_ASSET_SOURCE
        self.assertEqual(release.require_website_scope(BASE, TARGET),
                         ("cardImportPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET, "card-import-20261113.json",
                                         remote.CARD_IMPORT_PRESENTATION_FILES)
        git.return_value += "\nmodules/recharge/codexdaichong/native-routing.mjs"
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        self.assertEqual(approval.call_count, 1)

    @patch("release.require_presentation_approval")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_task_history_approval_cannot_include_changes_to_the_recharge_runtime(self, git, ancestor, approval):
        files = remote.TASK_HISTORY_PRESENTATION_FILES
        manifest = release.TASK_HISTORY_MANIFEST_PATH
        git.return_value = "\n".join((*files, manifest))
        self.assertEqual(release.require_website_scope(BASE, TARGET),
                         ("taskHistoryPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET, release.TASK_HISTORY_MANIFEST, files)
        for changed in ((manifest,), (*files, manifest, "modules/recharge/codexdaichong/native-adapter.mjs")):
            git.return_value = "\n".join(changed)
            with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
                release.require_website_scope(BASE, TARGET)

    @patch("release.require_presentation_approval")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_card_plan_ui_release_verifies_both_presentation_sources(self, git, ancestor, approval):
        files = remote.CARD_PLAN_PRESENTATION_FILES
        git.return_value = "\n".join(files)
        self.assertEqual(release.require_website_scope(BASE, TARGET),
                         ("cardPlanPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET, "card-plan-ui-20261114.json", files)
        for changed in (files[:1], (*files, "modules/recharge/codexdaichong/native-adapter.mjs")):
            git.return_value = "\n".join(changed)
            with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
                release.require_website_scope(BASE, TARGET)
        self.assertEqual(approval.call_count, 1)

    @patch("release.require_presentation_approval")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_checkout_diagnostic_release_verifies_its_four_presentation_sources(self, git, ancestor, approval):
        files = remote.CHECKOUT_DIAGNOSTIC_PRESENTATION_FILES
        git.return_value = "\n".join(files)
        self.assertEqual(release.require_website_scope(BASE, TARGET),
                         ("checkoutDiagnosticPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET, "checkout-diagnostic-20261114.json", files)
        for changed in (files[1:], (*files, "modules/recharge/codexdaichong/native-routing.mjs")):
            git.return_value = "\n".join(changed)
            with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
                release.require_website_scope(BASE, TARGET)
        self.assertEqual(approval.call_count, 1)

    @patch("release.require_presentation_approval")
    @patch("release.require_ancestor")
    @patch("release.git")
    def test_table_actions_release_only_accepts_the_reviewed_stylesheet(self, git, ancestor, approval):
        git.return_value = remote.TABLE_ACTIONS_STYLESHEET
        self.assertEqual(release.require_website_scope(BASE, TARGET),
                         ("tableActionsPresentation", approval.return_value))
        approval.assert_called_once_with(BASE, TARGET, "table-actions-20261112.json",
                                         (remote.TABLE_ACTIONS_STYLESHEET,))
        git.return_value += "\nmodules/recharge/codexdaichong/shell.js"
        with self.assertRaisesRegex(RuntimeError, "recharge_core_or_runtime_changed"):
            release.require_website_scope(BASE, TARGET)
        self.assertEqual(approval.call_count, 1)

    @patch("release.subprocess.check_output")
    @patch("release.Path.read_bytes")
    def test_presentation_approval_rejects_an_unreviewed_source_change(self, read, content):
        before = hashlib.sha256(b"old").hexdigest()
        after = hashlib.sha256(b"new").hexdigest()
        read.return_value = json.dumps({"beforeAssetsSha256": before, "assetsSha256": after,
                                        "files": {name: {"before": before, "after": after}
                                                  for name in remote.REDEEM_PRESENTATION_FILES}}).encode()
        content.side_effect = lambda args, **kwargs: b"old" if args[2].startswith(BASE) else b"new"
        self.assertEqual(release.require_redeem_presentation(BASE, TARGET),
                         {"beforeAssetsSha256": before, "assetsSha256": after})
        content.side_effect = lambda args, **kwargs: b"old" if args[2].startswith(BASE) else b"unexpected"
        with self.assertRaisesRegex(RuntimeError, "recharge_presentation_source_mismatch"):
            release.require_redeem_presentation(BASE, TARGET)

    def test_stage_keeps_default_asset_digest_check_and_verifies_opt_in(self):
        before, after = "a" * 64, "b" * 64
        plan = {"before": {"assetsSha256": before},
                "files": dict.fromkeys(remote.REDEEM_PRESENTATION_FILES, "c" * 64)}
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_assets_changed"):
            remote.require_asset_digest(plan, after)
        plan["redeemPresentation"] = {"beforeAssetsSha256": before, "assetsSha256": after}
        remote.require_asset_digest(plan, after)
        for changed in (plan | {"adapter": {"runtimeFiles": []}}, plan | {"files": {}},
                        plan | {"before": {"assetsSha256": "d" * 64}}):
            with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_approval_mismatch"):
                remote.require_asset_digest(changed, after)

    def test_security_canary_enrolls_a_factor_before_sensitive_actions(self):
        source = """  const login = await send('/api/local/auth/login', {method:'POST',body:credentials});
  assert.equal(login.status,200);
  const session = login.headers['set-cookie'][0].split(';')[0];
  await send('/api/local/auth/employees',{method:'POST',session,body:isolatedStaff});
"""
        configured = remote.wire_canary_authenticator(source)
        self.assertIn("assert.equal(JSON.parse(beforeSecurity.body).bound,false);", configured)
        self.assertIn("assert.equal(JSON.parse(verified.body).recentlyVerified,true);", configured)
        self.assertLess(configured.index("'/api/local/auth/security/confirm'"),
                        configured.index("'/api/local/auth/employees'"))
        self.assertEqual(remote.wire_canary_authenticator(configured), configured)
        with self.assertRaisesRegex(remote.ReleaseError, "isolated_login_contract_changed"):
            remote.wire_canary_authenticator("different login flow")

    def test_stages_active_website_launchers_and_switches_to_the_prepared_path(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            live = root / "releases" / BASE
            active = live / "operations-mailbox-public-20261112"
            active.mkdir(parents=True)
            (live / "source/frontend").mkdir(parents=True)
            (live / "source/frontend/index.html").write_text('<link href="./prototype.css?v=old">')
            tools_stream = '  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"\n'
            launchers = {"run-app": f"sha={BASE}\nops=$release/{active.name}\n{tools_stream}",
                         "app-entry.mjs": ANALYTICS_LAUNCHER + "\n// active mailbox entry\n",
                         "check-app.mjs": "assert(index.includes('prototype.css?v=old'));\n"}
            for name, content in launchers.items():
                (active / name).write_text(content)
            dropin = root / "website.conf"
            dropin.write_text(f"[Service]\nExecStart=\nExecStart={active / 'run-app'} live\n")
            release_dir = root / "releases" / TARGET
            assets_name = f"independent-assets-{TARGET}.json"
            source_name = f"independent-source-{TARGET}.tar.gz"
            artifacts = {assets_name: b"{}", source_name: b"synthetic archive"}
            index = b'<link href="./prototype.css?v=new">'

            def digest(data):
                return hashlib.sha256(data).hexdigest()

            def run(args, **_options):
                if args[0] == "aws":
                    destination = Path(args[4])
                    destination.write_bytes(artifacts[destination.name])
                else:
                    frontend = Path(args[-1]) / "frontend"
                    frontend.mkdir()
                    (frontend / "index.html").write_bytes(index)

            plan = {"sha": TARGET, "files": {"frontend/index.html": digest(index)},
                    "before": {"components": {"app": {"revision": BASE}},
                               "assetsSha256": digest(artifacts[assets_name]),
                               "launchers": {name: digest(content.encode()) for name, content in launchers.items()}},
                    "artifacts": {name: {"bytes": len(data), "sha256": digest(data)}
                                  for name, data in artifacts.items()}}
            with patch.multiple(remote, ROOT=root, DROP=dropin, run=run,
                                mount_backup_monitoring=lambda content: content,
                                mount_storefront_admission=lambda content: content):
                _, operations = remote.stage(plan, release_dir)
                self.assertEqual(remote.website_release_dropin(dropin.read_text(), BASE, operations / "run-app"),
                                 f"[Service]\nExecStart=\nExecStart={operations / 'run-app'} live\n")
            self.assertEqual((operations / "run-app").read_text(), remote.normalize_tools_credential_stream(
                f"sha={TARGET}\nops=$release/operations\n{tools_stream}"))
            self.assertEqual((operations / "app-entry.mjs").read_text(),
                             remote.wire_storefront_analytics(launchers["app-entry.mjs"]))
            self.assertIn("prototype.css?v=new", (operations / "check-app.mjs").read_text())

    def test_rejects_unrecognized_or_multiple_website_start_commands(self):
        launcher = remote.ROOT / "releases" / BASE / "operations/run-app"
        for content in ("ExecStart=/usr/bin/other\n",
                        f"ExecStart={launcher} live\nExecStart=/usr/bin/other\n"):
            with self.assertRaisesRegex(remote.ReleaseError, "live_website_launcher_unrecognized"):
                remote.website_launcher(content, BASE)

    def test_table_actions_release_rejects_missing_source_proof_or_a_second_scope(self):
        before, after = "a" * 64, "b" * 64
        approval = {"beforeAssetsSha256": before, "assetsSha256": after}
        plan = {"before": {"assetsSha256": before}, "tableActionsPresentation": approval,
                "files": {remote.TABLE_ACTIONS_STYLESHEET: "c" * 64}}
        self.assertEqual(remote.require_asset_digest(plan, after), "tableActionsPresentation")
        for changed in (plan | {"files": {}}, plan | {"redeemPresentation": approval},
                        plan | {"adapter": {"runtimeFiles": []}}):
            with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_approval_mismatch"):
                remote.require_asset_digest(changed, after)

    def test_presentation_bundle_keeps_other_pages_and_upstream_identical(self):
        base = {name: {"body": "old"} for name in {*remote.REDEEM_PRESENTATION_ASSETS, "/redeem", "/admin"}}
        candidate = base | {name: {"body": "new"} for name in remote.REDEEM_PRESENTATION_ASSETS}
        bundle = lambda assets, revision=remote.PINNED_UPSTREAM: Mock(
            read_bytes=lambda: json.dumps({"revision": revision, "assets": assets}).encode())
        remote.verify_presentation_bundle(bundle(base), bundle(candidate), remote.REDEEM_PRESENTATION_ASSETS)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(base), bundle(candidate | {"/redeem": {"body": "changed"}}),
                                              remote.REDEEM_PRESENTATION_ASSETS)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(base), bundle(candidate, TARGET), remote.REDEEM_PRESENTATION_ASSETS)
        table_assets = remote.PRESENTATION_SCOPES["tableActionsPresentation"][1]
        remote.verify_presentation_bundle(bundle(base), bundle(base | {"/shell.css": {"body": "new"}}), table_assets)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(base), bundle(candidate), table_assets)
        card_assets = remote.PRESENTATION_SCOPES["cardImportPresentation"][1]
        previous = base | {"/admin.js": {"body": "old"}}
        changed = previous | {name: {"body": "new"} for name in card_assets}
        remote.verify_presentation_bundle(bundle(previous), bundle(changed), card_assets)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(previous), bundle(changed | {"/workspace": {"body": "new"}}),
                                              card_assets)
        card_plan_assets = remote.PRESENTATION_SCOPES["cardPlanPresentation"][1]
        remote.verify_presentation_bundle(bundle(previous), bundle(changed), card_plan_assets)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(previous), bundle(changed | {"/redeem": {"body": "new"}}),
                                              card_plan_assets)
        checkout_assets = remote.PRESENTATION_SCOPES["checkoutDiagnosticPresentation"][1]
        remote.verify_presentation_bundle(bundle(previous), bundle(changed), checkout_assets)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(previous), bundle(changed | {"/workspace": {"body": "new"}}),
                                              checkout_assets)
        task_history_assets = remote.PRESENTATION_SCOPES["taskHistoryPresentation"][1]
        task_history = previous | {path: {"body": "new"} for path in ("/admin", "/admin.js")}
        remote.verify_presentation_bundle(bundle(previous), bundle(task_history), task_history_assets)
        with self.assertRaisesRegex(remote.ReleaseError, "recharge_presentation_bundle_scope_mismatch"):
            remote.verify_presentation_bundle(bundle(previous), bundle(task_history | {"/workspace": {"body": "new"}}),
                                              task_history_assets)

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

    @patch("remote.switch_adapter")
    @patch("remote.install_backup_monitoring")
    @patch("remote.adapter_canary", side_effect=remote.ReleaseError("adapter_canary_failed"))
    @patch("remote.canary")
    @patch("remote.stage", return_value=(Path("/stage/source"), Path("/stage/operations")))
    @patch("remote.snapshot")
    def test_adapter_canary_failure_prevents_production_switch(self, snapshot, stage, canary, adapter_canary,
                                                               install_backup_monitoring, switch_adapter):
        before = {"components": {"app": {"revision": BASE}}, "unitSha256": "unit",
                  "gatewaySha256": "gateway", "assetsSha256": "assets", "launchers": {},
                  "adapterUnit": {"commandSha256": "previous"}}
        snapshot.return_value = before
        plan = {"sha": TARGET, "before": before, "adapter": {"runtimeFiles": []}}
        with self.assertRaisesRegex(remote.ReleaseError, "adapter_canary_failed"):
            remote.release_website(plan)
        snapshot.assert_called_once_with(True)
        canary.assert_called_once_with(TARGET, Path("/stage/operations"))
        adapter_canary.assert_called_once_with(plan, *stage.return_value)
        install_backup_monitoring.assert_not_called()
        switch_adapter.assert_not_called()

    def test_adapter_override_uses_exact_candidate_and_existing_native_runtime(self):
        image = "sha256:" + "c" * 64
        content = remote.adapter_override(TARGET, BASE, image)
        self.assertEqual(content.splitlines(), ["[Service]", "ExecStart=",
            f"ExecStart=/usr/bin/python3 {remote.ROOT}/releases/{TARGET}/source/deploy/recharge-core/run-recharge.py"
            f" adapter {TARGET} {BASE} {image}"])

    def test_runtime_mount_must_match_exact_readonly_source(self):
        source = Path("/opt/id-business-independent/releases") / TARGET / "source"
        mount = {"Source": str(source), "Destination": "/app", "RW": False}
        self.assertTrue(remote.mount_matches({"Mounts": [mount]}, source, "/app"))
        self.assertFalse(remote.mount_matches({"Mounts": [mount | {"RW": True}]}, source, "/app"))
        self.assertFalse(remote.mount_matches({"Mounts": [mount]}, source.parent, "/app"))

    def test_only_the_live_launcher_gets_the_readonly_monitor_mount(self):
        live = '  state=(--mount "type=bind,src=$formal/data,dst=/state")'
        canary = '  state=(--tmpfs "/state:rw,size=32m")'
        launcher = live + "\n" + canary
        result = remote.mount_backup_monitoring(launcher)
        self.assertIn(remote.MONITORING_MOUNT, result)
        self.assertIn(remote.MONITORING_ENV, result)
        self.assertTrue(result.endswith(canary))
        self.assertEqual(remote.mount_backup_monitoring(result), result)
        with self.assertRaisesRegex(remote.ReleaseError, "unexpected_backup_monitoring_launcher"):
            remote.mount_backup_monitoring(canary)

    def test_only_the_live_app_gets_the_private_admission_socket(self):
        live = '  state=(--mount "type=bind,src=$formal/data,dst=/state")'
        canary = '  state=(--tmpfs "/state:rw,size=32m")'
        result = remote.mount_storefront_admission(remote.mount_backup_monitoring(live + "\n" + canary))
        self.assertIn('state+=(-e "ID_VENDURE_ADMISSION_DIRECTORY=/state/vendure-admission")', result)
        self.assertTrue(result.endswith(canary))
        self.assertEqual(remote.mount_storefront_admission(remote.mount_backup_monitoring(result)), result)
        with self.assertRaisesRegex(remote.ReleaseError, "unexpected_storefront_admission_launcher"):
            remote.mount_storefront_admission(result + "\n" + remote.ADMISSION_ENV)

    def test_gateway_launcher_changes_only_its_source_and_mounts_the_admission_socket_readonly(self):
        before, target = "a" * 40, "b" * 40
        old = f"sha={before}\n" + vendure_admission.LAUNCHER_ANCHOR + "\n  node\n"
        new = vendure_admission.stage_launcher(old, before, target)
        self.assertIn(f"sha={target}\n", new)
        self.assertIn(vendure_admission.LAUNCHER_ANCHOR, new)
        self.assertIn('dst=/run/id-vendure-admission,readonly', new)
        self.assertIn('ID_VENDURE_ADMISSION_SOCKET=/run/id-vendure-admission/lookup.sock', new)
        self.assertTrue(new.endswith("\n  node\n"))
        with self.assertRaisesRegex(remote.ReleaseError, "gateway_launcher_changed"):
            vendure_admission.stage_launcher(new, target, before)

    def test_gateway_drain_fences_writers_and_preserves_tasks(self):
        runtime = Path(__file__).resolve().parents[2] / ".runtime"
        runtime.mkdir(exist_ok=True)
        with TemporaryDirectory(dir=runtime) as directory:
            file = Path(directory) / vendure_admission.SQLITE_FILENAME
            writer = sqlite3.connect(file, timeout=0)
            try:
                writer.execute("CREATE TABLE vendure_recharge_isolated_state(id INTEGER, revision INTEGER, payload TEXT)")
                table = "vendure_recharge_isolated_state"
                writer.execute(f"INSERT INTO {table} VALUES(1, 3, ?)", ('{"tasks":[{"status":"succeeded"}]}',))
                writer.commit()
                with vendure_admission.lock_idle_queue(file) as retained:
                    self.assertEqual(retained, 1)
                    with self.assertRaisesRegex(sqlite3.OperationalError, "database is locked"):
                        writer.execute(f"UPDATE {table} SET payload = ''")
                writer.execute(f"UPDATE {table} SET payload = ?", ('{"tasks":[{"status":"running"}]}',))
                writer.commit()
                with self.assertRaisesRegex(remote.ReleaseError, "gateway_queue_not_idle"):
                    with vendure_admission.lock_idle_queue(file):
                        self.fail("active tasks must block the gateway cutover")
                self.assertEqual(json.loads(writer.execute(f"SELECT payload FROM {table}").fetchone()[0]),
                                 {"tasks": [{"status": "running"}]})
            finally:
                writer.close()

    @patch.object(vendure_admission, "inspect")
    @patch.object(vendure_admission, "read_idle_queue", side_effect=[(20, 0), (21, 0)])
    @patch.object(vendure_admission, "run")
    @patch.object(vendure_admission, "worker_binding", return_value=(b"original", "launcher-hash"))
    def test_worker_is_started_with_its_original_runtime_and_poll_observed(self, binding, run, queue, inspect):
        inspect.return_value = {"State": {"Running": True}, "Config": {"User": "993:992"}, "Image": "image",
                                "Mounts": [{"Destination": "/app", "Source": "/old/source", "RW": False}]}
        vendure_admission.resume_worker(binding.return_value, ("image", "993:992", "/old/source"), 0)
        run.assert_called_once_with(["systemctl", "start", vendure_admission.WORKER_UNIT], timeout=35)
        self.assertEqual(queue.call_count, 2)

    def test_mysql_projection_requires_the_verified_pair_and_exposes_only_times(self):
        captured = "20261111T073000Z"
        receipt = {
            "capturedAt": captured,
            "verifiedAt": "2026-11-11T07:30:04+00:00",
            "key": f"mysql/daily/independent-recharge/{captured}/{TARGET}/manifest.json",
            "cipherSha256": "a" * 64,
            "blobVersionId": "fixture-blob-version",
            "manifestVersionId": "fixture-manifest-version",
        }
        report = backup_monitoring.mysql_fields(receipt)
        self.assertEqual(set(report), {"capturedAt", "verifiedAt"})
        self.assertEqual(report["verifiedAt"] - report["capturedAt"], 4000)
        self.assertIsNone(backup_monitoring.mysql_fields(receipt | {"manifestVersionId": "null"}))
        self.assertIsNone(backup_monitoring.mysql_fields(receipt | {"verifiedAt": "2026-11-11T07:29:59+00:00"}))
        recovery = {"key": receipt["key"].removesuffix("manifest.json") + "recovery-state.idbackup",
                    "versionId": "fixture-capsule-version", "cipherSha256": "c" * 64, "cipherBytes": 4096}
        paired = receipt | {"recoveryStateStatus": "verified", "recoveryState": recovery}
        self.assertEqual(backup_monitoring.mysql_fields(paired)["recoveryStatus"], "verified")
        self.assertEqual(backup_monitoring.mysql_fields(receipt | {"recoveryStateStatus": "capture_failed"})[
            "recoveryStatus"], "capture_failed")
        for changes in ({"key": "unrelated/recovery-state.idbackup"}, {"versionId": "null"},
                        {"cipherBytes": 0}, {"cipherBytes": True}, {"cipherSha256": "bad"}):
            self.assertEqual(backup_monitoring.mysql_fields(paired | {"recoveryState": recovery | changes})[
                "recoveryStatus"], "missing")

    def test_recovery_receipt_limit_is_bounded_and_projection_stays_small(self):
        runtime = Path(__file__).resolve().parents[2] / ".runtime"
        runtime.mkdir(exist_ok=True)
        with TemporaryDirectory(dir=runtime) as directory:
            file = Path(directory) / "receipt.json"
            file.write_text(json.dumps({"fixture": "x" * 2048}))
            file.chmod(0o600)
            self.assertIsNone(backup_monitoring.read_receipt(file, os.geteuid()))
            self.assertIsNotNone(backup_monitoring.read_receipt(file, os.geteuid(), 16384))
            file.write_text(json.dumps({"fixture": "x" * 16384}))
            self.assertIsNone(backup_monitoring.read_receipt(file, os.geteuid(), 16384))

    def test_sheets_projection_uses_timestamped_worker_outcomes(self):
        verified = '{"status":"verified","writes":0,"rows":{"邮箱管理":1,"账号管理":2,"订单管理":3,"客户管理":4}}'
        retry = '{"status":"retry","code":"SHEETS_SYNC_FAILED"}'
        result = backup_monitoring.sheets_fields("\n".join([
            f"2026-11-12T03:04:00.500000000Z {retry}",
            f"2026-11-12T03:00:00.200000000Z {verified}",
            f"2026-11-12T03:02:00.300000000Z {retry}",
            '2026-11-12T03:05:00Z {"status":"verified","private":"fixture-only"}',
            '2026-11-12T03:06:00Z unrelated output',
        ]))
        self.assertEqual(result["at"] - result["verifiedAt"], 240_300)
        self.assertEqual(result["failures"], 2)
        self.assertEqual(set(result), {"at", "verifiedAt", "failures", "integrityFailure"})
        self.assertIsNone(backup_monitoring.sheets_fields('{"status":"verified"}'))
        recovered = backup_monitoring.sheets_fields(
            f"2026-11-12T03:02:00Z {retry}\n2026-11-12T03:04:00Z {verified}")
        self.assertEqual(recovered["verifiedAt"], recovered["at"])
        self.assertEqual(recovered["failures"], 0)
        mismatch = '{"status":"retry","code":"SHEETS_HEADER_MISMATCH"}'
        invalid_source = '{"status":"integrity-failed","code":"SHEETS_SOURCE_REPLACED"}'
        stale = backup_monitoring.sheets_fields(
            f"2026-11-12T03:00:00Z {verified}\n2026-11-12T03:02:00Z {mismatch}")
        self.assertEqual(stale["failures"], 1)
        self.assertTrue(stale["integrityFailure"])
        self.assertTrue(backup_monitoring.sheets_fields(
            f"2026-11-12T03:02:00Z {invalid_source}\n2026-11-12T03:04:00Z {retry}")["integrityFailure"])
        self.assertFalse(backup_monitoring.sheets_fields(
            f"2026-11-12T03:02:00Z {mismatch}\n2026-11-12T03:04:00Z {verified}")["integrityFailure"])

    def test_canary_diagnostic_outputs_only_recognized_indicators_and_locations(self):
        result = remote.canary_diagnostics("AssertionError [ERR_ASSERTION]: synthetic secret input\n"
                                           "at /ops/check-app.mjs:24:5\n"
                                           "prototype.css?v=20261111-confirmed-orders")
        self.assertEqual(result, {"indicators": ["assertion"], "frames": [["check-app.mjs", "24", "5"]],
                                  "assets": ["prototype.css?v=20261111-confirmed-orders"]})

    @patch("remote.time.sleep")
    @patch("remote.subprocess.run")
    def test_canary_retries_mailbox_unavailable_once_and_requires_success(self, run, sleep):
        unavailable = "RelayError: Vendure 邮箱服务暂时不可用，请重试\n"
        for second_exit in (0, 1):
            with self.subTest(second_exit=second_exit), TemporaryDirectory(dir=Path(__file__).parent) as directory:
                ops = Path(directory)
                run.reset_mock()
                sleep.reset_mock()

                def canary_attempt(command, *, stdout, **kwargs):
                    self.assertEqual(command[-2:], [str(ops / "run-app"), "canary"])
                    if stdout.name.endswith(remote.CANARY_LOG):
                        stdout.write(unavailable.encode())
                        return Mock(returncode=1)
                    return Mock(returncode=second_exit)

                run.side_effect = canary_attempt
                if second_exit:
                    with self.assertRaisesRegex(remote.ReleaseError, "isolated_app_canary_failed"):
                        remote.canary(TARGET, ops)
                else:
                    self.assertTrue(remote.canary(TARGET, ops))
                self.assertEqual(run.call_count, 2)
                self.assertNotEqual(run.call_args_list[0].args[0][4], run.call_args_list[1].args[0][4])
                self.assertLessEqual(run.call_args_list[1].kwargs["timeout"], run.call_args_list[0].kwargs["timeout"])
                self.assertTrue((ops / remote.CANARY_RETRY_LOG).is_file())
                sleep.assert_called_once_with(30)
        self.assertEqual(remote.canary_diagnostics(unavailable)["indicators"], ["vendure_mailbox_unavailable"])

    @patch("remote.subprocess.run")
    def test_canary_does_not_retry_mailbox_authorization_or_page_assertion(self, run):
        for error in ("RelayError: Vendure 邮箱授权无效或权限不足", "AssertionError: page assertion"):
            with self.subTest(error=error), TemporaryDirectory(dir=Path(__file__).parent) as directory:
                ops = Path(directory)
                run.reset_mock()

                def canary_failure(command, *, stdout, **kwargs):
                    stdout.write(error.encode())
                    return Mock(returncode=1)

                run.side_effect = canary_failure
                with self.assertRaisesRegex(remote.ReleaseError, "isolated_app_canary_failed"):
                    remote.canary(TARGET, ops)
                run.assert_called_once()
                self.assertFalse((ops / remote.CANARY_RETRY_LOG).exists())

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
