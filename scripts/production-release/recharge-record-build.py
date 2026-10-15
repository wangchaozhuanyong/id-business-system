"""Build the finite diagnostic repair and reproduce the live predecessor content."""
import ast
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


def platform_json(path):
    result = subprocess.run(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/' + path],
                            cwd=ROOT, capture_output=True)
    need(result.returncode == 0, 'PRIOR_VALIDATION_PLATFORM_UNAVAILABLE')
    return json.loads(result.stdout)


def verify_prior_application_validation(contract):
    prior = contract['priorApplicationValidation']
    need(prior['sourceBaseline'] == contract['sourceBaseline'], 'PRIOR_VALIDATION_SOURCE_CHANGED')
    old = json.loads(git('show', prior['commit'] + ':scripts/production-release/recharge-record-contract.json'))
    need(all(old.get(key) == contract.get(key) for key in
             ('sourceBaseline', 'sourceBaselineTree', 'changedSources', 'validationOnlySources')),
         'PRIOR_VALIDATION_SOURCE_CHANGED')
    workflow = git('show', prior['commit'] + ':.github/workflows/recharge-record-validation.yml')
    need(digest(workflow.encode()) == prior['workflowSha256'], 'PRIOR_VALIDATION_COMMANDS_CHANGED')
    functions = {'prepare', 'extract_source', 'run'}
    def preparation(source):
        return {node.name: ast.dump(node, include_attributes=False) for node in ast.parse(source).body
                if isinstance(node, ast.FunctionDef) and node.name in functions}
    need(preparation(git('show', prior['commit'] + ':scripts/production-release/recharge-record-build.py'))
         == preparation(Path(__file__).read_text()), 'PRIOR_VALIDATION_PREPARATION_CHANGED')
    native = platform_json('actions/runs/' + prior['runId'])
    need(native['head_sha'] == prior['commit'] and native['head_branch'] == 'main'
         and native['event'] == 'workflow_dispatch' and native['run_attempt'] == 1
         and native['path'] == '.github/workflows/recharge-record-validation.yml',
         'PRIOR_VALIDATION_IDENTITY_CHANGED')
    jobs = platform_json('actions/runs/' + prior['runId'] + '/attempts/1/jobs')['jobs']
    validators = [job for job in jobs if job['name'] == 'validate']
    need(len(validators) == 1 and validators[0]['status'] == 'completed'
         and validators[0]['conclusion'] == 'success', 'PRIOR_APPLICATION_CHECKS_NOT_SUCCESSFUL')
    return {'status': 'PRIOR_NATIVE_APPLICATION_CHECKS_REUSED', 'workflowRunId': prior['runId'],
            'commit': prior['commit'], 'candidateSourceUnchanged': True,
            'reused': ['diagnostic-and-form-tests', 'seven-ui-boundaries', 'connector-tests'],
            'publicationReused': False}


def matches_published_source(name, baseline):
    current = git('ls-tree', 'HEAD', '--', name)
    published = git('ls-tree', baseline, '--', name)
    return current == published and (not current or current.split()[0] in ('100644', '100755'))


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
    # Admit only source already present in the immutable published API/Admin/engine roles.
    published = {}
    for role in ('Admin', 'Engine'):
        for name, expected in contract.get('published' + role + 'Sources', {}).items():
            commit = contract['preserved' + role + 'Commit']
            need(digest(subprocess.check_output(['git', 'show', commit + ':' + name], cwd=ROOT)) == expected,
                 'PUBLISHED_SOURCE_CHANGED')
            published[name] = commit
    need(set(sources) <= changed and all(
        matches_published_source(name, published.get(name, contract['sourceBaseline']))
        for name in changed - set(sources)), 'SOURCE_SCOPE_CHANGED')
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


def admin_dependencies(context):
    # Preserve the API's normal dependency layout for declaration generation.
    # Only the subsequent frontend bundle uses the published realpath order.
    modules = context / 'node_modules'
    modules.rename(context / 'node_modules-api')
    modules.mkdir()
    dependencies = OUTPUT / '00-dependencies'
    for package in (dependencies / 'node_modules').iterdir():
        if package.name != '@apple-business':
            (modules / package.name).symlink_to(package, target_is_directory=True)
    workspaces = modules / '@apple-business'
    workspaces.mkdir()
    for package in (dependencies / 'node_modules/@apple-business').iterdir():
        relative = package.resolve().relative_to(dependencies)
        (workspaces / package.name).symlink_to(context / relative, target_is_directory=True)


