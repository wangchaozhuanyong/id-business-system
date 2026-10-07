"""Maintain service image caches independently after an observed successful release."""
import argparse
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import zlib

DIRECTORY = Path(__file__).resolve().parent
REPOSITORY = DIRECTORY.parents[1]
POLICY = 'current-service-rollback-explicit-dependencies-ecr-cache-v2'
REMOTE = r'''
import hashlib, json, os, re, stat, subprocess
from pathlib import Path
BASE = Path('/opt/id-business-v2')

def require(ok):
    if not ok: raise RuntimeError('retention_precondition_failed')

def baseline():
    current = (BASE / 'current').resolve()
    require(current.parent == BASE / 'releases' and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-' + EXPECTED[:12], current.name))
    path = current / 'release-manifest.json'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        before = os.fstat(f.fileno()); require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 128 * 1024)
        raw = f.read(128 * 1024 + 1)
        identity = lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(f.fileno())) == identity(path.lstat()))
    manifest = json.loads(raw)
    require(manifest.get('commit') == EXPECTED and manifest.get('deploymentRun') == DEPLOYMENT)
    require((BASE / 'current').resolve() == current)
    return hashlib.sha256(raw).hexdigest()

result = {'status':'FAILED_CLOSED','phase':MODE,'rawErrorSuppressed':True}
try:
    require(MODE in ('PLAN','APPLY'))
    manifest_sha = baseline()
    if MODE == 'APPLY': require(manifest_sha == EXPECTED_MANIFEST_SHA)
    arguments = ['python3','-B','-c',MAINTAIN_SOURCE,'--expected-current',EXPECTED]
    if MODE == 'APPLY':
        arguments += ['--apply','--approved-policy',POLICY,'--approved-plan-sha256',PLAN_SHA]
    p = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1200)
    require(p.returncode == 0 and len(p.stdout.encode()) <= 24000)
    value = json.loads(p.stdout.strip().splitlines()[-1])
    require(value.get('policy') == POLICY and value.get('currentCommit') == EXPECTED
        and type(value.get('candidateCount')) is int and 0 <= value['candidateCount'] <= 500
        and isinstance(value.get('removed'),list) and all(isinstance(x,str) for x in value['removed'])
        and all(type(value.get(k)) is int and value[k] >= 0 for k in ('freeBytesBefore','freeBytesAfter')))
    require(baseline() == manifest_sha)
    if MODE == 'PLAN':
        plan = value.get('plan'); require(isinstance(plan,dict) and plan.get('policy') == POLICY
            and plan.get('expectedCurrent') == EXPECTED and isinstance(plan.get('dependencies'),dict)
            and isinstance(plan.get('items'),list) and value['candidateCount'] == len(plan['items'])
            and value.get('mode') == 'PLAN_ONLY' and value['removed'] == [])
        plan_sha = hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        require(value.get('planSha256') == plan_sha)
        result = {'status':'PLAN_READY','phase':MODE,'currentCommit':EXPECTED,'deploymentRun':DEPLOYMENT,
            'policy':POLICY,'manifestSha256':manifest_sha,'planSha256':plan_sha,'plan':plan}
    else:
        require(value.get('mode') == 'APPLIED' and value.get('planSha256') == PLAN_SHA
            and len(value['removed']) == value['candidateCount'])
        result = {'status':'COMPLETE','phase':MODE,'currentCommit':EXPECTED,'deploymentRun':DEPLOYMENT,
            'policy':POLICY,'manifestSha256':manifest_sha,'planSha256':PLAN_SHA,
            'candidateCount':value['candidateCount'],'removed':value['removed'],
            'freeBytesBefore':value['freeBytesBefore'],'freeBytesAfter':value['freeBytesAfter']}
except BaseException:
    result = {'status':'FAILED_CLOSED','phase':MODE,'rawErrorSuppressed':True}
print('SAFE_RETENTION_RESULT ' + json.dumps(result,separators=(',',':')),flush=True)
if result['status'] == 'FAILED_CLOSED': raise SystemExit(1)
'''


