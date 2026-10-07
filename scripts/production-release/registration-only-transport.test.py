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
        if args[1:] in (['--prepare-fixed-registration-build'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-956-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-85-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-86-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-87-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-88-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-89-20261006'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-90-20261007'], ['--prepare-fixed-registration-build','--registration-profile','registration-worker-91-20261007']):
            context=pathlib.Path('.deploy/production-release/registration-build-context')
            dockerfile=context/'apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile'
            dockerfile.parent.mkdir(parents=True);dockerfile.write_text('FROM synthetic-fixture\\n')
            projection={}
            if os.environ['LOCAL_TEST_PROFILE']=='registration-worker-90-20261007':
                admin=pathlib.Path('.deploy/production-release/registration-admin-build-context')
                (admin/'apps/admin').mkdir(parents=True);(admin/'apps/admin/Dockerfile').write_text('FROM synthetic-fixture\\n')
                projection={'adminContextPath':str(admin),'adminProjectionSha256':'a'*64}
                mutation=os.environ.get('LOCAL_ADMIN_PROJECTION_MUTATION','')
                if mutation=='path':projection['adminContextPath']='foreign-context'
                if mutation=='hash':projection['adminProjectionSha256']='invalid'
            encoded=json.dumps(projection)
            if os.environ.get('LOCAL_ADMIN_PROJECTION_MUTATION')=='duplicate':encoded=encoded[:-1]+',"adminProjectionSha256":"'+('b'*64)+'"}'
            (context.parent/'registration-build-projection.json').write_text(encoded)
        sys.exit(0)
    os.execv(os.environ['LOCAL_REAL_PYTHON'],[os.environ['LOCAL_REAL_PYTHON'],*args])
if name=='node':print(os.environ.get('LOCAL_ADMIN_ONLY','false'));sys.exit(0)
if name=='docker':
    if args[:2]==['image','inspect']:
        if 'id-business-v2.admin-projection-sha256' in args[-1]:print(('b' if os.environ.get('LOCAL_ADMIN_LABEL_DRIFT') else 'a')*64)
        else:print(os.environ['RELEASE_COMMIT'])
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
            if self.profile=='registration-worker-90-20261007':
                prepared=root/'.deploy/production-release/registration-build-projection.json'
                prepared.parent.mkdir(parents=True,exist_ok=True)
                prepared.write_text(json.dumps({'adminContextPath':'.deploy/production-release/registration-admin-build-context',
                                               'adminProjectionSha256':'a'*64}))
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


class Registration88TransportTests(TransportTests):
    profile = 'registration-worker-88-20261006'
    output_directory = '.runtime/registration-email-request-release-20261006/transport'
    baseline = '4c200c4ae08bb8214ff8e0955f8237ce85069cc6'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-88'
    artifact_step = 'Save fixed 88 registration Worker build projection'
    readback_step = 'Verify fixed 88 registration deployment independently'
    readback_parameters = 'fixed-registration-88-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-956-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-85-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-86-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-87-20261006'),
                   ('EXPECTED_CURRENT','651f62902fba74ddd189b34932084573b39d245c'),
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

    def test_88_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-88-20261006'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


class Registration89TransportTests(TransportTests):
    profile = 'registration-worker-89-20261006'
    output_directory = '.runtime/registration-email-submit-observation-release-20261006/transport'
    baseline = 'd2e22e623d0e19851c79ffe43396f5f97a99b8d3'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-89'
    artifact_step = 'Save fixed 89 registration Worker build projection'
    readback_step = 'Verify fixed 89 registration deployment independently'
    readback_parameters = 'fixed-registration-89-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-956-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-85-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-86-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-87-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-88-20261006'),
                   ('EXPECTED_CURRENT','4c200c4ae08bb8214ff8e0955f8237ce85069cc6'),
                   ('EXPECTED_CURRENT','651f62902fba74ddd189b34932084573b39d245c'),
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

    def test_89_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-89-20261006'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


class Registration91TransportTests(TransportTests):
    profile = 'registration-worker-91-20261007'
    output_directory = '.runtime/registration-profile-observation-release-20261007/transport'
    baseline = '01cec5190b9fb48bc63c3f3eb8a4fa6f6f6345af'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-91'
    artifact_step = 'Save fixed 91 registration Worker build projection'
    readback_step = 'Verify fixed 91 registration deployment independently'
    readback_parameters = 'fixed-registration-91-readback.json'

    def test_other_profile_and_foreign_finance_seals_fail_before_transport(self):
        mutations=[('HISTORICAL_EXCEPTION','registration-worker-90-20261007'),
                   ('HISTORICAL_EXCEPTION','registration-worker-89-20261006'),
                   ('EXPECTED_CURRENT','c3cad767b372738b2193e60584b0a53daa53b65f'),
                   ('EXPECTED_CURRENT','d2e22e623d0e19851c79ffe43396f5f97a99b8d3'),
                   ('HISTORICAL_EXCEPTION','registration-worker-b8-80-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-956-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-85-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-86-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-87-20261006'),
                   ('HISTORICAL_EXCEPTION','registration-worker-88-20261006'),
                   ('EXPECTED_CURRENT','4c200c4ae08bb8214ff8e0955f8237ce85069cc6'),
                   ('EXPECTED_CURRENT','651f62902fba74ddd189b34932084573b39d245c'),
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

    def test_91_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-91-20261007'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')
            self.assertNotIn('RAW_SECRET_SENTINEL',result.stderr)


