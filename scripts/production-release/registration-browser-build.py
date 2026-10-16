"""Reconstruct the accepted 6fc runtime, then build only the browser-mode delta."""
import ast
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import types
import zipfile
import importlib.util

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONTRACT = HERE / 'registration-browser-contract.json'
OUTPUT = ROOT / '.deploy/registration-browser'
spec = importlib.util.spec_from_file_location('browser_release', HERE / 'registration-browser-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
SCOPE, CURRENT, CURRENT_TREE = r.SCOPE, r.CURRENT, r.CURRENT_TREE
SOURCE_BASE, SOURCE_TREE = r.SOURCE_BASE, r.SOURCE_TREE
need, digest, WORKER = r.need, r.digest, r.WORKER


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def verify_sources(contract):
    r.verify_contract(contract)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', SOURCE_BASE + '^{tree}').decode().strip() == SOURCE_TREE, 'BASE_TREE_CHANGED')
    changed = git('diff', '--name-only', SOURCE_BASE, 'HEAD').decode().splitlines()
    need(len(changed) == len(set(changed)) and set(changed) == set(contract['sourceDeltaPaths']),
         'SOURCE_SCOPE_CHANGED')
    for name, expected in contract['reviewedFileHashes'].items():
        need('..' not in Path(name).parts and not (ROOT / name).is_symlink()
             and digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    need(all(contract['reviewedFileHashes'].get(name) == value
             for name, value in {**contract['sources'], **contract['validationSources']}.items()),
         'SOURCE_HASH_CLOSURE_CHANGED')
    verify_immutable_inputs(contract)
    for name, value in contract['buildSupportHashes'].items():
        need(digest((ROOT / name).read_bytes()) == value == digest(git('show', SOURCE_BASE + ':' + name)),
             'IMMUTABLE_INPUT_CHANGED')
    need(re.fullmatch('[a-f0-9]{40}', contract.get('reviewedApplicationCommit') or '')
         and all(digest(git('show', contract['reviewedApplicationCommit'] + ':' + name)) == value
                 for name, value in contract['sources'].items()), 'REVIEWED_APPLICATION_CHANGED')
    need(set(contract['controlPaths']) <= set(contract['reviewedFileHashes'])
         | {'scripts/production-release/registration-browser-contract.json'}, 'CONTROL_CLOSURE_CHANGED')
    workflow_baseline = git('show', SOURCE_BASE + ':.github/workflows/quality.yml').decode()
    command = "import {readFileSync} from 'node:fs';import {isRegistrationBrowserOnly as check,registrationBrowserQualityWorkflowMatches as workflow} from './scripts/ci-registration-browser-scope.mjs';" \
        + 'if(!check(' + json.dumps(changed) + ',{base:' + json.dumps(SOURCE_BASE) \
        + ',baseTree:' + json.dumps(SOURCE_TREE) + "})||!workflow(readFileSync('.github/workflows/quality.yml','utf8')," \
        + json.dumps(workflow_baseline) + '))process.exit(2);'
    run('node', '--input-type=module', '-e', command)


def verify_immutable_inputs(contract):
    # HEAD schema provenance and reconstructed runtime schema are separate pins.
    # Reconstruct/prepare/build retain the prior runtime schema/client checks.
    source_inputs = contract['sourceTreeInputs']
    for name, expected in contract['unchangedInputs'].items():
        source_expected = source_inputs.get(name, expected)
        need(digest((ROOT / name).read_bytes()) == source_expected
             == digest(git('show', SOURCE_BASE + ':' + name)), 'IMMUTABLE_INPUT_CHANGED')


def published_proof(binding):
    """This exception names one failed run with a separately finalized release."""
    r.verify_predecessor_binding(binding)
    prefix = 'repos/wangchaozhuanyong/id-business-system/'

    def request(path):
        return subprocess.check_output(['gh', 'api', prefix + path], cwd=ROOT)

    meta = json.loads(request('actions/runs/' + binding['runId']))
    need(meta.get('head_sha') == CURRENT and meta.get('head_branch') == 'main'
         and meta.get('event') == 'workflow_dispatch' and meta.get('status') == 'completed'
         and meta.get('conclusion') == 'failure' and meta.get('path') == binding['workflowPath']
         and meta.get('run_attempt') == 1, 'PREDECESSOR_RUN_CHANGED')
    jobs = json.loads(request('actions/runs/' + binding['runId'] + '/attempts/1/jobs?per_page=100'))['jobs']
    validate = [job for job in jobs if job.get('name') == 'validate']
    need(len(validate) == 1 and validate[0].get('id') == binding['validationJobId']
         and validate[0].get('status') == 'completed' and validate[0].get('conclusion') == 'success',
         'PREDECESSOR_VALIDATION_CHANGED')
    artifacts = json.loads(request('actions/runs/' + binding['runId'] + '/artifacts?per_page=100'))['artifacts']
    selected = [row for row in artifacts if row.get('id') == binding['artifactId']
                and row.get('name') == 'registration-parity-diagnostics-' + CURRENT + '-1'
                and not row.get('expired') and row.get('digest') == binding['artifactDigest']
                and row.get('workflow_run', {}).get('head_sha') == CURRENT]
    need(len(selected) == 1 and selected[0]['size_in_bytes'] <= 64 * 1024**2,
         'PREDECESSOR_ARTIFACT_CHANGED')
    zipped = request('actions/artifacts/' + str(binding['artifactId']) + '/zip')
    need(len(zipped) <= 64 * 1024**2 and 'sha256:' + digest(zipped) == binding['artifactDigest'],
         'PREDECESSOR_ARTIFACT_BYTES_CHANGED')
    with zipfile.ZipFile(io.BytesIO(zipped)) as archive:
        names = archive.namelist()
        need(len(names) == 2 and set(names) == {binding['bundleName'], 'artifact-sha256.txt'}
             and all(archive.getinfo(name).file_size <= 64 * 1024**2 for name in names),
             'PREDECESSOR_ARTIFACT_LAYOUT_CHANGED')
        bundle = archive.read(binding['bundleName'])
        need(digest(bundle) == binding['bundleSha256'] == archive.read('artifact-sha256.txt').decode().strip(),
             'PREDECESSOR_BUNDLE_CHANGED')
    return verify_published_bundle(bundle, binding)


def verify_published_bundle(bundle, binding):
    r.verify_predecessor_binding(binding)
    need(digest(bundle) == binding['bundleSha256'], 'PREDECESSOR_BUNDLE_CHANGED')
    files, proof_raw, total = {}, None, 0
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        seen = set()
        for item in archive.getmembers():
            total += item.size
            need(item.name not in seen and not item.name.startswith('/') and '..' not in Path(item.name).parts
                 and (item.isdir() or item.isfile()) and item.size <= 8 * 1024**2
                 and total <= 64 * 1024**2, 'PREDECESSOR_PAYLOAD_INVALID')
            seen.add(item.name)
            need(Path(item.name).parts[0] == 'payload', 'PREDECESSOR_PAYLOAD_INVALID')
            if item.isfile():
                raw = archive.extractfile(item).read()
                name = item.name.removeprefix('payload/')
                files[name] = digest(raw)
                if name == 'build-proof.json':
                    proof_raw = raw
    need(proof_raw is not None and digest(proof_raw) == r.PRIOR_PROOF, 'PREDECESSOR_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    need(proof.get('commit') == CURRENT and proof.get('tree') == CURRENT_TREE
         and proof.get('workflowRunId') == binding['runId'] and proof.get('workflowRunAttempt') == '1',
         'PREDECESSOR_PROOF_IDENTITY_CHANGED')
    plan = {key: proof[key] for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                                      'contractSha256', 'controlSources')}
    h = types.SimpleNamespace(file_inventory=lambda _: dict(files))
    r.helper(r.OLD_NAME + '-release.py').verify_proof(proof, plan, r.prior_recipe(), None, h)
    return proof


def verify_prior_chain():
    """Run the frozen prepare function's native-proof prefix, with no build writes.

    Its old source-admission check is replaced by the frozen runtime contract
    check: current source admission is independently done by verify_sources.
    The bounded prefix ends immediately before the original output creation.
    """
    original = r.helper(r.OLD_NAME + '-build.py')
    tree = ast.parse((HERE / (r.OLD_NAME + '-build.py')).read_bytes())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'prepare')
    stops = [index for index, node in enumerate(function.body) if isinstance(node, ast.Expr)
             and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
             and node.value.func.id == 'need' and len(node.value.args) == 2
             and isinstance(node.value.args[1], ast.Constant) and node.value.args[1].value == 'OUTPUT_EXISTS']
    need(len(stops) == 1, 'PRIOR_PREPARE_BOUNDARY_CHANGED')
    function.name = 'verify_native_prefix'
    function.body = function.body[:stops[0]]
    namespace = {**vars(original), 'verify_sources': r.helper(r.OLD_NAME + '-release.py').verify_contract}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])),
                 str(HERE / (r.OLD_NAME + '-build.py')), 'exec'), namespace)
    namespace['verify_native_prefix']()


