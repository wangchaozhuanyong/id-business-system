"""Reproduce the deployed projection before compiling the authorized account delta."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/account-login-release'
CONTRACT = HERE / 'account-login-contract.json'


def need(value, code):
    if not value:
        raise RuntimeError('ACCOUNT_LOGIN_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('account_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(path):
    return load('recharge-record-release.py').file_inventory(path)


def verify_sources(c):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(c['scope'] == 'ACCOUNT_LOGIN_SEARCH_20261016', 'SCOPE_CHANGED')
    for name, expected in {**c['sources'], **c['supportSources']}.items():
        need(digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    for name, expected in c['recipeControls'].items():
        need(digest((HERE / name).read_bytes()) == expected, 'PUBLISHED_RECIPE_CHANGED')
    for role in ('api', 'admin'):
        for name in c['buildInputs'][role]:
            need(git('ls-tree', 'HEAD', '--', name) == git('ls-tree', c['reviewBase'], '--', name), 'DEPENDENCY_CHANGED')
    need(c['migration']['name'] == '20261016210000_chatgpt_email_search'
         and c['migration']['sha256'] == c['sources'][c['migration']['path']], 'MIGRATION_CHANGED')


def prepare(c):
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUTPUT.exists(), 'REMOTE_VALIDATION_ONLY')
    OUTPUT.mkdir(parents=True)
    recipe = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())
    # Verify successful predecessor artifacts independently; reuse reconstruction only.
    native = load('registration-parity-diagnostics-build.py')
    drag = native.native_proof(recipe['dragNative'])
    sales = native.native_proof(recipe['successorNative'])
    native.verify_drag_proof(drag, sales, recipe)
    need(drag['adminFiles'] == c['baselineAdminFiles'] and recipe['baselineApiFiles'] == c['baselineRuntimeApiFiles'], 'PREDECESSOR_PROOF_CHANGED')
    for variant in ('baseline', 'candidate'):
        context = OUTPUT / variant
        native.reconstruct(context, recipe)
        if variant == 'candidate':
            for name in {**c['sources'], **c['supportSources']}:
                p = context / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes((ROOT / name).read_bytes())
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', '@apple-business/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': c['baselineAdminBuildId'] if variant == 'baseline' else 'v2-' + os.environ['GITHUB_SHA']})
    before = inventory(OUTPUT / 'baseline/apps/api/dist')
    need({n:v for n,v in before.items() if n.endswith('.js')} == c['baselineRuntimeApiFiles'], 'PREDECESSOR_API_NOT_REPRODUCED')
    need(inventory(OUTPUT / 'baseline/apps/admin/dist') == c['baselineAdminFiles'], 'PREDECESSOR_ADMIN_NOT_REPRODUCED')


def api_delta(before, after, names):
    allowed = {n.removesuffix('.js') + ext for n in names for ext in ('.js', '.js.map', '.d.ts')}
    changed = {n for n in set(before) | set(after) if before.get(n) != after.get(n)}
    nonruntime = {n for n in changed - allowed if n.endswith('.d.ts') or n == 'tsconfig.build.tsbuildinfo'}
    need(changed <= allowed | nonruntime and not (set(before) - set(after))
         and all(n in after for n in allowed), 'API_OUTPUT_SCOPE_CHANGED')
    need(any(before.get(n) != after.get(n) for n in names), 'API_DELTA_EMPTY')
    return allowed


def package(c):
    passed = load('chatgpt-sales-build.py').quality()
    database = json.loads((OUTPUT / 'database-verification.json').read_bytes())
    browser = json.loads((OUTPUT / 'candidate/.runtime/chatgpt-sale-status-20261016/browser/result.json').read_bytes())
    need(database == {'isolated': True, 'migration': c['migration']['name'], 'legacyDefaultsVerified': True,
                     'testsPassed': 7, 'testsSkipped': 0, 'businessActions': 0}, 'DATABASE_VERIFICATION_FAILED')
    need(browser.get('status') == 'PASS' and browser.get('realWrites') == 0, 'BROWSER_VERIFICATION_FAILED')
    before, after = (inventory(OUTPUT / variant / 'apps/api/dist') for variant in ('baseline', 'candidate'))
    allowed = api_delta(before, after, c['apiModules'])
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for name in allowed:
        p = payload / 'api/modules' / name
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUTPUT / 'candidate/apps/api/dist' / name, p)
    shutil.copytree(OUTPUT / 'candidate/apps/admin/dist', payload / 'admin/html')
    for name in {**c['sources'], **c['supportSources']}:
        p = payload / 'source' / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes((ROOT / name).read_bytes())
    for name in c['hostSources']:
        p = payload / 'host' / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(git('show', c['hostSourceBaseline'] + ':' + name))
    proof = {'version': 1, 'scope': c['scope'], 'commit': os.environ['GITHUB_SHA'],
        'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
        'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'contractSha256': digest(CONTRACT.read_bytes()),
        'baselineApiFiles': {n: before.get(n) for n in sorted(allowed)},
        'baselineAdminFiles': c['baselineAdminFiles'],
        'baselineSources': {'api': c['apiSourceBaseline'], 'admin': c['adminSourceBaseline']},
        'adminPublishedSources': c['adminPublishedSources'], 'hostSources': c['hostSources'],
        'qualityVerification': passed, 'databaseVerification': database,
        'browserVerification': {'status': 'PASS', 'realWrites': 0},
        'generatedSchemaSha256': digest((OUTPUT / 'candidate/node_modules/.prisma/client/schema.prisma').read_bytes()),
        'omittedBuildOutputs': {n: after[n] for n in sorted(set(before) | set(after)) if before.get(n) != after.get(n) and n not in allowed},
        'files': inventory(payload), 'apiModules': {n: after[n] for n in sorted(allowed)},
        'adminFiles': inventory(payload / 'admin/html'), 'updatedServices': ['api', 'admin'],
        'migration': c['migration'], 'businessActions': 0}
    for field, name in [('controllerSha256', 'account-login-release.py'), ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        proof[field] = digest((HERE / name).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    with tarfile.open(OUTPUT / 'account-login-artifact.tar.gz', 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest((OUTPUT / 'account-login-artifact.tar.gz').read_bytes()) + '\n')
    print(json.dumps({'status': 'ACCOUNT_LOGIN_ARTIFACT_BUILT', 'apiFiles': len(allowed), 'databaseTestsPassed': 7, 'businessActions': 0}))


if __name__ == '__main__':
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    {'prepare': prepare, 'package': package}[sys.argv[1]](contract)