class RetentionFailure(RuntimeError):
    pass


def require(condition):
    if not condition:
        raise RetentionFailure('Service image retention failed; raw output suppressed')


def plan_digest(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def maintainer_source():
    source = (DIRECTORY / 'maintain-image-cache.py').read_text()
    assignments = [n.value for n in ast.parse(source).body if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == 'POLICY' for t in n.targets)]
    require(len(assignments) == 1 and ast.literal_eval(assignments[0]) == POLICY)
    return source


def remote_command(mode, expected, deployment, source, plan_sha=None, manifest_sha=None):
    values = {'MODE':mode,'EXPECTED':expected,'DEPLOYMENT':deployment,'POLICY':POLICY,
        'MAINTAIN_SOURCE':source,'PLAN_SHA':plan_sha,'EXPECTED_MANIFEST_SHA':manifest_sha}
    code = '\n'.join(k + ' = ' + repr(v) for k, v in values.items()) + '\n' + REMOTE
    compile(code, '<service-image-retention>', 'exec')
    packed = base64.b64encode(zlib.compress(code.encode(), 9)).decode()
    runner = 'import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(' + repr(packed) + ')),"<service-image-retention>","exec"))'
    command = 'python3 -B -c ' + shlex.quote(runner)
    require(len(command.encode()) <= 32 * 1024)
    return command


