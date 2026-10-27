"""Reproduce the published three-service lineage and apply the reviewed diagnostic repair."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(path):
    path = Path(path)
    if not path.is_absolute():
        path = HERE / path
    spec = importlib.util.spec_from_file_location('checkout_read_build_' + path.name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def observe_build(run, contexts, build_id):
    def capture(command, *args, **kwargs):
        result = run(command, *args, **kwargs)
        # Historical recipes may explicitly inherit the process environment.
        if (kwargs.get('env') or {}).get('V2_BUILD_ID') == build_id:
            for role in ('api', 'admin'):
                if command == ['npm', 'run', 'build', '--workspace', 'apps/' + role]:
                    contexts[role] = Path(kwargs['cwd'])
        return result
    return capture


def overlay_sources(c, contexts):
    load('recharge-autofill-build.py').overlay_sources(c, contexts, load('online-checkout-read-release.py').CURRENT)


def build(c, plan, quality, parent, out):
    p, h = load('online-checkout-read-release.py'), load('recharge-record-release.py')
    p.validate_contract(c)
    p.need(out.is_dir() and not (out / 'payload').exists(), 'OUTPUT_EXISTS')
    binding = c['reproductionArtifact']
    with urllib.request.urlopen(binding['artifactUrl'], timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    p.need(0 < len(raw) <= 24 * 1024**2 and p.sha(raw) == binding['artifactSha256'], 'PARENT_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    p.need(p.sha(proof_raw) == binding['buildProofSha256'], 'PARENT_PROOF_CHANGED')
    published = json.loads(proof_raw)
    p.need(published['commit'] == binding['commit'] and published['workflowRunId'] == binding['workflowRunId'], 'PARENT_IDENTITY')
    # Historical builders read their own ROOT. Load from the immutable published
    # tree so current diagnostic edits cannot leak into parent reproduction.
    source_root = ROOT / '.codex-worktrees' / ('checkout-read-parent-' + plan['workflowRunId'])
    source_root.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', 'worktree', 'add', '--detach', str(source_root), binding['commit']], cwd=ROOT, check=True)
    historical = source_root / 'scripts/production-release'
    for name in ('online-subscription-body-build.py', 'online-subscription-body-contract.json'):
        p.need(p.sha((historical / name).read_bytes()) == c['controlPins'][name], 'HISTORICAL_RECIPE_CHANGED')
    recipe = load(historical / 'online-subscription-body-build.py')
    parent_contract = json.loads((historical / 'online-subscription-body-contract.json').read_bytes())
    contexts = {}
    original_run = subprocess.run
    subprocess.run = observe_build(original_run, contexts, 'v2-' + binding['commit'])
    try:
        reproduced_out = out / 'published-parent'
        reproduced_out.mkdir()
        recipe.build(parent_contract, published, published['qualitySourceEvidence'],
                     published['nativeParentCapture'], reproduced_out)
    finally:
        subprocess.run = original_run
    reproduced = json.loads((reproduced_out / 'payload/build-proof.json').read_bytes())
    p.need(set(contexts) == {'api', 'admin'} and reproduced['adminFiles'] == published['adminFiles'] == c['baselineAdminFiles']
           and reproduced['afterEngineFiles'] == published['afterEngineFiles'], 'PARENT_NOT_REPRODUCED')
    before_api = h.file_inventory(contexts['api'] / 'apps/api/dist')
    p.need(all(before_api.get(n) == v for n, v in c['beforeApiModules'].items()), 'API_PARENT_NOT_REPRODUCED')
    overlay_sources(c, contexts)
    env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + plan['commit']}
    for role in ('api', 'admin'):
        subprocess.run(['npm', 'run', 'build', '--workspace', 'apps/' + role], cwd=contexts[role], env=env, check=True)
    after_api = h.file_inventory(contexts['api'] / 'apps/api/dist')
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    changed = {n for n in before_api.keys() | after_api.keys() if before_api.get(n) != after_api.get(n)}
    (out / 'api-compiled-delta.json').write_text(json.dumps(sorted(changed), indent=2) + '\n')
    p.need(set(before_api) <= set(after_api) and set(after_api) - set(before_api) == {n.removesuffix('.js') + ext for n in c['newApiModules'] for ext in ('.js', '.js.map', '.d.ts')} and changed <= selected | {'tsconfig.build.tsbuildinfo'}, 'API_COMPILED_SCOPE_CHANGED')
    payload = out / 'payload'
    for name in sorted(selected):
        destination = payload / 'api/modules' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(contexts['api'] / 'apps/api/dist' / name, destination)
    shutil.copytree(contexts['admin'] / 'apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        destination = payload / 'source' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    for name, digest in c['afterEngineFiles'].items():
        if c['beforeEngineFiles'].get(name) == digest:
            continue
        destination = payload / 'engine' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        p.need(p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest, 'ENGINE_SOURCE_CHANGED')
        shutil.copyfile(ROOT / p.ENGINE / name, destination)
    proof = {**plan, 'version': 1, 'scope': p.SCOPE, 'sources': c['sources'],
             'qualitySourceEvidence': quality, 'nativeParentCapture': parent,
             'baselineApiReproduced': True, 'baselineAdminSourceReproduced': True,
             'baselineAdminFiles': c['baselineAdminFiles'], 'afterEngineFiles': c['afterEngineFiles'],
             'apiModules': {n: after_api[n] for n in sorted(selected)},
             'adminFiles': h.file_inventory(contexts['admin'] / 'apps/admin/dist'),
             'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, {**plan, 'qualitySourceEvidence': quality, 'nativeParentCapture': parent}, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (p.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_CHECKOUT_READ_BUILT', 'businessActions': 0}))
