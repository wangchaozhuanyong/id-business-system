import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import shutil
import select
import signal
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import ExitStack, contextmanager, redirect_stdout
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.runtime/apple-hidden-mailbox-20261009/main373-merge/scope-fixtures'

# Historical release cases must keep their original source, including after an
# additive current-system migration. Read immutable Git blobs, never weaken the
# production controller's migration seal to match this checkout.
RUNTIME.mkdir(parents=True, exist_ok=True)
_LEGACY_SOURCE = tempfile.TemporaryDirectory(prefix='legacy-prisma-', dir=RUNTIME)
LEGACY_PRISMA_ROOT = Path(_LEGACY_SOURCE.name)
_LEGACY_COMMIT = '554eaff77d67cce4b760d24a5c358ccabf2b3a4c'
for _name in subprocess.check_output(['git', 'ls-tree', '-r', '--name-only',
        _LEGACY_COMMIT, 'apps/api/prisma-mysql'], cwd=ROOT).decode().splitlines():
    _target = LEGACY_PRISMA_ROOT / _name
    _target.parent.mkdir(parents=True, exist_ok=True)
    _target.write_bytes(subprocess.check_output(['git', 'show', _LEGACY_COMMIT + ':' + _name], cwd=ROOT))
RUNTIME.mkdir(exist_ok=True)


def load(name, filename, selected_scope=None):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    if selected_scope is not None:
        value.SCOPE = selected_scope
    spec.loader.exec_module(value)
    return value


scope = load('api_admin_scope', 'api-admin-scope.py')
d = load('remote_deployment', 'remote-deploy.py')
transport = load('api_admin_transport', 'api-admin-readonly.py')
COMMIT, TREE, OLD = 'a' * 40, 'b' * 40, 'c' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
registration = load('api_registration_scope', 'api-admin-scope.py', 'API_REGISTRATION')
migration = load('api_admin_migration_scope', 'api-admin-scope.py', 'API_ADMIN_MIGRATION')
workspace = load('api_workspace_scope', 'api-admin-scope.py', 'API_ADMIN_WORKSPACE')
PRIVATE_INSPECT_ORIGINAL = workspace.workspace_private_inspect
SUMMARY_READER_ORIGINAL = workspace.WorkspaceSqliteProtection.summary_reader
REGISTRATION_FIXTURE_COMMIT = '4042b5f2c673344409e329607bd43a893ba521bb'


@contextmanager
def tracked_online_source():
    """Use real tracked bytes; ignored local executor installs are not source."""
    paths = (*workspace.ONLINE_SOURCE_SEALS, workspace.MIGRATION_ROOT,
             *workspace.CONFIG_FILES, workspace.MIGRATION_SEED,
             'scripts/production-release/online-recharge-recovery.json')
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', *paths], cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix='tracked-online-source-', dir=RUNTIME) as temporary:
        directory = Path(temporary)
        for name in names.decode().split('\0'):
            if not name:
                continue
            relative = Path(name)
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('INVALID_TRACKED_FIXTURE')
            original = ROOT / relative
            if not original.is_file() or original.is_symlink():
                raise RuntimeError('INVALID_TRACKED_FIXTURE')
            target = directory / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(original.read_bytes())
        yield directory

# Workspace publication has its own reviewed historical Compose and edge seal.
# New checkout services must not redefine that scope. Keep only its configuration
# and auto-registration source structure, never a second copy of this repository.
_WORKSPACE_COMMIT = '2b54aad43dafc2e8ea9cebb46fc72aa8af003ac6'
_WORKSPACE_SOURCE = tempfile.TemporaryDirectory(prefix='legacy-workspace-', dir=RUNTIME)
WORKSPACE_SOURCE_ROOT = Path(_WORKSPACE_SOURCE.name)
_workspace_files = set(workspace.CONFIG_FILES)
_workspace_files.update(subprocess.check_output(['git', 'ls-tree', '-r', '--name-only',
    _WORKSPACE_COMMIT, 'apps/api/src/id-business-v2/auto-registration'], cwd=ROOT).decode().splitlines())
for _name in sorted(_workspace_files):
    _target = WORKSPACE_SOURCE_ROOT / _name
    _target.parent.mkdir(parents=True, exist_ok=True)
    _target.write_bytes(subprocess.check_output(['git', 'show', _WORKSPACE_COMMIT + ':' + _name], cwd=ROOT))


def proof():
    return {'version': 1, 'commit': COMMIT, 'sourceTree': TREE, 'images': {
        name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}', 'imageId': 'sha256:' + str(index) * 64,
               'fileCount': 1, 'sha256': str(index) * 64}
        for index, name in enumerate(scope.UPDATED, 1)}}


def workspace_proof():
    return {**proof(), 'scope': 'API_ADMIN_WORKSPACE',
            'configuration': workspace.workspace_configuration(d, WORKSPACE_SOURCE_ROOT, WORKSPACE_SOURCE_ROOT),
            'acceptance': {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
                'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'],
                'businessActions': 0, 'temporaryVolumeRemoved': True}}


def registration_proof():
    rows = copy.deepcopy(registration.registration_profile(d, ROOT)['workerProjection'])
    for name in registration.WORKER_PAIR:
        rows[name]['sha256'] = '1' * 64
    images = {'api': proof()['images']['api'], 'auto-registration': {
        'reference': f'{REPOSITORY}:{COMMIT}-123-1-auto-recharge', 'imageId': 'sha256:' + '2' * 64,
        **registration.worker_content(rows)}}
    return {'version': 1, 'scope': 'API_REGISTRATION', 'commit': COMMIT, 'sourceTree': TREE,
            'images': images, 'workerProjection': rows, 'workerProjectionSha256': registration.fingerprint(rows)}


def registration_task():
    return {'taskId': registration.TASK_ID, 'attempt': 10, 'registered': True,
            'passwordVerified': False, 'mfaVerified': False, 'leaseActive': False, 'noncePresent': False,
            'passwordCandidatePresent': True, 'binding': registration.TASK_BINDING,
            'emailHashHmac': '4' * 64, 'jobHmac': '1' * 64, 'accountHmac': '2' * 64, 'auditHmac': '3' * 64}


def migration_task():
    return copy.deepcopy(migration.MIGRATION_TASK)


def states():
    return {name: {'image': 'sha256:' + 'c' * 64, 'reference': 'old-' + name, 'status': 'running',
                   'health': 'healthy', 'containerId': name, 'startedAtSha256': 'start',
                   'environmentSha256': 'env', 'configurationSha256': 'config'} for name in d.ALL_SERVICES}


class JobGuardTests(unittest.TestCase):
    def controller(self, busy=False, retained=True, count='0'):
        return SimpleNamespace(BASE=RUNTIME / 'no-handoff', require=d.require, assert_no_active_recharge=MagicMock(),
            registration_runtime_state=MagicMock(return_value={'supported': True, 'registrationBusy': busy,
                'registrationWindowRetained': retained}), current_job_database=MagicMock(return_value='current_db'),
            compose=MagicMock(return_value=count))

    def test_quiet_retained_window_and_exact_zero_are_allowed(self):
        controller = self.controller()
        self.assertTrue(scope.jobs_idle(controller, Path('/safe'))['registrationWindowRetained'])
        query = ' '.join(controller.compose.call_args.args[1:])
        self.assertIn('MYSQL_DATABASE=current_db', query)
        self.assertIn('lease_until > UTC_TIMESTAMP(6)', query)
        self.assertNotIn('browser_profile_id', query)
        controller.assert_no_active_recharge.assert_called_once()

    def test_busy_runtime_rejects_even_when_database_count_zero(self):
        controller = self.controller(busy=True)
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_REGISTRATION_BUSY'):
            scope.jobs_idle(controller, Path('/safe'))
        controller.compose.assert_not_called()

    def test_runtime_missing_or_non_boolean_fails_closed(self):
        for value in ({}, {'supported': False}, {'supported': True, 'registrationBusy': 'false',
                       'registrationWindowRetained': True}, {'supported': True, 'registrationBusy': False}):
            with self.subTest(value=value):
                controller = self.controller()
                controller.registration_runtime_state.return_value = value
                with self.assertRaises(RuntimeError):
                    scope.jobs_idle(controller, Path('/safe'))

    def test_only_exact_zero_count_is_accepted(self):
        for count in ('1', '0\n0', '', '0.0', ' 0'):
            with self.subTest(count=count), self.assertRaisesRegex(RuntimeError, 'LEASE_ACTIVE'):
                scope.jobs_idle(self.controller(count=count), Path('/safe'))

    def test_read_errors_and_database_mismatch_do_not_proceed(self):
        for method in ('assert_no_active_recharge', 'registration_runtime_state', 'current_job_database', 'compose'):
            controller = self.controller()
            getattr(controller, method).side_effect = RuntimeError('unavailable')
            with self.subTest(method=method), self.assertRaises(RuntimeError):
                scope.jobs_idle(controller, Path('/safe'))


