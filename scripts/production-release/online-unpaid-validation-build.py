"""Reproduce live API modules and the published Admin recipe before applying this batch."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import importlib.util
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('unpaid_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(c, plan, quality, parent, out):
    p = load('online-unpaid-validation-release.py')
    h = load('recharge-record-release.py')
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT)
    env = {**os.environ, 'NODE_ENV': 'production', 'PRISMA_GENERATE_SKIP_AUTOINSTALL': '1'}

    def run(args, context, extra=None):
        subprocess.run(args, cwd=context, env={**env, **(extra or {})}, check=True)

    # The live API is the finite human-verification projection, not the full
    # later main tree. Reproduce its published source constructor exactly.
    api = out / 'api-context'
    api_recipe = load('online-human-verification-release.py')
    published_api = json.loads((HERE / api_recipe.CONTRACT_FILE).read_bytes())
    with tarfile.open(fileobj=io.BytesIO(git('archive', api_recipe.CURRENT))) as archive:
        archive.extractall(api, filter='data')
    for name in api_recipe.API:
        raw = git('show', api_recipe.SOURCE + ':' + name)
        p.need(p.sha(raw) == published_api['productionSources'][name], 'PUBLISHED_API_SOURCE_CHANGED')
        target = api / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'prisma:mysql:generate'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/api')):
        run(command, api)
    # Preserve the exact published type declaration. Its object/union ordering
    # varies with the historical Prisma projection, while JS and source maps
    # reproduce exactly. Reuse only this non-executable, hash-pinned file.
    declaration = 'persistence/tasks.repository.d.ts'
    binding = c['publishedApiDeclaration']
    with urllib.request.urlopen(binding['artifactUrl'], timeout=60) as response:
        raw = response.read(8 * 1024**2 + 1)
    p.need(0 < len(raw) <= 8 * 1024**2 and p.sha(raw) == binding['artifactSha256'], 'DECLARATION_ARTIFACT_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        member = archive.getmember('payload/api/modules/id-business-v2/online-recharge/' + declaration)
        p.need(member.isfile() and 0 < member.size <= 128 * 1024, 'DECLARATION_FILE_CHANGED')
        native_declaration = archive.extractfile(member).read()
    p.need(p.sha(native_declaration) == c['beforeApiOnlineFiles'][declaration], 'DECLARATION_CONTENT_CHANGED')
    (api / 'apps/api/dist/id-business-v2/online-recharge' / declaration).write_bytes(native_declaration)
    before = h.file_inventory(api / 'apps/api/dist')
    expected = {'id-business-v2/online-recharge/' + n: v for n, v in c['beforeApiOnlineFiles'].items()}
    (out / 'api-parent-reproduction.json').write_text(json.dumps({
        'sourceBaseline': api_recipe.CURRENT, 'sourceOverlay': api_recipe.SOURCE,
        'selected': {n: {'expected': v, 'actual': before.get(n)} for n, v in expected.items()},
        'reproduced': all(before.get(n) == v for n, v in expected.items())}, sort_keys=True, indent=2) + '\n')
    p.need(all(before.get(n) == v for n, v in expected.items()), 'NATIVE_API_NOT_REPRODUCED')
    declarations = c['apiDeclarationOnly']
    preserved = {n: v for n, v in before.items() if n not in expected and n not in declarations and n != 'tsconfig.build.tsbuildinfo'}
    for name in c['apiModules']:
        source = 'apps/api/src/' + name.removesuffix('.js') + '.ts'
        p.need(source in c['sources'], 'API_SOURCE_NOT_REVIEWED')
        (api / source).write_bytes((ROOT / source).read_bytes())
    run(('npm', 'run', 'build', '--workspace', '@apple-business/api'), api)
    after = h.file_inventory(api / 'apps/api/dist')
    p.need(all(after.get(n) == v for n, v in preserved.items()) and set(after) == set(before), 'API_COMPILED_SCOPE_CHANGED')
    p.need(all(after.get(n) == v for n, v in declarations.items()), 'INDIRECT_DECLARATION_CHANGED')
    modules = {n: after[n] for n in {*expected, *declarations}}
    # Reconstruct the accepted Admin through its immutable published lineage.
    recipe = json.loads((HERE / 'bitbrowser-quote-contract.json').read_bytes())
    q = load('bitbrowser-quote-publication.py')
    q.OUT = out / 'admin-source'
    q.OUT.mkdir()
    admin, helper = q.reconstruct_parent(recipe)
    helper.overlay(admin, recipe['productionSources'], recipe['sourceReviewCommit'])
    for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
                    ('npm', 'run', 'build', '--workspace', '@apple-business/admin')):
        run(command, admin, {'V2_BUILD_ID': 'v2-' + c['baselineAdminBuildCommit']})
    before_admin = h.file_inventory(admin / 'apps/admin/dist')
    p.need(h.fingerprint(before_admin) == c['baselineAdminFilesSha256'], 'NATIVE_ADMIN_NOT_REPRODUCED')
    for name in c['sources']:
        if name.startswith('apps/admin/'):
            target = admin / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / name).read_bytes())
    run(('npm', 'run', 'build', '--workspace', '@apple-business/admin'), admin,
        {'V2_BUILD_ID': 'v2-' + plan['commit']})
    admin_files = h.file_inventory(admin / 'apps/admin/dist')
    payload = out / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(api / 'apps/api/dist' / name, target)
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
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
             'baselineAdminSourceReproduced': True, 'baselineAdminFiles': before_admin,
             'apiModules': modules, 'adminFiles': admin_files, 'files': h.file_inventory(payload),
             'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (p.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_UNPAID_BUILT', 'commit': plan['commit'], 'businessActions': 0}))
