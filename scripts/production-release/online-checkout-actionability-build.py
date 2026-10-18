"""Source-bound engine-only checkout actionability repair; no business actions."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-checkout-actionability'
CONTRACT = HERE / 'online-checkout-actionability-contract.json'


def publisher():
    spec = importlib.util.spec_from_file_location('deadline_publisher', HERE / 'online-checkout-actionability-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def tracked_inventory(commit, prefix):
    p = publisher()
    return {name.removeprefix(prefix + '/'): p.sha(git('show', commit + ':' + name))
        for name in git('ls-tree', '-r', '--name-only', commit, '--', prefix).decode().splitlines()}


def verify_source_review(source_review):
    p = publisher()
    p.need(type(source_review) is str and re.fullmatch('[a-f0-9]{40}', source_review)
        and source_review == p.SOURCE_REVIEW, 'SOURCE_REVIEW_SELECTION_INVALID')
    tag = 'refs/tags/online-checkout-actionability-source-review-' + source_review[:12]
    p.need(git('cat-file', '-t', tag).decode().strip() == 'tag'
        and git('rev-parse', tag + '^{commit}').decode().strip() == source_review, 'REVIEW_TAG_CHANGED')
    expected = {p.ENGINE + '/' + name for name in p.FILES} | set(p.VALIDATION) | set(p.REVIEW_CONTROLS)
    p.need(len(expected) == 13 and set(git('diff', '--name-only', p.REVIEW_BASE,
        source_review).decode().splitlines()) == expected, 'REVIEW_SCOPE_CHANGED')
    for name in expected:
        path = ROOT / name
        p.need(path.is_file() and not path.is_symlink()
            and p.sha(path.read_bytes()) == p.sha(git('show', source_review + ':' + name)), 'REVIEWED_SOURCE_CHANGED')
    return source_review


def verify_main_selection(c, commit):
    p = publisher()
    p.need(c.get('mainIntegrationBase') == p.MAIN_BASE
        and git('merge-base', p.MAIN_BASE, commit).decode().strip() == p.MAIN_BASE, 'MAIN_INTEGRATION_BASE_CHANGED')
    expected = set(c['runtimeSources']) | set(c['validationSources']) | set(p.PUBLIC_CONTROLS)
    p.need(len(expected) == 19 and set(git('diff', '--name-only', p.MAIN_BASE,
        commit).decode().splitlines()) == expected, 'FINITE_SELECTION_CHANGED')


def freeze(baseline_path, source_review):
    p = publisher()
    review = verify_source_review(source_review)
    manifest = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    p.need({key: manifest.get(key) for key in ('repository', 'commit')} == p.UPSTREAM_SOURCE, 'SOURCE_ORIGIN_CHANGED')
    after = {row['path']: row['adaptedSha256'] for row in manifest['files']}
    p.need(len(after) == len(manifest['files']) and all(p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest
        for name, digest in after.items()), 'SOURCE_MANIFEST_CHANGED')
    after['SOURCE_MANIFEST.json'] = p.sha((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    changed = set(git('diff', '--name-only', p.REVIEW_BASE, review).decode().splitlines())
    c = {'version': 1, 'frozen': True, 'admission': 'FROZEN_REVIEWED_SOURCE', 'pendingBindings': [],
        'upstreamSource': p.UPSTREAM_SOURCE, 'scope': p.SCOPE, 'sourceBaseCommit': p.SOURCE_BASE, 'reviewBase': p.REVIEW_BASE,
        'mainIntegrationBase': p.MAIN_BASE,
        'sourceReviewCommit': review, 'sourceReviewTag': 'online-checkout-actionability-source-review-' + review[:12],
        'engineRoot': p.ENGINE, 'requiredQualityParts': list(p.QUALITY_PARTS),
        'runtimeSources': {p.ENGINE + '/' + name: after[name] for name in sorted(p.FILES)},
        'validationSources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.VALIDATION) if name in changed},
        'reviewedControlSources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.REVIEW_CONTROLS)},
        'controlPins': {name: p.sha((HERE / name).read_bytes()) for name in sorted(p.CONTROLS)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'beforeEngineFiles': tracked_inventory(p.SOURCE_BASE, p.ENGINE), 'afterEngineFiles': after,
        'baseline': json.loads(Path(baseline_path).read_bytes()), 'engineHealth': p.HEALTH,
        'sqlFenceHelperSha256': p.SQL_FENCE, 'updatedServices': ['online-recharge'],
        'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'ONLINE_CHECKOUT_ACTIONABILITY_SOURCES_FROZEN', 'runtimeSources': len(p.FILES), 'businessActions': 0}))


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
    p.need({key: registry.get(key) for key in ('repository', 'commit')} == p.UPSTREAM_SOURCE, 'SOURCE_ORIGIN_CHANGED')
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
    verify_main_selection(c, commit)
    p.need(tracked_inventory('HEAD', p.ENGINE) == c['afterEngineFiles']
        and tracked_inventory(p.SOURCE_BASE, p.ENGINE) == c['beforeEngineFiles'], 'TRACKED_ENGINE_CHANGED')
    parity_path = ROOT / '.runtime/online-checkout-actionability-ci/node22-parity.json'
    p.need(parity_path.is_file() and not parity_path.is_symlink()
        and all(not parent.is_symlink() for parent in parity_path.parents), 'PARITY_REPORT_INVALID')
    parity = p.parity_evidence(parity_path.read_bytes(), os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
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
        'qualitySourceEvidence': quality, 'qualityPartEvidence': covered, 'launcherParityEvidence': parity,
        'runtimeSources': c['runtimeSources'], 'validationSources': c['validationSources'],
        'beforeEngineFiles': c['beforeEngineFiles'], 'afterEngineFiles': c['afterEngineFiles'],
        'baselineSha256': p.fingerprint(c['baseline']), 'workflow': p.WORKFLOW, 'workflowSha256': c['workflowSha256'],
        'updatedServices': ['online-recharge'], 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0,
        'files': {'engine/' + name: c['afterEngineFiles'][name] for name in p.FILES}}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'online-checkout-actionability-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        for path in sorted(payload.rglob('*')):
            if path.is_file():
                archive.add(path, arcname=path.relative_to(OUT).as_posix(), recursive=False)
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_CHECKOUT_ACTIONABILITY_NATIVE_BUILT', 'commit': commit,
        'runtimeSources': len(p.FILES), 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true')
    parser.add_argument('--baseline')
    parser.add_argument('--source-review')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        publisher().need(args.baseline and not args.check, 'FREEZE_ARGUMENTS_INVALID')
        freeze(args.baseline, args.source_review)
    elif args.check:
        publisher().need(not args.baseline and not args.source_review, 'ARGUMENTS_INVALID')
        check(json.loads(CONTRACT.read_bytes()))
        print(json.dumps({'status': 'ONLINE_CHECKOUT_ACTIONABILITY_SOURCE_VERIFIED', 'businessActions': 0}))
    else:
        publisher().need(not args.baseline and not args.source_review, 'ARGUMENTS_INVALID')
        main()
