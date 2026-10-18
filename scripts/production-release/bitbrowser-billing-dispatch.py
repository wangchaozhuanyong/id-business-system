"""Single accepted native publication with persisted SSM receipts and independent readback."""
import hashlib
import importlib.util
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
HERE = Path(__file__).resolve().parent
OUT = ROOT / '.deploy/bitbrowser-billing-publication'
REPO = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'


def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_BILLING_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def execute(*args):
    return subprocess.check_output(args, cwd=ROOT)


def github(path):
    return json.loads(execute('gh', 'api', path))


def prepare():
    identity = dict(zip(('commit', 'workflowRunId', 'workflowRunAttempt'),
        (os.environ[n] for n in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))))
    commit, run_id, attempt = (identity[k] for k in ('commit', 'workflowRunId', 'workflowRunAttempt'))
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('RELEASE_COMMIT') == commit, 'MAIN_IDENTITY_INVALID')
    run = github('repos/' + REPO + '/actions/runs/' + run_id)
    need(run['head_sha'] == commit and run['head_branch'] == 'main'
        and run['path'] == '.github/workflows/bitbrowser-billing-validation.yml'
        and str(run['run_attempt']) == attempt, 'WORKFLOW_CHANGED')
    jobs = github('repos/' + REPO + '/actions/runs/' + run_id + '/attempts/' + attempt + '/jobs')['jobs']
    validate = [j for j in jobs if j['name'] == 'validate']
    need(len(validate) == 1 and validate[0]['status'] == 'completed'
        and validate[0]['conclusion'] == 'success', 'NATIVE_VALIDATION_REQUIRED')
    rows = github('repos/' + REPO + '/actions/runs/' + run_id + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == 'bitbrowser-billing-' + commit + '-' + attempt and not a['expired']]
    need(len(rows) == 1, 'NATIVE_ARTIFACT_MISSING')
    zipped = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0].get('digest') == 'sha256:' + sha(zipped), 'NATIVE_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        need(set(archive.namelist()) == {'recharge-checkout-artifact.tar.gz', 'artifact-sha256.txt'}, 'ZIP_LAYOUT_INVALID')
        bundle, declared = archive.read('recharge-checkout-artifact.tar.gz'), archive.read('artifact-sha256.txt').decode().strip()
    need(re.fullmatch('[a-f0-9]{64}', declared) and sha(bundle) == declared, 'BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
    proof = json.loads(raw)
    c_raw = (HERE / 'bitbrowser-billing-contract.json').read_bytes()
    c = json.loads(c_raw)
    identity['tree'] = execute('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    need(all(proof[k] == v for k, v in identity.items()) and proof['contractSha256'] == sha(c_raw)
        and os.environ.get('EXPECTED_CURRENT') == c['expectedCurrent'], 'BUILD_IDENTITY_CHANGED')
    need(set(proof['qualityVerification']) == {'release', 'sources'}, 'QUALITY_SCOPE_INVALID')
    for role, evidence in proof['qualityVerification'].items():
        checked = github('repos/' + REPO + '/actions/runs/' + evidence['runId'])
        need(checked['head_sha'] == evidence['commit']
            and (checked['event'] == 'pull_request' and evidence['commit'] == c['sourceReviewCommit']
                if role == 'sources' else checked['event'] == 'push' and checked['head_branch'] == 'main' and evidence['commit'] == commit)
            and checked['path'] == '.github/workflows/quality.yml'
            and checked['conclusion'] == 'success'
            and execute('git', 'rev-parse', evidence['commit'] + '^{tree}').decode().strip() == evidence['tree'],
            'QUALITY_CHANGED')
    OUT.mkdir(mode=0o700, parents=True, exist_ok=False)
    bundle_path = OUT / 'recharge-checkout-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    (OUT / 'build-proof.json').write_bytes(raw)
    spec = importlib.util.spec_from_file_location('billing_native_release', HERE / 'bitbrowser-billing-release.py')
    p = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p)
    p.validate_contract(c)
    p.verify_mysql(proof['isolatedMysqlVerification'], identity, c)
    controls = {**c['controlPins'], 'bitbrowser-billing-contract.json': sha(c_raw)}
    need(all(sha((HERE / n).read_bytes()) == v for n, v in controls.items()), 'CONTROLS_CHANGED')
    notes = OUT / 'artifact-notes.md'
    notes.write_text('比特自动充值有限修复构建。发布不代表真实充值成功；不提交付款。\n')
    tag = 'recharge-checkout-' + commit
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', commit,
        '--title', 'BitBrowser billing repair ' + commit[:12], '--notes-file', str(notes), '--prerelease')
    plan = {**identity, 'contractSha256': sha(c_raw), 'controlSources': controls,
        'artifactSha256': declared, 'buildProofSha256': sha(raw),
        'qualityVerification': proof['qualityVerification'], 'isolatedMysqlVerification': proof['isolatedMysqlVerification'],
        'artifactUrl': 'https://github.com/' + REPO + '/releases/download/' + tag + '/recharge-checkout-artifact.tar.gz'}
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    return plan


