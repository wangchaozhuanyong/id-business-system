"""Package only the reviewed npm directories, never application build output."""
import json
import shutil
import tarfile


def build(c, plan, qa, out, runtime):
    root = runtime.HERE.parents[1]
    h = runtime.load('recharge-record-release.py')
    payload = out / 'payload'
    payload.mkdir()
    package_roots = runtime.package_roots(c)
    lock = json.loads((root / 'package-lock.json').read_bytes())['packages']
    versions = c['afterVersions']
    for name in package_roots:
        path = root / name
        runtime.need(path.exists() == (name in lock), 'INSTALLED_LAYOUT_CHANGED')
        if versions[name] is not None:
            runtime.need(path.is_dir() and not path.is_symlink(), 'PACKAGE_LINK')
            shutil.copytree(path, payload / 'packages' / name)
    for name in c['packageDirectories']:
        path = payload / 'packages' / name
        runtime.need(path.exists() == (versions[name] is not None), 'PAYLOAD_LAYOUT_CHANGED')
        if versions[name] is not None:
            runtime.need(json.loads((path / 'package.json').read_bytes())['version'] == lock[name]['version'], 'PACKAGE_VERSION_CHANGED')
    for name, digest in c['sources'].items():
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = (root / name).read_bytes()
        runtime.need(runtime.sha(raw) == digest, 'SOURCE_CHANGED')
        path.write_bytes(raw)
    probe = payload / 'probes/dependency-security-regressions.test.mjs'
    probe.parent.mkdir()
    raw = (root / 'scripts/dependency-security-regressions.test.mjs').read_bytes()
    runtime.need(runtime.sha(raw) == c['probeSha256'], 'PROBE_CHANGED')
    probe.write_bytes(raw)
    proof = {**plan, 'qualitySourceEvidence': qa, 'scope': c['scope'],
             'baselineSha256': c['baselineSha256'], 'sources': c['sources'],
             'packageRoots': package_roots, 'packageVersions': versions,
             'files': h.file_inventory(payload), 'migrationPerformed': False, 'businessActions': 0}
    runtime.verify_proof(proof, {**plan, 'qualitySourceEvidence': qa}, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = out / (runtime.PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (out / 'artifact-sha256.txt').write_text(runtime.sha(bundle.read_bytes()) + '\n')
    return proof
