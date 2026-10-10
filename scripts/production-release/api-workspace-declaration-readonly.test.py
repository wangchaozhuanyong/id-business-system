import copy
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from contextlib import redirect_stderr, redirect_stdout


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader = load('declaration_inventory_readonly_tests', 'api-workspace-declaration-readonly.py')
remote = load('declaration_inventory_remote_tests', 'remote-deploy.py')
workspace = load('declaration_inventory_workspace_tests', 'api-admin-scope.py')
PRODUCER = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
            'workflowRunId': '123', 'workflowRunAttempt': '2'}


class InventoryTransportTests(unittest.TestCase):
    def report(self):
        return {'status': reader.STATUS, 'commit': reader.BASELINE, 'producer': copy.deepcopy(PRODUCER),
                'inventory': {'fixture': 'not-production-evidence'}, 'authority': False,
                'productionEligible': False, 'rawOutputSuppressed': True,
                'stableServicesSha256': '1' * 64, 'boundFilesSha256': '2' * 64,
                'readerFacts': {'kind': 'API_WORKSPACE_READER_FACTS_DIAGNOSTIC', 'version': 1,
                    'status': 'OBSERVED', 'authority': False, 'productionEligible': False,
                    'rawOutputSuppressed': True, 'rows': [{'role': role, 'phase': 'IDENTITY',
                        'status': 'MATCH', 'predicates': []} for role in workspace.WORKSPACE_READER_FACT_ROLES]}}

    def test_non_authorizing_receipt_rejects_grants_scope_and_run_drift(self):
        expected = self.report()
        seen = []
        self.assertEqual(reader.validate_receipt(expected, PRODUCER, seen.append), expected)
        self.assertEqual(seen, [expected['inventory']])
        mutations = [
            ('authority', True), ('authority', 0), ('productionEligible', True),
            ('status', 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'),
            ('status', 'API_ADMIN_WORKSPACE_VERIFIED'), ('commit', 'c' * 40),
            ('rawOutputSuppressed', False), ('stableServicesSha256', 'invalid')]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(expected)
                changed[key] = value
                with self.assertRaises(RuntimeError):
                    reader.validate_receipt(changed, PRODUCER, lambda _value: None)
        changed = copy.deepcopy(expected)
        changed['producer']['workflowRunAttempt'] = '3'
        with self.assertRaises(RuntimeError):
            reader.validate_receipt(changed, PRODUCER, lambda _value: None)
        changed = {**expected, 'pendingOnlineMigrationOrigin': {}}
        with self.assertRaises(RuntimeError):
            reader.validate_receipt(changed, PRODUCER, lambda _value: None)

    def test_closed_stdout_rejects_duplicate_keys_nonfinite_and_overflow(self):
        for raw in ('{"authority":false,"authority":true}', '{"value":NaN}',
                    '{"value":Infinity}', 'x' * 24000, '你' * 8000, None, b'{}'):
            with self.subTest(kind=type(raw).__name__):
                with self.assertRaises((RuntimeError, ValueError, TypeError)):
                    reader.closed_json(raw)
        self.assertEqual(reader.closed_json(json.dumps(self.report())), self.report())

    def test_only_fixed_inventory_command_and_exact_source_helper_digests(self):
        digests = {name: '1' * 64 for name in reader.HELPERS}
        data = reader.parameters(PRODUCER['commit'], reader.BASELINE, PRODUCER, digests)
        commands = '\n'.join(data['commands'])
        self.assertIn('--api-workspace-declaration-inventory', commands)
        self.assertEqual(len(re.findall('/scripts/production-release/', commands)), len(reader.HELPERS))
        self.assertNotRegex(commands, r'--api-workspace-(?:preflight|readback|only)\b')
        self.assertNotRegex(commands, r'\bdocker\b|\bmysql\b|--release|git reset|rm -rf')
        self.assertLess(len(json.dumps(data).encode()), 20 * 1024)
        for key, value in [('commit', 'a' * 40 + ';id'), ('sourceTree', 'b' * 39),
                           ('workflowRunId', '0'), ('workflowRunAttempt', True)]:
            changed = {**PRODUCER, key: value}
            with self.assertRaises(RuntimeError):
                reader.parameters(changed['commit'], reader.BASELINE, changed, digests)
        for changed in ({**digests, 'stranger.py': '2' * 64},
                        {**digests, 'remote-deploy.py': '$(id)'},
                        {k: v for k, v in digests.items() if k != 'remote-deploy.py'}):
            with self.assertRaises(RuntimeError):
                reader.parameters(PRODUCER['commit'], reader.BASELINE, PRODUCER, changed)
        with self.assertRaises(RuntimeError):
            reader.parameters(PRODUCER['commit'], 'c' * 40, PRODUCER, digests)

    def test_inventory_validator_failure_never_falls_back_to_preflight(self):
        def reject(_value):
            raise RuntimeError('SOURCE_NOT_MEASURED')
        with self.assertRaisesRegex(RuntimeError, '^SOURCE_NOT_MEASURED$'):
            reader.validate_receipt(self.report(), PRODUCER, reject)

    def test_wrong_fixed_origin_is_rejected_before_platform_reads(self):
        with patch.object(remote, 'online_recharge_scope') as platform:
            with self.assertRaises(RuntimeError):
                remote.api_workspace_declaration_inventory('c' * 40, PRODUCER)
            platform.assert_not_called()
        with patch.object(remote, 'online_recharge_scope') as platform:
            with self.assertRaises(RuntimeError):
                remote.api_workspace_declaration_inventory(reader.BASELINE,
                    {**PRODUCER, 'workflowRunAttempt': True})
            platform.assert_not_called()

    def invocation(self):
        return {'CommandId': '00000000-0000-0000-0000-000000000001',
                'InstanceId': 'i-0123456789abcdef0', 'DocumentName': 'AWS-RunShellScript',
                'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
                'StandardErrorContent': '', 'StandardOutputContent': json.dumps(self.report()),
                'ExecutionEndDateTime': '2026-01-01T00:00:00.123456Z'}

    def test_ended_invocation_binds_actual_transport_without_rewriting_payload(self):
        for ended in ('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.123456Z',
                      '2026-01-01T00:00:00+00:00'):
            value = self.invocation(); value['ExecutionEndDateTime'] = ended
            before = copy.deepcopy(value)
            self.assertIs(reader.validate_ended_invocation(value, command_id=value['CommandId'],
                instance_id=value['InstanceId']), value)
            self.assertEqual(value, before)

    def test_ended_invocation_rejects_missing_forged_and_invalid_metadata_safely(self):
        value = self.invocation()
        future = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).isoformat()
        mutations = [('CommandId', '00000000-0000-0000-0000-000000000002'),
            ('InstanceId', 'i-11111111111111111'), ('DocumentName', 'OtherDocument'),
            ('PluginName', 'OtherPlugin'), ('Status', 'Failed'), ('ResponseCode', False),
            ('ResponseCode', True), ('ResponseCode', 1), ('ResponseCode', '0'),
            ('StandardErrorContent', 'LOCAL_SYNTHETIC_PRIVATE_SENTINEL'),
            ('StandardErrorContent', None), ('StandardOutputContent', None),
            ('ExecutionEndDateTime', future), ('ExecutionEndDateTime', '2026-01-01T00:00:00+08:00'),
            ('ExecutionEndDateTime', '2026-01-01T00:00:00'), ('ExecutionEndDateTime', '2026-13-01T00:00:00Z'),
            ('ExecutionEndDateTime', '2026-01-01T99:00:00Z'), ('ExecutionEndDateTime', False)]
        cases = [dict(value, **{key: new}) for key, new in mutations]
        cases.extend({key: new for key, new in value.items() if key != missing} for missing in value)
        cases.extend([None, [], {**value, 'InstanceId': 'i-11111111111111111',
                               'trustedInstanceId': value['InstanceId'], 'trusted': True}])
        stdout = io.StringIO(); stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            for index, changed in enumerate(cases):
                with self.subTest(case=index), self.assertRaisesRegex(RuntimeError,
                        '^API_ADMIN_DECLARATION_INVENTORY_INVALID$'):
                    reader.validate_ended_invocation(changed, command_id=value['CommandId'],
                        instance_id=value['InstanceId'])
            for command_id, instance_id in ((True, value['InstanceId']), (value['CommandId'], True),
                                           ('invalid', value['InstanceId']), (value['CommandId'], 'i-invalid')):
                with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_DECLARATION_INVENTORY_INVALID$'):
                    reader.validate_ended_invocation(value, command_id=command_id, instance_id=instance_id)
        self.assertEqual(stdout.getvalue(), ''); self.assertEqual(stderr.getvalue(), '')

    def test_main_rejects_bad_ended_metadata_before_receipt_parse_or_save(self):
        root = Path(__file__).resolve().parents[2]
        output = root / '.runtime/online-recharge-release-20261009/build/declaration-inventory-client-tests'
        output.mkdir(parents=True, exist_ok=True)
        value = self.invocation(); value['InstanceId'] = 'i-11111111111111111'
        value['StandardOutputContent'] = 'LOCAL_SYNTHETIC_PRIVATE_STDOUT'
        value['StandardErrorContent'] = 'LOCAL_SYNTHETIC_PRIVATE_STDERR'
        def transport(*args):
            if args == ('git', 'rev-parse', 'HEAD'): return PRODUCER['commit']
            if args == ('git', 'rev-parse', 'HEAD^{tree}'): return PRODUCER['sourceTree']
            if 'send-command' in args: return self.invocation()['CommandId']
            if 'get-command-invocation' in args: return json.dumps(value)
            raise AssertionError('UNEXPECTED_TRANSPORT_CALL')
        environment = {'RELEASE_OPERATION': 'verify_api_workspace', 'RELEASE_COMMIT': PRODUCER['commit'],
            'SOURCE_TREE': PRODUCER['sourceTree'], 'GITHUB_RUN_ID': PRODUCER['workflowRunId'],
            'GITHUB_RUN_ATTEMPT': PRODUCER['workflowRunAttempt'], 'EXPECTED_CURRENT': reader.BASELINE,
            'PRODUCTION_INSTANCE_ID': self.invocation()['InstanceId'], 'AWS_REGION': 'ap-northeast-1'}
        cwd = Path.cwd(); stdout = io.StringIO(); stderr = io.StringIO(); validator = MagicMock()
        with tempfile.TemporaryDirectory(prefix='mock-main-', dir=output) as temporary:
            try:
                os.chdir(temporary)
                with patch.dict(reader.os.environ, environment, clear=True), \
                     patch.object(reader, 'command', side_effect=transport) as calls, \
                     patch.object(reader.os, 'umask'), patch.object(reader.time, 'sleep'), \
                     patch.object(reader.runpy, 'run_path', return_value={'validate_inventory': validator}), \
                     patch.object(reader, 'closed_json', side_effect=AssertionError('STDOUT_PARSE_FORBIDDEN')) as parse, \
                     redirect_stdout(stdout), redirect_stderr(stderr):
                    with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_DECLARATION_INVENTORY_INVALID$'):
                        reader.main()
                self.assertEqual(calls.call_count, 4); validator.assert_not_called(); parse.assert_not_called()
                self.assertFalse(Path('.deploy/production-release/api-workspace-declaration-inventory-result.json').exists())
            finally:
                os.chdir(cwd)
        self.assertEqual(stdout.getvalue(), ''); self.assertEqual(stderr.getvalue(), '')


class ReaderFactsDiagnosticTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[2] / '.runtime/backup-retention-protection-20261011/reader-facts-tests'
        output.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='synthetic-only-', dir=output)
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name) / 'base'
        self.source = self.base / 'releases/source'
        self.source.mkdir(parents=True, mode=0o700)
        for directory in (self.base, self.base / 'releases', self.source): directory.chmod(0o700)
        for _role, relative in workspace.WORKSPACE_READER_FACT_PARENTS:
            (self.source / relative).mkdir(mode=0o700)
        for _role, relative in workspace.WORKSPACE_READER_FACT_LEAVES:
            path = self.source / relative
            path.write_bytes(b'SYNTHETIC_PRIVATE_CONTENT_NEVER_READ')
            path.chmod(0o600)
        self.uid = os.geteuid()

    def observe(self):
        return workspace.workspace_reader_facts_inventory(self.source, uid=self.uid)

    def rows(self, report):
        return {row['role']: row for row in report['rows']}

    def test_all_twenty_fixed_roles_are_stat_only_and_do_not_grant_qualification(self):
        original_open = os.open
        flags = []
        def opened(*args, **kwargs):
            flags.append(args[1]); return original_open(*args, **kwargs)
        with patch.object(workspace.os, 'read', side_effect=AssertionError('CONTENT_READ_FORBIDDEN')), \
             patch.object(workspace.os, 'pread', side_effect=AssertionError('CONTENT_READ_FORBIDDEN')), \
             patch.object(Path, 'read_bytes', side_effect=AssertionError('CONTENT_READ_FORBIDDEN')), \
             patch.object(workspace.os, 'chmod', side_effect=AssertionError('MUTATION_FORBIDDEN')), \
             patch.object(workspace.os, 'fchmod', side_effect=AssertionError('MUTATION_FORBIDDEN')), \
             patch.object(workspace.os, 'chown', side_effect=AssertionError('MUTATION_FORBIDDEN')), \
             patch.object(workspace.os, 'fchown', side_effect=AssertionError('MUTATION_FORBIDDEN')), \
             patch.object(workspace.subprocess, 'run', side_effect=AssertionError('PROCESS_FORBIDDEN')), \
             patch.object(workspace.os, 'open', side_effect=opened):
            report = self.observe()
        self.assertEqual(len(report['rows']), 20)
        self.assertEqual(tuple(row['role'] for row in report['rows']), workspace.WORKSPACE_READER_FACT_ROLES)
        self.assertTrue(all(row['status'] == 'MATCH' and row['predicates'] == [] for row in report['rows']))
        self.assertTrue(flags and all(value & os.O_ACCMODE == os.O_RDONLY
                                    and not value & (os.O_CREAT | os.O_TRUNC | os.O_APPEND) for value in flags))
        self.assertIs(report['authority'], False); self.assertIs(report['productionEligible'], False)
        rendered = json.dumps(report)
        for forbidden in ('SYNTHETIC_PRIVATE_CONTENT', str(self.source), 'uid', 'gid', 'mode', 'sha256'):
            self.assertNotIn(forbidden, rendered)
        self.assertNotIn('measurementPerformed', report); self.assertNotIn('proofConstructed', report)
        self.assertIs(workspace.validate_workspace_reader_facts(report), report)

    def test_exact_leaf_and_parent_writable_predicates_do_not_change_permissions(self):
        for role, relative in (*workspace.WORKSPACE_READER_FACT_PARENTS, *workspace.WORKSPACE_READER_FACT_LEAVES):
            with self.subTest(role=role):
                path = self.source / relative; old = stat.S_IMODE(path.stat().st_mode)
                path.chmod(old | 0o022)
                before = path.stat()
                result = self.rows(self.observe())[role]
                self.assertEqual(result['status'], 'REJECTED')
                self.assertEqual(result['phase'], 'ATTRIBUTES')
                expected = ['WRITABLE', 'PRIVATE_MODE'] if role == 'SOURCE_ENV' else ['WRITABLE']
                self.assertEqual(result['predicates'], expected)
                after = path.stat()
                self.assertEqual((before.st_ino, before.st_mode, before.st_uid, before.st_gid),
                                 (after.st_ino, after.st_mode, after.st_uid, after.st_gid))
                path.chmod(old)
        # Ancestor roles use the same original root/non-writable predicates.
        for role, path in [('BASE', self.base), ('RELEASES', self.base / 'releases'), ('SOURCE', self.source)]:
            path.chmod(0o722)
            self.assertEqual(self.rows(self.observe())[role]['predicates'], ['WRITABLE'])
            path.chmod(0o700)

    def test_source_env_private_mode_and_original_zero_size_bound_are_distinct(self):
        env = self.source / '.env.aws.production'; env.chmod(0o644)
        self.assertEqual(self.rows(self.observe())['SOURCE_ENV']['predicates'], ['PRIVATE_MODE'])
        env.chmod(0o400)
        self.assertEqual(self.rows(self.observe())['SOURCE_ENV']['status'], 'MATCH')
        schema = self.source / 'apps/api/prisma-mysql/schema.prisma'
        schema.write_bytes(b'')
        self.assertEqual(self.rows(self.observe())['MYSQL_SCHEMA']['status'], 'MATCH')
        with schema.open('wb') as stream: stream.truncate(1024**2 + 1)
        self.assertEqual(self.rows(self.observe())['MYSQL_SCHEMA']['predicates'], ['SIZE'])

    def test_missing_symlink_nonregular_and_hardlink_are_closed_without_content_reads(self):
        path = self.source / 'docker-compose.aws-mysql.yml'
        path.unlink()
        self.assertEqual(self.rows(self.observe())['COMPOSE']['predicates'], ['MISSING'])
        path.symlink_to('.env.aws.production')
        self.assertEqual(self.rows(self.observe())['COMPOSE']['predicates'], ['SYMLINK'])
        path.unlink(); os.mkfifo(path, 0o600)
        self.assertEqual(self.rows(self.observe())['COMPOSE']['predicates'], ['TYPE'])
        path.unlink(); os.link(self.source / 'compose.release.json', path)
        result = self.rows(self.observe())
        self.assertEqual(result['COMPOSE']['predicates'], ['LINKS'])
        self.assertEqual(result['COMPOSE_RELEASE']['predicates'], ['LINKS'])

    def test_wrong_owner_directory_is_not_traversed_and_parent_symlink_is_not_followed(self):
        original_open = os.open; seen = []
        def opened(*args, **kwargs):
            seen.append(args[0]); return original_open(*args, **kwargs)
        with patch.object(workspace.os, 'open', side_effect=opened):
            report = workspace.workspace_reader_facts_inventory(self.source, uid=self.uid + 1)
        self.assertEqual(self.rows(report)['BASE']['predicates'], ['OWNER'])
        self.assertNotIn('releases', seen); self.assertNotIn('.env.aws.production', seen)
        self.assertTrue(all(self.rows(report)[role]['status'] == 'NOT_MEASURED'
                            for role, _name in workspace.WORKSPACE_READER_FACT_LEAVES))
        parent = self.source / 'deploy/caddy'
        (parent / 'Caddyfile.aws').unlink(); parent.rmdir(); parent.symlink_to('../apps')
        report = self.rows(self.observe())
        self.assertEqual(report['CADDY_PARENT']['predicates'], ['SYMLINK'])
        self.assertEqual(report['CADDY_CONFIG']['status'], 'NOT_MEASURED')
        for path in (Path('relative/source'), self.source / '../source'):
            with patch.object(workspace.os, 'open', side_effect=AssertionError('INVALID_PATH_OPEN_FORBIDDEN')):
                report = workspace.workspace_reader_facts_inventory(path, uid=self.uid)
            self.assertEqual(self.rows(report)['SOURCE_CHAIN']['predicates'], ['PATH_INVALID'])

    def test_leaf_identity_race_and_open_error_are_finite_and_all_descriptors_close(self):
        original_open = os.open; original_close = os.close; original_stat = os.stat
        outstanding = set(); calls = 0
        def opened(*args, **kwargs):
            fd = original_open(*args, **kwargs); outstanding.add(fd); return fd
        def closed(fd):
            outstanding.remove(fd); return original_close(fd)
        def observed(name, *args, **kwargs):
            nonlocal calls
            value = original_stat(name, *args, **kwargs)
            if name == 'schema.prisma' and kwargs.get('follow_symlinks') is False:
                calls += 1
                if calls == 2:
                    values = list(value); values[1] += 1; return os.stat_result(values)
            return value
        with patch.object(workspace.os, 'open', side_effect=opened), \
             patch.object(workspace.os, 'close', side_effect=closed), \
             patch.object(workspace.os, 'stat', side_effect=observed):
            report = self.observe()
        self.assertEqual(outstanding, set())
        self.assertEqual(self.rows(report)['MYSQL_SCHEMA'], {'role': 'MYSQL_SCHEMA',
            'phase': 'IDENTITY', 'status': 'REJECTED', 'predicates': ['IDENTITY_CHANGED']})
        def denied(name, *args, **kwargs):
            if name == 'Caddyfile.aws': raise PermissionError('SYNTHETIC_PRIVATE_ERROR_NEVER_OUTPUT')
            return original_open(name, *args, **kwargs)
        with patch.object(workspace.os, 'open', side_effect=denied): report = self.observe()
        self.assertEqual(self.rows(report)['CADDY_CONFIG']['predicates'], ['IO_FAILURE'])
        self.assertNotIn('SYNTHETIC_PRIVATE_ERROR', json.dumps(report))
        # fstat failure happens after successful child open; it must still close.
        original_fstat = os.fstat; failing = set()
        def opened_with_failure(*args, **kwargs):
            fd = opened(*args, **kwargs)
            if args[0] == 'docker-compose.aws-mysql.yml': failing.add(fd)
            return fd
        def stated(fd):
            if fd in failing:
                failing.remove(fd); raise OSError('SYNTHETIC_PRIVATE_FSTAT_ERROR')
            return original_fstat(fd)
        with patch.object(workspace.os, 'open', side_effect=opened_with_failure), \
             patch.object(workspace.os, 'close', side_effect=closed), \
             patch.object(workspace.os, 'fstat', side_effect=stated):
            report = self.observe()
        self.assertEqual(outstanding, set())
        self.assertEqual(self.rows(report)['COMPOSE']['predicates'], ['IO_FAILURE'])

    def test_closed_schema_rejects_unknowns_missing_reordered_roles_and_grants(self):
        report = self.observe(); cases = []
        for key, value in [('version', True), ('authority', 0), ('authority', True),
                ('productionEligible', True), ('rawOutputSuppressed', False), ('status', 'VERIFIED')]:
            cases.append({**report, key: value})
        cases.append({**report, 'token': 'SYNTHETIC_PRIVATE_SENTINEL'})
        cases.append({**report, 'rows': report['rows'][:-1]})
        cases.append({**report, 'rows': list(reversed(report['rows']))})
        for key, value in [('role', 'ARBITRARY_FILE'), ('phase', 'READ'), ('status', 'VERIFIED'),
                           ('predicates', ['WRITABLE', 'WRITABLE']), ('path', 'SYNTHETIC_PRIVATE_SENTINEL')]:
            changed = copy.deepcopy(report); changed['rows'][0][key] = value; cases.append(changed)
        for role, predicate in [('BASE', 'LINKS'), ('DEPLOY', 'SIZE'),
                                ('COMPOSE', 'PRIVATE_MODE'), ('SOURCE_CHAIN', 'OWNER')]:
            changed = copy.deepcopy(report)
            changed['rows'][workspace.WORKSPACE_READER_FACT_ROLES.index(role)].update(
                phase='ATTRIBUTES', status='REJECTED', predicates=[predicate])
            cases.append(changed)
        for changed in cases:
            with self.subTest(value=changed), self.assertRaisesRegex(RuntimeError,
                    '^API_ADMIN_DECLARATION_INVENTORY_INVALID$'):
                workspace.validate_workspace_reader_facts(changed)
        outer = InventoryTransportTests().report(); outer['readerFacts'] = report
        self.assertIs(reader.validate_receipt(outer, PRODUCER, lambda _value: None), outer)
        self.assertLess(len(json.dumps(outer).encode()) + 13100, 24000)
        for changed in ({k: v for k, v in outer.items() if k != 'readerFacts'},
                        {**outer, 'readerFacts': {**report, 'authority': True}},
                        {**outer, 'readerFacts': {**report, 'secret': 'SYNTHETIC_PRIVATE_SENTINEL'}}):
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_DECLARATION_INVENTORY_INVALID$'):
                reader.validate_receipt(changed, PRODUCER, lambda _value: None)

    def test_existing_inventory_keeps_current_bound_files_and_seven_service_guards(self):
        (self.base / 'current').symlink_to('releases/source')
        (self.source / 'release-manifest.json').write_text(json.dumps({'commit': reader.BASELINE}))
        services = {name: {'reference': 'SYNTHETIC_REFERENCE', 'image': 'SYNTHETIC_IMAGE'}
                    for name in ('api', 'admin', 'caddy', 'mysql', 'media-resolver', 'auto-recharge', 'auto-registration')}
        measured = {'fixture': 'SYNTHETIC_NOT_PRODUCTION_EVIDENCE'}
        api = SimpleNamespace(workspace_reader_facts_inventory=lambda directory:
            workspace.workspace_reader_facts_inventory(directory, uid=self.uid),
            validate_workspace_reader_facts=workspace.validate_workspace_reader_facts)
        online = SimpleNamespace(closed_recovery_json=lambda _controller, raw: json.loads(raw),
            release_recovery=lambda *_args: {'restored': {}}, snapshot=MagicMock(return_value=services),
            fingerprint=workspace.fingerprint, legacy=lambda _controller: api)
        namespace = {'inventory': MagicMock(return_value=measured), 'validate_inventory': MagicMock()}
        with patch.object(remote, 'BASE', self.base), \
             patch.object(remote, 'online_recharge_scope', return_value=(online, SimpleNamespace())), \
             patch.object(remote.runpy, 'run_path', return_value=namespace):
            result = remote.api_workspace_declaration_inventory(reader.BASELINE, PRODUCER)
            self.assertEqual(result['inventory'], measured)
            self.assertEqual(result['readerFacts'], self.observe())
            self.assertEqual(online.snapshot.call_count, 2)
            online.snapshot.side_effect = [services, {**services, 'admin': {'image': 'CHANGED'}}]
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_DECLARATION_INVENTORY_CHANGED$'):
                remote.api_workspace_declaration_inventory(reader.BASELINE, PRODUCER)
            online.snapshot.side_effect = None
            def changed_file(*_args, **_kwargs):
                (self.source / 'compose.release.json').write_bytes(b'SYNTHETIC_CHANGED')
                return measured
            namespace['inventory'].side_effect = changed_file
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_DECLARATION_INVENTORY_CHANGED$'):
                remote.api_workspace_declaration_inventory(reader.BASELINE, PRODUCER)
            namespace['inventory'].side_effect = None
            def changed_current(*_args, **_kwargs):
                (self.base / 'current').unlink(); (self.base / 'current').symlink_to('releases/OTHER_SYNTHETIC_SOURCE')
                return measured
            namespace['inventory'].side_effect = changed_current
            with self.assertRaisesRegex(RuntimeError, '^API_ADMIN_DECLARATION_INVENTORY_CHANGED$'):
                remote.api_workspace_declaration_inventory(reader.BASELINE, PRODUCER)


if __name__ == '__main__':
    unittest.main()
