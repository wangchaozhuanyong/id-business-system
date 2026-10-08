import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
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
RUNTIME = ROOT / '.deploy'
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
REGISTRATION_FIXTURE_COMMIT = '4042b5f2c673344409e329607bd43a893ba521bb'


def proof():
    return {'version': 1, 'commit': COMMIT, 'sourceTree': TREE, 'images': {
        name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}', 'imageId': 'sha256:' + str(index) * 64,
               'fileCount': 1, 'sha256': str(index) * 64}
        for index, name in enumerate(scope.UPDATED, 1)}}


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
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes((ROOT / name).read_bytes())
            with patch.object(Path, 'cwd', return_value=root), patch.dict(os.environ, {'RELEASE_COMMIT': commit, 'SOURCE_TREE': tree}):
                record = registration.prepare_registration_build(controller)
            rows = record['workerProjection']
            self.assertEqual(len(rows), 60)
            self.assertEqual({n for n in rows if rows[n] != profile['workerProjection'][n]}, registration.WORKER_PAIR)
            context = root / '.deploy/production-release/api-registration-build-context'
            for name, row in rows.items():
                self.assertEqual(registration.hashlib.sha256((context / name).read_bytes()).hexdigest(), row['sha256'])
            self.assertEqual(record['workerProjectionSha256'], registration.fingerprint(rows))
            self.assertEqual((context / 'scripts/audit-python-dependencies.py').read_bytes(), (ROOT / 'scripts/audit-python-dependencies.py').read_bytes())
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
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()
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

    def test_registration_and_pricing_merge_keeps_both_entries_and_rejects_mixed_selection(self):
        arguments = ['remote-deploy.py', '--commit', COMMIT, '--source-tree', TREE,
            '--repository', REPOSITORY, '--expected-current', OLD, '--run-id', '123',
            '--run-attempt', '1', '--ci-run-id', '456', '--api-registration-only', '--recharge-pro-pricing']
        with tempfile.TemporaryDirectory(dir=RUNTIME) as temporary, patch.object(d, 'BASE', Path(temporary)), \
             patch.object(sys, 'argv', arguments), patch.object(d, 'recharge_pricing_release') as pricing:
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(d.main(), 1)
            self.assertEqual(json.loads(output.getvalue())['code'], 'API_ADMIN_SCOPE_CONFLICT')
            pricing.assert_not_called()
        arguments.remove('--api-registration-only')
        with patch.object(sys, 'argv', arguments), patch.object(d, 'recharge_pricing_release', return_value=0) as pricing:
            self.assertEqual(d.main(), 0)
            pricing.assert_called_once()

    def execute_private(self, *, close, mode='success'):
        calls = []
        def read(request, timeout):
            method = request.get_method(); calls.append((method, request.full_url, request.data))
            if method == 'POST' and mode == '409':
                from urllib.error import HTTPError
                raise HTTPError(request.full_url, 409, 'PRIVATE RAW', {'PRIVATE': 'SECRET'},
                                io.BytesIO(b'{"ok":false,"reason":"fingerprint_cleanup_failed"}'))
            posted = any(row[0] == 'POST' for row in calls)
            if request.full_url.endswith('/status'):
                value = {'accepted': True, 'attempt': 10, 'cancelled': posted, 'done': True}
                if mode == 'wrong-attempt': value['attempt'] = 11
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

    def test_readonly_handoff_selection_does_not_add_general_command_input(self):
        for mode, closed, flag in (('preflight', False, 'verify'), ('preflight', True, 'preflight'),
                                   ('handoff', True, 'handoff'), ('readback', True, 'readback'), ('business', True, 'business')):
            commands = '\n'.join(transport.parameters(COMMIT, OLD, mode, 'API_REGISTRATION', require_closed=closed)['commands'])
            self.assertIn('--api-registration-' + flag + ' --expected-current ' + OLD, commands)
            self.assertEqual(commands.count('sha256sum -c -'), 2)
            self.assertNotIn('/cancel', commands)
        with self.assertRaises(ValueError):
            transport.parameters(COMMIT, OLD, 'handoff')
        for operation in ('verify_api_registration', 'handoff_api_registration', 'release_api_registration', 'verify_registration_business'):
            for changed, ok in (({}, True), ({'HISTORICAL_EXCEPTION': 'historical-finance-20261005'}, False),
                                ({'REUSE_IMAGE_RUN': '1'}, False), ({'RELEASE_BROWSER_CACHE_IMAGE': 'cache'}, False)):
                result = subprocess.run(['bash', 'scripts/production-release/validate-release-selection.sh'],
                    cwd=ROOT, env={**os.environ, 'RELEASE_OPERATION': operation, 'HISTORICAL_EXCEPTION': 'none', **changed}, capture_output=True)
                self.assertEqual(result.returncode == 0, ok)

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
                    migration_preapplied=False, migration_failure=None, migration_task_changed=False, migration_window_changed=False):
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
                path = previous / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('config')
            (previous / 'compose.release.json').write_text(json.dumps({'services': {name: {'image': 'old'} for name in d.SERVICES}}))
            if scope.MIGRATION_MODE:
                migration_fixture(previous, old=True)
            candidate = migration_proof() if scope.MIGRATION_MODE else registration_proof() if scope.REGISTRATION else proof()
            args = SimpleNamespace(admin_only=False, image_commit=None, image_run_id=None, image_run_attempt=None,
                post_cleanup_seal_sha256=None, order_archive_seal_sha256=None, order_archive_prepared_images_sha256=None,
                api_admin_build_proof=base64.b64encode(json.dumps(candidate).encode()).decode(), api_admin_migration_only=scope.MIGRATION_MODE,
                commit=COMMIT, source_tree=TREE, expected_current=OLD, repository=REPOSITORY, run_id='123', run_attempt='1', ci_run_id='456')
            before = states()
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.compose = MagicMock(); controller.wait_healthy = MagicMock()
            guards, task = migration_guards(), registration_task()
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
                if command[:3] == ('docker', 'image', 'inspect'):
                    row = next(row for row in candidate['images'].values() if row['reference'] == command[-1])
                    return json.dumps([{'Id': row['imageId'], 'Architecture': 'amd64', 'Config': {'Labels': {
                        'org.opencontainers.image.revision': COMMIT, 'id-business-v2.source-tree': TREE}}}])
                return ''
            controller.run = run
            archive_data = io.BytesIO()
            with tarfile.open(fileobj=archive_data, mode='w:gz') as archive:
                for name in ('remote-deploy.py', 'api-admin-scope.py'):
                    path = Path(__file__).with_name(name)
                    raw = path.read_bytes(); info = tarfile.TarInfo(f'id-business-system-{COMMIT}/scripts/production-release/{name}')
                    info.size = len(raw); archive.addfile(info, io.BytesIO(raw))
                if scope.MIGRATION_MODE:
                    for name in [scope.MIGRATION_SCHEMA, *(scope.MIGRATION_ROOT + '/' + name for name in scope.migration_files(d, ROOT))]:
                        raw = (ROOT / name).read_bytes(); info = tarfile.TarInfo(f'id-business-system-{COMMIT}/' + name)
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
                value.status = 200; return value
            stack.enter_context(patch.object(scope.urllib.request, 'urlopen', side_effect=response))
            stack.enter_context(patch.object(scope.subprocess, 'run', return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(scope, 'source_tree', return_value=TREE))
            stack.enter_context(patch.object(scope, 'configuration_hashes', return_value={'config': 'hash'}))
            evidence = {'manifestSha256': scope.hashlib.sha256(b'{}').hexdigest(), 'environmentSha256': 'env'}
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
            if busy_after_switch:
                idle.side_effect = [None, None, RuntimeError('API_ADMIN_REGISTRATION_BUSY')]
                controller.wait_healthy.side_effect = [None, RuntimeError('unhealthy')]
            if fail_at == 'health': controller.wait_healthy.side_effect = RuntimeError('unhealthy')
            if fail_at == 'queued-before-api':
                idle.side_effect = [None, RuntimeError('API_ADMIN_REGISTRATION_BUSY')]
            if fail_at == 'api-health':
                controller.wait_healthy.side_effect = [None, RuntimeError('unhealthy')]
            if fail_at == 'queued-after-api':
                idle.side_effect = [None, None, RuntimeError('API_ADMIN_REGISTRATION_BUSY')]
            output = io.StringIO()
            with redirect_stdout(output):
                code = scope.release(controller, args)
            result = json.loads(output.getvalue().splitlines()[-1])
            manifests = list((base / 'releases').glob('*/release-manifest.json'))
            new_manifest = next((json.loads(p.read_text()) for p in manifests if p.parent != previous), None)
            failure_files = list((base / 'releases').glob('*/' + scope.FAILURE_FILE))
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
    for name, digest in migration.migration_files(d, ROOT).items():
        if old and name == migration.MIGRATION_FILE:
            continue
        target = directory / migration.MIGRATION_ROOT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / migration.MIGRATION_ROOT / name).read_bytes())
    schema = directory / migration.MIGRATION_SCHEMA
    schema.parent.mkdir(parents=True, exist_ok=True)
    raw = (subprocess.check_output(['git', 'show', migration.REGISTRATION_CURRENT + ':' + migration.MIGRATION_SCHEMA], cwd=ROOT)
           if old else (ROOT / migration.MIGRATION_SCHEMA).read_bytes())
    schema.write_bytes(raw)


