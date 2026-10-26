"""Reproduce the published native source, then rebuild only the reviewed Admin overlay."""
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
    spec = importlib.util.spec_from_file_location('provider_build_' + Path(name).name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(c, plan, quality, parent, out):
    p, h = load('mailbox-provider-release.py'), load('recharge-record-release.py')
    p.need(out.is_dir() and not out.is_symlink() and not (out / 'payload').exists(), 'BUILD_OUTPUT_EXISTS')
    binding = c['parentArtifact']
    expected_url = ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                    'online-session-diagnostic-' + p.ADMIN_CURRENT + '/online-session-diagnostic-artifact.tar.gz')
    p.need(binding['url'] == expected_url, 'PARENT_ARTIFACT_LOCATION')
    with urllib.request.urlopen(binding['url'], timeout=60) as response:
        raw = response.read(4 * 1024**2 + 1)
    p.need(len(raw) <= 4 * 1024**2 and p.sha(raw) == binding['sha256'], 'PARENT_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        proof_raw = archive.extractfile('payload/build-proof.json').read()
    p.need(p.sha(proof_raw) == binding['buildProofSha256'] == c['baseline']['parentBuildProofSha256'], 'PARENT_PROOF_CHANGED')
    published = json.loads(proof_raw)
    p.need(published['commit'] == p.ADMIN_CURRENT and published['workflowRunId'] == binding['workflowRunId'], 'PARENT_IDENTITY')
    # Reproduce from the immutable Admin source; current main also contains newer engine files.
    source_root = out / 'published-source'
    subprocess.run(['git', 'worktree', 'add', '--detach', str(source_root), p.ADMIN_CURRENT], cwd=ROOT, check=True)
    recipe = load(source_root / 'scripts/production-release/online-session-diagnostic-build.py')
    parent_contract_raw = (HERE / 'online-session-diagnostic-contract.json').read_bytes()
    p.need(p.sha(parent_contract_raw) == c['baseline']['parentContractSha256'], 'PARENT_CONTRACT_CHANGED')
    parent_contract = json.loads(parent_contract_raw)
    contexts = {}
    original_run = subprocess.run

    def capture(command, *args, **kwargs):
        result = original_run(command, *args, **kwargs)
        if (command == ['npm', 'run', 'build', '--workspace', 'apps/admin']
                and kwargs.get('env', {}).get('V2_BUILD_ID') == 'v2-' + p.ADMIN_CURRENT):
            contexts['admin'] = kwargs['cwd']
        return result

    subprocess.run = capture
    try:
        recipe.build(parent_contract, published, published['qualitySourceEvidence'],
                                  published['nativeParentCapture'], out / 'published-parent')
    finally:
        subprocess.run = original_run
    reproduced = json.loads((out / 'published-parent/payload/build-proof.json').read_bytes())
    p.need(reproduced['adminFiles'] == published['adminFiles'] == c['baseline']['baselineAdminFiles']
           and reproduced['apiModules'] == published['apiModules'] == c['baseline']['baselineApiModules']
           and reproduced['afterEngineFiles'] == published['afterEngineFiles'], 'PARENT_NOT_REPRODUCED')
    admin = Path(contexts['admin'])
    for name, digest in c['sources'].items():
        source = ROOT / name
        p.need(p.sha(source.read_bytes()) == digest, 'SOURCE_CHANGED')
        if '.spec.' in name:
            continue  # Tests are validated by this main/PR quality run, not shipped into an older test toolchain.
        destination = admin / name
        baseline = subprocess.run(['git', 'show', p.ADMIN_CURRENT + ':' + name], cwd=ROOT, capture_output=True)
        if baseline.returncode == 0:
            p.need(destination.is_file() and destination.read_bytes() == baseline.stdout, 'UNPUBLISHED_SOURCE_DIFFERENCE')
        else:
            p.need(not destination.exists(), 'UNREVIEWED_SOURCE_EXISTS')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
    env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + plan['commit']}
    subprocess.run(['npm', 'run', 'build', '--workspace', 'apps/admin'], cwd=admin, env=env, check=True)
    payload = out / 'payload'
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        destination = payload / 'source' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    result = {**plan, 'version': 1, 'scope': p.SCOPE, 'baselineApiReproduced': True,
              'baselineAdminSourceReproduced': True, 'sources': c['sources'], 'qualitySourceEvidence': quality,
              'nativeParentCapture': parent, 'baselineAdminFiles': reproduced['adminFiles'],
              'apiModules': reproduced['apiModules'], 'baselineApiModules': reproduced['apiModules'],
              'adminFiles': h.file_inventory(admin / 'apps/admin/dist'), 'files': h.file_inventory(payload),
              'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(result, {**plan, 'qualitySourceEvidence': quality, 'nativeParentCapture': parent}, c, result['files'])
    (payload / 'build-proof.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    bundle = out / (p.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'MAILBOX_PROVIDER_BUILT', 'businessActions': 0}))
    return result
