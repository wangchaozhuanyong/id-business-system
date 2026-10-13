"""Offline component provenance, immutable application and protected release guards."""

import base64
import copy
from contextlib import ExitStack
from datetime import datetime, timezone
import importlib.util
import io
import json
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
PATH = Path(__file__).with_name('unpublished-component-successor.py')
spec = importlib.util.spec_from_file_location('tested_component_successor', PATH)
a = importlib.util.module_from_spec(spec)
exec(compile(PATH.read_bytes(), str(PATH), 'exec'), a.__dict__)
N, T, D = 'a' * 40, 'b' * 40, 'c' * 40
INSTANCE = 'i-offline-component-fixture'
COMMAND = '11111111-2222-3333-4444-555555555555'
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
P = a.producer(N, T, '12', '1')


def native(receipt):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return json.dumps({'CommandId': COMMAND, 'InstanceId': INSTANCE, 'DocumentName': 'AWS-RunShellScript',
        'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
        'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now, 'StandardErrorContent': '',
        'StandardOutputContent': json.dumps(receipt, sort_keys=True, separators=(',', ':')) + '\n'}).encode()


def server_receipt():
    return {'version': 1, 'scope': a.SCOPE, 'status': 'UNPUBLISHED_COMPONENT_BASELINE_VERIFIED', 'mode': 'preflight',
        'producer': P, 'instanceId': INSTANCE, 'baseline': {'currentCommit': D}, 'projectionSha256': 'd' * 64,
        'applicationInputSha256': 'd' * 64,
        'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}


def archive(sha):
    rows = {}
    raw = subprocess.check_output(['git', 'archive', sha], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as source:
        for item in source.getmembers():
            if item.isfile():
                rows[item.name] = (source.extractfile(item).read(), '100755' if item.mode & 0o111 else '100644')
    return rows


def sealed_candidate():
    # The integrated main N is the durable CI source after squash. The frozen
    # local commit is only a development fixture, never required when N is sealed.
    projection = a.projection_module()
    for ref in ('HEAD', a.APPLICATION_SOURCE):
        try:
            candidate = archive(ref)
        except subprocess.CalledProcessError:
            continue
        rows = {n: row for n, row in projection.inventory(candidate).items()
                if n.startswith(('apps/api/', 'apps/admin/', 'packages/shared/')) or n in
                ('package.json', 'package-lock.json', '.dockerignore', 'tsconfig.base.json', 'deploy/nginx/admin.conf')}
        if len(rows) == a.APPLICATION_INPUT_COUNT and a.fingerprint(rows) == a.APPROVED_APPLICATION_INPUT_SHA256:
            return candidate
    raise AssertionError('Final main must contain the exact reviewed application seal; no available archive is sealed')


def migration_state(status):
    return {'name': a.MIGRATION_NAME, 'sha256': a.MIGRATION_IDENTITY['sha256'], 'status': status, 'schemaVerified': True, 'appliedMigrationsSha256': 'f' * 64}


class PublishedPredecessorTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / '.runtime/remaining-release-20261014/component-control-tests'
        folder.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=folder)
        self.root = Path(self.tmp.name)
        self.authority = copy.deepcopy(a.COMPONENT_PREDECESSOR)
        self.grants = {'preservedGrantsSha256': 'd' * 64, 'schemaGrantsSha256': 'e' * 64,
            'newTablePrivileges': [{'grantee': "'id_business_app'@'%'", 'table': a.MIGRATION_TABLE,
                'privilege': n, 'grantable': 'NO'} for n in ('INSERT', 'SELECT', 'UPDATE')]}
        self.migration = migration_state('APPLIED')
        self.receipt = {'version': 1, 'scope': a.SCOPE, 'status': 'UNPUBLISHED_COMPONENT_VERIFIED',
            'commit': self.authority['producer']['commit'], 'sourceTree': self.authority['producer']['sourceTree'],
            'servicesUpdated': list(a.UPDATED), 'preservedServiceCount': len(a.PRESERVED),
            'runningImagesAndContentMatched': True, 'databaseOldGrantsPreserved': True,
            'volumeDeletionPerformed': False, 'onlinePublished': False, 'businessActions': 0,
            'migration': self.migration}
        value = json.loads(native(self.receipt))
        value.update(CommandId=self.authority['commandId'], InstanceId=self.authority['instanceId'])
        self.raw = json.dumps(value).encode()
        self.authority.update(invocationBytesSha256=a.digest(self.raw), receiptSha256=a.fingerprint(self.receipt))

    def tearDown(self):
        self.tmp.cleanup()

    def origin(self):
        origin = {n: copy.deepcopy(self.authority[n]) for n in ('producer', 'commandId', 'invocationBytesSha256',
            'manifestBytesSha256', 'publicationSha256', 'buildProofBytesSha256', 'preservationRecordBytesSha256', 'projectionSha256')}
        origin.update(version=1, scope=a.COMPONENT_PREDECESSOR_SCOPE, authenticated=True,
            migration=copy.deepcopy(self.migration), databaseGrants=copy.deepcopy(self.grants))
        return origin

    def test_original_native_only_and_receipt_or_command_substitution_rejected(self):
        with patch.dict(a.COMPONENT_PREDECESSOR, self.authority, clear=True):
            self.assertEqual(a.validate_component_predecessor_native(self.raw), self.receipt)
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_CHANGED'):
                a.validate_component_predecessor_native(self.raw + b' ')
            for key, value in (('CommandId', COMMAND), ('InstanceId', INSTANCE), ('ResponseCode', True),
                               ('StandardErrorContent', 'offline error'), ('Status', 'Failed')):
                altered = json.loads(self.raw); altered[key] = value
                changed = json.dumps(altered).encode()
                with patch.dict(a.COMPONENT_PREDECESSOR, {'invocationBytesSha256': a.digest(changed)}):
                    with self.assertRaises(RuntimeError): a.validate_component_predecessor_native(changed)
            altered = json.loads(self.raw)
            body = copy.deepcopy(self.receipt); body['onlinePublished'] = True
            altered['StandardOutputContent'] = json.dumps(body)
            changed = json.dumps(altered).encode()
            with patch.dict(a.COMPONENT_PREDECESSOR, {'invocationBytesSha256': a.digest(changed)}):
                with self.assertRaisesRegex(RuntimeError, 'RECEIPT_CHANGED'):
                    a.validate_component_predecessor_native(changed)

    def test_finite_origin_rejects_other_producer_native_seal_and_migration(self):
        with patch.dict(a.COMPONENT_PREDECESSOR, self.authority, clear=True):
            self.assertEqual(a.component_successor_origin({'componentSuccessorOrigin': self.origin()}), self.origin())
            for modify in (lambda v: v['producer'].update(commit=N), lambda v: v['producer'].update(workflowRunId='99'),
                           lambda v: v.update(authenticated=False), lambda v: v.update(invocationBytesSha256='a' * 64),
                           lambda v: v['migration'].update(status='PENDING'),
                           lambda v: v['migration'].update(name='unreviewed'), lambda v: v.update(extra=True)):
                value = self.origin(); modify(value)
                with self.assertRaises(RuntimeError): a.component_successor_origin({'componentSuccessorOrigin': value})

    def test_applied_successor_is_readonly_and_unknown_migration_or_grants_fail(self):
        d = SimpleNamespace(migration_plan=Mock(return_value=[]), compose=Mock(), sync_new_table_grants=Mock())
        with patch.dict(a.COMPONENT_PREDECESSOR, self.authority, clear=True), patch.object(a, 'migration_source_check') as source, \
             patch.object(a, 'migration_database_state', return_value=self.migration), patch.object(a, 'grant_state', return_value=self.grants):
            result = a.apply_migration(d, None, self.root, self.root, retained=self.origin())
            self.assertFalse(result['performed'])
            self.assertEqual(result['grants'], {'status': 'EXISTING_GRANTS_READONLY_VERIFIED', 'mutationPerformed': False})
            self.assertEqual(source.call_args_list[0].kwargs, {'candidate': True})
            self.assertEqual(source.call_args_list[1].kwargs, {'candidate': True})
            for change in ([a.MIGRATION_FILE], ['unexpected/migration.sql']):
                d.migration_plan.return_value = change
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
                    a.apply_migration(d, None, self.root, self.root, retained=self.origin())
            d.migration_plan.return_value = []
            for altered in ({**self.migration, 'status': 'PENDING'}, {**self.migration, 'appliedMigrationsSha256': '1' * 64}):
                with patch.object(a, 'migration_database_state', return_value=altered):
                    with self.assertRaisesRegex(RuntimeError, 'MIGRATION_RETAINED_BINDING_CHANGED'):
                        a.apply_migration(d, None, self.root, self.root, retained=self.origin())
            with patch.object(a, 'grant_state', return_value={**self.grants, 'schemaGrantsSha256': '1' * 64}):
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_RETAINED_BINDING_CHANGED'):
                    a.apply_migration(d, None, self.root, self.root, retained=self.origin())
        d.compose.assert_not_called(); d.sync_new_table_grants.assert_not_called()

    def test_original_f193_source_is_loaded_without_using_the_new_application_seal(self):
        commit = self.authority['producer']['commit']
        files = archive(commit)
        for name in a.HELPERS:
            path = self.root / 'scripts/production-release' / name
            row = files['scripts/production-release/' + name]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(row[0]); path.chmod(0o755 if row[1] == '100755' else 0o644)
        d = SimpleNamespace(registration_download=Mock(return_value=b'offline archive'), registration_archive=Mock(return_value=files))
        with patch.object(a, 'APPLICATION_SOURCE', N), patch.object(a, 'APPROVED_APPLICATION_INPUT_SHA256', '1' * 64):
            historical = a.component_predecessor_code(d, self.root)
            self.assertEqual(historical.APPLICATION_SOURCE, 'b1a775d1dc0bc460fb59eebcec089342b6134788')
            self.assertEqual(historical.APPROVED_APPLICATION_INPUT_SHA256,
                             '2e9549278a2e883a6a7eba4a90a565146919e3ce631f4c5cfe8e5771b2dfd647')
        for name in ('unpublished-component-successor.py', 'api-admin-scope.py'):
            path = self.root / 'scripts/production-release' / name
            original = path.read_bytes(); path.write_bytes(original + b'\n# unknown source\n')
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_SOURCE_CHANGED'):
                a.component_predecessor_code(d, self.root)
            path.write_bytes(original)
        bad = dict(files); bad['unrelated'] = (b'changed', '100644')
        d.registration_archive.return_value = bad
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_SOURCE_CHANGED'):
            a.component_predecessor_code(d, self.root)

    def test_preserve_accepts_only_unchanged_applied_schema_and_five_service_fingerprints(self):
        fixture = PreservationTests(); fixture.root = self.root
        d, scope, previous, target, evidence, images, states = fixture.fixture()
        d.migration_plan = Mock(return_value=[])
        evidence['componentSuccessorOrigin'] = self.origin()
        schema = previous / a.MIGRATION_SCHEMA
        with patch.dict(a.COMPONENT_PREDECESSOR, self.authority, clear=True), \
             patch.dict(a.MIGRATION_IDENTITY, {'schemaAfterSha256': a.digest(schema.read_bytes())}), \
             patch.object(a, 'migration_source_check') as source:
            self.assertEqual(a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images), states)
            self.assertEqual(source.call_args_list[0].kwargs, {'candidate': True})
            self.assertEqual(source.call_args_list[1].kwargs, {'candidate': True})
            d.migration_plan.return_value = ['unreviewed/migration.sql']
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
                a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)
            d.migration_plan.return_value = []
            original = (target / a.MIGRATION_SCHEMA).read_bytes()
            (target / a.MIGRATION_SCHEMA).write_bytes(b'unknown schema')
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCHEMA_CHANGED'):
                a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)
            (target / a.MIGRATION_SCHEMA).write_bytes(original)
            for name in a.PRESERVED:
                changed = copy.deepcopy(states); changed[name]['configurationSha256'] = '0' * 64
                scope.snapshot = Mock(return_value=changed)
                with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                    a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)

    def baseline_fixture(self):
        current = self.root / 'releases/current'; current.mkdir(parents=True, mode=0o700)
        (self.root / 'current').symlink_to(current)
        states = {n: {'containerId': '1' * 64, 'image': 'sha256:' + '2' * 64, 'reference': 'offline-' + n,
            'status': 'running', 'health': 'healthy', 'startedAtSha256': '3' * 64,
            'environmentSha256': '4' * 64, 'configurationSha256': '5' * 64} for n in a.SERVICES}
        volume = {'name': 'offline_volume'}
        (current / 'runtime').write_bytes(b'fixed')
        (current / '.env.aws.production').write_bytes(b'offline-placeholder'); (current / '.env.aws.production').chmod(0o600)
        markers = {'historical': {'immutable': True}}
        baseline = {'configurationFilesSha256': {'runtime': a.digest(b'fixed')}, 'originMarkersSha256': a.fingerprint(markers)}
        ledger = {'producer': self.authority['producer'], 'baseline': baseline}
        manifest = {'commit': self.authority['producer']['commit'], 'sourceTree': self.authority['producer']['sourceTree'],
                    'apiComponentPublication': ledger, **markers}
        raw = a.write_private(current / 'release-manifest.json', manifest)
        proof = {'images': {n: {'imageId': states[n]['image'], 'reference': states[n]['reference']} for n in a.UPDATED},
                 'projection': {'finite': True}}
        proof_raw = a.write_private(current / (a.PREFIX + '-build-proof.json'), proof)
        state = {'before': copy.deepcopy(states), 'after': copy.deepcopy(states), 'workspaceVolumeAfter': volume,
                 'migration': {'grantProtection': self.grants}}
        state_raw = a.write_private(current / (a.PREFIX + '-preservation.json'), state)
        self.authority.update(manifestBytesSha256=a.digest(raw), buildProofBytesSha256=a.digest(proof_raw),
            preservationRecordBytesSha256=a.digest(state_raw), publicationSha256=a.fingerprint(ledger), projectionSha256=a.fingerprint(proof['projection']))
        d = SimpleNamespace(BASE=self.root)
        scope = SimpleNamespace(snapshot=Mock(return_value=states), workspace_volume=Mock(return_value=volume),
            jobs_idle=Mock(return_value={'registrationBusy': False}), workspace_idle=Mock(),
            workspace_audit_protection=Mock(), workspace_private_inspect=Mock())
        admin = SimpleNamespace(ORIGIN_MARKERS=('historical',))
        historical = SimpleNamespace(readback=Mock(return_value=self.receipt))
        return d, admin, scope, current, raw, manifest, historical

    def test_successor_baseline_requires_full_historical_readback_and_five_services(self):
        fixture = self.baseline_fixture()
        d, admin, scope, current, raw, manifest, historical = fixture
        with patch.dict(a.COMPONENT_PREDECESSOR, self.authority, clear=True), \
             patch.object(a, 'validate_component_predecessor_native', return_value=self.receipt), \
             patch.object(a, 'private_bytes', side_effect=lambda path, **kwargs: b'offline native' if path.name == 'invocation.json' else path.read_bytes()), \
             patch.object(a, 'component_predecessor_code', return_value=historical), \
             patch.object(a, 'migration_database_state', return_value=self.migration), \
             patch.object(a, 'grant_state', return_value=self.grants), patch.object(a, 'configuration_model', return_value={'fixed': True}):
            result = a.baseline(d, admin, scope, self.authority['producer']['commit'])
            evidence = result[2]
            self.assertEqual(evidence['apiCurrentSourceCommit'], self.authority['producer']['commit'])
            self.assertEqual(evidence['componentSuccessorOrigin'], self.origin())
            self.assertIsNone(evidence['restorationBinding'])
            historical.readback.assert_called_once_with(None, self.authority['producer']['commit'])
            historical.readback.return_value = {**self.receipt, 'onlinePublished': True}
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_READBACK_CHANGED'):
                a.baseline(d, admin, scope, self.authority['producer']['commit'])
            historical.readback.return_value = self.receipt
            altered = copy.deepcopy(scope.snapshot.return_value); altered['mysql']['containerId'] = '9' * 64
            scope.snapshot.return_value = altered
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_SERVICES_CHANGED'):
                a.baseline(d, admin, scope, self.authority['producer']['commit'])


class SuccessorTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT / '.runtime/unpublished-release-20261013/successor-tests'
        folder.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=folder)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_approval_missing_rejects_before_source_or_any_controller(self):
        with patch.object(a, 'modules', side_effect=AssertionError('controller must not load')):
            with self.assertRaisesRegex(RuntimeError, 'API_FAULT_RESTORE_APPROVAL_REQUIRED'):
                a.release(None, SimpleNamespace(api_fault_restore_approved=False), {}, {})

    def test_urgent_unknown_manifest_is_rejected_without_inherited_admin_authority(self):
        base = self.root
        release = base / 'releases/unknown'; release.mkdir(parents=True, mode=0o700)
        (base / 'current').symlink_to(release)
        a.write_private(release / 'release-manifest.json', {'commit': D, 'apiWorkspacePublication': {'version': 4}})
        admin = SimpleNamespace(readback=Mock())
        with self.assertRaisesRegex(RuntimeError, 'CURRENT_ADMIN_CHANGED'):
            a.baseline(SimpleNamespace(BASE=base), admin, SimpleNamespace(), D)
        admin.readback.assert_not_called()

    def test_closed_json_duplicate_nonfinite_and_bool_producer_are_rejected(self):
        for raw in (b'{"version":1,"version":2}', b'{"value":NaN}', b'[]'):
            with self.assertRaises((RuntimeError, ValueError)):
                a.closed_json(raw)
        with self.assertRaises(RuntimeError):
            a.producer(N, T, True, '1')

    def test_preflight_retains_original_native_bytes_and_server_artifact(self):
        receipt = server_receipt()
        d = SimpleNamespace(BASE=self.root)
        a.write_private(a.evidence_path(d, P), receipt)
        raw = native(receipt)
        transport = a.make_transport(raw, COMMAND, INSTANCE)
        self.assertEqual(a.transport_invocation(transport), raw)
        with patch.object(a, 'instance_id', return_value=INSTANCE), patch.object(a, 'APPROVED_APPLICATION_INPUT_SHA256', 'd' * 64):
            self.assertEqual(a.validate_preflight(d, transport, P, D), receipt)

    def test_raw_command_instance_or_stdout_substitution_cannot_authorize(self):
        receipt = server_receipt()
        for field, replacement in (('CommandId', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
                                   ('InstanceId', 'i-other'), ('ResponseCode', True),
                                   ('StandardErrorContent', 'unexpected diagnostic')):
            value = json.loads(native(receipt)); value[field] = replacement
            with self.assertRaises(RuntimeError):
                a.validate_invocation(json.dumps(value).encode(), COMMAND, INSTANCE)

    def test_transport_and_private_record_tamper_fail_closed(self):
        receipt = server_receipt(); d = SimpleNamespace(BASE=self.root)
        a.write_private(a.evidence_path(d, P), receipt)
        transport = a.make_transport(native(receipt), COMMAND, INSTANCE)
        with patch.object(a, 'instance_id', return_value=INSTANCE), patch.object(a, 'APPROVED_APPLICATION_INPUT_SHA256', 'd' * 64):
            altered = copy.deepcopy(transport); altered['serverReceipt']['baseline']['currentCommit'] = 'e' * 40
            with self.assertRaises(RuntimeError):
                a.validate_preflight(d, altered, P, D)
            saved = a.evidence_path(d, P)
            changed = copy.deepcopy(receipt); changed['producer']['workflowRunId'] = '13'
            saved.write_text(json.dumps(changed))
            with self.assertRaises(RuntimeError):
                a.validate_preflight(d, transport, P, D)

    def test_private_evidence_never_overwrites_or_follows_links(self):
        path = self.root / 'evidence.json'
        a.write_private(path, {'version': 1})
        with self.assertRaises(FileExistsError):
            a.write_private(path, {'version': 2})
        link = self.root / 'link.json'; link.symlink_to(path)
        with self.assertRaises(RuntimeError):
            a.private_bytes(link)

    def test_gzip_size_suffix_duplicate_and_raw_hash_are_not_weakened(self):
        good = a.make_transport(native(server_receipt()), COMMAND, INSTANCE)
        for field, value in (('decodedInvocationLength', True), ('invocationBytesSha256', 'e' * 64),
                            ('invocationEncoding', 'base64')):
            altered = dict(good); altered[field] = value
            with self.assertRaises(RuntimeError):
                a.transport_invocation(altered)
        altered = dict(good)
        altered['invocationRawBase64'] = base64.b64encode(base64.b64decode(good['invocationRawBase64']) + b'trailing').decode()
        with self.assertRaises(RuntimeError):
            a.transport_invocation(altered)

    def test_new_context_is_private_instance_and_old_B_contract_unchanged(self):
        new = a.projection_module()
        old = a.load('old_projection_control_test', 'api-admin-pending-projection.py')
        self.assertEqual(new.CONTEXT_PATH, a.CONTEXT)
        self.assertEqual(old.CONTEXT_PATH, '.deploy/production-release/api-admin-pending-build-context')
        self.assertNotEqual(new.CONTEXT_PATH, old.CONTEXT_PATH)

    def test_old_publication_limit_and_issuer_remain_unchanged(self):
        source = PATH.with_name('api-admin-scope.py').read_text()
        self.assertIn("len(pending['priorPublications']) == 0, 'API_ADMIN_PENDING_ONLINE_PUBLICATION_LIMIT'", source)
        controller = PATH.read_text()
        self.assertNotIn('pending_online_successor(', controller)
        self.assertNotIn('_release_locked(', controller)
        self.assertNotIn('pending_online_declaration_b_guard(', controller)

    def test_prepare_and_build_proof_create_private_readable_artifacts(self):
        import os
        import stat
        record = {'contextPath': a.CONTEXT, 'candidateCommit': N, 'candidateTree': T}
        output = {'apps/api/prisma-mysql/schema.prisma': (b'offline source fixture\n', '100644')}
        transport = {'serverReceipt': {'baseline': {}, 'projectionSha256': a.fingerprint(record)}}
        receipt = {'producer': P, 'applicationInputSha256': a.APPROVED_APPLICATION_INPUT_SHA256,
                   'projectionSha256': a.fingerprint(record)}
        projection = SimpleNamespace(verify_build_context=Mock())
        d = SimpleNamespace()
        def write_files(folder, files):
            folder.mkdir(mode=0o700)
            for name, (raw, _) in files.items():
                path = folder / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        d.write_registration_files = write_files
        def docker(*args, **kwargs):
            return json.dumps([{'Id': 'sha256:' + '7' * 64, 'Architecture': 'amd64', 'Config': {'Labels': {
                'org.opencontainers.image.revision': N, 'id-business-v2.source-tree': T, a.LABEL: a.fingerprint(record)}}}])
        d.run = docker
        scope = SimpleNamespace(content_command=lambda *_: 'offline read-only content',
            content_summary=lambda *_: a.migration_image_content(projection, output),
            workspace_acceptance=lambda *_: {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
                'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'], 'businessActions': 0, 'temporaryVolumeRemoved': True})
        environment = {'RELEASE_COMMIT': N, 'SOURCE_TREE': T, 'GITHUB_RUN_ID': '12', 'GITHUB_RUN_ATTEMPT': '1',
                       'QUALITY_RUN_ID': '44', 'RELEASE_REPOSITORY': REPOSITORY}
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            a.write_private(self.root / a.PREFLIGHT, transport)
            with patch.dict(os.environ, environment), patch.object(a, 'modules', return_value=(d, None, scope, projection)), \
                 patch.object(a, 'source', return_value=(output, output, record, a.APPROVED_APPLICATION_INPUT_SHA256, 'd' * 64)), \
                 patch.object(a, 'local_preflight', return_value=receipt):
                self.assertEqual(a.prepare(d), record)
                proof = a.build_proof(d)
                self.assertEqual(a.closed_json(a.private_bytes(self.root / a.PROOF)), proof)
            for name in (a.PROJECTION, a.PROOF):
                self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o600)
        finally:
            os.chdir(previous)


