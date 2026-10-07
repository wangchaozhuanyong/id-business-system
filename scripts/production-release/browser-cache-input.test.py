"""Test cache selection and the real CLI using only a project-local fake AWS command."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager

PROJECT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).with_name('browser-cache-input.py')
spec = importlib.util.spec_from_file_location('browser_cache_input', SOURCE)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
CURRENT = 'b' * 40
WORKER_REVISION = 'a' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
REFERENCE = f'{REPOSITORY}:{WORKER_REVISION}-123-1-auto-recharge'
IMAGE_ID = 'sha256:' + 'e' * 64
COMMAND_ID = '11111111-2222-4333-8444-555555555555'
INSTANCE_ID = 'i-0123456789abcdef0'
ENV_BEFORE = 'EXISTING_INPUT=preserved\n'


def manifest():
    return {'commit': CURRENT, 'images': {'auto-recharge': {'reference': REFERENCE, 'digest': IMAGE_ID}}}


def scenario():
    return {
        'send': {'value': {'Command': {'CommandId': COMMAND_ID}}},
        'wait': {},
        'receipt': {'value': {'CommandId': COMMAND_ID, 'InstanceId': INSTANCE_ID,
            'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': json.dumps({
                'reference': REFERENCE, 'imageId': IMAGE_ID, 'currentCommit': CURRENT})}},
        'ecr': {'value': {'images': [{'imageManifest': json.dumps({'config': {'digest': IMAGE_ID}})}],
                          'failures': []}},
    }


@contextmanager
def cli_fixture(values=None):
    output = PROJECT / '.runtime/docker-retention-browser-cache-20261007'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cache-input-cli-test-', dir=output) as directory:
        root = Path(directory)
        source = root / 'scripts/production-release/browser-cache-input.py'
        source.parent.mkdir(parents=True)
        source.write_bytes(SOURCE.read_bytes())
        commands = root / '.fixture'
        commands.mkdir()
        aws = commands / 'aws'
        aws.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['LOCAL_AWS_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[:2] == ['ssm', 'send-command']: stage = 'send'
elif args[:3] == ['ssm', 'wait', 'command-executed']: stage = 'wait'
elif args[:2] == ['ssm', 'get-command-invocation']: stage = 'receipt'
elif args[:2] == ['ecr', 'batch-get-image']: stage = 'ecr'
else: sys.exit(70)
value = json.loads(Path(os.environ['LOCAL_AWS_SCENARIO']).read_text())[stage]
if 'stderr' in value: print(value['stderr'], file=sys.stderr)
if 'stdout' in value: print(value['stdout'])
elif 'value' in value: print(json.dumps(value['value']))
sys.exit(value.get('rc', 0))
''')
        aws.chmod(0o755)
        plan = commands / 'scenario.json'
        plan.write_text(json.dumps(values if values is not None else scenario()))
        environment = root / 'github.env'
        environment.write_text(ENV_BEFORE)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('AWS_', 'RELEASE_', 'GITHUB_'))
               and key not in ('EXPECTED_CURRENT', 'PRODUCTION_INSTANCE_ID')}
        env.update(PATH=str(commands) + os.pathsep + env['PATH'], EXPECTED_CURRENT=CURRENT,
                   RELEASE_REPOSITORY=REPOSITORY, PRODUCTION_INSTANCE_ID=INSTANCE_ID,
                   GITHUB_ENV=str(environment), LOCAL_AWS_LOG=str(commands / 'aws.jsonl'),
                   LOCAL_AWS_SCENARIO=str(plan))
        yield root, env


def run_cli(root, env):
    result = subprocess.run([sys.executable, '-B', 'scripts/production-release/browser-cache-input.py'],
                            cwd=root, env=env, capture_output=True, text=True, timeout=15)
    log = root / '.fixture/aws.jsonl'
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return result, calls


class BrowserCacheSelectorTests(unittest.TestCase):
    def test_selects_the_retained_worker_from_the_exact_current_manifest(self):
        value = manifest()
        value['images']['auto-registration'] = {'reference': 'unrelated', 'digest': 'unrelated'}
        selected = cache.select_browser_cache(value, CURRENT, REPOSITORY)
        self.assertEqual(selected, {'reference': REFERENCE, 'imageId': IMAGE_ID, 'currentCommit': CURRENT})
        self.assertNotIn(CURRENT + '-', selected['reference'])

    def test_current_commit_must_be_valid_and_match_manifest(self):
        for expected in ('c' * 40, CURRENT.upper(), 'b' * 39, CURRENT + '\n', '', None):
            with self.subTest(expected=expected), self.assertRaises(RuntimeError):
                cache.select_browser_cache(manifest(), expected, REPOSITORY)
        value = manifest()
        value['commit'] = 'c' * 40
        with self.assertRaises(RuntimeError):
            cache.select_browser_cache(value, CURRENT, REPOSITORY)

    def test_repository_tag_and_config_identity_are_strict(self):
        for repository in ('foreign.invalid/release', REPOSITORY.replace('ap-northeast-1', 'us-east-1'),
                           REPOSITORY + '/other', REPOSITORY + '\n', None):
            with self.subTest(repository=repository), self.assertRaises(RuntimeError):
                cache.select_browser_cache(manifest(), CURRENT, repository)
        cases = [('reference', REPOSITORY + ':latest'),
                 ('reference', REPOSITORY + '@' + IMAGE_ID),
                 ('reference', REFERENCE.replace('-123-', '-0-')),
                 ('reference', REFERENCE.replace('-1-auto', '-0-auto')),
                 ('reference', REFERENCE.replace('-auto-recharge', '-auto-registration')),
                 ('reference', REFERENCE.replace(REPOSITORY, 'foreign.invalid/release')),
                 ('reference', REFERENCE + '\n'), ('reference', None),
                 ('digest', IMAGE_ID.upper()), ('digest', IMAGE_ID + '\n'),
                 ('digest', 'e' * 64), ('digest', 'sha256:' + 'e' * 63), ('digest', None)]
        for field, wrong in cases:
            with self.subTest(field=field, wrong=wrong), self.assertRaises(RuntimeError):
                value = manifest()
                value['images']['auto-recharge'][field] = wrong
                cache.select_browser_cache(value, CURRENT, REPOSITORY)

    def test_missing_or_malformed_manifest_never_selects_an_image(self):
        cases = (None, [], {}, {'commit': CURRENT}, {'commit': CURRENT, 'images': {}},
                 {'commit': CURRENT, 'images': []},
                 {'commit': CURRENT, 'images': {'auto-recharge': ['unexpected']}})
        for value in cases:
            with self.subTest(value=value), self.assertRaises(Exception):
                cache.select_browser_cache(value, CURRENT, REPOSITORY)


class BrowserCacheInputCliTests(unittest.TestCase):
    def assert_closed(self, values, forbidden_stage=None):
        with cli_fixture(values) as (root, env):
            result, calls = run_cli(root, env)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, 'Browser cache preparation failed; raw output suppressed\n')
            self.assertEqual(result.stderr, '')
            self.assertEqual((root / 'github.env').read_text(), ENV_BEFORE)
            self.assertFalse((root / '.deploy/production-release/browser-cache-input.json').exists())
            if forbidden_stage:
                self.assertFalse(any(call[:2] == forbidden_stage for call in calls))

    def test_success_verifies_ecr_before_writing_env_and_public_identity_receipt(self):
        with cli_fixture() as (root, env):
            result, calls = run_cli(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'Verified immutable production browser cache\n')
            self.assertEqual([call[:2] for call in calls], [
                ['ssm', 'send-command'], ['ssm', 'wait'], ['ssm', 'get-command-invocation'],
                ['ecr', 'batch-get-image']])
            request = json.loads(calls[0][calls[0].index('--cli-input-json') + 1])
            self.assertEqual(request['InstanceIds'], [INSTANCE_ID])
            self.assertEqual(request['DocumentName'], 'AWS-RunShellScript')
            self.assertEqual(request['Parameters']['executionTimeout'], ['60'])
            remote = request['Parameters']['commands'][0]
            self.assertIn('release-manifest.json', remote)
            self.assertNotIn('.env', remote)
            self.assertEqual(calls[1][calls[1].index('--command-id') + 1], COMMAND_ID)
            self.assertEqual(calls[2][calls[2].index('--instance-id') + 1], INSTANCE_ID)
            self.assertEqual(calls[3][calls[3].index('--repository-name') + 1], 'id-business-v2-release')
            self.assertEqual(calls[3][calls[3].index('--image-ids') + 1],
                             'imageTag=' + REFERENCE.split(':')[-1])
            self.assertEqual((root / 'github.env').read_text(), ENV_BEFORE
                + 'RELEASE_BROWSER_CACHE_IMAGE=' + REFERENCE + '\n'
                + 'RELEASE_BROWSER_CACHE_IMAGE_ID=' + IMAGE_ID + '\n')
            receipt = json.loads((root / '.deploy/production-release/browser-cache-input.json').read_text())
            self.assertEqual(receipt, {'reference': REFERENCE, 'imageId': IMAGE_ID,
                'currentCommit': CURRENT, 'readOnlyCommandId': COMMAND_ID})

    def test_failed_aws_send_wait_fetch_or_ecr_never_writes_env(self):
        for stage in ('send', 'wait', 'receipt', 'ecr'):
            with self.subTest(stage=stage):
                value = scenario()
                value[stage]['rc'] = 9
                value[stage]['stderr'] = 'fixture-private-error-must-not-be-forwarded'
                self.assert_closed(value)

    def test_non_success_status_response_code_or_foreign_ssm_identity_is_closed(self):
        changes = [('Status', 'InProgress'), ('Status', 'Failed'), ('Status', 'Cancelled'),
                   ('ResponseCode', 1), ('ResponseCode', -1), ('ResponseCode', False),
                   ('ResponseCode', True), ('ResponseCode', '0'), ('ResponseCode', None),
                   ('CommandId', 'different-command'), ('CommandId', None),
                   ('InstanceId', 'i-00000000000000000'), ('InstanceId', None)]
        for field, wrong in changes:
            with self.subTest(field=field, wrong=wrong):
                value = scenario()
                value['receipt']['value'][field] = wrong
                self.assert_closed(value, ['ecr', 'batch-get-image'])

    def test_changed_cache_baseline_tag_or_config_id_is_closed_before_ecr(self):
        changes = [('currentCommit', 'c' * 40), ('currentCommit', None),
                   ('reference', REPOSITORY + ':latest'), ('reference', 'foreign.invalid/release:latest'),
                   ('reference', None), ('imageId', 'e' * 64), ('imageId', None)]
        for field, wrong in changes:
            with self.subTest(field=field, wrong=wrong):
                value = scenario()
                returned = json.loads(value['receipt']['value']['StandardOutputContent'])
                returned[field] = wrong
                value['receipt']['value']['StandardOutputContent'] = json.dumps(returned)
                self.assert_closed(value, ['ecr', 'batch-get-image'])

    def test_missing_multiple_failed_or_mismatched_ecr_config_is_closed(self):
        changes = ({'images': [], 'failures': []},
                   {'images': [], 'failures': [{'failureCode': 'ImageNotFound'}]},
                   {'images': [copy.deepcopy(scenario()['ecr']['value']['images'][0])] * 2, 'failures': []},
                   {'images': [{'imageManifest': json.dumps({'config': {'digest': 'sha256:' + 'd' * 64}})}]},
                   {'images': [{'imageManifest': json.dumps({'config': {}})}]},
                   {'images': [{'imageManifest': 'not-json'}]})
        for wrong in changes:
            with self.subTest(wrong=wrong):
                value = scenario()
                value['ecr']['value'] = wrong
                self.assert_closed(value)

    def test_malformed_remote_or_aws_json_is_closed(self):
        for stage in ('send', 'receipt', 'ecr'):
            with self.subTest(stage=stage):
                value = scenario()
                value[stage]['stdout'] = 'not-json'
                self.assert_closed(value)
        for raw in ('not-json', 'null', '[]'):
            with self.subTest(remote=raw):
                value = scenario()
                value['receipt']['value']['StandardOutputContent'] = raw
                self.assert_closed(value)

    def test_missing_required_ci_inputs_fail_before_any_aws_call(self):
        for key in ('EXPECTED_CURRENT', 'RELEASE_REPOSITORY', 'PRODUCTION_INSTANCE_ID'):
            with self.subTest(key=key), cli_fixture() as (root, env):
                env.pop(key)
                result, calls = run_cli(root, env)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(calls, [])
                self.assertEqual((root / 'github.env').read_text(), ENV_BEFORE)
                self.assertFalse((root / '.deploy/production-release/browser-cache-input.json').exists())


if __name__ == '__main__':
    unittest.main()
