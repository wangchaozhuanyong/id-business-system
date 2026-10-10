"""Synthetic only: isolated project-local bytes; no AWS, daemon or real /opt.

Constants are replaced only inside each controlled fixture. Production draft
constants and the actual producer's existing validators are checked separately.
No synthetic receipt produced here is a production F, Q, profile or artifact.
"""
import ast
import copy
import hashlib
import io
import inspect
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import types
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent
PREP = SOURCE.parents[1] / '.runtime/backup-retention-protection-20261011/reader-public-permission-repair-preparation'
PREP.mkdir(parents=True, exist_ok=True)
LOCAL_PROCESS = subprocess.run


def load(path, name):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


core = load(SOURCE / 'api-workspace-public-permission-repair.py', 'synthetic_public_core')
transport = load(SOURCE / 'api-workspace-public-permission-repair-transport.py', 'synthetic_public_transport')
workspace = load(SOURCE / 'api-admin-scope.py', 'synthetic_workspace_validator')
snapshot = load(SOURCE / transport.SNAPSHOT_NAME, 'synthetic_snapshot_validator')


def facts(targets):
    value = {'kind': 'API_WORKSPACE_READER_FACTS_DIAGNOSTIC', 'version': 1,
        'status': 'OBSERVED', 'authority': False, 'productionEligible': False,
        'rawOutputSuppressed': True, 'rows': [
            {'role': r, 'phase': 'IDENTITY', 'status': 'MATCH', 'predicates': []}
            for r in workspace.WORKSPACE_READER_FACT_ROLES]}
    for row in value['rows']:
        if row['role'] in targets:
            row.update(phase='ATTRIBUTES', status='REJECTED', predicates=['WRITABLE'])
    workspace.validate_workspace_reader_facts(value)
    return value


