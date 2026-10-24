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
import shlex
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('readonly', HERE / 'unpublished-component-successor-readonly.py')
r = importlib.util.module_from_spec(spec)
exec(compile(spec.loader.get_data(str(HERE / 'unpublished-component-successor-readonly.py')),
             str(HERE / 'unpublished-component-successor-readonly.py'), 'exec'), r.__dict__)
c = r.load('unpublished-component-successor.py')

# Original credential-free AWS Get/List bytes, sealed by the fixed native authority.
ACTUAL_RESTART_GET_GZIP_BASE64 = (
    'H4sIAAAAAAAC/7WZW28b17mG7/MrDGFfhso6H3S1FUtpDSSKYSkt0K3CWEeLKEWqPLhxA//3PoukUlmhtKOLyIAlcmbWzHzf+72H'
    'mV++esXP0evF7W2a1zf16OTVkcmhxhLjROiaJsbENonVmYnXUonQm84lHH29O/DNfLVO89J2R04nwgbtatLBCdec1uV+x3GGNl+P'
    'vd6cvWo/p7J+tUq3bVIW83Waztvy1bKx1nL96uzi8lVtPW1m61f/mq7nbbW6X+VsUTZjmQuOHEud/vVy8m4zv7xps9llWU7v1o/3'
    '/EtbrqaL+dj5f87Ovzv96fur+13ezjYfpvP7pdK/VifLg0u9a6u7xXzVXi/q2FPsvz7/uZXNmrUvx1WfpXW7mu6WUkK5iRQTqa+E'
    'O9HixIrjIMLfjh4feT5Ld6tW7497e6WPRbj87W7z+vzy+ovluZ71ZjX2vNyU8qB6uw1njXrPntg+r2lZf9ys7zbr1zRm37Ffro/y'
    'ZjUdnTgt44pW10cn4uvrI5rXpx82yzS+/IH6zMYWdk/1djrf/7lZL27Zofx5sVrPqTZfr5ebxuGrm6Ss4/P1ka/auF668dkVaWRr'
    'ycXkc5dSSZeSE7nn4pQpOmvbwWC2yWXti/CiCBb5zILpbvqSk4Lzbmy3JVhThIku9miyzkZb36RXPstqQhM2eyebMKp3k4SqMjqn'
    'mrs/KeeaLFu5ScsP7SWnj7pZkY0wzJmUxoYQoo1ZqhSUCqVyFbbZ5JtSJeqctGFzaKpq57Xx9ovTf5iu1rs+vKgCPbVec09dhiRr'
    'ik11V32LMdlMEZrhP5elN0H6bmUyujgXbQuuNNv2FSip1k8v6nbqQhrnZK45qZh96D1Fm0xupZospBaxBu1rcXzILYZeAltlDcG7'
    'nnanvW11mrj11WL2sS1fcn7FXUUnUo2y+hiDsRH0haCEkLHJ5Iz0qRYVjdJcWnVVp+BkyUpblYzfn//T6p+zl5y2d++josgiqKRj'
    'cD5qG3Iz2mQvsrKhx5JdDKIa4TRY0/wKVL352iqLft6We7NcMpmDUqfr7cJONOlYw1YGp6aUjRFFeqlj7jEnayunLE5eH/338Hdt'
    '1tKqbY//ZnG3/mZaJ/dTPvmovlnutq++GXwjhVRXElhK+bfJw7NtV6zz1XfTNqtj+P/v+uhs8MPX298/3u3pYvfxsqVlubk++vs4'
    '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'
)
ACTUAL_RESTART_LIST_GZIP_BASE64 = (
    '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'
)

def actual_restart_bytes():
    return tuple(gzip.decompress(base64.b64decode(raw, validate=True)) for raw in
                 (ACTUAL_RESTART_GET_GZIP_BASE64, ACTUAL_RESTART_LIST_GZIP_BASE64))


