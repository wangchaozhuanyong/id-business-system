"""Pure control contracts; all database/runtime objects here are synthetic."""
import copy
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

HERE = Path(__file__).parent


def load(filename):
    path = HERE / filename
    spec = importlib.util.spec_from_file_location('first_consumer_test', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


class FirstRechargeConsumerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = load('first-recharge-successor.py')

    def origin(self):
        c = self.c
        return {'version': 1, 'scope': c.ORIGIN_SCOPE, 'authenticated': True,
            'apiAuthority': c.history.sealed_authority(), 'adminAuthority': c.history.admin_successor_authority(),
            'migration': {'name': c.MIGRATION_NAME, 'sha256': c.MIGRATION_IDENTITY['sha256'],
                'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': 'a' * 64},
            'databaseGrants': {'preservedGrantsSha256': 'b' * 64, 'schemaGrantsSha256': 'c' * 64,
                'newTablePrivileges': [{'grantee': "'id_business_app'@'%'", 'table': c.MIGRATION_TABLE,
                    'privilege': privilege, 'grantable': 'NO'} for privilege in ('INSERT', 'SELECT', 'UPDATE')]}}

    def test_original_core_and_authorities_remain_cold(self):
        original = self.c.history.load_core()
        self.assertEqual(original.SCOPE, 'UNPUBLISHED_API_ADMIN_COMPONENT_SUCCESSOR')
        self.assertEqual(original.PREFIX, 'unpublished-component-successor')
        self.assertNotEqual(original.APPLICATION_SOURCE, self.c.APPLICATION_SOURCE)
        self.assertEqual(self.c.digest(Path(original.__file__).read_bytes()), self.c.history.sealed_authority()['coreSha256'])
        self.assertEqual(self.c.reused.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'))
        self.assertEqual(self.c.reused.IMAGE_SERVICES, ('api', 'admin', 'migrate'))
        self.assertEqual(self.c.reused.APPLICATION_INPUT_COUNT, 2192)
        self.assertEqual(self.c.reused.COMPONENT_PREDECESSOR, self.c.history.admin_successor_authority())
        self.assertNotEqual(original.COMPONENT_PREDECESSOR, self.c.reused.COMPONENT_PREDECESSOR)

    def test_exact_mixed_predecessor_is_admitted_without_role_relabeling(self):
        origin = self.origin()
        evidence = {'componentSuccessorOrigin': origin, 'currentCommit': self.c.projection.ADMIN_COMMIT,
                    'apiCurrentSourceCommit': self.c.projection.API_COMMIT}
        self.assertIs(self.c.component_successor_origin(evidence), origin)
        for key, value in (('currentCommit', self.c.projection.API_COMMIT),
                           ('apiCurrentSourceCommit', self.c.projection.ADMIN_COMMIT)):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'COMPONENT_PAIR_CHANGED'):
                self.c.component_successor_origin({**evidence, key: value})

    def test_pair_authority_cannot_be_resealed_to_different_native_receipt(self):
        for role in ('apiAuthority', 'adminAuthority'):
            for field in ('invocationBytesSha256', 'receiptSha256', 'commandId', 'producer'):
                origin = self.origin()
                origin[role][field] = '0' * 64
                with self.subTest(role=role, field=field), self.assertRaisesRegex(RuntimeError, 'COMPONENT_PAIR_CHANGED'):
                    self.c.component_successor_origin({'componentSuccessorOrigin': origin})

    def test_missing_false_extra_or_pending_origin_is_rejected(self):
        fixtures = [None, {}, {**self.origin(), 'authenticated': False}, {**self.origin(), 'extra': True}]
        pending = self.origin(); pending['migration']['status'] = 'PENDING'; fixtures.append(pending)
        for origin in fixtures:
            with self.subTest(origin=origin), self.assertRaises(RuntimeError):
                self.c.component_successor_origin({'componentSuccessorOrigin': origin})

    def test_grant_mutation_or_privilege_expansion_is_rejected(self):
        for mutation in ('DELETE', 'grantable', 'hash'):
            origin = self.origin()
            if mutation == 'DELETE':
                origin['databaseGrants']['newTablePrivileges'].append({'privilege': 'DELETE'})
            elif mutation == 'grantable':
                origin['databaseGrants']['newTablePrivileges'][0]['grantable'] = 'YES'
            else:
                origin['databaseGrants']['schemaGrantsSha256'] = None
            with self.subTest(mutation=mutation), self.assertRaisesRegex(RuntimeError, 'GRANTS_ORIGIN_CHANGED'):
                self.c.component_successor_origin({'componentSuccessorOrigin': origin})

    def test_applied_schema_path_never_runs_migration_or_grants(self):
        origin = self.origin()
        d = SimpleNamespace(migration_plan=Mock(return_value=[]), compose=Mock(side_effect=AssertionError('DB mutation')),
            sync_new_table_grants=Mock(side_effect=AssertionError('GRANT')))
        with patch.object(self.c.reused, 'migration_source_check'), \
                patch.object(self.c.reused, 'migration_database_state', return_value=origin['migration']), \
                patch.object(self.c.reused, 'grant_state', return_value=origin['databaseGrants']):
            result = self.c.apply_migration(d, object(), Path('/before'), Path('/after'), origin)
        self.assertFalse(result['performed'])
        self.assertEqual(result['grants'], {'status': 'EXISTING_GRANTS_READONLY_VERIFIED', 'mutationPerformed': False})
        d.compose.assert_not_called(); d.sync_new_table_grants.assert_not_called()

    def test_schema_change_and_stale_grants_stop_before_any_mutation(self):
        origin = self.origin()
        for migration_plan, grants in ((['unexpected/migration.sql'], origin['databaseGrants']),
                                       ([], {**origin['databaseGrants'], 'schemaGrantsSha256': '0' * 64})):
            d = SimpleNamespace(migration_plan=Mock(return_value=migration_plan), compose=Mock(), sync_new_table_grants=Mock())
            with patch.object(self.c.reused, 'migration_source_check'), \
                    patch.object(self.c.reused, 'migration_database_state', return_value=origin['migration']), \
                    patch.object(self.c.reused, 'grant_state', return_value=grants), self.assertRaises(RuntimeError):
                self.c.apply_migration(d, object(), Path('/before'), Path('/after'), origin)
            d.compose.assert_not_called(); d.sync_new_table_grants.assert_not_called()

    def test_missing_retained_origin_cannot_fall_into_legacy_migration(self):
        d = SimpleNamespace(migration_plan=Mock(), compose=Mock(), sync_new_table_grants=Mock())
        with self.assertRaisesRegex(RuntimeError, 'COMPONENT_PAIR_CHANGED'):
            self.c.apply_migration(d, object(), Path('/before'), Path('/after'), None)
        d.migration_plan.assert_not_called(); d.compose.assert_not_called(); d.sync_new_table_grants.assert_not_called()

    def test_formal_cli_requires_independent_recovery_permission_before_release(self):
        with patch.object(self.c.reused, 'release') as release, self.assertRaisesRegex(RuntimeError, 'API_FAULT_RESTORE_APPROVAL_REQUIRED'):
            self.c.cli(['release'])
        release.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
            self.c.cli(['bind-restoration'])

    def test_predecessor_mismatch_fails_before_live_reads(self):
        d = SimpleNamespace(BASE=MagicMock())
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_CHANGED'):
            self.c.baseline(d, object(), object(), self.c.projection.API_COMMIT)
        d.BASE.__truediv__.assert_not_called()

    def test_migration_image_summary_uses_api_role_only(self):
        output = {'api/apps/api/prisma-mysql/schema.prisma': (b'schema', '100644'),
                  'api/apps/api/prisma-mysql/migrations/a/migration.sql': (b'sql', '100644'),
                  'admin/apps/api/prisma-mysql/schema.prisma': (b'wrong-role', '100644')}
        original = self.c.history.load_core()
        expected = original.migration_image_content(None, {key[4:]: row for key, row in output.items() if key.startswith('api/')})
        self.assertEqual(self.c.migration_image_content(None, output), expected)
        self.assertEqual(expected['fileCount'], 2)

    def test_fresh_baseline_requires_original_readback_and_all_live_guards(self):
        # Historical authenticity is independently covered by the cold sealed
        # consumer. This synthetic fixture tests the new live composition only.
        c = self.c
        runtime = HERE.parent.parent / '.runtime/first-recharge-release-20261014'
        runtime.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='baseline-contract-', dir=runtime) as owned:
            root = Path(owned); current = root / 'releases/admin'; old = root / 'releases/api'
            current.mkdir(parents=True); old.mkdir()
            (root / 'current').symlink_to(current)
            (current / 'config.txt').write_bytes(b'synthetic runtime config')
            origin = self.origin()
            states = {role: {'image': 'image-' + role, 'reference': 'reference-' + role} for role in c.SERVICES}
            images = {role: {'imageId': states[role]['image'], 'reference': states[role]['reference'],
                            'fileCount': 1, 'sha256': 'd' * 64} for role in c.UPDATED}
            volume = {'name': 'synthetic-volume'}
            markers = {name: {'synthetic': name} for name in
                       c.load('baseline_test_cold_admin', 'admin-pending-online-release.py').ORIGIN_MARKERS}
            manifest = {'commit': c.projection.ADMIN_COMMIT, 'previousCommit': c.projection.API_COMMIT,
                'previousRelease': str(old), 'sourceArchiveSha256': 'b' * 64,
                'adminPublication': {'synthetic': True}, **markers}
            admin_raw = json.dumps(manifest).encode(); api_raw = b'synthetic-api-manifest'
            api_files = {'synthetic.txt': (b'ordinary source', '100644')}
            ledger = {'sourceArchiveSha256': 'a' * 64, 'sourceFilesSha256': c.fingerprint(c.projection.inventory(api_files)),
                'baseline': {'configurationFilesSha256': {'config.txt': 'ignored-old-hash'},
                             'originMarkersSha256': c.fingerprint(markers)}}
            authenticated = {'receipt': {'migration': origin['migration']},
                'manifest': {'apiComponentPublication': ledger}, 'proof': {'images': images},
                'preservation': {'after': states, 'workspaceVolumeAfter': volume,
                    'migration': {'grantProtection': origin['databaseGrants']}}}
            receipt = {'synthetic': 'original-admin-readback'}
            successor = {'receipt': receipt, 'proof': {'image': images['admin']}}
            reader = SimpleNamespace(readback=Mock(return_value=receipt))
            workspace = SimpleNamespace(**{name: Mock() for name in ('workspace_idle', 'workspace_audit_protection',
                'workspace_private_inspect')}, snapshot=Mock(return_value=states),
                workspace_volume=Mock(return_value=volume), jobs_idle=Mock(return_value={'registrationBusy': False}))
            d = SimpleNamespace(BASE=root, compose=Mock(return_value=''))
            admin = SimpleNamespace(ORIGIN_MARKERS=tuple(markers))
            digest = c.projection.digest
            def bytes_at(path, **kwargs):
                if path == current / 'release-manifest.json':
                    return admin_raw
                if path == old / 'release-manifest.json':
                    return api_raw
                return b'synthetic-private-' + path.name.encode()
            def hashes(raw):
                if raw == admin_raw:
                    return c.history.admin_successor_authority()['manifestBytesSha256']
                if raw == api_raw:
                    return c.history.sealed_authority()['manifestBytesSha256']
                return digest(raw)
            with ExitStack() as stack:
                stack.enter_context(patch.object(c.reused, 'private_bytes', side_effect=bytes_at))
                stack.enter_context(patch.object(c.projection, 'digest', side_effect=hashes))
                api_auth = stack.enter_context(patch.object(c.history, 'authenticate_component_records', return_value=authenticated))
                admin_auth = stack.enter_context(patch.object(c.history, 'authenticate_admin_records', return_value=successor))
                stack.enter_context(patch.object(c, 'archived_controller', side_effect=lambda _d, directory, *args:
                    (reader, api_files, 'b' * 64) if directory == current else (object(), api_files, 'a' * 64)))
                content = stack.enter_context(patch.object(c.reused, 'image_content'))
                stack.enter_context(patch.object(c.reused, 'configuration_model', return_value={'synthetic': True}))
                stack.enter_context(patch.object(c.reused, 'migration_source_check'))
                stack.enter_context(patch.object(c.reused, 'migration_database_state', return_value=origin['migration']))
                stack.enter_context(patch.object(c.reused, 'grant_state', return_value=origin['databaseGrants']))
                before, _manifest, evidence = c.baseline(d, admin, workspace, c.projection.ADMIN_COMMIT)
                self.assertEqual(before, current)
                self.assertEqual(evidence['currentCommit'], c.projection.ADMIN_COMMIT)
                self.assertEqual(evidence['apiCurrentSourceCommit'], c.projection.API_COMMIT)
                self.assertIsNone(evidence['restorationBinding'])
                self.assertEqual(evidence['services'], states)
                api_auth.assert_called_once(); admin_auth.assert_called_once()
                reader.readback.assert_called_once_with(d, c.projection.ADMIN_COMMIT)
                self.assertEqual(content.call_count, 2)
                workspace.workspace_private_inspect.assert_called_once_with(d, current, states['api']['reference'], volume['name'])
                workspace.workspace_idle.assert_called_once(); workspace.workspace_audit_protection.assert_called_once()
                # A website health receipt alone cannot satisfy original reader
                # identity, and an idle/audit failure cannot yield a preflight.
                reader.readback.return_value = {'synthetic': 'different'}
                with self.assertRaisesRegex(RuntimeError, 'ADMIN_LIVE_READBACK_CHANGED'):
                    c.baseline(d, admin, workspace, c.projection.ADMIN_COMMIT)
                reader.readback.return_value = receipt
                workspace.workspace_audit_protection.side_effect = RuntimeError('audit-protection-unavailable')
                with self.assertRaisesRegex(RuntimeError, 'audit-protection-unavailable'):
                    c.baseline(d, admin, workspace, c.projection.ADMIN_COMMIT)
                workspace.workspace_audit_protection.side_effect = None
                workspace.workspace_volume.return_value = {'name': 'changed-volume'}
                with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_VOLUME_CHANGED'):
                    c.baseline(d, admin, workspace, c.projection.ADMIN_COMMIT)
                workspace.workspace_volume.return_value = volume
                workspace.snapshot.return_value = {**states, 'online-recharge': {'image': 'unexpected'}}
                with self.assertRaisesRegex(RuntimeError, 'CURRENT_SERVICES_CHANGED'):
                    c.baseline(d, admin, workspace, c.projection.ADMIN_COMMIT)

    def test_real_backup_cas_uses_admin568_manifest_and_only_verifies_existing_entry(self):
        c = self.c
        cold = load('unpublished-component-successor.test.py')
        # Reuse its descriptor/lock/systemd simulator, while executing the real
        # unchanged backup function in this consumer's private namespace.
        with patch.object(cold, 'a', c.reused):
            fixture = cold.BackupMaintenanceTests(methodName='runTest')
            fixture.setUp()
            try:
                fixture.namespace.mkdir(mode=0o700)
                for relative, (raw, _mode) in fixture.files.items():
                    path = fixture.namespace / Path(relative).name
                    path.write_bytes(raw); path.chmod(0o700 if path.name.endswith('.sh') else 0o600)
                fixture.dropin.write_bytes(fixture.new_configuration); fixture.dropin.chmod(0o600)
                fixture.running_entry = fixture.entry
                fixture.evidence.update(currentRelease=str(fixture.previous),
                    currentCommit=c.projection.ADMIN_COMMIT, apiCurrentSourceCommit=c.projection.API_COMMIT,
                    currentManifestBytesSha256=c.history.admin_successor_authority()['manifestBytesSha256'],
                    componentSuccessorOrigin=self.origin())
                original_digest = c.reused.digest
                def synthetic_manifest_digest(raw):
                    return c.history.admin_successor_authority()['manifestBytesSha256'] if raw == fixture.manifest else original_digest(raw)
                before = {path: (path.stat().st_ino, path.read_bytes()) for path in
                    (fixture.dropin, fixture.previous / 'release-manifest.json', fixture.old_entry, fixture.entry)}
                with patch.object(c.reused, 'digest', side_effect=synthetic_manifest_digest):
                    result = fixture.upgrade()
                    self.assertEqual(result['status'], 'ALREADY_VERIFIED')
                    self.assertEqual(result['currentManifestSha256'], c.history.admin_successor_authority()['manifestBytesSha256'])
                    self.assertFalse(result['backupDeleted'])
                    self.assertEqual(before, {path: (path.stat().st_ino, path.read_bytes()) for path in before})
                    self.assertFalse(any(row[1:] == ('daemon-reload',) for row in fixture.calls))
                    for incorrect in (c.history.sealed_authority()['manifestBytesSha256'], '0' * 64):
                        fixture.evidence['currentManifestBytesSha256'] = incorrect
                        fixture.calls.clear()
                        with self.subTest(incorrect=incorrect), self.assertRaisesRegex(RuntimeError, 'BACKUP_BASELINE_CHANGED'):
                            fixture.upgrade()
                        self.assertEqual(fixture.calls, [])
                    fixture.evidence['currentManifestBytesSha256'] = c.history.admin_successor_authority()['manifestBytesSha256']
                    fixture.evidence['componentSuccessorOrigin'] = None
                    with self.assertRaisesRegex(RuntimeError, 'COMPONENT_PAIR_CHANGED'):
                        fixture.upgrade()
                    self.assertEqual(fixture.calls, [])
            finally:
                fixture.doCleanups()
                fixture.tearDown()


if __name__ == '__main__':
    unittest.main()