class Registration92TransportTests(TransportTests):
    profile = 'registration-worker-92-20261007'
    output_directory = '.runtime/registration-fingerprint-prepare-repair-20261007/transport92'
    baseline = '974c62cc1681012ecff897aefc90d2cd9900004a'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-92'
    artifact_step = 'Save fixed 92 registration API and Worker build projection'
    readback_step = 'Verify fixed 92 registration deployment independently'
    readback_parameters = 'fixed-registration-92-readback.json'

    @contextmanager
    def fixture(self):
        with super().fixture() as (root, env):
            profile = {'id': self.profile, 'enabled': True, 'registrationSourceCommit': '9' * 40,
                'workerBasisCommit': self.baseline, 'apiBasisCommit': BASELINE,
                'apiBasisProjectionSha256': 'c' * 64, 'apiProjectionSha256': 'a' * 64,
                'workerProjectionSha256': 'b' * 64, 'apiCompiledSourceSha256': {'synthetic-compiled.js': 'e' * 64},
                'apiCompiledSourceProjectionSha256': 'd' * 64,
                'registrationSourceSha256': {}, 'validationSourceSha256': {}}
            (root / self.profile_file).write_text(json.dumps(profile))
            projection = {'version': 1, 'id': self.profile, 'sourceCommit': COMMIT, 'sourceTree': TREE,
                'contextPath': CONTEXT, 'apiContextPath': '.deploy/production-release/registration-api-build-context',
                **{key: value for key, value in profile.items() if key not in ('id', 'enabled')}}
            target = root / '.deploy/production-release/registration-build-projection.json'
            target.parent.mkdir(parents=True, exist_ok=True); target.write_text(json.dumps(projection))
            for executable in (root / '.fixture').iterdir():
                if executable.name not in ('python3', 'aws', 'docker', 'node'): continue
                source = executable.read_text()
                marker = "['--prepare-fixed-registration-build','--registration-profile','registration-worker-91-20261007']):"
                assert source.count(marker) == 1
                source = source.replace(marker, marker[:-2] + ", ['--prepare-fixed-registration-build','--registration-profile','registration-worker-92-20261007']):")
                marker = '            projection={}\n'
                insertion = '''            if os.environ['LOCAL_TEST_PROFILE']=='registration-worker-92-20261007':
                api=pathlib.Path('.deploy/production-release/registration-api-build-context')
                (api/'apps/api').mkdir(parents=True);(api/'apps/api/Dockerfile.mysql').write_text('FROM synthetic-fixture\\n')
                p=json.loads(pathlib.Path('deploy/aws/registration-worker-92-20261007.json').read_bytes())
                projection={'version':1,'id':p['id'],'sourceCommit':os.environ['RELEASE_COMMIT'],'sourceTree':os.environ['SOURCE_TREE'],
                    'contextPath':str(context),'apiContextPath':str(api),**{k:v for k,v in p.items() if k not in ('id','enabled')}}
                mutation=os.environ.get('LOCAL_RECOVERY_PROJECTION_MUTATION','')
                if mutation=='path':projection['apiContextPath']='foreign-context'
                if mutation=='extra':projection['unexpected']='RAW_SECRET_SENTINEL'
                if mutation=='compiled':projection['apiCompiledSourceProjectionSha256']='0'*64
'''
                assert source.count(marker) == 1; source = source.replace(marker, marker + insertion)
                marker = "        if 'id-business-v2.admin-projection-sha256' in args[-1]:"
                insertion = '''        if 'id-business-v2.api-compiled-source-sha256' in args[-1]:print(('0' if os.environ.get('LOCAL_RECOVERY_LABEL_DRIFT') else 'd')*64)
        elif 'id-business-v2.api-projection-sha256' in args[-1]:print(('0' if os.environ.get('LOCAL_RECOVERY_LABEL_DRIFT') else 'a')*64)
        elif 'id-business-v2.worker-projection-sha256' in args[-1]:print(('0' if os.environ.get('LOCAL_RECOVERY_LABEL_DRIFT') else 'b')*64)
        elif 'id-business-v2.admin-projection-sha256' in args[-1]:'''
                assert source.count(marker) == 1; source = source.replace(marker, insertion)
                executable.write_text(source)
            yield root, env

    def test_registration_build_uses_only_prepared_worker_context(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'build-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            builds = self.calls(env, 'docker')
            self.assertEqual(len(builds), 2)
            self.assertEqual([entry[-1] for entry in builds],
                ['.deploy/production-release/registration-api-build-context', CONTEXT])
            self.assertEqual(builds[0][builds[0].index('-f') + 1],
                '.deploy/production-release/registration-api-build-context/apps/api/Dockerfile.mysql')
            self.assertEqual(builds[0][builds[0].index('--target') + 1], 'runtime')
            self.assertIn('id-business-v2.api-projection-sha256=' + 'a' * 64, builds[0])
            self.assertIn('id-business-v2.api-compiled-source-sha256=' + 'd' * 64, builds[0])
            self.assertIn('id-business-v2.worker-projection-sha256=' + 'b' * 64, builds[1])
            self.assertEqual([entry[entry.index('-t') + 1].rsplit('-', 1)[-1] for entry in builds], ['api', 'recharge'])
            self.assertEqual(Path(env['GITHUB_ENV']).read_text(), 'RELEASE_ADMIN_ONLY=false\n')

    def test_registration_push_verifies_and_pushes_only_worker_tag(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'push-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = [REPOSITORY + ':' + COMMIT + '-456-1-' + service for service in ('api', 'auto-recharge')]
            self.assertEqual([entry[1] for entry in self.calls(env, 'docker') if entry[0] == 'push'], expected)
            self.assertEqual(len([entry for entry in self.calls(env, 'aws') if entry[:2] == ['ecr', 'describe-images']]), 2)

    def test_wrong_compiled_or_source_projection_label_stops_before_ecr_login_or_push(self):
        with self.fixture() as (root, env):
            env['LOCAL_RECOVERY_LABEL_DRIFT'] = 'true'
            result = self.run_script(root, env, 'push-images.sh')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.calls(env, 'aws'), [])
            self.assertEqual([entry for entry in self.calls(env, 'docker') if entry[0] in ('login', 'push')], [])

    def test_projection_artifact_extra_path_or_compiled_drift_stops_before_docker_and_aws(self):
        for mutation in ('path', 'extra', 'compiled'):
            with self.subTest(mutation=mutation), self.fixture() as (root, env):
                env['LOCAL_RECOVERY_PROJECTION_MUTATION'] = mutation
                result = self.run_script(root, env, 'build-images.sh')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(env, 'docker'), [])
                self.assertEqual(self.calls(env, 'aws'), [])
                self.assertNotIn('RAW_SECRET_SENTINEL', result.stdout + result.stderr)


