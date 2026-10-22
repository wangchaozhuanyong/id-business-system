"""Main-only publication of the finite execution repair; no payment actions."""
import argparse
import base64
import time
import zlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-execution'
REPO = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
WORKFLOW = '.github/workflows/online-execution-publication.yml'


def load(name):
    import importlib.util
    spec = importlib.util.spec_from_file_location('execution_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('online-execution-release.py')
F = load('financial-closure-publication.py')
S = load('settled-checkout-publication.py')
need, sha, execute, git, github = P.need, P.sha, F.execute, F.git, F.github


def check(c):
    P.validate_contract(c)
    for name, digest in {**c['productionSources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == digest == sha(git('show', P.SOURCE + ':' + name)), 'SOURCE_CHANGED')
    for name, digest in c['controlPins'].items():
        need(re.fullmatch('[a-z][a-z0-9.-]+', name) and sha((HERE / name).read_bytes()) == digest, 'CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256']
         and sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'BUILD_INPUT_CHANGED')


def identity():
    F.WORKFLOW = WORKFLOW
    return F.native_identity()


def quality(c, commit):
    prs = github('commits/' + commit + '/pulls')
    prs = [p for p in prs if p.get('merged_at') and p['base']['ref'] == 'main' and p['merge_commit_sha'] == commit]
    need(len(prs) == 1, 'MERGED_SOURCE_REQUIRED')
    pr = prs[0]
    selected = pr['head']['sha']
    git('merge-base', '--is-ancestor', P.SOURCE, selected)
    evidence = {}
    for role, head, event in (('sources', selected, 'pull_request'), ('release', commit, 'push')):
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + head)['workflow_runs']
        runs = [r for r in runs if r['head_sha'] == head and r['event'] == event
                and r['status'] == 'completed' and r['conclusion'] == 'success']
        need(bool(runs), 'QUALITY_REQUIRED')
        run = runs[0]
        F.require_run(run, head, '.github/workflows/quality.yml', event)
        jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
        passed = {j['name'] for j in jobs if j['conclusion'] == 'success'}
        need({'quality', 'change-scope'} <= passed
             and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_JOBS_REQUIRED')
        evidence[role] = {'commit': head, 'runId': str(run['id']), 'runAttempt': str(run['run_attempt'])}
        if role == 'sources':
            need({'recharge (guards)', 'recharge (api)', 'recharge (online-engine)'} <= passed, 'SOURCE_QUALITY_REQUIRED')
            receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
            need(receipt.get('repository') == REPO and receipt.get('headSha') == head
                 and receipt.get('pullRequest') == pr['number'] and receipt.get('runId') == run['id']
                 and receipt.get('runAttempt') == run['run_attempt']
                 and receipt.get('testedTree') == git('rev-parse', commit + '^{tree}').decode().strip(), 'SOURCE_RECEIPT_CHANGED')
            evidence[role].update(pullRequest=pr['number'], sourceReceiptSha256=digest)
    P.verify_quality(evidence, commit)
    return evidence


def native_plan(c, native):
    return {**native, 'recipe': P.RECIPE, 'contractSha256': sha((HERE / P.CONTRACT_FILE).read_bytes()),
            'controlSources': {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}}


def build(c):
    check(c)
    native = identity()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    qa = quality(c, native['commit'])
    OUT.mkdir(parents=True, mode=0o700)
    plan = native_plan(c, native)
    capture = transport(plan, 'parent')
    need(capture['status'] == 'ONLINE_EXECUTION_PARENT_VERIFIED', 'PARENT_REQUIRED')
    context = OUT / 'context'
    with tarfile.open(fileobj=io.BytesIO(git('archive', P.CURRENT))) as archive:
        archive.extractall(context, filter='data')
    h = P.load('recharge-record-release.py')
    env = {**os.environ, 'NODE_ENV': 'production', 'PRISMA_GENERATE_SKIP_AUTOINSTALL': '1'}
    for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                    ('npm', 'run', 'prisma:mysql:generate'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/api')):
        subprocess.run(command, cwd=context, env=env, check=True)
    dist = context / 'apps/api/dist'
    before = h.file_inventory(dist)
    selected = {n: before[n] for n in P.MODULES}
    (OUT / 'parent-api-reproduction.json').write_text(json.dumps(selected, sort_keys=True, indent=2) + '\n')
    P.verify_parent_modules(c, selected, capture['baseline']['apiModules'])
    shared = h.file_inventory(context / 'packages/shared/dist')
    client = h.file_inventory(context / 'node_modules/.prisma/client')
    (context / P.WORKER).write_bytes(ROOT.joinpath(P.WORKER).read_bytes())
    subprocess.run(('npm', 'run', 'build', '--workspace', '@apple-business/api'), cwd=context, env=env, check=True)
    after = h.file_inventory(dist)
    delta = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)} - {'tsconfig.build.tsbuildinfo'}
    need(delta <= P.MODULES and {n for n in delta if n.endswith('.js')} == {n for n in P.MODULES if n.endswith('.js')}
         and h.file_inventory(context / 'packages/shared/dist') == shared
         and h.file_inventory(context / 'node_modules/.prisma/client') == client, 'COMPILED_SCOPE_CHANGED')
    payload = OUT / 'payload'
    for n in P.MODULES:
        target = payload / 'api/modules' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dist / n, target)
    for n in c['productionSources']:
        target = payload / 'source' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / n, target)
        if n.startswith(P.ENGINE):
            engine_target = payload / 'online-recharge/source' / n.removeprefix(P.ENGINE)
            engine_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / n, engine_target)
    proof = {**native, 'version': 1, 'scope': P.SCOPE, 'recipe': P.RECIPE,
        'contractSha256': plan['contractSha256'], 'productionSources': c['productionSources'],
        'controlSources': c['controlPins'], 'apiModules': {n: after[n] for n in P.MODULES},
        'files': h.file_inventory(payload), 'parentModulesReproduced': selected,
        'parentNativeModules': capture['baseline']['apiModules'],
        'baselineSharedUnchanged': True, 'baselineClientUnchanged': True,
        'qualityVerification': qa, 'nativeParentCapture': capture, 'businessActions': 0, 'migrationPerformed': False}
    P.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_EXECUTION_BUILT', **native, 'businessActions': 0}))