class MigratedOriginArchiveTests(unittest.TestCase):
    def test_only_the_new_private_archive_is_read_and_original_bytes_are_returned(self):
        original = b'original sealed receipt bytes'
        sha = r.digest(original)
        with patch.object(r, 'command_raw', return_value=original) as query:
            self.assertEqual(r.archived_origin(sha), original)
            query.assert_called_once_with('aws', '--region', r.REGION, 's3', 'cp',
                's3://id-business-v2-backups-098208446664-ap-northeast-1/'
                'release-native-origins/20261024/' + sha + '.json', '-', '--only-show-errors')

    def test_invalid_archive_key_stops_before_any_cloud_request(self):
        for value in ('../receipt', 'a' * 63, 'A' * 64, None):
            with self.subTest(value=value), patch.object(r, 'command_raw') as query:
                with self.assertRaisesRegex(RuntimeError, 'ORIGIN_ARCHIVE_KEY_INVALID'):
                    r.archived_origin(value)
                query.assert_not_called()


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
        self.native = {'CommandId': self.command, 'InstanceId': r.ORIGIN_INSTANCE, 'DocumentName': 'AWS-RunShellScript',
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
                    patch.object(r, 'restart_origin_bytes', return_value=None), \
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
        invocation = dict(self.native, InstanceId=r.INSTANCE, StandardOutputContent=json.dumps(receipt, sort_keys=True, separators=(',', ':')) + '\n',
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
                     patch.object(r, 'command_raw', return_value=self.raw), \
                     patch.object(r, 'restart_origin_bytes', return_value=actual_restart_bytes()):
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


class NativeRestartTests(unittest.TestCase):
    """Actual authentication runs offline; only Docker/host reads are fixtures."""
    def setUp(self):
        root = HERE.parent.parent / '.runtime' / 'successor-control-tests'
        root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=root)
        self.base = Path(self.tmp.name).resolve()
        self.command = '11111111-2222-3333-4444-555555555555'
        self.authority = copy.deepcopy(r.NATIVE_RESTART_AUTHORITY)
        self.old, self.states, self.metadata, models = {}, {}, {}, {}
        self.current = self.base / 'releases' / 'H'; self.current.mkdir(parents=True, mode=0o700)
        self.manifest = {'commit': '1' * 40}
        self.manifest_raw = c.write_private(self.current / 'release-manifest.json', self.manifest)
        self.contract = {'currentRelease': str(self.current), 'manifestSha256': r.digest(self.manifest_raw)}
        for index, role in enumerate(c.SERVICES):
            identifier = r.digest(role.encode())
            body = {'Config': {'Hostname': identifier[:12], 'Env': ['OFFLINE_ENV=one', 'OTHER=two']},
                'HostConfig': {'Dns': None, 'DnsOptions': None, 'DnsSearch': None, 'Privileged': False},
                'Mounts': [{'Destination': '/data', 'Source': '/volume', 'RW': True}]}
            old = {'containerId': identifier, 'image': 'sha256:' + r.digest(('image-' + role).encode()),
                'reference': 'offline-' + role, 'environmentSha256': r.digest(b'offline env'),
                'status': 'running', 'health': None if role == 'caddy' else 'healthy',
                'startedAtSha256': r.digest(b'old start'), 'configurationSha256': c.fingerprint(body)}
            self.old[role] = old
            body = copy.deepcopy(body)
            for key in ('Dns', 'DnsOptions', 'DnsSearch'): body['HostConfig'][key] = []
            state = dict(old, startedAtSha256=r.digest(b'new start'), configurationSha256=c.fingerprint(body))
            self.states[role] = state
            self.metadata[identifier] = {'Id': identifier, 'Image': state['image'], **body}
        self.contract['services'] = copy.deepcopy(self.old)
        self.d = SimpleNamespace(BASE=self.base, run=lambda *args: json.dumps([self.metadata[args[2]]]))
        models = {role: c.configuration_model(self.d, state) for role, state in self.states.items()}
        self.pins = {}
        folder = self.base / '.staging' / ('oidc-' + self.authority['sourceCommit'])
        folder.mkdir(parents=True, mode=0o700)
        for name in c.HELPERS:
            raw = ('offline source: ' + name).encode()
            path = folder / name; path.write_bytes(raw); path.chmod(0o644)
            self.pins[name] = r.digest(raw)
        self.receipt = {'version': 1, 'scope': 'UNPUBLISHED_COMPONENT_SAME_CONTAINER_RESTART',
            'status': 'SAME_CONTAINER_RESTART_VERIFIED', 'instanceId': r.ORIGIN_INSTANCE,
            'sourceCommit': self.authority['sourceCommit'], 'sourceTree': self.authority['sourceTree'],
            'sourcePinsSha256': c.fingerprint(self.pins), 'services': copy.deepcopy(self.states),
            'configurationModels': models, 'legacyConfigurationSha256': {n: row['configurationSha256'] for n, row in self.old.items()},
            'currentRelease': str(self.current), 'currentCommit': self.manifest['commit'],
            'manifestSha256': self.contract['manifestSha256'], 'dnsFields': ['Dns', 'DnsOptions', 'DnsSearch'],
            'docker': {'version': '25.0.16', 'apiVersion': '1.44', 'minApiVersion': '1.24'},
            'hostBootIdSha256': r.digest(b'offline boot'), 'migrationState': {'status': 'PENDING'},
            'migrationPerformed': False, 'onlinePublished': False, 'businessActions': 0,
            'publicAdminBuildId': 'v2-' + self.manifest['commit'], 'publicReady': True}
        program = ('pins=' + repr(self.pins) + '\n').encode()
        carrier = 'import base64,gzip;exec(gzip.decompress(base64.b64decode(' + repr(base64.b64encode(gzip.compress(program, mtime=0)).decode()) + ')))'
        self.program = program
        self.parameters = {'commands': ['python3 -B -c ' + shlex.quote(carrier)], 'executionTimeout': ['600']}
        self.native = {'CommandId': self.command, 'InstanceId': r.ORIGIN_INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'ResponseCode': 0,
            'ExecutionStartDateTime': '2000-01-01T00:00:00Z', 'ExecutionEndDateTime': '2000-01-01T00:00:01Z',
            'StandardErrorContent': ''}
        self.command_list = {'Commands': [{'CommandId': self.command, 'DocumentName': 'AWS-RunShellScript',
            'Status': 'Success', 'StatusDetails': 'Success', 'InstanceIds': [r.ORIGIN_INSTANCE], 'Targets': [],
            'TargetCount': 1, 'CompletedCount': 1, 'ErrorCount': 0, 'DeliveryTimedOutCount': 0,
            'Parameters': self.parameters}]}
        self.seal()

    def tearDown(self):
        self.tmp.cleanup()

    def seal(self):
        self.native['StandardOutputContent'] = json.dumps(self.receipt, sort_keys=True, separators=(',', ':')) + '\n'
        self.raw_get = json.dumps(self.native, indent=2).encode() + b'\n'
        self.raw_list = json.dumps(self.command_list, indent=2).encode() + b'\n'
        self.authority.update(commandId=self.command, invocationBytesSha256=r.digest(self.raw_get),
            commandListBytesSha256=r.digest(self.raw_list), parametersSha256=c.fingerprint(self.parameters),
            programSha256=r.digest(self.program), stdoutSha256=r.digest(self.native['StandardOutputContent'].encode()),
            receiptSha256=c.fingerprint(self.receipt), sourcePinsSha256=c.fingerprint(self.pins),
            servicesSha256=c.fingerprint(self.receipt['services']),
            configurationModelsSha256=c.fingerprint(self.receipt['configurationModels']))
        paths = r.restart_origin_paths(self.d, self.authority)
        for path, raw in zip(paths, (self.raw_get, self.raw_list)):
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.write_bytes(raw); path.chmod(0o600)
        self.paths = paths

    def authenticate(self):
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', self.authority), \
             patch.object(r, 'restart_host_facts', return_value=(self.receipt['docker'], self.receipt['hostBootIdSha256'])):
            return r.authenticate_restart_native(c, self.d, self.current, self.manifest, self.contract, self.states)

    def test_real_fixed_native_get_list_parameters_and_executed_pins_validate_offline(self):
        receipt, pins = r.validate_restart_material(c, *actual_restart_bytes())
        self.assertEqual(receipt['status'], 'SAME_CONTAINER_RESTART_VERIFIED')
        self.assertEqual(set(receipt['services']), set(c.SERVICES))
        self.assertEqual(set(pins), set(c.HELPERS))
        self.assertEqual(len(receipt), 22)

    def test_complete_current_raw_configuration_and_independent_native_bind_all_seven_roles(self):
        binding = self.authenticate()
        self.assertEqual(binding['servicesSha256'], c.fingerprint(self.states))
        self.assertEqual(binding['scope'], 'UNPUBLISHED_COMPONENT_SAME_CONTAINER_RESTART')
        self.assertEqual(binding['migrationState']['status'], 'PENDING')
        self.assertNotIn('restorationLedgerBytesSha256', binding)

    def test_empty_dns_does_not_allow_other_configuration_or_identity_changes(self):
        original_states, original_metadata, original_receipt = copy.deepcopy((self.states, self.metadata, self.receipt))
        for variant in ('dns', 'env', 'mount', 'privileged', 'unknown', 'cid', 'image', 'reference', 'environment', 'started'):
            self.states, self.metadata, self.receipt = copy.deepcopy((original_states, original_metadata, original_receipt))
            state = self.states['api']; row = self.metadata[state['containerId']]
            if variant == 'dns': row['HostConfig']['Dns'] = ['192.0.2.1']
            elif variant == 'env': row['Config']['Env'].reverse()
            elif variant == 'mount': row['Mounts'][0]['RW'] = False
            elif variant == 'privileged': row['HostConfig']['Privileged'] = True
            elif variant == 'unknown': row['HostConfig']['Future'] = None
            elif variant == 'cid':
                identifier = r.digest(b'new cid'); row['Id'] = identifier
                self.metadata[identifier] = row; state['containerId'] = identifier
            elif variant == 'image': row['Image'] = state['image'] = 'sha256:' + '0' * 64
            elif variant == 'reference': state['reference'] = 'changed'
            elif variant == 'environment': state['environmentSha256'] = '0' * 64
            else: state['startedAtSha256'] = self.old['api']['startedAtSha256']
            state['configurationSha256'] = c.fingerprint({n: row[n] for n in ('Config', 'HostConfig', 'Mounts')})
            self.receipt['services'] = copy.deepcopy(self.states)
            self.receipt['configurationModels']['api'] = c.configuration_model(self.d, state)
            self.seal()
            with self.subTest(variant=variant), self.assertRaises(RuntimeError): self.authenticate()

    def test_raw_digest_and_started_at_must_still_match_current_witness(self):
        for key in ('configurationSha256', 'startedAtSha256'):
            before = self.states['api'][key]; self.states['api'][key] = '0' * 64
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'RESTART_CURRENT_STATE_CHANGED'):
                self.authenticate()
            self.states['api'][key] = before
        self.metadata[self.states['api']['containerId']]['HostConfig']['Extra'] = []
        with self.assertRaisesRegex(RuntimeError, 'CONFIGURATION_MODEL_CHANGED'): self.authenticate()

    def test_manifest_source_native_status_parameters_and_closed_receipt_are_not_relaxed(self):
        for target, key, value in ((self.receipt, 'manifestSha256', '0' * 64),
                (self.receipt, 'currentCommit', '0' * 40), (self.receipt, 'sourceCommit', '0' * 40),
                (self.receipt, 'migrationState', {'status': 'APPLIED'}),
                (self.receipt, 'migrationPerformed', True), (self.receipt, 'businessActions', False),
                (self.receipt, 'publicReady', False), (self.receipt, 'extra', True),
                (self.native, 'Status', 'Failed'), (self.native, 'ResponseCode', False),
                (self.native, 'StandardErrorContent', 'error'), (self.native, 'InstanceId', 'i-other'),
                (self.command_list['Commands'][0], 'TargetCount', True),
                (self.command_list['Commands'][0], 'InstanceIds', [r.ORIGIN_INSTANCE, 'i-other'])):
            had, before = key in target, copy.deepcopy(target.get(key))
            target[key] = value; self.seal()
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.authenticate()
            if had: target[key] = before
            else: del target[key]
            self.seal()
        for raw_index in (0, 1):
            raws = list((self.raw_get, self.raw_list)); raws[raw_index] += b' '
            with patch.object(r, 'NATIVE_RESTART_AUTHORITY', self.authority), self.assertRaises(RuntimeError):
                r.validate_restart_material(c, *raws)
        raw = self.raw_get.rstrip()[:-1] + b',"Status":"Success"}'
        authority = dict(self.authority, invocationBytesSha256=r.digest(raw))
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', authority), self.assertRaises(RuntimeError):
            r.validate_restart_material(c, raw, self.raw_list)
        changed = copy.deepcopy(self.command_list)
        changed['Commands'][0]['Parameters']['commands'][0] += ' changed'
        raw = json.dumps(changed).encode()
        authority = dict(self.authority, commandListBytesSha256=r.digest(raw))
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', authority), self.assertRaisesRegex(RuntimeError, 'RESTART_PARAMETERS_CHANGED'):
            r.validate_restart_material(c, self.raw_get, raw)

    def test_private_native_files_and_pinned_source_permissions_aliases_or_bytes_reject(self):
        for path in self.paths:
            path.chmod(0o640)
            with self.assertRaises(RuntimeError): self.authenticate()
            path.chmod(0o600)
            alias = path.with_name('native-alias'); os.link(path, alias)
            with self.assertRaises(RuntimeError): self.authenticate()
            alias.unlink()
        native_path = self.paths[1]; raw_list = native_path.read_bytes()
        native_path.unlink(); native_path.symlink_to(self.paths[0])
        with self.assertRaises(RuntimeError): self.authenticate()
        native_path.unlink(); native_path.write_bytes(raw_list); native_path.chmod(0o600)
        path = self.base / '.staging' / ('oidc-' + self.authority['sourceCommit']) / c.HELPERS[0]
        raw = path.read_bytes()
        path.chmod(0o666)
        with self.assertRaises(RuntimeError): self.authenticate()
        path.chmod(0o644); path.write_bytes(raw + b'changed')
        with self.assertRaises(RuntimeError): self.authenticate()
        path.write_bytes(raw); alias = path.with_name('source-alias'); os.link(path, alias)
        with self.assertRaises(RuntimeError): self.authenticate()
        alias.unlink(); path.unlink(); path.symlink_to(self.paths[0])
        with self.assertRaises(RuntimeError): self.authenticate()

    def test_missing_native_authority_host_change_and_restoration_mixing_fail_closed(self):
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', None), self.assertRaisesRegex(RuntimeError, 'RESTART_NATIVE_NOT_SEALED'):
            r.authenticate_restart_native(c, self.d, self.current, self.manifest, self.contract, self.states)

    def test_every_native_hash_and_source_seal_remains_independently_required(self):
        for key, before in self.authority.items():
            authority = copy.deepcopy(self.authority)
            if key.endswith('Sha256'): authority[key] = '0' * 64
            elif key in ('sourceCommit', 'sourceTree'): authority[key] = '0' * 40
            elif key == 'commandId': authority[key] = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            else: authority[key] = []
            with self.subTest(key=key), patch.object(r, 'NATIVE_RESTART_AUTHORITY', authority), self.assertRaises(RuntimeError):
                r.validate_restart_material(c, self.raw_get, self.raw_list)
        raw = self.raw_list.rstrip()[:-1] + b',"Commands":[]}'
        authority = dict(self.authority, commandListBytesSha256=r.digest(raw))
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', authority), self.assertRaises(RuntimeError):
            r.validate_restart_material(c, self.raw_get, raw)
        program = self.program + b'# unreviewed source\n'
        carrier = 'import base64,gzip;exec(gzip.decompress(base64.b64decode(' + repr(base64.b64encode(gzip.compress(program, mtime=0)).decode()) + ')))'
        changed = copy.deepcopy(self.command_list)
        changed['Commands'][0]['Parameters']['commands'][0] = 'python3 -B -c ' + shlex.quote(carrier)
        raw = json.dumps(changed).encode()
        authority = dict(self.authority, commandListBytesSha256=r.digest(raw),
                         parametersSha256=c.fingerprint(changed['Commands'][0]['Parameters']))
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', authority), self.assertRaisesRegex(RuntimeError, 'RESTART_PROGRAM_CHANGED'):
            r.validate_restart_material(c, self.raw_get, raw)
        self.contract['restorationNative'] = {}
        with self.assertRaisesRegex(RuntimeError, 'RESTART_RESTORATION_AUTHORITY_MIXED'): self.authenticate()
        del self.contract['restorationNative']
        with patch.object(r, 'NATIVE_RESTART_AUTHORITY', self.authority), \
             patch.object(r, 'restart_host_facts', return_value=(self.receipt['docker'], '0' * 64)), \
             self.assertRaisesRegex(RuntimeError, 'RESTART_HOST_CHANGED'):
            r.authenticate_restart_native(c, self.d, self.current, self.manifest, self.contract, self.states)

    def hotfix_dispatch_fixture(self):
        predecessor = self.base / 'releases' / 'D'; predecessor.mkdir(mode=0o700)
        admin = {'cold': True}
        previous_raw = c.write_private(predecessor / 'release-manifest.json', {'adminPublication': admin, 'previousRelease': 'offline-B'})
        ledger = {'scope': 'API_RECOVERY_SINGLE_SOURCE_HOTFIX', 'servicesUpdated': ['api'], 'newMigrations': [],
            'before': copy.deepcopy(self.old), 'after': copy.deepcopy(self.old), 'beforeAudit': {}, 'afterAudit': {},
            'migrationPerformed': False, 'databaseGrantsChanged': False, 'paymentPerformed': False,
            'subscriptionChanged': False, 'externalNotification': False, 'sqliteMaintenanceCleared': True,
            'patchSourceCommit': self.manifest['commit'], 'baselineApiCommit': '2' * 40,
            'imageId': self.old['api']['image'], 'previousRelease': str(predecessor),
            'previousManifestSha256': r.digest(previous_raw)}
        manifest = dict(self.manifest, adminPublication=admin, apiHotfixPublication=ledger,
            previousRelease=str(predecessor), previousManifestSha256=r.digest(previous_raw))
        path = self.current / 'release-manifest.json'; path.unlink()
        raw = c.write_private(path, manifest)
        contract = copy.deepcopy(c.BASELINE_CONTRACT)
        contract.update(self.contract, manifestSha256=r.digest(raw), adminPredecessorRelease=str(predecessor),
            adminPredecessorManifestSha256=r.digest(previous_raw), adminPublicationSha256=c.fingerprint(admin),
            hotfixPublicationSha256=c.fingerprint(ledger), hotfixKeys=sorted(ledger), roles=sorted(c.SERVICES),
            hotfixScope=ledger['scope'], apiSourceCommit='2' * 40, apiImage={'imageId': ledger['imageId']},
            historicalB={'release': 'offline-B'})
        receipt = {'scope': ledger['scope'], 'status': 'API_HOTFIX_READBACK_VERIFIED', 'current': str(self.current),
            'patchSourceCommit': manifest['commit'], 'baselineApiCommit': contract['apiSourceCommit'],
            'apiImageId': ledger['imageId'], 'adminImageId': self.old['admin']['image'], 'businessActions': 0,
            'preservedServices': 6, 'migrationPerformed': False, 'publicReady': True}
        return manifest, contract, receipt

    def test_dispatch_keeps_exact_old_and_independent_restoration_paths_reachable(self):
        manifest, contract, hotfix = self.hotfix_dispatch_fixture()
        historical = {'authenticated': True}
        for variant in ('old', 'restart', 'restoration'):
            selected = copy.deepcopy(self.old if variant == 'old' else self.states)
            current_contract = copy.deepcopy(contract)
            if variant == 'restoration':
                selected = copy.deepcopy(self.old); selected['api']['containerId'] = 'f' * 64
                current_contract['restorationNative'] = {'producer': c.producer('3' * 40, '4' * 40, '12', '1'),
                    'bindingSha256': 'a' * 64, 'commandId': self.command, 'invocationBytesSha256': 'b' * 64}
            restored = {'authenticated': True, 'servicesSha256': c.fingerprint(selected), 'migration': {'status': 'APPLIED'}}
            def loader(name): return c if name == 'unpublished-component-successor.py' else real_load(name)
            real_load = r.load
            with self.subTest(variant=variant), patch.object(r, 'load', side_effect=loader), \
                 patch.object(c, 'modules', return_value=(self.d, None, SimpleNamespace(snapshot=lambda *_: selected), None)), \
                 patch.object(c, 'audit_guard'), patch.object(r, 'native_hotfix', return_value=hotfix), \
                 patch.object(r, 'historical_b', return_value=historical), \
                 patch.object(r, 'authenticate_restart_native', return_value={'authenticated': True}) as restart, \
                 patch.object(c, 'authenticate_restoration', return_value=restored) as restoration:
                authenticated = r.authenticate_hotfix(self.d, self.current, manifest, current_contract)
            self.assertEqual(restart.call_count, int(variant == 'restart'))
            self.assertEqual(restoration.call_count, int(variant == 'restoration'))
            self.assertEqual(authenticated['nativeRestartBinding'] is not None, variant == 'restart')
            self.assertEqual(authenticated['restorationBinding'] is not None, variant == 'restoration')

    def test_actual_native_preflight_carrier_fits_without_live_aws_or_extra_dispatch(self):
        boundaries = Boundaries(); boundaries.setUp()
        original_load = r.load
        with patch.dict(os.environ, boundaries.environment, clear=True), \
             patch.object(c, 'BASELINE_CONTRACT', boundaries.contract), \
             patch.object(r, 'load', side_effect=lambda name: c if name == 'unpublished-component-successor.py' else original_load(name)), \
             patch.object(r, 'command_raw', side_effect=[boundaries.raw, *actual_restart_bytes()]) as aws:
            parameters = r.parameters('preflight')
        self.assertLess(len(json.dumps(parameters).encode()), 20 * 1024)
        self.assertEqual(aws.call_count, 3)
        self.assertFalse(any('send-command' in call.args for call in aws.call_args_list))
        carrier = shlex.split(parameters['commands'][0])[-1]
        import ast
        packed = next(node.args[0].value for node in ast.walk(ast.parse(carrier)) if isinstance(node, ast.Call)
                      and ast.unparse(node.func) == 'base64.b64decode')
        program = gzip.decompress(base64.b64decode(packed, validate=True)).decode()
        self.assertIn('component-same-container-restart-origin-' + r.NATIVE_RESTART_AUTHORITY['invocationBytesSha256'], program)
        for raw in actual_restart_bytes(): self.assertIn(repr(raw), program)


