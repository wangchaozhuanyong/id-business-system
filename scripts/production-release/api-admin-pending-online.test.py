"""Pending database provenance, two publications, and independent readback.

Fixtures use no network, Docker, real database or production path writes.
"""
import copy
import base64
import gzip
from contextlib import contextmanager, ExitStack
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.runtime/bitbrowser-release-20261010/pending-control-tests'
OUTPUT.mkdir(parents=True, exist_ok=True)


def load(name, file, selected=None):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    if selected:
        value.SCOPE = selected
    spec.loader.exec_module(value)
    return value


s = load('pending_scope', 'api-admin-scope.py', 'API_ADMIN_WORKSPACE')
online = load('pending_online', 'online-recharge-scope.py')
t = load('pending_transport', 'api-admin-readonly.py')


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def states():
    return {name: {'image': 'sha256:' + str(i) * 64, 'reference': 'sealed-' + name,
        'status': 'running', 'health': None if name == 'caddy' else 'healthy',
        'containerId': str(i) * 64, 'startedAtSha256': 'a' * 64,
        'environmentSha256': 'b' * 64, 'configurationSha256': 'c' * 64}
        for i, name in enumerate(('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'), 1)}


def context():
    policy = online.recovery_policy(SimpleNamespace(require=need))
    return {'version': 1, 'scope': s.PENDING_ONLINE_SCOPE,
        'baselineRelease': '/opt/id-business-v2/releases/20261009T124501Z-' + s.WORKSPACE_BOOTSTRAP_COMMIT[:12],
        'baselineManifestSha256': 'e' * 64,
        'migrationState': {'name': online.MIGRATION_NAME, 'sha256': online.MIGRATION_IDENTITY['sha256'],
            'status': 'APPLIED', 'schemaVerified': True, 'appliedMigrationsSha256': 'f' * 64},
        'recoveryMarker': online.recovery_marker(policy),
        'restoredOrigin': {'source': '/opt/id-business-v2/releases/20261009T142956Z-' + online.RESTORED_COMMIT[:12],
            'manifestSha256': 'a' * 64, 'recordSha256': 'b' * 64},
        'services': states(), 'priorPublications': []}


def namespace():
    return vars(s)


class OriginValidation(unittest.TestCase):
    def test_fixed_pending_origin_does_not_assert_online_publication(self):
        value = context()
        self.assertIs(s.validate_pending_online_origin(value), value)
        marker = s.pending_online_marker(value)
        self.assertEqual(marker['publicationIndex'], 1)
        self.assertEqual(marker['scope'], 'PENDING_ONLINE_MIGRATION')
        self.assertNotIn('onlineOrigin', value)

    def test_wrong_migration_schema_or_pending_status_rejects(self):
        for key, change in [('sha256', '0' * 64), ('status', 'PENDING'), ('schemaVerified', False), ('name', 'other')]:
            value = context(); value['migrationState'][key] = change
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED'):
                s.validate_pending_online_origin(value)

    def test_both_failure_sources_and_exact_keys_are_required(self):
        for change in ('first', 'second', 'extra', 'secret'):
            value = context()
            if change == 'first': value['recoveryMarker']['failureReceiptSha256'] = '0' * 64
            elif change == 'second': value['recoveryMarker']['restoredAttempt']['failureReceiptSha256'] = '0' * 64
            elif change == 'extra': value['onlineOrigin'] = {}
            else: value['recoveryMarker']['privateToken'] = 'DO_NOT_EMIT_SENTINEL'
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_ORIGIN_CHANGED'):
                s.validate_pending_online_origin(value)

    def test_two_publication_limit_and_safe_service_identity(self):
        value = context()
        entry = {'release': '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12,
            'commit': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': '3' * 64,
            'recordSha256': '4' * 64, 'buildProofSha256': '5' * 64}
        value['priorPublications'] = [entry]
        self.assertEqual(s.pending_online_marker(value)['publicationIndex'], 2)
        value['priorPublications'].append(entry)
        with self.assertRaises(RuntimeError): s.validate_pending_online_origin(value)
        value = context(); value['services']['online-recharge'] = value['services']['api']
        with self.assertRaises(RuntimeError): s.validate_pending_online_origin(value)


