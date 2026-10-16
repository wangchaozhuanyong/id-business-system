"""Reproduce the published three-role baseline, then build only online settings changes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/online-settings-release'


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_SETTINGS_' + code)


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


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def module_delta(before, after, allowed, declaration_only=None):
    declarations = declaration_only or {}
    need(all(name.startswith('id-business-v2/online-recharge/') and name.endswith('.d.ts')
             and '..' not in Path(name).parts and re.fullmatch('[a-f0-9]{64}', digest)
             and after.get(name) == digest for name, digest in declarations.items()), 'DECLARATION_DELTA_CHANGED')
    changed = {name for name in set(before) | set(after) if before.get(name) != after.get(name)}
    expected = {name.removesuffix('.js') + ext for name in allowed for ext in ('.js', '.js.map', '.d.ts')} | set(declarations)
    need({name for name in changed if name.endswith('.js')} == set(allowed)
         and changed <= expected and expected <= set(after), 'API_DELTA_CHANGED')
    return {name: after[name] for name in sorted(expected)}


def verify_source_review(c):
    reviewed = c['sourceReviewCommit']
    need(re.fullmatch('[a-f0-9]{40}', reviewed), 'SOURCE_REVIEW_INVALID')
    git('merge-base', '--is-ancestor', reviewed, 'HEAD')
    need(set(git('diff', '--name-only', c['reviewBase'], reviewed, '--', 'apps/', 'packages/').decode().splitlines()) == set(c['sources']), 'SOURCE_SCOPE_CHANGED')
    for name, expected in c['sources'].items():
        need(sha(git('show', reviewed + ':' + name)) == expected, 'REVIEWED_SOURCE_CHANGED')


def published_overlays(context, c):
    for overlay in c['publishedOverlays']:
        need(re.fullmatch('[a-f0-9]{40}', overlay['commit']), 'PUBLISHED_OVERLAY_INVALID')
        for name, expected in {**overlay['sources'], **overlay['validationSources']}.items():
            need(name.startswith(('apps/', 'packages/', 'scripts/')) and '..' not in Path(name).parts, 'PUBLISHED_SOURCE_PATH_INVALID')
            raw = git('show', overlay['commit'] + ':' + name)
            need(sha(raw) == expected, 'PUBLISHED_OVERLAY_SOURCE_CHANGED')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)


def main():
    contract_raw = (HERE / 'online-settings-contract.json').read_bytes()
    c = json.loads(contract_raw)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    # Other work may enter main while this finite publication is validated. It is
    # never overlaid: only these immutable reviewed bytes may enter the payload.
    verify_source_review(c)
    for name, expected in c['sources'].items():
        need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    need(sha((HERE / 'registration-parity-diagnostics-build.py').read_bytes()) == c['reconstructionHelperSha256']
         and sha((HERE / 'registration-parity-diagnostics-contract.json').read_bytes()) == c['reconstructionContractSha256'], 'PUBLISHED_RECIPE_CHANGED')
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    recipe = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())
    builder = load('registration-parity-diagnostics-build.py')
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        builder.reconstruct(context, recipe)
        # These exact sources were already independently published by the predecessor.
        for name, expected in recipe['sources'].items():
            raw = git('show', c['reconstructionBaseCommit'] + ':' + name)
            need(sha(raw) == expected, 'PUBLISHED_PREDECESSOR_SOURCE_CHANGED')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        published_overlays(context, c)
        need(inventory(context / c['engineRoot']) == c['beforeEngineFiles'], 'ENGINE_BASELINE_CHANGED')
        if role == 'candidate':
            for name, expected in c['sources'].items():
                raw = (ROOT / name).read_bytes()
                need(sha(raw) == expected, 'SOURCE_CHANGED')
                target = context / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
        run('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', '@apple-business/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (c['expectedCurrent'] if role == 'baseline' else git('rev-parse', 'HEAD').decode().strip())})
    before, after = OUTPUT / 'baseline', OUTPUT / 'candidate'
    baseline_api, candidate_api = inventory(before / 'apps/api/dist'), inventory(after / 'apps/api/dist')
    baseline_admin = inventory(before / 'apps/admin/dist')
    need(sha(json.dumps(baseline_admin, sort_keys=True, separators=(',', ':')).encode()) == c['baselineAdminFilesSha256'], 'ADMIN_BASELINE_NOT_REPRODUCED')
    prefix = 'id-business-v2/online-recharge/'
    observed = {name.removeprefix(prefix): value for name, value in baseline_api.items() if name.startswith(prefix) and name.endswith('.js') and '/engine/' not in name}
    need(observed == c['beforeApiOnlineFiles'], 'API_BASELINE_NOT_REPRODUCED')
    # The sidecar has its own verified source overlay. API image publication
    # never copies worker assets or the sidecar source bundled by Nest assets.
    api_files = lambda files: {name: value for name, value in files.items()
        if name.endswith(('.js', '.js.map', '.d.ts')) and '/engine/' not in name}
    modules = module_delta(api_files(baseline_api), api_files(candidate_api), c['apiModules'], c['apiDeclarationOnly'])
    payload = OUTPUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(after / 'apps/api/dist' / name, target)
    shutil.copytree(after / 'apps/admin/dist', payload / 'admin/html')
    after_engine = inventory(after / c['engineRoot'])
    need(after_engine == c['afterEngineFiles'], 'CANDIDATE_ENGINE_CHANGED')
    for name, value in after_engine.items():
        if c['beforeEngineFiles'].get(name) != value:
            target = payload / 'engine' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(after / c['engineRoot'] / name, target)
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    controls = {name: sha((HERE / name).read_bytes()) for name in c['controlFiles']}
    proof = {'version': 1, 'scope': c['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'contractSha256': sha(contract_raw),
             'controlSources': controls, 'sources': c['sources'], 'apiModules': modules,
             'baselineAdminFiles': baseline_admin, 'adminFiles': inventory(payload / 'admin/html'),
             'afterEngineFiles': after_engine, 'files': inventory(payload), 'baselineApiReproduced': True,
             'baselineAdminSourceReproduced': True, 'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'online-settings-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_SETTINGS_NATIVE_ARTIFACT_BUILT', 'apiModules': len(c['apiModules']), 'engineDelta': len(list((payload / 'engine').rglob('*'))), 'businessActions': 0}))


if __name__ == '__main__':
    main()