class ProofTests(unittest.TestCase):
    def test_proof_requires_exact_build_attempt_and_only_api_admin(self):
        scope.validate_proof(d, proof(), COMMIT, TREE, REPOSITORY, '123', '1')
        for field, value in [('commit', OLD), ('sourceTree', OLD), ('images', {**proof()['images'], 'auto-recharge': {}})]:
            candidate = proof(); candidate[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                scope.validate_proof(d, candidate, COMMIT, TREE)
        with self.assertRaises(RuntimeError):
            scope.validate_proof(d, proof(), COMMIT, TREE, REPOSITORY, '123', '2')

    def test_content_proof_refuses_other_roots_and_empty_content(self):
        output = '1' * 64 + '  /app/apps/api/dist/main.js'
        self.assertEqual(scope.content_summary(d, 'api', output)['fileCount'], 1)
        for output in ('', '1' * 64 + '  /etc/passwd', '1' * 64 + '  /app/apps/api/dist/main.js\nBAD'):
            with self.assertRaises(RuntimeError):
                scope.content_summary(d, 'api', output)

    def test_running_content_checked_against_immutable_image_and_oci_revision(self):
        candidate = proof()
        controller = SimpleNamespace(require=d.require)
        def image_state(directory, service):
            row = candidate['images'][service]
            return {'image': row['imageId'], 'reference': row['reference']}
        controller.service_state = image_state
        controller.run = lambda *args: json.dumps([{'Id': args[-1], 'Architecture': 'amd64', 'Config': {'Labels': {
            'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}])
        controller.compose = MagicMock(return_value='content')
        with patch.object(scope, 'content_summary', side_effect=lambda _d, name, _o: {key: candidate['images'][name][key] for key in ('fileCount', 'sha256')}):
            scope.verify_running(controller, None, candidate)
        self.assertEqual(controller.compose.call_count, 2)
        with patch.object(scope, 'content_summary', return_value={'fileCount': 2, 'sha256': '0' * 64}), self.assertRaisesRegex(RuntimeError, 'CONTENT_CHANGED'):
            scope.verify_running(controller, None, candidate)
        controller.run = lambda *args: json.dumps([{'Id': args[-1], 'Architecture': 'amd64', 'Config': {'Labels': {}}}])
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CHANGED'):
            scope.verify_running(controller, None, candidate)

    def test_strict_audit_requires_49_unique_rules_and_zero_without_history_gate(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            receipt = Path(temporary) / 'audit.json'
            controller = SimpleNamespace(require=d.require)
            good = {'ok': True, 'checkCount': 49, 'violationCount': 0,
                    'checks': [{'code': str(index), 'count': 0} for index in range(49)]}
            for report, passes in [(good, True), ({**good, 'checkCount': 48}, False),
                ({**good, 'gate': {'accepted': True}}, False),
                ({**good, 'checks': good['checks'][:-1] + [good['checks'][0]]}, False),
                ({**good, 'checks': good['checks'][:-1] + [{'code': '48', 'count': 1}]}, False)]:
                controller.audit = lambda *a, **kw: (receipt.write_text(json.dumps(report)) and {})
                if passes:
                    self.assertEqual(scope.strict_audit(controller, None, receipt)['mode'], 'STRICT_ZERO_49')
                else:
                    with self.assertRaises(RuntimeError):
                        scope.strict_audit(controller, None, receipt)


class SnapshotTests(unittest.TestCase):
    def fixture(self):
        before = states()
        mounts = [
            {'Type': 'volume', 'Name': 'data', 'Source': '/fixture/data', 'Destination': '/data',
             'Driver': 'local', 'Mode': 'z', 'RW': True, 'Propagation': ''},
            {'Type': 'bind', 'Source': '/fixture/Caddyfile', 'Destination': '/etc/caddy/Caddyfile',
             'Mode': 'ro', 'RW': False, 'Propagation': 'rprivate'},
            {'Type': 'volume', 'Name': 'config', 'Source': '/fixture/config', 'Destination': '/config',
             'Driver': 'local', 'Mode': 'z', 'RW': True, 'Propagation': ''}]
        metadata = {row['containerId']: {'Id': row['containerId'], 'Image': row['image'],
            'Config': {'Image': row['reference'], 'Env': ['FIXTURE=one'], 'Cmd': ['run', 'argument']},
            'HostConfig': {'ReadonlyRootfs': True, 'Binds': ['fixture:/data']},
            'Mounts': copy.deepcopy(mounts) if name == 'caddy' else []} for name, row in before.items()}
        controller = SimpleNamespace(require=d.require, ALL_SERVICES=d.ALL_SERVICES,
            production_services=lambda directory: d.ALL_SERVICES,
            service_state=lambda directory, name, **kw: copy.deepcopy(before[name]),
            run=lambda *args: json.dumps([metadata[args[-1]]]))
        return controller, before, metadata

    def test_mount_order_only_is_stable_without_modifying_returned_records(self):
        controller, _, metadata = self.fixture()
        before = scope.snapshot(controller, None)
        mounts = metadata['caddy']['Mounts']
        for order in (list(reversed(mounts)), [mounts[1], mounts[2], mounts[0]]):
            metadata['caddy']['Mounts'] = copy.deepcopy(order)
            self.assertEqual(scope.snapshot(controller, None), before)
            self.assertEqual(metadata['caddy']['Mounts'], order)

    def test_every_mount_field_config_host_config_and_identity_stays_protected(self):
        changes = {'Type': 'bind', 'Name': 'other', 'Source': '/fixture/other', 'Destination': '/other',
                   'Driver': 'other', 'Mode': 'ro', 'RW': False, 'Propagation': 'shared', 'FutureField': 'new'}
        for key, value in changes.items():
            controller, _, metadata = self.fixture()
            before = scope.snapshot(controller, None)
            metadata['caddy']['Mounts'][0][key] = value
            with self.subTest(mountField=key):
                self.assertNotEqual(scope.snapshot(controller, None)['caddy']['configurationSha256'],
                                    before['caddy']['configurationSha256'])
        for section, field, value in [('Config', 'Env', ['FIXTURE=two']),
                ('Config', 'Cmd', ['argument', 'run']), ('HostConfig', 'ReadonlyRootfs', False),
                ('HostConfig', 'Binds', ['other:/data'])]:
            controller, _, metadata = self.fixture()
            before = scope.snapshot(controller, None)
            metadata['caddy'][section][field] = value
            with self.subTest(section=section, field=field):
                self.assertNotEqual(scope.snapshot(controller, None)['caddy']['configurationSha256'],
                                    before['caddy']['configurationSha256'])
        for field, value in [('containerId', 'changed'), ('image', 'sha256:' + '8' * 64)]:
            controller, rows, _ = self.fixture()
            rows['caddy'][field] = value
            with self.subTest(field=field), self.assertRaises((RuntimeError, KeyError)):
                scope.snapshot(controller, None)
        for field in ('reference', 'startedAtSha256', 'environmentSha256'):
            controller, rows, _ = self.fixture()
            before = scope.snapshot(controller, None)
            rows['caddy'][field] = 'changed'
            with self.subTest(field=field):
                self.assertNotEqual(scope.snapshot(controller, None), before)

    def test_invalid_or_duplicate_mount_destinations_fail_closed(self):
        for mounts in (None, {}, [{}], [{'Destination': 'relative'}],
                       [{'Destination': '/data'}, {'Destination': '/data'}]):
            controller, _, metadata = self.fixture()
            metadata['caddy']['Mounts'] = mounts
            with self.subTest(mounts=mounts), self.assertRaisesRegex(RuntimeError, 'MOUNTS_INVALID'):
                scope.snapshot(controller, None)


class PreservationTests(unittest.TestCase):
    def test_preserved_container_restart_env_or_config_change_rejected(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            before, after = Path(temporary) / 'before', Path(temporary) / 'after'
            for directory in (before, after):
                directory.mkdir()
                for name in (*scope.CONFIG_FILES, '.env.aws.production'):
                    path = directory / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('unchanged')
                (directory / 'compose.release.json').write_text(json.dumps({'services': {name: {'image': name} for name in d.SERVICES}}))
            controller = SimpleNamespace(require=d.require, migration_plan=MagicMock(return_value=[]))
            with patch.object(scope, 'snapshot', return_value=states()):
                scope.require_preserved(controller, before, after, states(), b'unchanged')
                for name in ('containerId', 'startedAtSha256', 'environmentSha256', 'configurationSha256', 'image'):
                    changed = states(); changed['auto-registration'][name] = 'changed'
                    with patch.object(scope, 'snapshot', return_value=changed), self.assertRaisesRegex(RuntimeError, 'PRESERVED_CONTAINER'):
                        scope.require_preserved(controller, before, after, states(), b'unchanged')
                (after / scope.CONFIG_FILES[0]).write_text('changed')
                with self.assertRaisesRegex(RuntimeError, 'CONFIG_OR_SCHEMA'):
                    scope.require_preserved(controller, before, after, states(), b'unchanged')
                (after / scope.CONFIG_FILES[0]).write_text('unchanged')
                controller.migration_plan.return_value = ['new migration']
                with self.assertRaisesRegex(RuntimeError, 'MIGRATIONS_FORBIDDEN'):
                    scope.require_preserved(controller, before, after, states(), b'unchanged')

    def test_audit_api_scope_never_uses_migrate_and_rejects_history(self):
        with patch.object(d, 'environment_values', return_value={'V2_DATA_INTEGRITY_DATABASE_URL': 'mysql://reader:placeholder@localhost/current'}), \
             patch.object(d, 'compose', return_value=json.dumps({'ok': True, 'violationCount': 0, 'checkCount': 49})) as compose:
            with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                d.audit(Path(temporary), Path(temporary) / 'audit.json', api_admin_only=True)
            args = compose.call_args.args
            self.assertIn('api', args)
            self.assertNotIn('migrate', args)
            self.assertIn('--no-deps', args)
            with self.assertRaisesRegex(RuntimeError, 'SCOPE_CONFLICT'):
                d.audit(None, None, api_admin_only=True, historical_exception=True)


class BaselineAndReadbackTests(unittest.TestCase):
    def test_worker94_retains815_build_proof_through_closed_registration_getter(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); current = base / 'releases/current'; current.mkdir(parents=True)
            (base / 'current').symlink_to(current)
            before = states(); origin = d.REGISTRATION_FOLLOWUP_RELEASE_CURRENT
            proof = {'apiRuntimeRevision': origin, 'apiBuildProofSha256': 'd' * 64,
                'apiContentSha256': 'e' * 64, 'adminContentSha256': 'f' * 64}
            provenance = {'id': d.REGISTRATION_FOLLOWUP_ID, **proof}
            manifest = {'commit': COMMIT, 'sourceTree': TREE, 'servicesUpdated': ['auto-registration'],
                'images': {name: {'reference': before[name]['reference'], 'digest': before[name]['image'],
                    'sourceCommit': origin if name in ('api','admin') else OLD} for name in d.SERVICES},
                'fixedRegistrationRelease': provenance}
            path = current / 'release-manifest.json'; path.write_text(json.dumps(manifest))
            (current / '.env.aws.production').write_text('preserved')
            profile = current / d.REGISTRATION_FOLLOWUP_FILE; profile.parent.mkdir(parents=True)
            raw = b'{"controlled94Fixture":true}'; profile.write_bytes(raw)
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.run = MagicMock(return_value=json.dumps([{'Id': before['api']['image'], 'Config': {'Labels': {
                'org.opencontainers.image.revision': origin}}}]))
            controller.check_registration_followup_deployment = MagicMock(return_value=proof)
            stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            result = scope.baseline(controller, COMMIT, check_jobs=False)
            self.assertEqual(result[3]['apiSource']['kind'], 'VERIFIED_RETAINED_API_ADMIN_PUBLICATION')
            self.assertEqual(result[3]['apiSource']['revision'], origin)
            self.assertEqual(result[3]['apiSource']['buildProofSha256'], proof['apiBuildProofSha256'])
            controller.check_registration_followup_deployment.assert_called_once_with(COMMIT, TREE, scope.hashlib.sha256(raw).hexdigest())
            for key in proof:
                broken = dict(proof); broken[key] = '0' * (40 if key=='apiRuntimeRevision' else 64)
                controller.check_registration_followup_deployment.return_value = broken
                with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_RETAINED_PUBLICATION_CHANGED$'):
                    scope.baseline(controller, COMMIT, check_jobs=False)
            controller.check_registration_followup_deployment.return_value = proof
            controller.check_registration_followup_deployment.side_effect = RuntimeError('RAW_PRIVATE_DIAGNOSTIC_SENTINEL')
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_PROJECTION_FAILED$'):
                scope.baseline(controller, COMMIT, check_jobs=False)
            controller.check_registration_followup_deployment.side_effect = None
            manifest['apiAdminPublication'] = {}; path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_RETAINED_PUBLICATION_AMBIGUOUS$'):
                scope.baseline(controller, COMMIT, check_jobs=False)

    def test_worker95_retains815_build_proof_through_closed_registration_getter(self):
        d.load_registration_interstitial95()
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); current = base / 'releases/current'; current.mkdir(parents=True)
            (base / 'current').symlink_to(current)
            before = states(); origin = d.REGISTRATION_FOLLOWUP_RELEASE_CURRENT
            proof = {'apiRuntimeRevision': origin, 'apiBuildProofSha256': 'd' * 64,
                'apiContentSha256': 'e' * 64, 'adminContentSha256': 'f' * 64}
            provenance = {'id': d.REGISTRATION_INTERSTITIAL_ID, **proof}
            manifest = {'commit': COMMIT, 'sourceTree': TREE, 'servicesUpdated': ['auto-registration'],
                'images': {name: {'reference': before[name]['reference'], 'digest': before[name]['image'],
                    'sourceCommit': origin if name in ('api','admin') else OLD} for name in d.SERVICES},
                'fixedRegistrationRelease': provenance}
            path = current / 'release-manifest.json'; path.write_text(json.dumps(manifest))
            (current / '.env.aws.production').write_text('preserved')
            profile = current / d.REGISTRATION_INTERSTITIAL_FILE; profile.parent.mkdir(parents=True)
            raw = b'{"controlled95Fixture":true}'; profile.write_bytes(raw)
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.run = MagicMock(return_value=json.dumps([{'Id': before['api']['image'], 'Config': {'Labels': {
                'org.opencontainers.image.revision': origin}}}]))
            controller.load_registration_interstitial95 = MagicMock()
            controller.check_registration_interstitial_deployment = MagicMock(return_value=proof)
            stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            result = scope.baseline(controller, COMMIT, check_jobs=False)
            self.assertEqual(result[3]['apiSource']['kind'], 'VERIFIED_RETAINED_API_ADMIN_PUBLICATION')
            self.assertEqual(result[3]['apiSource']['revision'], origin)
            self.assertEqual(result[3]['apiSource']['buildProofSha256'], proof['apiBuildProofSha256'])
            controller.load_registration_interstitial95.assert_called_once_with()
            controller.check_registration_interstitial_deployment.assert_called_once_with(COMMIT, TREE, scope.hashlib.sha256(raw).hexdigest())
            for key in proof:
                broken = dict(proof); broken[key] = '0' * (40 if key=='apiRuntimeRevision' else 64)
                controller.check_registration_interstitial_deployment.return_value = broken
                with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_RETAINED_PUBLICATION_CHANGED$'):
                    scope.baseline(controller, COMMIT, check_jobs=False)
            controller.check_registration_interstitial_deployment.return_value = proof
            controller.check_registration_interstitial_deployment.side_effect = RuntimeError('RAW_PRIVATE_DIAGNOSTIC_SENTINEL')
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_PROJECTION_FAILED$'):
                scope.baseline(controller, COMMIT, check_jobs=False)
            controller.check_registration_interstitial_deployment.side_effect = None
            manifest['apiAdminPublication'] = {}; path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_RETAINED_PUBLICATION_AMBIGUOUS$'):
                scope.baseline(controller, COMMIT, check_jobs=False)

    def test_registration94_getter_uses_pinned815_scope_without_new_baseline_recursion(self):
        import ast
        tree = ast.parse((ROOT / 'scripts/production-release/remote-deploy.py').read_bytes())
        functions = {n.name:n for n in tree.body if isinstance(n, ast.FunctionDef)}
        relevant = ('check_registration_followup_deployment', 'registration_followup_baseline',
            'registration_followup_api_admin_running', 'registration_followup_api_admin_states',
            'registration_followup_api_admin_history')
        for name in relevant:
            node = functions[name]
            with self.subTest(function=name):
                self.assertFalse(any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr=='baseline' for n in ast.walk(node)))
        loader = ast.unparse(functions['registration_followup_api_admin_module'])
        self.assertIn('REGISTRATION_FOLLOWUP_API_ADMIN_SCOPE', loader)
        self.assertIn('types.SimpleNamespace', loader)
        release = ast.unparse(functions['registration_followup_release'])
        self.assertIn("manifest.pop('apiAdminPublication', None)", release)
        self.assertNotEqual(d.REGISTRATION_FOLLOWUP_API_ADMIN_SCOPE,
            scope.hashlib.sha256((ROOT/'scripts/production-release/api-admin-scope.py').read_bytes()).hexdigest())

    def test_existing_mixed_api_requires_projection_and_compiled_file_proof(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); current = base / 'releases' / 'current'; current.mkdir(parents=True)
            (base / 'current').symlink_to(current)
            before = states()
            manifest = {'commit': OLD, 'images': {name: {'reference': before[name]['reference'],
                'digest': before[name]['image'], 'sourceCommit': OLD} for name in d.SERVICES},
                'fixedRegistrationRelease': {'id': d.REGISTRATION_RECOVERY_ID}}
            manifest['images']['api']['sourceCommit'] = d.RECHARGE_2F_CURRENT
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            (current / '.env.aws.production').write_text('preserved')
            profile_path = current / d.REGISTRATION_RECOVERY_FILE
            profile_path.parent.mkdir(parents=True)
            profile_raw = (ROOT / d.REGISTRATION_RECOVERY_FILE).read_bytes()
            profile_path.write_bytes(profile_raw)
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.run = MagicMock(return_value=json.dumps([{'Id': before['api']['image'], 'Config': {'Labels': {
                'org.opencontainers.image.revision': d.RECHARGE_2F_CURRENT, 'id-business-v2.api-projection-sha256': 'projection'}}}]))
            controller.registration_profile = MagicMock(return_value={'apiProjectionSha256': 'projection',
                'apiCompiledSourceProjectionSha256': 'compiled'})
            controller.registration_recovery_api_hashes = MagicMock()
            controller.registration_recovery_image_labels = MagicMock()
            snapshot_mock = stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            result = scope.baseline(controller, OLD, check_jobs=False)
            self.assertEqual(result[3]['apiSource']['kind'], 'VERIFIED_EXISTING_API_PROJECTION')
            controller.registration_recovery_api_hashes.assert_called_once()
            controller.registration_recovery_image_labels.assert_called_once()
            self.assertEqual(result[3]['apiSource']['revision'], d.RECHARGE_2F_CURRENT)
            self.assertEqual(result[3]['apiSource']['profileRawSha256'], d.RECHARGE_2F_PROFILE_RAW)
            # The publication manifest can now describe only a later recharge release.
            manifest.pop('fixedRegistrationRelease')
            manifest['fixedRechargeRelease'] = {'id': d.RECHARGE_2F_ID}
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(scope.baseline(controller, OLD, check_jobs=False)[3]['apiSource']['kind'],
                             'VERIFIED_EXISTING_API_PROJECTION')
            manifest['fixedRegistrationRelease'] = {'id': 'registration-worker-93-20261007'}
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(scope.baseline(controller, OLD, check_jobs=False)[3]['apiSource']['revision'],
                             d.RECHARGE_2F_CURRENT)
            profile_path.write_bytes(profile_raw + b'\n')
            with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_API_PROJECTION'):
                scope.baseline(controller, OLD, check_jobs=False)
            profile_path.write_bytes(profile_raw)
            controller.registration_recovery_image_labels.side_effect = RuntimeError('wrong projection label')
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_PROJECTION_FAILED$'):
                scope.baseline(controller, OLD, check_jobs=False)
            controller.registration_recovery_image_labels.side_effect = None
            manifest['images']['api']['sourceCommit'] = OLD
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, 'BASELINE_API_REVISION_CHANGED'):
                scope.baseline(controller, OLD, check_jobs=False)
            manifest['images']['api']['sourceCommit'] = d.RECHARGE_2F_CURRENT
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            controller.registration_recovery_api_hashes.side_effect = RuntimeError('raw private diagnostic')
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_PROJECTION_FAILED$'):
                scope.baseline(controller, OLD, check_jobs=False)

            controller.registration_recovery_api_hashes.side_effect = None
            # Keep guards/projection unchanged while independently drifting each final gate.
            current_link = base / 'current'
            other = base / 'releases' / 'other'
            other.mkdir()
            def move_pointer(*args):
                current_link.unlink()
                current_link.symlink_to(other)
            controller.registration_recovery_api_hashes.side_effect = move_pointer
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_POINTER_MOVED$'):
                scope.baseline(controller, OLD, check_jobs=False)
            current_link.unlink(); current_link.symlink_to(current)
            original_manifest = (current / 'release-manifest.json').read_text()
            controller.registration_recovery_api_hashes.side_effect = lambda *args: (current / 'release-manifest.json').write_text(original_manifest + ' ')
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_MANIFEST_CHANGED$'):
                scope.baseline(controller, OLD, check_jobs=False)
            (current / 'release-manifest.json').write_text(original_manifest)
            controller.registration_recovery_api_hashes.side_effect = None
            for field in ('containerId', 'image', 'reference', 'startedAtSha256', 'environmentSha256', 'configurationSha256'):
                changed = copy.deepcopy(before)
                changed['caddy'][field] = 'changed'
                snapshot_mock.side_effect = [before, changed]
                with self.subTest(driftField=field), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_SERVICES_CHANGED$'):
                    scope.baseline(controller, OLD, check_jobs=False)

    def test_independent_readback_refuses_host_config_drift_without_container_restart(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); origin, current = base / 'releases' / 'old', base / 'releases' / 'new'
            for directory in (origin, current):
                directory.mkdir(parents=True)
                for name in (*scope.CONFIG_FILES, '.env.aws.production'):
                    target = directory / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('same')
                (directory / 'compose.release.json').write_text(json.dumps({'services': {name: {'image': name} for name in d.SERVICES}}))
            (base / 'current').symlink_to(current)
            before, candidate = states(), proof()
            (current / scope.PROOF_FILE).write_text(json.dumps(candidate))
            report = {'ok': True, 'checkCount': 49, 'violationCount': 0,
                'checks': [{'code': str(index), 'count': 0} for index in range(49)]}
            for name in ('before-audit.json', 'after-audit.json'):
                (current / name).write_text(json.dumps(report))
            record = {'before': before, 'buildProofSha256': scope.fingerprint(candidate), 'environmentSha256': 'env',
                'configurationBefore': scope.configuration_hashes(origin), 'configurationAfter': scope.configuration_hashes(current)}
            (current / scope.STATE_FILE).write_text(json.dumps(record))
            manifest = {'sourceTree': TREE, 'servicesUpdated': ['api', 'admin'], 'migrationApplied': False,
                'newMigrations': [], 'previousRelease': str(origin),
                'dataAuditBefore': scope.audit_receipt(d, current / 'before-audit.json'),
                'dataAuditAfter': scope.audit_receipt(d, current / 'after-audit.json')}
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.migration_plan = MagicMock(return_value=[])
            stack.enter_context(patch.object(scope, 'baseline', return_value=(current, manifest, before, {'environmentSha256': 'env'})))
            stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(scope, 'verify_running'))
            self.assertEqual(scope.readback(controller, COMMIT)['status'], 'API_ADMIN_VERIFIED')
            (current / scope.CONFIG_FILES[0]).write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'READBACK_CONFIG_CHANGED'):
                scope.readback(controller, COMMIT)
            (current / scope.CONFIG_FILES[0]).write_text('same')
            report['checks'][0]['count'] = 1
            (current / 'after-audit.json').write_text(json.dumps(report))
            with self.assertRaisesRegex(RuntimeError, 'STRICT_49_FAILED'):
                scope.readback(controller, COMMIT)


class TransportTests(unittest.TestCase):
    def test_readonly_downloads_exact_commit_and_verifies_both_local_bytes(self):
        data = transport.parameters(COMMIT, OLD, 'preflight')
        commands = '\n'.join(data['commands'])
        self.assertEqual(commands.count('sha256sum -c -'), 2)
        self.assertIn('/' + COMMIT + '/scripts/production-release/api-admin-scope.py', commands)
        self.assertIn('--api-admin-preflight --expected-current ' + OLD, commands)
        self.assertNotIn('docker ', commands)
        for bad in (COMMIT + ';whoami', 'main'):
            with self.assertRaises(ValueError):
                transport.parameters(bad, OLD, 'preflight')

    def test_non_workspace_transport_keeps_only_its_two_pinned_scripts(self):
        names = ('remote-deploy.py', 'api-admin-scope.py')
        for selected in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION'):
            for mode in ('preflight', 'readback'):
                with self.subTest(scope=selected, mode=mode):
                    commands = transport.parameters(COMMIT, OLD, mode, selected)['commands']
                    downloads = [line for line in commands if line.startswith('curl ')]
                    checksums = [line for line in commands if 'sha256sum -c -' in line]
                    self.assertEqual(len(downloads), len(names))
                    self.assertEqual(len(checksums), len(names))
                    self.assertEqual([line.rsplit('/', 1)[-1] for line in downloads], list(names))
                    for name, download, checksum in zip(names, downloads, checksums):
                        digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                        self.assertIn('/' + COMMIT + '/scripts/production-release/' + name, download)
                        self.assertIn(digest + '  ', checksum)
                        self.assertNotIn('/' + OLD + '/', download)
                    self.assertFalse(any('online-recharge' in line for line in commands))

    def test_independent_receipt_binds_this_build_not_another_attempt_of_same_sha(self):
        candidate = proof()
        receipt = {'status': 'API_ADMIN_VERIFIED', 'commit': COMMIT, 'sourceTree': TREE,
            'buildProofSha256': scope.fingerprint(candidate), 'servicesUpdated': ['api', 'admin'],
            'preservedServiceCount': 5, 'runningImagesAndContentMatched': True, 'environmentUnchanged': True,
            'services': {name: {'image': row['imageId'], 'reference': row['reference']} for name, row in candidate['images'].items()}}
        with patch.object(Path, 'read_text', return_value=json.dumps(candidate)):
            transport.validate_receipt(receipt, COMMIT, 'readback')
            for key, value in [('commit', OLD), ('sourceTree', OLD), ('buildProofSha256', '9' * 64), ('preservedServiceCount', 4)]:
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    transport.validate_receipt({**receipt, key: value}, COMMIT, 'readback')
            other_attempt = copy.deepcopy(candidate)
            other_attempt['images']['api']['reference'] = other_attempt['images']['api']['reference'].replace('-123-1-', '-123-2-')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CHANGED'):
                transport.validate_receipt({**receipt, 'buildProofSha256': scope.fingerprint(other_attempt)}, COMMIT, 'readback')

    def test_dispatch_only_selects_explicit_scope_with_pinned_helper(self):
        text = (ROOT / 'scripts/production-release/dispatch.sh').read_text()
        program = text.split('python3 - "$parameters_file" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
        environment = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'EXPECTED_CURRENT': OLD,
            'RELEASE_REPOSITORY': REPOSITORY, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'QUALITY_RUN_ID': '456', 'RELEASE_OPERATION': 'release_api_admin', 'HISTORICAL_EXCEPTION': 'none'}
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.dict(os.environ, environment, clear=True), \
             patch.object(sys, 'argv', ['generate', str(Path(temporary) / 'parameters.json')]), \
             patch.object(Path, 'read_bytes', side_effect=lambda self=None: b'candidate'):
            exec(compile(program, '<dispatch>', 'exec'), {})
            data = json.loads((Path(temporary) / 'parameters.json').read_text())
        commands = '\n'.join(data['commands'])
        self.assertEqual(commands.count('sha256sum -c -'), 2)
        self.assertIn('--api-admin-only --api-admin-build-proof ', commands)
        self.assertNotIn('--image-commit', commands)
        self.assertNotIn('--historical-', commands)

    def test_failure_diagnostic_preserves_only_safe_code_and_error_type(self):
        raw = {'status': 'API_ADMIN_VERIFICATION_FAILED', 'code': 'API_ADMIN_BASELINE_JOBS_FAILED',
               'errorType': 'RuntimeError', 'rawError': 'PRIVATE'}
        self.assertEqual(transport.safe_failure(raw), {key: raw[key] for key in ('status', 'code', 'errorType')})
        raw['code'] = 'PRIVATE raw error'
        self.assertEqual(transport.safe_failure(raw)['code'], 'API_ADMIN_REMOTE_VERIFICATION_FAILED')

    def test_new_recharge_selection_is_mutually_exclusive_with_api_admin(self):
        arguments = ['remote-deploy.py', '--commit', COMMIT, '--source-tree', TREE,
            '--repository', REPOSITORY, '--expected-current', OLD, '--run-id', '123',
            '--run-attempt', '1', '--ci-run-id', '456', '--api-admin-only', '--recharge-pro-2f']
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.object(d, 'BASE', Path(temporary)), \
             patch.object(sys, 'argv', arguments), patch.object(d, 'recharge_2f_release') as recharge:
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(d.main(), 1)
            self.assertEqual(json.loads(output.getvalue())['code'], 'API_ADMIN_SCOPE_CONFLICT')
            recharge.assert_not_called()

    def test_selection_rejects_reuse_history_and_cache_inputs(self):
        environment = {'RELEASE_OPERATION': 'release_api_admin', 'HISTORICAL_EXCEPTION': 'none'}
        for changes, passes in [({}, True), ({'RELEASE_OPERATION': 'verify_api_admin'}, True),
            ({'HISTORICAL_EXCEPTION': 'historical-finance-20261005'}, False), ({'REUSE_IMAGE_RUN': '123'}, False),
            ({'RELEASE_ADMIN_ONLY': 'true'}, False), ({'RELEASE_BROWSER_CACHE_IMAGE': 'cache'}, False),
            ({'ORDER_ARCHIVE_SEAL_SHA256': 'a' * 64}, False)]:
            result = subprocess.run(['bash', 'scripts/production-release/validate-release-selection.sh'],
                cwd=ROOT, env={**os.environ, **environment, **changes}, capture_output=True)
            self.assertEqual(result.returncode == 0, passes, changes)


class RegistrationScopeTests(unittest.TestCase):
    def test_actual_projected_context_carries58_immutable_files_and_exact_pair(self):
        commit = REGISTRATION_FIXTURE_COMMIT
        tree = subprocess.check_output(['git', 'rev-parse', commit + '^{tree}'], cwd=ROOT, text=True).strip()
        profile = registration.registration_profile(d, ROOT)
        controller = SimpleNamespace(**vars(d))
        controller.run = lambda *args, **kwargs: (commit if args == ('git', 'rev-parse', 'HEAD')
            else tree if args == ('git', 'rev-parse', 'HEAD^{tree}') else d.run(*args, **kwargs))
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            root = Path(temporary)
            names = registration.WORKER_PAIR | set(profile['buildInputSha256']) | {registration.REGISTRATION_PROFILE}
            for name in names:
                raw = (subprocess.check_output(['git', 'show', commit + ':' + name], cwd=ROOT)
                       if name in registration.WORKER_PAIR else (ROOT / name).read_bytes())
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
            (root / '.dockerignore').write_bytes(b'unrelated native checkout changes\n')
            with patch.object(Path, 'cwd', return_value=root), patch.dict(os.environ, {'RELEASE_COMMIT': commit, 'SOURCE_TREE': tree}):
                record = registration.prepare_registration_build(controller)
            rows = record['workerProjection']
            self.assertEqual(len(rows), 60)
            self.assertEqual({n for n in rows if rows[n] != profile['workerProjection'][n]}, registration.WORKER_PAIR)
            context = root / '.deploy/production-release/api-registration-build-context'
            for name, row in rows.items():
                self.assertEqual(registration.hashlib.sha256((context / name).read_bytes()).hexdigest(), row['sha256'])
            self.assertEqual(record['workerProjectionSha256'], registration.fingerprint(rows))
            self.assertEqual(record['buildInputSourceCommit'], profile['workerBasisCommit'])
            self.assertEqual(record['buildInputSha256'], profile['buildInputSha256'])
            sealed_ignore = subprocess.check_output(['git', 'show', profile['workerBasisCommit'] + ':.dockerignore'], cwd=ROOT)
            self.assertEqual((context / '.dockerignore').read_bytes(), sealed_ignore)
            self.assertNotEqual((root / '.dockerignore').read_bytes(), sealed_ignore)
            api_context = root / '.deploy/production-release/api-registration-api-build-context'
            self.assertEqual((api_context / '.dockerignore').read_bytes(), subprocess.check_output(
                ['git', 'show', commit + ':.dockerignore'], cwd=ROOT))
            self.assertEqual((context / 'scripts/audit-python-dependencies.py').read_bytes(), (ROOT / 'scripts/audit-python-dependencies.py').read_bytes())

    def test_historical_worker_build_inputs_cannot_be_replaced_by_candidate_checkout(self):
        commit = REGISTRATION_FIXTURE_COMMIT
        tree = subprocess.check_output(['git', 'rev-parse', commit + '^{tree}'], cwd=ROOT, text=True).strip()
        profile = registration.registration_profile(d, ROOT)
        controller = SimpleNamespace(**vars(d))
        controller.run = lambda *args, **kwargs: (commit if args == ('git', 'rev-parse', 'HEAD')
            else tree if args == ('git', 'rev-parse', 'HEAD^{tree}') else d.run(*args, **kwargs))
        original = subprocess.check_output
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            root = Path(temporary)
            for name in registration.WORKER_PAIR | {registration.REGISTRATION_PROFILE}:
                raw = original(['git', 'show', commit + ':' + name], cwd=ROOT) if name in registration.WORKER_PAIR else (ROOT / name).read_bytes()
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(raw)
            def changed(command, *args, **kwargs):
                if command == ['git', 'show', profile['workerBasisCommit'] + ':.dockerignore']:
                    return b'tampered sealed build input\n'
                return original(command, *args, **kwargs)
            with patch.object(Path, 'cwd', return_value=root), patch.dict(os.environ, {'RELEASE_COMMIT': commit, 'SOURCE_TREE': tree}), \
                    patch.object(subprocess, 'check_output', side_effect=changed), \
                    self.assertRaisesRegex(RuntimeError, '^API_ADMIN_REGISTRATION_BUILD_INPUT_CHANGED$'):
                registration.prepare_registration_build(controller)
            self.assertFalse((root / '.deploy/production-release/api-registration-build-context').exists())
    def test_scope_selection_keeps_default_and_service_names_isolated(self):
        self.assertEqual(scope.UPDATED, ('api', 'admin'))
        self.assertEqual(registration.UPDATED, ('api', 'auto-registration'))
        self.assertEqual(registration.SWITCH_ORDER, ('api', 'auto-registration'))
        self.assertEqual(registration.image_service('auto-registration'), 'auto-recharge')
        selected, _ = d.api_admin_scope('API_REGISTRATION')
        default, _ = d.api_admin_scope()
        self.assertEqual(selected.UPDATED, registration.UPDATED)
        self.assertEqual(default.UPDATED, scope.UPDATED)
        with self.assertRaisesRegex(ValueError, 'SCOPE_CONFLICT'):
            d.api_admin_scope('ALL_SERVICES')

    def test_registration_requires_closed_window_while_readonly_can_observe_it(self):
        controller = JobGuardTests().controller()
        with self.assertRaisesRegex(RuntimeError, 'WINDOW_RETAINED'):
            registration.jobs_idle(controller, ROOT)
        self.assertTrue(registration.jobs_idle(controller, ROOT, allow_retained=True)['registrationWindowRetained'])
        self.assertTrue(scope.jobs_idle(controller, ROOT)['registrationWindowRetained'])
        controller.registration_runtime_state.return_value['registrationWindowRetained'] = False
        self.assertFalse(registration.jobs_idle(controller, ROOT)['registrationWindowRetained'])

    def test_proof_binds_complete60_two_file_delta_and_worker_tag_alias(self):
        value = registration_proof()
        registration.validate_proof(d, value, COMMIT, TREE, REPOSITORY, '123', '1')
        for mutate in ('preserved-source', 'pair-missing', 'projection-hash', 'wrong-tag', 'content', 'wrong-scope'):
            changed = copy.deepcopy(value)
            if mutate == 'preserved-source':
                changed['workerProjection'][registration.WORKER_PREFIX + 'server.py']['sha256'] = '9' * 64
            elif mutate == 'pair-missing':
                original = registration.registration_profile(d, ROOT)['workerProjection']
                name = next(iter(registration.WORKER_PAIR))
                changed['workerProjection'][name] = original[name]
            elif mutate == 'projection-hash': changed['workerProjectionSha256'] = '9' * 64
            elif mutate == 'wrong-tag': changed['images']['auto-registration']['reference'] += '-registration'
            elif mutate == 'content': changed['images']['auto-registration']['sha256'] = '9' * 64
            else: changed['scope'] = 'API_ADMIN'
            with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                registration.validate_proof(d, changed, COMMIT, TREE)
        with self.assertRaises(RuntimeError):
            scope.validate_proof(d, value, COMMIT, TREE)

    def test_build_proof_rejects_pair_hash_that_is_not_the_actual_git_commit(self):
        for name in registration.WORKER_PAIR:
            result = subprocess.run(['git', 'cat-file', '-e', 'HEAD:' + name], cwd=ROOT, capture_output=True)
            self.assertNotEqual(result.returncode, 0, 'Retired registration source must stay absent from current HEAD')
        # This negative proof belongs to the frozen historical registration build,
        # whose files are deliberately absent from the current retirement candidate.
        commit = REGISTRATION_FIXTURE_COMMIT
        tree = subprocess.check_output(['git', 'rev-parse', commit + '^{tree}'], cwd=ROOT, text=True).strip()
        value = registration_proof()
        projection = {n: value[n] for n in ('workerProjection', 'workerProjectionSha256')}
        controller = SimpleNamespace(require=d.require, run=MagicMock(side_effect=[commit, tree]))
        with patch.dict(os.environ, {'RELEASE_COMMIT': commit, 'SOURCE_TREE': tree}), \
             patch.object(Path, 'read_text', return_value=json.dumps(projection)), self.assertRaisesRegex(RuntimeError, 'PAIR_CHANGED'):
            registration.build_proof(controller)
        self.assertEqual(controller.run.call_count, 2)

    def test_candidate_scope_uses_actual_git_diff_and_forbids_api_dependency_or_schema_drift(self):
        commit = REGISTRATION_FIXTURE_COMMIT
        registration.registration_candidate_scope(d, commit)
        allowed = list(registration.API_CHANGES | registration.WORKER_PAIR)
        known = [registration.WORKER_PREFIX + n for n in ('plan_selection.py', 'registration_browser.py',
                                                        'test_pro.py', 'test_registration_browser.py')]
        controller = SimpleNamespace(require=d.require, run=MagicMock(side_effect=['\n'.join(known),
            '\n'.join(allowed + ['apps/api/prisma-mysql/schema.prisma'])]))
        with self.assertRaisesRegex(RuntimeError, 'API_SCOPE_CHANGED'):
            registration.registration_candidate_scope(controller, COMMIT)

    def test_reviewed_main_pricing_pair_is_pinned_and_stays_outside_registration_projection(self):
        commit = 'a1c99dd7f97855850067be970896e14abb504ec9'
        known = [registration.WORKER_PREFIX + n for n in ('plan_selection.py', 'registration_browser.py',
                                                        'test_pro.py', 'test_registration_browser.py')]
        allowed = registration.API_CHANGES | registration.WORKER_PAIR
        carried = set(registration.UNPUBLISHED_PRICING)
        self.assertTrue(carried.isdisjoint(registration.WORKER_PAIR))
        raw = {name: subprocess.check_output(['git', 'show', commit + ':' + name], cwd=ROOT) for name in carried}
        def controller(names):
            return SimpleNamespace(require=d.require, run=MagicMock(side_effect=['\n'.join(known), '\n'.join(names)]))
        registration.registration_candidate_scope(controller(allowed | carried), commit)
        with patch.object(registration.subprocess, 'check_output', side_effect=lambda args: raw[args[-1].split(':', 1)[1]] + b'\n'):
            with self.assertRaisesRegex(RuntimeError, 'API_SCOPE_CHANGED'):
                registration.registration_candidate_scope(controller(allowed | carried), commit)
        for changed in (allowed | {next(iter(carried))}, allowed | carried | {registration.WORKER_PREFIX + 'server.py'}):
            with self.subTest(changed=sorted(changed)), patch.object(registration.subprocess, 'check_output') as reader:
                with self.assertRaisesRegex(RuntimeError, 'API_SCOPE_CHANGED'):
                    registration.registration_candidate_scope(controller(changed), commit)
                reader.assert_not_called()

    def test_retired_registration_cannot_dispatch_or_fall_through_to_pricing(self):
        arguments = ['remote-deploy.py', '--commit', COMMIT, '--source-tree', TREE,
            '--repository', REPOSITORY, '--expected-current', OLD, '--run-id', '123',
            '--run-attempt', '1', '--ci-run-id', '456', '--api-registration-only', '--recharge-pro-pricing']
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.object(d, 'BASE', Path(temporary)), \
             patch.object(sys, 'argv', arguments), patch.object(d, 'recharge_pricing_release') as pricing:
            with self.assertRaisesRegex(RuntimeError, 'registration releases are disabled'):
                d.main()
            pricing.assert_not_called()
        arguments.remove('--api-registration-only')
        with patch.object(sys, 'argv', arguments), patch.object(d, 'recharge_pricing_release', return_value=0) as pricing:
            self.assertEqual(d.main(), 0)
            pricing.assert_called_once()

    def execute_private(self, *, close, mode='success', attempt=10):
        calls = []
        def read(request, timeout):
            method = request.get_method(); calls.append((method, request.full_url, request.data))
            if method == 'POST' and mode == '409':
                from urllib.error import HTTPError
                raise HTTPError(request.full_url, 409, 'PRIVATE RAW', {'PRIVATE': 'SECRET'},
                                io.BytesIO(b'{"ok":false,"reason":"fingerprint_cleanup_failed"}'))
            posted = any(row[0] == 'POST' for row in calls)
            if request.full_url.endswith('/status'):
                value = {'accepted': True, 'attempt': attempt, 'cancelled': posted, 'done': True}
                if mode == 'wrong-attempt': value['attempt'] = attempt + 1
                if mode == 'after-unconfirmed' and posted: value['cancelled'] = False
            elif method == 'POST': value = {'ok': True}
            else: value = {'ready': True, 'workerRole': 'registration', 'engine': 'camoufox',
                'mailDeliveryVersion': 1, 'registrationBusy': False, 'registrationWindowRetained': not posted}
            result = io.BytesIO(json.dumps(value).encode()); result.status = 202 if method == 'POST' else 200
            return result
        controller = SimpleNamespace(require=d.require)
        def compose(*args, **kwargs):
            code = args[-1]
            output = io.StringIO()
            with patch.dict(os.environ, {'AUTO_RECHARGE_WORKER_TOKEN': 'LOCAL_TEST_VALUE_' * 4}), \
                 patch('urllib.request.build_opener', return_value=SimpleNamespace(open=read)), redirect_stdout(output):
                exec(compile(code, '<actual-private-generated-source>', 'exec'), {})
            return output.getvalue()
        controller.compose = compose
        return controller, calls

    def test_private_generated_source_reads_only_without_explicit_close(self):
        controller, calls = self.execute_private(close=False)
        result = registration.registration_private(controller, ROOT)
        self.assertFalse(result['privatePostAttempted'])
        self.assertEqual([x[0] for x in calls], ['GET', 'GET'])

    def test_private_generated_source_posts_once_and_requires_after_confirmation(self):
        controller, calls = self.execute_private(close=True)
        result = registration.registration_private(controller, ROOT, close=True)
        self.assertTrue(result['privatePostAttempted'])
        self.assertEqual([x[0] for x in calls], ['GET', 'GET', 'POST', 'GET', 'GET'])
        self.assertEqual(next(x[2] for x in calls if x[0] == 'POST'), b'{"attempt":10}')
        for mode, attempted in (('wrong-attempt', False), ('after-unconfirmed', True), ('409', True)):
            controller, calls = self.execute_private(close=True, mode=mode)
            with self.subTest(mode=mode), self.assertRaises(registration.RegistrationHandoffError) as caught:
                registration.registration_private(controller, ROOT, close=True)
            self.assertEqual(caught.exception.diagnostic['privatePostAttempted'], attempted)
            self.assertEqual(sum(x[0] == 'POST' for x in calls), int(attempted))
            self.assertNotIn('PRIVATE', json.dumps(caught.exception.diagnostic))
            if mode == '409':
                self.assertEqual(caught.exception.diagnostic['controlledReason'], 'fingerprint_cleanup_failed')
                self.assertEqual(caught.exception.diagnostic['privatePostHttpStatus'], 409)

    def test_task_receipt_cannot_replace_attempt_binding_or_candidate_preservation(self):
        value = registration_task()
        controller = SimpleNamespace(require=d.require, compose=MagicMock(return_value=json.dumps(value)))
        self.assertEqual(registration.registration_task(controller, ROOT), value)
        for key, changed in (('attempt', 11), ('registered', False), ('passwordCandidatePresent', False),
                             ('binding', {}), ('jobHmac', 'raw-secret')):
            controller.compose.return_value = json.dumps({**value, key: changed})
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                registration.registration_task(controller, ROOT)

    def test_private_failure_transport_retains_only_fixed_diagnostic(self):
        diagnostic = {'confirmed': False, 'privatePostAttempted': True, 'failurePhase': 'close',
                      'privatePostHttpStatus': 409, 'controlledReason': 'fingerprint_cleanup_failed', 'rawOutputSuppressed': True}
        receipt = {'status': 'API_REGISTRATION_VERIFICATION_FAILED', 'code': 'API_ADMIN_REGISTRATION_PRIVATE_UNCONFIRMED',
                   'errorType': 'RegistrationHandoffError', 'privateDiagnostic': diagnostic, 'rawError': 'SECRET RAW'}
        result = transport.safe_failure(receipt, 'API_REGISTRATION')
        self.assertEqual(result['privateDiagnostic'], diagnostic)
        self.assertNotIn('rawError', result)
        receipt['privateDiagnostic'] = {**diagnostic, 'rawError': 'SECRET RAW'}
        self.assertNotIn('privateDiagnostic', transport.safe_failure(receipt, 'API_REGISTRATION'))

    def test_historical_handoff_transport_remains_fixed_and_retired_cli_selection_is_disabled(self):
        for mode, closed, flag in (('preflight', False, 'verify'), ('preflight', True, 'preflight'),
                                   ('handoff', True, 'handoff'), ('readback', True, 'readback'), ('business', True, 'business')):
            commands = '\n'.join(transport.parameters(COMMIT, OLD, mode, 'API_REGISTRATION', require_closed=closed)['commands'])
            self.assertIn('--api-registration-' + flag + ' --expected-current ' + OLD, commands)
            self.assertEqual(commands.count('sha256sum -c -'), 2)
            self.assertNotIn('/cancel', commands)
        with self.assertRaises(ValueError):
            transport.parameters(COMMIT, OLD, 'handoff')
        for operation in ('verify_api_registration', 'handoff_api_registration', 'release_api_registration', 'verify_registration_business'):
            for changed in ({}, {'HISTORICAL_EXCEPTION': 'historical-finance-20261005'},
                            {'REUSE_IMAGE_RUN': '1'}, {'RELEASE_BROWSER_CACHE_IMAGE': 'cache'}):
                result = subprocess.run(['bash', 'scripts/production-release/validate-release-selection.sh'],
                    cwd=ROOT, env={**os.environ, 'RELEASE_OPERATION': operation, 'HISTORICAL_EXCEPTION': 'none', **changed}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'registration releases are disabled', result.stderr)

    def test_workflow_separates_handoff_from_build_push_and_deploy(self):
        text = (ROOT / '.github/workflows/production-release.yml').read_text()
        self.assertIn("if: inputs.operation == 'handoff_api_registration'", text)
        for name in ('Build images on the GitHub runner', 'Push immutable images', 'Deploy through the production instance'):
            block = text.split('- name: ' + name + '\n', 1)[1].split('\n      - name:', 1)[0]
            self.assertIn("inputs.operation == 'release_api_registration'", block)
            self.assertNotIn('handoff_api_registration', block)

    def test_business_logs_filter_latest_attempt_and_preserve_first_failure_without_raw_text(self):
        task = {'attempt': 11, 'launchAt': '2026-10-08T03:00:00.000Z'}
        prefix = 'Registration verification '
        target = 'job=' + registration.TASK_ID + ' attempt=11 '
        raw = '\n'.join([
            'PRIVATE RAW EMAIL OTP TOKEN',
            prefix + 'checkpoint ' + target + 'checkpoint=email_code_returned owned_context=True after_email_code_returned=True',
            prefix + 'checkpoint ' + target.replace('attempt=11', 'attempt=10') + 'checkpoint=same_email_identity_confirmed owned_context=True after_email_code_returned=True',
            prefix + 'failed ' + target + 'phase=identity_read error_type=Stop browser_code=none cleanup=False reason=verification_required subphase=identity_after_get form_state=absent',
            prefix + 'failed ' + target + 'phase=cleanup error_type=Error browser_code=NS_ERROR_NET_RESET cleanup=True reason=session_network_error subphase=context_cleanup form_state=absent',
            prefix + 'failed ' + target + 'phase=navigation error_type=TimeoutError browser_code=net::ERR_TIMED_OUT cleanup=False reason=session_load_timeout subphase=get_retry form_state=absent',
        ])
        controller = SimpleNamespace(require=d.require, service_state=MagicMock(return_value={'containerId': 'a' * 64}))
        with patch.object(registration.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr=raw)) as docker:
            result = registration.business_logs(controller, ROOT, task)
        self.assertEqual(result['checkpoints'], {'email_code_returned': 1, 'same_email_identity_confirmed': 0})
        self.assertEqual(result['failureCount'], 3)
        self.assertEqual(result['cleanupFailureCount'], 1)
        self.assertEqual(result['firstFailure']['subphase'], 'identity_after_get')
        self.assertEqual(result['lastFailure']['browserCode'], 'net::ERR_TIMED_OUT')
        self.assertFalse(result['provesOfficialOtpAcceptance'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(docker.call_args.args[0][3:7], [task['launchAt'], '--tail', '1000', 'a' * 64])

    def test_business_read_keeps_runtime_proof_but_accepts_latest_attempt_and_rejects_stale_flags(self):
        task = {'taskId': registration.TASK_ID, 'attempt': 11, 'state': 'completed', 'step': 'completed', 'reason': 'none',
            'registered': True, 'passwordVerified': True, 'mfaVerified': True, 'accountRegistered': True,
            'encryptedPasswordPresent': True, 'encryptedMfaPresent': True, 'leaseActive': False, 'profileBindingConfirmed': True,
            'launchAt': '2026-10-08T03:00:00.000Z', 'updatedAt': '2026-10-08T03:01:00.000Z',
            'progressCount': 6, 'progressTruncated': False, 'codeReadCount': 1, 'codeReadTruncated': False,
            'officialThisAttempt': True, 'passwordThisAttempt': True, 'mfaThisAttempt': True,
            'officialAt': '2026-10-08T03:00:01.000Z', 'passwordAt': '2026-10-08T03:00:01.000Z', 'mfaAt': '2026-10-08T03:00:02.000Z'}
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); current = base / 'releases' / 'candidate'; current.mkdir(parents=True)
            (base / 'current').symlink_to(current)
            (current / registration.STATE_FILE).write_text(json.dumps({'registrationTask': registration_task()}))
            controller = SimpleNamespace(require=d.require, BASE=base, compose=MagicMock(return_value=json.dumps(task)))
            readback = stack.enter_context(patch.object(registration, 'readback', return_value={'services': states()}))
            stack.enter_context(patch.object(registration, 'snapshot', return_value=states()))
            stack.enter_context(patch.object(registration, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(registration, 'business_logs', return_value={'rawOutputSuppressed': True}))
            result = registration.registration_business(controller, COMMIT)
            self.assertTrue(result['businessAcceptanceConfirmed'])
            self.assertTrue(result['readOnly'])
            readback.assert_called_once_with(controller, COMMIT, check_task=False)
            self.assertTrue(all('node' in call.args and 'POST' not in call.args for call in controller.compose.call_args_list))
            inherited = {**task, 'officialThisAttempt': False, 'passwordThisAttempt': False, 'mfaThisAttempt': False,
                         'officialAt': None, 'passwordAt': None, 'mfaAt': None}
            controller.compose.return_value = json.dumps(inherited)
            self.assertFalse(registration.registration_business(controller, COMMIT)['businessAcceptanceConfirmed'])
            controller.compose.return_value = json.dumps({**task, 'reason': 'RAW PRIVATE VALUE'})
            with self.assertRaisesRegex(RuntimeError, 'BUSINESS_UNAVAILABLE'):
                registration.registration_business(controller, COMMIT)


class RegistrationHandoffTests(unittest.TestCase):
    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); directory = base / 'releases' / 'original'; directory.mkdir(parents=True)
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            # The macOS fixture is user-owned; only this host-owner precondition is
            # supplied by the fixture. File modes, exclusive writes and locks are real.
            controller.require = lambda ok, message: d.require(ok or message == 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED', message)
            stack.enter_context(patch.object(registration, 'REGISTRATION_DIRECTORY', str(directory)))
            proof = {'requiresWindowHandoff': True, 'task': registration_task(), 'services': states()}
            preflight = stack.enter_context(patch.object(registration, 'registration_preflight', return_value=proof))
            stack.enter_context(patch.object(registration, 'snapshot', return_value=states()))
            stack.enter_context(patch.object(registration, 'workspace_existing', return_value=False))
            task = stack.enter_context(patch.object(registration, 'registration_task', return_value=registration_task()))
            stack.enter_context(patch.object(registration, 'jobs_idle'))
            calls = []
            diagnostic = {'confirmed': False, 'privatePostAttempted': True, 'failurePhase': 'close',
                          'privatePostHttpStatus': 409, 'controlledReason': 'fingerprint_cleanup_failed', 'rawOutputSuppressed': True}
            def private(*args, **kwargs):
                calls.append(kwargs)
                if kwargs.get('close') and failure == '409':
                    raise registration.RegistrationHandoffError(diagnostic)
                return {'confirmed': True}
            stack.enter_context(patch.object(registration, 'registration_private', side_effect=private))
            if failure == 'task-changed': task.return_value = {**registration_task(), 'jobHmac': '9' * 64}
            if failure:
                with self.assertRaises(RuntimeError):
                    registration.registration_handoff(controller, registration.REGISTRATION_CURRENT)
                with self.assertRaisesRegex(RuntimeError, 'ALREADY_ATTEMPTED'):
                    registration.registration_handoff(controller, registration.REGISTRATION_CURRENT)
            else:
                result = registration.registration_handoff(controller, registration.REGISTRATION_CURRENT)
                self.assertTrue(result['privateCancelPerformed'])
                self.assertEqual(result['databaseWrites'], 0)
                preflight.return_value = {**proof, 'requiresWindowHandoff': False}
                second = registration.registration_handoff(controller, registration.REGISTRATION_CURRENT)
                self.assertFalse(second['privateCancelPerformed'])
            folder = registration.handoff_directory(controller)
            self.assertEqual(sum(row.get('close') is True for row in calls), 1)
            self.assertEqual((folder / 'attempt.json').stat().st_mode & 0o777, 0o400)
            if failure == '409':
                self.assertEqual(json.loads((folder / 'failure.json').read_text()), diagnostic)
                self.assertFalse((folder / 'confirmed.json').exists())
            elif failure == 'task-changed':
                self.assertFalse((folder / 'confirmed.json').exists())
            else:
                record = json.loads((folder / 'confirmed.json').read_text())
                self.assertEqual(record['task'], registration_task())
                self.assertTrue(record['accountPreserved'])
                self.assertTrue(record['passwordCandidatePreserved'])
                self.assertEqual((folder / 'confirmed.json').stat().st_mode & 0o777, 0o400)

    def test_same_registered_job_cleanup_is_independent_once_and_preserves_candidate(self):
        self.exercise()

    def test_controlled_failure_is_persisted_and_cannot_send_second_post(self):
        self.exercise('409')

    def test_changed_db_snapshot_cannot_be_written_as_confirmed(self):
        self.exercise('task-changed')


class ReleaseFailureTests(unittest.TestCase):
    def run_release(self, fail_at=None, busy_after_switch=False, preserved_changed=False, failure_receipt_unwritable=False,
                    selected_scope=scope, handoff_check=None, idle_check=None, after_api=None, archive_pair_mode=0o664,
                    migration_preapplied=False, migration_failure=None, migration_task_changed=False, migration_window_changed=False,
                    migration_origin=None, migration_origin_guard=None, workspace_busy=False, candidate_workspace=False,
                    sqlite_gate=None, sqlite_prepare_error=False, online_origin_context=None, online_fail=None, workspace_admission_failure=None,
                    pending_origin=None, pending_proof_origin_sha=None, pending_origin_after_build=None):
        scope = selected_scope
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            if failure_receipt_unwritable:
                original_write = Path.write_text
                def write(path, *args, **kwargs):
                    if path.name == scope.FAILURE_FILE:
                        raise OSError('receipt unavailable')
                    return original_write(path, *args, **kwargs)
                stack.enter_context(patch.object(Path, 'write_text', write))
            base = Path(temporary); previous = base / 'releases' / 'previous'; previous.mkdir(parents=True)
            (base / 'current').symlink_to(previous)
            (previous / '.env.aws.production').write_text('preserved')
            (previous / 'release-manifest.json').write_text('{}')
            for name in scope.CONFIG_FILES:
                path = previous / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((WORKSPACE_SOURCE_ROOT / name).read_bytes() if scope.WORKSPACE else b'config')
            (previous / 'compose.release.json').write_text(json.dumps({'services': {name: {'image': 'old'} for name in d.SERVICES}}))
            if scope.MIGRATION_MODE:
                migration_fixture(previous, old=True)
            candidate = migration_proof() if scope.MIGRATION_MODE else registration_proof() if scope.REGISTRATION else workspace_proof() if scope.WORKSPACE else proof()
            if pending_origin is not None:
                candidate['pendingOnlineProjection'] = {'fixture': 'separately-tested-projection'}
                if pending_proof_origin_sha != 'MISSING':
                    candidate['pendingOnlineOriginSha256'] = (scope.fingerprint(pending_origin)
                        if pending_proof_origin_sha is None else pending_proof_origin_sha)
                projection = scope.pending_projection()
                stack.enter_context(patch.object(scope, 'pending_projection', return_value=SimpleNamespace(
                    __file__=projection.__file__, validate_record=MagicMock())))
                controller_projection = stack.enter_context(patch.object(scope, 'apply_pending_runtime_projection'))
                stack.enter_context(patch.object(scope, 'pending_online_guard'))
            args = SimpleNamespace(admin_only=False, image_commit=None, image_run_id=None, image_run_attempt=None,
                post_cleanup_seal_sha256=None, order_archive_seal_sha256=None, order_archive_prepared_images_sha256=None,
                api_admin_build_proof=base64.b64encode(json.dumps(candidate).encode()).decode(), api_admin_migration_only=scope.MIGRATION_MODE,
                api_workspace_only=scope.WORKSPACE,
                commit=COMMIT, source_tree=TREE, expected_current=OLD, repository=REPOSITORY, run_id='123', run_attempt='1', ci_run_id='456')
            before = states()
            if online_origin_context is not None:
                before['online-recharge']=copy.deepcopy(before['api'])
                before['online-recharge'].update(online_origin_context['binding'])
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.compose = MagicMock(); controller.wait_healthy = MagicMock()
            guards, task = migration_guards(), migration_task() if scope.MIGRATION_MODE else registration_task()
            migration_state = {'name': migration.MIGRATION_NAME, 'sha256': migration.MIGRATION_IDENTITY['sha256'],
                'status': 'APPLIED' if migration_preapplied else 'PENDING', 'schemaVerified': True, 'appliedMigrationsSha256': '7' * 64}
            if scope.MIGRATION_MODE:
                def compose(*command, **kwargs):
                    if command[1] == 'run':
                        if migration_failure == 'before': raise RuntimeError('PRIVATE_SENTINEL')
                        migration_state['status'] = 'UNVERIFIED' if migration_failure == 'partial' else 'APPLIED'
                        if migration_task_changed: task['jobHmac'] = '9' * 64
                        if migration_window_changed: guards['registrationWindowRetained'] = False
                        if migration_failure: raise RuntimeError('PRIVATE_SENTINEL')
                    if command[-1] == 'api' and after_api is not None: after_api()
                    return ''
                controller.compose.side_effect = compose
            if after_api is not None:
                def compose(*command, **kwargs):
                    if command[-1] == 'api': after_api()
                    return ''
                controller.compose.side_effect = compose
            controller.rollback_service = MagicMock(); controller.point_current = MagicMock()
            controller.environment_values = lambda path: {'APP_PUBLIC_URL': 'https://example.test'}
            controller.fresh_backup = MagicMock(return_value={'name': 'backup'})
            if fail_at == 'backup': controller.fresh_backup.side_effect = RuntimeError('PRIVATE_SENTINEL')
            controller.service_state = lambda directory, name, **kw: before[name]
            controller.commands = []
            def run(*command, **kw):
                controller.commands.append(command)
                if fail_at == 'caddy-validation' and command[:2] == ('docker', 'run') and 'validate' in command:
                    raise RuntimeError('PRIVATE_SENTINEL_CADDY_OUTPUT')
                if command[:3] == ('docker', 'image', 'inspect'):
                    row = next(row for row in candidate['images'].values() if row['reference'] == command[-1])
                    return json.dumps([{'Id': row['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': {
                        'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}])
                return ''
            controller.run = run
            archive_data = io.BytesIO()
            with tarfile.open(fileobj=archive_data, mode='w:gz') as archive:
                for name in ('remote-deploy.py', 'api-admin-scope.py',
                             *(('online-recharge-scope.py',) if online_origin_context is not None else ()),
                             *(('api-admin-pending-projection.py',) if pending_origin is not None else ())):
                    path = Path(__file__).with_name(name)
                    raw = path.read_bytes(); info = tarfile.TarInfo(f'id-business-system-{COMMIT}/scripts/production-release/{name}')
                    info.size = len(raw); archive.addfile(info, io.BytesIO(raw))
                if scope.MIGRATION_MODE:
                    for name in [scope.MIGRATION_SCHEMA, scope.MIGRATION_SEED, *(scope.MIGRATION_ROOT + '/' + name for name in scope.migration_files(d, LEGACY_PRISMA_ROOT))]:
                        raw = (LEGACY_PRISMA_ROOT / name).read_bytes(); info = tarfile.TarInfo(f'id-business-system-{COMMIT}/' + name)
                        info.size = len(raw); info.mode = 0o644; archive.addfile(info, io.BytesIO(raw))
                if scope.WORKSPACE or candidate_workspace:
                    for name in scope.CONFIG_FILES:
                        source = WORKSPACE_SOURCE_ROOT if scope.WORKSPACE else ROOT
                        raw = (source / name).read_bytes(); info = tarfile.TarInfo(f'id-business-system-{COMMIT}/' + name)
                        info.size = len(raw); info.mode = 0o644; archive.addfile(info, io.BytesIO(raw))
                if scope.REGISTRATION:
                    for name in scope.WORKER_PAIR:
                        raw = b'candidate-pair'; candidate['workerProjection'][name]['sha256'] = scope.hashlib.sha256(raw).hexdigest()
                        info = tarfile.TarInfo(f'id-business-system-{COMMIT}/' + name); info.size = len(raw); info.mode = archive_pair_mode
                        archive.addfile(info, io.BytesIO(raw))
                    candidate['workerProjectionSha256'] = scope.fingerprint(candidate['workerProjection'])
                    candidate['images']['auto-registration'].update(scope.worker_content(candidate['workerProjection']))
                    args.api_admin_build_proof = base64.b64encode(json.dumps(candidate).encode()).decode()
            if scope.REGISTRATION and fail_at == 'pair-source':
                candidate['workerProjection'][next(iter(scope.WORKER_PAIR))]['sha256'] = '0' * 64
                candidate['workerProjectionSha256'] = scope.fingerprint(candidate['workerProjection'])
                candidate['images']['auto-registration'].update(scope.worker_content(candidate['workerProjection']))
                args.api_admin_build_proof = base64.b64encode(json.dumps(candidate).encode()).decode()
            def response(url, **kw):
                value = io.BytesIO(archive_data.getvalue() if 'archive/' in url else b'')
                value.status = 200
                if scope.WORKSPACE:
                    value.headers = {'Content-Security-Policy': re.search(r'Content-Security-Policy "([^"]+)"', (WORKSPACE_SOURCE_ROOT / scope.CONFIG_FILES[1]).read_text()).group(1)}
                return value
            stack.enter_context(patch.object(scope.urllib.request, 'urlopen', side_effect=response))
            stack.enter_context(patch.object(scope.subprocess, 'run', return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(scope, 'source_tree', return_value=TREE))
            stack.enter_context(patch.object(scope, 'configuration_hashes', return_value={'config': 'hash'}))
            evidence = {'manifestSha256': scope.hashlib.sha256(b'{}').hexdigest(), 'environmentSha256': 'env'}
            if pending_origin is not None:
                if pending_origin_after_build is not None:
                    pending_origin = pending_origin_after_build
                evidence.update(pendingOnlineMigrationOrigin=pending_origin, onlinePublished=False, migrationPerformed=False)
                controller._pendingOnlineMigrationOrigin = pending_origin
            if scope.WORKSPACE:
                controller.workspace_admission = SimpleNamespace(acquire=MagicMock(), before_stop=MagicMock(),
                    check_idle=MagicMock(), stop=MagicMock(), close=MagicMock())
                if workspace_admission_failure == 'acquire':
                    controller.workspace_admission.acquire.side_effect=RuntimeError('API_ADMIN_WORKSPACE_AUDIT_GUARD_FAILED')
                if workspace_admission_failure == 'before-stop':
                    controller.workspace_admission.before_stop.side_effect=RuntimeError('API_ADMIN_WORKSPACE_GUARD_TIMEOUT')
                if workspace_admission_failure == 'after-stop':
                    controller.workspace_admission.check_idle.side_effect=RuntimeError('API_ADMIN_WORKSPACE_AUDIT_GUARD_FAILED')
                stack.enter_context(patch.object(scope, 'WorkspaceAuditBarrier', return_value=controller.workspace_admission))
                stack.enter_context(patch.object(scope, 'workspace_database_identity', return_value={'database':'fixture_database'}))
                stack.enter_context(patch.object(scope, 'workspace_api_metadata', return_value={}))
                evidence['workspaceVolume'] = {'name': 'fixture_auto_registration_data', 'status': 'ABSENT', 'identitySha256': None}
                stack.enter_context(patch.object(scope, 'workspace_volume', return_value={
                    'name': 'fixture_auto_registration_data', 'status': 'PRESENT', 'identitySha256': '6' * 64}))
                def workspace_task_guard(_controller, directory, **kwargs):
                    if workspace_busy and directory != previous:
                        raise RuntimeError('API_ADMIN_WORKSPACE_TASK_ACTIVE')
                stack.enter_context(patch.object(scope, 'workspace_idle', side_effect=workspace_task_guard))
                if sqlite_gate is not None:
                    if sqlite_prepare_error:
                        error = RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SAFETY_FAILED')
                        error.sqlite_gate = sqlite_gate
                        stack.enter_context(patch.object(scope, 'workspace_prepare', side_effect=error))
                    else:
                        stack.enter_context(patch.object(scope, 'workspace_prepare', return_value=sqlite_gate))
                    stack.enter_context(patch.object(scope, 'workspace_private_inspect', return_value={}))
                if online_origin_context is not None:
                    evidence['onlineRechargeOrigin']=online_origin_context
                    stack.enter_context(patch.object(scope,'online_origin_guard'))
                    stack.enter_context(patch.object(scope,'online_binding',return_value=online_origin_context['binding']))
                    stack.enter_context(patch.object(scope,'online_idle',side_effect=RuntimeError('API_ADMIN_ONLINE_TASK_ACTIVE') if online_fail=='idle' else None))
                    controller.online_fence=SimpleNamespace(acquire=MagicMock(side_effect=RuntimeError('API_ADMIN_ONLINE_TASK_ACTIVE') if online_fail=='fence' else None),
                        stop=MagicMock(),check_idle=MagicMock(),close=MagicMock(),mysql=before['mysql'],connection_id=17)
                    stack.enter_context(patch.object(scope,'OnlineSqlFence',return_value=controller.online_fence))
                    controller.online_rebind=stack.enter_context(patch.object(scope,'online_rebind',
                        side_effect=RuntimeError('API_ADMIN_ONLINE_RUNTIME_CHANGED') if online_fail in ('rebind','rollback-busy') else None))
                    controller.online_rollback=stack.enter_context(patch.object(scope,'online_rollback_api',
                        side_effect=RuntimeError('API_ADMIN_ONLINE_TASK_ACTIVE') if online_fail=='rollback-busy' else None))
            if migration_origin is not None:
                evidence['migrationOrigin'] = migration_origin
                controller.migration_origin_guard = stack.enter_context(patch.object(scope, 'migration_successor_guard', side_effect=migration_origin_guard))
            if scope.MIGRATION_MODE:
                evidence.update(guards=copy.deepcopy(guards), migrationState=copy.deepcopy(migration_state))
                def database_state(*args):
                    if migration_state['status'] == 'UNVERIFIED': raise RuntimeError('API_ADMIN_MIGRATION_HISTORY_CHANGED')
                    return copy.deepcopy(migration_state)
                stack.enter_context(patch.object(scope, 'migration_database_state', side_effect=database_state))
                stack.enter_context(patch.object(scope, 'verify_migration_image'))
                controller.private_stub = stack.enter_context(patch.object(scope, 'registration_private'))
            old = {'images': {name: {'sourceCommit': OLD} for name in d.SERVICES},
                   'fixedRegistrationRelease': {'id': 'old'}, 'fixedRegistrationPreservedStates': {}}
            stack.enter_context(patch.object(scope, 'baseline', return_value=(previous, old, before, evidence)))
            stack.enter_context(patch.object(scope, 'registration_task', side_effect=lambda *args: copy.deepcopy(task)))
            stack.enter_context(patch.object(scope, 'require_preserved', return_value=before))
            stack.enter_context(patch.object(scope, 'strict_audit', return_value={'checksSha256': 'rules'}))
            idle = stack.enter_context(patch.object(scope, 'jobs_idle', side_effect=(lambda *args, **kw: copy.deepcopy(guards)) if scope.MIGRATION_MODE else None))
            stack.enter_context(patch.object(scope, 'require_registration_handoff', side_effect=handoff_check))
            if idle_check is not None: idle.side_effect = idle_check
            stack.enter_context(patch.object(scope, 'verify_running'))
            stack.enter_context(patch.object(scope, 'readback', return_value={'status': scope.SCOPE + '_VERIFIED'}))
            restore = copy.deepcopy(before)
            if preserved_changed: restore['auto-registration']['containerId'] = 'changed'
            stack.enter_context(patch.object(scope, 'snapshot', return_value=restore))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            if busy_after_switch:
                idle.side_effect = [None, None, RuntimeError('API_ADMIN_REGISTRATION_BUSY')]
                controller.wait_healthy.side_effect = [None, RuntimeError('unhealthy')]
            if fail_at == 'health': controller.wait_healthy.side_effect = RuntimeError('unhealthy')
            if fail_at == 'queued-before-api':
                idle.side_effect = [None, RuntimeError('API_ADMIN_REGISTRATION_BUSY')]
            if fail_at == 'api-health':
                controller.wait_healthy.side_effect = [None, RuntimeError('unhealthy')]
            if fail_at == 'caddy-health':
                controller.wait_healthy.side_effect = [None, None, RuntimeError('unhealthy')]
            if fail_at == 'queued-after-api':
                idle.side_effect = [None, None, RuntimeError('API_ADMIN_REGISTRATION_BUSY')]
            output = io.StringIO()
            with redirect_stdout(output):
                code = scope.release(controller, args)
            result = json.loads(output.getvalue().splitlines()[-1])
            manifests = list((base / 'releases').glob('*/release-manifest.json'))
            new_manifest = next((json.loads(p.read_text()) for p in manifests if p.parent != previous), None)
            failure_files = list((base / 'releases').glob('*/' + scope.FAILURE_FILE))
            if pending_origin is not None:
                controller.pending_projection = controller_projection
                controller.pending_build_proof = candidate
                records = list((base / 'releases').glob('*/' + scope.STATE_FILE))
                controller.pending_record = json.loads(records[-1].read_text()) if records else None
            return code, result, controller, new_manifest, bool(failure_files)

    def test_success_updates_only_api_admin_and_drops_historical_classification(self):
        code, result, controller, manifest, _ = self.run_release()
        self.assertEqual(code, 0)
        self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['admin', 'api'])
        self.assertTrue(all('--no-deps' in call.args and '--no-build' in call.args for call in controller.compose.call_args_list))
        self.assertEqual(manifest['servicesUpdated'], ['api', 'admin'])
        self.assertNotIn('fixedRegistrationRelease', manifest)
        self.assertNotIn('fixedRegistrationPreservedStates', manifest)
        self.assertEqual(manifest['images']['auto-registration']['sourceCommit'], OLD)
        self.assertEqual(manifest['newMigrations'], [])
        controller.rollback_service.assert_not_called()

    def test_registration_success_switches_only_api_and_registration_with_fresh_proof(self):
        code, result, controller, manifest, _ = self.run_release(selected_scope=registration)
        self.assertEqual(code, 0)
        self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['api', 'auto-registration'])
        self.assertEqual(manifest['servicesUpdated'], ['api', 'auto-registration'])
        self.assertEqual(manifest['images']['auto-recharge']['sourceCommit'], OLD)
        self.assertEqual(manifest['images']['admin']['sourceCommit'], OLD)
        self.assertEqual(manifest['apiRegistrationPublication']['scope'], 'API_REGISTRATION')
        self.assertTrue(manifest['apiRegistrationPublication']['workersPublished'])
        self.assertNotIn('apiAdminPublication', manifest)
        self.assertEqual(manifest['newMigrations'], [])
        self.assertFalse(manifest['migrationApplied'])
        controller.rollback_service.assert_not_called()

    def test_registration_pair_proof_must_match_actual_verified_candidate_archive(self):
        code, result, controller, _, _ = self.run_release(selected_scope=registration, fail_at='pair-source')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_REGISTRATION_FAILED_BEFORE_SWITCH')
        self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        controller.compose.assert_not_called()
        controller.rollback_service.assert_not_called()

    def test_registration_archive_pair_accepts_only_normal_non_executable_source_modes(self):
        for mode in (0o644, 0o664):
            with self.subTest(mode=oct(mode)):
                code, _, controller, manifest, _ = self.run_release(selected_scope=registration, archive_pair_mode=mode)
                self.assertEqual(code, 0)
                self.assertEqual(manifest['servicesUpdated'], ['api', 'auto-registration'])
                controller.rollback_service.assert_not_called()
        for mode in (0o666, 0o755, 0o777, 0o4644):
            with self.subTest(mode=oct(mode)):
                code, result, controller, _, _ = self.run_release(selected_scope=registration, archive_pair_mode=mode)
                self.assertEqual(code, 1)
                self.assertEqual(result['status'], 'API_REGISTRATION_FAILED_BEFORE_SWITCH')
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_PAIR_CHANGED')
                self.assertEqual(result['servicesAttempted'], [])
                controller.compose.assert_not_called()
                controller.rollback_service.assert_not_called()

    def test_api_switch_then_retained_false_and_registration_cid_drift_blocks_worker_switch(self):
        with RegistrationRecoveryTests().fixture() as f:
            registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            original_require = registration.require_registration_handoff
            observed_guards = []
            def idle_check(*args, **kwargs):
                value = f.original_idle(f.controller, f.directory)
                observed_guards.append(value['registrationWindowRetained'])
                return value
            def handoff_check(_controller, _previous, manifest):
                return original_require(f.controller, f.directory, manifest)
            def after_api():
                f.controller.registration_runtime_state.return_value['registrationWindowRetained'] = False
                f.controller.service_state.return_value = {**f.states['auto-registration'], 'containerId': 'f' * 64}
            code, result, controller, _, _ = self.run_release(selected_scope=registration,
                idle_check=idle_check, handoff_check=handoff_check, after_api=after_api)
            self.assertEqual(code, 1)
            self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_CONTAINER_CHANGED')
            self.assertEqual(result['servicesAttempted'], ['api'])
            self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['api'])
            self.assertIn(True, observed_guards); self.assertIn(False, observed_guards)

    def test_registration_failed_health_rolls_back_without_touching_other_five(self):
        code, result, controller, _, _ = self.run_release(selected_scope=registration, fail_at='api-health')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_REGISTRATION_FAILED_RESTORED')
        self.assertEqual([c.args[2] for c in controller.rollback_service.call_args_list], ['auto-registration', 'api'])

    def test_registration_new_job_blocks_all_resource_rollback(self):
        code, result, controller, _, _ = self.run_release(selected_scope=registration, busy_after_switch=True)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_REGISTRATION_PARTIAL_RECOVERY_REQUIRED')
        self.assertFalse(result['rollbackOk'])
        controller.rollback_service.assert_not_called()

    def test_new_active_job_blocks_rollback_and_reports_partial_state(self):
        code, result, controller, manifest, persisted = self.run_release(busy_after_switch=True)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_PARTIAL_RECOVERY_REQUIRED')
        self.assertFalse(result['rollbackOk'])
        self.assertTrue(persisted)
        self.assertEqual(result['servicesAttempted'], ['admin', 'api'])
        self.assertEqual(controller.rollback_service.call_count, 1)
        self.assertEqual(controller.rollback_service.call_args.args[2], 'admin')
        controller.point_current.assert_not_called()

    def test_failed_api_health_rolls_back_only_api_when_jobs_still_idle(self):
        code, result, controller, _, _ = self.run_release(fail_at='api-health')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_FAILED_RESTORED')
        self.assertTrue(result['rollbackOk'])
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['api', 'admin'])
        self.assertEqual(controller.rollback_service.call_count, 2)

    def test_queued_job_before_api_only_rolls_back_admin_without_worker_guard(self):
        code, result, controller, _, _ = self.run_release(fail_at='queued-before-api')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_FAILED_RESTORED')
        self.assertEqual(result['servicesAttempted'], ['admin'])
        self.assertEqual(controller.rollback_service.call_args.args[2], 'admin')

    def test_queued_job_after_api_does_not_block_already_completed_switch(self):
        code, result, controller, _, _ = self.run_release(fail_at='queued-after-api')
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'API_ADMIN_VERIFIED')
        controller.rollback_service.assert_not_called()

    def test_failure_receipt_io_error_keeps_actual_partial_state(self):
        code, result, controller, _, persisted = self.run_release(busy_after_switch=True, failure_receipt_unwritable=True)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_PARTIAL_RECOVERY_REQUIRED')
        self.assertEqual(result['servicesAttempted'], ['admin', 'api'])
        self.assertFalse(result['receiptPersisted'])
        self.assertFalse(persisted)

    def test_outer_unexpected_failure_never_claims_no_switch(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.object(scope, '_release_locked', side_effect=OSError('unavailable')):
            controller = SimpleNamespace(BASE=Path(temporary), fcntl=d.fcntl)
            output = io.StringIO()
            with redirect_stdout(output):
                code = scope.release(controller, None)
            result = json.loads(output.getvalue())
            self.assertEqual(code, 1)
            self.assertEqual(result['status'], 'API_ADMIN_FAILED_STATE_UNVERIFIED')
            self.assertNotIn('servicesAttempted', result)

    def test_worker_drift_prevents_false_restored_claim(self):
        code, result, controller, _, _ = self.run_release(fail_at='health', preserved_changed=True)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_PARTIAL_RECOVERY_REQUIRED')
        self.assertFalse(result['rollbackOk'])
        controller.point_current.assert_not_called()


class NativeHandoffGeneratedTests(unittest.TestCase):
    def test_native_handoff_exec_uses_explicit_worker_uid_and_fixed_container_id(self):
        cid, module_sha = 'a' * 64, 'b' * 64
        result = {'status': 'OBSERVED', 'nativeCount': 0, 'nativeCountObserved': True,
                  'signalsAttempted': 0, 'zeroObservations': 2, 'resourceClosed': True,
                  'readOnly': True, 'code': 'none'}
        controller = SimpleNamespace(require=d.require, run=MagicMock(return_value=json.dumps(result)))
        profile = {'workerProjection': {registration.WORKER_PREFIX + 'fingerprint_runtime.py': {'sha256': module_sha}}}
        with patch.object(registration, 'registration_profile', return_value=profile):
            self.assertEqual(registration.native_handoff(controller, ROOT, cid), result)
        source = registration.NATIVE_HANDOFF_SOURCE.replace('__RECOVER__', 'False').replace('__MODULE_SHA__', repr(module_sha))
        controller.run.assert_called_once_with('docker', 'exec', '--user', '10001:10001', '-i', cid,
                                               'python', '-B', '-c', source, timeout=20)

    @contextmanager
    def fixture(self, rows=None, outcome='exit', changed_on_open=False, inaccessible=False, unknown_exe=False,
                uid=10001, gid=10001, exit_ready=True, exit_mask=select.POLLIN, exit_fd_delta=0):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); proc = base / 'proc'; engine = base / 'engine'
            proc.mkdir(); engine.mkdir(); (engine / 'camoufox').write_bytes(b'synthetic engine')
            module = base / 'fingerprint_runtime.py'
            module.write_bytes((ROOT / (registration.WORKER_PREFIX + 'fingerprint_runtime.py')).read_bytes())
            starts = {}; links = {str(proc / 'self' / 'exe'): sys.executable}; fd_to_pid = {}; signals = []
            def state(pid, kind, stamp=123):
                folder = proc / str(pid); folder.mkdir(exist_ok=True); (folder / 'fd').mkdir(exist_ok=True)
                (folder / 'stat').write_text(f'{pid} (synthetic process) {kind} ' + '0 ' * 18 + f'{stamp} 0\n')
                starts[pid] = stamp
            for pid, kind in rows or []:
                state(pid, kind); links[str(proc / str(pid) / 'exe')] = str(engine / ('unknown' if unknown_exe else 'camoufox'))
            original_readlink = os.readlink
            def readlink(path):
                name = str(path)
                if name.endswith('/ns/pid'): return 'pid:[42]'
                if inaccessible and name.startswith(str(proc) + '/') and '/self/' not in name: raise PermissionError('PRIVATE RAW ERROR')
                if name in links: return links[name]
                return original_readlink(path)
            def pidfd_open(pid, flags):
                self.assertEqual(flags, 0)
                if changed_on_open: state(pid, 'S', starts[pid] + 1)
                fd = 1000 + len(fd_to_pid); fd_to_pid[fd] = pid
                return fd
            def poller():
                observed = []
                def register(fd, events):
                    self.assertEqual(events, select.POLLIN); observed.append(fd)
                def poll(timeout):
                    self.assertEqual(timeout, 0)
                    return [(fd + exit_fd_delta, exit_mask) for fd in observed] if exit_ready else []
                return SimpleNamespace(register=register, poll=poll)
            def send(fd, sig, info, flags):
                self.assertEqual((sig, info, flags), (signal.SIGTERM, None, 0))
                pid = fd_to_pid[fd]; signals.append(pid)
                if outcome == 'exit': shutil.rmtree(proc / str(pid))
                elif outcome == 'zombie': state(pid, 'Z', starts[pid])
            original_stat = Path.stat
            def owned_stat(path, *args, **kwargs):
                value = original_stat(path, *args, **kwargs)
                values = {name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
                values['st_uid'] = 0
                return SimpleNamespace(**values)
            stack.enter_context(patch.object(Path, 'stat', autospec=True, side_effect=owned_stat))
            stack.enter_context(patch.object(os, 'readlink', side_effect=readlink))
            stack.enter_context(patch.object(os, 'geteuid', return_value=uid))
            stack.enter_context(patch.object(os, 'getegid', return_value=gid))
            stack.enter_context(patch.object(os, 'getpid', return_value=900))
            stack.enter_context(patch.object(os, 'pidfd_open', side_effect=pidfd_open, create=True))
            stack.enter_context(patch.object(select, 'poll', side_effect=poller, create=True))
            stack.enter_context(patch.object(signal, 'pidfd_send_signal', side_effect=send, create=True))
            stack.enter_context(patch.object(os, 'close'))
            stack.enter_context(patch('time.sleep'))
            stack.enter_context(patch('time.monotonic', side_effect=[n / 2 for n in range(200)]))
            def execute(recover):
                source = registration.NATIVE_HANDOFF_SOURCE.replace('__RECOVER__', repr(recover)).replace(
                    '__MODULE_SHA__', repr(hashlib.sha256(module.read_bytes()).hexdigest()))
                source = source.replace("Path('/proc')", f'Path({str(proc)!r})').replace(
                    "Path('/opt/camoufox')", f'Path({str(engine)!r})').replace(
                    "Path('/app/fingerprint_runtime.py')", f'Path({str(module)!r})')
                output = io.StringIO()
                with redirect_stdout(output): exec(compile(source, '<actual-native-handoff>', 'exec'), {})
                result = json.loads(output.getvalue())
                self.assertNotIn('PRIVATE', output.getvalue())
                self.assertNotIn(str(base), output.getvalue())
                return result
            yield SimpleNamespace(execute=execute, signals=signals, state=state, links=links, proc=proc)

    def test_actual_generated_observer_counts_live_native_without_signals(self):
        with self.fixture([(7, 'S')]) as f:
            result = f.execute(False)
            self.assertEqual((result['status'], result['nativeCount'], result['signalsAttempted']), ('OBSERVED', 1, 0))
            self.assertEqual(f.signals, [])

    def test_wrong_uid_or_gid_is_rejected_before_proc_observation_or_signals(self):
        for uid, gid in ((0, 0), (10001, 0), (0, 10001)):
            with self.subTest(uid=uid, gid=gid), self.fixture([(7, 'S')], uid=uid, gid=gid) as f:
                result = f.execute(True)
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_OWNER_CHANGED')
                self.assertFalse(result['nativeCountObserved']); self.assertEqual(f.signals, [])

    def test_emulated_self_executable_is_rejected_before_inventory_or_signals(self):
        for recover in (False, True):
            with self.subTest(recover=recover), self.fixture([(7, 'S')]) as f:
                emulator = f.proc / 'rosetta'; emulator.write_bytes(b'synthetic emulator')
                f.links[str(f.proc / 'self' / 'exe')] = str(emulator)
                result = f.execute(recover)
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_EXECUTION_EMULATED')
                self.assertFalse(result['nativeCountObserved']); self.assertFalse(result['resourceClosed'])
                self.assertEqual(result['zeroObservations'], 0); self.assertEqual(f.signals, [])

    def test_matching_self_executable_does_not_hide_rosetta_browser_process(self):
        for recover in (False, True):
            with self.subTest(recover=recover), self.fixture([(7, 'S')]) as f:
                f.links[str(f.proc / '7' / 'exe')] = '/run/rosetta/rosetta'
                result = f.execute(recover)
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_EXECUTION_EMULATED')
                self.assertFalse(result['nativeCountObserved']); self.assertFalse(result['resourceClosed'])
                self.assertEqual(f.signals, [])

    def test_actual_generated_recovery_uses_pidfd_single_term_and_two_zero_observations(self):
        with self.fixture([(7, 'S'), (8, 'R')]) as f:
            result = f.execute(True)
            self.assertEqual((result['status'], result['signalsAttempted'], result['zeroObservations']), ('RECOVERED', 2, 2))
            self.assertTrue(result['resourceClosed']); self.assertEqual(f.signals, [7, 8])

    def test_no_native_means_no_signal(self):
        with self.fixture() as f:
            result = f.execute(True)
            self.assertEqual((result['signalsAttempted'], result['nativeCount'], result['zeroObservations']), (0, 0, 2))

    def test_pid_reuse_after_pidfd_open_refuses_all_signals(self):
        with self.fixture([(7, 'S')], changed_on_open=True) as f:
            result = f.execute(True)
            self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_PID_REUSED')
            self.assertEqual(f.signals, [])

    def test_pid_one_and_self_are_never_signalled(self):
        for pid in (1, 900):
            with self.subTest(pid=pid), self.fixture([(pid, 'S')]) as f:
                result = f.execute(True)
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_PID_OWNER')
                self.assertEqual(f.signals, [])

    def test_native_remaining_never_becomes_closed(self):
        with self.fixture([(7, 'S')], outcome='remain') as f:
            result = f.execute(True)
            self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_REMAINS')
            self.assertEqual(result['signalsAttempted'], 1); self.assertFalse(result['resourceClosed'])

    def test_zombie_or_dead_with_pidfd_exit_and_stable_namespace_is_inactive(self):
        for kind in ('Z', 'X'):
            with self.subTest(kind=kind), self.fixture([(7, kind)], inaccessible=True) as f:
                result = f.execute(True)
                self.assertEqual((result['status'], result['signalsAttempted']), ('RECOVERED', 0))

    def test_term_to_zombie_proves_no_executing_resource_without_kill(self):
        with self.fixture([(7, 'S')], outcome='zombie') as f:
            result = f.execute(True)
            self.assertEqual((result['status'], result['signalsAttempted'], result['zeroObservations']), ('RECOVERED', 1, 2))

    def test_live_permission_error_is_not_a_zero_observation(self):
        with self.fixture([(7, 'S')], inaccessible=True) as f:
            result = f.execute(True)
            self.assertEqual(result['status'], 'FAILED'); self.assertFalse(result['nativeCountObserved'])
            self.assertEqual(f.signals, [])

    def test_deleted_or_unknown_kernel_executable_is_rejected(self):
        for deleted in (False, True):
            with self.subTest(deleted=deleted), self.fixture([(7, 'S')], unknown_exe=not deleted) as f:
                if deleted: f.links[str(f.proc / '7' / 'exe')] += ' (deleted)'
                result = f.execute(True)
                self.assertEqual(result['status'], 'FAILED'); self.assertEqual(f.signals, [])

    def test_exited_zombie_with_unreadable_fd_directory_uses_pidfd_proof(self):
        with self.fixture([(7, 'Z')]) as f:
            original_iterdir = Path.iterdir
            def iterdir(path):
                if path.name == 'fd': raise PermissionError('PRIVATE RAW ERROR')
                return original_iterdir(path)
            with patch.object(Path, 'iterdir', iterdir): result = f.execute(True)
            self.assertEqual(result['status'], 'RECOVERED'); self.assertTrue(result['resourceClosed'])
            self.assertEqual(f.signals, [])

    def test_zombie_pidfd_not_ready_is_not_a_zero_observation(self):
        with self.fixture([(7, 'Z')], exit_ready=False) as f:
            result = f.execute(True)
            self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_PROC_READ')
            self.assertFalse(result['nativeCountObserved']); self.assertEqual(f.signals, [])

    def test_zombie_pid_reuse_after_pidfd_open_refuses_exit_proof(self):
        with self.fixture([(7, 'Z')], changed_on_open=True) as f:
            result = f.execute(True)
            self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_PID_REUSED')
            self.assertFalse(result['nativeCountObserved']); self.assertEqual(f.signals, [])

    def test_unavailable_pidfd_support_cannot_prove_zombie_exit(self):
        for error in (OSError(38, 'PRIVATE RAW ERROR'), PermissionError(1, 'PRIVATE RAW ERROR'), AttributeError('PRIVATE RAW ERROR')):
            with self.subTest(error=type(error).__name__), self.fixture([(7, 'Z')]) as f:
                with patch.object(os, 'pidfd_open', side_effect=error, create=True): result = f.execute(True)
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
                self.assertFalse(result['nativeCountObserved']); self.assertFalse(result['resourceClosed'])
                self.assertEqual(f.signals, [])

    def test_pidfd_exit_requires_pollin_without_error_or_invalid_fd(self):
        for mask, fd_delta in ((0, 0), (select.POLLHUP, 0), (select.POLLIN | select.POLLERR, 0),
                               (select.POLLIN | select.POLLNVAL, 0), (select.POLLIN, 1)):
            with self.subTest(mask=mask, fd_delta=fd_delta), self.fixture([(7, 'Z')], exit_mask=mask, exit_fd_delta=fd_delta) as f:
                result = f.execute(True)
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_NATIVE_PROC_READ')
                self.assertFalse(result['nativeCountObserved']); self.assertFalse(result['resourceClosed'])
                self.assertEqual(f.signals, [])


class RegistrationRecoveryTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, retained=True):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); directory = base / 'releases' / 'original'; directory.mkdir(parents=True)
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            stack.enter_context(patch.object(registration, 'REGISTRATION_DIRECTORY', str(directory)))
            folder = registration.handoff_directory(controller); folder.mkdir(mode=0o700, parents=True)
            def put(name, value):
                path = folder / name
                if path.exists(): path.chmod(0o600)
                path.write_text(json.dumps(value)); path.chmod(0o400); return path
            put('attempt.json', {'taskId': registration.TASK_ID, 'attempt': 10, 'privatePostBudget': 1})
            put('failure.json', registration.HANDOFF_FAILURE)
            bad_owner = []; original_lstat = Path.lstat
            def owned_lstat(path, *args, **kwargs):
                value = original_lstat(path, *args, **kwargs)
                values = {name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
                if path.is_relative_to(base): values['st_uid'] = 501 if path.name in bad_owner else 0
                return SimpleNamespace(**values)
            stack.enter_context(patch.object(Path, 'lstat', autospec=True, side_effect=owned_lstat))
            all_states = states()
            for index, row in enumerate(all_states.values(), 1): row['containerId'] = str(index) * 64
            stack.enter_context(patch.object(registration, 'REGISTRATION_STATES_SHA', registration.fingerprint(all_states)))
            manifest = {'commit': registration.REGISTRATION_CURRENT}
            evidence = {'manifestSha256': '1' * 64, 'environmentSha256': '2' * 64, 'apiSource': {'sha256': '3' * 64}}
            base_read = stack.enter_context(patch.object(registration, 'baseline', return_value=(directory, manifest, all_states, evidence)))
            stack.enter_context(patch.object(registration, 'configuration_hashes', return_value={'config': '4' * 64}))
            task_read = stack.enter_context(patch.object(registration, 'registration_task', return_value=registration_task()))
            original_idle = registration.jobs_idle
            idle = stack.enter_context(patch.object(registration, 'jobs_idle', return_value={
                'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False, 'registrationWindowRetained': retained}))
            private_calls = []
            def private(*args, **kwargs):
                self.assertFalse(kwargs.get('close', False)); private_calls.append(kwargs)
                return {'confirmed': True, 'privatePostAttempted': False, 'cancelled': not retained,
                        'retained': retained, 'busy': False, 'attempt': 10}
            stack.enter_context(patch.object(registration, 'registration_private', side_effect=private))
            def audit(_d, _directory, path):
                path.write_text(json.dumps({'ok': True, 'checkCount': 49, 'violationCount': 0,
                    'checks': [{'code': f'C{n}', 'count': 0} for n in range(49)]})); path.chmod(0o600)
                return registration.audit_receipt(_d, path)
            audit_read = stack.enter_context(patch.object(registration, 'strict_audit', side_effect=audit))
            recovered = []; native_calls = []
            def native(*args, **kwargs):
                active = kwargs.get('recover', False); native_calls.append(active)
                if active: recovered.append(True)
                count = 0 if recovered or not retained else 1
                return {'status': 'RECOVERED' if active else 'OBSERVED', 'nativeCount': count,
                    'nativeCountObserved': True, 'signalsAttempted': 1 if active else 0,
                    'zeroObservations': 2 if not count else 0, 'resourceClosed': not count, 'readOnly': not active, 'code': 'none'}
            native_read = stack.enter_context(patch.object(registration, 'native_handoff', side_effect=native))
            controller.service_state = MagicMock(return_value=all_states['auto-registration'])
            controller.assert_no_active_recharge = MagicMock()
            controller.registration_runtime_state = MagicMock(return_value={'supported': True,
                'registrationBusy': False, 'registrationWindowRetained': retained})
            controller.current_job_database = MagicMock(return_value='database')
            controller.compose = MagicMock(return_value='0')
            yield SimpleNamespace(controller=controller, directory=directory, folder=folder, put=put,
                bad_owner=bad_owner, states=all_states, evidence=evidence, baseline=base_read, task=task_read,
                idle=idle, original_idle=original_idle, private_calls=private_calls, native=native_read,
                native_calls=native_calls, recovered=recovered, audit=audit_read)

    def test_observe_is_readonly_and_preserves_original_failure(self):
        with self.fixture() as f:
            first = (f.folder / 'failure.json').read_bytes()
            result = registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT)
            self.assertEqual(result['status'], 'API_REGISTRATION_HANDOFF_OBSERVED')
            self.assertEqual(result['native']['nativeCount'], 1); self.assertTrue(result['readOnly'])
            self.assertEqual(f.native_calls, [False, False]); self.assertFalse((f.folder / 'recovery-attempt.json').exists())
            self.assertEqual(first, (f.folder / 'failure.json').read_bytes())

    def test_recover_records_honest_memory_retention_and_consumes_single_pass(self):
        with self.fixture() as f:
            first = (f.folder / 'failure.json').read_bytes()
            result = registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            record = registration.handoff_json(f.controller, f.folder, 'confirmed.json')
            self.assertEqual(record['version'], 2); self.assertFalse(record['privateCancelConfirmed'])
            self.assertTrue(record['privateMemoryRetained']); self.assertTrue(record['resourceClosed'])
            self.assertEqual(result['signalsAttempted'], 1); self.assertEqual(sum(f.native_calls), 1)
            self.assertEqual(first, (f.folder / 'failure.json').read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_CONFIRMED'):
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            self.assertEqual(sum(f.native_calls), 1)
            with patch.object(registration, 'jobs_idle', f.original_idle):
                guards = registration.jobs_idle(f.controller, f.directory)
            self.assertTrue(guards['registrationWindowRetained']); self.assertTrue(guards['registrationResourceClosed'])

    def test_already_closed_reconciliation_never_signals(self):
        with self.fixture(retained=False) as f:
            result = registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            record = registration.handoff_json(f.controller, f.folder, 'confirmed.json')
            self.assertEqual(record, registration.ordinary_handoff_record(registration_task()))
            self.assertFalse(result['privateCancelPerformed']); self.assertEqual(result['signalsAttempted'], 0)
            self.assertFalse(any(f.native_calls))

    def test_closed_get_with_remaining_native_cannot_reconcile_or_signal(self):
        with self.fixture(retained=False) as f:
            f.native.return_value = {'resourceClosed': False}; f.native.side_effect = None
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_REMAINS'):
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            self.assertFalse((f.folder / 'recovery-attempt.json').exists()); self.assertFalse(any(f.native_calls))

    def test_unknown_failure_and_boolean_budget_are_rejected_before_actions(self):
        for change in ('reason', 'status', 'budget'):
            with self.subTest(change=change), self.fixture() as f:
                if change == 'budget': f.put('attempt.json', {'taskId': registration.TASK_ID, 'attempt': 10, 'privatePostBudget': True})
                else: f.put('failure.json', {**registration.HANDOFF_FAILURE,
                    'controlledReason' if change == 'reason' else 'privatePostHttpStatus': 'none' if change == 'reason' else 500})
                with self.assertRaisesRegex(RuntimeError, 'FAILURE_CHANGED'):
                    registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
                f.baseline.assert_not_called(); f.native.assert_not_called()

    def test_nonowner_failure_and_active_job_are_rejected_without_marker(self):
        for cause in ('owner', 'active'):
            with self.subTest(cause=cause), self.fixture() as f:
                if cause == 'owner': f.bad_owner.append('failure.json')
                else: f.idle.side_effect = RuntimeError('API_ADMIN_REGISTRATION_BUSY')
                with self.assertRaises(RuntimeError):
                    registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
                self.assertFalse((f.folder / 'recovery-attempt.json').exists()); f.native.assert_not_called()

    def test_pid_failure_is_persisted_without_overwriting_original_first_cause(self):
        with self.fixture() as f:
            first = (f.folder / 'failure.json').read_bytes(); initial = f.native.side_effect
            diagnostic = {'confirmed': False, 'signalsAttempted': 0, 'nativeCount': 1,
                          'nativeCountObserved': True, 'rawOutputSuppressed': True}
            def native(*args, **kwargs):
                if kwargs.get('recover'): raise registration.RegistrationRecoveryError('API_ADMIN_REGISTRATION_NATIVE_PID_REUSED', diagnostic)
                return initial(*args, **kwargs)
            f.native.side_effect = native
            with self.assertRaisesRegex(RuntimeError, 'PID_REUSED'):
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            self.assertEqual(registration.handoff_json(f.controller, f.folder, 'recovery-failure.json'), diagnostic)
            self.assertEqual(first, (f.folder / 'failure.json').read_bytes()); self.assertFalse((f.folder / 'confirmed.json').exists())
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_ATTEMPTED'):
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)

    def test_later_database_drift_preserves_actual_signal_count(self):
        with self.fixture() as f:
            f.task.side_effect = [registration_task(), {**registration_task(), 'jobHmac': '9' * 64}]
            with self.assertRaisesRegex(RuntimeError, 'RECOVERY_MOVED'):
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            diagnostic = registration.handoff_json(f.controller, f.folder, 'recovery-failure.json')
            self.assertEqual(diagnostic['signalsAttempted'], 1); self.assertFalse((f.folder / 'confirmed.json').exists())

    def test_transport_unknown_after_recovery_start_is_not_forged_zero(self):
        with self.fixture() as f:
            initial = f.native.side_effect
            def native(*args, **kwargs):
                if kwargs.get('recover'): raise RuntimeError('API_ADMIN_TRANSPORT_FAILED')
                return initial(*args, **kwargs)
            f.native.side_effect = native
            with self.assertRaisesRegex(RuntimeError, 'TRANSPORT_FAILED'):
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            self.assertIsNone(registration.handoff_json(f.controller, f.folder, 'recovery-failure.json')['signalsAttempted'])

    def test_later_readonly_native_failure_does_not_erase_previous_signals(self):
        with self.fixture() as f:
            initial = f.native.side_effect
            def native(*args, **kwargs):
                if f.recovered and not kwargs.get('recover'):
                    raise registration.RegistrationRecoveryError('API_ADMIN_REGISTRATION_NATIVE_PROC_READ', {
                        'confirmed': False, 'signalsAttempted': 0, 'nativeCount': 0,
                        'nativeCountObserved': False, 'rawOutputSuppressed': True})
                return initial(*args, **kwargs)
            f.native.side_effect = native
            with self.assertRaises(registration.RegistrationRecoveryError) as caught:
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
            self.assertEqual(caught.exception.diagnostic['signalsAttempted'], 1)
            self.assertEqual(registration.handoff_json(f.controller, f.folder, 'recovery-failure.json')['signalsAttempted'], 1)
            self.assertFalse((f.folder / 'confirmed.json').exists())

    def test_cli_emits_recovery_diagnostic_after_later_failure(self):
        with self.fixture() as f:
            f.task.side_effect = [registration_task(), {**registration_task(), 'jobHmac': '9' * 64}]
            output = io.StringIO()
            with redirect_stdout(output):
                code = registration.registration_cli(f.controller, ['--api-registration-handoff-recover',
                    '--expected-current', registration.REGISTRATION_CURRENT])
            value = json.loads(output.getvalue())
            self.assertEqual(code, 1)
            self.assertEqual(value['errorType'], 'RegistrationRecoveryError')
            self.assertEqual(value['recoveryDiagnostic']['signalsAttempted'], 1)
            self.assertEqual(value['code'], 'API_ADMIN_REGISTRATION_RECOVERY_MOVED')

    def test_native_record_rejects_failed_recovery_and_bool_marker(self):
        for change in ('failure', 'pass', 'post'):
            with self.subTest(change=change), self.fixture() as f:
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
                record = registration.handoff_json(f.controller, f.folder, 'confirmed.json')
                if change == 'failure': f.put('recovery-failure.json', {'confirmed': False})
                else:
                    marker = registration.handoff_json(f.controller, f.folder, 'recovery-attempt.json')
                    marker['signalPassBudget' if change == 'pass' else 'privatePostBudget'] = True if change == 'pass' else False
                    f.put('recovery-attempt.json', marker); record['recoveryAttemptSha256'] = registration.fingerprint(marker)
                with self.assertRaises(RuntimeError): registration.require_native_handoff(f.controller, f.directory, record)

    def test_new_native_or_container_replacement_invalidates_recovery_confirmation(self):
        for change in ('native', 'container'):
            with self.subTest(change=change), self.fixture() as f:
                registration.registration_handoff_recovery(f.controller, registration.REGISTRATION_CURRENT, recover=True)
                record = registration.handoff_json(f.controller, f.folder, 'confirmed.json')
                if change == 'native': f.recovered.clear()
                else: f.controller.service_state.return_value = {**f.states['auto-registration'], 'containerId': 'f' * 64}
                with self.assertRaises(RuntimeError): registration.require_native_handoff(f.controller, f.directory, record)

    def test_recovery_failure_transport_accepts_only_closed_typed_diagnostic(self):
        diagnostic = {'confirmed': False, 'signalsAttempted': 1, 'nativeCount': 0,
                      'nativeCountObserved': True, 'rawOutputSuppressed': True}
        receipt = {'status': 'API_REGISTRATION_VERIFICATION_FAILED', 'code': 'API_ADMIN_REGISTRATION_NATIVE_REMAINS',
                   'errorType': 'RegistrationRecoveryError', 'recoveryDiagnostic': diagnostic}
        self.assertEqual(transport.safe_failure(receipt, 'API_REGISTRATION')['recoveryDiagnostic'], diagnostic)
        for changed in ({'rawError': 'PRIVATE RAW'}, {'nativeCount': -1}, {'nativeCount': True},
                        {'signalsAttempted': True}, {'signalsAttempted': -1}, {'nativeCountObserved': 1}):
            value = transport.safe_failure({**receipt, 'recoveryDiagnostic': {**diagnostic, **changed}}, 'API_REGISTRATION')
            self.assertNotIn('recoveryDiagnostic', value)
        unknown = {**diagnostic, 'signalsAttempted': None, 'nativeCountObserved': False}
        self.assertEqual(transport.safe_failure({**receipt, 'recoveryDiagnostic': unknown}, 'API_REGISTRATION')['recoveryDiagnostic'], unknown)


def migration_fixture(directory, *, old=False):
    for name, digest in migration.migration_files(d, LEGACY_PRISMA_ROOT).items():
        if old and name == migration.MIGRATION_FILE:
            continue
        target = directory / migration.MIGRATION_ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((LEGACY_PRISMA_ROOT / migration.MIGRATION_ROOT / name).read_bytes())
    schema = directory / migration.MIGRATION_SCHEMA
    schema.parent.mkdir(parents=True, exist_ok=True)
    raw = (subprocess.check_output(['git', 'show', migration.REGISTRATION_CURRENT + ':' + migration.MIGRATION_SCHEMA], cwd=ROOT)
           if old else (LEGACY_PRISMA_ROOT / migration.MIGRATION_SCHEMA).read_bytes())
    schema.write_bytes(raw)
    (directory / migration.MIGRATION_SEED).write_bytes((LEGACY_PRISMA_ROOT / migration.MIGRATION_SEED).read_bytes())


def docker_prisma_content(directory):
    # Model the actual whole-directory Docker COPY, independently of the attestation allowlist.
    root = directory / 'apps/api/prisma-mysql'
    return '\n'.join(sorted(hashlib.sha256(path.read_bytes()).hexdigest() + '  /app/'
        + path.relative_to(directory).as_posix() for path in root.rglob('*') if path.is_file()))


def migration_database_fixture(*, applied=False):
    rows = [{'name': name.split('/')[0], 'checksum': digest, 'finished': 1, 'rolledBack': 0}
            for name, digest in migration.migration_files(d, LEGACY_PRISMA_ROOT).items()
            if name.endswith('/migration.sql') and (applied or name != migration.MIGRATION_FILE)]
    return {'rows': rows,
        'columns': [{'type': 'int', 'columnType': 'int', 'nullable': 'YES', 'default': None, 'extra': ''}] if applied else None,
        'indexes': [{'column': name, 'sequence': index, 'nonUnique': 1, 'type': 'BTREE', 'prefix': None}
                    for index, name in enumerate(('user_id', 'deleted_at', 'sort_order'), 1)] if applied else None}


def migration_proof():
    value = proof()
    value.update(scope='API_ADMIN_MIGRATION', migration=dict(migration.MIGRATION_IDENTITY))
    value['images']['migrate'] = {'reference': f'{REPOSITORY}:{COMMIT}-123-1-migrate',
        'imageId': 'sha256:' + '3' * 64, **migration.migration_content(d, LEGACY_PRISMA_ROOT)}
    return value


def migration_guards():
    return {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
            'registrationWindowRetained': True}


class MigrationScopeTests(unittest.TestCase):
    def test_migration_task_matches_only_captured_attempt12_and_old_namespaces_keep_attempt10(self):
        self.assertEqual(migration.TASK_ATTEMPT, 12)
        self.assertEqual((registration.TASK_ATTEMPT, scope.TASK_ATTEMPT), (10, 10))
        value = migration_task()
        controller = SimpleNamespace(require=d.require, compose=MagicMock(return_value=json.dumps(value)))
        self.assertEqual(migration.registration_task(controller, LEGACY_PRISMA_ROOT), value)
        code = controller.compose.call_args.args[-1]
        self.assertIn('attempt=12', code)
        self.assertIn('const migration=true', code)
        self.assertIn('2026-10-08T14:18:32.726Z', code)
        self.assertIn('api-registration-handoff:', code)
        self.assertIn("createdAt:{gte:new Date('2026-10-08T02:14:14.768Z')}", code)
        for key, changed in (('attempt', 10), ('attempt', 13), ('attempt', 12.0), ('state', 'running'),
                ('step', 'mfa'), ('reason', 'session_network_error'), ('updatedAt', '2026-10-08T14:18:32.727Z'),
                ('auditCount', 6), ('auditCount', 5.0), ('auditCount', True),
                *((name, '0' * 64) for name in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac'))):
            controller.compose.return_value = json.dumps({**value, key: changed})
            with self.subTest(key=key, changed=changed), self.assertRaises(RuntimeError):
                migration.registration_task(controller, LEGACY_PRISMA_ROOT)
        for key in value['binding']:
            changed = copy.deepcopy(value); changed['binding'][key] = '0' * 64
            controller.compose.return_value = json.dumps(changed)
            with self.subTest(binding=key), self.assertRaises(RuntimeError):
                migration.registration_task(controller, LEGACY_PRISMA_ROOT)
        controller.compose.return_value = json.dumps(registration_task())
        with self.assertRaises(RuntimeError): migration.registration_task(controller, LEGACY_PRISMA_ROOT)
        controller.compose.return_value = json.dumps(value)
        with self.assertRaises(RuntimeError): registration.registration_task(controller, ROOT)

    def generated_task_controller(self, selected_scope, changes=None):
        captured = migration_task()
        cfg = {'migration': selected_scope.MIGRATION_MODE, 'taskId': selected_scope.TASK_ID,
            'attempt': selected_scope.TASK_ATTEMPT, 'state': 'partial', 'step': 'password',
            'reason': 'session_load_timeout' if selected_scope.MIGRATION_MODE else 'session_network_error',
            'updatedAt': '2026-10-08T14:18:32.726Z' if selected_scope.MIGRATION_MODE else '2026-10-08T02:15:59.029Z',
            'auditCount': 5 if selected_scope.MIGRATION_MODE else 2, 'binding': selected_scope.TASK_BINDING,
            'accountId': 'fixture-account', 'profileId': 'fixture-profile', 'ownerId': 'fixture-owner',
            'hmac': {name: captured[name] for name in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac')}}
        cfg.update(changes or {})
        # Run the real generated query against a deterministic in-memory Prisma substitute.
        prelude = r'''const cfg=__CONFIG__;
const need=x=>{if(!x)throw Error('fixture query contract');};let macCount=0,reads=0;
const job={id:cfg.taskId,attempt:cfg.attempt,state:cfg.state,step:cfg.step,reason:cfg.reason,
 registered:1,password_verified:0,mfa_verified:0,nonce_hash:null,lease_until:null,
 updated_at:new Date(cfg.updatedAt),password_encrypted:'SYNTHETIC_CANDIDATE',email_hash:'fixture-email-hash',
 account_id:cfg.accountId,browser_profile_id:cfg.profileId,owner_id:cfg.ownerId};
const account={id:'fixture-account',registered:1,deleted_at:null,password_encrypted:null,totp_secret_encrypted:null};
const audits=Array.from({length:cfg.auditCount},(_,i)=>({id:'fixture-audit-'+i,
 action:i===0?'id_business_v2.auto_registration.launch':'id_business_v2.auto_registration.profile_rebound',
 afterData:{attempt:cfg.attempt,browserProfileId:'fixture-profile',accountId:'fixture-account'},
 createdAt:new Date(i===0?'2026-10-08T02:14:16.979Z':'2026-10-08T02:14:39.680Z')}));
class PrismaClient{
 constructor(){this.auditLog={findMany:async options=>{
  need(options.where.module==='id_business_v2'&&options.where.objectType==='registration_job'
   &&options.where.objectId===cfg.taskId&&options.where.createdAt.gte.toISOString()==='2026-10-08T02:14:14.768Z'
   &&JSON.stringify(options.where.action.in)===JSON.stringify(['id_business_v2.auto_registration.launch','id_business_v2.auto_registration.profile_rebound','id_business_v2.auto_registration.cancel'])
   &&JSON.stringify(options.orderBy)===JSON.stringify([{createdAt:'asc'},{id:'asc'}])&&options.take===1001);
  return audits;}};}
 async $queryRaw(parts,...values){const sql=parts.join('?');need(sql.startsWith('SELECT * FROM '));reads++;
  if(sql.includes('id_business_v2_registration_jobs')){need(values[0]===cfg.taskId);return [job];}
  need(sql.includes('id_business_v2_chatgpt_accounts')&&values[0]===job.email_hash);return [account];}
 async $transaction(callback,options){need(options.isolationLevel==='RepeatableRead'&&options.timeout===25000);return callback(this);}
 async $disconnect(){need(reads===4||reads<4);}
}
const crypto={createHash:()=>({update(value){this.value=value;return this;},digest(){return {
 'fixture-account':cfg.binding.accountSha256,'fixture-profile':cfg.binding.profileSha256,
 'fixture-owner':cfg.binding.ownerSha256}[this.value]||'0'.repeat(64);}}),
 createHmac:()=>({parts:[],update(value){this.parts.push(value);return this;},digest(){
  need(this.parts[0]==='api-registration-handoff:'&&this.parts.length===2);
  return cfg.hmac[['emailHashHmac','jobHmac','accountHmac','auditHmac'][macCount++%4]];}})};
const fakeRequire=name=>{need(name==='@prisma/client'||name==='node:crypto');return name==='@prisma/client'?{PrismaClient}:crypto;};
new Function('require','process',__SOURCE__)(fakeRequire,{env:{AUTO_RECHARGE_WORKER_TOKEN:'LOCAL_TEST_VALUE_'.repeat(4)}});
'''
        def compose(*args, **kwargs):
            script = prelude.replace('__CONFIG__', json.dumps(cfg)).replace('__SOURCE__', json.dumps(args[-1]))
            result = subprocess.run(['node'], input=script, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        return SimpleNamespace(require=d.require, compose=compose)

    def test_generated_attempt12_query_rejects_state_reason_date_audit_count_and_binding_drift(self):
        self.assertEqual(migration.registration_task(self.generated_task_controller(migration), LEGACY_PRISMA_ROOT), migration_task())
        for changes in ({'attempt': 10}, {'attempt': 13}, {'state': 'completed'}, {'step': 'mfa'},
                        {'reason': 'session_network_error'}, {'updatedAt': '2026-10-08T14:18:32.727Z'},
                        {'auditCount': 4}, {'accountId': 'changed'}, {'profileId': 'changed'}, {'ownerId': 'changed'}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                migration.registration_task(self.generated_task_controller(migration, changes), LEGACY_PRISMA_ROOT)

    def test_generated_registration_attempt10_keeps_old_dates_reason_and_launch_rebound_checks(self):
        value = registration.registration_task(self.generated_task_controller(registration), ROOT)
        self.assertEqual(value['attempt'], 10)
        self.assertEqual(set(value), set(registration_task()))
        for changes in ({'attempt': 12}, {'reason': 'session_load_timeout'},
                        {'updatedAt': '2026-10-08T14:18:32.726Z'}, {'auditCount': 5}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                registration.registration_task(self.generated_task_controller(registration, changes), ROOT)

    def test_migration_private_attempt12_is_get_only_and_cannot_close_or_accept_another_attempt(self):
        controller, calls = RegistrationScopeTests().execute_private(close=False, attempt=12)
        value = migration.registration_private(controller, LEGACY_PRISMA_ROOT)
        self.assertEqual(value['attempt'], 12)
        self.assertFalse(value['privatePostAttempted'])
        self.assertTrue(value['retained'])
        self.assertEqual([row[0] for row in calls], ['GET', 'GET'])
        for attempt in (10, 13):
            controller, calls = RegistrationScopeTests().execute_private(close=False, attempt=attempt)
            with self.subTest(attempt=attempt), self.assertRaises(migration.RegistrationHandoffError):
                migration.registration_private(controller, LEGACY_PRISMA_ROOT)
            self.assertEqual([row[0] for row in calls], ['GET'])
        controller = SimpleNamespace(require=d.require, compose=MagicMock())
        for kwargs in ({'close': True}, {'retained': False}):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_SCOPE_CONFLICT$'):
                migration.registration_private(controller, LEGACY_PRISMA_ROOT, **kwargs)
        controller.compose.assert_not_called()

    def test_migration_task_guard_requires_the_observed_retained_window_even_when_new_snapshot_is_quiet(self):
        with patch.object(migration, 'jobs_idle', return_value={**migration_guards(), 'registrationWindowRetained': False}), \
             patch.object(migration, 'registration_task', return_value=migration_task()), \
             patch.object(migration, 'registration_private') as private:
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_REGISTRATION_TASK_CHANGED$'):
                migration.migration_task_guard(d, LEGACY_PRISMA_ROOT, migration_task(), {**migration_guards(), 'registrationWindowRetained': False})
            private.assert_not_called()

    def test_independent_migration_preflight_requires_the_complete_captured_task_not_only_attempt12(self):
        with self.registration_baseline_fixture() as (controller, current, before, native, idle, stack, *_):
            stack.enter_context(patch.object(migration, 'registration_private'))
            stack.enter_context(patch.object(migration, 'strict_audit', return_value={
                'mode': 'STRICT_ZERO_49', 'checkCount': 49, 'violationCount': 0, 'checksSha256': '5' * 64}))
            result = migration.migration_preflight(controller, COMMIT)
            transport.validate_receipt(result, COMMIT, 'preflight', 'API_ADMIN_MIGRATION')
            for field in migration.MIGRATION_TASK:
                changed = copy.deepcopy(result)
                changed['task'].pop(field)
                with self.subTest(missing=field), self.assertRaisesRegex(RuntimeError, 'MIGRATION_PREFLIGHT_CHANGED'):
                    transport.validate_receipt(changed, COMMIT, 'preflight', 'API_ADMIN_MIGRATION')
            for field, value in (('attempt', 10), ('attempt', 13), ('state', 'running'), ('step', 'mfa'),
                    ('reason', 'session_network_error'), ('updatedAt', '2026-10-08T14:18:32.727Z'), ('auditCount', 6), ('auditCount', 5.0),
                    *((name, '0' * 64) for name in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac'))):
                changed = copy.deepcopy(result); changed['task'][field] = value
                with self.subTest(field=field, value=value), self.assertRaisesRegex(RuntimeError, 'MIGRATION_PREFLIGHT_CHANGED'):
                    transport.validate_receipt(changed, COMMIT, 'preflight', 'API_ADMIN_MIGRATION')
            changed = copy.deepcopy(result); changed['guards']['registrationWindowRetained'] = False
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_PREFLIGHT_CHANGED'):
                transport.validate_receipt(changed, COMMIT, 'preflight', 'API_ADMIN_MIGRATION')

    def test_images_are_three_but_only_api_admin_are_switched(self):
        self.assertEqual(migration.UPDATED, ('api', 'admin'))
        self.assertEqual(migration.IMAGE_SERVICES, ('api', 'admin', 'migrate'))
        self.assertEqual(migration.SWITCH_ORDER, ('admin', 'api'))
        self.assertEqual(migration.PROOF_FILE, 'api-admin-migration-build-proof.json')
        self.assertFalse(migration.REGISTRATION)
        self.assertTrue(migration.MIGRATION_MODE)
        selected, _ = d.api_admin_scope('API_ADMIN_MIGRATION')
        self.assertEqual(selected.IMAGE_SERVICES, migration.IMAGE_SERVICES)

    def test_exact_source_checks_real_old_schema_and_all_46_original_files(self):
        self.assertEqual(migration.migration_source_check(d, LEGACY_PRISMA_ROOT), migration.MIGRATION_IDENTITY)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            directory = Path(temporary); migration_fixture(directory, old=True)
            self.assertEqual(migration.migration_source_check(d, directory, candidate=False), migration.MIGRATION_IDENTITY)
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
                migration.migration_source_check(d, directory)

    def test_additional_schema_sql_old_file_changes_and_missing_history_are_rejected(self):
        for change in ('schema', 'sql', 'history', 'missing', 'extra'):
            with self.subTest(change=change), tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                directory = Path(temporary); migration_fixture(directory)
                if change == 'schema': (directory / migration.MIGRATION_SCHEMA).write_text('other schema')
                elif change == 'sql': (directory / migration.MIGRATION_ROOT / migration.MIGRATION_FILE).write_text('ALTER TABLE other ADD COLUMN x INT;')
                elif change == 'extra':
                    path = directory / migration.MIGRATION_ROOT / '20261009000000_other/migration.sql'
                    path.parent.mkdir(); path.write_text('ALTER TABLE other ADD COLUMN x INT;')
                else:
                    path = next(path for path in (directory / migration.MIGRATION_ROOT).rglob('migration.sql') if migration.MIGRATION_NAME not in str(path))
                    if change == 'missing': path.unlink()
                    else: path.write_text('changed old migration')
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SCOPE_CHANGED'):
                    migration.migration_source_check(d, directory)

    def test_symlink_migration_sources_are_rejected(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            directory = Path(temporary); migration_fixture(directory)
            path = directory / migration.MIGRATION_ROOT / migration.MIGRATION_FILE
            path.unlink(); path.symlink_to(ROOT / migration.MIGRATION_ROOT / migration.MIGRATION_FILE)
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SOURCE_INVALID'):
                migration.migration_source_check(d, directory)

    def test_proof_requires_exact_mode_migration_and_all_three_images(self):
        candidate = migration_proof()
        migration.validate_proof(d, candidate, COMMIT, TREE, REPOSITORY, '123', '1')
        for change in ('scope', 'sql', 'missing-migrate', 'worker', 'run'):
            changed = copy.deepcopy(candidate)
            if change == 'scope': changed['scope'] = 'API_ADMIN'
            elif change == 'sql': changed['migration']['sha256'] = '0' * 64
            elif change == 'missing-migrate': del changed['images']['migrate']
            elif change == 'worker': changed['images']['auto-registration'] = {}
            else: changed['images']['migrate']['reference'] = changed['images']['migrate']['reference'].replace('-123-1-', '-123-2-')
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                migration.validate_proof(d, changed, COMMIT, TREE, REPOSITORY, '123', '1')
        with self.assertRaises(RuntimeError): scope.validate_proof(d, candidate, COMMIT, TREE)
        with self.assertRaises(RuntimeError): migration.validate_proof(d, proof(), COMMIT, TREE)

    def test_migrate_content_is_prisma_only_not_an_admin_or_worker_root(self):
        measured = migration.content_summary(d, 'migrate', docker_prisma_content(LEGACY_PRISMA_ROOT))
        self.assertEqual(measured['fileCount'], 49)
        self.assertEqual(measured['sha256'], '829ffff40a412bf2dd8dd46b22dcc02278f8323158fd8fdf104b1a5c307b974e')
        self.assertEqual(migration.migration_content(d, LEGACY_PRISMA_ROOT), measured)
        self.assertIn('/app/apps/api/prisma-mysql', migration.content_command('migrate'))
        for path in ('/app/apps/api/dist/main.js', '/app/server.py', '/usr/share/nginx/html/index.html'):
            with self.assertRaisesRegex(RuntimeError, 'CONTENT_INVALID'):
                migration.content_summary(d, 'migrate', '1' * 64 + '  ' + path)

    def test_migration_seed_missing_changed_or_symlink_is_rejected(self):
        for change in ('missing', 'changed', 'symlink'):
            with self.subTest(change=change), tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                directory = Path(temporary); migration_fixture(directory)
                seed = directory / migration.MIGRATION_SEED
                seed.unlink()
                if change == 'changed': seed.write_text('changed seed')
                elif change == 'symlink': seed.symlink_to(ROOT / migration.MIGRATION_SEED)
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_(SOURCE_INVALID|SCOPE_CHANGED)'):
                    migration.migration_content(d, directory)

    def test_build_proof_uses_complete_docker_copy_and_rejects_image_drift(self):
        content = docker_prisma_content(LEGACY_PRISMA_ROOT)
        variants = {'complete': content,
            'missing-seed': '\n'.join(line for line in content.splitlines() if not line.endswith('/seed.ts')),
            'changed-seed': '\n'.join('0' * 64 + line[64:] if line.endswith('/seed.ts') else line for line in content.splitlines()),
            'extra': content + '\n' + '0' * 64 + '  /app/apps/api/prisma-mysql/unexpected.ts'}
        for change, measured in variants.items():
            with self.subTest(change=change), tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, RELEASE_COMMIT=COMMIT, SOURCE_TREE=TREE,
                    RELEASE_REPOSITORY=REPOSITORY, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1'))
                stack.enter_context(patch.object(Path, 'cwd', return_value=LEGACY_PRISMA_ROOT))
                original = os.getcwd(); os.chdir(temporary)
                try:
                    def run(*args):
                        if args == ('git', 'rev-parse', 'HEAD'): return COMMIT
                        if args == ('git', 'rev-parse', 'HEAD^{tree}'): return TREE
                        service = next(name for name in migration.IMAGE_SERVICES if args[3 if args[1] == 'image' else 8].endswith('-' + name))
                        if args[1] == 'image':
                            return json.dumps([{'Id': 'sha256:' + '1' * 64, 'Architecture': 'amd64', 'Config': {'Labels': {
                                'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}])
                        return measured if service == 'migrate' else '1' * 64 + '  ' + (
                            '/app/apps/api/dist/main.js' if service == 'api' else '/usr/share/nginx/html/index.html')
                    controller = SimpleNamespace(require=d.require, run=run)
                    if change == 'complete':
                        with redirect_stdout(io.StringIO()): migration.build_proof(controller)
                        value = json.loads((Path(temporary) / '.deploy/production-release' / migration.PROOF_FILE).read_text())
                        self.assertEqual(value['images']['migrate']['fileCount'], 49)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_IMAGE_CONTENT_CHANGED'):
                            migration.build_proof(controller)
                        self.assertFalse((Path(temporary) / '.deploy/production-release' / migration.PROOF_FILE).exists())
                finally:
                    os.chdir(original)

    def database_controller(self, value):
        return SimpleNamespace(require=d.require, current_job_database=MagicMock(return_value='fixture_db'),
            compose=MagicMock(return_value=json.dumps(value)))

    def test_database_verifies_pending_and_applied_checksum_column_and_index(self):
        for applied in (False, True):
            controller = self.database_controller(migration_database_fixture(applied=applied))
            state = migration.migration_database_state(controller, LEGACY_PRISMA_ROOT)
            self.assertEqual(state['status'], 'APPLIED' if applied else 'PENDING')
            self.assertTrue(state['schemaVerified'])
            self.assertEqual(state['sha256'], migration.MIGRATION_IDENTITY['sha256'])
            query = controller.compose.call_args.args[-1]
            self.assertIn('MYSQL_DATABASE=fixture_db', controller.compose.call_args.args)
            self.assertIn('information_schema.STATISTICS', query)
            self.assertNotIn('UPDATE ', query)

    def test_native_boolean_database_status_verifies_pending_and_applied(self):
        for applied in (False, True):
            with self.subTest(applied=applied):
                value = migration_database_fixture(applied=applied)
                for row in value['rows']:
                    row['finished'], row['rolledBack'] = True, False
                state = migration.migration_database_state(self.database_controller(value), LEGACY_PRISMA_ROOT)
                self.assertEqual(state['status'], 'APPLIED' if applied else 'PENDING')
                self.assertTrue(state['schemaVerified'])

    def test_database_status_rejects_strings_floats_null_and_non_binary_integers(self):
        for field in ('finished', 'rolledBack'):
            for bad in ('0', '1', 'true', 'false', 0.0, 1.0, None, -1, 2, [], {}):
                with self.subTest(field=field, bad=bad):
                    value = migration_database_fixture()
                    value['rows'][0][field] = bad
                    with self.assertRaisesRegex(RuntimeError, 'MIGRATION_HISTORY_CHANGED'):
                        migration.migration_database_state(self.database_controller(value), LEGACY_PRISMA_ROOT)

    def test_database_status_requires_exactly_one_finished_or_rolled_back(self):
        for finished, rolled_back in ((False, False), (True, True), (0, 0), (1, 1)):
            with self.subTest(finished=finished, rolled_back=rolled_back):
                value = migration_database_fixture()
                value['rows'][0].update(finished=finished, rolledBack=rolled_back)
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_HISTORY_CHANGED'):
                    migration.migration_database_state(self.database_controller(value), LEGACY_PRISMA_ROOT)

    def test_rolled_back_boolean_history_keeps_required_successful_names_and_checksums(self):
        value = migration_database_fixture()
        for row in value['rows']:
            row['finished'], row['rolledBack'] = True, False
        value['rows'].append({**value['rows'][0], 'finished': False, 'rolledBack': True})
        state = migration.migration_database_state(self.database_controller(value), LEGACY_PRISMA_ROOT)
        self.assertEqual(state['status'], 'PENDING')
        value['rows'][-1]['checksum'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_HISTORY_CHANGED'):
            migration.migration_database_state(self.database_controller(value), LEGACY_PRISMA_ROOT)

    def test_database_partial_ddl_unresolved_or_foreign_history_and_index_drift_fail_closed(self):
        for change in ('checksum', 'missing-old', 'extra', 'duplicate', 'unresolved', 'partial-column', 'column-default', 'unsigned', 'index-column', 'index-unique'):
            value = migration_database_fixture(applied=True)
            if change == 'checksum': value['rows'][-1]['checksum'] = '0' * 64
            elif change == 'missing-old': value['rows'].pop(0)
            elif change == 'extra': value['rows'].append({**value['rows'][0], 'name': '20261009000000_other'})
            elif change == 'duplicate': value['rows'].append(copy.deepcopy(value['rows'][0]))
            elif change == 'unresolved': value['rows'][-1]['finished'] = 0
            elif change == 'partial-column': value['rows'] = [row for row in value['rows'] if row['name'] != migration.MIGRATION_NAME]
            elif change == 'column-default': value['columns'][0]['default'] = '0'
            elif change == 'unsigned': value['columns'][0]['columnType'] = 'int unsigned'
            elif change == 'index-column': value['indexes'][2]['column'] = 'id'
            else: value['indexes'][0]['nonUnique'] = 0
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'MIGRATION_(HISTORY|SCHEMA)_CHANGED'):
                migration.migration_database_state(self.database_controller(value), LEGACY_PRISMA_ROOT)

    def test_completed_migration_retry_is_skipped_and_pending_executes_once(self):
        for applied in (False, True):
            controller = self.database_controller(migration_database_fixture(applied=applied))
            controller.compose.side_effect = ([json.dumps(migration_database_fixture()), 'applied', json.dumps(migration_database_fixture(applied=True))]
                                              if not applied else [json.dumps(migration_database_fixture(applied=True))])
            result = migration.apply_migration(controller, LEGACY_PRISMA_ROOT)
            self.assertEqual(result['status'], 'APPLIED')
            self.assertIs(result['performed'], not applied)
            runs = [call for call in controller.compose.call_args_list if call.args[1] == 'run']
            self.assertEqual(len(runs), 0 if applied else 1)
            if runs:
                self.assertEqual(runs[0].args[2:], ('--rm', '--no-deps', '--pull', 'never', 'migrate'))

    def test_execution_failure_suppresses_raw_output_and_never_resolves_or_rolls_back_migration(self):
        controller = self.database_controller(migration_database_fixture())
        controller.compose.side_effect = [json.dumps(migration_database_fixture()), RuntimeError('PRIVATE_SENTINEL')]
        with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_EXECUTION_FAILED$'):
            migration.apply_migration(controller, LEGACY_PRISMA_ROOT)
        self.assertNotIn('resolve', repr(controller.compose.call_args_list))

    @contextmanager
    def baseline_fixture(self, *, free=10 * 1024**3):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); current = base / 'releases' / 'current'; current.mkdir(parents=True)
            migration_fixture(current, old=True)
            (current / '.env.aws.production').write_text('fixture-preserved')
            (base / 'current').symlink_to(current)
            before = states()
            manifest = {'commit': migration.REGISTRATION_CURRENT, 'sourceTree': TREE,
                'images': {name: {'reference': before[name]['reference'], 'digest': before[name]['image'], 'sourceCommit': OLD} for name in d.SERVICES}}
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.run = MagicMock(return_value=json.dumps([{'Id': before['api']['image'], 'Config': {'Labels': {'org.opencontainers.image.revision': OLD}}}]))
            controller.current_job_database = MagicMock(return_value='fixture_db')
            controller.compose = MagicMock(return_value=json.dumps(migration_database_fixture()))
            stack.enter_context(patch.object(migration, 'snapshot', return_value=before))
            stack.enter_context(patch.object(migration, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(migration.shutil, 'disk_usage', return_value=SimpleNamespace(free=free)))
            native = stack.enter_context(patch.object(migration, 'registration_native_baseline', return_value={'kind': 'VERIFIED_EXISTING_API_REGISTRATION_SOURCE'}))
            idle = stack.enter_context(patch.object(migration, 'jobs_idle', return_value=migration_guards()))
            yield controller, current, before, native, idle, stack

    @contextmanager
    def registration_baseline_fixture(self):
        with self.baseline_fixture() as (controller, current, before, native, idle, stack):
            candidate = registration_proof()
            content = {'api': '1' * 64 + '  /app/apps/api/dist/main.js',
                'auto-registration': '\n'.join(sorted(row['sha256'] + '  /app/' + name[len(registration.WORKER_PREFIX):]
                    for name, row in candidate['workerProjection'].items()))}
            candidate['images']['api'].update(registration.content_summary(d, 'api', content['api']))
            images = {}
            for name, row in candidate['images'].items():
                before[name].update(image=row['imageId'], reference=row['reference'])
                images[name] = {'Id': row['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': {
                    'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE,
                    'id-business-v2.worker-projection-sha256': candidate['workerProjectionSha256']}}}
            manifest = {'commit': COMMIT, 'sourceTree': TREE, 'servicesUpdated': ['api', 'auto-registration'],
                'migrationApplied': False, 'newMigrations': [],
                'images': {name: {'reference': before[name]['reference'], 'digest': before[name]['image'],
                    'sourceCommit': COMMIT if name in candidate['images'] else OLD} for name in d.SERVICES},
                'apiRegistrationPublication': {'version': 1, 'scope': 'API_REGISTRATION',
                    'buildProofSha256': registration.fingerprint(candidate), 'workersPublished': True,
                    'cacheStatus': 'SKIPPED', 'configurationChanged': False}}
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            (current / registration.PROOF_FILE).write_text(json.dumps(candidate))
            controller.api_admin_scope = MagicMock(return_value=(registration, controller))
            controller.service_state = MagicMock(side_effect=lambda _directory, name: before[name])
            image_ids = {image['Id']: image for image in images.values()}
            controller.run.side_effect = lambda *args: json.dumps([image_ids[args[-1]]])
            runtime_rows = {name[len(registration.WORKER_PREFIX):]: row['sha256']
                for name, row in candidate['workerProjection'].items()}
            task = migration_task()
            def compose(_directory, *args, **kwargs):
                if 'mysql' in args:
                    return json.dumps(migration_database_fixture())
                if args[3] == 'python':
                    return json.dumps(runtime_rows)
                if args[3] == 'node':
                    return json.dumps(task)
                return content[args[2]]
            controller.compose.side_effect = compose
            yield controller, current, before, native, idle, stack, candidate, manifest, images, content, runtime_rows, task

    def test_proven_registration_publication_uses_isolated_namespace_without_changing_migration_scope(self):
        with self.registration_baseline_fixture() as (controller, current, before, native, idle, stack, candidate, *_):
            handoff = stack.enter_context(patch.object(migration, 'require_registration_handoff'))
            validate = stack.enter_context(patch.object(registration, 'validate_proof', wraps=registration.validate_proof))
            running = stack.enter_context(patch.object(registration, 'verify_running', wraps=registration.verify_running))
            result = migration.baseline(controller, COMMIT)
            controller.api_admin_scope.assert_called_once_with('API_REGISTRATION')
            validate.assert_called_once_with(controller, candidate, COMMIT, TREE)
            running.assert_called_once_with(controller, current, candidate)
            self.assertEqual(result[2], before)
            self.assertEqual(result[3]['apiSource']['kind'], 'API_REGISTRATION_BUILD_PROVEN')
            self.assertEqual(result[3]['migrationState']['status'], 'PENDING')
            self.assertTrue(result[3]['guards']['registrationWindowRetained'])
            self.assertEqual(migration.UPDATED, ('api', 'admin'))
            self.assertEqual(migration.IMAGE_SERVICES, ('api', 'admin', 'migrate'))
            self.assertEqual(migration.PROOF_FILE, 'api-admin-migration-build-proof.json')
            self.assertFalse(migration.REGISTRATION)
            native.assert_not_called()
            handoff.assert_not_called()

    def test_registration_origin_still_supports_its_own_namespace_and_default_mode_cannot_use_it(self):
        with self.registration_baseline_fixture() as (controller, current, before, native, idle, stack, *_):
            stack.enter_context(patch.object(registration, 'snapshot', return_value=before))
            stack.enter_context(patch.object(registration, 'workspace_existing', return_value=False))
            result = registration.baseline(controller, COMMIT, check_jobs=False)
            self.assertEqual(result[3]['apiSource']['kind'], 'API_REGISTRATION_BUILD_PROVEN')
            stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_SCOPE_CONFLICT$'):
                scope.baseline(controller, COMMIT, check_jobs=False)

    def test_registration_origin_rejects_unproven_publication_or_old_migration_and_configuration_changes(self):
        for change in ('scope', 'proof-hash', 'workers', 'configuration', 'cache', 'extra-field',
                       'services', 'migration-applied', 'new-migration'):
            with self.subTest(change=change), self.registration_baseline_fixture() as (
                    controller, current, before, native, idle, stack, candidate, manifest, *_):
                publication = manifest['apiRegistrationPublication']
                if change == 'scope': publication['scope'] = 'API_ADMIN_MIGRATION'
                elif change == 'proof-hash': publication['buildProofSha256'] = '0' * 64
                elif change == 'workers': publication['workersPublished'] = False
                elif change == 'configuration': publication['configurationChanged'] = True
                elif change == 'cache': publication['cacheStatus'] = 'CLEANED'
                elif change == 'extra-field': publication['unchecked'] = True
                elif change == 'services': manifest['servicesUpdated'] = ['api', 'admin']
                elif change == 'migration-applied': manifest['migrationApplied'] = True
                else: manifest['newMigrations'] = [migration.MIGRATION_FILE]
                (current / 'release-manifest.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_REGISTRATION_PROVENANCE_CHANGED$'):
                    migration.baseline(controller, COMMIT)

    def test_registration_origin_rejects_wrong_proof_scope_tree_images_and_worker_projection(self):
        for change in ('scope', 'tree', 'commit', 'image-services', 'projection'):
            with self.subTest(change=change), self.registration_baseline_fixture() as (
                    controller, current, before, native, idle, stack, candidate, manifest, *_):
                if change == 'scope': candidate['scope'] = 'API_ADMIN_MIGRATION'
                elif change == 'tree': candidate['sourceTree'] = OLD
                elif change == 'commit': candidate['commit'] = OLD
                elif change == 'image-services': candidate['images']['admin'] = proof()['images']['admin']
                else:
                    name = next(name for name in candidate['workerProjection'] if name not in registration.WORKER_PAIR)
                    candidate['workerProjection'][name]['sha256'] = '0' * 64
                    candidate['workerProjectionSha256'] = registration.fingerprint(candidate['workerProjection'])
                (current / registration.PROOF_FILE).write_text(json.dumps(candidate))
                manifest['apiRegistrationPublication']['buildProofSha256'] = registration.fingerprint(candidate)
                (current / 'release-manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(RuntimeError): migration.baseline(controller, COMMIT)

    def test_registration_origin_requires_its_own_proof_file_without_migration_proof_fallback(self):
        with self.registration_baseline_fixture() as (controller, current, *_):
            (current / registration.PROOF_FILE).unlink()
            (current / migration.PROOF_FILE).write_text(json.dumps(migration_proof()))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BASELINE_PROJECTION_FAILED$'):
                migration.baseline(controller, COMMIT)

    def test_registration_origin_verifies_actual_images_content_projection_and_worker_source(self):
        for change in ('api-tree', 'worker-image', 'api-content', 'worker-content', 'worker-label', 'worker-source'):
            with self.subTest(change=change), self.registration_baseline_fixture() as (
                    controller, current, before, native, idle, stack, candidate, manifest, images, content, runtime_rows, task):
                if change == 'api-tree': images['api']['Config']['Labels']['id-business-v2.source-tree'] = OLD
                elif change == 'worker-image': images['auto-registration']['Id'] = 'sha256:' + '8' * 64
                elif change == 'api-content': content['api'] = '2' * 64 + '  /app/apps/api/dist/main.js'
                elif change == 'worker-content': content['auto-registration'] += '\n' + '2' * 64 + '  /app/unexpected.py'
                elif change == 'worker-label': images['auto-registration']['Config']['Labels']['id-business-v2.worker-projection-sha256'] = '0' * 64
                else: runtime_rows[next(iter(runtime_rows))] = '0' * 64
                with self.assertRaises(RuntimeError): migration.baseline(controller, COMMIT)

    def test_registration_origin_still_rejects_schema_sql_and_extra_history_after_image_proof(self):
        for change in ('schema', 'old-sql', 'extra-migration'):
            with self.subTest(change=change), self.registration_baseline_fixture() as (controller, current, *_):
                if change == 'schema': (current / migration.MIGRATION_SCHEMA).write_text('changed schema')
                elif change == 'old-sql': next((current / migration.MIGRATION_ROOT).rglob('migration.sql')).write_text('changed old SQL')
                else:
                    path = current / migration.MIGRATION_ROOT / '20261009000000_other/migration.sql'
                    path.parent.mkdir(); path.write_text('ALTER TABLE other ADD COLUMN x INT;')
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_SCOPE_CHANGED$'):
                    migration.baseline(controller, COMMIT)

    def test_registration_origin_preflight_keeps_strict_audit_task_hmac_and_window_guards(self):
        for change in (None, 'audit', 'hmac', 'window', 'attempt', 'task-state'):
            with self.subTest(change=change), self.registration_baseline_fixture() as (
                    controller, current, before, native, idle, stack, candidate, manifest, images, content, runtime_rows, task):
                private = stack.enter_context(patch.object(migration, 'registration_private'))
                handoff = stack.enter_context(patch.object(migration, 'registration_handoff'))
                audit = stack.enter_context(patch.object(migration, 'strict_audit', return_value={
                    'mode': 'STRICT_ZERO_49', 'checkCount': 49, 'violationCount': 0, 'checksSha256': '5' * 64}))
                if change == 'audit': audit.side_effect = RuntimeError('API_ADMIN_STRICT_49_FAILED')
                elif change == 'hmac': audit.side_effect = lambda *_args: task.update(jobHmac='9' * 64)
                elif change == 'window': idle.side_effect = [migration_guards(), migration_guards(), {**migration_guards(), 'registrationWindowRetained': False}]
                elif change == 'attempt': task['attempt'] = 10
                elif change == 'task-state': task['passwordVerified'] = True
                if change is None:
                    result = migration.migration_preflight(controller, COMMIT)
                    transport.validate_receipt(result, COMMIT, 'preflight', 'API_ADMIN_MIGRATION')
                    self.assertTrue(result['windowPreserved'])
                    self.assertFalse(result['requiresWindowHandoff'])
                    self.assertEqual(result['task']['attempt'], 12)
                    audit.assert_called_once()
                    self.assertTrue(all(call.kwargs == {'retained': True} for call in private.call_args_list))
                else:
                    with self.assertRaises(RuntimeError): migration.migration_preflight(controller, COMMIT)
                handoff.assert_not_called()
                native.assert_not_called()

    def test_existing_e7_source_uses_explicit_native_proof_and_never_handoff(self):
        with self.baseline_fixture() as (controller, directory, before, native, idle, stack):
            handoff = stack.enter_context(patch.object(migration, 'require_registration_handoff'))
            result = migration.baseline(controller, migration.REGISTRATION_CURRENT)
            native.assert_called_once()
            self.assertEqual(result[3]['apiSource']['kind'], 'VERIFIED_EXISTING_API_REGISTRATION_SOURCE')
            self.assertEqual(result[3]['migrationState']['status'], 'PENDING')
            self.assertTrue(result[3]['guards']['registrationWindowRetained'])
            handoff.assert_not_called()

    def test_six_gibibytes_is_insufficient_and_aborts_before_database_query(self):
        with self.baseline_fixture(free=6 * 1024**3) as (controller, directory, before, native, idle, stack):
            with self.assertRaisesRegex(RuntimeError, 'DISK_LOW_BEFORE_PULL'):
                migration.baseline(controller, migration.REGISTRATION_CURRENT)
            controller.compose.assert_not_called()

    def test_preflight_audits_49_and_preserves_task_and_retained_window_without_close(self):
        with self.baseline_fixture() as (controller, directory, before, native, idle, stack):
            stack.enter_context(patch.object(migration, 'registration_task', return_value=migration_task()))
            private = stack.enter_context(patch.object(migration, 'registration_private'))
            handoff = stack.enter_context(patch.object(migration, 'registration_handoff'))
            audit = stack.enter_context(patch.object(migration, 'strict_audit', return_value={
                'mode': 'STRICT_ZERO_49', 'checkCount': 49, 'violationCount': 0, 'checksSha256': '5' * 64}))
            result = migration.migration_preflight(controller, migration.REGISTRATION_CURRENT)
            self.assertEqual(result['status'], 'API_ADMIN_MIGRATION_BASELINE_VERIFIED')
            self.assertFalse(result['requiresWindowHandoff'])
            self.assertTrue(result['windowPreserved'])
            audit.assert_called_once()
            handoff.assert_not_called()
            self.assertTrue(all(call.kwargs == {'retained': True} for call in private.call_args_list))
            transport.validate_receipt(result, migration.REGISTRATION_CURRENT, 'preflight', 'API_ADMIN_MIGRATION')
            for key, val in [('freeBytes', 6 * 1024**3), ('windowPreserved', False), ('requiresWindowHandoff', True), ('task', {})]:
                with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, 'MIGRATION_PREFLIGHT_CHANGED'):
                    transport.validate_receipt({**result, key: val}, migration.REGISTRATION_CURRENT, 'preflight', 'API_ADMIN_MIGRATION')

    def test_preflight_hmac_or_window_changes_fail(self):
        for field in ('jobHmac', 'window'):
            with self.subTest(field=field), self.baseline_fixture() as (controller, directory, before, native, idle, stack):
                task = migration_task()
                stack.enter_context(patch.object(migration, 'registration_task', side_effect=[task, task, {**task, 'jobHmac': '9' * 64}] if field == 'jobHmac' else lambda *args: task))
                stack.enter_context(patch.object(migration, 'registration_private'))
                stack.enter_context(patch.object(migration, 'strict_audit', return_value={}))
                if field == 'window': idle.side_effect = [migration_guards(), migration_guards(), {**migration_guards(), 'registrationWindowRetained': False}]
                with self.assertRaisesRegex(RuntimeError, 'REGISTRATION_TASK_CHANGED'):
                    migration.migration_preflight(controller, migration.REGISTRATION_CURRENT)

    def test_transport_is_explicit_and_cannot_select_close_or_handoff(self):
        for operation in ('verify_api_admin_migration', 'release_api_admin_migration'):
            self.assertEqual(transport.selected_scope(operation), 'API_ADMIN_MIGRATION')
        for mode in ('preflight', 'readback'):
            commands = '\n'.join(transport.parameters(COMMIT, OLD, mode, 'API_ADMIN_MIGRATION')['commands'])
            self.assertIn('--api-admin-migration-' + mode, commands)
            self.assertNotIn('handoff', commands)
            self.assertNotIn('cancel', commands)
        for mode in ('handoff', 'business', 'handoff-observe', 'handoff-recover'):
            with self.assertRaises(ValueError): transport.parameters(COMMIT, OLD, mode, 'API_ADMIN_MIGRATION')
        receipt = {'status': 'API_ADMIN_MIGRATION_VERIFICATION_FAILED', 'code': 'API_ADMIN_MIGRATION_SCOPE_CHANGED',
                   'errorType': 'RuntimeError', 'rawError': 'PRIVATE_SENTINEL'}
        self.assertNotIn('rawError', transport.safe_failure(receipt, 'API_ADMIN_MIGRATION'))

    def test_current_business_candidate_still_cannot_use_registration_worker_release(self):
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        with self.assertRaisesRegex(RuntimeError, 'REGISTRATION_API_SCOPE_CHANGED'):
            registration.registration_candidate_scope(d, commit)


class MigrationReadbackTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary); origin, current = (base / 'releases' / n for n in ('old', 'new'))
            candidate, before = migration_proof(), states()
            for directory in (origin, current):
                directory.mkdir(parents=True)
                migration_fixture(directory, old=directory == origin)
                (directory / '.env.aws.production').write_text('fixture-preserved')
                for name in migration.CONFIG_FILES:
                    if name == migration.MIGRATION_SCHEMA: continue
                    path = directory / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('unchanged')
                override = {name: {'image': 'old-' + name, 'pull_policy': 'never'} for name in (*d.SERVICES, 'migrate')}
                if directory == current:
                    for name in migration.IMAGE_SERVICES: override[name]['image'] = candidate['images'][name]['reference']
                (directory / 'compose.release.json').write_text(json.dumps({'services': override}))
            (base / 'current').symlink_to(current)
            after = copy.deepcopy(before)
            for name in migration.UPDATED:
                after[name].update(image=candidate['images'][name]['imageId'], reference=candidate['images'][name]['reference'])
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.current_job_database = lambda directory: 'fixture_db'
            controller.compose = MagicMock(return_value=json.dumps(migration_database_fixture(applied=True)))
            image = {'Id': candidate['images']['migrate']['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': {
                'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}
            content = docker_prisma_content(current)
            controller.run = MagicMock(side_effect=lambda *args, **kw: json.dumps([image]) if args[:3] == ('docker', 'image', 'inspect') else content)
            state = migration.migration_database_state(controller, current)
            report = {'ok': True, 'checkCount': 49, 'violationCount': 0,
                'checks': [{'code': str(index), 'count': 0} for index in range(49)]}
            for name in ('before-audit.json', 'after-audit.json'): (current / name).write_text(json.dumps(report))
            backup = {'name': 'fixture.sql.gz', 's3Verified': True, 'size': 100, 'sha256': '9' * 64}
            (current / 'backup-verification.json').write_text(json.dumps(backup))
            environment_sha = hashlib.sha256(b'fixture-preserved').hexdigest()
            record = {'before': before, 'buildProofSha256': migration.fingerprint(candidate), 'environmentSha256': environment_sha,
                'configurationBefore': migration.configuration_hashes(origin), 'configurationAfter': migration.configuration_hashes(current),
                'registrationTask': migration_task(), 'registrationGuards': migration_guards(), 'migration': {**state, 'performed': True}}
            (current / migration.STATE_FILE).write_text(json.dumps(record))
            (current / migration.PROOF_FILE).write_text(json.dumps(candidate))
            manifest = {'sourceTree': TREE, 'servicesUpdated': list(migration.UPDATED), 'migrationApplied': True,
                'migrationPerformed': True, 'newMigrations': [migration.MIGRATION_FILE], 'previousRelease': str(origin),
                'backupBeforeRelease': backup['name'], 'dataAuditBefore': migration.audit_receipt(d, current / 'before-audit.json'),
                'dataAuditAfter': migration.audit_receipt(d, current / 'after-audit.json')}
            stack.enter_context(patch.object(migration, 'baseline', return_value=(current, manifest, after, {'environmentSha256': environment_sha})))
            stack.enter_context(patch.object(migration, 'snapshot', return_value=after))
            stack.enter_context(patch.object(migration, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(migration, 'verify_running'))
            stack.enter_context(patch.object(migration, 'jobs_idle', return_value=migration_guards()))
            task = stack.enter_context(patch.object(migration, 'registration_task', return_value=migration_task()))
            private = stack.enter_context(patch.object(migration, 'registration_private'))
            handoff = stack.enter_context(patch.object(migration, 'require_registration_handoff'))
            yield controller, current, manifest, candidate, image, task, private, handoff

    def test_readback_confirms_ddl_two_running_images_five_preserved_services_and_original_task(self):
        with self.fixture() as (controller, current, manifest, candidate, image, task, private, handoff):
            result = migration.readback(controller, COMMIT)
            self.assertTrue(result['migrationApplied'])
            self.assertTrue(result['migrationPerformed'])
            self.assertTrue(result['taskHmacMatched'])
            self.assertTrue(result['registrationWindowRetained'])
            self.assertEqual(result['servicesUpdated'], ['api', 'admin'])
            self.assertEqual(result['preservedServiceCount'], 5)
            self.assertNotIn('migrate', result['services'])
            with patch.object(Path, 'read_text', return_value=json.dumps(candidate)):
                transport.validate_receipt(result, COMMIT, 'readback', 'API_ADMIN_MIGRATION')
            handoff.assert_not_called()
            private.assert_called_once_with(controller, current, retained=True)

    def test_readback_cannot_disable_original_task_check(self):
        with self.fixture() as (controller, current, *_):
            with self.assertRaisesRegex(RuntimeError, 'SCOPE_CONFLICT'):
                migration.readback(controller, COMMIT, check_task=False)

    def test_readback_rejects_changed_task_backup_and_actual_index(self):
        for change in ('task', 'backup', 'index'):
            with self.subTest(change=change), self.fixture() as (controller, current, manifest, candidate, image, task, private, handoff):
                if change == 'task': task.return_value = {**migration_task(), 'jobHmac': '8' * 64}
                elif change == 'backup': (current / 'backup-verification.json').write_text(json.dumps({'name': 'wrong'}))
                else:
                    value = migration_database_fixture(applied=True); value['indexes'][2]['column'] = 'id'
                    controller.compose.return_value = json.dumps(value)
                with self.assertRaises(RuntimeError): migration.readback(controller, COMMIT)

    def test_migrate_image_exact_content_and_oci_provenance_are_checked_before_execution(self):
        with self.fixture() as (controller, current, manifest, candidate, image, *_):
            migration.verify_migration_image(controller, current, candidate, inspect_content=True)
            run = controller.run.call_args.args
            self.assertEqual(run[:3], ('docker', 'run', '--rm'))
            self.assertIn('none', run)
            self.assertIn('--read-only', run)
            image['Config']['Labels']['org.opencontainers.image.revision'] = OLD
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_IMAGE_CHANGED'):
                migration.verify_migration_image(controller, current, candidate)

    def test_migrate_image_wrong_content_and_override_are_rejected(self):
        for change in ('content', 'override'):
            with self.subTest(change=change), self.fixture() as (controller, current, manifest, candidate, image, *_):
                if change == 'content': candidate['images']['migrate']['sha256'] = '0' * 64
                else:
                    override = json.loads((current / 'compose.release.json').read_text())
                    override['services']['migrate']['image'] = 'wrong'
                    (current / 'compose.release.json').write_text(json.dumps(override))
                with self.assertRaisesRegex(RuntimeError, 'MIGRATION_IMAGE'):
                    migration.verify_migration_image(controller, current, candidate)

    def test_independent_receipt_rejects_missing_migration_or_task_proof(self):
        with self.fixture() as (controller, current, manifest, candidate, *_):
            result = migration.readback(controller, COMMIT)
            for key, value in [('migrationApplied', False), ('migrationPerformed', None), ('taskHmacMatched', False),
                               ('windowPreserved', False), ('migrationState', {}), ('migration', {})]:
                with self.subTest(field=key), patch.object(Path, 'read_text', return_value=json.dumps(candidate)), self.assertRaisesRegex(RuntimeError, 'MIGRATION_READBACK_CHANGED'):
                    transport.validate_receipt({**result, key: value}, COMMIT, 'readback', 'API_ADMIN_MIGRATION')


class MigrationReleaseTests(unittest.TestCase):
    run_release = ReleaseFailureTests.run_release
    def test_migration_success_pulls_three_images_switches_two_and_preserves_workers(self):
        code, result, controller, manifest, _ = self.run_release(selected_scope=migration)
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'API_ADMIN_MIGRATION_VERIFIED')
        switches = [call.args[-1] for call in controller.compose.call_args_list if call.args[1] == 'up']
        self.assertEqual(switches, ['admin', 'api'])
        self.assertEqual([command[2].rsplit('-', 1)[-1] for command in controller.commands if command[:2] == ('docker', 'pull')], ['api', 'admin', 'migrate'])
        self.assertEqual(manifest['servicesUpdated'], ['api', 'admin'])
        self.assertTrue(manifest['migrationApplied'])
        self.assertTrue(manifest['migrationPerformed'])
        self.assertEqual(manifest['newMigrations'], [migration.MIGRATION_FILE])
        self.assertFalse(manifest['apiAdminMigrationPublication']['workersPublished'])
        for name in ('auto-registration', 'auto-recharge', 'media-resolver'):
            self.assertEqual(manifest['images'][name]['sourceCommit'], OLD)
        self.assertTrue(all(call.kwargs == {'retained': True} for call in controller.private_stub.call_args_list))
        controller.rollback_service.assert_not_called()

    def test_api_failure_after_migration_restores_only_two_services_without_inverse_ddl(self):
        code, result, controller, manifest, persisted = self.run_release(selected_scope=migration, fail_at='api-health')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_MIGRATION_FAILED_RESTORED')
        self.assertTrue(result['migrationApplied'])
        self.assertTrue(result['migrationPerformed'])
        self.assertFalse(result['inverseMigrationPerformed'])
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['api', 'admin'])
        self.assertEqual(len([call for call in controller.compose.call_args_list if call.args[1] == 'run']), 1)
        self.assertTrue(persisted)
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))
        self.assertIsNone(manifest)

    def test_backup_failure_prevents_ddl_and_all_service_switches(self):
        code, result, controller, _, persisted = self.run_release(selected_scope=migration, fail_at='backup')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_MIGRATION_FAILED_BEFORE_SWITCH')
        self.assertFalse(result['migrationApplied'])
        self.assertFalse(result['migrationAttempted'])
        controller.compose.assert_not_called()
        self.assertTrue(persisted)

    def test_already_applied_retry_skips_ddl_but_manifest_records_real_schema(self):
        code, result, controller, manifest, _ = self.run_release(selected_scope=migration, migration_preapplied=True)
        self.assertEqual(code, 0)
        self.assertTrue(manifest['migrationApplied'])
        self.assertFalse(manifest['migrationPerformed'])
        self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['admin', 'api'])

    def test_command_failure_records_whether_ddl_completed_and_never_switches(self):
        for failure, applied, status in [('before', False, 'FAILED_BEFORE_SWITCH'), ('after', True, 'FAILED_BEFORE_SWITCH'),
                                         ('partial', None, 'PARTIAL_RECOVERY_REQUIRED')]:
            with self.subTest(failure=failure):
                code, result, controller, _, persisted = self.run_release(selected_scope=migration, migration_failure=failure)
                self.assertEqual(code, 1)
                self.assertEqual(result['status'], 'API_ADMIN_MIGRATION_' + status)
                self.assertIs(result['migrationApplied'], applied)
                self.assertFalse(result['inverseMigrationPerformed'])
                self.assertTrue(result['migrationAttempted'])
                self.assertFalse(any(call.args[1] == 'up' for call in controller.compose.call_args_list))
                self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))
                self.assertTrue(persisted)

    def test_busy_before_migration_stops_ddl_and_api_switch(self):
        count = 0
        def idle(*args, **kwargs):
            nonlocal count
            count += 1
            if count > 1: raise RuntimeError('API_ADMIN_REGISTRATION_BUSY')
            return migration_guards()
        code, result, controller, _, _ = self.run_release(selected_scope=migration, idle_check=idle)
        self.assertEqual(code, 1)
        self.assertFalse(result['migrationApplied'])
        controller.compose.assert_not_called()

    def test_changed_hmac_or_window_after_ddl_prevents_switch_without_reversing_migration(self):
        for changes in ({'migration_task_changed': True}, {'migration_window_changed': True}):
            with self.subTest(changes=changes):
                code, result, controller, _, _ = self.run_release(selected_scope=migration, **changes)
                self.assertEqual(code, 1)
                self.assertTrue(result['migrationApplied'])
                self.assertFalse(result['inverseMigrationPerformed'])
                self.assertEqual(result['code'], 'API_ADMIN_REGISTRATION_TASK_CHANGED')
                self.assertFalse(any(call.args[1] == 'up' for call in controller.compose.call_args_list))


class MigrationSuccessorReceiptTests(unittest.TestCase):
    def context(self):
        return {'version': 1, 'release': '/opt/id-business-v2/releases/20261008T175148Z-23c5841b9b7e',
            'commit': scope.MIGRATION_SUCCESSOR_COMMIT, 'manifestSha256': scope.MIGRATION_SUCCESSOR_MANIFEST_SHA,
            'buildProofSha256': scope.MIGRATION_SUCCESSOR_PROOF_SHA, 'migration': dict(scope.MIGRATION_IDENTITY),
            'migrationState': {'name': scope.MIGRATION_NAME, 'sha256': scope.MIGRATION_IDENTITY['sha256'],
                'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': '7' * 64},
            'task': migration_task(), 'guards': migration_guards()}

    def preflight(self):
        return {'status': 'API_ADMIN_BASELINE_VERIFIED', 'commit': scope.MIGRATION_SUCCESSOR_COMMIT,
            'freeBytes': 10 * 1024**3, 'services': states(), 'guards': migration_guards(), 'migrationOrigin': self.context()}

    def test_current_23c_seal_does_not_admit_old_fd16_or_replace_individual_proofs(self):
        self.assertEqual(scope.MIGRATION_SUCCESSOR_COMMIT, '23c5841b9b7e60be715250cbb985fc0966c0bce3')
        self.assertEqual(scope.MIGRATION_SUCCESSOR_MANIFEST_SHA, '117ca444e81623f372a2d9c34ecc16effd52141dcfb5e511f74624280092f639')
        self.assertEqual(scope.MIGRATION_SUCCESSOR_PROOF_SHA, '6208643f01babb412956fe43f537990adf951c14447645e7f56303d03a6b1d6c')
        old = {'commit': 'fd16cc2cbbec84c212f315d4b735ea0ce8a6cd6a',
            'release': '/opt/id-business-v2/releases/20261008T162950Z-fd16cc2cbbec',
            'manifestSha256': '73952f1c7807d7bf6e4f78d4c5c2eed20602a234c2fe0506538fbd1757f9bed0',
            'buildProofSha256': 'b9d1a28a2a4251e777285da187db51d0989f8ae80e82d5925c172fee18b17ded'}
        controller = SimpleNamespace(require=d.require, api_admin_scope=MagicMock())
        for changed in (old, {'manifestSha256': old['manifestSha256']},
                        {'buildProofSha256': old['buildProofSha256']}, {'manifestSha256': '0' * 64}):
            context = {**self.context(), **changed}
            receipt = {**self.preflight(), 'migrationOrigin': context}
            with self.subTest(changed=changed):
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED$'):
                    transport.validate_receipt(receipt, scope.MIGRATION_SUCCESSOR_COMMIT, 'preflight')
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_CHANGED$'):
                    scope.migration_successor_guard(controller, RUNTIME, context)
            controller.api_admin_scope.assert_not_called()
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            controller.BASE = Path(temporary)
            origin = controller.BASE / 'releases/20261008T162950Z-fd16cc2cbbec'
            origin.mkdir(parents=True)
            (origin / 'release-manifest.json').write_text(json.dumps({'commit': old['commit']}))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_CHANGED$'):
                scope.migration_successor_origin(controller, origin)
            controller.api_admin_scope.assert_not_called()

    def test_first_preflight_requires_complete_original_migration_task_window_and_seven_services(self):
        receipt = self.preflight()
        transport.validate_receipt(receipt, scope.MIGRATION_SUCCESSOR_COMMIT, 'preflight')
        for change in ('context', 'commit', 'manifest', 'proof', 'schema', 'sql', 'state', 'task', 'window', 'lease', 'service', 'disk', 'boolean-version'):
            changed = copy.deepcopy(receipt)
            context = changed['migrationOrigin']
            if change == 'context': changed.pop('migrationOrigin')
            elif change == 'commit': context['commit'] = OLD
            elif change == 'manifest': context['manifestSha256'] = '0' * 64
            elif change == 'proof': context['buildProofSha256'] = '0' * 64
            elif change == 'schema': context['migration']['schemaAfterSha256'] = '0' * 64
            elif change == 'sql': context['migrationState']['sha256'] = '0' * 64
            elif change == 'state': context['migrationState']['status'] = 'PENDING'
            elif change == 'task': context['task']['jobHmac'] = '0' * 64
            elif change == 'window': context['guards']['registrationWindowRetained'] = False
            elif change == 'lease': changed['guards']['registrationLeaseActive'] = True
            elif change == 'service': changed['services'].pop('auto-registration')
            elif change == 'disk': changed['freeBytes'] = 6 * 1024**3
            else: context['version'] = True
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED$'):
                transport.validate_receipt(changed, scope.MIGRATION_SUCCESSOR_COMMIT, 'preflight')

    @contextmanager
    def readback_fixture(self):
        context, candidate = self.context(), proof()
        receipt = {'status': 'API_ADMIN_VERIFIED', 'commit': COMMIT, 'sourceTree': TREE,
            'buildProofSha256': scope.fingerprint(candidate), 'servicesUpdated': ['api', 'admin'], 'preservedServiceCount': 5,
            'runningImagesAndContentMatched': True, 'environmentUnchanged': True,
            'services': {name: {'image': row['imageId'], 'reference': row['reference']} for name, row in candidate['images'].items()},
            'preservedMigrationOrigin': scope.migration_successor_marker(context), 'migrationPreserved': True,
            'migrationPerformed': False, 'taskHmacMatched': True, 'windowPreserved': True, 'registrationWindowRetained': True}
        before = {**self.preflight(), 'mode': 'preflight', 'releaseCandidateCommit': COMMIT,
                  'workflowRunId': '123', 'workflowRunAttempt': '1'}
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.dict(os.environ,
                RELEASE_COMMIT=COMMIT, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1'):
            directory = Path(temporary) / '.deploy/production-release'; directory.mkdir(parents=True)
            (directory / scope.PROOF_FILE).write_text(json.dumps(candidate))
            before_file = directory / 'api-admin-preflight-result.json'; before_file.write_text(json.dumps(before))
            saved = os.getcwd(); os.chdir(temporary)
            try: yield receipt, before, before_file
            finally: os.chdir(saved)

    def test_independent_readback_binds_origin_fingerprint_to_preflight_of_same_candidate_run_attempt(self):
        with self.readback_fixture() as (receipt, before, before_file):
            transport.validate_receipt(receipt, COMMIT, 'readback')
            for field, value in [('releaseCandidateCommit', OLD), ('workflowRunId', '124'), ('workflowRunAttempt', '2'),
                    ('status', 'UNVERIFIED'), ('mode', 'readback')]:
                before_file.write_text(json.dumps({**before, field: value}))
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED$'):
                    transport.validate_receipt(receipt, COMMIT, 'readback')
            before_file.write_text(json.dumps(before))
            for field, value in [('preservedMigrationOrigin', {}), ('migrationPreserved', False), ('migrationPerformed', True),
                    ('taskHmacMatched', False), ('windowPreserved', False), ('registrationWindowRetained', False)]:
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED$'):
                    transport.validate_receipt({**receipt, field: value}, COMMIT, 'readback')
            before_file.unlink()
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED$'):
                transport.validate_receipt(receipt, COMMIT, 'readback')

    def test_context_bytes_changed_after_preflight_cannot_use_old_readback_marker(self):
        with self.readback_fixture() as (receipt, before, before_file):
            changed = copy.deepcopy(before)
            changed['migrationOrigin']['migrationState']['appliedMigrationsSha256'] = '8' * 64
            before_file.write_text(json.dumps(changed))
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_MIGRATION_ORIGIN_RECEIPT_CHANGED$'):
                transport.validate_receipt(receipt, COMMIT, 'readback')


class MigrationSuccessorTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with MigrationReadbackTests().fixture() as (controller, current, manifest, candidate, image, task, private, handoff), ExitStack() as stack:
            before = states()
            for name in migration.UPDATED:
                before[name].update(image=candidate['images'][name]['imageId'], reference=candidate['images'][name]['reference'])
            manifest.update(commit=COMMIT, images={name: {'reference': row['reference'], 'digest': row['image'],
                'sourceCommit': COMMIT if name in migration.UPDATED else OLD} for name, row in before.items() if name in d.SERVICES},
                apiAdminMigrationPublication={'version': 1, 'scope': 'API_ADMIN_MIGRATION',
                    'buildProofSha256': migration.fingerprint(candidate), 'workersPublished': False,
                    'cacheStatus': 'SKIPPED', 'configurationChanged': False, 'schemaChanged': True,
                    'migration': migration.MIGRATION_IDENTITY})
            raw = json.dumps(manifest).encode(); (current / 'release-manifest.json').write_bytes(raw)
            stack.enter_context(patch.object(scope, 'MIGRATION_SUCCESSOR_COMMIT', COMMIT))
            stack.enter_context(patch.object(scope, 'MIGRATION_SUCCESSOR_MANIFEST_SHA', hashlib.sha256(raw).hexdigest()))
            stack.enter_context(patch.object(scope, 'MIGRATION_SUCCESSOR_PROOF_SHA', migration.fingerprint(candidate)))
            controller.api_admin_scope = MagicMock(return_value=(migration, controller))
            controller.service_state = lambda _directory, name, **kwargs: before[name]
            original_run = controller.run.side_effect
            def inspect(*args, **kwargs):
                if args[:3] == ('docker', 'image', 'inspect') and args[-1] == before['api']['image']:
                    return json.dumps([{'Id': before['api']['image'], 'Architecture': 'amd64', 'Config': {'Labels': {
                        'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}])
                return original_run(*args, **kwargs)
            controller.run.side_effect = inspect
            stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(scope, 'jobs_idle', return_value=migration_guards()))
            yield controller, current, manifest, candidate, before, task, private, handoff, stack

    def test_exact_origin_runs_original_three_image_migration_readback_without_migration_or_handoff(self):
        with self.fixture() as (controller, current, manifest, candidate, before, task, private, handoff, stack):
            apply = stack.enter_context(patch.object(migration, 'apply_migration'))
            original_readback = stack.enter_context(patch.object(migration, 'readback', wraps=migration.readback))
            result = scope.baseline(controller, COMMIT)
            context = result[3]['migrationOrigin']
            self.assertEqual(result[3]['apiSource']['kind'], 'VERIFIED_MIGRATION_API_ADMIN_ORIGIN')
            self.assertEqual(result[2], before)
            self.assertEqual(context['task'], migration.MIGRATION_TASK)
            self.assertEqual(context['migrationState']['status'], 'APPLIED')
            self.assertEqual(context['buildProofSha256'], migration.fingerprint(candidate))
            original_readback.assert_called_once_with(controller, COMMIT)
            self.assertTrue(all('run' not in call.args[1:3] for call in controller.compose.call_args_list))
            apply.assert_not_called(); handoff.assert_not_called()

    def test_origin_requires_exact_approved_commit_manifest_and_proof(self):
        for change in ('commit', 'manifest', 'proof'):
            with self.subTest(change=change), self.fixture() as (controller, current, manifest, candidate, *_):
                if change == 'commit': scope.MIGRATION_SUCCESSOR_COMMIT = OLD
                elif change == 'manifest': (current / 'release-manifest.json').write_text(json.dumps({**manifest, 'unchecked': True}))
                else:
                    candidate['images']['api']['sha256'] = '8' * 64
                    (current / migration.PROOF_FILE).write_text(json.dumps(candidate))
                with self.assertRaises(RuntimeError): scope.baseline(controller, COMMIT, check_jobs=False)

    def test_preservation_rejects_context_task_ddl_proof_or_window_drift(self):
        for change in ('extra', 'origin-commit', 'origin-path', 'context-task', 'database', 'task', 'window', 'schema', 'proof'):
            with self.subTest(change=change), self.fixture() as (controller, current, manifest, candidate, before, task, private, handoff, stack):
                context = scope.migration_successor_origin(controller, current)
                if change == 'extra': context['unchecked'] = True
                elif change == 'origin-commit': context['commit'] = OLD
                elif change == 'origin-path': context['release'] = str(controller.BASE)
                elif change == 'context-task': context['task']['jobHmac'] = '8' * 64
                elif change == 'database': controller.compose.return_value = json.dumps(migration_database_fixture(applied=False))
                elif change == 'task': task.return_value = {**migration_task(), 'jobHmac': '8' * 64}
                elif change == 'window': stack.enter_context(patch.object(migration, 'jobs_idle', return_value={**migration_guards(), 'registrationWindowRetained': False}))
                elif change == 'schema': (current / migration.MIGRATION_SCHEMA).write_text('changed schema')
                else:
                    candidate['images'].pop('migrate'); (current / migration.PROOF_FILE).write_text(json.dumps(candidate))
                with self.assertRaises(RuntimeError): scope.migration_successor_guard(controller, current, context)

    @contextmanager
    def successor_fixture(self):
        with self.fixture() as (controller, origin, original_manifest, original_proof, before, task, private, handoff, stack):
            context = scope.migration_successor_origin(controller, origin)
            current = controller.BASE / 'releases/successor'; shutil.copytree(origin, current)
            candidate = proof(); candidate['commit'] = OLD
            for name, row in candidate['images'].items(): row['reference'] = row['reference'].replace(COMMIT, OLD)
            after = copy.deepcopy(before)
            for name, row in candidate['images'].items(): after[name].update(image=row['imageId'], reference=row['reference'])
            override = json.loads((current / 'compose.release.json').read_text())
            for name, row in candidate['images'].items(): override['services'][name] = {'image': row['reference'], 'pull_policy': 'never'}
            (current / 'compose.release.json').write_text(json.dumps(override))
            environment_sha = hashlib.sha256((origin / '.env.aws.production').read_bytes()).hexdigest()
            record = {'before': before, 'after': after, 'environmentSha256': environment_sha,
                'buildProofSha256': scope.fingerprint(candidate), 'migrationOrigin': context,
                'configurationBefore': scope.configuration_hashes(origin), 'configurationAfter': scope.configuration_hashes(current)}
            (current / scope.STATE_FILE).write_text(json.dumps(record))
            (current / scope.PROOF_FILE).write_text(json.dumps(candidate))
            manifest = {'commit': OLD, 'sourceTree': TREE, 'servicesUpdated': ['api', 'admin'], 'migrationApplied': False,
                'newMigrations': [], 'previousRelease': str(origin), 'previousCommit': COMMIT,
                'backupBeforeRelease': original_manifest['backupBeforeRelease'],
                'dataAuditBefore': original_manifest['dataAuditBefore'], 'dataAuditAfter': original_manifest['dataAuditAfter'],
                'images': {name: {'reference': row['reference'], 'digest': row['image'], 'sourceCommit': OLD if name in scope.UPDATED else OLD}
                           for name, row in after.items() if name in d.SERVICES},
                'apiAdminPublication': {'version': 1, 'scope': 'API_ADMIN', 'buildProofSha256': scope.fingerprint(candidate),
                    'workersPublished': False, 'cacheStatus': 'SKIPPED', 'configurationChanged': False},
                'preservedMigrationOrigin': scope.migration_successor_marker(context)}
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            (controller.BASE / 'current').unlink(); (controller.BASE / 'current').symlink_to(current)
            stack.enter_context(patch.object(scope, 'snapshot', return_value=after))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            stack.enter_context(patch.object(scope, 'verify_running'))
            controller.migration_plan = MagicMock(return_value=[])
            controller.service_state = lambda _directory, name, **kwargs: after[name]
            original_run = controller.run.side_effect
            def inspect(*args, **kwargs):
                if args[:3] == ('docker', 'image', 'inspect') and args[-1] == after['api']['image']:
                    return json.dumps([{'Id': after['api']['image'], 'Architecture': 'amd64', 'Config': {'Labels': {'org.opencontainers.image.revision': OLD}}}])
                return original_run(*args, **kwargs)
            controller.run.side_effect = inspect
            yield controller, current, origin, manifest, record, context, stack

    def test_successor_readback_has_no_new_migration_and_keeps_five_services_task_window_and_origin_proof(self):
        with self.successor_fixture() as (controller, current, origin, manifest, record, context, stack):
            apply = stack.enter_context(patch.object(migration, 'apply_migration'))
            result = scope.readback(controller, OLD)
            self.assertEqual(result['servicesUpdated'], ['api', 'admin'])
            self.assertEqual(result['preservedServiceCount'], 5)
            self.assertTrue(result['migrationPreserved']); self.assertFalse(result['migrationPerformed'])
            self.assertTrue(result['taskHmacMatched']); self.assertTrue(result['windowPreserved'])
            self.assertEqual(result['preservedMigrationOrigin'], scope.migration_successor_marker(context))
            self.assertEqual(manifest['newMigrations'], [])
            apply.assert_not_called()

    def test_second_api_admin_successor_keeps_original_sealed_context_and_rechecks_it(self):
        with self.successor_fixture() as (controller, previous, origin, prior_manifest, prior_record, context, stack):
            commit = '9' * 40
            current = controller.BASE / 'releases/second-successor'; shutil.copytree(previous, current)
            candidate = json.loads((current / scope.PROOF_FILE).read_text()); candidate['commit'] = commit
            before = copy.deepcopy(prior_record['after']); after = copy.deepcopy(before)
            override = json.loads((current / 'compose.release.json').read_text())
            for name, row in candidate['images'].items():
                row['reference'] = row['reference'].replace(OLD, commit)
                after[name].update(image=row['imageId'], reference=row['reference'])
                override['services'][name] = {'image': row['reference'], 'pull_policy': 'never'}
            (current / 'compose.release.json').write_text(json.dumps(override))
            record = {**prior_record, 'before': before, 'after': after,
                'buildProofSha256': scope.fingerprint(candidate),
                'configurationBefore': scope.configuration_hashes(previous),
                'configurationAfter': scope.configuration_hashes(current)}
            manifest = {**prior_manifest, 'commit': commit, 'previousCommit': OLD, 'previousRelease': str(previous),
                'images': {name: {'reference': row['reference'], 'digest': row['image'],
                    'sourceCommit': commit if name in scope.UPDATED else OLD}
                    for name, row in after.items() if name in d.SERVICES},
                'apiAdminPublication': {**prior_manifest['apiAdminPublication'], 'buildProofSha256': scope.fingerprint(candidate)}}
            (current / scope.PROOF_FILE).write_text(json.dumps(candidate))
            (current / scope.STATE_FILE).write_text(json.dumps(record))
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            (controller.BASE / 'current').unlink(); (controller.BASE / 'current').symlink_to(current)
            stack.enter_context(patch.object(scope, 'snapshot', return_value=after))
            stack.enter_context(patch.object(scope, 'workspace_existing', return_value=False))
            controller.service_state = lambda _directory, name, **kwargs: after[name]
            original_run = controller.run.side_effect
            def inspect(*args, **kwargs):
                if args[:3] == ('docker', 'image', 'inspect') and args[-1] == after['api']['image']:
                    return json.dumps([{'Id': after['api']['image'], 'Architecture': 'amd64', 'Config': {'Labels': {
                        'org.opencontainers.image.revision': commit}}}])
                return original_run(*args, **kwargs)
            controller.run.side_effect = inspect
            guard = stack.enter_context(patch.object(scope, 'migration_successor_guard', wraps=scope.migration_successor_guard))
            result = scope.readback(controller, commit)
            self.assertEqual(result['preservedMigrationOrigin'], scope.migration_successor_marker(context))
            self.assertEqual(record['migrationOrigin']['release'], str(origin))
            self.assertTrue(result['migrationPreserved']); self.assertFalse(result['migrationPerformed'])
            self.assertGreaterEqual(guard.call_count, 2)
            self.assertTrue(all(call.args[2] == context for call in guard.call_args_list))
            manifest.pop('preservedMigrationOrigin'); record.pop('migrationOrigin')
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            (current / scope.STATE_FILE).write_text(json.dumps(record))
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ORIGIN_CHANGED'): scope.readback(controller, commit)
            manifest['preservedMigrationOrigin'] = scope.migration_successor_marker(context)
            record['migrationOrigin'] = context
            (current / 'release-manifest.json').write_text(json.dumps(manifest))
            (current / scope.STATE_FILE).write_text(json.dumps(record))
            (origin / migration.MIGRATION_SCHEMA).write_text('changed original schema')
            with self.assertRaises(RuntimeError): scope.readback(controller, commit)

    def test_successor_cannot_drop_marker_task_guard_or_backup_validation(self):
        for change in ('marker', 'context', 'backup', 'check-task'):
            with self.subTest(change=change), self.successor_fixture() as (controller, current, origin, manifest, record, context, stack):
                if change == 'marker': manifest.pop('preservedMigrationOrigin'); (current / 'release-manifest.json').write_text(json.dumps(manifest))
                elif change == 'context': record.pop('migrationOrigin'); (current / scope.STATE_FILE).write_text(json.dumps(record))
                elif change == 'backup': (current / 'backup-verification.json').write_text('{}')
                with self.assertRaises(RuntimeError): scope.readback(controller, OLD, check_task=change != 'check-task')

    def test_two_image_release_preserves_original_migration_context_without_running_migrate(self):
        with self.fixture() as (original, directory, *_):
            context = scope.migration_successor_origin(original, directory)
            code, result, controller, manifest, _ = ReleaseFailureTests().run_release(migration_origin=context)
            self.assertEqual(code, 0)
            self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['admin', 'api'])
            self.assertEqual(manifest['preservedMigrationOrigin'], scope.migration_successor_marker(context))
            self.assertEqual(manifest['newMigrations'], []); self.assertFalse(manifest['migrationApplied'])
            self.assertGreaterEqual(controller.migration_origin_guard.call_count, 6)
            self.assertEqual(len([command for command in controller.commands if command[:2] == ('docker', 'pull')]), 2)

    def test_new_task_or_window_after_api_switch_blocks_resource_rollback(self):
        with self.fixture() as (original, directory, *_):
            context = scope.migration_successor_origin(original, directory)
            changed = False
            def after_api():
                nonlocal changed
                changed = True
            def guard(*args):
                if changed: raise RuntimeError('API_ADMIN_REGISTRATION_TASK_CHANGED')
            code, result, controller, manifest, persisted = ReleaseFailureTests().run_release(
                migration_origin=context, migration_origin_guard=guard, after_api=after_api)
            self.assertEqual(code, 1)
            self.assertEqual(result['status'], 'API_ADMIN_PARTIAL_RECOVERY_REQUIRED')
            self.assertEqual(result['servicesAttempted'], ['admin', 'api'])
            self.assertFalse(result['rollbackOk']); self.assertTrue(persisted)
            controller.rollback_service.assert_not_called()
            controller.point_current.assert_not_called()

    def test_origin_drift_before_pull_stops_publication_and_healthy_failure_rolls_back_only_two(self):
        with self.fixture() as (original, directory, *_):
            context = scope.migration_successor_origin(original, directory)
            def guard(_controller, path, _context):
                if path.name != 'previous': raise RuntimeError('API_ADMIN_MIGRATION_PRESERVATION_CHANGED')
            code, result, controller, manifest, _ = ReleaseFailureTests().run_release(migration_origin=context, migration_origin_guard=guard)
            self.assertEqual(code, 1); self.assertEqual(result['servicesAttempted'], [])
            controller.compose.assert_not_called()
            self.assertFalse(any(command[:2] == ('docker', 'pull') for command in controller.commands))
            code, result, controller, manifest, _ = ReleaseFailureTests().run_release(migration_origin=context, fail_at='api-health')
            self.assertEqual(code, 1); self.assertEqual(result['status'], 'API_ADMIN_FAILED_RESTORED')
            self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['api', 'admin'])



class WorkspaceDiagnosticTests(unittest.TestCase):
    def test_current_api_admin_image_and_content_failures_have_bounded_steps_and_preserve_gate(self):
        for service in ('api', 'admin'):
            for step in ('RUNTIME_IMAGE', 'RUNTIME_CONTENT'):
                with self.subTest(service=service, step=step), tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                    base = Path(temporary); current = base / 'releases/current'; current.mkdir(parents=True)
                    (base / 'current').symlink_to(current)
                    candidate = proof(); before = states()
                    content = {'api': '1' * 64 + '  /app/apps/api/dist/main.js',
                        'admin': '2' * 64 + '  /usr/share/nginx/html/index.html'}
                    for name, row in candidate['images'].items():
                        before[name].update(image=row['imageId'], reference=row['reference'])
                        row.update(scope.content_summary(d, name, content[name]))
                    manifest = {'commit': COMMIT, 'sourceTree': TREE, 'apiAdminPublication': {'version': 1},
                        'images': {name: {'reference': row['reference'], 'digest': row['image'], 'sourceCommit': COMMIT}
                            for name, row in before.items() if name in d.SERVICES}}
                    (current / 'release-manifest.json').write_text(json.dumps(manifest))
                    (current / scope.PROOF_FILE).write_text(json.dumps(candidate))
                    controller = SimpleNamespace(**vars(d)); controller.BASE = base
                    controller.api_admin_scope = MagicMock(return_value=(scope, controller))
                    controller.service_state = lambda _directory, name, **kwargs: before[name]
                    inspections = 0
                    def inspect(*args, **kwargs):
                        nonlocal inspections
                        inspections += 1
                        selected = next(name for name in scope.UPDATED if before[name]['image'] == args[-1])
                        if inspections > 1 and selected == service and step == 'RUNTIME_IMAGE':
                            raise RuntimeError('SENTINEL_PRIVATE_COMMAND_OUTPUT')
                        return json.dumps([{'Id': before[selected]['image'], 'Architecture': 'amd64', 'Config': {'Labels': {
                            'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}])
                    controller.run = inspect
                    def compose(_directory, *args, **kwargs):
                        if args[2] == service and step == 'RUNTIME_CONTENT':
                            raise RuntimeError('SENTINEL_PRIVATE_COMMAND_OUTPUT')
                        return content[args[2]]
                    controller.compose = compose
                    with patch.object(workspace, 'snapshot', return_value=before):
                        with self.assertRaises(workspace.WorkspaceBaselineError) as failed:
                            workspace.baseline(controller, COMMIT)
                    diagnostic = failed.exception.workspaceDiagnostic
                    self.assertEqual(str(failed.exception), 'API_ADMIN_BASELINE_PROJECTION_FAILED')
                    self.assertEqual(diagnostic, {'phase': 'PROJECTION', 'step': step, 'scope': 'API_ADMIN',
                        'service': service, 'errorType': 'RuntimeError', 'rawOutputSuppressed': True})
                    self.assertTrue(workspace.valid_workspace_diagnostic(diagnostic))
                    self.assertFalse(hasattr(controller, '_workspaceBaselineDiagnostic'))
                    self.assertNotIn('SENTINEL', json.dumps(diagnostic))

    def test_missing_retained_migration_image_is_identified_without_bypassing_origin_proof(self):
        with MigrationSuccessorTests().fixture() as (controller, current, manifest, candidate, before, task, private, handoff, stack):
            for name in ('MIGRATION_SUCCESSOR_COMMIT', 'MIGRATION_SUCCESSOR_MANIFEST_SHA', 'MIGRATION_SUCCESSOR_PROOF_SHA'):
                stack.enter_context(patch.object(workspace, name, getattr(scope, name)))
            context = workspace.migration_successor_origin(controller, current)
            controller._workspaceBaselineDiagnostic = {}
            original = controller.run.side_effect
            def inspect(*args, **kwargs):
                if args[:3] == ('docker', 'image', 'inspect') and args[-1] == candidate['images']['migrate']['reference']:
                    raise RuntimeError('SENTINEL_PRIVATE_IMAGE_ERROR')
                return original(*args, **kwargs)
            controller.run.side_effect = inspect
            with self.assertRaisesRegex(RuntimeError, 'SENTINEL_PRIVATE_IMAGE_ERROR'):
                workspace.migration_successor_guard(controller, current, context)
            self.assertEqual(controller._workspaceBaselineDiagnostic,
                {'step': 'MIGRATION_IMAGE', 'service': 'migrate', 'scope': 'API_ADMIN_MIGRATION'})
            handoff.assert_not_called()

    def test_schema_task_idle_and_window_calls_set_safe_steps_before_private_query_failure(self):
        for name, step in [('migration_database_state', 'MIGRATION_SCHEMA'), ('registration_task', 'TASK_IDENTITY'),
                ('jobs_idle', 'JOBS_IDLE'), ('registration_private', 'WINDOW_STATE')]:
            with self.subTest(function=name):
                controller = SimpleNamespace(**vars(d)); controller._workspaceBaselineDiagnostic = {}
                controller.compose = MagicMock(side_effect=RuntimeError('SENTINEL_PRIVATE_QUERY_OUTPUT'))
                controller.current_job_database = MagicMock(return_value='fixture_db')
                with self.assertRaises(Exception):
                    getattr(migration, name)(controller, ROOT)
                self.assertEqual(controller._workspaceBaselineDiagnostic,
                    {'step': step, 'service': 'none', 'scope': 'API_ADMIN_MIGRATION'})

    def test_transport_only_preserves_exact_workspace_diagnostic_enums(self):
        diagnostic = {'phase': 'PROJECTION', 'step': 'MIGRATION_IMAGE', 'service': 'migrate',
            'scope': 'API_ADMIN_MIGRATION', 'errorType': 'RuntimeError', 'rawOutputSuppressed': True}
        receipt = {'status': 'API_ADMIN_WORKSPACE_VERIFICATION_FAILED', 'code': 'API_ADMIN_BASELINE_PROJECTION_FAILED',
            'errorType': 'WorkspaceBaselineError', 'workspaceDiagnostic': diagnostic}
        self.assertEqual(transport.safe_failure(receipt, 'API_ADMIN_WORKSPACE'), receipt)
        for field, value in [('phase', 'SENTINEL'), ('step', []), ('service', 'secret-service'),
                ('scope', 'OTHER'), ('errorType', 'PRIVATE_ERROR'), ('rawOutputSuppressed', False), ('extra', 'SENTINEL')]:
            changed = {**diagnostic, field: value}
            self.assertFalse(workspace.valid_workspace_diagnostic(changed))
            self.assertNotIn('workspaceDiagnostic', transport.safe_failure(
                {**receipt, 'workspaceDiagnostic': changed}, 'API_ADMIN_WORKSPACE'))
        legacy = {**receipt, 'status': 'API_ADMIN_VERIFICATION_FAILED'}
        self.assertNotIn('workspaceDiagnostic', transport.safe_failure(legacy))


class WorkspaceScopeTests(unittest.TestCase):
    def test_existing_workspace_detection_includes_configuration_mount_and_retained_orphan_volume(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            directory = Path(temporary)
            api = {'Config': {'Labels': {'com.docker.compose.project': 'fixture'}}, 'Mounts': []}
            found = ''
            def run(*args):
                if args[:2] == ('docker', 'inspect'): return json.dumps([api])
                if args[:3] == ('docker', 'volume', 'ls'): return found
                raise AssertionError(args)
            controller = SimpleNamespace(require=d.require, run=run,
                service_state=MagicMock(return_value={'containerId': '1' * 64}))
            self.assertFalse(workspace.workspace_existing(controller, directory))
            found = 'fixture_auto_registration_data'
            self.assertTrue(workspace.workspace_existing(controller, directory))
            found = ''
            api['Mounts'] = [{'Destination': workspace.WORKSPACE_DIRECTORY}]
            self.assertTrue(workspace.workspace_existing(controller, directory))
            api['Mounts'] = []
            path = directory / workspace.CONFIG_FILES[0]
            path.write_bytes(b'volumes:\n  auto_registration_data:\n')
            self.assertTrue(workspace.workspace_existing(controller, directory))
            path.unlink()
            found = 'unexpected-volume'
            with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_VOLUME_CHANGED'):
                workspace.workspace_existing(controller, directory)
            found = ''
            api['Config']['Labels'] = {}
            with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_PROJECT_INVALID'):
                workspace.workspace_existing(controller, directory)

    def test_old_api_modes_reject_existing_workspace_before_audit_or_service_switch(self):
        for selected in (scope, migration, registration):
            for kind in ('configured', 'mounted', 'orphan-volume'):
                with self.subTest(scope=selected.SCOPE, kind=kind), tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
                    base = Path(temporary); current = base / 'releases/current'; current.mkdir(parents=True)
                    (base / 'current').symlink_to(current)
                    (current / 'release-manifest.json').write_text(json.dumps({'commit': COMMIT}))
                    if kind == 'configured':
                        (current / selected.CONFIG_FILES[0]).write_bytes(b'volumes:\n  auto_registration_data:\n')
                    api = {'Config': {'Labels': {'com.docker.compose.project': 'fixture'}},
                        'Mounts': [{'Destination': workspace.WORKSPACE_DIRECTORY}] if kind == 'mounted' else []}
                    def run(*args):
                        if args[:2] == ('docker', 'inspect'): return json.dumps([api])
                        if args[:3] == ('docker', 'volume', 'ls'):
                            return 'fixture_auto_registration_data' if kind == 'orphan-volume' else ''
                        raise AssertionError(args)
                    controller = SimpleNamespace(BASE=base, require=d.require, run=run,
                        service_state=MagicMock(return_value={'containerId': '1' * 64}), compose=MagicMock())
                    with patch.object(selected, 'snapshot', return_value=states()), \
                         patch.object(selected, 'strict_audit') as audit:
                        with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_SCOPE_REQUIRED$'):
                            selected.baseline(controller, COMMIT)
                        audit.assert_not_called(); controller.compose.assert_not_called()

    def test_ordinary_release_requires_workspace_scope_and_admin_only_never_reads_api_or_volume(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            previous, candidate = (Path(temporary) / name for name in ('previous', 'candidate'))
            previous.mkdir(); candidate.mkdir()
            controller = SimpleNamespace(require=d.require)
            with patch.object(d, 'api_admin_scope', return_value=(workspace, controller)), \
                 patch.object(workspace, 'workspace_existing', return_value=True) as exists:
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_SCOPE_REQUIRED$'):
                    d.require_workspace_publication_scope(previous, candidate)
                exists.return_value = False
                d.require_workspace_publication_scope(previous, candidate)
                (candidate / workspace.CONFIG_FILES[0]).write_bytes(b'volumes:\n  auto_registration_data:\n')
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_WORKSPACE_SCOPE_REQUIRED$'):
                    d.require_workspace_publication_scope(previous, candidate)
                exists.reset_mock()
                d.require_workspace_publication_scope(previous, candidate, admin_only=True)
                exists.assert_not_called()
        import ast
        tree = ast.parse((ROOT / 'scripts/production-release/remote-deploy.py').read_bytes())
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        calls = [(node.func.id, node.lineno) for node in ast.walk(main)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        guard_line = next(line for name, line in calls if name == 'require_workspace_publication_scope')
        self.assertLess(guard_line, next(line for name, line in calls if name == 'run_release_migrations'))

    def test_old_api_release_modes_reject_candidate_workspace_configuration_before_switch(self):
        for selected in (scope, migration):
            with self.subTest(scope=selected.SCOPE):
                code, result, controller, manifest, _ = ReleaseFailureTests().run_release(
                    selected_scope=selected, candidate_workspace=True)
                self.assertEqual(code, 1)
                self.assertEqual(result['code'], 'API_ADMIN_WORKSPACE_SCOPE_REQUIRED')
                self.assertEqual(result['servicesAttempted'], [])
                controller.compose.assert_not_called()
                self.assertFalse(any(command[:2] == ('docker', 'pull') for command in controller.commands))

    def test_three_services_only_two_fresh_images_and_old_modes_unchanged(self):
        self.assertEqual(workspace.UPDATED, ('api', 'admin', 'caddy'))
        self.assertEqual(workspace.IMAGE_SERVICES, ('api', 'admin'))
        self.assertEqual(workspace.SWITCH_ORDER, ('admin', 'api', 'caddy'))
        self.assertEqual(scope.UPDATED, ('api', 'admin'))
        self.assertEqual(migration.IMAGE_SERVICES, ('api', 'admin', 'migrate'))
        self.assertEqual(transport.selected_scope('release_api_workspace'), 'API_ADMIN_WORKSPACE')
        self.assertEqual(d.api_admin_scope('API_ADMIN_WORKSPACE')[0].PREFIX, 'api-workspace')

    @contextmanager
    def config_fixture(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            previous, candidate = (Path(temporary) / name for name in ('previous', 'candidate'))
            for directory in (previous, candidate):
                directory.mkdir()
                for name in scope.CONFIG_FILES:
                    path = directory / name; path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes((WORKSPACE_SOURCE_ROOT / name).read_bytes())
            yield previous, candidate

    def test_configuration_allows_only_exact_api_mount_and_reviewed_caddy_bytes(self):
        with self.config_fixture() as (previous, candidate):
            expected = workspace.workspace_configuration(d, previous, candidate)
            self.assertEqual(expected, workspace_proof()['configuration'])
            original = (candidate / scope.CONFIG_FILES[0]).read_bytes()
            for changed in (original.replace(b'    read_only: true', b'    read_only: false', 1),
                original.replace(b'auto_registration_data:/app/.runtime/auto-registration', b'auto_registration_data:/tmp/workspace'),
                original.replace(b'  auto_registration_data:\n', b'  auto_registration_data:\n    driver: remote\n'),
                original.replace(b'      NODE_ENV: production', b'      NODE_ENV: development', 1)):
                (candidate / scope.CONFIG_FILES[0]).write_bytes(changed)
                with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_CONFIG_CHANGED'):
                    workspace.workspace_configuration(d, previous, candidate)
            (candidate / scope.CONFIG_FILES[0]).write_bytes(original)
            path = candidate / scope.CONFIG_FILES[1]
            path.write_bytes(path.read_bytes() + b'\n# unreviewed edge change\n')
            with self.assertRaisesRegex(RuntimeError, 'WORKSPACE_EDGE_CHANGED'):
                workspace.workspace_configuration(d, previous, candidate)

    def test_proof_includes_python_venv_css_and_offline_acceptance_but_never_runtime_data(self):
        command = workspace.content_command('api')
        for root in workspace.WORKSPACE_API_ROOTS:
            self.assertIn(root, command)
        self.assertNotIn('.runtime', command)
        self.assertNotIn('/opt/id-registration/venv', scope.content_command('api'))
        value = workspace_proof()
        workspace.validate_proof(d, value, COMMIT, TREE, REPOSITORY, '123', '1')
        for change in ('acceptance', 'configuration', 'caddy-image', 'other-attempt'):
            candidate = copy.deepcopy(value)
            if change == 'acceptance': candidate['acceptance']['businessActions'] = 1
            elif change == 'configuration': candidate['configuration']['caddySha256'] = '0' * 64
            elif change == 'caddy-image': candidate['images']['caddy'] = candidate['images']['admin']
            else: candidate['images']['api']['reference'] = candidate['images']['api']['reference'].replace('-123-1-', '-123-2-')
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                workspace.validate_proof(d, candidate, COMMIT, TREE, REPOSITORY, '123', '1')
        with self.assertRaises(RuntimeError): scope.validate_proof(d, value, COMMIT, TREE)
        for path in ('/app/.runtime/auto-registration/database.db', '/app/.runtime/auto-registration/logs/private.log'):
            with self.assertRaises(RuntimeError): workspace.content_summary(d, 'api', '1' * 64 + '  ' + path)

    @contextmanager
    def volume_fixture(self, *, exists=True):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            root = Path(temporary).resolve()
            name = 'fixture_' + workspace.WORKSPACE_VOLUME
            api = {'Config': {'Labels': {'com.docker.compose.project': 'fixture'}},
                   'Mounts': [{'Type': 'volume', 'Name': name, 'Destination': workspace.WORKSPACE_DIRECTORY, 'RW': True}]}
            value = {'Name': name, 'Driver': 'local', 'Scope': 'local', 'Mountpoint': str(root),
                     'Labels': {'com.docker.compose.project': 'fixture', 'com.docker.compose.volume': workspace.WORKSPACE_VOLUME},
                     'CreatedAt': 'fixture-created'}
            calls = []
            def run(*args):
                calls.append(args)
                if args[:3] == ('docker', 'volume', 'ls'): return name if exists else ''
                if args[:3] == ('docker', 'volume', 'inspect'): return json.dumps([value])
                if args[:2] == ('docker', 'inspect'): return json.dumps([api])
                raise AssertionError(args)
            controller = SimpleNamespace(require=d.require, run=run,
                service_state=lambda *args, **kw: {'containerId': 'fixture-api'})
            yield controller, root, value, api, calls

    def test_absent_and_empty_volume_allowed_only_attached_identity_can_become_runtime(self):
        with self.volume_fixture(exists=False) as (controller, root, value, api, calls):
            self.assertEqual(workspace.workspace_volume(controller, None, empty=True)['status'], 'ABSENT')
            with self.assertRaisesRegex(RuntimeError, 'VOLUME_MISSING'):
                workspace.workspace_volume(controller, None, attached=True)
        with self.volume_fixture() as (controller, root, value, api, calls):
            before = workspace.workspace_volume(controller, None, empty=True, attached=True)
            (root / 'database.db').write_bytes(b'private fixture')
            self.assertEqual(workspace.workspace_volume(controller, None, attached=True), before)
            with self.assertRaisesRegex(RuntimeError, 'SQLITE_BACKUP_REQUIRED'):
                workspace.workspace_volume(controller, None, empty=True)
            api['Mounts'][0]['RW'] = False
            with self.assertRaisesRegex(RuntimeError, 'MOUNT_CHANGED'):
                workspace.workspace_volume(controller, None, attached=True)
            self.assertFalse(any(args[:3] == ('docker', 'volume', 'rm') for args in calls))

    def test_volume_project_driver_and_name_drift_fail_closed(self):
        for key, changed in [('Driver', 'remote'), ('Name', 'other'), ('Scope', 'global'), ('Labels', {})]:
            with self.volume_fixture() as (controller, root, value, api, calls):
                value[key] = changed
                with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'VOLUME_CHANGED'):
                    workspace.workspace_volume(controller, None)
        with self.volume_fixture() as (controller, root, value, api, calls):
            api['Config']['Labels']['com.docker.compose.project'] = '../other'
            with self.assertRaisesRegex(RuntimeError, 'PROJECT_INVALID'):
                workspace.workspace_volume(controller, None)

    def test_readonly_task_guard_blocks_pending_running_unknown_and_corrupt_database(self):
        for status in ('pending', 'running', 'unknown', 'completed', 'failed', 'cancelled'):
            with self.volume_fixture() as (controller, root, value, api, calls):
                database = root / 'database.db'
                with sqlite3.connect(database) as connection:
                    connection.execute('CREATE TABLE registration_tasks (status TEXT, result TEXT)')
                    connection.execute('INSERT INTO registration_tasks VALUES (?,?)', (status, 'PRIVATE_SENTINEL'))
                original = database.read_bytes()
                if status in ('completed', 'failed', 'cancelled'):
                    workspace.workspace_idle(controller, None)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'TASK_ACTIVE'):
                        workspace.workspace_idle(controller, None)
                self.assertEqual(database.read_bytes(), original)
                self.assertNotIn('PRIVATE_SENTINEL', json.dumps(calls))
        with self.volume_fixture() as (controller, root, value, api, calls):
            (root / 'database.db').write_bytes(b'corrupt fixture')
            with self.assertRaisesRegex(RuntimeError, 'TASK_STATE_UNAVAILABLE'):
                workspace.workspace_idle(controller, None)

    def test_offline_acceptance_cleans_only_new_run_volume_on_pass_and_fail(self):
        for passing in (True, False):
            calls = []
            result = {key: value for key, value in workspace_proof()['acceptance'].items() if key != 'temporaryVolumeRemoved'}
            def run(*args, **kwargs):
                calls.append(args)
                if args[:3] == ('docker', 'volume', 'ls'): return ''
                if args[:3] == ('docker', 'volume', 'inspect'):
                    return json.dumps([{'Name': 'id-workspace-acceptance-123-1', 'Labels': {'id-business-v2.acceptance': '123-1'}}])
                if args[:2] == ('docker', 'run'):
                    if not passing: raise RuntimeError('fixture acceptance failed')
                    return json.dumps(result)
                return ''
            controller = SimpleNamespace(require=d.require, run=run)
            if passing:
                self.assertTrue(workspace.workspace_acceptance(controller, 'fixture-image', '123', '1')['temporaryVolumeRemoved'])
            else:
                with self.assertRaises(RuntimeError): workspace.workspace_acceptance(controller, 'fixture-image', '123', '1')
            removals = [args for args in calls if args[:3] == ('docker', 'volume', 'rm')]
            self.assertEqual(removals, [('docker', 'volume', 'rm', 'id-workspace-acceptance-123-1')])
            launch = next(args for args in calls if args[:2] == ('docker', 'run'))
            self.assertIn('none', launch); self.assertIn('--read-only', launch)
            self.assertNotIn('auto_registration_data', removals[0][-1])

    def test_success_switches_admin_api_caddy_preserves_workers_mysql_and_volume(self):
        code, result, controller, manifest, _ = ReleaseFailureTests().run_release(selected_scope=workspace)
        self.assertEqual(code, 0)
        self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['admin', 'api', 'caddy'])
        self.assertTrue(all('--no-deps' in call.args for call in controller.compose.call_args_list))
        self.assertEqual(manifest['servicesUpdated'], ['api', 'admin', 'caddy'])
        self.assertEqual(manifest['newMigrations'], []); self.assertFalse(manifest['migrationApplied'])
        self.assertFalse(manifest['apiWorkspacePublication']['volumeDeletionPerformed'])
        self.assertEqual(manifest['images']['auto-registration']['sourceCommit'], OLD)
        self.assertEqual(len([args for args in controller.commands if args[:2] == ('docker', 'pull')]), 2)
        self.assertFalse(any(args[:3] == ('docker', 'volume', 'rm') for args in controller.commands))
        controller.rollback_service.assert_not_called()

    def test_caddy_validation_uses_disposable_bounded_storage_and_preserves_runtime_isolation(self):
        code, result, controller, manifest, _ = ReleaseFailureTests().run_release(selected_scope=workspace)
        self.assertEqual(code, 0)
        validations = [args for args in controller.commands if args[:2] == ('docker', 'run') and 'validate' in args]
        self.assertEqual(len(validations), 1)
        command = validations[0]
        self.assertEqual(command[2:6], ('--rm', '--network', 'none', '--read-only'))
        tmpfs = [command[index + 1] for index, value in enumerate(command) if value == '--tmpfs']
        self.assertEqual(tmpfs, ['/data:rw,noexec,nosuid,nodev,size=16m', '/config:rw,noexec,nosuid,nodev,size=16m'])
        mounts = [command[index + 1] for index, value in enumerate(command) if value == '--mount']
        self.assertEqual(len(mounts), 1)
        self.assertTrue(mounts[0].startswith('type=bind,source='))
        self.assertTrue(mounts[0].endswith('/deploy/caddy/Caddyfile.aws,target=/etc/caddy/Caddyfile,readonly'))
        self.assertEqual(command[command.index('--env') + 1], 'APP_DOMAIN=workspace-acceptance.local')
        self.assertEqual(command[-7:], ('caddy', states()['caddy']['image'], 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'))
        self.assertFalse(any(value in command for value in ('--volume', '-v', '--privileged', '--network=host')))
        self.assertFalse(any('caddy_data' in value or 'caddy_config' in value for value in command))

    def test_caddy_validation_failure_is_controlled_before_any_pull_or_service_switch(self):
        code, result, controller, manifest, persisted = ReleaseFailureTests().run_release(
            selected_scope=workspace, fail_at='caddy-validation')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'API_ADMIN_WORKSPACE_FAILED_BEFORE_SWITCH')
        self.assertEqual(result['step'], 'source')
        self.assertEqual(result['code'], 'API_ADMIN_WORKSPACE_CADDY_VALIDATION_FAILED')
        self.assertEqual(result['servicesAttempted'], [])
        self.assertTrue(result['rollbackOk']); self.assertTrue(persisted)
        self.assertFalse(result['currentPointsToCandidate']); self.assertIsNone(manifest)
        self.assertFalse(result['volumeDeletionPerformed'])
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))
        controller.compose.assert_not_called(); controller.rollback_service.assert_not_called()
        self.assertFalse(any(args[:2] == ('docker', 'pull') for args in controller.commands))
        self.assertFalse(any(args[:3] == ('docker', 'volume', 'rm') for args in controller.commands))

    def test_failure_restores_three_only_and_active_new_task_blocks_api_rollback(self):
        code, result, controller, manifest, _ = ReleaseFailureTests().run_release(selected_scope=workspace, fail_at='caddy-health')
        self.assertEqual(code, 1); self.assertEqual(result['status'], 'API_ADMIN_WORKSPACE_FAILED_RESTORED')
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['caddy', 'api', 'admin'])
        self.assertFalse(result['volumeDeletionPerformed'])
        code, result, controller, manifest, _ = ReleaseFailureTests().run_release(selected_scope=workspace, workspace_busy=True)
        self.assertEqual(code, 1); self.assertEqual(result['status'], 'API_ADMIN_WORKSPACE_PARTIAL_RECOVERY_REQUIRED')
        self.assertEqual(result['rollback']['api'], 'BLOCKED_OR_FAILED')
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['admin'])
        self.assertFalse(result['volumeDeletionPerformed'])

    def test_pinned_transport_and_selection_do_not_admit_history_reuse_or_cache(self):
        names = ('remote-deploy.py', 'api-admin-scope.py', 'online-recharge-scope.py',
                 'online-recharge-recovery.json', 'api-admin-pending-projection.py',
                 'api-admin-readonly.py', 'api-admin-pending-receipt-wire.py')
        for mode in ('preflight', 'readback'):
            with self.subTest(mode=mode):
                commands = transport.parameters(COMMIT, OLD, mode, 'API_ADMIN_WORKSPACE')['commands']
                downloads = [line for line in commands if line.startswith('curl ')]
                checksums = [line for line in commands if 'sha256sum -c -' in line]
                self.assertEqual(len(downloads), len(names))
                self.assertEqual(len(checksums), len(names))
                self.assertEqual([line.rsplit('/', 1)[-1] for line in downloads], list(names))
                for name, download, checksum in zip(names, downloads, checksums):
                    digest = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                    self.assertIn('/' + COMMIT + '/scripts/production-release/' + name, download)
                    self.assertIn(digest + '  ', checksum)
                    self.assertNotIn('/' + OLD + '/', download)
                self.assertIn('--api-workspace-' + mode, commands[-1])
        script = ROOT / 'scripts/production-release/validate-release-selection.sh'
        for operation in ('verify_api_workspace', 'release_api_workspace'):
            base = {'RELEASE_OPERATION': operation, 'HISTORICAL_EXCEPTION': 'none'}
            self.assertEqual(subprocess.run(['bash', str(script)], env=base, capture_output=True).returncode, 0)
            for key in ('REUSE_IMAGE_RUN', 'ORDER_ARCHIVE_SEAL_SHA256', 'POST_CLEANUP_SEAL_SHA256',
                        'RELEASE_BROWSER_CACHE_IMAGE', 'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID'):
                self.assertNotEqual(subprocess.run(['bash', str(script)], env={**base, key: 'fixture'}, capture_output=True).returncode, 0)
            self.assertNotEqual(subprocess.run(['bash', str(script)], env={**base, 'HISTORICAL_EXCEPTION': 'historical-finance-20261005'}, capture_output=True).returncode, 0)


    def test_workspace_independent_receipt_binds_exact_proof_volume_and_actual_health(self):
        value = workspace_proof()
        receipt = {'status': 'API_ADMIN_WORKSPACE_VERIFIED', 'commit': COMMIT, 'sourceTree': TREE,
            'buildProofSha256': workspace.fingerprint(value), 'servicesUpdated': list(workspace.UPDATED),
            'preservedServiceCount': 4, 'runningImagesAndContentMatched': True, 'environmentUnchanged': True,
            'workspaceVolume': {'name': 'fixture_auto_registration_data', 'status': 'PRESENT', 'identitySha256': '6' * 64},
            'volumePreserved': True, 'volumeDeletionPerformed': False, 'registrationHealthChecked': True,
            'offlineAcceptance': value['acceptance'],
            'services': {name: {'image': row['imageId'], 'reference': row['reference']} for name, row in value['images'].items()}}
        with patch.object(Path, 'read_text', return_value=json.dumps(value)):
            transport.validate_receipt(receipt, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')
            protection={'backupVerified':True,'restoreVerified':True,'sqliteProtectionSha256':'7'*64,
                'backupSha256':'8'*64,'backupSize':4096}
            transport.validate_receipt({**receipt,'sqliteProtection':protection},COMMIT,'readback','API_ADMIN_WORKSPACE')
            for change in ({'backupSize':False},{'restoreVerified':False},{'backupSha256':'not-a-hash'},
                    {'backupSize':256*1024**2+1},{'privateData':'PRIVATE_SENTINEL'}):
                with self.subTest(protection=change),self.assertRaisesRegex(RuntimeError,'SQLITE_RECEIPT_CHANGED'):
                    transport.validate_receipt({**receipt,'sqliteProtection':{**protection,**change}},
                        COMMIT,'readback','API_ADMIN_WORKSPACE')
            for field, changed in [('preservedServiceCount', 5), ('registrationHealthChecked', False),
                ('volumeDeletionPerformed', True), ('workspaceVolume', {}), ('offlineAcceptance', {})]:
                with self.subTest(field=field), self.assertRaises(RuntimeError):
                    transport.validate_receipt({**receipt, field: changed}, COMMIT, 'readback', 'API_ADMIN_WORKSPACE')

    def test_workspace_dispatch_uses_only_new_scope_and_exact_runner_proof(self):
        import ast
        import gzip
        import shlex
        text = (ROOT / 'scripts/production-release/dispatch.sh').read_text()
        program = text.split('python3 - "$parameters_file" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
        environment = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'EXPECTED_CURRENT': OLD,
            'RELEASE_REPOSITORY': REPOSITORY, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'QUALITY_RUN_ID': '456', 'RELEASE_OPERATION': 'release_api_workspace', 'HISTORICAL_EXCEPTION': 'none'}
        original_read = Path.read_bytes
        def local_proof(path):
            return json.dumps(workspace_proof()).encode() if path.name == 'api-workspace-build-proof.json' else original_read(path)
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.dict(os.environ, environment, clear=True), \
             patch.object(sys, 'argv', ['generate', str(Path(temporary) / 'parameters.json')]), \
             patch.object(Path, 'read_bytes', local_proof):
            exec(compile(program, 'workspace-dispatch', 'exec'), {'__name__': '__test__'})
            lines = json.loads((Path(temporary) / 'parameters.json').read_text())['commands']
            commands = '\n'.join(lines)
        self.assertIn('--api-workspace-only --api-admin-build-proof ', commands)
        self.assertNotIn('--image-commit', commands)
        self.assertNotIn('--historical-', commands)
        self.assertEqual(commands.count('sha256sum -c -'), 0)
        carrier = next(line for line in lines if line.startswith('python3 -B -c '))
        bootstrap = ast.parse(shlex.split(carrier)[3])
        payload = next(node.args[0].value for node in ast.walk(bootstrap)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'b85decode')
        parsed = ast.parse(gzip.decompress(base64.b85decode(payload)).decode())
        stores = [node for node in ast.walk(parsed) if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name) and node.func.id == '_store_files']
        self.assertEqual(len(stores), 2)
        self.assertEqual([ast.literal_eval(node.args[1]) for node in stores], [COMMIT, COMMIT])
        self.assertEqual([ast.literal_eval(node.args[3]) for node in stores], [False, True])
        self.assertEqual([ast.literal_eval(node.args[0]) for node in stores],
            ['/opt/id-business-v2/.staging/oidc-' + COMMIT,
             '/opt/id-business-v2/.staging/oidc-' + COMMIT + '/formal-runtime-package'])
        self.assertNotIn('--reuse-image-run', commands)
        controllers, package = [ast.literal_eval(node.args[2]) for node in stores]
        self.assertEqual(set(controllers), set(transport.FORMAL_RUNTIME_CONTROLLERS))
        self.assertEqual(set(package), set(transport.FORMAL_RUNTIME_FILES))
        for name, digest in controllers.items():
            self.assertEqual(digest, hashlib.sha256((ROOT / 'scripts/production-release' / name).read_bytes()).hexdigest())
        for name, digest in package.items():
            self.assertEqual(digest, hashlib.sha256((ROOT / 'scripts/production-release/formal-runtime-package' / name).read_bytes()).hexdigest())

    def test_workspace_origin_still_rechecks_original_migration_proof_and_fails_on_task_drift(self):
        with MigrationSuccessorTests().fixture() as (controller, current, manifest, candidate, before, task, private, handoff, stack):
            for name in ('MIGRATION_SUCCESSOR_COMMIT', 'MIGRATION_SUCCESSOR_MANIFEST_SHA', 'MIGRATION_SUCCESSOR_PROOF_SHA'):
                stack.enter_context(patch.object(workspace, name, getattr(scope, name)))
            context = workspace.migration_successor_origin(controller, current)
            self.assertEqual(context['migrationState']['status'], 'APPLIED')
            workspace.migration_successor_guard(controller, current, context)
            task.return_value = {**migration_task(), 'jobHmac': '8' * 64}
            with self.assertRaises(RuntimeError): workspace.migration_successor_guard(controller, current, context)
            handoff.assert_not_called()

    def test_workspace_health_fetches_running_api_not_a_second_fixture_worker(self):
        controller = SimpleNamespace(require=d.require, compose=MagicMock(return_value='{"ready":true}'))
        workspace.workspace_health(controller, ROOT)
        arguments = controller.compose.call_args.args
        self.assertIn('exec', arguments); self.assertIn('api', arguments)
        self.assertIn('http://127.0.0.1:3000/api/health/ready', arguments[-1])
        self.assertNotIn('workspace.py', arguments[-1])
        controller.compose.return_value = '{"ready":false}'
        with self.assertRaisesRegex(RuntimeError, 'HEALTH_FAILED'): workspace.workspace_health(controller, ROOT)


class OnlineWorkspaceCompatibilityTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            base=Path(temporary).resolve();previous=base/'releases/origin';current=base/'releases/current'
            for directory in (previous,current):
                directory.mkdir(parents=True);(directory/workspace.CONFIG_FILES[0]).write_bytes((ROOT/workspace.CONFIG_FILES[0]).read_bytes())
                (directory/'.env.aws.production').write_text('APP_DOMAIN=fixture.example\n')
                (directory/'compose.release.json').write_text('{"services":{}}')
                (directory/workspace.CONFIG_FILES[1]).parent.mkdir(parents=True)
                (directory/workspace.CONFIG_FILES[1]).write_bytes((ROOT/workspace.CONFIG_FILES[1]).read_bytes())
            original=states();original['online-recharge']=copy.deepcopy(original['api'])
            metadata={};calls=[]
            for index,(name,row) in enumerate(original.items(),1):
                row['containerId']=hex(index)[2:]*64;row['startedAtSha256']='1'*64
                metadata[row['containerId']]={'Id':row['containerId'],'Image':row['image'],
                    'Config':{'Env':['NODE_ENV=production'],'Image':row['reference'],'Labels':{}},
                    'State':{'Running':True,'StartedAt':'2026-10-09T00:00:00Z'},'HostConfig':{},'Mounts':[]}
                row['startedAtSha256']=hashlib.sha256(metadata[row['containerId']]['State']['StartedAt'].encode()).hexdigest()
            engine=metadata[original['online-recharge']['containerId']]
            engine['Config']['Labels']={'com.docker.compose.project.working_dir':str(previous),
                'com.docker.compose.project.config_files':str(previous/workspace.CONFIG_FILES[0])+','+str(previous/'compose.release.json'),
                'com.docker.compose.project.environment_file':str(previous/'.env.aws.production'),
                'com.docker.compose.service':'online-recharge','com.docker.compose.container-number':'1',
                'com.docker.compose.project':'fixture','com.docker.compose.image':original['online-recharge']['image'],
                'com.docker.compose.config-hash':'1'*64,'com.docker.compose.depends_on':'api:service_healthy:true',
                'protected-label':'fixed'}
            engine['Config']['Hostname']=original['api']['containerId'][:12]
            metadata[original['api']['containerId']]['Config'].update(Hostname=engine['Config']['Hostname'],
                Labels={'com.docker.compose.project':'fixture'})
            engine['HostConfig']={'NetworkMode':'container:'+original['api']['containerId'],'ReadonlyRootfs':True}
            volume={'Name':'fixture_online_recharge_data','Driver':'local','CreatedAt':'fixed','Labels':{'owner':'fixture'}}
            engine['Mounts']=[{'Type':'volume','Name':volume['Name'],'RW':True,'Destination':'/workspace/engine/runtime'}]
            metadata[original['api']['containerId']]['Mounts']=[{'Type':'volume','Name':volume['Name'],'RW':True,'Destination':'/app/.runtime/online-recharge'}]
            def run(*args,**kwargs):
                calls.append((args,kwargs))
                if args[:3]==('docker','volume','inspect'):return json.dumps([volume])
                if args[:2]==('docker','inspect'):return json.dumps([metadata[args[-1]]])
                if args[:2]==('docker','stop'):
                    metadata[args[-1]]['State']['Running']=False;return args[-1]
                raise AssertionError(args)
            controller=SimpleNamespace(BASE=base,require=d.require,ALL_SERVICES=d.ALL_SERVICES,run=run,
                production_services=lambda folder:d.ALL_SERVICES,service_state=lambda folder,name,**kw:copy.deepcopy(original[name]),
                current_job_database=lambda folder:'fixture_database',compose=MagicMock(),wait_healthy=MagicMock(),rollback_service=MagicMock())
            yield SimpleNamespace(base=base,previous=previous,current=current,controller=controller,states=original,
                metadata=metadata,engine=engine,volume=volume,calls=calls)

    def context(self):
        return {'version':1,'release':'/opt/id-business-v2/releases/origin','commit':COMMIT,
            'manifestSha256':'1'*64,'buildProofSha256':'2'*64,
            'files':{n:'1'*64 for n in workspace.ONLINE_ORIGIN_FILES},
            'migrationState':{'name':'20261009093000_online_recharge','sha256':'44966182c1bf38290b01f665a4c2c863b052677c5e0024b900137f1d7f11eb95',
                'status':'APPLIED','schemaVerified':True,'appliedMigrationsSha256':'3'*64},
            'binding':{'image':'sha256:'+'4'*64,'reference':REPOSITORY+':'+COMMIT+'-123-1-online-recharge',
                **{n:'5'*64 for n in ('environmentSha256','configurationSha256','volumeIdentitySha256','apiContainerId','containerId','startedAtSha256')}}}

    def test_workspace_eight_services_leave_historical_seven_service_set_unchanged(self):
        with self.fixture() as f:
            observed=workspace.snapshot(f.controller,f.previous)
            self.assertEqual(set(observed),set(d.ALL_SERVICES)|{'online-recharge'})
            self.assertEqual(tuple(d.ALL_SERVICES),tuple(scope.workspace_service_names(d,ROOT)))
            self.assertEqual(len(scope.snapshot(f.controller,f.previous)),7)

    def test_compose_projection_preserves_exact_online_bytes_and_rejects_any_configuration_change(self):
        with self.fixture() as f:
            workspace.workspace_configuration(f.controller,f.previous,f.current)
            for old,new in ((b'network_mode: service:api',b'network_mode: host'),
                    (b'  online_recharge_data:',b'  unrelated_data:'),(b'read_only: true',b'read_only: false')):
                (f.current/workspace.CONFIG_FILES[0]).write_bytes((f.previous/workspace.CONFIG_FILES[0]).read_bytes().replace(old,new,1))
                with self.assertRaisesRegex(RuntimeError,'WORKSPACE_CONFIG_CHANGED'):
                    workspace.workspace_configuration(f.controller,f.previous,f.current)

    def test_binding_normalizes_only_verified_compose_paths_and_network_target(self):
        with self.fixture() as f:
            before=workspace.online_binding(f.controller,f.previous,f.states)
            labels=f.engine['Config']['Labels'];labels['com.docker.compose.project.working_dir']=str(f.current)
            labels['com.docker.compose.project.config_files']=str(f.current/workspace.CONFIG_FILES[0])+','+str(f.current/'compose.release.json')
            labels['com.docker.compose.project.environment_file']=str(f.current/'.env.aws.production')
            labels['com.docker.compose.config-hash']='2'*64
            labels['com.docker.compose.replace']='online-recharge-1'
            labels['com.docker.compose.depends_on']=''
            after=workspace.online_binding(f.controller,f.current,f.states)
            self.assertEqual(before['configurationSha256'],after['configurationSha256'])
            labels['protected-label']='changed'
            self.assertNotEqual(workspace.online_binding(f.controller,f.current,f.states)['configurationSha256'],before['configurationSha256'])
            labels['com.docker.compose.project.config_files']='unverified-source'
            with self.assertRaisesRegex(RuntimeError,'COMPOSE_ORIGIN_CHANGED'):
                workspace.online_binding(f.controller,f.current,f.states)

    def test_rebound_hostname_must_inherit_new_api_and_generated_metadata_cannot_hide_business_drift(self):
        with self.fixture() as f:
            before=workspace.online_binding(f.controller,f.previous,f.states)
            old=f.states['api']['containerId'];new='e'*64
            f.metadata[new]=copy.deepcopy(f.metadata[old]);f.metadata[new]['Id']=new
            f.metadata[new]['Config']['Hostname']=new[:12];f.states['api']['containerId']=new
            f.engine['HostConfig']['NetworkMode']='container:'+new;f.engine['Config']['Hostname']=new[:12]
            self.assertEqual(workspace.online_binding(f.controller,f.previous,f.states)['configurationSha256'],before['configurationSha256'])
            f.engine['Config']['Hostname']='wrong'
            with self.assertRaisesRegex(RuntimeError,'GENERATED_IDENTITY_CHANGED'):
                workspace.online_binding(f.controller,f.previous,f.states)
        with self.fixture() as f:
            before=workspace.online_binding(f.controller,f.previous,f.states)
            f.engine['HostConfig']['ReadonlyRootfs']=False
            self.assertNotEqual(workspace.online_binding(f.controller,f.previous,f.states)['configurationSha256'],before['configurationSha256'])

    def test_network_volume_and_engine_image_drift_are_rejected(self):
        with self.fixture() as f:
            f.engine['HostConfig']['NetworkMode']='container:'+'9'*64
            with self.assertRaisesRegex(RuntimeError,'BINDING_CHANGED'):workspace.online_binding(f.controller,f.previous,f.states)
        with self.fixture() as f:
            f.engine['Mounts'][0]['Name']='other_online_recharge_data'
            with self.assertRaisesRegex(RuntimeError,'BINDING_CHANGED'):workspace.online_binding(f.controller,f.previous,f.states)
        with self.fixture() as f:
            f.engine['Image']='sha256:'+'9'*64
            with self.assertRaisesRegex(RuntimeError,'BINDING_CHANGED'):workspace.online_binding(f.controller,f.previous,f.states)

    def test_failed_online_publication_cannot_create_a_successor_origin(self):
        with self.fixture() as f:
            reader=SimpleNamespace(readback=MagicMock(return_value={'status':'ONLINE_RECHARGE_FAILED_RESTORED'}))
            with patch.object(workspace,'online_reader',return_value=reader),self.assertRaisesRegex(RuntimeError,'NOT_PUBLISHED'):
                workspace.online_origin(f.controller,f.previous,{'commit':COMMIT},f.states)

    def test_successful_online_readback_seals_actual_source_files_and_original_binding(self):
        with self.fixture() as f:
            for name in workspace.ONLINE_ORIGIN_FILES:
                path=f.previous/name
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text('sealed-fixture')
            state=self.context()['migrationState']
            reader=SimpleNamespace(readback=MagicMock(return_value={'status':'ONLINE_RECHARGE_VERIFIED','services':f.states,
                'migrationApplied':True,'workspaceBackupVerified':True,'backupVerified':True,'buildProofSha256':'2'*64,'migration':state}))
            with patch.object(workspace,'online_reader',return_value=reader),patch.object(workspace,'online_origin_guard') as guard:
                context=workspace.online_origin(f.controller,f.previous,{'commit':OLD},f.states)
            reader.readback.assert_called_once_with(f.controller,OLD)
            self.assertEqual(context['commit'],OLD);self.assertEqual(context['binding']['image'],f.states['online-recharge']['image'])
            self.assertEqual(set(context['files']),set(workspace.ONLINE_ORIGIN_FILES));guard.assert_called_once()

    def test_first_and_repeated_workspace_successors_preserve_same_online_origin_or_fail_closed(self):
        for repeated in (False,True):
            with self.subTest(repeated=repeated),self.fixture() as f,ExitStack() as stack:
                context=self.context();context.update(release=str(f.current),commit=OLD)
                origin_marker=workspace.online_marker(context)
                predecessor={'commit':OLD,**({'apiWorkspacePublication':{},'preservedOnlineRechargeOrigin':origin_marker}
                    if repeated else {'onlineRechargePublication':{'scope':'ONLINE_RECHARGE'}})}
                raw=(json.dumps(predecessor)+'\n').encode();(f.current/'release-manifest.json').write_bytes(raw)
                (f.current/workspace.STATE_FILE).write_text(json.dumps({'onlineRechargeOrigin':context}))
                volume={'name':'fixture_auto_registration_data','status':'PRESENT','identitySha256':'6'*64}
                proof_value=workspace_proof()
                manifest={'commit':COMMIT,'sourceTree':TREE,'previousCommit':OLD,'previousRelease':str(f.current),
                    'previousManifestSha256':hashlib.sha256(raw).hexdigest(),'preservedOnlineRechargeOrigin':origin_marker,
                    'images':{n:{'reference':row['reference'],'digest':row['image'],'sourceCommit':COMMIT} for n,row in f.states.items()},
                    'apiWorkspacePublication':{'version':1,'scope':'API_ADMIN_WORKSPACE','buildProofSha256':workspace.fingerprint(proof_value),
                        'workersPublished':False,'cacheStatus':'SKIPPED','configurationChanged':True,'volume':volume,'volumeDeletionPerformed':False}}
                record={'workspaceVolumeAfter':volume,'onlineRechargeOrigin':context,
                    'baselineEvidence':{'onlineRechargeOrigin':context,'manifestSha256':hashlib.sha256(raw).hexdigest()}}
                (f.previous/'release-manifest.json').write_text(json.dumps(manifest));(f.previous/workspace.STATE_FILE).write_text(json.dumps(record))
                (f.previous/workspace.PROOF_FILE).write_text(json.dumps(proof_value));(f.base/'current').symlink_to(f.previous)
                f.controller.SERVICES=d.SERVICES;run=f.controller.run
                def inspect(*args,**kwargs):
                    if args[:3]==('docker','image','inspect'):
                        return json.dumps([{'Id':f.states['api']['image'],'Config':{'Labels':{'org.opencontainers.image.revision':COMMIT}}}])
                    return run(*args,**kwargs)
                f.controller.run=inspect
                stack.enter_context(patch.object(workspace,'snapshot',return_value=f.states))
                stack.enter_context(patch.object(workspace,'validate_proof',return_value=proof_value))
                stack.enter_context(patch.object(workspace,'verify_running'))
                stack.enter_context(patch.object(workspace,'workspace_volume',return_value=volume))
                stack.enter_context(patch.object(workspace,'online_origin_guard'))
                stack.enter_context(patch.object(workspace.shutil,'disk_usage',return_value=SimpleNamespace(free=20*1024**3)))
                previous,observed,states_value,evidence=workspace.baseline(f.controller,COMMIT,check_jobs=False)
                self.assertEqual(evidence['onlineRechargeOrigin'],context)
                if repeated:
                    (f.current/workspace.STATE_FILE).write_text(json.dumps({'onlineRechargeOrigin':{**context,'buildProofSha256':'9'*64}}))
                else:
                    (f.current/'release-manifest.json').write_text(json.dumps({**predecessor,'commit':'9'*40}))
                with self.assertRaisesRegex(RuntimeError,'ONLINE_ORIGIN_CHANGED'):
                    workspace.baseline(f.controller,COMMIT,check_jobs=False)

    def test_origin_receipt_is_closed_and_preserves_known_migration_identity(self):
        namespace=vars(workspace);context=self.context()
        self.assertEqual(transport.validate_online_origin(namespace,context),workspace.online_marker(context))
        for changed in ({'privateData':'SENTINEL'},{'files':{}},{'migrationState':{**context['migrationState'],'status':'PENDING'}},
                {'binding':{**context['binding'],'image':'sha256:bad'}}):
            with self.subTest(changed=changed),self.assertRaisesRegex(RuntimeError,'ONLINE_ORIGIN_RECEIPT_CHANGED'):
                transport.validate_online_origin(namespace,{**context,**changed})

    def test_retained_quick_action_uses_only_verified_online_history_view(self):
        context=self.context();o=SimpleNamespace(historical_guard=MagicMock())
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            source=Path(temporary);context['release']=str(source)
            (source/'release-manifest.json').write_text(json.dumps({'previousRelease':'/opt/id-business-v2/releases/workspace'}))
            with patch.object(workspace,'online_reader',return_value=o),patch.object(workspace,'migration_successor_guard') as old:
                workspace.preserved_migration_guard(d,ROOT,{'fixed':'quick-action'},context)
                old.assert_not_called();o.historical_guard.assert_called_once_with(d,Path('/opt/id-business-v2/releases/workspace'),
                    {'migrationOrigin':{'fixed':'quick-action'}},source)

    @contextmanager
    def fence_fixture(self,busy=0,changing_connection=False,lose_after_api=False):
        with self.fixture() as f:
            popen=subprocess.Popen
            script=('import sys,json\ncount=0\nfor line in sys.stdin:\n'
                ' if "SELECT JSON_OBJECT" in line:\n  count+=1\n  print(json.dumps({"version":1,"connectionId":'
                +('count' if changing_connection else '(18 if count>2 else 17)' if lose_after_api else '17')+',"busy":'+str(busy)+'}),flush=True)\n')
            commands=[]
            def launch(command,**kwargs):
                commands.append(command);return popen([sys.executable,'-u','-c',script],**kwargs)
            fence=workspace.OnlineSqlFence(f.controller,f.previous)
            with patch.object(workspace.subprocess,'Popen',side_effect=launch):
                try:yield f,fence,commands
                finally:fence.close()

    def test_fence_uses_same_connection_private_stdin_and_stops_exact_api_then_engine(self):
        with self.fence_fixture() as (f,fence,commands):
            fence.acquire();self.assertEqual(fence.connection_id,17)
            fence.stop(f.states['api'],grace=30);fence.stop(f.states['online-recharge'],grace=45)
            self.assertEqual([a[-1] for a,k in f.calls if a[:2]==('docker','stop')],
                [f.states['api']['containerId'],f.states['online-recharge']['containerId']])
            self.assertIn('--unbuffered',commands[0][-1]);self.assertNotIn('LOCK TABLES',str(commands[0]))

    def test_active_task_or_card_lease_never_stops_any_container(self):
        with self.fence_fixture(busy=1) as (f,fence,commands):
            with self.assertRaisesRegex(RuntimeError,'FENCE_UNAVAILABLE'):fence.acquire()
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))

    def test_lost_connection_changed_identity_or_insufficient_budget_prevents_stop(self):
        with self.fence_fixture(changing_connection=True) as (f,fence,commands):
            fence.acquire()
            with self.assertRaisesRegex(RuntimeError,'TASK_ACTIVE'):fence.stop(f.states['api'],grace=30)
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))

    def test_lost_fence_after_api_stop_never_sends_stop_to_original_engine(self):
        with self.fence_fixture(lose_after_api=True) as (f,fence,commands):
            fence.acquire()
            with self.assertRaisesRegex(RuntimeError,'TASK_ACTIVE'):fence.stop(f.states['api'],grace=30)
            self.assertEqual([a[-1] for a,k in f.calls if a[:2]==('docker','stop')],[f.states['api']['containerId']])
            self.assertTrue(f.metadata[f.states['online-recharge']['containerId']]['State']['Running'])
        with self.fence_fixture() as (f,fence,commands):
            fence.acquire();fence.deadline=workspace.time.monotonic()+20
            with self.assertRaisesRegex(RuntimeError,'FENCE_TIMEOUT'):fence.stop(f.states['api'],grace=30)
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))

    def test_reverse_switch_stops_idle_owner_before_original_api_and_original_engine_rebind(self):
        with self.fixture() as f:
            order=[];fence=SimpleNamespace(acquire=lambda:order.append('lock'),check_idle=lambda:order.append('idle'),
                stop=lambda row,grace:order.append('stop-api' if row['image']=='api-image' else 'stop-engine'),close=lambda:order.append('unlock'))
            f.controller.rollback_service.side_effect=lambda *a:order.append('restore-api')
            with patch.object(workspace,'OnlineSqlFence',return_value=fence),patch.object(workspace,'online_container',
                    side_effect=[{'image':'api-image'},{'image':'engine-image'}]),patch.object(workspace,'online_rebind',side_effect=lambda *a:order.append('rebind-original')):
                workspace.online_rollback_api(f.controller,f.previous,f.current,f.states,workspace_proof(),self.context())
            self.assertEqual(order,['lock','stop-api','idle','stop-engine','unlock','restore-api','rebind-original'])

    def test_busy_reverse_switch_cannot_restore_api_or_interrupt_engine(self):
        with self.fixture() as f:
            fence=SimpleNamespace(acquire=MagicMock(side_effect=RuntimeError('API_ADMIN_ONLINE_TASK_ACTIVE')),close=MagicMock())
            with patch.object(workspace,'OnlineSqlFence',return_value=fence),patch.object(workspace,'online_rebind') as rebind, \
                    self.assertRaisesRegex(RuntimeError,'TASK_ACTIVE'):
                workspace.online_rollback_api(f.controller,f.previous,f.current,f.states,workspace_proof(),self.context())
            f.controller.rollback_service.assert_not_called();rebind.assert_not_called()

    def test_busy_before_any_api_mutation_never_recreates_old_api_or_engine(self):
        for failure in ('idle','fence'):
            with self.subTest(failure=failure):
                code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
                    online_origin_context=self.context(),online_fail=failure)
                self.assertEqual(code,1);self.assertEqual(result['servicesAttempted'],['admin'])
                self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list],['admin'])
                controller.online_fence.stop.assert_not_called();controller.online_rebind.assert_not_called()
                controller.online_rollback.assert_not_called()

    def test_rebind_failure_uses_online_aware_recovery_and_busy_recovery_is_partial(self):
        for failure in ('rebind','rollback-busy'):
            with self.subTest(failure=failure):
                code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
                    online_origin_context=self.context(),online_fail=failure)
                self.assertEqual(code,1);controller.online_rollback.assert_called_once()
                self.assertNotIn('api',[call.args[2] for call in controller.rollback_service.call_args_list])
                self.assertEqual(result['servicesReboundAttempted'],['online-recharge'])
                self.assertEqual(result['rollbackOk'],failure!='rollback-busy')
                if failure=='rollback-busy':self.assertEqual(result['status'],'API_ADMIN_WORKSPACE_PARTIAL_RECOVERY_REQUIRED')

    def test_eight_service_readback_binds_recreated_engine_to_current_api_and_sealed_origin(self):
        fixtures=load('merged_readonly_fixtures','api-admin-readonly.test.py')
        case=fixtures.WorkspaceSuccessorReceiptTests();case.setUp()
        value,receipt=case.full_readback_contract()
        def read(path,*a,**kw):
            return json.dumps(case.before if path.name.endswith('preflight-result.json') else value)
        with patch.object(Path,'read_text',read),patch.object(Path,'is_file',return_value=True), \
                patch.object(Path,'read_bytes',lambda path:read(path).encode()), \
                patch.dict(os.environ,case.environment,clear=True):
            transport.validate_receipt(receipt,fixtures.COMMIT,'readback','API_ADMIN_WORKSPACE')
            after=receipt['onlineNetworkRebind']['after']
            for changed in ({'servicesRebound':[]},{'preservedOnlineRechargeOrigin':{}},
                    {'onlineNetworkRebind':{**receipt['onlineNetworkRebind'],'after':{**after,'apiContainerId':'0'*64}}}):
                with self.subTest(changed=changed),self.assertRaises(RuntimeError):
                    transport.validate_receipt({**receipt,**changed},fixtures.COMMIT,'readback','API_ADMIN_WORKSPACE')
            missing={k:v for k,v in receipt.items() if k not in
                ('preservedOnlineRechargeOrigin','servicesRebound','onlineNetworkRebind')}
            missing['services']={k:v for k,v in receipt['services'].items() if k!='online-recharge'}
            with self.assertRaisesRegex(RuntimeError,'ONLINE_ORIGIN_RECEIPT_CHANGED'):
                transport.validate_receipt(missing,fixtures.COMMIT,'readback','API_ADMIN_WORKSPACE')


class WorkspaceSqliteProtectionTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, task_status=None, wal=False):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, ExitStack() as stack:
            base = Path(temporary).resolve()
            volume_root = base / 'source'; volume_root.mkdir(mode=0o700)
            previous = base / 'previous'; previous.mkdir(mode=0o700)
            target = base / 'candidate'; target.mkdir(mode=0o700)
            database = volume_root / 'database.db'
            tables = ('accounts', 'email_services', 'registration_tasks', 'settings', 'proxies',
                      'cpa_services', 'sub2api_services', 'tm_services')
            writer = sqlite3.connect(database)
            if wal: writer.execute('PRAGMA journal_mode=WAL')
            for name in tables:
                writer.execute('CREATE TABLE "' + name + '" (id INTEGER PRIMARY KEY, status TEXT, value TEXT)')
            writer.execute('INSERT INTO settings VALUES (1,NULL,?)', ('PRIVATE_SENTINEL_CIPHERTEXT',))
            if task_status is not None:
                writer.execute('INSERT INTO registration_tasks VALUES (1,?,?)', (task_status, 'PRIVATE_TASK'))
            writer.commit(); database.chmod(0o600)
            stack.callback(writer.close)
            name = 'fixture_auto_registration_data'
            identity = {'name': name, 'status': 'PRESENT', 'identitySha256': '6' * 64}
            api = {'Id': 'a' * 64, 'Image': 'sha256:' + '1' * 64,
                   'State': {'Running': True, 'StartedAt': '2026-10-01T00:00:00.000000000Z'}}
            state = {'containerId': api['Id'], 'image': api['Image'],
                     'startedAtSha256': hashlib.sha256(api['State']['StartedAt'].encode()).hexdigest()}
            calls, volumes = [], {name: {'Name': name, 'Mountpoint': str(volume_root)}}
            def run(*args, **kwargs):
                calls.append((args, kwargs))
                if args[:2] == ('docker', 'inspect'): return json.dumps([api])
                if args[:3] == ('docker', 'volume', 'inspect'): return json.dumps([volumes[args[-1]]])
                if args[:3] == ('docker', 'volume', 'ls'): return ''
                if args[:3] == ('docker', 'volume', 'create'):
                    root = base / args[-1]; root.mkdir()
                    volumes[args[-1]] = {'Name': args[-1], 'Mountpoint': str(root),
                        'Labels': {'id-business-v2.sqlite-restore': '123-1'}}
                    return args[-1]
                if args[:3] == ('docker', 'volume', 'rm'): return args[-1]
                if args[:2] == ('docker', 'stop'):
                    # A competing writer is still blocked until the exact old process is stopped.
                    with sqlite3.connect(database, timeout=0.01) as competing:
                        with self.assertRaises(sqlite3.OperationalError):
                            competing.execute('INSERT INTO settings VALUES (2,NULL,NULL)')
                    api['State']['Running'] = False
                    return args[-1]
                raise AssertionError(args)
            controller = SimpleNamespace(require=d.require, run=run, service_state=lambda *a, **kw: dict(state),
                compose=MagicMock(return_value='{"version":1,"mutationCount":0}'))
            def summary(connection):
                task_counts = {key: 0 for key in ('pending','running','completed','failed','cancelled')}
                for key,count in connection.execute('SELECT status,COUNT(*) FROM registration_tasks GROUP BY status'):
                    if key not in task_counts: raise RuntimeError('API_ADMIN_WORKSPACE_TASK_STATE_UNAVAILABLE')
                    task_counts[key] = count
                counts = {key: connection.execute('SELECT COUNT(*) FROM "' + key + '"').fetchone()[0] for key in tables}
                return {'schemaSha256': '7'*64,
                    'logicalSha256': hashlib.sha256('\n'.join(connection.iterdump()).encode()).hexdigest(),
                    'tableCounts': counts, 'taskCounts': task_counts}
            stack.enter_context(patch.object(workspace, 'workspace_volume', return_value=identity))
            stack.enter_context(patch.object(workspace.WorkspaceSqliteProtection, 'summary_reader', return_value=summary))
            args = SimpleNamespace(run_id='123', run_attempt='1', commit=COMMIT)
            candidate = {'images': {'api': {'reference':'fixture-image','imageId':'sha256:'+'2'*64}}}
            gate = workspace.WorkspaceSqliteProtection(controller, previous, target, candidate, args, legacy=True)
            stack.callback(gate.close)
            def inspect(_d, _directory, _reference, volume, **kwargs):
                path = Path(volumes[volume]['Mountpoint']) / 'database.db'
                with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as restored:
                    value = summary(restored)
                return {'version':1,'status':'PASS', **value,
                    'activeAppleLeaseCount':0,'corruptEncryptedValueCount':0,'businessActions':0}
            inspector = stack.enter_context(patch.object(workspace, 'workspace_private_inspect', side_effect=inspect))
            yield SimpleNamespace(gate=gate, controller=controller, database=database, root=volume_root,
                previous=previous, target=target, summary=summary, candidate=candidate,
                api=api,state=state,calls=calls,volumes=volumes,inspector=inspector,writer=writer)

    def test_lock_blocks_new_task_creation_until_exact_old_api_stops(self):
        with self.fixture() as f:
            f.gate.lock()
            with sqlite3.connect(f.database, timeout=0.01) as competing:
                with self.assertRaises(sqlite3.OperationalError):
                    competing.execute("INSERT INTO registration_tasks VALUES (9,'pending',NULL)")
            f.gate.backup_restore(); f.gate.stop_previous()
            self.assertIsNone(f.gate.connection)
            with sqlite3.connect(f.database) as competing:
                competing.execute("INSERT INTO settings VALUES (9,NULL,'AFTER_STOP')")
            self.assertFalse(f.api['State']['Running'])
            self.assertTrue((f.root/workspace.WORKSPACE_MAINTENANCE).is_file())

    def test_wal_committed_data_is_in_consistent_backup_and_source_never_replaced(self):
        with self.fixture(wal=True) as f:
            original_inode = f.database.stat().st_ino
            self.assertTrue(Path(str(f.database)+'-wal').exists())
            f.gate.lock(); value=f.gate.backup_restore()
            backup=f.target/value['backupName']
            with sqlite3.connect(backup) as read:
                self.assertEqual(read.execute('SELECT value FROM settings').fetchone()[0], 'PRIVATE_SENTINEL_CIPHERTEXT')
                self.assertEqual(f.summary(read),f.gate.summary)
            self.assertEqual(f.database.stat().st_ino,original_inode)
            self.assertEqual(backup.stat().st_mode & 0o777,0o600)
            self.assertEqual(backup.parent.stat().st_mode & 0o777,0o700)
            removals=[a[-1] for a,k in f.calls if a[:3]==('docker','volume','rm')]
            self.assertEqual(removals,['id-sqlite-restore-123-1'])
            self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value))

    def test_legacy_pending_running_cancelled_and_unknown_fail_before_marker(self):
        for status in ('pending','running','cancelled','unknown'):
            with self.subTest(status=status), self.fixture(task_status=status) as f:
                with self.assertRaises(RuntimeError): f.gate.lock()
                self.assertIsNone(f.gate.connection)
                self.assertFalse((f.root/workspace.WORKSPACE_MAINTENANCE).exists())

    def test_completed_and_failed_history_remain_intact(self):
        for status in ('completed','failed'):
            with self.subTest(status=status), self.fixture(task_status=status) as f:
                f.gate.lock(); f.gate.backup_restore()
                self.assertEqual(f.gate.summary['taskCounts'][status],1)
                self.assertTrue(f.gate.connection.in_transaction)

    def test_legacy_mutation_or_missing_audit_cannot_be_silently_empty(self):
        for response in ('{"version":1,"mutationCount":1}', '{}','{"version":1,"mutationCount":false}'):
            with self.subTest(response=response), self.fixture() as f:
                f.controller.compose.return_value=response
                with self.assertRaisesRegex(RuntimeError,'LEGACY_MUTATION'): f.gate.lock()
                self.assertFalse((f.root/workspace.WORKSPACE_MAINTENANCE).exists())
        with self.fixture() as f:
            f.controller.compose.side_effect=RuntimeError('PRIVATE_DATABASE_OUTPUT')
            with self.assertRaisesRegex(RuntimeError,'LEGACY_AUDIT_UNAVAILABLE') as caught: f.gate.lock()
            self.assertNotIn('PRIVATE_DATABASE_OUTPUT',str(caught.exception))

    def test_new_mutation_before_stop_blocks_without_sending_stop(self):
        with self.fixture() as f:
            f.gate.lock(); f.gate.backup_restore()
            f.controller.compose.return_value='{"version":1,"mutationCount":1}'
            with self.assertRaisesRegex(RuntimeError,'LEGACY_MUTATION'): f.gate.stop_previous()
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))

    def test_existing_foreign_or_symlink_maintenance_marker_is_never_overwritten(self):
        for symlink in (False,True):
            with self.subTest(symlink=symlink),self.fixture() as f:
                marker=f.root/workspace.WORKSPACE_MAINTENANCE
                if symlink: marker.symlink_to(f.target/'not-created')
                else: marker.write_text('FOREIGN_MARKER')
                with self.assertRaisesRegex(RuntimeError,'MAINTENANCE_EXISTS'): f.gate.lock()
                if not symlink: self.assertEqual(marker.read_text(),'FOREIGN_MARKER')

    def test_source_sidecar_symlink_and_source_permissions_are_rejected(self):
        with self.fixture() as f:
            f.database.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError,'SOURCE_INVALID'): f.gate.lock()
        with self.fixture() as f:
            (f.root/'database.db-wal').symlink_to(f.target/'outside')
            with self.assertRaisesRegex(RuntimeError,'SOURCE_INVALID'): f.gate.lock()

    def test_marker_changed_or_deadline_passed_blocks_and_preserves_original_database(self):
        with self.fixture() as f:
            f.gate.lock(); f.gate.deadline=0
            with self.assertRaisesRegex(RuntimeError,'FENCE_TIMEOUT'): f.gate.backup_restore()
            self.assertFalse((f.target/'backups'/'auto-registration').exists())
        with self.fixture() as f:
            f.gate.lock(); (f.root/workspace.WORKSPACE_MAINTENANCE).write_text('CHANGED')
            with self.assertRaisesRegex(RuntimeError,'MAINTENANCE_CHANGED'): f.gate.stop_previous()
            self.assertTrue(f.api['State']['Running'])

    def test_stop_is_rejected_without_budget_and_docker_timeout_stays_inside_remaining_budget(self):
        with self.fixture() as f:
            f.gate.lock(); f.gate.backup_restore()
            f.gate.deadline=workspace.time.monotonic()+34
            with self.assertRaisesRegex(RuntimeError,'FENCE_TIMEOUT'): f.gate.stop_previous()
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))
        with self.fixture() as f:
            f.gate.lock(); f.gate.backup_restore()
            f.gate.deadline=workspace.time.monotonic()+40
            f.gate.stop_previous()
            timeouts=[k['timeout'] for a,k in f.calls if a[:2]==('docker','stop')]
            self.assertEqual(len(timeouts),1);self.assertTrue(35<timeouts[0]<40)

    def test_failed_restore_keeps_backup_and_fence_and_cleans_only_own_clone(self):
        with self.fixture() as f:
            f.gate.lock(); f.inspector.side_effect=RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SAFETY_FAILED')
            with self.assertRaisesRegex(RuntimeError,'SAFETY_FAILED'): f.gate.backup_restore()
            self.assertTrue((f.target/'backups/auto-registration/database.db').is_file())
            self.assertTrue((f.root/workspace.WORKSPACE_MAINTENANCE).is_file())
            self.assertEqual([a[-1] for a,k in f.calls if a[:3]==('docker','volume','rm')],['id-sqlite-restore-123-1'])
            self.assertTrue(f.api['State']['Running'])

    def test_finish_only_removes_owned_fence_after_live_data_matches_verified_backup(self):
        with self.fixture() as f:
            f.gate.lock(); f.gate.backup_restore(); f.gate.stop_previous()
            f.gate.finish()
            self.assertFalse((f.root/workspace.WORKSPACE_MAINTENANCE).exists())
            self.assertTrue((f.target/'backups/auto-registration/database.db').exists())
        with self.fixture() as f:
            f.gate.lock(); f.gate.backup_restore(); f.gate.stop_previous()
            with sqlite3.connect(f.database) as changing:
                changing.execute("INSERT INTO settings VALUES (99,NULL,'AFTER_SNAPSHOT')")
            with self.assertRaisesRegex(RuntimeError,'SOURCE_CHANGED'): f.gate.finish()
            self.assertTrue((f.root/workspace.WORKSPACE_MAINTENANCE).exists())

    def test_private_safety_container_is_offline_readonly_and_key_never_in_arguments(self):
        with self.fixture() as f:
            value={'version':1,'status':'PASS',**f.summary(f.writer),
                'activeAppleLeaseCount':0,'corruptEncryptedValueCount':0,'businessActions':0}
            key='PRIVATE_FIXTURE_KEY_'+'x'*40
            controller=SimpleNamespace(require=d.require,environment_values=lambda p:{'FIELD_ENCRYPTION_KEY':key},
                run=MagicMock(return_value=json.dumps(value)))
            # The fixture patches inspect for other tests; call the original saved function directly.
            result=PRIVATE_INSPECT_ORIGINAL(controller,f.previous,'fixed-image','controlled-volume')
            self.assertEqual(result,value)
            command=controller.run.call_args.args
            self.assertIn('none',command); self.assertIn('--read-only',command)
            self.assertIn('no-new-privileges:true',command); self.assertIn('ALL',command)
            self.assertTrue(command[command.index('--mount')+1].endswith(',readonly'))
            self.assertNotIn(key,json.dumps(command))
            self.assertEqual(json.loads(controller.run.call_args.kwargs['input_data'])['encryptionKey'],key)

    def test_prepare_failure_carries_owned_gate_and_safe_abort_removes_only_its_marker(self):
        with self.fixture() as f:
            f.inspector.side_effect=RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SAFETY_FAILED')
            args=SimpleNamespace(run_id='123',run_attempt='1',commit=COMMIT)
            with self.assertRaisesRegex(RuntimeError,'SAFETY_FAILED') as caught:
                workspace.workspace_prepare(f.controller,f.previous,f.target,f.candidate,args,
                    {'workspaceVolume':f.gate.volume},legacy=True)
            owned=caught.exception.sqlite_gate
            self.assertIsNone(owned.connection)
            self.assertTrue((f.root/workspace.WORKSPACE_MAINTENANCE).exists())
            owned.abort()
            self.assertFalse((f.root/workspace.WORKSPACE_MAINTENANCE).exists())
            self.assertTrue((f.target/'backups/auto-registration/database.db').exists())

    def test_abort_after_old_image_restore_checks_new_container_and_clears_owned_marker(self):
        with self.fixture() as f:
            f.gate.lock();f.gate.backup_restore();f.gate.stop_previous()
            f.api['State']['Running']=True
            f.api['Id']='c'*64;f.state['containerId']=f.api['Id']
            f.api['State']['StartedAt']='2026-10-02T00:00:00.000000000Z'
            f.state['startedAtSha256']=hashlib.sha256(f.api['State']['StartedAt'].encode()).hexdigest()
            f.gate.abort()
            self.assertFalse((f.root/workspace.WORKSPACE_MAINTENANCE).exists())
            self.assertIsNone(f.gate.connection)

    def test_abort_keeps_fence_if_new_data_or_original_api_or_audit_cannot_be_proven(self):
        for failure in ('data','image','audit'):
            with self.subTest(failure=failure),self.fixture() as f:
                f.gate.lock();f.gate.backup_restore();f.gate.close()
                if failure=='data':
                    f.writer.execute("INSERT INTO settings VALUES (55,NULL,'NEW_DATA')");f.writer.commit()
                if failure=='image':
                    f.api['Image']='sha256:'+'3'*64;f.state['image']=f.api['Image']
                if failure=='audit':f.controller.compose.return_value='{"version":1,"mutationCount":1}'
                with self.assertRaises(RuntimeError):f.gate.abort()
                self.assertTrue((f.root/workspace.WORKSPACE_MAINTENANCE).exists())
                self.assertIsNone(f.gate.connection)

    def fake_release_gate(self):
        return SimpleNamespace(record={'safeFixture':True},summary={'logicalSha256':'7'*64},
            volume={'name':'fixture_auto_registration_data'},stop_previous=MagicMock(),finish=MagicMock(),
            check_marker=MagicMock(),close=MagicMock(),abort=MagicMock())

    def test_release_does_not_discard_prepare_exception_gate_before_cleanup(self):
        gate=self.fake_release_gate()
        code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
            sqlite_gate=gate,sqlite_prepare_error=True)
        self.assertEqual(code,1);self.assertEqual(result['status'],'API_ADMIN_WORKSPACE_FAILED_RESTORED')
        self.assertEqual(result['servicesAttempted'],['admin'])
        gate.abort.assert_called_once();gate.stop_previous.assert_not_called()
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list],['admin'])

    def test_prepare_failure_does_not_report_unfinished_restore_proof_as_verified(self):
        gate=self.fake_release_gate();gate.record=None
        code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
            sqlite_gate=gate,sqlite_prepare_error=True)
        self.assertEqual(code,1);self.assertTrue(result['rollbackOk'])
        self.assertEqual(result['sqliteBackupStatus'],'INCOMPLETE_PROOF')

    def test_release_success_and_rollback_finalize_gate_only_after_validation(self):
        gate=self.fake_release_gate()
        code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,sqlite_gate=gate)
        self.assertEqual(code,0);gate.stop_previous.assert_called_once();gate.finish.assert_called_once()
        gate.abort.assert_not_called()
        self.assertEqual(manifest['apiWorkspacePublication']['sqliteProtectionSha256'],workspace.fingerprint(gate.record))
        gate=self.fake_release_gate()
        code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
            sqlite_gate=gate,fail_at='caddy-health')
        self.assertEqual(code,1);self.assertTrue(result['rollbackOk']);gate.abort.assert_called_once()
        self.assertEqual(result['status'],'API_ADMIN_WORKSPACE_FAILED_RESTORED')
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list],['caddy','api','admin'])

    def test_uncertain_abort_is_partial_and_never_reported_restored(self):
        gate=self.fake_release_gate();gate.abort.side_effect=RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SOURCE_CHANGED')
        code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
            sqlite_gate=gate,sqlite_prepare_error=True)
        self.assertEqual(code,1);self.assertFalse(result['rollbackOk'])
        self.assertEqual(result['status'],'API_ADMIN_WORKSPACE_PARTIAL_RECOVERY_REQUIRED')
        self.assertFalse(result['currentPointsToCandidate'])

    def test_persisted_restore_receipt_rechecks_binding_and_backup_bytes(self):
        with self.fixture() as f:
            f.gate.lock();value=f.gate.backup_restore()
            digest=workspace.fingerprint(value)
            record={'sqliteProtectionSha256':digest,'workspaceVolumeBefore':f.gate.volume,
                'workspaceVolumeAfter':f.gate.volume,'before':{'api':f.state}}
            manifest={'apiWorkspacePublication':{'sqliteProtectionSha256':digest}}
            result=workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)
            self.assertTrue(result['restoreVerified']);self.assertTrue(result['backupVerified'])
            with (f.target/value['backupName']).open('ab') as stream:stream.write(b'CHANGED')
            with self.assertRaisesRegex(RuntimeError,'BACKUP_CHANGED'):
                workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)

    def test_v4_real_restore_receipt_rejects_resigned_private_restore_hash_identity_and_lease_changes(self):
        with self.fixture() as f:
            f.gate.lock();original=f.gate.backup_restore()
            path=f.target/workspace.WORKSPACE_SQLITE_RECEIPT
            def bound(value):
                digest=workspace.fingerprint(value)
                record={'sqliteProtectionSha256':digest,'workspaceVolumeBefore':f.gate.volume,
                    'workspaceVolumeAfter':f.gate.volume,'before':{'api':dict(f.state)}}
                manifest={'apiWorkspacePublication':{'version':4,'sqliteProtectionSha256':digest}}
                return record,manifest
            record,manifest=bound(original)
            result=workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)
            self.assertEqual(set(result),{'backupVerified','restoreVerified','sqliteProtectionSha256','backupSha256','backupSize'})
            self.assertTrue(result['backupVerified']);self.assertTrue(result['restoreVerified'])
            for variation in ('private','restore','restore-volume','backup-hash','source-hash','maintenance-hash',
                    'container','image','started-at','candidate-image','volume','lease','inspection-private','legacy-audit'):
                value=copy.deepcopy(original)
                if variation=='private':value['privateData']='PRIVATE_SENTINEL'
                elif variation=='restore':value['restoreVerified']=False
                elif variation=='restore-volume':value['temporaryRestoreVolumeRemoved']=False
                elif variation=='backup-hash':value['backupSha256']='not-a-hash'
                elif variation=='source-hash':value['sourceDatabaseIdentitySha256']='not-a-hash'
                elif variation=='maintenance-hash':value['maintenanceSha256']='not-a-hash'
                elif variation=='container':value['sourceApiIdentity']['containerId']='d'*64
                elif variation=='image':value['sourceApiIdentity']['image']='sha256:'+'d'*64
                elif variation=='started-at':value['sourceApiIdentity']['startedAtSha256']='d'*64
                elif variation=='candidate-image':value['candidateImageId']='sha256:'+'d'*64
                elif variation=='volume':value['volume']['identitySha256']='d'*64
                elif variation=='lease':value['inspection']['activeAppleLeaseCount']=1
                elif variation=='inspection-private':value['inspection']['privateData']='PRIVATE_SENTINEL'
                else:value['legacyAudit']['legacyMutationCount']=1
                # Rebind both outer seals so rejection must come from the real
                # closed receipt/safety checks, not a stale digest alone.
                path.write_text(json.dumps(value))
                record,manifest=bound(value)
                with self.subTest(variation=variation),self.assertRaisesRegex(RuntimeError,'SQLITE_'):
                    workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)
            path.write_text(json.dumps(original))
            record,manifest=bound(original)
            self.assertEqual(workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest),result)

    def test_v4_real_restore_receipt_rejects_private_file_permission_and_outer_seal_changes(self):
        with self.fixture() as f:
            f.gate.lock();value=f.gate.backup_restore()
            digest=workspace.fingerprint(value)
            record={'sqliteProtectionSha256':digest,'workspaceVolumeBefore':f.gate.volume,
                'workspaceVolumeAfter':f.gate.volume,'before':{'api':dict(f.state)}}
            manifest={'apiWorkspacePublication':{'version':4,'sqliteProtectionSha256':digest}}
            backup=f.target/value['backupName']
            for path,mode in ((f.target/workspace.WORKSPACE_SQLITE_RECEIPT,0o644),
                    (backup,0o644),(backup.parent,0o755),(backup.parent.parent,0o755)):
                original_mode=path.stat().st_mode & 0o777
                try:
                    path.chmod(mode)
                    with self.subTest(path=path.relative_to(f.target)),self.assertRaisesRegex(RuntimeError,'SQLITE_'):
                        workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)
                finally:path.chmod(original_mode)
            for target,key in ((record,'sqliteProtectionSha256'),(manifest['apiWorkspacePublication'],'sqliteProtectionSha256')):
                original=target[key]
                try:
                    target[key]='d'*64
                    with self.assertRaisesRegex(RuntimeError,'SQLITE_RECEIPT_CHANGED'):
                        workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)
                finally:target[key]=original
            self.assertTrue(workspace.workspace_sqlite_receipt(f.controller,f.target,f.candidate,record,manifest)['restoreVerified'])

    def test_pending_v4_producer_binds_sqlite_gate_and_switches_only_api_admin(self):
        pending_fixtures=load('merged_pending_v4_producer_fixtures','api-admin-pending-online.test.py')
        pending=pending_fixtures.context()
        gate=self.fake_release_gate()
        code,result,controller,manifest,persisted=ReleaseFailureTests().run_release(selected_scope=workspace,
            pending_origin=pending,sqlite_gate=gate)
        self.assertEqual(code,0);self.assertFalse(persisted)
        self.assertEqual(result['status'],'API_ADMIN_WORKSPACE_VERIFIED')
        self.assertEqual([call.args[-1] for call in controller.compose.call_args_list],['admin','api'])
        self.assertEqual(manifest['servicesUpdated'],['api','admin'])
        publication=manifest['apiWorkspacePublication']
        self.assertEqual(publication['version'],4)
        self.assertEqual(publication['sqliteProtectionSha256'],workspace.fingerprint(gate.record))
        self.assertEqual(publication['pendingOnlineMigration'],workspace.pending_online_marker(pending))
        self.assertIs(publication['onlinePublished'],False);self.assertIs(publication['migrationPerformed'],False)
        self.assertNotIn('workspaceBackupSha256',publication)
        self.assertNotIn('workspaceBackup',controller.pending_record)
        self.assertNotIn('workspacePreparation',controller.pending_record)
        self.assertEqual(controller.pending_record['sqliteProtectionSha256'],workspace.fingerprint(gate.record))
        self.assertEqual(controller.pending_record['pendingOnlineMigrationOrigin'],pending)
        controller.pending_projection.assert_called_once()
        gate.stop_previous.assert_called_once();gate.finish.assert_called_once();gate.abort.assert_not_called()
        controller.rollback_service.assert_not_called()
        # This mock tests producer field binding and switch selection only. The
        # two real-gate tests above exercise workspace_sqlite_receipt authority.

    def test_safe_receipt_rejects_extra_data_bad_types_or_unproven_lease(self):
        with self.fixture() as f:
            original={'version':1,'status':'PASS',**f.summary(f.writer),
                'activeAppleLeaseCount':0,'corruptEncryptedValueCount':0,'businessActions':0}
            for key,value in [('privateData','PRIVATE_SENTINEL'),('activeAppleLeaseCount',1),
                    ('businessActions',False),('schemaSha256','not-a-hash')]:
                changed={**original,key:value}
                with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'SAFETY_FAILED'):
                    workspace.workspace_safety_result(f.controller,changed)
            with self.assertRaisesRegex(RuntimeError,'SAFETY_FAILED'):
                workspace.workspace_safety_result(f.controller,{**original,
                    'tableCounts':{**original['tableCounts'],'sqlite_sequence':0}})

    def test_frozen_pure_helper_runs_on_host_and_wal_backup_shares_its_algorithm(self):
        with self.fixture(wal=True) as f:
            helper=f.target/workspace.WORKSPACE_SAFETY
            helper.parent.mkdir(parents=True,mode=0o700)
            helper.write_bytes((ROOT/workspace.WORKSPACE_SAFETY).read_bytes())
            before_crypto={name for name in sys.modules if name.startswith('cryptography')}
            summary=SUMMARY_READER_ORIGINAL(f.gate)
            self.assertEqual(before_crypto,{name for name in sys.modules if name.startswith('cryptography')})
            with sqlite3.connect(f.database.as_uri()+'?mode=rw',uri=True) as holder:
                holder.execute('BEGIN IMMEDIATE');original=summary(holder)
                source=sqlite3.connect(f.database.as_uri()+'?mode=ro',uri=True)
                destination=sqlite3.connect(f.target/'standalone-proof.db')
                try:
                    source.backup(destination);destination.execute('PRAGMA journal_mode=DELETE')
                    self.assertEqual(summary(destination),original)
                    self.assertTrue(holder.in_transaction)
                finally:
                    source.close();destination.close();holder.rollback()