def prepare():
    os.umask(0o077)
    contract = json.loads(CONTRACT.read_bytes())
    verify_scope(contract)
    need(not OUTPUT.exists(), 'BUILD_OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    # Rolldown orders module identifiers by resolved path. Keep dependency realpaths
    # before both source trees, as in the published build, without changing versions.
    dependencies = OUTPUT / '00-dependencies'
    source = subprocess.check_output(['git', 'archive', contract['sourceBaseline']], cwd=ROOT)
    extract_source(source, dependencies)
    run('npm', 'ci', '--no-audit', cwd=dependencies)
    baseline = OUTPUT / 'baseline'
    extract_source(source, baseline)
    candidate = OUTPUT / 'candidate'
    extract_source(source, candidate)
    for name in {**contract['changedSources'], **contract.get('validationOnlySources', {})}:
        (candidate / name).write_bytes((ROOT / name).read_bytes())
    for context in (baseline, candidate):
        run('npm', 'ci', '--no-audit', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def overlay_published_admin(context, contract):
    for name, expected in contract['publishedAdminSources'].items():
        raw = subprocess.check_output(['git', 'show', contract['preservedAdminCommit'] + ':' + name], cwd=ROOT)
        need(digest(raw) == expected, 'PUBLISHED_ADMIN_SOURCE_CHANGED')
        (context / name).write_bytes(raw)


def build():
    contract = json.loads(CONTRACT.read_bytes())
    verify_scope(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=baseline)
    overlay_published_admin(baseline, contract)
    admin_dependencies(baseline)
    baseline_env = {**os.environ, 'NODE_ENV': 'production',
                    'V2_BUILD_ID': 'v2-' + contract['preservedAdminCommit']}
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=baseline, env=baseline_env)
    need(digest((baseline / MODULE).read_bytes()) == contract['apiValidationSha256'],
         'BASELINE_API_NOT_REPRODUCED')
    need(inventory(baseline / 'apps/admin/dist') == contract['publicFiles'],
         'BASELINE_ADMIN_NOT_REPRODUCED')
    run('npm', 'run', 'typecheck', '--workspace', 'apps/api', cwd=candidate)
    run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=candidate)
    overlay_published_admin(candidate, contract)
    run('npm', 'run', 'typecheck', '--workspace', 'apps/admin', cwd=candidate)
    run('npm', 'run', 'test', '--workspace', 'apps/admin', '--',
        'src/v2/features/online-recharge/api.spec.ts', cwd=candidate)
    admin_dependencies(candidate)
    commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
    run('npm', 'run', 'build', '--workspace', 'apps/admin',
        cwd=candidate, env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + commit})
    payload = OUTPUT / 'payload'
    (payload / 'api').mkdir(parents=True)
    shutil.copyfile(candidate / MODULE, payload / 'api/recharge-validation.js')
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name in {**contract['changedSources'], **contract['publishedAdminSources']}:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((candidate / name).read_bytes())
    proof = {'version': 3, 'scope': 'RECHARGE_RECORD_DIAGNOSTICS_ONLY',
             'commit': commit, 'tree': tree, 'contractSha256': digest(CONTRACT.read_bytes()),
             'workflowRunId': os.environ['GITHUB_RUN_ID'],
             'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'sourceBaseline': contract['sourceBaseline'],
             'liveManifestSha256': contract['manifestSha256'],
             'baselineApiReproduced': True, 'baselineAdminReproduced': True,
             'publishedAdminPatchCommit': contract['preservedAdminCommit'],
             'publishedAdminSources': contract['publishedAdminSources'],
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
    need(sys.argv[1:] in (['prepare'], ['build'], ['verify-prior-validation']), 'BUILD_MODE_INVALID')
    if sys.argv[1] == 'verify-prior-validation':
        contract = json.loads(CONTRACT.read_bytes())
        verify_scope(contract)
        print(json.dumps(verify_prior_application_validation(contract), sort_keys=True))
    else:
        prepare() if sys.argv[1] == 'prepare' else build()
