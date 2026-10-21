"""Main-only finite native tax context publication; no API or payment actions."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import zipfile
import zlib
import importlib.util

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/settled-checkout'
REPO = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
WORKFLOW = '.github/workflows/settled-checkout-publication.yml'


def load(name):
    spec = importlib.util.spec_from_file_location('settled_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('settled-checkout-release.py')
F = load('financial-closure-publication.py')
need, sha = P.need, P.sha
git, github, execute = F.git, F.github, F.execute


def check(c):
    P.validate_contract(c)
    for name, digest in {**c['productionSources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == digest == sha(git('show', P.SOURCE + ':' + name)),
             'REVIEWED_SOURCE_CHANGED')
    for name, digest in c['controlPins'].items():
        need(re.fullmatch('[a-z][a-z0-9.-]+', name)
             and sha((HERE / name).read_bytes()) == digest, 'CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    finance = json.loads((HERE / 'financial-closure-contract.json').read_bytes())
    need(sha((ROOT / 'package-lock.json').read_bytes()) == finance['buildDependencyPatch']['sha256'],
         'BUILD_LOCK_CHANGED')


def quality(c, commit):
    pr = github('pulls/' + str(c['sourcePullRequest']))
    need(pr.get('merged_at') and pr['base']['ref'] == 'main' and pr['head']['sha'] == P.SOURCE,
         'MERGED_SOURCE_REQUIRED')
    git('merge-base', '--is-ancestor', pr['merge_commit_sha'], commit)
    evidence = {}
    for role, selected, event in (('sources', P.SOURCE, 'pull_request'), ('release', commit, 'push')):
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + selected)['workflow_runs']
        runs = [r for r in runs if r['head_sha'] == selected and r['event'] == event
                and r['status'] == 'completed' and r['conclusion'] == 'success']
        need(bool(runs), 'QUALITY_REQUIRED')
        run = runs[0]
        F.require_run(run, selected, '.github/workflows/quality.yml', event)
        jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt'])
                      + '/jobs?per_page=100')['jobs']
        need({'quality', 'change-scope'} <= {j['name'] for j in jobs if j['conclusion'] == 'success'}
             and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_JOBS_REQUIRED')
        evidence[role] = {'commit': selected, 'runId': str(run['id']), 'runAttempt': str(run['run_attempt'])}
        if role == 'sources':
            need({'recharge (admin)', 'recharge (guards)'} <= {
                 j['name'] for j in jobs if j['conclusion'] == 'success'}, 'SOURCE_ADMIN_QUALITY_REQUIRED')
            receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
            need(receipt.get('repository') == REPO and receipt.get('headSha') == selected
                 and receipt.get('pullRequest') == c['sourcePullRequest']
                 and receipt.get('runId') == run['id'] and receipt.get('runAttempt') == run['run_attempt']
                 and receipt.get('testedTree') == git('rev-parse', pr['merge_commit_sha'] + '^{tree}').decode().strip(),
                 'SOURCE_RECEIPT_CHANGED')
            evidence[role].update(pullRequest=c['sourcePullRequest'], sourceReceiptSha256=digest)
    P.verify_quality(evidence, commit)
    return evidence


def identity():
    F.WORKFLOW = WORKFLOW
    return F.native_identity()


def reconstruct_parent(c):
    b = load('bitbrowser-history-build.py')
    b.OUT = OUT / 'reconstruction'
    b.OUT.mkdir(mode=0o700)
    legacy = b.load('bitbrowser-history-release.py')
    legacy.select_recipe(legacy.BOUNDED)
    _, admin = b.reconstruct_bounded_parent(legacy)
    prior = json.loads((HERE / 'bitbrowser-bounded-hold-contract.json').read_bytes())
    manual = json.loads((HERE / 'bitbrowser-manual-contract.json').read_bytes())
    published = json.loads((HERE / 'financial-closure-parent-proof.json').read_bytes())
    finance = json.loads((HERE / 'financial-closure-contract.json').read_bytes())
    b.overlay(admin, {n: v for n, v in prior['productionSources'].items() if n.startswith('apps/admin/')}, prior['sourceReviewCommit'])
    for name, row in manual['reconstructedParents'].items():
        if name.startswith('apps/admin/'):
            b.overlay(admin, {name: row['sourceSha256']}, row['sourceCommit'])
    b.overlay(admin, {n: v for n, v in published['productionSources'].items()
                     if n.startswith(('apps/admin/', 'packages/shared/'))}, manual['sourceReviewCommit'])
    b.overlay(admin, {n: v for n, v in finance['productionSources'].items() if n.startswith('apps/admin/')}, finance['sourceReviewCommit'])
    # Reproduce the already-published header repair before applying this successor.
    b.overlay(admin, {'apps/admin/src/v2/features/auto-recharge/bitbrowser-payment-page.ts':
                     '5e7c50d16146187b2d1c4a5d217974309566a993332e20408cd3c64e0a6a6bdb'},
              '893da2f6f8a9b06a26f43b13b87cd5cb89fb499d')
    # Preserve the published omitted-tax-id compatibility in the reproduced parent.
    b.overlay(admin, {'apps/admin/src/v2/features/auto-recharge/bitbrowser-native-quote.ts': '09a899e6eebd872eb6b404cd24c962afb4d7389775f76ddff137bb854d75bd23'},
              'ec6987a1b32d1991a2a5a318f58b3f491c51408a')
    F.patch_build_lock(admin, finance)
    need(all(sha((admin / name).read_bytes()) == digest for name, digest in c['sourceParents'].items()), 'BUILD_SOURCE_PARENT_CHANGED')
    return admin, b


def verify_delta(before, after, c):
    need(before == c['adminParent']['adminFiles'], 'NATIVE_PARENT_NOT_REPRODUCED')
    need(len(after) >= 250 and 'index.html' in after
         and after['index.html'] != before['index.html'], 'ADMIN_OUTPUT_UNCHANGED')


def build(c):
    check(c)
    native = identity()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    qa = quality(c, native['commit'])
    OUT.mkdir(parents=True, mode=0o700)
    admin, b = reconstruct_parent(c)
    h = P.load('recharge-record-release.py')
    env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + c['adminParent']['commit']}
    for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/admin')):
        subprocess.run(command, cwd=admin, env=env, check=True)
    dist = admin / 'apps/admin/dist'
    before = h.file_inventory(dist)
    (OUT / 'parent-admin-reproduction.json').write_text(json.dumps(before, sort_keys=True, indent=2) + '\n')
    need(before == c['adminParent']['adminFiles'], 'NATIVE_PARENT_NOT_REPRODUCED')
    b.overlay(admin, c['productionSources'], P.SOURCE)
    subprocess.run(('npm', 'run', 'build', '--workspace', '@apple-business/admin'), cwd=admin,
                   env={**env, 'V2_BUILD_ID': 'v2-' + native['commit']}, check=True)
    after = h.file_inventory(dist)
    verify_delta(before, after, c)
    payload = OUT / 'payload'
    shutil.copytree(dist, payload / 'admin/html')
    for name in c['productionSources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {**native, 'version': 1, 'scope': P.SCOPE, 'recipe': P.RECIPE,
             'contractSha256': sha((HERE / P.CONTRACT_FILE).read_bytes()),
             'productionSources': c['productionSources'], 'controlSources': c['controlPins'],
             'apiModules': {}, 'adminFiles': after, 'files': h.file_inventory(payload),
             'baselineAdminReproduced': True, 'baselineAdminFiles': before,
             'qualityVerification': qa, 'migrationPerformed': False, 'businessActions': 0}
    P.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'SETTLED_CHECKOUT_BUILT', **native, 'businessActions': 0}))


def publish(c):
    check(c)
    native = identity()
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT and not OUT.exists(), 'PUBLISH_INPUT_CHANGED')
    jobs = github('actions/runs/' + native['workflowRunId'] + '/attempts/' + native['workflowRunAttempt'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    qa = quality(c, native['commit'])
    rows = github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
    name = 'settled-checkout-native-' + native['commit'] + '-' + native['workflowRunAttempt']
    rows = [a for a in rows if a['name'] == name and not a['expired']]
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
    controls = {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}
    plan = {**native, 'recipe': P.RECIPE, 'contractSha256': controls[P.CONTRACT_FILE],
            'controlSources': controls, 'artifactSha256': declared, 'buildProofSha256': sha(proof_raw),
            'qualityVerification': qa}
    path = OUT / 'bitbrowser-history-artifact.tar.gz'
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('原生核价安全诊断：仅输出一次受控状态及错误代码，不记录凭据或账单，不改变放行条件；保留 API 与历史资源，无迁移、付款或订阅操作。\n')
    tag = 'bitbrowser-history-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'],
            '--title', '核价安全诊断 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/bitbrowser-history-artifact.tar.gz'
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    plan['runtimeBaseline'] = preflight['runtimeBaseline']
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan, 'release')
    need(result['status'] == 'BITBROWSER_HISTORY_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'SETTLED_CHECKOUT_PUBLISHED', **native, 'businessActions': 0}))


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
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('SETTLED_CHECKOUT_CONTROL_PATH')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('SETTLED_CHECKOUT_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('SETTLED_CHECKOUT_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('financial_release',directory/'settled-checkout-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 result=json.dumps(module.release(plan,c),sort_keys=True).encode()
 print(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(result)).decode()}))
except Exception as error:
 code=str(error)
 if not re.fullmatch('(?:SETTLED_CHECKOUT|BITBROWSER_HISTORY|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK)_[A-Z0-9_]+',code):code='SETTLED_CHECKOUT_REMOTE_FAILED'
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
        '--document-name', 'AWS-RunShellScript', '--comment', 'settled-' + mode + '-' + plan['commit'][:12],
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
    raise RuntimeError('SETTLED_CHECKOUT_RESULT_PENDING')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish'))
    mode = parser.parse_args().mode
    c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
    {'check': check, 'build': build, 'publish': publish}[mode](c)


if __name__ == '__main__':
    main()
