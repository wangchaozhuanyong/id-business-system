"""Synthetic local subprocess checks; never AWS, Docker or production writes."""
import base64
import ast
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import shlex
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.runtime/online-recharge-release-20261009/build/artifact-transport-tests'
spec = importlib.util.spec_from_file_location('declaration_artifacts',
    Path(__file__).with_name('api-workspace-declaration-artifacts.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
PRODUCER = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
            'workflowRunId': '37999999999', 'workflowRunAttempt': '1'}
COMMAND_ID = '12345678-1234-1234-1234-123456789abc'


def receipt(status='API_ADMIN_WORKSPACE_BASELINE_VERIFIED'):
    return {'status': status, 'commit': '0' * 40,
        'pendingOnlineMigrationOrigin': {'version': 2, 'scope': 'PENDING_ONLINE_MIGRATION',
            'restoredConfigurationProof': {'version': 3, 'kind': 'API_FIXED_DECLARATION_EQUIVALENCE'}}}


def preflight():
    return {**receipt(), 'commandId': COMMAND_ID, 'mode': 'preflight',
        'releaseCandidateCommit': PRODUCER['commit'], 'workflowRunId': PRODUCER['workflowRunId'],
        'workflowRunAttempt': PRODUCER['workflowRunAttempt']}


def wire(value):
    raw = json.dumps(value).encode()
    return json.dumps({'kind': 'WORKSPACE_PENDING_DECLARATION_RECEIPT', 'version': 1,
        'encoding': 'gzip-base64', 'decodedLength': len(raw),
        'decodedSha256': hashlib.sha256(raw).hexdigest(),
        'payload': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}) + '\n'


def invocation():
    return {'CommandId': COMMAND_ID, 'Status': 'Success', 'ResponseCode': 0,
        'StandardErrorContent': '', 'StandardOutputContent': wire({**receipt('API_ADMIN_WORKSPACE_VERIFIED'),
                                                                 'commit': PRODUCER['commit']}),
        'InstanceId': 'i-0123456789abcdef0', 'DocumentName': 'AWS-RunShellScript',
        'ExecutionStartDateTime': '2026-10-10T01:02:03.000Z', 'StatusDetails': 'Success'}


def raw(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def carrier_literals(parameters):
    loader = shlex.split(parameters['commands'][-1])[-1]
    constants = {node.targets[0].id: ast.literal_eval(node.value)
                 for node in ast.parse(loader).body if isinstance(node, ast.Assign)}
    return loader, constants


def stored_program(parameters):
    unused, constants = carrier_literals(parameters)
    return gzip.decompress(base64.b64decode(constants['payload'])).decode()


class ArtifactTransport(unittest.TestCase):
    def setUp(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='sandbox-', dir=OUTPUT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)

    def reject(self, operation):
        with self.assertRaises(RuntimeError) as caught:
            operation()
        self.assertEqual(caught.exception.args, (s.ERROR,))
        self.assertIsNone(caught.exception.__cause__)

    def params(self, kind='preflight', data=None):
        return s._test_artifact_parameters(PRODUCER, kind,
            raw(preflight()) if data is None else data, sandbox=self.root)

    def execute(self, result, expected=0):
        process = subprocess.run(['sh', '-c', '\n'.join(result['commands'])],
            capture_output=True, text=True, timeout=10, cwd=ROOT)
        self.assertEqual(process.returncode, expected, process.stderr)
        self.assertEqual(process.stderr, '')
        if expected:
            self.assertEqual(process.stdout, '')
        return process.stdout

    def target(self, kind='preflight'):
        return self.root / s._directory(PRODUCER) / s.FILENAMES[kind]

    def test_actual_subprocess_preserves_f_raw_bytes_and_private_modes(self):
        data = raw(preflight())
        ack = self.execute(self.params(data=data))
        s.validate_artifact_ack(ack, PRODUCER, 'preflight', data)
        self.assertEqual(self.target().read_bytes(), data)
        self.assertEqual(stat.S_IMODE(self.target().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.target().parent.stat().st_mode), 0o700)
        self.assertEqual(self.target().stat().st_nlink, 1)
        self.assertLess(len(ack), 24000)
        self.assertNotIn('BASELINE_VERIFIED', ack)

    def test_actual_subprocess_preserves_original_q_invocation_and_wire(self):
        data = raw(invocation())
        ack = self.execute(self.params('readback-invocation', data))
        s.validate_artifact_ack(ack, PRODUCER, 'readback-invocation', data)
        self.assertEqual(self.target('readback-invocation').read_bytes(), data)
        self.assertEqual(json.loads(data)['StandardOutputContent'], invocation()['StandardOutputContent'])

    def test_existing_same_bytes_is_idempotent_without_inode_or_mtime_change(self):
        params = self.params()
        first = self.execute(params)
        before = self.target().stat()
        self.assertEqual(self.execute(params), first)
        after = self.target().stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))

    def test_existing_other_valid_bytes_never_overwritten(self):
        self.execute(self.params())
        old = self.target().read_bytes()
        new = {**preflight(), 'commandId': '87654321-1234-1234-1234-123456789abc'}
        self.execute(self.params(data=raw(new)), 1)
        self.assertEqual(self.target().read_bytes(), old)

    def test_production_parameters_have_fixed_root_uid_and_no_override(self):
        value = s.artifact_parameters(PRODUCER, 'preflight', raw(preflight()))
        script = stored_program(value)
        self.assertIn("ack=_store('/opt/id-business-v2/.staging',0,p,k,raw)", script)
        self.assertNotIn(str(self.root), script)
        with self.assertRaises(TypeError):
            s.artifact_parameters(PRODUCER, 'preflight', raw(preflight()), sandbox=self.root)
        self.assertLess(len(json.dumps(value).encode()), 20 * 1024)

    def test_private_sandbox_capability_cannot_escape_project_owner_root(self):
        self.reject(lambda: s._test_artifact_parameters(PRODUCER, 'preflight', raw(preflight()),
                                                       sandbox=ROOT))
        link = self.root.parent / (self.root.name + '-link')
        link.symlink_to(self.root, target_is_directory=True)
        self.addCleanup(link.unlink)
        self.reject(lambda: s._test_artifact_parameters(PRODUCER, 'preflight', raw(preflight()), sandbox=link))

    def test_producer_closed_exact_types_and_safe_identifier_budgets(self):
        changes = [{'run': '1'}, {'commit': '../etc'}, {'sourceTree': 'B' * 40},
                   {'workflowRunId': True}, {'workflowRunAttempt': '0'},
                   {'workflowRunId': '1' * 21}, {'workflowRunAttempt': '1;pwd'}]
        for change in changes:
            with self.subTest(change=change):
                self.reject(lambda: s.artifact_parameters({**PRODUCER, **change}, 'preflight', raw(preflight())))
        for key in PRODUCER:
            self.reject(lambda: s.artifact_parameters({k: v for k, v in PRODUCER.items() if k != key},
                                                      'preflight', raw(preflight())))

    def test_kind_and_raw_type_length_strict(self):
        for kind in ('../anything', 'preflight-result', True, None):
            self.reject(lambda: s.artifact_parameters(PRODUCER, kind, raw(preflight())))
        for data in (b'', b'x' * 65536, bytearray(raw(preflight())), raw(preflight()).decode()):
            self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', data))

    def test_preflight_basics_match_metadata_not_running_commit(self):
        data = preflight()
        self.assertNotEqual(data['commit'], PRODUCER['commit'])
        s.artifact_parameters(PRODUCER, 'preflight', raw(data))
        for change in ({'releaseCandidateCommit': 'c' * 40}, {'workflowRunId': '2'},
                       {'workflowRunAttempt': '2'}, {'mode': 'readback'},
                       {'status': 'API_ADMIN_WORKSPACE_VERIFICATION_FAILED'}, {'commandId': 'invalid'}):
            self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', raw({**data, **change})))

    def test_bad_declared_versions_never_fall_back(self):
        for location, version in (('origin', 1), ('origin', True), ('origin', '2'),
                                  ('proof', 2), ('proof', 3.0), ('proof', True)):
            data = preflight()
            origin = data['pendingOnlineMigrationOrigin']
            target = origin if location == 'origin' else origin['restoredConfigurationProof']
            target['version'] = version
            self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', raw(data)))
        data = preflight()
        del data['pendingOnlineMigrationOrigin']['restoredConfigurationProof']
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', raw(data)))

    def test_q_actual_invocation_success_int_uuid_and_empty_stderr_only(self):
        for change in ({'Status': 'Failed'}, {'ResponseCode': False}, {'ResponseCode': 0.0},
                       {'ResponseCode': 1}, {'CommandId': 'invalid'},
                       {'StandardErrorContent': 'synthetic-private-error'},
                       {'StandardOutputContent': 'synthetic-private-output'}):
            self.reject(lambda: s.artifact_parameters(PRODUCER, 'readback-invocation',
                                                     raw({**invocation(), **change})))
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'readback-invocation',
            raw({**invocation(), 'StandardOutputContent': json.dumps(receipt('API_ADMIN_WORKSPACE_VERIFIED'))})))

    def test_raw_duplicate_json_unknown_frame_and_bad_utf8_rejected(self):
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', b'\xff'))
        data = raw(preflight()).replace(b'"mode": "preflight"', b'"mode": "preflight", "mode": "preflight"')
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', data))
        q = invocation()
        value = json.loads(q['StandardOutputContent'])
        value['unknown'] = True
        q['StandardOutputContent'] = json.dumps(value)
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'readback-invocation', raw(q)))

    def test_q_gzip_integrity_truncation_suffix_concat_and_bomb_rejected(self):
        value = json.loads(invocation()['StandardOutputContent'])
        packed = base64.b64decode(value['payload'])
        for bad in (packed[:-1], packed + b'\0', packed + packed,
                    gzip.compress(b'x' * 65536, mtime=0)):
            bad_wire = {**value, 'payload': base64.b64encode(bad).decode()}
            self.reject(lambda: s.artifact_parameters(PRODUCER, 'readback-invocation',
                raw({**invocation(), 'StandardOutputContent': json.dumps(bad_wire)})))
        for change in ({'decodedLength': True}, {'decodedLength': value['decodedLength'] + 1},
                       {'decodedSha256': '0' * 64}, {'payload': value['payload'] + '\n'}):
            self.reject(lambda: s.artifact_parameters(PRODUCER, 'readback-invocation',
                raw({**invocation(), 'StandardOutputContent': json.dumps({**value, **change})})))

    def test_remote_envelope_tamper_is_silent_and_writes_nothing(self):
        original = self.params()
        script = stored_program(original)
        sha = hashlib.sha256(raw(preflight())).hexdigest()
        changed = {**original, 'commands': [*original['commands'][:-1],
                   'python3 -B -c ' + shlex.quote(s._program_carrier(script.replace(sha, '0' * 64)))]}
        self.execute(changed, 1)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_root_permission_directory_symlink_and_target_symlink_rejected(self):
        params = self.params()
        self.root.chmod(0o755)
        self.execute(params, 1)
        self.root.chmod(0o700)
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        self.target().parent.symlink_to(outside, target_is_directory=True)
        self.execute(params, 1)
        self.target().parent.unlink()
        self.target().parent.mkdir(mode=0o700)
        victim = outside / 'untouched'
        victim.write_bytes(b'synthetic untouched')
        self.target().symlink_to(victim)
        self.execute(params, 1)
        self.assertEqual(victim.read_bytes(), b'synthetic untouched')

    def test_root_uid_and_parent_directory_mode_reject_before_writing(self):
        if os.getuid() != 0:
            self.execute(s._parameters(PRODUCER, 'preflight', raw(preflight()), str(self.root), 0), 1)
            self.assertEqual(list(self.root.iterdir()), [])
        params = self.params()
        self.target().parent.mkdir(mode=0o755)
        self.execute(params, 1)
        self.assertFalse(self.target().exists())

    def test_existing_hardlink_wrong_mode_directory_and_fifo_rejected(self):
        params = self.params()
        self.execute(params)
        link = self.root / 'hardlink'
        os.link(self.target(), link)
        self.execute(params, 1)
        link.unlink()
        self.target().chmod(0o644)
        self.execute(params, 1)
        self.target().unlink()
        self.target().mkdir()
        self.execute(params, 1)
        self.target().rmdir()
        os.mkfifo(self.target(), 0o600)
        self.execute(params, 1)

    def test_concurrent_exclusive_writes_never_ack_different_bytes(self):
        params = self.params()
        def execute():
            return subprocess.run(['sh', '-c', '\n'.join(params['commands'])],
                capture_output=True, text=True, cwd=ROOT, timeout=10)
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = list(pool.map(lambda unused: execute(), range(4)))
        self.assertTrue(any(p.returncode == 0 for p in values))
        self.assertEqual(self.target().read_bytes(), raw(preflight()))
        for p in values:
            self.assertEqual(p.stderr, '')
            if p.returncode == 0:
                s.validate_artifact_ack(p.stdout, PRODUCER, 'preflight', raw(preflight()))
            else:
                self.assertEqual(p.stdout, '')

    def test_ack_closed_exact_length_hash_producer_kind_and_no_authority(self):
        data = raw(preflight())
        ack = json.loads(self.execute(self.params()))
        for change in ({'status': 'API_ADMIN_WORKSPACE_BASELINE_VERIFIED'}, {'length': True},
                       {'length': len(data) + 1}, {'bytesSha256': '0' * 64},
                       {'producer': {**PRODUCER, 'workflowRunAttempt': '2'}},
                       {'kind': 'readback-invocation'}, {'authority': True}):
            self.reject(lambda: s.validate_artifact_ack({**ack, **change}, PRODUCER, 'preflight', data))
        duplicate = json.dumps(ack)[:-1] + ', "length": ' + str(len(data)) + '}'
        self.reject(lambda: s.validate_artifact_ack(duplicate, PRODUCER, 'preflight', data))

    def test_compressible_near_limit_and_noncompressible_parameter_budget(self):
        value = preflight()
        value['syntheticPublicIds'] = ['a' * 64] * 800
        data = raw(value)
        self.assertLess(len(data), 65536)
        params = s.artifact_parameters(PRODUCER, 'preflight', data)
        self.assertLess(len(json.dumps(params).encode()), 20480)
        self.execute(self.params(data=data))
        self.assertEqual(self.target().read_bytes(), data)
        rng = random.Random(20261010)
        value['syntheticPublicIds'] = [format(rng.getrandbits(256), '064x') for unused in range(800)]
        data = raw(value)
        self.assertLess(len(data), 65536)
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', data))

    def test_exact_exclusive_raw_byte_limit_and_large_original_q_frame(self):
        data = raw(preflight())
        data += b' ' * (65535 - len(data))
        self.execute(self.params(data=data))
        self.assertEqual(self.target().read_bytes(), data)
        self.reject(lambda: s.artifact_parameters(PRODUCER, 'preflight', data + b' '))
        rng = random.Random(91)
        value = {**receipt('API_ADMIN_WORKSPACE_VERIFIED'), 'commit': PRODUCER['commit'],
                 'syntheticPublicIds': [format(rng.getrandbits(256), '064x') for unused in range(395)]}
        output = wire(value)
        self.assertGreater(len(json.loads(output)['payload']), 20480)
        self.assertLess(len(output), 24000)
        # A valid inner wire may exceed the outer transport budget. It is not
        # rejected by a mistakenly shared base64 bound; only total params count.
        s._payload(PRODUCER, 'readback-invocation', raw({**invocation(), 'StandardOutputContent': output}))

    def test_program_carrier_rejects_hash_length_and_boolean_before_execution(self):
        params = self.params()
        loader, constants = carrier_literals(params)
        variants = [loader.replace(constants['digest'], '0' * 64),
                    loader.replace('length=' + str(constants['length']), 'length=' + str(constants['length'] + 1)),
                    loader.replace('length=' + str(constants['length']), 'length=True')]
        for broken in variants:
            changed = {**params, 'commands': [*params['commands'][:-1], 'python3 -B -c ' + shlex.quote(broken)]}
            self.execute(changed, 1)
            self.assertEqual(list(self.root.iterdir()), [])

    def test_program_carrier_rejects_base64_damage_truncation_concat_suffix_and_bomb(self):
        params = self.params()
        loader, constants = carrier_literals(params)
        packed = base64.b64decode(constants['payload'])
        damaged = bytearray(packed); damaged[-5] ^= 1
        bad_payloads = [constants['payload'] + '\n', constants['payload'] + '!',
            base64.b64encode(packed[:-1]).decode(), base64.b64encode(packed + b'\0').decode(),
            base64.b64encode(packed + packed).decode(), base64.b64encode(bytes(damaged)).decode(),
            base64.b64encode(gzip.compress(b'x' * s.PROGRAM_LIMIT, mtime=0)).decode()]
        for encoded in bad_payloads:
            broken = loader.replace('payload=' + repr(constants['payload']), 'payload=' + repr(encoded))
            changed = {**params, 'commands': [*params['commands'][:-1], 'python3 -B -c ' + shlex.quote(broken)]}
            self.execute(changed, 1)
            self.assertEqual(list(self.root.iterdir()), [])

    def test_program_carrier_upper_bound_is_separate_from_raw_artifact_limit(self):
        self.reject(lambda: s._program_carrier('x' * s.PROGRAM_LIMIT))
        params = self.params()
        loader, constants = carrier_literals(params)
        broken = loader.replace('length=' + str(constants['length']), 'length=' + str(s.PROGRAM_LIMIT))
        self.execute({**params, 'commands': [*params['commands'][:-1],
            'python3 -B -c ' + shlex.quote(broken)]}, 1)
        self.assertEqual(s.LIMIT, 65536)
        self.assertEqual(s.PARAMETER_LIMIT, 20480)

    def test_program_carrier_integrity_still_rejects_python_optimization(self):
        params = self.params()
        loader, constants = carrier_literals(params)
        broken = loader.replace(constants['digest'], '0' * 64)
        process = subprocess.run(['python3', '-I', '-O', '-B', '-c', broken], cwd=ROOT,
            capture_output=True, text=True, timeout=10)
        self.assertEqual((process.returncode, process.stdout, process.stderr), (1, '', ''))
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
