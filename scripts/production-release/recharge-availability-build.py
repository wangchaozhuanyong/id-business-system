"""Reproduce published content, then build only the approved availability delta."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

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
    # Reproduce the published 20a8 CI build environment and ordinary npm layout.
    for context, build_id in ((baseline, contract['preservedAdminCommit']), (candidate, git('rev-parse', 'HEAD').decode().strip())):
        run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': contract['adminNodeEnv'], 'V2_BUILD_ID': 'v2-' + build_id})
    need(inventory(baseline / 'apps/admin/dist') == contract['publicFiles'], 'BASELINE_ADMIN_NOT_REPRODUCED')
    payload = OUTPUT / 'payload'
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
             'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'files': inventory(payload),
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
