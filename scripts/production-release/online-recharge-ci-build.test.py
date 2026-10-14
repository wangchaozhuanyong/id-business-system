"""Pure CI tests: real Git/source validators, no Docker or production calls."""

import copy
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import importlib.util
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('online_ci_test', HERE / 'online-recharge-ci-build.py')
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files, cls.record = ci.source_projection()

    def test_real_four_git_objects_match_frozen_application_online_and_admin(self):
        self.assertFalse(self.record['releaseAuthority'])
        self.assertEqual(self.record['applicationInputSha256'], ci.c.APPLICATION_SHA256)
        self.assertEqual(self.record['onlineInputSha256'], ci.c.ONLINE_SHA256)
        self.assertEqual(self.record['ordinaryProducer'], ci.c.sealed_authority()['producer'])
        for name in ci.c.ADMIN_OVERLAY_FILES:
            self.assertEqual(self.files[name][0], ci.git('show', 'HEAD:' + name))

    def test_dirty_working_files_are_not_source_inputs(self):
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('working file read')):
            files = ci.git_files(self.record['candidateCommit'])
        self.assertEqual(files, self.files)

    def test_git_refs_and_symlinks_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'COMMIT_INVALID'):
            ci.git_files('HEAD')
        with patch.object(ci, 'git', return_value=b'120000 blob ' + b'a' * 40 + b'\tsecret\0'):
            with self.assertRaisesRegex(RuntimeError, 'GIT_SOURCE_INVALID'):
                ci.git_files('b' * 40)

    def test_application_drift_is_rejected_by_real_source_validator(self):
        changed = dict(self.files)
        name = ci.c.ADMIN_OVERLAY_FILES[0]
        changed[name] = (changed[name][0] + b'\nchanged', changed[name][1])
        with self.assertRaisesRegex(RuntimeError, 'APPLICATION_SOURCE_CHANGED'):
            ci.c.validate_source_files(changed)

    def test_ci_record_is_rejected_by_formal_build_validator(self):
        runtime = ci.load('online-recharge-component-runtime.py')
        value = {'version': 1, 'kind': ci.KIND, 'scope': 'CI_ONLY', 'releaseAuthority': False,
                 'sourceProjection': self.record, 'images': {}}
        with self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_CHANGED'):
            runtime.validate_build(value, self.record['ordinaryProducer'], self.record, {}, '123',
                '012345678901.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release')


