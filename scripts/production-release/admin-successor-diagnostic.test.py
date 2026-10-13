import ast
import base64
import copy
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('admin_diagnostic', Path(__file__).with_name('admin-successor-diagnostic.py'))
d = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(d)


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        output = ROOT / '.runtime/admin-successor-diagnostic-tests'
        output.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.contract = copy.deepcopy(d.contract_from_source())
        self.states = copy.deepcopy(self.contract['services'])
        self.current = self.base / 'releases/H'
        self.admin = self.base / 'releases/D'
        self.origin = self.base / 'releases/B'
        for directory in (self.current, self.admin, self.origin):
            directory.mkdir(parents=True)
        (self.base / 'current').symlink_to(self.current)
        self.markers = {'apiWorkspacePublication': {'onlinePublished': False, 'migrationPerformed': False},
                        'pendingOnlineMigration': {'unchanged': True}, 'preservedMigrationOrigin': {'unchanged': True}}
        origin = {'commit': d.API_ORIGIN, 'sourceTree': self.contract['apiSourceTree'], **self.markers}
        origin_raw = self.write(self.origin / 'release-manifest.json', origin)
        projection = {'candidateCommit': d.CURRENT, 'candidateTree': d.CURRENT_TREE}
        projection['projectionSha256'] = d.fingerprint(projection)
        proof = {'commit': d.CURRENT, 'sourceTree': d.CURRENT_TREE, 'projection': projection}
        proof_raw = self.write(self.admin / 'admin-build-proof.json', proof)
        ledger = {'commit': d.CURRENT, 'projection': projection, 'buildProofSha256': d.fingerprint(proof),
                  'componentBaselines': {'api': d.API_ORIGIN}, 'inheritedManifestSha256': d.digest(origin_raw)}
        admin = {'commit': d.CURRENT, 'sourceTree': d.CURRENT_TREE, 'previousRelease': str(self.origin),
                 'previousManifestSha256': d.digest(origin_raw), 'adminPublication': ledger, **self.markers}
        admin_raw = self.write(self.admin / 'release-manifest.json', admin)
        hotfix = {'previousRelease': str(self.admin), 'previousManifestSha256': d.digest(admin_raw),
                  'baselineApiCommit': d.API_ORIGIN}
        manifest = {**admin, 'previousRelease': str(self.admin), 'previousManifestSha256': d.digest(admin_raw),
                    'apiHotfixPublication': hotfix}
        raw = self.write(self.current / 'release-manifest.json', manifest)
        self.contract.update(currentRelease=str(self.current), manifestSha256=d.digest(raw),
            adminPredecessorRelease=str(self.admin), adminPredecessorManifestSha256=d.digest(admin_raw),
            adminPublicationSha256=d.fingerprint(ledger), hotfixPublicationSha256=d.fingerprint(hotfix))
        history = self.contract['historicalB']
        history.update(release=str(self.origin), manifestSha256=d.digest(origin_raw),
                       nativeInvocationRelativePath='.staging/origin.json')
        for name, key in (('api-workspace-preservation.json', 'recordSha256'), ('api-workspace-build-proof.json', 'proofSha256')):
            history[key] = d.digest(self.write(self.origin / name, {'native': name}))
        native = {'CommandId': history['nativeReadbackCommandId'], 'InstanceId': d.INSTANCE,
                  'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                  'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '', 'StandardOutputContent': 'native origin'}
        history['nativeStdoutSha256'] = d.digest(native['StandardOutputContent'].encode())
        history['nativeInvocationSha256'] = d.digest(self.write(self.base / history['nativeInvocationRelativePath'], native))
        self.configuration = {}
        for name in d.CONFIGURATION_HASHES:
            self.configuration[name] = d.digest(self.write(self.current / name, {'synthetic': name}, private=False))
        env = self.write(self.current / '.env.aws.production', {'password': 'SENTINEL_PRIVATE_VALUE'})
        for name in d.RUNTIME_FILES:
            self.write(self.current / '.deploy/production-release/pending-original-source' / name, {'original': name})
        self.write(self.current / 'apps/api/prisma-mysql/migrations/20261001000000_base/migration.sql', {'synthetic': True}, private=False)
        self.images = {name: {'imageId': row['image'], 'reference': row['reference'], 'architecture': 'amd64',
            'labels': {key: None for key in d.LABELS}} for name, row in self.states.items()}
        self.images['api']['labels'].update({d.LABELS[0]: d.API_ORIGIN, d.LABELS[1]: self.contract['apiSourceTree']})
        self.images['admin']['labels'].update({d.LABELS[0]: d.CURRENT, d.LABELS[1]: d.CURRENT_TREE,
                                              d.LABELS[2]: projection['projectionSha256']})
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for key, value in {'BASE': self.base, 'ADMIN_PROOF_SHA256': d.digest(proof_raw),
            'ORIGIN_MARKERS_SHA256': d.fingerprint(self.markers), 'CONFIGURATION_HASHES': self.configuration,
            'ENVIRONMENT_SHA256': d.digest(env), 'CONTRACT_SHA256': d.fingerprint(self.contract)}.items():
            self.stack.enter_context(patch.object(d, key, value))
        self.stack.enter_context(patch.object(d, 'snapshot', side_effect=lambda _: copy.deepcopy(self.states)))
        self.stack.enter_context(patch.object(d, 'image_facts', side_effect=lambda _: copy.deepcopy(self.images)))

    def write(self, path, value, private=True):
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = (json.dumps(value, sort_keys=True) + '\n').encode()
        path.write_bytes(raw)
        path.chmod(0o600 if private else 0o644)
        return raw

    def receipt(self):
        result = d.collect(self.contract)
        self.assertIs(d.validate_receipt(result, self.contract), result)
        return result

    def test_native_chain_and_current_observation_are_separate_from_publication(self):
        result = self.receipt()
        self.assertTrue(result['nativeProofsVerified'])
        self.assertTrue(result['baselineVerified'])
        self.assertEqual(result['facts']['apiComponentBaseline'], d.API_ORIGIN)
        self.assertEqual(result['facts']['pendingOriginalSource']['fileCount'], 3)
        self.assertNotIn('SENTINEL_PRIVATE_VALUE', json.dumps(result))
        self.assertNotIn('apiRestore', json.dumps(result))

    def test_restarted_api_is_a_reported_difference_not_new_native_authority(self):
        self.states['api']['containerId'] = 'f' * 64
        self.states['api']['startedAtSha256'] = 'e' * 64
        result = self.receipt()
        self.assertTrue(result['nativeProofsVerified'])
        self.assertFalse(result['baselineVerified'])
        self.assertEqual(result['differences'], ['services.api.containerId', 'services.api.startedAtSha256'])
        self.assertNotEqual(self.contract['services']['api']['containerId'], self.states['api']['containerId'])

    def test_filter_cannot_hide_live_differences_or_add_private_fields(self):
        self.states['api']['containerId'] = 'f' * 64
        result = self.receipt()
        for mutation in ('hide', 'secret', 'origin', 'hash', 'image-label'):
            bad = copy.deepcopy(result)
            if mutation == 'hide':
                bad['differences'] = []; bad['baselineVerified'] = True
            elif mutation == 'secret':
                bad['facts']['services']['api']['environment'] = 'SENTINEL'
            elif mutation == 'origin':
                bad['facts']['apiComponentBaseline'] = d.CURRENT
            elif mutation == 'hash':
                bad['facts']['manifestBytesSha256'] = '0' * 64
            else:
                bad['facts']['images']['api']['labels']['secret'] = 'SENTINEL'
            with self.subTest(mutation=mutation), self.assertRaises(d.DiagnosticError):
                d.validate_receipt(bad, self.contract)

    def test_native_hash_mismatch_returns_closed_stable_failure(self):
        self.write(self.admin / 'admin-build-proof.json', {'secret': 'SENTINEL'})
        output = io.StringIO()
        with redirect_stdout(output):
            status = d.remote_main(self.contract)
        result = json.loads(output.getvalue())
        self.assertEqual(status, 1)
        self.assertEqual(result, {'version': 1, 'scope': d.SCOPE, 'status': 'FAILED',
                                  'code': 'ADMIN_DIAGNOSTIC_NATIVE_MANIFEST_CHANGED'})
        self.assertNotIn('SENTINEL', output.getvalue())

    def test_private_symlink_mode_bound_and_directory_links_are_rejected(self):
        path = self.base / 'private.json'; self.write(path, {'secret': 'SENTINEL'})
        alias = self.base / 'alias'; alias.symlink_to(path)
        with self.assertRaisesRegex(d.DiagnosticError, 'FILE_PATH_CHANGED'):
            d.read_bytes(alias, private=True)
        path.chmod(0o644)
        with self.assertRaisesRegex(d.DiagnosticError, 'FILE_IDENTITY_CHANGED'):
            d.read_bytes(path, private=True)
        path.chmod(0o600)
        with self.assertRaisesRegex(d.DiagnosticError, 'FILE_IDENTITY_CHANGED'):
            d.read_bytes(path, cap=8, private=True)
        folder = self.base / 'directory'; folder.mkdir(); (folder / 'link').symlink_to(path)
        with self.assertRaisesRegex(d.DiagnosticError, 'DIRECTORY_SYMLINK'):
            d.directory_hash(folder, 3)

    def test_mid_read_service_change_is_not_reported_as_stable(self):
        after = copy.deepcopy(self.states); after['api']['containerId'] = 'e' * 64
        with patch.object(d, 'snapshot', side_effect=[copy.deepcopy(self.states), after]):
            with self.assertRaisesRegex(d.DiagnosticError, 'LIVE_SNAPSHOT_CHANGED'):
                d.collect(self.contract)

    def test_mid_read_runtime_change_is_not_reported_as_stable(self):
        calls = 0
        def states(_):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.write(self.current / 'compose.release.json', {'changed': True}, private=False)
            return copy.deepcopy(self.states)
        with patch.object(d, 'snapshot', side_effect=states):
            with self.assertRaisesRegex(d.DiagnosticError, 'LIVE_FILES_CHANGED'):
                d.collect(self.contract)

    def test_unexpected_exception_never_leaks_raw_contents(self):
        output = io.StringIO()
        with patch.object(d, 'collect', side_effect=KeyError('SENTINEL_PRIVATE')), redirect_stdout(output):
            self.assertEqual(d.remote_main(self.contract), 1)
        self.assertEqual(json.loads(output.getvalue())['code'], 'ADMIN_DIAGNOSTIC_UNEXPECTED_STRUCTURE')
        self.assertNotIn('SENTINEL', output.getvalue())

    def test_duplicate_oversized_and_extra_fields_are_rejected_by_receiver(self):
        with self.assertRaisesRegex(d.DiagnosticError, 'JSON_DUPLICATE_FIELD'):
            d.json_value(b'{"scope":1,"scope":2}', 100)
        with self.assertRaisesRegex(d.DiagnosticError, 'JSON_SIZE_INVALID'):
            d.json_value(b' ' * d.OUTPUT_LIMIT, d.OUTPUT_LIMIT)
        bad = {'version': 1, 'scope': d.SCOPE, 'status': 'FAILED', 'code': 'ADMIN_DIAGNOSTIC_NATIVE_MANIFEST_CHANGED',
               'error': 'SENTINEL_PRIVATE'}
        with self.assertRaisesRegex(d.DiagnosticError, 'RECEIPT_INVALID'):
            d.validate_receipt(bad, self.contract)

    def test_transport_retains_command_identity_and_only_safe_failed_receipt(self):
        command_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        receipt = {'version': 1, 'scope': d.SCOPE, 'status': 'FAILED', 'code': 'ADMIN_DIAGNOSTIC_NATIVE_MANIFEST_CHANGED'}
        invocation = {'CommandId': command_id, 'InstanceId': d.INSTANCE, 'PluginName': 'aws:runShellScript',
            'DocumentName': 'AWS-RunShellScript', 'Status': 'Failed', 'ResponseCode': 1,
            'StandardOutputContent': json.dumps(receipt), 'StandardErrorContent': 'SENTINEL_PRIVATE_STDERR'}
        def fake_aws(operation, *args):
            self.assertIn(operation, ('send-command', 'get-command-invocation'))
            return json.dumps({'Command': {'CommandId': command_id}} if operation == 'send-command' else invocation).encode()
        old_cwd = Path.cwd()
        output = io.StringIO()
        try:
            os.chdir(self.base)
            with patch.object(d, 'contract_from_source', return_value=self.contract), \
                 patch.object(d, 'native_hotfix', return_value={'authenticated': True}), \
                 patch.object(d, 'aws', side_effect=fake_aws), \
                 patch.dict(os.environ, {'RELEASE_OPERATION': 'verify_access', 'EXPECTED_CURRENT': d.CURRENT,
                     'AWS_REGION': d.REGION, 'PRODUCTION_INSTANCE_ID': d.INSTANCE}), redirect_stdout(output):
                self.assertEqual(d.run(), 1)
        finally:
            os.chdir(old_cwd)
        folder = self.base / '.deploy/production-release'
        stored = json.loads((folder / (d.PREFIX + '-invocation.json')).read_text())
        result = json.loads((folder / (d.PREFIX + '-result.json')).read_text())
        self.assertEqual(stored['commandId'], command_id)
        self.assertEqual(result['receipt'], receipt)
        self.assertNotIn('SENTINEL', output.getvalue())
        self.assertNotIn('SENTINEL', ''.join(p.read_text() for p in folder.glob('*.json')))


