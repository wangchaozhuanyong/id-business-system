"""Authenticate checks, reproduce native parents, and publish the finite human-verification projection."""
import argparse
import base64
import time
import zlib
import re
import zipfile
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-human-verification'
WORKFLOW = '.github/workflows/online-human-verification-publication.yml'
REPO = 'wangchaozhuanyong/id-business-system'


def load(name):
    import importlib.util
    spec = importlib.util.spec_from_file_location('human_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('online-human-verification-release.py')
E = load('online-execution-publication.py')
F, S = E.F, E.S
need, sha, git, github, execute = P.need, P.sha, F.git, F.github, F.execute
INSTANCE = E.INSTANCE
CONTROL_PATHS = frozenset((WORKFLOW, 'scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs', *('scripts/production-release/online-human-verification-' + n
    for n in ('release.py', 'publication.py', 'release.test.py', 'contract.json'))))
HISTORICAL_REVIEW_COMMITS = (
    '04a284c1d038b2eadd6aef933c6cc26a5bfa6935',
    '04aa234505adccfe295776245b88fc56feac0588',
    '091897de2f08338dbbfea79123f2dc2ae8f391e5',
    '0cfc9d184fc05c57f08d2bae2ff51a11e489d8d1',
    '0f33f72ae5968bc3e8a17bdba96bc7661eb47de2',
    '131031a66b626119c7469e66c40e5b27b3cf0025',
    '1b1b635b2562edfe983590ff9955268f254187bb',
    '1f22456050e5a712405b3dff37dc43b55e778a92',
    '217fe5016994d4536178842fde065c87d2bdc73a',
    '2a4474c4f9e0ccd38291b1dfffbd4abd70ab4b5d',
    '2bcced63c834187ac5e69e344176da33ff82d4c9',
    '3317af5de7330c57a926181dd03cded795c4c38f',
    '3cf2293bdc1fb62ea44196b8a8775d42b1cc5c9c',
    '3f796a9f79a950caf2dce85d6ee687dc5d48e21b',
    '4aa49436239ab57e9deb3b5890e645ceeef25149',
    '619e6c56c38cc5ee38a92f716ed4bdfd54d2f4de',
    '6d1db82cde92e8c02fea6254289c4b410e94016a',
    '71abf78eed79b7b052713ed35133a3570dd799ae',
    '7f419903e9335c00524f5065f46920e8f24f2722',
    '7fc353223095b66408b03af0ea117230abba1a63',
    '9857b1b34f1013f400046cc849ad0628b921ead1',
    '9dffb3e25fb67f86df3d829dabd98bdcf4ca9218',
    'a1e65b996b0c527a562a14c470b5c7650a00bd25',
    'adb3a3c7a63054520c284838189d85064e1c019a',
    'b39ab26351f485856884f86fb67c91ad771a7213',
    'b3fb8fe13de45a20c897287a0a77d2c253171ec6',
    'bcd67c4dfe3944aa6c0498699a619395f04ed296',
    'be11287feb7c2494fc41c9de071fdff9e06563d2',
    'ce3f04e31f400d4bb714ea0a16f972c53593e3c5',
    'd59b5c43fa69aedbc1ce2dc4739e1fadd7bf991a',
    'e0bda43bab61ee6673471cfcffc878d268b70cf5',
    'e3e8995d0ea3461272eac1e3ee9d5117d6e22e2c',
    'e474bc8ed3ecc1a942f2eeb54bccab30570ae2af',
    'e84c7be631f42b82a9174367e93f163fe7299152',
    'f246c4ce8ec35d52e914d602b3b08a834e10d9d5',
    'f404926fc4eca91a413ed29567f9048eedceb83e',
    'f62fa65c20ad93292ad7c09792a4049cda03fab5',
    'f8a1612d9b465dc5cfb1534c9cc3c5640583cc80',
    'faea152b038c7ddb1a3199070f9dc7ffb5583c36',
    'fc51da593302cc8535a5adfe199d7768949eb419',
)


def prefetch_historical_sources():
    missing = [rev for rev in HISTORICAL_REVIEW_COMMITS if subprocess.run(
        ['git', 'cat-file', '-t', rev], cwd=ROOT, capture_output=True).returncode != 0]
    if missing:
        git('fetch', '--no-tags', '--no-write-fetch-head', 'origin', *missing)
    need(all(git('cat-file', '-t', rev).strip() == b'commit' for rev in HISTORICAL_REVIEW_COMMITS),
         'HISTORICAL_SOURCE_TYPE_CHANGED')


def check(c):
    P.validate_contract(c)
    for name, digest in {**c['productionSources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == digest == sha(git('show', P.SOURCE + ':' + name)), 'SOURCE_CHANGED')
    for name, digest in c['controlPins'].items():
        need(sha((HERE / name).read_bytes()) == digest, 'CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256']
         and sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'BUILD_INPUT_CHANGED')
    changed = set(git('diff', '--name-only', P.SOURCE, 'HEAD').decode().splitlines())
    need(changed <= CONTROL_PATHS, 'REVIEW_EXTENSION_CHANGED')


def identity():
    F.WORKFLOW = WORKFLOW
    return F.native_identity()


def quality(c, commit):
    pr = github('pulls/676')
    need(pr.get('merged_at') and pr['base']['ref'] == 'main' and pr['merge_commit_sha'] == P.SOURCE_MAIN, 'MERGED_SOURCE_REQUIRED')
    head = pr['head']['sha']
    git('merge-base', '--is-ancestor', P.SOURCE, head)
    need(set(git('diff', '--name-only', P.SOURCE, head).decode().splitlines()) <= CONTROL_PATHS, 'SOURCE_EXTENSION_CHANGED')
    controls = github('pulls/' + str(P.CONTROL_PR))
    need(controls.get('merged_at') and controls['base']['ref'] == 'main'
         and controls['base']['sha'] == P.CONTROL_BASE and controls['merge_commit_sha'] == commit, 'MERGED_CONTROL_REQUIRED')
    control_head = controls['head']['sha']
    git('merge-base', '--is-ancestor', P.CONTROL_BASE, control_head)
    control_paths = {'scripts/production-release/online-human-verification-' + n
                     for n in ('release.py', 'publication.py', 'release.test.py', 'contract.json')}
    need(set(git('diff', '--name-only', P.SOURCE_MAIN, control_head).decode().splitlines()) == control_paths
         and git('rev-parse', control_head + '^{tree}') == git('rev-parse', commit + '^{tree}'), 'CONTROL_EXTENSION_CHANGED')
    evidence = {}
    for role, selected, event in (('sources', head, 'pull_request'), ('controls', control_head, 'pull_request'), ('release', commit, 'push')):
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + selected)['workflow_runs']
        runs = [r for r in runs if r['head_sha'] == selected and r['event'] == event and r['status'] == 'completed' and r['conclusion'] == 'success']
        need(bool(runs), 'QUALITY_REQUIRED')
        run = runs[0]
        F.require_run(run, selected, '.github/workflows/quality.yml', event)
        jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
        passed = {j['name'] for j in jobs if j['conclusion'] == 'success'}
        need({'quality', 'change-scope'} <= passed and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_JOBS_REQUIRED')
        record = {'commit': selected, 'runId': str(run['id']), 'runAttempt': str(run['run_attempt'])}
        if role != 'release':
            if role == 'sources':
                need('full-quality' in passed or {'recharge (guards)', 'recharge (api)', 'recharge (admin)', 'recharge (online-engine)'} <= passed,
                     'SOURCE_QUALITY_REQUIRED')
            else:
                need('recharge (guards)' in passed, 'CONTROL_QUALITY_REQUIRED')
            receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
            number = 676 if role == 'sources' else P.CONTROL_PR
            expected_tree = git('rev-parse', (P.SOURCE_MAIN if role == 'sources' else commit) + '^{tree}').decode().strip()
            need(receipt.get('repository') == REPO and receipt.get('headSha') == selected and receipt.get('pullRequest') == number
                 and receipt.get('runId') == run['id'] and receipt.get('runAttempt') == run['run_attempt']
                 and receipt.get('testedTree') == expected_tree, 'SOURCE_RECEIPT_CHANGED')
            record.update(pullRequest=number, sourceReceiptSha256=digest)
            record.update({'reviewedBusinessCommit': P.SOURCE, 'mainCommit': P.SOURCE_MAIN} if role == 'sources'
                          else {'baseCommit': P.CONTROL_BASE})
        evidence[role] = record
    P.verify_quality(evidence, commit)
    return evidence


def native_plan(c, native):
    return {**native, 'recipe': P.RECIPE, 'contractSha256': sha((HERE / P.CONTRACT_FILE).read_bytes()),
            'controlSources': {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}}


def run(command, context, env):
    subprocess.run(command, cwd=context, env=env, check=True)


def build(c):
    check(c)
    native = identity()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    qa = quality(c, native['commit'])
    prefetch_historical_sources()
    OUT.mkdir(parents=True, mode=0o700)
    plan = native_plan(c, native)
    parent = transport(plan, 'parent')
    need(parent['status'] == 'ONLINE_HUMAN_PARENT_VERIFIED', 'PARENT_REQUIRED')
    h = P.load('recharge-record-release.py')
    api = OUT / 'api-context'
    with tarfile.open(fileobj=io.BytesIO(git('archive', P.CURRENT))) as archive:
        archive.extractall(api, filter='data')
    env = {**os.environ, 'NODE_ENV': 'production', 'PRISMA_GENERATE_SKIP_AUTOINSTALL': '1'}
    for cmd in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                ('npm', 'run', 'prisma:mysql:generate'), ('npm', 'run', 'build', '--workspace', '@apple-business/api')):
        run(cmd, api, env)
    dist = api / 'apps/api/dist'
    before = h.file_inventory(dist)
    selected = {n: before[n] for n in P.MODULES - P.ABSENT}
    P.verify_parent_modules(selected, parent['baseline']['apiModules'])
    shared, client = h.file_inventory(api / 'packages/shared/dist'), h.file_inventory(api / 'node_modules/.prisma/client')
    for n in P.API:
        destination = api / n
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((ROOT / n).read_bytes())
    run(('npm', 'run', 'build', '--workspace', '@apple-business/api'), api, env)
    after = h.file_inventory(dist)
    delta = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)} - {'tsconfig.build.tsbuildinfo'}
    need(delta <= P.MODULES and {n for n in delta if n.endswith('.js')} == {n for n in P.MODULES if n.endswith('.js')}
         and h.file_inventory(api / 'packages/shared/dist') == shared and h.file_inventory(api / 'node_modules/.prisma/client') == client,
         'COMPILED_SCOPE_CHANGED')
    # Reproduce the published admin through the existing frozen lineage recipe.
    S.OUT = OUT / 'admin-reconstruction'
    S.OUT.mkdir(mode=0o700)
    admin, b = S.reconstruct_parent(json.loads((HERE / 'settled-checkout-contract.json').read_bytes()))
    admin_env = {**env, 'V2_BUILD_ID': 'v2-e9c944de6845201f73cc71247339ccab69d919dc'}
    for cmd in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                ('npm', 'run', 'build', '--workspace', '@apple-business/admin')):
        run(cmd, admin, admin_env)
    before_admin = h.file_inventory(admin / 'apps/admin/dist')
    need(before_admin == json.loads((HERE / 'settled-checkout-contract.json').read_bytes())['adminParent']['adminFiles'], 'ADMIN_PARENT_REPRODUCTION_CHANGED')
    # The published tax-wire successor was the last admin change before this parent.
    old_admin = json.loads((HERE / 'settled-checkout-contract.json').read_bytes())
    b.overlay(admin, old_admin['productionSources'], old_admin['sourceReviewCommit'])
    run(('npm', 'run', 'build', '--workspace', '@apple-business/admin'), admin,
        {**env, 'V2_BUILD_ID': 'v2-d7d80c357c4954ef28db85e1021a0e19a65ebd81'})
    before_admin = h.file_inventory(admin / 'apps/admin/dist')
    need({'count': len(before_admin), 'sha256': sha(P.canonical(before_admin))}
         == parent['baseline']['adminPublishedInventory'], 'NATIVE_ADMIN_NOT_REPRODUCED')
    for n in P.ADMIN:
        if n.endswith('/OnlineHumanVerification.vue'):
            need(not (admin / n).exists(), 'ADMIN_NEW_SOURCE_EXISTS')
        else:
            need(sha((admin / n).read_bytes()) == sha(git('show', P.CURRENT + ':' + n)), 'ADMIN_SOURCE_PARENT_CHANGED')
    b.overlay(admin, {n: c['productionSources'][n] for n in P.ADMIN}, P.SOURCE)
    run(('npm', 'run', 'build', '--workspace', '@apple-business/admin'), admin, {**env, 'V2_BUILD_ID': 'v2-' + native['commit']})
    admin_files = h.file_inventory(admin / 'apps/admin/dist')
    need(admin_files['index.html'] != before_admin['index.html'], 'ADMIN_UNCHANGED')
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
            target = payload / 'online-recharge/source' / n.removeprefix(P.ENGINE)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / n, target)
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    proof = {**native, 'version': 1, 'scope': P.SCOPE, 'recipe': P.RECIPE, 'contractSha256': plan['contractSha256'],
             'productionSources': c['productionSources'], 'controlSources': c['controlPins'],
             'apiModules': {n: after[n] for n in P.MODULES}, 'adminFiles': admin_files,
             'parentModulesReproduced': selected, 'parentNativeModules': parent['baseline']['apiModules'],
             'baselineSharedUnchanged': True, 'baselineClientUnchanged': True, 'nativeParentCapture': parent,
             'qualityVerification': qa, 'businessActions': 0, 'migrationPerformed': False, 'files': h.file_inventory(payload)}
    P.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_HUMAN_BUILT', **native, 'businessActions': 0}))


