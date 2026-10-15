"""Build a finite billing overlay from an authenticated published predecessor."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/recharge-billing-release'
CONTRACT = HERE / 'recharge-billing-contract.json'


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_BILLING_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('billing_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(root):
    return load('recharge-record-release.py').file_inventory(root)


def verify_sources(contract):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    before = contract['sourceBaseline']
    need(git('rev-parse', before + '^{tree}').decode().strip() == contract['sourceBaselineTree'], 'BASE_TREE_CHANGED')
    changed = set(git('diff', '--name-only', contract['reviewBase'], 'HEAD', '--', 'apps/', 'packages/').decode().splitlines())
    need(changed == set(contract['sources']), 'SOURCE_SCOPE_CHANGED')
    for name, expected in contract['sources'].items():
        need(name.startswith(('apps/admin/src/v2/features/auto-recharge/',
                             'apps/api/src/id-business-v2/auto-recharge/'))
             and digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    # Preserve all ordinary frontend inputs, dependencies, Prisma and build commands.
    names = git('ls-tree', '-r', '--name-only', before).decode().splitlines()
    for name in names:
        if (name.startswith(('apps/admin/', 'packages/shared/', 'apps/api/prisma-mysql/'))
                or name in ('package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc',
                            'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json')):
            if name not in contract['sources']:
                need(git('ls-tree', 'HEAD', '--', name) == git('ls-tree', before, '--', name), 'PRESERVED_INPUT_CHANGED')


def verify_native_baseline(contract):
    native = contract['baselineNative']
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    def api(path):
        return subprocess.check_output(['gh', 'api', prefix + path], cwd=ROOT)
    run_meta = json.loads(api('actions/runs/' + str(native['runId'])))
    need(run_meta['head_sha'] == contract['sourceBaseline'] and run_meta['conclusion'] == 'success'
         and run_meta['path'] == '.github/workflows/recharge-availability-validation.yml'
         and run_meta['event'] == 'workflow_dispatch' and run_meta['run_attempt'] == 1, 'BASE_NATIVE_CHANGED')
    meta = json.loads(api('actions/artifacts/' + str(native['artifactId'])))
    need(meta['digest'] == native['artifactDigest'] and not meta['expired']
         and meta['workflow_run']['id'] == native['runId'], 'BASE_ARTIFACT_CHANGED')
    raw = api('actions/artifacts/' + str(native['artifactId']) + '/zip')
    need(len(raw) < 32 * 1024**2 and 'sha256:' + digest(raw) == native['artifactDigest'], 'BASE_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(set(archive.namelist()) == {'recharge-availability-artifact.tar.gz', 'artifact-sha256.txt'}, 'BASE_LAYOUT_CHANGED')
        bundle = archive.read('recharge-availability-artifact.tar.gz')
        need(digest(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'BASE_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        proof = json.load(archive.extractfile('payload/build-proof.json'))
        need(proof['commit'] == contract['sourceBaseline'] and proof['adminFiles'] == contract['baselineAdminFiles'], 'BASE_PROOF_CHANGED')
        for name, expected in proof['adminFiles'].items():
            need(digest(archive.extractfile('payload/admin/html/' + name).read()) == expected, 'BASE_ADMIN_CHANGED')
    return {**native, 'verified': True}


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    raw = git('archive', contract['sourceBaseline'])
    h = load('recharge-record-build.py')
    for name in ('baseline', 'candidate'):
        context = OUTPUT / name
        h.extract_source(raw, context)
        if name == 'candidate':
            for path in contract['sources']:
                destination = context / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((ROOT / path).read_bytes())
        run('npm', 'ci', '--no-audit', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def build():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (baseline, candidate):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    before, after = inventory(baseline / 'apps/api/dist'), inventory(candidate / 'apps/api/dist')
    for name, expected in contract['apiModules'].items():
        need(before.get(name) == expected, 'BASE_API_NOT_REPRODUCED')
    allowed = load('recharge-availability-build.py').verify_api_outputs(before, after, contract['apiModules'])
    native = verify_native_baseline(contract)
    commit, tree = (git('rev-parse', ref).decode().strip() for ref in ('HEAD', 'HEAD^{tree}'))
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=candidate,
        env={**os.environ, 'NODE_ENV': 'test', 'V2_BUILD_ID': 'v2-' + commit})
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for name in allowed:
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, path)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name in contract['sources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    proof = {'version': 1, 'scope': contract['scope'], 'commit': commit, 'tree': tree,
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(CONTRACT.read_bytes()), 'baselineApiReproduced': True,
             'baselineNativeVerified': native, 'databaseVerification': {'isolated': True, 'suite': 'recharge-billing.mysql.integration.spec.ts'},
             'files': inventory(payload), 'apiModules': {n: after[n] for n in sorted(allowed)},
             'adminFiles': inventory(candidate / 'apps/admin/dist'), 'updatedServices': ['api', 'admin'],
             'migrationPerformed': False, 'businessActions': 0}
    for field, name in [('controllerSha256', 'recharge-billing-release.py'), ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        proof[field] = digest((HERE / name).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'recharge-billing-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BILLING_ARTIFACT_BUILT', 'apiFiles': len(allowed), 'adminFiles': len(proof['adminFiles'])}))


if __name__ == '__main__':
    {'prepare': prepare, 'build': build}[sys.argv[1]]()
