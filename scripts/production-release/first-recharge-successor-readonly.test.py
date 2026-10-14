"""Offline transport contracts; synthetic native bytes are never real evidence."""
import ast
import base64
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shlex
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent


def load(filename):
    path = HERE / filename
    spec = importlib.util.spec_from_file_location('first_readonly_test', path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


class FirstRechargeReadonlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = load('first-recharge-successor-readonly.py')

    def environment(self, **changes):
        return {'AWS_REGION': 'ap-northeast-1', 'PRODUCTION_INSTANCE_ID': self.r.reused.INSTANCE,
            'RELEASE_OPERATION': 'verify_first_recharge', 'EXPECTED_CURRENT': self.r.core.projection.ADMIN_COMMIT,
            'RELEASE_COMMIT': 'a' * 40, 'SOURCE_TREE': 'b' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'API_FAULT_RESTORE_APPROVED': 'false', **changes}

    def program(self, params):
        command = shlex.split(params['commands'][0])
        self.assertEqual(command[:3], ['python3', '-B', '-c'])
        tree = ast.parse(command[3])
        nodes = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute) and node.func.attr == 'b64decode']
        self.assertEqual(len(nodes), 1)
        result = gzip.decompress(base64.b64decode(nodes[0].args[0].value, validate=True)).decode()
        ast.parse(result)
        return result

    def test_preflight_false_permission_and_formal_true_permission_are_distinct(self):
        with patch.dict(os.environ, self.environment(), clear=True):
            self.assertIs(self.r.selected('preflight')[0], self.r.core)
            with self.assertRaisesRegex(RuntimeError, 'API_FAULT_RESTORE_APPROVAL_REQUIRED'):
                self.r.selected('release')
        with patch.dict(os.environ, self.environment(RELEASE_OPERATION='release_first_recharge', API_FAULT_RESTORE_APPROVED='true'), clear=True):
            self.assertIs(self.r.selected('release')[0], self.r.core)

    def test_invalid_target_reuse_and_extra_operation_are_rejected(self):
        for changes in ({'EXPECTED_CURRENT': self.r.core.projection.API_COMMIT}, {'AWS_REGION': 'us-east-1'},
            {'PRODUCTION_INSTANCE_ID': 'i-other'}, {'RELEASE_OPERATION': 'release_online_recharge'},
            {'REUSE_IMAGE_RUN_ID': '123'}, {'HISTORICAL_EXCEPTION': 'old'}, {'CACHE_PLAN_SHA256': '0' * 64},
            {'RELEASE_BROWSER_CACHE_IMAGE': 'image'}, {'API_FAULT_RESTORE_APPROVED': 'yes'}):
            with self.subTest(changes=changes), patch.dict(os.environ, self.environment(**changes), clear=True), self.assertRaises(RuntimeError):
                self.r.selected('preflight')

    def test_formal_permission_failure_happens_before_any_aws_read(self):
        with patch.dict(os.environ, self.environment(RELEASE_OPERATION='release_first_recharge'), clear=True), \
                patch.object(self.r.reused, 'command_raw') as command, self.assertRaisesRegex(RuntimeError, 'API_FAULT_RESTORE_APPROVAL_REQUIRED'):
            self.r.parameters('release')
        command.assert_not_called()

    def test_original_getters_are_read_by_exact_sealed_command_ids_only(self):
        with patch.object(self.r.reused, 'command_raw', side_effect=[b'synthetic-api', b'synthetic-admin']) as command, \
                patch.object(self.r, 'validate_native_origin', side_effect=lambda raw, role: raw) as validate:
            value = self.r.native_origins()
        self.assertEqual(value, {'api': b'synthetic-api', 'admin': b'synthetic-admin'})
        self.assertEqual(command.call_count, 2)
        for role, call in zip(('api', 'admin'), command.call_args_list):
            authority = self.r.core.history.sealed_authority() if role == 'api' else self.r.core.history.admin_successor_authority()
            self.assertEqual(call.args, ('aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation',
                '--command-id', authority['commandId'], '--instance-id', self.r.reused.INSTANCE, '--output', 'json'))
        self.assertEqual([call.args[1] for call in validate.call_args_list], ['api', 'admin'])

    def test_local_metadata_synthetic_and_oversized_receipts_cannot_be_native_evidence(self):
        for role in ('api', 'admin'):
            for raw in (b'{}', json.dumps({'invocationBytesSha256': 'c63c1df7e2c5900ee3f4336be1f6ebcdf7beb43a7b117bf2a6bf776d9a49cb68'}).encode(),
                        b'0' * (128 * 1024)):
                with self.subTest(role=role, size=len(raw)), self.assertRaisesRegex(RuntimeError, 'NATIVE_ORIGIN_BYTES_CHANGED'):
                    self.r.validate_native_origin(raw, role)

    def test_sealed_digest_is_not_enough_if_envelope_or_receipt_is_invalid(self):
        # Explicitly substitute an authority for this synthetic I/O contract;
        # production authorities and the independent source contract stay fixed.
        authority = self.r.core.history.sealed_authority(); raw = b'synthetic-envelope'
        authority['invocationBytesSha256'] = self.r.core.digest(raw)
        with patch.object(self.r.core.history, 'sealed_authority', return_value=authority), \
                patch.object(self.r.core, 'validate_invocation', side_effect=RuntimeError('bad-envelope')), self.assertRaisesRegex(RuntimeError, 'bad-envelope'):
            self.r.validate_native_origin(raw, 'api')
        with patch.object(self.r.core.history, 'sealed_authority', return_value=authority), \
                patch.object(self.r.core, 'validate_invocation', return_value=({}, {'status': 'UNPUBLISHED_COMPONENT_VERIFIED',
                    'commit': authority['producer']['commit'], 'onlinePublished': False})), self.assertRaisesRegex(RuntimeError, 'NATIVE_ORIGIN_RECEIPT_CHANGED'):
            self.r.validate_native_origin(raw, 'api')

    def test_preflight_installs_future_pins_and_two_origins_without_payment_or_legacy_hotfix(self):
        with patch.dict(os.environ, self.environment(), clear=True), \
                patch.object(self.r, 'native_origins', return_value={'api': b'synthetic-api', 'admin': b'synthetic-admin'}):
            params = self.r.parameters('preflight')
        program = self.program(params)
        self.assertLess(len(json.dumps(params).encode()), 20 * 1024)
        self.assertEqual(params['executionTimeout'], ['600'])
        self.assertIn('/first-recharge-successor.py', program)
        self.assertIn('first-recharge-api-origin-', program)
        self.assertIn('first-recharge-admin-origin-', program)
        self.assertNotIn('component-hotfix-origin-', program)
        self.assertNotIn('same-container-restart-origin-', program)
        self.assertNotIn('--api-fault-restore-approved', program)
        self.assertNotIn('sync_new_table_grants', program)
        self.assertNotIn('payment', program)
        self.assertIn(self.r.core.digest((HERE / 'first-recharge-successor-contract.json').read_bytes()), program)

    def test_readback_requires_release_operation_and_no_proof_arguments(self):
        with patch.dict(os.environ, self.environment(), clear=True), self.assertRaisesRegex(RuntimeError, 'SELECTION_INVALID'):
            self.r.selected('readback')
        with patch.dict(os.environ, self.environment(RELEASE_OPERATION='release_first_recharge'), clear=True), \
                patch.object(self.r, 'native_origins', return_value={'api': b'synthetic-api', 'admin': b'synthetic-admin'}):
            program = self.program(self.r.parameters('readback'))
            self.assertNotIn('--source-tree', program)
            self.assertNotIn('--expected-current', program)
            self.assertNotIn('--api-fault-restore-approved', program)

    def test_release_carries_bounded_proof_and_keeps_same_source_and_run(self):
        c = self.r.core
        record = {'version': 1, 'scope': c.projection.SCOPE, 'candidateCommit': 'a' * 40,
            'candidateTree': 'b' * 40, 'businessCommit': c.projection.BUSINESS_COMMIT,
            'businessTree': c.projection.BUSINESS_TREE, 'contractSha256': c.projection.APPROVED_CONTRACT_SHA256,
            'contextPath': c.CONTEXT, **c.projection.contract()['outputSeals']}
        record['projectionSha256'] = c.fingerprint(record)
        repository = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
        transport = {'serverReceipt': {'baseline': {'synthetic': True}}}
        proof = {'version': 1, 'scope': c.BUILD_SCOPE, 'commit': 'a' * 40, 'sourceTree': 'b' * 40,
            'runId': '123', 'runAttempt': '1', 'qualityRunId': '456', 'preflightSha256': c.fingerprint(transport),
            'baselineSha256': c.fingerprint(transport['serverReceipt']['baseline']), 'projection': record,
            'migration': c.MIGRATION_IDENTITY, 'images': {role: {
                'reference': repository + ':' + 'a' * 40 + '-123-1-' + role,
                'imageId': 'sha256:' + 'd' * 64, 'fileCount': 10, 'sha256': 'e' * 64}
                for role in ('api', 'admin', 'migrate')},
            'acceptance': {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
                'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'], 'businessActions': 0, 'temporaryVolumeRemoved': True}}
        inputs = tuple(json.dumps(value, sort_keys=True).encode() for value in (proof, transport))
        env = self.environment(RELEASE_OPERATION='release_first_recharge', API_FAULT_RESTORE_APPROVED='true',
            QUALITY_RUN_ID='456', RELEASE_REPOSITORY=repository)
        with patch.dict(os.environ, env, clear=True), patch.object(c, 'local_preflight'), \
                patch.object(self.r, 'native_origins', return_value={'api': b'synthetic-api', 'admin': b'synthetic-admin'}):
            params = self.r.parameters('release', input_artifacts=inputs)
            program = self.program(params)
            self.assertIn('read_input_bundle(', program)
            self.assertIn('--api-fault-restore-approved', program)
            self.assertIn('base64.b64encode(_proof_raw)', program)
            self.assertEqual(params['executionTimeout'], ['3600'])
            for key, value in (('commit', 'f' * 40), ('runId', '124'), ('qualityRunId', '999')):
                altered = {**proof, key: value}
                with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_CHANGED'):
                    self.r.parameters('release', input_artifacts=(json.dumps(altered).encode(), inputs[1]))

    def test_accepted_send_and_input_custody_are_reused_in_isolated_namespace(self):
        original = self.r.reused.load('unpublished-component-successor-readonly.py')
        self.assertEqual(inspect_source(self.r.reused.transport), inspect_source(original.transport))
        self.assertEqual(inspect_source(self.r.reused.install_input_bundle), inspect_source(original.install_input_bundle))
        self.assertIs(self.r.reused.selected, self.r.selected)
        self.assertIs(self.r.reused.parameters, self.r.parameters)
        self.assertIsNot(original.selected, self.r.selected)
        producer = self.r.core.producer('a' * 40, 'b' * 40, '123', '1')
        plan, chunks = self.r.reused.input_bundle(producer, b'{"synthetic":"proof"}', b'{"synthetic":"transport"}')
        self.assertEqual(plan['producer'], producer)
        self.assertEqual(plan['scope'], 'UNPUBLISHED_COMPONENT_INPUT_BUNDLE')
        self.assertEqual(sum(len(chunk) for chunk in chunks), plan['compressedLength'])


def inspect_source(function):
    import inspect
    return inspect.getsource(function)


if __name__ == '__main__':
    unittest.main()
