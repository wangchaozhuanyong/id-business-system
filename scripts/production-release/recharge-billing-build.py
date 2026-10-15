"""Build a finite billing overlay from an authenticated published predecessor."""
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
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/recharge-billing-release'
CONTRACT = HERE / 'recharge-billing-contract.json'


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_BILLING_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('billing_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(root):
    return load('recharge-record-release.py').file_inventory(root)


def verify_sources(contract):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    before = contract['sourceBaseline']
    need(git('rev-parse', before + '^{tree}').decode().strip() == contract['sourceBaselineTree'], 'BASE_TREE_CHANGED')
    changed = set(git('diff', '--name-only', contract['reviewBase'], 'HEAD', '--', 'apps/', 'packages/').decode().splitlines())
    need(changed == set(contract['sources']), 'SOURCE_SCOPE_CHANGED')
    for name, expected in contract['sources'].items():
        need((name.startswith(('apps/admin/src/v2/features/auto-recharge/',
                             'apps/api/src/id-business-v2/auto-recharge/')) or name == contract['migration']['path'])
             and digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    # Preserve all ordinary frontend inputs, dependencies, Prisma and build commands.
    names = git('ls-tree', '-r', '--name-only', before).decode().splitlines()
    for name in names:
        if (name.startswith(('apps/admin/', 'packages/shared/', 'apps/api/prisma-mysql/'))
                or name in ('package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc',
                            'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json')):
            if name not in contract['sources']:
                need(git('ls-tree', 'HEAD', '--', name) == git('ls-tree', before, '--', name), 'PRESERVED_INPUT_CHANGED')


def verify_native_baseline(contract):
    native = contract['baselineNative']
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    def api(path):
        return subprocess.check_output(['gh', 'api', prefix + path], cwd=ROOT)
    run_meta = json.loads(api('actions/runs/' + str(native['runId'])))
    need(run_meta['head_sha'] == contract['sourceBaseline'] and run_meta['conclusion'] == 'success'
         and run_meta['path'] == '.github/workflows/recharge-availability-validation.yml'
         and run_meta['event'] == 'workflow_dispatch' and run_meta['run_attempt'] == 1, 'BASE_NATIVE_CHANGED')
    meta = json.loads(api('actions/artifacts/' + str(native['artifactId'])))
    need(meta['digest'] == native['artifactDigest'] and not meta['expired']
         and meta['workflow_run']['id'] == native['runId'], 'BASE_ARTIFACT_CHANGED')
    raw = api('actions/artifacts/' + str(native['artifactId']) + '/zip')
    need(len(raw) < 32 * 1024**2 and 'sha256:' + digest(raw) == native['artifactDigest'], 'BASE_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(set(archive.namelist()) == {'recharge-availability-artifact.tar.gz', 'artifact-sha256.txt'}, 'BASE_LAYOUT_CHANGED')
        bundle = archive.read('recharge-availability-artifact.tar.gz')
        need(digest(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'BASE_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        proof = json.load(archive.extractfile('payload/build-proof.json'))
        need(proof['commit'] == contract['sourceBaseline'] and proof['adminFiles'] == contract['baselineAdminFiles'], 'BASE_PROOF_CHANGED')
        for name, expected in proof['adminFiles'].items():
            need(digest(archive.extractfile('payload/admin/html/' + name).read()) == expected, 'BASE_ADMIN_CHANGED')
    return {**native, 'verified': True}


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    raw = git('archive', contract['sourceBaseline'])
    h = load('recharge-record-build.py')
    for name in ('baseline', 'candidate'):
        context = OUTPUT / name
        h.extract_source(raw, context)
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
    before, after = inventory(baseline / 'apps/api/dist'), inventory(candidate / 'apps/api/dist')
    for name, expected in contract['apiModules'].items():
        need(before.get(name) == expected, 'BASE_API_NOT_REPRODUCED')
    allowed = load('recharge-availability-build.py').verify_api_outputs(before, after, contract['apiModules'])
    native = verify_native_baseline(contract)
    commit, tree = (git('rev-parse', ref).decode().strip() for ref in ('HEAD', 'HEAD^{tree}'))
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=candidate,
        env={**os.environ, 'NODE_ENV': 'test', 'V2_BUILD_ID': 'v2-' + commit})
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for name in allowed:
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, path)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name in contract['sources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    finish(contract, payload, {n: after[n] for n in sorted(allowed)}, native, commit, tree)


def finish(contract, payload, api_modules, native, commit, tree, reused=None):
    database = {'isolated': True, 'suite': 'recharge-billing.mysql.integration.spec.ts'}
    if reused:
        database['reusedFrom'] = reused
    proof = {'version': 1, 'scope': contract['scope'], 'commit': commit, 'tree': tree,
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(CONTRACT.read_bytes()), 'baselineApiReproduced': True,
             'baselineNativeVerified': native, 'databaseVerification': database,
             'files': inventory(payload), 'apiModules': api_modules,
             'adminFiles': inventory(payload / 'admin/html'), 'updatedServices': ['api', 'admin'],
             'migrationPerformed': False, 'plannedMigration': contract['migration'], 'businessActions': 0}
    if reused:
        proof['apiCompilationReused'] = {**reused, 'verified': True}
    for field, name in [('controllerSha256', 'recharge-billing-release.py'), ('releaseUtilitySha256', 'remote-deploy.py'), ('helperSha256', 'recharge-record-release.py')]:
        proof[field] = digest((HERE / name).read_bytes())
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'recharge-billing-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'BILLING_ARTIFACT_BUILT', 'apiFiles': len(api_modules), 'adminFiles': len(proof['adminFiles']), 'validationReused': bool(reused)}))


def verify_reuse_inputs(contract, prior, old_contract):
    # Control-only successor: all application, schema, dependency and compiler
    # inputs must still equal the run that actually passed the database suites.
    need({k: v for k, v in contract.items() if k != 'priorValidationNative'} == old_contract, 'REUSE_CONTRACT_CHANGED')
    inputs = ('apps/', 'packages/', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc')
    need(not git('diff', '--name-only', prior['commit'], 'HEAD', '--', *inputs).strip(), 'REUSE_SOURCE_CHANGED')
    need(git('rev-parse', prior['commit'] + '^{tree}').decode().strip() == prior['tree'], 'REUSE_TREE_CHANGED')


def verified_prior_artifact(contract):
    prior = contract['priorValidationNative']
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    def api(path):
        return subprocess.check_output(['gh', 'api', prefix + path], cwd=ROOT)
    old_raw = git('show', prior['commit'] + ':scripts/production-release/recharge-billing-contract.json')
    need(digest(old_raw) == prior['contractSha256'], 'REUSE_CONTRACT_DIGEST_CHANGED')
    old_contract = json.loads(old_raw)
    verify_reuse_inputs(contract, prior, old_contract)
    run_meta = json.loads(api('actions/runs/' + str(prior['runId'])))
    need(run_meta['head_sha'] == prior['commit'] and run_meta['head_branch'] == 'main'
         and run_meta['event'] == 'workflow_dispatch' and run_meta['run_attempt'] == prior['attempt']
         and run_meta['path'] == '.github/workflows/recharge-billing-validation.yml', 'REUSE_NATIVE_CHANGED')
    # The publication job failed, so bind the successful validation job itself.
    jobs = json.loads(api('actions/runs/' + str(prior['runId']) + '/attempts/' + str(prior['attempt']) + '/jobs'))['jobs']
    jobs = [j for j in jobs if j['name'] == 'validate']
    need(len(jobs) == 1 and jobs[0]['id'] == prior['jobId'] and jobs[0]['status'] == 'completed'
         and jobs[0]['conclusion'] == 'success', 'REUSE_JOB_NOT_SUCCESSFUL')
    successful_steps = {s['name'] for s in jobs[0]['steps'] if s['conclusion'] == 'success'}
    need(set(prior['requiredSteps']).issubset(successful_steps), 'REUSE_REQUIRED_STEP_MISSING')
    metadata = json.loads(api('actions/artifacts/' + str(prior['artifactId'])))
    need(not metadata['expired'] and metadata['workflow_run']['id'] == prior['runId']
         and metadata['digest'] == prior['artifactDigest']
         and metadata['name'] == 'recharge-billing-' + prior['commit'] + '-' + str(prior['attempt']), 'REUSE_ARTIFACT_CHANGED')
    raw = api('actions/artifacts/' + str(prior['artifactId']) + '/zip')
    need(len(raw) <= 32 * 1024**2 and 'sha256:' + digest(raw) == prior['artifactDigest'], 'REUSE_ARTIFACT_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        need(set(archive.namelist()) == {'recharge-billing-artifact.tar.gz', 'artifact-sha256.txt'}, 'REUSE_ARTIFACT_LAYOUT_CHANGED')
        bundle = archive.read('recharge-billing-artifact.tar.gz')
        need(digest(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'REUSE_BUNDLE_CHANGED')
    h, r = load('recharge-record-release.py'), load('recharge-billing-release.py')
    payload = h.safe_archive(bundle, OUTPUT / 'prior')
    proof_raw = (payload / 'build-proof.json').read_bytes()
    need(digest(proof_raw) == prior['proofSha256'], 'REUSE_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    need(proof['commit'] == prior['commit'] and proof['tree'] == prior['tree']
         and proof['workflowRunId'] == str(prior['runId']) and proof['workflowRunAttempt'] == str(prior['attempt'])
         and proof['contractSha256'] == prior['contractSha256'], 'REUSE_PROOF_IDENTITY_CHANGED')
    r.validate_proof(proof, proof, old_contract, payload, h)
    (OUTPUT / 'reused-native-artifact.zip').write_bytes(raw)
    (OUTPUT / 'reused-validation.json').write_text(json.dumps({**prior, 'verified': True}, sort_keys=True) + '\n')
    return payload, proof


def reuse():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    prior_payload, prior_proof = verified_prior_artifact(contract)
    # V2_BUILD_ID changes with this control successor; rebuild Admin for that
    # changed input. API compilation and all 38 DB tests keep their native run.
    candidate = OUTPUT / 'candidate'
    load('recharge-record-build.py').extract_source(git('archive', contract['sourceBaseline']), candidate)
    for name in contract['sources']:
        path = candidate / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    run('npm', 'ci', '--no-audit', cwd=candidate)
    run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=candidate)
    commit, tree = (git('rev-parse', ref).decode().strip() for ref in ('HEAD', 'HEAD^{tree}'))
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=candidate,
        env={**os.environ, 'NODE_ENV': 'test', 'V2_BUILD_ID': 'v2-' + commit})
    payload = OUTPUT / 'payload'
    payload.mkdir()
    for name in ('api', 'source'):
        shutil.copytree(prior_payload / name, payload / name)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    finish(contract, payload, prior_proof['apiModules'], prior_proof['baselineNativeVerified'], commit, tree,
           reused=contract['priorValidationNative'])


if __name__ == '__main__':
    {'prepare': prepare, 'build': build, 'reuse': reuse}[sys.argv[1]]()
