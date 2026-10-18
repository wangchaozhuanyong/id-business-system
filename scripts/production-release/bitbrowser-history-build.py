"""Reproduce the exact published recovery API, then build only the reviewed history delta."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / '.deploy/bitbrowser-history'
CONTRACT = HERE / 'bitbrowser-history-contract.json'
PREDECESSOR = ROOT / '.runtime/plus-unusual-activity-20261018/release-20261019/native-publication/build-proof.json'


def load(name):
    spec = importlib.util.spec_from_file_location('history_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def predecessor(raw, p):
    proof = json.loads(raw)
    p.need(p.sha(raw) == p.PREDECESSOR_PROOF and proof.get('commit') == p.CURRENT
        and proof.get('scope') == 'BITBROWSER_PAYMENT_RECOVERY_20261019'
        and proof.get('contractSha256') == p.PREDECESSOR_CONTRACT
        and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0,
        'PREDECESSOR_PROOF_INVALID')
    return proof


def freeze(baseline, source, proof_path):
    p = load('bitbrowser-history-release.py')
    source = git('rev-parse', source + '^{commit}').decode().strip()
    p.need(set(git('diff', '--name-only', p.CURRENT, source).decode().splitlines()) == p.APPLICATION,
        'REVIEW_SCOPE_CHANGED')
    proof = predecessor(Path(proof_path).read_bytes(), p)
    c = {'version': 1, 'status': 'FROZEN', 'scope': p.SCOPE, 'expectedCurrent': p.CURRENT,
        'reviewBase': p.CURRENT, 'sourceReviewCommit': source,
        'sources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.APPLICATION)},
        'apiModules': sorted(p.MODULES), 'updatedServices': ['api'], 'reboundServices': ['online-recharge'],
        'preservedServices': list(p.PRESERVED), 'engineHealth': p.ENGINE,
        'controlPins': {n: p.sha((HERE / n).read_bytes()) for n in sorted(p.CONTROLS)},
        'ciControlPins': {n: p.sha((ROOT / n).read_bytes()) for n in sorted(p.CI_CONTROLS)},
        'mysqlTestSources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.MYSQL_FILES)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'qualityWorkflowSha256': p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()),
        'predecessorProofSha256': p.PREDECESSOR_PROOF, 'publishedApiModules': proof['apiModules'],
        'publishedSharedFiles': proof['sharedFiles'], 'sqlFenceHelperSha256': p.sha((HERE / 'api-admin-scope.py').read_bytes()),
        'baseline': json.loads(Path(baseline).read_bytes()), 'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    p.need(all(c['baseline']['apiModules'][n] == proof['apiModules'][n] for n in p.MODULES),
        'NATIVE_BASELINE_MODULE_CHANGED')
    for name in p.INHERITED:
        p.need(c['controlPins'][name] == p.sha(git('show', p.CURRENT + ':scripts/production-release/' + name)),
            'INHERITED_CONTROL_CHANGED')
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')


def check(c):
    p = load('bitbrowser-history-release.py')
    p.validate_contract(c)
    p.need(set(git('diff', '--name-only', p.CURRENT, c['sourceReviewCommit']).decode().splitlines()) == p.APPLICATION,
        'REVIEW_SCOPE_CHANGED')
    for name, expected in c['sources'].items():
        path = ROOT / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == expected
            == p.sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'SOURCE_CHANGED')
    for name, expected in c['mysqlTestSources'].items():
        p.need(p.sha((ROOT / name).read_bytes()) == expected
            == p.sha(git('show', c['sourceReviewCommit'] + ':' + name))
            == p.sha(git('show', p.CURRENT + ':' + name)), 'MYSQL_SOURCE_CHANGED')
    for name, expected in c['controlPins'].items():
        path = HERE / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == expected, 'CONTROL_CHANGED')
        if name in p.INHERITED:
            p.need(expected == p.sha(git('show', p.CURRENT + ':scripts/production-release/' + name)), 'INHERITED_CONTROL_CHANGED')
    for name, expected in c['ciControlPins'].items():
        p.need(p.sha((ROOT / name).read_bytes()) == expected, 'CI_CONTROL_CHANGED')
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256']
        and p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()) == c['qualityWorkflowSha256'], 'WORKFLOW_CHANGED')
    public = {p.WORKFLOW, *('scripts/production-release/bitbrowser-history-' + n
        for n in ('build.py', 'release.py', 'dispatch.py', 'release.test.py', 'contract.json'))}
    # The same closed file set can be reviewed before commit; native main builds
    # additionally require a clean tracked tree in main(). Untracked controls are
    # included here so an unrelated file cannot silently enter the prepared scope.
    changed = set(git('diff', '--name-only', p.CURRENT).decode().splitlines()) \
        | set(git('ls-files', '--others', '--exclude-standard').decode().splitlines())
    p.need(git('merge-base', p.CURRENT, 'HEAD').decode().strip() == p.CURRENT
        and changed == p.APPLICATION | public | (changed & p.CI_CONTROLS), 'FINITE_SELECTION_CHANGED')
    return p


def overlay(context, sources, commit):
    p = load('bitbrowser-history-release.py')
    for name, digest in sources.items():
        raw = git('show', commit + ':' + name)
        p.need(p.sha(raw) == digest, 'OVERLAY_SOURCE_CHANGED')
        path = context / name
        p.need(path.resolve().is_relative_to(context.resolve()) and not path.is_symlink(), 'OVERLAY_PATH_INVALID')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def reconstruct():
    p = load('bitbrowser-history-release.py')
    previous = load('bitbrowser-recovery-build.py')
    previous.OUT = OUT / 'predecessor-reconstruction'
    previous.OUT.mkdir(mode=0o700)
    api, _unused_admin_source = previous.reconstruct()
    old = json.loads((HERE / 'bitbrowser-recovery-contract.json').read_bytes())
    p.need(p.sha((HERE / 'bitbrowser-recovery-contract.json').read_bytes()) == p.PREDECESSOR_CONTRACT,
        'RECONSTRUCTION_CONTRACT_CHANGED')
    overlay(api, {n: v for n, v in old['sources'].items() if n.startswith(('apps/api/', 'packages/shared/'))},
        old['sourceReviewCommit'])
    return api


def require_quality_jobs(rows, p):
    names = {r.get('name', '').replace(' ', '') for r in rows if r.get('conclusion') == 'success'}
    p.need('full-quality' in names or {'recharge(guards)', 'recharge(api)'} <= names,
        'SOURCE_API_QUALITY_NOT_PASSED')


def quality(commit, c, *, source=False):
    p = load('bitbrowser-history-release.py')
    response = json.loads(subprocess.check_output(['gh', 'api',
        'repos/wangchaozhuanyong/id-business-system/actions/workflows/quality.yml/runs?head_sha=' + commit], cwd=ROOT))
    rows = [r for r in response['workflow_runs'] if r['head_sha'] == commit
        and (r['event'] == 'pull_request' if source else r['event'] == 'push' and r['head_branch'] == 'main')
        and r['path'] == '.github/workflows/quality.yml' and r['conclusion'] == 'success']
    p.need(bool(rows), 'QUALITY_NOT_PASSED')
    if source:
        p.need(commit == c['sourceReviewCommit'], 'SOURCE_REVIEW_CHANGED')
        for name, digest in c['sources'].items():
            p.need(p.sha(git('show', commit + ':' + name)) == digest
                == p.sha(git('show', 'HEAD:' + name)), 'SOURCE_PROJECTION_CHANGED')
        jobs = json.loads(subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/runs/'
            + str(rows[0]['id']) + '/attempts/' + str(rows[0]['run_attempt']) + '/jobs?per_page=100'], cwd=ROOT))
        require_quality_jobs(jobs['jobs'], p)
    return {'commit': commit, 'tree': git('rev-parse', commit + '^{tree}').decode().strip(),
        'runId': str(rows[0]['id']), 'runAttempt': str(rows[0]['run_attempt']), 'event': rows[0]['event'], 'conclusion': 'success'}


def mysql(c, identity):
    p = load('bitbrowser-history-release.py')
    raw = (ROOT / '.runtime/bitbrowser-history/mysql-vitest.json').read_bytes()
    result = json.loads(raw)
    p.need(result.get('success') is True and result.get('numTotalTests') == result.get('numPassedTests') == 18
        and all(result.get(n) == 0 for n in ('numFailedTests', 'numPendingTests', 'numTodoTests',
            'numFailedTestSuites', 'numPendingTestSuites'))
        and {Path(f['name']).resolve() for f in result.get('testResults', [])} == {ROOT / n for n in p.MYSQL_FILES}
        and all(f.get('status') == 'passed' and all(a.get('status') == 'passed' for a in f['assertionResults'])
            for f in result['testResults']), 'MYSQL_TESTS_NOT_PASSED')
    proof = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
        'testFiles': c['mysqlTestSources'], 'testsTotal': 18, 'testsPassed': 18, 'testsSkipped': 0,
        'testsTodo': 0, 'productionActions': 0, 'reportSha256': p.sha(raw)}
    p.verify_mysql(proof, identity, c)
    return proof


def verify_delta(before, after, shared_before, shared_after, c, p):
    p.need({n: before.get(n) for n in c['publishedApiModules']} == c['publishedApiModules']
        and {n: before.get(n) for n in p.MODULES} == c['baseline']['apiModules'], 'BASE_API_NOT_REPRODUCED')
    extra = {n for n in set(before) | set(after) if before.get(n) != after.get(n)} - p.MODULES - {'tsconfig.build.tsbuildinfo'}
    p.need(not extra, 'UNSELECTED_API_OUTPUT_CHANGED')
    p.need(shared_before == shared_after
        and {n: shared_before.get(n) for n in c['publishedSharedFiles']} == c['publishedSharedFiles'], 'SHARED_OUTPUT_CHANGED')
    p.need(all(n in after for n in p.MODULES) and any(before[n] != after[n] for n in p.MODULES if n.endswith('.js')),
        'EXPECTED_API_DELTA_MISSING')


def main():
    c = json.loads(CONTRACT.read_bytes())
    p = check(c)
    commit = git('rev-parse', 'HEAD').decode().strip()
    identity = {'commit': commit, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
        and not OUT.exists() and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    qa = {'release': quality(commit, c), 'sources': quality(c['sourceReviewCommit'], c, source=True)}
    mysql_evidence = mysql(c, identity)
    OUT.mkdir(mode=0o700, parents=True)
    before = reconstruct()
    candidate = OUT / 'api-candidate'
    shutil.copytree(before, candidate)
    overlay(candidate, c['sources'], c['sourceReviewCommit'])
    h = load('recharge-record-release.py')
    outputs = []
    for context in (before, candidate):
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + p.CURRENT}
        for args in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/shared'), ('npm', 'run', 'prisma:mysql:generate'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/api')):
            subprocess.run(args, cwd=context, env=env, check=True)
        outputs.append((h.file_inventory(context / 'apps/api/dist'), h.file_inventory(context / 'packages/shared/dist')))
    verify_delta(outputs[0][0], outputs[1][0], outputs[0][1], outputs[1][1], c, p)
    payload = OUT / 'payload'
    for name in p.MODULES:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, target)
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {**identity, 'version': 1, 'scope': p.SCOPE, 'contractSha256': p.sha(CONTRACT.read_bytes()),
        'sources': c['sources'], 'controlSources': c['controlPins'], 'apiModules': h.file_inventory(payload / 'api/modules'),
        'files': h.file_inventory(payload), 'qualityVerification': qa, 'isolatedMysqlVerification': mysql_evidence,
        'baselineModulesReproduced': c['baseline']['apiModules'], 'predecessorProofSha256': p.PREDECESSOR_PROOF,
        'baselineSharedUnchanged': True, 'updatedServices': ['api'], 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BITBROWSER_HISTORY_NATIVE_BUILT', **identity, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', nargs=2, metavar=('BASELINE', 'SOURCE_REVIEW_COMMIT'))
    parser.add_argument('--predecessor-proof', default=str(PREDECESSOR))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        freeze(*args.freeze, args.predecessor_proof)
    elif args.check:
        check(json.loads(CONTRACT.read_bytes()))
        print('{"sourceCheck":"passed","businessActions":0}')
    else:
        main()