class ContextTests(unittest.TestCase):
    def test_exact_bytes_and_modes_survive_and_repeat_or_tamper_is_rejected(self):
        runtime = ci.ROOT / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='online-ci-test-', dir=runtime) as directory:
            target = Path(directory) / 'context'
            files = {'a/file.bin': (b'\0\xff\n', '100644'), 'script': (b'#!/bin/sh\n', '100755')}
            ci.write_context(target, files)
            ci.verify_context(target, files)
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_EXISTS'):
                ci.write_context(target, files)
            (target / 'a/file.bin').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_CHANGED'):
                ci.verify_context(target, files)

    def test_symlink_context_is_rejected(self):
        runtime = ci.ROOT / '.runtime'
        runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='online-ci-link-', dir=runtime) as directory:
            target = Path(directory) / 'context'
            target.symlink_to(runtime, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'BUILD_CONTEXT_EXISTS'):
                ci.write_context(target, {})


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.record = {'candidateCommit': 'a' * 40, 'candidateTree': 'b' * 40, 'releaseAuthority': False}

    def test_build_has_only_local_reference_and_no_production_authority(self):
        calls = []
        with patch.object(ci, 'docker', side_effect=lambda *args: calls.append(args) or ''):
            reference = ci.build('admin', Path('/project/admin/Dockerfile'), 'runtime',
                                 Path('/project/context'), self.record)
        self.assertTrue(reference.startswith('id-online-ci:'))
        self.assertIn('id-business-v2.release-authority=false', calls[0])
        self.assertIn('V2_BUILD_ID=v2-' + 'a' * 40, calls[0])
        self.assertFalse(any('ecr.' in arg or arg in ('push', 'login') for arg in calls[0]))

    def test_content_is_read_only_and_never_starts_service(self):
        row = 'c' * 64 + '  /app/dist/file.js\n'
        with patch.object(ci, 'docker', return_value=row) as operation:
            measured = ci.content('id-online-ci:test', ('/app/dist',))
        self.assertEqual(measured, {'/app/dist/file.js': 'c' * 64})
        args = operation.call_args.args
        self.assertIn('--read-only', args)
        self.assertIn('--no-healthcheck', args)
        self.assertIn('none', args)
        self.assertIn('/bin/sh', args)

    def test_content_duplicates_or_out_of_roots_are_rejected(self):
        for raw in ('c' * 64 + '  /secret/file\n', ('c' * 64 + '  /app/dist/a\n') * 2):
            with self.subTest(raw=raw), patch.object(ci, 'docker', return_value=raw):
                with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONTENT_INVALID'):
                    ci.content('id-online-ci:test', ('/app/dist',))

    def test_provenance_mismatch_is_rejected(self):
        value = {'Architecture': 'amd64', 'Id': 'sha256:' + 'c' * 64, 'Config': {'Labels': {
            'org.opencontainers.image.revision': self.record['candidateCommit'],
            'id-business-v2.source-tree': self.record['candidateTree'],
            ci.LABEL: ci.c.fingerprint(self.record), ci.RUNTIME_LABEL: ci.c.fingerprint(self.record),
            'id-business-v2.ci-only': 'NOT_FOR_RELEASE', 'id-business-v2.release-authority': 'false'}}}
        with patch.object(ci, 'docker', return_value=json.dumps([value])):
            self.assertEqual(ci.inspect('id-online-ci:test', self.record), value['Id'])
        for key in ('Architecture', 'Id'):
            bad = copy.deepcopy(value)
            bad[key] = 'invalid'
            with patch.object(ci, 'docker', return_value=json.dumps([bad])):
                with self.assertRaisesRegex(RuntimeError, 'IMAGE_IDENTITY_CHANGED'):
                    ci.inspect('id-online-ci:test', self.record)

    def test_inherited_admin_content_requires_exact_pinned_base_and_all_original_files(self):
        files = {'apps/admin/Dockerfile': (('FROM ' + ci.ADMIN_RUNTIME_BASE + ' AS runtime\n').encode(), '100644')}
        metadata = {'Architecture': 'amd64', 'Os': 'linux', 'Id': ci.ADMIN_BASE_IMAGE_ID,
                    'RepoDigests': ['nginx@' + ci.ADMIN_RUNTIME_BASE.split('@')[1]]}
        calls = []
        with patch.object(ci, 'docker', side_effect=lambda *args: calls.append(args) or
            (json.dumps([metadata]) if args[:2] == ('image', 'inspect') else '')), \
             patch.object(ci, 'content', return_value=dict(ci.ADMIN_BASE_HTML)):
            rows, proof = ci.admin_base_content(files)
        self.assertEqual(rows, ci.ADMIN_BASE_HTML)
        self.assertEqual(proof['imageId'], ci.ADMIN_BASE_IMAGE_ID)
        self.assertEqual(proof['fileCount'], 2)
        self.assertEqual(calls[0], ('pull', '--platform', 'linux/amd64', ci.ADMIN_RUNTIME_BASE))
        self.assertTrue(all('push' not in call and 'login' not in call for call in calls))
        for key, changed in (('Architecture', 'arm64'), ('Os', 'other'), ('Id', 'sha256:' + '1' * 64),
                             ('RepoDigests', ['nginx@sha256:' + '2' * 64])):
            bad = {**metadata, key: changed}
            with self.subTest(key=key), patch.object(ci, 'docker', side_effect=lambda *args:
                json.dumps([bad]) if args[:2] == ('image', 'inspect') else ''), \
                 patch.object(ci, 'content', side_effect=AssertionError('invalid base read')):
                with self.assertRaisesRegex(RuntimeError, 'ADMIN_BASE_IDENTITY_CHANGED'):
                    ci.admin_base_content(files)
        for changed in ({**ci.ADMIN_BASE_HTML, '/usr/share/nginx/html/unknown.html': '3' * 64},
                        {**ci.ADMIN_BASE_HTML, '/usr/share/nginx/html/50x.html': '4' * 64},
                        {'/usr/share/nginx/html/index.html': ci.ADMIN_BASE_HTML['/usr/share/nginx/html/index.html']}):
            with self.subTest(changed=changed), patch.object(ci, 'docker', side_effect=lambda *args:
                json.dumps([metadata]) if args[:2] == ('image', 'inspect') else ''), \
                 patch.object(ci, 'content', return_value=changed):
                with self.assertRaisesRegex(RuntimeError, 'ADMIN_BASE_CONTENT_CHANGED'):
                    ci.admin_base_content(files)
        with patch.object(ci, 'docker') as operation:
            with self.assertRaisesRegex(RuntimeError, 'ADMIN_BASE_SOURCE_CHANGED'):
                ci.admin_base_content({'apps/admin/Dockerfile': (b'FROM nginx:latest AS runtime\n', '100644')})
            operation.assert_not_called()

    def test_docker_is_refused_outside_linux_github_runner(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), patch('sys.argv', ['ci-build']):
            with patch.object(ci, 'docker', side_effect=AssertionError('Docker invoked')):
                with self.assertRaisesRegex(RuntimeError, 'LINUX_CI_RUNNER_REQUIRED'):
                    ci.main()

    def test_failure_stage_and_category_are_distinct_without_raw_exception_text(self):
        ci.STATE.update(stage='IMAGE_BUILD', image='online-recharge')
        for error, category in (
            (RuntimeError('ONLINE_RECHARGE_CI_IMAGE_SOURCE_CHANGED'), 'VALIDATION_FAILED'),
            (RuntimeError('UNPUBLISHED_COMPONENT_CANDIDATE_TREE_CHANGED'), 'VALIDATION_FAILED'),
            (RuntimeError('API_ADMIN_PENDING_SOURCE_CHANGED'), 'VALIDATION_FAILED'),
            (subprocess.CalledProcessError(1, ['docker', 'sensitive-argument']), 'COMMAND_FAILED'),
            (subprocess.TimeoutExpired(['docker', 'sensitive-argument'], 30), 'RESULT_UNCONFIRMED'),
            (ValueError('sensitive-argument'), 'RECORD_INVALID'),
            (FileExistsError('sensitive-argument'), 'LOCAL_IO_FAILED')):
            result = ci.failure_summary(error)
            self.assertEqual(result['stage'], 'IMAGE_BUILD')
            self.assertEqual(result['image'], 'online-recharge')
            self.assertEqual(result['category'], category)
            self.assertFalse(result['releaseAuthority'])
            self.assertNotIn('sensitive-argument', json.dumps(result))

    def test_four_packaged_images_match_compilation_and_frozen_source(self):
        files = {
            'apps/admin/Dockerfile': (('FROM ' + ci.ADMIN_RUNTIME_BASE + ' AS runtime\n').encode(), '100644'),
            'apps/api/src/id-business-v2/auto-registration/worker/tool.py': (b'worker', '100644'),
            'apps/admin/src/v2/styles/base.css': (b'css', '100644'),
            ci.c.SCHEMA: (b'schema', '100644'),
            ci.c.MIGRATION_ROOT + '/one/migration.sql': (b'migration', '100644'),
            'apps/api/prisma-mysql/seed.ts': (b'seed', '100644'),
            ci.ENGINE + '/worker.cjs': (b'engine', '100644')}
        compiled = {'/app/apps/api/dist/main.js': '1' * 64, '/app/packages/shared/dist/index.js': '2' * 64}
        dependencies = {'/opt/id-registration/venv/bin/python': '3' * 64,
                        '/opt/id-registration/dependency-audit.json': '4' * 64}
        compiled_admin = {'/app/apps/admin/dist/index.html': '5' * 64}
        snapshots = {'api-build': compiled, 'registration-dependencies': dependencies,
            'admin-build': compiled_admin,
            'api': {**compiled, **dependencies, **{'/app/' + name: ci.c.digest(raw)
                for name, (raw, _mode) in files.items() if name.endswith(('tool.py', 'base.css'))}},
            'admin': {**ci.ADMIN_BASE_HTML, '/usr/share/nginx/html/index.html': '5' * 64},
            ci.ADMIN_RUNTIME_BASE: dict(ci.ADMIN_BASE_HTML),
            'migrate': {'/app/' + name: ci.c.digest(raw) for name, (raw, _mode) in files.items()
                        if name.startswith('apps/api/prisma-mysql/')},
            'online-recharge': {'./worker.cjs': ci.c.digest(b'engine')}}
        calls = []

        def fake_build(name, dockerfile, target, context, record):
            calls.append((name, dockerfile, target, context))
            return name

        with patch.object(ci, 'verify_context'), patch.object(ci, 'build', side_effect=fake_build), \
             patch.object(ci, 'inspect', return_value='sha256:' + '6' * 64), \
             patch.object(ci, 'docker', side_effect=lambda *args: json.dumps([{
                'Architecture': 'amd64', 'Os': 'linux', 'Id': ci.ADMIN_BASE_IMAGE_ID,
                'RepoDigests': ['nginx@' + ci.ADMIN_BASE_PLATFORM_MANIFEST]}])
                if args[:2] == ('image', 'inspect') else ''), \
             patch.object(ci, 'content', side_effect=lambda reference, *_args, **_kwargs: snapshots[reference]):
            # Reproduce the old false rejection: compiled dist has no 50x.html,
            # while the immutable nginx base contributes that exact original.
            self.assertNotEqual(snapshots['admin'], {'/usr/share/nginx/html/index.html': '5' * 64})
            result = ci.build_and_verify(Path('/project/context'), files, self.record)
            self.assertEqual(set(result['images']), set(ci.IMAGES))
            self.assertFalse(result['releaseAuthority'])
            self.assertFalse(result['productionAccess'])
            self.assertFalse(result['registryPushPerformed'])
            self.assertEqual(result['businessActions'], 0)
            self.assertEqual(result['adminRuntimeBase']['imageId'], ci.ADMIN_BASE_IMAGE_ID)
            for mutation in ({'/usr/share/nginx/html/index.html': '7' * 64},
                             {'/usr/share/nginx/html/50x.html': '7' * 64},
                             {'/usr/share/nginx/html/unknown.html': '7' * 64}):
                original = snapshots['admin']
                snapshots['admin'] = {**original, **mutation}
                with self.assertRaisesRegex(RuntimeError, 'IMAGE_SOURCE_CHANGED'):
                    ci.build_and_verify(Path('/project/context'), files, self.record)
                snapshots['admin'] = original
            snapshots['admin-build'] = {'/app/apps/admin/dist/assets/app.js': '8' * 64}
            with self.assertRaisesRegex(RuntimeError, 'ADMIN_COMPILED_INDEX_MISSING'):
                ci.build_and_verify(Path('/project/context'), files, self.record)
        selected = {name: (dockerfile.name, target, str(context)) for name, dockerfile, target, context in calls}
        self.assertEqual(selected['api'][:2], ('Dockerfile.mysql', 'runtime'))
        self.assertEqual(selected['admin'][:2], ('Dockerfile', 'runtime'))
        self.assertEqual(selected['migrate'][:2], ('Dockerfile.mysql', 'migration'))
        self.assertEqual(selected['online-recharge'], ('Dockerfile', '', '/project/context/' + ci.ENGINE))


