"""Pure CI tests: real Git/source validators, no Docker or production calls."""

import copy
from contextlib import redirect_stdout
import io
import json
import os
import subprocess
import sys
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
        # This consumer admits one sealed historical application, not whichever
        # application happens to be HEAD when its control tests run later.
        cls.fixture_commit = ci.c.APPLICATION_SOURCE
        cls.fixture_tree = ci.c.APPLICATION_TREE
        cls.head_git = ci.git
        with patch.object(ci, 'git', side_effect=cls.historical_git):
            cls.files, cls.record = ci.source_projection()

    @classmethod
    def historical_git(cls, *args):
        if args == ('rev-parse', 'HEAD'):
            return (cls.fixture_commit + '\n').encode()
        if args == ('rev-parse', 'HEAD^{tree}'):
            return (cls.fixture_tree + '\n').encode()
        # File bytes, modes, ordinary producer, base and ONLINE inputs still
        # come from the real immutable Git objects and the real validators.
        return cls.head_git(*args)

    def test_real_four_git_objects_match_frozen_application_online_and_admin(self):
        self.assertFalse(self.record['releaseAuthority'])
        self.assertEqual(self.record['candidateCommit'], self.fixture_commit)
        self.assertEqual(self.record['candidateTree'], self.fixture_tree)
        self.assertEqual(ci.git('rev-parse', self.fixture_commit + '^{tree}').decode().strip(),
                         self.fixture_tree)
        self.assertEqual(self.record['applicationInputSha256'], ci.c.APPLICATION_SHA256)
        self.assertEqual(self.record['onlineInputSha256'], ci.c.ONLINE_SHA256)
        self.assertEqual(self.record['ordinaryProducer'], ci.c.sealed_authority()['producer'])
        for name in ci.c.ADMIN_OVERLAY_FILES:
            self.assertEqual(self.files[name][0], ci.git('show', self.fixture_commit + ':' + name))

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

    def test_later_admin_candidate_is_rejected_by_historical_consumer(self):
        # This ancestor candidate reproduced the failure in run 38724007645.
        # Pinning it also avoids depending on a removable side branch's object.
        later_commit = 'f979c38c59c0f08d326b746ce14cba543f602b0c'
        later = ci.git_files(later_commit)
        self.assertNotEqual(later, self.files)
        with self.assertRaisesRegex(RuntimeError, 'APPLICATION_SOURCE_CHANGED'):
            ci.c.validate_source_files(later)

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
        self.context = Path('/project/context')
        self.api_reference = 'id-online-ci:' + self.record['candidateTree'] + '-api-build'
        commands, references = ci.execution_allowlist(self.context, self.record)
        execution = patch.multiple(ci, ACTIVE_ENV=ci.public_environment(),
            ACTIVE_COMMANDS=commands, ACTIVE_REFERENCES=references)
        execution.start(); self.addCleanup(execution.stop)

    def test_build_has_only_local_reference_and_no_production_authority(self):
        calls = []
        with patch.object(ci, 'docker', side_effect=lambda *args: calls.append(args) or ''):
            reference = ci.build('admin', self.context / 'apps/admin/Dockerfile', 'runtime',
                                 self.context, self.record)
        self.assertTrue(reference.startswith('id-online-ci:'))
        self.assertIn('id-business-v2.release-authority=false', calls[0])
        self.assertIn('V2_BUILD_ID=v2-' + 'a' * 40, calls[0])
        self.assertFalse(any('ecr.' in arg or arg in ('push', 'login') for arg in calls[0]))

    def test_content_is_read_only_and_never_starts_service(self):
        row = 'c' * 64 + '  /app/apps/api/dist/file.js\n'
        with patch.object(ci, 'docker', return_value=row) as operation:
            measured = ci.content(self.api_reference, ci.CONTENT_ROOTS['api-build'])
        self.assertEqual(measured, {'/app/apps/api/dist/file.js': 'c' * 64})
        args = operation.call_args.args
        self.assertIn('--read-only', args)
        self.assertIn('--no-healthcheck', args)
        self.assertIn('none', args)
        self.assertIn('/bin/sh', args)

    def test_content_duplicates_or_out_of_roots_are_rejected(self):
        for raw in ('c' * 64 + '  /secret/file\n', ('c' * 64 + '  /app/apps/api/dist/a\n') * 2):
            with self.subTest(raw=raw), patch.object(ci, 'docker', return_value=raw):
                with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONTENT_INVALID'):
                    ci.content(self.api_reference, ci.CONTENT_ROOTS['api-build'])

    def test_provenance_mismatch_is_rejected(self):
        value = {'Architecture': 'amd64', 'Id': 'sha256:' + 'c' * 64, 'Config': {'Labels': {
            'org.opencontainers.image.revision': self.record['candidateCommit'],
            'id-business-v2.source-tree': self.record['candidateTree'],
            ci.LABEL: ci.c.fingerprint(self.record), ci.RUNTIME_LABEL: ci.c.fingerprint(self.record),
            'id-business-v2.ci-only': 'NOT_FOR_RELEASE', 'id-business-v2.release-authority': 'false'}}}
        with patch.object(ci, 'docker', return_value=json.dumps([value])):
            self.assertEqual(ci.inspect(self.api_reference, self.record), value['Id'])
        for key in ('Architecture', 'Id'):
            bad = copy.deepcopy(value)
            bad[key] = 'invalid'
            with patch.object(ci, 'docker', return_value=json.dumps([bad])):
                with self.assertRaisesRegex(RuntimeError, 'IMAGE_IDENTITY_CHANGED'):
                    ci.inspect(self.api_reference, self.record)

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


