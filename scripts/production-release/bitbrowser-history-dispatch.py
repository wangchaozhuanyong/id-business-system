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
OUT = ROOT / '.deploy/bitbrowser-history-publication'
REPO = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
SCOPE = 'BITBROWSER_HISTORY_PAGINATION_20261019'
CURRENT = 'fe27681e1ef06b14616276dff33c3febeea47579'
RECIPE = os.environ.get('BITBROWSER_RELEASE_RECIPE', 'history-20261019')
CONTRACT_FILE = 'bitbrowser-history-contract.json'
if RECIPE == 'entry-start-20261019':
    CURRENT = '5f122fcb841c6029b46b023f41562529b7b4bde0'
    SCOPE = 'BITBROWSER_ENTRY_START_20261019'
    CONTRACT_FILE = 'bitbrowser-entry-start-contract.json'
elif RECIPE == 'followup-20261019':
    CURRENT = '02a348a6c6b252968bc63ccb38c7d2b82e0e0c66'
    SCOPE = 'BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019'
    CONTRACT_FILE = 'bitbrowser-followup-contract.json'
elif RECIPE != 'history-20261019':
    raise RuntimeError('BITBROWSER_HISTORY_RECIPE_INVALID')


def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_HISTORY_' + code)


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
    need(github('repos/' + REPO + '/git/ref/heads/main')['object']['sha'] == commit,
        'CURRENT_MAIN_REQUIRED')
    run = github('repos/' + REPO + '/actions/runs/' + run_id)
    need(run['head_sha'] == commit and run['head_branch'] == 'main'
        and run['path'] == '.github/workflows/bitbrowser-history-validation.yml'
        and str(run['run_attempt']) == attempt, 'WORKFLOW_CHANGED')
    jobs = github('repos/' + REPO + '/actions/runs/' + run_id + '/attempts/' + attempt + '/jobs')['jobs']
    validate = [j for j in jobs if j['name'] == 'validate']
    need(len(validate) == 1 and validate[0]['status'] == 'completed'
        and validate[0]['conclusion'] == 'success', 'NATIVE_VALIDATION_REQUIRED')
    rows = github('repos/' + REPO + '/actions/runs/' + run_id + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == 'bitbrowser-history-' + commit + '-' + attempt and not a['expired']]
    need(len(rows) == 1, 'NATIVE_ARTIFACT_MISSING')
    zipped = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0].get('digest') == 'sha256:' + sha(zipped), 'NATIVE_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        need(set(archive.namelist()) == {'bitbrowser-history-artifact.tar.gz', 'artifact-sha256.txt'}, 'ZIP_LAYOUT_INVALID')
        bundle, declared = archive.read('bitbrowser-history-artifact.tar.gz'), archive.read('artifact-sha256.txt').decode().strip()
    need(re.fullmatch('[a-f0-9]{64}', declared) and sha(bundle) == declared, 'BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
    proof = json.loads(raw)
    c_raw = (HERE / CONTRACT_FILE).read_bytes()
    c = json.loads(c_raw)
    identity['tree'] = execute('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    need(all(proof[k] == v for k, v in identity.items()) and proof['contractSha256'] == sha(c_raw)
        and proof.get('scope') == c.get('scope') == SCOPE
        and os.environ.get('EXPECTED_CURRENT') == c.get('expectedCurrent') == CURRENT, 'BUILD_IDENTITY_CHANGED')
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
    bundle_path = OUT / 'bitbrowser-history-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    (OUT / 'build-proof.json').write_bytes(raw)
    spec = importlib.util.spec_from_file_location('history_native_release', HERE / 'bitbrowser-history-release.py')
    p = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p)
    p.select_recipe(RECIPE)
    p.validate_contract(c)
    p.verify_mysql(proof['isolatedMysqlVerification'], identity, c)
    controls = {**c['controlPins'], CONTRACT_FILE: sha(c_raw)}
    need(all(sha((HERE / n).read_bytes()) == v for n, v in controls.items()), 'CONTROLS_CHANGED')
    notes = OUT / 'artifact-notes.md'
    notes.write_text('比特自动充值有限修复构建；更新范围以冻结契约为准，不提交付款。\n')
    tag = 'bitbrowser-history-' + commit
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', commit,
        '--title', 'BitBrowser history pagination ' + commit[:12], '--notes-file', str(notes), '--prerelease')
    plan = {**identity, 'recipe': RECIPE, 'contractSha256': sha(c_raw), 'controlSources': controls,
        'artifactSha256': declared, 'buildProofSha256': sha(raw),
        'qualityVerification': proof['qualityVerification'], 'isolatedMysqlVerification': proof['isolatedMysqlVerification'],
        'artifactUrl': 'https://github.com/' + REPO + '/releases/download/' + tag + '/bitbrowser-history-artifact.tar.gz'}
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    return plan


def transport(plan, mode):
    selected = {**plan, 'mode': mode}
    code = '''import hashlib,importlib.util,json,os,re,urllib.request
from pathlib import Path
os.umask(0o077)
plan=json.loads(PLAN_JSON)
directory=Path('/opt/id-business-v2/.staging/bitbrowser-history-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('BITBROWSER_HISTORY_CONTROL_PATH_INVALID')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('BITBROWSER_HISTORY_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('BITBROWSER_HISTORY_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('history_release',directory/'bitbrowser-history-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.select_recipe(plan.get('recipe','history-20261019'))
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 print(json.dumps(module.release(plan,c),sort_keys=True))
except Exception as error:
 code=str(error) if re.fullmatch('(?:BITBROWSER_HISTORY|BITBROWSER_RECOVERY|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK)_[A-Z0-9_]+',str(error)) else 'BITBROWSER_HISTORY_REMOTE_OPERATION_FAILED'
 print(json.dumps({'status':'FAILED','code':code,'mode':plan['mode'],'businessActions':0}))
 raise SystemExit(1) from None
'''
    source = 'PLAN_JSON=' + repr(json.dumps(selected)) + '\nRAW_BASE=' + repr(
        'https://raw.githubusercontent.com/' + REPO + '/' + plan['commit'] + '/scripts/production-release/') + '\n' + code
    compile(source, 'finite-publication', 'exec')
    parameters = {'commands': ["python3 - <<'HISTORY_RELEASE'\n" + source + '\nHISTORY_RELEASE'], 'executionTimeout': ['900']}
    receipt, intent = OUT / (mode + '-accepted.json'), OUT / (mode + '-intent.json')
    need(not receipt.exists() and not intent.exists(), 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    with intent.open('x') as output:
        json.dump({'mode': mode, 'commit': plan['commit'], 'parametersSha256': sha(json.dumps(parameters, sort_keys=True).encode())}, output)
        output.flush()
        os.fsync(output.fileno())
    value = json.loads(subprocess.check_output(['aws', '--region', 'ap-northeast-1', 'ssm', 'send-command',
        '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript', '--comment',
        'bitbrowser-history-' + mode + '-' + plan['commit'][:12], '--parameters', json.dumps(parameters),
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
    raise RuntimeError('BITBROWSER_HISTORY_RESULT_PENDING')


if __name__ == '__main__':
    plan = prepare()
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'PREFLIGHT_NOT_VERIFIED')
    plan['runtimeBaseline'] = preflight['runtimeBaseline']
    released = transport(plan, 'release')
    need(released['status'] == 'BITBROWSER_HISTORY_DEPLOYED', 'NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'READBACK_NOT_VERIFIED')
    print(json.dumps(readback, sort_keys=True))