class PublishedComponentTransportTests(unittest.TestCase):
    def test_component_and_legacy_origins_fit_existing_carrier_without_send(self):
        boundaries = Boundaries(); boundaries.setUp()
        component_raw = b'original-native-component-fixture'
        environment = {**boundaries.environment, 'EXPECTED_CURRENT': c.COMPONENT_PREDECESSOR['producer']['commit']}
        original_load = r.load
        with patch.dict(os.environ, environment, clear=True), patch.object(c, 'BASELINE_CONTRACT', boundaries.contract), \
             patch.dict(c.COMPONENT_PREDECESSOR, {'invocationBytesSha256': c.digest(component_raw)}), \
             patch.object(c, 'validate_component_predecessor_native') as validate, \
             patch.object(r, 'load', side_effect=lambda name: c if name == 'unpublished-component-successor.py' else original_load(name)), \
             patch.object(r, 'command_raw', side_effect=[boundaries.raw, component_raw, *actual_restart_bytes()]) as query:
            parameters = r.parameters('preflight')
        self.assertLess(len(json.dumps(parameters).encode()), 20 * 1024)
        self.assertEqual(query.call_count, 4)
        self.assertFalse(any('send-command' in call.args for call in query.call_args_list))
        validate.assert_called_once_with(component_raw)
        carrier = shlex.split(parameters['commands'][0])[-1]
        import ast
        packed = next(node.args[0].value for node in ast.walk(ast.parse(carrier)) if isinstance(node, ast.Call)
                      and ast.unparse(node.func) == 'base64.b64decode')
        program = gzip.decompress(base64.b64decode(packed, validate=True)).decode()
        self.assertIn('component-published-origin-' + c.digest(component_raw), program)
        self.assertIn(repr(component_raw), program)
        for raw in actual_restart_bytes(): self.assertIn(repr(raw), program)

    def test_only_exact_published_predecessor_fetches_original_native_bytes(self):
        core = r.load('unpublished-component-successor.py')
        raw = b'offline-original-native-bytes'
        expected = core.COMPONENT_PREDECESSOR['producer']['commit']
        with patch.dict(os.environ, {'EXPECTED_CURRENT': expected}), patch.object(r, 'command_raw', return_value=raw) as query, \
             patch.object(core, 'validate_component_predecessor_native') as validate:
            self.assertEqual(r.component_predecessor_bytes(core), raw)
            validate.assert_called_once_with(raw)
            query.assert_called_once_with('aws', '--region', r.REGION, 's3', 'cp',
                's3://id-business-v2-backups-098208446664-ap-northeast-1/release-native-origins/20261024/'
                + core.COMPONENT_PREDECESSOR['invocationBytesSha256'] + '.json', '-', '--only-show-errors')

    def test_legacy_and_unknown_producer_do_not_receive_component_origin(self):
        core = r.load('unpublished-component-successor.py')
        for expected in ('60e164b75d1eedaab440c17139bf9ba55de08c61', 'a' * 40):
            with patch.dict(os.environ, {'EXPECTED_CURRENT': expected}), patch.object(r, 'command_raw') as query:
                self.assertIsNone(r.component_predecessor_bytes(core))
                query.assert_not_called()

    def test_bad_native_bytes_stop_before_they_can_be_installed(self):
        core = r.load('unpublished-component-successor.py')
        with patch.dict(os.environ, {'EXPECTED_CURRENT': core.COMPONENT_PREDECESSOR['producer']['commit']}), \
             patch.object(r, 'command_raw', return_value=b'changed original'), \
             patch.object(core, 'validate_component_predecessor_native', side_effect=RuntimeError('UNPUBLISHED_COMPONENT_PREDECESSOR_NATIVE_CHANGED')):
            with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_NATIVE_CHANGED'):
                r.component_predecessor_bytes(core)


if __name__ == '__main__':
    unittest.main()