class AllowlistTests(unittest.TestCase):
    def setUp(self):
        self.record = {'candidateCommit': 'a' * 40, 'candidateTree': 'b' * 40, 'releaseAuthority': False}
        self.producer = {'commit': 'a' * 40, 'sourceTree': 'b' * 40,
            'workflowRunId': '31', 'workflowRunAttempt': '2'}
        self.context = ci.ROOT / '.deploy/ci-online-recharge' / ('b' * 40) / '.deploy/production-release/online-recharge-component-build-context'
        self.commands, self.references = ci.execution_allowlist(self.context, self.record, self.producer)
        self.environment = {**ci.public_environment(), 'DOCKER_CONFIG': str(ci.ROOT / '.runtime/empty-ci-docker-config'),
            'TMPDIR': str(ci.ROOT / '.runtime/private-ci-tmp'), 'DOCKER_BUILDKIT': '1'}
        execution = patch.multiple(ci, ACTIVE_ENV=self.environment, ACTIVE_COMMANDS=self.commands,
            ACTIVE_REFERENCES=self.references)
        execution.start(); self.addCleanup(execution.stop)

    def test_only_exact_seven_builds_one_pull_and_four_runtime_aliases_are_registered(self):
        self.assertIsInstance(self.commands, frozenset)
        self.assertEqual(len(self.commands), 36)
        self.assertEqual(len(self.references), 12)
        self.assertEqual({name: sum(command[0] == name for command in self.commands)
            for name in ('build', 'pull', 'image', 'run', 'tag')},
            {'build': 7, 'pull': 1, 'image': 12, 'run': 12, 'tag': 4})
        self.assertEqual({command for command in self.commands if command[0] == 'pull'}, {
            ('pull', '--platform', 'linux/amd64', ci.ADMIN_RUNTIME_BASE)})
        for name in ci.IMAGES:
            alias = ci.SYNTHETIC_REPOSITORY + ':' + 'a' * 40 + '-31-2-' + name
            self.assertIn(('tag', 'id-online-ci:' + 'b' * 40 + '-' + name, alias), self.commands)
        default, references = ci.execution_allowlist(self.context, self.record)
        self.assertEqual(len(default), 24)
        self.assertEqual(len(references), 8)
        self.assertFalse(any(command[0] == 'tag' for command in default))

    def test_exact_commands_execute_with_only_explicit_public_environment(self):
        private = ('GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL',
            'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'DOCKER_HOST', 'DOCKER_CONTEXT',
            'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'HOME', 'CODEX_HOME')
        with patch.dict(os.environ, {name: 'PRIVATE_SENTINEL' for name in private}), \
             patch.object(ci.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'public')) as external:
            for command in self.commands:
                self.assertEqual(ci.approved_docker(*command), 'public')
            self.assertEqual(external.call_count, 36)
            for call in external.call_args_list:
                self.assertEqual(call.kwargs['env'], self.environment)
                self.assertFalse(set(private) & set(call.kwargs['env']))
                self.assertNotIn('PRIVATE_SENTINEL', json.dumps(call.kwargs['env']))
        self.assertIs(ci.ACTIVE_COMMANDS, self.commands)

    def test_unknown_references_extra_arguments_and_unsafe_commands_never_reach_subprocess(self):
        reference = 'id-online-ci:' + 'b' * 40 + '-api'
        selected_build = next(command for command in self.commands if command[0] == 'build')
        selected_run = next(command for command in self.commands if command[0] == 'run')
        commands = [(*command, '--extra-argument') for command in self.commands]
        commands += [('push', reference), ('login',), ('compose', 'up'),
            ('image', 'inspect', 'unknown'), ('pull', '--platform', 'linux/amd64', 'nginx:latest'),
            ('tag', reference, ci.SYNTHETIC_REPOSITORY + ':' + 'a' * 40 + '-32-2-api'),
            tuple(part.replace('000000000000', '079740175286') for part in
                next(command for command in self.commands if command[0] == 'tag')),
            (*selected_run[:-1], selected_run[-1] + '; arbitrary command'),
            (*selected_run[:4], 'host', *selected_run[5:]),
            tuple(part for part in selected_run if part not in ('--read-only', '--no-healthcheck')),
            (*selected_run, '--env', 'PRIVATE=sentinel'),
            (*selected_build, '--build-arg', 'PRIVATE=sentinel'),
            (*selected_build, '--secret', 'id=private'),
            tuple('/production/Dockerfile' if index and selected_build[index - 1] == '-f' else part
                for index, part in enumerate(selected_build)),
            ('image', 'inspect', []), ('image', 'inspect', None)]
        commands += [tuple(part for part in selected_run if part != flag)
            for flag in ('--read-only', '--no-healthcheck', '--pull=never')]
        commands.append((*selected_run[:3], *selected_run[5:]))
        with patch.object(ci.subprocess, 'run') as external:
            for command in commands:
                with self.subTest(operation=command[0]), self.assertRaisesRegex(RuntimeError, 'DOCKER_COMMAND_FORBIDDEN'):
                    ci.approved_docker(*command)
            with self.assertRaisesRegex(RuntimeError, 'DOCKER_COMMAND_FORBIDDEN'):
                ci.docker('image', 'inspect', 'unknown')
            external.assert_not_called()
        self.assertIs(ci.ACTIVE_COMMANDS, self.commands)

    def test_build_labels_targets_contexts_and_public_arguments_cannot_change(self):
        variants = []
        for command in self.commands:
            if command[0] != 'build': continue
            for index, part in enumerate(command):
                if index == len(command) - 1 or (index and command[index - 1] in
                    ('-f', '-t', '--target', '--label', '--build-arg')):
                    variants.append((*command[:index], part + '-changed', *command[index + 1:]))
        with patch.object(ci.subprocess, 'run') as external:
            for command in variants:
                with self.assertRaisesRegex(RuntimeError, 'DOCKER_COMMAND_FORBIDDEN'):
                    ci.approved_docker(*command)
            external.assert_not_called()

    def test_reference_revocation_and_injection_into_content_roots_are_refused(self):
        reference = 'id-online-ci:' + 'b' * 40 + '-api'
        with patch.object(ci.subprocess, 'run') as external:
            with patch.object(ci, 'ACTIVE_REFERENCES', self.references - {reference}):
                with self.assertRaisesRegex(RuntimeError, 'DOCKER_COMMAND_FORBIDDEN'):
                    ci.approved_docker('image', 'inspect', reference)
            with self.assertRaisesRegex(RuntimeError, 'DOCKER_COMMAND_FORBIDDEN'):
                ci.content(reference, ('/app/apps/api/dist; arbitrary command',))
            external.assert_not_called()

    def test_unadmitted_execution_fails_before_directory_or_subprocess_changes(self):
        record = {**self.record, 'ciOnly': True, 'notForRelease': True, 'candidateProducer': self.producer}
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(sys, 'platform', 'linux'), \
             patch.object(ci, 'ADMITTED_TREE', None), patch.object(Path, 'mkdir') as directory, \
             patch.object(ci.subprocess, 'run') as external:
            with self.assertRaisesRegex(RuntimeError, 'CI_ADMISSION_CHANGED'):
                ci.configure_execution(ci.ROOT / '.deploy/ci-online-recharge' / ('b' * 40), record, strict=True)
            directory.assert_not_called(); external.assert_not_called()

    def test_execution_uses_private_empty_docker_config_and_temporary_directory(self):
        runtime = ci.ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        record = {**self.record, 'ciOnly': True, 'notForRelease': True, 'candidateProducer': self.producer}
        with tempfile.TemporaryDirectory(prefix='online-ci-environment-', dir=runtime) as directory:
            root = Path(directory); target = root / '.deploy/ci-online-recharge' / record['candidateTree']
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'ADMITTED_TREE', record['candidateTree']), \
                 patch.object(sys, 'platform', 'linux'), patch.dict(os.environ, {'GITHUB_ACTIONS': 'true',
                     'GITHUB_RUN_ID': '31', 'GITHUB_RUN_ATTEMPT': '2', 'HOME': 'PRIVATE_SENTINEL',
                     'DOCKER_HOST': 'PRIVATE_SENTINEL'}), patch.object(ci.subprocess, 'run') as external:
                context = ci.configure_execution(target, record, strict=True)
                self.assertEqual(context, target / ci.load('online-recharge-component-runtime.py').CONTEXT)
                for key in ('DOCKER_CONFIG', 'TMPDIR'):
                    path = Path(ci.ACTIVE_ENV[key])
                    self.assertEqual(path.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(list(path.iterdir()), [])
                self.assertNotIn('HOME', ci.ACTIVE_ENV); self.assertNotIn('DOCKER_HOST', ci.ACTIVE_ENV)
                (Path(ci.ACTIVE_ENV['DOCKER_CONFIG']) / 'config.json').write_text('{}')
                with self.assertRaisesRegex(RuntimeError, 'DOCKER_CONFIG_NOT_EMPTY'):
                    ci.configure_execution(target, record, strict=True)
                self.assertIsNone(ci.ACTIVE_ENV)
                external.assert_not_called()


class EntryTests(unittest.TestCase):
    def test_default_workflow_contract_keeps_four_build_result_without_double_proof(self):
        record = {'candidateCommit': 'a' * 40, 'candidateTree': 'b' * 40, 'releaseAuthority': False}
        result = {'images': {name: {} for name in ci.IMAGES}, 'releaseAuthority': False}
        runtime = ci.ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='online-ci-default-', dir=runtime) as directory:
            root = Path(directory)
            target = root / '.deploy/ci-online-recharge' / record['candidateTree']; target.mkdir(parents=True)
            output = io.StringIO()
            with patch.object(ci, 'ROOT', root), patch.dict(os.environ, {'GITHUB_ACTIONS': 'true',
                 'CHECK_MODE': 'existing-quality-workflow', 'NODE_ENV': 'existing'}), \
                 patch.object(sys, 'platform', 'linux'), patch.object(sys, 'argv', ['ci-build']), \
                 patch.object(ci, 'source_projection', return_value=({}, record)), \
                 patch.object(ci, 'configure_execution', return_value=target / 'context') as configure, \
                 patch.object(ci, 'write_context'), patch.object(ci, 'build_and_verify', return_value=result), \
                 patch.object(ci, 'ci_entry_guard') as strict, patch.object(ci, 'double_build_proof') as double, \
                 redirect_stdout(output):
                ci.main()
            configure.assert_called_once_with(target, record, strict=False)
            strict.assert_not_called(); double.assert_not_called()
            self.assertEqual(json.loads((target / 'ci-build-only.json').read_bytes()), result)
            self.assertEqual(json.loads(output.getvalue())['status'], 'CI_BUILD_ONLY_VERIFIED')
            self.assertEqual(json.loads(output.getvalue())['imageCount'], 4)

    def test_explicit_mode_selects_double_proof_and_keeps_ci_only_result_filename(self):
        source = {'candidateCommit': 'a' * 40, 'candidateTree': 'b' * 40, 'releaseAuthority': False}
        record = {**source, 'ciOnly': True, 'notForRelease': True}
        result = {'images': {name: {} for name in ci.IMAGES}, 'releaseAuthority': False}
        runtime_module = ci.load('online-recharge-component-runtime.py')
        runtime = ci.ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='online-ci-explicit-routing-', dir=runtime) as directory:
            root = Path(directory)
            target = root / '.deploy/ci-online-recharge' / source['candidateTree']; target.mkdir(parents=True)
            output = io.StringIO()
            # Routing only: real proof acceptance belongs to the real Docker CI gate.
            with patch.object(ci, 'ROOT', root), patch.dict(os.environ, {'GITHUB_ACTIONS': 'true',
                 'GITHUB_RUN_ID': '31', 'GITHUB_RUN_ATTEMPT': '2'}), patch.object(sys, 'platform', 'linux'), \
                 patch.object(sys, 'argv', ['ci-build', '--ci-real-build-not-for-release',
                     '--admitted-source-tree', source['candidateTree']]), \
                 patch.object(ci, 'ci_entry_guard') as strict, \
                 patch.object(ci, 'source_projection', return_value=({}, source)), \
                 patch.object(ci, 'runtime_source_record', return_value=record), \
                 patch.object(ci, 'configure_execution', return_value=target / runtime_module.CONTEXT) as configure, \
                 patch.object(ci, 'write_context'), patch.object(ci, 'build_and_verify', return_value=result), \
                 patch.object(ci, 'double_build_proof', return_value={'routingFixture': True}) as double, \
                 redirect_stdout(output):
                ci.main()
            strict.assert_called_once_with(source['candidateTree'])
            configure.assert_called_once_with(target, record, strict=True)
            self.assertEqual(double.call_count, 1)
            self.assertEqual(json.loads((target / 'ci-build-only.json').read_bytes()), result)
            emitted = json.loads(output.getvalue())
            self.assertEqual(emitted['scope'], 'CI_ONLY'); self.assertTrue(emitted['notForRelease'])
            self.assertFalse(emitted['releaseAuthority'])
            self.assertEqual(emitted['status'], 'CI_BUILD_DOUBLE_PROOF_VERIFIED')

    def test_wrong_branch_base_event_and_malformed_head_stop_before_git_or_docker(self):
        event = {'pull_request': {'head': {'ref': ci.BRANCH, 'sha': 'a' * 40,
            'repo': {'full_name': 'wangchaozhuanyong/id-business-system'}},
            'base': {'sha': ci.CI_BASE, 'repo': {'full_name': 'wangchaozhuanyong/id-business-system'}}}}
        runtime = ci.ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='online-ci-admission-', dir=runtime) as directory:
            path = Path(directory) / 'event.json'
            environment = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'wangchaozhuanyong/id-business-system',
                'GITHUB_EVENT_NAME': 'pull_request', 'CHECK_MODE': 'ci-only', 'NODE_ENV': 'test',
                'GITHUB_EVENT_PATH': str(path)}
            variants = []
            for field, value in (('ref', 'codex/online-build-proof-reuse-20261014'), ('sha', '--unsafe')):
                changed = copy.deepcopy(event); changed['pull_request']['head'][field] = value
                variants.append(changed)
            changed = copy.deepcopy(event); changed['pull_request']['base']['sha'] = '619b04c240eed836b1db76a9fe330634de1fecbf'
            variants.append(changed)
            with patch.dict(os.environ, environment), patch.object(sys, 'platform', 'linux'), \
                 patch.object(ci, 'git') as git, patch.object(ci.subprocess, 'run') as external:
                for changed in variants:
                    path.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(RuntimeError, 'CI_ADMISSION_CHANGED'):
                        ci.ci_entry_guard('b' * 40)
                path.write_text(json.dumps(event))
                for field, value in (('GITHUB_EVENT_NAME', 'push'), ('CHECK_MODE', 'production'), ('NODE_ENV', 'production')):
                    with patch.dict(os.environ, {field: value}), self.assertRaisesRegex(RuntimeError, 'CI_ADMISSION_CHANGED'):
                        ci.ci_entry_guard('b' * 40)
                git.assert_not_called(); external.assert_not_called()

    def test_explicit_mode_requires_strict_admission_before_sources_or_builds(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(sys, 'platform', 'linux'), \
             patch.object(sys, 'argv', ['ci-build', '--ci-real-build-not-for-release',
                 '--admitted-source-tree', 'b' * 40]), \
             patch.object(ci, 'ci_entry_guard', side_effect=RuntimeError('ONLINE_RECHARGE_CI_CI_ADMISSION_CHANGED')) as strict, \
             patch.object(ci, 'source_projection') as source, patch.object(ci.subprocess, 'run') as external:
            with self.assertRaisesRegex(RuntimeError, 'CI_ADMISSION_CHANGED'): ci.main()
            strict.assert_called_once_with('b' * 40)
            source.assert_not_called(); external.assert_not_called()


if __name__ == '__main__':
    unittest.main()
