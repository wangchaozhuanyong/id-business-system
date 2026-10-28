"""Use the existing native OIDC/SSM release transport for one Admin settings repair."""
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
PREFIX = 'mailbox-settings'
WORKFLOW = '.github/workflows/' + PREFIX + '-publication.yml'
OUT = ROOT / '.deploy' / PREFIX
REPO = 'wangchaozhuanyong/id-business-system'


def load(name):
    spec = importlib.util.spec_from_file_location('settings_publication_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


R = load(PREFIX + '-runtime.py')
M = load('mailbox-validity-publication.py')
F = M.F
F.WORKFLOW, F.P = WORKFLOW, R
need, sha, git, github, execute = R.need, R.sha, M.git, M.github, M.execute


def contract():
    return json.loads((HERE / R.CONTRACT_FILE).read_bytes())


def check(c):
    R.validate_contract(c)
    old = git('show', R.CURRENT + ':' + R.SOURCE)
    before = b"const queryCodeSettingsSnapshot = ref('');"
    after = b'const queryCodeSettingsSnapshot = ref(JSON.stringify(queryCodeSettingsForm));'
    need(old.count(before) == 1 and (ROOT / R.SOURCE).read_bytes() == old.replace(before, after), 'APPLICATION_DELTA_CHANGED')
    need(set(git('diff', '--name-only', R.CURRENT, 'HEAD').decode().splitlines()) <= set(c['candidateFiles']), 'UNREVIEWED_EXTENSION')
    for name, expected in {**c['sources'], **c['validationSources']}.items():
        need(sha((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    need(all(sha(git('show', R.CURRENT + ':' + n)) == v for n, v in c['baselineSources'].items()), 'BASE_SOURCE_CHANGED')
    need(all(sha((HERE / n).read_bytes()) == v for n, v in c['helperPins'].items()), 'INHERITED_CONTROL_CHANGED')
    need(sha((ROOT / 'package-lock.json').read_bytes()) == c['packageLockSha256']
         and sha((ROOT / WORKFLOW).read_bytes()) == c['workflowSha256'], 'BUILD_INPUT_CHANGED')


def identity(c):
    need(json.loads(execute('aws', 'sts', 'get-caller-identity', '--output', 'json'))['Account'] == c['awsAccount'], 'AWS_ACCOUNT_CHANGED')
    need(os.environ.get('EXPECTED_CURRENT') == R.CURRENT, 'EXPECTED_CURRENT_CHANGED')
    return F.native_identity()


def quality(native):
    qa = M.quality(native['commit'], native['tree'])
    jobs = github('actions/runs/' + qa['pull_request']['runId'] + '/jobs?per_page=100')['jobs']
    need(any(j['name'] in ('recharge (admin)', 'full-quality') and j['conclusion'] == 'success' for j in jobs), 'FRESH_ADMIN_QUALITY_REQUIRED')
    return qa


def plan_for(c, native):
    names = {*c['helperPins'], PREFIX + '-runtime.py', R.CONTRACT_FILE}
    return {**native, 'contractSha256': sha((HERE / R.CONTRACT_FILE).read_bytes()),
            'controlSources': {n: sha((HERE / n).read_bytes()) for n in sorted(names)}}


def transport(plan, mode):
    source = inspect.getsource(F.transport)
    need(source.count("directory/'financial-closure-release.py'") == 1, 'TRANSPORT_RECIPE_CHANGED')
    source = source.replace("directory/'financial-closure-release.py'", "directory/'mailbox-settings-runtime.py'")
    source = source.replace('financial-entry-', 'mailbox-settings-entry-')
    source = source.replace('FINANCIAL_PUBLICATION|BITBROWSER_HISTORY', 'MAILBOX_SETTINGS|FINANCIAL_PUBLICATION|BITBROWSER_HISTORY')
    values = dict(F.__dict__)
    exec(compile(source, '<mailbox-settings-transport>', 'exec'), values)
    return values['transport'](plan, mode, OUT)


def build(c):
    check(c)
    native = identity(c)
    qa = quality(native)
    need(not OUT.exists(), 'OUTPUT_EXISTS')
    OUT.mkdir(parents=True, mode=0o700)
    plan = plan_for(c, native)
    parent = transport(plan, 'parent')
    need(parent['status'] == 'MAILBOX_SETTINGS_PARENT_VERIFIED', 'PARENT_CAPTURE_REQUIRED')
    load(PREFIX + '-build.py').build(c, plan, qa, parent, OUT, R)


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
    notes.write_text('仅修复邮箱默认有效期表单初始状态；仅切换 Admin，API、数据库和其他服务保持不变。\n')
    tag = PREFIX + '-' + native['commit']
    execute('gh', 'release', 'create', tag, str(path), '--target', native['commit'], '--title', '邮箱有效期设置 ' + native['commit'][:12], '--notes-file', str(notes), '--prerelease')
    plan['artifactUrl'] = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + filename
    need(transport(plan, 'preflight')['status'] == 'MAILBOX_SETTINGS_PREFLIGHT_VERIFIED', 'PREFLIGHT_FAILED')
    (OUT / 'publication-plan.json').write_text(json.dumps(plan, sort_keys=True, indent=2) + '\n')
    need(transport(plan, 'release')['status'] == 'MAILBOX_SETTINGS_DEPLOYED', 'RELEASE_NOT_DEPLOYED')
    need(transport(plan, 'readback')['status'] == 'MAILBOX_SETTINGS_READBACK_VERIFIED', 'READBACK_FAILED')
    print(json.dumps({'status': 'MAILBOX_SETTINGS_PUBLISHED_AND_VERIFIED', 'commit': native['commit'], 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('check', 'build', 'publish'))
    args = parser.parse_args()
    {'check': check, 'build': build, 'publish': publish}[args.mode](contract())