class BaselineTests(unittest.TestCase):
    setUp = SuccessorTests.setUp
    tearDown = SuccessorTests.tearDown

    def fixture(self):
        b = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
        releases = {}
        for name in ('B', 'D', 'H'):
            folder = self.root / 'releases' / name; folder.mkdir(parents=True, mode=0o700); releases[name] = folder
        (self.root / 'current').symlink_to(releases['H'])
        volume = {'name': 'offline_sqlite', 'status': 'PRESENT', 'identitySha256': '6' * 64}
        origin = {'apiWorkspacePublication': {'volume': volume}, 'pendingOnlineMigration': {'historical': True},
                  'preservedMigrationOrigin': {'historical': True}}
        old = {'commit': b, 'sourceTree': T, **origin}
        b_raw = a.write_private(releases['B'] / 'release-manifest.json', old)
        b_record = a.write_private(releases['B'] / 'api-admin-preservation.json', {'pendingOnlineMigrationOrigin': {'version': 2}})
        b_proof = a.write_private(releases['B'] / 'api-admin-build-proof.json', {'historical': True})
        projection = {'projectionSha256': '7' * 64}
        images = {'api': {'reference': 'offline-api', 'imageId': 'sha256:' + '7' * 64, 'fileCount': 2, 'sha256': '9' * 64},
                  'admin': {'reference': 'offline-admin', 'imageId': 'sha256:' + '8' * 64}}
        states, metadata = {}, {}
        for index, name in enumerate(a.SERVICES):
            identifier = format(index + 1, 'x') * 64
            image = images[name]['imageId'] if name in images else 'sha256:' + '1' * 64
            reference = images[name]['reference'] if name in images else 'offline-' + name
            labels = {'org.opencontainers.image.revision': b if name == 'api' else D, 'id-business-v2.source-tree': T,
                      'id-business-v2.admin-pending-projection-sha256': projection['projectionSha256']}
            config = {'Hostname': identifier[:12], 'Image': reference, 'Labels': labels, 'Env': ['OFFLINE_ENV=fixture']}
            row = {'Id': identifier, 'Image': image, 'Config': config,
                   'HostConfig': {'NetworkMode': 'offline-network', 'Dns': None, 'DnsOptions': None, 'DnsSearch': None},
                   'Mounts': [{'Destination': '/offline-data', 'Source': '/offline-data', 'RW': True}]}
            metadata[identifier] = row
            states[name] = {'containerId': identifier, 'image': image, 'reference': reference, 'status': 'running',
                'health': None if name == 'caddy' else 'healthy', 'startedAtSha256': '3' * 64, 'environmentSha256': '4' * 64,
                'configurationSha256': a.fingerprint({n: row[n] for n in ('Config', 'HostConfig', 'Mounts')})}
        ledger = {'commit': D, 'inheritedManifestSha256': a.digest(b_raw), 'projection': projection,
            'preservedServices': {n: {'before': copy.deepcopy(states[n]), 'after': copy.deepcopy(states[n])}
                                  for n in a.SERVICES if n != 'admin'}}
        before = {'commit': D, 'sourceTree': T, 'previousRelease': str(releases['B']),
                  'previousManifestSha256': a.digest(b_raw), 'adminPublication': ledger, **origin}
        d_raw = a.write_private(releases['D'] / 'release-manifest.json', before)
        a.write_private(releases['D'] / 'admin-build-proof.json', {'projection': projection, 'image': images['admin']})
        hotfix = {'previousRelease': str(releases['D']), 'previousManifestSha256': a.digest(d_raw)}
        current = {**before, 'previousRelease': str(releases['D']), 'previousManifestSha256': a.digest(d_raw),
                   'apiHotfixPublication': hotfix}
        a.write_private(releases['H'] / 'release-manifest.json', current)
        runtime = {n: (('offline runtime:' + n).encode(), '100644') for n in
                   ('docker-compose.aws-mysql.yml', a.MIGRATION_SCHEMA, 'apps/api/prisma-mysql/seed.ts')}
        for folder in releases.values():
            for name, (raw, _mode) in runtime.items():
                path = folder / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
            env = folder / '.env.aws.production'; env.write_bytes(b'offline environment fixture'); env.chmod(0o600)
            caddy = folder / 'deploy/caddy/Caddyfile.aws'; caddy.parent.mkdir(parents=True); caddy.write_bytes(b'offline edge fixture')
            a.write_private(folder / 'compose.release.json', {'services': {}})
        authenticated = {'apiImage': images['api'], 'apiSourceCommit': b, 'apiSourceTree': T,
            'hotfixPublicationSha256': a.fingerprint(hotfix), 'hotfixReadbackCommandId': COMMAND,
            'hotfixReadbackInvocationBytesSha256': 'a' * 64, 'services': copy.deepcopy(states), 'restorationBinding': None,
            'nativeRestartBinding': None,
            'historicalB': {'release': str(releases['B']), 'manifestSha256': a.digest(b_raw), 'recordSha256': a.digest(b_record),
                'proofSha256': a.digest(b_proof), 'nativeReadbackCommandId': COMMAND, 'nativeInvocationSha256': 'b' * 64, 'authenticated': True}}
        def docker(*args, **kwargs):
            if args[:2] == ('docker', 'inspect'): return json.dumps([metadata[args[2]]])
            if args[:3] == ('docker', 'image', 'inspect'):
                name = next(n for n, image in images.items() if args[3] in (image['reference'], image['imageId']))
                labels = metadata[states[name]['containerId']]['Config']['Labels']
                return json.dumps([{'Id': images[name]['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': labels}}])
            return 'offline content'
        d = SimpleNamespace(BASE=self.root, run=docker, service_state=lambda folder, name: copy.deepcopy(states[name]),
                            compose=lambda *args, **kwargs: 'offline content')
        scope = SimpleNamespace(STATE_FILE='api-admin-preservation.json', PROOF_FILE='api-admin-build-proof.json',
            validate_pending_online_origin=lambda value: value, workspace_sqlite_receipt=Mock(),
            snapshot=lambda *_: copy.deepcopy(states), content_command=lambda name: 'offline ' + name,
            content_summary=lambda *_: {'fileCount': 2, 'sha256': '9' * 64}, jobs_idle=lambda *_: {'registrationBusy': False},
            workspace_volume=lambda *args, **kwargs: copy.deepcopy(volume), workspace_idle=Mock(), workspace_audit_protection=Mock(),
            workspace_private_inspect=Mock())
        admin = SimpleNamespace(BASELINE=b, BASELINE_MANIFEST_SHA256=a.digest(b_raw), ORIGIN_MARKERS=tuple(origin),
            source_projection=lambda *_: ({}, {}, projection, runtime, None), readback=Mock(side_effect=AssertionError('cold Admin reader must not assert hotfix live API')))
        helper = SimpleNamespace(authenticate_hotfix=lambda *_: copy.deepcopy(authenticated))
        contract = {'adminPredecessorRelease': str(releases['D']), 'adminPredecessorManifestSha256': a.digest(d_raw),
                    'services': copy.deepcopy(states)}
        self.fixture_states, self.fixture_metadata, self.fixture_authenticated = states, metadata, authenticated
        self.fixture_contract = contract
        controls = [patch.object(a, 'load', return_value=helper), patch.object(a, 'BASELINE_CONTRACT', contract),
                    patch.object(a, 'migration_database_state', return_value=migration_state('PENDING')),
                    patch.object(a, 'grant_state', return_value={'newTablePrivileges': [], 'schemaGrantsSha256': 'c' * 64, 'preservedGrantsSha256': 'd' * 64})]
        return d, admin, scope, controls, releases, current

    def test_hotfix_D_B_ancestors_and_native_B_identity_survive_five_service_loop(self):
        d, admin, scope, controls, releases, _current = self.fixture()
        with ExitStack() as stack:
            for control in controls: stack.enter_context(control)
            current, _manifest, evidence = a.baseline(d, admin, scope, D)
        self.assertEqual(current, releases['H'])
        self.assertEqual(evidence['apiOriginReadbackCommandId'], COMMAND)
        self.assertEqual(evidence['apiOriginReadbackInvocationBytesSha256'], 'b' * 64)
        self.assertEqual(evidence['adminPredecessorRelease'], str(releases['D']))
        admin.readback.assert_not_called()

    def test_top_previous_pointer_cannot_skip_genuine_admin_D(self):
        d, admin, scope, controls, releases, current = self.fixture()
        current['previousRelease'] = str(releases['B'])
        (releases['H'] / 'release-manifest.json').write_text(json.dumps(current))
        with ExitStack() as stack:
            for control in controls: stack.enter_context(control)
            with self.assertRaisesRegex(RuntimeError, 'ADMIN_ANCESTOR_CHANGED'): a.baseline(d, admin, scope, D)

    def restart_fixture(self):
        result = self.fixture()
        for state in self.fixture_states.values():
            row = self.fixture_metadata[state['containerId']]
            for name in ('Dns', 'DnsOptions', 'DnsSearch'):
                row['HostConfig'][name] = []
            state['configurationSha256'] = a.fingerprint({n: row[n] for n in ('Config', 'HostConfig', 'Mounts')})
            state['startedAtSha256'] = '5' * 64
        self.fixture_authenticated['services'] = copy.deepcopy(self.fixture_states)
        self.fixture_authenticated['nativeRestartBinding'] = {'authenticated': True,
            'scope': 'UNPUBLISHED_COMPONENT_SAME_CONTAINER_RESTART',
            'servicesSha256': a.fingerprint(self.fixture_states), 'migrationState': migration_state('PENDING')}
        return result

    def test_native_restart_uses_authenticated_current_states_and_retains_cold_ledger(self):
        d, admin, scope, controls, _releases, _current = self.restart_fixture()
        with ExitStack() as stack:
            for control in controls: stack.enter_context(control)
            _directory, _manifest, evidence = a.baseline(d, admin, scope, D)
        self.assertEqual(evidence['services'], self.fixture_states)
        self.assertIsNone(evidence['restorationBinding'])
        self.assertEqual(evidence['migrationState']['status'], 'PENDING')
        self.assertNotEqual(evidence['services'], self.fixture_contract['services'])

    def test_restart_binding_cannot_mix_restoration_or_apply_migration(self):
        for variant in ('restoration', 'state', 'applied'):
            d, admin, scope, controls, _releases, _current = self.restart_fixture()
            if variant == 'restoration':
                self.fixture_authenticated['restorationBinding'] = {'authenticated': True}
            elif variant == 'state':
                self.fixture_authenticated['nativeRestartBinding']['servicesSha256'] = '0' * 64
            with self.subTest(variant=variant), ExitStack() as stack:
                for control in controls: stack.enter_context(control)
                if variant == 'applied':
                    stack.enter_context(patch.object(a, 'migration_database_state', return_value=migration_state('APPLIED')))
                with self.assertRaisesRegex(RuntimeError, 'RESTART_AUTHENTICATION_INVALID|RESTART_MIGRATION_STATE_CHANGED'):
                    a.baseline(d, admin, scope, D)
            # Each variant requires independent immutable ancestry fixtures.
            self.tmp.cleanup(); self.setUp()


