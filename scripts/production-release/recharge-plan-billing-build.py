"""Rebuild the published source plus the reviewed billing delta on exact main."""
import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / '.deploy/recharge-plan-billing'
CONTRACT = HERE / 'recharge-plan-billing-contract.json'
PREFIX = 'recharge-plan-billing'


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_PLAN_BILLING_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    spec = importlib.util.spec_from_file_location('plan_billing_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def ensure_commit(commit):
    need(re.fullmatch('[a-f0-9]{40}', commit), 'IMMUTABLE_SOURCE_REQUIRED')
    probe = subprocess.run(['git', 'cat-file', '-e', commit + '^{commit}'], cwd=ROOT, capture_output=True)
    if probe.returncode:
        git('fetch', '--no-tags', '--no-write-fetch-head', '--depth=1', 'origin', commit)
    need(git('cat-file', '-t', commit).decode().strip() == 'commit', 'SOURCE_COMMIT_MISSING')


def inventory(path):
    return load('recharge-record-release.py').file_inventory(path)


def runtime_groups(files):
    groups = {}
    for name, value in sorted(files.items()):
        if name.endswith('.js'):
            group = '/'.join(name.split('/')[:2 if name.startswith('id-business-v2/') else 1])
            groups.setdefault(group, {})[name] = value
    return {name: fingerprint(values) for name, values in groups.items()}


def overlay(context, sources, commit):
    ensure_commit(commit)
    for name, expected in sources.items():
        need(name.startswith(('apps/', 'packages/')) and '..' not in Path(name).parts, 'SOURCE_PATH')
        raw = git('show', commit + ':' + name)
        need(sha(raw) == expected, 'SOURCE_HASH')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def check(c):
    need(c['scope'] == 'RECHARGE_PLAN_BILLING_20261026' and c['sourcePullRequest'] == 723, 'CONTRACT')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256'], 'DEPENDENCIES_CHANGED')
    ensure_commit(c['sourceReviewCommit'])
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected
             == sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'REVIEW_CHANGED')
    need(c['migration']['name'] == '20261026010000_recharge_billing_uniqueness'
         and c['migration']['sha256'] == c['sources'][c['migration']['path']], 'MIGRATION_SCOPE')


def reconstruct(c):
    api = OUT / 'api-baseline'
    with tarfile.open(fileobj=io.BytesIO(git('archive', 'f2b092ba034d18cfe4fbea6b997ffc46bfb6f99b'))) as archive:
        archive.extractall(api, filter='data')
    recipes = ['online-human-verification', 'online-unpaid-validation', 'online-checkout-resume',
               'online-card-read-diagnostics', 'online-proxy-failure-evidence',
               'online-profile-egress', 'online-country-evidence']
    for name in recipes:
        recipe = json.loads((HERE / (name + '-contract.json')).read_bytes())
        sources = recipe['productionSources'] if 'productionSources' in recipe else recipe['sources']
        overlay(api, {n: v for n, v in sources.items()
                      if n.startswith('apps/api/src/') and '/engine/' not in n}, recipe['sourceReviewCommit'])
    q = load('bitbrowser-quote-publication.py')
    q.OUT = OUT / 'admin-reconstruction'
    q.OUT.mkdir()
    recipe = json.loads((HERE / 'bitbrowser-quote-contract.json').read_bytes())
    admin, helper = q.reconstruct_parent(recipe)
    helper.overlay(admin, recipe['productionSources'], recipe['sourceReviewCommit'])
    for name in ['online-unpaid-validation', 'online-proxy-failure-evidence',
                 'online-profile-egress', 'online-country-evidence']:
        recipe = json.loads((HERE / (name + '-contract.json')).read_bytes())
        overlay(admin, {n: v for n, v in recipe['sources'].items() if n.startswith('apps/admin/')},
                recipe['sourceReviewCommit'])
    for role, context in [('api', api), ('admin', admin)]:
        for name in c['sources']:
            if name.startswith(('apps/' + role + '/', 'packages/shared/')):
                prior = subprocess.run(['git', 'show', c['reviewBase'] + ':' + name], cwd=ROOT, capture_output=True)
                if prior.returncode == 0:
                    need((context / name).read_bytes() == prior.stdout, 'UNPUBLISHED_INPUT')
    return api, admin


