"""Authenticate main/PR checks and execute one native preflight, switch and readback."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
import importlib.util


def load(name):
    spec = importlib.util.spec_from_file_location('billing_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


B = load('recharge-plan-billing-build.py')
P = load('recharge-plan-billing-release.py')
F = load('financial-closure-publication.py')
OUT, PREFIX = B.OUT, B.PREFIX
WORKFLOW = '.github/workflows/recharge-plan-billing-publication.yml'
INSTANCE = 'i-0838cebf64f0e2a89'
REPO = 'wangchaozhuanyong/id-business-system'


def checked_run(workflow, head, event, required):
    rows = F.github('actions/workflows/' + workflow + '/runs?head_sha=' + head)['workflow_runs']
    rows = [r for r in rows if r['head_sha'] == head and r['event'] == event and r['conclusion'] == 'success']
    B.need(bool(rows), 'SUCCESSFUL_CHECK_REQUIRED')
    run = rows[0]
    jobs = F.github('actions/runs/' + str(run['id']) + '/jobs?per_page=100')['jobs']
    alternatives = required if isinstance(required, list) else [required]
    passed = {j['name'] for j in jobs if j['conclusion'] == 'success'}
    B.need(any(names <= passed for names in alternatives)
           and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'CHECK_JOBS_REQUIRED')
    return {'runId': str(run['id']), 'head': head, 'event': event, 'attempt': run['run_attempt']}


def identity_and_quality(c):
    F.WORKFLOW = WORKFLOW
    native = F.native_identity()
    B.need(os.environ['EXPECTED_CURRENT'] == c['baseline']['expectedCurrent'], 'EXPECTED_CURRENT')
    account = json.loads(F.execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))
    B.need(account['Account'] == '098208446664', 'AWS_ACCOUNT')
    commit = native['commit']
    B.need(B.git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == commit, 'MAIN_MOVED')
    pr = F.github('pulls/' + str(c['sourcePullRequest']))
    B.need(pr['merged_at'] and pr['base']['ref'] == 'main' and pr['head']['sha'] == c['sourceReviewCommit'], 'MERGED_SOURCE_REQUIRED')
    B.git('merge-base', '--is-ancestor', pr['merge_commit_sha'], commit)
    evidence = {
        'source': checked_run('quality.yml', pr['head']['sha'], 'pull_request', [
            {'quality', 'full-quality'},
            {'quality', 'recharge (guards)', 'recharge (admin)', 'recharge (api)', 'recharge (migration)'}]),
        'database': checked_run('recharge-billing-allocation-validation.yml', pr['head']['sha'], 'pull_request', {'billing-allocation-mysql'}),
        'main': checked_run('quality.yml', commit, 'push', {'quality'})
    }
    return native, evidence


def command(mode, plan, control_files):
    plan = {**plan, 'mode': mode}
    for name in control_files:
        B.need(B.sha((HERE / name).read_bytes()) == plan['controlSources'][name], 'DISPATCH_CONTROL_CHANGED')
    encoded = base64.b64encode(json.dumps(plan, sort_keys=True).encode()).decode()
    # Fetch immutable main source by commit, using the existing native SSM transport pattern.
    source = """import base64,hashlib,urllib.request,subprocess,json,sys,re
from pathlib import Path
plan=json.loads(base64.b64decode(PAYLOAD))
root=Path('/opt/id-business-v2/.staging/billing-controls-'+plan['commit']+'-'+plan['workflowRunId'])
root.mkdir(mode=0o700,parents=True,exist_ok=True)
try:
 for name,digest in plan['controlSources'].items():
  if not re.fullmatch('[a-z][a-z0-9.-]+',name):raise RuntimeError('CONTROL_PATH')
  url='https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/'+plan['commit']+'/scripts/production-release/'+name
  with urllib.request.urlopen(url,timeout=60) as response:raw=response.read(3*1024**2+1)
  if len(raw)>3*1024**2 or hashlib.sha256(raw).hexdigest()!=digest:raise RuntimeError('CONTROL_HASH')
  path=root/name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=raw:raise RuntimeError('CONTROL_DRIFT')
  else:path.write_bytes(raw);path.chmod(0o600)
 (root/'plan.json').write_text(json.dumps(plan,sort_keys=True));(root/'plan.json').chmod(0o600)
 result=subprocess.run(['python3','-B',str(root/'recharge-plan-billing-release.py'),str(root/'plan.json')],capture_output=True,text=True)
 if result.returncode:
  lines=result.stderr.splitlines();codes=[x.split(': ',1)[-1] for x in lines if 'RuntimeError: ' in x]
  print(json.dumps({'status':'FAILED','mode':MODE,'reason':codes[-1] if codes and len(codes[-1])<180 else 'OUTPUT_SUPPRESSED'}));sys.exit(1)
 value=json.loads(result.stdout);print(json.dumps(value,sort_keys=True))