class PreservationTests(unittest.TestCase):
    def setUp(self):
        SuccessorTests.setUp(self)
        self.controls = ExitStack()
        self.controls.enter_context(patch.object(a, 'migration_source_check', return_value={}))
        self.controls.enter_context(patch.dict(a.MIGRATION_IDENTITY, {'schemaBeforeSha256': a.digest(b'offline:apps/api/prisma-mysql/schema.prisma'), 'schemaAfterSha256': a.digest(b'offline:apps/api/prisma-mysql/schema.prisma')}))
        self.addCleanup(self.controls.close)
    tearDown = SuccessorTests.tearDown

    def fixture(self):
        previous, target = self.root / 'releases/previous', self.root / 'releases/target'
        previous.mkdir(parents=True, mode=0o700); target.mkdir(parents=True, mode=0o700)
        (self.root / 'current').symlink_to(previous)
        manifest_raw = a.write_private(previous / 'release-manifest.json', {'commit': D})
        for name in ('.env.aws.production', 'docker-compose.aws-mysql.yml', 'apps/api/prisma-mysql/schema.prisma',
                     'apps/api/prisma-mysql/seed.ts', 'deploy/caddy/Caddyfile.aws'):
            for folder in (previous, target):
                path = folder / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(('offline:' + name).encode()); path.chmod(0o600)
        states = {n: {'status': 'running', 'health': 'healthy', 'image': 'sha256:' + '1' * 64,
            'reference': 'offline-' + n, 'containerId': '2' * 64, 'startedAtSha256': '3' * 64,
            'environmentSha256': '4' * 64, 'configurationSha256': '5' * 64} for n in a.SERVICES}
        volume = {'name': 'offline_sqlite', 'status': 'PRESENT', 'identitySha256': '6' * 64}
        images = {n: {'reference': 'new-' + n} for n in a.IMAGE_SERVICES}
        override = {'services': {n: {'image': states[n]['reference'], 'pull_policy': 'never'} for n in a.SERVICES}}
        a.write_private(previous / 'compose.release.json', override)
        updated = copy.deepcopy(override)
        for n in a.IMAGE_SERVICES:
            updated['services'][n] = {'image': images[n]['reference'], 'pull_policy': 'never'}
        a.write_private(target / 'compose.release.json', updated)
        evidence = {'currentManifestBytesSha256': a.digest(manifest_raw), 'environmentFileSha256': a.digest((previous / '.env.aws.production').read_bytes()),
            'configurationFilesSha256': {n: a.digest((previous / n).read_bytes()) for n in
                ('docker-compose.aws-mysql.yml', 'apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts', 'deploy/caddy/Caddyfile.aws', 'compose.release.json')},
            'services': states, 'workspaceVolume': volume}
        scope = SimpleNamespace(workspace_configuration=Mock(), snapshot=lambda *_: copy.deepcopy(states),
                                workspace_volume=lambda *args, **kwargs: copy.deepcopy(volume))
        d = SimpleNamespace(BASE=self.root, migration_plan=lambda *args: [a.MIGRATION_FILE])
        return d, scope, previous, target, evidence, images, states

    def test_only_api_admin_override_allowed_all_five_services_preserved(self):
        d, scope, previous, target, evidence, images, states = self.fixture()
        self.assertEqual(a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images), states)
        self.assertEqual(a.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'))
        for name in a.PRESERVED:
            changed = copy.deepcopy(states); changed[name]['containerId'] = '9' * 64
            scope.snapshot = lambda _d, _directory, changed=changed: changed
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)

    def test_migration_env_pointer_and_hidden_override_changes_rejected(self):
        d, scope, previous, target, evidence, images, _ = self.fixture()
        d.migration_plan = lambda *args: ['new/migration.sql']
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
            a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)
        d.migration_plan = lambda *args: [a.MIGRATION_FILE]
        path = target / 'compose.release.json'
        override = json.loads(path.read_bytes()); override['services']['auto-registration']['image'] = 'unpublished-worker'
        path.write_text(json.dumps(override))
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_OVERRIDE_CHANGED'):
            a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)
        (target / '.env.aws.production').write_text('different')
        with self.assertRaisesRegex(RuntimeError, 'ENVIRONMENT_CHANGED'):
            a.preserve(d, scope, previous, target, evidence, pointer=previous, images=images)