def compile(context, role, commit):
    env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + commit}
    commands = [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                ('npm', 'run', 'build', '--workspace', '@apple-business/shared')]
    if role == 'api':
        commands.append(('npm', 'run', 'prisma:mysql:generate'))
    commands.append(('npm', 'run', 'build', '--workspace', '@apple-business/' + role))
    for args in commands:
        subprocess.run(args, cwd=context, env=env, check=True)


def build():
    c = json.loads(CONTRACT.read_bytes())
    check(c)
    commit = git('rev-parse', 'HEAD').decode().strip()
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
         and os.environ.get('GITHUB_SHA') == commit and os.environ.get('RELEASE_COMMIT') == commit
         and git('ls-remote', 'origin', 'refs/heads/main').decode().split()[0] == commit, 'EXACT_MAIN_REQUIRED')
    need(not OUT.exists(), 'BUILD_ALREADY_ACCEPTED')
    OUT.mkdir(parents=True)
    api, admin = reconstruct(c)
    results = {}
    for role, before in [('api', api), ('admin', admin)]:
        candidate = OUT / (role + '-candidate')
        shutil.copytree(before, candidate)
        overlay(candidate, {n: v for n, v in c['sources'].items()
                            if n.startswith(('apps/' + role + '/', 'packages/shared/'))}, commit)
        compile(before, role, c['baselineAdminBuildCommit'])
        compile(candidate, role, commit)
        results[role] = (inventory(before / ('apps/' + role + '/dist')),
                         inventory(candidate / ('apps/' + role + '/dist')))
    before_api, after_api = results['api']
    before_admin, after_admin = results['admin']
    need(runtime_groups(before_api) == c['baseline']['apiGroups']['groups'], 'API_PARENT_NOT_REPRODUCED')
    need(fingerprint(before_admin) == c['baseline']['adminFilesSha256'], 'ADMIN_PARENT_NOT_REPRODUCED')
    selected = {n.removeprefix('apps/api/src/').removesuffix('.ts') + ext for n in c['sources']
                if n.startswith('apps/api/src/') and not n.endswith('.spec.ts')
                for ext in ('.js', '.js.map', '.d.ts')}
    delta = {n for n in set(before_api) | set(after_api) if before_api.get(n) != after_api.get(n)}
    need(not (set(before_api) - set(after_api))
         and all(n in selected or n.endswith('.d.ts') or n == 'tsconfig.build.tsbuildinfo' for n in delta),
         'UNSELECTED_API_OUTPUT')
    payload = OUT / 'payload'
    for name in selected:
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'api-candidate/apps/api/dist' / name, path)
    shutil.copytree(OUT / 'api-candidate/node_modules/.prisma/client', payload / 'api/prisma-client')
    shutil.copytree(OUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    controls = ['remote-deploy.py', 'recharge-record-release.py', 'recharge-availability-release.py',
                'recharge-source-recovery-release.py', 'recharge-billing-release.py', 'online-checkout-release.py',
                'online-profile-lock-recovery.py', 'proxy-result-identity-release.py', 'api-admin-scope.py',
                'recharge-plan-billing-release.py', 'recharge-plan-billing-contract.json']
    for name in controls:
        (payload / 'controls').mkdir(exist_ok=True)
        shutil.copyfile(HERE / name, payload / 'controls' / name)
    proof = {'version': 1, 'scope': c['scope'], 'commit': commit,
             'sourceLayout': 'PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAIN_BILLING_OVERLAY',
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': sha(CONTRACT.read_bytes()), 'sources': c['sources'],
             'baselineApiGroups': runtime_groups(before_api), 'baselineAdminFiles': before_admin,
             'apiModules': {n: after_api[n] for n in sorted(selected)}, 'adminFiles': after_admin,
             'prismaClientFiles': inventory(payload / 'api/prisma-client'),
             'controlSources': inventory(payload / 'controls'), 'files': inventory(payload),
             'migrationImage': os.environ['MIGRATION_IMAGE'], 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BILLING_MAIN_REBUILT', 'commit': commit, 'businessActions': 0}))


if __name__ == '__main__':
    build()