def workflow_condition(expression, inputs, failed):
    """Evaluate the repository's finite explicit workflow predicates, including negative gates."""
    if expression is None:
        return True
    parsed = ast.parse(expression.replace('&&', ' and ').replace('||', ' or '), mode='eval')
    def evaluate(node):
        if isinstance(node, ast.Constant) and type(node.value) in (str, bool):
            return node.value
        if isinstance(node, ast.Attribute):
            name = ast.unparse(node)
            if name.startswith('inputs.') and name.count('.') == 1:
                return inputs[name.split('.')[1]]
            if name == 'steps.api_admin_preflight.outcome':
                return 'failure' if failed else 'success'
        if isinstance(node, ast.BoolOp) and type(node.op) in (ast.And, ast.Or):
            values = [evaluate(value) for value in node.values]
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
            left, right = evaluate(node.left), evaluate(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq): return left == right
            if isinstance(node.ops[0], ast.NotEq): return left != right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            if node.func.id == 'always' and not node.args: return True
            if node.func.id == 'failure' and not node.args: return failed
            if node.func.id == 'startsWith' and len(node.args) == 2:
                return evaluate(node.args[0]).startswith(evaluate(node.args[1]))
        raise AssertionError('Workflow predicate outside the finite actual expression grammar')
    return evaluate(parsed.body)


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-', dir=PREP)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'opt/id-business-v2'
        self.release = self.base / 'releases/20261011T000000Z-0a03fa28e6b8'
        self.release.mkdir(parents=True)
        self.base.joinpath('current').symlink_to('releases/' + self.release.name)
        for _role, name in core.PARENTS:
            self.release.joinpath(name).mkdir(exist_ok=True)
        self.data = {'COMPOSE_GUARD': b'SYNTHETIC_COMPOSE', 'CADDY_CONFIG': b'SYNTHETIC_CADDY',
                     'MYSQL_SCHEMA': b'SYNTHETIC_SCHEMA'}
        leaves = tuple((r, p, len(self.data[r]), hashlib.sha256(self.data[r]).hexdigest())
                       for r, p, *_ in core.LEAVES)
        compose = (core.COMPOSE[0], core.COMPOSE[1], len(self.data['COMPOSE_GUARD']),
                   hashlib.sha256(self.data['COMPOSE_GUARD']).hexdigest())
        for role, name, *_ in (compose, *leaves):
            self.release.joinpath(name).write_bytes(self.data[role])
        # Untouched sentinels demonstrate that no environment/receipt/unknown
        # file is opened or normalized by the repair, even if writable.
        for name in ('.env.aws.production', 'release-manifest.json', 'unknown-file'):
            self.release.joinpath(name).write_bytes(b'SYNTHETIC_PRIVATE_UNTOUCHED')
            self.release.joinpath(name).chmod(0o666)
        for path in (self.root, *self.root.rglob('*')):
            if path.is_dir() and not path.is_symlink(): path.chmod(0o700)
        for _r, name, *_ in (compose, *leaves): self.release.joinpath(name).chmod(0o600)
        self.names = dict(core.PARENTS) | {r: p for r, p, *_ in leaves}
        self.opened = []; self.closed = []; self.writes = []
        real_open, real_close, real_fchmod = os.open, os.close, os.fchmod
        def opened(name, flags, *args, **kwargs):
            self.assertEqual(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC), 0)
            self.assertNotIn(str(name), ('.env.aws.production', 'release-manifest.json', 'unknown-file'))
            fd = real_open(name, flags, *args, **kwargs); self.opened.append(fd); return fd
        def closed(fd):
            self.closed.append(fd); return real_close(fd)
        def chmod(fd, mode):
            self.writes.append((os.fstat(fd).st_ino, mode)); return real_fchmod(fd, mode)
        def controlled_root():
            return os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        for p in (patch.object(core, 'LEAVES', leaves), patch.object(core, 'COMPOSE', compose),
                  patch.object(core, '_uid', return_value=os.geteuid()),
                  patch.object(core, '_root_identity', return_value=True),
                  patch.object(core, '_open_root', side_effect=controlled_root),
                  patch.object(core.os, 'open', side_effect=opened),
                  patch.object(core.os, 'close', side_effect=closed),
                  patch.object(core.os, 'fchmod', side_effect=chmod)):
            p.start(); self.addCleanup(p.stop)
        self.addCleanup(self.assert_fds_closed)

    def assert_fds_closed(self):
        self.assertEqual(sorted(self.opened), sorted(self.closed))

    def run_core(self, targets=('CADDY_CONFIG',), *, service=None, source=None, observed=None, deadline=None):
        def services(_current): return '1' * 64
        def check(): pass
        return core.repair(service or services, source or check, authorized_targets=targets,
            observed_reader_facts=facts(targets) if observed is None else observed,
            deadline=time.monotonic() + 120.0 if deadline is None else deadline)

    def writable(self, *roles, mode=0o664):
        for role in roles: self.release.joinpath(self.names[role]).chmod(mode)

    def failed(self, result, code, *, mutated=False, count=0):
        self.assertEqual(result['status'], 'FAILED_MUTATED_UNVERIFIED' if mutated else 'FAILED_BEFORE_MUTATION')
        self.assertEqual(result['code'], code)
        self.assertIs(result['mutationAttempted'], mutated)
        self.assertEqual(result['changedCount'], count)
        self.assertFalse(result['repairVerified']); core.result_validate(result)
        self.assertNotIn('SYNTHETIC_PRIVATE_UNTOUCHED', json.dumps(result))

    def test_no_default_target_or_diag_and_no_fd_open(self):
        self.failed(core.repair(), 'INPUT_INVALID'); self.assertFalse(self.opened)
        self.failed(self.run_core(observed=facts(())), 'DIAGNOSTIC_INVALID'); self.assertFalse(self.opened)
        for target in ((), ('SOURCE_ENV',), ('COMPOSE',), ('SOURCE',), ('CADDY_CONFIG', 'CADDY_CONFIG')):
            self.failed(core.repair(authorized_targets=target), 'INPUT_INVALID')
        self.assertFalse(self.writes)

    def test_all_seven_authorized_writable_exact_fd_only_clear_022(self):
        before = {}
        for role in core.ROLES:
            path = self.release / self.names[role]
            path.chmod(0o2775 if path.is_dir() else 0o2664)
            before[role] = core.identity(path.stat())
        result = self.run_core(core.ROLES)
        self.assertEqual((result['status'], result['changedCount']), ('CHANGED', 7))
        self.assertEqual(len(self.writes), 7)
        for role in core.ROLES:
            path = self.release / self.names[role]; after = core.identity(path.stat())
            self.assertEqual(after[2], before[role][2] & ~0o022)
            self.assertTrue(all(after[i] == before[role][i] for i in (0, 1, 3, 4, 5, 6, 7)))
        for role, name, *_ in (core.COMPOSE, *core.LEAVES):
            self.assertEqual((self.release / name).read_bytes(), self.data[role])
        for name in ('.env.aws.production', 'release-manifest.json', 'unknown-file'):
            self.assertEqual(stat.S_IMODE((self.release / name).stat().st_mode), 0o666)
        self.assertFalse(result['authority']); self.assertFalse(result['productionEligible'])

    def test_already_safe_idempotent_no_change_does_not_chmod(self):
        result = self.run_core()
        self.assertEqual(result['status'], 'NO_CHANGE'); self.assertEqual(result['changedCount'], 0)
        self.assertFalse(self.writes)

    def test_unselected_writable_parent_refuses_before_any_mutation(self):
        self.writable('CADDY_CONFIG', 'DEPLOY')
        self.failed(self.run_core(), 'UNAUTHORIZED_WRITABLE'); self.assertFalse(self.writes)

    def test_wrong_public_bytes_refuse_before_any_mutation(self):
        self.writable('CADDY_CONFIG')
        (self.release / self.names['CADDY_CONFIG']).write_bytes(b'SYNTHETIC_WRONG_BYTES')
        self.failed(self.run_core(), 'SOURCE_HASH_CHANGED'); self.assertFalse(self.writes)

    def test_missing_symlink_directory_hardlink_large_leaf_never_mutate(self):
        path = self.release / self.names['CADDY_CONFIG']; original = path.read_bytes()
        for kind, code in (('missing', 'IO_FAILURE'), ('symlink', 'IO_FAILURE'),
                           ('directory', 'TYPE'), ('hardlink', 'LINKS'), ('large', 'SIZE')):
            with self.subTest(kind=kind):
                path.unlink()
                if kind == 'symlink': path.symlink_to(self.release / self.names['MYSQL_SCHEMA'])
                elif kind == 'directory': path.mkdir()
                elif kind == 'hardlink': os.link(self.release / self.names['MYSQL_SCHEMA'], path)
                elif kind == 'large': path.write_bytes(b'x' * (1024**2 + 1))
                self.failed(self.run_core(), code); self.assertFalse(self.writes)
                if path.is_dir(): path.rmdir()
                elif path.exists() or path.is_symlink(): path.unlink()
                path.write_bytes(original); path.chmod(0o600)

    def test_owner_mismatch_cannot_enter_writable_branch(self):
        self.writable('CADDY_CONFIG')
        original = core.Authority.strict
        def strict(authority, info, *, directory):
            if info.st_ino == (self.release / self.names['CADDY_CONFIG']).stat().st_ino:
                values = list(info); values[4] = os.geteuid() + 1
                info = os.stat_result(values)
            return original(authority, info, directory=directory)
        with patch.object(core.Authority, 'strict', strict):
            self.failed(self.run_core(), 'OWNER')
        self.assertFalse(self.writes)

    def test_current_namespace_or_public_identity_changes_before_write(self):
        self.writable('CADDY_CONFIG'); count = 0
        def change_current():
            nonlocal count
            count += 1
            if count == 2:
                path = self.base / 'current'; path.unlink(); path.symlink_to('releases/' + self.release.name)
        self.failed(self.run_core(source=change_current), 'CURRENT_CHANGED'); self.assertFalse(self.writes)

    def test_target_namespace_changes_before_write(self):
        self.writable('CADDY_CONFIG'); count = 0
        def replace():
            nonlocal count
            count += 1
            if count == 2:
                path = self.release / self.names['CADDY_CONFIG']
                replacement = path.with_name('synthetic-replacement')
                replacement.write_bytes(self.data['CADDY_CONFIG']); replacement.chmod(0o664)
                replacement.replace(path)
        self.failed(self.run_core(source=replace), 'IDENTITY_CHANGED'); self.assertFalse(self.writes)

    def test_source_and_seven_services_changes_before_write(self):
        self.writable('CADDY_CONFIG')
        def source_changed(): raise core.Rejected('SOURCE_CHANGED')
        self.failed(self.run_core(source=source_changed), 'SOURCE_CHANGED')
        count = 0
        def services(_current):
            nonlocal count
            count += 1; return ('1' if count == 1 else '2') * 64
        self.failed(self.run_core(service=services), 'SERVICES_CHANGED'); self.assertFalse(self.writes)

    def test_fchmod_failure_is_attempted_unverified_no_unsafe_rollback(self):
        self.writable('CADDY_CONFIG')
        with patch.object(core.os, 'fchmod', side_effect=OSError('SYNTHETIC_PRIVATE_UNTOUCHED')):
            result = self.run_core()
        self.failed(result, 'IO_FAILURE', mutated=True)
        self.assertEqual(result['targets'][5]['status'], 'ATTEMPTED_UNVERIFIED')

    def test_post_mutation_services_change_preserves_partial_fact(self):
        self.writable('CADDY_CONFIG'); count = 0
        def services(_current):
            nonlocal count
            count += 1; return ('2' if count == 4 else '1') * 64
        result = self.run_core(service=services)
        self.failed(result, 'SERVICES_CHANGED', mutated=True)
        self.assertEqual(stat.S_IMODE((self.release / self.names['CADDY_CONFIG']).stat().st_mode), 0o644)
        self.assertEqual(len(self.writes), 1)

    def test_second_mutation_failure_preserves_first_verified_count(self):
        targets = ('CADDY_CONFIG', 'MYSQL_SCHEMA'); self.writable(*targets)
        real = os.fchmod; count = 0
        def fail_second(fd, mode):
            nonlocal count
            count += 1
            if count == 2: raise OSError('SYNTHETIC_FAILURE')
            return real(fd, mode)
        with patch.object(core.os, 'fchmod', side_effect=fail_second): result = self.run_core(targets)
        self.failed(result, 'IO_FAILURE', mutated=True, count=1)
        self.assertEqual(result['targets'][5]['status'], 'VERIFIED_CHANGED')
        self.assertEqual(result['targets'][6]['status'], 'ATTEMPTED_UNVERIFIED')

    def test_rejected_type_args_and_literal_are_exact_without_raw_output(self):
        class Forged(RuntimeError): pass
        class Child(core.Rejected): pass
        class Text(str): pass
        for error in (Forged('SOURCE_CHANGED'), Child('SOURCE_CHANGED'),
                      core.Rejected('SOURCE_CHANGED', 'extra'), core.Rejected(Text('SOURCE_CHANGED')),
                      core.Rejected('SYNTHETIC_PRIVATE_UNTOUCHED')):
            with self.subTest(error=type(error).__name__):
                def fail(): raise error
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr): result = self.run_core(source=fail)
                self.failed(result, 'IO_FAILURE'); self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
        self.assertFalse(self.writes)

    def test_deadline_invalid_or_expired_never_opens_or_writes(self):
        self.failed(self.run_core(deadline=time.monotonic() - 1.0), 'INPUT_INVALID')
        self.failed(self.run_core(deadline=time.monotonic() + 241.0), 'INPUT_INVALID')
        self.assertFalse(self.opened); self.assertFalse(self.writes)

    def test_child_fstat_failure_closes_newly_opened_fd(self):
        real = os.fstat; count = 0
        def fail(fd):
            nonlocal count
            count += 1
            if count == 3: raise OSError('SYNTHETIC_PRIVATE_UNTOUCHED')
            return real(fd)
        with patch.object(core.os, 'fstat', side_effect=fail): self.failed(self.run_core(), 'IO_FAILURE')
        self.assertFalse(self.writes)

    def test_closed_result_rejects_unknown_fields_boolean_count_and_bad_status(self):
        good = self.run_core()
        for change in (lambda r: r.update(token='SYNTHETIC_PRIVATE_UNTOUCHED'),
                       lambda r: r.update(changedCount=False), lambda r: r.update(authority=True),
                       lambda r: r['targets'][0].update(raw='SYNTHETIC_PRIVATE_UNTOUCHED'),
                       lambda r: r.update(status='CHANGED')):
            bad = copy.deepcopy(good); change(bad)
            with self.assertRaises(core.Rejected): core.result_validate(bad)
    def test_captured_stat_mode_drift_then_revert_refuses_zero_fchmod(self):
        self.writable('CADDY_CONFIG'); real = os.fstat; issued = False
        inode = (self.release / self.names['CADDY_CONFIG']).stat().st_ino
        def fstat(fd):
            nonlocal issued
            value = real(fd)
            caller = inspect.currentframe().f_back
            while caller and caller.f_code.co_filename.endswith('unittest/mock.py'):
                caller = caller.f_back
            if not issued and value.st_ino == inode and caller.f_code.co_name == 'repair':
                issued = True
                fields = {name:getattr(value, name) for name in ('st_dev','st_ino','st_mode','st_uid','st_gid',
                    'st_nlink','st_size','st_mtime_ns','st_ctime_ns')}
                fields['st_mode'] = stat.S_IFMT(value.st_mode) | 0o666
                return types.SimpleNamespace(**fields)
            return value
        with patch.object(core.os, 'fstat', side_effect=fstat): result = self.run_core()
        self.failed(result, 'IDENTITY_CHANGED'); self.assertTrue(issued); self.assertFalse(self.writes)

    def test_source_change_after_first_chmod_clears_final_source_verified(self):
        self.writable('CADDY_CONFIG'); count = 0
        def source():
            nonlocal count
            count += 1
            if count == 4: (self.release / self.names['CADDY_CONFIG']).write_bytes(b'SYNTHETIC_CHANGED_AFTER_WRITE')
        result = self.run_core(source=source)
        self.failed(result, 'IDENTITY_CHANGED', mutated=True)
        self.assertFalse(result['sourceVerified']); self.assertEqual(len(self.writes), 1)