class BackupMaintenanceTests(unittest.TestCase):
    setUp_root = SuccessorTests.setUp
    tearDown = SuccessorTests.tearDown

    def setUp(self):
        self.setUp_root()
        self.previous = self.root / 'releases/20261012T182211Z-60e164b75d1e'
        self.previous.mkdir(parents=True, mode=0o700)
        self.target = self.root / 'releases/20261013T000000Z-aaaaaaaaaaaa'
        (self.target / 'scripts').mkdir(parents=True, mode=0o700)
        self.target.chmod(0o700)
        (self.root / 'current').symlink_to(self.previous)
        self.manifest = b'{"immutable":"H"}\n'
        self.environment = b'UNRELATED_SECRET=synthetic-never-print\n'
        for name, raw in (('release-manifest.json', self.manifest), ('.env.aws.production', self.environment)):
            path = self.previous / name; path.write_bytes(raw); path.chmod(0o600)
        self.script = (ROOT / 'scripts/backup-aws-mysql.sh').read_bytes()
        self.old_helper = b'# immutable original retention fixture\n'
        self.new_helper = b'# protected new retention fixture\n'
        old_namespace = self.root / 'maintenance' / a.BACKUP_OLD_NAMESPACE
        old_namespace.mkdir(parents=True, mode=0o700)
        self.old_entry = old_namespace / 'backup-aws-mysql.sh'
        for name, raw in (('backup-aws-mysql.sh', self.script), ('backup-retention-protection.py', self.old_helper)):
            path = old_namespace / name; path.write_bytes(raw); path.chmod(0o700 if name.endswith('.sh') else 0o600)
        self.files = {'scripts/backup-aws-mysql.sh': (self.script, '100755'),
                      'scripts/backup-retention-protection.py': (self.new_helper, '100644')}
        for name, (raw, mode) in self.files.items():
            path = self.target / name; path.write_bytes(raw); path.chmod(0o755 if mode == '100755' else 0o644)
        self.dropin = self.root / 'systemd' / (a.BACKUP_SERVICE + '.d') / '20-release-retention.conf'
        self.dropin.parent.mkdir(parents=True, mode=0o700)
        self.original_configuration = ('[Service]\nExecStart=\nExecStart=' + str(self.old_entry) + '\n').encode()
        self.dropin.write_bytes(self.original_configuration); self.dropin.chmod(0o600)
        self.namespace = self.root / 'maintenance' / ('mysql-backup-' + a.fingerprint(
            {Path(name).name: a.digest(raw) for name, (raw, _mode) in self.files.items()})[:16])
        self.entry = self.namespace / 'backup-aws-mysql.sh'
        self.new_configuration = ('[Service]\nExecStart=\nExecStart=' + str(self.entry) + '\n').encode()
        self.lock_path = self.root / 'backups/mysql/.backup.lock'
        self.lock_path.parent.mkdir(parents=True, mode=0o700)
        self.lock_path.touch(mode=0o600)
        self.states = {'api': {'container': 'synthetic-immutable'}}
        self.evidence = {'currentManifestBytesSha256': a.digest(self.manifest),
                         'environmentFileSha256': a.digest(self.environment), 'services': copy.deepcopy(self.states)}
        self.scope = SimpleNamespace(snapshot=lambda *_: copy.deepcopy(self.states))
        self.d = SimpleNamespace(BASE=self.root)
        self.timer = 'active'; self.service = 'failed'; self.running_entry = self.old_entry
        self.calls = []; self.native_hook = None; self.reload_fail = False; self.reload_wrong = False
        real_stat, real_fstat = os.stat, os.fstat
        class Owner:
            def __init__(self, row): self.row = row; self.st_uid = 0
            def __getattr__(self, key): return getattr(self.row, key)
        for control in (patch.object(os, 'stat', side_effect=lambda *args, **kw: Owner(real_stat(*args, **kw))),
                        patch.object(os, 'fstat', side_effect=lambda *args, **kw: Owner(real_fstat(*args, **kw))),
                        patch.object(os, 'getuid', return_value=0), patch.object(os, 'geteuid', return_value=0),
                        patch.object(a, 'BACKUP_DROPIN', self.dropin),
                        patch.object(a, 'BACKUP_OLD_HELPER_SHA256', a.digest(self.old_helper)),
                        patch.object(a, 'BACKUP_DROPIN_SHA256', a.digest(self.original_configuration)),
                        patch.dict(a.BASELINE_CONTRACT, {'currentRelease': str(self.previous),
                            'manifestSha256': a.digest(self.manifest)}),
                        patch.object(a, 'backup_native', self.native)):
            control.start(); self.addCleanup(control.stop)

    def plan(self):
        return {'kind': 'MYSQL_BACKUP_RETENTION_V1', 'status': 'PLAN_ONLY', 'code': 'OK',
                'protectedCount': 2, 'countBefore': 3, 'candidateCount': 1, 'removedCount': 0,
                'countAfter': 3, 'retainedBytes': 42, 'rawOutputSuppressed': True}

    def native(self, d, arguments, *, pass_fds=()):
        self.assertIs(d, self.d); self.calls.append(tuple(arguments))
        if self.native_hook:
            self.native_hook(arguments)
        if arguments[0] == '/usr/bin/python3':
            self.assertNotIn('--apply', arguments)
            helper_fd = int(arguments[2].rsplit('/', 1)[1])
            lock_fd = int(arguments[4])
            self.assertEqual(pass_fds, (helper_fd, lock_fd))
            self.assertEqual(os.pread(helper_fd, 1024 * 1024, 0), self.new_helper)
            descriptor = os.open(self.lock_path, os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(descriptor)
            self.assertEqual(arguments[-4:], ['--retention-count', '48', '--max-bytes', '1073741824'])
            return json.dumps(self.plan())
        self.assertEqual(arguments[0], '/usr/bin/systemctl')
        self.assertNotIn('start', arguments); self.assertNotIn('stop', arguments)
        if arguments[1:] == ['daemon-reload']:
            if self.reload_fail:
                raise RuntimeError('UNPUBLISHED_COMPONENT_BACKUP_NATIVE_FAILED')
            if not self.reload_wrong:
                self.running_entry = self.entry
            return ''
        self.assertEqual(arguments[1], 'show')
        unit, prop = arguments[2], arguments[3]
        if unit == a.BACKUP_TIMER:
            return self.timer
        self.assertEqual(unit, a.BACKUP_SERVICE)
        if prop == '--property=ActiveState': return self.service
        if prop == '--property=DropInPaths': return str(self.dropin)
        if prop == '--property=ExecStart':
            return '{ path=' + str(self.running_entry) + ' ; argv[]=' + str(self.running_entry) + ' ; ignore_errors=no ; }'
        self.fail('Unrecognized synthetic control')

    def upgrade(self):
        return a.upgrade_backup_maintenance(self.d, self.scope, self.previous, self.target, self.evidence, self.files)

    def assert_unchanged(self):
        self.assertEqual(self.dropin.read_bytes(), self.original_configuration)
        self.assertFalse(any(row[1:] == ('daemon-reload',) for row in self.calls))

    def test_exact_upgrade_holds_lock_and_preserves_immutable_H_and_old_source(self):
        value = self.upgrade()
        self.assertEqual(value['status'], 'UPGRADED')
        self.assertFalse(value['backupDeleted']); self.assertEqual(value['businessActions'], 0)
        self.assertEqual(self.dropin.read_bytes(), self.new_configuration)
        self.assertEqual(self.old_entry.read_bytes(), self.script)
        self.assertEqual(self.old_entry.with_name('backup-retention-protection.py').read_bytes(), self.old_helper)
        self.assertEqual((self.previous / 'release-manifest.json').read_bytes(), self.manifest)
        self.assertEqual((self.root / 'current').resolve(), self.previous)
        saved = json.loads((self.target / (a.PREFIX + '-backup-entry-original.json')).read_bytes())
        self.assertEqual(base64.b64decode(saved['rawBase64']), self.original_configuration)
        self.assertNotIn('UNRELATED_SECRET', json.dumps(value)); self.assertNotIn('synthetic-never-print', json.dumps(saved))
        for name, (raw, _mode) in self.files.items():
            self.assertEqual((self.namespace / Path(name).name).read_bytes(), raw)

    def test_published_component_only_verifies_already_installed_backup_entry(self):
        self.upgrade()
        self.evidence['currentRelease'] = str(self.previous)
        with patch.object(a, 'component_successor_origin', return_value={'authenticated': True}), \
             patch.dict(a.COMPONENT_PREDECESSOR, {'manifestBytesSha256': a.digest(self.manifest)}):
            before = self.dropin.read_bytes()
            result = self.upgrade()
            self.assertEqual(result['status'], 'ALREADY_VERIFIED')
            self.assertEqual(self.dropin.read_bytes(), before)
            self.dropin.write_bytes(self.original_configuration); self.dropin.chmod(0o600)
            self.running_entry = self.old_entry
            with self.assertRaisesRegex(RuntimeError, 'BACKUP_COMPONENT_ENTRY_CHANGED'):
                self.upgrade()
            self.assertEqual(self.dropin.read_bytes(), self.original_configuration)

    def test_existing_exact_entry_is_readonly_and_does_not_reload_or_add_records(self):
        self.upgrade()
        before = {path: (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes())
                  for path in (self.dropin, self.namespace / 'backup-aws-mysql.sh',
                               self.namespace / 'backup-retention-protection.py')}
        self.calls.clear()
        value = self.upgrade()
        self.assertEqual(value['status'], 'ALREADY_VERIFIED')
        self.assertFalse(any(row[1:] == ('daemon-reload',) for row in self.calls))
        self.assertEqual(before, {path: (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes()) for path in before})

    def test_busy_service_cannot_plan_or_mutate(self):
        self.service = 'activating'
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_SERVICE_BUSY'): self.upgrade()
        self.assert_unchanged(); self.assertFalse(self.namespace.exists())
        self.assertFalse(any(row[0] == '/usr/bin/python3' for row in self.calls))

    def test_existing_backup_lock_busy_blocks_plan_and_mutation(self):
        descriptor = os.open(self.lock_path, os.O_RDONLY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'BACKUP_LOCK_BUSY'): self.upgrade()
        finally:
            os.close(descriptor)
        self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_plan_failure_and_mutated_or_unclosed_output_never_change_entry(self):
        for changes in ({'status': 'APPLIED'}, {'removedCount': 1}, {'unexpected': 1}, {'candidateCount': True}):
            with self.subTest(changes=changes), patch.object(self, 'plan', return_value={**self.plan(), **changes}):
                with self.assertRaisesRegex(RuntimeError, 'BACKUP_PLAN_INVALID'): self.upgrade()
                self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_plan_execution_failure_never_creates_namespace(self):
        def fail(arguments):
            if arguments[0] == '/usr/bin/python3': raise RuntimeError('UNPUBLISHED_COMPONENT_BACKUP_NATIVE_FAILED')
        self.native_hook = fail
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_NATIVE_FAILED'): self.upgrade()
        self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_tampered_source_or_file_mode_or_links_block_before_writes(self):
        path = self.target / 'scripts/backup-retention-protection.py'
        for change in ('bytes', 'mode', 'symlink', 'hardlink'):
            with self.subTest(change=change):
                if path.is_symlink() or path.exists(): path.unlink()
                linked = self.target / 'source-link'
                if linked.exists(): linked.unlink()
                path.write_bytes(self.new_helper); path.chmod(0o644)
                if change == 'bytes': path.write_bytes(b'other')
                if change == 'mode': path.chmod(0o666)
                if change == 'symlink':
                    linked.write_bytes(self.new_helper); path.unlink(); path.symlink_to(linked)
                if change == 'hardlink': os.link(path, linked)
                with self.assertRaises(RuntimeError): self.upgrade()
                self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_old_helper_tamper_and_dropin_mode_cannot_be_overwritten(self):
        old_helper = self.old_entry.with_name('backup-retention-protection.py')
        old_helper.write_bytes(b'other')
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_OLD_SOURCE_CHANGED'): self.upgrade()
        old_helper.write_bytes(self.old_helper)
        self.dropin.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_FILE_INVALID'): self.upgrade()
        self.assert_unchanged()

    def test_directory_link_and_writable_namespace_are_rejected(self):
        self.namespace.symlink_to(self.old_entry.parent, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_AUTHORITY_INVALID'): self.upgrade()
        self.namespace.unlink(); self.namespace.mkdir(mode=0o777); self.namespace.chmod(0o777)
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_AUTHORITY_INVALID'): self.upgrade()
        self.assert_unchanged()

    def test_dropin_race_after_plan_is_detected_and_unknown_bytes_preserved(self):
        def race(arguments):
            if arguments[0] == '/usr/bin/python3': self.dropin.write_bytes(b'unknown raced entry\n')
        self.native_hook = race
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_FILE_CHANGED'): self.upgrade()
        self.assertEqual(self.dropin.read_bytes(), b'unknown raced entry\n')
        self.assertFalse(self.namespace.exists())

    def test_dropin_identity_race_at_final_CAS_is_detected(self):
        count = 0
        def race(arguments):
            nonlocal count
            if '--property=ExecStart' in arguments:
                count += 1
                if count == 2:
                    replacement = self.dropin.with_name('concurrent-replacement.conf')
                    replacement.write_bytes(self.original_configuration); replacement.chmod(0o600)
                    os.replace(replacement, self.dropin)
        self.native_hook = race
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_FILE_CHANGED'): self.upgrade()
        self.assert_unchanged()

    def test_current_pointer_race_after_plan_is_rejected(self):
        def race(arguments):
            if arguments[0] == '/usr/bin/python3':
                pointer = self.root / 'current'; pointer.unlink(); pointer.symlink_to(self.target)
        self.native_hook = race
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_CURRENT_CHANGED'): self.upgrade()
        self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_current_or_services_race_after_plan_stops_before_mutation(self):
        def race(arguments):
            if arguments[0] == '/usr/bin/python3': self.states['api']['container'] = 'different'
        self.native_hook = race
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_SERVICES_CHANGED'): self.upgrade()
        self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_timer_change_after_plan_keeps_entry_unchanged(self):
        def race(arguments):
            if arguments[0] == '/usr/bin/python3': self.timer = 'inactive'
        self.native_hook = race
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_TIMER_CHANGED'): self.upgrade()
        self.assert_unchanged(); self.assertFalse(self.namespace.exists())

    def test_daemon_reload_failure_and_wrong_entry_do_not_return_success(self):
        self.reload_fail = True
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_NATIVE_FAILED'): self.upgrade()
        self.assertEqual(self.dropin.read_bytes(), self.new_configuration)
        # Failed reload is deliberately not accepted as an idempotent installation.
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_ENTRY_CHANGED'): self.upgrade()

    def test_reload_success_with_wrong_loaded_entry_is_rejected(self):
        self.reload_wrong = True
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_ENTRY_CHANGED'): self.upgrade()


class PipelineTests(unittest.TestCase):
    setUp = SuccessorTests.setUp
    tearDown = SuccessorTests.tearDown

    def fixture(self, *, active=False, late_active=False, fail_api=False):
        root = self.root
        previous = root / 'releases/previous'; previous.mkdir(parents=True, mode=0o700)
        (root / 'current').symlink_to(previous)
        b = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
        markers = {'apiWorkspacePublication': {'version': 4, 'onlinePublished': False, 'sqliteProtectionSha256': 'd' * 64},
            'pendingOnlineMigration': {'publicationIndex': 2, 'successorConfigurationSeal': {'currentProducer': {'commit': b}}},
            'preservedMigrationOrigin': {'original': 'immutable'}}
        old = {'commit': D, 'sourceTree': T, 'apiHotfixPublication': {'scope': 'AUTHENTICATED_OFFLINE_HOTFIX'}, 'adminPublication': {'commit': D, 'componentBaselines': {'api': b}}, **markers,
               'images': {n: {'reference': 'offline-' + n, 'digest': 'sha256:' + '1' * 64, 'sourceCommit': b} for n in a.SERVICES}}
        manifest_raw = a.write_private(previous / 'release-manifest.json', old)
        files = {n: (('offline:' + n).encode(), '100644') for n in
            ('docker-compose.aws-mysql.yml', 'apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts', 'deploy/caddy/Caddyfile.aws')}
        for name, (raw, _) in files.items():
            path = previous / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
        env = previous / '.env.aws.production'; env.write_bytes(b'offline placeholder'); env.chmod(0o600)
        states = {n: {'status': 'running', 'health': 'healthy', 'image': 'sha256:' + '1' * 64,
            'reference': 'offline-' + n, 'containerId': '2' * 64, 'startedAtSha256': '3' * 64,
            'environmentSha256': '4' * 64, 'configurationSha256': '5' * 64} for n in a.SERVICES}
        override = {'services': {n: {'image': states[n]['reference'], 'pull_policy': 'never'} for n in a.SERVICES}}
        a.write_private(previous / 'compose.release.json', override)
        volume = {'name': 'offline_sqlite', 'status': 'PRESENT', 'identitySha256': '6' * 64}
        evidence = {'currentRelease': str(previous), 'currentCommit': D,
            'currentManifestBytesSha256': a.digest(manifest_raw), 'environmentFileSha256': a.digest(env.read_bytes()),
            'configurationFilesSha256': {n: a.digest((previous / n).read_bytes()) for n in (*files, 'compose.release.json')},
            'services': copy.deepcopy(states), 'workspaceVolume': volume,
            'originMarkersSha256': a.fingerprint(markers), 'guards': {'rechargeIdle': True, 'registrationBusy': False}, 'apiCurrentSourceCommit': b,
            'restorationBinding': None, 'migrationState': migration_state('PENDING'),
            'configurationModels': {n: {'sha256': 'a' * 64, 'automaticHostname': True} for n in a.UPDATED},
            'databaseGrants': {'preservedGrantsSha256': 'd' * 64, 'schemaGrantsSha256': 'e' * 64, 'newTablePrivileges': []}}
        record = {'version': 1, 'contextPath': a.CONTEXT, 'candidateCommit': N, 'candidateTree': T,
                  'projectionSha256': 'e' * 64}
        receipt = server_receipt(); receipt['baseline'] = evidence; receipt['projectionSha256'] = a.fingerprint(record)
        d = SimpleNamespace(BASE=root)
        a.write_private(a.evidence_path(d, P), receipt)
        transport = a.make_transport(native(receipt), COMMAND, INSTANCE)
        images = {n: {'reference': f'{REPOSITORY}:{N}-12-1-{n}', 'imageId': 'sha256:' + ('7' if n == 'api' else '8') * 64,
                      'fileCount': 2, 'sha256': '9' * 64} for n in a.IMAGE_SERVICES}
        images['migrate'].update(a.migration_image_content(None, files))
        proof = {'version': 1, 'scope': a.BUILD_SCOPE, 'migration': a.MIGRATION_IDENTITY, 'commit': N, 'sourceTree': T, 'runId': '12', 'runAttempt': '1',
            'qualityRunId': '44', 'preflightSha256': a.fingerprint(transport), 'baselineSha256': a.fingerprint(evidence),
            'projection': record, 'images': images, 'acceptance': {'status': 'PASS', 'checks': ['private-health', 'packaged-resources',
                'private-sqlite', 'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'], 'businessActions': 0, 'temporaryVolumeRemoved': True}}
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            if args[:3] == ('docker', 'image', 'inspect'):
                name = next(n for n, row in images.items() if args[3] in (row['imageId'], row['reference']))
                return json.dumps([{'Id': images[name]['imageId'], 'Architecture': 'amd64', 'Config': {'Labels':
                    {'org.opencontainers.image.revision': N, 'id-business-v2.source-tree': T, a.LABEL: a.fingerprint(record)}}}])
            if args[:2] == ('docker', 'inspect'):
                return json.dumps([{'Id': args[2], 'State': {'Running': False, 'Pid': 0}}])
            return ''
        def write_files(folder, items):
            folder.mkdir(parents=True, mode=0o700)
            for name, (raw, mode) in items.items():
                path = folder / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
                path.chmod(0o755 if mode == '100755' else 0o644)
        def compose(directory, *args, **kwargs):
            calls.append(('compose', *args))
            if args[0] == 'up':
                name = args[-1]
                states[name] = {**states[name], 'image': images[name]['imageId'], 'reference': images[name]['reference'], 'containerId': 'a' * 64}
            return ''
        def point_current(target, _run):
            (root / 'current').unlink(); (root / 'current').symlink_to(target)
        def wait_healthy(_target, name):
            if fail_api and name == 'api':
                raise RuntimeError('UNPUBLISHED_COMPONENT_STARTUP_FAILED')
        def rollback(_previous, _target, name, before):
            calls.append(('rollback', name)); states[name] = {**copy.deepcopy(before[name]), 'containerId': 'b' * 64, 'startedAtSha256': 'c' * 64}
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): return None
            def read(self, *_): return ('v2-' + N).encode()
        d.run = run; d.write_registration_files = write_files; d.compose = compose; d.point_current = point_current
        d.wait_healthy = wait_healthy; d.rollback_service = rollback
        d.shutil = SimpleNamespace(disk_usage=lambda _: SimpleNamespace(free=10 * 1024**3))
        d.subprocess = SimpleNamespace(run=lambda *args, **kwargs: SimpleNamespace(returncode=0))
        d.migration_plan = lambda *args: [a.MIGRATION_FILE]
        d.fresh_backup = lambda _: {'name': 'id-business-v2-offline-backup.sql.gz', 'sha256': 'c' * 64, 'size': 100, 's3Verified': True}
        d.environment_values = lambda _: {'APP_PUBLIC_URL': 'https://offline.invalid'}
        d.urllib = SimpleNamespace(request=SimpleNamespace(urlopen=lambda *args, **kwargs: Response()))
        class Gate:
            def __init__(self):
                self.record = {'version': 1, 'restoreVerified': True}; self.volume = volume
                self.summary = {'logicalSha256': 'f' * 64}; self.marker = True
            def check_locked(self): calls.append(('gate', 'check_locked'))
            def check_marker(self): a.need(self.marker, 'MARKER_CHANGED')
            def stop_previous(self): calls.append(('gate', 'stop_previous'))
            def finish(self): calls.append(('gate', 'finish')); self.marker = False
            def close(self): calls.append(('gate', 'close'))
            def abort(self): calls.append(('gate', 'abort')); self.marker = False
        gate = Gate()
        def jobs(_d, directory, **kwargs):
            calls.append(('jobs', str(directory)))
            if active or late_active and states['api']['image'] == images['api']['imageId']:
                raise RuntimeError('API_ADMIN_REGISTRATION_BUSY')
            return {'rechargeIdle': True, 'registrationBusy': False}
        scope = SimpleNamespace(snapshot=lambda *_: copy.deepcopy(states), workspace_configuration=lambda *args: {},
            workspace_volume=lambda *args, **kwargs: copy.deepcopy(volume), workspace_idle=lambda *args, **kwargs: None,
            workspace_audit_protection=lambda *args: 'e' * 64, jobs_idle=jobs,
            workspace_database_identity=lambda *args: {}, workspace_private_inspect=lambda *args, **kwargs: {},
            workspace_prepare=lambda *args, **kwargs: gate, workspace_sqlite_receipt=lambda *args: {},
            workspace_api_identity=lambda *args, **kwargs: {'containerId': states['api']['containerId']},
            workspace_api_metadata=lambda *args: {'Id': states['api']['containerId'], 'Image': states['api']['image'],
                                                  'State': {'Running': True, 'Pid': 123}},
            verify_running=lambda *args: None,
            strict_audit=lambda *args: {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': 'd' * 64},
            content_summary=lambda *args: a.migration_image_content(projection, files), content_command=lambda *args: 'offline readonly content')
        admin = SimpleNamespace(BASELINE=b, ORIGIN_MARKERS=tuple(markers))
        projection = SimpleNamespace(inventory=lambda items: {n: {'mode': row[1], 'sha256': a.digest(row[0])} for n, row in items.items()},
            runtime_config_files=lambda *args: {n: files[n] for n in
            ('docker-compose.aws-mysql.yml', 'apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts')})
        args = SimpleNamespace(api_fault_restore_approved=True, commit=N, source_tree=T, run_id='12', run_attempt='1',
                               expected_current=D, ci_run_id='44', repository=REPOSITORY)
        context = {'modules': patch.object(a, 'modules', return_value=(d, admin, scope, projection)),
            'backup_maintenance': patch.object(a, 'upgrade_backup_maintenance', side_effect=lambda *args:
                (calls.append(('backup-maintenance', 'verified')) or {'status': 'UPGRADED', 'businessActions': 0})),
            'source': patch.object(a, 'source', return_value=(files, files, record, 'd' * 64, 'd' * 64)),
            'baseline': patch.object(a, 'baseline', return_value=(previous, old, evidence)),
            'instance': patch.object(a, 'instance_id', return_value=INSTANCE),
            'seal': patch.object(a, 'APPROVED_APPLICATION_INPUT_SHA256', 'd' * 64),
            'migration_source': patch.object(a, 'migration_source_check', return_value={}),
            'migration_read': patch.object(a, 'migration_database_state', return_value=migration_state('APPLIED')),
            'migration_apply': patch.object(a, 'apply_migration', side_effect=lambda *args: (calls.append(('migration', 'verified')) or {**migration_state('APPLIED'), 'performed': True, 'before': migration_state('PENDING'), 'grants': {'ok': True, 'newTableCount': 1, 'runtimeTableCount': 100}})),
            'grant_preservation': patch.object(a, 'require_grants_preserved', return_value={'preservedGrantsSha256': 'd' * 64, 'schemaGrantsSha256': 'e' * 64, 'newTablePrivileges': []}),
            'configuration_model': patch.object(a, 'configuration_model', return_value={'sha256': 'a' * 64, 'automaticHostname': True}),
            'schema': patch.dict(a.MIGRATION_IDENTITY, {'schemaBeforeSha256': a.digest(files[a.MIGRATION_SCHEMA][0]), 'schemaAfterSha256': a.digest(files[a.MIGRATION_SCHEMA][0])})}
        return d, args, proof, transport, context, calls, gate, old

    def exercise(self, fixture):
        d, args, proof, transport, context, *_ = fixture
        with ExitStack() as stack:
            for control in context.values(): stack.enter_context(control)
            return a.release(d, args, proof, transport)

    def test_positive_component_chain_keeps_B_origins_and_all_five_services(self):
        fixture = self.fixture(); result = self.exercise(fixture)
        d, _args, _proof, _transport, _context, calls, gate, old = fixture
        manifest = json.loads(((d.BASE / 'current').resolve() / 'release-manifest.json').read_bytes())
        self.assertEqual(result['status'], 'UNPUBLISHED_COMPONENT_VERIFIED')
        self.assertTrue(result['sqliteMaintenanceReleased'])
        self.assertFalse(gate.marker)
        self.assertEqual([call[-1] for call in calls if call[:2] == ('compose', 'up')], ['api', 'admin'])
        self.assertEqual(manifest['apiComponentPublication']['componentBefore'], {'api': '31d2c6885a45817cd40d23fce8d6145bc9f18af2', 'admin': D})
        self.assertEqual(manifest['apiComponentPublication']['componentAfter'], {'api': N, 'admin': N})
        for name in ('apiWorkspacePublication', 'pendingOnlineMigration', 'preservedMigrationOrigin', 'adminPublication'):
            self.assertEqual(manifest[name], old[name])
        self.assertTrue(manifest['migrationApplied'])
        self.assertEqual(manifest['newMigrations'], [a.MIGRATION_FILE])
        self.assertEqual(manifest['databaseGrants']['status'], 'VERIFIED')
        self.assertLess(calls.index(('gate', 'check_locked')), calls.index(('gate', 'stop_previous')))
        self.assertIn(('gate', 'finish'), calls)

    def test_running_task_blocks_stop_and_keeps_business_untouched(self):
        fixture = self.fixture(active=True)
        with self.assertRaises(a.ComponentFailure) as error:
            self.exercise(fixture)
        calls = fixture[5]
        self.assertEqual(error.exception.receipt['servicesAttempted'], [])
        self.assertFalse(any(call[:2] == ('compose', 'up') or call[:2] == ('docker', 'stop')
                             or call == ('gate', 'stop_previous') for call in calls))
        self.assertEqual(error.exception.receipt['recovery']['status'], 'NOT_REQUIRED')

    def test_late_accepted_task_prevents_fault_restore_even_when_approved(self):
        fixture = self.fixture(late_active=True, fail_api=True)
        with self.assertRaises(a.ComponentFailure) as error:
            self.exercise(fixture)
        self.assertEqual(error.exception.receipt['recovery']['status'], 'BLOCKED_OR_FAILED')
        self.assertFalse(any(call[0] == 'rollback' or call[:2] == ('docker', 'stop') for call in fixture[5]))
        self.assertTrue(fixture[6].marker)

    def test_no_backup_restore_proof_never_stops_api(self):
        fixture = self.fixture()
        d, args, proof, transport, context, calls, _gate, _old = fixture
        with ExitStack() as stack:
            for control in context.values(): stack.enter_context(control)
            scope = a.modules(d)[2]
            scope.workspace_prepare = lambda *args, **kwargs: None
            with self.assertRaisesRegex(a.ComponentFailure, 'SQLITE_PROTECTION_REQUIRED'):
                a.release(d, args, proof, transport)
        self.assertFalse(any(call[:2] == ('compose', 'up') or call[:2] == ('docker', 'stop') for call in calls))

    def test_approved_startup_fault_restores_only_attempted_api_after_idle_proof(self):
        fixture = self.fixture(fail_api=True)
        with self.assertRaises(a.ComponentFailure) as error:
            self.exercise(fixture)
        self.assertEqual(error.exception.receipt['servicesAttempted'], ['api'])
        self.assertEqual(error.exception.receipt['recovery']['status'], 'RESTORED')
        self.assertEqual(error.exception.receipt['recovery']['services'], {'api': 'RESTORED'})
        self.assertTrue(error.exception.receipt['recovery']['independentReadbackRequired'])
        self.assertEqual([call for call in fixture[5] if call[0] == 'rollback'], [('rollback', 'api')])
        self.assertFalse(fixture[6].marker)

    def test_known_stopped_api_needs_no_signal_and_unknown_image_is_rejected(self):
        fixture = self.fixture()
        d, _args, proof, transport, context, calls, gate, _old = fixture
        evidence = transport['serverReceipt']['baseline']
        with context['modules']:
            scope = a.modules(d)[2]
            scope.workspace_api_metadata = lambda *args: {'Id': evidence['services']['api']['containerId'],
                'Image': evidence['services']['api']['image'], 'State': {'Running': False, 'Pid': 0}}
            a.stop_failed_api(d, scope, Path(evidence['currentRelease']), proof, evidence, gate, {})
            self.assertFalse(any(call[:2] == ('docker', 'stop') for call in calls))
            scope.workspace_api_metadata = lambda *args: {'Id': 'a' * 64, 'Image': 'sha256:' + 'c' * 64,
                                                          'State': {'Running': False, 'Pid': 0}}
            with self.assertRaisesRegex(RuntimeError, 'API_IDENTITY_CHANGED'):
                a.stop_failed_api(d, scope, Path(evidence['currentRelease']), proof, evidence, gate, {})

    def test_migration_is_verified_before_stopping_api(self):
        fixture = self.fixture(); self.exercise(fixture)
        calls = fixture[5]
        self.assertLess(calls.index(('migration', 'verified')), calls.index(('gate', 'stop_previous')))
        self.assertEqual(sum(call == ('migration', 'verified') for call in calls), 1)

    def test_backup_maintenance_failure_blocks_fresh_backup_migration_and_services(self):
        fixture = self.fixture()
        fixture[0].fresh_backup = Mock(side_effect=AssertionError('No backup start after maintenance refusal'))
        fixture[4]['backup_maintenance'] = patch.object(a, 'upgrade_backup_maintenance',
            side_effect=RuntimeError('UNPUBLISHED_COMPONENT_BACKUP_ENTRY_CHANGED'))
        with self.assertRaisesRegex(a.ComponentFailure, 'BACKUP_ENTRY_CHANGED') as error:
            self.exercise(fixture)
        fixture[0].fresh_backup.assert_not_called()
        self.assertEqual(error.exception.receipt['phase'], 'backup')
        self.assertEqual(error.exception.receipt['servicesAttempted'], [])
        self.assertFalse(any(call == ('migration', 'verified') or call == ('gate', 'stop_previous')
                             or call[:2] == ('compose', 'up') for call in fixture[5]))

    def test_maintenance_is_verified_after_audit_and_before_fresh_backup(self):
        fixture = self.fixture()
        original = fixture[0].fresh_backup
        fixture[0].fresh_backup = lambda previous: (fixture[5].append(('fresh-backup', 'verified')) or original(previous))
        self.exercise(fixture)
        self.assertLess(fixture[5].index(('backup-maintenance', 'verified')),
                        fixture[5].index(('fresh-backup', 'verified')))
        self.assertLess(fixture[5].index(('fresh-backup', 'verified')),
                        fixture[5].index(('migration', 'verified')))

    def test_missing_verified_s3_backup_blocks_migration_and_stop(self):
        fixture = self.fixture()
        fixture[0].fresh_backup = lambda _: {'name': 'id-business-v2-offline.sql.gz', 'sha256': 'c' * 64, 'size': 100, 's3Verified': False}
        with self.assertRaisesRegex(a.ComponentFailure, 'FRESH_S3_BACKUP_REQUIRED'):
            self.exercise(fixture)
        self.assertFalse(any(call == ('migration', 'verified') or call == ('gate', 'stop_previous') for call in fixture[5]))

    def test_restored_new_container_needs_and_passes_separate_readback_binding(self):
        fixture = self.fixture(fail_api=True)
        with self.assertRaises(a.ComponentFailure) as error:
            self.exercise(fixture)
        d, _args, _proof, _transport, controls, _calls, _gate, _old = fixture
        self.assertEqual(error.exception.receipt['recovery']['status'], 'RESTORED')
        saved = json.loads(Path(error.exception.receipt['recovery']['restorationLedgerPath']).read_bytes())
        self.assertNotEqual(saved['before']['api']['containerId'], saved['after']['api']['containerId'])
        with ExitStack() as stack:
            for control in controls.values(): stack.enter_context(control)
            stack.enter_context(patch.object(a, 'image_content', return_value={}))
            # The restoration fixture adds the content seal supplied by the real
            # authenticated baseline. Native command bytes remain independently bound.
            path = a.restore_path(d, P)
            saved['baseline']['componentCurrentImages'] = {'api': {}, 'admin': {}}
            path.write_text(json.dumps(saved))
            receipt = a.restore_readback(d, P)
            self.assertEqual(receipt['status'], 'UNPUBLISHED_COMPONENT_RESTORATION_VERIFIED')
            result = a.bind_restoration(d, native(receipt), COMMAND, INSTANCE)
            binding_path = Path(result['bindingPath'])
            binding = json.loads(binding_path.read_bytes())
            authenticated = a.authenticate_restoration(d, P, binding_sha256=result['bindingSha256'],
                command_id=COMMAND, invocation_sha256=binding['invocationBytesSha256'])
            self.assertTrue(authenticated['authenticated'])
            self.assertEqual(authenticated['migration']['status'], 'APPLIED')
            saved['after']['api']['containerId'] = '0' * 64
            path.write_text(json.dumps(saved))
            with self.assertRaisesRegex(RuntimeError, 'RESTORATION_SERVICES_CHANGED'):
                a.authenticate_restoration(d, P, binding_sha256=result['bindingSha256'],
                    command_id=COMMAND, invocation_sha256=binding['invocationBytesSha256'])


class FiniteMigrationTests(unittest.TestCase):
    setUp = SuccessorTests.setUp
    tearDown = SuccessorTests.tearDown

    def histories(self):
        base = archive('0a03fa28e6b844a18833d5c63f1de700f091fc64')
        rows = {n[len(a.MIGRATION_ROOT) + 1:]: a.digest(raw) for n, (raw, _mode) in base.items()
                if n.startswith(a.MIGRATION_ROOT + '/')}
        rows['20261009093000_online_recharge/migration.sql'] = '44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95'
        return rows

    def database(self, applied):
        rows = self.histories()
        if applied:
            rows[a.MIGRATION_FILE] = a.MIGRATION_IDENTITY['sha256']
        value = {'rows': [{'name': n.split('/')[0], 'checksum': sha, 'finished': 1, 'rolledBack': 0}
                          for n, sha in rows.items() if n.endswith('/migration.sql')],
                 'tables': [], 'columns': [], 'indexes': []}
        if applied:
            value['tables'] = [{'engine': 'InnoDB', 'collation': 'utf8mb4_unicode_ci'}]
            value['columns'] = [
                {'name': name, 'position': index, 'type': kind, 'columnType': full, 'nullable': 'NO',
                 'default': default, 'extra': extra}
                for index, (name, kind, full, default, extra) in enumerate((
                    ('id', 'char', 'char(36)', None, ''), ('owner_id', 'varchar', 'varchar(191)', None, ''),
                    ('name', 'varchar', 'varchar(80)', None, ''), ('configuration', 'json', 'json', None, ''),
                    ('created_at', 'datetime', 'datetime(3)', 'current_timestamp(3)', 'DEFAULT_GENERATED'),
                    ('updated_at', 'datetime', 'datetime(3)', None, '')), 1)]
            value['indexes'] = [
                {'name': name, 'column': column, 'sequence': index, 'nonUnique': unique, 'type': 'BTREE', 'prefix': None}
                for name, unique, names in (('PRIMARY', 0, ('id',)),
                    (a.MIGRATION_TABLE + '_owner_id_name_key', 0, ('owner_id', 'name')),
                    (a.MIGRATION_TABLE + '_owner_id_created_idx', 1, ('owner_id', 'created_at')))
                for index, column in enumerate(names, 1)]
        return rows, value

    def read(self, rows, value):
        d = SimpleNamespace()
        scope = SimpleNamespace(migration_files=lambda *_: dict(rows))
        with patch.object(a, 'mysql_readonly', return_value=value):
            return a.migration_database_state(d, scope, self.root)

    def test_true_pending_and_complete_applied_schema_and_indexes(self):
        rows, value = self.database(False)
        self.assertEqual(self.read(rows, value)['status'], 'PENDING')
        rows, value = self.database(True)
        value['columns'].reverse(); value['indexes'].reverse()
        self.assertEqual(self.read(rows, value)['status'], 'APPLIED')

    def test_source_rejects_extra_or_changed_legacy_or_449_migration(self):
        rows, value = self.database(True)
        for name, sha in (('20261013100000_unreviewed/migration.sql', 'a' * 64),
                          (a.MIGRATION_FILE, 'a' * 64), ('migration_lock.toml', 'b' * 64)):
            changed = {**rows, name: sha}
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SOURCE_CHANGED'):
                self.read(changed, value)

    def test_unknown_checksum_incomplete_history_and_partial_schema_rejected(self):
        rows, value = self.database(True)
        for alter in (lambda n: n['rows'][0].update(checksum='0' * 64),
                      lambda n: n['rows'].append(copy.deepcopy(n['rows'][0])),
                      lambda n: n['rows'][-1].update(finished=0, rolledBack=0),
                      lambda n: n['columns'][1].update(columnType='varchar(255)'),
                      lambda n: n['indexes'][-1].update(nonUnique=0),
                      lambda n: n['tables'][0].update(engine='MyISAM')):
            changed = copy.deepcopy(value); alter(changed)
            with self.assertRaises(RuntimeError): self.read(rows, changed)
        rows, value = self.database(False)
        value['tables'] = [{'engine': 'InnoDB', 'collation': 'utf8mb4_unicode_ci'}]
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCHEMA_CHANGED'): self.read(rows, value)

    def test_applied_without_independent_restoration_authority_never_runs_migrate(self):
        d = SimpleNamespace(migration_plan=lambda *_: [a.MIGRATION_FILE], compose=Mock(), sync_new_table_grants=Mock())
        with patch.object(a, 'migration_source_check'), patch.object(a, 'migration_database_state', return_value=migration_state('APPLIED')):
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_APPLIED_WITHOUT_RECEIPT'):
                a.apply_migration(d, None, self.root, self.root)
        d.compose.assert_not_called(); d.sync_new_table_grants.assert_not_called()

    def test_authentic_retained_applied_schema_does_not_repeat_migration(self):
        grants = {'ok': True, 'newTableCount': 1, 'runtimeTableCount': 100}
        d = SimpleNamespace(migration_plan=lambda *_: [a.MIGRATION_FILE], compose=Mock(), sync_new_table_grants=Mock(return_value=grants))
        with patch.object(a, 'migration_source_check'), patch.object(a, 'migration_database_state', return_value=migration_state('APPLIED')):
            result = a.apply_migration(d, None, self.root, self.root,
                retained={'authenticated': True, 'migration': migration_state('APPLIED')})
        self.assertFalse(result['performed']); d.compose.assert_not_called()
        d.sync_new_table_grants.assert_called_once_with(self.root, [a.MIGRATION_FILE])

    def test_finite_projection_keeps_449_model_and_removes_only_sealed_online_delta(self):
        projection = a.projection_module()
        old = a.load('immutable_projection_test', 'api-admin-pending-projection.py')
        candidate = archive('60e164b75d1eedaab440c17139bf9ba55de08c61')
        candidate[a.MIGRATION_SCHEMA] = ((ROOT / a.MIGRATION_SCHEMA).read_bytes(), '100644')
        candidate[a.MIGRATION_ROOT + '/' + a.MIGRATION_FILE] = ((ROOT / a.MIGRATION_ROOT / a.MIGRATION_FILE).read_bytes(), '100644')
        output, record = projection.project_files(candidate, archive(old.BASELINE_COMMIT), archive(old.ONLINE_COMMIT), N, projection.source_tree(candidate))
        self.assertEqual(a.digest(output[a.MIGRATION_SCHEMA][0]), a.MIGRATION_IDENTITY['schemaAfterSha256'])
        self.assertEqual(output[a.MIGRATION_ROOT + '/' + a.MIGRATION_FILE], candidate[a.MIGRATION_ROOT + '/' + a.MIGRATION_FILE])
        self.assertFalse(any(n.startswith(('apps/api/src/id-business-v2/online-recharge/', 'apps/admin/src/v2/features/online-recharge/')) for n in output))
        self.assertEqual(projection.verify_output(output, record), record)
        self.assertEqual(old.FILE_SEALS[a.MIGRATION_SCHEMA][0], a.MIGRATION_IDENTITY['schemaBeforeSha256'])
        altered = dict(candidate); raw, mode = altered[a.MIGRATION_SCHEMA]
        altered[a.MIGRATION_SCHEMA] = (raw.replace(b'@db.VarChar(80)', b'@db.VarChar(81)', 1), mode)
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCHEMA_CHANGED'):
            projection.project_files(altered, archive(old.BASELINE_COMMIT), archive(old.ONLINE_COMMIT), N, projection.source_tree(altered))

    def test_existing_grants_must_stay_exact_and_new_table_no_delete_permission(self):
        schema = [{'grantee': "'id_business_migrator'@'%'", 'privilege': 'ALTER', 'grantable': 'NO'}]
        old = [{'grantee': "'id_business_app'@'%'", 'table': 'existing_table', 'privilege': 'SELECT', 'grantable': 'NO'}]
        new = [{'grantee': "'id_business_app'@'%'", 'table': a.MIGRATION_TABLE, 'privilege': n, 'grantable': 'NO'}
               for n in ('SELECT', 'INSERT', 'UPDATE')]
        with patch.object(a, 'mysql_readonly', return_value={'schema': schema, 'tables': old}):
            before = a.grant_state(None, self.root, applied=False)
        with patch.object(a, 'mysql_readonly', return_value={'schema': schema, 'tables': list(reversed(old + new))}):
            after = a.require_grants_preserved(None, self.root, {'databaseGrants': before}, applied=True)
        self.assertEqual(after['preservedGrantsSha256'], before['preservedGrantsSha256'])
        for changed in (old + new + [{**new[0], 'privilege': 'DELETE'}],
                        [{**old[0], 'privilege': 'UPDATE'}] + new,
                        old + [{**row, 'grantable': 'YES'} for row in new]):
            with patch.object(a, 'mysql_readonly', return_value={'schema': schema, 'tables': changed}):
                with self.assertRaises(RuntimeError): a.require_grants_preserved(None, self.root, {'databaseGrants': before}, applied=True)

    def test_private_artifact_hardlink_and_group_readable_file_rejected(self):
        path = self.root / 'safe.json'; a.write_private(path, {'value': 'fixture'})
        alias = self.root / 'hard-link.json'
        import os
        os.link(path, alias)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'): a.private_bytes(path)
        alias.unlink(); path.chmod(0o640)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'): a.private_bytes(path)

    def test_reviewed_application_seal_allows_control_only_change_but_rejects_any_app_drift(self):
        projection = a.projection_module()
        original = a.load('sealed_app_reference_test', 'api-admin-pending-projection.py')
        candidate = sealed_candidate()
        sources = {N: candidate, original.BASELINE_COMMIT: archive(original.BASELINE_COMMIT),
                   original.ONLINE_COMMIT: archive(original.ONLINE_COMMIT)}
        d = SimpleNamespace(registration_download=lambda ref: ('offline-archive:' + ref).encode(),
            registration_archive=lambda raw, ref: sources[ref])
        with patch.object(a, 'HELPERS', ()):
            p = a.producer(N, projection.source_tree(candidate), '12', '1')
            self.assertEqual(a.source(d, p)[3], a.APPROVED_APPLICATION_INPUT_SHA256)
            candidate['docs/offline-control-test.md'] = (b'non-runtime evidence fixture\n', '100644')
            p = a.producer(N, projection.source_tree(candidate), '12', '1')
            self.assertEqual(a.source(d, p)[3], a.APPROVED_APPLICATION_INPUT_SHA256)
            name = 'apps/api/src/id-business-v2/auto-registration/worker/workspace.py'
            raw, mode = candidate[name]; candidate[name] = (raw + b'\n# unreviewed application mutation\n', mode)
            p = a.producer(N, projection.source_tree(candidate), '12', '1')
            with self.assertRaisesRegex(RuntimeError, 'APPLICATION_INPUTS_NOT_SEALED'): a.source(d, p)

    def test_current_control_helper_bytes_are_bound_before_projection(self):
        projection = a.projection_module()
        candidate = sealed_candidate()
        name = 'scripts/production-release/' + PATH.name
        candidate[name] = (PATH.read_bytes() + b'\n# unexpected executor\n', '100644')
        d = SimpleNamespace(registration_download=lambda ref: b'offline archive', registration_archive=lambda *_: candidate)
        with patch.object(a, 'HELPERS', (PATH.name,)):
            p = a.producer(N, projection.source_tree(candidate), '12', '1')
            with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_SOURCE_CHANGED'): a.source(d, p)

    def test_unknown_application_input_contract_remains_closed(self):
        projection = a.projection_module(); candidate = archive(a.APPLICATION_SOURCE)
        d = SimpleNamespace(registration_download=lambda ref: b'offline archive', registration_archive=lambda *_: candidate)
        p = a.producer(N, projection.source_tree(candidate), '12', '1')
        with patch.object(a, 'HELPERS', ()), patch.object(a, 'APPROVED_APPLICATION_INPUT_SHA256', None):
            with self.assertRaisesRegex(RuntimeError, 'APPLICATION_INPUTS_NOT_SEALED'): a.source(d, p)

    def test_restore_configuration_allows_only_proven_automatic_hostname_identity(self):
        def model(identifier, *, hostname=None, privilege=False, env='fixture'):
            body = {'Config': {'Hostname': hostname or identifier[:12], 'Env': ['OFFLINE_ENV=' + env]},
                    'HostConfig': {'Privileged': privilege}, 'Mounts': [{'Destination': '/data', 'Source': '/volume', 'RW': True}]}
            metadata = {'Id': identifier, 'Image': 'sha256:' + '7' * 64, **body}
            state = {'containerId': identifier, 'image': metadata['Image'], 'configurationSha256': a.fingerprint(body)}
            return a.configuration_model(SimpleNamespace(run=lambda *_: json.dumps([metadata])), state)
        original = model('a' * 64)
        self.assertEqual(original, model('b' * 64))
        self.assertTrue(original['automaticHostname'])
        self.assertNotEqual(original, model('b' * 64, privilege=True))
        self.assertNotEqual(original, model('b' * 64, env='changed'))
        self.assertNotEqual(original, model('b' * 64, hostname='arbitrary-custom-host'))
        explicit = model('a' * 64, hostname='fixed-compose-host')
        self.assertFalse(explicit['automaticHostname'])
        self.assertEqual(explicit, model('b' * 64, hostname='fixed-compose-host'))


class RestartConfigurationTests(unittest.TestCase):
    def body(self):
        return {'Config': {'Hostname': 'a' * 12, 'Env': ['A=one', 'B=two'], 'OnBuild': None},
            'HostConfig': {'Dns': None, 'DnsOptions': None, 'DnsSearch': None,
                           'Privileged': False, 'UnknownFutureField': []},
            'Mounts': [{'Destination': '/data', 'Source': '/volume', 'RW': True}]}

    def test_only_existing_empty_dns_slices_are_canonical_and_input_is_immutable(self):
        body = self.body(); before = copy.deepcopy(body)
        empty = copy.deepcopy(body)
        for key in ('Dns', 'DnsOptions', 'DnsSearch'): empty['HostConfig'][key] = []
        self.assertEqual(a.canonical_dns_configuration(body), a.canonical_dns_configuration(empty))
        self.assertEqual(body, before)
        missing = self.body(); del missing['HostConfig']['Dns']
        self.assertNotIn('Dns', a.canonical_dns_configuration(missing)['HostConfig'])
        for key in ('Dns', 'DnsOptions', 'DnsSearch'):
            nonempty = self.body(); nonempty['HostConfig'][key] = ['192.0.2.1']
            self.assertEqual(a.canonical_dns_configuration(nonempty)['HostConfig'][key], ['192.0.2.1'])
            self.assertNotEqual(a.fingerprint(a.canonical_dns_configuration(nonempty)), a.fingerprint(body))

    def test_environment_mounts_permissions_and_unknown_fields_never_normalize(self):
        original = self.body()
        variants = []
        for section, field, value in (('Config', 'Env', ['B=two', 'A=one']),
                ('Config', 'OnBuild', []), ('HostConfig', 'Privileged', True),
                ('HostConfig', 'UnknownFutureField', None)):
            body = self.body(); body[section][field] = value; variants.append(body)
        mount = self.body(); mount['Mounts'][0]['RW'] = False; variants.append(mount)
        for body in variants:
            self.assertNotEqual(a.fingerprint(a.canonical_dns_configuration(body)), a.fingerprint(original))
        for value in (False, {}, [None], '[]'):
            body = self.body(); body['HostConfig']['Dns'] = value
            with self.assertRaisesRegex(RuntimeError, 'DNS_CONFIGURATION_INVALID'):
                a.canonical_dns_configuration(body)

    def test_raw_configuration_digest_identity_and_only_automatic_hostname_remain_required(self):
        body = self.body()
        for key in ('Dns', 'DnsOptions', 'DnsSearch'): body['HostConfig'][key] = []
        metadata = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, **body}
        d = SimpleNamespace(run=lambda *_: json.dumps([metadata]))
        state = {'containerId': metadata['Id'], 'image': metadata['Image'], 'configurationSha256': a.fingerprint(body)}
        model = a.configuration_model(d, state)
        self.assertTrue(model['automaticHostname'])
        for key, value in (('configurationSha256', '0' * 64), ('containerId', 'c' * 64), ('image', 'sha256:' + 'c' * 64)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                a.configuration_model(d, {**state, key: value})
        metadata['Config']['Hostname'] = 'fixed-host'
        state['configurationSha256'] = a.fingerprint({n: metadata[n] for n in ('Config', 'HostConfig', 'Mounts')})
        self.assertFalse(a.configuration_model(d, state)['automaticHostname'])


if __name__ == '__main__':
    unittest.main()