class FinitePublicationChain(unittest.TestCase):
    def test_a_to_b_transition_is_sealed_and_a_third_is_rejected(self):
        value = context()
        previous = MagicMock()
        previous.__str__.return_value = '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12
        (previous / s.STATE_FILE).read_bytes.return_value = b'{"sealed":"A"}'
        new_states = states(); new_states['api']['containerId'] = '9' * 64
        manifest = {'commit': '1' * 40, 'sourceTree': '2' * 40}
        successor = s.pending_online_successor(SimpleNamespace(require=need), value, previous,
            manifest, b'{"commit":"A"}', {'proof': 'A'}, new_states)
        self.assertEqual(s.pending_online_marker(value)['publicationIndex'], 1)
        self.assertEqual(s.pending_online_marker(successor)['publicationIndex'], 2)
        self.assertEqual(successor['priorPublications'][0]['recordSha256'], s.hashlib.sha256(b'{"sealed":"A"}').hexdigest())
        self.assertEqual(value['priorPublications'], [])
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_PUBLICATION_LIMIT'):
            s.pending_online_successor(SimpleNamespace(require=need), successor, previous,
                manifest, b'{}', {}, new_states)

    @contextmanager
    def sealed_chain(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            base = Path(temporary); (base / 'releases').mkdir()
            value = context(); origin = base / 'releases' / Path(value['baselineRelease']).name; origin.mkdir()
            raw = b'{"original":"sealed"}'; (origin / 'release-manifest.json').write_bytes(raw)
            value['baselineManifestSha256'] = s.hashlib.sha256(raw).hexdigest()
            first = copy.deepcopy(value)
            prior_commit = '1' * 40; prior = base / 'releases' / ('20261010T010000Z-' + prior_commit[:12]); prior.mkdir()
            after = states(); after['api']['containerId'] = '9' * 64; after['admin']['containerId'] = '8' * 64
            proof = {'pendingOnlineProjection': {'sealed': 'A'}}
            manifest = {'commit': prior_commit, 'sourceTree': '2' * 40, 'pendingOnlineMigration': s.pending_online_marker(first),
                'servicesUpdated': ['api', 'admin'], 'migrationApplied': False, 'newMigrations': []}
            record = {'pendingOnlineMigrationOrigin': first, 'before': first['services'], 'after': after}
            for name, row in [('release-manifest.json', manifest), (s.STATE_FILE, record), (s.PROOF_FILE, proof)]:
                (prior / name).write_text(json.dumps(row))
            value['services'] = after
            value['priorPublications'] = [{'release': '/opt/id-business-v2/releases/' + prior.name,
                'commit': prior_commit, 'sourceTree': '2' * 40,
                'manifestSha256': s.hashlib.sha256((prior / 'release-manifest.json').read_bytes()).hexdigest(),
                'recordSha256': s.hashlib.sha256((prior / s.STATE_FILE).read_bytes()).hexdigest(),
                'buildProofSha256': s.fingerprint(proof)}]
            module = SimpleNamespace(verify_permission_seed=MagicMock(), require_fresh_resources=MagicMock(),
                recovery_services=MagicMock(side_effect=AssertionError('retired container live reader forbidden')))
            recovery = {'state': value['migrationState'], 'marker': value['recoveryMarker'],
                'restored': value['restoredOrigin'], 'source': base / 'sealed-failure-source',
                'policy': {'preflight': {'services': states()}}}
            def mapped_path(item):
                path = Path(item)
                return base / 'releases' / path.name if str(path).startswith('/opt/id-business-v2/releases/') else path
            controller = SimpleNamespace(require=need, BASE=base, run=MagicMock(side_effect=AssertionError('no retired Docker inspect')))
            with patch.object(s, 'Path', side_effect=mapped_path), patch.object(s, 'pending_online_recovery', return_value=(module, recovery)), \
                    patch.object(s, 'pending_online_migrations'), patch.object(s, 'snapshot', return_value=after):
                yield controller, value, prior, module, recovery

    def test_b_origin_cold_read_succeeds_without_retired_containers(self):
        with self.sealed_chain() as (controller, value, prior, module, recovery):
            self.assertEqual(s.pending_online_guard(controller, prior, value, all_services=True), recovery)
            controller.run.assert_not_called(); module.recovery_services.assert_not_called()
            module.verify_permission_seed.assert_called_once(); module.require_fresh_resources.assert_called_once()

    def test_b_source_record_proof_or_before_after_drift_is_rejected(self):
        for changed in ('manifest', 'record', 'proof', 'sealed-configuration', 'preserved-live'):
            with self.subTest(changed=changed), self.sealed_chain() as (controller, value, prior, module, recovery):
                if changed == 'manifest': (prior / 'release-manifest.json').write_text('{}')
                elif changed == 'record': (prior / s.STATE_FILE).write_text('{}')
                elif changed == 'proof': (prior / s.PROOF_FILE).write_text('{}')
                elif changed == 'sealed-configuration': recovery['policy']['preflight']['services']['api']['configurationSha256'] = '0' * 64
                else: value['services']['caddy']['containerId'] = '0' * 64
                with self.assertRaises(RuntimeError): s.pending_online_guard(controller, prior, value)
                controller.run.assert_not_called()


class BoundedProofTransport(unittest.TestCase):
    def test_only_pending_workspace_proof_uses_large_compressed_envelope(self):
        value = {'pendingOnlineProjection': {'inventory': 'a' * 33059}}
        encoded = 'gzip:' + base64.b64encode(gzip.compress(json.dumps(value).encode(), mtime=0)).decode()
        self.assertEqual(s.decode_build_proof(SimpleNamespace(require=need), encoded), value)
        with patch.object(s, 'WORKSPACE', False), self.assertRaises(RuntimeError):
            s.decode_build_proof(SimpleNamespace(require=need), encoded)
        ordinary = base64.b64encode(json.dumps(value).encode()).decode()
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_BUILD_PROOF_TOO_LARGE'):
            s.decode_build_proof(SimpleNamespace(require=need), ordinary)

    def test_bomb_trailing_stream_and_missing_projection_are_rejected(self):
        for value, tail in [({'pendingOnlineProjection': {'inventory': 'a' * 65536}}, b''), ({'version': 1}, b''),
                            ({'pendingOnlineProjection': {}}, b'unsigned-extra-stream')]:
            encoded = 'gzip:' + base64.b64encode(gzip.compress(json.dumps(value).encode(), mtime=0) + tail).decode()
            with self.subTest(tail=bool(tail)), self.assertRaises(RuntimeError):
                s.decode_build_proof(SimpleNamespace(require=need), encoded)

    def test_real_dispatch_envelope_binds_unchanged_proof_and_fits_ssm_budget(self):
        value = {'pendingOnlineProjection': {'removedFiles': {('f' + str(i) + '.ts'):
            {'mode': '100644', 'sha256': s.hashlib.sha256(str(i).encode()).hexdigest()} for i in range(152)},
            'generatedFiles': {('g' + str(i) + '.ts'): {'before': s.hashlib.sha256(('b' + str(i)).encode()).hexdigest(),
                'after': s.hashlib.sha256(('a' + str(i)).encode()).hexdigest()} for i in range(26)}, 'padding': 'x' * 10000}}
        raw = json.dumps(value, separators=(',', ':')).encode()
        self.assertGreater(len(raw), 16384); self.assertLess(len(raw), 65536)
        text = (ROOT / 'scripts/production-release/dispatch.sh').read_text()
        program = text.split('python3 - "$parameters_file" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]
        env = {'RELEASE_COMMIT': 'a' * 40, 'SOURCE_TREE': 'b' * 40, 'EXPECTED_CURRENT': online.BASELINE_COMMIT,
            'RELEASE_REPOSITORY': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'QUALITY_RUN_ID': '456',
            'RELEASE_OPERATION': 'release_api_workspace', 'HISTORICAL_EXCEPTION': 'none'}
        original = Path.read_bytes
        def local_read(path):
            return raw if path.name == 'api-workspace-build-proof.json' else original(path)
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, patch.dict(os.environ, env, clear=True), \
                patch.object(sys, 'argv', ['generate', str(Path(temporary) / 'parameters.json')]), \
                patch.object(Path, 'read_bytes', local_read):
            exec(compile(program, '<pending-dispatch>', 'exec'), {})
            encoded_parameters = (Path(temporary) / 'parameters.json').read_bytes()
        self.assertLess(len(encoded_parameters), 65536)
        commands = json.loads(encoded_parameters)['commands']
        self.assertEqual(sum('sha256sum -c -' in command for command in commands), 5)
        argument = next(command for command in commands if '--api-admin-build-proof ' in command).split('--api-admin-build-proof ', 1)[1].split()[0]
        self.assertTrue(argument.startswith('gzip:'))
        self.assertEqual(s.decode_build_proof(SimpleNamespace(require=need), argument), value)


class IndependentEndedFailures(unittest.TestCase):
    def fixture(self):
        value = context()
        value['migrationState']['appliedMigrationsSha256'] = '792ed62e35a3110ae1a0e4dec9d1d8a67430972d8bd9f7b9c2f7ff1d0a679088'
        shared = {'errorType': 'RuntimeError', 'rollbackOk': True, 'previousCommit': online.BASELINE_COMMIT,
                  'inverseMigrationPerformed': False, 'mediaVolumeDeleted': False,
                  'currentPointsToCandidate': False, 'receiptPersisted': True}
        first = {**shared, 'status': 'ONLINE_RECHARGE_FAILED_BEFORE_SWITCH', 'step': 'migration',
            'code': 'ONLINE_RECHARGE_STEP_FAILED', 'rollback': {}, 'servicesAttempted': [],
            'candidateCommit': online.RECOVERY_COMMIT, 'migration': {**value['migrationState'], 'performed': True},
            'migrationAttempted': True}
        second = {**shared, 'status': 'ONLINE_RECHARGE_FAILED_RESTORED', 'step': 'audit-after',
            'code': 'ONLINE_RECHARGE_WORKSPACE_ORIGIN_CHANGED', 'rollback': {n: 'RESTORED' for n in online.SWITCH_ORDER},
            'servicesAttempted': list(online.SWITCH_ORDER), 'candidateCommit': online.RESTORED_COMMIT,
            'migration': {**value['migrationState'], 'performed': False}, 'migrationAttempted': False}
        expected = s.pending_online_ended_failures(value)
        for row, receipt in zip(expected, (first, second)):
            self.assertEqual(s.fingerprint(receipt), row['receiptSha256'])
        invocations = [{'commandId': row['commandId'], 'instanceId': 'i-1234567890abcdef0',
            'documentName': 'AWS-RunShellScript', 'status': 'Failed', 'responseCode': 1,
            'executionEnd': '2026-10-09T15:00:00.000Z', 'output': json.dumps(receipt)}
            for row, receipt in zip(expected, (first, second))]
        return value, invocations

    def test_exact_two_failures_are_independently_read_and_only_hashes_return(self):
        value, invocations = self.fixture()
        with patch.dict(os.environ, {'AWS_REGION': 'ap-northeast-1', 'PRODUCTION_INSTANCE_ID': 'i-1234567890abcdef0'}), \
                patch.object(t, 'command', side_effect=[json.dumps(v) for v in invocations]) as read:
            result = t.validate_pending_ended_failures(namespace(), value)
        self.assertEqual(result, s.pending_online_ended_failures(value)); self.assertEqual(read.call_count, 2)
        for call, invocation in zip(read.call_args_list, invocations):
            self.assertIn('get-command-invocation', call.args); self.assertIn(invocation['commandId'], call.args)
        self.assertNotIn('output', json.dumps(result)); self.assertNotIn('migrationAttempted', json.dumps(result))

    def test_not_ended_wrong_instance_command_receipt_and_duplicate_fields_are_rejected(self):
        for changed in ('status', 'responseCode', 'instanceId', 'commandId', 'documentName', 'executionEnd',
                        'hash', 'duplicate', 'oversize', 'read-error'):
            value, invocations = self.fixture()
            second = invocations[1]
            changes = {'status': 'InProgress', 'responseCode': 0, 'instanceId': 'i-other', 'commandId': '0' * 36,
                       'documentName': 'other', 'executionEnd': ''}
            if changed in changes: second[changed] = changes[changed]
            elif changed == 'hash': second['output'] = '{"private":"DO_NOT_EMIT_SENTINEL"}'
            elif changed == 'duplicate': second['output'] = '{"status":"one","status":"two"}'
            elif changed == 'oversize': second['output'] = 'a' * 16385
            responses = [json.dumps(v) for v in invocations]
            if changed == 'read-error': responses[1] = RuntimeError('DO_NOT_EMIT_SENTINEL')
            with self.subTest(changed=changed), patch.dict(os.environ, {'AWS_REGION': 'ap-northeast-1',
                    'PRODUCTION_INSTANCE_ID': 'i-1234567890abcdef0'}), patch.object(t, 'command', side_effect=responses):
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_PENDING_ONLINE_ENDED_FAILURE_CHANGED$'):
                    t.validate_pending_ended_failures(namespace(), value)


class PublicationFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.existing = load('pending_existing_release_test', 'api-admin-scope.test.py')
        cls.runner = cls.existing.ReleaseFailureTests()

    def origin(self, stage):
        value = context()
        if stage == 2:
            value['priorPublications'] = [{'release': '/opt/id-business-v2/releases/20261010T010000Z-' + '1' * 12,
                'commit': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': '3' * 64,
                'recordSha256': '4' * 64, 'buildProofSha256': '5' * 64}]
        return value

    def test_each_stage_writes_pending_record_and_switches_only_api_admin(self):
        for stage in (1, 2):
            with self.subTest(stage=stage):
                value = self.origin(stage)
                code, result, controller, manifest, failure = self.runner.run_release(
                    selected_scope=self.existing.workspace, pending_origin=value)
                self.assertEqual((code, failure), (0, False), result)
                self.assertEqual([call.args[-1] for call in controller.compose.call_args_list], ['admin', 'api'])
                self.assertEqual(manifest['servicesUpdated'], ['api', 'admin'])
                self.assertFalse(manifest['migrationApplied']); self.assertEqual(manifest['newMigrations'], [])
                publication = manifest['apiWorkspacePublication']
                self.assertEqual(publication['version'], 4)
                self.assertFalse(publication['configurationChanged']); self.assertFalse(publication['onlinePublished'])
                self.assertEqual(publication['pendingOnlineMigration']['publicationIndex'], stage)
                self.assertEqual(controller.pending_record['pendingOnlineMigrationOrigin'], value)
                self.assertEqual(controller.pending_record['baselineEvidence']['pendingOnlineMigrationOrigin'], value)
                self.assertNotIn('onlineOrigin', controller.pending_record); self.assertNotIn('onlineRechargePublication', manifest)
                controller.pending_projection.assert_called_once(); controller.rollback_service.assert_not_called()

    def test_pending_api_failure_rolls_back_only_the_two_switched_services(self):
        code, result, controller, manifest, failure = self.runner.run_release(
            selected_scope=self.existing.workspace, pending_origin=self.origin(1), fail_at='api-health')
        self.assertEqual(code, 1); self.assertTrue(failure); self.assertIsNone(manifest)
        self.assertEqual([call.args[2] for call in controller.rollback_service.call_args_list], ['api', 'admin'])
        self.assertEqual(result['servicesAttempted'], ['admin', 'api'])

    def test_each_independent_scope_readback_keeps_same_pending_origin(self):
        for stage in (1, 2):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, ExitStack() as stack:
                value = self.origin(stage)
                code, result, controller, manifest, _ = self.runner.run_release(
                    selected_scope=self.existing.workspace, pending_origin=value)
                self.assertEqual(code, 0, result)
                base = Path(temporary); prior = base / 'releases' / 'prior'; current = base / 'releases' / 'current'
                prior.mkdir(parents=True); current.mkdir(); (base / 'current').symlink_to(current)
                manifest['previousRelease'] = str(prior)
                record = controller.pending_record; proof = controller.pending_build_proof
                (current / s.STATE_FILE).write_text(json.dumps(record)); (current / s.PROOF_FILE).write_text(json.dumps(proof))
                (current / '.env.aws.production').write_bytes(b'fixture')
                controller.BASE = base; observed = record['after']; evidence = record['baselineEvidence']
                stack.enter_context(patch.object(s, 'baseline', return_value=(current, manifest, observed, evidence)))
                stack.enter_context(patch.object(s, 'configuration_hashes', return_value={'config': 'hash'}))
                stack.enter_context(patch.object(s, 'require_preserved'))
                stack.enter_context(patch.object(s, 'pending_projection', return_value=SimpleNamespace(validate_record=MagicMock())))
                stack.enter_context(patch.object(s, 'workspace_volume', return_value=record['workspaceVolumeAfter']))
                stack.enter_context(patch.object(s, 'workspace_configuration', return_value=proof['configuration']))
                stack.enter_context(patch.object(s, 'workspace_health'))
                stack.enter_context(patch.object(s, 'workspace_public_origin', return_value='https://example.test'))
                stack.enter_context(patch.object(s, 'workspace_backup_receipt', return_value=record['workspaceBackup']))
                stack.enter_context(patch.object(s, 'audit_receipt', return_value=manifest['dataAuditBefore']))
                stack.enter_context(patch.object(s, 'verify_running'))
                stack.enter_context(patch.object(s, 'snapshot', return_value=observed))
                guard = stack.enter_context(patch.object(s, 'pending_online_guard'))
                readback = s.readback(controller, self.existing.COMMIT)
                self.assertEqual(readback['pendingOnlineMigrationOrigin'], value)
                self.assertEqual(readback['preservedPendingOnlineMigration']['publicationIndex'], stage)
                self.assertEqual((readback['observedServiceCount'], readback['preservedServiceCount']), (7, 5))
                self.assertFalse(readback['onlinePublished']); self.assertFalse(readback['migrationPerformed'])
                guard.assert_called_once_with(controller, current, value)


class MigrationSource(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(dir=OUTPUT)
        cls.source = Path(cls.directory.name)
        names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', online.RECOVERY_COMMIT,
            online.MIGRATION_ROOT], cwd=ROOT).decode().splitlines()
        for name in [*names, online.SCHEMA_FILE, online.SEED_FILE]:
            revision = online.BASELINE_COMMIT if name in (online.SCHEMA_FILE, online.SEED_FILE) else online.RECOVERY_COMMIT
            path = cls.source / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_old_47_files_and_only_fixed_new_sql_are_recognized(self):
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (online, None))
        self.assertEqual(s.pending_online_migrations(controller, self.source), online.MIGRATION_FILE)
        self.assertEqual(len(s.migration_files(SimpleNamespace(require=need), self.source)), 48)

    def test_extra_migration_changed_sql_and_after_schema_are_rejected(self):
        names = [online.MIGRATION_ROOT + '/20261010000000_unknown/migration.sql',
                 online.MIGRATION_ROOT + '/' + online.MIGRATION_FILE, online.SCHEMA_FILE]
        for name in names:
            target = self.source / name
            old = target.read_bytes() if target.exists() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'ALTER TABLE unexpected;')
            try:
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    s.pending_online_migrations(SimpleNamespace(require=need,
                        online_recharge_scope=lambda: (online, None)), self.source)
            finally:
                if old is None: target.unlink(); target.parent.rmdir()
                else: target.write_bytes(old)


