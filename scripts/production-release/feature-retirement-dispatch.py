"""Bind an exact native retirement artifact to one forward production operation."""
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.deploy/feature-retirement-release'
REPOSITORY = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'
WORKFLOW = '.github/workflows/feature-retirement-validation.yml'
CONTRACT = 'scripts/production-release/feature-retirement-contract.json'
MAX_BUNDLE = 64 * 1024**2
BOOTSTRAP = ('feature-retirement-release.py', 'remote-deploy.py',
             'recharge-record-release.py', 'recharge-availability-release.py',
             'api-admin-scope.py')


def need(value, code):
    if not value:
        raise RuntimeError('FEATURE_RETIREMENT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def execute(*args, env=None):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, env=env)
    need(result.returncode == 0, 'PLATFORM_REQUEST_FAILED')
    return result.stdout


def github(path):
    return json.loads(execute('gh', 'api', path))


def artifact_bytes(zipped, metadata, commit, attempt):
    need(len(zipped) <= MAX_BUNDLE and metadata.get('digest') == 'sha256:' + sha(zipped),
         'NATIVE_ARTIFACT_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        names = archive.namelist()
        need(len(names) == 2 and set(names) == {
            'feature-retirement-artifact.tar.gz', 'artifact-sha256.txt'},
            'NATIVE_ARTIFACT_LAYOUT_INVALID')
        need(archive.getinfo('feature-retirement-artifact.tar.gz').file_size <= MAX_BUNDLE
             and archive.getinfo('artifact-sha256.txt').file_size <= 128,
             'NATIVE_ARTIFACT_TOO_LARGE')
        bundle = archive.read('feature-retirement-artifact.tar.gz')
        declared = archive.read('artifact-sha256.txt').decode().strip()
    need(re.fullmatch('[a-f0-9]{64}', declared) and sha(bundle) == declared,
         'COMPILED_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        members, names, expanded = [], set(), 0
        for item in archive:
            name = item.name.rstrip('/')
            expanded += item.size
            need(len(members) < 8192 and expanded <= 128 * 1024**2,
                 'NATIVE_PAYLOAD_BUDGET_EXCEEDED')
            need(name and not name.startswith('/') and '\\' not in name
                 and all(part not in ('', '.', '..') for part in name.split('/'))
                 and name.split('/')[0] == 'payload'
                 and (item.isfile() or item.isdir()) and item.size <= 8 * 1024**2
                 and name not in names, 'NATIVE_PAYLOAD_PATH_INVALID')
            names.add(name)
            members.append(item)
        entries = [item for item in members
                   if item.name == 'payload/build-proof.json']
        need(len(entries) == 1 and entries[0].isfile() and entries[0].size <= 512 * 1024,
             'NATIVE_PROOF_INVALID')
        raw = archive.extractfile(entries[0]).read()
    proof = json.loads(raw)
    need(proof.get('commit') == commit and proof.get('workflowRunAttempt') == attempt,
         'BUILD_IDENTITY_CHANGED')
    return bundle, declared, raw, proof


def prepare_plan():
    commit, run_id, attempt = (os.environ[n] for n in
                              ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    need(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
         and os.environ.get('GITHUB_REF') == 'refs/heads/main'
         and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
         and os.environ.get('RELEASE_COMMIT') == commit
         and re.fullmatch('[a-f0-9]{40}', commit)
         and re.fullmatch('[1-9][0-9]*', run_id)
         and re.fullmatch('[1-9][0-9]*', attempt), 'MAIN_SELECTION_INVALID')
    run = github('repos/' + REPOSITORY + '/actions/runs/' + run_id)
    need(run['head_sha'] == commit and run['head_branch'] == 'main'
         and run['event'] == 'workflow_dispatch' and run['path'] == WORKFLOW
         and str(run['run_attempt']) == attempt, 'WORKFLOW_IDENTITY_INVALID')
    jobs = github('repos/' + REPOSITORY + '/actions/runs/' + run_id
                  + '/attempts/' + attempt + '/jobs')['jobs']
    for name in ('validate', 'quality-gate'):
        matches = [job for job in jobs if job['name'] == name]
        need(len(matches) == 1 and matches[0]['status'] == 'completed'
             and matches[0]['conclusion'] == 'success', 'NATIVE_VALIDATION_NOT_SUCCESSFUL')
    artifacts = github('repos/' + REPOSITORY + '/actions/runs/' + run_id
                       + '/artifacts')['artifacts']
    matches = [item for item in artifacts
               if item['name'] == 'feature-retirement-' + commit + '-' + attempt]
    need(len(matches) == 1 and not matches[0]['expired']
         and matches[0]['workflow_run']['head_sha'] == commit,
         'NATIVE_ARTIFACT_UNAVAILABLE')
    artifact = matches[0]
    zipped = execute('gh', 'api', 'repos/' + REPOSITORY + '/actions/artifacts/'
                     + str(artifact['id']) + '/zip')
    bundle, declared, proof_raw, proof = artifact_bytes(zipped, artifact, commit, attempt)
    contract_raw = (ROOT / CONTRACT).read_bytes()
    contract = json.loads(contract_raw)
    tree = execute('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    need(proof.get('scope') == contract['scope'] and proof.get('tree') == tree
         and proof.get('workflowRunId') == run_id
         and proof.get('contractSha256') == sha(contract_raw)
         and os.environ.get('EXPECTED_CURRENT') == contract['expectedCurrent'],
         'BUILD_IDENTITY_CHANGED')
    controls = contract['controlSources']
    need(proof.get('controlSources') == controls
         and all(sha((ROOT / name).read_bytes()) == value for name, value in controls.items()),
         'EXECUTOR_SOURCE_CHANGED')
    quality = proof.get('qualityVerification', {})
    need(quality.get('commit') == commit and quality.get('sourceTree') == tree
         and quality.get('path') == '.github/workflows/quality.yml'
         and quality.get('conclusion') == 'success'
         and re.fullmatch('[1-9][0-9]*', str(quality.get('runId', ''))),
         'QUALITY_PROOF_INVALID')
    checked = github('repos/' + REPOSITORY + '/actions/runs/' + quality['runId'])
    need(checked['head_sha'] == commit and checked['head_branch'] == 'main'
         and checked['event'] == 'push' and checked['path'] == quality['path']
         and checked['status'] == 'completed'
         and checked['conclusion'] == 'success', 'QUALITY_GATE_CHANGED')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    bundle_path = OUTPUT / 'feature-retirement-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    (OUTPUT / 'native-artifact.zip').write_bytes(zipped)
    tag = 'feature-retirement-' + commit
    notes = OUTPUT / 'artifact-notes.md'
    notes.write_text('自动注册功能独立下线产物；不包含数据库迁移、注册、付款或用户数据删除。'
                     'main ' + commit + '；原生验证运行 https://github.com/'
                     + REPOSITORY + '/actions/runs/' + run_id + '。\n')
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', commit,
            '--title', 'Automatic registration retirement ' + commit[:12],
            '--notes-file', str(notes), '--prerelease')
    plan = {'version': 1, 'scope': contract['scope'], 'commit': commit, 'tree': tree,
            'branch': 'main', 'workflowRunId': run_id, 'workflowRunAttempt': attempt,
            'contractSha256': sha(contract_raw), 'artifactSha256': declared,
            'buildProofSha256': sha(proof_raw), 'controlSources': controls,
            'qualityVerification': quality,
            'artifactUrl': 'https://github.com/' + REPOSITORY + '/releases/download/'
                           + tag + '/feature-retirement-artifact.tar.gz'}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    return plan, contract


def transport(plan, contract, mode):
    need(mode in ('preflight', 'release', 'readback'), 'MODE_INVALID')
    current = {**plan, 'mode': mode}
    raw_base = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + plan['commit'] + '/'
    source = 'PLAN_JSON=' + repr(json.dumps(current)) + '\nRAW_BASE=' + repr(raw_base) + '\n'
    source += """import base64,gzip,hashlib,importlib.util,json,os,re,urllib.request
from pathlib import Path
os.umask(0o077)
plan=json.loads(PLAN_JSON)
directory=Path('/opt/id-business-v2/.staging/feature-retirement-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
def load(path,name):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def download(name,expected,limit):
 with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(limit+1)
 if len(raw)>limit or hashlib.sha256(raw).hexdigest()!=expected:raise RuntimeError('FEATURE_RETIREMENT_EXECUTOR_SOURCE_CHANGED')
 path=directory/Path(name).name
 if path.exists():
  if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('FEATURE_RETIREMENT_EXECUTOR_CHANGED')
 else:path.write_bytes(raw)
 return path
try:
 contract_path=download('scripts/production-release/feature-retirement-contract.json',plan['contractSha256'],1024*1024)
 contract=json.loads(contract_path.read_bytes())
 for name in BOOTSTRAP:
  full='scripts/production-release/'+name
  download(full,plan['controlSources'][full],8*1024**2)
 module=load(directory/'feature-retirement-release.py','feature_retirement_controller')
 helper=load(directory/'recharge-record-release.py','retirement_published_helper')
 driver=helper.load_utilities(directory/'remote-deploy.py',plan['controlSources']['scripts/production-release/remote-deploy.py'])
 result=module.release(plan,contract,driver,helper)
 raw=json.dumps(result,sort_keys=True,separators=(',',':')).encode()
 encoded=base64.b64encode(gzip.compress(raw)).decode()
 if len(encoded)>19000:raise RuntimeError('FEATURE_RETIREMENT_RECEIPT_TOO_LARGE')
 print('FEATURE_RETIREMENT_GZIP_BASE64='+encoded)
except Exception as error:
 code=str(error) if re.fullmatch('(?:FEATURE_RETIREMENT|RECHARGE_RECORD|API_ADMIN)_[A-Z0-9_]+',str(error)) else 'FEATURE_RETIREMENT_REMOTE_OPERATION_FAILED'
 print(json.dumps({'status':'FEATURE_RETIREMENT_FAILED','code':code,'mode':plan['mode'],'commit':plan['commit'],'businessActions':0}))
 raise SystemExit(1) from None
"""
    source = source.replace('for name in BOOTSTRAP:', 'for name in ' + repr(BOOTSTRAP) + ':')
    parameters = {'commands': ["python3 - <<'RETIREMENT_RELEASE'\n" + source
                              + '\nRETIREMENT_RELEASE'], 'executionTimeout': ['900']}
    accepted = OUTPUT / (mode + '-accepted-command.json')
    intent = OUTPUT / (mode + '-command-intent.json')
    need(not accepted.exists() and not accepted.is_symlink()
         and not intent.exists() and not intent.is_symlink(),
         'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    with intent.open('x') as handle:
        json.dump({'mode': mode, 'commit': plan['commit'], 'workflowRunId': plan['workflowRunId'],
                   'parametersSha256': sha(json.dumps(parameters, sort_keys=True).encode())}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    response = json.loads(execute('aws', 'ssm', 'send-command', '--region', REGION,
                                  '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript',
                                  '--comment', 'feature-retirement-' + mode + '-' + plan['commit'][:12],
                                  '--parameters', json.dumps(parameters), '--output', 'json',
                                  env={**os.environ, 'AWS_MAX_ATTEMPTS': '1'}))
    command = response['Command']['CommandId']
    accepted.write_text(json.dumps({'CommandId': command, 'InstanceId': INSTANCE}) + '\n')
    print(json.dumps({'mode': mode, 'acceptedCommandId': command}), flush=True)
    for _ in range(180):
        process = subprocess.run(['aws', 'ssm', 'get-command-invocation', '--region', REGION,
                                  '--command-id', command, '--instance-id', INSTANCE, '--output', 'json'],
                                 cwd=ROOT, capture_output=True)
        if process.returncode:
            time.sleep(5)
            continue
        value = json.loads(process.stdout)
        if value['Status'] in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        (OUTPUT / (mode + '-native-invocation.json')).write_text(json.dumps(value, indent=2) + '\n')
        need(value['Status'] == 'Success' and value['ResponseCode'] == 0
             and value.get('StandardErrorContent', '') == '', 'NATIVE_' + mode.upper() + '_FAILED')
        text = value['StandardOutputContent'].strip()
        need(text.startswith('FEATURE_RETIREMENT_GZIP_BASE64='), 'NATIVE_RECEIPT_INVALID')
        result = json.loads(gzip.decompress(base64.b64decode(text.split('=', 1)[1])))
        need(result.get('commit') == plan['commit']
             and result.get('mode') == mode, 'NATIVE_RESULT_IDENTITY_CHANGED')
        expected = {'preflight': 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED',
                    'release': 'FEATURE_RETIREMENT_DEPLOYED',
                    'readback': 'FEATURE_RETIREMENT_READBACK_VERIFIED'}
        need(result.get('status') == expected[mode], 'NATIVE_RESULT_STATUS_INVALID')
        (OUTPUT / (mode + '-receipt.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'mode': mode, 'status': result.get('status'), 'commit': plan['commit']}), flush=True)
        return result
    raise RuntimeError('FEATURE_RETIREMENT_ACCEPTED_COMMAND_STILL_PENDING')


def publish():
    plan, contract = prepare_plan()
    preflight = transport(plan, contract, 'preflight')
    need(preflight.get('status') == 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED'
         and type(preflight.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_INVALID')
    plan = {**plan, 'runtimeBaseline': preflight['runtimeBaseline']}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    transport(plan, contract, 'release')
    transport(plan, contract, 'readback')


if __name__ == '__main__':
    publish()
