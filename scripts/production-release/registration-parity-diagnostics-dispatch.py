"""Dispatch the finite no-migration successor through the existing registration workflow."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.deploy/registration-parity-diagnostics'
REPOSITORY = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def execute(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True)
    need(result.returncode == 0, 'PLATFORM_REQUEST_FAILED')
    return result.stdout


def github(path):
    return json.loads(execute('gh', 'api', path))


def verified_contract():
    path = Path(__file__).with_name('registration-parity-diagnostics-release.py')
    spec = importlib.util.spec_from_file_location('parity_local_admission', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raw = Path(__file__).with_name('registration-parity-diagnostics-contract.json').read_bytes()
    contract = json.loads(raw)
    module.verify_contract(contract)
    return raw, contract


def prepare_plan():
    contract_raw, contract = verified_contract()
    commit = os.environ['RELEASE_COMMIT']
    need(re.fullmatch('[a-f0-9]{40}', commit) and os.environ['GITHUB_REF'] == 'refs/heads/main'
         and os.environ['GITHUB_REPOSITORY'] == REPOSITORY
         and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch'
         and os.environ.get('REGISTRATION_PARITY_DIAGNOSTICS') == '1' and os.environ['GITHUB_SHA'] == commit and execute('git', 'rev-parse', 'HEAD').decode().strip() == commit,
         'MAIN_IDENTITY_INVALID')
    need(os.environ['EXPECTED_CURRENT'] == contract['expectedCurrent'], 'BASELINE_INPUT_CHANGED')
    path = Path(__file__).with_name('registration-closure-dispatch.py')
    need(sha(path.read_bytes()) == contract['qualityEvidenceHelperSha256'], 'QUALITY_HELPER_CHANGED')
    spec = importlib.util.spec_from_file_location('verified_quality_evidence_only', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tree = execute('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    quality = module.quality_source_evidence(commit, tree)
    run_id, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    prefix = 'repos/' + REPOSITORY + '/'
    run = github(prefix + 'actions/runs/' + run_id)
    jobs = github(prefix + 'actions/runs/' + run_id + '/jobs?per_page=100')['jobs']
    need(run['head_sha'] == commit and run['head_branch'] == 'main' and run['event'] == 'workflow_dispatch'
         and run['run_attempt'] == int(attempt) and run['path'] == '.github/workflows/registration-parity-diagnostics-validation.yml'
         and sum(job['name'] == 'validate' and job['conclusion'] == 'success' for job in jobs) == 1,
         'NATIVE_VALIDATION_MISSING')
    artifacts = github(prefix + 'actions/runs/' + run_id + '/artifacts')['artifacts']
    matches = [a for a in artifacts if a['name'] == 'registration-parity-diagnostics-' + commit + '-' + attempt and not a['expired']]
    need(len(matches) == 1 and matches[0]['size_in_bytes'] <= 16 * 1024**2, 'ARTIFACT_INVALID')
    zipped = execute('gh', 'api', prefix + 'actions/artifacts/' + str(matches[0]['id']) + '/zip')
    need(len(zipped) <= 16 * 1024**2 and matches[0]['digest'] == 'sha256:' + sha(zipped), 'ARTIFACT_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        names = archive.namelist()
        need(set(names) == {'registration-parity-diagnostics-artifact.tar.gz', 'artifact-sha256.txt'}
             and all(archive.getinfo(name).file_size <= 16 * 1024**2 for name in names), 'ARTIFACT_CONTENT_INVALID')
        bundle = archive.read('registration-parity-diagnostics-artifact.tar.gz')
        need(sha(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
    proof = json.loads(raw)
    need(proof['commit'] == commit and proof['tree'] == tree and proof['workflowRunId'] == run_id
         and proof['workflowRunAttempt'] == attempt and proof['contractSha256'] == sha(contract_raw)
         and proof['sources'] == contract['sources'] and set(proof['controlSources']) == set(contract['controlFiles']), 'PROOF_CHANGED')
    for name, expected in proof['controlSources'].items():
        need(sha(Path(__file__).with_name(name).read_bytes()) == expected, 'EXECUTOR_CHANGED')
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    bundle_path = OUTPUT / 'registration-parity-diagnostics-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    notes = OUTPUT / 'artifact-notes.md'
    notes.write_text('注册流程证据的 API 与 Admin 精确增量；保存产物不代表生产切换或真实注册验收。\n')
    tag = 'registration-parity-diagnostics-' + commit
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', commit, '--title',
            'Registration flow evidence ' + commit[:12], '--notes-file', str(notes), '--prerelease')
    plan = {'commit': commit, 'tree': tree, 'workflowRunId': run_id, 'workflowRunAttempt': attempt,
            'contractSha256': sha(contract_raw), 'controlSources': proof['controlSources'],
            'artifactSha256': sha(bundle), 'buildProofSha256': sha(raw), 'qualitySourceEvidence': quality,
            'artifactUrl': 'https://github.com/' + REPOSITORY + '/releases/download/' + tag + '/registration-parity-diagnostics-artifact.tar.gz'}
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    return plan, contract


def transport(plan, mode):
    verified_contract()
    need(mode in ('preflight', 'release', 'readback'), 'MODE_INVALID')
    receipt = OUTPUT / (mode + '-accepted-command.json')
    need(not receipt.exists(), 'COMMAND_ALREADY_ACCEPTED')
    current = {**plan, 'mode': mode}
    raw_base = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + plan['commit'] + '/scripts/production-release/'
    code = """import sys