def transport(plan, mode):
    selected = {**plan, 'mode': mode}
    code = '''import hashlib,importlib.util,json,os,re,urllib.request
from pathlib import Path
os.umask(0o077)
plan=json.loads(PLAN_JSON)
directory=Path('/opt/id-business-v2/.staging/bitbrowser-billing-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('BITBROWSER_BILLING_CONTROL_PATH_INVALID')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('BITBROWSER_BILLING_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('BITBROWSER_BILLING_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('billing_release',directory/'bitbrowser-billing-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/'bitbrowser-billing-contract.json').read_bytes())
 print(json.dumps(module.release(plan,c),sort_keys=True))
except Exception as error:
 code=str(error) if re.fullmatch('(?:BITBROWSER_BILLING|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK)_[A-Z0-9_]+',str(error)) else 'BITBROWSER_BILLING_REMOTE_OPERATION_FAILED'
 print(json.dumps({'status':'FAILED','code':code,'mode':plan['mode'],'businessActions':0}))
 raise SystemExit(1) from None
'''
    source = 'PLAN_JSON=' + repr(json.dumps(selected)) + '\nRAW_BASE=' + repr(
        'https://raw.githubusercontent.com/' + REPO + '/' + plan['commit'] + '/scripts/production-release/') + '\n' + code
    compile(source, 'finite-publication', 'exec')
    parameters = {'commands': ["python3 - <<'BILLING_RELEASE'\n" + source + '\nBILLING_RELEASE'], 'executionTimeout': ['900']}
    receipt, intent = OUT / (mode + '-accepted.json'), OUT / (mode + '-intent.json')
    need(not receipt.exists() and not intent.exists(), 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    with intent.open('x') as output:
        json.dump({'mode': mode, 'commit': plan['commit'], 'parametersSha256': sha(json.dumps(parameters, sort_keys=True).encode())}, output)
        output.flush()
        os.fsync(output.fileno())
    value = json.loads(subprocess.check_output(['aws', '--region', 'ap-northeast-1', 'ssm', 'send-command',
        '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--comment',
        'bitbrowser-billing-' + mode + '-' + plan['commit'][:12], '--parameters', json.dumps(parameters),
        '--output', 'json'], cwd=ROOT, env={**os.environ, 'AWS_MAX_ATTEMPTS': '1'}))
    command = value['Command']['CommandId']
    receipt.write_text(json.dumps({'CommandId': command, 'InstanceId': INSTANCE}) + '\n')
    print(json.dumps({'acceptedCommandId': command, 'mode': mode}), flush=True)
    for _ in range(180):
        response = subprocess.run(['aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation',
            '--command-id', command, '--instance-id', INSTANCE, '--output', 'json'], cwd=ROOT, capture_output=True)
        if response.returncode:
            time.sleep(5)
            continue
        result = json.loads(response.stdout)
        if result['Status'] in ('Pending', 'InProgress', 'Delayed'):
            time.sleep(5)
            continue
        (OUT / (mode + '-invocation.json')).write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
        need(result['Status'] == 'Success' and result['ResponseCode'] == 0 and not result['StandardErrorContent'],
            'NATIVE_OPERATION_FAILED')
        report = json.loads(result['StandardOutputContent'])
        (OUT / (mode + '-result.json')).write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        return report
    raise RuntimeError('BITBROWSER_BILLING_RESULT_PENDING')


if __name__ == '__main__':
    plan = prepare()
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == 'RECHARGE_CHECKOUT_PREFLIGHT_VERIFIED', 'PREFLIGHT_NOT_VERIFIED')
    plan['runtimeBaseline'] = preflight['runtimeBaseline']
    released = transport(plan, 'release')
    need(released['status'] == 'RECHARGE_CHECKOUT_DEPLOYED', 'NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'RECHARGE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED', 'READBACK_NOT_VERIFIED')
    print(json.dumps(readback, sort_keys=True))
