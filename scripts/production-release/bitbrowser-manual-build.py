"""Build the finite API/shared/Admin delta from the previously published composite."""
import argparse
import io
import zipfile
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile

import importlib.util

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/bitbrowser-manual'


def load(name):
    spec = importlib.util.spec_from_file_location('manual_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def check(c):
    p = load('bitbrowser-manual-release.py')
    p.validate_contract(c)
    p.need(git('rev-parse', p.SOURCE + '^{tree}').decode().strip() == c['sourceReviewTree'], 'SOURCE_TREE_CHANGED')
    for n, v in c['sources'].items():
        p.need(p.sha((ROOT / n).read_bytes()) == v == p.sha(git('show', p.SOURCE + ':' + n)), 'SOURCE_CHANGED')
    for n, v in c['controlPins'].items():
        p.need(p.sha((HERE / n).read_bytes()) == v, 'CONTROL_CHANGED')
    for n, v in c['ciControlPins'].items():
        p.need(p.sha((ROOT / n).read_bytes()) == v, 'CI_CONTROL_CHANGED')
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256']
        and p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()) == c['qualityWorkflowSha256'], 'WORKFLOW_CHANGED')
    changed = set(git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines())
    allowed = set(c['sources']) | set(c['ciControlPins']) | {p.WORKFLOW, 'scripts/production-release/' + p.CONTRACT_FILE} | {
        'scripts/production-release/' + n for n in c['controlPins'] if n.startswith('bitbrowser-manual-')}
    p.need(changed <= allowed and set(c['sources']) <= changed, 'FINITE_SCOPE_CHANGED')
    return p


def require_quality_jobs(rows, *, source, p):
    passed = {row['name'] for row in rows if row['conclusion'] == 'success'}
    p.need({'change-scope', 'quality'} <= passed
        and (not source or 'full-quality' in passed), 'APPLICABLE_QUALITY_REQUIRED')
    # The pinned quality job verifies main's identical-tree PR evidence when its
    # full-quality job is skipped; do not demand a redundant full main run.
    p.need(all(row['conclusion'] in ('success', 'skipped') for row in rows), 'QUALITY_JOB_NOT_PASSED')


def github(path):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/' + path], cwd=ROOT))


def source_receipt(run, pr, identity, c, p):
    rows = github('actions/runs/' + str(run['id']) + '/artifacts')['artifacts']
    selected = [a for a in rows if a['name'] == 'quality-source-evidence-' + str(run['run_attempt']) and not a['expired']]
    p.need(len(selected) == 1, 'SOURCE_RECEIPT_MISSING')
    artifact = selected[0]
    raw = subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/artifacts/' + str(artifact['id']) + '/zip'], cwd=ROOT)
    p.need(0 < len(raw) < 1024**2 and artifact.get('digest') == 'sha256:' + p.sha(raw), 'SOURCE_RECEIPT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        p.need(archive.namelist() == ['evidence.json'], 'SOURCE_RECEIPT_LAYOUT')
        receipt = json.loads(archive.read('evidence.json'))
    p.need(receipt == {'repository': 'wangchaozhuanyong/id-business-system', 'runId': run['id'],
        'runAttempt': run['run_attempt'], 'pullRequest': pr['number'], 'headSha': pr['head']['sha'],
        'baseSha': c['reviewBase'], 'testedTree': identity['tree']}, 'TESTED_TREE_CHANGED')
    return {'testedTree': receipt['testedTree'], 'pullRequest': pr['number'],
        'sourceEvidenceArtifactId': artifact['id'], 'sourceEvidenceSha256': p.sha(raw)}


def quality(c, p, identity):
    prs = [pr for pr in github('commits/' + identity['commit'] + '/pulls')
        if pr.get('merged_at') and pr.get('merge_commit_sha') == identity['commit'] and pr['base']['ref'] == 'main']
    p.need(len(prs) == 1, 'MERGED_SOURCE_PR_REQUIRED')
    pr = prs[0]
    producer = pr['head']['sha']
    for name, expected in c['sources'].items():
        p.need(p.sha(git('show', producer + ':' + name)) == expected
            == p.sha(git('show', p.SOURCE + ':' + name)), 'REVIEWED_BUSINESS_PROJECTION_CHANGED')
    out = {}
    for role, commit in (('sources', producer), ('release', identity['commit'])):
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + commit)['workflow_runs']
        rows = [r for r in runs if r['head_sha'] == commit and r['conclusion'] == 'success'
            and (r['event'] == 'pull_request' if role == 'sources' else r['event'] == 'push' and r['head_branch'] == 'main')]
        p.need(bool(rows), 'QUALITY_NOT_PASSED')
        run = rows[0]
        jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
        require_quality_jobs(jobs, source=role == 'sources', p=p)
        out[role] = {'commit': commit, 'tree': git('rev-parse', commit + '^{tree}').decode().strip(),
            'runId': str(run['id']), 'runAttempt': str(run['run_attempt']), 'event': run['event'], 'conclusion': 'success'}
        if role == 'sources':
            out[role].update(source_receipt(run, pr, identity, c, p))
            out[role]['reviewedBusinessCommit'] = p.SOURCE
    # Read the actual full candidate's native MySQL log. Its business files must
    # match the frozen review; publisher/CI-only commits do not relabel that review.
    source_run = out['sources']['runId']
    log = subprocess.check_output(['gh', 'run', 'view', source_run, '--log', '--repo', 'wangchaozhuanyong/id-business-system'], cwd=ROOT)
    text = re.sub(r'\x1b\[[0-9;]*m', '', log.decode())
    manual = [line for line in text.splitlines() if '\tVerify financial integrity on disposable MySQL\t' in line
        and '✓ src/id-business-v2/auto-recharge/recharge-mysql.integration.spec.ts (5 tests)' in line]
    p.need(len(manual) == 1 and 'skipped' not in manual[0]
        and 'Verify rollback, deletion and restore integrity on MySQL' in text, 'MANUAL_MYSQL_NOT_PASSED')
    mysql = {'sourceCommit': p.SOURCE, 'testedCommit': producer, 'runId': source_run, 'manualTestsPassed': 4,
        'manualTestsSkipped': 0, 'financialStepPassed': True, 'rollbackStepPassed': True, 'nativeLogSha256': p.sha(log)}
    p.verify_mysql(mysql, {**identity, 'qualityVerification': out}, c)
    return out, mysql