class TransportTests(unittest.TestCase):
    def test_snapshot_hashes_private_configuration_and_canonicalizes_mount_order(self):
        contract = d.contract_from_source()
        metadata = {}
        for name, state in contract['services'].items():
            metadata[state['containerId']] = {'Id': state['containerId'], 'Image': state['image'],
                'Config': {'Image': state['reference'], 'Env': ['PASSWORD=SENTINEL', 'A=B']},
                'HostConfig': {'private': 'SENTINEL'}, 'Mounts': [{'Destination': '/z'}, {'Destination': '/a'}],
                'State': {'Status': 'running', 'StartedAt': '2026-10-13T00:00:00Z',
                          'Health': {'Status': 'healthy'} if name != 'caddy' else {}}}
        def command(args, cap=0):
            if args[-2:] == ['config', '--services']:
                return ('\n'.join((*d.SERVICES, 'migrate')) + '\n').encode()
            if args[-3:-1] == ['ps', '-q']:
                return contract['services'][args[-1]]['containerId'].encode()
            raise AssertionError(args)
        with patch.object(d, 'command', side_effect=command), \
             patch.object(d, 'inspect_one', side_effect=lambda _, identifier: copy.deepcopy(metadata[identifier])):
            first = d.snapshot(Path(contract['currentRelease']))
            for row in metadata.values(): row['Mounts'].reverse()
            second = d.snapshot(Path(contract['currentRelease']))
        self.assertEqual(first, second)
        self.assertNotIn('SENTINEL', json.dumps(first))
        self.assertEqual(first['api']['environmentSha256'], d.fingerprint(['A=B', 'PASSWORD=SENTINEL']))

    def test_actual_payload_calls_remote_reader_and_stays_within_ssm_cap(self):
        parameters = d.parameters(d.contract_from_source())
        self.assertLess(len(json.dumps(parameters).encode()), 20 * 1024)
        command = shlex.split(parameters['commands'][0])
        self.assertEqual(command[:3], ['python3', '-B', '-c'])
        decoder = ast.parse(command[3])
        payload = next(ast.literal_eval(n.args[0]) for n in ast.walk(decoder)
                       if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'b64decode')
        source = lzma.decompress(base64.b64decode(payload, validate=True)).decode()
        tree = ast.parse(source)
        self.assertIsInstance(tree.body[-1], ast.Raise)
        self.assertEqual(tree.body[-1].exc.args[0].func.id, 'remote_main')
        self.assertFalse(any(isinstance(n, ast.If) and isinstance(n.test, ast.Compare)
                             and isinstance(n.test.left, ast.Name) and n.test.left.id == '__name__'
                             for n in tree.body))

    def test_native_hotfix_binds_actual_aws_response_bytes_and_ended_status(self):
        contract = d.contract_from_source()
        decoded = b'{"native":"SENTINEL_PRIVATE"}'
        import zlib
        envelope = {'encoding': 'zlib-base64', 'sha256': d.digest(decoded),
                    'payload': base64.b64encode(zlib.compress(decoded)).decode()}
        stdout = json.dumps(envelope)
        native = {'CommandId': contract['hotfixReadbackCommandId'], 'InstanceId': d.INSTANCE,
            'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript', 'Status': 'Success',
            'ResponseCode': 0, 'StandardErrorContent': '', 'StandardOutputContent': stdout}
        raw = json.dumps(native).encode()
        contract.update(hotfixReadbackInvocationBytesSha256=d.digest(raw), hotfixStdoutSha256=d.digest(stdout.encode()),
                        hotfixDecodedSha256=d.digest(decoded))
        with patch.object(d, 'aws', return_value=raw):
            result = d.native_hotfix(contract)
        self.assertTrue(result['authenticated'])
        self.assertNotIn('SENTINEL', json.dumps(result))
        with patch.object(d, 'aws', return_value=raw + b' '), self.assertRaisesRegex(d.DiagnosticError, 'HOTFIX_NATIVE_CHANGED'):
            d.native_hotfix(contract)
        native['Status'] = 'Failed'; raw = json.dumps(native).encode(); contract['hotfixReadbackInvocationBytesSha256'] = d.digest(raw)
        with patch.object(d, 'aws', return_value=raw), self.assertRaisesRegex(d.DiagnosticError, 'HOTFIX_NATIVE_CHANGED'):
            d.native_hotfix(contract)

    def test_workflow_60_reader_is_exclusive_and_evidence_saved_on_failure(self):
        workflow = (ROOT / '.github/workflows/production-release.yml').read_text()
        finite = workflow.split('      - name: Read finite Admin successor baseline facts\n', 1)[1].split('\n      - name:', 1)[0]
        legacy = workflow.split('      - name: Read production release diagnostics\n', 1)[1].split('\n      - name:', 1)[0]
        self.assertIn("inputs.expected_current == '" + d.CURRENT + "'", finite)
        self.assertIn("inputs.expected_current != '" + d.CURRENT + "'", legacy)
        self.assertIn('run: python3 -B scripts/production-release/admin-successor-diagnostic.py', finite)
        save = workflow.split('      - name: Save finite Admin successor read-only evidence\n', 1)[1].split('\n      - name:', 1)[0]
        self.assertIn('if: always()', save)
        self.assertIn('admin-successor-diagnostic-*.json', save)

    def test_admin_readback_api_origin_is_31_for_60_and_legacy_only_fallback(self):
        workflow = (ROOT / '.github/workflows/production-release.yml').read_text()
        start = workflow.index("              expected_api_origin = proof['projection'].get('apiComponentBaseline')")
        end = workflow.index('              staged = ', start)
        import textwrap
        code = compile(textwrap.dedent(workflow[start:end]), '<api-origin-selection>', 'exec')
        for current, projection, accepted in ((d.CURRENT, {'apiComponentBaseline': d.API_ORIGIN}, True),
            (d.CURRENT, {}, False), (d.CURRENT, {'apiComponentBaseline': d.CURRENT}, False),
            (d.API_ORIGIN, {}, True)):
            with self.subTest(current=current, projection=projection), patch.dict(os.environ, {'EXPECTED_CURRENT': current}):
                namespace = {'proof': {'projection': projection}, 'os': os}
                if accepted:
                    exec(code, namespace)
                    self.assertEqual(namespace['expected_api_origin'], d.API_ORIGIN)
                else:
                    with self.assertRaises(RuntimeError): exec(code, namespace)
        self.assertIn("receipt['apiComponentBaseline'] != expected_api_origin", workflow)
        self.assertNotIn("receipt['apiComponentBaseline'] != os.environ['EXPECTED_CURRENT']", workflow)


if __name__ == '__main__':
    unittest.main()