class MergedWorkspaceAdmissionTests(unittest.TestCase):

    def test_stopped_database_identity_is_bound_to_live_mysql_and_environment_without_api_probe(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as folder:
            root = Path(folder).resolve(); (root / '.env.aws.production').write_text('SYNTHETIC_ENV=1\n')
            state = {'status': 'running', 'health': 'healthy', 'containerId': 'mysql-fixture', 'image': 'fixture-image'}
            controller = SimpleNamespace(require=d.require, current_job_database=MagicMock(return_value='fixture'),
                service_state=lambda *a, **k: dict(state))
            identity = workspace.workspace_database_identity(controller, root)
            controller.current_job_database.side_effect = AssertionError('old API must stay stopped')
            self.assertEqual(workspace.workspace_database_identity(controller, root, identity), identity)
            state['containerId'] = 'changed'
            with self.assertRaisesRegex(RuntimeError, 'DATABASE_IDENTITY_CHANGED'):
                workspace.workspace_database_identity(controller, root, identity)
            state['containerId'] = 'mysql-fixture'; (root / '.env.aws.production').write_text('SYNTHETIC_ENV=2\n')
            with self.assertRaisesRegex(RuntimeError, 'DATABASE_IDENTITY_CHANGED'):
                workspace.workspace_database_identity(controller, root, identity)

    def test_stopped_identity_keeps_recharge_registration_leases_and_worker_busy_guards(self):
        controller = SimpleNamespace(require=d.require, compose=MagicMock(return_value='0'),
            assert_no_active_recharge=MagicMock(side_effect=AssertionError('cannot probe old API')),
            current_job_database=MagicMock(side_effect=AssertionError('cannot probe old API')),
            registration_runtime_state=lambda p: {'supported': True, 'registrationBusy': False,
                                                  'registrationWindowRetained': True})
        identity = {'database': 'fixture'}
        with patch.object(workspace, 'workspace_database_identity', return_value=identity):
            value = workspace.jobs_idle(controller, ROOT, database_identity=identity)
            self.assertTrue(value['rechargeIdle']); self.assertFalse(value['registrationLeaseActive'])
            statements = [call.args[-1] for call in controller.compose.call_args_list]
            self.assertIn('id_business_v2_recharge_jobs', statements[0])
            self.assertIn('id_business_v2_registration_jobs', statements[1])
            for bad_result in (['1'], ['0', '1']):
                controller.compose.side_effect = bad_result
                with self.assertRaisesRegex(RuntimeError, 'LEASE_ACTIVE'):
                    workspace.jobs_idle(controller, ROOT, database_identity=identity)
            controller.compose.side_effect = None; controller.compose.return_value = '0'
            controller.registration_runtime_state = lambda p: {'supported': True, 'registrationBusy': True,
                                                               'registrationWindowRetained': True}
            with self.assertRaisesRegex(RuntimeError, 'REGISTRATION_BUSY'):
                workspace.jobs_idle(controller, ROOT, database_identity=identity)

    def test_public_origin_only_emits_https_hostname_and_valid_port(self):
        controller = SimpleNamespace(require=d.require, environment_values=lambda p: {'APP_PUBLIC_URL': url})
        url = 'https://fixture.example:8443/'
        self.assertEqual(workspace.workspace_public_origin(controller, ROOT), 'https://fixture.example:8443')
        for url in ('http://fixture.example', 'https://user:secret@fixture.example',
                    'https://fixture.example/?credential=fixture', 'https://fixture.example/#fixture',
                    'https://fixture.example/private', 'https://fixture.example:0'):
            with self.assertRaises((RuntimeError, ValueError)):
                workspace.workspace_public_origin(controller, ROOT)

    def test_stopped_api_probe_rejects_absent_multiple_or_wrong_container(self):
        identifier = '5' * 64
        controller = SimpleNamespace(require=d.require, compose=MagicMock(return_value=identifier),
            run=MagicMock(return_value=json.dumps([{'Id': identifier, 'State': {'Running': False},
                'Config': {'Labels': {'com.docker.compose.service': 'admin'}}}])))
        with self.assertRaisesRegex(RuntimeError, 'CONTAINER_UNAVAILABLE'):
            workspace.workspace_api_metadata(controller, ROOT)
        controller.run.assert_called_once()
        for identifiers in ('', identifier + '\n' + '6' * 64):
            controller.compose.return_value = identifiers
            with self.assertRaisesRegex(RuntimeError, 'CONTAINER_UNAVAILABLE'):
                workspace.workspace_api_metadata(controller, ROOT)

    @contextmanager
    def audit_fixture(self, *, busy=0, changed_connection=False):
        with OnlineWorkspaceCompatibilityTests().fixture() as f:
            popen=subprocess.Popen;commands=[]
            script=('import sys,json\ncount=0\nfor line in sys.stdin:\n'
                ' if "SELECT JSON_OBJECT" in line:\n  count+=1\n  print(json.dumps({"version":1,"connectionId":'
                +('count' if changed_connection else '17')+',"busy":'+str(busy)+'}),flush=True)\n')
            def launch(command,**kwargs):
                commands.append(command);return popen([sys.executable,'-u','-c',script],**kwargs)
            barrier=workspace.WorkspaceAuditBarrier(f.controller,f.previous)
            with patch.object(workspace,'workspace_audit_protection') as protection, \
                    patch.object(workspace.subprocess,'Popen',side_effect=launch):
                try:yield f,barrier,commands,protection
                finally:barrier.close()

    def test_legacy_admission_uses_private_same_connection_and_since_started_at_mutation_predicate(self):
        with self.audit_fixture() as (f,barrier,commands,protection):
            barrier.acquire();barrier.before_stop();barrier.stop(f.states['api'],grace=30)
            self.assertEqual(barrier.connection_id,17);protection.assert_called_once()
            self.assertIn('created_at>=CAST(',barrier.QUERY)
            self.assertIn(' /api/registration',barrier.QUERY);self.assertIn(' /api/ws/',barrier.QUERY)
            self.assertIn('--skip-reconnect',commands[0][-1]);self.assertNotIn('LOCK TABLES',str(commands[0]))
            self.assertEqual([a[-1] for a,k in f.calls if a[:2]==('docker','stop')],[f.states['api']['containerId']])

    def test_admitted_legacy_mutation_or_changed_connection_blocks_all_stop_commands(self):
        with self.audit_fixture(busy=1) as (f,barrier,commands,protection):
            with self.assertRaisesRegex(RuntimeError,'AUDIT_GUARD_FAILED'):barrier.acquire()
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))
        with self.audit_fixture(changed_connection=True) as (f,barrier,commands,protection):
            barrier.acquire()
            with self.assertRaisesRegex(RuntimeError,'TASK_ACTIVE'):barrier.before_stop()
            self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))

    def test_audit_timeout_mysql_identity_drift_and_eof_block_stop_and_close_descriptors(self):
        for failure in ('timeout','identity','eof'):
            with self.subTest(failure=failure),self.audit_fixture() as (f,barrier,commands,protection):
                barrier.acquire();process=barrier.process
                if failure=='timeout':barrier.deadline=workspace.time.monotonic()+20
                if failure=='identity':f.states['mysql']['containerId']='0'*64
                if failure=='eof':process.stdin.close();process.wait(timeout=3)
                with self.assertRaises(Exception):barrier.before_stop()
                self.assertFalse(any(a[:2]==('docker','stop') for a,k in f.calls))
                barrier.close();self.assertIsNotNone(process.poll());self.assertTrue(process.stdout.closed)

    def test_legacy_guard_failure_before_api_mutation_restores_only_attempted_admin(self):
        for failure in ('acquire','before-stop'):
            gate=WorkspaceSqliteProtectionTests().fake_release_gate()
            code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
                sqlite_gate=gate,workspace_admission_failure=failure)
            self.assertEqual(code,1);self.assertEqual(result['servicesAttempted'],['admin'])
            self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list],['admin'])
            gate.stop_previous.assert_not_called();controller.workspace_admission.close.assert_called()

    def test_lost_legacy_guard_after_old_api_stop_does_not_stop_engine_and_recovers_through_online_path(self):
        gate=WorkspaceSqliteProtectionTests().fake_release_gate()
        code,result,controller,manifest,_=ReleaseFailureTests().run_release(selected_scope=workspace,
            sqlite_gate=gate,online_origin_context=OnlineWorkspaceCompatibilityTests().context(),
            workspace_admission_failure='after-stop',online_fail='rollback-busy')
        self.assertEqual(code,1);self.assertFalse(result['rollbackOk'])
        self.assertEqual(result['status'],'API_ADMIN_WORKSPACE_PARTIAL_RECOVERY_REQUIRED')
        controller.online_fence.stop.assert_not_called();controller.online_rollback.assert_called_once()
        self.assertNotIn('api',[call.args[2] for call in controller.rollback_service.call_args_list])
        gate.abort.assert_not_called()

    def test_audit_history_immutable_trigger_contract_is_required(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            folder=Path(temporary)
            for migration_name in ('20261002123500_routine_audit_retention_exception','20260830182500_mysql_trigger_service_definers'):
                name=workspace.MIGRATION_ROOT+'/'+migration_name+'/migration.sql';path=folder/name
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((ROOT/name).read_bytes())
            rows=[]
            for event,migration_name in (('DELETE','20261002123500_routine_audit_retention_exception'),('UPDATE','20260830182500_mysql_trigger_service_definers')):
                raw=(folder/workspace.MIGRATION_ROOT/migration_name/'migration.sql').read_text()
                trigger='idv2_audit_log_no_'+('delete' if event=='DELETE' else 'update')
                body=raw.split('CREATE TRIGGER `'+trigger+'`',1)[1].split('FOR EACH ROW',1)[1]
                body=body.split('END;',1)[0]+'END' if event=='DELETE' else body.split(';',1)[0]
                rows.append({'event':event,'timing':'BEFORE','statement':body})
            controller=SimpleNamespace(require=d.require,current_job_database=lambda p:'fixture_db',compose=MagicMock(return_value=json.dumps(rows)))
            digest=workspace.workspace_audit_protection(controller,folder);self.assertRegex(digest,r'^[a-f0-9]{64}$')
            for value in ([],[rows[0]], [{**rows[0],'statement':'SET @allow=1'},rows[1]], [*rows,rows[0]]):
                controller.compose.return_value=json.dumps(value)
                with self.assertRaisesRegex(RuntimeError,'HISTORY_UNPROVEN'):workspace.workspace_audit_protection(controller,folder)

    def test_engine_private_runtime_idle_checks_closed_health_and_active_thread_counter(self):
        expected={'ready':True,'mode':'enabled','activeTasks':0,'stopping':False,'rpcConnected':True}
        controller=SimpleNamespace(require=d.require,run=MagicMock(return_value=json.dumps(expected)))
        workspace.online_engine_idle(controller,{'Id':'1'*64})
        for change in ({'activeTasks':1},{'activeTasks':False},{'stopping':True},{'rpcConnected':False},{'mode':'disabled'},{'private':'SENTINEL'}):
            controller.run.return_value=json.dumps({**expected,**change})
            with self.subTest(change=change),self.assertRaisesRegex(RuntimeError,'ENGINE_NOT_IDLE'):
                workspace.online_engine_idle(controller,{'Id':'1'*64})

    def test_online_sources_bind_fixed_engine_frontend_schema_compose_and_policy_without_fourteen_receipt_fields(self):
        online,_=d.online_recharge_scope()
        self.assertEqual(online.fingerprint(online.recovery_policy(d)),online.RECOVERY_POLICY_SHA256)
        self.assertIn('scripts/production-release/online-recharge-recovery.json',workspace.ONLINE_ORIGIN_FILES)
        with patch.object(workspace,'online_reader',return_value=online):
            with tracked_online_source() as folder:
                workspace.online_source_guard(d,folder)
                path=folder/'scripts/production-release'/online.RECOVERY_FILE;path.write_bytes(path.read_bytes()+b'\n')
                with self.assertRaisesRegex(RuntimeError,'RECOVERY_POLICY_CHANGED'):workspace.online_source_guard(d,folder)

    def test_actual_admission_source_bytes_cannot_change_in_an_online_successor(self):
        online,_=d.online_recharge_scope()
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            previous=Path(temporary)/'previous';candidate=Path(temporary)/'candidate'
            folders=(*workspace.ONLINE_SOURCE_SEALS,workspace.MIGRATION_ROOT)
            files=(*workspace.CONFIG_FILES,workspace.MIGRATION_SEED,*workspace.ONLINE_ADMISSION_FILES,
                'scripts/production-release/'+online.RECOVERY_FILE)
            archive=subprocess.check_output(['git','archive','HEAD','--',*folders],cwd=ROOT)
            for directory in (previous,candidate):
                directory.mkdir()
                with tarfile.open(fileobj=io.BytesIO(archive),mode='r:') as tracked:
                    for member in tracked.getmembers():
                        path=Path(member.name)
                        self.assertFalse(path.is_absolute() or '..' in path.parts)
                        self.assertTrue(member.isdir() or member.isfile())
                        target=directory/path
                        if member.isdir():
                            target.mkdir(parents=True,exist_ok=True)
                        else:
                            target.parent.mkdir(parents=True,exist_ok=True)
                            target.write_bytes(tracked.extractfile(member).read())
                            target.chmod(member.mode)
                for name in files:
                    path=directory/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((ROOT/name).read_bytes())
                (directory/'.env.aws.production').write_bytes(b'synthetic-only')
            controller=SimpleNamespace(**vars(d))
            with patch.object(workspace,'online_reader',return_value=online):
                for name in workspace.ONLINE_ADMISSION_FILES:
                    path=candidate/name;raw=path.read_bytes();path.write_bytes(raw+b'\n// changed\n')
                    with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'ADMISSION_SOURCE_CHANGED'):
                        workspace.require_preserved(controller,previous,candidate,states(),b'synthetic-only',online_context={})
                    path.write_bytes(raw)

    def test_stopped_identity_adapter_only_reads_the_previously_verified_database(self):
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary:
            folder=Path(temporary);(folder/'.env.aws.production').write_bytes(b'synthetic')
            row={'status':'running','health':'healthy','containerId':'1'*64,'image':'sha256:'+'2'*64,'environmentSha256':'3'*64}
            controller=SimpleNamespace(require=d.require,service_state=lambda *a,**kw:dict(row),
                current_job_database=MagicMock(return_value='fixture_database'))
            identity=workspace.workspace_database_identity(controller,folder)
            adapter=workspace.workspace_database_controller(controller,folder,identity)
            controller.current_job_database.side_effect=AssertionError('stopped API cannot be queried')
            self.assertEqual(adapter.current_job_database(folder),'fixture_database')
            row['containerId']='4'*64
            with self.assertRaisesRegex(RuntimeError,'DATABASE_IDENTITY_CHANGED'):adapter.current_job_database(folder)

    def test_original_first_publication_cannot_omit_performed_or_claim_unsealed_recovery(self):
        online,_=d.online_recharge_scope();controller=SimpleNamespace(require=d.require)
        workspace.online_recovery_guard(controller,online,ROOT,ROOT,
            {'migrationPerformed':True},{'baselineEvidence':{},'migration':{'performed':True}})
        for performed in (False,None,1):
            with self.subTest(performed=performed),self.assertRaises(RuntimeError):
                workspace.online_recovery_guard(controller,online,ROOT,ROOT,
                    {'migrationPerformed':performed},{'baselineEvidence':{},'migration':{'performed':performed}})
        with self.assertRaises(RuntimeError):
            workspace.online_recovery_guard(controller,online,ROOT,ROOT,
                {'migrationPerformed':True,'migrationRecovery':{}},{'baselineEvidence':{},'migration':{'performed':True}})

    def test_recovery_origin_and_candidate_source_are_revalidated_without_runtime_publication(self):
        fixtures=load('merged_online_recovery_fixtures','online-recharge-scope.test.py')
        fixtures.RUNTIME=RUNTIME;fixtures.RecoveryTests.setUpClass();fixtures.RestoredRecoveryTests.setUpClass()
        try:
            with fixtures.RestoredRecoveryTests().fixture() as restored:
                controller,previous,second,context,documents,save,*_=restored
                online=fixtures.scope
                # The latest official reader requires both ended attempts. Reuse its
                # actual two immutable source fixtures rather than bypass that reader.
                with fixtures.RecoveryTests().fixture() as first:
                    first_controller,_,first_source,failure,*_=first
                    failed=previous.parent/first_source.name
                    shutil.copytree(first_source,failed);failed.chmod(0o700)
                    failure=copy.deepcopy(failure)
                database=fixtures.database_fixture(failed,True)
                published=previous.with_name('candidate')
                shutil.copytree(fixtures.RestoredRecoveryTests.prepared/online.RECOVERY_COMMIT,published)
                for name in context['policy']['candidateAllowedFiles']:
                    path=published/name;path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes((ROOT/name).read_bytes());path.chmod((ROOT/name).stat().st_mode & 0o777)
                marker=online.recovery_marker(context['policy'])
                manifest={'migrationRecovery':marker,'migrationPerformed':False}
                record={'baselineEvidence':{'migrationRecovery':marker},'migration':{'performed':False}}
                with patch.object(online,'recovery_policy',return_value=context['policy']), \
                        patch.object(online,'RECOVERY_FAILURE_SHA256',online.fingerprint(failure)), \
                        patch.object(online,'database_read',return_value=database):
                    workspace.online_recovery_guard(controller,online,previous,published,manifest,record)
                    for variation in ('marker','performed','source','first-failure','restored-failure'):
                        with self.subTest(variation=variation):
                            bad_manifest=copy.deepcopy(manifest);bad_record=copy.deepcopy(record)
                            if variation=='marker':bad_manifest['migrationRecovery']={}
                            if variation=='performed':bad_manifest['migrationPerformed']=bad_record['migration']['performed']=True
                            extra=published/'apps/admin/src/v2/features/online-recharge/unapproved.ts'
                            if variation=='source':extra.write_text('unapproved')
                            if variation=='first-failure':(failed/online.FAILURE_FILE).write_text(json.dumps({**failure,'servicesAttempted':['api']}))
                            if variation=='restored-failure':
                                documents[online.FAILURE_FILE]['rollbackOk']=False;save()
                            with self.assertRaises(RuntimeError):
                                workspace.online_recovery_guard(controller,online,previous,published,bad_manifest,bad_record)
                            if variation=='source':extra.unlink()
                            if variation=='first-failure':(failed/online.FAILURE_FILE).write_text(json.dumps(failure))
                            if variation=='restored-failure':documents[online.FAILURE_FILE]['rollbackOk']=True;save()
        finally:
            fixtures.RestoredRecoveryTests.tearDownClass();fixtures.RecoveryTests.tearDownClass()


