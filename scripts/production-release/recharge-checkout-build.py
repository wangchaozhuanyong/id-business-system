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
    need(c['scope'] == 'BIT_RECHARGE_NATIVE_CHECKOUT_20261016', 'SCOPE_CHANGED')
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


def prepare(c):
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    extract = load('recharge-record-build.py').extract_source
    for role in ('api', 'admin'):
        raw = git('archive', c[role + 'SourceBaseline'])
        for variant in ('baseline', 'candidate'):
            context = OUTPUT / (role + '-' + variant)
            extract(raw, context)
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


def build(c, passed):
    for role in ('api', 'admin'):
        for variant in ('baseline', 'candidate'):
            build_id = c['baselineAdminBuildId'] if variant == 'baseline' else 'v2-' + os.environ['GITHUB_SHA']
            run('npm', 'run', 'build', '--workspace', '@apple-business/' + role,
                cwd=OUTPUT / (role + '-' + variant), env={**os.environ, 'NODE_ENV': c['adminNodeEnv'], 'V2_BUILD_ID': build_id})
    before = inventory(OUTPUT / 'api-baseline/apps/api/dist')
    after = inventory(OUTPUT / 'api-candidate/apps/api/dist')
    need(all(before.get(n) == v for n, v in c['apiModules'].items()), 'BASE_API_NOT_REPRODUCED')
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
    prepare(c)
    build(c, passed)
