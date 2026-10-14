"""Continuous ONLINE controls with real files, projection and validators.

This suite does not claim production acceptance. Git business archives are real;
only a synthetic candidate's Git transport, AWS, Docker output and time are
fixtures. No website, daemon, database, container or production command starts.
"""

import ast
import base64
from contextlib import contextmanager, redirect_stdout
import copy
from datetime import datetime, timezone
import errno
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COMMAND = '11111111-2222-3333-4444-555555555555'
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'


def load(name):
    path = HERE / name
    spec = importlib.util.spec_from_file_location('lifecycle_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = load('online-recharge-component-readonly.py')
r = client.r
controller = load('remote-deploy.py')


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def archive(ref):
    commit = subprocess.check_output(['git', 'rev-parse', ref], cwd=ROOT, text=True).strip()
    raw = subprocess.check_output(['git', 'archive', '--format=tar',
        '--prefix=id-business-system-' + commit + '/', commit], cwd=ROOT)
    return commit, raw, controller.registration_archive(raw, commit)


def synthetic_archive(files, commit):
    # Transport bytes for the future candidate; never a release seal/artifact.
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as output:
        for name, (raw, mode) in sorted(files.items()):
            member = tarfile.TarInfo('id-business-system-' + commit + '/' + name)
            member.size, member.mode = len(raw), 0o755 if mode == '100755' else 0o644
            output.addfile(member, io.BytesIO(raw))
    return stream.getvalue()


def native(receipt, command, instance, *, failed=False, wire=True, stderr=''):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return encoded({'CommandId': command, 'InstanceId': instance,
        'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
        'Status': 'Failed' if failed else 'Success', 'ResponseCode': 1 if failed else 0,
        'StandardErrorContent': stderr,
        'StandardOutputContent': encoded(r.wire(receipt) if wire else receipt).decode(),
        'ExecutionStartDateTime': now, 'ExecutionEndDateTime': now})


@contextmanager
def working_directory(directory):
    previous = Path.cwd()
    os.chdir(directory)
    try:
        yield
    finally:
        os.chdir(previous)


class ContinuousLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = r.c.load_core()
        cls.projection = cls.core.projection_module()
        cls.references = {}
        for ref in ('HEAD', r.c.AUTHENTICATED_PREDECESSOR['producer']['commit'],
                    '0a03fa28e6b844a18833d5c63f1de700f091fc64', r.c.ONLINE_SOURCE):
            commit, raw, files = archive(ref)
            cls.references[ref] = (commit, raw, files)
        cls.candidate = dict(cls.references['HEAD'][2])
        # Bind current control edits, but preserve every frozen business byte.
        for name in {*cls.core.HELPERS, *r.HELPERS}:
            path = HERE / name
            cls.candidate['scripts/production-release/' + name] = (
                path.read_bytes(), '100755' if path.stat().st_mode & 0o111 else '100644')
        cls.p = cls.core.producer('a' * 40, cls.projection.source_tree(cls.candidate), '123', '1')
        cls.candidate_raw = synthetic_archive(cls.candidate, cls.p['commit'])
        cls.ordinary = cls.references[r.c.AUTHENTICATED_PREDECESSOR['producer']['commit']][2]
        cls.base = cls.references['0a03fa28e6b844a18833d5c63f1de700f091fc64'][2]
        cls.fixed = cls.references[r.c.ONLINE_SOURCE][2]
        _output, cls.ordinary_projection = cls.projection.project_files(cls.ordinary, cls.base,
            cls.fixed, **dict(zip(('commit', 'tree'),
                (r.c.AUTHENTICATED_PREDECESSOR['producer'][n] for n in ('commit', 'sourceTree')))))
        cls.ordinary_output_sha = r.c.fingerprint(cls.projection.inventory(_output))

    def setUp(self):
        runtime = ROOT / '.runtime'
        runtime.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='online-lifecycle-', dir=runtime)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.auth = copy.deepcopy(r.c.AUTHENTICATED_PREDECESSOR)
        self.current_auth = copy.deepcopy(r.c.AUTHENTICATED_ADMIN_SUCCESSOR)
        self.origin = native({'syntheticPredecessorFixture': True}, self.auth['commandId'],
                             self.auth['instanceId'], wire=False)
        self.current = native({'syntheticAdminFixture': True}, self.current_auth['commandId'],
                              self.current_auth['instanceId'], wire=False)
        for authority, raw in ((self.auth, self.origin), (self.current_auth, self.current)):
            authority.update(invocationBytesSha256=r.c.digest(raw),
                receiptSha256=r.c.fingerprint(json.loads(json.loads(raw)['StandardOutputContent'])))
        for patcher in (patch.object(r.c, 'SEALED_ORDINARY_COMPONENT', self.auth),
                        patch.object(r.c, 'ADMIN_SUCCESSOR', self.current_auth),
                        patch.dict(os.environ, {
                            'GITHUB_ACTIONS': 'true', 'GITHUB_REF': 'refs/heads/main',
                            'RELEASE_OPERATION': 'release_online_recharge',
                            'EXPECTED_CURRENT': self.current_auth['producer']['commit'],
                            'RELEASE_COMMIT': self.p['commit'], 'SOURCE_TREE': self.p['sourceTree'],
                            'GITHUB_RUN_ID': self.p['workflowRunId'],
                            'GITHUB_RUN_ATTEMPT': self.p['workflowRunAttempt'],
                            'AWS_REGION': 'ap-northeast-1',
                            'PRODUCTION_INSTANCE_ID': self.auth['instanceId'],
                            'API_FAULT_RESTORE_APPROVED': 'true',
                            'QUALITY_RUN_ID': '456', 'RELEASE_REPOSITORY': REPOSITORY}, clear=True)):
            patcher.start(); self.addCleanup(patcher.stop)
        self.docker = []
        self.aws = []
        self.image_mutation = None
        scope = controller.api_admin_scope('API_ADMIN_WORKSPACE')
        self.d = SimpleNamespace(require=controller.require,
            registration_download=self.download, registration_archive=controller.registration_archive,
            write_registration_files=controller.write_registration_files,
            api_admin_scope=lambda name: scope if name == 'API_ADMIN_WORKSPACE' else
                (_ for _ in ()).throw(AssertionError('unexpected scope')),
            run=self.docker_run)
        original_modules = r.modules
        patcher = patch.object(r, 'modules', side_effect=lambda d=None:
            original_modules(self.d if d is None else d))
        patcher.start(); self.addCleanup(patcher.stop)
        self.evidence = {'ordinaryProducer': self.auth['producer'],
            'ordinaryAuthoritySha256': r.c.fingerprint(self.auth),
            'actualPredecessor': self.current_auth['producer'],
            'adminAuthoritySha256': r.c.fingerprint(self.current_auth),
            'ordinaryArchiveSha256': r.c.digest(self.references[self.auth['producer']['commit']][1]),
            'ordinarySourceFilesSha256': r.c.fingerprint(self.projection.inventory(self.ordinary)),
            'ordinaryProjectionSha256': r.c.fingerprint(self.ordinary_projection),
            'ordinaryOutputFilesSha256': self.ordinary_output_sha}
        with working_directory(self.directory):
            _, self.output, self.record = r.source(self.d, self.p, self.evidence)
        self.receipt = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND,
            'status': 'ONLINE_RECHARGE_BASELINE_VERIFIED', 'producer': self.p,
            'baseline': self.evidence, 'sourceProjectionSha256': r.c.fingerprint(self.record),
            'applicationInputSha256': r.c.APPLICATION_SHA256, 'onlineInputSha256': r.c.ONLINE_SHA256,
            'onlinePublished': False, 'migrationPerformed': False, 'databaseGrantsChanged': False,
            'executionMigrationPlan': [], 'businessActions': 0}
        self.preflight_native = native(self.receipt, COMMAND, self.auth['instanceId'])
        self.transport = client.validate_native(self.core, self.preflight_native, 'preflight',
            self.p, COMMAND, self.auth['instanceId'])

    def download(self, commit):
        if commit == self.p['commit']:
            return self.candidate_raw
        for reference, raw, _files in self.references.values():
            if commit == reference:
                return raw
        raise AssertionError('network source transport forbidden: ' + commit)

    def command(self, *args, **kwargs):
        if args[:2] == ('git', 'ls-tree'):
            self.assertEqual(args[2], self.p['commit'])
            name = args[-1]; raw, mode = self.candidate[name]
            blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            return (mode + ' blob ' + blob + '\t' + name + '\n').encode()
        if args[:2] == ('git', 'ls-remote'):
            return (self.p['commit'] + '\trefs/heads/main\n').encode()
        if args[0] == 'aws':
            self.aws.append(args)
            if 'send-command' in args:
                return (COMMAND + '\n').encode()
            if 'get-command-invocation' in args:
                command_id = args[args.index('--command-id') + 1]
                if command_id == self.auth['commandId']:
                    return self.origin
                if command_id == self.current_auth['commandId']:
                    return self.current
                return self.return_native
        raise AssertionError('unmocked external command: ' + repr(args[:3]))

    def content(self, name):
        if name == 'online-recharge':
            root = self.directory / r.CONTEXT / 'apps/api/src/id-business-v2/online-recharge/engine'
            return '\n'.join(sorted(r.c.digest(path.read_bytes()) + '  ./' + path.relative_to(root).as_posix()
                for path in root.rglob('*') if path.is_file()))
        if name == 'migrate':
            return '\n'.join(sorted(r.c.digest(raw) + '  /app/' + filename
                for filename, (raw, _mode) in self.output.items()
                if filename.startswith(r.c.MIGRATION_ROOT + '/') or
                   filename in (r.c.SCHEMA, 'apps/api/prisma-mysql/seed.ts')))
        # Compiled app output is a Docker fixture; content parsing remains real.
        return r.c.digest(('synthetic compiled ' + name).encode()) + '  ' + (
            '/app/apps/api/dist/main.js' if name == 'api' else '/usr/share/nginx/html/index.html')

    def docker_run(self, *args, **kwargs):
        self.assertEqual(args[0], 'docker')
        self.docker.append(args)
        if args[1:3] == ('image', 'inspect'):
            name = args[3].rsplit('-', 1)[-1]
            if name == 'recharge': name = 'online-recharge'
            metadata = {'Id': 'sha256:' + r.c.digest(name.encode()), 'Architecture': 'amd64',
                'Config': {'Labels': {'org.opencontainers.image.revision': self.p['commit'],
                    'id-business-v2.source-tree': self.p['sourceTree'],
                    r.LABEL: r.c.fingerprint(self.record)}}}
            if self.image_mutation: self.image_mutation(name, metadata)
            return json.dumps([metadata])
        self.assertEqual(args[1], 'run')
        name = args[args.index('-c') - 1].rsplit('-', 1)[-1]
        if name == 'recharge': name = 'online-recharge'
        return self.content(name)

    def prepare(self):
        with working_directory(self.directory):
            client.write_once(self.core, (self.directory / r.PREFLIGHT), self.transport)
            return r.prepare(self.d, self.p, self.transport)

    def build(self):
        with working_directory(self.directory):
            return r.build_proof(self.d, self.p, self.transport, '456', REPOSITORY)

    def returned_receipt(self):
        value = {name: 'c' * 64 for name in r.RETURN_FIELDS if name.endswith('Sha256')}
        value.update(version=1, scope=r.SCOPE, kind=r.KIND, status='ONLINE_RECHARGE_VERIFIED',
            producer=self.p, servicesUpdated=list(r.UPDATED), preservedServiceCount=len(r.PRESERVED),
            onlinePublished=True, migrationPerformed=False, databaseGrantsChanged=False,
            executionMigrationPlan=[], businessActions=0, volumeDeletionPerformed=False,
            runningImagesAndContentMatched=True, databaseOldGrantsPreserved=True, backupVerified=True,
            appliedDatabase={'online': {'status': 'APPLIED', 'schemaVerified': True},
                'connectionProfile': {'status': 'APPLIED', 'schemaVerified': True},
                'migrationPerformed': False, 'databaseGrantsChanged': False, 'migrationPlan': []},
            onlineGrants={'status': 'EXISTING_ONLINE_GRANTS_READONLY_VERIFIED', 'mutationPerformed': False},
            sourceProjectionSha256=r.c.fingerprint(self.record))
        proof = self.directory / r.PROOF
        if proof.exists(): value['buildProofBytesSha256'] = r.c.digest(self.core.private_bytes(proof))
        return value

    def test_native_save_prepare_label_four_image_proof_parameters_and_readback(self):
        self.prepare()
        path = self.directory / r.PREFLIGHT
        original, identity = path.read_bytes(), path.stat()
        client.write_once(self.core, path, self.transport)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(path.stat().st_ino, identity.st_ino)
        self.assertEqual(path.stat().st_mtime_ns, identity.st_mtime_ns)
        with working_directory(self.directory), redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(client.main('label'), 0)
        self.assertEqual(stdout.getvalue().strip(), r.c.fingerprint(self.record))
        proof = self.build()
        self.assertEqual(set(proof['images']), set(r.IMAGES))
        self.assertEqual(proof['sourceProjection'], self.record)
        self.assertFalse(proof['sourceProjection']['releaseAuthority'])
        with working_directory(self.directory), patch.object(client, 'command_raw', side_effect=self.command):
            params = client.parameters('release', self.core, self.p,
                input_artifacts=(self.core.private_bytes(self.directory / r.PROOF),
                                 self.core.private_bytes(path)))
        carrier = shlex.split(params['commands'][0])[-1]
        packed = ast.literal_eval(carrier.split('base64.b64decode(', 1)[1].split(',validate=True)', 1)[0])
        program = gzip.decompress(base64.b64decode(packed)).decode()
        tree = ast.parse(program)
        call = next(node.value.right for node in tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Attribute) and target.attr == 'argv' for target in node.targets))
        args, origin, current, descriptor, packed_native, packed_proof = [ast.literal_eval(arg) for arg in call.args]
        # Execute the real server argument assembly. Only its private server
        # destination is redirected into this owned temporary test directory.
        writes = []
        ordinary_client = client.load('api-admin-readonly.py')
        write_raw = ordinary_client.write_workspace_private_bytes
        def store(filename, raw):
            destination = self.directory / 'synthetic-server' / str(len(writes)) / 'invocation.json'
            write_raw(str(destination), raw)
            writes.append((filename, raw, self.core.private_bytes(destination)))
        with patch.object(ordinary_client, 'write_workspace_private_bytes', side_effect=store), \
                patch.object(client, 'load', side_effect=lambda name: ordinary_client
                    if name == 'api-admin-readonly.py' else load(name)):
            server_args = client.server_arguments(args, origin, current, descriptor, packed_native, packed_proof)
        actual_proof = r.decode_json(self.core, server_args[server_args.index('--build-proof') + 1])
        actual_preflight = r.decode_json(self.core, server_args[server_args.index('--preflight') + 1])
        self.assertEqual(actual_proof, proof)
        self.assertEqual(actual_preflight, self.transport)
        self.assertEqual([raw for _, raw, _ in writes], [self.origin, self.current])
        self.assertTrue(all(raw == saved for _, raw, saved in writes))
        returned = self.returned_receipt()
        self.return_native = native(returned, COMMAND, self.auth['instanceId'])
        result = client.validate_native(self.core, self.return_native, 'readback', self.p,
                                        COMMAND, self.auth['instanceId'])
        client.write_once(self.core, self.directory / 'readback.json', result)
        self.assertEqual(self.core.closed_json(self.core.private_bytes(self.directory / 'readback.json'))['receipt'], returned)
        self.assertEqual(returned['buildProofBytesSha256'], r.c.digest(self.core.private_bytes(self.directory / r.PROOF)))
        self.assertEqual(len([a for a in self.aws if 'send-command' in a]), 0)

    def test_old_duplicate_preflight_write_fails_errno17_current_prepare_preserves_bytes(self):
        path = self.directory / r.PREFLIGHT
        client.write_once(self.core, path, self.transport)
        before = path.read_bytes()
        # This was the old prepare tail: genuine O_EXCL writer, same saved F.
        with self.assertRaises(FileExistsError) as caught:
            self.core.write_private(path, self.transport)
        self.assertEqual(caught.exception.errno, errno.EEXIST)
        self.prepare()
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_EXISTS'):
            self.prepare()
        self.assertEqual(path.read_bytes(), before)

    def test_saved_preflight_changed_or_symlink_is_refused_before_prepare(self):
        path = self.directory / r.PREFLIGHT
        client.write_once(self.core, path, self.transport)
        changed = copy.deepcopy(self.transport); changed['producer']['workflowRunId'] = '999'
        with self.assertRaisesRegex(RuntimeError, 'SAVED_EVIDENCE_CHANGED'):
            client.write_once(self.core, path, changed)
        original = path.read_bytes(); target = path.with_name('synthetic-public-original.json')
        path.rename(target); path.symlink_to(target)
        with working_directory(self.directory), self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'):
            r.prepare(self.d, self.p, self.transport)
        self.assertTrue(path.is_symlink()); self.assertEqual(target.read_bytes(), original)
        self.assertFalse((self.directory / r.CONTEXT).exists())

    def test_modified_context_or_projection_refuses_before_docker(self):
        self.prepare()
        path = self.directory / r.CONTEXT / 'apps/admin/src/v2/features/online-recharge/api.ts'
        self.assertTrue(path.exists())
        path.write_bytes(path.read_bytes() + b'\n// synthetic drift\n')
        with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_CHANGED'): self.build()
        self.assertEqual(self.docker, [])

    def test_saved_preflight_tampering_refuses_before_build_context(self):
        path = self.directory / r.PREFLIGHT
        client.write_once(self.core, path, self.transport)
        changed = copy.deepcopy(self.transport)
        changed['serverReceipt']['sourceProjectionSha256'] = '0' * 64
        path.write_bytes(encoded(changed))
        with working_directory(self.directory), self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_RECEIPT_CHANGED'):
            r.prepare(self.d, self.p, self.transport)
        self.assertFalse((self.directory / r.CONTEXT).exists())
        self.assertEqual(self.docker, [])

    def test_projection_tampering_and_context_file_symlink_refuse_before_docker(self):
        self.prepare()
        path = self.directory / r.PROJECTION
        changed = copy.deepcopy(self.record); changed['releaseAuthority'] = True
        original = path.read_bytes(); path.write_bytes(encoded(changed))
        with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_CHANGED'): self.build()
        path.write_bytes(original)
        context_file = self.directory / r.CONTEXT / 'apps/admin/src/v2/features/online-recharge/api.ts'
        target = self.directory / 'synthetic-context-target'
        context_file.rename(target); context_file.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_CHANGED'): self.build()
        self.assertTrue(context_file.is_symlink())
        self.assertEqual(self.docker, [])

    def test_projection_evidence_symlink_refuses_without_changing_preflight_or_context(self):
        self.prepare()
        path = self.directory / r.PROJECTION
        target = path.with_name('synthetic-original-projection.json')
        original = self.core.private_bytes(path)
        preflight = self.core.private_bytes(self.directory / r.PREFLIGHT)
        path.rename(target); path.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'):
            self.build()
        self.assertTrue(path.is_symlink())
        self.assertEqual(self.core.private_bytes(target), original)
        self.assertEqual(self.core.private_bytes(self.directory / r.PREFLIGHT), preflight)
        with working_directory(self.directory):
            r.verify_context(self.core, self.output, self.record)
        self.assertFalse((self.directory / r.PROOF).exists())
        self.assertEqual(self.docker, [])

    def test_stale_source_and_cross_module_content_errors_are_real(self):
        changed = {**self.p, 'sourceTree': 'f' * 40}
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_TREE_CHANGED'):
            r.source(self.d, changed, self.evidence)
        online = r.load('online-recharge-scope.py')
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_CONTENT_INVALID') as caught:
            online.content_summary(self.d, 'api', 'synthetic invalid content')
        self.assertEqual(client.safe_failure(caught.exception)['code'], 'API_ADMIN_CONTENT_INVALID')
        self.assertEqual(self.docker, [])

    def test_four_image_label_drift_is_refused_before_build_proof_is_saved(self):
        self.prepare()
        self.image_mutation = lambda name, metadata: metadata['Config']['Labels'].update(
            {r.LABEL: '0' * 64}) if name == 'migrate' else None
        with self.assertRaisesRegex(RuntimeError, 'BUILD_IMAGE_LABEL_CHANGED'): self.build()
        self.assertFalse((self.directory / r.PROOF).exists())

    def test_build_image_content_and_candidate_identity_mismatch_refuse_parameters(self):
        self.prepare(); proof = self.build()
        changed = copy.deepcopy(proof); changed['images']['api']['reference'] += '-other'
        with self.assertRaisesRegex(RuntimeError, 'BUILD_IMAGE_CHANGED'):
            r.validate_build(changed, self.p, self.record, self.transport, '456', REPOSITORY)
        changed = copy.deepcopy(proof); changed['producer']['workflowRunId'] = '999'
        with self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_CHANGED'):
            r.validate_build(changed, self.p, self.record, self.transport, '456', REPOSITORY)
        online = r.load('online-recharge-scope.py')
        changed = copy.deepcopy(proof); changed['images']['api']['sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONTENT_CHANGED'):
            r.verify_image(self.d, online, self.directory / r.CONTEXT, self.output, self.p, changed, 'api')
        self.assertEqual(self.aws, [])

    def test_build_and_push_consumers_revalidate_same_four_image_proof_without_rewrite(self):
        self.prepare()
        # These are the genuine two shell consumers in one formal run. Invoke
        # their actual CLI dispatcher with its full producer/F/quality/repo
        # environment; only Docker transport remains the existing fixture.
        command = 'python3 -B scripts/production-release/online-recharge-component-readonly.py build-proof'
        for name in ('build-images.sh', 'push-images.sh'):
            self.assertIn(command, (HERE / name).read_text())
        with working_directory(self.directory), patch.object(r, 'build_proof', wraps=r.build_proof) as proof_call:
            with redirect_stdout(io.StringIO()): self.assertEqual(client.main('build-proof'), 0)
            path = self.directory / r.PROOF
            before, metadata = self.core.private_bytes(path), path.stat()
            image_checks = len(self.docker)
            with redirect_stdout(io.StringIO()): self.assertEqual(client.main('build-proof'), 0)
            self.assertEqual(proof_call.call_count, 2)
            for call in proof_call.call_args_list:
                self.assertEqual(call.args, (self.d, self.p, self.transport, '456', REPOSITORY))
        after = path.stat()
        self.assertEqual(self.core.private_bytes(path), before)
        self.assertEqual((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                         (metadata.st_dev, metadata.st_ino, metadata.st_size,
                          metadata.st_mtime_ns, metadata.st_ctime_ns))
        self.assertGreater(len(self.docker), image_checks)  # Push guard rereads all image identities/content.
        saved = self.core.closed_json(before)
        self.assertEqual(set(saved['images']), set(r.IMAGES))
        self.assertEqual(saved['producer'], self.p)
        self.assertEqual(saved['qualityRunId'], '456')
        self.assertEqual(saved['preflightSha256'], r.c.fingerprint(self.transport))
        self.assertEqual(self.aws, [])

    def test_archived_build_proof_second_call_reproduces_errno17_then_current_call_reuses(self):
        self.prepare()
        raw = subprocess.check_output(['git', 'show',
            'a9829b443fe5c0cf6f4803366d06c5f8e3357318:scripts/production-release/online-recharge-component-runtime.py'],
            cwd=ROOT)
        function = next(node for node in ast.parse(raw).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'build_proof')
        # Run the exact archived function, using current genuine validators and
        # private writer. This is the old production bug, not a writer mock.
        namespace = dict(vars(r))
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<archived-build-proof>', 'exec'), namespace)
        old_build = namespace['build_proof']
        with working_directory(self.directory):
            expected = old_build(self.d, self.p, self.transport, '456', REPOSITORY)
            path = self.directory / r.PROOF
            before, metadata = self.core.private_bytes(path), path.stat()
            with self.assertRaises(FileExistsError) as caught:
                old_build(self.d, self.p, self.transport, '456', REPOSITORY)
            self.assertEqual(caught.exception.errno, errno.EEXIST)
            self.assertEqual(r.build_proof(self.d, self.p, self.transport, '456', REPOSITORY), expected)
        self.assertEqual(self.core.private_bytes(path), before)
        self.assertEqual(path.stat().st_ino, metadata.st_ino)
        self.assertEqual(path.stat().st_mtime_ns, metadata.st_mtime_ns)

    def test_existing_build_proof_tampering_or_symlink_refuses_without_overwrite(self):
        self.prepare(); self.build()
        path = self.directory / r.PROOF
        original = self.core.private_bytes(path)
        changed = self.core.closed_json(original); changed['qualityRunId'] = '999'
        path.write_bytes(encoded(changed))
        tampered = path.read_bytes()
        with self.assertRaises(RuntimeError): self.build()
        self.assertEqual(path.read_bytes(), tampered)
        path.write_bytes(original)
        target = path.with_name('synthetic-original-build-proof.json')
        path.rename(target); path.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_ARTIFACT_INVALID'):
            self.build()
        self.assertTrue(path.is_symlink())
        self.assertEqual(self.core.private_bytes(target), original)
        self.assertEqual(self.aws, [])

    def test_accepted_read_timeout_then_late_result_never_resends(self):
        self.return_native = encoded({'Status': 'InProgress'})
        output = self.directory / '.deploy/production-release'
        output.mkdir(parents=True, mode=0o700)
        trace = {}
        with working_directory(self.directory), patch.object(client, 'command_raw', side_effect=self.command), \
                patch.object(client.time, 'monotonic', side_effect=[0, 1, 646]), \
                patch.object(client.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'NATIVE_TIMEOUT_NO_REPLAY') as caught:
                client.transport('readback', self.core, self.p, output, trace)
        summary = client.diagnostic_failure(caught.exception, 'readback', self.p, trace)
        self.assertEqual(summary['outcome'], 'RESULT_UNKNOWN')
        self.assertEqual(summary['commandId'], COMMAND)
        self.assertFalse(summary['automaticRetryAllowed'])
        self.assertEqual(len([a for a in self.aws if 'send-command' in a]), 1)
        metadata = self.core.closed_json(self.core.private_bytes(output / (r.PREFIX + '-readback-invocation-metadata.json')))
        self.assertEqual(metadata['commandId'], COMMAND)
        self.return_native = native(self.returned_receipt(), COMMAND, self.auth['instanceId'])
        ended = client.validate_native(self.core, self.return_native, 'readback', self.p,
            metadata['commandId'], metadata['instanceId'])
        self.assertEqual(ended['status'], 'Success')
        with working_directory(self.directory), patch.object(client, 'command_raw', side_effect=self.command):
            with self.assertRaisesRegex(RuntimeError, 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                client.transport('readback', self.core, self.p, output)
        self.assertEqual(len([a for a in self.aws if 'send-command' in a]), 1)

    def test_stale_main_prevents_any_ssm_submission(self):
        with patch.object(client, 'command_raw', return_value=b'ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main\n'):
            with self.assertRaisesRegex(RuntimeError, 'STALE_MAIN_FORMAL_SEND_FORBIDDEN'):
                client.transport('readback', self.core, self.p, self.directory)
        self.assertEqual(self.aws, [])

    def test_truncated_wire_wrong_identity_and_rejected_native_never_pass_readback(self):
        good = native(self.returned_receipt(), COMMAND, self.auth['instanceId'])
        changed = json.loads(good); changed['StandardOutputContent'] = changed['StandardOutputContent'][:-4]
        identity = json.loads(good); identity['CommandId'] = '00000000-0000-0000-0000-000000000000'
        rejected = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND,
            'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED',
            'code': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED'}
        for raw in (good[:-1], encoded(changed), encoded(identity),
                    native(rejected, COMMAND, self.auth['instanceId'], failed=True)):
            with self.subTest(size=len(raw)), self.assertRaises((RuntimeError, ValueError)):
                client.validate_native(self.core, raw, 'readback', self.p, COMMAND, self.auth['instanceId'])
        self.assertEqual(self.aws, [])

    def test_original_failed_native_aws_trailer_is_authenticated_failure_without_replay(self):
        rejected = {'version': 1, 'scope': r.SCOPE, 'kind': r.KIND,
            'status': 'ONLINE_RECHARGE_COMPONENT_REJECTED',
            'code': 'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED'}
        trailer = 'failed to run commands: exit status 1'
        self.assertEqual(len(trailer.encode()), 37)
        raw = native(rejected, COMMAND, self.auth['instanceId'], failed=True, stderr=trailer)
        # The old frozen validator reproduces the actual evidence rejection.
        with self.assertRaisesRegex(RuntimeError, 'INVOCATION_INVALID'):
            self.core.validate_invocation(raw, COMMAND, self.auth['instanceId'], status='Failed')
        result = client.validate_failure_native(self.core, raw, self.p, COMMAND, self.auth['instanceId'])
        self.assertEqual(result['status'], 'Failed')
        self.assertEqual(result['invocationBytesSha256'], r.c.digest(raw))
        self.assertEqual(base64.b64decode(result['invocationRawBase64']), raw)
        self.assertEqual(result['receipt'], rejected)
        self.assertFalse(result['automaticRetryAllowed'])
        trace = {'phase': 'authenticate-native', 'accepted': True,
            'commandId': COMMAND, 'instanceId': self.auth['instanceId'], **client.native_details(raw)}
        summary = client.diagnostic_failure(client.NativeFailure(result), 'preflight', self.p, trace)
        self.assertEqual(summary['code'], rejected['code'])
        self.assertEqual(summary['outcome'], 'COMMAND_FAILED')
        self.assertTrue(summary['nativeAuthenticated'])
        self.assertEqual(summary['nativeStatus'], 'Failed')
        self.assertFalse(summary['automaticRetryAllowed'])
        for change in (lambda value: value.update(StandardErrorContent='synthetic unexpected stderr'),
                       lambda value: value.update(Status='Success', ResponseCode=0),
                       lambda value: value.update(ResponseCode=2)):
            changed = json.loads(raw); change(changed)
            with self.assertRaisesRegex(RuntimeError, 'INVOCATION_INVALID'):
                r.validate_component_invocation(self.core, encoded(changed), COMMAND,
                                                self.auth['instanceId'], status='Failed')
        with self.assertRaisesRegex(RuntimeError, 'INVOCATION_INVALID'):
            client.validate_native(self.core, raw, 'readback', self.p, COMMAND, self.auth['instanceId'])
        self.return_native = raw
        output = self.directory / '.deploy/production-release'
        output.mkdir(parents=True, mode=0o700)
        trace = {}
        with working_directory(self.directory), patch.object(client, 'command_raw', side_effect=self.command):
            with self.assertRaises(client.NativeFailure) as caught:
                client.transport('preflight', self.core, self.p, output, trace)
        saved = self.core.closed_json(self.core.private_bytes(output / (r.PREFIX + '-preflight-failure.json')))
        self.assertEqual(saved, result)
        self.assertEqual(client.diagnostic(self.core, self.p, output)['code'], rejected['code'])
        self.assertEqual(client.diagnostic_failure(caught.exception, 'preflight', self.p, trace)['outcome'],
                         'COMMAND_FAILED')
        with working_directory(self.directory), patch.object(client, 'command_raw', side_effect=self.command):
            with self.assertRaisesRegex(RuntimeError, 'SEND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                client.transport('preflight', self.core, self.p, output)
        self.assertEqual(len([a for a in self.aws if 'send-command' in a]), 1)

    def test_local_exception_diagnostics_distinguish_errors_without_raw_text(self):
        secret_fixture = 'synthetic-secret-should-never-appear'
        errors = (FileExistsError(errno.EEXIST, secret_fixture, '/synthetic/private/path'),
                  json.JSONDecodeError(secret_fixture, secret_fixture, 0),
                  RuntimeError('API_ADMIN_CONTENT_INVALID'))
        summaries = [client.diagnostic_failure(error, 'prepare', self.p, {'phase': 'prepare'})
                     for error in errors]
        self.assertEqual(summaries[0]['exceptionClass'], 'FileExistsError')
        self.assertEqual(summaries[0]['errno'], errno.EEXIST)
        self.assertEqual(summaries[1]['exceptionClass'], 'ValueError')
        self.assertEqual(summaries[2]['code'], 'API_ADMIN_CONTENT_INVALID')
        self.assertTrue(all(summary['outcome'] == 'LOCAL_FAILED' for summary in summaries))
        self.assertNotIn(secret_fixture, json.dumps(summaries))
        self.assertNotIn('/synthetic/private/path', json.dumps(summaries))


if __name__ == '__main__':
    unittest.main()
