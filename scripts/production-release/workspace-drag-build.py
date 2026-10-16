"""Reproduce the deployed Admin and overlay only the three card-drag sources."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/workspace-drag-release'


def need(value, code):
    if not value:
        raise RuntimeError('WORKSPACE_DRAG_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def load(name):
    spec = importlib.util.spec_from_file_location('drag_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(path):
    return load('recharge-record-release.py').file_inventory(path)


def published(c):
    d = load('chatgpt-sales-dispatch.py')
    identity = d.github('repos/' + d.REPOSITORY + '/actions/runs/' + c['publishedRunId'])
    need(identity['head_sha'] == c['expectedCurrent'] and identity['head_branch'] == 'main'
         and identity['path'] == '.github/workflows/chatgpt-sales-validation.yml'
         and identity['conclusion'] == 'success', 'PREDECESSOR_NOT_PUBLISHED')
    rows = d.github('repos/' + d.REPOSITORY + '/actions/runs/' + c['publishedRunId'] + '/artifacts')['artifacts']
    rows = [r for r in rows if r['name'] == 'chatgpt-sales-' + c['expectedCurrent'] + '-1' and not r['expired']]
    need(len(rows) == 1, 'PREDECESSOR_ARTIFACT_MISSING')
    zipped = d.execute('gh', 'api', 'repos/' + d.REPOSITORY + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0]['digest'] == 'sha256:' + sha(zipped), 'PREDECESSOR_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as z:
        bundle = z.read('chatgpt-sales-artifact.tar.gz')
    need(sha(bundle) == c['publishedArtifactSha256'], 'PREDECESSOR_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
    need(sha(raw) == c['publishedProofSha256'], 'PREDECESSOR_PROOF_CHANGED')
    proof = json.loads(raw)
    need(proof['commit'] == c['expectedCurrent'] and proof['workflowRunId'] == c['publishedRunId'], 'PREDECESSOR_IDENTITY_CHANGED')
    return proof


def validate_sources(c):
    expected = {'apps/admin/src/v2/components/workspace/V2QuickActions.vue',
                'apps/admin/src/v2/components/workspace/useV2QuickActionSorting.ts',
                'apps/admin/src/v2/styles/base.css'}
    need(set(c['sources']) == expected and all(sha((ROOT / n).read_bytes()) == v for n, v in c['sources'].items()), 'SOURCES_CHANGED')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')


def prepare(c):
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUTPUT.exists(), 'NATIVE_BUILD_ONLY')
    validate_sources(c)
    previous = published(c)
    raw = git('show', c['expectedCurrent'] + ':scripts/production-release/chatgpt-sales-contract.json')
    need(sha(raw) == c['publishedContractSha256'], 'RECONSTRUCTION_CHANGED')
    recipe = json.loads(raw)
    for name, expected in recipe['buildInputs']['admin'].items():
        need(git('ls-tree', 'HEAD', '--', name) == git('ls-tree', c['expectedCurrent'], '--', name), 'DEPENDENCY_CHANGED')
    OUTPUT.mkdir(parents=True)
    (OUTPUT / 'predecessor-proof.json').write_text(json.dumps(previous, sort_keys=True) + '\n')
    for variant in ('baseline', 'candidate'):
        context = OUTPUT / variant
        load('recharge-record-build.py').extract_source(git('archive', recipe['adminSourceBaseline']), context)
        inherited = {**recipe['adminPublishedSources'], **{
            n: {'commit': c['expectedCurrent'], 'sha256': v}
            for n, v in recipe['sources'].items() if n.startswith('apps/admin/')}}
        for name, entry in inherited.items():
            source = git('show', entry['commit'] + ':' + name)
            need(sha(source) == entry['sha256'], 'INHERITED_SOURCE_CHANGED')
            destination = context / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source)
        if variant == 'candidate':
            for name in [*c['sources'], 'apps/admin/src/v2/testing/workspace-design-fixture.ts',
                         'scripts/acceptance-v2-workspace-drag-static.mjs']:
                (context / name).write_bytes((ROOT / name).read_bytes())
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' +
                 (c['expectedCurrent'] if variant == 'baseline' else os.environ['GITHUB_SHA'])})
    need(inventory(OUTPUT / 'baseline/apps/admin/dist') == previous['adminFiles'], 'PREDECESSOR_NOT_REPRODUCED')


def package(c):
    validate_sources(c)
    quality = load('chatgpt-sales-build.py').quality()
    browser = json.loads((OUTPUT / 'candidate/.runtime/workspace-copy-drag-20261016/browser/result.json').read_bytes())
    need(browser.get('ok') is True and len(browser['checks']) == 13
         and browser['errors'] == browser['blocked'] == [], 'BROWSER_VERIFICATION_FAILED')
    payload = OUTPUT / 'payload'
    payload.mkdir()
    shutil.copytree(OUTPUT / 'candidate/apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        p = payload / 'source' / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes((ROOT / name).read_bytes())
    proof = {'version': 1, 'scope': c['scope'], 'commit': os.environ['GITHUB_SHA'],
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': sha((HERE / 'workspace-drag-contract.json').read_bytes()),
             'qualityVerification': quality, 'sources': c['sources'],
             'baselineAdminFiles': inventory(OUTPUT / 'baseline/apps/admin/dist'),
             'adminFiles': inventory(payload / 'admin/html'), 'files': inventory(payload),
             'publishedProofSha256': c['publishedProofSha256'], 'browserChecks': 13,
             'updatedServices': ['admin'], 'migrationPerformed': False, 'businessActions': 0}
    for field, name in [('controllerSha256', 'workspace-drag-release.py'),
                        ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        proof[field] = sha((HERE / name).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    with tarfile.open(OUTPUT / 'workspace-drag-artifact.tar.gz', 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(sha((OUTPUT / 'workspace-drag-artifact.tar.gz').read_bytes()) + '\n')
    print(json.dumps({'status': 'WORKSPACE_DRAG_ARTIFACT_BUILT', 'browserChecks': 13, 'updatedServices': ['admin'], 'businessActions': 0}))


if __name__ == '__main__':
    import sys
    contract = json.loads((HERE / 'workspace-drag-contract.json').read_bytes())
    {'prepare': prepare, 'package': package}[sys.argv[1]](contract)
