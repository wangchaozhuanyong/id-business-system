"""No production, service, Docker or database calls; native fixtures are synthetic."""

import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(filename):
    spec = importlib.util.spec_from_file_location('component_test_' + filename.replace('-', '_'), HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('online-recharge-component-consumer.py')
online = load('online-recharge-scope.py')


def archive(commit):
    raw = subprocess.check_output(['git', 'archive', '--format=tar', commit], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as source:
        return {n.name: (source.extractfile(n).read(), '100755' if n.mode & 0o111 else '100644')
                for n in source if n.isfile()}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def require(value, code):
    if not value:
        raise RuntimeError(code)


def synthetic_records():
    # Deliberately synthetic; this fixture is never a production constant or file.
    p = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}
    ledger = {'producer': p, 'scope': 'UNPUBLISHED_API_ADMIN_COMPONENT_SUCCESSOR', 'onlinePublished': False,
              'migrationPerformed': False, 'databaseGrantsChanged': False}
    manifest = {'commit': p['commit'], 'sourceTree': p['sourceTree'], 'apiComponentPublication': ledger,
                'newMigrations': []}
    proof = {'projection': {'syntheticFixture': True}}
    states = {n: {'configurationSha256': 'c' * 64, 'containerId': 'd' * 64} for n in c.SERVICES}
    state = {'before': states, 'after': copy.deepcopy(states), 'migration': {'performed': False,
        'grants': {'status': 'EXISTING_GRANTS_READONLY_VERIFIED', 'mutationPerformed': False},
        'grantProtection': {'preservedGrantsSha256': '1' * 64, 'schemaGrantsSha256': '2' * 64,
            'newTablePrivileges': [{'grantee': "'id_business_app'@'%'",
                'table': 'id_business_v2_recharge_connection_profiles', 'privilege': privilege, 'grantable': 'NO'}
                for privilege in ('INSERT', 'SELECT', 'UPDATE')]}}}
    m, b, s = (encoded(n) for n in (manifest, proof, state))
    authority = {'producer': p, 'commandId': '11111111-2222-3333-4444-555555555555',
        'instanceId': 'i-0123456789abcdef0', 'manifestBytesSha256': c.digest(m),
        'buildProofBytesSha256': c.digest(b), 'preservationRecordBytesSha256': c.digest(s),
        'publicationSha256': c.fingerprint(ledger), 'projectionSha256': c.fingerprint(proof['projection']),
        'coreSha256': c.digest((HERE / 'unpublished-component-successor.py').read_bytes())}
    receipt = {'version': 1, 'scope': ledger['scope'], 'status': 'UNPUBLISHED_COMPONENT_VERIFIED',
        'commit': p['commit'], 'sourceTree': p['sourceTree'], 'servicesUpdated': ['api', 'admin'],
        'preservedServiceCount': 5, 'onlinePublished': False, 'runningImagesAndContentMatched': True,
        'databaseOldGrantsPreserved': True, 'volumeDeletionPerformed': False, 'businessActions': 0,
        **{n: authority[n] for n in ('manifestBytesSha256', 'buildProofBytesSha256',
            'preservationRecordBytesSha256', 'publicationSha256', 'projectionSha256')}}
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    invocation = {'CommandId': authority['commandId'], 'InstanceId': authority['instanceId'],
        'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript', 'Status': 'Success',
        'ResponseCode': 0, 'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now,
        'StandardErrorContent': '', 'StandardOutputContent': encoded(receipt).decode() + '\n'}
    raw = encoded(invocation)
    authority.update(invocationBytesSha256=c.digest(raw), receiptSha256=c.fingerprint(receipt))
    return authority, (raw, m, b, s)


def synthetic_admin_records():
    """Synthetic two-publication chain; no production receipt is manufactured."""
    old_authority, originals = synthetic_records()
    native, old, old_proof, state = (json.loads(raw) for raw in originals)
    old.update(adminPublication={'syntheticAdmin': True}, apiWorkspacePublication={'syntheticWorkspace': True},
        pendingOnlineMigration={'syntheticPending': True}, preservedMigrationOrigin={'syntheticMigration': True},
        apiHotfixPublication={'syntheticHotfix': True})
    old_raw = encoded(old); old_authority['manifestBytesSha256'] = c.digest(old_raw)
    old_receipt = json.loads(native['StandardOutputContent']); old_receipt['manifestBytesSha256'] = c.digest(old_raw)
    native['StandardOutputContent'] = encoded(old_receipt).decode() + '\n'
    old_authority.update(receiptSha256=c.fingerprint(old_receipt), invocationBytesSha256=c.digest(encoded(native)))
    originals = (encoded(native), old_raw, encoded(old_proof), encoded(state))
    authority = copy.deepcopy(c.AUTHENTICATED_ADMIN_SUCCESSOR)
    authority['instanceId'] = old_authority['instanceId']; p = authority['producer']
    projection = {'profile': c.ADMIN_PROFILE, 'sourceBasisCommit': old['commit'],
        'apiComponentBaseline': old['commit'], 'sourceBasisTree': old['sourceTree'],
        'overlaySha256': c.ADMIN_OVERLAY_SHA256, 'inheritedProjectionSha256': old_authority['projectionSha256']}
    projection['projectionSha256'] = c.fingerprint(projection)
    proof = {'commit': p['commit'], 'sourceTree': p['sourceTree'], 'runId': p['workflowRunId'],
        'runAttempt': p['workflowRunAttempt'], 'qualityRunId': c.ADMIN_QUALITY_RUN,
        'scope': 'ADMIN_PENDING_ONLINE_BUILD', 'projection': projection}
    ledger = {'commit': p['commit'], 'sourceTree': p['sourceTree'], 'scope': 'ADMIN_ONLY_PENDING_ONLINE_SUCCESSOR',
        'profile': c.ADMIN_PROFILE, 'buildProofSha256': c.fingerprint(proof), 'projection': projection,
        'inheritedOriginCommit': old['commit'], 'inheritedManifestSha256': c.digest(old_raw),
        'inheritedApiComponentPublicationSha256': c.fingerprint(old['apiComponentPublication']),
        'inheritedAdminPublicationSha256': c.fingerprint(old['adminPublication']),
        'componentBaselines': {'api': old['commit']}, 'onlinePublished': False, 'migrationPerformed': False,
        'databaseGrantsChanged': False, 'businessActions': 0, 'preservedServices': {
            n: {'before': state['after'][n], 'after': copy.deepcopy(state['after'][n])} for n in c.SERVICES if n != 'admin'}}
    manifest = {**old, 'commit': p['commit'], 'sourceTree': p['sourceTree'], 'adminPublication': ledger,
        'deploymentRun': 'github-actions-' + p['workflowRunId'] + '-' + p['workflowRunAttempt'],
        'imageBuildRun': 'github-actions-' + p['workflowRunId'] + '-' + p['workflowRunAttempt'],
        'ciWorkflowRunId': int(c.ADMIN_QUALITY_RUN), 'previousCommit': old['commit'],
        'previousManifestSha256': c.digest(old_raw), 'servicesUpdated': ['admin'],
        'migrationApplied': False, 'migrationPerformed': False, 'newMigrations': []}
    receipt = {'status': 'ADMIN_ONLY_READBACK_VERIFIED', 'commit': p['commit'], 'apiComponentBaseline': old['commit'],
        'servicesUpdated': ['admin'], 'preservedServiceCount': 6, 'onlinePublished': False,
        'projectionSha256': projection['projectionSha256']}
    native.update(CommandId=authority['commandId'], InstanceId=authority['instanceId'],
        StandardOutputContent=encoded(receipt).decode() + '\n')
    records = tuple(encoded(value) for value in (native, manifest, proof))
    authority.update(invocationBytesSha256=c.digest(records[0]), receiptSha256=c.fingerprint(receipt),
        manifestBytesSha256=c.digest(records[1]), buildProofBytesSha256=c.digest(records[2]),
        projectionSha256=projection['projectionSha256'], publicationSha256=c.fingerprint(ledger))
    return old_authority, authority, originals, records


class ClosedEntryTests(unittest.TestCase):
    def setUp(self):
        closed = patch.object(c, 'SEALED_ORDINARY_COMPONENT', None)
        closed.start(); self.addCleanup(closed.stop)
        admin_closed = patch.object(c, 'ADMIN_SUCCESSOR', None)
        admin_closed.start(); self.addCleanup(admin_closed.stop)
        selector = patch.object(online, '_online_component_consumer', return_value=c)
        selector.start(); self.addCleanup(selector.stop)

    def test_no_seal_refuses_before_core_or_sql_or_any_adapter(self):
        self.assertIsNone(c.SEALED_ORDINARY_COMPONENT)
        with patch.object(c, 'load_core', side_effect=AssertionError('no controller')):
            for call in (c.require_runtime_adapter,
                         lambda: c.authenticate_component_records(b'', b'', b'', b''),
                         lambda: c.verify_applied_database(None, None, None, ROOT, predecessor_records=(), migration_plan=[])):
                with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NOT_SEALED'):
                    call()

    def test_filling_only_seal_still_cannot_activate_old_switch_or_grants(self):
        authority, _ = synthetic_records()
        runtime = c.load_runtime(); runtime.RUNTIME_ADAPTER_READY = False
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', authority), patch.object(c, 'load_runtime', return_value=runtime):
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_ADAPTER_NOT_READY'):
                c.require_runtime_adapter()

    def test_component_proof_and_receipt_refuse_before_old_workspace_session(self):
        with patch.object(online, '_pending_workspace_session', side_effect=AssertionError('no old B')):
            for call in (lambda: online.validate_proof(None, {'kind': c.KIND + '_BUILD_PROOF'}, '', ''),
                         lambda: online.validate_receipt(None, {'kind': c.KIND}, 'preflight', '', '')):
                with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NOT_SEALED'):
                    call()

    def test_actual_component_manifest_never_uses_old_workspace_state(self):
        folder = ROOT / '.runtime/online-component-continuation-20261014/pure-tests'
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as name:
            previous = Path(name)
            path = previous / 'release-manifest.json'
            path.write_bytes(encoded({'apiComponentPublication': {'producer': {'commit': 'f' * 40}}}))
            path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NOT_SEALED'):
                online._workspace_baseline_kind(SimpleNamespace(require=require), SimpleNamespace(STATE_FILE='absent'), previous)

    def test_original_a_and_b_selector_is_unchanged_without_component_publication(self):
        folder = ROOT / '.runtime/online-component-continuation-20261014/pure-tests'
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as name:
            previous = Path(name)
            manifest = previous / 'release-manifest.json'
            manifest.write_bytes(encoded({'apiWorkspacePublication': {'version': 4}})); manifest.chmod(0o600)
            state = previous / 'workspace.json'
            reader = SimpleNamespace(STATE_FILE=state.name, validate_pending_online_origin=lambda value: value)
            for publications, kind in (([], online.ONLINE_PENDING_WORKSPACE_KIND),
                                       ([{'syntheticFixture': True}], online.ONLINE_AFTER_BIT_KIND)):
                state.write_bytes(encoded({'pendingOnlineMigrationOrigin': {'version': 2,
                    'priorPublications': publications}})); state.chmod(0o600)
                self.assertEqual(online._workspace_baseline_kind(SimpleNamespace(require=require), reader, previous), kind)


class NativeRecordTests(unittest.TestCase):
    def test_admin_successor_keeps_independent_ordinary_authority_and_all_six_services(self):
        old, admin, originals, records = synthetic_admin_records()
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', old), patch.object(c, 'ADMIN_SUCCESSOR', admin):
            value = c.authenticate_admin_records(*records, originals)
            self.assertFalse(value['releaseAuthority'])
            self.assertEqual(value['ordinary']['manifest']['commit'], old['producer']['commit'])
            self.assertEqual(value['manifest']['commit'], c.APPLICATION_SOURCE)
            for index in range(3):
                altered = list(records); altered[index] += b' '
                with self.subTest(record=index), self.assertRaises(RuntimeError):
                    c.authenticate_admin_records(*altered, originals)
            bad = copy.deepcopy(admin); bad['producer']['commit'] = old['producer']['commit']
            with patch.object(c, 'ADMIN_SUCCESSOR', bad), self.assertRaisesRegex(RuntimeError, 'ADMIN_SUCCESSOR_SEAL_CHANGED'):
                c.authenticate_admin_records(*records, originals)

    def test_admin_aggregate_hash_does_not_hide_changed_api_or_resident_service(self):
        old, admin, originals, records = synthetic_admin_records()
        manifest = json.loads(records[1]); manifest['adminPublication']['preservedServices']['api']['after']['containerId'] = 'e' * 64
        altered = list(records); altered[1] = encoded(manifest)
        admin['manifestBytesSha256'] = c.digest(altered[1]); admin['publicationSha256'] = c.fingerprint(manifest['adminPublication'])
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', old), patch.object(c, 'ADMIN_SUCCESSOR', admin), \
             self.assertRaisesRegex(RuntimeError, 'ADMIN_PRESERVED_SERVICES_CHANGED'):
            c.authenticate_admin_records(*altered, originals)

    def test_runtime_module_receives_both_seals_and_missing_admin_refuses(self):
        old, admin, _, _ = synthetic_admin_records()
        runtime = c.load_runtime(); runtime.RUNTIME_ADAPTER_READY = True
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', old), patch.object(c, 'ADMIN_SUCCESSOR', admin), \
             patch.object(c, 'load_runtime', return_value=runtime):
            self.assertIs(c.require_runtime_adapter(), runtime)
            self.assertEqual(runtime.c.SEALED_ORDINARY_COMPONENT, old)
            self.assertEqual(runtime.c.ADMIN_SUCCESSOR, admin)
            with patch.object(c, 'ADMIN_SUCCESSOR', None), self.assertRaisesRegex(RuntimeError, 'ADMIN_SUCCESSOR_NOT_SEALED'):
                c.require_runtime_adapter()

    def test_changed_original_helper_refuses_before_compiling_any_code(self):
        with patch('builtins.compile', side_effect=AssertionError('no unsealed helper code')):
            for expected in (None, '0' * 64):
                with self.subTest(expected=expected), self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_HELPER_CHANGED'):
                    c.load_core(expected)
            with patch.object(Path, 'read_bytes', return_value=b'not-the-signed-source'):
                with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_HELPER_CHANGED'):
                    c.load_core()

    def test_explicit_synthetic_native_bytes_match_without_release_authority(self):
        authority, records = synthetic_records()
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', authority):
            result = c.authenticate_component_records(*records)
        self.assertFalse(result['releaseAuthority'])
        self.assertEqual(result['receipt']['commit'], authority['producer']['commit'])

    def test_unknown_producer_or_any_raw_record_drift_is_rejected(self):
        authority, records = synthetic_records()
        for index in range(4):
            changed = list(records); changed[index] += b' '
            with self.subTest(record=index), patch.object(c, 'SEALED_ORDINARY_COMPONENT', authority):
                with self.assertRaises(RuntimeError): c.authenticate_component_records(*changed)
        changed = copy.deepcopy(authority); changed['producer']['commit'] = 'f' * 40
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', changed):
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_RECEIPT_CHANGED'):
                c.authenticate_component_records(*records)

    def test_boolean_run_or_unexpected_seal_field_is_not_a_finite_authority(self):
        authority, _ = synthetic_records()
        for change in (lambda x: x['producer'].update(workflowRunId=True),
                       lambda x: x.update(allowAnyMain=True)):
            changed = copy.deepcopy(authority); change(changed)
            with patch.object(c, 'SEALED_ORDINARY_COMPONENT', changed):
                with self.assertRaisesRegex(RuntimeError, 'SEAL_INVALID'): c.sealed_authority()


class SourceAndDatabasePreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # This consumer authenticates the original fixed application, not a
        # future checkout containing unrelated, already published repairs.
        cls.candidate = archive(c.APPLICATION_SOURCE)
        cls.ordinary = archive(c.AUTHENTICATED_PREDECESSOR['producer']['commit'])
        cls.base = archive('0a03fa28e6b844a18833d5c63f1de700f091fc64')
        cls.fixed = archive(c.ONLINE_SOURCE)
        cls.core = c.load_core()
        cls.projection = cls.core.projection_module()
        cls.commit = c.APPLICATION_SOURCE
        cls.tree = cls.projection.source_tree(cls.candidate)
        assert cls.tree == c.APPLICATION_TREE

    def prepare(self, candidate=None, ordinary=None):
        candidate = self.candidate if candidate is None else candidate
        ordinary = self.ordinary if ordinary is None else ordinary
        return c.prepare_source_projection(candidate, ordinary, self.base, self.fixed, commit=self.commit,
            tree=self.projection.source_tree(candidate), ordinary_producer={**c.AUTHENTICATED_PREDECESSOR['producer'],
                'sourceTree': self.projection.source_tree(ordinary)})

    def test_real_git_2191_and_150_sources_survive_online_activation_projection(self):
        output, record = self.prepare()
        self.assertEqual(output, self.candidate)
        self.assertEqual(record['applicationFileCount'], 2191)
        self.assertEqual(record['onlineFileCount'], 150)
        self.assertEqual(record['applicationInputSha256'], c.APPLICATION_SHA256)
        for name in c.ADMIN_OVERLAY_FILES:
            self.assertEqual(output[name], self.candidate[name])
            self.assertNotEqual(output[name], self.ordinary[name])
        self.assertFalse(record['releaseAuthority'])
        for name in ('apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts',
            'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_connector.py',
            c.MIGRATION_ROOT + '/' + c.PROFILE_MIGRATION + '/migration.sql',
            'apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue'):
            self.assertEqual(output[name], self.candidate[name])
        self.assertEqual(c.digest(output[c.SCHEMA][0]), c.FULL_SCHEMA_SHA256)

    def test_future_checkout_cannot_borrow_original_application_authority(self):
        with self.assertRaisesRegex(RuntimeError, 'APPLICATION_SOURCE_CHANGED'):
            self.prepare(archive('HEAD'))

    def test_preparation_matches_original_producer_archive_core_source_output_and_record(self):
        # Run the genuine archived helper against its genuine archived controls.
        # Only the workflow tuple is a synthetic fixture; no network/runtime call.
        folder = ROOT / '.runtime/online-component-continuation-20261014/pure-tests'
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as name:
            archived_here = Path(name) / 'scripts/production-release'
            archived_here.mkdir(parents=True)
            for helper in self.core.HELPERS:
                relative = 'scripts/production-release/' + helper
                (archived_here / helper).write_bytes(self.ordinary[relative][0])
            core_path = archived_here / 'unpublished-component-successor.py'
            spec = importlib.util.spec_from_file_location('archived_ordinary_core_source_fixture', core_path)
            original_core = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(original_core)
            ordinary_p = c.AUTHENTICATED_PREDECESSOR['producer']
            references = (ordinary_p['commit'], '0a03fa28e6b844a18833d5c63f1de700f091fc64', c.ONLINE_SOURCE)
            raw_archives = {ref: subprocess.check_output(['git', 'archive', '--format=tar', ref], cwd=ROOT)
                            for ref in references}
            files = dict(zip(references, (self.ordinary, self.base, self.fixed)))
            d = SimpleNamespace(registration_download=lambda ref: raw_archives[ref],
                registration_archive=lambda raw, ref: files[ref], require=require)
            p = original_core.producer(ordinary_p['commit'], ordinary_p['sourceTree'], ordinary_p['workflowRunId'], ordinary_p['workflowRunAttempt'])
            actual_files, actual_output, actual_record, actual_app_sha, actual_archive_sha = original_core.source(d, p)
            output, preparation = self.prepare()
            self.assertEqual(actual_files, self.ordinary)
            self.assertEqual(actual_app_sha, c.ORDINARY_APPLICATION_SHA256)
            self.assertEqual(actual_archive_sha, c.digest(raw_archives[ordinary_p['commit']]))
            self.assertEqual(preparation['ordinaryProjectionSha256'], c.fingerprint(actual_record))
            self.assertEqual(preparation['ordinaryProjectionSha256'], c.AUTHENTICATED_PREDECESSOR['projectionSha256'])
            self.assertEqual(preparation['ordinaryOutputFilesSha256'], c.fingerprint(self.projection.inventory(actual_output)))
            self.assertEqual(output, self.candidate)
            self.assertFalse(preparation['releaseAuthority'])

    def test_mutated_employee_ordinary_business_online_mode_or_partial_source_is_rejected(self):
        for path in (c.MIGRATION_ROOT + '/' + c.PROFILE_MIGRATION + '/migration.sql',
                     'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts',
                     'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json'):
            for mode_change in (False, True):
                changed = dict(self.candidate); raw, mode = changed[path]
                changed[path] = (raw if mode_change else raw + b' ', '100755' if mode_change else mode)
                with self.subTest(path=path, mode=mode_change), self.assertRaises(RuntimeError):
                    self.prepare(changed)
        missing = dict(self.candidate); missing.pop(c.MIGRATION_ROOT + '/' + c.ONLINE_MIGRATION + '/migration.sql')
        with self.assertRaises(RuntimeError): self.prepare(missing)

    def database_fixture(self):
        files = {n[len(c.MIGRATION_ROOT) + 1:]: c.digest(row[0]) for n, row in self.candidate.items()
                 if n.startswith(c.MIGRATION_ROOT + '/')}
        schema = {'tables': [], 'columns': [], 'indexes': []}
        rows = [{'name': n.split('/')[0], 'checksum': sha, 'finished': 1, 'rolledBack': 0}
                for n, sha in files.items() if n.endswith('/migration.sql')]
        return files, schema, {'rows': rows, **copy.deepcopy(schema)}

    def source_directory(self):
        folder = ROOT / '.runtime/online-component-continuation-20261014/pure-tests'
        folder.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=folder)
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        for name in (c.SCHEMA, online.SEED_FILE,
                     c.MIGRATION_ROOT + '/' + c.ONLINE_MIGRATION + '/migration.sql'):
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.candidate[name][0])
        files, _, metadata = self.database_fixture()
        workspace = SimpleNamespace(migration_files=Mock(side_effect=lambda *args: dict(files)))
        d = SimpleNamespace(require=require, api_admin_scope=lambda selected: (workspace, None))
        schema = c.union_schema_expectation(d, online, workspace, directory)
        metadata.update(copy.deepcopy(schema))
        return directory, workspace, d, files, schema, metadata

    def test_union49_real_schema_parser_keeps_all_nine_tables_without_changing_legacy_guard(self):
        guard = online.schema_expectation.__globals__['migration_source_check']
        directory, workspace, d, files, schema, metadata = self.source_directory()
        self.assertEqual(len(schema['tables']), 9)
        self.assertEqual(c.migration_source_check(d, workspace, directory), files)
        self.assertIs(online.schema_expectation.__globals__['migration_source_check'], guard)
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
            online.schema_expectation(d, directory)
        self.assertEqual(c.validate_online_metadata(metadata, files, schema)['status'], 'APPLIED')
        for name in ('tables', 'columns', 'indexes'):
            changed = copy.deepcopy(metadata); changed[name].pop()
            with self.subTest(field=name), self.assertRaisesRegex(RuntimeError, 'ONLINE_SCHEMA_CHANGED'):
                c.validate_online_metadata(changed, files, schema)
        workspace.migration_files.side_effect = lambda *args: {**files, 'unapproved/migration.sql': 'f' * 64}
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_HISTORY_CHANGED'):
            c.union_schema_expectation(d, online, workspace, directory)

    def test_signed_grants_and_two_applied_states_are_readonly_and_empty_plan(self):
        directory, workspace, d, files, schema, metadata = self.source_directory()
        authority, records = synthetic_records()
        grants = json.loads(records[3])['migration']['grantProtection']
        profile = {'name': c.PROFILE_MIGRATION, 'sha256': c.MIGRATIONS[c.PROFILE_MIGRATION],
            'status': 'APPLIED', 'schemaVerified': True,
            'appliedMigrationsSha256': c.validate_online_metadata(metadata, files, schema)['appliedMigrationsSha256']}
        mock_online = SimpleNamespace(TABLES=online.TABLES, database_read=Mock(return_value=metadata),
                                      schema_expectation=online.schema_expectation)
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', authority), \
             patch.object(c, 'load_core', return_value=self.core), \
             patch.object(self.core, 'migration_database_state', return_value=profile) as read_profile, \
             patch.object(self.core, 'grant_state', return_value=grants) as read_grants, \
             patch.object(self.core, 'apply_migration', side_effect=AssertionError('no migration or grants')) as mutate:
            result = c.verify_applied_database(d, mock_online, workspace, directory,
                predecessor_records=records, migration_plan=[])
            self.assertEqual(result['migrationPlan'], [])
            self.assertFalse(result['migrationPerformed'])
            self.assertFalse(result['databaseGrantsChanged'])
            self.assertEqual(result['online']['status'], result['connectionProfile']['status'])
            read_profile.assert_called_once(); read_grants.assert_called_once(); mutate.assert_not_called()
            query = mock_online.database_read.call_args.args[2]
            self.assertTrue(query.startswith('SELECT JSON_OBJECT'))
            self.assertNotRegex(query, r'\b(?:ALTER|INSERT|UPDATE|DELETE|GRANT|REVOKE|DROP)\b')
            for bad in ({**profile, 'status': 'PENDING'},
                        {**profile, 'appliedMigrationsSha256': '0' * 64}):
                read_profile.return_value = bad
                with self.assertRaisesRegex(RuntimeError, 'PROFILE_NOT_APPLIED'):
                    c.verify_applied_database(d, mock_online, workspace, directory,
                        predecessor_records=records, migration_plan=[])
            read_profile.return_value = profile
            read_grants.return_value = {**grants, 'preservedGrantsSha256': '9' * 64}
            with self.assertRaisesRegex(RuntimeError, 'DATABASE_GRANTS_CHANGED'):
                c.verify_applied_database(d, mock_online, workspace, directory,
                    predecessor_records=records, migration_plan=[])
            changed = list(records); changed[3] += b' '
            calls = mock_online.database_read.call_count
            with self.assertRaisesRegex(RuntimeError, 'RECORD_BYTES_CHANGED'):
                c.verify_applied_database(d, mock_online, workspace, directory,
                    predecessor_records=tuple(changed), migration_plan=[])
            self.assertEqual(mock_online.database_read.call_count, calls)

    def test_all_48_real_migrations_must_be_applied_with_exact_checksums(self):
        files, schema, metadata = self.database_fixture()
        self.assertEqual(len(files), 49)
        self.assertEqual(len(metadata['rows']), 48)
        result = c.validate_online_metadata(metadata, files, schema)
        self.assertEqual(result['status'], 'APPLIED')
        for name in c.MIGRATIONS:
            for change in ('missing', 'pending', 'checksum', 'duplicate'):
                bad = copy.deepcopy(metadata)
                row = next(r for r in bad['rows'] if r['name'] == name)
                if change == 'missing': bad['rows'].remove(row)
                elif change == 'pending': row.update(finished=0, rolledBack=1)
                elif change == 'checksum': row['checksum'] = '0' * 64
                else: bad['rows'].append(copy.deepcopy(row))
                with self.subTest(name=name, change=change), self.assertRaises(RuntimeError):
                    c.validate_online_metadata(bad, files, schema)

    def test_real_profile_reader_accepts_union49_full_schema_without_bypassing_source_guard(self):
        directory, workspace, d, files, _, metadata = self.source_directory()
        self.assertEqual(c.digest((directory / c.SCHEMA).read_bytes()), c.FULL_SCHEMA_SHA256)
        profile = {'rows': metadata['rows'], 'tables': [{'engine': 'InnoDB', 'collation': 'utf8mb4_unicode_ci'}],
            'columns': [{'name': name, 'position': index, 'type': kind, 'columnType': full,
                'nullable': 'NO', 'default': default, 'extra': extra}
                for index, (name, kind, full, default, extra) in enumerate((
                    ('id', 'char', 'char(36)', None, ''), ('owner_id', 'varchar', 'varchar(191)', None, ''),
                    ('name', 'varchar', 'varchar(80)', None, ''), ('configuration', 'json', 'json', None, ''),
                    ('created_at', 'datetime', 'datetime(3)', 'CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED'),
                    ('updated_at', 'datetime', 'datetime(3)', None, '')), 1)],
            'indexes': [{'name': name, 'column': column, 'sequence': index, 'nonUnique': unique,
                'type': 'BTREE', 'prefix': None}
                for name, unique, names in (('PRIMARY', 0, ('id',)),
                    (self.core.MIGRATION_TABLE + '_owner_id_name_key', 0, ('owner_id', 'name')),
                    (self.core.MIGRATION_TABLE + '_owner_id_created_idx', 1, ('owner_id', 'created_at')))
                for index, column in enumerate(names, 1)]}
        original_guard = self.core.migration_source_check
        with patch.object(self.core, 'mysql_readonly', return_value=profile) as query:
            result = self.core.migration_database_state(d, workspace, directory)
            self.assertEqual(result['status'], 'APPLIED')
            self.assertTrue(result['schemaVerified'])
            self.assertEqual(result['appliedMigrationsSha256'], c.fingerprint({row['name']: row['checksum'] for row in metadata['rows']}))
            self.assertTrue(query.call_args.args[2].startswith('SELECT JSON_OBJECT'))
            for field in ('columns', 'indexes', 'rows'):
                bad = copy.deepcopy(profile); bad[field].pop(); query.return_value = bad
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    self.core.migration_database_state(d, workspace, directory)
            query.return_value = profile
            workspace.migration_files.side_effect = lambda *args: {**files, 'unapproved/migration.sql': 'f' * 64}
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SOURCE_CHANGED'):
                self.core.migration_database_state(d, workspace, directory)
        self.assertIs(self.core.migration_source_check, original_guard)
        workspace.migration_files.side_effect = lambda *args: dict(files)
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCHEMA_CHANGED'):
            self.core.migration_source_check(d, workspace, directory, candidate=True)

    def test_readonly_database_path_rejects_a_plan_before_any_sql(self):
        authority, _ = synthetic_records()
        with patch.object(c, 'SEALED_ORDINARY_COMPONENT', authority), \
             patch.object(c, 'migration_source_check', side_effect=AssertionError('no source or SQL')):
            for value in (['migration.sql'], None, False):
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_PLAN_NOT_EMPTY'):
                    c.verify_applied_database(None, None, None, ROOT, predecessor_records=(), migration_plan=value)


if __name__ == '__main__':
    unittest.main()
