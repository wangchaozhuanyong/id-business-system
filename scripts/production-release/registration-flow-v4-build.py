"""Reconstruct published components, then validate/package only this adapter repair."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
NAME = 'registration-flow-v4-20261017'
OUT = ROOT / '.deploy' / NAME
C8 = 'c8ce1a01a1a1e61bcc8de778dad331191319d645'
DISPLAY = '626620f09b9fc27e32cc1d3e8a93cb1c51513387'
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
SCHEMA = 'apps/api/prisma-mysql/schema.prisma'


def load(path):
    spec = importlib.util.spec_from_file_location('repair_build_' + path.stem.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load(HERE / 'registration-flow-v4-release.py')
need, digest, signature = r.need, r.digest, r.signature


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(path):
    return {n: value for n, value in r.helper('recharge-record-release.py').file_inventory(path).items()
            if not n.endswith('.tsbuildinfo') and '__pycache__' not in Path(n).parts and not n.endswith('.pyc')}


def admitted():
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'ISOLATED_CI_REQUIRED')
    c = json.loads((HERE / 'registration-flow-v4-contract.json').read_bytes())
    r.verify_contract(c)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', c['sourceBaseline'] + '^{tree}').decode().strip() == c['sourceBaselineTree'], 'SOURCE_BASE_CHANGED')
    need(set(git('diff', '--name-only', c['sourceBaseline'], 'HEAD').decode().splitlines()) == set(c['expectedGitChanges']),
         'SOURCE_SCOPE_CHANGED')
    contract_name = 'scripts/production-release/registration-flow-v4-contract.json'
    need(set(c['reviewedFileHashes']) == set(c['expectedGitChanges']) - {contract_name}, 'REVIEW_SCOPE_CHANGED')
    for name, expected in {**c['reviewedFileHashes'], **c['sources'], **c['validationSources'],
                           **c['validationSupportSources']}.items():
        path = ROOT / name
        need(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(ROOT)
             and digest(path.read_bytes()) == expected, 'REVIEWED_SOURCE_CHANGED')
    return c


def overlay(context, sources, commit=None):
    for name, expected in sources.items():
        need('..' not in Path(name).parts and not name.startswith('/'), 'SOURCE_PATH_INVALID')
        raw = git('show', commit + ':' + name) if commit else (ROOT / name).read_bytes()
        need(digest(raw) == expected, 'SOURCE_CHANGED')
        path = context / name
        need(not path.is_symlink(), 'SOURCE_LINK')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def overlay_runtime_worker(context, c):
    for name, pin in c['reconstruction']['runtimeWorkerSources'].items():
        overlay(context, {WORKER + name: pin['sha256']}, pin['commit'])


def published_recipe(c, key, filename):
    binding = c['reconstruction'][key]
    raw = git('show', binding['commit'] + ':scripts/production-release/' + filename)
    need(digest(raw) == binding['contractSha256'], 'PUBLISHED_SUCCESSOR_RECIPE_CHANGED')
    recipe = json.loads(raw)
    need(recipe['sourceReviewCommit'] == binding['sourceReviewCommit']
         and signature(recipe['sources']) == binding['sources']
         and signature(recipe['afterEngineFiles']) == binding['engineFiles'], 'PUBLISHED_SUCCESSOR_SOURCES_CHANGED')
    return recipe


def published_legacy_recipe(c):
    binding = c['reconstruction']['legacyClose']
    raw = git('show', binding['commit'] + ':scripts/production-release/online-legacy-close-contract.json')
    need(digest(raw) == binding['contractSha256'], 'PUBLISHED_LEGACY_RECIPE_CHANGED')
    recipe = json.loads(raw)
    need(recipe['sourceReviewCommit'] == binding['sourceReviewCommit']
         and signature(recipe['sources']) == binding['sources']
         and all(name.startswith(('apps/api/src/id-business-v2/online-recharge/', 'docs/'))
                 for name in recipe['sources']), 'PUBLISHED_LEGACY_SOURCES_CHANGED')
    return recipe


def overlay_published_sources(context, role, c, recipe, successor_recipe, recharge_recipe):
    overlay(context, recipe['sources'], recipe['sourceReviewCommit'])
    display_sources = {ENGINE + name: value for name, value in c['reconstruction']['displaySources'].items()}
    overlay(context, display_sources, DISPLAY)
    if role != 'previous-admin':
        overlay(context, successor_recipe['sources'], c['reconstruction']['successor']['commit'])
        need(inventory(context / ENGINE) == successor_recipe['afterEngineFiles']
             and signature(successor_recipe['afterEngineFiles']) == c['reconstruction']['successor']['engineFiles'],
             'PUBLISHED_ENGINE_NOT_REPRODUCED')
    if role in ('055-admin', 'baseline', 'candidate'):
        overlay(context, recharge_recipe['sources'], c['reconstruction']['publishedRecharge']['commit'])
        need(inventory(context / ENGINE) == recharge_recipe['afterEngineFiles']
             and signature(recharge_recipe['afterEngineFiles']) == c['reconstruction']['publishedRecharge']['engineFiles'],
             'PUBLISHED_RECHARGE_NOT_REPRODUCED')
    if role in ('baseline', 'candidate'):
        published = r.historical_repair(c)
        overlay(context, published['sources'], c['reconstruction']['registeredRepair']['commit'])
        legacy = published_legacy_recipe(c)
        overlay(context, legacy['sources'], c['reconstruction']['legacyClose']['commit'])
        need(signature(inventory(context / ENGINE)) == c['baseline']['inventory']['engine'],
             'LIVE_ENGINE_NOT_REPRODUCED')


def prepare():
    c = admitted()
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    history = OUT / 'history'
    raw = git('archive', C8, 'scripts/production-release')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive:
            need(not item.name.startswith('/') and '..' not in Path(item.name).parts
                 and (item.isdir() or item.isfile()), 'HISTORY_PATH_INVALID')
        archive.extractall(history)
    old_here = history / 'scripts/production-release'
    need(digest((old_here / 'online-checkout-build.py').read_bytes()) == c['reconstruction']['helperSha256']
         and digest((old_here / 'online-checkout-contract.json').read_bytes()) == c['reconstruction']['contractSha256'],
         'PUBLISHED_RECIPE_CHANGED')
    recipe = json.loads((old_here / 'online-checkout-contract.json').read_bytes())
    successor_recipe = published_recipe(c, 'successor', 'online-checkout-retest-contract.json')
    recharge_recipe = published_recipe(c, 'publishedRecharge', 'online-unattended-contract.json')
    builder = load(old_here / 'online-checkout-build.py')
    builder.OUT = OUT / 'historical-merge'
    builder.OUT.mkdir(mode=0o700)
    prior_git_dir = os.environ.get('GIT_DIR')
    os.environ['GIT_DIR'] = git('rev-parse', '--absolute-git-dir').decode().strip()
    try:
        legacy = OUT / 'legacy-admin'
        builder.reconstruct(legacy, recipe, None)
        for role in ('previous-admin', '0222-admin', '055-admin', 'baseline', 'candidate'):
            context = OUT / role
            shutil.copytree(legacy, context)
            overlay_published_sources(context, role, c, recipe, successor_recipe, recharge_recipe)
            overlay_runtime_worker(context, c)
            if role == 'candidate':
                overlay(context, {**c['sources'], **c['validationSources'], **c['validationSupportSources']})
            need(digest((context / SCHEMA).read_bytes()) == c['baseline']['schemaSha256'], 'SCHEMA_CHANGED')
    finally:
        if prior_git_dir is None:
            os.environ.pop('GIT_DIR', None)
        else:
            os.environ['GIT_DIR'] = prior_git_dir
    print(json.dumps({'status': r.SCOPE + '_PREPARED', 'migrationPerformed': False, 'businessActions': 0}))


def ensure_prepared():
    c = admitted()
    if not OUT.exists():
        prepare()
    need(all((OUT / role).is_dir() for role in ('candidate', 'baseline', '055-admin', '0222-admin', 'previous-admin')),
         'PREPARATION_MISSING')
    verify_candidate_sources(c)
    return c


def verify_candidate_sources(c):
    for name, expected in {**c['sources'], **c['validationSources'], **c['validationSupportSources']}.items():
        path = OUT / 'candidate' / name
        need(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected,
             'PREPARED_SOURCE_MOVED')


def install(context, api=False):
    if not (context / 'node_modules').is_dir():
        run('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
    run('npm', 'run', 'prisma:mysql:generate', cwd=context)
    run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)


def python():
    path = OUT / 'python/bin/python'
    if not path.exists():
        run('python3', '-m', 'venv', str(OUT / 'python'))
        run(str(path), '-m', 'pip', 'install', '--disable-pip-version-check', '-r',
            str(OUT / 'candidate' / WORKER / 'requirements.lock.txt'))
        run(str(path), '-m', 'pip', 'check')
    return path


def runtime_worker_map(c):
    old = r.historical_repair(c)
    rows = {**old['baselineWorkerFiles'], **old['workerFiles']}
    need(signature(rows) == c['baseline']['inventory']['worker'], 'WORKER_BASE_NOT_REPRODUCED')
    return rows


def check_api():
    c = ensure_prepared()
    before, after = OUT / 'baseline', OUT / 'candidate'
    for context in (before, after):
        install(context, True)
        run('npm', 'run', 'build', '--workspace', '@apple-business/api', cwd=context)
    old, new = inventory(before / 'apps/api/dist'), inventory(after / 'apps/api/dist')
    js = lambda rows: {n: value for n, value in rows.items() if n.endswith('.js')}
    need(signature(js(old)) == c['baseline']['inventory']['apiJavascript'] and js(old) == js(new), 'API_JAVASCRIPT_CHANGED')
    changed = {n for n in old.keys() | new.keys() if old.get(n) != new.get(n)}
    need(changed == set(c['apiDeclarationPaths']), 'API_DECLARATION_SCOPE_CHANGED')
    worker = runtime_worker_map(c)
    need(all(digest((before / WORKER / name).read_bytes()) == value for name, value in worker.items()), 'BASE_WORKER_SOURCE_CHANGED')
    run('npm', 'run', 'typecheck', '--workspace', '@apple-business/api', cwd=after)
    run('npm', 'run', 'test', '--workspace', '@apple-business/api', '--', 'src/id-business-v2/auto-registration', cwd=after)
    py = python()
    for name in c['pythonTests']:
        need(re.fullmatch('test_[a-z0-9_]+', name), 'TEST_SCOPE_INVALID')
        run(str(py), '-B', '-m', 'unittest', name, cwd=after / WORKER)
    # Published images retain historical incremental declaration/map inventory.
    # No dist file is needed for a type-only source change: inherit every live
    # dist byte, while proving all compiled JS matches live and the only fresh
    # compilation delta is the approved declaration.
    receipt = {'status': 'PASS', 'apiModules': {}, 'apiJavascriptDelta': [],
               'compiledDeclarationDelta': {n: new[n] for n in sorted(changed)},
               'compiledBeforeApi': signature(old), 'compiledAfterApi': signature(new),
               'beforeApi': c['baseline']['inventory']['api'], 'afterApi': c['baseline']['inventory']['api'],
               'afterWorker': signature({**worker, **c['workerFiles']})}
    (OUT / 'api-validation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')


def check_admin():
    c = ensure_prepared()
    baseline_dist = {}
    for role, build_id in [('legacy-admin', 'v2-1bd89a110774ebb4cfcbcfeefa35752ae3c83fae'),
                           ('previous-admin', 'v2-' + C8),
                           ('0222-admin', 'v2-' + c['reconstruction']['successor']['commit']),
                           ('055-admin', 'v2-' + c['reconstruction']['publishedRecharge']['commit']),
                           ('baseline', c['baseline']['adminBuildId']),
                           ('candidate', 'v2-' + git('rev-parse', 'HEAD').decode().strip())]:
        context = OUT / role
        install(context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': build_id})
        baseline_dist[role] = inventory(context / 'apps/admin/dist')
    c8 = json.loads(git('show', C8 + ':scripts/production-release/online-checkout-contract.json'))
    need(r.digest(r.canonical(baseline_dist['legacy-admin'])) == c8['baselineAdminFilesSha256'], 'LEGACY_ADMIN_NOT_REPRODUCED')
    need(signature(baseline_dist['previous-admin']) == c['reconstruction']['previousAdminProof']['adminFiles'],
         'PREVIOUS_ADMIN_NOT_REPRODUCED')
    need(signature(baseline_dist['0222-admin']) == c['reconstruction']['successorAdminProof']['adminFiles'],
         'SUCCESSOR_ADMIN_NOT_REPRODUCED')
    expected_recharge = c['baseline']['publishedProofs']['online-checkout-build-proof.json']['adminFiles']
    need(signature(baseline_dist['055-admin']) == expected_recharge, 'PUBLISHED_RECHARGE_ADMIN_NOT_REPRODUCED')
    expected = c['reconstruction']['registeredRepair']['proof']['adminFiles']
    need(signature(baseline_dist['baseline']) == expected, 'PUBLISHED_ADMIN_NOT_REPRODUCED')
    old = json.loads(git('show', '1bd89a110774ebb4cfcbcfeefa35752ae3c83fae:scripts/production-release/registration-protocol-restore-contract.json'))
    retained = {**old['runtimeAdminFiles'], **baseline_dist['legacy-admin'],
                **baseline_dist['previous-admin'], **baseline_dist['0222-admin'],
                **baseline_dist['055-admin'], **baseline_dist['baseline']}
    need(signature(retained) == c['baseline']['inventory']['admin'], 'ADMIN_HISTORY_NOT_REPRODUCED')
    final = {**retained, **baseline_dist['candidate']}
    context = OUT / 'candidate'
    run('npm', 'run', 'typecheck', '--workspace', '@apple-business/admin', cwd=context)
    run('npm', 'run', 'test', '--workspace', '@apple-business/admin', '--', 'src/v2/features/auto-registration', cwd=context)
    for name in ('admin-ui', 'v2-ui-language', 'v2-color-contrast', 'v2-table-standard', 'v2-loading-standard',
                 'v2-module-architecture', 'v2-isolation'):
        run('npm', 'run', 'check:' + name, cwd=context)
    run('npm', 'exec', '--', 'playwright', 'install', '--with-deps', 'chromium', cwd=context)
    run('node', 'scripts/acceptance-v2-registration-parity-diagnostics.mjs', '--flow-v4', '--python=' + str(python()), cwd=context)
    (OUT / 'admin-validation.json').write_text(json.dumps({'status': 'PASS', 'adminFiles': baseline_dist['candidate'],
        'beforeAdmin': signature(retained), 'afterAdmin': signature(final), 'retainedAssetCount': len(retained)}, sort_keys=True, indent=2) + '\n')


def package():
    c = admitted()
    verify_candidate_sources(c)
    api = json.loads((OUT / 'api-validation.json').read_bytes())
    admin = json.loads((OUT / 'admin-validation.json').read_bytes())
    need(api['status'] == admin['status'] == 'PASS', 'VALIDATION_MISSING')
    payload = OUT / 'payload'
    need(not payload.exists(), 'PACKAGE_EXISTS')
    (payload / 'api/modules').mkdir(parents=True)
    for name in api['apiModules']:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'candidate/apps/api/dist' / name, target)
    for name, expected in c['workerFiles'].items():
        raw = (OUT / 'candidate' / WORKER / name).read_bytes()
        need(digest(raw) == expected, 'WORKER_SOURCE_MOVED')
        target = payload / 'api/worker' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    shutil.copytree(OUT / 'candidate/apps/admin/dist', payload / 'admin/html')
    for name, expected in c['sources'].items():
        raw = (ROOT / name).read_bytes()
        need(digest(raw) == expected, 'SOURCE_MOVED')
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    after = copy.deepcopy(c['baseline']['inventory'])
    after.update(api=api['afterApi'], worker=api['afterWorker'], admin=admin['afterAdmin'])
    proof = {'version': 1, 'scope': r.SCOPE, 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest((HERE / 'registration-flow-v4-contract.json').read_bytes()),
             'controlSources': c['controlHashes'], 'sources': c['sources'], 'validationSources': c['validationSources'],
             'apiModules': api['apiModules'], 'apiJavascriptDelta': [], 'workerFiles': c['workerFiles'],
             'adminFiles': admin['adminFiles'], 'baselineInventory': c['baseline']['inventory'], 'afterInventory': after,
             'validation': {'status': 'PASS', 'api': True, 'admin': True, 'offlineBrowser': True, 'isolatedPersistence': True},
             'files': inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / (NAME + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': r.SCOPE + '_ARTIFACT_BUILT', 'migrationPerformed': False, 'businessActions': 0}))


if __name__ == '__main__':
    import sys
    mode = sys.argv[1] if len(sys.argv) == 2 else 'build'
    need(len(sys.argv) <= 2 and mode in {'prepare', 'check-api', 'check-admin', 'build', 'package'}, 'MODE_INVALID')
    if mode == 'prepare': prepare()
    elif mode == 'check-api': check_api()
    elif mode == 'check-admin': check_admin()
    elif mode == 'package': package()
    else:
        check_api()
        check_admin()
        package()
