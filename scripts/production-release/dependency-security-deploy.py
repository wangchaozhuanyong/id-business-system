"""Native reviewed main build and one bounded OIDC/SSM dependency publication."""
import argparse
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'dependency-security'
WORKFLOW = '.github/workflows/dependency-security-publication.yml'
REPO = 'wangchaozhuanyong/id-business-system'
OUT = ROOT / '.deploy' / PREFIX


def load(name):
    spec = importlib.util.spec_from_file_location('dependency_deploy_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load('dependency-security-runtime.py')
P = load('dependency-security-publication.py')
F = load('financial-closure-publication.py')
F.WORKFLOW, F.P = WORKFLOW, R
need, sha, git, github, execute = R.need, R.sha, F.git, F.github, F.execute


def check(c):
    P.check(c)
    R.validate_contract(c)
    need(set(git('diff', '--name-only', c['sourceCommit'], 'HEAD').decode().splitlines()) <= set(c['publicationControls']), 'UNREVIEWED_EXTENSION')
    need(sha((ROOT / 'scripts/dependency-security-regressions.test.mjs').read_bytes()) == c['probeSha256'], 'PROBE_CHANGED')
    lock = json.loads((ROOT / 'package-lock.json').read_bytes())['packages']
    need(c['afterVersions'] == {n: lock[n]['version'] if n in lock and (c['baseline']['dependencies']['inventory'][n] is not None or any(n.startswith(p + '/') and v is not None for p, v in c['baseline']['dependencies']['inventory'].items())) else None for n in c['packageDirectories']}, 'LOCK_LAYOUT_CHANGED')


def reviewed_quality(review, required):
    pr = github('pulls/' + str(review['pullRequest']))
    need(pr['merged_at'] and pr['merge_commit_sha'] == review['main'] and pr['head']['sha'] == review['head']
         and pr['base']['ref'] == 'main' and pr['head']['repo']['full_name'] == REPO
         and git('rev-parse', review['main'] + '^{tree}').decode().strip() == review['tree'], 'REVIEW_CHANGED')
    run = github('actions/runs/' + str(review['runId']))
    F.require_run(run, review['head'], '.github/workflows/quality.yml', 'pull_request')
    jobs = github('actions/runs/' + str(run['id']) + '/attempts/' + str(run['run_attempt']) + '/jobs?per_page=100')['jobs']
    successful = {j['name'] for j in jobs if j['conclusion'] == 'success'}
    need(required <= successful and all(j['conclusion'] in ('success', 'skipped') for j in jobs), 'QUALITY_PARTS_REQUIRED')
    receipt, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
    need(receipt['repository'] == REPO and receipt['headSha'] == review['head']
         and receipt['testedTree'] == review['tree'] and receipt['pullRequest'] == review['pullRequest'], 'QUALITY_RECEIPT_CHANGED')
    return {**review, 'sourceReceiptSha256': digest}


def quality(c, native):
    source = reviewed_quality(c['sourceReview'], {'quality', 'change-scope', 'full-quality'})
    commit, tree = native['commit'], native['tree']
    prs = [p for p in github('commits/' + commit + '/pulls') if p.get('merged_at') and p['merge_commit_sha'] == commit and p['base']['ref'] == 'main']
    need(len(prs) == 1, 'MERGED_CONTROL_PR_REQUIRED')
    pr = prs[0]
    need(git('rev-parse', pr['head']['sha'] + '^{tree}').decode().strip() == tree, 'CONTROL_TREE_CHANGED')
    runs = github('actions/workflows/quality.yml/runs?head_sha=' + pr['head']['sha'])['workflow_runs']
    rows = [r for r in runs if r['head_sha'] == pr['head']['sha'] and r['event'] == 'pull_request' and r['conclusion'] == 'success']
    need(bool(rows), 'CONTROL_QUALITY_REQUIRED')
    control = reviewed_quality({'pullRequest': pr['number'], 'main': commit, 'head': pr['head']['sha'],
        'tree': tree, 'runId': str(rows[0]['id'])}, {'quality', 'change-scope', 'recharge (guards)'})
    rows = [r for r in github('actions/workflows/quality.yml/runs?head_sha=' + commit)['workflow_runs']
            if r['head_sha'] == commit and r['event'] == 'push' and r['conclusion'] == 'success']
    need(bool(rows), 'MAIN_QUALITY_REQUIRED')
    F.require_run(rows[0], commit, '.github/workflows/quality.yml', 'push')
    return {'commit': commit, 'tree': tree, 'source': source, 'control': control,
            'main': {'head': commit, 'runId': str(rows[0]['id'])}}


def identity(c):
    need(os.environ.get('EXPECTED_CURRENT') == c['expectedCurrent'], 'EXPECTED_CURRENT_CHANGED')
    return F.native_identity()


def plan_for(c, native):
    names = {*c['helperPins'], P.CONTRACT_FILE, 'dependency-security-publication.py', 'dependency-security-runtime.py'}
    return {**native, 'contractSha256': sha((HERE / P.CONTRACT_FILE).read_bytes()),
            'controlSources': {n: sha((HERE / n).read_bytes()) for n in sorted(names)}}


def transport(plan, mode):
    source = inspect.getsource(F.transport)
    need(source.count("directory/'financial-closure-release.py'") == 1, 'TRANSPORT_CHANGED')
    source = source.replace("directory/'financial-closure-release.py'", "directory/'dependency-security-runtime.py'")
    source = source.replace('financial-entry-', 'dependency-security-entry-')
    source = source.replace('FINANCIAL_PUBLICATION|BITBROWSER_HISTORY', 'DEPENDENCY_SECURITY|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY')
    values = dict(F.__dict__)
    exec(compile(source, '<dependency-security-publication>', 'exec'), values)
    return values['transport'](plan, mode, OUT)


def build(c):
    check(c)
    native = identity(c)
    qa = quality(c, native)
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    load('dependency-security-build.py').build(c, plan_for(c, native), qa, OUT, R)


def diagnose(c):
    check(c)
    native = identity(c)
    need(json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == '098208446664', 'AWS_ACCOUNT_CHANGED')
    quality(c, native)
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    result = transport(plan_for(c, native), 'diagnose')
    need(result['status'] == 'DEPENDENCY_SECURITY_FAILED_BUILD_DIAGNOSED', 'DIAGNOSIS_FAILED')
    print(json.dumps(result))


def publish(c):
    check(c)
    native = identity(c)
    need(json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == '098208446664', 'AWS_ACCOUNT_CHANGED')
    qa = quality(c, native)
    jobs = github('actions/runs/' + native['workflowRunId'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    rows = [a for a in github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
            if a['name'] == PREFIX + '-native-' + native['commit'] + '-' + native['workflowRunAttempt'] and not a['expired']]
    need(len(rows) == 1, 'NATIVE_ARTIFACT_REQUIRED')
    raw = execute('gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + str(rows[0]['id']) + '/zip')
    need(rows[0].get('digest') == 'sha256:' + sha(raw), 'NATIVE_ARTIFACT_CHANGED')
    filename = PREFIX + '-artifact.tar.gz'
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(set(archive.namelist()) == {filename, 'artifact-sha256.txt'}, 'ARTIFACT_LAYOUT_CHANGED')
        bundle = archive.read(filename)
        need(sha(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'ARTIFACT_CHANGED')
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    payload = load('shared-bank-card-release.py').safe_archive(bundle, OUT / 'checked-content')
    proof_raw = (payload / 'build-proof.json').read_bytes()
    proof = json.loads(proof_raw)
    plan = {**plan_for(c, native), 'qualitySourceEvidence': qa, 'artifactSha256': sha(bundle), 'buildProofSha256': sha(proof_raw)}
    files = load('recharge-record-release.py').file_inventory(payload)
    files.pop('build-proof.json')
    R.verify_proof(proof, plan, c, files)
    path = OUT / filename
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('仅修补已审查的 API 依赖；保留当前业务源码、前端、Prisma 与代充执行器，不执行迁移或真实业务测试。\n')
    execute('gh', 'release', 'create', PREFIX + '-' + native['commit'], str(path), '--target', native['commit'],
            '--title', '生产依赖安全修补 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + PREFIX + '-' + native['commit'] + '/' + filename
    need(transport(plan, 'preflight')['status'] == 'DEPENDENCY_SECURITY_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    identity(c)
    need(transport(plan, 'release')['status'] == 'DEPENDENCY_SECURITY_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    need(transport(plan, 'readback')['status'] == 'DEPENDENCY_SECURITY_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'DEPENDENCY_SECURITY_PUBLISHED_AND_VERIFIED', 'commit': native['commit'], 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish', 'diagnose'))
    args = parser.parse_args()
    {'check': check, 'build': build, 'publish': publish, 'diagnose': diagnose}[args.mode](json.loads((HERE / P.CONTRACT_FILE).read_bytes()))
