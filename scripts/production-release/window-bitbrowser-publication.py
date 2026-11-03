"""Use native main OIDC/SSM publication, with parent reproduction and exact source receipts."""
import argparse
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'window-bitbrowser'
WORKFLOW = '.github/workflows/' + PREFIX + '-publication.yml'
OUT = ROOT / '.deploy' / PREFIX


def load(name):
    spec = importlib.util.spec_from_file_location('window_publication_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


R = load(PREFIX + '-release.py')
F = load('financial-closure-publication.py')
F.WORKFLOW = WORKFLOW
need, sha = R.need, R.sha


def check(c):
    R.validate(c)
    need(F.git('merge-base', '--is-ancestor', c['reviewBase'], 'HEAD') is not None, 'REVIEW_BASE')
    names = set(F.git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines())
    need(names <= set(c['candidateFiles']), 'UNREVIEWED_EXTENSION')
    for name, digest in {**c['sources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
    need(sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'DEPENDENCY_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')


def quality(native):
    qa = load('permission-loading-publication.py').quality(native)
    head = qa['review']['head']
    rows = F.github('actions/workflows/window-bitbrowser-validation.yml/runs?head_sha=' + head)['workflow_runs']
    rows = [r for r in rows if r['head_sha'] == head and r['event'] == 'pull_request' and r['conclusion'] == 'success']
    need(bool(rows), 'ISOLATED_DATABASE_VALIDATION_REQUIRED')
    return {**qa, 'isolatedDatabase': {'head': head, 'runId': rows[0]['id'], 'attempt': rows[0]['run_attempt']}}


def transport(plan, mode):
    source = inspect.getsource(F.transport)
    changes = {"directory/'financial-closure-release.py'": "directory/'window-bitbrowser-release.py'",
        'financial-entry-': 'window-bitbrowser-entry-',
        'FINANCIAL_PUBLICATION|BITBROWSER_HISTORY': 'WINDOW_BITBROWSER|RECHARGE_PLAN_BILLING|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY'}
    for before, after in changes.items():
        need(source.count(before) == 1, 'TRANSPORT_RECIPE_CHANGED')
        source = source.replace(before, after)
    values = {**F.__dict__}
    exec(compile(source, '<window-bitbrowser-transport>', 'exec'), values)
    return values['transport'](plan, mode, OUT)


def archive_source(ref, folder):
    with tarfile.open(fileobj=io.BytesIO(F.git('archive', ref))) as archive:
        archive.extractall(folder, filter='data')


def build(c, plan):
    B = load('recharge-plan-billing-build.py')
    B.OUT, B.PREFIX, B.CONTRACT = OUT / 'build', PREFIX, HERE / R.CONTRACT_FILE
    resolved = {**c, 'baseline': plan['nativeParentCapture']['baseline'], 'baselineAdminBuildCommit': c['expectedCurrent']}
    def reconstruct(_c):
        folders = [B.OUT / 'api-baseline', B.OUT / 'admin-baseline']
        for path in folders:
            archive_source(c['reviewBase'], path)
        return tuple(folders)
    B.reconstruct, B.check = reconstruct, lambda _c: check(c)
    source = inspect.getsource(B.build)
    source = source.replace('c = json.loads(CONTRACT.read_bytes())', 'c = RESOLVED')
    source = source.replace("if n.startswith('apps/api/src/') and not n.endswith('.spec.ts')", "if n.startswith('apps/api/src/') and n.endswith('.ts') and not n.endswith('.spec.ts')")
    needle="    need(not (set(before_api) - set(after_api))"
    need(source.count(needle) == 1, 'BUILD_RECIPE_CHANGED')
    source = source.replace(needle,"    selected |= {n for n in delta if n.endswith('.d.ts')}\n"+needle)
    start = source.index('    controls = [')
    end = source.index('    for name in controls:', start)
    source = source[:start]+"    controls = sorted(set(c['helperPins']) | {PREFIX + '-release.py', PREFIX + '-contract.json'})\n"+source[end:]
    values = {**B.__dict__, 'RESOLVED': resolved}
    exec(compile(source, '<window-bitbrowser-build>', 'exec'), values)
    values['build']()
    payload = B.OUT / 'payload'
    proof_file = payload / 'build-proof.json'
    proof = json.loads(proof_file.read_bytes())
    before_client = B.inventory(B.OUT / 'api-baseline/node_modules/.prisma/client')
    need({'count': len(before_client), 'sha256': sha(R.canonical(before_client))}
         == resolved['baseline']['runtime']['clientInventory'], 'PRISMA_PARENT_NOT_REPRODUCED')
    for name in ('credentials.cjs', 'SOURCE_MANIFEST.json'):
        engine = payload / 'online-recharge/engine' / name
        engine.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'apps/api/src/id-business-v2/online-recharge/engine' / name, engine)
    proof.update(nativeParentCapture=plan['nativeParentCapture'], qualitySourceEvidence=plan['qualitySourceEvidence'],
        sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAIN_WINDOW_OVERLAY')
    proof_file.unlink()
    proof['files'] = B.inventory(payload)
    R.verify_proof(proof, plan, resolved, proof['files'])
    proof_file.write_text(json.dumps(proof, sort_keys=True, indent=2)+'\n')
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    shutil.copyfile(B.OUT / (PREFIX + '-migration.tar.gz'), OUT / (PREFIX + '-migration.tar.gz'))
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes())+'\n')
    return proof


def main(operation):
    c = json.loads((HERE / R.CONTRACT_FILE).read_bytes())
    check(c)
    native = F.native_identity()
    need(os.environ.get('EXPECTED_CURRENT') == c['expectedCurrent'], 'EXPECTED_CURRENT')
    need(json.loads(F.execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == c['awsAccount'], 'AWS_ACCOUNT')
    need(F.git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == native['commit'], 'MAIN_MOVED')
    qa = quality(native)
    OUT.mkdir(parents=True, exist_ok=False)
    controls = {**c['helperPins'], PREFIX + '-release.py': sha((HERE / (PREFIX + '-release.py')).read_bytes()),
        R.CONTRACT_FILE: sha((HERE / R.CONTRACT_FILE).read_bytes())}
    plan = {**native, 'contractSha256': sha((HERE / R.CONTRACT_FILE).read_bytes()), 'controlSources': controls, 'qualitySourceEvidence': qa}
    capture = transport(plan, 'capture')
    need(capture['status'] == 'WINDOW_BITBROWSER_PARENT_VERIFIED', 'PARENT_CAPTURE')
    plan['nativeParentCapture'] = capture
    (OUT / 'parent-capture.json').write_text(json.dumps(capture, sort_keys=True, indent=2)+'\n')
    if operation == 'observe':
        print(json.dumps({'status': capture['status'], 'commit': native['commit'], 'businessActions': 0}))
        return
    proof = build(c, plan)
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    tag = PREFIX + '-' + native['commit']
    exists = subprocess.run(['gh', 'release', 'view', tag, '--repo', F.REPO], cwd=ROOT, capture_output=True)
    need(exists.returncode != 0, 'ARTIFACT_ALREADY_ACCEPTED')
    F.execute('gh', 'release', 'create', tag, str(bundle), str(OUT / (PREFIX + '-migration.tar.gz')),
        '--repo', F.REPO, '--target', native['commit'], '--title', '本窗口业务资料与比特派单 '+native['commit'][:12],
        '--notes', '从确定的 main 提交构建；仅包含本窗口审查范围，业务动作数为零。')
    plan.update(artifactUrl='https://github.com/'+F.REPO+'/releases/download/'+tag+'/'+bundle.name,
        artifactSha256=sha(bundle.read_bytes()), buildProofSha256=sha((OUT / 'build/payload/build-proof.json').read_bytes()))
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2)+'\n')
    need(transport(plan, 'preflight')['status'] == 'BILLING_PREFLIGHT_VERIFIED', 'PREFLIGHT')
    need(F.git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == native['commit'], 'MAIN_MOVED')
    result = transport(plan, 'release')
    need(result['status'] == 'BILLING_DEPLOYED', 'DEPLOYMENT')
    readback = transport(plan, 'readback')
    need(readback['status'] == 'BILLING_INDEPENDENT_READBACK_VERIFIED', 'INDEPENDENT_READBACK')
    print(json.dumps({'status': 'WINDOW_BITBROWSER_PUBLISHED_AND_VERIFIED', 'commit': native['commit'], 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['observe', 'publish'])
    main(parser.parse_args().operation)
