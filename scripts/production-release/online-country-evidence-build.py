"""Reproduce published API/Admin bytes, then apply the reviewed country evidence repair."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import importlib.util

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(c, plan, quality, parent, out):
    p = load('online-country-evidence-release.py')
    h = load('recharge-record-release.py')
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT)
    env = {**os.environ, 'NODE_ENV': 'production', 'PRISMA_GENERATE_SKIP_AUTOINSTALL': '1'}
    api = out / 'api-context'

    def run(*args):
        subprocess.run(args, cwd=api, env=env, check=True)

    binding = c['parentArtifact']
    with urllib.request.urlopen(binding['artifactUrl'], timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    p.need(0 < len(raw) <= 24 * 1024**2 and p.sha(raw) == binding['artifactSha256'], 'PARENT_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        parent_raw = archive.extractfile('payload/build-proof.json').read()
        p.need(p.sha(parent_raw) == binding['buildProofSha256'], 'PARENT_PROOF_CHANGED')
        published = json.loads(parent_raw)
        native_declarations = {n: archive.extractfile('payload/api/modules/' + n).read()
                               for n in published['apiModules'] if n.endswith('.d.ts')}
    historical = c['historicalApiDeclarations']
    with urllib.request.urlopen(historical['artifactUrl'], timeout=60) as response:
        old_raw = response.read(24 * 1024**2 + 1)
    p.need(p.sha(old_raw) == historical['artifactSha256'], 'HISTORICAL_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(old_raw), mode='r:gz') as archive:
        proof_bytes = archive.extractfile('payload/build-proof.json').read()
        p.need(p.sha(proof_bytes) == historical['buildProofSha256'], 'HISTORICAL_PROOF_CHANGED')
        previous = json.loads(proof_bytes)
        old_declarations = {n: archive.extractfile('payload/api/modules/' + n).read() for n in previous['apiModules'] if n.endswith('.d.ts')}
        for n,v in old_declarations.items():
            p.need(p.sha(v) == previous['apiModules'][n], 'DECLARATION_HASH_CHANGED')
        native_declarations = {**old_declarations, **native_declarations}
    p.need(published['commit'] == c['parentArtifact']['commit'] and published['afterEngineFiles'] == c['apiParentEngineFiles'], 'PARENT_CONTENT_CHANGED')
    recipe = load('online-human-verification-release.py')
    old = json.loads((HERE / recipe.CONTRACT_FILE).read_bytes())
    with tarfile.open(fileobj=io.BytesIO(git('archive', recipe.CURRENT))) as archive:
        archive.extractall(api, filter='data')
    for name in recipe.API:
        raw = git('show', recipe.SOURCE + ':' + name)
        p.need(p.sha(raw) == old['productionSources'][name], 'HISTORICAL_SOURCE_CHANGED')
        target = api / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'prisma:mysql:generate'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/api')):
        run(*command)
    # Apply exactly the already-published unpaid-validation API sources.
    prior = json.loads((HERE / 'online-unpaid-validation-contract.json').read_bytes())
    for name in prior['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        raw = git('show', prior['sourceReviewCommit'] + ':' + source)
        p.need(p.sha(raw) == prior['sources'][source], 'PUBLISHED_SOURCE_CHANGED')
        (api / source).write_bytes(raw)
    # Reproduce the already-published checkout-resume API layer as well. The
    # newer persistent-profile release changed only the executor, not the API.
    resume = json.loads((HERE / 'online-checkout-resume-contract.json').read_bytes())
    for name in resume['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        raw = git('show', resume['sourceReviewCommit'] + ':' + source)
        p.need(p.sha(raw) == resume['sources'][source], 'PUBLISHED_RESUME_SOURCE_CHANGED')
        (api / source).write_bytes(raw)
    card_read = json.loads((HERE / 'online-card-read-diagnostics-contract.json').read_bytes())
    for name in card_read['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        raw = git('show', card_read['sourceReviewCommit'] + ':' + source)
        p.need(p.sha(raw) == card_read['sources'][source], 'PUBLISHED_CARD_READ_SOURCE_CHANGED')
        (api / source).write_bytes(raw)
    run('npm', 'run', 'build', '--workspace', '@apple-business/api')
    dist = api / 'apps/api/dist'
    # Reproduce the current, already-published proxy diagnostics API layer.
    parent_patch = json.loads((HERE / 'online-proxy-failure-evidence-contract.json').read_bytes())
    for name in parent_patch['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        raw = git('show', parent_patch['sourceReviewCommit'] + ':' + source)
        p.need(p.sha(raw) == parent_patch['sources'][source], 'PUBLISHED_PROXY_API_CHANGED')
        (api / source).write_bytes(raw)
    run('npm', 'run', 'build', '--workspace', '@apple-business/api')
    latest = json.loads((HERE / 'online-profile-egress-contract.json').read_bytes())
    for name in latest['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        (api / source).write_bytes(git('show', latest['sourceReviewCommit'] + ':' + source))
    run('npm', 'run', 'build', '--workspace', '@apple-business/api')
    # Declaration ordering depends on the historical Prisma projection. Reuse
    # only already-published, hash-verified non-executable declaration bytes.
    for name, raw in native_declarations.items():
        p.need(p.sha(raw) == c['expectedApiFiles'][name], 'PUBLISHED_DECLARATION_CHANGED')
        (dist / name).write_bytes(raw)
    before = h.file_inventory(dist)
    expected = c['expectedApiFiles']
    comparison = {n: {'expected': v, 'actual': before.get(n)} for n, v in expected.items()}
    (out / 'api-parent-reproduction.json').write_text(json.dumps(comparison, sort_keys=True, indent=2) + '\n')
    p.need(all(before.get(n) == v for n, v in expected.items()), 'PUBLISHED_API_NOT_REPRODUCED')
    # Existing edited modules must be the exact published source before this repair.
    for name in c['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        if (api / source).exists():
            p.need((api / source).read_bytes() == git('show', c['reviewBase'] + ':' + source), 'UNPUBLISHED_API_SOURCE')
        (api / source).write_bytes((ROOT / source).read_bytes())
    run('npm', 'run', 'build', '--workspace', '@apple-business/api')
    after = h.file_inventory(dist)
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    changed = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)}
    p.need(not (before.keys() - after.keys()) and all(n in selected or (
        n.startswith('id-business-v2/online-recharge/') and n.endswith('.d.ts')) or
        n == 'tsconfig.build.tsbuildinfo' for n in changed), 'API_COMPILED_SCOPE_CHANGED')
    modules = {n: after[n] for n in selected | (changed - {'tsconfig.build.tsbuildinfo'})}
    # Reproduce the exact published Admin lineage, never build unrelated main WIP.
    recipe = json.loads((HERE / 'bitbrowser-quote-contract.json').read_bytes())
    q = load('bitbrowser-quote-publication.py')
    q.OUT = out / 'admin-source'
    q.OUT.mkdir()
    admin, helper = q.reconstruct_parent(recipe)
    helper.overlay(admin, recipe['productionSources'], recipe['sourceReviewCommit'])
    prior = json.loads((HERE / 'online-unpaid-validation-contract.json').read_bytes())
    for name,digest in prior['sources'].items():
        if name.startswith('apps/admin/'):
            raw = git('show', prior['sourceReviewCommit'] + ':' + name)
            p.need(p.sha(raw) == digest, 'PUBLISHED_ADMIN_SOURCE_CHANGED')
            target = admin / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    # Reproduce the current Admin overlay before applying this repair.
    for name, digest in parent_patch['sources'].items():
        if name.startswith('apps/admin/'):
            raw = git('show', parent_patch['sourceReviewCommit'] + ':' + name)
            p.need(p.sha(raw) == digest, 'PUBLISHED_PROXY_ADMIN_CHANGED')
            (admin / name).write_bytes(raw)
    for name, digest in latest['sources'].items():
        if name.startswith('apps/admin/'):
            raw = git('show', latest['sourceReviewCommit'] + ':' + name)
            p.need(p.sha(raw) == digest, 'PUBLISHED_PROFILE_ADMIN_CHANGED')
            (admin / name).write_bytes(raw)
    def run_admin(args, commit):
        subprocess.run(args, cwd=admin, env={**env, 'V2_BUILD_ID': 'v2-' + commit}, check=True)
    for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/admin')):
        run_admin(command, c['baselineAdminBuildCommit'])
    before_admin = h.file_inventory(admin / 'apps/admin/dist')
    (out / 'admin-parent-reproduction.json').write_text(json.dumps({'reproduced': before_admin == published['adminFiles'], 'expectedSha256': h.fingerprint(published['adminFiles']), 'actualSha256': h.fingerprint(before_admin)}, sort_keys=True) + '\n')
    p.need(before_admin == published['adminFiles'], 'PUBLISHED_ADMIN_NOT_REPRODUCED')
    for name in c['sources']:
        if name.startswith('apps/admin/'):
            (admin / name).write_bytes((ROOT / name).read_bytes())
    run_admin(('npm', 'run', 'build', '--workspace', '@apple-business/admin'), plan['commit'])
    admin_files = h.file_inventory(admin / 'apps/admin/dist')
    payload = out / 'payload'
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dist / name, target)
    for name, digest in c['sources'].items():
        p.need(p.sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    for name, digest in c['afterEngineFiles'].items():
        if c['beforeEngineFiles'].get(name) == digest:
            continue
        target = payload / 'engine' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / c['engineRoot'] / name, target)
    proof = {**plan, 'version': 1, 'scope': p.SCOPE, 'sources': c['sources'],
             'afterEngineFiles': c['afterEngineFiles'], 'qualitySourceEvidence': quality,
             'nativeParentCapture': parent, 'baselineApiReproduced': True,
             'baselineAdminSourceReproduced': True, 'baselineAdminFiles': published['adminFiles'],
             'apiModules': modules, 'adminFiles': admin_files,
             'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, {**plan, 'qualitySourceEvidence': quality, 'nativeParentCapture': parent}, {**c, **parent['baseline']}, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (p.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_COUNTRY_EVIDENCE_BUILT', 'commit': plan['commit'], 'businessActions': 0}))
