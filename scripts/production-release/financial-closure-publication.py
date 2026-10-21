"""Build and publish only the eight reviewed billing sources; main OIDC only."""
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
OUT = ROOT / '.deploy/financial-closure'
REPO = 'wangchaozhuanyong/id-business-system'
INSTANCE = 'i-05836da38606e633c'
WORKFLOW = '.github/workflows/financial-closure-publication.yml'


def load(name):
    spec = importlib.util.spec_from_file_location('financial_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('financial-closure-release.py')
need, sha = P.need, P.sha


def execute(*args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=120)
    need(result.returncode == 0, 'TRANSPORT_FAILED')
    return result.stdout


def git(*args):
    return execute('git', *args)


def github(path):
    return json.loads(execute('gh', 'api', 'repos/' + REPO + '/' + path))


def check(c):
    P.validate_contract(c)
    published = json.loads((HERE / P.PARENT_FILE).read_bytes())
    parent = json.loads((HERE / 'bitbrowser-manual-contract.json').read_bytes())
    need(published['commit'] == P.CURRENT and published['scope'] == 'BITBROWSER_MANUAL_SETTLEMENT_20261019'
         and published['productionSources'] == parent['productionSources']
         and published['qualityVerification']['sources']['reviewedBusinessCommit'] == parent['sourceReviewCommit']
         and published['businessActions'] == 0 and published['migrationPerformed'] is False,
         'PARENT_PROJECTION_CHANGED')
    for name, digest in {**c['productionSources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == digest
             == sha(git('show', c['validation']['commit'] + ':' + name)), 'REVIEWED_SOURCE_CHANGED')
    for name, digest in c['productionSources'].items():
        need(sha(git('show', P.SOURCE + ':' + name)) == digest, 'REVIEW_PROJECTION_CHANGED')
    for name, digest in c['controlPins'].items():
        need(re.fullmatch('[a-z][a-z0-9.-]+', name)
             and sha((HERE / name).read_bytes()) == digest, 'CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    need(sha((ROOT / 'package-lock.json').read_bytes()) == c['buildDependencyPatch']['sha256'],
         'DEPENDENCY_LOCK_CHANGED')
    need(sha((ROOT / 'scripts/lib/v2-data-integrity-audit.mjs').read_bytes())
         == '9c982c6f6c4573715d6679d64eb898ea20080430aa18ac42ae093beac181f26e', 'FROZEN_RULES_CHANGED')
    rules = load('financial-closure-readonly.py').bundle()['rules']
    need([{k: row[k] for k in ('code', 'severity', 'scope')} for row in rules] == c['productionAuditRules'],
         'PRODUCTION_RULES_CHANGED')


def artifact_json(run, name, member):
    rows = github('actions/runs/' + str(run['id']) + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == name and not a['expired']]
    need(len(rows) == 1, 'ACCEPTANCE_ARTIFACT_MISSING')
    raw = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(0 < len(raw) < 64 * 1024**2 and rows[0].get('digest') == 'sha256:' + sha(raw),
         'ACCEPTANCE_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(member in archive.namelist() and archive.getinfo(member).file_size < 8 * 1024**2,
             'ACCEPTANCE_REPORT_MISSING')
        report = archive.read(member)
    return json.loads(report), sha(report)


def require_run(run, commit, workflow, event=None):
    need(run.get('head_sha') == commit and run.get('path') == workflow
         and run.get('repository', {}).get('full_name') == REPO
         and run.get('status') == 'completed' and run.get('conclusion') == 'success'
         and (event is None or run.get('event') == event), 'QUALITY_REQUIRED')


def quality(c, commit):
    validation = github('actions/runs/' + c['validation']['runId'])
    require_run(validation, c['validation']['commit'], '.github/workflows/financial-closure-validation.yml', 'push')
    suffix = c['validation']['commit'] + '-' + str(validation['run_attempt'])
    mysql, mysql_sha = artifact_json(validation, 'financial-closure-database-' + suffix, 'mysql-results.json')
    ui, ui_sha = artifact_json(validation, 'financial-closure-interface-' + suffix, 'result.json')
    need(mysql.get('success') is True and mysql.get('numTotalTests') == mysql.get('numPassedTests') == 53
         and mysql.get('numPendingTests') == mysql.get('numFailedTests') == 0
         and ui.get('status') == 'PASS' and len(ui.get('cases', [])) == 112
         and all(row.get('result') == 'PASS' for row in ui['cases'])
         and ui.get('consoleErrors') == [], 'ISOLATED_ACCEPTANCE_FAILED')
    pr = github('pulls/' + str(c['validation']['pullRequest']))
    need(pr.get('merged_at') and pr['base']['ref'] == 'main', 'MERGED_SOURCE_REQUIRED')
    git('merge-base', '--is-ancestor', pr['merge_commit_sha'], commit)
    producer = pr['head']['sha']
    for name, digest in {**c['productionSources'], **c['validationSources']}.items():
        need(sha(git('show', producer + ':' + name)) == digest, 'ACCEPTANCE_INPUT_CHANGED')
    rows = github('actions/workflows/quality.yml/runs?head_sha=' + producer)['workflow_runs']
    rows = [r for r in rows if r['head_sha'] == producer and r['event'] == 'pull_request'
            and r['status'] == 'completed' and r['conclusion'] == 'success']
    need(bool(rows), 'SOURCE_FULL_QUALITY_REQUIRED')
    source = rows[0]
    require_run(source, producer, '.github/workflows/quality.yml', 'pull_request')
    receipt, receipt_sha = artifact_json(source, 'quality-source-evidence-' + str(source['run_attempt']), 'evidence.json')
    need(receipt.get('repository') == REPO and receipt.get('runId') == source['id']
         and receipt.get('runAttempt') == source['run_attempt']
         and receipt.get('pullRequest') == c['validation']['pullRequest']
         and receipt.get('headSha') == producer
         and receipt.get('testedTree') == git('rev-parse', pr['merge_commit_sha'] + '^{tree}').decode().strip(),
         'SOURCE_RECEIPT_CHANGED')
    jobs = github('actions/runs/' + str(source['id']) + '/attempts/' + str(source['run_attempt']) + '/jobs?per_page=100')['jobs']
    need({'quality', 'full-quality', 'change-scope'} <= {j['name'] for j in jobs if j['conclusion'] == 'success'},
         'SOURCE_FULL_QUALITY_REQUIRED')
    runs = github('actions/workflows/quality.yml/runs?head_sha=' + commit)['workflow_runs']
    main = [r for r in runs if r['head_sha'] == commit and r['head_branch'] == 'main'
            and r['event'] == 'push' and r['conclusion'] == 'success']
    need(bool(main), 'MAIN_QUALITY_REQUIRED')
    require_run(main[0], commit, '.github/workflows/quality.yml', 'push')
    jobs = github('actions/runs/' + str(main[0]['id']) + '/attempts/' + str(main[0]['run_attempt']) + '/jobs?per_page=100')['jobs']
    need('quality' in {j['name'] for j in jobs if j['conclusion'] == 'success'}, 'MAIN_QUALITY_REQUIRED')
    qa = {'sources': {'commit': source['head_sha'], 'runId': str(source['id']),
                     'runAttempt': str(source['run_attempt']), 'reviewedBusinessCommit': P.SOURCE,
                     'sourceReceiptSha256': receipt_sha, 'testedTree': receipt['testedTree']},
          'release': {'commit': commit, 'runId': str(main[0]['id']), 'runAttempt': str(main[0]['run_attempt'])}}
    evidence = {'testedCommit': validation['head_sha'], 'runId': str(validation['id']),
        'testsPassed': 53, 'testsSkipped': 0, 'testsFailed': 0, 'interfaceCasesPassed': 112,
        'mysqlReportSha256': mysql_sha, 'interfaceReportSha256': ui_sha}
    P.verify_mysql(evidence, {'isolatedMysqlVerification': evidence}, c)
    return qa, evidence


def native_identity():
    commit = os.environ.get('GITHUB_SHA', '')
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
         and os.environ.get('GITHUB_REPOSITORY') == REPO
         and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
         and os.environ.get('RELEASE_COMMIT') == commit and re.fullmatch('[a-f0-9]{40}', commit)
         and git('rev-parse', 'HEAD').decode().strip() == commit, 'MAIN_ONLY')
    need(github('git/ref/heads/main')['object']['sha'] == commit, 'MAIN_MOVED')
    run_id, attempt = (os.environ.get(n, '') for n in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    need(all(re.fullmatch('[1-9][0-9]*', n) for n in (run_id, attempt)), 'RUN_IDENTITY')
    run = github('actions/runs/' + run_id)
    need(run['head_sha'] == commit and run['head_branch'] == 'main' and run['path'] == WORKFLOW
         and str(run['run_attempt']) == attempt, 'WORKFLOW_IDENTITY')
    return {'commit': commit, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
            'workflowRunId': run_id, 'workflowRunAttempt': attempt}


def transport(plan, mode, output):
    selected = {**plan, 'mode': mode}
    code = r'''
import base64,hashlib,importlib.util,json,os,re,urllib.request,zlib
from pathlib import Path
os.umask(0o077)
plan=json.loads(zlib.decompress(base64.b64decode(PLAN)))
directory=Path('/opt/id-business-v2/.staging/financial-entry-'+plan['commit']+'-'+plan['workflowRunId'])
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('FINANCIAL_PUBLICATION_CONTROL_PATH')
  with urllib.request.urlopen(RAW_BASE+name,timeout=30) as response:raw=response.read(8*1024**2+1)
  if len(raw)>8*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('FINANCIAL_PUBLICATION_CONTROL_CHANGED')
  path=directory/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('FINANCIAL_PUBLICATION_EXECUTOR_CHANGED')
  else:path.write_bytes(raw)
 spec=importlib.util.spec_from_file_location('financial_release',directory/'financial-closure-release.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 c=json.loads((directory/module.CONTRACT_FILE).read_bytes())
 result=json.dumps(module.release(plan,c),sort_keys=True).encode()
 print(json.dumps({'zlibBase64':base64.b64encode(zlib.compress(result)).decode()}))
except Exception as error:
 code=str(error)
 if not re.fullmatch('(?:FINANCIAL_PUBLICATION|BITBROWSER_HISTORY|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK)_[A-Z0-9_]+',code):code='FINANCIAL_PUBLICATION_REMOTE_FAILED'
 print(json.dumps({'status':'FAILED','code':code,'mode':plan['mode'],'businessActions':0}))
 raise SystemExit(1) from None
'''
    source = 'PLAN=' + repr(base64.b64encode(zlib.compress(json.dumps(selected).encode())).decode())
    source += '\nRAW_BASE=' + repr('https://raw.githubusercontent.com/' + REPO + '/' + plan['commit'] + '/scripts/production-release/') + '\n' + code
    compile(source, '<financial-publication>', 'exec')
    parameters = {'commands': ["python3 - <<'FINANCIAL_RELEASE'\n" + source + '\nFINANCIAL_RELEASE'],
                  'executionTimeout': ['900']}
    intent, accepted = output / (mode + '-intent.json'), output / (mode + '-accepted.json')
    need(not intent.exists() and not accepted.exists(), 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN')
    with intent.open('x') as f:
        json.dump({'mode': mode, 'commit': plan['commit'], 'parametersSha256': sha(P.canonical(parameters))}, f)
        f.flush()
        os.fsync(f.fileno())
    sent = subprocess.run(['aws', '--region', 'ap-northeast-1', 'ssm', 'send-command', '--instance-ids', INSTANCE,
        '--document-name', 'AWS-RunShellScript', '--comment', 'financial-' + mode + '-' + plan['commit'][:12],
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
    raise RuntimeError('FINANCIAL_PUBLICATION_RESULT_PENDING')


def patch_build_lock(context, c):
    target = context / 'package-lock.json'
    before, after = target.read_bytes(), (ROOT / 'package-lock.json').read_bytes()
    patch = c['buildDependencyPatch']
    need(sha(before) == patch['parentSha256'] and sha(after) == patch['sha256'], 'BUILD_LOCK_PARENT_CHANGED')
    old, new = json.loads(before), json.loads(after)
    name = 'node_modules/follow-redirects'
    need(old['packages'][name]['version'] == '1.16.0' and new['packages'][name]['version'] == '1.16.1',
         'BUILD_LOCK_VERSION')
    new['packages'][name] = old['packages'][name]
    need(new == old, 'BUILD_LOCK_SCOPE')
    target.write_bytes(after)


def production_counts(output, phase):
    reader = load('financial-closure-readonly.py')
    reader.main()
    path = ROOT / '.deploy/financial-closure-readonly' / (
        os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'])
    report = json.loads((path / 'result.json').read_bytes())
    need(reader.validate_report(report, reader.bundle()['rules']), 'PRODUCTION_COUNTS_UNAVAILABLE')
    value = {'report': report, 'reportSha256': sha(P.canonical(report)),
        'commandId': (path / 'command-id.txt').read_text().strip(),
        'invocationSha256': sha((path / 'invocation.json').read_bytes())}
    (output / ('production-counts-' + phase + '.json')).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    return value


def build(c):
    check(c)
    identity = native_identity()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    qa, mysql = quality(c, identity['commit'])
    integrity = production_counts(OUT, 'before')
    P.verify_production_integrity(integrity, c)
    controls = {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}
    plan = {**identity, 'recipe': P.RECIPE, 'contractSha256': controls[P.CONTRACT_FILE], 'controlSources': controls}
    capture = transport(plan, 'parent', OUT)
    need(capture['status'] == 'FINANCIAL_NATIVE_PARENT_VERIFIED', 'PARENT_CAPTURE_FAILED')
    b = load('bitbrowser-history-build.py')
    b.OUT = OUT / 'reconstruction'
    b.OUT.mkdir(mode=0o700)
    legacy = b.load('bitbrowser-history-release.py')
    legacy.select_recipe(legacy.BOUNDED)
    api, admin = b.reconstruct_bounded_parent(legacy)
    prior = json.loads((HERE / 'bitbrowser-bounded-hold-contract.json').read_bytes())
    parent = json.loads((HERE / 'bitbrowser-manual-contract.json').read_bytes())
    published = json.loads((HERE / P.PARENT_FILE).read_bytes())
    h = P.load('recharge-record-release.py')
    baseline = {}
    outputs = {}
    for role, context in (('api', api), ('admin', admin)):
        b.overlay(context, {n: v for n, v in prior['productionSources'].items() if n.startswith('apps/' + role + '/')}, prior['sourceReviewCommit'])
        for name, row in parent['reconstructedParents'].items():
            if name.startswith('apps/' + role + '/'):
                b.overlay(context, {name: row['sourceSha256']}, row['sourceCommit'])
        # The independently observed 640e predecessor already includes this
        # exact native manual projection. Reconstruct it before adding billing;
        # none of these parent sources enter the new eight-file payload.
        b.overlay(context, {n: v for n, v in published['productionSources'].items()
            if n.startswith(('apps/' + role + '/', 'packages/shared/'))}, parent['sourceReviewCommit'])
        for name, expected in c['buildParents'].items():
            if name.startswith('apps/' + role + '/'):
                target = context / name
                need(not target.is_symlink() and (not target.exists() if expected is None else target.is_file()
                     and sha(target.read_bytes()) == expected), 'RECONSTRUCTED_SOURCE_CHANGED')
        patch_build_lock(context, c)
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + c['apiAdminParentCommit']}
        commands = [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared')]
        if role == 'api':
            commands.append(('npm', 'run', 'prisma:mysql:generate'))
        commands.append(('npm', 'run', 'build', '--workspace', '@apple-business/' + role))
        for command in commands:
            subprocess.run(command, cwd=context, env=env, check=True)
        dist = context / ('apps/' + role + '/dist')
        before = h.file_inventory(dist)
        if role == 'api':
            shared = h.file_inventory(context / 'packages/shared/dist')
            reproduced = {'apiModules': {n: before.get(n) for n in published['apiModules']},
                          'sharedModules': {n: shared.get(n) for n in published['sharedModules']}}
            (OUT / 'parent-api-reproduction-result.json').write_text(json.dumps(reproduced, sort_keys=True, indent=2) + '\n')
            need(reproduced['apiModules'] == published['apiModules']
                 and reproduced['sharedModules'] == published['sharedModules'], 'PARENT_PUBLICATION_COMPILE_CHANGED')
            need({n: before[n] for n in P.MODULES - P.ABSENT} == c['buildParentApiModules']
                 and P.ABSENT.isdisjoint(before), 'PARENT_COMPILE_CHANGED')
            baseline['api'] = before
            baseline['shared'] = h.file_inventory(context / 'packages/shared/dist')
            baseline['client'] = h.file_inventory(context / 'node_modules/.prisma/client')
        else:
            (OUT / 'parent-admin-reproduction-result.json').write_text(json.dumps(before, sort_keys=True, indent=2) + '\n')
            need(before == published['adminFiles'], 'PARENT_ADMIN_CONTENT_REPRODUCTION_FAILED')
            need(before['index.html'] == c['parentAdminIndexSha256'], 'PARENT_ADMIN_REPRODUCTION_FAILED')
        selected = {n: v for n, v in c['productionSources'].items() if n.startswith('apps/' + role + '/')}
        b.overlay(context, selected, P.SOURCE)
        subprocess.run(('npm', 'run', 'build', '--workspace', '@apple-business/' + role), cwd=context,
                       env={**env, 'V2_BUILD_ID': 'v2-' + identity['commit']}, check=True)
        after = h.file_inventory(dist)
        if role == 'api':
            delta = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)}
            need(delta - {'tsconfig.build.tsbuildinfo'} == P.MODULES
                 and h.file_inventory(context / 'packages/shared/dist') == baseline['shared']
                 and h.file_inventory(context / 'node_modules/.prisma/client') == baseline['client'], 'COMPILED_SCOPE_CHANGED')
            outputs['api'] = {n: after[n] for n in P.MODULES}
        else:
            outputs['admin'] = after
            script = 'scripts/acceptance-v2-online-billing-ui.mjs'
            shutil.copyfile(ROOT / script, context / script)
            subprocess.run(('node', script), cwd=context, env=env, check=True)
            ui = context / '.runtime/online-recharge/billing-ui/result.json'
            report = json.loads(ui.read_bytes())
            need(report.get('status') == 'PASS' and len(report.get('cases', [])) == 112
                 and report.get('consoleErrors') == [], 'PROJECTED_INTERFACE_FAILED')
            shutil.copytree(ui.parent, OUT / 'projected-interface')
    payload = OUT / 'payload'
    for name in P.MODULES:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(api / 'apps/api/dist' / name, target)
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    for name in c['productionSources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {**identity, 'version': 1, 'scope': P.SCOPE, 'recipe': P.RECIPE,
        'contractSha256': plan['contractSha256'], 'productionSources': c['productionSources'],
        'controlSources': c['controlPins'], 'apiModules': outputs['api'], 'adminFiles': outputs['admin'],
        'files': h.file_inventory(payload), 'parentModulesReproduced': c['buildParentApiModules'],
        'baselineSharedUnchanged': True, 'baselineClientUnchanged': True,
        'baselineAdminIndexSha256': c['parentAdminIndexSha256'], 'projectedInterfaceCasesPassed': 112,
        'qualityVerification': qa, 'isolatedMysqlVerification': mysql, 'nativeParentCapture': capture,
        'productionIntegrityBefore': integrity,
        'businessActions': 0, 'migrationPerformed': False}
    P.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'FINANCIAL_NATIVE_BUILT', **identity, 'businessActions': 0}))


def publish(c):
    check(c)
    identity = native_identity()
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT and not OUT.exists(), 'PUBLISH_INPUT_CHANGED')
    jobs = github('actions/runs/' + identity['workflowRunId'] + '/attempts/' + identity['workflowRunAttempt'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['status'] == 'completed' and j['conclusion'] == 'success' for j in jobs),
         'NATIVE_BUILD_REQUIRED')
    qa, mysql = quality(c, identity['commit'])
    rows = github('actions/runs/' + identity['workflowRunId'] + '/artifacts')['artifacts']
    name = 'financial-closure-native-' + identity['commit'] + '-' + identity['workflowRunAttempt']
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
    need(all(proof.get(k) == v for k, v in identity.items()) and proof['qualityVerification'] == qa
         and proof['isolatedMysqlVerification'] == mysql, 'BUILD_PROVENANCE_CHANGED')
    P.verify_proof(proof, proof, c, payload, h)
    controls = {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}
    plan = {**identity, 'recipe': P.RECIPE, 'contractSha256': controls[P.CONTRACT_FILE], 'controlSources': controls,
        'artifactSha256': declared, 'buildProofSha256': sha(proof_raw), 'qualityVerification': qa,
        'isolatedMysqlVerification': mysql, 'nativeParentCapture': proof['nativeParentCapture'],
        'productionIntegrityBefore': proof['productionIntegrityBefore']}
    bundle_path = OUT / 'bitbrowser-history-artifact.tar.gz'
    bundle_path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('账务闭环有限发布：八个业务源文件，API 和管理端更新，无迁移、付款、订阅或通知。\n')
    tag = 'bitbrowser-history-' + identity['commit']
    execute('gh', 'release', 'create', tag, str(bundle_path), '--target', identity['commit'],
            '--title', '账务闭环 ' + identity['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/bitbrowser-history-artifact.tar.gz'
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    preflight = transport(plan, 'preflight', OUT)
    need(preflight['status'] == 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    plan['runtimeBaseline'] = preflight['runtimeBaseline']
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    result = transport(plan, 'release', OUT)
    need(result['status'] == 'BITBROWSER_HISTORY_DEPLOYED', 'NOT_DEPLOYED')
    result = transport(plan, 'readback', OUT)
    need(result['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'READBACK_FAILED')
    after = production_counts(OUT, 'after')['report']
    need(after['identity']['commit'] == identity['commit']
         and after['identity']['apiBillingSha256'] == proof['apiModules']['id-business-v2/online-recharge/persistence/admin.repository.js']
         and after['identity']['adminIndexSha256'] == proof['adminFiles']['index.html']
         and all(row['severity'] != 'error' or row['count'] == 0 for row in after['audit']['checks']),
         'POSTFLIGHT_INTEGRITY_FINDINGS')
    print(json.dumps(result, sort_keys=True))


def inspect_parent(c):
    check(c)
    identity = native_identity()
    need(os.environ.get('EXPECTED_CURRENT') == P.CURRENT and not OUT.exists(), 'INSPECTION_INPUT_CHANGED')
    OUT.mkdir(parents=True, mode=0o700)
    controls = {**c['controlPins'], P.CONTRACT_FILE: sha((HERE / P.CONTRACT_FILE).read_bytes())}
    plan = {**identity, 'recipe': P.RECIPE, 'contractSha256': controls[P.CONTRACT_FILE],
            'controlSources': controls, 'diagnosticOnly': True}
    facts = transport(plan, 'parent', OUT)
    need(facts.get('status') == 'FINANCIAL_NATIVE_PARENT_FACTS' and facts.get('databaseWrites') == 0
         and facts.get('commit') == P.CURRENT and facts.get('manifestSha256') == c['parentManifestSha256']
         and facts.get('predecessorProofSha256') == P.PARENT_PROOF
         and set(facts.get('sourceParents', {})) | set(facts.get('unsafeSources', [])) == P.SOURCES
         and set(facts.get('apiModules', {})) <= P.MODULES, 'PARENT_FACTS_INVALID')
    print(json.dumps({'status': facts['status'], 'businessActions': 0, 'databaseWrites': 0,
                      'sourceCount': len(facts['sourceParents']), 'unsafeSources': len(facts['unsafeSources'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('check', 'build', 'publish', 'inspect'))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        contract = json.loads((HERE / P.CONTRACT_FILE).read_bytes())
        {'check': check, 'build': build, 'publish': publish, 'inspect': inspect_parent}[args.mode](contract)
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch('FINANCIAL_PUBLICATION_[A-Z0-9_]+', code) else 'FINANCIAL_PUBLICATION_FAILED')
        raise SystemExit(1) from None
