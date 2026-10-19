"""Freeze reviewed initialization sources; build only on the selected native main tree."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'online-checkout-initialization'
CONTRACT = HERE / (PREFIX + '-contract.json')
OUT = ROOT / '.deploy' / PREFIX
REPORTS = ROOT / '.runtime' / (PREFIX + '-ci')


def publisher():
    spec = importlib.util.spec_from_file_location('initialization_publisher', HERE / (PREFIX + '-release.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def engine_inventory(commit, p):
    return {name.removeprefix(p.ENGINE + '/'): p.sha(git('show', commit + ':' + name))
        for name in git('ls-tree', '-r', '--name-only', commit, '--', p.ENGINE).decode().splitlines()}


def reviewed_paths(p):
    return {p.ENGINE + '/' + n for n in p.FILES} | p.VALIDATION | p.PUBLIC_CONTROLS


def verify_review(c, p):
    review = c.get('sourceReviewCommit', '')
    p.need(re.fullmatch('[a-f0-9]{40}', review) and c.get('sourceReviewTag') == PREFIX + '-source-review-' + review[:12], 'SOURCE_REVIEW_INVALID')
    tag = 'refs/tags/' + c['sourceReviewTag']
    p.need(git('cat-file', '-t', tag).decode().strip() == 'tag'
        and git('rev-parse', tag + '^{commit}').decode().strip() == review
        and git('merge-base', p.CURRENT, review).decode().strip() == p.CURRENT
        and set(git('diff', '--name-only', p.CURRENT, review).decode().splitlines()) == reviewed_paths(p), 'SOURCE_REVIEW_SCOPE_CHANGED')
    for name in reviewed_paths(p) - {'scripts/production-release/' + p.CONTRACT_FILE}:
        path = ROOT / name
        p.need(path.is_file() and not path.is_symlink() and path.read_bytes() == git('show', review + ':' + name), 'REVIEWED_SOURCE_CHANGED')


def freeze(baseline, review):
    p = publisher()
    c = {'sourceReviewCommit': review, 'sourceReviewTag': PREFIX + '-source-review-' + review[:12]}
    verify_review(c, p)
    before = engine_inventory(p.ENGINE_BASE, p)
    after = engine_inventory(review, p)
    c.update(version=1, scope=p.SCOPE, frozen=True, admission='FROZEN_REVIEWED_SOURCE', pendingBindings=[],
        expectedCurrent=p.CURRENT, engineSourceBase=p.ENGINE_BASE, reviewBase=p.CURRENT,
        engineRoot=p.ENGINE, upstreamSource=p.LEGACY.UPSTREAM_SOURCE, requiredQualityParts=list(p.QUALITY_PARTS),
        runtimeSources={p.ENGINE + '/' + n: after[n] for n in sorted(p.FILES)},
        validationSources={n: p.sha((ROOT / n).read_bytes()) for n in sorted(p.VALIDATION)},
        reviewedControlSources={n: p.sha((ROOT / n).read_bytes()) for n in sorted(p.REVIEW_CONTROLS)},
        controlPins={n: p.sha((HERE / n).read_bytes()) for n in sorted(p.CONTROLS)},
        workflowSha256=p.sha((ROOT / p.WORKFLOW).read_bytes()), beforeEngineFiles=before, afterEngineFiles=after,
        baseline=json.loads(Path(baseline).read_bytes()), engineHealth=p.HEALTH, sqlFenceHelperSha256=p.SQL_FENCE,
        updatedServices=['online-recharge'], preservedServices=list(p.PRESERVED), migrationPerformed=False, businessActions=0)
    p.validate_contract(c)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': p.SCOPE + '_SOURCE_FROZEN', 'businessActions': 0}))


def check(c):
    p = publisher(); p.validate_contract(c); verify_review(c, p)
    for name, digest in {**c['runtimeSources'], **c['validationSources'], **c['reviewedControlSources']}.items():
        p.need(not (ROOT / name).is_symlink() and p.sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
    p.need(all(not (HERE / n).is_symlink() and p.sha((HERE / n).read_bytes()) == v for n, v in c['controlPins'].items())
        and p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256'], 'CONTROL_CHANGED')
    manifest = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    actual = {row['path']: row['adaptedSha256'] for row in manifest['files']}
    p.need({k: manifest.get(k) for k in ('repository', 'commit')} == p.LEGACY.UPSTREAM_SOURCE
        and len(actual) == len(manifest['files']) and actual == {n: v for n, v in c['afterEngineFiles'].items() if n != 'SOURCE_MANIFEST.json'}
        and all(not (ROOT / p.ENGINE / n).is_symlink() and p.sha((ROOT / p.ENGINE / n).read_bytes()) == v for n, v in c['afterEngineFiles'].items()), 'SOURCE_MANIFEST_CHANGED')
    return p


def quality_evidence(commit, tree):
    p = publisher(); helper = p.load('online-checkout-actionability-build.py')
    helper.publisher = publisher
    return helper.quality_evidence(commit, tree)


def browser_evidence(identity, c, p):
    p.need(os.uname().sysname == 'Linux' and os.environ.get('SESSION_ROUTING_HEADFUL') == '1'
        and re.fullmatch(r'v22\.\d+\.\d+', subprocess.check_output(['node', '--version']).decode().strip()), 'LINUX_NODE22_REQUIRED')
    reports = (('session-routing-native.tap', 'SESSION_ROUTING', 'native', 4),
        ('session-routing-standalone.tap', 'SESSION_ROUTING', 'standalone', 4),
        ('session-routing-pool.tap', 'SESSION_ROUTING', 'pool', 4),
        ('card-preparation.tap', 'CARD_PREPARATION', 'native', 13))
    runs = []
    for filename, suite, mode, total in reports:
        path = REPORTS / filename
        p.need(path.is_file() and not path.is_symlink() and all(not parent.is_symlink() for parent in path.parents), 'BROWSER_REPORT_INVALID')
        raw = path.read_bytes(); p.need(0 < len(raw) <= 4 * 1024**2, 'BROWSER_REPORT_INVALID')
        text = raw.decode(); summary = {}
        for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
            found = re.findall(r'^# ' + key + r' ([0-9]+)$', text, re.M)
            p.need(len(found) == 1, 'BROWSER_REPORT_INVALID'); summary[key] = int(found[0])
        p.need(summary == {'tests': total, 'pass': total, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, 'BROWSER_TESTS_FAILED')
        runs.append({'suite': suite, 'mode': mode, 'passed': total, 'reportSha256': p.sha(raw)})
    evidence = {**identity, 'platform': 'linux', 'nodeVersion': subprocess.check_output(['node', '--version']).decode().strip()[1:],
        'testFiles': {n: c['afterEngineFiles'][n] for n in p.INITIALIZATION_TESTS}, 'runs': runs, 'sessionRoutingHeadful': True,
        'passed': sum(r['passed'] for r in runs), 'failed': 0, 'skipped': 0, 'todo': 0, 'businessActions': 0, 'paymentActions': 0}
    evidence['reportSha256'] = p.fingerprint(runs); p.validate_browser(evidence, identity, c)
    return evidence


def main():
    c = json.loads(CONTRACT.read_bytes()); p = check(c)
    commit, tree = git('rev-parse', 'HEAD').decode().strip(), git('rev-parse', 'HEAD^{tree}').decode().strip()
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
        and not OUT.exists() and not git('status', '--porcelain', '--untracked-files=no').strip()
        and git('merge-base', p.CURRENT, commit).decode().strip() == p.CURRENT
        and set(git('diff', '--name-only', p.CURRENT, commit).decode().splitlines()) == reviewed_paths(p)
        and engine_inventory(commit, p) == c['afterEngineFiles']
        and engine_inventory(p.ENGINE_BASE, p) == c['beforeEngineFiles'], 'NATIVE_MAIN_BUILD_REQUIRED')
    p.need(subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/git/ref/heads/main', '--jq', '.object.sha'], cwd=ROOT).decode().strip() == commit,
        'REMOTE_MAIN_MOVED')
    identity = {'commit': commit, 'tree': tree, 'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
    quality, parts = quality_evidence(commit, tree)
    evidence = browser_evidence(identity, c, p)
    payload = OUT / 'payload'; (payload / 'engine').mkdir(parents=True, mode=0o700)
    for n in p.FILES:
        target = payload / 'engine' / n; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / p.ENGINE / n, target)
    proof = {**identity, 'version': 1, 'scope': p.SCOPE, 'contractSha256': p.sha(CONTRACT.read_bytes()),
        'controlSources': c['controlPins'], 'qualitySourceEvidence': quality, 'qualityPartEvidence': parts,
        'initializationBrowserEvidence': evidence, 'runtimeSources': c['runtimeSources'],
        'beforeEngineFiles': c['beforeEngineFiles'], 'afterEngineFiles': c['afterEngineFiles'],
        'baselineSha256': p.fingerprint(c['baseline']), 'workflowSha256': c['workflowSha256'],
        'updatedServices': ['online-recharge'], 'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0,
        'files': {'engine/' + n: c['afterEngineFiles'][n] for n in p.FILES}}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / (PREFIX + '-artifact.tar.gz')
    with tarfile.open(bundle, 'w:gz') as archive:
        for path in sorted(payload.rglob('*')):
            if path.is_file(): archive.add(path, arcname=path.relative_to(OUT).as_posix(), recursive=False)
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': p.SCOPE + '_NATIVE_BUILT', 'commit': commit, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true'); parser.add_argument('--baseline'); parser.add_argument('--source-review'); parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        publisher().need(args.baseline and args.source_review and not args.check, 'FREEZE_ARGUMENTS_INVALID'); freeze(args.baseline, args.source_review)
    elif args.check:
        check(json.loads(CONTRACT.read_bytes())); print(json.dumps({'status': 'SOURCE_VERIFIED', 'businessActions': 0}))
    else:
        publisher().need(not args.baseline and not args.source_review, 'ARGUMENTS_INVALID'); main()
