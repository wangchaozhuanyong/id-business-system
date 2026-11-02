"""Use the existing native OIDC/SSM release transport for one Admin settings repair."""
import argparse
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import re
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = 'permission-loading'
WORKFLOW = '.github/workflows/' + PREFIX + '-publication.yml'
OUT = ROOT / '.deploy' / PREFIX
REPO = 'wangchaozhuanyong/id-business-system'


def load(name):
    spec = importlib.util.spec_from_file_location('settings_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load(PREFIX + '-runtime.py')
F = load('financial-closure-publication.py')
F.WORKFLOW, F.P = WORKFLOW, R
need, sha, git, github, execute = R.need, R.sha, F.git, F.github, F.execute


def contract():
    return json.loads((HERE / R.CONTRACT_FILE).read_bytes())


def check(c):
    R.validate_contract(c)
    need(git('merge-base', '--is-ancestor', c['reviewBase'], 'HEAD') is not None, 'REVIEW_BASE_REQUIRED')
    need(set(git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines()) <= set(c['candidateFiles']), 'UNREVIEWED_EXTENSION')
    for name, expected in {**c['sources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    need(all(sha((HERE / n).read_bytes()) == v for n, v in c['helperPins'].items()), 'INHERITED_CONTROL_CHANGED')
    need(sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256']
         and sha((ROOT / 'package-lock.json').read_bytes()) == c['mainPackageLockSha256'], 'BUILD_INPUT_CHANGED')
    names = R.SOURCES
    originals = {n: git('show', c['reviewBase'] + ':' + n) for n in names}
    need(all(sha(originals[n]) == c['baselineReviewSources'][n] for n in names), 'BASE_SOURCE_CHANGED')
    expected = dict(originals)
    expected[names[0]] = expected[names[0]].replace(b"export type V2AsyncRegionState =\n", b"export type V2AsyncRegionState =\n  | 'inactive'\n").replace(b"  if (forbidden || phase === 'disabled') return 'forbidden';", b"  if (forbidden) return 'forbidden';\n  // A query can wait for a dependency, an active tab or an open drawer without lacking access.\n  if (phase === 'disabled') return 'inactive';")
    expected[names[1]] = expected[names[1]].replace(b'  <section\n', b"  <section\n    v-if=\"regionState !== 'inactive'\"\n", 1)
    expected[names[2]] = expected[names[2]].replace(b'      :phase="query.phase.value"\n      :previous-data=', b'      :phase="query.phase.value"\n      :forbidden="!canRead"\n      :previous-data=', 1)
    need(all((ROOT / n).read_bytes() == expected[n] for n in names), 'APPLICATION_DELTA_CHANGED')


def identity(c):
    need(json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == c['awsAccount'], 'AWS_ACCOUNT_CHANGED')
    need(os.environ.get('EXPECTED_CURRENT') == R.CURRENT, 'EXPECTED_CURRENT_CHANGED')
    return F.native_identity()


def quality(native):
    commit, tree = native['commit'], native['tree']
    prs = [p for p in github('commits/' + commit + '/pulls') if p.get('merged_at') and p['merge_commit_sha'] == commit and p['base']['ref'] == 'main']
    need(len(prs) == 1, 'MERGED_REVIEW_REQUIRED')
    pr = prs[0]
    need(git('rev-parse', pr['head']['sha'] + '^{tree}').decode().strip() == tree, 'REVIEW_TREE_CHANGED')
    output = {'commit': commit, 'tree': tree}
    for role, head, event in [('review', pr['head']['sha'], 'pull_request'), ('main', commit, 'push')]:
        runs = github('actions/workflows/quality.yml/runs?head_sha=' + head)['workflow_runs']
        runs = [r for r in runs if r['head_sha'] == head and r['event'] == event and r['conclusion'] == 'success']
        need(bool(runs), 'QUALITY_REQUIRED')
        run = runs[0]
        F.require_run(run, head, '.github/workflows/quality.yml', event)
        row = {'head': head, 'runId': str(run['id'])}
        if role == 'review':
            evidence, digest = F.artifact_json(run, 'quality-source-evidence-' + str(run['run_attempt']), 'evidence.json')
            need(evidence['testedTree'] == tree and evidence['headSha'] == head and evidence['pullRequest'] == pr['number'], 'QUALITY_TREE_CHANGED')
            row.update(pullRequest=pr['number'], sourceReceiptSha256=digest)
        output[role] = row
    return output


def plan_for(c, native):
    names = {*c['helperPins'], PREFIX + '-runtime.py', R.CONTRACT_FILE}
    return {**native, 'contractSha256': sha((HERE / R.CONTRACT_FILE).read_bytes()),
            'controlSources': {n: sha((HERE / n).read_bytes()) for n in sorted(names)}}


def transport(plan, mode):
    source = inspect.getsource(F.transport)
    need(source.count("directory/'financial-closure-release.py'") == 1, 'TRANSPORT_RECIPE_CHANGED')
    source = source.replace("directory/'financial-closure-release.py'", "directory/'permission-loading-runtime.py'")
    source = source.replace('financial-entry-', 'permission-loading-entry-')
    source = source.replace('FINANCIAL_PUBLICATION|BITBROWSER_HISTORY', 'PERMISSION_LOADING|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY')
    before = "print(json.dumps({'status':'FAILED','code':code,'mode':plan['mode'],'businessActions':0}))"
    after = "print(json.dumps({'status':'FAILED','code':code,'mode':plan['mode'],'businessActions':0,'exceptionType':type(error).__name__,'httpStatus':error.code if type(getattr(error,'code',None)) is int and 100<=error.code<=599 else None,'controlName':name if 'name' in locals() and re.fullmatch('[a-z][a-z0-9.-]{0,100}',name) else None,'entryLoaded':'module' in locals()}))"
    need(source.count(before) == 1, 'TRANSPORT_DIAGNOSTIC_RECIPE_CHANGED')
    source = source.replace(before, after)
    values = dict(F.__dict__)
    exec(compile(source, '<permission-loading-transport>', 'exec'), values)
    return values['transport'](plan, mode, OUT)


def build(c):
    check(c)
    native = identity(c)
    qa = quality(native)
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    plan = plan_for(c, native)
    parent = transport(plan, 'parent')
    need(parent['status'] == 'PERMISSION_LOADING_PARENT_VERIFIED', 'PARENT_CAPTURE_REQUIRED')
    load(PREFIX + '-build.py').build(c, plan, qa, parent, OUT, R)


def observe(c):
    check(c)
    native = identity(c)
    quality(native)
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    result = transport(plan_for(c, native), 'inspect-parent')
    need(result['status'] == 'PERMISSION_LOADING_PARENT_DIAGNOSED' and result['releaseAuthority'] is False, 'DIAGNOSTIC_FAILED')
    print(json.dumps(result, sort_keys=True))


def publish(c):
    check(c)
    native = identity(c)
    qa = quality(native)
    jobs = github('actions/runs/' + native['workflowRunId'] + '/jobs')['jobs']
    need(any(j['name'] == 'validate' and j['conclusion'] == 'success' for j in jobs), 'NATIVE_BUILD_REQUIRED')
    rows = github('actions/runs/' + native['workflowRunId'] + '/artifacts')['artifacts']
    rows = [a for a in rows if a['name'] == PREFIX + '-native-' + native['commit'] + '-' + native['workflowRunAttempt'] and not a['expired']]
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
    need(all(proof.get(k) == v for k, v in native.items()) and proof['qualitySourceEvidence'] == qa, 'BUILD_PROVENANCE_CHANGED')
    plan = {**plan_for(c, native), 'qualitySourceEvidence': qa, 'nativeParentCapture': proof['nativeParentCapture'], 'artifactSha256': sha(bundle), 'buildProofSha256': sha(proof_raw)}
    files = load('recharge-record-release.py').file_inventory(payload)
    files.pop('build-proof.json')
    R.verify_proof(proof, plan, c, files)
    path = OUT / filename
    path.write_bytes(bundle)
    notes = OUT / 'artifact-notes.md'
    notes.write_text('仅修复查询未启用被误报权限不足；仅切换 Admin，保留 API、数据库和其他六个服务。\n')
    tag = PREFIX + '-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'], '--title', '切页权限提示修复 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + filename
    need(transport(plan, 'preflight')['status'] == 'PERMISSION_LOADING_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    F.native_identity()
    need(transport(plan, 'release')['status'] == 'PERMISSION_LOADING_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    need(transport(plan, 'readback')['status'] == 'PERMISSION_LOADING_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'PERMISSION_LOADING_PUBLISHED_AND_VERIFIED', 'commit': native['commit'], 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish', 'observe'))
    args = parser.parse_args()
    {'check': check, 'build': build, 'publish': publish, 'observe': observe}[args.mode](contract())
    if args.mode == 'check':
        print(json.dumps({'status': 'PERMISSION_LOADING_SOURCE_VERIFIED'}))
