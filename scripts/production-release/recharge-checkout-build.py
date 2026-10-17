"""Build only the checkout repair over independently reproduced live API/Admin inputs."""
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
OUTPUT = ROOT / '.deploy/recharge-checkout-release'
CONTRACT = HERE / 'recharge-checkout-contract.json'
MYSQL_REPORT = ROOT / '.runtime/recharge-web-direct-release/mysql-vitest.json'


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_CHECKOUT_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('checkout_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(root):
    return load('recharge-record-release.py').file_inventory(root)


def verify_sources(c):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(c['scope'] == 'BIT_RECHARGE_WEB_DIRECT_EXPIRED_CHECKOUT_20261017', 'SCOPE_CHANGED')
    changed = set(git('diff', '--name-only', c['reviewBase'], 'HEAD', '--', 'apps/', 'packages/').decode().splitlines())
    need(changed == set(c['sources']), 'SOURCE_SCOPE_CHANGED')
    for name, expected in c['sources'].items():
        need(name.startswith(('apps/admin/src/v2/features/auto-recharge/',
                              'apps/api/src/id-business-v2/auto-recharge/'))
             or name == 'packages/shared/src/v2/auto-recharge.ts', 'SOURCE_PATH_INVALID')
        need(digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    for role in ('api', 'admin'):
        before = c[role + 'SourceBaseline']
        if subprocess.run(['git', 'cat-file', '-e', before + '^{commit}'], cwd=ROOT,
                          capture_output=True).returncode:
            run('git', 'fetch', '--no-tags', 'origin', before)
        need(git('rev-parse', before + '^{tree}').decode().strip() == c[role + 'SourceBaselineTree'], 'BASE_TREE_CHANGED')
        for name in ('package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc',
                     'apps/api/package.json', 'apps/admin/package.json', 'packages/shared/package.json'):
            need(git('ls-tree', 'HEAD', '--', name) == git('ls-tree', c['reviewBase'], '--', name), 'DEPENDENCY_INPUT_CHANGED')
            if role == 'api':
                need((digest(git('show', before + ':' + name)) if git('ls-tree', before, '--', name).strip() else None)
                     == c['buildInputs'][role][name], 'PUBLISHED_BUILD_INPUT_CHANGED')
    need(not git('diff', '--name-only', c['apiSourceBaseline'], 'HEAD', '--', 'apps/api/prisma-mysql/').strip(), 'SCHEMA_CHANGED')
    # Compare the actual Prisma call ASTs; the repository change is post-query qualification only.
    name = 'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts'
    driver = """const fs=require('fs'),ts=require('typescript');const input=JSON.parse(fs.readFileSync(0,'utf8'));
const p=ts.createPrinter({removeComments:true});function calls(s){const f=ts.createSourceFile('x.ts',s,ts.ScriptTarget.Latest,true),r=[];
function visit(n){if(ts.isCallExpression(n)&&/^(tx|this\\.prisma)\\./.test(n.expression.getText(f)))r.push(p.printNode(ts.EmitHint.Unspecified,n,f));ts.forEachChild(n,visit)}visit(f);return r}
process.stdout.write(JSON.stringify(calls(input[0]))===JSON.stringify(calls(input[1]))?'same':'different');"""
    result = subprocess.run(['node', '-e', driver], cwd=ROOT, capture_output=True, text=True,
        input=json.dumps([git('show', c['apiSourceBaseline'] + ':' + name).decode(), (ROOT / name).read_text()]), check=True)
    need(result.stdout == 'same', 'DATABASE_QUERY_CHANGED')
    need(c['databaseVerification'] == {'schemaChanged': False, 'sqlChanged': False, 'databaseStarted': False}, 'DATABASE_SCOPE_CHANGED')


def quality(c):
    commit = git('rev-parse', 'HEAD').decode().strip()
    raw = subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/runs?head_sha=' + commit + '&event=push'], cwd=ROOT)
    matches = [r for r in json.loads(raw)['workflow_runs'] if r['path'] == '.github/workflows/quality.yml'
               and r['head_branch'] == 'main' and r['head_sha'] == commit and r['conclusion'] == 'success']
    need(bool(matches), 'QUALITY_GATE_NOT_SUCCESSFUL')
    r = matches[0]
    return {'runId': str(r['id']), 'commit': commit, 'sourceTree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
            'path': r['path'], 'conclusion': 'success'}


def mysql_verification(c):
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and MYSQL_REPORT.is_file()
         and not MYSQL_REPORT.is_symlink(), 'ISOLATED_MYSQL_REPORT_MISSING')
    raw = MYSQL_REPORT.read_bytes()
    report = json.loads(raw)
    expected = c['isolatedMysqlTest']
    files = report.get('testResults', [])
    total = report.get('numTotalTests')
    need(report.get('success') is True and type(total) is int and total == expected['tests']
         and report.get('numPassedTests') == total
         and all(report.get(key) == 0 for key in ('numFailedTests', 'numPendingTests', 'numTodoTests',
                                                 'numFailedTestSuites', 'numPendingTestSuites'))
         and len(files) == 1 and Path(files[0]['name']).resolve() == (ROOT / expected['testFile']).resolve()
         and files[0].get('status') == 'passed' and len(files[0].get('assertionResults', [])) == total
         and all(item.get('status') == 'passed' for item in files[0]['assertionResults']), 'ISOLATED_MYSQL_TESTS_NOT_PASSED')
    value = {'version': 1, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
             'commit': os.environ['GITHUB_SHA'], 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'database': expected['database'], 'testFile': expected['testFile'],
             'testFileSha256': digest((ROOT / expected['testFile']).read_bytes()),
             'reportSha256': digest(raw), 'testsTotal': total, 'testsPassed': total, 'testsSkipped': 0,
             'testsTodo': 0, 'productionActions': 0, 'browserRequests': 0}
    load('recharge-checkout-release.py').verify_mysql_verification(value, value, c)
    return value


def prepare_published_admin(c):
    pin = c['publishedAdminRecipe']
    need(pin['buildFile'] in ('registration-protocol-repair-build.py', 'registration-flow-v4-build.py')
         and pin['contractFile'] == pin['buildFile'].replace('-build.py', '-contract.json')
         and pin['releaseFile'] == pin['buildFile'].replace('-build.py', '-release.py'), 'ADMIN_RECIPE_SELECTION_INVALID')
    for name, expected in pin['controlHashes'].items():
        need(digest(git('show', pin['commit'] + ':scripts/production-release/' + name)) == expected
             and digest((HERE / name).read_bytes()) == expected, 'PUBLISHED_ADMIN_RECIPE_CHANGED')
    published = load(pin['buildFile'])
    contract = json.loads(git('show', pin['commit'] + ':scripts/production-release/' + pin['contractFile']))
    history = OUTPUT / 'published-admin-history'
    extract = load('recharge-record-build.py').extract_source
    extract(git('archive', published.C8, 'scripts/production-release'), history)
    old_here = history / 'scripts/production-release'
    reconstruction = contract['reconstruction']
    need(digest((old_here / 'online-checkout-build.py').read_bytes()) == reconstruction['helperSha256']
         and digest((old_here / 'online-checkout-contract.json').read_bytes()) == reconstruction['contractSha256'],
         'PUBLISHED_ADMIN_HISTORY_CHANGED')
    old_recipe = json.loads((old_here / 'online-checkout-contract.json').read_bytes())
    successor = published.published_recipe(contract, 'successor', 'online-checkout-retest-contract.json')
    recharge = published.published_recipe(contract, 'publishedRecharge', 'online-unattended-contract.json')
    builder = published.load(old_here / 'online-checkout-build.py')
    builder.OUT = OUTPUT / 'published-admin-merge'
    builder.OUT.mkdir(mode=0o700)
    previous_git_dir = os.environ.get('GIT_DIR')
    os.environ['GIT_DIR'] = git('rev-parse', '--absolute-git-dir').decode().strip()
    try:
        context = OUTPUT / 'admin-baseline'
        builder.reconstruct(context, old_recipe, None)
        published.overlay_published_sources(context, 'baseline', contract, old_recipe, successor, recharge)
        published.overlay_runtime_worker(context, contract)
        published.overlay(context, {**contract['sources'], **contract['validationSources'],
                                   **contract['validationSupportSources']}, pin['commit'])
        need(digest((context / published.SCHEMA).read_bytes()) == contract['baseline']['schemaSha256'],
             'PUBLISHED_ADMIN_SCHEMA_CHANGED')
    finally:
        if previous_git_dir is None:
            os.environ.pop('GIT_DIR', None)
        else:
            os.environ['GIT_DIR'] = previous_git_dir


def prepare(c):
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    extract = load('recharge-record-build.py').extract_source
    prepare_published_admin(c)
    for role in ('api', 'admin'):
        raw = git('archive', c['apiSourceBaseline']) if role == 'api' else None
        for variant in ('baseline', 'candidate'):
            context = OUTPUT / (role + '-' + variant)
            if role == 'api':
                extract(raw, context)
            elif variant == 'candidate':
                shutil.copytree(OUTPUT / 'admin-baseline', context)
            for name, expected in c['buildInputs'][role].items():
                path = context / name
                need((digest(path.read_bytes()) if path.is_file() else None) == expected, 'PUBLISHED_BUILD_INPUT_CHANGED')
            if variant == 'candidate':
                for name in c['sources']:
                    if name.startswith('apps/' + role + '/') or name.startswith('packages/'):
                        path = context / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes((ROOT / name).read_bytes())
            run('npm', 'ci', '--no-audit', cwd=context)
            run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
            if role == 'api':
                run('npm', 'run', 'prisma:mysql:generate', '--workspace', '@apple-business/api', cwd=context)


def build(c, passed, isolated_mysql):
    for role in ('api', 'admin'):
        for variant in ('baseline', 'candidate'):
            build_id = c['baselineAdminBuildId'] if variant == 'baseline' else 'v2-' + os.environ['GITHUB_SHA']
            run('npm', 'run', 'build', '--workspace', '@apple-business/' + role,
                cwd=OUTPUT / (role + '-' + variant), env={**os.environ, 'NODE_ENV': c['adminNodeEnv'], 'V2_BUILD_ID': build_id})
    before = inventory(OUTPUT / 'api-baseline/apps/api/dist')
    after = inventory(OUTPUT / 'api-candidate/apps/api/dist')
    need(all(before.get(n) == v for n, v in c['apiBaselineFiles'].items()), 'BASE_API_NOT_REPRODUCED')
    allowed = load('recharge-availability-build.py').verify_api_outputs(before, after, c['apiModules'])
    admin_before = inventory(OUTPUT / 'admin-baseline/apps/admin/dist')
    need(admin_before == c['publicFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for name in allowed:
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUTPUT / 'api-candidate/apps/api/dist' / name, path)
    shutil.copytree(OUTPUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    proof = {'version': 1, 'scope': c['scope'], 'commit': os.environ['GITHUB_SHA'],
        'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
        'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'contractSha256': digest(CONTRACT.read_bytes()),
        'baselineApiReproduced': True, 'baselineAdminReproduced': True,
        'baselinePublishedVerified': {'apiSource': c['apiSourceBaseline'], 'adminSource': c['adminSourceBaseline'], 'verified': True},
        'qualityVerification': passed, 'databaseVerification': c['databaseVerification'],
        'isolatedMysqlVerification': isolated_mysql,
        'files': inventory(payload), 'apiModules': {n: after[n] for n in sorted(allowed)},
        'adminFiles': inventory(payload / 'admin/html'), 'updatedServices': ['api', 'admin'],
        'migrationPerformed': False, 'businessActions': 0}
    for field, name in [('controllerSha256', 'recharge-checkout-release.py'),
                        ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        proof[field] = digest((HERE / name).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    with tarfile.open(OUTPUT / 'recharge-checkout-artifact.tar.gz', 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest((OUTPUT / 'recharge-checkout-artifact.tar.gz').read_bytes()) + '\n')
    print(json.dumps({'status': 'CHECKOUT_ARTIFACT_BUILT', 'apiFiles': len(allowed),
                     'adminFiles': len(proof['adminFiles']), 'migrationPerformed': False, 'businessActions': 0}))


if __name__ == '__main__':
    c = json.loads(CONTRACT.read_bytes())
    verify_sources(c)
    passed = quality(c)
    isolated_mysql = mysql_verification(c)
    prepare(c)
    build(c, passed, isolated_mysql)
