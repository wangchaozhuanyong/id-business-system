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
OUTPUT = ROOT / '.deploy/registration-closure-release'
REPOSITORY = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_CLOSURE_' + code)


def execute(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True)
    need(result.returncode == 0, 'PLATFORM_REQUEST_FAILED')
    return result.stdout


def github(path):
    return json.loads(execute('gh', 'api', path))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def quality_source_evidence(commit, tree):
    prefix = 'repos/' + REPOSITORY
    runs = github(prefix + '/actions/workflows/quality.yml/runs?head_sha=' + commit + '&status=success&per_page=20')['workflow_runs']
    for run in runs:
        if (run['head_sha'] == commit and run.get('head_branch') == 'main'
                and run['event'] == 'push' and run['status'] == 'completed'
                and run['conclusion'] == 'success' and run['path'] == '.github/workflows/quality.yml'):
            return {'runId': str(run['id']), 'runAttempt': run['run_attempt'], 'testedTree': tree,
                    'kind': 'EXACT_MAIN_SUCCESS', 'commit': commit}
    pulls = github(prefix + '/commits/' + commit + '/pulls')
    for pr in pulls:
        if not (pr['merged_at'] and pr['merge_commit_sha'] == commit and pr['base']['ref'] == 'main'
                and pr['head']['repo'] and pr['head']['repo']['full_name'] == REPOSITORY):
            continue
        runs = github(prefix + '/actions/workflows/quality.yml/runs?event=pull_request&head_sha='
                      + pr['head']['sha'] + '&status=success&per_page=20')['workflow_runs']
        for run in runs:
            if not (run['head_sha'] == pr['head']['sha'] and run['event'] == 'pull_request'
                    and run['status'] == 'completed' and run['conclusion'] == 'success'
                    and run['path'] == '.github/workflows/quality.yml'):
                continue
            artifacts = github(prefix + '/actions/runs/' + str(run['id']) + '/artifacts?per_page=100')['artifacts']
            matches = [a for a in artifacts if a['name'] == 'quality-source-evidence-' + str(run['run_attempt'])
                       and not a['expired']]
            if len(matches) != 1:
                continue
            artifact = matches[0]
            raw = execute('gh', 'api', prefix + '/actions/artifacts/' + str(artifact['id']) + '/zip')
            need(len(raw) <= 1024**2 and artifact['digest'] == 'sha256:' + sha(raw), 'QUALITY_EVIDENCE_CHANGED')
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                need(archive.namelist() == ['evidence.json'] and archive.getinfo('evidence.json').file_size <= 16384,
                     'QUALITY_EVIDENCE_INVALID')
                proof = json.loads(archive.read('evidence.json'))
            if (proof.get('repository') != REPOSITORY or proof.get('runId') != run['id']
                    or proof.get('runAttempt') != run['run_attempt'] or proof.get('pullRequest') != pr['number']
                    or proof.get('headSha') != pr['head']['sha'] or proof.get('testedTree') != tree
                    or not re.fullmatch('[a-f0-9]{40}', proof.get('baseSha', ''))):
                continue
            return {'runId': str(run['id']), 'runAttempt': run['run_attempt'], 'testedTree': tree,
                    'kind': 'IDENTICAL_PR_TESTED_TREE', 'pullRequest': pr['number'],
                    'artifactDigest': artifact['digest'], 'proof': proof}
    raise RuntimeError('REGISTRATION_CLOSURE_QUALITY_SOURCE_EVIDENCE_UNAVAILABLE')


