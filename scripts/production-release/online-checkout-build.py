"""Reproduce the published GPT/shared-card source, then build this finite repair."""
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
OUT = ROOT / '.deploy/online-checkout'


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_CHECKOUT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def load(path):
    spec = importlib.util.spec_from_file_location('checkout_' + path.name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def reconstruct(context, contract, controls):
    recipe = json.loads((HERE / 'gpt-recharge-contract.json').read_bytes())
    shared = json.loads((HERE / 'shared-bank-card-contract.json').read_bytes())
    load(HERE / 'shared-bank-card-build.py').reconstruct(context, shared)
    for name, expected in shared['sources'].items():
        raw = git('show', contract['adminPublishedCommit'] + ':' + name)
        need(sha(raw) == expected, 'PUBLISHED_SHARED_SOURCE_CHANGED')
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    # Preserve the exact three-way merge used by the already published GPT build.
    for name, expected in recipe['sources'].items():
        raw = git('show', recipe['sourceReviewCommit'] + ':' + name)
        need(sha(raw) == expected, 'PUBLISHED_GPT_SOURCE_CHANGED')
        target = context / name
        prior = subprocess.run(['git', 'show', recipe['reviewBase'] + ':' + name], cwd=ROOT, capture_output=True)
        if prior.returncode == 0:
            base, after = OUT / 'merge-base', OUT / 'merge-after'
            base.write_bytes(prior.stdout)
            after.write_bytes(raw)
            run('git', 'merge-file', str(target), str(base), str(after))
        else:
            need(not target.exists(), 'SOURCE_COLLISION')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    for name, pin in contract['postGptSources'].items():
        raw = git('show', pin['commit'] + ':' + name)
        need(sha(raw) == pin['sha256'], 'POST_GPT_SOURCE_CHANGED')
        (context / name).write_bytes(raw)
    for name, pin in contract['postAdminSources'].items():
        raw = git('show', pin['commit'] + ':' + name)
        need(sha(raw) == pin['sha256'], 'PUBLISHED_ADMIN_SOURCE_CHANGED')
        (context / name).write_bytes(raw)
    overlay_engine(context, contract)


def overlay_engine(context, contract):
    # The API-only GPT publication deliberately retained the later sidecar role.
    # Bind every retained engine file to the independently read runtime hash.
    for name, expected in contract['beforeEngineFiles'].items():
        source = contract['engineRoot'] + '/' + name
        raw = git('show', contract['enginePublishedCommit'] + ':' + source)
        need(sha(raw) == expected, 'PUBLISHED_ENGINE_SOURCE_CHANGED')
        target = context / source
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def module_delta(before, after, allowed):
    changed = {n for n in before.keys() | after.keys()
               if n.endswith(('.js', '.js.map', '.d.ts')) and '/engine/' not in n and before.get(n) != after.get(n)}
    expected = {n.removesuffix('.js') + ext for n in allowed for ext in ('.js', '.js.map', '.d.ts')}
    need({n for n in changed if n.endswith('.js')} == set(allowed)
         and changed <= expected and expected <= after.keys(), 'COMPILED_SCOPE_CHANGED')
    return {n: after[n] for n in sorted(expected)}


def main():
    raw_contract = (HERE / 'online-checkout-contract.json').read_bytes()
    c = json.loads(raw_contract)
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUT.exists(), 'NATIVE_BUILD_REQUIRED')
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    changes = set(git('diff', '--name-only', c['reviewBase'], c['sourceReviewCommit'], '--', 'apps/', 'docs/').decode().splitlines())
    need(changes == set(c['sources']), 'REVIEW_SCOPE_CHANGED')
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected == sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'SOURCE_CHANGED')
    OUT.mkdir(parents=True, mode=0o700)
    os.environ['GIT_DIR'] = git('rev-parse', '--absolute-git-dir').decode().strip()
    helper = load(HERE / 'recharge-record-release.py')
    inventory = helper.file_inventory
    for role in ('baseline', 'candidate'):
        context = OUT / role
        reconstruct(context, c, None)
        if role == 'candidate':
            for name in c['sources']:
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
        env = {**os.environ, 'NODE_ENV': 'production',
               'V2_BUILD_ID': 'v2-' + (c['baselineAdminBuildCommit'] if role == 'baseline' else git('rev-parse', 'HEAD').decode().strip())}
        for command in [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                        ('npm', 'run', 'prisma:mysql:generate'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/api'),
                        ('npm', 'run', 'build', '--workspace', '@apple-business/admin')]:
            run(*command, cwd=context, env=env)
    before, after = OUT / 'baseline', OUT / 'candidate'
    before_api, after_api = inventory(before / 'apps/api/dist'), inventory(after / 'apps/api/dist')
    need(all(before_api.get('id-business-v2/online-recharge/' + n) == digest for n, digest in c['beforeApiOnlineFiles'].items()), 'BASE_API_NOT_REPRODUCED')
    before_admin = inventory(before / 'apps/admin/dist')
    need(helper.fingerprint(before_admin) == c['baselineAdminFilesSha256'], 'BASE_ADMIN_NOT_REPRODUCED')
    need(inventory(before / c['engineRoot']) == c['beforeEngineFiles'], 'BASE_ENGINE_NOT_REPRODUCED')
    modules = module_delta(before_api, after_api, c['apiModules'])
    payload = OUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(after / 'apps/api/dist' / name, target)
    shutil.copytree(after / 'apps/admin/dist', payload / 'admin/html')
    need(inventory(after / c['engineRoot']) == c['afterEngineFiles'], 'CANDIDATE_ENGINE_CHANGED')
    for name, digest in c['afterEngineFiles'].items():
        if c['beforeEngineFiles'].get(name) != digest:
            target = payload / 'engine' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(after / c['engineRoot'] / name, target)
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {'version': 1, 'scope': c['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': sha(raw_contract), 'controlSources': {n: sha((HERE / n).read_bytes()) for n in c['controlFiles']},
             'sources': c['sources'], 'apiModules': modules, 'baselineAdminFiles': before_admin,
             'adminFiles': inventory(payload / 'admin/html'), 'afterEngineFiles': c['afterEngineFiles'],
             'files': inventory(payload), 'baselineApiReproduced': True, 'baselineAdminSourceReproduced': True,
             'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'online-checkout-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_CHECKOUT_NATIVE_BUILT', 'apiModules': len(modules), 'businessActions': 0}))


if __name__ == '__main__':
    main()
