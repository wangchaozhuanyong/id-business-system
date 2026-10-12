"""Offline component provenance, immutable application and protected release guards."""

import base64
import copy
from contextlib import ExitStack
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
            row = {'Id': identifier, 'Image': image, 'Config': config, 'HostConfig': {'NetworkMode': 'offline-network'},
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
        contract = {'adminPredecessorRelease': str(releases['D']), 'adminPredecessorManifestSha256': a.digest(d_raw)}
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


if __name__ == '__main__':
    unittest.main()
