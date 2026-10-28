"""Reproduce live API modules and Admin assets, then apply reviewed diagnostic files."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('frame_attempt_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(c, plan, quality, parent, out):
    p, h = load('online-frame-attempts-release.py'), load('recharge-record-release.py')
    p.validate_contract(c)
    contexts = {'baseline': out / 'baseline', 'candidate': out / 'candidate'}
    contexts['baseline'].mkdir()
    raw = subprocess.check_output(['git', 'archive', c['sourceBase']], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive.getmembers():
            p.need(not member.name.startswith('/') and '..' not in Path(member.name).parts
                   and not member.issym() and not member.islnk(), 'SOURCE_ARCHIVE_INVALID')
        archive.extractall(contexts['baseline'])
    shutil.copytree(contexts['baseline'], contexts['candidate'])
    for name, digest in c['sources'].items():
        p.need(p.sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
        destination = contexts['candidate'] / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    for context in contexts.values():
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + plan['commit']}
        for command in [
            ['npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
            ['npm', 'run', 'prisma:mysql:generate'],
            ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
            ['npm', 'run', 'build', '--workspace', '@apple-business/api']]:
            subprocess.run(command, cwd=context, env=env, check=True)
    before = h.file_inventory(contexts['baseline'] / 'apps/api/dist')
    after = h.file_inventory(contexts['candidate'] / 'apps/api/dist')
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map')}
    p.need(all(before.get(n) == c['beforeApiModules'][n] for n in selected), 'API_PARENT_NOT_REPRODUCED')
    changed = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)
               and not n.endswith(('.d.ts', '.d.ts.map'))}
    p.need(changed <= selected | {'tsconfig.build.tsbuildinfo'} and selected <= after.keys(), 'API_COMPILED_SCOPE_CHANGED')
    payload = out / 'payload'
    for name in sorted(selected):
        destination = payload / 'api/modules' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(contexts['candidate'] / 'apps/api/dist' / name, destination)
    for name in c['sources']:
        destination = payload / 'source' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    for name, digest in c['afterEngineFiles'].items():
        if c['beforeEngineFiles'].get(name) == digest:
            continue
        p.need(p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest, 'ENGINE_SOURCE_CHANGED')
        destination = payload / 'engine' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / p.ENGINE / name, destination)
    # Reproduce the exact published Admin source envelope, retaining mailbox fixes.
    admin_contexts = {}
    for role in ('baseline', 'candidate'):
        context = out / ('admin-' + role)
        context.mkdir()
        raw = subprocess.check_output(['git', 'archive', c['adminSourceBase']], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for member in archive.getmembers():
                p.need(not member.name.startswith('/') and '..' not in Path(member.name).parts
                       and not member.issym() and not member.islnk(), 'ADMIN_SOURCE_ARCHIVE_INVALID')
            archive.extractall(context)
        for name, expected in c['adminBaselineSources'].items():
            raw = subprocess.check_output(['git', 'show', c['expectedCurrent'] + ':' + name], cwd=ROOT)
            p.need(p.sha(raw) == expected, 'ADMIN_BASE_SOURCE_CHANGED')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        if role == 'candidate':
            for name in c['sources']:
                if name.startswith('apps/admin/'):
                    shutil.copyfile(ROOT / name, context / name)
        env = {**os.environ, 'NODE_ENV': 'production',
               'V2_BUILD_ID': 'v2-' + (c['expectedCurrent'] if role == 'baseline' else plan['commit'])}
        for command in [['npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                        ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
                        ['npm', 'run', 'build', '--workspace', '@apple-business/admin']]:
            subprocess.run(command, cwd=context, env=env, check=True)
        admin_contexts[role] = context
    admin_before = h.file_inventory(admin_contexts['baseline'] / 'apps/admin/dist')
    p.need(admin_before == c['baselineAdminFiles'], 'ADMIN_PARENT_NOT_REPRODUCED')
    shutil.copytree(admin_contexts['candidate'] / 'apps/admin/dist', payload / 'admin/html')
    admin_after = h.file_inventory(payload / 'admin/html')
    p.need('v2-' + plan['commit'] in (payload / 'admin/html/index.html').read_text(), 'ADMIN_BUILD_VERSION_CHANGED')
    proof = {**plan, 'version': 1, 'scope': p.SCOPE, 'sources': c['sources'],
             'qualitySourceEvidence': quality, 'nativeParentCapture': parent,
             'baselineApiReproduced': True, 'afterEngineFiles': c['afterEngineFiles'],
             'apiModules': {n: after[n] for n in sorted(selected)},
             'preservedApiDeclarations': {n: v for n, v in c['beforeApiModules'].items() if n.endswith('.d.ts')},
             'baselineAdminReproduced': True, 'baselineAdminFiles': admin_before, 'adminFiles': admin_after,
             'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, {**plan, 'qualitySourceEvidence': quality, 'nativeParentCapture': parent}, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (p.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_FRAME_ATTEMPTS_BUILT', 'businessActions': 0}))
