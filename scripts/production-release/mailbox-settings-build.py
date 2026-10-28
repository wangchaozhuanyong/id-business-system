"""Rebuild the published source envelope and change one reviewed Admin line."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def build(c, plan, qa, capture, out, runtime):
    root = runtime.HERE.parents[1]
    h = runtime.load('recharge-record-release.py')
    contexts = {}
    for role in ('baseline', 'candidate'):
        context = out / role
        context.mkdir()
        raw = subprocess.check_output(['git', 'archive', c['sourceBase']], cwd=root)
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for member in archive.getmembers():
                runtime.need(not member.name.startswith('/') and '..' not in Path(member.name).parts
                             and not member.issym() and not member.islnk(), 'SOURCE_ARCHIVE_INVALID')
            archive.extractall(context)
        for name, expected in c['baselineSources'].items():
            raw = subprocess.check_output(['git', 'show', c['expectedCurrent'] + ':' + name], cwd=root)
            runtime.need(runtime.sha(raw) == expected, 'BASE_SOURCE_CHANGED')
            path = context / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        if role == 'candidate':
            for name, expected in c['sources'].items():
                raw = (root / name).read_bytes()
                runtime.need(runtime.sha(raw) == expected, 'SOURCE_CHANGED')
                (context / name).write_bytes(raw)
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (runtime.ADMIN_PARENT if role == 'baseline' else plan['commit'])}
        for command in [['npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                        ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
                        ['npm', 'run', 'build', '--workspace', '@apple-business/admin']]:
            subprocess.run(command, cwd=context, env=env, check=True)
        contexts[role] = context
    before = h.file_inventory(contexts['baseline'] / 'apps/admin/dist')
    runtime.need(before == c['baselineAdminFiles'], 'ADMIN_BASELINE_NOT_REPRODUCED')
    payload = out / 'payload'
    shutil.copytree(contexts['candidate'] / 'apps/admin/dist', payload / 'admin/html')
    runtime.need('v2-' + plan['commit'] in (payload / 'admin/html/index.html').read_text(), 'BUILD_VERSION_CHANGED')
    path = payload / 'source' / runtime.SOURCE
    path.parent.mkdir(parents=True)
    shutil.copyfile(root / runtime.SOURCE, path)
    proof = {**plan, 'qualitySourceEvidence': qa, 'nativeParentCapture': capture, 'scope': runtime.SCOPE,
             'sources': c['sources'], 'baselineAdminReproduced': True, 'baselineAdminFiles': before,
             'adminFiles': h.file_inventory(payload / 'admin/html'), 'files': h.file_inventory(payload),
             'migrationPerformed': False, 'businessActions': 0}
    runtime.verify_proof(proof, {**plan, 'qualitySourceEvidence': qa, 'nativeParentCapture': capture}, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (runtime.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(runtime.sha(bundle.read_bytes()) + '\n')
    return proof