class Registration90TransportTests(Registration89TransportTests):
    profile = 'registration-worker-90-20261007'
    output_directory = '.runtime/registration-hydration-release-20261007/transport'
    baseline = 'c3cad767b372738b2193e60584b0a53daa53b65f'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-90'
    artifact_step = 'Save fixed 90 registration Admin and Worker build projection'
    readback_step = 'Verify fixed 90 registration deployment independently'
    readback_parameters = 'fixed-registration-90-readback.json'

    def test_registration_build_uses_only_prepared_worker_context(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'build-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            builds = self.calls(env, 'docker')
            self.assertEqual(len(builds), 2)
            worker, admin = builds
            self.assertEqual(worker[-1], CONTEXT)
            self.assertEqual(worker[worker.index('-f')+1], CONTEXT+'/'+WORKER+'/Dockerfile')
            self.assertEqual(worker[worker.index('-t')+1], REPOSITORY+':'+COMMIT+'-456-1-auto-recharge')
            admin_context = '.deploy/production-release/registration-admin-build-context'
            self.assertEqual(admin[-1], admin_context)
            self.assertEqual(admin[admin.index('-f')+1], admin_context+'/apps/admin/Dockerfile')
            self.assertEqual(admin[admin.index('--target')+1], 'runtime')
            self.assertEqual(admin[admin.index('-t')+1], REPOSITORY+':'+COMMIT+'-456-1-admin')
            self.assertIn('id-business-v2.admin-projection-sha256='+'a'*64, admin)
            self.assertIn('V2_BUILD_ID=v2-'+COMMIT, admin)
            self.assertEqual(self.calls(env, 'python3')[:2], [
                ['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope']+self.scope_args,
                ['scripts/production-release/remote-deploy.py','--prepare-fixed-registration-build']+self.scope_args])

    def test_registration_push_verifies_and_pushes_only_worker_tag(self):
        with self.fixture() as (root, env):
            result = self.run_script(root, env, 'push-images.sh')
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = [REPOSITORY+':'+COMMIT+'-456-1-'+service for service in ('auto-recharge','admin')]
            self.assertEqual([call for call in self.calls(env,'docker') if call[0]=='push'],
                             [['push',reference] for reference in expected])
            inspected=[call[2] for call in self.calls(env,'docker') if call[:2]==['image','inspect']]
            self.assertEqual(set(inspected),set(expected))
            self.assertFalse(any('api' in call or 'migrate' in call for call in self.calls(env,'docker')))

    def test_90_admin_projection_drift_fails_before_any_image_build(self):
        for mutation in ('path','hash','duplicate'):
            with self.subTest(mutation=mutation),self.fixture() as (root,env):
                env['LOCAL_ADMIN_PROJECTION_MUTATION']=mutation
                result=self.run_script(root,env,'build-images.sh')
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(self.calls(env,'docker'),[])
                self.assertEqual(self.calls(env,'aws'),[])

    def test_90_admin_label_drift_fails_before_any_push_or_registry_login(self):
        with self.fixture() as (root,env):
            env['LOCAL_ADMIN_LABEL_DRIFT']='true'
            result=self.run_script(root,env,'push-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(self.calls(env,'aws'),[])
            self.assertFalse(any(call[0] in ('push','login') for call in self.calls(env,'docker')))

    def test_89_readback_rejects_implicit_old_profile_validation(self):
        _block,script=self.workflow_step(self.readback_step)
        script,count=re.subn(r",\n\s+profile_id='registration-worker-90-20261007'",'',script)
        self.assertEqual(count,1)
        with self.fixture() as (root,env):
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            receipt={'status':'VERIFIED','currentCommit':COMMIT,'sourceTree':TREE,'profileSha256':profile_sha}
            env['LOCAL_READBACK_OUTPUT']='FIXED_REGISTRATION_RELEASE_VERIFIED '+json.dumps(receipt)
            result=subprocess.run(['bash','-c',script],cwd=root,env=env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'')

    def test_90_stale_current_fails_before_prepare_or_transport(self):
        for name in ('build-images.sh','push-images.sh','dispatch.sh'):
            with self.subTest(script=name),self.fixture() as (root,env):
                env['EXPECTED_CURRENT']='d2e22e623d0e19851c79ffe43396f5f97a99b8d3'
                result=self.run_script(root,env,name)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(self.calls(env),[])



class Registration93TransportTests(TransportTests):
    profile = 'registration-worker-93-20261007'
    output_directory = '.runtime/registration-login-submit-ready-20261007/transport93'
    baseline = '2f24cf81007429ea474da404a30bc74da9d43ce1'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-93'
    artifact_step = 'Save fixed 93 registration Worker build projection'
    readback_step = 'Verify fixed 93 registration deployment independently'
    readback_parameters = 'fixed-registration-93-readback.json'

    @contextmanager
    def fixture(self):
        with super().fixture() as (root,env):
            profile = {'id': self.profile, 'enabled': True, 'registrationSourceCommit': '9'*40, 'workerBasisCommit': self.baseline,
                'workerProjectionSha256': 'b'*64, 'registrationSourceSha256': {}, 'validationSourceSha256': {}}
            (root/self.profile_file).write_text(json.dumps(profile))
            for executable in (root/'.fixture').iterdir():
                if executable.name not in ('python3','docker','aws','node'): continue
                source=executable.read_text()
                marker="['--prepare-fixed-registration-build','--registration-profile','registration-worker-91-20261007']):"
                assert source.count(marker)==1
                source=source.replace(marker,marker[:-2]+", ['--prepare-fixed-registration-build','--registration-profile','registration-worker-93-20261007']):")
                marker='            projection={}\n'
                insertion="""            if os.environ['LOCAL_TEST_PROFILE']=='registration-worker-93-20261007':
                p=json.loads(pathlib.Path('deploy/aws/registration-worker-93-20261007.json').read_bytes())
                projection={'version':1,'id':p['id'],'sourceCommit':os.environ['RELEASE_COMMIT'],'sourceTree':os.environ['SOURCE_TREE'],
                    'contextPath':str(context),**{k:v for k,v in p.items() if k not in ('id','enabled')}}
"""
                assert source.count(marker)==1; source=source.replace(marker,marker+insertion)
                marker="        if 'id-business-v2.admin-projection-sha256' in args[-1]:"
                source=source.replace(marker,"        if 'id-business-v2.worker-projection-sha256' in args[-1]:print(('0' if os.environ.get('LOCAL_LOGIN_LABEL_DRIFT') else 'b')*64)\n        elif 'id-business-v2.admin-projection-sha256' in args[-1]:",1)
                executable.write_text(source)
            target=root/'.deploy/production-release/registration-build-projection.json';target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(json.dumps({'version':1,'id':profile['id'],'sourceCommit':COMMIT,'sourceTree':TREE,'contextPath':CONTEXT,
                **{k:v for k,v in profile.items() if k not in ('id','enabled')}}))
            yield root,env

    def test_registration_build_uses_only_prepared_worker_context(self):
        with self.fixture() as (root,env):
            result=self.run_script(root,env,'build-images.sh');self.assertEqual(result.returncode,0,result.stderr)
            builds=[x for x in self.calls(env,'docker') if x and x[0]=='build']
            self.assertEqual(len(builds),1);self.assertEqual(builds[0][-1],CONTEXT)
            self.assertIn('id-business-v2.worker-projection-sha256='+('b'*64),builds[0])
            self.assertEqual(self.calls(env,'python3'),[
                ['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope',*self.scope_args],
                ['scripts/production-release/remote-deploy.py','--prepare-fixed-registration-build',*self.scope_args],['-']])

    def test_registration_push_verifies_and_pushes_only_worker_tag(self):
        with self.fixture() as (root,env):
            result=self.run_script(root,env,'push-images.sh');self.assertEqual(result.returncode,0,result.stderr)
            pushes=[x for x in self.calls(env,'docker') if x and x[0]=='push']
            self.assertEqual(pushes,[['push',REPOSITORY+':'+COMMIT+'-456-1-auto-recharge']])
            self.assertEqual(self.calls(env,'python3'),[['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope',*self.scope_args],['-']])

    def test_foreign_profile_or_cache_seal_fails_before_transport(self):
        for key,value in [('EXPECTED_CURRENT','974c62cc1681012ecff897aefc90d2cd9900004a'),
            ('RELEASE_OPERATION','verify_order_archive_release'),('RELEASE_ADMIN_ONLY','true'),
            ('REUSE_IMAGE_RUN','123'),('ORDER_ARCHIVE_SEAL_SHA256','0'*64)]:
            for name in ('build-images.sh','push-images.sh','dispatch.sh'):
                with self.subTest(key=key,name=name),self.fixture() as (root,env):
                    env[key]=value;result=self.run_script(root,env,name)
                    self.assertNotEqual(result.returncode,0);self.assertEqual(self.calls(env,'aws'),[]);self.assertEqual(self.calls(env,'docker'),[])

    def test_worker_label_drift_rejects_push_before_any_push(self):
        with self.fixture() as (root,env):
            env['LOCAL_LOGIN_LABEL_DRIFT']='true'
            result=self.run_script(root,env,'push-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual([x for x in self.calls(env,'docker') if x and x[0]=='push'],[])

    def test_cache_input_is_not_a_new_build_input(self):
        with self.fixture() as (root,env):
            env['RELEASE_BROWSER_CACHE_IMAGE']=REPOSITORY+':'+('a'*40)+'-1-1-auto-recharge'
            env['RELEASE_BROWSER_CACHE_IMAGE_ID']='sha256:'+('a'*64)
            result=self.run_script(root,env,'build-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual([x for x in self.calls(env,'docker') if x and x[0] in ('pull','build')],[])

class Registration94TransportTests(TransportTests):
    profile = 'registration-worker-94-20261007'
    output_directory = '.runtime/registration-login-runtime-followup-20261007/transport94'
    baseline = '815fae391b172d6c368ea2ad25225f52a1272808'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-94'
    artifact_step = 'Save fixed 94 registration Worker build projection'
    readback_step = 'Verify fixed 94 registration deployment independently'
    readback_parameters = 'fixed-registration-94-readback.json'

    @contextmanager
    def fixture(self):
        with super().fixture() as (root,env):
            profile = {'id': self.profile, 'enabled': True, 'registrationSourceCommit': '9'*40, 'workerBasisCommit': '2f24cf81007429ea474da404a30bc74da9d43ce1',
                'workerProjectionSha256': 'b'*64, 'registrationSourceSha256': {}, 'validationSourceSha256': {}}
            (root/self.profile_file).write_text(json.dumps(profile))
            for executable in (root/'.fixture').iterdir():
                if executable.name not in ('python3','docker','aws','node'): continue
                source=executable.read_text()
                marker="['--prepare-fixed-registration-build','--registration-profile','registration-worker-91-20261007']):"
                assert source.count(marker)==1
                source=source.replace(marker,marker[:-2]+", ['--prepare-fixed-registration-build','--registration-profile','registration-worker-94-20261007']):")
                marker='            projection={}\n'
                insertion="""            if os.environ['LOCAL_TEST_PROFILE']=='registration-worker-94-20261007':
                p=json.loads(pathlib.Path('deploy/aws/registration-worker-94-20261007.json').read_bytes())
                projection={'version':1,'id':p['id'],'sourceCommit':os.environ['RELEASE_COMMIT'],'sourceTree':os.environ['SOURCE_TREE'],
                    'contextPath':str(context),**{k:v for k,v in p.items() if k not in ('id','enabled')}}
"""
                assert source.count(marker)==1; source=source.replace(marker,marker+insertion)
                marker="        if 'id-business-v2.admin-projection-sha256' in args[-1]:"
                source=source.replace(marker,"        if 'id-business-v2.worker-projection-sha256' in args[-1]:print(('0' if os.environ.get('LOCAL_LOGIN_LABEL_DRIFT') else 'b')*64)\n        elif 'id-business-v2.admin-projection-sha256' in args[-1]:",1)
                executable.write_text(source)
            target=root/'.deploy/production-release/registration-build-projection.json';target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(json.dumps({'version':1,'id':profile['id'],'sourceCommit':COMMIT,'sourceTree':TREE,'contextPath':CONTEXT,
                **{k:v for k,v in profile.items() if k not in ('id','enabled')}}))
            yield root,env

    def test_registration_build_uses_only_prepared_worker_context(self):
        with self.fixture() as (root,env):
            result=self.run_script(root,env,'build-images.sh');self.assertEqual(result.returncode,0,result.stderr)
            builds=[x for x in self.calls(env,'docker') if x and x[0]=='build']
            self.assertEqual(len(builds),1);self.assertEqual(builds[0][-1],CONTEXT)
            self.assertIn('id-business-v2.worker-projection-sha256='+('b'*64),builds[0])
            self.assertEqual(self.calls(env,'python3'),[
                ['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope',*self.scope_args],
                ['scripts/production-release/remote-deploy.py','--prepare-fixed-registration-build',*self.scope_args],['-']])

    def test_registration_push_verifies_and_pushes_only_worker_tag(self):
        with self.fixture() as (root,env):
            result=self.run_script(root,env,'push-images.sh');self.assertEqual(result.returncode,0,result.stderr)
            pushes=[x for x in self.calls(env,'docker') if x and x[0]=='push']
            self.assertEqual(pushes,[['push',REPOSITORY+':'+COMMIT+'-456-1-auto-recharge']])
            self.assertEqual(self.calls(env,'python3'),[['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope',*self.scope_args],['-']])

    def test_foreign_profile_or_cache_seal_fails_before_transport(self):
        for key,value in [('EXPECTED_CURRENT','974c62cc1681012ecff897aefc90d2cd9900004a'),
            ('RELEASE_OPERATION','verify_order_archive_release'),('RELEASE_ADMIN_ONLY','true'),
            ('REUSE_IMAGE_RUN','123'),('ORDER_ARCHIVE_SEAL_SHA256','0'*64)]:
            for name in ('build-images.sh','push-images.sh','dispatch.sh'):
                with self.subTest(key=key,name=name),self.fixture() as (root,env):
                    env[key]=value;result=self.run_script(root,env,name)
                    self.assertNotEqual(result.returncode,0);self.assertEqual(self.calls(env,'aws'),[]);self.assertEqual(self.calls(env,'docker'),[])

    def test_worker_label_drift_rejects_push_before_any_push(self):
        with self.fixture() as (root,env):
            env['LOCAL_LOGIN_LABEL_DRIFT']='true'
            result=self.run_script(root,env,'push-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual([x for x in self.calls(env,'docker') if x and x[0]=='push'],[])

    def test_cache_input_is_not_a_new_build_input(self):
        with self.fixture() as (root,env):
            env['RELEASE_BROWSER_CACHE_IMAGE']=REPOSITORY+':'+('a'*40)+'-1-1-auto-recharge'
            env['RELEASE_BROWSER_CACHE_IMAGE_ID']='sha256:'+('a'*64)
            result=self.run_script(root,env,'build-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual([x for x in self.calls(env,'docker') if x and x[0] in ('pull','build')],[])


    def test_api_admin_operation_cannot_select_registration94(self):
        for operation in ('release_api_admin', 'verify_api_admin'):
            for name in ('build-images.sh', 'push-images.sh', 'dispatch.sh'):
                with self.subTest(operation=operation, script=name), self.fixture() as (root, env):
                    env['RELEASE_OPERATION'] = operation
                    result = self.run_script(root, env, name)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.calls(env, 'aws'), [])
                    self.assertEqual(self.calls(env, 'docker'), [])

class Registration95TransportTests(TransportTests):
    profile = 'registration-worker-95-20261008'
    output_directory = '.runtime/registration-login-interstitial-20261008/transport95'
    baseline = '4c170e661c871dc14dccc98a8d6e5cf983141341'
    profile_file = 'deploy/aws/' + profile + '.json'
    scope_args = ['--registration-profile', profile]
    release_flag = '--registration-worker-95'
    artifact_step = 'Save fixed 95 registration Worker build projection'
    readback_step = 'Verify fixed 95 registration deployment independently'
    readback_parameters = 'fixed-registration-95-readback.json'

    @contextmanager
    def fixture(self):
        with super().fixture() as (root,env):
            controller=root/'scripts/production-release/remote-deploy.py'
            controller.write_text(controller.read_text()+'\nvalidate_registration_interstitial_readback=validate_fixed_registration_readback_projection\n')
            controller.write_text(controller.read_text()+"\ndef registration_interstitial_verify_carrier(source_sha,profile_sha):\n import pathlib,hashlib,json\n p=pathlib.Path(__file__);q=pathlib.Path('deploy/aws/registration-worker-95-20261008.json')\n assert hashlib.sha256(p.read_bytes()).hexdigest()==source_sha and hashlib.sha256(q.read_bytes()).hexdigest()==profile_sha\n return json.loads(q.read_bytes())\n")
            controller.write_text(controller.read_text()+"\ndef load_registration_interstitial95():return globals()\n")
            (root/'scripts/production-release/registration-interstitial-95.py').write_text('# Closed plaintext95 module fixture\n')
            curl=root/'.fixture/curl'
            curl.write_text('#!'+sys.executable+'\n'+"import os,pathlib,sys\nargs=sys.argv[1:];url=args[args.index('--max-time')+2];base='https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/'+os.environ['RELEASE_COMMIT']+'/'\nallowed={base+'scripts/production-release/remote-deploy.py':pathlib.Path('scripts/production-release/remote-deploy.py'),base+'deploy/aws/registration-worker-95-20261008.json':pathlib.Path('deploy/aws/registration-worker-95-20261008.json'),base+'scripts/production-release/registration-interstitial-95.py':pathlib.Path('scripts/production-release/registration-interstitial-95.py')}\nif url not in allowed:raise SystemExit('Closed local curl fixture rejected URL')\ndata=allowed[url].read_bytes();pathlib.Path(args[args.index('-o')+1]).write_bytes(data)\n")
            curl.chmod(0o755)
            profile = {'id': self.profile, 'enabled': True, 'registrationSourceCommit': '9'*40, 'workerBasisCommit': '2f24cf81007429ea474da404a30bc74da9d43ce1',
                'workerProjectionSha256': 'b'*64, 'registrationSourceSha256': {}, 'validationSourceSha256': {}}
            (root/self.profile_file).write_text(json.dumps(profile))
            for executable in (root/'.fixture').iterdir():
                if executable.name not in ('python3','docker','aws','node'): continue
                source=executable.read_text()
                marker="['--prepare-fixed-registration-build','--registration-profile','registration-worker-91-20261007']):"
                assert source.count(marker)==1
                source=source.replace(marker,marker[:-2]+", ['--prepare-fixed-registration-build','--registration-profile','registration-worker-95-20261008']):")
                marker='            projection={}\n'
                insertion="""            if os.environ['LOCAL_TEST_PROFILE']=='registration-worker-95-20261008':
                p=json.loads(pathlib.Path('deploy/aws/registration-worker-95-20261008.json').read_bytes())
                projection={'version':1,'id':p['id'],'sourceCommit':os.environ['RELEASE_COMMIT'],'sourceTree':os.environ['SOURCE_TREE'],
                    'contextPath':str(context),**{k:v for k,v in p.items() if k not in ('id','enabled')}}
"""
                assert source.count(marker)==1; source=source.replace(marker,marker+insertion)
                marker="        if 'id-business-v2.admin-projection-sha256' in args[-1]:"
                source=source.replace(marker,"        if 'id-business-v2.worker-projection-sha256' in args[-1]:print(('0' if os.environ.get('LOCAL_LOGIN_LABEL_DRIFT') else 'b')*64)\n        elif 'id-business-v2.admin-projection-sha256' in args[-1]:",1)
                executable.write_text(source)
            target=root/'.deploy/production-release/registration-build-projection.json';target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(json.dumps({'version':1,'id':profile['id'],'sourceCommit':COMMIT,'sourceTree':TREE,'contextPath':CONTEXT,
                **{k:v for k,v in profile.items() if k not in ('id','enabled')}}))
            yield root,env

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
            local_verifier = command[2].replace(repr(staging), repr(str(local_source))).replace(repr('/opt/id-business-v2/.staging/oidc-'+COMMIT+'/'+self.profile+'.json'),repr(str(root/self.profile_file))).replace(repr('/opt/id-business-v2/.staging/oidc-'+COMMIT+'/registration-interstitial-95.py'),repr(str(root/'scripts/production-release/registration-interstitial-95.py')))
            carrier=root/self.profile_file;carrier_raw=carrier.read_bytes();carrier.unlink();never=root/'never-written-readback-carrier';carrier.symlink_to(never)
            rejected=subprocess.run([sys.executable,'-c',local_verifier],cwd=root,env=env,capture_output=True,text=True)
            self.assertNotEqual(rejected.returncode,0);self.assertFalse(never.exists());carrier.unlink();carrier.write_bytes(carrier_raw)
            verified = subprocess.run([sys.executable, '-c', local_verifier], cwd=root, env=env,
                                      capture_output=True, text=True, timeout=10)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            module=root/'scripts/production-release/registration-interstitial-95.py';module_raw=module.read_bytes();module.write_bytes(module_raw+b'changed')
            bad_module=subprocess.run([sys.executable,'-c',local_verifier],cwd=root,env=env,capture_output=True,text=True)
            self.assertNotEqual(bad_module.returncode,0);self.assertIn('Fixed95 carrier hash changed',bad_module.stderr);module.write_bytes(module_raw)
            module.unlink();never_module=root/'never-readback-module';module.symlink_to(never_module)
            bad_module=subprocess.run([sys.executable,'-c',local_verifier],cwd=root,env=env,capture_output=True,text=True)
            self.assertNotEqual(bad_module.returncode,0);self.assertFalse(never_module.exists());module.unlink();module.write_bytes(module_raw)
            with local_source.open('a') as target:
                target.write("\nraise RuntimeError('RAW_SECRET_SENTINEL')\n")
            changed = subprocess.run([sys.executable, '-c', local_verifier], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(changed.returncode, 0)
            self.assertIn('Fixed95 carrier hash changed', changed.stderr)
            self.assertNotIn('RAW_SECRET_SENTINEL', changed.stdout + changed.stderr)

    def test_actual_dispatch_stages_pinned95_carrier_and_matches_real_controller_argv(self):
        with self.fixture()as(root,env):
            result=self.run_script(root,env,'dispatch.sh');self.assertEqual(result.returncode,0,result.stderr)
            parameters=json.loads((root/'.deploy/production-release/ssm-456.json').read_bytes())
            commands=parameters['commands'];source_sha=hashlib.sha256((root/'scripts/production-release/remote-deploy.py').read_bytes()).hexdigest()
            profile_sha=hashlib.sha256((root/self.profile_file).read_bytes()).hexdigest()
            module_sha=hashlib.sha256((root/'scripts/production-release/registration-interstitial-95.py').read_bytes()).hexdigest()
            self.assertTrue(any('/scripts/production-release/registration-interstitial-95.py' in c for c in commands))
            self.assertTrue(any('/deploy/aws/'+self.profile+'.json' in c for c in commands))
            self.assertTrue(any('/.staging/oidc-'+COMMIT+'/'+self.profile+'.json' in c for c in commands))
            verified=[shlex.split(c)[2]for c in commands if c.startswith('python3 -c ')]
            for code in verified:compile(code,'<closed95-carrier>','exec')
            self.assertTrue(any(module_sha in c and 'load_registration_interstitial95'in c for c in verified))
            self.assertTrue(any(source_sha in c and profile_sha in c and 'registration_interstitial_verify_carrier'in c for c in verified))
            self.assertTrue(any('resolve()'in c and 'is_symlink' in c for c in verified))
            prefix='/opt/id-business-v2'
            local_base=root/'staging-before-download';local_stage=local_base/'.staging'/('oidc-'+COMMIT);local_stage.mkdir(parents=True)
            guard=verified[0].replace(prefix,str(local_base))
            broken=local_stage/(self.profile+'.json');target=root/'never-written-carrier'
            broken.symlink_to(target)
            rejected=subprocess.run([sys.executable,'-c',guard],env=env,capture_output=True,text=True)
            self.assertNotEqual(rejected.returncode,0);self.assertFalse(target.exists());broken.unlink()
            local_source=local_stage/'remote-deploy.py';local_source.symlink_to(target)
            rejected=subprocess.run([sys.executable,'-c',guard],env=env,capture_output=True,text=True)
            self.assertNotEqual(rejected.returncode,0);self.assertFalse(target.exists());local_source.unlink()
            local_module=local_stage/'registration-interstitial-95.py';local_module.symlink_to(target)
            rejected=subprocess.run([sys.executable,'-c',guard],env=env,capture_output=True,text=True)
            self.assertNotEqual(rejected.returncode,0);self.assertFalse(target.exists());local_module.unlink()
            ns={'__name__':'actual95_dispatch_argv_fixture','__file__':str(PROJECT/'scripts/production-release/remote-deploy.py')}
            exec(compile((PROJECT/'scripts/production-release/remote-deploy.py').read_bytes(),ns['__file__'],'exec'),ns)
            ns['load_registration_interstitial95']()
            received=[];ns['registration_interstitial_release']=lambda args:received.append(args)or 0
            tokens=shlex.split(commands[-1]);self.assertEqual(tokens[:2],['python3','/opt/id-business-v2/.staging/oidc-'+COMMIT+'/remote-deploy.py'])
            self.assertEqual(ns['registration_interstitial_main'](tokens[2:]),0);self.assertEqual(len(received),1)
            args=received[0];self.assertEqual((args.image_commit,args.image_run_id,args.image_run_attempt),(COMMIT,'456','1'))

    def test_dispatch_all_three_hashes_are_checked_before_controller_or_module_exec(self):
        with self.fixture()as(root,env):
            controller=root/'scripts/production-release/remote-deploy.py'
            controller.write_text(controller.read_text()+"\nraise AssertionError('UNVERIFIED95_CONTROLLER_EXEC_SENTINEL')\n")
            result=self.run_script(root,env,'dispatch.sh');self.assertEqual(result.returncode,0,result.stderr)
            commands=json.loads((root/'.deploy/production-release/ssm-456.json').read_bytes())['commands']
            verify=[shlex.split(c)[2]for c in commands if c.startswith('python3 -c ')][1]
            base=root/'actual-three-carrier-preexec';stage=base/'.staging'/('oidc-'+COMMIT);stage.mkdir(parents=True)
            locations=[(controller,stage/'remote-deploy.py'),(root/self.profile_file,stage/(self.profile+'.json')),
                (root/'scripts/production-release/registration-interstitial-95.py',stage/'registration-interstitial-95.py')]
            for original,target in locations:target.write_bytes(original.read_bytes());target.chmod(0o644)
            code=verify.replace('/opt/id-business-v2',str(base))
            for _original,target in locations:
                raw=target.read_bytes();target.write_bytes(raw+b'drift')
                rejected=subprocess.run([sys.executable,'-c',code],cwd=root,env=env,capture_output=True,text=True)
                self.assertNotEqual(rejected.returncode,0);self.assertIn('Fixed95 carrier hash changed',rejected.stderr)
                self.assertNotIn('UNVERIFIED95_CONTROLLER_EXEC_SENTINEL',rejected.stderr);target.write_bytes(raw);target.chmod(0o644)

    def test_registration_build_uses_only_prepared_worker_context(self):
        with self.fixture() as (root,env):
            result=self.run_script(root,env,'build-images.sh');self.assertEqual(result.returncode,0,result.stderr)
            builds=[x for x in self.calls(env,'docker') if x and x[0]=='build']
            self.assertEqual(len(builds),1);self.assertEqual(builds[0][-1],CONTEXT)
            self.assertIn('id-business-v2.worker-projection-sha256='+('b'*64),builds[0])
            self.assertEqual(self.calls(env,'python3'),[
                ['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope',*self.scope_args],
                ['scripts/production-release/remote-deploy.py','--prepare-fixed-registration-build',*self.scope_args],['-']])

    def test_registration_push_verifies_and_pushes_only_worker_tag(self):
        with self.fixture() as (root,env):
            result=self.run_script(root,env,'push-images.sh');self.assertEqual(result.returncode,0,result.stderr)
            pushes=[x for x in self.calls(env,'docker') if x and x[0]=='push']
            self.assertEqual(pushes,[['push',REPOSITORY+':'+COMMIT+'-456-1-auto-recharge']])
            self.assertEqual(self.calls(env,'python3'),[['scripts/production-release/remote-deploy.py','--check-fixed-registration-scope',*self.scope_args],['-']])

    def test_foreign_profile_or_cache_seal_fails_before_transport(self):
        for key,value in [('EXPECTED_CURRENT','974c62cc1681012ecff897aefc90d2cd9900004a'),
            ('RELEASE_OPERATION','verify_order_archive_release'),('RELEASE_ADMIN_ONLY','true'),
            ('REUSE_IMAGE_RUN','123'),('ORDER_ARCHIVE_SEAL_SHA256','0'*64)]:
            for name in ('build-images.sh','push-images.sh','dispatch.sh'):
                with self.subTest(key=key,name=name),self.fixture() as (root,env):
                    env[key]=value;result=self.run_script(root,env,name)
                    self.assertNotEqual(result.returncode,0);self.assertEqual(self.calls(env,'aws'),[]);self.assertEqual(self.calls(env,'docker'),[])

    def test_worker_label_drift_rejects_push_before_any_push(self):
        with self.fixture() as (root,env):
            env['LOCAL_LOGIN_LABEL_DRIFT']='true'
            result=self.run_script(root,env,'push-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual([x for x in self.calls(env,'docker') if x and x[0]=='push'],[])

    def test_cache_input_is_not_a_new_build_input(self):
        with self.fixture() as (root,env):
            env['RELEASE_BROWSER_CACHE_IMAGE']=REPOSITORY+':'+('a'*40)+'-1-1-auto-recharge'
            env['RELEASE_BROWSER_CACHE_IMAGE_ID']='sha256:'+('a'*64)
            result=self.run_script(root,env,'build-images.sh')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual([x for x in self.calls(env,'docker') if x and x[0] in ('pull','build')],[])


    def test_api_admin_operation_cannot_select_registration95(self):
        for operation in ('release_api_admin', 'verify_api_admin'):
            for name in ('build-images.sh', 'push-images.sh', 'dispatch.sh'):
                with self.subTest(operation=operation, script=name), self.fixture() as (root, env):
                    env['RELEASE_OPERATION'] = operation
                    result = self.run_script(root, env, name)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.calls(env, 'aws'), [])
                    self.assertEqual(self.calls(env, 'docker'), [])

if __name__ == '__main__':
    unittest.main()
