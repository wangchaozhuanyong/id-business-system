import hashlib
import json
import sqlite3
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

import release
import remote
import backup_monitoring
import vendure_admission

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

    def test_only_the_live_app_prepares_and_mounts_the_analytics_credential(self):
        live = f'  state+=(-e "{remote.ADMISSION_ENV}")'
        canary = '  state=(--tmpfs "/state:rw,size=32m")'
        launcher = remote.mount_storefront_analytics(live + "\n" + canary)
        self.assertEqual(remote.mount_storefront_analytics(launcher), launcher)
        self.assertIn(remote.CLOUDFLARE_CREDENTIAL.name, launcher)
        self.assertIn('--prepare-storefront-analytics || exit 1', launcher)
        self.assertIn(remote.storefront_analytics_mount(remote.CLOUDFLARE_CONFIG), launcher)
        self.assertTrue(launcher.endswith(canary))
        subprocess.run(["bash", "-n"], input=launcher, text=True, check=True)
        with self.assertRaisesRegex(remote.ReleaseError, "unexpected_storefront_analytics_launcher"):
            remote.mount_storefront_analytics(canary)

    def test_analytics_credential_decrypts_to_a_private_file_and_never_replaces_it_on_failure(self):
        runtime = Path(__file__).resolve().parents[2] / ".runtime"
        runtime.mkdir(exist_ok=True)
        credential = (1, 2, 3, 4, 5)
        with TemporaryDirectory(dir=runtime) as directory:
            target = Path(directory) / "cloudflare.json"
            synthetic = b'{"apiToken":"synthetic-local-only"}'
            data = SimpleNamespace(st_mode=0o40700, st_uid=123, st_gid=124)

            def decrypt(args, stdout, **_):
                self.assertEqual(args, ["systemd-creds", "decrypt",
                                        "--name=" + remote.CLOUDFLARE_CREDENTIAL_NAME,
                                        str(remote.CLOUDFLARE_CREDENTIAL), "-"])
                stdout.write(synthetic)
                stdout.flush()

            with patch.object(remote, "storefront_analytics_credential", return_value=credential), \
                 patch.object(remote.Path, "lstat", return_value=data), \
                 patch.object(remote.os, "fchown") as chown, \
                 patch.object(remote.subprocess, "run", side_effect=decrypt) as command:
                remote.materialize_storefront_analytics(target, credential)
                chown.assert_called_once_with(unittest.mock.ANY, 123, 124)
                command.side_effect = subprocess.CalledProcessError(1, "systemd-creds")
                with self.assertRaises(subprocess.CalledProcessError):
                    remote.materialize_storefront_analytics(target, credential)
            self.assertEqual(target.read_bytes(), synthetic)
            self.assertEqual(target.stat().st_mode & 0o777, 0o400)
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_analytics_probe_reads_only_the_candidate_and_a_temporary_private_file(self):
        runtime = Path(__file__).resolve().parents[2] / ".runtime"
        runtime.mkdir(exist_ok=True)
        with TemporaryDirectory(dir=runtime) as directory:
            root = Path(directory)
            reports = {"damatong.net:7": "ready", "damatong.net:30": "empty"}
            with patch.object(remote, "storefront_analytics_runtime_directory", return_value=root), \
                 patch.object(remote, "materialize_storefront_analytics") as prepare, \
                 patch.object(remote, "run", return_value=json.dumps(reports).encode()) as run:
                actual = remote.verify_storefront_analytics(Path("/candidate"), "image-sha", "123:124", (1, 2))
            self.assertEqual(actual, reports)
            config = prepare.call_args.args[0]
            self.assertEqual(config.parent.parent, root)
            args = run.call_args.args[0]
            self.assertEqual(args[:6], ["docker", "run", "--rm", "--read-only", "--user", "123:124"])
            self.assertIn("type=bind,src=/candidate,dst=/app,readonly", args)
            self.assertIn(remote.storefront_analytics_mount(config), args)
            self.assertIn(remote.CLOUDFLARE_ENV, args)
            self.assertNotIn("/state", " ".join(args))
            self.assertFalse(config.parent.exists())

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
