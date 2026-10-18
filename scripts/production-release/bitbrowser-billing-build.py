"""Native build of the reviewed recharge overlay over reproduced published inputs."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / '.deploy/bitbrowser-billing'
CONTRACT = HERE / 'bitbrowser-billing-contract.json'


def load(name):
    spec = importlib.util.spec_from_file_location('billing_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def freeze(path, source):
    p = load('bitbrowser-billing-release.py')
    source = git('rev-parse', source + '^{commit}').decode().strip()
    sources = git('diff', '--name-only', p.CURRENT, source).decode().splitlines()
    previous = json.loads((HERE / 'online-query-network-contract.json').read_bytes())
    # Its native proof is independently tied to the published API/Admin build.
    proof_path = Path(path).parent / 'predecessor-artifact/build-proof.json'
    proof_raw = proof_path.read_bytes()
    proof = json.loads(proof_raw)
    p.need(proof['commit'] == p.PUBLISHED_BUILD and proof['scope'] == 'ONLINE_QUERY_NETWORK_REPAIR'
        and proof['contractSha256'] == p.sha((HERE / 'online-query-network-contract.json').read_bytes()),
        'PREDECESSOR_PROOF_INVALID')
    c = {'version': 1, 'scope': p.SCOPE, 'expectedCurrent': p.CURRENT, 'reviewBase': p.CURRENT,
        'sourceReviewCommit': source, 'sources': {n: p.sha(git('show', source + ':' + n)) for n in sources},
        'apiModules': sorted(n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
            for n in p.API_SOURCES for suffix in ('.js', '.d.ts', '.js.map')),
        'sharedFiles': sorted(p.SHARED), 'controlPins': {n: p.sha((HERE / n).read_bytes()) for n in p.CONTROLS},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'qualityWorkflowSha256': p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()),
        'predecessorProofSha256': p.sha(proof_raw), 'publishedAdminFiles': proof['adminFiles'],
        'baseline': json.loads(Path(path).read_bytes()), 'reconstructionContractSha256':
            p.sha((HERE / 'online-query-network-contract.json').read_bytes()),
        'engineHealth': {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True},
        'migrationPerformed': False, 'businessActions': 0}
    p.need(previous['expectedCurrent'] == '320b5281b27b1e5c0fda1b6abfcbe87f16ff9dde', 'RECONSTRUCTION_CHANGED')
    p.validate_contract(c)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')


def check(c):
    p = load('bitbrowser-billing-release.py')
    p.validate_contract(c)
    p.need(set(git('diff', '--name-only', p.CURRENT, c['sourceReviewCommit']).decode().splitlines())
        == set(c['sources']), 'REVIEW_SCOPE_CHANGED')
    for name, expected in c['sources'].items():
        path = ROOT / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == expected
            == p.sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'SOURCE_CHANGED')
    for name, expected in c['controlPins'].items():
        p.need((HERE / name).is_file() and not (HERE / name).is_symlink()
            and p.sha((HERE / name).read_bytes()) == expected, 'CONTROL_CHANGED')
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256']
        and p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()) == c['qualityWorkflowSha256']
        and p.sha((HERE / 'online-query-network-contract.json').read_bytes()) == c['reconstructionContractSha256'],
        'WORKFLOW_OR_RECONSTRUCTION_CHANGED')
    p.need(not git('diff', p.CURRENT, 'HEAD', '--', 'apps/api/prisma-mysql/', 'package.json',
        'package-lock.json', 'apps/api/package.json', 'apps/admin/package.json').strip(), 'DEPENDENCY_OR_SCHEMA_CHANGED')
    public_controls = {p.WORKFLOW, *['scripts/production-release/bitbrowser-billing-' + suffix
        for suffix in ('build.py', 'release.py', 'dispatch.py', 'release.test.py', 'contract.json')]}
    changed = set(git('diff', '--name-only', p.CURRENT, 'HEAD').decode().splitlines())
    p.need(changed <= set(c['sources']) | public_controls and set(c['sources']) <= changed,
        'FINITE_SELECTION_CHANGED')
    return p


def overlay(context, sources, commit):
    p = load('bitbrowser-billing-release.py')
    for name, expected in sources.items():
        path = context / name
        p.need(path.resolve().is_relative_to(context.resolve()) and not path.is_symlink(), 'OVERLAY_PATH_INVALID')
        if expected is None:
            if path.exists():
                path.unlink()
        else:
            raw = git('show', commit + ':' + name)
            p.need(p.sha(raw) == expected, 'OVERLAY_SOURCE_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)


def reconstruct():
    p = load('bitbrowser-billing-release.py')
    previous = load('online-query-network-build.py')
    previous.OUT = OUT / 'reconstruction'
    previous.OUT.mkdir(mode=0o700)
    c = json.loads((HERE / 'online-query-network-contract.json').read_bytes())
    api, admin = previous.reconstruct(c)
    retirement = json.loads(git('show', c['expectedCurrent'] + ':scripts/production-release/feature-retirement-contract.json'))
    overlay(api, {n: v for n, v in retirement['sources'].items()
        if n.startswith(('apps/api/', 'packages/shared/'))}, c['expectedCurrent'])
    overlay(api, {n: v for n, v in c['sources'].items()
        if n.startswith(('apps/api/', 'packages/shared/')) and '/engine/' not in n}, p.CURRENT)
    overlay(admin, {n: v for n, v in c['sources'].items()
        if n.startswith(('apps/admin/', 'packages/shared/'))}, p.CURRENT)
    return api, admin


def reviewed_projection(commit, c):
    p = load('bitbrowser-billing-release.py')
    p.need(commit == c['sourceReviewCommit'], 'REVIEW_COMMIT_CHANGED')
    # GitHub squash merges rewrite ancestry; frozen file bytes retain review identity.
    for name, expected in c['sources'].items():
        p.need(p.sha(git('show', commit + ':' + name)) == expected
            == p.sha(git('show', 'HEAD:' + name)), 'REVIEW_SOURCE_PROJECTION_CHANGED')


def quality(commit, *, reviewed_source=False):
    p = load('bitbrowser-billing-release.py')
    response = json.loads(subprocess.check_output(['gh', 'api',
        'repos/wangchaozhuanyong/id-business-system/actions/workflows/quality.yml/runs?head_sha=' + commit], cwd=ROOT))
    rows = [r for r in response['workflow_runs'] if r['head_sha'] == commit
        and (r['event'] == 'pull_request' if reviewed_source else r['event'] == 'push' and r['head_branch'] == 'main')
        and r['path'] == '.github/workflows/quality.yml' and r['conclusion'] == 'success']
    p.need(bool(rows), 'MAIN_QUALITY_NOT_PASSED')
    if reviewed_source:
        reviewed_projection(commit, json.loads(CONTRACT.read_bytes()))
        jobs = json.loads(subprocess.check_output(['gh', 'api',
            'repos/wangchaozhuanyong/id-business-system/actions/runs/' + str(rows[0]['id']) + '/jobs?per_page=100'], cwd=ROOT))
        p.need(any(j['name'] == 'full-quality' and j['conclusion'] == 'success' for j in jobs['jobs']),
            'REVIEW_FULL_QUALITY_NOT_PASSED')
    return {'commit': commit, 'tree': git('rev-parse', commit + '^{tree}').decode().strip(),
        'runId': str(rows[0]['id']), 'runAttempt': str(rows[0]['run_attempt']), 'conclusion': 'success',
        'event': rows[0]['event']}


def mysql(c, identity):
    p = load('bitbrowser-billing-release.py')
    raw = (ROOT / '.runtime/bitbrowser-billing/mysql-vitest.json').read_bytes()
    value = json.loads(raw)
    files = value.get('testResults', [])
    p.need(value.get('success') is True and value.get('numTotalTests') == value.get('numPassedTests') == 13
        and all(value.get(k) == 0 for k in ('numFailedTests', 'numPendingTests', 'numTodoTests',
            'numFailedTestSuites', 'numPendingTestSuites'))
        and {Path(f['name']).resolve() for f in files} == {ROOT / n for n in p.MYSQL_FILES}
        and all(f.get('status') == 'passed' and all(a.get('status') == 'passed' for a in f['assertionResults'])
            for f in files), 'MYSQL_TESTS_NOT_PASSED')
    report = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
        'testFiles': {n: c['sources'][n] for n in p.MYSQL_FILES}, 'testsTotal': 13, 'testsPassed': 13,
        'testsSkipped': 0, 'testsTodo': 0, 'productionActions': 0, 'reportSha256': p.sha(raw)}
    p.verify_mysql(report, identity, c)
    return report


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
    quality_evidence = {'release': quality(commit), 'sources': quality(c['sourceReviewCommit'], reviewed_source=True)}
    mysql_evidence = mysql(c, identity)
    OUT.mkdir(mode=0o700, parents=True)
    api, admin = reconstruct()
    inventory = load('recharge-record-release.py').file_inventory
    outputs = {}
    for role, before in (('api', api), ('admin', admin)):
        candidate = OUT / (role + '-candidate')
        shutil.copytree(before, candidate)
        overlay(candidate, {n: v for n, v in c['sources'].items()
            if n.startswith(('apps/' + role + '/', 'packages/shared/'))}, c['sourceReviewCommit'])
        for variant, context in (('baseline', before), ('candidate', candidate)):
            env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (p.PUBLISHED_BUILD if variant == 'baseline' else commit)}
            commands = [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                ('npm', 'run', 'build', '--workspace', '@apple-business/shared')]
            if role == 'api':
                commands.append(('npm', 'run', 'prisma:mysql:generate'))
            commands.append(('npm', 'run', 'build', '--workspace', '@apple-business/' + role))
            for args in commands:
                subprocess.run(args, cwd=context, env=env, check=True)
            outputs[role + '-' + variant] = {'api': inventory(context / ('apps/' + role + '/dist')),
                'shared': inventory(context / 'packages/shared/dist')}
    p.need(outputs['admin-baseline']['api'] == c['publishedAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    actual_delta = {n for n in set(outputs['api-baseline']['api']) | set(outputs['api-candidate']['api'])
        if outputs['api-baseline']['api'].get(n) != outputs['api-candidate']['api'].get(n)}
    p.need(actual_delta <= set(c['apiModules']) | {'tsconfig.build.tsbuildinfo'},
        'UNSELECTED_API_OUTPUT_CHANGED')
    declaration_differences = []
    for name, expected in c['baseline']['apiBaselineFiles'].items():
        files = outputs['api-baseline']['api' if name.startswith('apps/api/') else 'shared']
        relative = name.removeprefix('apps/api/dist/').removeprefix('packages/shared/dist/')
        if files.get(relative) != expected:
            p.need(name.endswith('.d.ts'), 'BASE_RUNTIME_NOT_REPRODUCED')
            declaration_differences.append(name)
    payload = OUT / 'payload'
    for names, context, folder, destination in ((c['apiModules'], OUT / 'api-candidate', 'apps/api/dist', 'api/modules'),
        (c['sharedFiles'], OUT / 'api-candidate', 'packages/shared/dist', 'api/shared')):
        for name in names:
            target = payload / destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(context / folder / name, target)
    shutil.copytree(OUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {**identity, 'version': 1, 'scope': p.SCOPE, 'contractSha256': p.sha(CONTRACT.read_bytes()),
        'sources': c['sources'], 'controlSources': c['controlPins'],
        'apiModules': inventory(payload / 'api/modules'), 'sharedFiles': inventory(payload / 'api/shared'),
        'adminFiles': inventory(payload / 'admin/html'), 'files': inventory(payload),
        'qualityVerification': quality_evidence, 'isolatedMysqlVerification': mysql_evidence,
        'predecessorProofSha256': c['predecessorProofSha256'], 'baselineRuntimeReproduced': True,
        'baselineAdminReproduced': True, 'baselineDeclarationDifferences': sorted(declaration_differences),
        'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, proof, c, payload, load('recharge-record-release.py'))
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'recharge-checkout-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BITBROWSER_BILLING_NATIVE_BUILT', **identity, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', nargs=2, metavar=('BASELINE', 'SOURCE_REVIEW_COMMIT'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        freeze(*args.freeze)
    elif args.check:
        check(json.loads(CONTRACT.read_bytes()))
        print('{"sourceCheck":"passed","productionActions":0}')
    else:
        main()
