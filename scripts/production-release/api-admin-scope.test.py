import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import ExitStack, redirect_stdout
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.deploy'
RUNTIME.mkdir(exist_ok=True)


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


scope = load('api_admin_scope', 'api-admin-scope.py')
d = load('remote_deployment', 'remote-deploy.py')
transport = load('api_admin_transport', 'api-admin-readonly.py')
COMMIT, TREE, OLD = 'a' * 40, 'b' * 40, 'c' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'


def proof():
    return {'version': 1, 'commit': COMMIT, 'sourceTree': TREE, 'images': {
        name: {'reference': f'{REPOSITORY}:{COMMIT}-123-1-{name}', 'imageId': 'sha256:' + str(index) * 64,
               'fileCount': 1, 'sha256': str(index) * 64}
        for index, name in enumerate(scope.UPDATED, 1)}}


def states():
    return {name: {'image': 'sha256:' + 'c' * 64, 'reference': 'old-' + name, 'status': 'running',
                   'health': 'healthy', 'containerId': name, 'startedAtSha256': 'start',
                   'environmentSha256': 'env', 'configurationSha256': 'config'} for name in d.ALL_SERVICES}


class JobGuardTests(unittest.TestCase):
    def controller(self, busy=False, retained=True, count='0'):
        return SimpleNamespace(require=d.require, assert_no_active_recharge=MagicMock(),
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
            controller.check_registration_interstitial_deployment = MagicMock(return_value=proof)
            stack.enter_context(patch.object(scope, 'snapshot', return_value=before))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            result = scope.baseline(controller, COMMIT, check_jobs=False)
            self.assertEqual(result[3]['apiSource']['kind'], 'VERIFIED_RETAINED_API_ADMIN_PUBLICATION')
            self.assertEqual(result[3]['apiSource']['revision'], origin)
            self.assertEqual(result[3]['apiSource']['buildProofSha256'], proof['apiBuildProofSha256'])
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


class ReleaseFailureTests(unittest.TestCase):
    def run_release(self, fail_at=None, busy_after_switch=False, preserved_changed=False, failure_receipt_unwritable=False):
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
            candidate = proof()
            args = SimpleNamespace(admin_only=False, image_commit=None, image_run_id=None, image_run_attempt=None,
                post_cleanup_seal_sha256=None, order_archive_seal_sha256=None, order_archive_prepared_images_sha256=None,
                api_admin_build_proof=base64.b64encode(json.dumps(candidate).encode()).decode(),
                commit=COMMIT, source_tree=TREE, expected_current=OLD, repository=REPOSITORY, run_id='123', run_attempt='1', ci_run_id='456')
            before = states()
            controller = SimpleNamespace(**vars(d)); controller.BASE = base
            controller.compose = MagicMock(); controller.wait_healthy = MagicMock()
            controller.rollback_service = MagicMock(); controller.point_current = MagicMock()
            controller.environment_values = lambda path: {'APP_PUBLIC_URL': 'https://example.test'}
            controller.fresh_backup = MagicMock(return_value={'name': 'backup'})
            controller.service_state = lambda directory, name, **kw: before[name]
            def run(*command, **kw):
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
            def response(url, **kw):
                value = io.BytesIO(archive_data.getvalue() if 'archive/' in url else b'')
                value.status = 200; return value
            stack.enter_context(patch.object(scope.urllib.request, 'urlopen', side_effect=response))
            stack.enter_context(patch.object(scope.subprocess, 'run', return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(scope.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)))
            stack.enter_context(patch.object(scope, 'source_tree', return_value=TREE))
            stack.enter_context(patch.object(scope, 'configuration_hashes', return_value={'config': 'hash'}))
            evidence = {'manifestSha256': scope.hashlib.sha256(b'{}').hexdigest(), 'environmentSha256': 'env'}
            old = {'images': {name: {'sourceCommit': OLD} for name in d.SERVICES},
                   'fixedRegistrationRelease': {'id': 'old'}, 'fixedRegistrationPreservedStates': {}}
            stack.enter_context(patch.object(scope, 'baseline', return_value=(previous, old, before, evidence)))
            stack.enter_context(patch.object(scope, 'require_preserved', return_value=before))
            stack.enter_context(patch.object(scope, 'strict_audit', return_value={'checksSha256': 'rules'}))
            idle = stack.enter_context(patch.object(scope, 'jobs_idle'))
            stack.enter_context(patch.object(scope, 'verify_running'))
            stack.enter_context(patch.object(scope, 'readback', return_value={'status': 'API_ADMIN_VERIFIED'}))
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


if __name__ == '__main__':
    unittest.main()