def verify_baseline_union(contract, proof):
    prior = r.prior_recipe()
    expected = {
        'baselineApiFiles': {**prior['baselineApiFiles'], **{n: value for n, value in proof['apiModules'].items() if n.endswith('.js')}},
        'baselineWorkerFiles': {**prior['baselineWorkerFiles'], **proof['workerFiles']},
        'runtimeAdminFiles': {**prior['runtimeAdminFiles'], **proof['adminFiles']},
        'baselineAdminFiles': proof['adminFiles'], 'baselineAdminBuildId': 'v2-' + CURRENT}
    need(all(contract.get(key) == value for key, value in expected.items()), 'BASELINE_UNION_CHANGED')


def reconstruct(context, contract):
    prior = r.prior_recipe()
    old = r.helper(r.OLD_NAME + '-build.py')
    old.reconstruct(context, prior)
    # The 13 prior sources are inheritance, never a newer tree snapshot.
    for name, expected in {**prior['sources'], **prior['validationSources']}.items():
        raw = git('show', CURRENT + ':' + name)
        need(digest(raw) == expected, 'PRIOR_PUBLISHED_SOURCE_CHANGED')
        path = context / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    restore_runtime_worker_tests(context, contract, prior)
    need({name: digest((context / WORKER / name).read_bytes()) for name in contract['baselineWorkerFiles']}
         == contract['baselineWorkerFiles'], 'BASE_WORKER_NOT_REPRODUCED')
    old.verify_runtime_schema(context, contract)


