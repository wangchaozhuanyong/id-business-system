"""Reproduce published content, then build only the approved availability delta."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.deploy/recharge-availability-release'
CONTRACT = Path(__file__).with_name('recharge-availability-contract.json')


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_AVAILABILITY_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(root):
    result = {}
    for path in root.rglob('*'):
        need(not path.is_symlink(), 'CONTENT_SYMLINK')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return result


def helper():
    spec = importlib.util.spec_from_file_location('published_record_build', Path(__file__).with_name('recharge-record-build.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.OUTPUT = OUTPUT
    return module


def platform_bytes(path):
    return subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/' + path], cwd=ROOT)


def platform_json(path):
    return json.loads(platform_bytes(path))


def verify_published_admin(contract):
    binding = contract['publishedAdminNative']
    run_id = str(binding['runId'])
    native = platform_json('actions/runs/' + run_id)
    need(native['head_sha'] == contract['sourceBaseline'] == binding['sourceCommit']
         and native['status'] == 'completed' and native['conclusion'] == binding.get('runConclusion', 'success')
         and native['path'] == binding['workflowPath'] and native['event'] == 'push'
         and native['run_attempt'] == 1, 'PUBLISHED_ADMIN_RUN_CHANGED')
    jobs = platform_json('actions/runs/' + run_id + '/attempts/1/jobs?per_page=100')['jobs']
    validators = [j for j in jobs if j['name'] == 'validate']
    need(len(validators) == 1 and validators[0]['conclusion'] == binding.get('validationConclusion', 'success')
         and any(s['name'] == 'Build Admin with Vue TypeScript checking' and s['conclusion'] == 'success'
                 for s in validators[0]['steps'])
         and [s['name'] for s in validators[0]['steps'] if s['conclusion'] == 'failure']
             == binding.get('failedValidationSteps', []), 'PUBLISHED_ADMIN_BUILD_NOT_SUCCESSFUL')
    artifacts = platform_json('actions/runs/' + run_id + '/artifacts')['artifacts']
    matches = [a for a in artifacts if a['id'] == binding['artifactId']]
    need(len(matches) == 1 and matches[0]['name'] == binding['artifactName']
         and matches[0]['expired'] is False and matches[0]['digest'] == binding['artifactDigest'],
         'PUBLISHED_ADMIN_ARTIFACT_CHANGED')
    workflow = git('show', contract['sourceBaseline'] + ':' + binding['workflowPath'])
    need(digest(workflow) == binding['workflowSha256'], 'PUBLISHED_ADMIN_COMMANDS_CHANGED')
    raw = platform_bytes('actions/artifacts/' + str(binding['artifactId']) + '/zip')
    need(len(raw) <= 8 * 1024**2 and 'sha256:' + digest(raw) == binding['artifactDigest'], 'PUBLISHED_ADMIN_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        need(len(names) == len(set(names)), 'PUBLISHED_ADMIN_DUPLICATE_PATH')
        actual = {n.removeprefix('apps/admin/dist/'): digest(archive.read(n))
                  for n in names if n.startswith('apps/admin/dist/') and not n.endswith('/')}
    need(actual == contract['publicFiles'], 'PUBLISHED_ADMIN_CONTENT_CHANGED')
    receipt = {**binding, 'verified': True,
               'publicInventorySha256': digest(json.dumps(actual, sort_keys=True, separators=(',', ':')).encode())}
    return raw, receipt


def verify_sources(contract):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    changed = set(git('diff', '--name-only', contract['reviewBase'], 'HEAD', '--', 'apps/', 'packages/').decode().splitlines())
    approved = {n for n in contract['sources'] if n.startswith(('apps/', 'packages/'))}
    need(approved <= changed and all(
        git('ls-tree', 'HEAD', '--', name) == git('ls-tree', contract['sourceBaseline'], '--', name)
        for name in changed - approved), 'SOURCE_SCOPE_CHANGED')
    for name, expected in contract['sources'].items():
        need(digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    need(git('show', contract['sourceBaseline'] + ':package-lock.json') == (ROOT / 'package-lock.json').read_bytes(), 'LOCKFILE_CHANGED')


def verify_api_outputs(before, after, modules):
    permitted = {n.removesuffix('.js') + ext for n in modules for ext in ('.js', '.js.map', '.d.ts')}
    # Incremental caches and inferred declarations are not executable output.
    # Only the finite declaration files in permitted are included in the payload.
    changed_runtime = {n for n in set(before) | set(after)
                       if n.endswith(('.js', '.js.map')) and before.get(n) != after.get(n)}
    need(changed_runtime <= permitted, 'API_OUTPUT_SCOPE_CHANGED')
    need(all(n in after for n in permitted), 'API_OUTPUT_MISSING')
    return permitted


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    if subprocess.run(['git','cat-file','-e',contract['sourceBaseline']+'^{commit}'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        run('git','fetch','--no-tags','origin',contract['sourceBaseline'])
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    h = helper()
    source = git('archive', contract['sourceBaseline'])
    for name in ('baseline', 'candidate'):
        context = OUTPUT / name
        h.extract_source(source, context)
        if name == 'candidate':
            for path in contract['sources']:
                destination = context / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((ROOT / path).read_bytes())
        run('npm', 'ci', '--no-audit', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def build():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (baseline, candidate):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    for name, expected in contract['apiModules'].items():
        path = baseline / 'apps/api/dist' / name
        need((digest(path.read_bytes()) if path.exists() else None) == expected, 'BASELINE_API_NOT_REPRODUCED')
    before = inventory(baseline / 'apps/api/dist')
    after = inventory(candidate / 'apps/api/dist')
    permitted = verify_api_outputs(before, after, contract['apiModules'])
    # Reuse the exact original successful native Admin build; do not relabel a local rebuild.
    published_admin_zip, admin_verification = verify_published_admin(contract)
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=candidate,
        env={**os.environ, 'NODE_ENV': contract['adminNodeEnv'], 'V2_BUILD_ID': 'v2-' + git('rev-parse', 'HEAD').decode().strip()})
    payload = OUTPUT / 'payload'
    payload.mkdir()
    (payload / 'baseline-admin-native.zip').write_bytes(published_admin_zip)
    for name in sorted(permitted):
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, path)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name in contract['sources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    proof = {'version': 1, 'scope': contract['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'contractSha256': digest(CONTRACT.read_bytes()),
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'controllerSha256': digest(Path(__file__).with_name('recharge-availability-release.py').read_bytes()),
             'releaseUtilitySha256': digest(Path(__file__).with_name('remote-deploy.py').read_bytes()),
             'helperSha256': digest(Path(__file__).with_name('recharge-record-release.py').read_bytes()),
             'baselineApiReproduced': True, 'baselineAdminArtifactVerified': True,
             'baselineAdminVerification': admin_verification, 'files': inventory(payload),
             'apiModules': {name: after[name] for name in sorted(permitted)},
             'adminFiles': inventory(candidate / 'apps/admin/dist'), 'updatedServices': ['api', 'admin'],
             'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'recharge-availability-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'AVAILABILITY_ARTIFACT_BUILT', 'apiFiles': len(permitted), 'adminFiles': len(proof['adminFiles'])}))


if __name__ == '__main__':
    {'prepare': prepare, 'build': build}[sys.argv[1]]()
