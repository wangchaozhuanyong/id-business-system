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
            ci.LABEL: ci.c.fingerprint(self.record), 'id-business-v2.release-authority': 'false'}}}
        with patch.object(ci, 'docker', return_value=json.dumps([value])):
            self.assertEqual(ci.inspect('id-online-ci:test', self.record), value['Id'])
        for key in ('Architecture', 'Id'):
            bad = copy.deepcopy(value)
            bad[key] = 'invalid'
            with patch.object(ci, 'docker', return_value=json.dumps([bad])):
                with self.assertRaisesRegex(RuntimeError, 'IMAGE_IDENTITY_CHANGED'):
                    ci.inspect('id-online-ci:test', self.record)

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
            'admin': {'/usr/share/nginx/html/index.html': '5' * 64},
            'migrate': {'/app/' + name: ci.c.digest(raw) for name, (raw, _mode) in files.items()
                        if name.startswith('apps/api/prisma-mysql/')},
            'online-recharge': {'./worker.cjs': ci.c.digest(b'engine')}}
        calls = []

        def fake_build(name, dockerfile, target, context, record):
            calls.append((name, dockerfile, target, context))
            return name

        with patch.object(ci, 'verify_context'), patch.object(ci, 'build', side_effect=fake_build), \
             patch.object(ci, 'inspect', return_value='sha256:' + '6' * 64), \
             patch.object(ci, 'content', side_effect=lambda reference, *_args, **_kwargs: snapshots[reference]):
            result = ci.build_and_verify(Path('/project/context'), files, self.record)
            self.assertEqual(set(result['images']), set(ci.IMAGES))
            self.assertFalse(result['releaseAuthority'])
            self.assertFalse(result['productionAccess'])
            self.assertFalse(result['registryPushPerformed'])
            self.assertEqual(result['businessActions'], 0)
            snapshots['admin']['/usr/share/nginx/html/index.html'] = '7' * 64
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_SOURCE_CHANGED'):
                ci.build_and_verify(Path('/project/context'), files, self.record)
        selected = {name: (dockerfile.name, target, str(context)) for name, dockerfile, target, context in calls}
        self.assertEqual(selected['api'][:2], ('Dockerfile.mysql', 'runtime'))
        self.assertEqual(selected['admin'][:2], ('Dockerfile', 'runtime'))
        self.assertEqual(selected['migrate'][:2], ('Dockerfile.mysql', 'migration'))
        self.assertEqual(selected['online-recharge'], ('Dockerfile', '', '/project/context/' + ci.ENGINE))


if __name__ == '__main__':
    unittest.main()
