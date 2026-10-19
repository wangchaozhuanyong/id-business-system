"""Reproduce the exact published recovery API, then build only the reviewed history delta."""
import argparse
import importlib.util
import json
import io
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / '.deploy/bitbrowser-history'
CONTRACT = HERE / 'bitbrowser-history-contract.json'
RECIPE = 'history-20261019'
PREDECESSOR = ROOT / '.runtime/plus-unusual-activity-20261018/release-20261019/native-publication/build-proof.json'


def load(name):
    spec = importlib.util.spec_from_file_location('history_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if name == 'bitbrowser-history-release.py':
        module.select_recipe(RECIPE)
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
    required = ({'recharge(guards)', 'recharge(admin)'} if p.RECIPE == p.ADDRESS else
        {'recharge(guards)', 'recharge(api)'} | ({'recharge(admin)'} if p.RECIPE == p.FOLLOWUP else set()))
    p.need('full-quality' in names or required <= names,
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



def followup_freeze(baseline, source, proof_path, admin_proof_path):
    p = load('bitbrowser-history-release.py')
    source = git('rev-parse', source + '^{commit}').decode().strip()
    p.need(set(git('diff', '--name-only', p.CURRENT, source).decode().splitlines()) == p.APPLICATION, 'REVIEW_SCOPE_CHANGED')
    raw, admin_raw = Path(proof_path).read_bytes(), Path(admin_proof_path).read_bytes()
    previous, admin = json.loads(raw), json.loads(admin_raw)
    p.need(p.sha(raw) == p.FOLLOWUP_PROOF and previous.get('commit') == p.CURRENT
        and previous.get('scope') == 'BITBROWSER_HISTORY_PAGINATION_20261019'
        and previous.get('contractSha256') == p.LEGACY_CONTRACT_SHA
        and p.sha(admin_raw) == p.ADMIN_PROOF and admin.get('commit') == p.ADMIN_BUILD, 'PREDECESSOR_PROOF_INVALID')
    old = json.loads((HERE / 'bitbrowser-history-contract.json').read_bytes())
    source_tree = git('rev-parse', source + '^{tree}').decode().strip()
    selector = ROOT / 'scripts/ci-recharge-scope.mjs'
    selector_text = selector.read_text()
    import re
    for key, value in (('Commit', source), ('Tree', source_tree)):
        selector_text, count = re.subn(r"(export const bitbrowserFollowupSourceReview" + key + r" = ')[^']+(';?)", lambda m: m[1] + value + m[2], selector_text)
        p.need(count == 1, 'FOLLOWUP_SELECTOR_MISSING')
    selector.write_text(selector_text)
    c = {'version': 1, 'status': 'FROZEN', 'recipe': p.FOLLOWUP, 'scope': p.SCOPE,
        'expectedCurrent': p.CURRENT, 'reviewBase': p.CURRENT, 'sourceReviewCommit': source,
        'sourceReviewTree': git('rev-parse', source + '^{tree}').decode().strip(),
        'sources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.APPLICATION)},
        'apiModules': sorted(p.MODULES), 'updatedServices': list(p.UPDATED), 'reboundServices': ['online-recharge'],
        'preservedServices': list(p.PRESERVED), 'engineHealth': p.ENGINE,
        'controlPins': {n: p.sha((HERE / n).read_bytes()) for n in sorted(p.CONTROLS)},
        'ciControlPins': {n: p.sha((ROOT / n).read_bytes()) for n in sorted(p.CI_CONTROLS)},
        'mysqlTestSources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.MYSQL_FILES)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'qualityWorkflowSha256': p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()),
        'predecessorProofSha256': p.FOLLOWUP_PROOF,
        'publishedApiModules': {**old['publishedApiModules'], **previous['apiModules']},
        'publishedSharedFiles': old['publishedSharedFiles'], 'publishedAdminFiles': admin['adminFiles'],
        'adminBuildCommit': p.ADMIN_BUILD, 'adminProofSha256': p.ADMIN_PROOF,
        'sqlFenceHelperSha256': p.sha((HERE / 'api-admin-scope.py').read_bytes()),
        'baseline': json.loads(Path(baseline).read_bytes()), 'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    for n in p.INHERITED:
        p.need(c['controlPins'][n] == p.sha(git('show', p.CURRENT + ':scripts/production-release/' + n)), 'INHERITED_CONTROL_CHANGED')
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')


def followup_check(c):
    p = load('bitbrowser-history-release.py')
    p.validate_contract(c)
    p.need(git('rev-parse', c['sourceReviewCommit'] + '^{tree}').decode().strip() == c['sourceReviewTree']
        and set(git('diff', '--name-only', p.CURRENT, c['sourceReviewCommit']).decode().splitlines()) == p.APPLICATION,
        'REVIEW_SCOPE_CHANGED')
    for n, expected in {**c['sources'], **c['mysqlTestSources']}.items():
        path = ROOT / n
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == expected
            == p.sha(git('show', c['sourceReviewCommit'] + ':' + n)), 'SOURCE_CHANGED')
    for n in p.MYSQL_FILES:
        p.need(c['mysqlTestSources'][n] == p.sha(git('show', p.CURRENT + ':' + n)), 'MYSQL_SOURCE_CHANGED')
    if p.RECIPE == p.ADDRESS:
        p.need(c['mysqlInheritance']['inputs'] == mysql_inputs(c['sourceReviewCommit']) == mysql_inputs(p.CURRENT)
            == mysql_inputs('HEAD'), 'INHERITED_MYSQL_INPUT_CHANGED')
    for n, expected in c['controlPins'].items():
        p.need((HERE / n).is_file() and not (HERE / n).is_symlink() and p.sha((HERE / n).read_bytes()) == expected, 'CONTROL_CHANGED')
        if n in p.INHERITED:
            p.need(expected == p.sha(git('show', p.CURRENT + ':scripts/production-release/' + n)), 'INHERITED_CONTROL_CHANGED')
    for n, expected in c['ciControlPins'].items():
        p.need(p.sha((ROOT / n).read_bytes()) == expected, 'CI_CONTROL_CHANGED')
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256']
        and p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()) == c['qualityWorkflowSha256'], 'WORKFLOW_CHANGED')
    public = {p.WORKFLOW, 'scripts/production-release/' + p.CONTRACT_FILE,
        *('scripts/production-release/bitbrowser-history-' + n for n in ('build.py', 'release.py', 'dispatch.py', 'release.test.py')), *p.CI_CONTROLS}
    changed = set(git('diff', '--name-only', p.CURRENT).decode().splitlines()) | set(git('ls-files', '--others', '--exclude-standard').decode().splitlines())
    p.need(git('merge-base', p.CURRENT, 'HEAD').decode().strip() == p.CURRENT and changed == p.APPLICATION | public, 'FINITE_SELECTION_CHANGED')
    return p


