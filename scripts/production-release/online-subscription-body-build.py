"""Reproduce the last published autofill tree and apply only the reviewed read repair."""
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
    spec = importlib.util.spec_from_file_location('subscription_build_' + path.name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def overlay_sources(c, contexts):
    p = load('online-subscription-body-release.py')
    for name, digest in c['sources'].items():
        raw = (ROOT / name).read_bytes()
        p.need(p.sha(raw) == digest, 'SOURCE_CHANGED')
        if '.spec.' in name or not name.startswith(('apps/admin/', 'apps/api/')) or name.startswith(p.ENGINE):
            continue
        role = 'admin' if name.startswith('apps/admin/') else 'api'
        destination = contexts[role] / name
        before = subprocess.check_output(['git', 'show', p.CURRENT + ':' + name], cwd=ROOT)
        p.need(destination.is_file() and destination.read_bytes() == before, 'UNPUBLISHED_SOURCE_DIFFERENCE')
        destination.write_bytes(raw)


def build(c, plan, quality, parent, out):
    p, h = load('online-subscription-body-release.py'), load('recharge-record-release.py')
    p.validate_contract(c)
    p.need(out.is_dir() and not (out / 'payload').exists(), 'OUTPUT_EXISTS')
    binding = c['parentArtifact']
    expected = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/recharge-autofill-' + p.CURRENT + '/recharge-autofill-artifact.tar.gz'
    p.need(binding['url'] == expected, 'PARENT_ARTIFACT_LOCATION')
    with urllib.request.urlopen(expected, timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    p.need(0 < len(raw) <= 24 * 1024**2 and p.sha(raw) == binding['sha256'], 'PARENT_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    p.need(p.sha(proof_raw) == binding['buildProofSha256'], 'PARENT_PROOF_CHANGED')
    published = json.loads(proof_raw)
    p.need(published['commit'] == p.CURRENT and published['workflowRunId'] == binding['workflowRunId'], 'PARENT_IDENTITY')
    source_root = out / 'published-source'
    subprocess.run(['git', 'worktree', 'add', '--detach', str(source_root), p.CURRENT], cwd=ROOT, check=True)
    recipe = load(source_root / 'scripts/production-release/recharge-autofill-build.py')
    parent_contract_raw = (source_root / 'scripts/production-release/recharge-autofill-contract.json').read_bytes()
    p.need(p.sha(parent_contract_raw) == c['parentContractSha256'], 'PARENT_CONTRACT_CHANGED')
    parent_contract = json.loads(parent_contract_raw)
    contexts = {}
    original_run = subprocess.run

    def capture(command, *args, **kwargs):
        result = original_run(command, *args, **kwargs)
        if kwargs.get('env', {}).get('V2_BUILD_ID') == 'v2-' + p.CURRENT:
            for role in ('api', 'admin'):
                if command == ['npm', 'run', 'build', '--workspace', 'apps/' + role]:
                    contexts[role] = Path(kwargs['cwd'])
        return result

    subprocess.run = capture
    try:
        reproduced_out = out / 'published-parent'
        reproduced_out.mkdir()
        recipe.build(parent_contract, published, published['qualitySourceEvidence'],
                     published['nativeParentCapture'], reproduced_out)
    finally:
        subprocess.run = original_run
    reproduced = json.loads((reproduced_out / 'payload/build-proof.json').read_bytes())
    p.need(set(contexts) == {'api', 'admin'} and reproduced['adminFiles'] == published['adminFiles'] == c['baselineAdminFiles']
           and reproduced['afterEngineFiles'] == c['beforeEngineFiles'], 'PARENT_NOT_REPRODUCED')
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
    p.need(set(before_api) == set(after_api) and changed <= selected | {'tsconfig.build.tsbuildinfo'}, 'API_COMPILED_SCOPE_CHANGED')
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
    print(json.dumps({'status': 'ONLINE_SUBSCRIPTION_BODY_BUILT', 'businessActions': 0}))