class TransportTests(unittest.TestCase):
    def setUp(self):
        self.producer = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
                        'workflowRunId': '11111111111111111111', 'workflowRunAttempt': '11111111111111111111'}
        def no_network(*args, **kwargs): raise AssertionError('Synthetic test attempted process/network')
        p = patch.object(transport.subprocess, 'run', side_effect=no_network)
        p.start(); self.addCleanup(p.stop)

    def parameters(self):
        return transport.parameters(self.producer, source=SOURCE)

    def failed_result(self, binding):
        receipt = core.repair(authorized_targets=core.ROLES, observed_reader_facts=binding['readerFacts'])
        return {'kind': 'API_WORKSPACE_PUBLIC_PERMISSION_EXECUTION_V1', 'version': 1,
            'operation': transport.OPERATION, 'producer': binding['producer'], 'origin': binding['origin'],
            'authorizedTargets': binding['authorizedTargets'], 'source21Sha256': binding['source21Sha256'],
            'coreSha256': binding['extraPins'][transport.CORE_NAME],
            'transportSha256': binding['extraPins'][transport.SELF_NAME],
            'snapshotSha256': binding['extraPins'][transport.SNAPSHOT_NAME],
            'clientCleanupVerified': True, 'receipt': receipt, 'snapshotDiagnostic': snapshot.snapshot_state().get(),
            'authority': False, 'productionEligible': False, 'rawOutputSuppressed': True}

    def record(self, binding, value):
        return {'kind': 'API_WORKSPACE_PUBLIC_PERMISSION_ARTIFACT_V1', 'operation': transport.OPERATION,
            'producer': self.producer, 'origin': transport.ORIGIN,
            'commandId': '11111111-1111-4111-8111-111111111111', 'status': 'OPERATION_FAILED',
            'code': 'INPUT_INVALID', 'result': value}

    def test_actual_source21_plus_new_three_sha_carrier_budget_only_assembly(self):
        captured = []
        real_module = transport.module
        def loaded(raw, name, path):
            value = real_module(raw, name, path)
            if Path(path).name == 'online-recharge-backup-source-recovery-transport.py':
                packed = value.packed_command
                def capture(raw, bound):
                    captured.append(len(raw)); return packed(raw, bound)
                value.packed_command = capture
            return value
        with patch.object(transport, 'module', side_effect=loaded): payload, binding = self.parameters()
        self.assertLess(len(transport.canonical(payload)), 20480)
        self.assertEqual(payload['executionTimeout'], ['300'])
        self.assertEqual(len(binding['controllerPins']), 11); self.assertEqual(len(binding['packagePins']), 10)
        self.assertEqual(set(binding['extraPins']), {transport.CORE_NAME, transport.SELF_NAME, transport.SNAPSHOT_NAME})
        self.assertEqual(binding['extraPins'][transport.CORE_NAME], transport.sha((SOURCE / transport.CORE_NAME).read_bytes()))
        self.assertEqual(binding['authorizedTargets'], list(core.ROLES)); self.assertEqual(binding['origin'], transport.ORIGIN)
        self.assertEqual(len(transport.SOURCE_NAMES), 24)
        self.assertNotIn('SYNTHETIC_PRIVATE_UNTOUCHED', json.dumps(payload))
        print('SYNTHETIC_ONLY_PAYLOAD_BYTES=' + str(len(transport.canonical(payload))))
        print('SYNTHETIC_ONLY_CAPTURED_STORE_BODY_BYTES=' + str(captured[0]))
        print('SYNTHETIC_ONLY_CAPTURED_EXECUTION_BODY_BYTES=' + str(captured[1]))

    def test_exact_actual_origin_and_roles_cannot_be_rebound(self):
        self.assertEqual(transport.ORIGIN['producer'], {'commit':'9ba28849fa73d65eacdfb16cc5cefba876a057b5',
            'sourceTree':'7cb42f48723927309d9bb689df734a7956701831', 'workflowRunId':'38082132351', 'workflowRunAttempt':'1'})
        self.assertEqual(transport.ORIGIN['commandId'], 'e040dec8-f453-4556-b96c-a740854b6441')
        self.assertEqual(transport.ORIGIN['receiptBytes'], 11227)
        self.assertEqual(transport.ORIGIN['receiptSha256'], 'df724e4abb21072afb6308359ea838a0de15adabd40f38e6e9c03f16bc2850c5')
        _payload, binding = self.parameters()
        for change in (lambda b:b['origin'].update(receiptSha256='0'*64),
                       lambda b:b['origin']['producer'].update(workflowRunId='1'),
                       lambda b:b.update(authorizedTargets=['CADDY_CONFIG']),
                       lambda b:b['readerFacts']['rows'][4].update(predicates=['OWNER', 'WRITABLE'])):
            bad = copy.deepcopy(binding); change(bad)
            with self.assertRaises(RuntimeError): transport.binding_validate(bad, workspace, core)

    def test_actual_consumer_closes_all20_roles_and_qualification_false(self):
        _payload, binding = self.parameters()
        for change in (lambda b:b.update(token='SYNTHETIC_PRIVATE_UNTOUCHED'),
                       lambda b:b['readerFacts'].update(raw='SYNTHETIC_PRIVATE_UNTOUCHED'),
                       lambda b:b['readerFacts']['rows'].pop(),
                       lambda b:b['readerFacts']['rows'][0].update(role='UNKNOWN'),
                       lambda b:b['readerFacts'].update(authority=True),
                       lambda b:b['readerFacts'].update(productionEligible=True)):
            bad = copy.deepcopy(binding); change(bad)
            with self.assertRaises(RuntimeError): transport.binding_validate(bad, workspace, core)

    def test_sourcepin_names_fixed_and_no_unknown_or_env_source(self):
        _payload, binding = self.parameters()
        for field in ('controllerPins', 'packagePins', 'extraPins'):
            bad = copy.deepcopy(binding); key = next(iter(bad[field])); bad[field]['../.env'] = bad[field].pop(key)
            with self.assertRaises(transport.Rejected): transport.binding_validate(bad, workspace, core)

    def test_failure_outer_result_stays_closed_and_never_qualifies(self):
        _payload, binding = self.parameters(); value = self.failed_result(binding)
        transport.validate_result(value, binding, workspace, core, snapshot)
        for change in (lambda v:v.update(raw='SYNTHETIC_PRIVATE_UNTOUCHED'), lambda v:v.update(authority=True),
                       lambda v:v['receipt'].update(token='SYNTHETIC_PRIVATE_UNTOUCHED'),
                       lambda v:v['origin'].update(commandId='not-uuid')):
            bad = copy.deepcopy(value); change(bad)
            with self.assertRaises(RuntimeError): transport.validate_result(bad, binding, workspace, core, snapshot)

    def test_artifact_closed_nonempty_result_requires_uuid_and_original_code(self):
        _payload, binding = self.parameters(); record = self.record(binding, self.failed_result(binding))
        transport.validate_artifact(record, self.producer, binding, workspace, core, snapshot)
        for change in (lambda v:v.update(raw='SYNTHETIC_PRIVATE_UNTOUCHED'), lambda v:v.update(commandId=None),
                       lambda v:v.update(status='OPERATION_COMPLETED'), lambda v:v.update(code='OK'),
                       lambda v:v.update(producer={'commit':'a'*40})):
            bad = copy.deepcopy(record); change(bad)
            with self.assertRaises(RuntimeError): transport.validate_artifact(bad, self.producer, binding, workspace, core, snapshot)
        empty = self.record(binding, None); empty.update(commandId=None, code='TRANSPORT_UNAVAILABLE')
        transport.validate_artifact(empty, self.producer, binding, workspace, core, snapshot)

    def test_terminal_binds_original_command_instance_ended_and_finite_failure(self):
        _payload, binding = self.parameters(); value = self.failed_result(binding)
        invocation = {'CommandId':'11111111-1111-4111-8111-111111111111', 'InstanceId':'i-11111111111111111',
            'DocumentName':'AWS-RunShellScript', 'PluginName':'aws:runShellScript', 'Status':'Failed', 'ResponseCode':1,
            'ExecutionEndDateTime':'2026-10-11T00:00:00Z', 'StandardOutputContent':transport.PREFIX+transport.canonical(value).decode(),
            'StandardErrorContent':'SYNTHETIC_PRIVATE_UNTOUCHED'}
        transport.terminal(invocation, invocation['CommandId'], binding, invocation['InstanceId'], workspace, core, snapshot)
        for change in (lambda v:v.update(CommandId='22222222-2222-4222-8222-222222222222'),
                       lambda v:v.update(InstanceId='i-22222222222222222'), lambda v:v.update(Status='InProgress'),
                       lambda v:v.update(ResponseCode=0), lambda v:v.update(StandardOutputContent='SYNTHETIC_PRIVATE_UNTOUCHED')):
            bad = copy.deepcopy(invocation); change(bad)
            with self.assertRaises(RuntimeError): transport.terminal(bad, invocation['CommandId'], binding,
                invocation['InstanceId'], workspace, core, snapshot)

    def test_selection_old_compose_op_and_reuse_inputs_refused(self):
        environ = {'RELEASE_OPERATION':transport.OPERATION, 'EXPECTED_CURRENT':core.BASELINE, 'GITHUB_REF':'refs/heads/main',
            'RELEASE_COMMIT':self.producer['commit'], 'SOURCE_TREE':self.producer['sourceTree'],
            'GITHUB_RUN_ID':self.producer['workflowRunId'], 'GITHUB_RUN_ATTEMPT':self.producer['workflowRunAttempt']}
        self.assertEqual(transport.selection(environ), self.producer)
        for change in (lambda v:v.update(RELEASE_OPERATION='repair_online_source_permissions'),
                       lambda v:v.update(EXPECTED_CURRENT='f'*40), lambda v:v.update(REUSE_IMAGE_RUN='1')):
            bad = dict(environ); change(bad)
            with self.assertRaises(transport.Rejected): transport.selection(bad)

    def test_closed_json_duplicates_unknown_nonfinite_and_byte_cap(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'x'*24000, b'\xff'):
            with self.assertRaises((RuntimeError, ValueError)): transport.closed(raw)

    def test_main_total390_deadline_limits_each_aws_and_wait_no_network(self):
        environ = {'RELEASE_OPERATION':transport.OPERATION, 'EXPECTED_CURRENT':core.BASELINE, 'GITHUB_REF':'refs/heads/main',
            'RELEASE_COMMIT':self.producer['commit'], 'SOURCE_TREE':self.producer['sourceTree'],
            'GITHUB_RUN_ID':self.producer['workflowRunId'], 'GITHUB_RUN_ATTEMPT':self.producer['workflowRunAttempt'],
            'AWS_REGION':'SYNTHETIC_REGION', 'PRODUCTION_INSTANCE_ID':'i-11111111111111111'}
        clock = [0.0]; calls = []; saved = []
        command = '11111111-1111-4111-8111-111111111111'
        def process(*args, timeout):
            calls.append(timeout); clock[0] += timeout
            if 'send-command' in args: return command.encode()
            return transport.canonical({'CommandId':command, 'InstanceId':environ['PRODUCTION_INSTANCE_ID'], 'Status':'Pending'})
        def wait(seconds): clock[0] += seconds
        real_module = transport.module
        def loaded(raw, name, path):
            if name == 'public_repair_artifact_writer':
                return types.SimpleNamespace(write_workspace_private_bytes=lambda name, raw:saved.append((name, raw)))
            return real_module(raw, name, path)
        stdout = io.StringIO()
        with patch.dict(transport.os.environ, environ, clear=True), patch.object(transport.sys, 'argv', ['synthetic-test']), \
             patch.object(transport.time, 'monotonic', side_effect=lambda:clock[0]), \
             patch.object(transport.time, 'sleep', side_effect=wait), patch.object(transport, 'aws', side_effect=process), \
             patch.object(transport, 'module', side_effect=loaded), redirect_stdout(stdout):
            self.assertEqual(transport.main(), 1)
        self.assertLessEqual(clock[0], 390); self.assertTrue(calls); self.assertTrue(all(0 < n <= 60 for n in calls))
        self.assertEqual(len(saved), 1); self.assertEqual(saved[0][0], transport.ARTIFACT)
        value = transport.closed(saved[0][1]); self.assertEqual(value['code'], 'TRANSPORT_UNAVAILABLE')
        self.assertIsNone(value['result']); self.assertNotIn('SYNTHETIC_REGION', stdout.getvalue())
    def test_transport_and_bash_exact_selection_and_all11_unrelated_inputs(self):
        clean = {'PATH':'/usr/bin:/bin', 'RELEASE_OPERATION':transport.OPERATION, 'EXPECTED_CURRENT':core.BASELINE,
            'GITHUB_REF':'refs/heads/main', 'HISTORICAL_EXCEPTION':'none', 'RELEASE_ADMIN_ONLY':'false',
            'RELEASE_COMMIT':self.producer['commit'], 'SOURCE_TREE':self.producer['sourceTree'],
            'GITHUB_RUN_ID':self.producer['workflowRunId'], 'GITHUB_RUN_ATTEMPT':self.producer['workflowRunAttempt']}
        self.assertEqual(transport.selection(clean), self.producer)
        def bash(environ):
            return LOCAL_PROCESS(['/bin/bash', str(SOURCE/'validate-release-selection.sh')], cwd=SOURCE.parents[1],
                env=environ, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).returncode
        self.assertEqual(bash(clean), 0)
        bad = [('RELEASE_OPERATION',transport.OPERATION+'-extra'), ('EXPECTED_CURRENT','f'*40),
               ('GITHUB_REF','refs/heads/other'), ('HISTORICAL_EXCEPTION','other'), ('RELEASE_ADMIN_ONLY','true')]
        attached = ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
            'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256', 'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256',
            'RELEASE_BROWSER_CACHE_IMAGE', 'RELEASE_BROWSER_CACHE_IMAGE_ID', 'CACHE_PLAN_SHA256', 'DIAGNOSTIC_COMMAND_ID')
        for key, value in bad + [(key, 'SYNTHETIC_ATTACHED_INPUT') for key in attached]:
            with self.subTest(key=key):
                changed = dict(clean); changed[key] = value
                with self.assertRaises(transport.Rejected): transport.selection(changed)
                self.assertNotEqual(bash(changed), 0)

    def test_workflow_only_choice_explicit_repair_and_always_safe_upload_no_release_steps(self):
        path = SOURCE.parents[1]/'.github/workflows/production-release.yml'; text = path.read_text()
        self.assertEqual(text.count(transport.OPERATION), 3)
        self.assertIn('run: python3 -B scripts/production-release/'+transport.SELF_NAME, text)
        self.assertIn('path: '+transport.ARTIFACT, text)
        sequence = ('Verify exact source and passing Quality Gate', 'Obtain short-lived AWS credentials through OIDC',
            'Check AWS identity and production target', 'Verify read-only SSM command access',
            'Explicitly repair the diagnosed API Workspace public permissions',
            'Save only the API Workspace public permission repair safe receipt')
        positions = [text.index('- name: '+title) for title in sequence]
        self.assertEqual(positions, sorted(positions))
        script = ("const fs=require('fs'),yaml=require('js-yaml');"
                  "const w=yaml.load(fs.readFileSync(process.argv[1],'utf8'));"
                  "process.stdout.write(JSON.stringify({inputs:w.on.workflow_dispatch.inputs,"
                  "steps:Object.values(w.jobs).flatMap(j=>j.steps||[])}));")
        parsed = LOCAL_PROCESS(['node','-e',script,str(path)], cwd=SOURCE.parents[1],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10)
        content = json.loads(parsed.stdout)
        inputs = {name:value.get('default','') for name,value in content['inputs'].items()}
        inputs.update(operation=transport.OPERATION, historical_exception='none', commit=self.producer['commit'],
            expected_current=core.BASELINE, reuse_image_run='', diagnostic_command_id='', cache_plan_sha256='')
        expected = ['Reject removed automatic registration releases','Check out the requested main commit',
            'Verify exact source and passing Quality Gate','Validate release policy and reviewed seal selection',
            *sequence[1:]]
        for failed in (False, True):
            steps = [step for step in content['steps'] if workflow_condition(step.get('if'),inputs,failed)]
            self.assertEqual([step['name'] for step in steps], expected)
            uploads = [step for step in steps if step.get('uses','').startswith('actions/upload-artifact@')]
            self.assertEqual(len(uploads),1)
            self.assertEqual(uploads[0]['with']['path'],transport.ARTIFACT)
            self.assertEqual(uploads[0]['with']['name'], 'api-workspace-public-permission-repair-${{ github.run_id }}-${{ github.run_attempt }}')
            self.assertEqual(uploads[0]['if'], "always() && inputs.operation == 'repair_api_workspace_public_permissions'")



if __name__ == '__main__': unittest.main()