# The existing transport and publication consumer keep one accepted SSM operation,
# immutable native receipts, the release lock, backup, SQL fence and readback.

def publish(c):
    check(c)
    native = identity()
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT and not OUT.exists(), 'PUBLISH_INPUT_CHANGED')
    jobs = github('actions/runs/' + native['workflowRunId'] + '/attempts/' + native['workflowRunAttempt'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    qa = quality(c, native['commit'])
    rows = github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == 'online-human-verification-native-' + native['commit'] + '-' + native['workflowRunAttempt'] and not a['expired']]
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
    notes.write_text('线上代充本人验证接续：仅更新已验证的 API、管理端与执行器文件。无迁移、付款或订阅操作。\n')
    tag = 'bitbrowser-history-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'],
            '--title', '线上代充本人验证接续 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/bitbrowser-history-artifact.tar.gz'
    preflight = transport(plan, 'preflight')
    need(preflight['status'] == 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    plan['runtimeBaseline'] = preflight['runtimeBaseline']
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan, 'release')
    need(result['status'] == 'BITBROWSER_HISTORY_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'ONLINE_HUMAN_PUBLISHED', **native, 'businessActions': 0}))


def transport(plan, mode):
    output = OUT
    selected = {**plan, 'mode': mode}
    code = r'''
import base64,hashlib,importlib.util,json,os,re,urllib.request,zlib
from pathlib import Path
os.umask(0o077)
plan=json.loads(zlib.decompress(base64.b64decode(PLAN)))
directory=Path('/opt/id-business-v2/.staging/human-verification-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('ONLINE_HUMAN_CONTROL_PATH')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('ONLINE_HUMAN_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('ONLINE_HUMAN_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('financial_release',directory/'online-human-verification-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 result=json.dumps(module.release(plan,c),sort_keys=True).encode()
 print(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(result)).decode()}))
except Exception as error:
 report={'status':'FAILED','code':'ONLINE_HUMAN_REMOTE_FAILED','mode':plan['mode'],'businessActions':0}
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
        '--document-name', 'AWS-RunShellScript', '--comment', 'online-human-verification-' + mode + '-' + plan['commit'][:12],
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
    raise RuntimeError('ONLINE_HUMAN_RESULT_PENDING')




def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish'))
    mode = parser.parse_args().mode
    c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
    {'check': check, 'build': build, 'publish': publish}[mode](c)


if __name__ == '__main__':
    main()
