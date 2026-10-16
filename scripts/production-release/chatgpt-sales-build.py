"""Native finite sale-management build, over the published API and Admin sources."""
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
OUTPUT = ROOT / '.deploy/chatgpt-sales-release'
CONTRACT = HERE / 'chatgpt-sales-contract.json'


def need(value, code):
    if not value:
        raise RuntimeError('CHATGPT_SALES_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('sales_' + name.replace('-', '_'), HERE / name)
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
    need(c['scope'] == 'CHATGPT_ACCOUNT_SALES_20261016', 'SCOPE_CHANGED')
    need(c['sources'] and all(digest((ROOT / n).read_bytes()) == v for n, v in c['sources'].items()), 'SOURCE_CHANGED')
    need(all(n.startswith(('apps/admin/src/v2/features/', 'apps/api/src/id-business-v2/auto-recharge/'))
             or n in ('apps/api/prisma-mysql/schema.prisma', c['migration']['path']) for n in c['sources']), 'SOURCE_PATH_INVALID')
    for role in ('api', 'admin'):
        before = c[role + 'SourceBaseline']
        need(git('rev-parse', before + '^{tree}').decode().strip() == c[role + 'SourceBaselineTree'], 'BASE_TREE_CHANGED')
        for n, expected in c['buildInputs'][role].items():
            existing = bool(git('ls-tree', before, '--', n).strip())
            need((digest(git('show', before + ':' + n)) if existing else None) == expected, 'BUILD_INPUT_CHANGED')
            need(git('ls-tree', 'HEAD', '--', n) == git('ls-tree', c['reviewBase'], '--', n), 'DEPENDENCY_CHANGED')
    need(git('show', c['apiSourceBaseline'] + ':apps/api/prisma-mysql/schema.prisma')
         == git('show', c['reviewBase'] + ':apps/api/prisma-mysql/schema.prisma'), 'SCHEMA_BASE_CHANGED')
    need(digest((ROOT / c['migration']['path']).read_bytes()) == c['migration']['sha256'], 'MIGRATION_CHANGED')


def quality():
    commit = git('rev-parse', 'HEAD').decode().strip()
    raw = subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/runs?head_sha=' + commit + '&event=push'], cwd=ROOT)
    rows = [r for r in json.loads(raw)['workflow_runs'] if r['path'] == '.github/workflows/quality.yml'
            and r['head_branch'] == 'main' and r['head_sha'] == commit and r['conclusion'] == 'success']
    need(bool(rows), 'QUALITY_GATE_NOT_SUCCESSFUL')
    return {'runId': str(rows[0]['id']), 'commit': commit, 'sourceTree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
            'path': rows[0]['path'], 'conclusion': 'success'}


def prepare(c):
    need(os.environ.get('GITHUB_ACTIONS') == 'true', 'REMOTE_VALIDATION_ONLY')
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    extract = load('recharge-record-build.py').extract_source
    for role in ('api', 'admin'):
        raw = git('archive', c[role + 'SourceBaseline'])
        for variant in ('baseline', 'candidate'):
            context = OUTPUT / (role + '-' + variant)
            extract(raw, context)
            if variant == 'candidate':
                for n in c['sources']:
                    if n.startswith('apps/' + role + '/'):
                        path = context / n
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes((ROOT / n).read_bytes())
                for n in ('scripts/acceptance-v2-chatgpt-account-sales.mjs',):
                    (context / n).write_bytes((ROOT / n).read_bytes())
            run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
            run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
            if role == 'api':
                run('npm', 'run', 'prisma:mysql:generate', '--workspace', '@apple-business/api', cwd=context)
            run('npm', 'run', 'build', '--workspace', '@apple-business/' + role, cwd=context,
                env={**os.environ, 'NODE_ENV': c['adminNodeEnv'], 'V2_BUILD_ID': c['baselineAdminBuildId'] if variant == 'baseline' else 'v2-' + os.environ['GITHUB_SHA']})


def api_delta(before, after, names):
    allowed = {n.removesuffix('.js') + ext for n in names for ext in ('.js', '.js.map', '.d.ts')}
    changed = {n for n in set(before) | set(after) if before.get(n) != after.get(n)}
    need(changed <= allowed and all(n in after for n in allowed), 'API_OUTPUT_SCOPE_CHANGED')
    need(any(before.get(n) != after.get(n) for n in names), 'API_DELTA_EMPTY')
    return allowed


def package(c):
    passed = quality()
    database = json.loads((OUTPUT / 'database-verification.json').read_bytes())
    browser = json.loads((OUTPUT / 'admin-candidate/.runtime/chatgpt-sale-status-20261016/browser/result.json').read_bytes())
    need(database == {'isolated': True, 'migration': c['migration']['name'], 'legacyDefaultsVerified': True,
                      'testsPassed': 5, 'testsSkipped': 0, 'businessActions': 0}, 'DATABASE_VERIFICATION_FAILED')
    need(browser.get('status') == 'PASS' and browser.get('realWrites') == 0, 'BROWSER_VERIFICATION_FAILED')
    before = inventory(OUTPUT / 'api-baseline/apps/api/dist')
    after = inventory(OUTPUT / 'api-candidate/apps/api/dist')
    allowed = api_delta(before, after, c['apiModules'])
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for n in allowed:
        p = payload / 'api/modules' / n
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUTPUT / 'api-candidate/apps/api/dist' / n, p)
    shutil.copytree(OUTPUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for n in c['sources']:
        p = payload / 'source' / n
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes((ROOT / n).read_bytes())
    proof = {'version': 1, 'scope': c['scope'], 'commit': os.environ['GITHUB_SHA'],
        'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
        'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'contractSha256': digest(CONTRACT.read_bytes()),
        'baselineApiFiles': {n: before.get(n) for n in sorted(allowed)},
        'baselineAdminFiles': inventory(OUTPUT / 'admin-baseline/apps/admin/dist'),
        'baselineSources': {'api': c['apiSourceBaseline'], 'admin': c['adminSourceBaseline']},
        'qualityVerification': passed, 'databaseVerification': database,
        'browserVerification': {'status': 'PASS', 'realWrites': 0},
        'files': inventory(payload), 'apiModules': {n: after[n] for n in sorted(allowed)},
        'adminFiles': inventory(payload / 'admin/html'), 'updatedServices': ['api', 'admin'],
        'migration': c['migration'], 'businessActions': 0}
    for field, n in [('controllerSha256', 'chatgpt-sales-release.py'), ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        proof[field] = digest((HERE / n).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    with tarfile.open(OUTPUT / 'chatgpt-sales-artifact.tar.gz', 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest((OUTPUT / 'chatgpt-sales-artifact.tar.gz').read_bytes()) + '\n')
    print(json.dumps({'status': 'CHATGPT_SALES_ARTIFACT_BUILT', 'apiFiles': len(allowed), 'databaseTestsPassed': 5, 'businessActions': 0}))


if __name__ == '__main__':
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    {'prepare': prepare, 'package': package}[sys.argv[1]](contract)