def migration_database_fixture(*, applied=False):
    rows = [{'name': name.split('/')[0], 'checksum': digest, 'finished': 1, 'rolledBack': 0}
            for name, digest in migration.migration_files(d, ROOT).items()
            if name.endswith('/migration.sql') and (applied or name != migration.MIGRATION_FILE)]
    return {'rows': rows,
        'columns': [{'type': 'int', 'columnType': 'int', 'nullable': 'YES', 'default': None, 'extra': ''}] if applied else None,
        'indexes': [{'column': name, 'sequence': index, 'nonUnique': 1, 'type': 'BTREE', 'prefix': None}
                    for index, name in enumerate(('user_id', 'deleted_at', 'sort_order'), 1)] if applied else None}


def migration_proof():
    value = proof()
    value.update(scope='API_ADMIN_MIGRATION', migration=dict(migration.MIGRATION_IDENTITY))
    value['images']['migrate'] = {'reference': f'{REPOSITORY}:{COMMIT}-123-1-migrate',
        'imageId': 'sha256:' + '3' * 64, **migration.migration_content(d, ROOT)}
    return value


def migration_guards():
    return {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
            'registrationWindowRetained': True}


class MigrationScopeTests(unittest.TestCase):
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
        self.assertEqual(migration.migration_source_check(d, ROOT), migration.MIGRATION_IDENTITY)
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
        self.assertEqual(migration.migration_content(d, ROOT)['fileCount'], 48)
        self.assertIn('/app/apps/api/prisma-mysql', migration.content_command('migrate'))
        for path in ('/app/apps/api/dist/main.js', '/app/server.py', '/usr/share/nginx/html/index.html'):
            with self.assertRaisesRegex(RuntimeError, 'CONTENT_INVALID'):
                migration.content_summary(d, 'migrate', '1' * 64 + '  ' + path)

    def database_controller(self, value):
        return SimpleNamespace(require=d.require, current_job_database=MagicMock(return_value='fixture_db'),
            compose=MagicMock(return_value=json.dumps(value)))

    def test_database_verifies_pending_and_applied_checksum_column_and_index(self):
        for applied in (False, True):
            controller = self.database_controller(migration_database_fixture(applied=applied))
            state = migration.migration_database_state(controller, ROOT)
            self.assertEqual(state['status'], 'APPLIED' if applied else 'PENDING')
            self.assertTrue(state['schemaVerified'])
            self.assertEqual(state['sha256'], migration.MIGRATION_IDENTITY['sha256'])
            query = controller.compose.call_args.args[-1]
            self.assertIn('MYSQL_DATABASE=fixture_db', controller.compose.call_args.args)
            self.assertIn('information_schema.STATISTICS', query)
            self.assertNotIn('UPDATE ', query)

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
                migration.migration_database_state(self.database_controller(value), ROOT)

    def test_completed_migration_retry_is_skipped_and_pending_executes_once(self):
        for applied in (False, True):
            controller = self.database_controller(migration_database_fixture(applied=applied))
            controller.compose.side_effect = ([json.dumps(migration_database_fixture()), 'applied', json.dumps(migration_database_fixture(applied=True))]
                                              if not applied else [json.dumps(migration_database_fixture(applied=True))])
            result = migration.apply_migration(controller, ROOT)
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
            migration.apply_migration(controller, ROOT)
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
            stack.enter_context(patch.object(migration.shutil, 'disk_usage', return_value=SimpleNamespace(free=free)))
            native = stack.enter_context(patch.object(migration, 'registration_native_baseline', return_value={'kind': 'VERIFIED_EXISTING_API_REGISTRATION_SOURCE'}))
            idle = stack.enter_context(patch.object(migration, 'jobs_idle', return_value=migration_guards()))
            yield controller, current, before, native, idle, stack

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
            stack.enter_context(patch.object(migration, 'registration_task', return_value=registration_task()))
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
                task = registration_task()
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
            rows = {'/app/' + migration.MIGRATION_ROOT + '/' + name: digest for name, digest in migration.migration_files(d, current).items()}
            rows['/app/' + migration.MIGRATION_SCHEMA] = hashlib.sha256((current / migration.MIGRATION_SCHEMA).read_bytes()).hexdigest()
            content = '\n'.join(sorted(digest + '  ' + name for name, digest in rows.items()))
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
                'registrationTask': registration_task(), 'registrationGuards': migration_guards(), 'migration': {**state, 'performed': True}}
            (current / migration.STATE_FILE).write_text(json.dumps(record))
            (current / migration.PROOF_FILE).write_text(json.dumps(candidate))
            manifest = {'sourceTree': TREE, 'servicesUpdated': list(migration.UPDATED), 'migrationApplied': True,
                'migrationPerformed': True, 'newMigrations': [migration.MIGRATION_FILE], 'previousRelease': str(origin),
                'backupBeforeRelease': backup['name'], 'dataAuditBefore': migration.audit_receipt(d, current / 'before-audit.json'),
                'dataAuditAfter': migration.audit_receipt(d, current / 'after-audit.json')}
            stack.enter_context(patch.object(migration, 'baseline', return_value=(current, manifest, after, {'environmentSha256': environment_sha})))
            stack.enter_context(patch.object(migration, 'snapshot', return_value=after))
            stack.enter_context(patch.object(migration, 'verify_running'))
            stack.enter_context(patch.object(migration, 'jobs_idle', return_value=migration_guards()))
            task = stack.enter_context(patch.object(migration, 'registration_task', return_value=registration_task()))
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
                if change == 'task': task.return_value = {**registration_task(), 'jobHmac': '8' * 64}
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


if __name__ == '__main__':
    unittest.main()
