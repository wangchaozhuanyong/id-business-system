"""Bind the mailbox release to native PR/main evidence and the established OIDC/SSM transport."""
import argparse
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'mailbox-validity'
WORKFLOW = '.github/workflows/mailbox-validity-publication.yml'
OUT = ROOT / '.deploy' / PREFIX
REPO = 'wangchaozhuanyong/id-business-system'


def load(name):
    spec = importlib.util.spec_from_file_location('mailbox_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('mailbox-validity-runtime.py')
F = load('financial-closure-publication.py')
F.WORKFLOW, F.P = WORKFLOW, R
need, sha, git, github, execute = R.need, R.sha, F.git, F.github, F.execute


def contract():
    return json.loads((HERE / R.CONTRACT_FILE).read_bytes())


def check(c):
    R.validate_contract(c)
    for n, v in {**c['sources'], **c['validationSources']}.items():
        need(sha((ROOT / n).read_bytes()) == v, 'SOURCE_CHANGED')
    for n, v in c['helperPins'].items():
        need(sha((HERE / n).read_bytes()) == v, 'INHERITED_CONTROL_CHANGED')
    changed = set(git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines())
    need(changed <= set(c['sources']) | set(c['validationSources']) | set(c['controlFiles']), 'UNREVIEWED_EXTENSION')
    need(sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256']
         and sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256'], 'BUILD_INPUT_CHANGED')


def identity(c):
    need(json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == c['awsAccount'], 'AWS_ACCOUNT_CHANGED')
    need(os.environ.get('EXPECTED_CURRENT') == c['expectedCurrent'], 'EXPECTED_CURRENT_CHANGED')
    return F.native_identity()


def quality(commit, tree):
    prs = [p for p in github('commits/' + commit + '/pulls') if p.get('merged_at') and p['merge_commit_sha'] == commit and p['base']['ref'] == 'main' and p['head']['repo']['full_name'] == REPO]
    need(len(prs) == 1, 'MERGED_PR_REQUIRED')
    pr = prs[0]
    need(git('rev-parse', pr['head']['sha'] + '^{tree}').decode().strip() == tree, 'REVIEW_TREE_CHANGED')
    receipts = {}
    for event, head in [('pull_request', pr['head']['sha']), ('push', commit)]:
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + head)['workflow_runs']
        rows = [r for r in runs if r['head_sha'] == head and r['event'] == event and r['conclusion'] == 'success']
        need(bool(rows), 'QUALITY_REQUIRED')
        run = rows[0]
        F.require_run(run, head, '.github/workflows/quality.yml', event)
        jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
        successful = {j['name'] for j in jobs if j['conclusion'] == 'success'}
        need({'quality', 'change-scope'} <= successful and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_PARTS_REQUIRED')
        if event == 'pull_request':
            need('full-quality' in successful or {'recharge (guards)', 'recharge (api)', 'recharge (admin)'} <= successful, 'SOURCE_CHECKS_REQUIRED')
            receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
            need(receipt['repository'] == REPO and receipt['headSha'] == head and receipt['testedTree'] == tree and receipt['pullRequest'] == pr['number'], 'QUALITY_RECEIPT_CHANGED')
            # The existing migration workflow must execute the new finite MySQL cases.
            db_runs = github('actions/workflows/recharge-billing-allocation-validation.yml/runs?head_sha=' + head)['workflow_runs']
            db = [r for r in db_runs if r['head_sha'] == head and r['event'] == 'pull_request' and r['conclusion'] == 'success']
            need(bool(db), 'ISOLATED_DATABASE_CHECK_REQUIRED')
            db_jobs = github('actions/runs/' + str(db[0]['id']) + '/jobs?per_page=100')['jobs']
            need(any(j['conclusion'] == 'success' and any(s['name'] == 'Verify mailbox query-code migration without production data' and s['conclusion'] == 'success' for s in j['steps']) for j in db_jobs), 'MAILBOX_DATABASE_CHECK_REQUIRED')
            receipts['databaseRunId'] = str(db[0]['id'])
            receipts['sourceReceiptSha256'] = digest
        receipts[event] = {'head': head, 'runId': str(run['id']), 'runAttempt': str(run['run_attempt'])}
    return {**receipts, 'commit': commit, 'tree': tree, 'pullRequest': pr['number']}


def transport(plan, mode):
    # Keep the audited transport's single-send journal, native receipt checks and bounded waits.
    # Only select this finite executor and its error namespace; permissions and transport are unchanged.
    source = inspect.getsource(F.transport)
    need(source.count("directory/'financial-closure-release.py'") == 1, 'TRANSPORT_RECIPE_CHANGED')
    source = source.replace("directory/'financial-closure-release.py'", "directory/'mailbox-validity-runtime.py'")
    source = source.replace('financial-entry-', 'mailbox-validity-entry-')
    source = source.replace('FINANCIAL_PUBLICATION|BITBROWSER_HISTORY', 'MAILBOX_VALIDITY|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY')
    values = dict(F.__dict__)
    exec(compile(source, '<mailbox-validity-transport>', 'exec'), values)
    return values['transport'](plan, mode, OUT)


def plan_for(c, native):
    names = {*c['helperPins'], 'mailbox-validity-runtime.py', R.CONTRACT_FILE}
    return {**native, 'contractSha256': sha((HERE / R.CONTRACT_FILE).read_bytes()),
            'controlSources': {n: sha((HERE / n).read_bytes()) for n in sorted(names)}}


def build(c):
    check(c)
    native = identity(c)
    qa = quality(native['commit'], native['tree'])
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    plan = plan_for(c, native)
    parent = transport(plan, 'parent')
    need(parent['status'] == 'MAILBOX_VALIDITY_PARENT_VERIFIED', 'PARENT_CAPTURE_REQUIRED')
    load('mailbox-validity-build.py').build(c, plan, qa, parent, OUT)


def publish(c):
    check(c)
    native = identity(c)
    qa = quality(native['commit'], native['tree'])
    jobs = github('actions/runs/' + native['workflowRunId'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    rows = github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == PREFIX + '-native-' + native['commit'] + '-' + native['workflowRunAttempt'] and not a['expired']]
    need(len(rows) == 1, 'NATIVE_ARTIFACT_REQUIRED')
    raw = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0].get('digest') == 'sha256:' + sha(raw), 'NATIVE_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        filename = PREFIX + '-artifact.tar.gz'
        need(set(archive.namelist()) == {filename, 'artifact-sha256.txt'}, 'ARTIFACT_LAYOUT_CHANGED')
        bundle = archive.read(filename)
        need(sha(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'ARTIFACT_CHANGED')
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    payload = load('shared-bank-card-release.py').safe_archive(bundle, OUT / 'checked-content')
    proof_raw = (payload / 'build-proof.json').read_bytes()
    proof = json.loads(proof_raw)
    need(all(proof.get(k) == v for k, v in native.items()) and proof['qualitySourceEvidence'] == qa, 'BUILD_PROVENANCE_CHANGED')
    plan = {**plan_for(c, native), 'qualitySourceEvidence': qa, 'nativeParentCapture': proof['nativeParentCapture'], 'artifactSha256': sha(bundle), 'buildProofSha256': sha(proof_raw)}
    files = load('recharge-record-release.py').file_inventory(payload)
    files.pop('build-proof.json')
    R.verify_proof(proof, plan, c, files)
    path = OUT / filename
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('仅更新邮箱查询码有效期界面、接口及新增周期字段；保留既有查询码和到期时间，无真实业务写入测试。\n')
    tag = PREFIX + '-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'], '--title', '查询码有效期 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + filename
    need(transport(plan, 'preflight')['status'] == 'MAILBOX_VALIDITY_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    need(transport(plan, 'release')['status'] == 'MAILBOX_VALIDITY_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    need(transport(plan, 'readback')['status'] == 'MAILBOX_VALIDITY_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'MAILBOX_VALIDITY_PUBLISHED_AND_VERIFIED', 'commit': native['commit'], 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish'))
    args = parser.parse_args()
    {'check': check, 'build': build, 'publish': publish}[args.mode](contract())
