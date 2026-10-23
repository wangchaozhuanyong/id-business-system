"""Authenticate PR checks and publish the existing engine-only source overlay."""
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'online-readonly-probe'
WORKFLOW = '.github/workflows/online-readonly-probe-publication.yml'
REPO = 'wangchaozhuanyong/id-business-system'
OUT = ROOT / '.deploy' / PREFIX


def load(name):
    import importlib.util
    spec = importlib.util.spec_from_file_location('native_fetch_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load(PREFIX + '-release.py')
F = load('financial-closure-publication.py')
need, sha, git, github, execute = P.need, P.sha, F.git, F.github, F.execute
INSTANCE = 'i-05836da38606e633c'
CONTROLS = frozenset((WORKFLOW, 'scripts/ci-online-settings-scope.mjs',
    'scripts/ci-online-settings-scope.test.mjs', 'scripts/ci-recharge-scope.mjs',
    *('scripts/production-release/' + PREFIX + '-' + suffix
      for suffix in ('release.py', 'publication.py', 'release.test.py', 'contract.json'))))


def check(c):
    P.validate_contract(c)
    for n, v in {**c['runtimeSources'], **c['validationSources']}.items():
        need(sha((ROOT / n).read_bytes()) == v == sha(git('show', P.SOURCE + ':' + n)), 'SOURCE_CHANGED')
    need(set(git('diff', '--name-only', P.SOURCE, 'HEAD').decode().splitlines()) <= CONTROLS,
         'UNREVIEWED_EXTENSION')
    need(all(not (HERE / n).is_symlink() and sha((HERE / n).read_bytes()) == v
             for n, v in c['controlPins'].items())
         and sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256']
         and sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'CONTROL_CHANGED')
    rows = json.loads((ROOT / P.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())['files']
    need({r['path']: r['adaptedSha256'] for r in rows} ==
         {n: v for n, v in c['afterEngineFiles'].items() if n != 'SOURCE_MANIFEST.json'}, 'SOURCE_MANIFEST_CHANGED')


def identity():
    F.WORKFLOW = WORKFLOW
    return F.native_identity()


def quality(commit, tree):
    linked = github('commits/' + commit + '/pulls')
    selected = [pr for pr in linked if pr.get('merged_at') and pr.get('merge_commit_sha') == commit
                and pr['base']['ref'] == 'main' and pr['head']['repo']['full_name'] == REPO]
    need(len(selected) == 1, 'MERGED_SOURCE_REQUIRED')
    pr = selected[0]
    head = pr['head']['sha']
    git('merge-base', '--is-ancestor', P.SOURCE, head)
    need(set(git('diff', '--name-only', P.SOURCE, head).decode().splitlines()) <= CONTROLS,
         'REVIEW_EXTENSION_CHANGED')
    need(git('rev-parse', head + '^{tree}').decode().strip() == tree, 'REVIEW_TREE_CHANGED')
    evidence = None
    for sha_value, event in ((head, 'pull_request'), (commit, 'push')):
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + sha_value)['workflow_runs']
        runs = [r for r in runs if r['head_sha'] == sha_value and r['event'] == event
                and r['status'] == 'completed' and r['conclusion'] == 'success']
        need(bool(runs), 'QUALITY_REQUIRED')
        run = runs[0]
        F.require_run(run, sha_value, '.github/workflows/quality.yml', event)
        jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
        required = {'quality', 'change-scope'}
        if event == 'pull_request': required |= {'recharge (guards)', 'recharge (online-engine)'}
        need(required <= {j['name'] for j in jobs if j['conclusion'] == 'success'}
             and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_JOBS_REQUIRED')
        if event == 'pull_request':
            receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
            need(receipt.get('repository') == REPO and receipt.get('headSha') == head
                 and receipt.get('pullRequest') == pr['number'] and receipt.get('testedTree') == tree
                 and receipt.get('runId') == run['id'] and receipt.get('runAttempt') == run['run_attempt'],
                 'QUALITY_RECEIPT_CHANGED')
            evidence = {'commit': commit, 'tree': tree, 'pullRequest': pr['number'], 'head': head,
                'runId': str(run['id']), 'runAttempt': str(run['run_attempt']),
                'sourceReviewCommit': P.SOURCE, 'sourceReceiptSha256': digest}
    P.verify_quality(evidence, commit, tree)
    return evidence


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
    need(parent['status'] == 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'PARENT_REQUIRED')
    payload = OUT / 'payload'
    files = {'engine/' + n: c['afterEngineFiles'][n] for n in P.FILES}
    for n in P.FILES:
        dest = payload / 'engine' / n
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes((ROOT / P.ENGINE / n).read_bytes())
    proof = {**plan, 'scope': P.SCOPE, 'qualitySourceEvidence': qa, 'nativeParentCapture': parent,
             'runtimeSources': c['runtimeSources'], 'beforeEngineFiles': c['beforeEngineFiles'],
             'afterEngineFiles': c['afterEngineFiles'], 'files': files,
             'businessActions': 0, 'migrationPerformed': False}
    P.verify_proof(proof, proof, c, files)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        for path in sorted(payload.rglob('*')):
            if path.is_file():
                archive.add(path, arcname=path.relative_to(OUT).as_posix(), recursive=False)
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_READONLY_PROBE_BUILT', **native, 'businessActions': 0}))


def publish(c):
    check(c)
    native = identity()
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT and not OUT.exists(), 'PUBLISH_INPUT_CHANGED')
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
    payload = P.load('shared-bank-card-release.py').safe_archive(bundle, OUT / 'checked-content')
    proof_raw = (payload / 'build-proof.json').read_bytes()
    proof = json.loads(proof_raw)
    need(all(proof.get(k) == v for k, v in native.items()) and proof['qualitySourceEvidence'] == qa, 'BUILD_PROVENANCE_CHANGED')
    files = P.load('recharge-record-release.py').file_inventory(payload)
    files.pop('build-proof.json')
    P.verify_proof(proof, proof, c, files)
    plan = {**native_plan(c, native), 'artifactSha256': declared, 'buildProofSha256': sha(proof_raw),
            'qualitySourceEvidence': qa, 'nativeParentCapture': proof['nativeParentCapture']}
    path = OUT / filename
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('线上代充：修正原结账单只读诊断的预算、准备与证据保留，仅更新本轮执行器文件。无迁移或付款。\n')
    tag = PREFIX + '-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'],
            '--title', '线上代充只读诊断修复 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + filename
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == P.SCOPE + '_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan, 'release')
    need(result['status'] == P.SCOPE + '_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == P.SCOPE + '_INDEPENDENT_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'ONLINE_READONLY_PROBE_PUBLISHED', **native, 'businessActions': 0}))


