"""Build the finite API/shared/Admin delta from the previously published composite."""
import argparse
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
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256']
        and p.sha((ROOT / '.github/workflows/quality.yml').read_bytes()) == c['qualityWorkflowSha256'], 'WORKFLOW_CHANGED')
    changed = set(git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines())
    allowed = set(c['sources']) | {p.WORKFLOW, 'scripts/production-release/' + p.CONTRACT_FILE} | {
        'scripts/production-release/' + n for n in c['controlPins'] if n.startswith('bitbrowser-manual-')}
    p.need(changed <= allowed and set(c['sources']) <= changed, 'FINITE_SCOPE_CHANGED')
    return p


def quality(c, p, identity):
    out = {}
    for role, commit in (('sources', p.SOURCE), ('release', identity['commit'])):
        runs = json.loads(subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/workflows/quality.yml/runs?head_sha=' + commit], cwd=ROOT))['workflow_runs']
        rows = [r for r in runs if r['head_sha'] == commit and r['conclusion'] == 'success'
            and (r['event'] == 'pull_request' if role == 'sources' else r['event'] == 'push' and r['head_branch'] == 'main')]
        p.need(bool(rows), 'QUALITY_NOT_PASSED')
        run = rows[0]
        jobs = json.loads(subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/runs/' + str(run['id']) + '/jobs?per_page=100'], cwd=ROOT))['jobs']
        p.need(any(j['name'] == 'full-quality' and j['conclusion'] == 'success' for j in jobs), 'FULL_QUALITY_REQUIRED')
        out[role] = {'commit': commit, 'tree': git('rev-parse', commit + '^{tree}').decode().strip(),
            'runId': str(run['id']), 'runAttempt': str(run['run_attempt']), 'event': run['event'], 'conclusion': 'success'}
    p.need(out['sources']['runId'] == c['sourceQualityRunId'], 'SOURCE_QUALITY_CHANGED')
    # Fetch the native log rather than trusting an aggregate successful job.
    log = subprocess.check_output(['gh', 'run', 'view', c['sourceQualityRunId'], '--log', '--repo', 'wangchaozhuanyong/id-business-system'], cwd=ROOT)
    text = re.sub(r'\x1b\[[0-9;]*m', '', log.decode())
    manual = [line for line in text.splitlines() if '\tVerify financial integrity on disposable MySQL\t' in line
        and '✓ src/id-business-v2/auto-recharge/recharge-mysql.integration.spec.ts (5 tests)' in line]
    p.need(len(manual) == 1 and 'skipped' not in manual[0]
        and 'Verify financial integrity on disposable MySQL' in text
        and 'Verify rollback, deletion and restore integrity on MySQL' in text, 'MANUAL_MYSQL_NOT_PASSED')
    mysql = {'sourceCommit': p.SOURCE, 'runId': c['sourceQualityRunId'], 'manualTestsPassed': 4,
        'manualTestsSkipped': 0, 'financialStepPassed': True, 'rollbackStepPassed': True, 'nativeLogSha256': p.sha(log)}
    p.verify_mysql(mysql, identity, c)
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
            path, expected = context / n, c['sourceParents'][n]
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
