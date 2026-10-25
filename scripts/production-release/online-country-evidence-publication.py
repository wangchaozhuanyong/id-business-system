"""Publish the reviewed checkout-resume API/engine pair using native CI and SSM receipts."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time
import zipfile
import zlib
import importlib.util

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'online-country-evidence'
WORKFLOW = '.github/workflows/' + PREFIX + '-publication.yml'
REPO = 'wangchaozhuanyong/id-business-system'
OUT = ROOT / '.deploy' / PREFIX
INSTANCE = 'i-0838cebf64f0e2a89'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

P = load(PREFIX + '-release.py')
F = load('financial-closure-publication.py')
need, sha, git, github, execute = P.need, P.sha, F.git, F.github, F.execute
CONTROLS = frozenset((WORKFLOW, 'scripts/ci-unpaid-validation-scope.mjs', 'scripts/ci-unpaid-validation-scope.test.mjs',
    *('scripts/production-release/' + PREFIX + '-' + suffix for suffix in
      ('release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'))))


def check(c):
    P.validate_contract(c)
    for name, digest in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == digest == sha(git('show', P.SOURCE + ':' + name)), 'SOURCE_CHANGED')
    need(set(git('diff', '--name-only', P.SOURCE, 'HEAD').decode().splitlines()) <= CONTROLS, 'UNREVIEWED_EXTENSION')
    need(all(sha((HERE / n).read_bytes()) == v for n, v in c['controlPins'].items()), 'CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256']
         and sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'BUILD_INPUT_CHANGED')


def identity():
    F.WORKFLOW = WORKFLOW
    need(json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == '098208446664', 'AWS_ACCOUNT_CHANGED')
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT, 'EXPECTED_CURRENT_CHANGED')
    return F.native_identity()


def verified_run(head, event, tree, pr_number=None):
    runs = github('actions/workflows/quality.yml/runs?head_sha=' + head)['workflow_runs']
    runs = [r for r in runs if r['head_sha'] == head and r['event'] == event and r['conclusion'] == 'success']
    need(bool(runs), 'QUALITY_REQUIRED')
    run = runs[0]
    F.require_run(run, head, '.github/workflows/quality.yml', event)
    jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
    successful = {j['name'] for j in jobs if j['conclusion'] == 'success'}
    need({'quality', 'change-scope'} <= successful and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_PARTS_REQUIRED')
    if event == 'pull_request':
        need(('full-quality' in successful) or ('recharge (guards)' in successful), 'REVIEW_CHECK_REQUIRED')
        if pr_number == 715:
            need({'recharge (guards)', 'recharge (api)', 'recharge (admin)', 'recharge (online-engine)'} <= successful, 'SOURCE_API_ENGINE_QUALITY_REQUIRED')
        receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
        need(receipt['repository'] == REPO and receipt['pullRequest'] == pr_number
             and receipt['headSha'] == head and receipt['testedTree'] == tree
             and receipt['runId'] == run['id'] and receipt['runAttempt'] == run['run_attempt'], 'QUALITY_RECEIPT_CHANGED')
        return {'head': head, 'tree': tree, 'pullRequest': pr_number, 'runId': str(run['id']),
                'runAttempt': str(run['run_attempt']), 'sourceReceiptSha256': digest}
    return {'head': head, 'runId': str(run['id']), 'runAttempt': str(run['run_attempt'])}


def quality(commit, tree):
    source = github('pulls/715')
    need(source.get('merged_at') and source['head']['sha'] == P.SOURCE
         and source['base']['ref'] == 'main', 'SOURCE_MERGE_REQUIRED')
    git('merge-base', '--is-ancestor', source['merge_commit_sha'], commit)
    source_tree = git('rev-parse', P.SOURCE + '^{tree}').decode().strip()
    source_qa = verified_run(P.SOURCE, 'pull_request', source_tree, 715)
    prs = [r for r in github('commits/' + commit + '/pulls') if r.get('merged_at')
           and r['merge_commit_sha'] == commit and r['base']['ref'] == 'main' and r['head']['repo']['full_name'] == REPO]
    need(len(prs) == 1, 'MERGED_CONTROL_REQUIRED')
    pr = prs[0]
    need(set(git('diff', '--name-only', pr['base']['sha'], pr['head']['sha']).decode().splitlines()) <= CONTROLS, 'CONTROL_PR_BUSINESS_CHANGED')
    need(git('rev-parse', pr['head']['sha'] + '^{tree}').decode().strip() == tree, 'REVIEW_TREE_CHANGED')
    control = verified_run(pr['head']['sha'], 'pull_request', tree, pr['number'])
    main = verified_run(commit, 'push', tree)
    return {'source': source_qa, 'control': control, 'main': main, 'commit': commit, 'tree': tree}


def native_plan(c, native):
    return {**native, 'contractSha256': sha((HERE / P.CONTRACT_FILE).read_bytes()),
            'controlSources': {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}}


def build(c):
    check(c)
    native = identity()
    qa = quality(native['commit'], native['tree'])
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    plan = native_plan(c, native)
    parent = transport(plan, 'parent')
    need(parent['status'] == 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'PARENT_REQUIRED')
    load(PREFIX + '-build.py').build(c, plan, qa, parent, OUT)


def publish(c):
    check(c)
    native = identity()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    jobs = github('actions/runs/' + native['workflowRunId'] + '/attempts/' + native['workflowRunAttempt'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    qa = quality(native['commit'], native['tree'])
    rows = github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == PREFIX + '-native-' + native['commit'] + '-' + native['workflowRunAttempt'] and not a['expired']]
    need(len(rows) == 1, 'NATIVE_ARTIFACT_MISSING')
    raw = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0].get('digest') == 'sha256:' + sha(raw), 'NATIVE_ARTIFACT_CHANGED')
    filename = PREFIX + '-artifact.tar.gz'
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(set(archive.namelist()) == {filename, 'artifact-sha256.txt'}, 'ARTIFACT_LAYOUT')
        bundle, declared = archive.read(filename), archive.read('artifact-sha256.txt').decode().strip()
    need(sha(bundle) == declared, 'ARTIFACT_CHANGED')
    OUT.mkdir(parents=True, mode=0o700)
    payload = load('shared-bank-card-release.py').safe_archive(bundle, OUT / 'checked-content')
    proof_raw = (payload / 'build-proof.json').read_bytes()
    proof = json.loads(proof_raw)
    need(all(proof.get(k) == v for k, v in native.items()) and proof['qualitySourceEvidence'] == qa, 'BUILD_PROVENANCE_CHANGED')
    files = load('recharge-record-release.py').file_inventory(payload)
    files.pop('build-proof.json')
    plan = {**native_plan(c, native), 'artifactSha256': declared, 'buildProofSha256': sha(proof_raw),
            'qualitySourceEvidence': qa, 'nativeParentCapture': proof['nativeParentCapture']}
    P.verify_proof(proof, plan, {**c, **proof['nativeParentCapture']['baseline']}, files)
    path = OUT / filename
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('仅更新已审查的移动代理浏览器分区修复与提示。API复用相同已发布编译字节，保留其他服务；无迁移、无业务任务、无付款。\n')
    tag = PREFIX + '-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'],
            '--title', '线上代充出口会话修复 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + filename
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == 'ONLINE_CHECKOUT_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan, 'release')
    need(result['status'] == 'ONLINE_CHECKOUT_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'ONLINE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'ONLINE_PROFILE_EGRESS_PUBLISHED', **native, 'businessActions': 0}))


def transport(plan, mode):
    output = OUT
    selected = {**plan, 'mode': mode}
    code = r'''
import base64,hashlib,importlib.util,json,os,re,urllib.request,zlib
from pathlib import Path
os.umask(0o077)
plan=json.loads(zlib.decompress(base64.b64decode(PLAN)))
directory=Path('/opt/id-business-v2/.staging/checkout-resume-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('ONLINE_CHECKOUT_CONTROL_PATH')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('ONLINE_CHECKOUT_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('ONLINE_CHECKOUT_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('financial_release',directory/'online-country-evidence-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 result=json.dumps(module.release(plan,c),sort_keys=True).encode()
 print(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(result)).decode()}))
except Exception as error:
 report={'status':'FAILED','code':'ONLINE_CHECKOUT_REMOTE_FAILED','mode':plan['mode'],'businessActions':0}
 if 'module' in locals() and hasattr(module,'failure_report'):report=module.failure_report(error,plan)
 print(json.dumps(report))
 raise SystemExit(1) from None
'''
    source = 'PLAN=' + repr(base64.b64encode(zlib.compress(json.dumps(selected).encode())).decode())
    source += '\nRAW_BASE=' + repr('https://raw.githubusercontent.com/' + REPO + '/' + plan['commit'] + '/scripts/production-release/') + '\n' + code
    compile(source, '<financial-publication>', 'exec')
    parameters = {'commands': ["python3 - <<'SETTLED_RELEASE'\n" + source + '\nSETTLED_RELEASE'],
                  'executionTimeout': ['900']}
    intent, accepted = output / (mode + '-intent.json'), output / (mode + '-accepted.json')
    need(not intent.exists() and not accepted.exists(), 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    with intent.open('x') as f:
        json.dump({'mode': mode, 'commit': plan['commit'], 'parametersSha256': sha(P.canonical(parameters))}, f)
        f.flush()
        os.fsync(f.fileno())
    sent = subprocess.run(['aws', '--region', 'ap-northeast-1', 'ssm', 'send-command', '--instance-ids', INSTANCE,
        '--document-name', 'AWS-RunShellScript', '--comment', 'online-country-evidence-' + mode + '-' + plan['commit'][:12],
        '--parameters', json.dumps(parameters), '--query', 'Command.CommandId', '--output', 'text'],
        cwd=ROOT, capture_output=True, timeout=120, env={**os.environ, 'AWS_MAX_ATTEMPTS': '1'})
    need(sent.returncode == 0, 'COMMAND_ACCEPTANCE_UNCERTAIN')
    command = sent.stdout.decode().strip()
    need(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', command), 'COMMAND_ID')
    accepted.write_text(json.dumps({'CommandId': command, 'InstanceId': INSTANCE}) + '\n')
    print(json.dumps({'acceptedCommandId': command, 'mode': mode}), flush=True)
    for _ in range(180):
        time.sleep(5)
        response = subprocess.run(['aws', '--region', 'ap-northeast-1', 'ssm', 'get-command-invocation',
            '--command-id', command, '--instance-id', INSTANCE, '--output', 'json'],
            cwd=ROOT, capture_output=True, timeout=90)
        if response.returncode:
            continue
        invocation = json.loads(response.stdout)
        if invocation['Status'] in ('Pending', 'InProgress', 'Delayed'):
            continue
        need(invocation.get('CommandId') == command and invocation.get('InstanceId') == INSTANCE
             and invocation.get('DocumentName') == 'AWS-RunShellScript'
             and invocation.get('PluginName') == 'aws:runShellScript', 'NATIVE_RECEIPT_IDENTITY')
        (output / (mode + '-invocation.json')).write_bytes(response.stdout)
        need(invocation['Status'] == 'Success' and invocation['ResponseCode'] == 0
             and type(invocation['ResponseCode']) is int
             and not invocation.get('StandardErrorContent'), 'NATIVE_OPERATION_FAILED')
        envelope = json.loads(invocation['StandardOutputContent'])
        need(set(envelope) == {'zlibBase64'} and len(envelope['zlibBase64']) < 24000, 'NATIVE_REPORT_INVALID')
        decoder = zlib.decompressobj()
        decoded = decoder.decompress(base64.b64decode(envelope['zlibBase64']), 128 * 1024 + 1)
        need(len(decoded) <= 128 * 1024 and decoder.eof and not decoder.unused_data, 'NATIVE_REPORT_BOUND')
        report = json.loads(decoded)
        need(type(report) is dict and report.get('businessActions') == 0, 'NATIVE_REPORT_INVALID')
        (output / (mode + '-result.json')).write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        return report
    raise RuntimeError('ONLINE_CHECKOUT_RESULT_PENDING')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish'))
    args = parser.parse_args()
    contract = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
    {'check': check, 'build': build, 'publish': publish}[args.mode](contract)