def restore_runtime_worker_tests(context, contract, prior):
    # Prior publishers stored validation sources in Git while their overlay
    # images retained these three original test files. Keep runtime bytes and
    # the newer validation layer separate instead of changing inventory facts.
    raw = (HERE / 'registration-flow-evidence-contract.json').read_bytes()
    need(digest(raw) == prior['parentContractSha256'], 'RUNTIME_TEST_RECIPE_CHANGED')
    sources = json.loads(raw)['reconstruction']['runtimeSources']
    need(set(sources) == {WORKER + name for name in (
        'test_apple_mailboxes.py', 'test_release_safety.py', 'test_workspace.py')}, 'RUNTIME_TEST_SCOPE_CHANGED')
    contents = {}
    for name, source in sources.items():
        need(source['commit'] == 'e90f02a65cdf63b656e82eed6e25fd8a68a21b7b'
             and source['sha256'] == contract['baselineWorkerFiles'][name.removeprefix(WORKER)],
             'RUNTIME_TEST_BINDING_CHANGED')
        value = git('show', source['commit'] + ':' + name)
        need(digest(value) == source['sha256'], 'RUNTIME_TEST_SOURCE_CHANGED')
        contents[name] = value
    for name, value in contents.items():
        path = context / name
        need(not path.is_symlink() and path.resolve().is_relative_to(context.resolve()), 'RUNTIME_TEST_PATH_INVALID')
        path.write_bytes(value)


def overlay_published_validation_tests(context, prior):
    sources = {name: value for name, value in {**prior['sources'], **prior['validationBaselineSources']}.items()
               if name.startswith(WORKER) and Path(name).name.startswith('test_') and name.endswith('.py')}
    for name, expected in sources.items():
        raw = git('show', CURRENT + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_VALIDATION_SOURCE_CHANGED')
        path = context / name
        need(not path.is_symlink() and path.resolve().is_relative_to(context.resolve()), 'VALIDATION_PATH_INVALID')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def api_delta(before, after, approved):
    allowed = {name.removesuffix('.js') + suffix for name in approved for suffix in ('.js', '.js.map', '.d.ts')}
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    need(changed and changed <= allowed and not (before.keys() - after.keys()), 'API_OUTPUT_SCOPE_CHANGED')
    need(all(before.get(name) == value for name, value in approved.items()), 'BASE_APPROVED_MODULE_NOT_REPRODUCED')
    return {name: after[name] for name in sorted(changed)}


def build_namespace():
    return r.private_namespace(r.OLD_NAME + '-build.py', {'CONTRACT': CONTRACT, 'OUTPUT': OUTPUT,
        'verify_sources': verify_sources, 'reconstruct': reconstruct, 'api_delta': api_delta, 'run': run, 'git': git})


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    verify_prior_chain()
    verify_baseline_union(contract, published_proof(contract['predecessorNative']))
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    old = r.helper(r.OLD_NAME + '-build.py')
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        reconstruct(context, contract)
        if role == 'candidate':
            overlay_published_validation_tests(context, r.prior_recipe())
            for name in {**contract['sources'], **contract['validationSources'], **contract['validationBaselineSources']}:
                path = context / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / name).read_bytes())
        old.verify_runtime_schema(context, contract)
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        old.generate_unchanged_client(context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)
    print(json.dumps({'status': SCOPE + '_PREPARED', 'migrationPerformed': False}))


