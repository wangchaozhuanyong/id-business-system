"""Reproduce published API/Admin bytes, then compile the finite mailbox delta."""
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
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/mailbox-realtime'
CONTRACT = HERE / 'mailbox-realtime-contract.json'
SCOPE = 'MAILBOX_REALTIME_20261016'


def need(value, code):
    if not value:
        raise RuntimeError('MAILBOX_REALTIME_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('mail_build_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(path):
    return load('registration-parity-diagnostics-build.py').inventory(path)


def verify_sources():
    c = json.loads(CONTRACT.read_bytes())
    load('mailbox-realtime-release.py').verify_contract(c)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', c['sourceBaseline'] + '^{tree}').decode().strip() == c['sourceBaselineTree'], 'BASE_CHANGED')
    changed = set(git('diff', '--name-only', c['sourceBaseline'], 'HEAD').decode().splitlines())
    need(changed == set(c['expectedGitChanges']), 'SOURCE_SCOPE_CHANGED')
    for name, value in {**c['sources'], **c['validationSources'], **c['reviewedFileHashes']}.items():
        need(digest((ROOT / name).read_bytes()) == value, 'REVIEWED_SOURCE_CHANGED')
    return c


def prepare():
    c = verify_sources()
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and not OUTPUT.exists(), 'NATIVE_BUILD_REQUIRED')
    p = load('registration-parity-diagnostics-build.py')
    parent = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())
    # These are the three successful predecessor publications, not the later unfinished candidate.
    p.native_proof(parent['parentNative'])
    p.native_proof(parent['successorNative'])
    p.native_proof(parent['dragNative'])
    OUTPUT.mkdir(parents=True, mode=0o700)
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        p.reconstruct(context, parent)
        if role == 'candidate':
            for name in {**c['sources'], **c['validationSources']}:
                destination = context / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((ROOT / name).read_bytes())
        p.verify_runtime_schema(context, c)
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def build():
    c = verify_sources()
    b, a = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (b, a):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    before, after = inventory(b / 'apps/api/dist'), inventory(a / 'apps/api/dist')
    need({n: v for n, v in before.items() if n.endswith('.js')} == c['baselineApiFiles'], 'BASE_API_NOT_REPRODUCED')
    modules = load('registration-parity-diagnostics-build.py').api_delta(before, after, c['apiModules'])
    # No generated client or shared JS is delivered. Verify its compiled runtime is unchanged.
    shared = lambda context: {n: v for n, v in inventory(context / 'packages/shared/dist').items() if n.endswith('.js')}
    need(shared(b) == shared(a), 'SHARED_RUNTIME_CHANGED')
    commit, tree = (git('rev-parse', ref).decode().strip() for ref in ('HEAD', 'HEAD^{tree}'))
    for context, build_id in [(b, c['baselineAdminBuildId']), (a, 'v2-' + commit)]:
        run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': build_id})
    need(inventory(b / 'apps/admin/dist') == c['baselineAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    payload = OUTPUT / 'payload'
    payload.mkdir(mode=0o700)
    for name in modules:
        out = payload / 'api/modules' / name
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(a / 'apps/api/dist' / name, out)
    shutil.copytree(a / 'apps/admin/dist', payload / 'admin/html')
    for name in c['sources']:
        out = payload / 'source' / name
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(a / name, out)
    proof = {'version': 1, 'scope': SCOPE, 'commit': commit, 'tree': tree,
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(CONTRACT.read_bytes()), 'sources': c['sources'],
             'validationSources': c['validationSources'], 'apiModules': modules, 'workerFiles': {},
             'adminFiles': inventory(payload / 'admin/html'), 'files': inventory(payload),
             'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'sharedRuntimeUnchanged': True,
             'updatedServices': ['api', 'admin'], 'migrationPerformed': False, 'businessActions': 0,
             'controlSources': {name: digest((HERE / name).read_bytes()) for name in c['controlFiles']}}
    (OUTPUT / 'prepared-build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')


def validate():
    c = verify_sources()
    context = OUTPUT / 'candidate'
    for workspace, tests in [('apps/api', c['apiTests']), ('apps/admin', c['adminTests'])]:
        run('npm', 'run', 'typecheck', '--workspace', workspace, cwd=context)
        run('npm', 'run', 'test', '--workspace', workspace, '--', *tests, cwd=context)
    for guard in ('admin-ui', 'v2-ui-language', 'v2-color-contrast', 'v2-table-standard',
                  'v2-loading-standard', 'v2-module-architecture', 'v2-isolation'):
        run('npm', 'run', 'check:' + guard, cwd=context)
    for args in ([], ['--actions-only']):
        run('node', 'scripts/acceptance-v2-mailbox-realtime.mjs', *args, cwd=context)
    receipt = {'scope': SCOPE, 'sources': c['sources'], 'validationSources': c['validationSources'],
               'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'}
    (OUTPUT / 'validation-receipt.json').write_text(json.dumps(receipt, sort_keys=True) + '\n')


def package():
    c = verify_sources()
    payload = OUTPUT / 'payload'
    proof = json.loads((OUTPUT / 'prepared-build-proof.json').read_bytes())
    need(proof['commit'] == git('rev-parse', 'HEAD').decode().strip()
         and proof['contractSha256'] == digest(CONTRACT.read_bytes())
         and inventory(payload) == proof['files'], 'COMPILED_INPUT_MOVED')
    proof['validation'] = json.loads((OUTPUT / 'validation-receipt.json').read_bytes())
    plan = {n: proof[n] for n in ('commit', 'tree', 'contractSha256', 'controlSources')}
    load('mailbox-realtime-release.py').verify_proof(proof, plan, c, payload, load('recharge-record-release.py'))
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'mailbox-realtime-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')


def main(args):
    need(args in (['prepare'], ['build'], ['validate'], ['package']), 'BUILD_MODE_INVALID')
    globals()[args[0]]()


if __name__ == '__main__':
    main(sys.argv[1:])
