"""Real byte/record lifecycle; Docker, AWS, SQL and service transports are mocked."""

import base64
import ast
import copy
from contextlib import ExitStack
from datetime import datetime, timezone
import importlib.util
import gzip
import json
import os
from pathlib import Path
import subprocess
import shlex
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('online_protected_recovery_tests',
    HERE / 'online-recharge-component-recovery.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REAL_PROCESS_RUN = subprocess.run
# Historical recovery proofs use the original published workspace helper, even
# after the registration feature has been removed from the current source tree.
LEGACY_WORKSPACE_SAFETY = subprocess.check_output([
    'git', 'show',
    '31d2c6885a45817cd40d23fce8d6145bc9f18af2:'
    'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py',
], cwd=HERE.parents[1])


def raw(value):
    return m.encoded(value)


class Rows(list):
    def fetchall(self):
        return list(self)


class SqliteTransport:
    """Closed simulated SQLite responses; never creates or connects a database."""
    TABLES = ('accounts', 'email_services', 'registration_tasks', 'settings',
        'proxies', 'cpa_services', 'sub2api_services', 'tm_services')

    def __init__(self):
        self.commands = []

    def execute(self, query):
        self.commands.append(query)
        if query == 'BEGIN IMMEDIATE': return Rows()
        if query.startswith('SELECT type,name,tbl_name,sql FROM sqlite_schema'):
            return Rows([('table', name, name, 'CREATE TABLE ' + name + '(id INTEGER PRIMARY KEY)')
                for name in sorted(self.TABLES)])
        if query.startswith('PRAGMA table_info('):
            return Rows([(0, 'id', 'INTEGER', 0, None, 1)])
        if query == 'SELECT status,COUNT(*) FROM registration_tasks GROUP BY status': return Rows()
        if query.startswith('SELECT "id" FROM "'): return Rows()
        raise AssertionError('unexpected SQLite transport query')

    def set_progress_handler(self, callback, count):
        self.progress = callback

    def rollback(self): pass
    def close(self): pass


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.core = m.r.c.load_core(m.r.authority()['coreSha256'])
        self.producer = copy.deepcopy(m.FAILED_PRODUCER)
        self.origin = copy.deepcopy(m.ORIGIN)
        self.baseline = {'ordinaryAuthoritySha256': m.r.c.fingerprint(m.r.authority()),
            'actualPredecessor': m.r.current_authority()['producer'],
            'adminAuthoritySha256': m.r.c.fingerprint(m.r.current_authority()),
            'manifestBytesSha256': self.origin['manifestBytesSha256'],
            'currentRelease': str(m.BASE / 'releases' / '20261014T050000Z-568e9390a304'),
            'environmentFileSha256': 'e' * 64,
            'workspaceVolume': {'name': 'private-registration', 'status': 'PRESENT', 'identitySha256': 'd' * 64},
            'appliedDatabase': {'migrationPerformed': False, 'databaseGrantsChanged': False, 'migrationPlan': []},
            'services': {}}
        for index, name in enumerate(m.r.c.SERVICES):
            token = str(index + 1)
            self.baseline['services'][name] = {'containerId': token * 64,
                'image': 'sha256:' + token * 64, 'reference': 'old-' + name,
                'startedAtSha256': 'a' * 64, 'environmentSha256': 'b' * 64,
                'configurationSha256': 'c' * 64, 'status': 'running',
                'health': None if name == 'caddy' else 'healthy'}
        self.failure = {'version': 1, 'scope': m.r.SCOPE, 'kind': m.r.KIND,
            'status': 'ONLINE_RECHARGE_COMPONENT_FAILED', 'producer': self.producer,
            'phase': 'protected-readback', 'code': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED',
            'servicesAttempted': ['admin', 'api', 'online-recharge'],
            'recovery': {'status': 'BLOCKED_OR_FAILED', 'sqliteMaintenanceRetained': True},
            'publication': {'attempted': False, 'currentRole': 'PREDECESSOR', 'onlinePublished': False},
            'onlinePublished': False, 'migrationPerformed': False, 'databaseGrantsChanged': False,
            'executionMigrationPlan': [], 'volumeDeletionPerformed': False, 'businessActions': None}
        self.pref = {'version': 1, 'scope': m.r.SCOPE, 'kind': m.r.KIND,
            'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED', 'producer': self.producer,
            'baseline': self.baseline, 'sourceProjectionSha256': 'f' * 64,
            'onlinePublished': False, 'migrationPerformed': False, 'databaseGrantsChanged': False,
            'executionMigrationPlan': [], 'businessActions': 0}
        self.f_native = self.native(self.pref, command='11111111-2222-3333-4444-555555555555')
        self.transport = {'version': 1, 'kind': m.r.KIND + '_PREFLIGHT_TRANSPORT', 'producer': self.producer,
            'expectedCurrent': m.r.current_predecessor(), 'commandId': '11111111-2222-3333-4444-555555555555',
            'instanceId': self.origin['instanceId'], 'invocationBytesSha256': m.r.c.digest(self.f_native),
            'invocationRawBase64': base64.b64encode(self.f_native).decode(), 'serverReceipt': self.pref}
        self.proof = {'version': 1, 'scope': m.r.SCOPE, 'kind': m.r.KIND + '_BUILD_PROOF',
            'producer': self.producer, 'qualityRunId': '38544086836', 'sourceProjection': {'kind': 'fixture'},
            'preflightSha256': m.r.c.fingerprint(self.transport), 'migrations': copy.deepcopy(m.r.c.MIGRATIONS), 'images': {}}
        for name in m.r.IMAGES:
            self.proof['images'][name] = {'reference': '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:'
                + '-'.join((self.producer['commit'], self.producer['workflowRunId'], '1', name)),
                'imageId': 'sha256:' + 'f' * 64, 'fileCount': 3, 'sha256': 'a' * 64}
        self.context = {'failureRaw': self.native(self.failure, failed=True),
            'preflightRaw': raw(self.transport), 'proofRaw': raw(self.proof)}
        self.origin.update(failureNativeBytesSha256=m.r.c.digest(self.context['failureRaw']),
            preflightNativeBytesSha256=m.r.c.digest(self.f_native),
            preflightBytesSha256=m.r.c.digest(self.context['preflightRaw']),
            buildProofBytesSha256=m.r.c.digest(self.context['proofRaw']))
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(m, 'ORIGIN', self.origin))
        self.stack.enter_context(patch('subprocess.run', side_effect=AssertionError('external process forbidden in unit fixture')))
        self.stack.enter_context(patch('subprocess.Popen', side_effect=AssertionError('external process forbidden in unit fixture')))
        self.stack.enter_context(patch('sqlite3.connect', side_effect=AssertionError('database connection forbidden in unit fixture')))

    def native(self, receipt, command=None, failed=False):
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        return raw({'CommandId': command or self.origin['failureCommandId'],
            'InstanceId': self.origin['instanceId'], 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Failed' if failed else 'Success',
            'ResponseCode': 1 if failed else 0,
            'StandardErrorContent': 'failed to run commands: exit status 1' if failed else '',
            'StandardOutputContent': raw(m.r.wire(receipt)).decode(),
            'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now})

    def test_real_native_preflight_proof_bindings_pass(self):
        self.assertEqual(m.validate_inputs(**{'failure_raw': self.context['failureRaw'],
            'preflight_raw': self.context['preflightRaw'], 'proof_raw': self.context['proofRaw']}), self.context)

    def test_any_original_bytes_change_is_rejected_before_controller(self):
        for name in self.context:
            with self.subTest(name=name), patch.object(m.r, 'modules') as controller:
                changed = {**self.context, name: self.context[name] + b' '}
                with self.assertRaisesRegex(RuntimeError, 'INPUT_CHANGED'):
                    m.inputs(changed)
                controller.assert_not_called()

    def test_authenticated_unknown_result_or_wrong_phase_is_not_authority(self):
        for phase, recovery in (('audit-after', self.failure['recovery']),
                ('protected-readback', {'status': 'NOT_REQUIRED'})):
            changed = copy.deepcopy(self.failure); changed['phase'], changed['recovery'] = phase, recovery
            if recovery['status'] == 'NOT_REQUIRED':
                changed['servicesAttempted'] = []; changed['businessActions'] = 0
            failed = self.native(changed, failed=True)
            with patch.dict(self.origin, failureNativeBytesSha256=m.r.c.digest(failed)):
                with self.assertRaisesRegex(RuntimeError, 'FAILURE_CHANGED'):
                    m.validate_inputs(failed, self.context['preflightRaw'], self.context['proofRaw'])

    def test_wrong_instance_rejected_even_with_matching_input_hash(self):
        value = json.loads(self.context['failureRaw']); value['InstanceId'] = 'i-11111111111111111'
        changed = raw(value)
        with patch.dict(self.origin, failureNativeBytesSha256=m.r.c.digest(changed)):
            with self.assertRaises(RuntimeError):
                m.validate_inputs(changed, self.context['preflightRaw'], self.context['proofRaw'])

    def state(self, marker_absent=True):
        services = copy.deepcopy(self.baseline['services'])
        services['api']['containerId'] = '9' * 64
        services['admin']['containerId'] = '8' * 64
        return {'currentRelease': self.baseline['currentRelease'],
            'manifestBytesSha256': self.origin['manifestBytesSha256'], 'servicesAfter': services,
            'workspaceVolume': self.baseline['workspaceVolume'], 'environmentFileSha256': 'e' * 64,
            'appliedDatabase': self.baseline['appliedDatabase'],
            'onlineGrants': {'status': 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED', 'sha256': 'c' * 64, 'mutationPerformed': False},
            'sqliteProtectionSha256': self.origin['sqliteProtectionSha256'],
            'sqliteReceiptBytesSha256': self.origin['sqliteReceiptBytesSha256'],
            'sqliteSourceSummarySha256': 'a' * 64,
            'auditRecordBytesSha256': self.origin['auditRecordBytesSha256'], 'historicalAuditSha256': 'd' * 64,
            'freshStrictAudit': {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': 'a' * 64},
            'backupInstallationSha256': 'a' * 64, 'markerAbsent': marker_absent,
            'executorAbsent': True, 'preservedServiceCount': len(m.r.PRESERVED)}

    def executor(self):
        return {'commit': 'a' * 40, 'sourceTree': 'b' * 40, 'workflowRunId': '12345', 'workflowRunAttempt': '1'}

    def receipt(self):
        return {'version': 1, 'scope': m.r.SCOPE, 'kind': m.r.KIND, 'status': m.STATUS,
            'producer': self.producer, 'origin': self.origin, 'failedRelease': str(m.BASE / 'releases' / m.TARGET_NAME),
            'recoveryExecutor': self.executor(), 'recoveryHelperSha256': 'a' * 64,
            'recoveryRecordBytesSha256': 'b' * 64, 'state': self.state(),
            'originalMarkerCleared': True, 'onlinePublished': False, 'migrationPerformed': False,
            'databaseGrantsChanged': False, 'executionMigrationPlan': [], 'volumeDeletionPerformed': False,
            'businessActions': 0, 'failedOperationBusinessActions': None}

    def test_closed_receipt_accepts_new_ids_but_not_new_preserved_service(self):
        receipt = self.receipt()
        self.assertEqual(m.validate_receipt(receipt, self.context, 'readback'), receipt)
        bad = copy.deepcopy(receipt); bad['state']['servicesAfter']['mysql']['containerId'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'RETURN_SERVICES_CHANGED'):
            m.validate_receipt(bad, self.context, 'readback')

    def test_no_unknown_business_result_is_upgraded_to_zero(self):
        bad = self.receipt(); bad['failedOperationBusinessActions'] = 0
        with self.assertRaisesRegex(RuntimeError, 'RETURN_CHANGED'):
            m.validate_receipt(bad, self.context, 'readback')

    def test_false_boolean_unknown_fields_and_marker_present_rejected(self):
        for mutate in (lambda v: v.update(extra='forged'), lambda v: v.update(businessActions=False),
                lambda v: v['state'].update(markerAbsent=False),
                lambda v: v.update(recoveryRecordBytesSha256='bad'),
                lambda v: v['state']['servicesAfter']['api'].update(image='sha256:' + 'f' * 64)):
            bad = self.receipt(); mutate(bad)
            with self.assertRaises(RuntimeError):
                m.validate_receipt(bad, self.context, 'recover')

    def test_default_verify_does_not_call_abort_or_write(self):
        controller = Mock(); state = self.state(False)
        with patch.object(m, '_verify', return_value=(state, ())):
            self.assertEqual(m.verify(controller, self.context), state)
        controller.assert_not_called()

    def test_recovery_requires_both_explicit_flag_and_existing_approval(self):
        controller = Mock()
        for approved, env in ((False, 'true'), (True, 'false'), (True, '')):
            with patch.dict(os.environ, API_FAULT_RESTORE_APPROVED=env), \
                    patch.object(m, 'authenticate_executor') as source:
                with self.assertRaisesRegex(RuntimeError, 'APPROVAL_REQUIRED'):
                    m.recover(controller, self.context, approved=approved, executor=self.executor())
                source.assert_not_called()

    def install_transaction(self):
        output = HERE.parents[1] / '.runtime' / 'online-release-hardening-20261014' / 'unit-recovery'
        output.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=output); self.addCleanup(directory.cleanup)
        base = Path(directory.name).resolve()
        target = base / 'releases' / m.TARGET_NAME
        previous = base / 'releases' / '20261014T050000Z-568e9390a304'
        target.mkdir(parents=True, mode=0o700); previous.mkdir(mode=0o700)
        (base / 'current').symlink_to(previous)
        marker = base / 'marker'; marker.write_bytes(b'bound marker'); marker.chmod(0o600)
        state = self.state(False); state['currentRelease'] = str(previous)
        self.baseline['currentRelease'] = str(previous)
        self.stack.enter_context(patch.object(m, 'BASE', base))
        self.stack.enter_context(patch.object(m, 'inputs', return_value=(self.core, self.transport, self.baseline, self.proof)))
        self.stack.enter_context(patch.object(m, 'authenticate_executor', return_value='a' * 64))
        self.stack.enter_context(patch.dict(os.environ, API_FAULT_RESTORE_APPROVED='true'))
        self.stack.enter_context(patch.object(m, 'require_root'))
        controller = SimpleNamespace(BASE=base)
        workspace = SimpleNamespace(snapshot=Mock(return_value=state['servicesAfter']), jobs_idle=Mock())
        online = SimpleNamespace(require_fresh_resources=Mock())
        gate = SimpleNamespace(marker=marker, d=None)
        events = []
        def abort():
            self.assertTrue((target / m.INTENT).is_file())
            self.assertIsNotNone(gate.d)
            events.append('abort'); marker.unlink()
        gate.abort = Mock(side_effect=abort)
        class Fence:
            def __init__(self):
                self.pipe = SimpleNamespace(deadline=time.monotonic() + 210)
            def __enter__(self):
                events.append('fresh-fence'); return self
            def __exit__(self, *args):
                events.append('close-fence')
            def check(self):
                events.append('check')
        fence = Fence()
        details = (controller, self.core, workspace, online, previous, target, self.baseline,
            self.proof, gate, {}, {})
        self.stack.enter_context(patch.object(m, '_verify', return_value=(state, details)))
        self.stack.enter_context(patch.object(m, 'fresh_audit_fence', return_value=fence))
        self.stack.enter_context(patch.object(m.r, 'DeadlineController', side_effect=lambda d, deadline, reserve:
            SimpleNamespace(deadline=deadline, reserve=reserve)))
        return controller, target, marker, gate, state, events

    def test_real_files_order_marker_clear_intent_final_then_independent_readback(self):
        controller, target, marker, gate, state, events = self.install_transaction()
        accepted = self.receipt(); accepted['failedRelease'] = str(target)
        with patch.object(m, 'readback', return_value=accepted) as q:
            self.assertEqual(m.recover(controller, self.context, approved=True, executor=self.executor()), accepted)
        gate.abort.assert_called_once(); self.assertFalse(marker.exists())
        self.assertLess(events.index('fresh-fence'), events.index('abort'))
        intent = self.core.closed_json(self.core.private_bytes(target / m.INTENT))
        record = self.core.closed_json(self.core.private_bytes(target / m.RECORD))
        self.assertFalse(intent['stateBefore']['markerAbsent'])
        self.assertTrue(record['state']['markerAbsent'])
        self.assertEqual(record['origin'], self.origin)
        self.assertIsNone(record['failedOperationBusinessActions'])
        self.assertEqual(record['businessActions'], 0)
        q.assert_called_once_with(controller, self.context)

    def test_existing_final_record_or_symlink_is_never_replaced_or_cleared(self):
        controller, target, marker, gate, _state, _events = self.install_transaction()
        (target / m.RECORD).symlink_to(marker)
        before = marker.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'RECORD_EXISTS'):
            m.recover(controller, self.context, approved=True, executor=self.executor())
        self.assertEqual(marker.read_bytes(), before); gate.abort.assert_not_called()

    def test_existing_intent_after_partial_failure_blocks_blind_retry(self):
        controller, target, marker, gate, _state, _events = self.install_transaction()
        (target / m.INTENT).write_bytes(b'original intent')
        with self.assertRaisesRegex(RuntimeError, 'RECORD_EXISTS'):
            m.recover(controller, self.context, approved=True, executor=self.executor())
        self.assertEqual((target / m.INTENT).read_bytes(), b'original intent')
        self.assertTrue(marker.exists()); gate.abort.assert_not_called()

    def test_lost_fresh_fence_or_changed_live_service_keeps_marker(self):
        controller, _target, marker, gate, state, _events = self.install_transaction()
        with patch.object(m, 'fresh_audit_fence', side_effect=RuntimeError('fresh fence unavailable')):
            with self.assertRaises(RuntimeError):
                m.recover(controller, self.context, approved=True, executor=self.executor())
        self.assertTrue(marker.exists()); gate.abort.assert_not_called()
        details = m._verify.return_value[1]
        details[2].snapshot.return_value = {**state['servicesAfter'], 'mysql': {'unexpected': True}}
        with self.assertRaisesRegex(RuntimeError, 'STATE_MOVED'):
            m.recover(controller, self.context, approved=True, executor=self.executor())
        self.assertTrue(marker.exists()); gate.abort.assert_not_called()

    def test_failed_abort_leaves_only_immutable_intent_no_success_record(self):
        controller, target, marker, gate, _state, _events = self.install_transaction()
        gate.abort.side_effect = RuntimeError('summary changed')
        with self.assertRaises(RuntimeError):
            m.recover(controller, self.context, approved=True, executor=self.executor())
        self.assertTrue(marker.exists()); self.assertTrue((target / m.INTENT).is_file())
        self.assertFalse((target / m.RECORD).exists())

    def test_real_private_record_readback_then_modified_record_rejected(self):
        controller, target, _marker, _gate, state, _events = self.install_transaction()
        receipt = self.receipt(); receipt['failedRelease'] = str(target)
        receipt['state'] = {**state, 'markerAbsent': True}
        record = {k: v for k, v in receipt.items() if k != 'recoveryRecordBytesSha256'}
        record.update(kind=m.RECORD_KIND, status='PROTECTED_RECOVERY_AWAITING_NATIVE_READBACK')
        before = self.core.write_private(target / m.RECORD, record)
        details = m._verify.return_value[1]
        m._verify.return_value = (receipt['state'], details)
        with patch.object(m.r, 'verify_live_sqlite'):
            result = m.readback(controller, self.context)
        self.assertEqual(result['recoveryRecordBytesSha256'], m.r.c.digest(before))
        self.assertEqual((target / m.RECORD).read_bytes(), before)
        changed = copy.deepcopy(record); changed['origin']['failureCommandId'] = '00000000-0000-0000-0000-000000000000'
        (target / m.RECORD).write_bytes(raw(changed))
        with self.assertRaisesRegex(RuntimeError, 'RECORD_CHANGED'):
            m.readback(controller, self.context)

    def test_historical_queries_use_old_api_and_actual_cas_uses_new_id(self):
        state = self.state()
        old = {'containerId': '1' * 64, 'image': self.baseline['services']['api']['image'],
            'startedAtSha256': 'a' * 64, 'startedAt': '2026-10-14T09:00:00Z'}
        plan = {'historyQuery': 'sealed fixed history', 'expectedTriggersSha256': 'a' * 64}
        audit = {'sourceApiIdentity': old, 'before': {'historyCutoff': '2026-10-14 09:56:53.084873'},
            'historyQuerySha256': m.r.c.digest(plan['historyQuery'].encode()),
            'triggerDefinitionsSha256': 'a' * 64, 'basis': {'kind': m.r.KIND}}
        workspace = SimpleNamespace(workspace_api_identity=Mock(return_value={
            n: state['servicesAfter']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')}))
        online = SimpleNamespace(_online_after_bit_audit_queries=Mock(return_value=plan),
            _online_after_bit_audit_transport=Mock(return_value='fence'))
        self.assertEqual(m.fresh_audit_fence(SimpleNamespace(), workspace, online, Path('/old'),
            self.baseline, state, audit), 'fence')
        self.assertEqual(online._online_after_bit_audit_queries.call_args.args[3], old)
        online._online_after_bit_audit_transport.call_args.kwargs['first_api_check'](time.monotonic() + 10)
        self.assertEqual(workspace.workspace_api_identity.call_args.kwargs['expected']['containerId'], '9' * 64)

    def test_real_audit_writer_reader_reuse_diff_timestamps_has_same_proof(self):
        # Genuine archived implementations, not a mirrored audit reducer.
        d, _core, _admin, workspace, _online = m.r.modules()
        reports = [{'ok': True, 'checkCount': 49, 'violationCount': 0,
            'generatedAt': stamp, 'checks': [{'code': str(n), 'count': 0, 'samples': []} for n in range(49)]}
            for stamp in ('2026-10-14T11:00:00Z', '2026-10-14T11:00:30Z')]
        values = {'V2_DATA_INTEGRITY_DATABASE_URL': 'mysql://audit:synthetic@127.0.0.1/synthetic'}
        original_namespace = d.audit.__globals__
        with patch.dict(original_namespace, environment_values=lambda _path: values,
                compose=Mock(side_effect=[json.dumps(report) for report in reports])):
            first, second = m.MemoryAuditReceipt(), m.MemoryAuditReceipt()
            self.assertEqual(workspace.strict_audit(d, Path('/synthetic'), first),
                workspace.strict_audit(d, Path('/synthetic'), second))
        self.assertNotEqual(first.read_text(), second.read_text())
        self.assertEqual(workspace.audit_receipt(d, first), workspace.audit_receipt(d, second))

    def frozen_abort_fixture(self):
        output = HERE.parents[1] / '.runtime' / 'online-release-hardening-20261014' / 'unit-recovery'
        output.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=output); self.addCleanup(directory.cleanup)
        base = Path(directory.name).resolve()
        database, marker = base / 'database.db', base / '.id-release-maintenance.json'
        database.write_bytes(b'opaque original protected data'); database.chmod(0o600)
        marker.write_bytes(b'original bound private marker'); marker.chmod(0o600)
        d, _core, _admin, workspace, _online = m.r.modules()
        gate = workspace.WorkspaceSqliteProtection.__new__(workspace.WorkspaceSqliteProtection)
        gate.d, gate.previous, gate.target, gate.legacy = d, base, base, False
        gate.database, gate.marker, gate.connection = database, marker, None
        gate.volume = {'name': 'fixture-volume'}
        gate.database_identity = (database.stat().st_dev, database.stat().st_ino)
        gate.marker_identity = (marker.stat().st_dev, marker.stat().st_ino)
        gate.marker_bytes = marker.read_bytes()
        gate.api_identity = {'image': 'sha256:' + 'a' * 64, 'containerId': '1' * 64}
        identity = {'image': gate.api_identity['image'], 'containerId': '9' * 64, 'startedAtSha256': 'b' * 64}
        gate.summary = {'schemaSha256': 'a' * 64, 'logicalSha256': 'b' * 64, 'tableCounts': {}, 'taskCounts': {}}
        gate.summary_reader = lambda: lambda connection: gate.summary
        # Expired source lease supplies no authority; abort must acquire a new
        # transaction and use its own bounded deadline.
        gate.deadline = time.monotonic() - 1000
        connection = Mock()
        self.stack.enter_context(patch.object(workspace.sqlite3, 'connect', return_value=connection))
        api, private = Mock(return_value=identity), Mock(return_value=gate.summary)
        self.stack.enter_context(patch.dict(gate.abort.__func__.__globals__,
            workspace_api_identity=api, workspace_private_inspect=private))
        return gate, marker, connection, api, private

    def test_real_frozen_abort_uses_new_sqlite_transaction_and_current_old_image(self):
        gate, marker, connection, api, private = self.frozen_abort_fixture()
        gate.abort()
        self.assertFalse(marker.exists())
        connection.execute.assert_called_once_with('BEGIN IMMEDIATE')
        connection.rollback.assert_called_once(); connection.close.assert_called_once()
        self.assertIsNone(gate.connection)
        self.assertEqual(api.call_count, 2)
        self.assertEqual(private.call_args.kwargs['expected'], gate.summary['logicalSha256'])
        self.assertGreater(private.call_args.kwargs['timeout'], 0)
        self.assertLessEqual(private.call_args.kwargs['timeout'], 30)

    def test_real_frozen_abort_rejects_changed_marker_summary_or_image(self):
        for kind in ('marker', 'summary', 'image'):
            with self.subTest(kind=kind):
                gate, marker, connection, api, _private = self.frozen_abort_fixture()
                if kind == 'marker':
                    marker.write_bytes(b'replaced marker')
                elif kind == 'summary':
                    gate.summary_reader = lambda: lambda connection: {'changed': True}
                else:
                    api.return_value = {'image': 'sha256:' + 'f' * 64, 'containerId': '9' * 64}
                with self.assertRaises(RuntimeError):
                    gate.abort()
                self.assertTrue(marker.exists())

    def full_verifier_fixture(self):
        """Real old native validators, private artifacts and SQLite receipt checks."""
        fixture_spec = importlib.util.spec_from_file_location('historical_recovery_fixture',
            HERE / 'online-recharge-component-consumer.test.py')
        fixture = importlib.util.module_from_spec(fixture_spec); fixture_spec.loader.exec_module(fixture)
        old_auth, admin_auth, old_records, admin_records = fixture.synthetic_admin_records()
        old_native, old_manifest, old_proof, old_state = (json.loads(v) for v in old_records)
        admin_native, admin_manifest, admin_proof = (json.loads(v) for v in admin_records)
        old_state['before'] = copy.deepcopy(self.baseline['services'])
        old_state['after'] = copy.deepcopy(self.baseline['services'])
        old_state['workspaceVolumeAfter'] = self.baseline['workspaceVolume']
        images = {n: {'reference': self.baseline['services'][n]['reference'],
            'imageId': self.baseline['services'][n]['image'], 'fileCount': 3, 'sha256': 'a' * 64}
            for n in ('api', 'admin')}
        old_proof['images'], admin_proof['image'] = images, images['admin']
        old_proof['projection']['outputFilesSha256'] = 'f' * 64
        ordinary_files = {'scripts/synthetic-readonly-fixture.py': (b'# synthetic source fixture\n', '100644')}
        old_manifest['apiComponentPublication'].update(sourceArchiveSha256=m.r.c.digest(b'ordinary archive'),
            sourceFilesSha256=m.r.c.fingerprint(self.core.projection_module().inventory(ordinary_files)))
        old_auth.update(projectionSha256=m.r.c.fingerprint(old_proof['projection']),
            publicationSha256=m.r.c.fingerprint(old_manifest['apiComponentPublication']))
        admin_proof['projection']['inheritedProjectionSha256'] = old_auth['projectionSha256']
        admin_proof['projection']['projectionSha256'] = m.r.c.fingerprint({k: v
            for k, v in admin_proof['projection'].items() if k != 'projectionSha256'})
        admin_manifest['adminPublication']['inheritedApiComponentPublicationSha256'] = m.r.c.fingerprint(old_manifest['apiComponentPublication'])
        admin_manifest['apiComponentPublication'] = copy.deepcopy(old_manifest['apiComponentPublication'])
        admin_manifest['adminPublication']['projection'] = admin_proof['projection']
        admin_manifest['sourceArchiveSha256'] = m.r.c.digest(b'admin archive')
        admin_receipt = json.loads(admin_native['StandardOutputContent'])
        admin_receipt['projectionSha256'] = admin_proof['projection']['projectionSha256']
        admin_native['StandardOutputContent'] = raw(admin_receipt).decode()
        admin_auth['projectionSha256'] = admin_proof['projection']['projectionSha256']
        admin_manifest['adminPublication']['preservedServices'] = {
            n: {'before': copy.deepcopy(old_state['after'][n]), 'after': copy.deepcopy(old_state['after'][n])}
            for n in m.r.c.SERVICES if n != 'admin'}
        admin_manifest['adminPublication']['buildProofSha256'] = m.r.c.fingerprint(admin_proof)
        old_encoded = tuple(raw(v) for v in (old_manifest, old_proof, old_state))
        old_auth.update(manifestBytesSha256=m.r.c.digest(old_encoded[0]),
            buildProofBytesSha256=m.r.c.digest(old_encoded[1]), preservationRecordBytesSha256=m.r.c.digest(old_encoded[2]))
        old_receipt = json.loads(old_native['StandardOutputContent'])
        old_receipt.update({n: old_auth[n] for n in ('manifestBytesSha256', 'buildProofBytesSha256',
            'preservationRecordBytesSha256', 'projectionSha256', 'publicationSha256')})
        old_receipt['migration'] = copy.deepcopy(old_state['migration'])
        old_native['StandardOutputContent'] = raw(old_receipt).decode()
        old_auth.update(invocationBytesSha256=m.r.c.digest(raw(old_native)), receiptSha256=m.r.c.fingerprint(old_receipt))
        old_records = (raw(old_native), *old_encoded)
        admin_manifest['adminPublication']['inheritedManifestSha256'] = old_auth['manifestBytesSha256']
        admin_manifest['previousManifestSha256'] = old_auth['manifestBytesSha256']
        output = HERE.parents[1] / '.runtime' / 'online-release-hardening-20261014' / 'unit-recovery'
        output.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=output); self.addCleanup(directory.cleanup)
        base = Path(directory.name).resolve(); previous = base / 'releases' / 'old-admin'
        historical = base / 'releases' / 'old-ordinary'; target = base / 'releases' / m.TARGET_NAME
        for path in (previous, historical, target): path.mkdir(parents=True, mode=0o700)
        (base / 'current').symlink_to(previous)
        admin_manifest['previousRelease'] = str(historical)
        admin_records = (raw(admin_native), raw(admin_manifest), raw(admin_proof))
        admin_auth.update(invocationBytesSha256=m.r.c.digest(admin_records[0]),
            receiptSha256=m.r.c.fingerprint(json.loads(admin_native['StandardOutputContent'])),
            manifestBytesSha256=m.r.c.digest(admin_records[1]),
            buildProofBytesSha256=m.r.c.digest(admin_records[2]),
            publicationSha256=m.r.c.fingerprint(admin_manifest['adminPublication']))
        self.stack.enter_context(patch.object(m, 'BASE', base))
        self.stack.enter_context(patch.object(m.r.c, 'SEALED_ORDINARY_COMPONENT', old_auth))
        self.stack.enter_context(patch.object(m.r.c, 'ADMIN_SUCCESSOR', admin_auth))
        self.origin['manifestBytesSha256'] = admin_auth['manifestBytesSha256']
        self.baseline.update(manifestBytesSha256=admin_auth['manifestBytesSha256'], currentRelease=str(previous),
            ordinaryProducer=old_auth['producer'], ordinaryAuthoritySha256=m.r.c.fingerprint(old_auth),
            adminAuthoritySha256=m.r.c.fingerprint(admin_auth), currentArchiveSha256=m.r.c.digest(b'admin archive'),
            ordinaryArchiveSha256=m.r.c.digest(b'ordinary archive'), configurationModels={n: {'profile': n} for n in ('api', 'admin')},
            backupInstallation={'stable': True, 'servicesSha256': 'c' * 64})
        for name, data in (('release-manifest.json', admin_records[1]), ('admin-build-proof.json', admin_records[2]),
                           ('.env.aws.production', b'opaque existing environment')):
            path = previous / name; path.write_bytes(data); path.chmod(0o600)
        self.baseline['environmentFileSha256'] = m.r.c.digest(b'opaque existing environment')
        for name, data in (('release-manifest.json', old_records[1]), (self.core.PREFIX + '-build-proof.json', old_records[2]),
                           (self.core.PREFIX + '-preservation.json', old_records[3])):
            path = historical / name; path.write_bytes(data); path.chmod(0o600)
        controller = SimpleNamespace(BASE=base, require=self.core.need)
        for path, data in ((m.r.native_path(controller), old_records[0]), (m.r.current_native_path(controller), admin_records[0])):
            path.parent.mkdir(parents=True, mode=0o700); path.write_bytes(data); path.chmod(0o600)
        _d, _core, actual_admin, actual_workspace, actual_online = m.r.modules()
        workspace = SimpleNamespace(WORKSPACE_SAFETY=actual_workspace.WORKSPACE_SAFETY,
            WORKSPACE_SQLITE_RECEIPT=actual_workspace.WORKSPACE_SQLITE_RECEIPT,
            WorkspaceSqliteProtection=actual_workspace.WorkspaceSqliteProtection,
            workspace_sqlite_receipt=actual_workspace.workspace_sqlite_receipt,
            audit_receipt=actual_workspace.audit_receipt, strict_audit=actual_workspace.strict_audit)
        states = self.state()['servicesAfter']
        for name, result in (('snapshot', states), ('workspace_volume', self.baseline['workspaceVolume']),
                             ('jobs_idle', {}), ('workspace_idle', {}), ('workspace_audit_protection', {}), ('workspace_health', {})):
            setattr(workspace, name, Mock(return_value=result))
        safety_file = HERE.parents[1] / workspace.WORKSPACE_SAFETY
        safety_namespace = {'__name__': 'verified_fixture_logical_reader'}
        exec(compile(LEGACY_WORKSPACE_SAFETY, str(safety_file), 'exec', dont_inherit=True), safety_namespace)
        summary = safety_namespace['logical_summary'](SqliteTransport())
        inspection = {'version': 1, 'status': 'PASS', **summary, 'activeAppleLeaseCount': 0,
            'corruptEncryptedValueCount': 0, 'businessActions': 0}
        workspace.workspace_private_inspect = Mock(return_value=inspection)
        volume_root = base / 'volume'; volume_root.mkdir(mode=0o700)
        database = volume_root / 'database.db'; database.write_bytes(b'opaque protected data'); database.chmod(0o600)
        marker = volume_root / actual_workspace.WORKSPACE_MAINTENANCE
        marker.write_bytes(raw({'version': 1, 'runId': self.producer['workflowRunId'], 'runAttempt': '1',
            'candidateCommit': self.producer['commit'], 'nonce': 'f' * 64})); marker.chmod(0o600)
        self.origin['markerBytesSha256'] = m.r.c.digest(marker.read_bytes())
        backup = target / 'backups' / 'auto-registration' / 'database.db'
        backup.parent.mkdir(parents=True, mode=0o700); backup.parent.parent.chmod(0o700)
        backup.write_bytes(b'opaque immutable backup'); backup.chmod(0o600)
        sqlite = {'version': 1, 'volume': self.baseline['workspaceVolume'], 'backupName': 'backups/auto-registration/database.db',
            'backupSha256': m.r.c.digest(backup.read_bytes()), 'backupSize': backup.stat().st_size,
            'sourceDatabaseIdentitySha256': m.r.c.fingerprint((database.stat().st_dev, database.stat().st_ino)),
            'sourceApiIdentity': {n: self.baseline['services']['api'][n] for n in ('containerId', 'image', 'startedAtSha256')},
            'candidateImageId': self.proof['images']['api']['imageId'], 'inspection': inspection,
            'legacyAudit': None, 'sourceSummary': summary, 'maintenanceSha256': self.origin['markerBytesSha256'],
            'restoreVerified': True, 'temporaryRestoreVolumeRemoved': True, 'volumeDeletionPerformed': False}
        sqlite_path = target / workspace.WORKSPACE_SQLITE_RECEIPT
        sqlite_path.write_bytes(raw(sqlite)); sqlite_path.chmod(0o600)
        self.origin.update(sqliteReceiptBytesSha256=m.r.c.digest(raw(sqlite)), sqliteProtectionSha256=m.r.c.fingerprint(sqlite))
        guard = {'registrationMutationCount': 0, 'onlineAuditCount': 0, 'tables': {n: 0 for n in actual_online.TABLES},
            'historyCutoff': '2026-10-14 09:56:53.084873', 'historicalRegistrationAuditCount': 34}
        audit = {'version': 1, 'kind': m.r.KIND + '_AUDIT_PROTECTION',
            'basis': {'kind': m.r.KIND, 'ordinaryProducer': old_auth['producer'], 'ordinaryAuthoritySha256': m.r.c.fingerprint(old_auth)},
            'sourceApiIdentity': {**sqlite['sourceApiIdentity'], 'startedAt': '2026-10-14T09:00:00Z'},
            'mysqlIdentitySha256': m.r.c.fingerprint(self.baseline['services']['mysql']),
            **{n: 'a' * 64 for n in ('initialQuerySha256', 'querySha256', 'historyQuerySha256', 'triggerDefinitionsSha256', 'connectionIdSha256')},
            'before': guard, 'after': copy.deepcopy(guard), 'sqliteProtectionSha256': self.origin['sqliteProtectionSha256'],
            'oldApiStop': {'identity': sqlite['sourceApiIdentity'], 'running': False, 'pid': 0}}
        audit_path = target / (m.r.PREFIX + '-audit-protection.json')
        audit_path.write_bytes(raw(audit)); audit_path.chmod(0o600)
        self.origin['auditRecordBytesSha256'] = m.r.c.digest(raw(audit))
        report = {'ok': True, 'checkCount': 49, 'violationCount': 0,
            'checks': [{'code': str(n), 'count': 0, 'samples': []} for n in range(49)]}
        for name, key in (('before-audit.json', 'beforeAuditBytesSha256'), ('after-audit.json', 'afterAuditBytesSha256')):
            path = target / name; path.write_bytes(raw(report)); path.chmod(0o600)
            self.origin[key] = m.r.c.digest(raw(report))
        def audit_run(directory, receipt, **kwargs):
            receipt.write_text(json.dumps(report)); receipt.chmod(0o600)
        controller.audit = audit_run
        safety_raw = LEGACY_WORKSPACE_SAFETY
        safety_path = target / workspace.WORKSPACE_SAFETY
        safety_path.parent.mkdir(parents=True, mode=0o700); safety_path.write_bytes(safety_raw)
        source_output = {workspace.WORKSPACE_SAFETY: (safety_raw, '100644')}
        def run(*command, **kwargs):
            if command[:3] == ('docker', 'volume', 'inspect'):
                return json.dumps([{'Mountpoint': str(volume_root)}])
            if command[:3] == ('docker', 'image', 'inspect'):
                return json.dumps([{'Config': {'Labels': {
                    'id-business-v2.unpublished-component-successor-projection-sha256': old_auth['projectionSha256'],
                    'id-business-v2.admin-pending-projection-sha256': admin_auth['projectionSha256']}}}])
            raise AssertionError('unexpected transport')
        controller.run, controller.compose = run, Mock(return_value='')
        for name in ('current_job_database', 'assert_no_active_recharge', 'registration_runtime_state', 'rollback_service'):
            setattr(controller, name, Mock(side_effect=AssertionError('unexpected service mutation')))
        controller.registration_download = Mock(return_value=b'ordinary archive')
        controller.registration_archive = Mock(return_value={})
        online = SimpleNamespace(inspect_image=Mock(), content_command=lambda _name: 'fixed readonly content',
            content_summary=Mock(return_value={'fileCount': 3, 'sha256': 'a' * 64}), require_fresh_resources=Mock(),
            verify_permission_seed=Mock())
        controller.shutil = SimpleNamespace(disk_usage=Mock(return_value=SimpleNamespace(free=10 * 1024**3)))
        self.stack.enter_context(patch.object(m.r, 'modules', return_value=(controller, self.core, actual_admin, workspace, online)))
        self.stack.enter_context(patch.object(m.r, 'original_controller', return_value=(None, ordinary_files, self.baseline['ordinaryArchiveSha256'])))
        self.stack.enter_context(patch.object(m.r, 'admin_controller', return_value=(None, {}, self.baseline['currentArchiveSha256'])))
        self.stack.enter_context(patch.object(m.r, 'source', return_value=({}, source_output, self.proof['sourceProjection'])))
        self.stack.enter_context(patch.object(m, 'failed_source', return_value=({}, source_output, self.proof['sourceProjection'])))
        self.stack.enter_context(patch.object(self.core, 'configuration_model',
            side_effect=lambda _d, state: {'profile': 'api' if state['reference'] == 'old-api' else 'admin'}))
        self.stack.enter_context(patch.object(m.r.c, 'verify_applied_database', return_value=self.baseline['appliedDatabase']))
        self.stack.enter_context(patch.object(m.r, 'verify_online_grants', return_value=self.state()['onlineGrants']))
        self.stack.enter_context(patch.object(m.r, 'backup_cas', return_value=self.baseline['backupInstallation']))
        current_identity = {**{n: states['api'][n] for n in ('containerId', 'image', 'startedAtSha256')}, 'startedAt': '2026-10-14T10:00:00Z'}
        self.stack.enter_context(patch.dict(workspace.WorkspaceSqliteProtection.__init__.__globals__,
            workspace_volume=lambda *args, **kwargs: self.baseline['workspaceVolume'],
            workspace_api_identity=lambda *args, **kwargs: current_identity,
            workspace_private_inspect=lambda *args, **kwargs: inspection))
        self.transport['instanceId'] = old_auth['instanceId']; self.origin['instanceId'] = old_auth['instanceId']
        self.f_native = self.native(self.pref, command=self.transport['commandId'])
        self.transport.update(invocationRawBase64=base64.b64encode(self.f_native).decode(),
            invocationBytesSha256=m.r.c.digest(self.f_native))
        self.proof['preflightSha256'] = m.r.c.fingerprint(self.transport)
        self.context = {'failureRaw': self.native(self.failure, failed=True),
            'preflightRaw': raw(self.transport), 'proofRaw': raw(self.proof)}
        self.origin.update(failureNativeBytesSha256=m.r.c.digest(self.context['failureRaw']),
            preflightNativeBytesSha256=m.r.c.digest(self.f_native),
            preflightBytesSha256=m.r.c.digest(self.context['preflightRaw']), buildProofBytesSha256=m.r.c.digest(self.context['proofRaw']))
        return controller, workspace, target, marker, sqlite_path, safety_path

    def test_complete_real_verification_and_marker_binding_keeps_original_files(self):
        d, _workspace, target, marker, _sqlite, _safety = self.full_verifier_fixture()
        original = {p: p.read_bytes() for p in target.rglob('*') if p.is_file()}
        state, details = m._verify(d, self.context, marker_required=True)
        self.assertFalse(state['markerAbsent']); self.assertTrue(marker.exists())
        self.assertEqual(state['sqliteProtectionSha256'], self.origin['sqliteProtectionSha256'])
        self.assertEqual(details[8].marker_bytes, marker.read_bytes())
        self.assertTrue(callable(details[8].summary_reader()))
        self.assertEqual(original, {p: p.read_bytes() for p in target.rglob('*') if p.is_file()})

    def test_complete_verifier_rejects_marker_source_receipt_or_preserved_service_drift(self):
        d, workspace, _target, marker, sqlite_path, safety_path = self.full_verifier_fixture()
        original_marker, original_sqlite, original_safety = (p.read_bytes() for p in (marker, sqlite_path, safety_path))
        for path in (marker, sqlite_path, safety_path):
            with self.subTest(path=path.name):
                old = path.read_bytes(); path.write_bytes(old + b' ')
                with self.assertRaises(RuntimeError): m.verify(d, self.context)
                path.write_bytes(old)
        states = workspace.snapshot.return_value
        states['mysql']['containerId'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'SERVICES_CHANGED'): m.verify(d, self.context)
        self.assertEqual(marker.read_bytes(), original_marker)
        self.assertEqual(sqlite_path.read_bytes(), original_sqlite)
        self.assertEqual(safety_path.read_bytes(), original_safety)

    def test_complete_verify_abort_record_independent_readback_chain_without_database(self):
        d, workspace, target, marker, sqlite_path, _safety = self.full_verifier_fixture()
        original_sqlite = sqlite_path.read_bytes()
        original_manifest = (Path(self.baseline['currentRelease']) / 'release-manifest.json').read_bytes()
        connections = []
        def connect(*args, **kwargs):
            connection = SqliteTransport(); connections.append(connection); return connection
        class FreshFence:
            def __init__(self): self.pipe = SimpleNamespace(deadline=time.monotonic() + 210)
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def check(self):
                self.assert_not_expired = time.monotonic() < self.pipe.deadline
                if not self.assert_not_expired: raise RuntimeError('fresh fence expired')
        with patch('sqlite3.connect', side_effect=connect), \
                patch.object(m, 'require_root'), \
                patch.object(m, 'authenticate_executor', return_value='a' * 64), \
                patch.dict(os.environ, API_FAULT_RESTORE_APPROVED='true'), \
                patch.object(m, 'fresh_audit_fence', side_effect=lambda *args: FreshFence()):
            receipt = m.recover(d, self.context, approved=True, executor=self.executor())
            self.assertEqual(m.validate_receipt(receipt, self.context, 'recover'), receipt)
            record_before = (target / m.RECORD).read_bytes()
            independent = m.readback(d, self.context)
            self.assertEqual(m.validate_receipt(independent, self.context, 'readback'), receipt)
        self.assertEqual(len(connections), 1)
        self.assertIn('BEGIN IMMEDIATE', connections[0].commands)
        self.assertFalse(marker.exists())
        self.assertEqual((target / m.RECORD).read_bytes(), record_before)
        self.assertEqual(sqlite_path.read_bytes(), original_sqlite)
        self.assertEqual((Path(self.baseline['currentRelease']) / 'release-manifest.json').read_bytes(), original_manifest)
        self.assertFalse(receipt['onlinePublished']); self.assertIsNone(receipt['failedOperationBusinessActions'])
        d.rollback_service.assert_not_called()
        self.assertTrue(all('up' not in call.args and 'stop' not in call.args and 'rm' not in call.args
            for call in d.compose.call_args_list))

    def witness_fixture(self):
        d, workspace, target, marker, _sqlite, _safety = self.full_verifier_fixture()
        names = (*self.core.HELPERS, 'online-recharge-component-consumer.py',
            'online-recharge-component-runtime.py', 'online-recharge-component-readonly.py',
            'online-recharge-component-recovery.py', 'online-recharge-component-recovery-readonly.py')
        archive_files = {'scripts/production-release/' + name: ((HERE / name).read_bytes(),
            '100755' if (HERE / name).stat().st_mode & 0o111 else '100644') for name in names}
        executor = {**self.executor(), 'commit': 'e' * 40,
            'sourceTree': self.core.projection_module().source_tree(archive_files)}
        archive_raw = b'synthetic authenticated executor archive transport'
        directory = d.BASE / '.staging' / ('online-protected-recovery-' + '-'.join(
            executor[n] for n in ('commit', 'workflowRunId', 'workflowRunAttempt')))
        directory.mkdir(parents=True, mode=0o700)
        for name in names:
            data, mode = archive_files['scripts/production-release/' + name]
            path = directory / name; path.write_bytes(data); path.chmod(0o755 if mode == '100755' else 0o600)
        d.registration_download = lambda commit: archive_raw if commit == executor['commit'] else b'ordinary archive'
        d.registration_archive = lambda data, commit: archive_files if data == archive_raw else {}
        helper_sha = m.r.c.digest(Path(m.__file__).read_bytes())
        class Fence:
            def __init__(self): self.pipe = SimpleNamespace(deadline=time.monotonic() + 210)
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def check(self):
                if time.monotonic() >= self.pipe.deadline: raise RuntimeError('expired fixture fence')
        self.stack.enter_context(patch('sqlite3.connect', side_effect=lambda *args, **kwargs: SqliteTransport()))
        self.stack.enter_context(patch.object(m, 'require_root'))
        self.stack.enter_context(patch.dict(os.environ, API_FAULT_RESTORE_APPROVED='true'))
        self.stack.enter_context(patch.object(m, 'fresh_audit_fence', side_effect=lambda *args: Fence()))
        recovered = m.recover(d, self.context, approved=True, executor=executor)
        independent = m.readback(d, self.context)
        self.assertEqual(recovered, independent); self.assertFalse(marker.exists())
        witness = {'version': 1, 'kind': m.WITNESS_KIND, 'origin': copy.deepcopy(self.origin),
            'originalProducer': self.producer, 'executorProducer': executor,
            'executorRun': {'runId': executor['workflowRunId'], 'runAttempt': executor['workflowRunAttempt'],
                'headBranch': 'main', 'headCommit': executor['commit'], 'sourceTree': executor['sourceTree'],
                'workflowPath': '.github/workflows/online-recharge-recovery.yml', 'event': 'workflow_dispatch',
                'status': 'completed', 'conclusion': 'success', 'runResponseBytesSha256': 'a' * 64,
                'treeResponseBytesSha256': 'b' * 64},
            'executorArchiveBytesSha256': m.r.c.digest(archive_raw), 'executorHelperSha256': helper_sha,
            'contextRawBase64': {k: base64.b64encode(v).decode() for k, v in self.context.items()},
            'commands': {}, 'recoveryRecordBytesSha256': recovered['recoveryRecordBytesSha256'],
            'servicesSha256': m.r.c.fingerprint(recovered['state']['servicesAfter'])}
        actual_generator = m.archived_parameter_generator
        def fixture_generator(controller, core, authority):
            generator, saved = actual_generator(controller, core, authority)
            # Synthetic seals are confined to this fixture. The archived control
            # implementation and every archived source/parameter byte remain real.
            archived_runtime = generator.__globals__['r']
            archived_runtime.c.SEALED_ORDINARY_COMPONENT = copy.deepcopy(m.r.c.SEALED_ORDINARY_COMPONENT)
            archived_runtime.c.ADMIN_SUCCESSOR = copy.deepcopy(m.r.c.ADMIN_SUCCESSOR)
            generator.__globals__['recovery'] = m
            return generator, saved
        self.stack.enter_context(patch.object(m, 'archived_parameter_generator', side_effect=fixture_generator))
        generator, _saved = fixture_generator(d, self.core, witness)
        for mode, command_id in (('recover', '22222222-2222-3333-4444-555555555555'),
                                 ('readback', '33333333-2222-3333-4444-555555555555')):
            params = generator(mode, self.core, executor, self.context)
            native = self.native(recovered, command=command_id)
            witness['commands'][mode] = {'commandId': command_id, 'instanceId': self.origin['instanceId'],
                'parameters': params, 'parametersSha256': m.r.c.fingerprint(params),
                'nativeRawBase64': base64.b64encode(native).decode(), 'nativeBytesSha256': m.r.c.digest(native),
                'receiptSha256': m.r.c.fingerprint(recovered)}
        source_directory = d.BASE / 'admission-source'; source_directory.mkdir(mode=0o700)
        for name in (*names, 'online-recharge-scope.py'):
            path = source_directory / name
            if not path.exists(): path.write_bytes((HERE / name).read_bytes()); path.chmod(0o600)
        profile = source_directory / 'online-recharge-component-runtime.py'
        profile.write_text(profile.read_text().replace('RECOVERY_AUTHORITY = None', 'RECOVERY_AUTHORITY = ' + repr(witness)))
        self.stack.enter_context(patch.object(m.r, '__file__', str(profile)))
        self.stack.enter_context(patch.object(m.r, 'RECOVERY_AUTHORITY', witness))
        original_load = m.r.load
        self.stack.enter_context(patch.object(m.r, 'load', side_effect=lambda name:
            m if name == 'online-recharge-component-recovery.py' else original_load(name)))
        return d, workspace, target, profile, witness, recovered

    def test_full_actual_recovery_native_witness_consumed_by_next_real_baseline_and_preflight(self):
        d, workspace, target, _profile, witness, recovered = self.witness_fixture()
        manifest_before = (Path(self.baseline['currentRelease']) / 'release-manifest.json').read_bytes()
        admission = m.admit_baseline(d, witness)
        self.assertEqual(admission['state'], recovered['state'])
        previous, _manifest, evidence = m.r.restored_baseline(d, m.r.current_predecessor())
        self.assertEqual(evidence['services'], recovered['state']['servicesAfter'])
        self.assertEqual(evidence['recoveryAdmission']['readbackCommandId'], witness['commands']['readback']['commandId'])
        with patch.object(m.r.c, 'validate_source_files', return_value={}):
            next_f = m.r.preflight(d, self.executor(), m.r.current_predecessor())
        self.assertEqual(next_f['baseline'], evidence)
        self.assertEqual(previous, Path(self.baseline['currentRelease']))
        self.assertEqual((previous / 'release-manifest.json').read_bytes(), manifest_before)
        self.assertTrue((target / m.RECORD).is_file())

    def test_source_none_self_declared_witness_or_same_command_never_admits(self):
        d, _workspace, _target, profile, witness, _receipt = self.witness_fixture()
        raw_profile = profile.read_bytes()
        profile.write_text('RECOVERY_AUTHORITY = None\n')
        with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_NOT_SEALED'): m.admit_baseline(d, witness)
        profile.write_bytes(raw_profile)
        forged = copy.deepcopy(witness); forged['commands']['readback']['commandId'] = forged['commands']['recover']['commandId']
        with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_NOT_SEALED'): m.admit_baseline(d, forged)
        with self.assertRaisesRegex(RuntimeError, 'INDEPENDENT_COMMAND_REQUIRED'): m.validate_witness_shape(forged)
        with patch.object(m.r, 'RECOVERY_AUTHORITY', None):
            with self.assertRaisesRegex(RuntimeError, 'RECOVERY_NOT_SEALED'):
                m.r.restored_baseline(d, m.r.current_predecessor())

    def test_source_seal_symlink_or_hardlink_rejected(self):
        d, _workspace, _target, profile, witness, _receipt = self.witness_fixture()
        link = profile.with_name('linked-runtime.py'); link.symlink_to(profile)
        with patch.object(m.r, '__file__', str(link)):
            with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_SOURCE_CHANGED'): m.admit_baseline(d, witness)
        link.unlink()
        os.link(profile, link)
        with self.assertRaisesRegex(RuntimeError, 'AUTHORITY_SOURCE_CHANGED'): m.admit_baseline(d, witness)
        link.unlink()

    def rewritten_carrier(self, parameters, os_byte, *, append_program=b''):
        program = m.sender_program(parameters)
        tree = ast.parse(program)
        call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Subscript) and isinstance(node.func.value, ast.Name)
            and node.func.value.id == 'client' and isinstance(node.func.slice, ast.Constant)
            and node.func.slice.value == 'server_arguments')
        for index in (2, 4, 5):
            text = ast.literal_eval(call.args[index])
            packed = bytearray(gzip.compress(gzip.decompress(base64.b64decode(text[len('gzip-base64:'):], validate=True)), mtime=0))
            packed[9] = os_byte
            replacement = 'gzip-base64:' + base64.b64encode(packed).decode()
            program = program.replace(repr(text).encode(), repr(replacement).encode())
        packed = bytearray(gzip.compress(program + append_program, mtime=0)); packed[9] = os_byte
        carrier = ('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('
            + repr(base64.b64encode(packed).decode()) + ',validate=True)),"<online-protected-recovery-transport>","exec"))')
        return {'commands': ['python3 -B -c ' + shlex.quote(carrier)], 'executionTimeout': ['600']}

    def test_os_three_255_parameter_equivalence_retains_actual_hash_and_full_program_guard(self):
        d, _workspace, _target, _profile, witness, _receipt = self.witness_fixture()
        generator, _saved = m.archived_parameter_generator(d, self.core, witness)
        executor = m.r.producer(*[witness['executorProducer'][n] for n in
            ('commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt')])
        for os_byte in (3, 255):
            parameters = self.rewritten_carrier(witness['commands']['recover']['parameters'], os_byte)
            original_hash = m.r.c.fingerprint(parameters)
            self.assertEqual(m.authenticate_sender_parameters(generator, 'recover', self.core,
                executor, self.context, parameters), parameters)
            self.assertEqual(m.r.c.fingerprint(parameters), original_hash)
        changed = self.rewritten_carrier(witness['commands']['recover']['parameters'], 255,
            append_program=b'\nraise RuntimeError("unexpected extra program")\n')
        with self.assertRaisesRegex(RuntimeError, 'WITNESS_PARAMETERS_CHANGED'):
            m.authenticate_sender_parameters(generator, 'recover', self.core, executor, self.context, changed)
        with self.assertRaisesRegex(RuntimeError, 'WITNESS_ARGUMENTS_CHANGED'):
            m.authenticate_sender_parameters(generator, 'readback', self.core, executor, self.context,
                witness['commands']['recover']['parameters'])
        noncanonical = copy.deepcopy(witness['commands']['recover']['parameters'])
        noncanonical['commands'][0] = ' ' + noncanonical['commands'][0]
        with self.assertRaisesRegex(RuntimeError, 'WITNESS_CARRIER_CHANGED'): m.sender_program(noncanonical)

    def test_json_sorted_source_executor_data_keeps_original_constructor_program(self):
        d, _workspace, _target, profile, witness, _receipt = self.witness_fixture()
        witness['executorProducer'] = json.loads(json.dumps(witness['executorProducer'], sort_keys=True))
        source = profile.read_text(); tree = ast.parse(source)
        declaration = next(node for node in tree.body if isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'RECOVERY_AUTHORITY' for t in node.targets))
        lines = source.splitlines(keepends=True)
        lines[declaration.lineno - 1:declaration.end_lineno] = ['RECOVERY_AUTHORITY = ' + repr(witness) + '\n']
        profile.write_text(''.join(lines))
        self.assertEqual(m.admit_baseline(d, witness)['servicesSha256'], witness['servicesSha256'])

    def test_sealed_native_parameters_or_live_service_drift_is_rejected(self):
        d, workspace, _target, _profile, witness, _receipt = self.witness_fixture()
        original_authority = copy.deepcopy(witness)
        # Even a re-sealed modified parameter declaration cannot bypass the
        # actual archived source generator, unlike a self-consistent file hash.
        original_source_authority = m.source_authority
        with patch.object(m, 'source_authority', side_effect=lambda v: copy.deepcopy(v)):
            changed = copy.deepcopy(witness)
            changed['commands']['recover']['parameters']['executionTimeout'] = ['601']
            changed['commands']['recover']['parametersSha256'] = m.r.c.fingerprint(changed['commands']['recover']['parameters'])
            with self.assertRaisesRegex(RuntimeError, 'WITNESS_PARAMETERS_CHANGED'): m.admit_baseline(d, changed)
            changed = copy.deepcopy(witness)
            changed['commands']['readback']['nativeRawBase64'] = changed['commands']['recover']['nativeRawBase64']
            with self.assertRaises(RuntimeError): m.admit_baseline(d, changed)
        workspace.snapshot.return_value['mysql']['containerId'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'SERVICES_CHANGED'): m.admit_baseline(d, original_authority)


class FailedSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = m.r.c.load_core(m.r.authority()['coreSha256'])
        cls.projection = cls.core.projection_module()
        cls.root = HERE.parents[1]
        commits = (m.FAILED_PRODUCER['commit'], m.r.authority()['producer']['commit'],
            '0a03fa28e6b844a18833d5c63f1de700f091fc64', m.r.c.ONLINE_SOURCE)
        cls.archives, cls.files = {}, {}
        for commit in commits:
            process = REAL_PROCESS_RUN(['git', 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit],
                cwd=cls.root, capture_output=True, timeout=30, check=True)
            cls.archives[commit] = process.stdout
            cls.files[commit] = m.r.modules()[0].registration_archive(process.stdout, commit)

    def fixture(self):
        output = self.root / '.runtime' / 'online-release-hardening-20261014' / 'unit-recovery'
        output.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=output); self.addCleanup(directory.cleanup)
        base = Path(directory.name).resolve(); target = base / 'releases' / m.TARGET_NAME
        helper_directory = target / 'scripts/production-release'; helper_directory.mkdir(parents=True, mode=0o700)
        candidate = self.files[m.FAILED_PRODUCER['commit']]
        for name in (*self.core.HELPERS, *m.r.HELPERS):
            data, mode = candidate['scripts/production-release/' + name]
            path = helper_directory / name; path.write_bytes(data); path.chmod(0o755 if mode == '100755' else 0o644)
        a = m.r.authority(); ordinary = self.files[a['producer']['commit']]
        base_files = self.files['0a03fa28e6b844a18833d5c63f1de700f091fc64']
        fixed = self.files[m.r.c.ONLINE_SOURCE]
        original_output, original_projection = self.projection.project_files(ordinary, base_files, fixed,
            a['producer']['commit'], a['producer']['sourceTree'])
        evidence = {'ordinaryProducer': a['producer'], 'ordinaryAuthoritySha256': m.r.c.fingerprint(a),
            'actualPredecessor': m.r.current_authority()['producer'],
            'adminAuthoritySha256': m.r.c.fingerprint(m.r.current_authority()),
            'ordinaryArchiveSha256': m.r.c.digest(self.archives[a['producer']['commit']]),
            'ordinarySourceFilesSha256': m.r.c.fingerprint(self.projection.inventory(ordinary)),
            'ordinaryProjectionSha256': m.r.c.fingerprint(original_projection),
            'ordinaryOutputFilesSha256': m.r.c.fingerprint(self.projection.inventory(original_output))}
        d = SimpleNamespace(BASE=base, registration_download=lambda commit: self.archives[commit],
            registration_archive=lambda data, commit: self.files[commit],
            _apiAdminPendingProjectionReferences=(base_files, fixed))
        proof = {'sourceProjection': {'candidateArchiveSha256': m.r.c.digest(self.archives[m.FAILED_PRODUCER['commit']])}}
        return d, target, evidence, proof

    def test_old_new_helper_call_fails_real_archived_pure_source_succeeds(self):
        d, _target, evidence, proof = self.fixture()
        with patch.object(m, 'BASE', d.BASE), \
                patch('subprocess.run', side_effect=AssertionError('external transport forbidden')):
            with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_SOURCE_CHANGED'):
                m.r.source(d, m.FAILED_PRODUCER, evidence)
            candidate, output, record = m.failed_source(d, self.core, evidence, proof)
        self.assertEqual(candidate, self.files[m.FAILED_PRODUCER['commit']])
        self.assertEqual(output, candidate)
        self.assertEqual(record['candidateProducer'], m.FAILED_PRODUCER)
        self.assertEqual(record['applicationInputSha256'], m.r.c.APPLICATION_SHA256)
        self.assertEqual(record['onlineInputSha256'], m.r.c.ONLINE_SHA256)

    def test_original_helper_or_archive_bytes_drift_rejected_before_execution(self):
        d, target, evidence, proof = self.fixture()
        helper = target / 'scripts/production-release/online-recharge-component-runtime.py'
        with patch.object(m, 'BASE', d.BASE):
            helper.write_bytes(helper.read_bytes() + b'\n# changed\n')
            with self.assertRaisesRegex(RuntimeError, 'FAILED_HELPER_CHANGED'):
                m.failed_source(d, self.core, evidence, proof)
            changed = copy.deepcopy(proof); changed['sourceProjection']['candidateArchiveSha256'] = 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'FAILED_ARCHIVE_CHANGED'):
                m.failed_source(d, self.core, evidence, changed)

    def test_new_candidate_source_authenticates_recovery_dependency_with_real_frozen_projection(self):
        d, _target, evidence, _proof = self.fixture()
        candidate = copy.deepcopy(self.files[m.FAILED_PRODUCER['commit']])
        for name in (*self.core.HELPERS, *m.r.HELPERS, 'online-recharge-component-recovery.py'):
            path = HERE / name
            candidate['scripts/production-release/' + name] = (path.read_bytes(),
                '100755' if path.stat().st_mode & 0o111 else '100644')
        producer = {'commit': 'e' * 40, 'sourceTree': self.projection.source_tree(candidate),
            'workflowRunId': '54321', 'workflowRunAttempt': '1'}
        candidate_raw = b'synthetic current candidate archive transport'
        d.registration_download = lambda commit: candidate_raw if commit == producer['commit'] else self.archives[commit]
        d.registration_archive = lambda data, commit: candidate if data == candidate_raw else self.files[commit]
        with patch.object(m.r, 'RECOVERY_AUTHORITY', {'syntheticSourceSeal': True}), \
                patch('subprocess.run', side_effect=AssertionError('external transport forbidden')):
            files, output, record = m.r.source(d, producer, evidence)
            self.assertEqual(files, candidate); self.assertEqual(output, candidate)
            self.assertEqual(record['applicationInputSha256'], m.r.c.APPLICATION_SHA256)
            self.assertEqual(m.r.c.validate_source_files(files)['onlineInputSha256'], m.r.c.ONLINE_SHA256)
            helper = 'scripts/production-release/online-recharge-component-recovery.py'
            candidate[helper] = (candidate[helper][0] + b'\n# mutated\n', candidate[helper][1])
            producer['sourceTree'] = self.projection.source_tree(candidate)
            with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_SOURCE_CHANGED'):
                m.r.source(d, producer, evidence)


if __name__ == '__main__':
    unittest.main()
