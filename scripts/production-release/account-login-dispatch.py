"""Bind successful native Actions validation to one accepted SSM publication."""
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
OUTPUT = ROOT / '.deploy/account-login-release'
REPOSITORY = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'


def need(value, code):
    if not value:
        raise RuntimeError('ACCOUNT_LOGIN_' + code)


def execute(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True)
    need(result.returncode == 0, 'PLATFORM_REQUEST_FAILED')
    return result.stdout


def github(path):
    return json.loads(execute('gh', 'api', path))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def prepare_plan():
    if os.environ.get('VALIDATED_RUN'):
        return prepare_reused_plan()
    commit, run_id, attempt = (os.environ[n] for n in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    need(os.environ['GITHUB_REPOSITORY'] == REPOSITORY and os.environ['GITHUB_REF'] == 'refs/heads/main'
         and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch' and os.environ['RELEASE_COMMIT'] == commit
         and re.fullmatch('[a-f0-9]{40}', commit), 'MAIN_SELECTION_INVALID')
    run = github('repos/' + REPOSITORY + '/actions/runs/' + run_id)
    need(run['head_sha'] == commit and run['head_branch'] == 'main' and run['event'] == 'workflow_dispatch'
         and run['path'] == '.github/workflows/account-login-validation.yml'
         and str(run['run_attempt']) == attempt, 'WORKFLOW_IDENTITY_INVALID')
    jobs = github('repos/' + REPOSITORY + '/actions/runs/' + run_id + '/attempts/' + attempt + '/jobs')['jobs']
    validators = [job for job in jobs if job['name'] == 'validate']
    need(len(validators) == 1 and validators[0]['status'] == 'completed'
         and validators[0]['conclusion'] == 'success', 'NATIVE_VALIDATION_NOT_SUCCESSFUL')
    artifacts = github('repos/' + REPOSITORY + '/actions/runs/' + run_id + '/artifacts')['artifacts']
    matches = [a for a in artifacts if a['name'] == 'account-login-' + commit + '-' + attempt]
    need(len(matches) == 1 and not matches[0]['expired'], 'NATIVE_ARTIFACT_UNAVAILABLE')
    artifact = matches[0]
    zipped = execute('gh', 'api', 'repos/' + REPOSITORY + '/actions/artifacts/' + str(artifact['id']) + '/zip')
    need(artifact.get('digest') == 'sha256:' + sha(zipped), 'NATIVE_ARTIFACT_DIGEST_CHANGED')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        need(set(archive.namelist()) == {'account-login-artifact.tar.gz', 'artifact-sha256.txt'},
             'NATIVE_ARTIFACT_LAYOUT_INVALID')
        bundle, declared = archive.read('account-login-artifact.tar.gz'), archive.read('artifact-sha256.txt').decode().strip()
    need(re.fullmatch('[a-f0-9]{64}', declared) and sha(bundle) == declared, 'COMPILED_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    proof = json.loads(proof_raw)
    contract_raw = (ROOT / 'scripts/production-release/account-login-contract.json').read_bytes()
    contract = json.loads(contract_raw)
    tree = execute('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    need(proof['commit'] == commit and proof['tree'] == tree and proof['workflowRunId'] == run_id
         and proof['workflowRunAttempt'] == attempt and proof['contractSha256'] == sha(contract_raw)
         and os.environ['EXPECTED_CURRENT'] == contract['expectedCurrent'], 'BUILD_IDENTITY_CHANGED')
    quality = proof.get('qualityVerification', {})
    need(quality.get('commit') == commit and quality.get('sourceTree') == tree
         and quality.get('path') == '.github/workflows/quality.yml'
         and quality.get('conclusion') == 'success' and re.fullmatch('[1-9][0-9]*', str(quality.get('runId', ''))), 'QUALITY_PROOF_INVALID')
    checked = github('repos/' + REPOSITORY + '/actions/runs/' + quality['runId'])
    need(checked['head_sha'] == commit and checked['head_branch'] == 'main' and checked['event'] == 'push'
         and checked['path'] == quality['path'] and checked['conclusion'] == 'success', 'QUALITY_GATE_CHANGED')
    for field, name in [('controllerSha256', 'account-login-release.py'), ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        need(proof[field] == sha((ROOT / 'scripts/production-release' / name).read_bytes()), 'EXECUTOR_SOURCE_CHANGED')
    bundle_path = OUTPUT / 'account-login-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    (OUTPUT / 'native-artifact.zip').write_bytes(zipped)
    tag = 'account-login-' + commit
    notes = OUTPUT / 'artifact-notes.md'
    notes.write_text('ChatGPT 账号出售状态的原生构建产物及隔离迁移验证。main `' + commit + '`；验证运行 https://github.com/'
                     + REPOSITORY + '/actions/runs/' + run_id + '。产物保存不代表服务器切换或付款成功。\n')
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', commit, '--title',
            'ChatGPT account sales ' + commit[:12], '--notes-file', str(notes), '--prerelease')
    plan = {'qualityVerification': quality, 'commit': commit, 'tree': tree, 'branch': 'main', 'workflowRunId': run_id,
            'workflowRunAttempt': attempt, 'contractSha256': sha(contract_raw), 'artifactSha256': declared,
            'buildProofSha256': sha(proof_raw), 'controllerSha256': proof['controllerSha256'],
            'releaseUtilitySha256': proof['releaseUtilitySha256'], 'helperSha256': proof['helperSha256'], 'availabilityHelperSha256': sha((ROOT / 'scripts/production-release/recharge-availability-release.py').read_bytes()), 'controlSources': {n: sha((ROOT / 'scripts/production-release' / n).read_bytes()) for n in ('account-login-release.py', 'recharge-record-release.py', 'remote-deploy.py', 'recharge-availability-release.py', 'account-login-contract.json')}, 'artifactUrl': 'https://github.com/'
            + REPOSITORY + '/releases/download/' + tag + '/account-login-artifact.tar.gz'}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    return plan, contract


def prepare_reused_plan():
    # Reuse only the successful validator of the one known preflight failure.
    source = '13e52ad670c6b6daa94ab2df009aaa8a9d69b97c'
    run_id = '38878982040'
    need(os.environ['VALIDATED_RUN'] == run_id and os.environ['GITHUB_REPOSITORY'] == REPOSITORY
         and os.environ['GITHUB_REF'] == 'refs/heads/main'
         and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch'
         and os.environ['GITHUB_SHA'] == os.environ['RELEASE_COMMIT'], 'REUSE_SELECTION_INVALID')
    current = os.environ['GITHUB_SHA']
    meta = github('repos/' + REPOSITORY + '/actions/runs/' + run_id)
    need(meta['head_sha'] == source and meta['head_branch'] == 'main'
         and meta['path'] == '.github/workflows/account-login-validation.yml'
         and meta['conclusion'] == 'failure' and meta['run_attempt'] == 1, 'REUSED_NATIVE_CHANGED')
    jobs = github('repos/' + REPOSITORY + '/actions/runs/' + run_id + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'REUSED_VALIDATOR_NOT_SUCCESSFUL')
    contract_raw = (ROOT / 'scripts/production-release/account-login-contract.json').read_bytes()
    contract = json.loads(contract_raw)
    need(execute('git', 'show', source + ':scripts/production-release/account-login-contract.json') == contract_raw
         and os.environ['EXPECTED_CURRENT'] == contract['expectedCurrent'], 'REUSED_CONTRACT_CHANGED')
    for name, expected in {**contract['sources'], **contract['supportSources']}.items():
        need(sha((ROOT / name).read_bytes()) == expected == sha(execute('git', 'show', source + ':' + name)), 'REUSED_APPLICATION_CHANGED')
    for role in ('api', 'admin'):
        for name in contract['buildInputs'][role]:
            need(execute('git','ls-tree',source,'--',name) == execute('git','ls-tree','HEAD','--',name), 'REUSED_DEPENDENCY_CHANGED')
    publisher = github('repos/' + REPOSITORY + '/actions/runs/' + os.environ['GITHUB_RUN_ID'])
    need(publisher['head_sha'] == current and publisher['head_branch'] == 'main'
         and publisher['path'] == '.github/workflows/account-login-validation.yml', 'PUBLISHER_IDENTITY_CHANGED')
    quality = github('repos/' + REPOSITORY + '/actions/runs?head_sha=' + current + '&event=push')['workflow_runs']
    need(any(r['head_branch']=='main' and r['path']=='.github/workflows/quality.yml' and r['conclusion']=='success' for r in quality), 'PUBLISHER_QUALITY_NOT_SUCCESSFUL')
    artifacts = github('repos/' + REPOSITORY + '/actions/runs/' + run_id + '/artifacts')['artifacts']
    rows = [r for r in artifacts if r['name'] == 'account-login-' + source + '-1' and not r['expired']]
    need(len(rows)==1, 'REUSED_ARTIFACT_MISSING')
    zipped = execute('gh','api','repos/' + REPOSITORY + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0]['digest'] == 'sha256:' + sha(zipped), 'REUSED_ARCHIVE_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        need(set(archive.namelist()) == {'account-login-artifact.tar.gz','artifact-sha256.txt'}, 'REUSED_LAYOUT_INVALID')
        bundle = archive.read('account-login-artifact.tar.gz')
        declared = archive.read('artifact-sha256.txt').decode().strip()
    need(sha(bundle) == declared, 'REUSED_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
    proof = json.loads(raw)
    need(proof['commit'] == source and proof['workflowRunId'] == run_id and proof['workflowRunAttempt'] == '1'
         and proof['contractSha256'] == sha(contract_raw), 'REUSED_PROOF_IDENTITY_CHANGED')
    checked = github('repos/' + REPOSITORY + '/actions/runs/' + proof['qualityVerification']['runId'])
    need(checked['head_sha'] == source and checked['head_branch'] == 'main'
         and checked['path'] == '.github/workflows/quality.yml' and checked['conclusion'] == 'success', 'REUSED_QUALITY_CHANGED')
    OUTPUT.mkdir(parents=True,exist_ok=True)
    (OUTPUT / 'account-login-artifact.tar.gz').write_bytes(bundle)
    (OUTPUT / 'reused-build-proof.json').write_bytes(raw)
    names = ('account-login-release.py','recharge-record-release.py','remote-deploy.py','recharge-availability-release.py','account-login-contract.json')
    controls = {n:sha((ROOT / 'scripts/production-release' / n).read_bytes()) for n in names}
    plan = {'commit': source,'tree':proof['tree'],'branch':'main','workflowRunId':os.environ['GITHUB_RUN_ID'],
            'workflowRunAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'validationRunId':run_id,'validationRunAttempt':'1',
            'controllerCommit':current,'validatedControllerSha256':proof['controllerSha256'],
            'qualityVerification':proof['qualityVerification'],'contractSha256':sha(contract_raw),
            'artifactSha256':declared,'buildProofSha256':sha(raw),'controllerSha256':controls['account-login-release.py'],
            'releaseUtilitySha256':controls['remote-deploy.py'],'helperSha256':controls['recharge-record-release.py'],
            'availabilityHelperSha256':controls['recharge-availability-release.py'],'controlSources':controls,
            'artifactUrl':'https://github.com/' + REPOSITORY + '/releases/download/account-login-' + source + '/account-login-artifact.tar.gz'}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan,sort_keys=True,indent=2)+'\n')
    return plan, contract


def transport(plan, contract, mode):
    current = {**plan, 'mode': mode}
    raw_base = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + plan.get('controllerCommit', plan['commit']) + '/scripts/production-release/'
    code = """import hashlib,importlib.util,json,os,re,urllib.request
from pathlib import Path
os.umask(0o077)
plan=json.loads(PLAN_JSON)
directory=Path('/opt/id-business-v2/.staging/account-login-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 with urllib.request.urlopen(RAW_BASE+'account-login-contract.json',timeout=30) as response:contract_raw=response.read(256*1024+1)
 if len(contract_raw)>256*1024 or hashlib.sha256(contract_raw).hexdigest()!=plan['contractSha256']:raise RuntimeError('ACCOUNT_LOGIN_CONTRACT_CHANGED')
 contract=json.loads(contract_raw)
 contract_path=directory/'account-login-contract.json'
 if contract_path.exists():
  if contract_path.is_symlink() or contract_path.read_bytes()!=contract_raw:raise RuntimeError('ACCOUNT_LOGIN_CONTRACT_CHANGED')
 else:contract_path.write_bytes(contract_raw)
 for name,field in [('account-login-release.py','controllerSha256'),('remote-deploy.py','releaseUtilitySha256'),('recharge-record-release.py','helperSha256'),('recharge-availability-release.py','availabilityHelperSha256')]:
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=plan[field]:raise RuntimeError('ACCOUNT_LOGIN_EXECUTOR_SOURCE_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('ACCOUNT_LOGIN_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 path=directory/'account-login-release.py'
 spec=importlib.util.spec_from_file_location('recharge_record_controller',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 helper=module.load(directory/'recharge-record-release.py','availability_published_helper')
 utilities=helper.load_utilities(directory/'remote-deploy.py',plan['releaseUtilitySha256'])
 print(json.dumps(module.release(plan,contract,utilities,helper),sort_keys=True))
except Exception as error:
 code=str(error) if re.fullmatch('(?:ACCOUNT_LOGIN|RECHARGE_RECORD|RECHARGE_AVAILABILITY)_[A-Z0-9_]+',str(error)) else 'ACCOUNT_LOGIN_REMOTE_OPERATION_FAILED'
 print(json.dumps({'status':'ACCOUNT_LOGIN_FAILED','code':code,'mode':plan['mode'],'commit':plan['commit'],'businessActions':0}))
 raise SystemExit(1) from None
"""
    source = 'PLAN_JSON=' + repr(json.dumps(current))
    source += '\nRAW_BASE=' + repr(raw_base) + '\n' + code
    parameters = {'commands': ["python3 - <<'RECORD_RELEASE'\n" + source + '\nRECORD_RELEASE'], 'executionTimeout': ['900']}
    receipt_path = OUTPUT / (mode + '-accepted-command.json')
    need(not receipt_path.exists(), 'COMMAND_ALREADY_ACCEPTED')
    response = json.loads(execute('aws', 'ssm', 'send-command', '--region', REGION, '--instance-ids', INSTANCE,
                                  '--document-name', 'AWS-RunShellScript', '--comment', 'account-login-' + mode
                                  + '-' + plan['commit'][:12], '--parameters', json.dumps(parameters), '--output', 'json'))
    command = response['Command']['CommandId']
    receipt_path.write_text(json.dumps({'CommandId': command, 'InstanceId': INSTANCE}) + '\n')
    print(json.dumps({'mode': mode, 'acceptedCommandId': command}), flush=True)
    for _ in range(180):
        process = subprocess.run(['aws', 'ssm', 'get-command-invocation', '--region', REGION, '--command-id', command,
                                  '--instance-id', INSTANCE, '--output', 'json'], cwd=ROOT, capture_output=True)
        if process.returncode:
            time.sleep(5)
            continue
        value = json.loads(process.stdout)
        if value['Status'] in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        (OUTPUT / (mode + '-native-invocation.json')).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
        need(value['Status'] == 'Success' and value['ResponseCode'] == 0 and value.get('StandardErrorContent', '') == '',
             'NATIVE_' + mode.upper() + '_FAILED')
        result = json.loads(value['StandardOutputContent'])
        need(result.get('commit') == plan['commit'], 'NATIVE_RESULT_IDENTITY_CHANGED')
        print(json.dumps(result, sort_keys=True), flush=True)
        return result
    raise RuntimeError('ACCOUNT_LOGIN_ACCEPTED_COMMAND_STILL_PENDING')


def publish():
    plan, contract = prepare_plan()
    preflight = transport(plan, contract, 'preflight')
    need(preflight.get('status') == 'ACCOUNT_LOGIN_PREFLIGHT_VERIFIED'
         and type(preflight.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_INVALID')
    accepted = json.loads((OUTPUT / 'preflight-accepted-command.json').read_bytes())
    plan = {**plan, 'runtimeBaseline': preflight['runtimeBaseline'],
            'runtimeObservationCommandId': accepted['CommandId']}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    for mode in ('release', 'readback'):
        transport(plan, contract, mode)


if __name__ == '__main__':
    publish()
