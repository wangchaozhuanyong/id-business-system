"""No-network boundary tests for the independently acquired predecessor Q."""
import base64
import copy
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import tarfile
import unittest
from unittest.mock import patch
import zlib

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('readonly', HERE / 'unpublished-component-successor-readonly.py')
r = importlib.util.module_from_spec(spec)
exec(compile(spec.loader.get_data(str(HERE / 'unpublished-component-successor-readonly.py')),
             str(HERE / 'unpublished-component-successor-readonly.py'), 'exec'), r.__dict__)
c = r.load('unpublished-component-successor.py')


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.receipt = {'adminImageId': 'sha256:' + 'a' * 64, 'apiImageId': 'sha256:' + 'b' * 64,
            'baselineApiCommit': '1' * 40, 'businessActions': 0,
            'current': '/opt/id-business-v2/releases/20261012T182211Z-' + '2' * 12,
            'migrationPerformed': False, 'patchSourceCommit': '2' * 40, 'preservedServices': 6,
            'publicReady': True, 'scope': 'API_RECOVERY_SINGLE_SOURCE_HOTFIX', 'status': 'API_HOTFIX_READBACK_VERIFIED'}
        raw = json.dumps(self.receipt, sort_keys=True, separators=(',', ':')).encode()
        self.decoded_sha = r.digest(raw)
        self.output = json.dumps({'encoding': 'zlib-base64', 'sha256': self.decoded_sha,
                                 'payload': base64.b64encode(zlib.compress(raw)).decode()}) + '\n'
        self.stdout_sha = r.digest(self.output.encode())
        self.command = '12345678-1234-1234-1234-123456789012'
        self.native = {'CommandId': self.command, 'InstanceId': r.INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'StandardErrorContent': '', 'StandardOutputContent': self.output}
        self.raw = json.dumps(self.native, indent=4).encode() + b'\n'
        self.contract = {'hotfixReadbackCommandId': self.command,
                         'hotfixReadbackInvocationBytesSha256': r.digest(self.raw),
                         'hotfixStdoutSha256': self.stdout_sha, 'hotfixDecodedSha256': self.decoded_sha}
        self.environment = {'AWS_REGION': r.REGION, 'PRODUCTION_INSTANCE_ID': r.INSTANCE,
            'RELEASE_OPERATION': 'verify_unpublished_components', 'EXPECTED_CURRENT': '2' * 40,
            'RELEASE_COMMIT': '3' * 40, 'SOURCE_TREE': '4' * 40, 'GITHUB_RUN_ID': '123',
            'GITHUB_RUN_ATTEMPT': '1', 'HISTORICAL_EXCEPTION': 'none', 'API_FAULT_RESTORE_APPROVED': 'false'}

    def test_actual_native_and_two_independent_content_seals_are_required(self):
        self.assertEqual(r.validate_hotfix_native(self.raw, self.contract), self.receipt)
        for name in self.contract:
            contract = copy.deepcopy(self.contract)
            contract[name] = '0' * 64 if name != 'hotfixReadbackCommandId' else '87654321-1234-1234-1234-123456789012'
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                r.validate_hotfix_native(self.raw, contract)

    def test_original_aws_bytes_are_not_replaced_by_canonical_json(self):
        canonical = json.dumps(self.native, sort_keys=True, separators=(',', ':')).encode()
        with self.assertRaises(RuntimeError):
            r.validate_hotfix_native(canonical, self.contract)

    def test_failed_wrong_host_or_document_never_qualifies_even_with_matching_byte_hash(self):
        for key, value in (('Status', 'Failed'), ('ResponseCode', False), ('InstanceId', 'i-00000000000000000'),
                           ('DocumentName', 'Other'), ('PluginName', 'Other'), ('StandardErrorContent', 'suppressed')):
            native = dict(self.native, **{key: value}); raw = json.dumps(native).encode()
            contract = dict(self.contract, hotfixReadbackInvocationBytesSha256=r.digest(raw))
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                r.validate_hotfix_native(raw, contract)

    def test_unknown_fields_and_duplicate_fields_are_rejected(self):
        raw = json.dumps(dict(self.receipt, unknown=True)).encode()
        output = json.dumps({'encoding': 'zlib-base64', 'sha256': r.digest(raw),
                             'payload': base64.b64encode(zlib.compress(raw)).decode()})
        with self.assertRaises(RuntimeError):
            r.decode_hotfix(output, r.digest(output.encode()), r.digest(raw))
        duplicate = self.output.rstrip()[:-1] + ',"encoding":"zlib-base64"}'
        with self.assertRaises(RuntimeError):
            r.decode_hotfix(duplicate, r.digest(duplicate.encode()), self.decoded_sha)

    def test_bounded_decoder_rejects_bomb_trailing_stream_and_incomplete_stream(self):
        for packed in (zlib.compress(b'x' * 20000), zlib.compress(b'{}') + b'junk', zlib.compress(b'{}')[:-1]):
            output = json.dumps({'encoding': 'zlib-base64', 'sha256': r.digest(b'{}'),
                                 'payload': base64.b64encode(packed).decode()})
            with self.subTest(length=len(packed)), self.assertRaises(RuntimeError):
                r.decode_hotfix(output, r.digest(output.encode()), r.digest(b'{}'))

    def test_scope_and_authorization_defaults_reject_business_dispatch(self):
        with patch.dict(os.environ, self.environment, clear=True):
            r.selected('preflight')
            with self.assertRaises(RuntimeError):
                r.selected('release')
        for key, value in (('RELEASE_OPERATION', 'release'), ('AWS_REGION', 'elsewhere'),
                           ('HISTORICAL_EXCEPTION', 'old-exception'), ('REUSE_IMAGE_RUN', '12'),
                           ('API_FAULT_RESTORE_APPROVED', 'yes')):
            with self.subTest(key=key), patch.dict(os.environ, dict(self.environment, **{key: value}), clear=True), \
                    self.assertRaises(RuntimeError):
                r.selected('preflight')

    def test_release_requires_explicit_boolean_true_and_only_its_operation(self):
        env = dict(self.environment, RELEASE_OPERATION='release_unpublished_components', API_FAULT_RESTORE_APPROVED='true')
        with patch.dict(os.environ, env, clear=True):
            r.selected('release')
        with patch.dict(os.environ, dict(env, RELEASE_OPERATION='verify_unpublished_components'), clear=True), \
                self.assertRaises(RuntimeError):
            r.selected('release')

    def test_receipt_storage_is_write_once_and_changed_receipt_is_rejected(self):
        root = HERE.parent.parent / '.runtime' / 'successor-control-tests'
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as folder:
            path = Path(folder).resolve() / 'receipt.json'
            r.write_once(c, path, {'status': 'PASS'})
            r.write_once(c, path, {'status': 'PASS'})
            with self.assertRaises(RuntimeError):
                r.write_once(c, path, {'status': 'OTHER'})

    def test_preflight_carrier_fetches_only_exact_commit_pinned_helpers_and_native_q(self):
        original = c.BASELINE_CONTRACT
        c.BASELINE_CONTRACT = self.contract
        try:
            def loader(filename):
                return c if filename == 'unpublished-component-successor.py' else real_load(filename)
            real_load = r.load
            with patch.dict(os.environ, self.environment, clear=True), patch.object(r, 'load', side_effect=loader), \
                    patch.object(r, 'command_raw', return_value=self.raw) as aws:
                params = r.parameters('preflight')
            self.assertLess(len(json.dumps(params).encode()), 20 * 1024)
            text = params['commands'][0]
            packed = text.split("base64.b64decode(", 1)[1].split(',validate=True)', 1)[0]
            # shlex.quote carrier is shell-quoted; decode its one payload literal.
            import shlex, ast
            carrier = shlex.split(text)[-1]
            packed = ast.literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
            program = gzip.decompress(base64.b64decode(packed, validate=True)).decode()
            self.assertIn('/opt/id-business-v2/.staging/oidc-' + '3' * 40, program)
            self.assertIn('write_workspace_private_bytes', program)
            self.assertNotIn('--api-fault-restore-approved', program)
            self.assertIn('component-hotfix-origin-' + r.digest(self.raw), program)
            aws.assert_called_once()
        finally:
            c.BASELINE_CONTRACT = original

    def temporary_project(self):
        root = HERE.parent.parent / '.runtime' / 'successor-control-tests'
        root.mkdir(parents=True, exist_ok=True)
        return tempfile.TemporaryDirectory(dir=root)

    def release_size_fixture(self):
        # Derive the genuine projection from the reviewed application, rather
        # than a repetitive dummy proof that would hide the 66 KiB boundary.
        root = HERE.parent.parent
        projection = c.projection_module()
        original = c.load('size_original_projection', 'api-admin-pending-projection.py')
        def archive(ref):
            raw = subprocess.check_output(['git', 'archive', ref], cwd=root)
            rows = {}
            with tarfile.open(fileobj=io.BytesIO(raw)) as source:
                for entry in source.getmembers():
                    if entry.isfile():
                        rows[entry.name] = (source.extractfile(entry).read(), '100755' if entry.mode & 0o111 else '100644')
            return rows
        candidate, selected_ref = None, None
        for ref in ('HEAD', c.APPLICATION_SOURCE):
            try:
                files = archive(ref)
            except subprocess.CalledProcessError:
                continue
            rows = {n: row for n, row in projection.inventory(files).items()
                    if n.startswith(('apps/api/', 'apps/admin/', 'packages/shared/'))
                    or n in ('package.json', 'package-lock.json', '.dockerignore', 'tsconfig.base.json', 'deploy/nginx/admin.conf')}
            if len(rows) == c.APPLICATION_INPUT_COUNT and c.fingerprint(rows) == c.APPROVED_APPLICATION_INPUT_SHA256:
                candidate, selected_ref = files, ref
                break
        self.assertIsNotNone(candidate, 'A source matching the reviewed application seal is required')
        commit = subprocess.check_output(['git', 'rev-parse', selected_ref], cwd=root, text=True).strip()
        tree = projection.source_tree(candidate)
        _output, record = projection.project_files(candidate, archive(original.BASELINE_COMMIT),
                                                   archive(original.ONLINE_COMMIT), commit, tree)
        producer = c.producer(commit, tree, '123', '1')
        baseline = copy.deepcopy(c.BASELINE_CONTRACT)
        baseline['currentCommit'] = self.environment['EXPECTED_CURRENT']
        baseline['configurationModels'] = {n: {'sha256': r.digest(('config-' + n).encode()), 'automaticHostname': True} for n in c.UPDATED}
        baseline['configurationFilesSha256'] = {n: r.digest(n.encode()) for n in
            ('docker-compose.aws-mysql.yml', 'apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts',
             'deploy/caddy/Caddyfile.aws', 'compose.release.json')}
        receipt = {'version': 1, 'scope': c.SCOPE, 'status': 'UNPUBLISHED_COMPONENT_BASELINE_VERIFIED',
            'mode': 'preflight', 'producer': producer, 'instanceId': r.INSTANCE, 'baseline': baseline,
            'projectionSha256': c.fingerprint(record), 'applicationInputSha256': c.APPROVED_APPLICATION_INPUT_SHA256,
            'onlinePublished': False, 'migrationPerformed': False, 'businessActions': 0}
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        invocation = dict(self.native, StandardOutputContent=json.dumps(receipt, sort_keys=True, separators=(',', ':')) + '\n',
                          ExecutionStartDateTime=now, ExecutionEndDateTime=now)
        transport = c.make_transport(json.dumps(invocation).encode(), self.command, r.INSTANCE)
        proof = {'version': 1, 'scope': c.BUILD_SCOPE, 'commit': commit, 'sourceTree': tree,
            'runId': '123', 'runAttempt': '1', 'qualityRunId': '456', 'projection': record,
            'preflightSha256': c.fingerprint(transport), 'baselineSha256': c.fingerprint(baseline),
            'migration': c.MIGRATION_IDENTITY, 'images': {n: {'imageId': 'sha256:' + r.digest(n.encode()),
                'reference': '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + commit + '-123-1-' + n,
                'fileCount': 4244, 'sha256': r.digest(('image-' + n).encode())} for n in c.IMAGE_SERVICES},
            'acceptance': {'status': 'PASS', 'checks': ['private-health', 'packaged-resources', 'private-sqlite',
                'encrypted-storage', 'restart-persistence', 'wrong-key-rejected'], 'businessActions': 0, 'temporaryVolumeRemoved': True}}
        env = dict(self.environment, RELEASE_OPERATION='release_unpublished_components', API_FAULT_RESTORE_APPROVED='true',
                   RELEASE_COMMIT=commit, SOURCE_TREE=tree, QUALITY_RUN_ID='456',
                   RELEASE_REPOSITORY='123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release')
        return proof, transport, env

    def test_real_66k_projection_release_carrier_keeps_exact_binary_inputs_under_original_cap(self):
        proof, transport, environment = self.release_size_fixture()
        previous, real_load = Path.cwd(), r.load
        try:
            with self.temporary_project() as folder:
                os.chdir(Path(folder).resolve())
                proof_raw = c.write_private(Path(c.PROOF).resolve(), proof)
                transport_raw = c.write_private(Path(c.PREFLIGHT).resolve(), transport)
                producer = c.producer(environment['RELEASE_COMMIT'], environment['SOURCE_TREE'], '123', '1')
                plan, chunks = r.input_bundle(producer, proof_raw, transport_raw)
                base = Path(folder).resolve() / 'input-fixture'
                writer = real_load('api-admin-readonly.py').write_workspace_private_bytes
                for index, chunk in enumerate(chunks):
                    chunk_params, _receipt = r.chunk_parameters(producer, plan, chunk, index)
                    self.assertLessEqual(len(chunk), 8192)
                    self.assertLess(len(json.dumps(chunk_params).encode()), 20 * 1024)
                    writer(r.input_directory(plan, base) / ('part-' + str(index).zfill(3) + '.bin'), chunk)
                with patch.dict(os.environ, environment, clear=True), patch.object(c, 'BASELINE_CONTRACT', self.contract), \
                     patch.object(r, 'load', side_effect=lambda n: c if n == 'unpublished-component-successor.py' else real_load(n)), \
                     patch.object(r, 'command_raw', return_value=self.raw):
                    params = r.parameters('release')
                self.assertGreater(len(proof_raw), 65 * 1024)
                self.assertLess(len(json.dumps(params).encode()), 20 * 1024)
                import shlex, ast
                carrier = shlex.split(params['commands'][0])[-1]
                packed = ast.literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
                program = gzip.decompress(base64.b64decode(packed, validate=True)).decode()
                assignment = next(node for node in ast.parse(program).body if isinstance(node, ast.Assign)
                    and any(isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == 'sys'
                            and n.attr == 'argv' for n in node.targets))
                decoded_proof, decoded_transport = r.read_input_bundle(plan, base)
                argv = eval(compile(ast.Expression(assignment.value), '<offline argv bytes only>', 'eval'),
                    {'base64': base64, '_proof_raw': decoded_proof, '_transport_raw': decoded_transport})
                self.assertEqual(base64.b64decode(argv[argv.index('--build-proof') + 1], validate=True), proof_raw)
                self.assertEqual(base64.b64decode(argv[argv.index('--preflight') + 1], validate=True), transport_raw)
        finally:
            os.chdir(previous)

    def test_input_bundle_rejects_exact_limits_tamper_alias_modes_and_trailing_stream(self):
        producer = c.producer('1' * 40, '2' * 40, '123', '1')
        for proof, preflight in ((b'x' * (128 * 1024), b'{}'), (b'{}', b'x' * 24576), (b'', b'{}')):
            with self.assertRaises(RuntimeError): r.input_bundle(producer, proof, preflight)
        plan, chunks = r.input_bundle(producer, b'{"opaque-proof":true}\n', b'{"opaque-receipt":true}\n')
        writer = r.load('api-admin-readonly.py').write_workspace_private_bytes
        with self.temporary_project() as folder:
            base = Path(folder).resolve() / 'inputs'
            paths = []
            for index, chunk in enumerate(chunks):
                path = r.input_directory(plan, base) / ('part-' + str(index).zfill(3) + '.bin')
                writer(path, chunk); paths.append(path)
            self.assertEqual(r.read_input_bundle(plan, base), (b'{"opaque-proof":true}\n', b'{"opaque-receipt":true}\n'))
            for field, value in (('proofLength', True), ('decodedLength', plan['decodedLength'] + 1),
                                 ('bundleSha256', '0' * 64), ('proofSha256', '0' * 64)):
                altered = dict(plan, **{field: value})
                with self.assertRaises((RuntimeError, OSError)): r.read_input_bundle(altered, base)
            altered = copy.deepcopy(plan); altered['chunks'][0]['index'] = True
            with self.assertRaises(RuntimeError): r.read_input_bundle(altered, base)
            path = paths[0]; raw = path.read_bytes()
            path.chmod(0o640)
            with self.assertRaises(RuntimeError): r.read_input_bundle(plan, base)
            path.chmod(0o600); path.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
            with self.assertRaises(RuntimeError): r.read_input_bundle(plan, base)
            path.write_bytes(raw); alias = path.with_name('alias'); os.link(path, alias)
            with self.assertRaises(RuntimeError): r.read_input_bundle(plan, base)
            alias.unlink(); path.unlink(); path.symlink_to('/dev/null')
            with self.assertRaises((RuntimeError, OSError)): r.read_input_bundle(plan, base)
            for bad in (b''.join(chunks) + b'trailing', b''.join(chunks)[:-1], gzip.compress(b'x' * (2 * 1024**2), mtime=0)):
                altered = copy.deepcopy(plan)
                altered.update(bundleSha256=r.digest(bad), compressedLength=len(bad),
                    chunks=[{'index': 0, 'size': len(bad), 'sha256': r.digest(bad)}])
                writer(r.input_directory(altered, base) / 'part-000.bin', bad)
                with self.assertRaises(RuntimeError): r.read_input_bundle(altered, base)

    def test_maximal_incompressible_chunks_still_fit_the_original_20k_parameter_cap(self):
        producer = c.producer('1' * 40, '2' * 40, '123', '1')
        plan, chunks = r.input_bundle(producer, os.urandom(128 * 1024 - 1), os.urandom(24575))
        self.assertLessEqual(len(chunks), 20)
        for index, chunk in enumerate(chunks):
            params, receipt = r.chunk_parameters(producer, plan, chunk, index)
            self.assertLessEqual(len(chunk), 8192)
            self.assertLess(len(json.dumps(params).encode()), 20 * 1024)
            self.assertEqual(receipt['businessActions'], 0)

    def test_unknown_chunk_send_response_cannot_send_again(self):
        producer = c.producer('1' * 40, '2' * 40, '123', '1')
        plan, chunks = r.input_bundle(producer, b'{}', b'{}')
        previous = Path.cwd()
        try:
            with self.temporary_project() as folder:
                os.chdir(Path(folder).resolve())
                with patch.object(r, 'command_raw', side_effect=RuntimeError('lost response')) as aws:
                    with self.assertRaises(RuntimeError): r.install_input_bundle(c, producer, plan, chunks)
                    with self.assertRaisesRegex(RuntimeError, 'INPUT_SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED'):
                        r.install_input_bundle(c, producer, plan, chunks)
                    aws.assert_called_once()
        finally:
            os.chdir(previous)

    def test_accepted_chunk_reads_original_command_and_requires_exact_native_receipt(self):
        producer = c.producer('1' * 40, '2' * 40, '123', '1')
        plan, chunks = r.input_bundle(producer, b'{}', b'{}')
        _params, expected = r.chunk_parameters(producer, plan, chunks[0], 0)
        previous = Path.cwd()
        try:
            with self.temporary_project() as folder:
                os.chdir(Path(folder).resolve())
                name = c.PREFIX + '-input-' + plan['bundleSha256'] + '-000'
                path = Path('.deploy/production-release').resolve() / (name + '-metadata.json')
                c.write_private(path, {'producer': producer, 'bundleSha256': plan['bundleSha256'], 'index': 0,
                    'sha256': r.digest(chunks[0]), 'instanceId': r.INSTANCE, 'commandId': self.command, 'status': 'ACCEPTED'})
                with patch.object(r, 'command_raw', return_value=b'{"Status":"Success"}') as aws, \
                     patch.object(c, 'validate_invocation', return_value=({'Status': 'Success'}, expected)):
                    r.install_input_bundle(c, producer, plan, chunks)
                aws.assert_called_once()
                self.assertIn('get-command-invocation', aws.call_args.args)
                self.assertNotIn('send-command', aws.call_args.args)
                for key, value in (('sha256', '0' * 64), ('businessActions', False), ('index', True)):
                    with patch.object(r, 'command_raw', return_value=b'{"Status":"Success"}'), \
                         patch.object(c, 'validate_invocation', return_value=({'Status': 'Success'}, dict(expected, **{key: value}))), \
                         self.assertRaisesRegex(RuntimeError, 'INPUT_RECEIPT_CHANGED'):
                        r.install_input_bundle(c, producer, plan, chunks)
        finally:
            os.chdir(previous)

    def test_fresh_release_checks_main_after_chunks_and_before_any_formal_intent(self):
        producer = c.producer('1' * 40, '2' * 40, '123', '1')
        previous = Path.cwd()
        try:
            for stale in (True, False):
                with self.temporary_project() as folder:
                    os.chdir(Path(folder).resolve())
                    calls = []
                    def command(*args, **kwargs):
                        calls.append(args)
                        if args[0] == 'git':
                            calls.append(('main-checked',))
                            return (('9' if stale else '1') * 40 + '\trefs/heads/main\n').encode()
                        return self.command.encode()
                    with patch.object(r, 'selected', return_value=(c, producer)), \
                         patch.object(c, 'private_bytes', return_value=b'{}'), \
                         patch.object(r, 'parameters', return_value={'commands': ['offline synthetic']}), \
                         patch.object(r, 'input_bundle', return_value=({}, [b'{}'])), \
                         patch.object(r, 'install_input_bundle', side_effect=lambda *_: calls.append(('chunks-installed',))), \
                         patch.object(r, 'command_raw', side_effect=command), \
                         patch.object(r.time, 'monotonic', side_effect=(0, 4000)):
                        with self.assertRaisesRegex(RuntimeError,
                            'STALE_MAIN_FORMAL_SEND_FORBIDDEN' if stale else 'ACCEPTED_COMMAND_RESULT_PENDING'):
                            r.transport('release')
                    self.assertLess(calls.index(('chunks-installed',)), calls.index(('main-checked',)))
                    intent = Path('.deploy/production-release') / (c.PREFIX + '-release-send-intent.json')
                    sends = [n for n in calls if 'send-command' in n]
                    self.assertEqual(len(sends), 0 if stale else 1)
                    self.assertEqual(intent.exists(), not stale)
        finally:
            os.chdir(previous)

    def test_unknown_accepted_send_result_cannot_be_sent_twice(self):
        p = c.producer('1' * 40, '2' * 40, '123', '1')
        previous = Path.cwd()
        try:
            with self.temporary_project() as folder:
                os.chdir(Path(folder).resolve())
                with patch.object(r, 'selected', return_value=(c, p)), \
                     patch.object(r, 'parameters', return_value={'commands': ['synthetic no action']}), \
                     patch.object(r, 'command_raw', side_effect=RuntimeError('lost accepted response')) as aws:
                    with self.assertRaises(RuntimeError):
                        r.transport('preflight')
                    with self.assertRaisesRegex(RuntimeError, 'SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED'):
                        r.transport('preflight')
                    aws.assert_called_once()
                intent = Path('.deploy/production-release') / (c.PREFIX + '-preflight-send-intent.json')
                self.assertEqual(c.closed_json(c.private_bytes(intent.resolve()))['producer'], p)
        finally:
            os.chdir(previous)

    def test_already_accepted_identity_only_queries_original_command(self):
        p = c.producer('1' * 40, '2' * 40, '123', '1')
        previous = Path.cwd()
        try:
            with self.temporary_project() as folder:
                os.chdir(Path(folder).resolve())
                path = Path('.deploy/production-release').resolve() / (c.PREFIX + '-readback-invocation-metadata.json')
                c.write_private(path, {'commandId': self.command, 'instanceId': r.INSTANCE,
                    'mode': 'readback', 'status': 'ACCEPTED', 'producer': p})
                receipt = {'scope': c.SCOPE, 'status': 'UNPUBLISHED_COMPONENT_VERIFIED', 'commit': p['commit'],
                           'sourceTree': p['sourceTree'], 'onlinePublished': False, 'businessActions': 0}
                invocation = dict(self.native, StandardOutputContent=json.dumps(receipt))
                raw = json.dumps(invocation).encode()
                with patch.object(r, 'selected', return_value=(c, p)), patch.object(r, 'parameters', return_value={}), \
                     patch.object(r, 'command_raw', return_value=raw) as aws, patch.object(r.time, 'sleep'), \
                     patch.object(c, 'validate_invocation', return_value=(invocation, receipt)), \
                     patch.object(r, 'load', side_effect=lambda n: c if n == 'unpublished-component-successor.py' else None):
                    result = r.transport('readback')
                self.assertEqual(result['commandId'], self.command)
                aws.assert_called_once()
                self.assertIn('get-command-invocation', aws.call_args.args)
                self.assertNotIn('send-command', aws.call_args.args)
        finally:
            os.chdir(previous)

    def test_new_native_container_ids_need_separate_source_sealed_restoration_authority(self):
        states = {n: {'image': 'sha256:' + 'a' * 64, 'reference': 'fixture', 'environmentSha256': 'b' * 64,
                     'configurationSha256': 'c' * 64, 'containerId': 'd' * 64, 'status': 'running', 'health': 'healthy'}
                  for n in c.SERVICES}
        contract = {'services': copy.deepcopy(states)}
        states['api']['containerId'] = 'e' * 64
        with self.assertRaisesRegex(RuntimeError, 'RESTORATION_NATIVE_SEAL_REQUIRED'):
            r.restoration_binding(c, None, contract, states)
        authority = {'producer': c.producer('1' * 40, '2' * 40, '123', '1'), 'bindingSha256': 'a' * 64,
                     'commandId': self.command, 'invocationBytesSha256': 'b' * 64}
        contract['restorationNative'] = authority
        binding = {'authenticated': True, 'servicesSha256': c.fingerprint(states), 'migration': {'status': 'APPLIED'}}
        with patch.object(c, 'authenticate_restoration', return_value=binding) as native:
            self.assertEqual(r.restoration_binding(c, None, contract, states), binding)
            native.assert_called_once_with(None, authority['producer'], binding_sha256='a' * 64,
                                          command_id=self.command, invocation_sha256='b' * 64)
        for role, field in (('mysql', 'containerId'), ('api', 'environmentSha256')):
            drifted = copy.deepcopy(states); drifted[role][field] = 'f' * 64
            forged_binding = dict(binding, servicesSha256=c.fingerprint(drifted))
            with self.subTest(role=role), patch.object(c, 'authenticate_restoration', return_value=forged_binding), \
                    self.assertRaises(RuntimeError):
                r.restoration_binding(c, None, contract, drifted)


if __name__ == '__main__':
    unittest.main()
