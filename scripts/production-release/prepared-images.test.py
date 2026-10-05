"""Build-only source evidence and same-commit reuse; all external calls mocked."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zlib
from contextlib import contextmanager
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepared_images', Path(__file__).with_name('reuse-images.py'))
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)
COMMIT = 'b' * 40
TREE = 'c' * 40
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
RUN_ID = '222'
ATTEMPT = '2'
SUCCESS_STEPS = ('Verify exact source and passing Quality Gate', 'Build images on the GitHub runner',
                 'Push immutable images', 'Validate release policy and reviewed seal selection',
                 'Verify build-only ECR target', 'Record prepared API image source', 'Save prepared API image source')
SKIPPED_STEPS = ('Check AWS identity and production target', 'Verify read-only SSM command access',
                 'Deploy through the production instance', 'Verify or maintain recoverable unused project image cache')


def fixture():
    run = {'id': 222, 'event': 'workflow_dispatch', 'path': '.github/workflows/production-release.yml',
           'head_branch': 'main', 'status': 'completed', 'conclusion': 'success',
           'head_sha': COMMIT, 'run_attempt': 2}
    jobs = {'jobs': [{'name': 'release', 'steps':
                      [{'name': name, 'conclusion': 'success'} for name in SUCCESS_STEPS] +
                      [{'name': name, 'conclusion': 'skipped'} for name in SKIPPED_STEPS]}]}
    manifest = {'formatVersion': 1, 'operation': images.PREPARE_OPERATION, 'policyId': images.POST_CLEANUP_POLICY,
                'sourceCommit': COMMIT, 'sourceTree': TREE, 'qualityRunId': '111',
                'expectedCurrent': images.POST_CLEANUP_BASELINE, 'runId': RUN_ID, 'runAttempt': ATTEMPT,
                'repository': REPOSITORY, 'images': {}}
    for service in ('api', 'migrate'):
        manifest['images'][service] = {'reference': f'{REPOSITORY}:{COMMIT}-{RUN_ID}-{ATTEMPT}-{service}',
                                      'revision': COMMIT, 'imageId': 'sha256:' + 'd' * 64,
                                      'digest': 'sha256:' + 'e' * 64}
    artifacts = {'artifacts': [{'name': f'post-cleanup-prepared-images-{RUN_ID}-{ATTEMPT}',
                               'expired': False, 'size_in_bytes': 2048,
                               'workflow_run': {'id': 222, 'head_branch': 'main', 'head_sha': COMMIT}}]}
    return run, jobs, manifest, artifacts


def validate(run, jobs, manifest):
    return images.validate_prepared_source(run, jobs, manifest, COMMIT, TREE, '111', RUN_ID, REPOSITORY)


def archive_fixture():
    run, jobs, manifest, artifacts = fixture()
    for step in jobs['jobs'][0]['steps']:
        step['name'] = step['name'].replace('prepared API image source', 'prepared order archive image source')
    manifest.update(operation=images.ORDER_ARCHIVE_PREPARE_OPERATION,
                    policyId=images.ORDER_ARCHIVE_POLICY, expectedCurrent=images.ORDER_ARCHIVE_BASELINE)
    manifest['images']['admin'] = {**manifest['images']['api'],
        'reference': f'{REPOSITORY}:{COMMIT}-{RUN_ID}-{ATTEMPT}-admin'}
    artifacts['artifacts'][0]['name'] = f'order-archive-prepared-images-{RUN_ID}-{ATTEMPT}'
    return run, jobs, manifest, artifacts


@contextmanager
def runtime():
    output = PROJECT / '.deploy'
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='prepared-image-test-', dir=output) as temporary:
        previous = Path.cwd()
        os.chdir(temporary)
        try:
            yield Path(temporary)
        finally:
            os.chdir(previous)


class PreparedImageSourceTests(unittest.TestCase):
    def test_exact_successful_preparation_is_reusable(self):
        run, jobs, manifest, _ = fixture()
        self.assertEqual(validate(run, jobs, manifest), (COMMIT, ATTEMPT))

    def test_other_commit_and_untrusted_runs_are_rejected(self):
        run, jobs, manifest, _ = fixture()
        for field, value in [('head_sha', 'a' * 40), ('event', 'push'), ('head_branch', 'feature'),
                             ('path', '.github/workflows/quality.yml'), ('status', 'in_progress'),
                             ('conclusion', 'failure'), ('id', 333), ('run_attempt', 0)]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                validate({**run, field: value}, jobs, manifest)

    def test_incomplete_or_duplicate_success_steps_are_rejected(self):
        run, jobs, manifest, _ = fixture()
        for name in SUCCESS_STEPS:
            for conclusion in ('failure', 'skipped'):
                altered = copy.deepcopy(jobs)
                next(step for step in altered['jobs'][0]['steps'] if step['name'] == name)['conclusion'] = conclusion
                with self.subTest(name=name, conclusion=conclusion), self.assertRaises(RuntimeError):
                    validate(run, altered, manifest)
            altered = copy.deepcopy(jobs)
            altered['jobs'][0]['steps'].append({'name': name, 'conclusion': 'success'})
            with self.subTest(duplicate=name), self.assertRaises(RuntimeError):
                validate(run, altered, manifest)

    def test_ssm_deploy_or_cache_activity_cannot_count_as_preparation(self):
        run, jobs, manifest, _ = fixture()
        for name in SKIPPED_STEPS:
            for conclusion in ('success', 'failure', 'cancelled'):
                altered = copy.deepcopy(jobs)
                next(step for step in altered['jobs'][0]['steps'] if step['name'] == name)['conclusion'] = conclusion
                with self.subTest(name=name, conclusion=conclusion), self.assertRaises(RuntimeError):
                    validate(run, altered, manifest)

    def test_manifest_operation_policy_source_quality_and_origin_must_match(self):
        run, jobs, manifest, _ = fixture()
        for field, value in [('formatVersion', 2), ('operation', 'release'), ('policyId', 'none'),
                             ('sourceCommit', 'a' * 40), ('sourceTree', 'a' * 40), ('qualityRunId', '112'),
                             ('expectedCurrent', 'a' * 40), ('runId', '333'), ('runAttempt', '1'),
                             ('repository', 'another-repository')]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                validate(run, jobs, {**manifest, field: value})
        with self.assertRaises(RuntimeError):
            validate(run, jobs, {**manifest, 'unreviewed': True})

    def test_only_api_and_migrate_complete_identities_are_accepted(self):
        run, jobs, manifest, _ = fixture()
        for service in ('api', 'migrate'):
            altered = copy.deepcopy(manifest)
            del altered['images'][service]
            with self.assertRaises(RuntimeError):
                validate(run, jobs, altered)
            for field, value in [('reference', 'wrong-reference'), ('revision', 'a' * 40),
                                 ('imageId', 'sha256:invalid'), ('digest', ''), ('extra', True)]:
                altered = copy.deepcopy(manifest)
                altered['images'][service][field] = value
                with self.subTest(service=service, field=field), self.assertRaises(RuntimeError):
                    validate(run, jobs, altered)
        altered = copy.deepcopy(manifest)
        altered['images']['admin'] = altered['images']['api']
        with self.assertRaises(RuntimeError):
            validate(run, jobs, altered)

    def test_artifact_is_unique_bounded_unexpired_and_bound_to_run_attempt(self):
        _, _, _, artifacts = fixture()
        name = images.prepared_artifact(artifacts, RUN_ID, ATTEMPT, COMMIT)
        self.assertEqual(name, f'post-cleanup-prepared-images-{RUN_ID}-{ATTEMPT}')
        for field, value in [('name', 'other-attempt'), ('expired', True), ('size_in_bytes', 0),
                             ('size_in_bytes', 65537), ('workflow_run', {'id': 333})]:
            altered = copy.deepcopy(artifacts)
            altered['artifacts'][0][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                images.prepared_artifact(altered, RUN_ID, ATTEMPT, COMMIT)
        for count in (0, 2):
            with self.assertRaises(RuntimeError):
                images.prepared_artifact({'artifacts': artifacts['artifacts'] * count}, RUN_ID, ATTEMPT, COMMIT)

    def test_actual_reuse_downloads_one_manifest_and_exports_same_commit_api_scope(self):
        run, jobs, manifest, artifacts = fixture()
        with runtime() as directory:
            env = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'QUALITY_RUN_ID': '111',
                   'RELEASE_REPOSITORY': REPOSITORY, 'RELEASE_OPERATION': 'release',
                   'GITHUB_ENV': str(directory / 'github.env')}
            def command(*args):
                if args[0] == 'bash':
                    return ''
                if args[:2] == ('gh', 'api'):
                    return json.dumps(artifacts)
                if args[:3] == ('gh', 'run', 'download'):
                    destination = Path(args[args.index('--dir') + 1])
                    self.assertTrue(destination.resolve().is_relative_to(directory))
                    (destination / 'prepared-images.json').write_text(json.dumps(manifest))
                    return ''
                self.fail('Unexpected external command')
            with patch.dict(os.environ, env, clear=True), patch.object(images, 'command', side_effect=command) as external:
                images.reuse_post_cleanup(run, jobs, 'wangchaozhuanyong/id-business-system', RUN_ID)
            self.assertEqual((directory / 'github.env').read_text(),
                             f'REUSE_IMAGE_COMMIT={COMMIT}\nREUSE_IMAGE_RUN_ID=222\nREUSE_IMAGE_RUN_ATTEMPT=2\nRELEASE_ADMIN_ONLY=false\n')
            self.assertFalse(list((directory / '.deploy/production-release').glob('prepared-image-source-*')))
            self.assertTrue(all(call.args[0] in ('bash', 'gh') for call in external.call_args_list))

    def test_wrong_source_reuse_never_downloads_or_exports_images(self):
        run, jobs, _, _ = fixture()
        with runtime() as directory, patch.dict(os.environ, {'RELEASE_COMMIT': COMMIT,
                'GITHUB_ENV': str(directory / 'github.env')}, clear=True), patch.object(images, 'command', return_value='') as external:
            with self.assertRaises(RuntimeError):
                images.reuse_post_cleanup({**run, 'head_sha': 'a' * 40}, jobs,
                                          'wangchaozhuanyong/id-business-system', RUN_ID)
            self.assertEqual(external.call_count, 1)
            self.assertFalse((directory / 'github.env').exists())

    def test_preparation_manifest_records_only_two_real_image_identities_without_production_calls(self):
        with runtime() as directory:
            env = {'RELEASE_OPERATION': images.PREPARE_OPERATION, 'RELEASE_COMMIT': COMMIT,
                   'SOURCE_TREE': TREE, 'QUALITY_RUN_ID': '111', 'GITHUB_RUN_ID': RUN_ID,
                   'GITHUB_RUN_ATTEMPT': ATTEMPT, 'RELEASE_REPOSITORY': REPOSITORY}
            def command(*args):
                if args[0] == 'bash':
                    return ''
                if args[:2] == ('git', 'rev-parse'):
                    return COMMIT if args[2] == 'HEAD' else TREE
                if args[:3] == ('docker', 'image', 'inspect'):
                    return 'sha256:' + 'd' * 64 if args[-1] == '{{.Id}}' else COMMIT
                if args[:3] == ('aws', 'ecr', 'describe-images'):
                    return 'sha256:' + 'e' * 64
                self.fail('Unexpected external command')
            with patch.dict(os.environ, env, clear=True), patch.object(images, 'command', side_effect=command) as external:
                images.write_prepared_manifest()
                with self.assertRaises(FileExistsError):
                    images.write_prepared_manifest()
            manifest = json.loads((directory / '.deploy/production-release/prepared-images.json').read_text())
            run, jobs, _, _ = fixture()
            self.assertEqual(validate(run, jobs, manifest), (COMMIT, ATTEMPT))
            self.assertFalse(any('ssm' in call.args for call in external.call_args_list))


class OrderArchivePreparedImageTests(unittest.TestCase):
    def validate(self, run, jobs, manifest):
        return images.validate_prepared_source(run, jobs, manifest, COMMIT, TREE, '111', RUN_ID,
                                               REPOSITORY, order_archive=True)

    def test_archive_preparation_requires_latest_runtime_without_reusing_stale_b8_manifest(self):
        run, jobs, manifest, _ = archive_fixture()
        manifest['expectedCurrent'] = '7f70688b9bf53a071a0a324ca558aeabc4ced2e3'
        self.assertEqual(self.validate(run, jobs, manifest), (COMMIT, ATTEMPT))
        manifest['expectedCurrent'] = 'b8d643450ffa9012ccc09ead15e4681e3dee98d0'
        with self.assertRaises(RuntimeError): self.validate(run, jobs, manifest)
        old_run, old_jobs, old_manifest, _ = fixture()
        self.assertEqual(validate(old_run, old_jobs, old_manifest), (COMMIT, ATTEMPT))

    def test_archive_requires_its_independent_complete_three_image_manifest(self):
        run, jobs, manifest, artifacts = archive_fixture()
        self.assertEqual(self.validate(run, jobs, manifest), (COMMIT, ATTEMPT))
        self.assertEqual(images.prepared_artifact(artifacts, RUN_ID, ATTEMPT, COMMIT, order_archive=True),
                         f'order-archive-prepared-images-{RUN_ID}-{ATTEMPT}')
        old_run, old_jobs, old_manifest, old_artifacts = fixture()
        with self.assertRaises(RuntimeError): self.validate(old_run, old_jobs, old_manifest)
        with self.assertRaises(RuntimeError): validate(run, jobs, manifest)
        with self.assertRaises(RuntimeError): images.prepared_artifact(old_artifacts, RUN_ID, ATTEMPT, COMMIT, order_archive=True)
        with self.assertRaises(RuntimeError): images.prepared_artifact(artifacts, RUN_ID, ATTEMPT, COMMIT)
        for service in images.ORDER_ARCHIVE_SERVICES:
            altered = copy.deepcopy(manifest); altered['images'].pop(service)
            with self.subTest(missing=service), self.assertRaises(RuntimeError): self.validate(run, jobs, altered)
        for service in ('auto-recharge', 'media-resolver'):
            altered = copy.deepcopy(manifest); altered['images'][service] = altered['images']['api']
            with self.subTest(extra=service), self.assertRaises(RuntimeError): self.validate(run, jobs, altered)

    def test_archive_cannot_reuse_failed_or_production_touching_preparation(self):
        run, jobs, manifest, _ = archive_fixture()
        for field, value in (('head_sha', 'a' * 40), ('conclusion', 'failure'), ('id', 999)):
            with self.subTest(field=field), self.assertRaises(RuntimeError): self.validate({**run, field: value}, jobs, manifest)
        for name in SKIPPED_STEPS:
            changed = copy.deepcopy(jobs)
            next(step for step in changed['jobs'][0]['steps'] if step['name'] == name)['conclusion'] = 'success'
            with self.subTest(name=name), self.assertRaises(RuntimeError): self.validate(run, changed, manifest)
        for service in images.ORDER_ARCHIVE_SERVICES:
            for field in ('revision', 'imageId', 'digest', 'reference'):
                changed = copy.deepcopy(manifest); changed['images'][service][field] = 'invalid'
                with self.subTest(service=service, field=field), self.assertRaises(RuntimeError): self.validate(run, jobs, changed)

    def test_archive_manifest_writer_records_only_three_images_and_no_production_commands(self):
        with runtime() as directory:
            env = {'HISTORICAL_EXCEPTION': images.ORDER_ARCHIVE_POLICY,
                'RELEASE_OPERATION': images.ORDER_ARCHIVE_PREPARE_OPERATION, 'RELEASE_COMMIT': COMMIT,
                'SOURCE_TREE': TREE, 'QUALITY_RUN_ID': '111', 'GITHUB_RUN_ID': RUN_ID,
                'GITHUB_RUN_ATTEMPT': ATTEMPT, 'RELEASE_REPOSITORY': REPOSITORY}
            def command(*args):
                if args[0] == 'bash': return ''
                if args[:2] == ('git', 'rev-parse'): return COMMIT if args[2] == 'HEAD' else TREE
                if args[:3] == ('docker', 'image', 'inspect'): return 'sha256:' + 'd' * 64 if args[-1] == '{{.Id}}' else COMMIT
                if args[:3] == ('aws', 'ecr', 'describe-images'): return 'sha256:' + 'e' * 64
                self.fail('Unexpected external command')
            with patch.dict(os.environ, env, clear=True), patch.object(images, 'command', side_effect=command) as external:
                images.write_prepared_manifest()
            manifest = json.loads((directory / '.deploy/production-release/prepared-images.json').read_text())
            run, jobs, _, _ = archive_fixture()
            self.assertEqual(self.validate(run, jobs, manifest), (COMMIT, ATTEMPT))
            self.assertFalse(any('ssm' in call.args for call in external.call_args_list))
            inspected = [call.args[3].rsplit('-', 1)[-1] for call in external.call_args_list
                         if call.args[:3] == ('docker', 'image', 'inspect')]
            self.assertEqual(set(inspected), set(images.ORDER_ARCHIVE_SERVICES))

    def test_archive_reuse_exports_exact_prepared_manifest_hash_for_independent_reviewed_seal(self):
        run, jobs, manifest, artifacts = archive_fixture()
        with runtime() as directory:
            env = {'RELEASE_COMMIT': COMMIT, 'SOURCE_TREE': TREE, 'QUALITY_RUN_ID': '111',
                'RELEASE_REPOSITORY': REPOSITORY, 'RELEASE_OPERATION': 'release',
                'GITHUB_ENV': str(directory / 'github.env')}
            raw = json.dumps(manifest)
            def command(*args):
                if args[0] == 'bash': return ''
                if args[:2] == ('gh', 'api'): return json.dumps(artifacts)
                if args[:3] == ('gh', 'run', 'download'):
                    (Path(args[args.index('--dir') + 1]) / 'prepared-images.json').write_text(raw)
                    return ''
                self.fail('Unexpected external command')
            with patch.dict(os.environ, env, clear=True), patch.object(images, 'command', side_effect=command):
                images.reuse_post_cleanup(run, jobs, 'wangchaozhuanyong/id-business-system', RUN_ID, order_archive=True)
            exported = (directory / 'github.env').read_text()
            self.assertIn(f'REUSE_IMAGE_COMMIT={COMMIT}\n', exported)
            self.assertIn('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256=' + images.hashlib.sha256(raw.encode()).hexdigest() + '\n', exported)


class DeterministicAdminBuildTests(unittest.TestCase):
    policy_path = 'deploy/aws/historical-finance-20261005-order-archive.json'

    @staticmethod
    def git_object(root, kind, raw):
        # Isolated fixture objects only; never touch the candidate index or commit it.
        payload = kind.encode() + b' ' + str(len(raw)).encode() + b'\0' + raw
        oid = hashlib.sha1(payload).hexdigest()
        target = root / '.git/objects' / oid[:2] / oid[2:]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(zlib.compress(payload))
        return oid

    @classmethod
    def git_tree(cls, root, entries):
        nested = {}
        for name, mode in entries.items():
            current = nested
            parts = name.split('/')
            for part in parts[:-1]: current = current.setdefault(part, {})
            current[parts[-1]] = (mode, cls.git_object(root, 'blob', (root / name).read_bytes()))
        def write_tree(values):
            raw = b''
            for name, value in sorted(values.items(), key=lambda item: (item[0] + ('/' if isinstance(item[1], dict) else '')).encode()):
                mode, oid = ('40000', write_tree(value)) if isinstance(value, dict) else value
                raw += mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(oid)
            return cls.git_object(root, 'tree', raw)
        return write_tree(nested)

    @classmethod
    def fixture_head(cls, root, entries):
        tree = cls.git_tree(root, entries)
        raw = (f'tree {tree}\nauthor Synthetic Fixture <fixture@invalid.test> 1 +0000\n'
               'committer Synthetic Fixture <fixture@invalid.test> 1 +0000\n\nLocal fixture only\n').encode()
        commit = cls.git_object(root, 'commit', raw)
        (root / '.git/HEAD').write_text(commit + '\n')
        return commit

    @contextmanager
    def fixture(self):
        output = PROJECT / '.deploy'; output.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='deterministic-admin-build-', dir=output) as directory:
            root = Path(directory)
            copied = ('scripts/production-release/build-images.sh', 'scripts/production-release/validate-release-selection.sh',
                      'scripts/lib/v2-order-archive-release-policy.mjs', 'scripts/lib/v2-release-history-policy.mjs',
                      'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-evidence.mjs', 'apps/admin/Dockerfile')
            modes = {name: '100644' for name in copied}
            modes['scripts/production-release/build-images.sh'] = '100755'
            for name, mode in modes.items():
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((PROJECT / name).read_bytes()); path.chmod(0o755 if mode == '100755' else 0o644)
            source = root / 'apps/admin/src/synthetic.ts'; source.parent.mkdir(parents=True)
            source.write_text('export const synthetic = 1;\n'); modes['apps/admin/src/synthetic.ts'] = '100644'
            (root / '.git/objects').mkdir(parents=True)
            (root / '.git/refs').mkdir()
            (root / '.git/config').write_text('[core]\nrepositoryformatversion = 0\nbare = false\n')
            projection = self.git_tree(root, modes)
            policy = {'id': images.ORDER_ARCHIVE_POLICY, 'scope': 'API_ADMIN_ORDER_ARCHIVE', 'userApproved': False,
                      'candidateBindings': {'sourceTree': projection,
                          'sourceSha256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in modes},
                          'sourceGitModes': dict(modes)}}
            path = root / self.policy_path; path.parent.mkdir(parents=True); path.write_text(json.dumps(policy))
            commit = self.fixture_head(root, {**modes, self.policy_path: '100644'})
            self.assertEqual(subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=root,
                                           check=True, capture_output=True, text=True).stdout.strip(), str(root))
            private = root / '.fixture'; private.mkdir()
            docker = private / 'docker'
            docker.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                              'with open(os.environ["LOCAL_DOCKER_LOG"], "a") as log:\n'
                              '    log.write(json.dumps(sys.argv[1:]) + "\\n")\n')
            docker.chmod(0o755)
            env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
            env.update(PATH=str(private) + os.pathsep + env['PATH'], RELEASE_REPOSITORY='synthetic.invalid/release',
                       RELEASE_COMMIT=commit, EXPECTED_CURRENT=images.ORDER_ARCHIVE_BASELINE,
                       GITHUB_RUN_ID=RUN_ID, GITHUB_RUN_ATTEMPT=ATTEMPT, GITHUB_ENV=str(private / 'github.env'),
                       HISTORICAL_EXCEPTION=images.ORDER_ARCHIVE_POLICY, RELEASE_OPERATION=images.ORDER_ARCHIVE_PREPARE_OPERATION,
                       RELEASE_ADMIN_ONLY='false', LOCAL_DOCKER_LOG=str(private / 'docker.jsonl'))
            for key in ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT',
                        'POST_CLEANUP_SEAL_SHA256', 'ORDER_ARCHIVE_SEAL_SHA256'):
                env[key] = ''
            yield root, policy, modes, env

    @staticmethod
    def build(root, env):
        result = subprocess.run(['bash', 'scripts/production-release/build-images.sh'], cwd=root, env=env,
                                capture_output=True, text=True, timeout=20)
        log = root / '.fixture/docker.jsonl'
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls

    def test_real_head_binding_sets_stable_id_only_on_archive_admin(self):
        with self.fixture() as (root, policy, _modes, env):
            result, calls = self.build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(calls), 3)
            self.assertEqual([call[call.index('-f') + 1] for call in calls],
                             ['apps/api/Dockerfile.mysql', 'apps/api/Dockerfile.mysql', 'apps/admin/Dockerfile'])
            stable = 'V2_BUILD_ID=v2-' + policy['candidateBindings']['sourceTree']
            self.assertNotIn(stable, calls[0]); self.assertNotIn(stable, calls[1]); self.assertIn(stable, calls[2])
            self.assertEqual([arg for call in calls for arg in call if arg.startswith('V2_BUILD_ID=')], [stable])
            result, repeated = self.build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(repeated[3:], calls)

    def test_invalid_policy_or_source_binding_stops_before_docker(self):
        mutations = ('id', 'scope', 'approved', 'tree-format', 'tree', 'hash', 'mode-binding', 'coverage',
                     'source', 'missing', 'mode', 'symlink', 'extra-head', 'head-link')
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.fixture() as (root, policy, modes, env):
                source = root / 'apps/admin/src/synthetic.ts'
                if mutation == 'id': policy['id'] = 'historical-finance-20261005-post-cleanup'
                elif mutation == 'scope': policy['scope'] = 'API_ONLY'
                elif mutation == 'approved': policy['userApproved'] = True
                elif mutation == 'tree-format': policy['candidateBindings']['sourceTree'] = 'a' * 64
                elif mutation == 'tree': policy['candidateBindings']['sourceTree'] = 'a' * 40
                elif mutation == 'hash': policy['candidateBindings']['sourceSha256']['apps/admin/src/synthetic.ts'] = 'a' * 64
                elif mutation == 'mode-binding': policy['candidateBindings']['sourceGitModes']['apps/admin/src/synthetic.ts'] = '100755'
                elif mutation == 'coverage': del policy['candidateBindings']['sourceSha256']['apps/admin/src/synthetic.ts']
                elif mutation == 'source': source.write_text('export const synthetic = 2;\n')
                elif mutation == 'missing': source.unlink()
                elif mutation == 'mode': source.chmod(0o755)
                elif mutation == 'symlink': source.unlink(); source.symlink_to(root / 'apps/admin/Dockerfile')
                elif mutation == 'extra-head':
                    (root / 'extra-source.ts').write_text('export const extra = true;\n')
                    self.fixture_head(root, {**modes, 'extra-source.ts': '100644', self.policy_path: '100644'})
                elif mutation == 'head-link':
                    self.fixture_head(root, {**modes, 'apps/admin/src/synthetic.ts': '120000', self.policy_path: '100644'})
                (root / self.policy_path).write_text(json.dumps(policy))
                result, calls = self.build(root, env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])
                self.assertFalse((root / '.fixture/github.env').exists())

    def test_rebound_changed_source_receives_different_build_id(self):
        with self.fixture() as (root, policy, modes, env):
            first, calls = self.build(root, env); self.assertEqual(first.returncode, 0, first.stderr)
            (root / 'apps/admin/src/synthetic.ts').write_text('export const synthetic = 2;\n')
            old_tree = policy['candidateBindings']['sourceTree']
            policy['candidateBindings']['sourceTree'] = self.git_tree(root, modes)
            policy['candidateBindings']['sourceSha256']['apps/admin/src/synthetic.ts'] = hashlib.sha256(
                (root / 'apps/admin/src/synthetic.ts').read_bytes()).hexdigest()
            (root / self.policy_path).write_text(json.dumps(policy))
            env['RELEASE_COMMIT'] = self.fixture_head(root, {**modes, self.policy_path: '100644'})
            result, updated = self.build(root, env); self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(policy['candidateBindings']['sourceTree'], old_tree)
            self.assertIn('V2_BUILD_ID=v2-' + old_tree, calls[-1])
            self.assertIn('V2_BUILD_ID=v2-' + policy['candidateBindings']['sourceTree'], updated[-1])

    def test_other_modes_keep_original_admin_arguments_and_post_cleanup_images(self):
        with self.fixture() as (root, _policy, _modes, env):
            (root / self.policy_path).write_text('{broken-unused-policy')
            for policy, operation, baseline, count in (
                    ('none', 'release', env['RELEASE_COMMIT'], 5),
                    (images.POST_CLEANUP_POLICY, images.PREPARE_OPERATION, images.POST_CLEANUP_BASELINE, 2)):
                (root / '.fixture/docker.jsonl').unlink(missing_ok=True)
                current = {**env, 'HISTORICAL_EXCEPTION': policy, 'RELEASE_OPERATION': operation, 'EXPECTED_CURRENT': baseline}
                result, calls = self.build(root, current)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(calls), count)
                self.assertFalse(any(arg.startswith('V2_BUILD_ID=') for call in calls for arg in call))
                if policy == 'none':
                    self.assertIn('AUTH_PROVIDER=local', calls[-1]); self.assertIn('VITE_API_BASE_URL=/api', calls[-1])
                else:
                    self.assertEqual([call[call.index('--target') + 1] for call in calls], ['runtime', 'migration'])


if __name__ == '__main__':
    unittest.main()
