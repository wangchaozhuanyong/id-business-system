"""Reproduce published 055b API, then compile only the legacy closure delta."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-legacy-close'
CONTRACT_FILE = 'online-legacy-close-contract.json'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_LEGACY_CLOSE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def reconstruct(context, contract):
    raw = (HERE / 'online-unattended-contract.json').read_bytes()
    need(sha(raw) == contract['predecessorRecipeSha256'], 'PREDECESSOR_RECIPE_CHANGED')
    old = json.loads(raw)
    builder = load('online-unattended-build.py').configure(load('online-checkout-build.py'))
    builder.OUT = OUT
    builder.reconstruct(context, old, None)
    for name, expected in old['sources'].items():
        raw = git('show', contract['expectedCurrent'] + ':' + name)
        need(sha(raw) == expected, 'PUBLISHED_SOURCE_CHANGED')
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    inventory = load('recharge-record-release.py').file_inventory
    need(inventory(context / contract['engineRoot']) == contract['engineFiles'],
         'PUBLISHED_ENGINE_CHANGED')


def database_evidence(results, contract):
    need(results.get('success') is True and results.get('numFailedTests') == 0
         and results.get('numPendingTests') == 0
         and results.get('numPassedTests', 0) >= contract['minimumDatabaseTests'],
         'DATABASE_TESTS_FAILED')
    assertions = [row for suite in results.get('testResults', [])
                  for row in suite.get('assertionResults', [])]
    specific = [row for row in assertions
                if contract['databaseTestMarker'] in row.get('fullName', '')]
    need(len(specific) >= contract['minimumClosureDatabaseTests']
         and all(row.get('status') == 'passed' for row in specific),
         'CLOSURE_DATABASE_TESTS_MISSING')
    return {'isolated': True, 'suite': 'mysql.integration.spec.ts',
            'passed': results['numPassedTests'], 'closureTestsPassed': len(specific)}


def main():
    raw_contract = (HERE / CONTRACT_FILE).read_bytes()
    c = json.loads(raw_contract)
    load('online-legacy-close-release.py').validate_contract(c)
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUT.exists(), 'NATIVE_BUILD_REQUIRED')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    changes = set(git('diff', '--name-only', c['reviewBase'], c['sourceReviewCommit'],
                      '--', 'apps/', 'docs/').decode().splitlines())
    need(changes == set(c['sources']), 'REVIEW_SCOPE_CHANGED')
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected
             == sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'SOURCE_CHANGED')
    OUT.mkdir(parents=True, mode=0o700)
    os.environ['GIT_DIR'] = git('rev-parse', '--absolute-git-dir').decode().strip()
    from urllib.parse import urlsplit
    database = urlsplit(os.environ.get('DATABASE_URL', ''))
    need(database.hostname in ('127.0.0.1', 'localhost')
         and database.path == '/id_business_v2_online_recharge_fixture', 'ISOLATED_DATABASE_REQUIRED')
    inventory = load('recharge-record-release.py').file_inventory
    for role in ('baseline', 'candidate'):
        context = OUT / role
        reconstruct(context, c)
        if role == 'candidate':
            for name in c['sources']:
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
        for command in [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                        ('npm', 'run', 'prisma:mysql:generate'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/api')]:
            run(*command, cwd=context)
        if role == 'candidate':
            run('npm', 'run', 'typecheck', '--workspace', '@apple-business/api', cwd=context)
            run('npm', 'run', 'test', '--workspace', '@apple-business/api', '--',
                'src/id-business-v2/online-recharge/persistence/tasks.manual-closure.spec.ts', cwd=context)
            run('npm', 'run', 'prisma:mysql:migrate:deploy', cwd=context)
            run('npm', 'run', 'test', '--workspace', '@apple-business/api', '--',
                'src/id-business-v2/online-recharge/mysql.integration.spec.ts',
                '--reporter=json', '--outputFile=' + str(OUT / 'mysql-results.json'),
                cwd=context, env={**os.environ, 'ONLINE_RECHARGE_MYSQL_TEST': '1'})
    before = inventory(OUT / 'baseline/apps/api/dist')
    after = inventory(OUT / 'candidate/apps/api/dist')
    need(all(before.get(n) == value for n, value in c['beforeApiOnlineFiles'].items()),
         'BASE_API_NOT_REPRODUCED')
    modules = load('online-checkout-build.py').module_delta(before, after, c['apiModules'])
    payload = OUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'candidate/apps/api/dist' / name, target)
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {'version': 1, 'scope': c['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': sha(raw_contract),
             'controlSources': {n: sha((HERE / n).read_bytes()) for n in c['controlFiles']},
             'sources': c['sources'], 'apiModules': modules, 'files': inventory(payload),
             'baselineApiReproduced': True, 'preservedAdminFiles': c['publicFiles'],
             'preservedEngineFiles': c['engineFiles'],
             'databaseVerification': database_evidence(json.loads((OUT / 'mysql-results.json').read_bytes()), c),
             'updatedServices': ['api'], 'dependentServiceRebound': 'online-recharge',
             'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    archive = OUT / 'online-legacy-close-artifact.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        bundle.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(archive.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_LEGACY_CLOSE_NATIVE_BUILT', 'apiFiles': len(modules),
                      'databaseVerification': proof['databaseVerification'], 'businessActions': 0}))


if __name__ == '__main__':
    main()
