"""Build exact main; reproduce only the deployed inputs used by the finite overlay."""
import hashlib
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
    spec = importlib.util.spec_from_file_location('mailbox_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(c, plan, qa, capture, out):
    r, h = load('mailbox-validity-runtime.py'), load('recharge-record-release.py')
    r.validate_contract(c)
    # Rebuild the reviewed main-owned files on the proven deployed source envelope.
    # Other work merged into main is retained in Git, but cannot enter this finite release.
    contexts = {'baseline': out / 'baseline', 'candidate': out / 'candidate'}
    contexts['baseline'].mkdir()
    raw = subprocess.check_output(['git', 'archive', c['sourceBase']], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive.getmembers():
            r.need(not member.name.startswith('/') and '..' not in Path(member.name).parts
                   and not member.issym() and not member.islnk(), 'SOURCE_ARCHIVE_INVALID')
        archive.extractall(contexts['baseline'])
    shutil.copytree(contexts['baseline'], contexts['candidate'])
    for name, expected in c['sources'].items():
        r.need(r.sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
        dest = contexts['candidate'] / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, dest)
    for role, context in contexts.items():
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (c['baselineAdminCommit'] if role == 'baseline' else plan['commit'])}
        for command in [
            ['npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
            ['npm', 'run', 'prisma:mysql:generate'],
            ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
            ['npm', 'run', 'build', '--workspace', '@apple-business/api'],
            ['npm', 'run', 'build', '--workspace', '@apple-business/admin']]:
            subprocess.run(command, cwd=context, env=env, check=True)
    before = h.file_inventory(contexts['baseline'] / 'apps/api/dist')
    candidate = contexts['candidate']
    after = h.file_inventory(candidate / 'apps/api/dist')
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    r.need(all(before[n] == v for n, v in capture['baseline']['baselineApiModules'].items()), 'API_BASELINE_NOT_REPRODUCED')
    changed = {n for n in before.keys() | after.keys() if before.get(n) != after.get(n)}
    r.need(changed <= selected | {'tsconfig.build.tsbuildinfo'} and selected <= after.keys(), 'API_COMPILED_SCOPE_CHANGED')
    baseline_admin = h.file_inventory(contexts['baseline'] / 'apps/admin/dist')
    r.need(baseline_admin == c['baselineAdminFiles'], 'ADMIN_BASELINE_NOT_REPRODUCED')
    old_schema = (contexts['baseline'] / 'apps/api/prisma-mysql/schema.prisma').read_text()
    new_schema = (candidate / 'apps/api/prisma-mysql/schema.prisma').read_text()
    field = '  queryCodeValidityDays       Int                              @default(30) @map("query_code_validity_days")\n'
    r.need(new_schema.count(field) == 1 and new_schema.replace(field, '') == old_schema, 'SCHEMA_DELTA_CHANGED')
    payload = out / 'payload'
    for name in sorted(selected):
        dest = payload / 'api/modules' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, dest)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for path in (candidate / 'node_modules/.prisma/client').iterdir():
        if path.is_file() and not path.name.endswith('.node'):
            dest = payload / 'api/prisma-client' / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
    shutil.copyfile(candidate / 'apps/api/prisma-mysql/schema.prisma', payload / 'api/schema.prisma')
    for name, expected in c['sources'].items():
        r.need(r.sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
        dest = payload / 'source' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, dest)
    proof = {**plan, 'scope': r.SCOPE, 'sources': c['sources'], 'qualitySourceEvidence': qa,
             'nativeParentCapture': capture, 'retainedSourceBase': c['sourceBase'], 'reviewBase': c['reviewBase'],
             'baselineApiModulesReproduced': True,
             'baselineAdminReproduced': True, 'baselineAdminFiles': baseline_admin,
             'apiModules': {n: after[n] for n in sorted(selected)},
             'adminFiles': h.file_inventory(payload / 'admin/html'),
             'prismaClientFiles': h.file_inventory(payload / 'api/prisma-client'),
             'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    r.verify_proof(proof, {**plan, 'qualitySourceEvidence': qa, 'nativeParentCapture': capture}, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / 'mailbox-validity-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(r.sha(bundle.read_bytes()) + '\n')
    return proof
