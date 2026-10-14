"""Pure lifecycle tests. All controllers, containers, SQL and service calls are mocks."""

import base64
import copy
from datetime import datetime, timezone
import gzip
import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('online_component_runtime_test', HERE / 'online-recharge-component-runtime.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        for patcher in (patch.object(r.c, 'SEALED_ORDINARY_COMPONENT', None),
                        patch.object(r.c, 'ADMIN_SUCCESSOR', None),
                        patch.object(r, 'RUNTIME_ADAPTER_READY', False)):
            patcher.start(); self.addCleanup(patcher.stop)
        self.auth = copy.deepcopy(r.c.AUTHENTICATED_PREDECESSOR)
        self.admin_auth = copy.deepcopy(r.c.AUTHENTICATED_ADMIN_SUCCESSOR)
        self.p = {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1'}
        self.repo = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'

    def enabled(self):
        return patch.multiple(r, RUNTIME_ADAPTER_READY=True)

    def seal(self):
        return patch.multiple(r.c, SEALED_ORDINARY_COMPONENT=self.auth, ADMIN_SUCCESSOR=self.admin_auth)

    def native(self, receipt, *, response=0, status='Success'):
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        return encoded({'CommandId': '11111111-2222-3333-4444-555555555555',
            'InstanceId': self.auth['instanceId'], 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': status, 'ResponseCode': response,
            'StandardErrorContent': '', 'StandardOutputContent': encoded(r.wire(receipt)).decode(),
            'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now})

    def private_prepare_fixture(self, directory):
        # Original frozen private I/O is real. Source transport, acceptance,
        # containers, SQL and service operations remain mocked.
        core = r.c.load_core(self.auth['coreSha256'])
        transport = {'version': 1, 'expectedCurrent': self.admin_auth['producer']['commit'],
            'syntheticPublicTransport': True}
        output = {'synthetic-public-source.txt': (b'public fixture\n', '100644')}
        record = {'kind': r.KIND + '_SOURCE', 'syntheticProjection': True}
        def store(context, files):
            context.mkdir(parents=True, mode=0o700)
            for name, (raw, _mode) in files.items(): (context / name).write_bytes(raw)
        return {'core': core, 'transport': transport, 'record': record, 'output': output,
            'd': SimpleNamespace(write_registration_files=Mock(side_effect=store))}

    def call_private_prepare(self, directory, fixture):
        with self.seal(), self.enabled(), patch.dict(r.os.environ, GITHUB_ACTIONS='true'), \
             patch.object(r.c, 'load_core', return_value=fixture['core']), \
             patch.object(r, 'validate_preflight', return_value={'baseline': {},
                 'sourceProjectionSha256': r.c.fingerprint(fixture['record'])}), \
             patch.object(r, 'source', return_value=({}, fixture['output'], fixture['record'])), \
             patch.object(r.Path, 'cwd', return_value=directory):
            return r.prepare(fixture['d'], self.p, fixture['transport'])

    def test_prepare_existing_preflight_private_io_preserves_original_and_refuses_replay(self):
        with tempfile.TemporaryDirectory(prefix='online-prepare-private-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td); f = self.private_prepare_fixture(directory)
            preflight = directory / r.PREFLIGHT
            original = f['core'].write_private(preflight, f['transport'])
            identity = lambda p: (p.stat().st_dev, p.stat().st_ino, p.stat().st_mode,
                p.stat().st_uid, p.stat().st_gid, p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns)
            before = identity(preflight)
            with patch.object(f['core'], 'write_private', wraps=f['core'].write_private) as write:
                self.assertEqual(self.call_private_prepare(directory, f), f['record'])
                write.assert_called_once_with(directory / r.PROJECTION, f['record'])
                self.assertEqual(preflight.read_bytes(), original)
                self.assertEqual(identity(preflight), before)
                self.assertEqual(f['core'].closed_json(f['core'].private_bytes(directory / r.PROJECTION)), f['record'])
                projection_before = (directory / r.PROJECTION).read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_EXISTS'):
                    self.call_private_prepare(directory, f)
                self.assertEqual(write.call_count, 1)
                self.assertEqual(f['d'].write_registration_files.call_count, 1)
                self.assertEqual((directory / r.PROJECTION).read_bytes(), projection_before)
                self.assertEqual(preflight.read_bytes(), original)
                self.assertEqual(identity(preflight), before)

    def test_prepare_missing_preflight_private_io_refuses_before_context_or_projection_write(self):
        with tempfile.TemporaryDirectory(prefix='online-prepare-missing-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td); f = self.private_prepare_fixture(directory)
            with patch.object(f['core'], 'write_private', wraps=f['core'].write_private) as write:
                with self.assertRaises(FileNotFoundError): self.call_private_prepare(directory, f)
                write.assert_not_called(); f['d'].write_registration_files.assert_not_called()
            self.assertFalse((directory / r.CONTEXT).exists())
            self.assertFalse((directory / r.PROJECTION).exists())

    def test_prepare_symlink_preflight_private_io_refuses_before_context_or_projection_write(self):
        with tempfile.TemporaryDirectory(prefix='online-prepare-symlink-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td); f = self.private_prepare_fixture(directory)
            target = directory / 'synthetic-public-original.json'
            original = f['core'].write_private(target, f['transport'])
            preflight = directory / r.PREFLIGHT; preflight.parent.mkdir(parents=True, mode=0o700)
            preflight.symlink_to(target)
            with patch.object(f['core'], 'write_private', wraps=f['core'].write_private) as write:
                with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'):
                    self.call_private_prepare(directory, f)
                write.assert_not_called(); f['d'].write_registration_files.assert_not_called()
            self.assertTrue(preflight.is_symlink()); self.assertEqual(target.read_bytes(), original)
            self.assertFalse((directory / r.CONTEXT).exists())
            self.assertFalse((directory / r.PROJECTION).exists())

    def test_prepare_different_preflight_private_io_refuses_before_context_or_projection_write(self):
        with tempfile.TemporaryDirectory(prefix='online-prepare-different-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td); f = self.private_prepare_fixture(directory)
            preflight = directory / r.PREFLIGHT
            original = f['core'].write_private(preflight, {**f['transport'], 'unreviewed': True})
            with patch.object(f['core'], 'write_private', wraps=f['core'].write_private) as write:
                with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_RECEIPT_CHANGED'):
                    self.call_private_prepare(directory, f)
                write.assert_not_called(); f['d'].write_registration_files.assert_not_called()
            self.assertEqual(preflight.read_bytes(), original)
            self.assertFalse((directory / r.CONTEXT).exists())
            self.assertFalse((directory / r.PROJECTION).exists())

    def test_prepare_preflight_bytes_drift_after_projection_private_io_refuses(self):
        with tempfile.TemporaryDirectory(prefix='online-prepare-drift-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td); f = self.private_prepare_fixture(directory)
            preflight = directory / r.PREFLIGHT; original = f['core'].write_private(preflight, f['transport'])
            write_private = f['core'].write_private
            def write_projection(path, value):
                self.assertEqual(path, directory / r.PROJECTION)
                raw = write_private(path, value)
                preflight.write_bytes(original + b' ')  # JSON is equal; original raw bytes are not.
                return raw
            with patch.object(f['core'], 'write_private', side_effect=write_projection) as write:
                with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_RECEIPT_CHANGED'):
                    self.call_private_prepare(directory, f)
                write.assert_called_once_with(directory / r.PROJECTION, f['record'])
                f['d'].write_registration_files.assert_called_once()
            self.assertTrue((directory / r.CONTEXT).is_dir())
            self.assertEqual(f['core'].closed_json(f['core'].private_bytes(directory / r.PROJECTION)), f['record'])
            self.assertEqual(preflight.read_bytes(), original + b' ')

    def test_none_and_unreviewed_adapter_refuse_before_controller_or_io(self):
        calls = (lambda: r.modules(), lambda: r.baseline(None, ''), lambda: r.preflight(None, {}, ''),
            lambda: r.prepare(None, {}, {}), lambda: r.build_proof(None, {}, {}, '', ''),
            lambda: r.release(None, None, {}, {}), lambda: r.readback(None, ''),
            lambda: r.restore(None, None, None, None, None, None, {}, {}, None, [], {}),
            lambda: r.backup_cas(None, None, None, None, {}, {}, {}), lambda: r.cli())
        with patch.object(r.c, 'load_core', side_effect=AssertionError('controller forbidden')):
            for call in calls:
                with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NOT_SEALED'):
                    call()
            with self.seal():
                for call in calls:
                    with self.assertRaisesRegex(RuntimeError, 'RUNTIME_ADAPTER_NOT_READY'):
                        call()

    def test_admin_authority_is_independent_and_required_before_loading_any_controller(self):
        with self.seal(), self.enabled():
            self.assertEqual(r.current_predecessor(), self.admin_auth['producer']['commit'])
            self.assertEqual(r.authority()['producer'], self.auth['producer'])
            self.assertNotEqual(r.native_path(SimpleNamespace(BASE=Path('/fixture'))),
                r.current_native_path(SimpleNamespace(BASE=Path('/fixture'))))
            with patch.object(r.c, 'ADMIN_SUCCESSOR', None), \
                 patch.object(r.c, 'load_core', side_effect=AssertionError('no controller or SQL')):
                for call in (r.modules, r.current_predecessor, lambda: r.baseline(None, self.auth['producer']['commit'])):
                    with self.assertRaisesRegex(RuntimeError, 'ADMIN_SUCCESSOR_NOT_SEALED'): call()

    def test_typed_gzip_wire_retains_original_ended_native_validation(self):
        # Deliberately synthetic F, with a large but compressible projection.
        receipt = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND, 'projection': 'a' * 80000}
        core = r.c.load_core(self.auth['coreSha256'])
        with self.seal(), self.enabled():
            raw = self.native(receipt)
            native, measured = r.validate_component_invocation(core, raw,
                '11111111-2222-3333-4444-555555555555', self.auth['instanceId'])
            self.assertEqual(measured, receipt)
            self.assertLess(len(native['StandardOutputContent']), 24000)
            for field, value in (('ResponseCode', 1), ('Status', 'InProgress'),
                                 ('StandardErrorContent', 'synthetic forbidden'), ('InstanceId', 'i-00000000000000000')):
                bad = json.loads(raw); bad[field] = value
                with self.assertRaises(RuntimeError):
                    r.validate_component_invocation(core, encoded(bad), native['CommandId'], self.auth['instanceId'])

    def test_wire_hash_length_kind_bombs_and_concatenated_members_rejected(self):
        core = r.c.load_core(self.auth['coreSha256'])
        value = {'scope': r.SCOPE, 'kind': r.KIND}
        with self.seal(), self.enabled():
            raw = self.native(value); original = json.loads(raw)
            for field, replacement in (('payloadSha256', '0' * 64), ('decodedLength', True),
                                       ('decodedLength', 1), ('kind', 'OLD_B'), ('extra', 'x')):
                native = copy.deepcopy(original); envelope = json.loads(native['StandardOutputContent'])
                envelope[field] = replacement; native['StandardOutputContent'] = encoded(envelope).decode()
                with self.assertRaises(RuntimeError):
                    r.validate_component_invocation(core, encoded(native), native['CommandId'], self.auth['instanceId'])
        for raw in (gzip.compress(b'a' * (256 * 1024)), gzip.compress(b'{}') + gzip.compress(b'{}')):
            with self.assertRaises(RuntimeError):
                r.bounded_gzip(raw, 256 * 1024)

    def test_wire_limit_covers_complete_compact_utf8_stdout_and_newline(self):
        fixture = ''.join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(800))
        value = {'scope': r.SCOPE, 'kind': r.KIND, 'syntheticFrameFixture': fixture[:18000]}
        envelope = r.wire(value)
        stdout = (json.dumps(envelope, sort_keys=True, separators=(',', ':')) + '\n').encode()
        self.assertLess(len(stdout), 23000)
        value['syntheticFrameFixture'] = fixture
        with self.assertRaisesRegex(RuntimeError, 'WIRE_TOO_LARGE'):
            r.wire(value)

    def test_cli_compression_is_explicit_bounded_and_closed_json(self):
        core = r.c.load_core(self.auth['coreSha256']); value = {'a': 1}
        for text in (base64.b64encode(encoded(value)).decode(),
            'gzip-base64:' + base64.b64encode(gzip.compress(encoded(value))).decode()):
            self.assertEqual(r.decode_json(core, text), value)
        for text in ('gzip-base64:' + base64.b64encode(gzip.compress(b'{"a":1,"a":2}')).decode(),
                     base64.b64encode(gzip.compress(encoded(value))).decode()):
            with self.assertRaises((RuntimeError, ValueError, UnicodeDecodeError)):
                r.decode_json(core, text)

    def test_preflight_binds_new_namespace_instance_raw_and_typed_receipt(self):
        core = r.c.load_core(self.auth['coreSha256'])
        pref = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND, 'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED',
            'producer': self.p, 'baseline': {'ordinaryAuthoritySha256': r.c.fingerprint(self.auth),
                'actualPredecessor': self.admin_auth['producer'], 'adminAuthoritySha256': r.c.fingerprint(self.admin_auth)},
            'migrationPerformed': False, 'databaseGrantsChanged': False,
            'executionMigrationPlan': [], 'onlinePublished': False, 'businessActions': 0}
        raw = self.native(pref)
        f = {'version': 1, 'kind': r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': self.p,
            'expectedCurrent': self.admin_auth['producer']['commit'],
            'commandId': '11111111-2222-3333-4444-555555555555', 'instanceId': self.auth['instanceId'],
            'invocationBytesSha256': r.c.digest(raw), 'invocationRawBase64': base64.b64encode(raw).decode(), 'serverReceipt': pref}
        with self.seal(), self.enabled():
            self.assertEqual(r.validate_preflight(core, f, self.p, f['expectedCurrent']), pref)
            for field, value in (('instanceId', 'i-00000000000000000'), ('version', True),
                                 ('expectedCurrent', self.auth['producer']['commit']),
                                 ('invocationBytesSha256', '0' * 64), ('extra', 1)):
                bad = copy.deepcopy(f); bad[field] = value
                with self.assertRaises(RuntimeError):
                    r.validate_preflight(core, bad, self.p, f['expectedCurrent'])

    def test_build_contract_uses_four_exact_images_and_never_ddl(self):
        record = {'synthetic': True}; f = {'synthetic': True}
        value = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND + '_BUILD_PROOF', 'producer': self.p,
            'qualityRunId': '456', 'sourceProjection': record, 'preflightSha256': r.c.fingerprint(f),
            'migrations': dict(r.c.MIGRATIONS), 'images': {name: {'reference': self.repo + ':' +
                self.p['commit'] + '-123-1-' + name, 'imageId': 'sha256:' + 'c' * 64, 'fileCount': 123,
                'sha256': 'd' * 64} for name in r.IMAGES}}
        with self.seal(), self.enabled():
            self.assertEqual(r.validate_build(value, self.p, record, f, '456', self.repo), value)
            for kind in ('boolean_count', 'missing_engine', 'mutable_tag', 'migration_changed', 'extra'):
                bad = copy.deepcopy(value)
                if kind == 'boolean_count': bad['images']['api']['fileCount'] = True
                elif kind == 'missing_engine': bad['images'].pop('online-recharge')
                elif kind == 'mutable_tag': bad['images']['api']['reference'] = self.repo + ':latest'
                elif kind == 'migration_changed': bad['migrations'][r.c.ONLINE_MIGRATION] = '0' * 64
                else: bad['extra'] = 'no'
                with self.assertRaises(RuntimeError):
                    r.validate_build(bad, self.p, record, f, '456', self.repo)

    def test_switch_holds_read_fence_through_engine_and_tracks_actual_stop(self):
        events = []
        d = Mock(); d.run.side_effect = lambda *a, **k: events.append(a[:2]) or ''
        d.assert_no_active_recharge = Mock()
        d.compose.side_effect = lambda _dir, *a, **k: events.append(('up', a[-1])) or ''
        source_api = {'containerId': 'c' * 64, 'image': 'sha256:' + 'd' * 64, 'startedAtSha256': 'e' * 64}
        evidence = {'services': {'api': source_api}, 'workspaceVolume': {'status': 'PRESENT'}}
        audit = MagicMock(); audit.pipe.deadline = 10**12; audit.receipt = {'synthetic': True}
        audit.check.side_effect = lambda: events.append(('audit', 'check'))
        class Gate:
            def __init__(self):
                self.d = d; self.record = {'synthetic': True}; self.deadline = 10**12 - 60; self.connection = object()
            check_locked = Mock(); check_marker = Mock()
            def stop_previous(self):
                self.d.run('docker', 'stop', '--time', '30', source_api['containerId'], timeout=40)
                self.connection = None
        gate = Gate(); workspace = Mock(); online = Mock(); core = Mock()
        workspace.workspace_prepare.return_value = gate
        workspace.online_engine_idle.side_effect = lambda *_: events.append(('engine', 'idle'))
        changed, holder = [], {}
        with self.seal(), self.enabled(), patch.object(r, 'preserve'), patch.object(r, 'audit_barrier', return_value=audit), \
             patch.object(r, 'wait_healthy', return_value={'containerId': 'f' * 64}):
            actual_gate, receipt = r.switch(d, core, workspace, online, Path('/prev'), Path('/target'), evidence,
                {'synthetic': True}, SimpleNamespace(), changed, gate_holder=holder)
        self.assertIs(actual_gate, gate); self.assertEqual(receipt, audit.receipt)
        self.assertEqual(changed, ['admin', 'api', 'online-recharge'])
        self.assertIn(('docker', 'stop'), events)
        self.assertLess(events.index(('up', 'api')), events.index(('up', 'online-recharge')))
        self.assertLess(events.index(('up', 'online-recharge')), events.index(('engine', 'idle')))
        self.assertIs(holder['audit'], audit); audit.__exit__.assert_not_called()
        self.assertTrue(holder['sqliteReleasedAfterStop'])
        self.assertEqual(holder['controller'].deadline, audit.pipe.deadline)
        self.assertEqual(holder['controller'].reserve, r.RESTORE_BUDGET_SECONDS)
        workspace.migrate.assert_not_called(); online.sync_new_table_grants.assert_not_called()

    def test_failed_gate_precheck_does_not_claim_api_stop(self):
        d, workspace, online, core = Mock(), Mock(), Mock(), Mock()
        d.assert_no_active_recharge = Mock()
        gate = Mock(); gate.record = {'synthetic': True}; gate.check_locked.side_effect = RuntimeError('SYNTHETIC_CHANGED')
        gate.deadline = 10**12
        workspace.workspace_prepare.return_value = gate
        audit = MagicMock(); audit.pipe.deadline = 10**12; changed, holder = [], {}
        with self.seal(), self.enabled(), patch.object(r, 'preserve'), patch.object(r, 'audit_barrier', return_value=audit):
            with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_CHANGED'):
                r.switch(d, core, workspace, online, Path('/p'), Path('/t'),
                    {'services': {'api': {}}, 'workspaceVolume': {}}, {}, SimpleNamespace(), changed, gate_holder=holder)
        self.assertEqual(changed, ['admin']); gate.stop_previous.assert_not_called()

    def test_busy_or_unknown_task_blocks_fault_restore_before_any_stop(self):
        for blocked in ('ordinary', 'online'):
            d, core, workspace, online = Mock(), Mock(), Mock(), Mock()
            (workspace.jobs_idle if blocked == 'ordinary' else online.require_fresh_resources).side_effect = RuntimeError('SYNTHETIC_BUSY')
            with self.seal(), self.enabled():
                with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_BUSY'):
                    r.restore(d, core, workspace, online, Path('/p'), Path('/t'), {}, {},
                        SimpleNamespace(api_fault_restore_approved=True), ['admin', 'api', 'online-recharge'], {})
            d.run.assert_not_called(); d.rollback_service.assert_not_called(); core.stop_failed_api.assert_not_called()

    def test_restore_engine_must_be_known_and_removed_before_api(self):
        events = []; d, core, workspace, online = Mock(), Mock(), Mock(), Mock()
        states = {n: {'image': 'sha256:' + 'a' * 64, 'reference': 'exact', 'environmentSha256': 'b' * 64,
            'status': 'running', 'health': 'healthy'} for n in r.c.SERVICES}
        evidence = {'services': states, 'workspaceVolume': {'name': 'safe'}, 'configurationModels': {'api': {}, 'admin': {}},
            'environmentFileSha256': r.c.digest(b'public fixture')}
        workspace.snapshot.return_value = states; workspace.workspace_volume.return_value = evidence['workspaceVolume']
        core.configuration_model.return_value = {}; core.private_bytes.return_value = b'public fixture'
        core.write_private.side_effect = lambda _path, value: encoded(value)
        d.compose.return_value = 'known'
        core.stop_failed_api.side_effect = lambda *_: events.append('api-stop')
        d.rollback_service.side_effect = lambda _p, _t, name, _e: events.append('restore-' + name)
        gate = Mock(); gate.record = {'synthetic': True}; gate.volume = {'name': 'safe'}; gate.summary = {'logicalSha256': 'd' * 64}
        proof = {'producer': self.p, 'images': {'api': {'reference': 'exact'}}}
        # All temporary fixtures stay inside this project. No real controller,
        # service, volume or business database is used.
        with tempfile.TemporaryDirectory(prefix='online-component-pure-', dir=HERE.parents[1] / '.runtime') as td:
            previous = Path(td) / 'old'; target = Path(td) / 'new'; previous.mkdir(); target.mkdir()
            d.BASE = Path(td); (d.BASE / 'current').symlink_to(previous)
            def remove(*_, **_kwargs): events.append('engine-remove'); d.compose.return_value = ''
            with self.seal(), self.enabled(), patch.object(r, 'remove_added_engine', side_effect=remove), \
                 patch.object(r, 'predecessor_records', return_value=(b'1', b'2', b'3', b'4')), \
                 patch.object(r.c, 'verify_applied_database', return_value={'synthetic': True}), \
                 patch.object(r, 'verify_online_grants', return_value={'synthetic': True}):
                result = r.restore(d, core, workspace, online, previous, target, evidence, proof,
                    SimpleNamespace(api_fault_restore_approved=True, run_id='123'), ['admin', 'api', 'online-recharge'], {'gate': gate})
        self.assertEqual(events, ['engine-remove', 'api-stop', 'restore-api', 'restore-admin'])
        self.assertEqual(result['status'], 'RESTORED_INDEPENDENT_READBACK_REQUIRED')
        gate.abort.assert_called_once(); d.run.assert_not_called()

    def test_fenced_controller_bounds_commands_and_preserves_native_service_fields(self):
        d = Mock(); d.historical_fingerprint.side_effect = r.c.fingerprint
        d.assert_no_active_recharge = Mock()
        metadata = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64,
            'Config': {'Image': 'exact-image', 'Env': ['SYNTHETIC_PUBLIC=value']},
            'State': {'Status': 'running', 'StartedAt': '2026-10-14T00:00:00Z', 'Health': {'Status': 'healthy'}}}
        d.compose.return_value = metadata['Id']; d.run.return_value = json.dumps([metadata])
        with patch.object(r.time, 'monotonic', return_value=100), self.seal(), self.enabled():
            bounded = r.DeadlineController(d, 120)
            state = bounded.service_state(Path('/synthetic'), 'api', include_container_id=True, include_environment_hash=True)
            self.assertEqual(state['containerId'], metadata['Id'])
            self.assertEqual(state['environmentSha256'], r.c.fingerprint(metadata['Config']['Env']))
            self.assertEqual(d.run.call_args.kwargs['timeout'], 17)
            for name in ('registration_download', 'wait_healthy'):
                with self.assertRaisesRegex(RuntimeError, 'FENCED_UNBOUNDED_OPERATION'):
                    getattr(bounded, name)
            with patch.object(r.time, 'monotonic', return_value=119):
                before = d.run.call_count
                with self.assertRaisesRegex(RuntimeError, 'FENCE_TIMEOUT'):
                    bounded.run('synthetic', timeout=60)
                self.assertEqual(d.run.call_count, before)

    def test_all_four_images_require_dedicated_projection_label_on_server(self):
        record = {'synthetic': True}; online, d = Mock(), Mock()
        metadata = {'Id': 'sha256:' + 'c' * 64, 'Architecture': 'amd64', 'Config': {'Labels': {
            'org.opencontainers.image.revision': self.p['commit'], 'id-business-v2.source-tree': self.p['sourceTree'],
            r.LABEL: r.c.fingerprint(record)}}}
        with self.seal(), self.enabled():
            for name in r.IMAGES:
                row = {'reference': self.repo + ':' + self.p['commit'] + '-123-1-' + name, 'imageId': metadata['Id']}
                d.run.return_value = json.dumps([metadata])
                r.verify_image_identity(d, online, row, self.p, record)
                for field in (r.LABEL, 'org.opencontainers.image.revision', 'id-business-v2.source-tree'):
                    for missing in (True, False):
                        bad = copy.deepcopy(metadata)
                        if missing: bad['Config']['Labels'].pop(field)
                        else: bad['Config']['Labels'][field] = 'synthetic-wrong'
                        d.run.return_value = json.dumps([bad])
                        with self.subTest(image=name, field=field, missing=missing), self.assertRaisesRegex(RuntimeError, 'IMAGE_PROVENANCE_CHANGED'):
                            r.verify_image_identity(d, online, row, self.p, record)

    def test_failed_publication_keeps_actual_candidate_and_unknown_business_state(self):
        value = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND, 'status': 'ONLINE_RECHARGE_COMPONENT_FAILED',
            'producer': self.p, 'phase': 'publication', 'code': 'ONLINE_RECHARGE_COMPONENT_SYNTHETIC_FAULT',
            'servicesAttempted': ['admin', 'api', 'online-recharge'],
            'recovery': {'status': 'BLOCKED_OR_FAILED', 'sqliteMaintenanceRetained': True},
            'publication': {'attempted': True, 'currentRole': 'CANDIDATE', 'onlinePublished': True},
            'onlinePublished': True, 'migrationPerformed': False, 'databaseGrantsChanged': False,
            'executionMigrationPlan': [], 'volumeDeletionPerformed': False, 'businessActions': None}
        with self.seal(), self.enabled():
            self.assertEqual(r.validate_failure_receipt(value, self.p), value)
            for field, bad_value in (('onlinePublished', False), ('businessActions', 0), ('phase', 'unapproved'),
                                     ('code', 'SYNTHETIC_TOKEN_OR_RAW_ERROR'), ('extra', 'x')):
                bad = copy.deepcopy(value); bad[field] = bad_value
                with self.assertRaises(RuntimeError): r.validate_failure_receipt(bad, self.p)
            restored = copy.deepcopy(value)
            restored.update(businessActions=0, onlinePublished=False,
                publication={'attempted': True, 'currentRole': 'PREDECESSOR', 'onlinePublished': False},
                recovery={'status': 'RESTORED_INDEPENDENT_READBACK_REQUIRED', 'independentReadbackRequired': True,
                    'recordSha256': 'c' * 64, 'recordBytesSha256': 'd' * 64,
                    'failedRelease': '/opt/id-business-v2/releases/20261014T000000Z-' + self.p['commit'][:12]})
            self.assertEqual(r.validate_failure_receipt(restored, self.p), restored)

    def test_fresh_s3_checksum_size_encryption_and_actual_file_digest_are_required(self):
        raw = b'synthetic compressed backup bytes'; digest = hashlib.sha256(raw).digest()
        receipt = {'sha256': digest.hex(), 'size': len(raw)}
        head = {'ContentLength': len(raw), 'ChecksumSHA256': base64.b64encode(digest).decode(), 'ServerSideEncryption': 'AES256'}
        with self.seal(), self.enabled():
            r.verify_backup_head(receipt, digest, head)
            for field, bad_value in (('ContentLength', True), ('ContentLength', 1),
                ('ChecksumSHA256', base64.b64encode(b'a' * 32).decode()), ('ServerSideEncryption', None)):
                bad = dict(head); bad[field] = bad_value
                with self.assertRaisesRegex(RuntimeError, 'S3_BACKUP_CHANGED'):
                    r.verify_backup_head(receipt, digest, bad)
            with self.assertRaisesRegex(RuntimeError, 'S3_BACKUP_CHANGED'):
                r.verify_backup_head(receipt, b'a' * 32, head)

    def test_pre_engine_preservation_reads_seven_services_from_ordinary_context(self):
        d, core, workspace, online = Mock(), Mock(), Mock(), Mock()
        states = {n: {'synthetic': n} for n in r.c.SERVICES}; volume = {'name': 'synthetic'}
        evidence = {'manifestBytesSha256': r.c.digest(b'public manifest'),
            'environmentFileSha256': r.c.digest(b'public env'), 'services': states, 'workspaceVolume': volume}
        core.private_bytes.side_effect = lambda path: b'public env' if path.name == '.env.aws.production' else b'public manifest'
        workspace.workspace_volume.return_value = volume; d.migration_plan.return_value = []
        with tempfile.TemporaryDirectory(prefix='online-context-pure-', dir=HERE.parents[1] / '.runtime') as td:
            d.BASE = Path(td); previous = d.BASE / 'old'; target = d.BASE / 'new'; previous.mkdir(); target.mkdir()
            (d.BASE / 'current').symlink_to(previous)
            workspace.snapshot.side_effect = lambda _d, directory: states if directory == previous else (_ for _ in ()).throw(AssertionError('target would include absent engine'))
            online.snapshot.side_effect = AssertionError('no engine before startup')
            with self.seal(), self.enabled(), patch.object(r.c, 'migration_source_check') as source_guard:
                self.assertEqual(r.preserve(d, core, workspace, online, previous, target, evidence, {}, pointer=previous,
                    all_services=True), states)
                self.assertEqual(source_guard.call_args_list[0].kwargs, {'candidate': False})
                self.assertEqual(source_guard.call_args_list[1].kwargs, {'candidate': True})
            online.snapshot.assert_not_called()

    def test_fault_after_switch_failure_cannot_restore_with_unbounded_or_expired_controller(self):
        original = Mock(); original.assert_no_active_recharge = Mock()
        audit = Mock(); audit.pipe.deadline = 200
        with self.seal(), self.enabled(), patch.object(r.time, 'monotonic', return_value=100):
            bounded = r.DeadlineController(original, 200)
            self.assertIs(r.fault_restore_controller(original, {'audit': audit, 'controller': bounded}), bounded)
            for controller in (None, original, r.DeadlineController(original, 201)):
                with self.assertRaisesRegex(RuntimeError, 'RESTORE_FENCE_CONTROLLER_REQUIRED'):
                    r.fault_restore_controller(original, {'audit': audit, 'controller': controller})
            with patch.object(r.time, 'monotonic', return_value=199):
                with self.assertRaisesRegex(RuntimeError, 'FENCE_TIMEOUT'):
                    r.fault_restore_controller(original, {'audit': audit, 'controller': bounded})
        original.run.assert_not_called(); original.rollback_service.assert_not_called()

    def test_after_audit_uses_original_function_with_read_deadline_and_restore_reserve(self):
        original = Mock(); original.assert_no_active_recharge = Mock()
        controller = r.load('remote-deploy.py'); original.audit = controller.audit
        original_compose = controller.compose
        original.compose.return_value = json.dumps({'ok': True, 'violationCount': 0, 'checkCount': 49})
        audit = Mock(); audit.pipe.deadline = 310
        gate = Mock(); gate.deadline = 250; gate.connection = None
        with self.seal(), self.enabled(), patch.object(r.time, 'monotonic', return_value=100), \
             patch.object(controller, 'environment_values', return_value={'V2_DATA_INTEGRITY_DATABASE_URL':
                'mysql://synthetic:synthetic@localhost/synthetic'}), \
             tempfile.TemporaryDirectory(prefix='online-deadline-pure-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td); receipt = directory / 'audit.json'
            bounded = r.DeadlineController(original, 310, reserve=r.RESTORE_BUDGET_SECONDS)
            holder = {'audit': audit, 'gate': gate, 'controller': bounded, 'sqliteReleasedAfterStop': True}
            bounded.audit(directory, receipt, api_admin_only=True)
            self.assertEqual(original.compose.call_args.kwargs['timeout'], 142)
            self.assertIs(controller.compose, original_compose)
            self.assertEqual(original.compose.call_args.args[-3:], ('api', 'node', 'scripts/v2-data-integrity-audit.mjs'))
            self.assertEqual(json.loads(receipt.read_bytes())['checkCount'], 49)
            with patch.object(r.time, 'monotonic', return_value=243):
                calls = original.compose.call_count
                with self.assertRaisesRegex(RuntimeError, 'FENCE_TIMEOUT'):
                    bounded.audit(directory, receipt, api_admin_only=True)
                self.assertEqual(original.compose.call_count, calls)
                self.assertIs(r.fault_restore_controller(original, holder), bounded)
                self.assertEqual(bounded.reserve, 0)
                self.assertEqual(bounded.timeout(240), 64)
            with patch.object(r.time, 'monotonic', return_value=308):
                with self.assertRaisesRegex(RuntimeError, 'FENCE_TIMEOUT'): r.fault_restore_controller(original, holder)

    def test_before_strict49_failure_never_acquires_sqlite_or_read_fence_or_switches_services(self):
        d, core, admin, workspace, online = Mock(), Mock(), Mock(), Mock(), Mock()
        record = {'synthetic': True}; raw_env = b'public fixture'
        evidence = {'environmentFileSha256': r.c.digest(raw_env), 'manifestBytesSha256': r.c.digest(b'{}')}
        pref = {'baseline': evidence, 'sourceProjectionSha256': r.c.fingerprint(record)}
        args = SimpleNamespace(api_fault_restore_approved=True, commit=self.p['commit'], source_tree=self.p['sourceTree'],
            run_id='123', run_attempt='1', expected_current=self.admin_auth['producer']['commit'], ci_run_id='456', repository=self.repo)
        proof = {'images': {name: {'reference': 'synthetic-' + name} for name in r.IMAGES}}
        d.shutil.disk_usage.return_value = SimpleNamespace(free=10 * 1024**3)
        d.subprocess.run.return_value = SimpleNamespace(returncode=0)
        core.closed_json.return_value = {'services': {}}; core.private_bytes.return_value = b'{}'
        online.extend_environment.return_value = raw_env
        workspace.strict_audit.side_effect = RuntimeError('UNPUBLISHED_COMPONENT_STRICT_49_AUDIT_REQUIRED')
        with tempfile.TemporaryDirectory(prefix='online-before-pure-', dir=HERE.parents[1] / '.runtime') as td:
            d.BASE = Path(td); previous = d.BASE / 'releases' / 'old'; previous.mkdir(parents=True)
            (d.BASE / 'current').symlink_to(previous)
            d.write_registration_files.side_effect = lambda target, output: target.mkdir()
            with self.seal(), self.enabled(), patch.object(r, 'modules', return_value=(d, core, admin, workspace, online)), \
                 patch.object(r, 'producer', return_value=self.p), patch.object(r, 'validate_preflight', return_value=pref), \
                 patch.object(r, 'source', return_value=({}, {}, record)), patch.object(r, 'validate_build'), \
                 patch.object(r, 'baseline', return_value=(previous, {}, evidence)), patch.object(r, 'preserve'), \
                 patch.object(r, 'verify_image'), patch.object(r.os, 'umask'), patch.object(r, 'switch') as switch:
                with self.assertRaises(r.ComponentFailure) as failure: r.release(d, args, proof, {})
                self.assertEqual(failure.exception.receipt['phase'], 'audit-before')
        workspace.workspace_prepare.assert_not_called(); switch.assert_not_called()
        d.fresh_backup.assert_not_called(); d.compose.assert_not_called()

    def test_before_confirmed_api_stop_sqlite_deadline_is_still_required(self):
        original = Mock(); original.assert_no_active_recharge = Mock(); audit = Mock(); audit.pipe.deadline = 310
        gate = Mock(); gate.deadline = 250; gate.connection = object()
        with self.seal(), self.enabled(), patch.object(r.time, 'monotonic', return_value=100):
            bounded = r.DeadlineController(original, 250, reserve=r.RESTORE_BUDGET_SECONDS)
            holder = {'audit': audit, 'gate': gate, 'controller': bounded}
            self.assertEqual(bounded.timeout(240), 82)
            self.assertIs(r.fault_restore_controller(original, holder), bounded)
            holder['sqliteReleasedAfterStop'] = True
            with self.assertRaisesRegex(RuntimeError, 'RESTORE_FENCE_CONTROLLER_REQUIRED'):
                r.fault_restore_controller(original, holder)
            gate.connection = None
            with self.assertRaisesRegex(RuntimeError, 'RESTORE_FENCE_CONTROLLER_REQUIRED'):
                r.fault_restore_controller(original, holder)

    def test_actual_prepare_exception_restores_only_admin_and_aborts_only_owned_marker(self):
        workspace = r.load('api-admin-scope.py')
        for failure in ('owned_marker', 'before_lock', 'foreign_marker'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='online-prepare-pure-',
                    dir=HERE.parents[1] / '.runtime') as td:
                directory = Path(td); previous = directory / 'old'; target = directory / 'new'
                previous.mkdir(); target.mkdir(); volume_root = directory / 'volume'; volume_root.mkdir()
                # An inert fixture file; no SQLite connection or local database is created.
                (volume_root / 'database.db').write_bytes(b'synthetic opaque file')
                marker = volume_root / workspace.WORKSPACE_MAINTENANCE
                if failure != 'owned_marker': marker.write_bytes(b'foreign synthetic marker'); marker.chmod(0o600)
                states = {n: {'containerId': 'a' * 64, 'image': 'sha256:' + 'b' * 64, 'reference': 'exact-' + n,
                    'startedAtSha256': 'c' * 64, 'environmentSha256': 'd' * 64,
                    'status': 'running', 'health': 'healthy'} for n in r.c.SERVICES}
                volume = {'status': 'PRESENT', 'name': 'synthetic-volume'}
                evidence = {'services': states, 'workspaceVolume': volume, 'configurationModels': {'api': {}, 'admin': {}},
                    'environmentFileSha256': r.c.digest(b'public fixture')}
                args = SimpleNamespace(api_fault_restore_approved=True, run_id='123', run_attempt='1', commit=self.p['commit'])
                proof = {'producer': self.p, 'images': {'api': {'reference': 'candidate'}}}
                d, core, online = Mock(), Mock(), Mock(); d.BASE = directory; (directory / 'current').symlink_to(previous)
                d.assert_no_active_recharge = Mock(); d.require = r.need; d.compose.return_value = ''
                d.run.return_value = json.dumps([{'Mountpoint': str(volume_root)}])
                core.private_bytes.return_value = b'public fixture'; core.configuration_model.return_value = {}
                written = {}
                def write(path, value):
                    written[path.name] = copy.deepcopy(value)
                    return encoded(value)
                core.write_private.side_effect = write
                created, aborted = [], []
                def init(gate, controller, old, new, supplied_proof, supplied_args, *, legacy):
                    gate.d, gate.previous, gate.target, gate.proof, gate.args = controller, old, new, supplied_proof, supplied_args
                    gate.legacy, gate.connection, gate.marker_bytes, gate.summary, gate.record = legacy, None, None, None, None
                    gate.volume, gate.api_identity = volume, {n: states['api'][n] for n in ('containerId', 'image', 'startedAtSha256')}
                    gate.marker = marker; created.append(gate)
                def lock(gate):
                    if failure == 'before_lock': raise RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SOURCE_INVALID')
                    gate.deadline = 200
                    if failure == 'foreign_marker': raise RuntimeError('API_ADMIN_WORKSPACE_MAINTENANCE_EXISTS')
                    gate.summary = {'logicalSha256': 'e' * 64}
                    gate.marker_bytes = encoded({'version': 1, 'runId': args.run_id, 'runAttempt': args.run_attempt,
                        'candidateCommit': args.commit, 'nonce': '0' * 64})
                    marker.write_bytes(gate.marker_bytes); marker.chmod(0o600)
                    gate.marker_identity = (marker.stat().st_dev, marker.stat().st_ino)
                def abort(gate):
                    # Pure substitute for the original abort's database proof;
                    # its real marker identity/mode/bytes guard is still used.
                    gate.check_marker(); aborted.append(gate); marker.unlink()
                audit = MagicMock(); audit.pipe.deadline = 310
                with self.seal(), self.enabled(), patch.object(r.time, 'monotonic', return_value=100), \
                     patch.object(r, 'preserve'), patch.object(r, 'audit_barrier', return_value=audit), \
                     patch.object(workspace.WorkspaceSqliteProtection, '__init__', init), \
                     patch.object(workspace.WorkspaceSqliteProtection, 'lock', lock), \
                     patch.object(workspace.WorkspaceSqliteProtection, 'backup_restore',
                         side_effect=RuntimeError('API_ADMIN_WORKSPACE_SQLITE_SAFETY_FAILED')), \
                     patch.object(workspace.WorkspaceSqliteProtection, 'abort', abort), \
                     patch.object(workspace, 'workspace_volume', return_value=volume), \
                     patch.object(workspace, 'snapshot', return_value=states), \
                     patch.object(workspace, 'jobs_idle'), patch.object(workspace, 'workspace_idle'), \
                     patch.object(r, 'predecessor_records', return_value=(b'1', b'2', b'3', b'4')), \
                     patch.object(r.c, 'verify_applied_database', return_value={'synthetic': True}), \
                     patch.object(r, 'verify_online_grants', return_value={'synthetic': True}):
                    changed, holder = [], {}
                    with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_WORKSPACE_') as caught:
                        r.switch(d, core, workspace, online, previous, target, evidence, proof, args, changed, gate_holder=holder)
                    self.assertIs(caught.exception.sqlite_gate, created[0])
                    self.assertEqual(changed, ['admin']); self.assertNotIn('audit', holder)
                    bounded = r.fault_restore_controller(d, holder)
                    if failure == 'before_lock': self.assertIs(bounded, d)
                    else:
                        self.assertIsInstance(bounded, r.DeadlineController)
                        self.assertEqual(bounded.deadline, 200); self.assertEqual(bounded.reserve, 0)
                    result = r.restore(bounded, core, workspace, online, previous, target, evidence, proof, args, changed, holder)
                    self.assertEqual(result['status'], 'RESTORED_INDEPENDENT_READBACK_REQUIRED')
                    self.assertEqual([call.args[2] for call in d.rollback_service.call_args_list], ['admin'])
                    core.stop_failed_api.assert_not_called(); audit.__enter__.assert_not_called()
                    value = written[r.PREFIX + '-fault-restore.json']
                    self.assertIsNone(value['sqliteProtectionSha256'])
                    self.assertFalse(value['sqlitePreparation']['backupRestoreProofCompleted'])
                    self.assertEqual(value['sqlitePreparation']['markerClearedByThisRelease'], failure == 'owned_marker')
                    r.validate_preparation_restore(value, evidence)
                    bad = copy.deepcopy(value); bad['servicesAfter']['api']['containerId'] = 'f' * 64
                    with self.assertRaisesRegex(RuntimeError, 'PREPARE_FAILURE_RESTORE_CHANGED'):
                        r.validate_preparation_restore(bad, evidence)
                self.assertEqual(len(aborted), int(failure == 'owned_marker'))
                if failure != 'owned_marker': self.assertEqual(marker.read_bytes(), b'foreign synthetic marker')

    def test_prepare_exception_does_not_adopt_foreign_gate_or_guess_deadline(self):
        workspace = r.load('api-admin-scope.py'); original = Mock(); original.assert_no_active_recharge = Mock()
        foreign = Mock(); holder = {}
        with self.seal(), self.enabled():
            r.capture_prepare_failure(original, workspace, Path('/old'), Path('/new'), {}, {}, SimpleNamespace(),
                ['admin'], holder, foreign)
            self.assertIsNone(holder['gate']); self.assertIs(r.fault_restore_controller(original, holder), original)
            self.assertFalse(holder['prepareFailure']['boundGate']); foreign.close.assert_not_called(); foreign.abort.assert_not_called()
            actual = object.__new__(workspace.WorkspaceSqliteProtection)
            actual.deadline = 200; actual.connection = None
            holder = {'gate': actual, 'prepareFailure': {'ownedMarker': True},
                'controller': r.DeadlineController(original, 200)}
            with patch.object(r.time, 'monotonic', return_value=199), self.assertRaisesRegex(RuntimeError, 'FENCE_TIMEOUT'):
                r.fault_restore_controller(original, holder)

    def test_new_strict49_reports_are_bound_before_after_in_manifest_ledger_and_state(self):
        core = r.c.load_core(self.auth['coreSha256']); workspace = r.load('api-admin-scope.py')
        report = {'ok': True, 'checkCount': 49, 'violationCount': 0,
            'checks': [{'code': 'SYNTHETIC_' + str(n), 'count': 0} for n in range(49)]}
        d = SimpleNamespace(require=r.need)
        with tempfile.TemporaryDirectory(prefix='online-audit-pure-', dir=HERE.parents[1] / '.runtime') as td:
            directory = Path(td)
            for name in ('before', 'after'):
                path = directory / (name + '-audit.json'); path.write_bytes(encoded(report)); path.chmod(0o600)
            summary = workspace.audit_receipt(d, directory / 'before-audit.json')
            manifest = {'dataAuditBefore': summary, 'dataAuditAfter': summary}
            ledger = {**manifest, 'dataAuditBeforeBytesSha256': r.c.digest(encoded(report)),
                'dataAuditAfterBytesSha256': r.c.digest(encoded(report))}
            state = copy.deepcopy(ledger)
            with self.seal(), self.enabled():
                self.assertTrue(r.verify_fresh_audits(core, workspace, d, directory, manifest, ledger, state)['freshStrictZero49Verified'])
                for where in ('manifest', 'ledger', 'state', 'raw'):
                    m, l, s = (copy.deepcopy(value) for value in (manifest, ledger, state))
                    if where == 'raw': (directory / 'after-audit.json').write_bytes(encoded(report) + b' ')
                    else: {'manifest': m, 'ledger': l, 'state': s}[where]['dataAuditAfter']['checksSha256'] = '0' * 64
                    with self.subTest(where=where), self.assertRaises(RuntimeError):
                        r.verify_fresh_audits(core, workspace, d, directory, m, l, s)
                    (directory / 'after-audit.json').write_bytes(encoded(report))
                for field, bad_value in (('checkCount', 48), ('violationCount', 1), ('mode', 'LEGACY')):
                    bad = dict(summary); bad[field] = bad_value
                    with self.subTest(field=field), self.assertRaises(RuntimeError): core.audit_guard(bad)
                bad_report = copy.deepcopy(report); bad_report['checks'][0]['count'] = 1
                (directory / 'after-audit.json').write_bytes(encoded(bad_report))
                with self.assertRaises(RuntimeError): r.verify_fresh_audits(core, workspace, d, directory, manifest, ledger, state)

    def test_independent_readback_requires_current_live_sqlite_schema_rows_and_volume(self):
        d, core, workspace = Mock(), Mock(), Mock()
        workspace.WORKSPACE_SQLITE_RECEIPT = 'synthetic-private-receipt.json'
        summary = {'schemaSha256': 'a' * 64, 'logicalSha256': 'b' * 64,
            'tableCounts': {'synthetic': 1}, 'taskCounts': {'pending': 0, 'running': 0}}
        value = {'sourceSummary': summary, 'volume': {'name': 'synthetic-volume'}}
        core.closed_json.return_value = value; core.private_bytes.return_value = encoded(value)
        workspace.workspace_volume.return_value = value['volume']; workspace.workspace_private_inspect.return_value = summary
        with self.seal(), self.enabled():
            result = r.verify_live_sqlite(d, core, workspace, Path('/receipt'), Path('/current'), 'pinned-image', r.c.fingerprint(value))
            self.assertTrue(result['liveSchemaAndLogicalDataVerified'])
            self.assertEqual(workspace.workspace_private_inspect.call_args.kwargs,
                {'expected': summary['logicalSha256'], 'timeout': 30})
            for field in summary:
                workspace.workspace_private_inspect.return_value = {**summary, field: 'synthetic-drift'}
                with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'SQLITE_LIVE_DATA_CHANGED'):
                    r.verify_live_sqlite(d, core, workspace, Path('/receipt'), Path('/current'), 'pinned-image', r.c.fingerprint(value))
            workspace.workspace_private_inspect.return_value = summary
            workspace.workspace_volume.return_value = {'name': 'another-volume'}
            with self.assertRaisesRegex(RuntimeError, 'SQLITE_LIVE_VOLUME_CHANGED'):
                r.verify_live_sqlite(d, core, workspace, Path('/receipt'), Path('/current'), 'pinned-image', r.c.fingerprint(value))


def verify_authenticated_original(directory):
    """Explicit local audit of the supplied public records; missing bytes fail."""
    directory = Path(directory).resolve()
    names = ('original-readback-invocation.json', 'published-original-release-manifest.json',
        'published-original-unpublished-component-successor-build-proof.json',
        'published-original-unpublished-component-successor-preservation.json')
    project = HERE.parents[1].parent.parent
    if not directory.is_relative_to(project):
        raise RuntimeError('public fixture must stay inside this project')
    records = tuple((directory / name).read_bytes() for name in names)
    with patch.object(r.c, 'SEALED_ORDINARY_COMPONENT', r.c.AUTHENTICATED_PREDECESSOR):
        authenticated = r.c.authenticate_component_records(*records)
        if authenticated['releaseAuthority'] is not False: raise AssertionError('pure audit granted release')
        for index in range(4):
            altered = list(records); altered[index] += b' '
            try: r.c.authenticate_component_records(*tuple(altered))
            except RuntimeError: pass
            else: raise AssertionError('altered original record admitted')
    print(json.dumps({'actualOriginalRecords': 'PASS', 'positiveCases': 1, 'tamperCases': 4,
        'runtimeAuthorityGranted': False, 'producer': authenticated['receipt']['commit']}))


def verify_authenticated_admin(original_directory, admin_directory):
    """Read supplied public native originals, never current live services."""
    project = HERE.parents[1].parent.parent
    original_directory, admin_directory = (Path(value).resolve() for value in (original_directory, admin_directory))
    if not all(path.is_relative_to(project) for path in (original_directory, admin_directory)):
        raise RuntimeError('public fixtures must stay inside this project')
    names = ('original-readback-invocation.json', 'published-original-release-manifest.json',
        'published-original-unpublished-component-successor-build-proof.json',
        'published-original-unpublished-component-successor-preservation.json')
    originals = tuple((original_directory / name).read_bytes() for name in names)
    records = tuple((admin_directory / name).read_bytes() for name in
        ('id-business-v2-admin568-native.json', 'published-admin-manifest.json', 'published-admin-build-proof.json'))
    with patch.object(r.c, 'SEALED_ORDINARY_COMPONENT', r.c.AUTHENTICATED_PREDECESSOR), \
         patch.object(r.c, 'ADMIN_SUCCESSOR', r.c.AUTHENTICATED_ADMIN_SUCCESSOR):
        authenticated = r.c.authenticate_admin_records(*records, originals)
        if authenticated['releaseAuthority'] is not False: raise AssertionError('pure audit granted release')
        for index in range(3):
            changed = list(records); changed[index] += b' '
            try: r.c.authenticate_admin_records(*changed, originals)
            except RuntimeError: pass
            else: raise AssertionError('changed actual Admin record admitted')
    print(json.dumps({'actualAdminOriginalRecords': 'PASS', 'positiveCases': 1, 'tamperCases': 3,
        'historicalProducer': authenticated['ordinary']['receipt']['commit'],
        'actualPredecessor': authenticated['receipt']['commit'], 'runtimeAuthorityGranted': False}))


if __name__ == '__main__':
    (HERE.parents[1] / '.runtime').mkdir(exist_ok=True)
    if len(sys.argv) == 3 and sys.argv[1] == '--authenticated-original-dir':
        verify_authenticated_original(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == '--authenticated-admin-dirs':
        verify_authenticated_admin(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
