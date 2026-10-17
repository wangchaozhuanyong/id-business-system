"""Source-bound engine delta packaging; publication is a separate operation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-checkout-load'
CONTRACT = HERE / 'online-checkout-load-contract.json'


def publisher():
    spec = importlib.util.spec_from_file_location('checkout_load_publisher', HERE / 'online-checkout-load-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def tracked_inventory(commit, prefix):
    return {name.removeprefix(prefix + '/'): sha(git('show', commit + ':' + name))
            for name in git('ls-tree', '-r', '--name-only', commit, '--', prefix).decode().splitlines()}


def freeze_sources():
    p = publisher()
    p.need(CONTRACT.is_file() and not CONTRACT.is_symlink(), 'CONTRACT_REQUIRED')
    c = json.loads(CONTRACT.read_bytes())
    p.need(c.get('sourceBaseCommit') == p.SOURCE_BASE, 'SOURCE_BASE_INVALID')
    expected_before = tracked_inventory(c['sourceBaseCommit'], p.ENGINE)
    if c['baseline'] is not None:
        p.need(c['baseline']['engineFiles'] == expected_before, 'PUBLISHED_SOURCE_BASE_CHANGED')
        c['beforeEngineFiles'] = c['baseline']['engineFiles']
    else:
        c['beforeEngineFiles'] = expected_before
    registry = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    entries = {row['path']: row['adaptedSha256'] for row in registry['files']}
    p.need(len(entries) == len(registry['files']) and all(
        sha((ROOT / p.ENGINE / name).read_bytes()) == digest for name, digest in entries.items()),
        'SOURCE_MANIFEST_CHANGED')
    c['afterEngineFiles'] = {**entries, 'SOURCE_MANIFEST.json': sha((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())}
    c['runtimeSources'] = {p.ENGINE + '/' + name: c['afterEngineFiles'][name] for name in sorted(p.FILES)}
    c['validationSources'] = {name: sha((ROOT / name).read_bytes()) for name in sorted(p.VALIDATION)}
    c['controlPins'] = {name: sha((HERE / name).read_bytes()) for name in sorted(p.CONTROLS)}
    c['workflowSha256'] = sha((ROOT / p.WORKFLOW).read_bytes())
    p.validate_contract(c, require_baseline=False)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'LOCAL_SOURCES_FROZEN', 'runtimeSources': len(c['runtimeSources']),
                      'validationSources': len(c['validationSources']), 'baselineBound': c['baseline'] is not None}))


def check(c, *, require_baseline=False):
    p = publisher()
    p.validate_contract(c, require_baseline=require_baseline)
    p.need(sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    for name, digest in {**c['runtimeSources'], **c['validationSources']}.items():
        path = ROOT / name
        p.need(not path.is_symlink() and path.is_file() and sha(path.read_bytes()) == digest, 'SOURCE_CHANGED')
    registry = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    entries = {row['path']: row['adaptedSha256'] for row in registry['files']}
    p.need(len(entries) == len(registry['files']) and entries == {
        name: digest for name, digest in c['afterEngineFiles'].items() if name != 'SOURCE_MANIFEST.json'}
        and all(not (ROOT / p.ENGINE / name).is_symlink()
                and sha((ROOT / p.ENGINE / name).read_bytes()) == digest for name, digest in entries.items()),
        'SOURCE_MANIFEST_CHANGED')
    return p


def main():
    if sys.argv[1:] == ['--freeze-sources']:
        freeze_sources()
        return
    c = json.loads(CONTRACT.read_bytes())
    p = check(c, require_baseline=not sys.argv[1:])
    if sys.argv[1:] == ['--check']:
        print(json.dumps({'status': 'LOCAL_SOURCE_CONTRACT_VERIFIED', 'baselineBound': c['baseline'] is not None,
                          'runtimeSources': len(c['runtimeSources']), 'businessActions': 0}))
        return
    p.need(not sys.argv[1:] and os.environ.get('GITHUB_ACTIONS') == 'true'
           and os.environ.get('GITHUB_REF') == 'refs/heads/main', 'NATIVE_BUILD_REQUIRED')
    commit, tree = git('rev-parse', 'HEAD').decode().strip(), git('rev-parse', 'HEAD^{tree}').decode().strip()
    p.need(commit == os.environ.get('GITHUB_SHA') and not git('status', '--porcelain', '--untracked-files=no').strip(),
           'SOURCE_DIRTY')
    p.need(tracked_inventory('HEAD', p.ENGINE) == c['afterEngineFiles']
           and tracked_inventory(c['sourceBaseCommit'], p.ENGINE) == c['beforeEngineFiles'],
           'TRACKED_ENGINE_CHANGED')
    p.need(not OUT.exists(), 'BUILD_ALREADY_STARTED')
    quality = p.load('registration-closure-dispatch.py').quality_source_evidence(commit, tree)
    p.validate_quality(quality, commit, tree)
    payload = OUT / 'payload'
    (payload / 'engine').mkdir(parents=True, mode=0o700)
    for name in p.FILES:
        target = payload / 'engine' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / p.ENGINE / name, target)
    proof = {'version': 1, 'scope': p.SCOPE, 'commit': commit, 'tree': tree,
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'contractSha256': sha(CONTRACT.read_bytes()), 'controlSources': c['controlPins'],
        'qualitySourceEvidence': quality,
        'runtimeSources': c['runtimeSources'], 'validationSources': c['validationSources'],
        'beforeEngineFiles': c['beforeEngineFiles'], 'afterEngineFiles': c['afterEngineFiles'],
        'baselineSha256': p.fingerprint(c['baseline']), 'workflow': p.WORKFLOW,
        'workflowSha256': c['workflowSha256'],
        'updatedServices': ['online-recharge'], 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0,
        'files': {'engine/' + name: c['afterEngineFiles'][name] for name in p.FILES}}
    raw = json.dumps(proof, sort_keys=True, indent=2).encode() + b'\n'
    plan = {key: proof[key] for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                                      'contractSha256', 'controlSources', 'qualitySourceEvidence')}
    p.verify_proof(proof, plan, c, proof['files'])
    (payload / 'build-proof.json').write_bytes(raw)
    bundle = OUT / 'online-checkout-load-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        for path in sorted(payload.rglob('*')):
            if path.is_file():
                archive.add(path, arcname=path.relative_to(OUT).as_posix(), recursive=False)
    (OUT / 'artifact-sha256.txt').write_text(sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'commit': commit, 'scope': p.SCOPE, 'runtimeSources': len(p.FILES),
                      'artifactSha256': sha(bundle.read_bytes()), 'businessActions': 0}))


if __name__ == '__main__':
    main()