class SsmClient:
    def __init__(self, region, instance, sleep=time.sleep, monotonic=time.monotonic):
        self.region, self.instance = region, instance
        self.sleep, self.monotonic = sleep, monotonic
        self.command_ids = []

    def call(self, arguments, invocation=False):
        p = subprocess.run(['aws', '--region', self.region, *arguments, '--output', 'json'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        if invocation and p.returncode and 'InvocationDoesNotExist' in p.stderr:
            return {'Status':'Pending'}
        require(p.returncode == 0)
        return json.loads(p.stdout)

    def execute(self, command):
        require(isinstance(command,str) and len(command.encode()) <= 32 * 1024)
        dispatch = self.call(['ssm','send-command','--cli-input-json',json.dumps({
            'InstanceIds':[self.instance],'DocumentName':'AWS-RunShellScript',
            'Comment':'Independent service rollback image retention',
            'Parameters':{'commands':[command],'executionTimeout':['1500']}})])
        accepted = dispatch['Command']
        command_id = accepted['CommandId']
        require(isinstance(command_id, str) and re.fullmatch(r'[0-9a-f-]{36}', command_id)
            and accepted.get('InstanceIds') == [self.instance]
            and accepted.get('DocumentName') == 'AWS-RunShellScript')
        self.command_ids.append(command_id)
        deadline = self.monotonic() + 1500
        while self.monotonic() < deadline:
            response = self.call(['ssm','get-command-invocation','--command-id',command_id,
                '--instance-id',self.instance], invocation=True)
            if response.get('Status') in ('Pending','InProgress','Delayed'):
                self.sleep(10)
                continue
            require(response.get('Status') == 'Success' and type(response.get('ResponseCode')) is int
                and response['ResponseCode'] == 0 and response.get('CommandId') == command_id
                and response.get('InstanceId') == self.instance
                and response.get('DocumentName') == 'AWS-RunShellScript'
                and response.get('PluginName') == 'aws:runShellScript')
            stdout = response.get('StandardOutputContent', '')
            require(isinstance(stdout,str) and len(stdout.encode()) <= 24000)
            lines = [line.removeprefix('SAFE_RETENTION_RESULT ') for line in stdout.splitlines()
                if line.startswith('SAFE_RETENTION_RESULT ')]
            require(len(lines) == 1)
            result = json.loads(lines[0]); result['commandId'] = command_id
            require(result.get('status') != 'FAILED_CLOSED')
            return result
        raise RetentionFailure('Service image retention timed out; raw output suppressed')


def maintain(operation, expected, deployment, client, source=None):
    if operation != 'release':
        return {'status':'SKIPPED_NO_RELEASE','operation':operation}
    require(isinstance(expected,str) and re.fullmatch(r'[0-9a-f]{40}', expected)
        and isinstance(deployment,str) and re.fullmatch(r'github-actions-[1-9][0-9]*-[1-9][0-9]*', deployment))
    source = source if source is not None else maintainer_source()
    planned = client.execute(remote_command('PLAN', expected, deployment, source))
    require(planned.get('status') == 'PLAN_READY' and planned.get('phase') == 'PLAN'
        and planned.get('currentCommit') == expected and planned.get('deploymentRun') == deployment
        and planned.get('policy') == POLICY and isinstance(planned.get('plan'),dict)
        and planned['plan'].get('policy') == POLICY and planned['plan'].get('expectedCurrent') == expected
        and isinstance(planned['plan'].get('dependencies'),dict)
        and planned.get('planSha256') == plan_digest(planned['plan'])
        and isinstance(planned.get('manifestSha256'),str) and re.fullmatch(r'[0-9a-f]{64}',planned['manifestSha256']))
    applied = client.execute(remote_command('APPLY', expected, deployment, source,
        planned['planSha256'], planned['manifestSha256']))
    require(applied.get('status') == 'COMPLETE' and applied.get('phase') == 'APPLY'
        and applied.get('currentCommit') == expected and applied.get('deploymentRun') == deployment
        and applied.get('policy') == POLICY and applied.get('manifestSha256') == planned['manifestSha256']
        and applied.get('planSha256') == planned['planSha256']
        and type(applied.get('candidateCount')) is int and applied['candidateCount'] == len(planned['plan']['items'])
        and isinstance(applied.get('removed'),list)
        and sorted(applied['removed']) == sorted(x['tag'] for x in planned['plan']['items'])
        and all(type(applied.get(k)) is int and applied[k] >= 0 for k in ('freeBytesBefore','freeBytesAfter')))
    return {**applied,'planCommandId':planned.get('commandId'),
        'maintainerSourceSha256':hashlib.sha256(source.encode()).hexdigest()}


def save(path, result):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as target:
        json.dump(result, target, sort_keys=True)
        target.write('\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--operation', default=os.environ.get('RELEASE_OPERATION'))
    parser.add_argument('--expected-current', default=os.environ.get('RELEASE_COMMIT'))
    parser.add_argument('--deployment-run', default=('github-actions-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'])
        if os.environ.get('GITHUB_RUN_ID') and os.environ.get('GITHUB_RUN_ATTEMPT') else None)
    parser.add_argument('--instance', default=os.environ.get('PRODUCTION_INSTANCE_ID'))
    parser.add_argument('--region', default=os.environ.get('AWS_REGION'))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    require(isinstance(args.operation,str) and bool(args.operation))
    if args.operation != 'release':
        print(json.dumps({'status':'SKIPPED_NO_RELEASE','operation':args.operation}))
        return 0
    require(isinstance(args.instance,str) and re.fullmatch(r'i-(?:[0-9a-f]{8}|[0-9a-f]{17})',args.instance)
        and args.region == 'ap-northeast-1')
    output_directory = REPOSITORY / '.deploy' / 'production-release'
    require(output_directory.resolve().is_relative_to(REPOSITORY.resolve()))
    output = args.output or output_directory / ('service-image-retention-' + str(args.deployment_run) + '.json')
    output = output.resolve(); require(output.is_relative_to(output_directory.resolve()))
    client = SsmClient(args.region,args.instance)
    try:
        result = maintain(args.operation,args.expected_current,args.deployment_run,client)
        save(output,result); print(json.dumps(result)); return 0
    except BaseException:
        result = {'status':'FAILED_CLOSED','phase':'service-image-retention','rawErrorSuppressed':True,
            'commandIds':client.command_ids}
        save(output,result); print(json.dumps(result)); return 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except RetentionFailure:
        print(json.dumps({'status':'FAILED_CLOSED','rawErrorSuppressed':True})); raise SystemExit(1) from None
