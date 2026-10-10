import copy
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import re
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
PRODUCER = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
            'workflowRunId': '123', 'workflowRunAttempt': '2'}


class InventoryTransportTests(unittest.TestCase):
    def report(self):
        return {'status': reader.STATUS, 'commit': reader.BASELINE, 'producer': copy.deepcopy(PRODUCER),
                'inventory': {'fixture': 'not-production-evidence'}, 'authority': False,
                'productionEligible': False, 'rawOutputSuppressed': True,
                'stableServicesSha256': '1' * 64, 'boundFilesSha256': '2' * 64}

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


if __name__ == '__main__':
    unittest.main()
