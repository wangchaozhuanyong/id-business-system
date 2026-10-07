"""Exercise the real image build selector with local Docker/Node command stubs."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import contextmanager

PROJECT = Path(__file__).resolve().parents[2]
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
CACHE_REVISION = 'a' * 40
CACHE_IMAGE = f'{REPOSITORY}:{CACHE_REVISION}-123-1-auto-recharge'
CACHE_IMAGE_ID = 'sha256:' + 'e' * 64
WORKER_DOCKERFILE = 'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile'


@contextmanager
def fixture():
    output = PROJECT / '.deploy'
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='browser-inline-cache-test-', dir=output) as directory:
        root = Path(directory)
        scripts = root / 'scripts/production-release'
        scripts.mkdir(parents=True)
        for name in ('build-images.sh', 'validate-release-selection.sh'):
            (scripts / name).write_bytes((PROJECT / 'scripts/production-release' / name).read_bytes())
        worker = root / WORKER_DOCKERFILE
        worker.parent.mkdir(parents=True)
        worker.write_bytes((PROJECT / WORKER_DOCKERFILE).read_bytes())
        commands = root / '.fixture'
        commands.mkdir()
        docker = commands / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['LOCAL_DOCKER_LOG'], 'a') as log:
    log.write(json.dumps({'args': args, 'buildkit': os.environ.get('DOCKER_BUILDKIT')}) + '\\n')
if args[0] == 'pull':
    sys.exit(int(os.environ.get('STUB_PULL_RESULT', '0')))
if args[:2] == ['image', 'inspect']:
    if os.environ.get('STUB_INSPECT_RESULT'):
        sys.exit(int(os.environ['STUB_INSPECT_RESULT']))
    print(os.environ['STUB_CACHE_METADATA'])
''')
        docker.chmod(0o755)
        node = commands / 'node'
        node.write_text("#!/usr/bin/env python3\nimport os\nprint(os.environ.get('STUB_ADMIN_ONLY', 'false'))\n")
        node.chmod(0o755)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('RELEASE_', 'REUSE_', 'GITHUB_', 'STUB_', 'GIT_'))
               and key not in ('HISTORICAL_EXCEPTION', 'ORDER_ARCHIVE_SEAL_SHA256',
                               'ORDER_ARCHIVE_PREPARED_IMAGES_SHA256', 'POST_CLEANUP_SEAL_SHA256',
                               'DOCKER_BUILDKIT')}
        env.update(PATH=str(commands) + os.pathsep + env['PATH'],
                   RELEASE_REPOSITORY=REPOSITORY, RELEASE_COMMIT='b' * 40,
                   EXPECTED_CURRENT='c' * 40, GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT='2',
                   GITHUB_ENV=str(root / 'github.env'), RELEASE_OPERATION='release',
                   HISTORICAL_EXCEPTION='none', LOCAL_DOCKER_LOG=str(root / 'docker.jsonl'),
                   STUB_CACHE_METADATA=CACHE_IMAGE_ID + ' amd64 ' + CACHE_REVISION)
        yield root, env


def build(root, env):
    result = subprocess.run(['bash', 'scripts/production-release/build-images.sh'],
                            cwd=root, env=env, capture_output=True, text=True, timeout=10)
    log = root / 'docker.jsonl'
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return result, calls


def worker_builds(calls):
    return [call for call in calls if call['args'][0] == 'build'
            and call['args'][call['args'].index('-t') + 1].endswith('-auto-recharge')]


class BrowserInlineCacheTests(unittest.TestCase):
    def test_cold_build_exports_inline_cache_only_on_the_worker(self):
        with fixture() as (root, env):
            result, calls = build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(calls), 5)
            self.assertTrue(all(call['args'][0] == 'build' for call in calls))
            worker = worker_builds(calls)
            self.assertEqual(len(worker), 1)
            self.assertIn('BUILDKIT_INLINE_CACHE=1', worker[0]['args'])
            self.assertIn('PYTHON_AUDIT_BUILD_ID=' + 'b' * 40 + '-456-2', worker[0]['args'])
            self.assertEqual(worker[0]['buildkit'], '1')
            self.assertNotIn('--cache-from', worker[0]['args'])
            for call in calls:
                if call not in worker:
                    self.assertNotIn('BUILDKIT_INLINE_CACHE=1', call['args'])
                    self.assertFalse(any(arg.startswith('PYTHON_AUDIT_BUILD_ID=') for arg in call['args']))
                    self.assertNotIn('--cache-from', call['args'])
                    self.assertIsNone(call['buildkit'])

    def test_reviewed_cache_is_pulled_and_checked_before_worker_build(self):
        with fixture() as (root, env):
            env.update(RELEASE_BROWSER_CACHE_IMAGE=CACHE_IMAGE, RELEASE_BROWSER_CACHE_IMAGE_ID=CACHE_IMAGE_ID)
            result, calls = build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls[1]['args'], ['pull', '--platform', 'linux/amd64', CACHE_IMAGE])
            self.assertEqual(calls[2]['args'][:3], ['image', 'inspect', '--format'])
            self.assertIn('{{.Id}}', calls[2]['args'][3])
            self.assertEqual(calls[2]['args'][-1], CACHE_IMAGE)
            worker = worker_builds(calls)
            self.assertEqual(len(worker), 1)
            self.assertEqual(worker[0]['args'][worker[0]['args'].index('--cache-from') + 1], CACHE_IMAGE)
            self.assertEqual(worker[0]['args'][worker[0]['args'].index('-t') + 1],
                             REPOSITORY + ':' + 'b' * 40 + '-456-2-auto-recharge')
            self.assertIn('org.opencontainers.image.revision=' + 'b' * 40, worker[0]['args'])
            self.assertIn('BUILDKIT_INLINE_CACHE=1', worker[0]['args'])
            self.assertEqual(worker[0]['buildkit'], '1')
            for call in calls:
                if call['args'][0] == 'build' and call not in worker:
                    self.assertNotIn('--cache-from', call['args'])

    def test_audit_cache_key_changes_with_the_release_run(self):
        with fixture() as (root, env):
            env.update(RELEASE_BROWSER_CACHE_IMAGE=CACHE_IMAGE, RELEASE_BROWSER_CACHE_IMAGE_ID=CACHE_IMAGE_ID)
            result, initial = build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            env['GITHUB_RUN_ID'] = '457'
            result, repeated = build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            first = worker_builds(initial)[0]['args']
            second = worker_builds(repeated[len(initial):])[0]['args']
            self.assertIn('PYTHON_AUDIT_BUILD_ID=' + 'b' * 40 + '-456-2', first)
            self.assertIn('PYTHON_AUDIT_BUILD_ID=' + 'b' * 40 + '-457-2', second)
            self.assertEqual(first[first.index('--cache-from') + 1],
                             second[second.index('--cache-from') + 1])

    def test_foreign_mutable_or_malformed_cache_stops_before_docker(self):
        invalid = ('foreign.invalid/release:' + CACHE_REVISION + '-123-1-auto-recharge',
                   REPOSITORY + ':latest', REPOSITORY + '@sha256:' + 'a' * 64,
                   REPOSITORY + ':' + CACHE_REVISION + '-123-1-auto-registration',
                   REPOSITORY + ':' + CACHE_REVISION + '-0-1-auto-recharge',
                   REPOSITORY + ':' + CACHE_REVISION + '-123-0-auto-recharge',
                   REPOSITORY + ':' + CACHE_REVISION.upper() + '-123-1-auto-recharge',
                   CACHE_IMAGE + '\n', CACHE_IMAGE + ',ref=foreign.invalid/cache',
                   CACHE_IMAGE + '$(touch should-not-exist)')
        for reference in invalid:
            with self.subTest(reference=reference), fixture() as (root, env):
                env['RELEASE_BROWSER_CACHE_IMAGE'] = reference
                env['RELEASE_BROWSER_CACHE_IMAGE_ID'] = CACHE_IMAGE_ID
                result, calls = build(root, env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])
                self.assertFalse((root / 'should-not-exist').exists())

    def test_missing_or_malformed_reviewed_identity_stops_before_docker(self):
        cases = ({'RELEASE_BROWSER_CACHE_IMAGE': CACHE_IMAGE},
                 {'RELEASE_BROWSER_CACHE_IMAGE_ID': CACHE_IMAGE_ID},
                 {'RELEASE_BROWSER_CACHE_IMAGE': CACHE_IMAGE, 'RELEASE_BROWSER_CACHE_IMAGE_ID': 'e' * 64},
                 {'RELEASE_BROWSER_CACHE_IMAGE': CACHE_IMAGE, 'RELEASE_BROWSER_CACHE_IMAGE_ID': CACHE_IMAGE_ID.upper()},
                 {'RELEASE_BROWSER_CACHE_IMAGE': CACHE_IMAGE, 'RELEASE_BROWSER_CACHE_IMAGE_ID': CACHE_IMAGE_ID + '\n'})
        for values in cases:
            with self.subTest(values=values), fixture() as (root, env):
                env.update(values)
                result, calls = build(root, env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_pull_failure_never_falls_back_to_a_cold_worker_build(self):
        with fixture() as (root, env):
            env.update(RELEASE_BROWSER_CACHE_IMAGE=CACHE_IMAGE,
                       RELEASE_BROWSER_CACHE_IMAGE_ID=CACHE_IMAGE_ID, STUB_PULL_RESULT='1')
            result, calls = build(root, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls[-1]['args'][0], 'pull')
            self.assertEqual(worker_builds(calls), [])

    def test_historical_dockerfile_without_fresh_audit_rejects_cache_input(self):
        with fixture() as (root, env):
            dockerfile = root / WORKER_DOCKERFILE
            legacy = dockerfile.read_text().replace('ARG PYTHON_AUDIT_BUILD_ID=local\n', '')
            legacy = legacy.replace('RUN test -n "$PYTHON_AUDIT_BUILD_ID" \\\n  && python', 'RUN python')
            dockerfile.write_text(legacy)
            env.update(RELEASE_BROWSER_CACHE_IMAGE=CACHE_IMAGE, RELEASE_BROWSER_CACHE_IMAGE_ID=CACHE_IMAGE_ID)
            result, calls = build(root, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('pull', [call['args'][0] for call in calls])
            self.assertEqual(worker_builds(calls), [])
            env.pop('RELEASE_BROWSER_CACHE_IMAGE')
            env.pop('RELEASE_BROWSER_CACHE_IMAGE_ID')
            result, calls = build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(worker_builds(calls)), 1)
            self.assertNotIn('--cache-from', worker_builds(calls)[0]['args'])

    def test_wrong_architecture_revision_or_failed_inspect_stops_worker_build(self):
        cases = ({'STUB_CACHE_METADATA': CACHE_IMAGE_ID + ' arm64 ' + CACHE_REVISION},
                 {'STUB_CACHE_METADATA': CACHE_IMAGE_ID + ' amd64 ' + 'd' * 40},
                 {'STUB_CACHE_METADATA': CACHE_IMAGE_ID + ' amd64 <no value>'},
                 {'STUB_CACHE_METADATA': CACHE_IMAGE_ID + ' amd64 ' + CACHE_REVISION + '\nextra'},
                 {'STUB_CACHE_METADATA': 'sha256:' + 'd' * 64 + ' amd64 ' + CACHE_REVISION},
                 {'STUB_INSPECT_RESULT': '1'})
        for values in cases:
            with self.subTest(values=values), fixture() as (root, env):
                env.update(RELEASE_BROWSER_CACHE_IMAGE=CACHE_IMAGE,
                           RELEASE_BROWSER_CACHE_IMAGE_ID=CACHE_IMAGE_ID, **values)
                result, calls = build(root, env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls[-1]['args'][:2], ['image', 'inspect'])
                self.assertEqual(worker_builds(calls), [])

    def test_admin_only_build_does_not_pull_a_browser_cache(self):
        with fixture() as (root, env):
            env.update(RELEASE_BROWSER_CACHE_IMAGE=CACHE_IMAGE,
                       RELEASE_BROWSER_CACHE_IMAGE_ID=CACHE_IMAGE_ID, STUB_ADMIN_ONLY='true')
            result, calls = build(root, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['args'][0], 'build')
            self.assertTrue(calls[0]['args'][calls[0]['args'].index('-t') + 1].endswith('-admin'))
            self.assertNotIn('--cache-from', calls[0]['args'])

    def test_audit_and_business_code_cannot_invalidate_the_browser_install_layer(self):
        dockerfile = (PROJECT / WORKER_DOCKERFILE).read_text()
        install = dockerfile.index('RUN pip install')
        installation_end = dockerfile.index('COPY scripts/audit-python-dependencies.py', install)
        inputs = [line for line in dockerfile[:install].splitlines() if line.startswith('COPY ')]
        self.assertEqual(inputs, [
            'COPY apps/api/src/id-business-v2/auto-recharge/worker/requirements.lock.txt ./',
            'COPY apps/api/src/id-business-v2/auto-recharge/worker/install_fingerprint_browser.py ./'])
        browser_layer = dockerfile[install:installation_end]
        for preserved in ('pip==26.2.1', 'pip check', 'playwright install --with-deps chromium',
                          'playwright install-deps firefox', 'xauth unzip',
                          'install_fingerprint_browser.py --destination /opt/camoufox --platform lin.x86_64'):
            self.assertIn(preserved, browser_layer)
        self.assertGreater(dockerfile.index('COPY --chown=recharge:recharge'), installation_end)
        audit_key = dockerfile.index('ARG PYTHON_AUDIT_BUILD_ID=local')
        self.assertGreater(audit_key, dockerfile.index('COPY --chown=recharge:recharge'))
        self.assertGreater(dockerfile.index('RUN test -n "$PYTHON_AUDIT_BUILD_ID"'), audit_key)
        self.assertGreater(dockerfile.index('python /opt/security/audit-python-dependencies.py'), audit_key)
        self.assertIn('--output /opt/security/python-dependencies.json', dockerfile)
        self.assertIn('\nUSER recharge\n', dockerfile)


if __name__ == '__main__':
    unittest.main()
