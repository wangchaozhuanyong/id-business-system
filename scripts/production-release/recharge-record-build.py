"""Build the finite diagnostic repair and reproduce the live predecessor content."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import sys

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / 'scripts/production-release/recharge-record-contract.json'
OUTPUT = ROOT / '.deploy/recharge-record-release'
MODULE = 'apps/api/dist/id-business-v2/auto-recharge/recharge-validation.js'


def need(condition, code):
    if not condition:
        raise RuntimeError('RECHARGE_RECORD_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inventory(root):
    rows = {}
    for path in root.rglob('*'):
        need(not path.is_symlink(), 'CONTENT_SYMLINK')
        if path.is_file():
            rows[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return rows


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode().strip()


def verify_scope(contract):
    need(git('rev-parse', contract['sourceBaseline'] + '^{tree}') == contract['sourceBaselineTree'],
         'PUBLISHED_SOURCE_TREE_CHANGED')
    changed = set(git('diff', '--name-only', contract['mainBase'], 'HEAD', '--',
                      'apps/', 'packages/', 'deploy/', 'package.json', 'package-lock.json',
                      'tsconfig.base.json', 'docker-compose.aws-mysql.yml').splitlines())
    validation_only = contract.get('validationOnlySources', {})
    need(set(validation_only) <= {'apps/api/src/id-business-v2/auto-recharge/worker/test_payment.py'},
         'VALIDATION_SCOPE_CHANGED')
    sources = {**contract['changedSources'], **validation_only}
    need(changed == set(sources), 'SOURCE_SCOPE_CHANGED')
    need(all(digest((ROOT / name).read_bytes()) == sha
             for name, sha in sources.items()), 'REPAIR_SOURCE_CHANGED')
    need(not git('status', '--porcelain', '--untracked-files=no'), 'SOURCE_DIRTY')


def extract_source(raw, target):
    target.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive.getmembers():
            parts = Path(item.name).parts
            need(bool(parts) and not item.name.startswith('/') and '..' not in parts
                 and (item.isfile() or item.isdir()), 'SOURCE_ARCHIVE_INVALID')
            if item.isdir():
                (target / item.name).mkdir(parents=True, exist_ok=True)
            else:
                path = target / item.name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(item).read())
                path.chmod(0o755 if item.mode & 0o111 else 0o644)


def prepare():
    os.umask(0o077)
    contract = json.loads(CONTRACT.read_bytes())
    verify_scope(contract)
    need(not OUTPUT.exists(), 'BUILD_OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    baseline = OUTPUT / 'baseline'
    extract_source(subprocess.check_output(['git', 'archive', contract['sourceBaseline']], cwd=ROOT), baseline)
    candidate = OUTPUT / 'candidate'
    extract_source(subprocess.check_output(['git', 'archive', contract['sourceBaseline']], cwd=ROOT), candidate)
    for name in {**contract['changedSources'], **contract.get('validationOnlySources', {})}:
        (candidate / name).write_bytes((ROOT / name).read_bytes())
    for context in (baseline, candidate):
        run('npm', 'ci', '--no-audit', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def build():
    contract = json.loads(CONTRACT.read_bytes())
    verify_scope(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=baseline)
    baseline_env = {**os.environ, 'VITE_BUILD_ID': 'v2-' + contract['sourceBaseline']}
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=baseline, env=baseline_env)
    need(digest((baseline / MODULE).read_bytes()) == contract['apiValidationSha256'],
         'BASELINE_API_NOT_REPRODUCED')
    need(inventory(baseline / 'apps/admin/dist') == contract['publicFiles'],
         'BASELINE_ADMIN_NOT_REPRODUCED')
    run('npm', 'run', 'typecheck', '--workspace', 'apps/api', cwd=candidate)
    run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=candidate)
    commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
    run('npm', 'run', 'build', '--workspace', 'apps/admin',
        cwd=candidate, env={**os.environ, 'VITE_BUILD_ID': 'v2-' + commit})
    payload = OUTPUT / 'payload'
    (payload / 'api').mkdir(parents=True)
    shutil.copyfile(candidate / MODULE, payload / 'api/recharge-validation.js')
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name in contract['changedSources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((candidate / name).read_bytes())
    proof = {'version': 1, 'scope': 'RECHARGE_RECORD_DIAGNOSTICS_ONLY',
             'commit': commit, 'tree': tree, 'contractSha256': digest(CONTRACT.read_bytes()),
             'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'sourceBaseline': contract['sourceBaseline'],
             'liveManifestSha256': contract['manifestSha256'],
             'baselineApiReproduced': True, 'baselineAdminReproduced': True,
             'controllerSha256': digest((ROOT / 'scripts/production-release/recharge-record-release.py').read_bytes()),
             'releaseUtilitySha256': digest((ROOT / 'scripts/production-release/remote-deploy.py').read_bytes()),
             'files': inventory(payload), 'updatedServices': ['api', 'admin'],
             'dependentServiceRebound': 'online-recharge',
             'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    archive = OUTPUT / 'recharge-record-artifact.tar.gz'
    with tarfile.open(archive, 'w:gz') as output:
        output.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(archive.read_bytes()) + '\n')
    print(json.dumps({'status': 'RECHARGE_RECORD_BUILT', 'commit': commit,
                      'baselineReproduced': True, 'artifactSha256': digest(archive.read_bytes())}))


if __name__ == '__main__':
    need(sys.argv[1:] in (['prepare'], ['build']), 'BUILD_MODE_INVALID')
    prepare() if sys.argv[1] == 'prepare' else build()