def main(c):
    p = check(c)
    commit = git('rev-parse', 'HEAD').decode().strip()
    identity = {'commit': commit, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
        and not OUT.exists() and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    qa, mysql = quality(c, p, identity)
    dispatch = load('bitbrowser-manual-dispatch.py')
    dispatch.OUT = ROOT / '.deploy/bitbrowser-manual-parent'
    dispatch.OUT.mkdir(parents=True, mode=0o700)
    capture_plan = {**identity, 'recipe': p.RECIPE, 'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()),
        'controlSources': {**c['controlPins'], p.CONTRACT_FILE: p.sha((HERE / p.CONTRACT_FILE).read_bytes())}}
    capture = dispatch.transport(capture_plan, 'parent')
    p.need(capture['status'] == 'BITBROWSER_MANUAL_READONLY_PARENT' and capture['databaseWrites'] == 0, 'PARENT_CAPTURE_FAILED')
    OUT.mkdir(parents=True, mode=0o700)
    b = load('bitbrowser-history-build.py')
    b.OUT = OUT / 'reconstruction'
    b.OUT.mkdir(mode=0o700)
    legacy = b.load('bitbrowser-history-release.py')
    legacy.select_recipe(legacy.BOUNDED)
    api, admin = b.reconstruct_bounded_parent(legacy)
    prior = json.loads((HERE / 'bitbrowser-bounded-hold-contract.json').read_bytes())
    # Reconstruct the current API/Admin sources; do not compile unrelated main WIP.
    for role, context in (('api', api), ('admin', admin)):
        b.overlay(context, {n: v for n, v in prior['productionSources'].items() if n.startswith('apps/' + role + '/')}, prior['sourceReviewCommit'])
        selected = {n: v for n, v in c['productionSources'].items() if n.startswith(('apps/' + role + '/', 'packages/shared/'))}
        for n in selected:
            path, expected = context / n, c['buildParents'][n]
            p.need(not path.is_symlink() and (not path.exists() if expected is None else path.is_file()
                and p.sha(path.read_bytes()) == expected), 'RECONSTRUCTED_PARENT_SOURCE_CHANGED')
        b.overlay(context, selected, p.SOURCE)
        env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + commit}
        commands = [('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'),
            ('npm', 'run', 'build', '--workspace', '@apple-business/shared')]
        if role == 'api':
            commands.append(('npm', 'run', 'prisma:mysql:generate'))
        commands.append(('npm', 'run', 'build', '--workspace', '@apple-business/' + role))
        for command in commands:
            subprocess.run(command, cwd=context, env=env, check=True)
    payload = OUT / 'payload'
    for root, selected, source in (('api/modules', c['apiModules'], api / 'apps/api/dist'),
        ('api/shared', c['sharedModules'], api / 'packages/shared/dist')):
        for n in selected:
            target = payload / root / n
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / n, target)
    shutil.copytree(admin / 'apps/admin/dist', payload / 'admin/html')
    for n in c['productionSources']:
        target = payload / 'source' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / n, target)
    h = load('recharge-record-release.py')
    selected_c = {**c, 'baseline': capture['baseline']}
    proof = {**identity, 'version': 1, 'recipe': p.RECIPE, 'scope': p.SCOPE,
        'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()), 'sources': c['sources'],
        'productionSources': c['productionSources'], 'controlSources': c['controlPins'],
        'apiModules': h.file_inventory(payload / 'api/modules'), 'sharedModules': h.file_inventory(payload / 'api/shared'),
        'adminFiles': h.file_inventory(payload / 'admin/html'), 'files': h.file_inventory(payload),
        'qualityVerification': qa, 'isolatedMysqlVerification': mysql, 'nativeParentCapture': capture,
        'predecessorProofSha256': p.PARENT_PROOF, 'updatedServices': ['api', 'admin'],
        'businessActions': 0, 'migrationPerformed': False}
    p.verify_proof(proof, proof, selected_c, payload, h)
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'bitbrowser-history-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BITBROWSER_MANUAL_NATIVE_BUILT', **identity, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    contract = json.loads((HERE / 'bitbrowser-manual-contract.json').read_bytes())
    if args.check:
        check(contract)
        print('{"sourceCheck":"passed","businessActions":0}')
    else:
        main(contract)
