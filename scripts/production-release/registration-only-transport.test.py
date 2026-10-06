"""Exercise release shell transport with local executables; no Docker/AWS writes."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import textwrap
import unittest

PROJECT = Path(__file__).resolve().parents[2]
PROFILE = 'registration-worker-b8-80-20261006'
BASELINE = '80bddb1a8d8fa1b5f768a146d90f2bc1fe77ac9b'
COMMIT = 'c' * 40
TREE = 'a' * 40
REPOSITORY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
CONTEXT = '.deploy/production-release/registration-build-context'
WORKER = 'apps/api/src/id-business-v2/auto-recharge/worker'
PROFILE_FILE = 'deploy/aws/' + PROFILE + '.json'


class TransportTests(unittest.TestCase):
    profile = PROFILE
    baseline = BASELINE
    profile_file = PROFILE_FILE
    scope_args = []
    release_flag = '--registration-worker-b8-80'
    artifact_step = 'Save fixed registration Worker build projection'
    readback_step = 'Verify fixed registration deployment independently'
    readback_parameters = 'fixed-registration-readback.json'
    output_directory = '.runtime/registration-password-release-20261006/transport'
    @contextmanager
    def fixture(self):
        output = PROJECT / self.output_directory
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='fixture-', dir=output) as directory:
            root = Path(directory)
            for name in ('build-images.sh', 'push-images.sh', 'dispatch.sh', 'validate-release-selection.sh'):
                target = root / 'scripts/production-release' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((PROJECT / 'scripts/production-release' / name).read_bytes())
            profile = root / self.profile_file
            profile.parent.mkdir(parents=True)
            profile.write_text(json.dumps({'id': self.profile, 'fixtureOnly': True}))
            source = root / 'scripts/production-release/remote-deploy.py'
            source.write_text('''import os, json
def validate_fixed_registration_readback_projection(value, commit, tree, profile, *, profile_id='registration-worker-b8-80-20261006'):
    expected={'status':'VERIFIED','currentCommit':commit,'sourceTree':tree,'profileSha256':profile}
    if profile_id != os.environ['LOCAL_TEST_PROFILE'] or value != expected or set(value) != set(expected):
        raise ValueError('Synthetic closed receipt changed')
''')
            private = root / '.fixture'
            private.mkdir()
            tool = '''import json, os, pathlib, sys
name=pathlib.Path(sys.argv[0]).name;args=sys.argv[1:]
with open(os.environ['LOCAL_TOOL_LOG'],'a') as target:
    target.write(json.dumps([name,args])+'\\n')
if name=='python3':
    if args and args[0].endswith('remote-deploy.py'):
        if os.environ.get('LOCAL_SCOPE_FAILURE')=='true':sys.exit(19)
        if args[1:] in (['--prepare-fixed-registration-build'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-956-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-85-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-86-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-87-20261006']):
            context=pathlib.Path('.deploy/production-release/registration-build-context')
            dockerfile=context/'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile'
            dockerfile.parent.mkdir(parents=True);dockerfile.write_text('FROM synthetic-fixture\\n')
            (context.parent/'registration-build-projection.json').write_text('{}')
        sys.exit(0)
    os.execv(os.environ['LOCAL_REAL_PYTHON'],[os.environ['LOCAL_REAL_PYTHON'],*args])
if name=='node':print(os.environ.get('LOCAL_ADMIN_ONLY','false'));sys.exit(0)
if name=='docker':
    if args[:2]==['image','inspect']:print(os.environ['RELEASE_COMMIT'])
    if args and args[0]=='login':sys.stdin.read()
    sys.exit(0)
if name=='aws':
    if args[:2]==['ecr','get-login-password']:print('synthetic-fixture-only')
    elif args[:2]==['ecr','describe-images']:print('sha256:'+'a'*64)
    elif 'send-command' in args:print('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    elif 'wait' in args:pass
    elif 'get-command-invocation' in args:
        query=args[args.index('--query')+1]
        print('Success' if query=='Status' else os.environ.get('LOCAL_READBACK_OUTPUT','synthetic-deployed'))
    else:sys.exit(23)
'''
            for name in ('docker', 'aws', 'python3', 'node'):
                executable = private / name
                executable.write_text('#!' + sys.executable + '\n' + tool)
                executable.chmod(0o755)
            env = dict(PATH=str(private) + os.pathsep + os.defpath, LANG='C.UTF-8',
                LOCAL_REAL_PYTHON=sys.executable, LOCAL_TEST_PROFILE=self.profile, LOCAL_TOOL_LOG=str(private / 'calls.jsonl'),
                RELEASE_COMMIT=COMMIT, EXPECTED_CURRENT=self.baseline, SOURCE_TREE=TREE,
                QUALITY_RUN_ID='123', RELEASE_REPOSITORY=REPOSITORY, GITHUB_RUN_ID='456',
                GITHUB_RUN_ATTEMPT='1', GITHUB_ENV=str(private / 'github.env'),
                HISTORICAL_EXCEPTION=self.profile, RELEASE_OPERATION='release', RELEASE_ADMIN_ONLY='false',
                AWS_REGION='ap-northeast-1', PRODUCTION_INSTANCE_ID='i-synthetic',
                REUSE_IMAGE_RUN='', REUSE_IMAGE_COMMIT='', REUSE_IMAGE_RUN_ID='', REUSE_IMAGE_RUN_ATTEMPT='',
                POST_CLEANUP_SEAL_SHA256='', ORDER_ARCHIVE_SEAL_SHA256='')
            yield root, env

    @staticmethod
    def run_script(root, env, name):
        return subprocess.run(['bash', 'scripts/production-release/' + name], cwd=root, env=env,
                              capture_output=True, text=True, timeout=20)

    @staticmethod
    def calls(env, tool=None):
        path = Path(env['LOCAL_TOOL_LOG'])
        entries = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [args for name, args in entries if tool is None or name == tool]

    @staticmethod
    def workflow_step(name):
        workflow = (PROJECT / '.github/workflows/production-release.yml').read_text()
        match = re.search(r'^      - name: ' + re.escape(name)
                          + r'\n(.*?)(?=^      - name: |\Z)', workflow, re.M | re.S)
        if not match:
            raise AssertionError('Missing workflow step: ' + name)
        block = match.group(1)
        return block, textwrap.dedent(block.split('        run: |\n', 1)[1]) if '        run: |\n' in block else ''

    def test_registration_build_uses_only_prepared_worker_context(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'build-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = self.calls(env, 'docker')
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], 'build')
            self.assertEqual(calls[0][-1], CONTEXT)
            self.assertEqual(calls[0][calls[0].index('-f') + 1], CONTEXT + '/' + WORKER + '/Dockerfile')
            self.assertEqual(calls[0][calls[0].index('-t') + 1], REPOSITORY + ':' + COMMIT + '-456-1-auto-recharge')
            self.assertEqual(self.calls(env, 'python3'), [
                ['scripts/production-release/remote-deploy.py', '--check-fixed-registration-scope'] + self.scope_args,
                ['scripts/production-release/remote-deploy.py', '--prepare-fixed-registration-build'] + self.scope_args])
            self.assertEqual(Path(env['GITHUB_ENV']).read_text(), 'RELEASE_ADMIN_ONLY=false\n')

    def test_registration_push_verifies_and_pushes_only_worker_tag(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'push-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = REPOSITORY + ':' + COMMIT + '-456-1-auto-recharge'
            self.assertEqual([call for call in self.calls(env, 'docker') if call[0] == 'push'], [['push', expected]])
            self.assertEqual(self.calls(env, 'python3'), [
                ['scripts/production-release/remote-deploy.py', '--check-fixed-registration-scope'] + self.scope_args])
            self.assertEqual(len([call for call in self.calls(env, 'aws') if call[:2] == ['ecr', 'describe-images']]), 1)

    def test_scope_failure_stops_before_build_push_or_dispatch(self):
        for script in ('build-images.sh', 'push-images.sh', 'dispatch.sh'):
            with self.subTest(script=script), self.fixture() as (root, env):
                env['LOCAL_SCOPE_FAILURE'] = 'true'
                result = self.run_script(root, env, script)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(env, 'python3'), [
                    ['scripts/production-release/remote-deploy.py', '--check-fixed-registration-scope'] + self.scope_args])
                self.assertEqual(self.calls(env, 'docker'), [])
                self.assertEqual(self.calls(env, 'aws'), [])

    def test_wrong_baseline_reuse_admin_and_operations_fail_before_transport(self):
        mutations = [('EXPECTED_CURRENT', 'd' * 40),
                     ('EXPECTED_CURRENT', '3ca300486d0edfadda83c094a48474a63959fce7'),
                     ('HISTORICAL_EXCEPTION', 'registration-worker-b8-3ca-20261006'),
                     ('RELEASE_ADMIN_ONLY', 'true'),
                     ('RELEASE_OPERATION', 'prepare_order_archive_release')]
        mutations += [(key, '123') for key in ('REUSE_IMAGE_RUN', 'REUSE_IMAGE_COMMIT',
                                               'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT')]
        for script in ('build-images.sh', 'push-images.sh', 'dispatch.sh'):
            for key, value in mutations:
                with self.subTest(script=script, field=key), self.fixture() as (root, env):
                    env[key] = value
                    result = self.run_script(root, env, script)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.calls(env, 'docker'), [])
                    self.assertEqual(self.calls(env, 'aws'), [])

    def test_dispatch_binds_only_registration_scope_with_fresh_image_identity(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'dispatch.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            parameters = json.loads((root / '.deploy/production-release/ssm-456.json').read_text())
            command = shlex.split(parameters['commands'][-1])
            self.assertIn(self.release_flag, command)
            self.assertNotIn('--admin-only', command)
            for field, value in (('--commit', COMMIT), ('--expected-current', self.baseline),
                                 ('--image-commit', COMMIT), ('--image-run-id', '456'), ('--image-run-attempt', '1')):
                self.assertEqual(command[command.index(field) + 1], value)

    def test_ordinary_build_and_push_keep_existing_service_set_and_context(self):
        with self.fixture() as (root, env):
            env['HISTORICAL_EXCEPTION'] = 'none'
            result = self.run_script(root, env, 'build-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            builds = self.calls(env, 'docker')
            self.assertEqual(len(builds), 5)
            self.assertEqual([entry[-1] for entry in builds], ['.'] * 5)
            self.assertEqual([entry[entry.index('-t') + 1].rsplit('-', 1)[-1] for entry in builds],
                             ['resolver', 'recharge', 'api', 'migrate', 'admin'])
            result = self.run_script(root, env, 'push-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len([call for call in self.calls(env, 'docker') if call[0] == 'push']), 5)

    def test_workflow_keeps_quality_lock_and_skips_only_fixed_release_cache(self):
        workflow = (PROJECT / '.github/workflows/production-release.yml').read_text()
        self.assertIn('group: id-business-v2-production-release\n  cancel-in-progress: false', workflow)
        self.assertIn('run: bash scripts/production-release/check-source.sh', workflow)
        block, _script = self.workflow_step('Verify or maintain recoverable unused project image cache')
        self.assertIn("inputs.historical_exception != '" + self.profile + "'", block)
        block, _script = self.workflow_step(self.artifact_step)
        self.assertIn("inputs.operation == 'release' && inputs.historical_exception == '" + self.profile + "'", block)
        self.assertIn('path: .deploy/production-release/registration-build-projection.json', block)

    def test_readback_uses_bound_verifier_and_closed_receipt_filter(self):
        _block, script = self.workflow_step(self.readback_step)
        with self.fixture() as (root, env):
            profile_sha = hashlib.sha256((root / self.profile_file).read_bytes()).hexdigest()
            receipt = {'status': 'VERIFIED', 'currentCommit': COMMIT, 'sourceTree': TREE, 'profileSha256': profile_sha}
            env['LOCAL_READBACK_OUTPUT'] = 'FIXED_REGISTRATION_RELEASE_VERIFIED ' + json.dumps(receipt)
            result = subprocess.run(['bash', '-c', script], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), receipt)
            parameters = json.loads((root / '.deploy/production-release' / self.readback_parameters).read_text())
            command = shlex.split(parameters['commands'][0])
            self.assertEqual(command[:2], ['python3', '-c'])
            compile(command[2], '<bound-registration-readback>', 'exec')
            self.assertIn(hashlib.sha256((root / 'scripts/production-release/remote-deploy.py').read_bytes()).hexdigest(), command[2])
            self.assertIn('--check-fixed-registration-deployment', command[2])
            self.assertIn('--registration-profile-sha256', command[2])
            self.assertIn(profile_sha, command[2])
            if self.scope_args:
                self.assertIn('\"--registration-profile\",\"' + self.profile + '\"', command[2])
            staging = '/opt/id-business-v2/.staging/oidc-' + COMMIT + '/remote-deploy.py'
            local_source = root / 'scripts/production-release/remote-deploy.py'
            local_verifier = command[2].replace(repr(staging), repr(str(local_source)))
            verified = subprocess.run([sys.executable, '-c', local_verifier], cwd=root,
                                      capture_output=True, text=True, timeout=10)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            with local_source.open('a') as target:
                target.write("\nraise RuntimeError('RAW_SECRET_SENTINEL')\n")
            changed = subprocess.run([sys.executable, '-c', local_verifier], cwd=root,
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(changed.returncode, 0)
            self.assertIn('Fixed registration verifier source unavailable', changed.stderr)
            self.assertNotIn('RAW_SECRET_SENTINEL', changed.stdout + changed.stderr)

    def test_readback_rejects_unknown_duplicate_and_raw_output_without_leaks(self):
        _block, script = self.workflow_step(self.readback_step)
        values = ['RAW_SECRET_SENTINEL', 'FIXED_REGISTRATION_RELEASE_VERIFIED {"status":"VERIFIED","status":"RAW_SECRET_SENTINEL"}',
                  'FIXED_REGISTRATION_RELEASE_VERIFIED {"unexpected":"RAW_SECRET_SENTINEL"}',
                  'FIXED_REGISTRATION_RELEASE_VERIFIED NaN', 'FIXED_REGISTRATION_RELEASE_VERIFIED ' + 'X' * 8193]
        for value in values:
            with self.subTest(kind=value[:60]), self.fixture() as (root, env):
                env['LOCAL_READBACK_OUTPUT'] = value
                result = subprocess.run(['bash', '-c', script], cwd=root, env=env,
                                        capture_output=True, text=True, timeout=20)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('RAW_SECRET_SENTINEL', result.stdout + result.stderr)
                self.assertEqual(result.stdout, '')


class Registration956TransportTests(TransportTests):
    profile = 'registration-worker-956-20261006'
    baseline = '9560d8038a39d4ded1e560d484bdcb941a5d9c43'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-956'
    artifact_step = 'Save fixed 956 registration Worker build projection'
    readback_step = 'Verify fixed 956 registration deployment independently'
    readback_parameters = 'fixed-registration-956-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-arbitrary'),
                   ('EXPECTED_CURRENT',BASELINE),('RELEASE_OPERATION','verify_unused_cache'),
                   ('POST_CLEANUP_SEAL_SHA256','a'*64),('ORDER_ARCHIVE_SEAL_SHA256','a'*64),
                   ('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256','a'*64)]
        for script in ('build-images.sh','push-images.sh','dispatch.sh'):
            for field,value in mutations:
                with self.subTest(script=script,field=field),self.fixture() as (root,env):
                    env[field]=value
                    result=self.run_script(root,env,script)
                    self.assertNotEqual(result.returncode,0)
                    self.assertEqual(self.calls(env,'aws'),[])
                    self.assertEqual(self.calls(env,'docker'),[])

    def test_956_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-956-20261006'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


class Registration85TransportTests(TransportTests):
    profile = 'registration-worker-85-20261006'
    output_directory = '.runtime/registration-initial-form-release-20261006/transport'
    baseline = '85e94572cd965dd993743d12d55a3e91d60b6444'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-85'
    artifact_step = 'Save fixed 85 registration Worker build projection'
    readback_step = 'Verify fixed 85 registration deployment independently'
    readback_parameters = 'fixed-registration-85-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-956-20261006'),
                   ('EXPECTED_CURRENT','9560d8038a39d4ded1e560d484bdcb941a5d9c43'),
                   ('HISTORICAL_EXCEPTION','registration-worker-arbitrary'),
                   ('EXPECTED_CURRENT',BASELINE),('RELEASE_OPERATION','verify_unused_cache'),
                   ('POST_CLEANUP_SEAL_SHA256','a'*64),('ORDER_ARCHIVE_SEAL_SHA256','a'*64),
                   ('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256','a'*64)]
        for script in ('build-images.sh','push-images.sh','dispatch.sh'):
            for field,value in mutations:
                with self.subTest(script=script,field=field),self.fixture() as (root,env):
                    env[field]=value
                    result=self.run_script(root,env,script)
                    self.assertNotEqual(result.returncode,0)
                    self.assertEqual(self.calls(env,'aws'),[])
                    self.assertEqual(self.calls(env,'docker'),[])

    def test_85_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-85-20261006'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


class Registration86TransportTests(TransportTests):
    profile = 'registration-worker-86-20261006'
    output_directory = '.runtime/registration-email-submit-release-20261006/transport'
    baseline = 'fd3a6da610c505c2b7a51601cf854182991ffd12'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-86'
    artifact_step = 'Save fixed 86 registration Worker build projection'
    readback_step = 'Verify fixed 86 registration deployment independently'
    readback_parameters = 'fixed-registration-86-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-956-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-85-20261006'),
                   ('EXPECTED_CURRENT','9560d8038a39d4ded1e560d484bdcb941a5d9c43'),
                   ('HISTORICAL_EXCEPTION','registration-worker-arbitrary'),
                   ('EXPECTED_CURRENT',BASELINE),('RELEASE_OPERATION','verify_unused_cache'),
                   ('POST_CLEANUP_SEAL_SHA256','a'*64),('ORDER_ARCHIVE_SEAL_SHA256','a'*64),
                   ('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256','a'*64)]
        for script in ('build-images.sh','push-images.sh','dispatch.sh'):
            for field,value in mutations:
                with self.subTest(script=script,field=field),self.fixture() as (root,env):
                    env[field]=value
                    result=self.run_script(root,env,script)
                    self.assertNotEqual(result.returncode,0)
                    self.assertEqual(self.calls(env,'aws'),[])
                    self.assertEqual(self.calls(env,'docker'),[])

    def test_86_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-86-20261006'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


class Registration87TransportTests(TransportTests):
    profile = 'registration-worker-87-20261006'
    output_directory = '.runtime/registration-callback-release-20261006/transport'
    baseline = '651f62902fba74ddd189b34932084573b39d245c'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-87'
    artifact_step = 'Save fixed 87 registration Worker build projection'
    readback_step = 'Verify fixed 87 registration deployment independently'
    readback_parameters = 'fixed-registration-87-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-956-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-85-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-86-20261006'),
                   ('EXPECTED_CURRENT','fd3a6da610c505c2b7a51601cf854182991ffd12'),
                   ('EXPECTED_CURRENT','9560d8038a39d4ded1e560d484bdcb941a5d9c43'),
                   ('HISTORICAL_EXCEPTION','registration-worker-arbitrary'),
                   ('EXPECTED_CURRENT',BASELINE),('RELEASE_OPERATION','verify_unused_cache'),
                   ('POST_CLEANUP_SEAL_SHA256','a'*64),('ORDER_ARCHIVE_SEAL_SHA256','a'*64),
                   ('ORDER_ARCHIVE_PREPARED_IMAGES_SHA256','a'*64)]
        for script in ('build-images.sh','push-images.sh','dispatch.sh'):
            for field,value in mutations:
                with self.subTest(script=script,field=field),self.fixture() as (root,env):
                    env[field]=value
                    result=self.run_script(root,env,script)
                    self.assertNotEqual(result.returncode,0)
                    self.assertEqual(self.calls(env,'aws'),[])
                    self.assertEqual(self.calls(env,'docker'),[])

    def test_87_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-87-20261006'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


if __name__ == '__main__':
    unittest.main()
