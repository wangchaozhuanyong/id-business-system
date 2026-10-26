"""Reproduce the published API/Admin inputs and apply only the reviewed autofill delta."""
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


def load(name):
    spec = importlib.util.spec_from_file_location('autofill_build_' + Path(name).name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def overlay_sources(c, contexts, current):
    p = load('recharge-autofill-release.py')
    for name, digest in c['sources'].items():
        raw = (ROOT / name).read_bytes()
        p.need(p.sha(raw) == digest, 'SOURCE_CHANGED')
        if '.spec.' in name or not name.startswith(('apps/admin/', 'apps/api/')) or name.startswith(p.ENGINE):
            continue
        role = 'admin' if name.startswith('apps/admin/') else 'api'
        destination = contexts[role] / name
        before = subprocess.run(['git', 'show', current + ':' + name], cwd=ROOT, capture_output=True)
        if before.returncode == 0:
            p.need(destination.is_file() and destination.read_bytes() == before.stdout, 'UNPUBLISHED_SOURCE_DIFFERENCE')
        else:
            p.need(not destination.exists(), 'UNREVIEWED_SOURCE_EXISTS')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)


def build(c, plan, quality, parent, out):
    p, h = load('recharge-autofill-release.py'), load('recharge-record-release.py')
    p.validate_contract(c)
    p.need(out.is_dir() and not (out / 'payload').exists(), 'BUILD_OUTPUT_EXISTS')
    binding = c['parentArtifact']
    expected = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mailbox-provider-' + p.CURRENT + '/mailbox-provider-artifact.tar.gz'
    p.need(binding['url'] == expected, 'PARENT_ARTIFACT_LOCATION')
    with urllib.request.urlopen(expected, timeout=60) as response:
        raw = response.read(4 * 1024**2 + 1)
    p.need(len(raw) <= 4 * 1024**2 and p.sha(raw) == binding['sha256'], 'PARENT_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    p.need(p.sha(proof_raw) == binding['buildProofSha256'], 'PARENT_PROOF_CHANGED')
    published = json.loads(proof_raw)
    p.need(published['commit'] == p.CURRENT and published['workflowRunId'] == binding['workflowRunId'], 'PARENT_IDENTITY')
    provider = load('mailbox-provider-build.py')
    provider_contract = json.loads((HERE / 'mailbox-provider-contract.json').read_bytes())
    parent_out = ROOT / '.codex-worktrees' / ('recharge-autofill-reproduction-' + plan['workflowRunId'])
    p.need(not parent_out.exists(), 'REPRODUCTION_ALREADY_ACCEPTED')
    parent_out.mkdir(parents=True, mode=0o700)
    contexts = {}
    original_run = subprocess.run

    def capture(command, *args, **kwargs):
        result = original_run(command, *args, **kwargs)
        build_id = (kwargs.get('env') or {}).get('V2_BUILD_ID')
        if command == ['npm', 'run', 'build', '--workspace', 'apps/api'] and build_id == 'v2-' + c['apiSourceParent']:
            contexts['api'] = Path(kwargs['cwd'])
        if command == ['npm', 'run', 'build', '--workspace', 'apps/admin'] and build_id == 'v2-' + p.CURRENT:
            contexts['admin'] = Path(kwargs['cwd'])
        return result

    subprocess.run = capture
    try:
        provider.build(provider_contract, published, published['qualitySourceEvidence'], published['nativeParentCapture'], parent_out)
    finally:
        subprocess.run = original_run
    reproduced = json.loads((parent_out / 'payload/build-proof.json').read_bytes())
    p.need(reproduced['adminFiles'] == published['adminFiles'] == c['baselineAdminFiles'] and set(contexts) == {'api', 'admin'}, 'PARENT_NOT_REPRODUCED')
    before_api = h.file_inventory(contexts['api'] / 'apps/api/dist')
    p.need(all(before_api.get(n) == c['beforeApiModules'][n] for n in c['apiModules']), 'API_PARENT_NOT_REPRODUCED')
    overlay_sources(c, contexts, p.CURRENT)
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
        if c['beforeEngineFiles'][name] != digest:
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
    print(json.dumps({'status': 'RECHARGE_AUTOFILL_BUILT', 'businessActions': 0}))