class WorkspaceDeclarationProofVersionTests(unittest.TestCase):
    def declaration(self):
        result = workspace_proof()
        result.update(version=2, pendingOnlineProjection={'fixture': 'projection'},
            pendingOnlineOriginSha256='1' * 64, pendingOnlinePreflightSha256='2' * 64,
            declarationEquivalenceSeal={'kind': 'API_FIXED_DECLARATION_EQUIVALENCE', 'version': 3,
                'preflightProofSha256': '3' * 64, 'semanticSha256': '4' * 64})
        return result

    def test_explicit_v2_preserves_original_image_configuration_and_acceptance_checks(self):
        controller = SimpleNamespace(require=d.require)
        helper = SimpleNamespace(validate_record=MagicMock())
        value = self.declaration()
        with patch.object(workspace, 'pending_projection', return_value=helper):
            self.assertIs(workspace.validate_proof(controller, value, COMMIT, TREE), value)
            helper.validate_record.assert_called_once_with(controller, value['pendingOnlineProjection'], COMMIT, TREE)
            for mutate in ('acceptance', 'image', 'configuration', 'source', 'run'):
                changed = copy.deepcopy(value)
                if mutate == 'acceptance': changed['acceptance']['businessActions'] = 1
                elif mutate == 'image': changed['images']['api']['imageId'] = 'not-an-image'
                elif mutate == 'configuration': changed['configuration']['volume'] = 'other'
                elif mutate == 'source': changed['sourceTree'] = '0' * 40
                else: changed['images']['api']['reference'] = changed['images']['api']['reference'].replace('-123-', '-999-')
                with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                    workspace.validate_proof(controller, changed, COMMIT, TREE, REPOSITORY, '123', '1')

    def test_partial_unknown_or_wrong_version_declaration_seals_are_rejected(self):
        controller = SimpleNamespace(require=d.require)
        helper = SimpleNamespace(validate_record=MagicMock())
        for mutate in ('missing-f', 'missing-seal', 'missing-projection', 'extra', 'outer-bool',
                       'outer-three', 'seal-bool', 'seal-two', 'seal-extra', 'bad-kind', 'bad-f', 'bad-p', 'bad-semantic'):
            value = self.declaration()
            if mutate == 'missing-f': value.pop('pendingOnlinePreflightSha256')
            elif mutate == 'missing-seal': value.pop('declarationEquivalenceSeal')
            elif mutate == 'missing-projection':
                value.pop('pendingOnlineProjection'); value.pop('pendingOnlineOriginSha256')
            elif mutate == 'extra': value['sourceMeasured'] = True
            elif mutate == 'outer-bool': value['version'] = True
            elif mutate == 'outer-three': value['version'] = 3
            elif mutate == 'seal-bool': value['declarationEquivalenceSeal']['version'] = True
            elif mutate == 'seal-two': value['declarationEquivalenceSeal']['version'] = 2
            elif mutate == 'seal-extra': value['declarationEquivalenceSeal']['authority'] = True
            elif mutate == 'bad-kind': value['declarationEquivalenceSeal']['kind'] = 'OTHER'
            elif mutate == 'bad-f': value['pendingOnlinePreflightSha256'] = 'hash-only'
            elif mutate == 'bad-p': value['declarationEquivalenceSeal']['preflightProofSha256'] = 'hash-only'
            else: value['declarationEquivalenceSeal']['semanticSha256'] = 'hash-only'
            with self.subTest(mutate=mutate), patch.object(workspace, 'pending_projection', return_value=helper):
                with self.assertRaises(RuntimeError): workspace.validate_proof(controller, value, COMMIT, TREE)

    def test_v1_cannot_silently_admit_new_fields_or_other_scopes_v2(self):
        value = self.declaration(); value['version'] = 1
        controller = SimpleNamespace(require=d.require)
        for consumer in (scope, registration, migration, workspace):
            with self.subTest(scope=consumer.SCOPE), self.assertRaisesRegex(RuntimeError, '^API_ADMIN_BUILD_PROOF_INVALID$'):
                consumer.validate_proof(controller, value, COMMIT, TREE)
        ordinary = workspace_proof()
        self.assertIs(workspace.validate_proof(controller, ordinary, COMMIT, TREE), ordinary)


if __name__ == '__main__':
    unittest.main()