def prepare_plan():
    commit, run_id, attempt = (os.environ[n] for n in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    need(os.environ['GITHUB_REPOSITORY'] == REPOSITORY and os.environ['GITHUB_REF'] == 'refs/heads/main'
         and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch' and os.environ['RELEASE_COMMIT'] == commit
         and re.fullmatch('[a-f0-9]{40}', commit), 'MAIN_SELECTION_INVALID')
    run = github('repos/' + REPOSITORY + '/actions/runs/' + run_id)
    need(run['head_sha'] == commit and run['head_branch'] == 'main' and run['event'] == 'workflow_dispatch'
         and run['path'] == '.github/workflows/registration-closure-validation.yml'
         and str(run['run_attempt']) == attempt, 'WORKFLOW_IDENTITY_INVALID')
    jobs = github('repos/' + REPOSITORY + '/actions/runs/' + run_id + '/attempts/' + attempt + '/jobs')['jobs']
    validators = [job for job in jobs if job['name'] == 'validate']
    need(len(validators) == 1 and validators[0]['status'] == 'completed'
         and validators[0]['conclusion'] == 'success', 'NATIVE_VALIDATION_NOT_SUCCESSFUL')
    artifacts = github('repos/' + REPOSITORY + '/actions/runs/' + run_id + '/artifacts')['artifacts']
    matches = [a for a in artifacts if a['name'] == 'registration-closure-' + commit + '-' + attempt]
    need(len(matches) == 1 and not matches[0]['expired'], 'NATIVE_ARTIFACT_UNAVAILABLE')
    artifact = matches[0]
    zipped = execute('gh', 'api', 'repos/' + REPOSITORY + '/actions/artifacts/' + str(artifact['id']) + '/zip')
    need(len(zipped) <= 64 * 1024**2, 'NATIVE_ARTIFACT_TOO_LARGE')
    need(artifact.get('digest') == 'sha256:' + sha(zipped), 'NATIVE_ARTIFACT_DIGEST_CHANGED')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        need(set(archive.namelist()) == {'registration-closure-artifact.tar.gz', 'artifact-sha256.txt', 'database-verification.json'},
             'NATIVE_ARTIFACT_LAYOUT_INVALID')
        bundle, declared = archive.read('registration-closure-artifact.tar.gz'), archive.read('artifact-sha256.txt').decode().strip()
    need(re.fullmatch('[a-f0-9]{64}', declared) and sha(bundle) == declared, 'COMPILED_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    proof = json.loads(proof_raw)
    contract_raw = (ROOT / 'scripts/production-release/registration-closure-contract.json').read_bytes()
    contract = json.loads(contract_raw)
    tree = execute('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    quality = quality_source_evidence(commit, tree)
    quality.update(lockfileSha256=sha((ROOT / 'package-lock.json').read_bytes()),
                   workflowSha256=sha((ROOT / '.github/workflows/quality.yml').read_bytes()))
    need(len(bundle) <= 64 * 1024**2, 'COMPILED_ARTIFACT_TOO_LARGE')
    need(proof['commit'] == commit and proof['tree'] == tree and proof['workflowRunId'] == run_id
         and proof['workflowRunAttempt'] == attempt and proof['contractSha256'] == sha(contract_raw)
         and os.environ['EXPECTED_CURRENT'] == contract['expectedCurrent'], 'BUILD_IDENTITY_CHANGED')
    need(set(proof['controlSources']) == set(contract['controlFiles']), 'EXECUTOR_SCOPE_CHANGED')
    for name, expected in proof['controlSources'].items():
        need(sha((ROOT / 'scripts/production-release' / name).read_bytes()) == expected, 'EXECUTOR_SOURCE_CHANGED')
    bundle_path = OUTPUT / 'registration-closure-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    (OUTPUT / 'native-artifact.zip').write_bytes(zipped)
    tag = 'registration-closure-' + commit
    notes = OUTPUT / 'artifact-notes.md'
    notes.write_text('自动注册台账与代理管理闭环修复的原生构建产物。main `' + commit + '`；验证运行 https://github.com/'
                     + REPOSITORY + '/actions/runs/' + run_id + '。产物保存不代表服务器切换或付款成功。\n')
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', commit, '--title',
            'Registration inventory and proxy closure ' + commit[:12], '--notes-file', str(notes), '--prerelease')
    plan = {'commit': commit, 'tree': tree, 'branch': 'main', 'workflowRunId': run_id,
            'workflowRunAttempt': attempt, 'contractSha256': sha(contract_raw), 'artifactSha256': declared,
            'buildProofSha256': sha(proof_raw), 'controlSources': proof['controlSources'], 'qualitySourceEvidence': quality,
            'artifactUrl': 'https://github.com/' + REPOSITORY + '/releases/download/' + tag + '/registration-closure-artifact.tar.gz'}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    return plan, contract


def transport(plan, contract, mode):
    current = {**plan, 'mode': mode}
    raw_base = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + plan['commit'] + '/scripts/production-release/'
    code = """import hashlib,importlib.util,json,os,re,urllib.request
from pathlib import Path
os.umask(0o077)
plan=json.loads(PLAN_JSON)
directory=Path('/opt/id-business-v2/.staging/registration-closure-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 with urllib.request.urlopen(RAW_BASE+'registration-closure-contract.json',timeout=30) as response:contract_raw=response.read(1024*1024+1)
 if len(contract_raw)>1024*1024 or hashlib.sha256(contract_raw).hexdigest()!=plan['contractSha256']:raise RuntimeError('REGISTRATION_CLOSURE_CONTRACT_CHANGED')
 contract=json.loads(contract_raw)
 contract_path=directory/'registration-closure-contract.json'
 if contract_path.exists():
  if contract_path.is_symlink() or contract_path.read_bytes()!=contract_raw:raise RuntimeError('REGISTRATION_CLOSURE_CONTRACT_CHANGED')
 else:contract_path.write_bytes(contract_raw)
 for name,expected in plan['controlSources'].items():
  if not re.fullmatch('[a-z0-9.-]+',name):raise RuntimeError('REGISTRATION_CLOSURE_EXECUTOR_PATH_INVALID')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=expected:raise RuntimeError('REGISTRATION_CLOSURE_EXECUTOR_SOURCE_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('REGISTRATION_CLOSURE_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 path=directory/'registration-closure-release.py'
 spec=importlib.util.spec_from_file_location('recharge_record_controller',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 helper=module.load(directory/'recharge-record-release.py','availability_published_helper')
 utilities=helper.load_utilities(directory/'remote-deploy.py',plan['controlSources']['remote-deploy.py'])
 print(json.dumps(module.release(plan,contract,utilities,helper),sort_keys=True))
except Exception as error:
 code=str(error) if re.fullmatch('(?:REGISTRATION_CLOSURE|RECHARGE_RECORD|RECHARGE_BILLING|RECHARGE_AVAILABILITY)_[A-Z0-9_]+',str(error)) else 'REGISTRATION_CLOSURE_REMOTE_OPERATION_FAILED'
 print(json.dumps({'status':'REGISTRATION_CLOSURE_FAILED','code':code,'mode':plan['mode'],'commit':plan['commit'],'businessActions':0}))
 raise SystemExit(1) from None
"""
    source = 'PLAN_JSON=' + repr(json.dumps(current))
    source += '\nRAW_BASE=' + repr(raw_base) + '\n' + code
    parameters = {'commands': ["python3 - <<'RECORD_RELEASE'\n" + source + '\nRECORD_RELEASE'], 'executionTimeout': ['900']}
    receipt_path = OUTPUT / (mode + '-accepted-command.json')
    need(not receipt_path.exists(), 'COMMAND_ALREADY_ACCEPTED')
    response = json.loads(execute('aws', 'ssm', 'send-command', '--region', REGION, '--instance-ids', INSTANCE,
                                  '--document-name', 'AWS-RunShellScript', '--comment', 'registration-closure-' + mode
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
    raise RuntimeError('REGISTRATION_CLOSURE_ACCEPTED_COMMAND_STILL_PENDING')


def publish():
    plan, contract = prepare_plan()
    preflight = transport(plan, contract, 'preflight')
    need(preflight.get('status') == 'REGISTRATION_CLOSURE_PREFLIGHT_VERIFIED'
         and type(preflight.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_INVALID')
    accepted = json.loads((OUTPUT / 'preflight-accepted-command.json').read_bytes())
    plan = {**plan, 'runtimeBaseline': preflight['runtimeBaseline'],
            'runtimeObservationCommandId': accepted['CommandId']}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    for mode in ('release', 'readback'):
        transport(plan, contract, mode)


if __name__ == '__main__':
    publish()