def publish(c):
    check(c)
    native = identity()
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT and not OUT.exists(), 'PUBLISH_INPUT_CHANGED')
    jobs = github('actions/runs/' + native['workflowRunId'] + '/attempts/' + native['workflowRunAttempt'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    qa = quality(c, native['commit'])
    rows = github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == 'online-execution-native-' + native['commit'] + '-' + native['workflowRunAttempt'] and not a['expired']]
    need(len(rows) == 1, 'NATIVE_ARTIFACT_MISSING')
    raw = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0].get('digest') == 'sha256:' + sha(raw), 'NATIVE_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(set(archive.namelist()) == {'bitbrowser-history-artifact.tar.gz', 'artifact-sha256.txt'}, 'ARTIFACT_LAYOUT')
        bundle = archive.read('bitbrowser-history-artifact.tar.gz')
        declared = archive.read('artifact-sha256.txt').decode().strip()
    need(sha(bundle) == declared, 'ARTIFACT_CHANGED')
    OUT.mkdir(parents=True, mode=0o700)
    h = P.load('recharge-record-release.py')
    payload = h.safe_archive(bundle, OUT / 'checked-content')
    proof_raw = (payload / 'build-proof.json').read_bytes()
    proof = json.loads(proof_raw)
    need(all(proof.get(k) == v for k, v in native.items()) and proof['qualityVerification'] == qa, 'BUILD_PROVENANCE_CHANGED')
    P.verify_proof(proof, proof, c, payload, h)
    plan = {**native_plan(c, native), 'artifactSha256': declared, 'buildProofSha256': sha(proof_raw),
            'qualityVerification': qa, 'nativeParentCapture': proof['nativeParentCapture']}
    path = OUT / 'bitbrowser-history-artifact.tar.gz'
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('线上代充执行修复：只替换已验证的 API 任务收尾模块及执行器文件。无迁移、付款或订阅操作。\n')
    tag = 'bitbrowser-history-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'],
            '--title', '线上代充执行修复 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/bitbrowser-history-artifact.tar.gz'
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    plan['runtimeBaseline'] = preflight['runtimeBaseline']
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan, 'release')
    need(result['status'] == 'BITBROWSER_HISTORY_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'ONLINE_EXECUTION_PUBLISHED', **native, 'businessActions': 0}))


def transport(plan, mode):
    output = OUT
    selected = {**plan, 'mode': mode}
    code = r'''
import base64,hashlib,importlib.util,json,os,re,urllib.request,zlib
from pathlib import Path
os.umask(0o077)
plan=json.loads(zlib.decompress(base64.b64decode(PLAN)))
directory=Path('/opt/id-business-v2/.staging/settled-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('ONLINE_EXECUTION_CONTROL_PATH')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('ONLINE_EXECUTION_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('ONLINE_EXECUTION_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('financial_release',directory/'online-execution-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 result=json.dumps(module.release(plan,c),sort_keys=True).encode()
 print(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(result)).decode()}))
except Exception as error:
 code=str(error)
 if not re.fullmatch('(?:ONLINE_EXECUTION|SETTLED_CHECKOUT|BITBROWSER_HISTORY|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK)_[A-Z0-9_]+',code):code='ONLINE_EXECUTION_REMOTE_FAILED'
 print(json.dumps({'status':'FAILED','code':code,'mode':plan['mode'],'businessActions':0}))
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
        '--document-name', 'AWS-RunShellScript', '--comment', 'online-execution-' + mode + '-' + plan['commit'][:12],
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
    raise RuntimeError('ONLINE_EXECUTION_RESULT_PENDING')



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("check", "build", "publish"))
    mode = parser.parse_args().mode
    c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
    {"check": check, "build": build, "publish": publish}[mode](c)


if __name__ == "__main__":
    main()
