"""Build a finite shared-card delta over the independently reproduced live source."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/shared-bank-card'


def need(value, code):
    if not value:
        raise RuntimeError('SHARED_BANK_CARD_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def inventory(path):
    return load('recharge-record-release.py').file_inventory(path)


def reconstruct(context, contract):
    prior = load('online-settings-build.py')
    raw = (HERE / 'online-settings-contract.json').read_bytes()
    need(sha(raw) == contract['predecessorRecipeSha256'], 'PREDECESSOR_RECIPE_CHANGED')
    c = json.loads(raw)
    recipe = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())
    need(sha((HERE / 'registration-parity-diagnostics-contract.json').read_bytes()) == c['reconstructionContractSha256']
         and sha((HERE / 'registration-parity-diagnostics-build.py').read_bytes()) == c['reconstructionHelperSha256'], 'RECONSTRUCTION_CHANGED')
    prior.load('registration-parity-diagnostics-build.py').reconstruct(context, recipe)
    for name, expected in recipe['sources'].items():
        raw = git('show', c['reconstructionBaseCommit'] + ':' + name)
        need(sha(raw) == expected, 'PUBLISHED_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    prior.published_overlays(context, c)
    for name, expected in c['sources'].items():
        raw = git('show', c['sourceReviewCommit'] + ':' + name)
        need(sha(raw) == expected, 'PUBLISHED_SETTINGS_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def module_delta(before, after, contract):
    changed = {n for n in before.keys() | after.keys() if n.endswith(('.js', '.js.map', '.d.ts')) and before.get(n) != after.get(n)}
    expected = {n.removesuffix('.js') + suffix for n in contract['apiModules'] for suffix in ('.js', '.js.map', '.d.ts')} | set(contract['apiDeclarationOnly'])
    need({n for n in changed if n.endswith('.js')} == set(contract['apiModules']) and changed <= expected
         and expected <= after.keys(), 'API_DELTA_CHANGED')
    return {n: after[n] for n in sorted(expected)}


def main():
    raw_contract = (HERE / 'shared-bank-card-contract.json').read_bytes()
    c = json.loads(raw_contract)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    commit = git('rev-parse', 'HEAD').decode().strip()
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        reconstruct(context, c)
        if role == 'candidate':
            for name in c['sources']:
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
        for command in [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                        ('npm', 'run', 'prisma:mysql:generate'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/api'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/admin')]:
            subprocess.run(command, cwd=context, check=True, env={**os.environ, 'NODE_ENV': 'production',
                'V2_BUILD_ID': 'v2-' + (c['expectedCurrent'] if role == 'baseline' else commit)})
    before, after = OUTPUT / 'baseline', OUTPUT / 'candidate'
    baseline_api, candidate_api = inventory(before / 'apps/api/dist'), inventory(after / 'apps/api/dist')
    need(all(baseline_api.get(n) == value for n, value in c['baselineApiModules'].items()), 'BASE_API_NOT_REPRODUCED')
    baseline_admin = inventory(before / 'apps/admin/dist')
    need(sha(json.dumps(baseline_admin, sort_keys=True, separators=(',', ':')).encode()) == c['baselineAdminFilesSha256'], 'BASE_ADMIN_NOT_REPRODUCED')
    modules = module_delta(baseline_api, candidate_api, c)
    payload = OUTPUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(after / 'apps/api/dist' / name, target)
    for path in (after / 'node_modules/.prisma/client').iterdir():
        # The exact native engine from the live image stays in place. Linux CI
        # metadata is portable; its own native engine must never replace Alpine's.
        if path.is_file() and path.suffix != '.node':
            target = payload / 'api/prisma-client' / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    shutil.copyfile(after / 'apps/api/prisma-mysql/schema.prisma', payload / 'api/schema.prisma')
    shutil.copytree(after / 'apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    results = json.loads((ROOT / '.deploy/shared-bank-card-mysql/results.json').read_bytes())
    need(results['success'] is True and results['numPassedTests'] == 5 and results['numFailedTests'] == 0
         and results['numPendingTests'] == 0, 'REAL_MYSQL_EVIDENCE_MISSING')
    controls = {n: sha((HERE / n).read_bytes()) for n in c['controlFiles']}
    proof = {'version': 1, 'scope': c['scope'], 'commit': commit, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'contractSha256': sha(raw_contract), 'controlSources': controls, 'sources': c['sources'], 'apiModules': modules,
        'baselineAdminFiles': baseline_admin, 'adminFiles': inventory(payload / 'admin/html'),
        'prismaClientFiles': inventory(payload / 'api/prisma-client'), 'baselineApiReproduced': True,
        'baselineAdminSourceReproduced': True, 'afterEngineFiles': c['afterEngineFiles'],
        'plannedMigration': c['migration'], 'databaseVerification': {'isolated': True, 'tests': 5, 'passed': 5},
        'files': inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'shared-bank-card-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'SHARED_BANK_CARD_NATIVE_ARTIFACT_BUILT', 'apiModules': len(c['apiModules']), 'businessActions': 0}))


if __name__ == '__main__':
    main()
