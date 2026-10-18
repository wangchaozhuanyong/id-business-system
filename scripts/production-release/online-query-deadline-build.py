"""Source-bound engine-only complete-response deadline repair; no business actions."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-query-deadline'
CONTRACT = HERE / 'online-query-deadline-contract.json'


def publisher():
    spec = importlib.util.spec_from_file_location('deadline_publisher', HERE / 'online-query-deadline-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def tracked_inventory(commit, prefix):
    p = publisher()
    return {name.removeprefix(prefix + '/'): p.sha(git('show', commit + ':' + name))
        for name in git('ls-tree', '-r', '--name-only', commit, '--', prefix).decode().splitlines()}


def freeze(baseline_path):
    p = publisher()
    manifest = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    after = {row['path']: row['adaptedSha256'] for row in manifest['files']}
    p.need(len(after) == len(manifest['files']) and all(p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest
        for name, digest in after.items()), 'SOURCE_MANIFEST_CHANGED')
    after['SOURCE_MANIFEST.json'] = p.sha((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    review = git('rev-parse', 'HEAD').decode().strip()
    c = {'version': 1, 'scope': p.SCOPE, 'sourceBaseCommit': p.SOURCE_BASE, 'reviewBase': p.REVIEW_BASE,
        'sourceReviewCommit': review, 'sourceReviewTag': 'online-query-deadline-source-review-' + review[:12],
        'engineRoot': p.ENGINE, 'requiredQualityParts': list(p.QUALITY_PARTS),
        'runtimeSources': {p.ENGINE + '/' + name: after[name] for name in sorted(p.FILES)},
        'validationSources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.VALIDATION)},
        'reviewedControlSources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.REVIEW_CONTROLS)},
        'controlPins': {name: p.sha((HERE / name).read_bytes()) for name in sorted(p.CONTROLS)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'beforeEngineFiles': tracked_inventory(p.SOURCE_BASE, p.ENGINE), 'afterEngineFiles': after,
        'baseline': json.loads(Path(baseline_path).read_bytes()), 'engineHealth': p.HEALTH,
        'sqlFenceHelperSha256': p.SQL_FENCE, 'updatedServices': ['online-recharge'],
        'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'ONLINE_QUERY_DEADLINE_SOURCES_FROZEN', 'runtimeSources': len(p.FILES), 'businessActions': 0}))


def check(c):
    p = publisher()
    p.validate_contract(c)
    tag = 'refs/tags/' + c['sourceReviewTag']
    p.need(git('cat-file', '-t', tag).decode().strip() == 'tag'
        and git('rev-parse', tag + '^{commit}').decode().strip() == c['sourceReviewCommit'], 'REVIEW_TAG_CHANGED')
    expected = set(c['runtimeSources']) | set(c['validationSources']) | set(p.REVIEW_CONTROLS)
    p.need(set(git('diff', '--name-only', p.REVIEW_BASE, c['sourceReviewCommit']).decode().splitlines()) == expected,
        'REVIEW_SCOPE_CHANGED')
    for name, digest in {**c['runtimeSources'], **c['validationSources'], **c['reviewedControlSources']}.items():
        path = ROOT / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == digest
            == p.sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'REVIEWED_SOURCE_CHANGED')
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    for name, digest in c['controlPins'].items():
        path = HERE / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == digest, 'CONTROL_CHANGED')
    registry = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    entries = {row['path']: row['adaptedSha256'] for row in registry['files']}
    p.need(len(entries) == len(registry['files']) and entries == {name: digest for name, digest
        in c['afterEngineFiles'].items() if name != 'SOURCE_MANIFEST.json'}
        and all(not (ROOT / p.ENGINE / name).is_symlink() and p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest
            for name, digest in c['afterEngineFiles'].items()), 'SOURCE_MANIFEST_CHANGED')
    return p


def quality_evidence(commit, tree):
    # Reuse the accepted immutable historical Quality verifier only in memory.
    # Retirement removed these scripts from main; no retired file is restored.
    p = publisher()
    old = json.loads((HERE / 'online-query-network-contract.json').read_bytes())
    source = 'b8c37f1262a42398a43a1acd3ff4504d17c1bed8'
    def historical(name):
        p.need(name in ('online-session-preflight-build.py', 'registration-closure-dispatch.py'), 'QUALITY_HELPER_SCOPE_CHANGED')
        raw = git('show', source + ':scripts/production-release/' + name)
        p.need(p.sha(raw) == old['reconstruction']['pins'][name], 'QUALITY_HELPER_CHANGED')
        helper = types.ModuleType('immutable_deadline_quality_' + name.replace('-', '_'))
        helper.__file__ = str(HERE / name)
        exec(compile(raw, helper.__file__, 'exec'), helper.__dict__)
        return helper
    previous = historical('online-session-preflight-build.py')
    previous.publisher, previous.load = publisher, historical
    return previous.quality_evidence(commit, tree)


def main():
    c = json.loads(CONTRACT.read_bytes())
    p = check(c)
    commit, tree = git('rev-parse', 'HEAD').decode().strip(), git('rev-parse', 'HEAD^{tree}').decode().strip()
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
        and not OUT.exists() and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    p.need(set(git('diff', '--name-only', p.SOURCE_BASE, 'HEAD').decode().splitlines()) ==
        set(c['runtimeSources']) | set(c['validationSources']) | set(p.PUBLIC_CONTROLS), 'FINITE_SELECTION_CHANGED')
    p.need(tracked_inventory('HEAD', p.ENGINE) == c['afterEngineFiles']
        and tracked_inventory(p.SOURCE_BASE, p.ENGINE) == c['beforeEngineFiles'], 'TRACKED_ENGINE_CHANGED')
    quality, covered = quality_evidence(commit, tree)
    payload = OUT / 'payload'
    (payload / 'engine').mkdir(parents=True, mode=0o700)
    for name in p.FILES:
        target = payload / 'engine' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / p.ENGINE / name, target)
    proof = {'version': 1, 'scope': p.SCOPE, 'commit': commit, 'tree': tree,
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'controlSources': c['controlPins'],
        'qualitySourceEvidence': quality, 'qualityPartEvidence': covered,
        'runtimeSources': c['runtimeSources'], 'validationSources': c['validationSources'],
        'beforeEngineFiles': c['beforeEngineFiles'], 'afterEngineFiles': c['afterEngineFiles'],
        'baselineSha256': p.fingerprint(c['baseline']), 'workflow': p.WORKFLOW, 'workflowSha256': c['workflowSha256'],
        'updatedServices': ['online-recharge'], 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0,
        'files': {'engine/' + name: c['afterEngineFiles'][name] for name in p.FILES}}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'online-query-deadline-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        for path in sorted(payload.rglob('*')):
            if path.is_file():
                archive.add(path, arcname=path.relative_to(OUT).as_posix(), recursive=False)
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_QUERY_DEADLINE_NATIVE_BUILT', 'commit': commit,
        'runtimeSources': len(p.FILES), 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true')
    parser.add_argument('--baseline')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        publisher().need(args.baseline and not args.check, 'FREEZE_ARGUMENTS_INVALID')
        freeze(args.baseline)
    elif args.check:
        publisher().need(not args.baseline, 'ARGUMENTS_INVALID')
        check(json.loads(CONTRACT.read_bytes()))
        print(json.dumps({'status': 'ONLINE_QUERY_DEADLINE_SOURCE_VERIFIED', 'businessActions': 0}))
    else:
        publisher().need(not args.baseline, 'ARGUMENTS_INVALID')
        main()