def build():
    build_namespace()['build']()
    path = OUTPUT / 'prepared-build-proof.json'
    proof = json.loads(path.read_bytes())
    contract = json.loads(CONTRACT.read_bytes())
    proof.update(predecessorNative=contract['predecessorNative'], configurationNormalization=r.NORMALIZATION)
    path.write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')


def validate():
    build_namespace()['validate']()


def package():
    build_namespace()['package']()


def check_context():
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('CHECK_MODE') == 'recharge',
         'CHECKS_REQUIRE_ISOLATED_CI')
    prepare()
    contract = json.loads(CONTRACT.read_bytes())
    old = r.helper(r.OLD_NAME + '-build.py')
    need(old.unchanged_client(OUTPUT / 'baseline', contract)
         == old.unchanged_client(OUTPUT / 'candidate', contract), 'UNCHANGED_CLIENT_NOT_REPRODUCED')
    python = OUTPUT / 'python/bin/python'
    run(sys.executable, '-m', 'venv', str(OUTPUT / 'python'))
    run(str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '-r',
        str(OUTPUT / 'candidate' / WORKER / 'requirements.lock.txt'))
    run(str(python), '-m', 'pip', 'check')
    return contract, old, python


def check_api():
    contract, old, python = check_context()
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (baseline, candidate):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    before, after = old.inventory(baseline / 'apps/api/dist'), old.inventory(candidate / 'apps/api/dist')
    need({name: value for name, value in before.items() if name.endswith('.js')}
         == contract['baselineApiFiles'], 'BASE_API_NOT_REPRODUCED')
    api_delta(before, after, contract['apiModules'])
    run('npm', 'run', 'typecheck', '--workspace', 'apps/api', cwd=candidate)
    run('npm', 'run', 'test', '--workspace', 'apps/api', '--', *contract['apiTests'], cwd=candidate)
    for module in contract['pythonTests']:
        need(re.fullmatch('test_[a-z0-9_]+', module), 'PYTHON_TEST_PATH_INVALID')
        run(str(python), '-B', '-m', 'unittest', module, cwd=candidate / WORKER)
    run('node', '--test', str(candidate / WORKER / 'test_payment_browser.mjs'), cwd=candidate)
    print(json.dumps({'status': SCOPE + '_API_CANDIDATE_VERIFIED', 'runtimeBaseline': CURRENT,
        'sourceBaseline': SOURCE_BASE, 'migrationPerformed': False, 'businessActions': 0}))


def check_admin():
    contract, old, python = check_context()
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    commit = git('rev-parse', 'HEAD').decode().strip()
    for context, build_id in ((baseline, contract['baselineAdminBuildId']), (candidate, 'v2-' + commit)):
        run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=context,
            env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': build_id})
    need(old.inventory(baseline / 'apps/admin/dist') == contract['baselineAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    run('npm', 'run', 'typecheck', '--workspace', 'apps/admin', cwd=candidate)
    run('npm', 'run', 'test', '--workspace', 'apps/admin', '--', *contract['adminTests'], cwd=candidate)
    run('npm', 'exec', '--', 'playwright', 'install', '--with-deps', 'chromium', cwd=candidate)
    for script in contract['browserAcceptances']:
        need(script in contract['validationSources'] and script.startswith('scripts/acceptance-v2-'),
             'BROWSER_TEST_PATH_INVALID')
        run('node', script, '--python=' + str(python), cwd=candidate)
    print(json.dumps({'status': SCOPE + '_ADMIN_CANDIDATE_VERIFIED', 'runtimeBaseline': CURRENT,
        'sourceBaseline': SOURCE_BASE, 'migrationPerformed': False, 'businessActions': 0}))


def main(arguments):
    modes = {'prepare': prepare, 'build': build, 'validate': validate, 'package': package,
             'check-api': check_api, 'check-admin': check_admin}
    need(len(arguments) == 1 and arguments[0] in modes, 'BUILD_MODE_INVALID')
    modes[arguments[0]]()


if __name__ == '__main__':
    main(sys.argv[1:])