def transport(plan, mode):
    output = OUT
    selected = {**plan, 'mode': mode}
    code = r'''
import base64,hashlib,importlib.util,json,os,re,urllib.request,zlib
from pathlib import Path
os.umask(0o077)
plan=json.loads(zlib.decompress(base64.b64decode(PLAN)))
directory=Path('/opt/id-business-v2/.staging/session-probe-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('ONLINE_READONLY_PROBE_CONTROL_PATH')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('ONLINE_READONLY_PROBE_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('ONLINE_READONLY_PROBE_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('financial_release',directory/'online-readonly-probe-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 result=json.dumps(module.release(plan,c),sort_keys=True).encode()
 print(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(result)).decode()}))
except Exception as error:
 report={'status':'FAILED','code':'ONLINE_READONLY_PROBE_REMOTE_FAILED','mode':plan['mode'],'businessActions':0}
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
        '--document-name', 'AWS-RunShellScript', '--comment', 'online-readonly-probe-' + mode + '-' + plan['commit'][:12],
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
    raise RuntimeError('ONLINE_READONLY_PROBE_RESULT_PENDING')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("check", "build", "publish"))
    mode = parser.parse_args().mode
    c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
    {"check": check, "build": build, "publish": publish}[mode](c)


if __name__ == "__main__":
    main()