class TransportBinding(unittest.TestCase):
    @contextmanager
    def receipts(self, value=None):
        value = context() if value is None else value
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            old_cwd = os.getcwd(); os.chdir(temporary)
            output = Path('.deploy/production-release'); output.mkdir(parents=True)
            before = {'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED', 'mode': 'preflight',
                'commit': online.BASELINE_COMMIT, 'releaseCandidateCommit': 'a' * 40,
                'workflowRunId': '123', 'workflowRunAttempt': '1',
                'pendingOnlineMigrationOrigin': value, 'pendingOnlineEndedFailures': s.pending_online_ended_failures(value),
                'services': value['services'],
                'onlinePublished': False, 'migrationPerformed': False}
            (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
            receipt = {'pendingOnlineMigrationOrigin': value,
                'preservedPendingOnlineMigration': s.pending_online_marker(value),
                'services': copy.deepcopy(value['services']), 'observedServiceCount': 7,
                'servicesUpdated': ['api', 'admin'], 'onlinePublished': False, 'migrationPerformed': False}
            receipt['services']['api']['containerId'] = '9' * 64
            receipt['services']['admin']['containerId'] = '8' * 64
            env = {'RELEASE_COMMIT': 'a' * 40, 'EXPECTED_CURRENT': online.BASELINE_COMMIT,
                   'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
            try:
                with patch.dict(os.environ, env): yield before, receipt, output
            finally:
                os.chdir(old_cwd)

    def test_preflight_and_independent_readback_share_pending_origin(self):
        with self.receipts() as (before, receipt, output):
            self.assertTrue(t.validate_pending_workspace_receipt(namespace(), before, online.BASELINE_COMMIT, 'preflight'))
            self.assertTrue(t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback', proof={'pendingOnlineProjection': {}}))

    def test_readback_rejects_missing_origin_same_run_drift_and_all_five_preserved_services(self):
        for change in ('missing', 'online', 'run', 'candidate', 'proof', 'ended', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'):
            with self.subTest(change=change), self.receipts() as (before, receipt, output):
                proof = {'pendingOnlineProjection': {}}
                if change == 'missing': receipt.pop('pendingOnlineMigrationOrigin')
                elif change == 'online': receipt['onlinePublished'] = True
                elif change == 'run': before['workflowRunId'] = '124'
                elif change == 'candidate': before['releaseCandidateCommit'] = 'b' * 40
                elif change == 'proof': proof = {}
                elif change == 'ended': before.pop('pendingOnlineEndedFailures')
                else: receipt['services'][change]['configurationSha256'] = '0' * 64
                (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
                with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECEIPT_CHANGED'):
                    t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback', proof=proof)

    def test_projection_cannot_select_fallback_reader_when_origin_is_removed(self):
        with self.receipts() as (before, receipt, output):
            before.pop('pendingOnlineMigrationOrigin')
            receipt.pop('pendingOnlineMigrationOrigin'); receipt.pop('preservedPendingOnlineMigration')
            (output / 'api-workspace-preflight-result.json').write_text(json.dumps(before))
            with self.assertRaises(RuntimeError):
                t.validate_pending_workspace_receipt(namespace(), receipt, 'a' * 40, 'readback', proof={'pendingOnlineProjection': {}})

    def test_workspace_downloads_pin_projection_and_pending_source_readers(self):
        commands = t.parameters('a' * 40, online.BASELINE_COMMIT, 'preflight', 'API_ADMIN_WORKSPACE')['commands']
        for file in ('api-admin-pending-projection.py', 'online-recharge-scope.py', 'online-recharge-recovery.json'):
            self.assertTrue(any(file in command and 'curl -fsSL' in command for command in commands))
            self.assertTrue(any(file in command and 'sha256sum -c' in command for command in commands))


class RecoveryGate(unittest.TestCase):
    def test_missing_ended_second_failure_is_never_accepted(self):
        module = SimpleNamespace(release_recovery=MagicMock(return_value={'state': context()['migrationState']}))
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (module, None))
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_RECOVERY_REQUIRED'):
            s.pending_online_recovery(controller, Path('/not-production'))

    def test_diagnostic_projection_is_not_a_recovery_witness(self):
        recovery = {'state': context()['migrationState'], 'restored': {}, 'source': Path('/sealed')}
        module = SimpleNamespace(release_recovery=MagicMock(return_value=recovery),
            recovery_services=MagicMock(side_effect=RuntimeError('ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED')))
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (module, None), BASE=OUTPUT)
        directory = OUTPUT / 'releases/placeholder'
        with patch.object(s, 'snapshot', return_value=states()):
            with self.assertRaisesRegex(RuntimeError, 'ONLINE_RECHARGE_PRESERVED_CONTAINER_CHANGED'):
                s.pending_online_first(controller, directory)
        module.recovery_services.assert_called_once()

    def test_successor_context_is_removed_from_original_failed_publication_reader(self):
        module = SimpleNamespace(release_recovery=MagicMock(return_value={'state': context()['migrationState'], 'restored': {}}))
        controller = SimpleNamespace(require=need, online_recharge_scope=lambda: (module, None),
            _pendingOnlineMigrationOrigin=context(), _pendingOnlineHistoryProjected=True)
        s.pending_online_recovery(controller, Path('/sealed'))
        reader = module.release_recovery.call_args.args[0]
        self.assertFalse(hasattr(reader, '_pendingOnlineMigrationOrigin'))
        self.assertFalse(hasattr(reader, '_pendingOnlineHistoryProjected'))


class PreservationGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(dir=OUTPUT)
        cls.sealed = Path(cls.directory.name) / 'sealed'; cls.sealed.mkdir()
        names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', online.RECOVERY_COMMIT,
            online.MIGRATION_ROOT], cwd=ROOT).decode().splitlines()
        for name in [*names, online.SCHEMA_FILE, online.SEED_FILE, *s.CONFIG_FILES[:2]]:
            revision = online.BASELINE_COMMIT if name not in names else online.RECOVERY_COMMIT
            path = cls.sealed / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(subprocess.check_output(['git', 'show', revision + ':' + name], cwd=ROOT))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    @contextmanager
    def fixture(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            old, new = (Path(temporary) / n for n in ('old', 'new'))
            for directory in (old, new):
                shutil.copytree(self.sealed, directory)
                (directory / '.env.aws.production').write_bytes(b'TEST_ONLY=fixture\n')
                (directory / 'compose.release.json').write_text(json.dumps({'services': {
                    n: {'image': 'old-' + n, 'pull_policy': 'never'} for n in ('api', 'admin', 'media-resolver', 'auto-recharge', 'auto-registration')}}))
            (old / online.MIGRATION_ROOT / online.MIGRATION_FILE).unlink()
            (old / online.MIGRATION_ROOT / online.MIGRATION_NAME).rmdir()
            before = states()
            controller = SimpleNamespace(require=need, _pendingOnlineMigrationOrigin=context(),
                online_recharge_scope=lambda: (online, None), migration_plan=MagicMock(return_value=[online.MIGRATION_FILE]),
                compose=MagicMock(), apply_migration=MagicMock(), run_release_migrations=MagicMock())
            with patch.object(s, 'pending_online_guard') as guard, patch.object(s, 'snapshot', return_value=before) as snapshot:
                yield controller, old, new, before, guard, snapshot

    def test_projected_schema_compose_and_only_known_migration_plan_pass_without_migrating(self):
        with self.fixture() as (controller, old, new, before, guard, snapshot):
            self.assertEqual(s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n', all_services=True), before)
            guard.assert_called_once_with(controller, old, controller._pendingOnlineMigrationOrigin, all_services=True)
            controller.apply_migration.assert_not_called(); controller.run_release_migrations.assert_not_called()
            controller.compose.assert_not_called()

    def test_raw_online_schema_compose_and_unrelated_migration_still_block(self):
        for changed in ('schema', 'compose', 'migration'):
            with self.subTest(changed=changed), self.fixture() as (controller, old, new, before, guard, snapshot):
                if changed in ('schema', 'compose'):
                    name = online.SCHEMA_FILE if changed == 'schema' else s.CONFIG_FILES[0]
                    (new / name).write_bytes(subprocess.check_output(['git', 'show', online.RECOVERY_COMMIT + ':' + name], cwd=ROOT))
                else: controller.migration_plan.return_value = ['20261010000000_other/migration.sql']
                with self.assertRaises(RuntimeError): s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n')
                controller.apply_migration.assert_not_called(); controller.run_release_migrations.assert_not_called()

    def test_caddy_is_preserved_as_fifth_service_and_never_restartable_in_pending_mode(self):
        with self.fixture() as (controller, old, new, before, guard, snapshot):
            changed = copy.deepcopy(before); changed['caddy']['containerId'] = '0' * 64
            snapshot.return_value = changed
            with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PRESERVED_CONTAINER_CHANGED'):
                s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n')

    def test_changed_old_47_file_is_not_hidden_by_new_migration_admission(self):
        with self.fixture() as (controller, old, new, before, guard, snapshot):
            (new / online.MIGRATION_ROOT / 'migration_lock.toml').write_bytes(b'provider="other"')
            with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_PENDING_ONLINE_MIGRATION_SOURCE_CHANGED'):
                s.require_preserved(controller, old, new, before, b'TEST_ONLY=fixture\n')


if __name__ == '__main__':
    unittest.main()