def reconstruct_followup(p):
    previous = load('bitbrowser-recovery-build.py')
    previous.OUT = OUT / 'published-reconstruction'
    previous.OUT.mkdir(mode=0o700)
    api, admin = previous.reconstruct()
    old = json.loads((HERE / 'bitbrowser-recovery-contract.json').read_bytes())
    for role, context in (('api', api), ('admin', admin)):
        overlay(context, {n: v for n, v in old['sources'].items() if n.startswith(('apps/' + role + '/', 'packages/shared/'))}, p.ADMIN_SOURCE)
    history = json.loads((HERE / 'bitbrowser-history-contract.json').read_bytes())
    overlay(api, history['sources'], p.HISTORY_SOURCE)
    return api, admin


def entry_freeze(proof_path, source):
    p = load('bitbrowser-history-release.py')
    source = git('rev-parse', source + '^{commit}').decode().strip()
    p.need(set(git('diff', '--name-only', p.CURRENT, source).decode().splitlines()) == p.APPLICATION, 'REVIEW_SCOPE_CHANGED')
    raw = Path(proof_path).read_bytes()
    previous = json.loads(raw)
    old_raw = (HERE / 'bitbrowser-followup-contract.json').read_bytes()
    p.need(p.sha(raw) == p.ENTRY_PROOF and previous.get('commit') == p.ENTRY_CURRENT
        and previous.get('contractSha256') == p.FOLLOWUP_CONTRACT_SHA
        and p.sha(old_raw) == p.FOLLOWUP_CONTRACT_SHA, 'PREDECESSOR_PROOF_INVALID')
    old = json.loads(old_raw)
    source_tree = git('rev-parse', source + '^{tree}').decode().strip()
    import re
    selector = ROOT / 'scripts/ci-recharge-scope.mjs'
    text = selector.read_text()
    for key, value in (('Commit', source), ('Tree', source_tree)):
        text, count = re.subn(r"(export const bitbrowserEntryStartSourceReview" + key + r" = ')[^']+(';?)", lambda m: m[1] + value + m[2], text)
        p.need(count == 1, 'ENTRY_SELECTOR_MISSING')
    selector.write_text(text)
    published = {**old['publishedApiModules'], **previous['apiModules']}
    c = {'version': 1, 'status': 'FROZEN', 'recipe': p.ENTRY, 'scope': p.SCOPE,
        'expectedCurrent': p.CURRENT, 'reviewBase': p.CURRENT, 'sourceReviewCommit': source, 'sourceReviewTree': source_tree,
        'sources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.APPLICATION)},
        'apiModules': sorted(p.MODULES), 'updatedServices': list(p.UPDATED), 'reboundServices': ['online-recharge'],
        'preservedServices': list(p.PRESERVED), 'engineHealth': p.ENGINE,
        'controlPins': {n: p.sha((HERE / n).read_bytes()) for n in sorted(p.CONTROLS)},
        'ciControlPins': {n: p.sha((ROOT / n).read_bytes()) for n in sorted(p.CI_CONTROLS)},
        'mysqlTestSources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.MYSQL_FILES)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'qualityWorkflowSha256': p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()),
        'predecessorProofSha256': p.ENTRY_PROOF, 'publishedApiModules': published, 'publishedSharedFiles': old['publishedSharedFiles'],
        'sqlFenceHelperSha256': p.sha((HERE / 'api-admin-scope.py').read_bytes()),
        'baseline': {'commit': p.CURRENT, 'apiModules': {n: published[n] for n in p.MODULES}},
        'parentNative': {'commit': p.ENTRY_CURRENT, 'tree': p.ENTRY_TREE, 'proofSha256': p.ENTRY_PROOF,
            'contractSha256': p.FOLLOWUP_CONTRACT_SHA, 'workflowRunId': '39199575083', 'apiImage': p.ENTRY_API_IMAGE},
        'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    for n in p.INHERITED:
        p.need(c['controlPins'][n] == p.sha(git('show', p.CURRENT + ':scripts/production-release/' + n)), 'INHERITED_CONTROL_CHANGED')
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')


def reconstruct_entry(p):
    api, _unused_admin = reconstruct_followup(p)
    old = json.loads((HERE / 'bitbrowser-followup-contract.json').read_bytes())
    overlay(api, {n: v for n, v in old['sources'].items() if n.startswith('apps/api/')}, old['sourceReviewCommit'])
    return api


def entry_main(c):
    p = followup_check(c)
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
    before = reconstruct_entry(p)
    candidate = OUT / 'api-candidate'
    shutil.copytree(before, candidate)
    overlay(candidate, c['sources'], c['sourceReviewCommit'])
    h = load('recharge-record-release.py')
    outputs = []
    for context in (before, candidate):
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + p.ADMIN_BUILD}
        for args in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/shared'), ('npm', 'run', 'prisma:mysql:generate'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/api')):
            subprocess.run(args, cwd=context, env=env, check=True)
        outputs.append((h.file_inventory(context / 'apps/api/dist'), h.file_inventory(context / 'packages/shared/dist')))
    verify_delta(outputs[0][0], outputs[1][0], outputs[0][1], outputs[1][1], c, p)
    payload = OUT / 'payload'
    for n in p.MODULES:
        target = payload / 'api/modules' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / n, target)
    for n in c['sources']:
        target = payload / 'source' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / n, target)
    proof = {**identity, 'version': 1, 'recipe': p.ENTRY, 'scope': p.SCOPE,
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'sources': c['sources'], 'controlSources': c['controlPins'],
        'apiModules': h.file_inventory(payload / 'api/modules'), 'files': h.file_inventory(payload),
        'qualityVerification': qa, 'isolatedMysqlVerification': mysql_evidence,
        'baselineModulesReproduced': c['baseline']['apiModules'], 'predecessorProofSha256': p.ENTRY_PROOF,
        'baselineSharedUnchanged': True, 'updatedServices': list(p.UPDATED), 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BITBROWSER_ENTRY_START_NATIVE_BUILT', **identity, 'businessActions': 0}))


def verify_followup_admin(before, shared_before, shared_after, c, p):
    p.need(before == c['publishedAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    p.need(shared_before == shared_after, 'SHARED_OUTPUT_CHANGED')


def followup_main(c):
    p = followup_check(c)
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
    api, admin = reconstruct_followup(p)
    h = load('recharge-record-release.py')
    outputs = {}
    for role, before in (('api', api), ('admin', admin)):
        candidate = OUT / (role + '-candidate')
        shutil.copytree(before, candidate)
        overlay(candidate, {n: v for n, v in c['sources'].items() if n.startswith('apps/' + role + '/')}, c['sourceReviewCommit'])
        for variant, context in (('baseline', before), ('candidate', candidate)):
            build_id = commit if role == 'admin' and variant == 'candidate' else p.ADMIN_BUILD
            env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + build_id}
            commands = [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
                ('npm', 'run', 'build', '--workspace', '@apple-business/shared')]
            if role == 'api':
                commands.append(('npm', 'run', 'prisma:mysql:generate'))
            commands.append(('npm', 'run', 'build', '--workspace', '@apple-business/' + role))
            for args in commands:
                subprocess.run(args, cwd=context, env=env, check=True)
            outputs[role + '-' + variant] = (h.file_inventory(context / ('apps/' + role + '/dist')),
                h.file_inventory(context / 'packages/shared/dist'))
    verify_delta(*[outputs['api-' + v][0] for v in ('baseline', 'candidate')],
        *[outputs['api-' + v][1] for v in ('baseline', 'candidate')], c, p)
    verify_followup_admin(outputs['admin-baseline'][0], outputs['admin-baseline'][1], outputs['admin-candidate'][1], c, p)
    payload = OUT / 'payload'
    for n in p.MODULES:
        target = payload / 'api/modules' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'api-candidate/apps/api/dist' / n, target)
    shutil.copytree(OUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for n in c['sources']:
        target = payload / 'source' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / n, target)
    proof = {**identity, 'version': 1, 'recipe': p.FOLLOWUP, 'scope': p.SCOPE,
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'sources': c['sources'], 'controlSources': c['controlPins'],
        'apiModules': h.file_inventory(payload / 'api/modules'), 'adminFiles': h.file_inventory(payload / 'admin/html'),
        'baselineAdminReproduced': True, 'baselineAdminFiles': c['publishedAdminFiles'],
        'files': h.file_inventory(payload), 'qualityVerification': qa, 'isolatedMysqlVerification': mysql_evidence,
        'baselineModulesReproduced': c['baseline']['apiModules'], 'predecessorProofSha256': p.FOLLOWUP_PROOF,
        'baselineSharedUnchanged': True, 'updatedServices': list(p.UPDATED), 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BITBROWSER_FOLLOWUP_NATIVE_BUILT', **identity, 'businessActions': 0}))



def mysql_inputs(commit):
    # Bind the unchanged lock implementation, its complete local dependencies,
    # both database specs and all MySQL migrations/schema and dependency locks.
    p = load('bitbrowser-history-release.py')
    raw = git('archive', '--format=tar', commit, 'apps/api/src/id-business-v2/auto-recharge',
        'apps/api/prisma-mysql', 'packages/shared/src', 'package-lock.json', 'package.json',
        'apps/api/package.json', 'packages/shared/package.json')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        members = archive.getmembers()
        p.need(all(member.isdir() or member.isfile() for member in members), 'MYSQL_INPUT_KIND_CHANGED')
        return {member.name: p.sha(archive.extractfile(member).read()) for member in members if member.isfile()}


def address_freeze(parent_dir, source, admin_proof_path):
    p = load('bitbrowser-history-release.py')
    source = git('rev-parse', source + '^{commit}').decode().strip()
    p.need(set(git('diff', '--name-only', p.CURRENT, source).decode().splitlines()) == p.APPLICATION, 'REVIEW_SCOPE_CHANGED')
    directory = Path(parent_dir)
    raw = (directory / 'build-proof.json').read_bytes()
    parent = json.loads(raw)
    preflight = json.loads((directory / 'publication/preflight-result.json').read_bytes())
    admin_raw = Path(admin_proof_path).read_bytes()
    admin = json.loads(admin_raw)
    old = json.loads((HERE / 'bitbrowser-entry-start-contract.json').read_bytes())
    p.need(p.sha(raw) == p.ADDRESS_PROOF and parent['commit'] == p.ADDRESS_CURRENT
        and parent['contractSha256'] == p.ENTRY_CONTRACT_SHA and p.sha(admin_raw) == p.ENTRY_PROOF
        and admin['commit'] == p.ENTRY_CURRENT and preflight['commit'] == p.ADDRESS_CURRENT
        and preflight['status'] == 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'PREDECESSOR_PROOF_INVALID')
    inputs = mysql_inputs(source)
    p.need(inputs == mysql_inputs(p.CURRENT), 'INHERITED_MYSQL_INPUT_CHANGED')
    tree = git('rev-parse', source + '^{tree}').decode().strip()
    selector = ROOT / 'scripts/ci-recharge-scope.mjs'
    text = selector.read_text()
    for key, value in (('Commit', source), ('Tree', tree)):
        text, count = re.subn(r"(export const bitbrowserExistingAddressSourceReview" + key + r"\s*=\s*')[^']+(';?)", lambda m: m[1] + value + m[2], text)
        p.need(count == 1, 'ADDRESS_SELECTOR_MISSING')
    selector.write_text(text)
    c = {'version': 1, 'status': 'FROZEN', 'recipe': p.ADDRESS, 'scope': p.SCOPE,
        'expectedCurrent': p.CURRENT, 'reviewBase': p.CURRENT, 'sourceReviewCommit': source, 'sourceReviewTree': tree,
        'sources': {n: p.sha(git('show', source + ':' + n)) for n in sorted(p.APPLICATION)},
        'apiModules': [], 'updatedServices': list(p.UPDATED), 'reboundServices': [], 'preservedServices': list(p.PRESERVED),
        'engineHealth': p.ENGINE, 'controlPins': {n: p.sha((HERE / n).read_bytes()) for n in sorted(p.CONTROLS)},
        'ciControlPins': {n: p.sha((ROOT / n).read_bytes()) for n in sorted(p.CI_CONTROLS)},
        'mysqlTestSources': old['mysqlTestSources'], 'mysqlInheritance': {'parentProofSha256': p.ADDRESS_PROOF,
            'evidence': parent['isolatedMysqlVerification'], 'inputs': inputs},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()),
        'qualityWorkflowSha256': p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()),
        'predecessorProofSha256': p.ADDRESS_PROOF,
        'publishedApiModules': {**old['publishedApiModules'], **parent['apiModules']}, 'publishedSharedFiles': old['publishedSharedFiles'],
        'publishedAdminFiles': admin['adminFiles'], 'adminNativeProofSha256': p.ENTRY_PROOF,
        'parentVerifiedBaseline': preflight['runtimeBaseline']['verifiedBaseline'],
        'parentVerifiedSealSha256': preflight['runtimeBaseline']['entryParentSealSha256'],
        'sqlFenceHelperSha256': p.sha((HERE / 'api-admin-scope.py').read_bytes()),
        'baseline': {'commit': p.CURRENT, 'apiModules': {}},
        'parentNative': {'commit': p.ADDRESS_CURRENT, 'tree': p.ADDRESS_TREE, 'proofSha256': p.ADDRESS_PROOF,
            'contractSha256': p.ENTRY_CONTRACT_SHA, 'workflowRunId': '39202298576',
            'apiImage': p.ADDRESS_API_IMAGE, 'adminImage': p.ADDRESS_ADMIN_IMAGE},
        'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    for n in p.INHERITED:
        p.need(c['controlPins'][n] == p.sha(git('show', p.CURRENT + ':scripts/production-release/' + n)), 'INHERITED_CONTROL_CHANGED')
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')


def inherited_mysql(c, identity):
    p = load('bitbrowser-history-release.py')
    destination = ROOT / '.runtime/bitbrowser-history-parent'
    p.need(not destination.exists(), 'PARENT_EVIDENCE_ALREADY_EXISTS')
    run = json.loads(subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/runs/39202298576'], cwd=ROOT))
    p.need(run['head_sha'] == p.ADDRESS_CURRENT and run['conclusion'] == 'success'
        and run['path'] == p.WORKFLOW and str(run['run_attempt']) == '1', 'PARENT_NATIVE_CHANGED')
    destination.mkdir(mode=0o700, parents=True)
    subprocess.run(['gh', 'run', 'download', '39202298576', '-n', 'bitbrowser-history-mysql-39202298576-1', '-D', str(destination / 'mysql')], cwd=ROOT, check=True)
    subprocess.run(['gh', 'run', 'download', '39202298576', '-n', 'bitbrowser-history-' + p.ADDRESS_CURRENT + '-1', '-D', str(destination / 'native')], cwd=ROOT, check=True)
    bundle = destination / 'native/bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle) as archive:
        raw = archive.extractfile('payload/build-proof.json').read()
    parent = json.loads(raw)
    report = (destination / 'mysql/mysql-vitest.json').read_bytes()
    p.need(p.sha(raw) == p.ADDRESS_PROOF and parent['isolatedMysqlVerification'] == c['mysqlInheritance']['evidence']
        and p.sha(report) == parent['isolatedMysqlVerification']['reportSha256'], 'PARENT_MYSQL_EVIDENCE_CHANGED')
    evidence = parent['isolatedMysqlVerification']
    p.verify_mysql(evidence, identity, c)
    return evidence


def reconstruct_address(p):
    _unused_api, admin = reconstruct_followup(p)
    old = json.loads((HERE / 'bitbrowser-followup-contract.json').read_bytes())
    overlay(admin, {n: v for n, v in old['sources'].items() if n.startswith('apps/admin/')}, old['sourceReviewCommit'])
    return admin


def address_main(c):
    p = followup_check(c)
    commit = git('rev-parse', 'HEAD').decode().strip()
    identity = {'commit': commit, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
        and not OUT.exists() and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    qa = {'release': quality(commit, c), 'sources': quality(c['sourceReviewCommit'], c, source=True)}
    mysql_evidence = inherited_mysql(c, identity)
    OUT.mkdir(mode=0o700, parents=True)
    before = reconstruct_address(p)
    candidate = OUT / 'admin-candidate'
    shutil.copytree(before, candidate)
    overlay(candidate, c['sources'], c['sourceReviewCommit'])
    h = load('recharge-record-release.py')
    outputs = []
    for context, build_id in ((before, p.ENTRY_CURRENT), (candidate, commit)):
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + build_id}
        for command in (('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/shared'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/admin')):
            subprocess.run(command, cwd=context, env=env, check=True)
        outputs.append((h.file_inventory(context / 'apps/admin/dist'), h.file_inventory(context / 'packages/shared/dist')))
    verify_followup_admin(outputs[0][0], outputs[0][1], outputs[1][1], c, p)
    payload = OUT / 'payload'
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for n in c['sources']:
        target = payload / 'source' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / n, target)
    proof = {**identity, 'version': 1, 'recipe': p.ADDRESS, 'scope': p.SCOPE,
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'sources': c['sources'], 'controlSources': c['controlPins'],
        'apiModules': {}, 'adminFiles': h.file_inventory(payload / 'admin/html'),
        'baselineAdminReproduced': True, 'baselineAdminFiles': c['publishedAdminFiles'],
        'files': h.file_inventory(payload), 'qualityVerification': qa, 'isolatedMysqlVerification': mysql_evidence,
        'baselineModulesReproduced': {}, 'predecessorProofSha256': p.ADDRESS_PROOF,
        'baselineSharedUnchanged': True, 'updatedServices': ['admin'], 'migrationPerformed': False, 'businessActions': 0}
    p.verify_proof(proof, proof, c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BITBROWSER_EXISTING_ADDRESS_NATIVE_BUILT', **identity, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recipe', choices=('history-20261019', 'followup-20261019', 'entry-start-20261019', 'existing-address-field-20261019'), default=os.environ.get('BITBROWSER_RELEASE_RECIPE', 'history-20261019'))
    parser.add_argument('--admin-proof', default=str(PREDECESSOR))
    parser.add_argument('--freeze', nargs=2, metavar=('BASELINE', 'SOURCE_REVIEW_COMMIT'))
    parser.add_argument('--predecessor-proof', default=str(PREDECESSOR))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    RECIPE = args.recipe
    if RECIPE == 'existing-address-field-20261019':
        CONTRACT = HERE / 'bitbrowser-existing-address-contract.json'
    elif RECIPE == 'followup-20261019':
        CONTRACT = HERE / 'bitbrowser-followup-contract.json'
    elif RECIPE == 'entry-start-20261019':
        CONTRACT = HERE / 'bitbrowser-entry-start-contract.json'
    if args.freeze:
        if RECIPE == 'existing-address-field-20261019':
            address_freeze(*args.freeze, args.admin_proof)
        elif RECIPE == 'entry-start-20261019':
            entry_freeze(*args.freeze)
        elif RECIPE == 'followup-20261019':
            followup_freeze(*args.freeze, args.predecessor_proof, args.admin_proof)
        else:
            freeze(*args.freeze, args.predecessor_proof)
    elif args.check:
        (followup_check if RECIPE in ('followup-20261019', 'entry-start-20261019', 'existing-address-field-20261019') else check)(json.loads(CONTRACT.read_bytes()))
        print('{"sourceCheck":"passed","businessActions":0}')
    else:
        if RECIPE == 'existing-address-field-20261019':
            address_main(json.loads(CONTRACT.read_bytes()))
        elif RECIPE == 'entry-start-20261019':
            entry_main(json.loads(CONTRACT.read_bytes()))
        elif RECIPE == 'followup-20261019':
            followup_main(json.loads(CONTRACT.read_bytes()))
        else:
            main()