sys.dont_write_bytecode=True
import hashlib,importlib.util,json,os,re,traceback,urllib.request
from pathlib import Path
os.umask(0o077)
plan=json.loads(PLAN_JSON)
entry=Path('/opt/id-business-v2/.staging/registration-parity-diagnostics-entry-'+plan['commit']+'-'+plan['workflowRunId'])
entry.mkdir(mode=0o700,parents=True,exist_ok=True)
stage='ENTRY_DOWNLOAD'
try:
 with urllib.request.urlopen(RAW_BASE+'registration-parity-diagnostics-contract.json',timeout=30) as response:raw=response.read(256*1024+1)
 if len(raw)>256*1024 or hashlib.sha256(raw).hexdigest()!=plan['contractSha256']:raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_CONTRACT_CHANGED')
 contract=json.loads(raw)
 for name,expected in plan['controlSources'].items():
  if not re.fullmatch('[a-z0-9.-]+',name):raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_EXECUTOR_PATH_INVALID')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:source=response.read(2*1024**2+1)
  if len(source)>2*1024**2 or hashlib.sha256(source).hexdigest()!=expected:raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_EXECUTOR_CHANGED')
  path=entry/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=source:raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_ENTRY_CHANGED')
  else:path.write_bytes(source)
 stage='LOAD_VERIFIED_EXECUTOR'
 path=entry/'registration-parity-diagnostics-release.py';spec=importlib.util.spec_from_file_location('finite_engine_identity',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 h=module.helper('recharge-record-release.py');d=h.load_utilities(entry/'remote-deploy.py',plan['controlSources']['remote-deploy.py'])
 stage=plan['mode'].upper()
 print(json.dumps(module.release(plan,contract,d,h),sort_keys=True))
except BaseException as error:
 message=str(error);code=message if re.fullmatch('(?:REGISTRATION_PARITY_DIAGNOSTICS|RECHARGE_RECORD|RECHARGE_AVAILABILITY|RECHARGE_BILLING|REGISTRATION_CLOSURE|API_ADMIN_ONLINE)_[A-Z0-9_]+',message) else 'REGISTRATION_PARITY_DIAGNOSTICS_OPERATION_FAILED'
 frames=[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name}for f in traceback.extract_tb(error.__traceback__)]
 print(json.dumps({'status':'REGISTRATION_PARITY_DIAGNOSTICS_FAILED','code':code,'stage':stage,'mode':plan['mode'],'commit':plan['commit'],'errorType':type(error).__name__,'frames':frames,'businessActions':0}))
 raise SystemExit(1) from None
"""
    source = 'PLAN_JSON=' + repr(json.dumps(current)) + '\nRAW_BASE=' + repr(raw_base) + '\n' + code
    parameters = {'commands': ["python3 -B - <<'FINITE_ENGINE_IDENTITY'\n" + source + '\nFINITE_ENGINE_IDENTITY'], 'executionTimeout': ['900']}
    accepted = json.loads(execute('aws', 'ssm', 'send-command', '--region', REGION, '--instance-ids', INSTANCE,
        '--document-name', 'AWS-RunShellScript', '--comment', 'registration-parity-diagnostics-' + mode + '-' + plan['commit'][:12],
        '--parameters', json.dumps(parameters), '--output', 'json'))
    command = accepted['Command']['CommandId']
    receipt.write_text(json.dumps({'CommandId': command, 'InstanceId': INSTANCE}) + '\n')
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
        need(value['Status'] == 'Success' and value['ResponseCode'] == 0 and not value.get('StandardErrorContent'), 'NATIVE_' + mode.upper() + '_FAILED')
        result = json.loads(value['StandardOutputContent'])
        need(result['commit'] == plan['commit'], 'NATIVE_IDENTITY_CHANGED')
        print(json.dumps(result, sort_keys=True), flush=True)
        return result
    raise RuntimeError('REGISTRATION_PARITY_DIAGNOSTICS_ACCEPTED_COMMAND_STILL_PENDING')


def publish():
    plan, _ = prepare_plan()
    before = transport(plan, 'preflight')
    need(before.get('status') == 'REGISTRATION_PARITY_DIAGNOSTICS_PREFLIGHT_VERIFIED', 'PREFLIGHT_RECEIPT_INVALID')
    plan['runtimeBaseline'] = before['runtimeBaseline']
    (OUTPUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    transport(plan, 'release')
    transport(plan, 'readback')


def main():
    publish()


if __name__ == '__main__':
    need(len(sys.argv) == 1, 'DISPATCH_ARGUMENTS_INVALID')
    main()
