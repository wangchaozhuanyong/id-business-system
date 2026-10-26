"""Reproduce the latest published mailbox contexts; overlay only reviewed login files."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(c, plan, quality, parent, out):
    p, h = load('online-session-diagnostic-release.py'), load('recharge-record-release.py')
    recipe = load('mail-query-build.py')
    contexts = {}

    def capture_recipe(module):
        if hasattr(module, 'overlay'):
            original = module.overlay

            def overlay(*args, **kwargs):
                result = original(*args, **kwargs)
                contexts.update(kwargs)
                return result

            module.overlay = overlay
        original_load = module.load

        def capture(path):
            child = original_load(path)
            return capture_recipe(child) if Path(path).name == 'mail-query-build.py' else child

        module.load = capture
        return module

    capture_recipe(recipe)
    published = recipe.build({'commit': p.CURRENT}, out / 'published-parent')
    p.need(published['adminFiles'] == c['baselineAdminFiles'], 'ADMIN_BASE_NOT_REPRODUCED')
    api, admin = contexts['api_context'], contexts['admin_context']
    dist = api / 'apps/api/dist'
    before = h.file_inventory(dist)
    expected = {'id-business-v2/online-recharge/' + n: v for n, v in c['beforeApiOnlineFiles'].items()}
    comparison = {n: {'expected': v, 'actual': before.get(n)} for n, v in expected.items()}
    (out / 'api-parent-reproduction.json').write_text(json.dumps(comparison, sort_keys=True, indent=2) + '\n')
    p.need(all(before.get(n) == v for n, v in expected.items()), 'API_BASE_NOT_REPRODUCED')
    for name in c['sources']:
        if not name.startswith(('apps/admin/', 'apps/api/')) or name.startswith(p.ENGINE) or '.spec.' in name:
            continue
        context = admin if name.startswith('apps/admin/') else api
        target = context / name
        original = subprocess.check_output(['git', 'show', p.CURRENT + ':' + name], cwd=ROOT)
        p.need(target.read_bytes() == original, 'UNPUBLISHED_SOURCE_DIFFERENCE')
        target.write_bytes((ROOT / name).read_bytes())
    env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + plan['commit']}
    for context, role in ((api, 'api'), (admin, 'admin')):
        subprocess.run(['npm', 'run', 'build', '--workspace', 'apps/' + role], cwd=context, env=env, check=True)
    after = h.file_inventory(dist)
    changed = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)}
    p.need(set(after) == set(before) and changed <= set(expected) | {'tsconfig.build.tsbuildinfo'}, 'API_COMPILED_SCOPE_CHANGED')
    payload = out / 'payload'
    for name in expected:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dist / name, target)
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    for name, digest in c['sources'].items():
        p.need(p.sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    for name, digest in c['afterEngineFiles'].items():
        if c['beforeEngineFiles'][name] != digest:
            target = payload / 'engine' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / p.ENGINE / name, target)
    proof = {**plan, 'version': 1, 'scope': p.SCOPE, 'sources': c['sources'],
             'afterEngineFiles': c['afterEngineFiles'], 'qualitySourceEvidence': quality,
             'nativeParentCapture': parent, 'baselineApiReproduced': True,
             'baselineAdminSourceReproduced': True, 'baselineAdminFiles': published['adminFiles'],
             'apiModules': {n: after[n] for n in expected},
             'adminFiles': h.file_inventory(admin / 'apps/admin/dist'),
             'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, {**plan, 'qualitySourceEvidence': quality, 'nativeParentCapture': parent}, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (p.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_SESSION_DIAGNOSTIC_BUILT', 'businessActions': 0}))