except Exception as error:
 print(json.dumps({'status':'FAILED','mode':MODE,'reason':'CONTROL_TRANSPORT_'+type(error).__name__}));sys.exit(1)
""".replace('MODE', repr(mode)).replace('PAYLOAD', repr(encoded))
    parameters = {'commands': ["python3 - <<'PY'\n" + source + '\nPY']}
    B.need(len(json.dumps(parameters).encode()) < 64 * 1024, 'SSM_TRANSPORT_TOO_LARGE')
    path = OUT / (mode + '-parameters.json')
    path.write_text(json.dumps(parameters))
    response = json.loads(F.execute('aws', 'ssm', 'send-command', '--region', 'ap-northeast-1',
        '--instance-ids', INSTANCE, '--document-name', 'AWS-RunShellScript',
        '--parameters', 'file://' + str(path), '--output', 'json'))
    command_id = response['Command']['CommandId']
    (OUT / (mode + '-command.json')).write_text(json.dumps({'commandId': command_id, 'mode': mode}) + '\n')
    deadline = time.monotonic() + 1500
    while time.monotonic() < deadline:
        time.sleep(10)
        result = json.loads(F.execute('aws', 'ssm', 'get-command-invocation', '--region', 'ap-northeast-1',
            '--instance-id', INSTANCE, '--command-id', command_id, '--output', 'json'))
        (OUT / (mode + '-invocation.json')).write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
        if result['Status'] in ('Pending', 'InProgress', 'Delayed'):
            continue
        B.need(result['Status'] == 'Success' and result['ResponseCode'] == 0
               and result['StandardErrorContent'] == '', 'SSM_' + mode.upper() + '_FAILED')
        value = json.loads(result['StandardOutputContent'])
        B.need(value.get('commit') == plan['commit'] and value.get('businessActions') == 0, 'SSM_RECEIPT')
        return value
    raise RuntimeError('RECHARGE_PLAN_BILLING_SSM_PENDING_DO_NOT_REPEAT')


def main(mode):
    c = json.loads(B.CONTRACT.read_bytes())
    B.check(c)
    native, quality = identity_and_quality(c)
    if mode == 'check':
        print(json.dumps({'status': 'BILLING_SOURCE_CHECKED', 'commit': native['commit']}))
        return
    if mode == 'build':
        B.build()
        (OUT / 'quality-evidence.json').write_text(json.dumps(quality, sort_keys=True, indent=2) + '\n')
        return
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    B.need(bundle.is_file() and not (OUT / 'release-command.json').exists(), 'PUBLICATION_ALREADY_ACCEPTED')
    with tarfile.open(bundle) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
        proof = json.loads(raw)
    B.need(all(proof[k] == native[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt')), 'BUILD_RUN_CHANGED')
    tag = PREFIX + '-' + native['commit']
    response = subprocess.run(['gh', 'release', 'view', tag, '--repo', REPO], cwd=ROOT, capture_output=True)
    B.need(response.returncode != 0, 'ARTIFACT_ALREADY_PUBLISHED')
    F.execute('gh', 'release', 'create', tag, str(bundle), str(OUT / 'artifact-sha256.txt'),
              '--repo', REPO, '--target', native['commit'], '--title', tag,
              '--notes', '经检查的套餐联动与账单永久排重构建；不包含真实付款或测试业务记录。')
    plan = {**native, 'contractSha256': B.sha(B.CONTRACT.read_bytes()), 'controlSources': proof['controlSources'],
            'artifactSha256': B.sha(bundle.read_bytes()), 'buildProofSha256': B.sha(raw),
            'artifactUrl': 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + bundle.name}
    command('preflight', plan, proof['controlSources'])
    B.need(B.git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == native['commit'], 'MAIN_MOVED_BEFORE_PUBLICATION')
    command('release', plan, proof['controlSources'])
    result = command('readback', plan, proof['controlSources'])
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'build', 'publish'])
    main(parser.parse_args().mode)