class SafetyTests(unittest.TestCase):
    def test_subprocess_environment_never_inherits_credentials_or_daemon_settings(self):
        names = ('GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL',
            'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'HOME', 'CODEX_HOME')
        with patch.dict(os.environ, {name: 'SYNTHETIC_PRIVATE_SENTINEL' for name in names}):
            environment = ci.public_environment()
            self.assertFalse(set(names) & set(environment))
            self.assertNotIn('SYNTHETIC_PRIVATE_SENTINEL', json.dumps(environment))
            self.assertEqual(environment['GIT_CONFIG_GLOBAL'], '/dev/null')
            with patch.object(ci.subprocess, 'check_output', return_value=b'public') as command:
                self.assertEqual(ci.git('rev-parse', 'HEAD'), b'public')
            self.assertEqual(command.call_args.kwargs['env'], environment)

    def test_unsafe_docker_command_and_unadmitted_local_call_stop_before_subprocess(self):
        with patch.object(ci, 'ACTIVE_ENV', None), patch.object(ci.subprocess, 'run') as external:
            for args in (('push', 'private'), ('login',), ('compose', 'up'),
                         ('run', '--env', 'PRIVATE=secret', 'image')):
                with self.subTest(operation=args[0]), self.assertRaises(RuntimeError):
                    ci.approved_docker(*args)
            with self.assertRaisesRegex(RuntimeError, 'DOCKER_COMMAND_FORBIDDEN'):
                ci.docker('image', 'inspect', 'unadmitted')
            external.assert_not_called()

    def test_runtime_driver_only_accepts_exact_inspect_or_no_network_read_commands(self):
        driver = object.__new__(ci.ReadOnlyDockerDriver)
        reference = ci.SYNTHETIC_REPOSITORY + ':' + 'a' * 40 + '-1-1-api'
        driver.references = {'api': reference}
        driver.online = SimpleNamespace(content_command=lambda name: 'fixed public hash command')
        with patch.object(ci, 'approved_docker', return_value='public') as command:
            self.assertEqual(driver.run('docker', 'image', 'inspect', reference), 'public')
            driver.run('docker', 'run', '--rm', '--network', 'none', '--read-only',
                '--entrypoint', '/bin/sh', reference, '-c', 'fixed public hash command')
            self.assertIn('--pull=never', command.call_args.args)
            self.assertIn('--no-healthcheck', command.call_args.args)
            for args in (('aws', 'ssm'), ('docker', 'push', reference),
                         ('docker', 'image', 'inspect', reference + '-other'),
                         ('docker', 'run', reference, '-c', 'private command')):
                with self.assertRaisesRegex(RuntimeError, 'DRIVER_COMMAND_FORBIDDEN'):
                    driver.run(*args)

    def test_only_two_ci_boundaries_are_adapted_and_always_restored(self):
        before = (object(), object())
        runtime = SimpleNamespace(validate_preflight=before[0], source=before[1])
        producer = {'public': 'producer'}; transport = {'scope': 'CI_ONLY'}
        files = {'public': (b'bytes', '100644')}; record = {'notForRelease': True}
        with self.assertRaisesRegex(RuntimeError, 'CI_SOURCE_CHANGED'):
            with ci.source_boundaries(runtime, files, record, producer, transport):
                receipt = runtime.validate_preflight(None, transport, producer, 'CI_ONLY_NOT_FOR_RELEASE')
                self.assertEqual(runtime.source(None, producer, receipt['baseline']), (files, files, record))
                runtime.source(None, {'different': True}, receipt['baseline'])
        self.assertEqual((runtime.validate_preflight, runtime.source), before)

    def test_formal_preflight_rejects_ci_transport_without_a_boundary_adapter(self):
        runtime = ci.load('online-recharge-component-runtime.py')
        core = ci.c.load_core(ci.c.sealed_authority()['coreSha256'])
        transport = {'version': 1, 'kind': ci.KIND + '_NOT_FOR_RELEASE_PREFLIGHT',
            'scope': 'CI_ONLY', 'notForRelease': True, 'producer': {},
            'expectedCurrent': 'CI_ONLY_NOT_FOR_RELEASE'}
        with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_TRANSPORT_CHANGED'):
            runtime.validate_preflight(core, transport, {}, transport['expectedCurrent'])

    def test_unknown_exception_values_and_custom_str_are_never_inspected(self):
        class Hostile(RuntimeError):
            def __str__(self): raise AssertionError('private formatting forbidden')
            def __getattribute__(self, name):
                if name == 'args': raise AssertionError('private args forbidden')
                return super().__getattribute__(name)
        for error in (Hostile('PRIVATE_SENTINEL'), RuntimeError('PRIVATE_SENTINEL'),
                      KeyError('PRIVATE_SENTINEL')):
            result = ci.failure_summary(error)
            self.assertNotIn('PRIVATE_SENTINEL', json.dumps(result))
            self.assertEqual(result['code'], 'ONLINE_RECHARGE_CI_BUILD_FAILED')
            self.assertTrue(result['notForRelease'])
            self.assertFalse(result['releaseAuthority'])


if __name__ == '__main__':
    unittest.main()
