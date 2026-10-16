"""Published 6fc inheritance only: sealed native receipts, artifact and read-only guards.

No browser-registration candidate or unrelated main application source is used.
Historical publishers remain byte exact; only current identity and inspections adapt.
"""
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import types
import re
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCOPE = 'MAILBOX_REALTIME'
CURRENT = '6fc99d23c2918280a94c3f5b8be48f638190e02f'

CURRENT_TREE = '3c7ae119d97c8478f32f644485b7cd1b555830a6'

WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'

OLD_NAME = 'registration-parity-diagnostics'

PRIOR_CONTROLS = {
    OLD_NAME + '-build.py': '7bd0eb8a3b28261402782b2dbe01fc436c41331f0ecd47764c2d5abc5dc4e459',
    OLD_NAME + '-release.py': 'f5d3d6e3d5ee539a965cbbfa4401beee3e209c2258886ea7239ae667a13e3eb8',
    OLD_NAME + '-dispatch.py': 'c16f8a09a7a08771faa1071910a05a077d3c4e368f6a4938d3c8cec8cca74a8c',
    OLD_NAME + '-contract.json': 'ec58e314bfebe558c9bf793ca1b240fcd1144d56956ecf0de1fd18fd6aa03ae7',
}

PRIOR_PROOF = '7b3a49d2ebc6111143d73e022230c0f591827a5e82bfefea7f2f80d190e5abdb'

PRIOR_BUNDLE = '89ba4b0cbb3fe204bef628646b4263af0e12bffcafd9fac1408f02bf47223787'

FORWARD_COMMAND = 'ba29bee4-9b71-4ad3-9647-fbcd55a72110'

INSTANCE = 'i-05836da38606e633c'

BIND_DESTINATIONS = ('/app/.runtime/auto-registration', '/app/.runtime/online-recharge')

NORMALIZATION = {'version': 1, 'role': 'api', 'field': 'HostConfig.Binds',
                 'method': 'SORT_COMPLETE_DECLARATIONS_BY_DISTINCT_DESTINATION',
                 'destinations': list(BIND_DESTINATIONS)}
RECEIPTS_SHA256 = '5e5166247fd77b0487582cb90694061c9243d33bc526c637e19e24572206713a'

def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def helper(name):
    spec = importlib.util.spec_from_file_location('mailbox_baseline_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def prior_recipe():
    for name, expected in PRIOR_CONTROLS.items():
        need(digest((HERE / name).read_bytes()) == expected, 'PRIOR_CONTROL_CHANGED')
    recipe = json.loads((HERE / (OLD_NAME + '-contract.json')).read_bytes())
    helper(OLD_NAME + '-release.py').verify_contract(recipe)
    return recipe

def verify_predecessor_binding(binding):
    expected = {'commit': CURRENT, 'tree': CURRENT_TREE, 'runId': '38883922525', 'runAttempt': 1,
        'workflowPath': '.github/workflows/registration-parity-diagnostics-validation.yml',
        'originalRunConclusion': 'failure', 'validationJobId': 116916962577,
        'artifactId': 12038657136,
        'artifactDigest': 'sha256:86b4c4736f8ef07215eabcad5780fc49c4e311e83f5c69c88cb3fa6f2880b78f',
        'bundleName': 'registration-parity-diagnostics-artifact.tar.gz',
        'bundleSha256': PRIOR_BUNDLE, 'proofSha256': PRIOR_PROOF,
        'contractSha256': PRIOR_CONTROLS[OLD_NAME + '-contract.json'],
        'originalReleaseCommandId': '9e73d3f5-6988-438f-80af-ed3f03a15ecd',
        'forwardCommandId': FORWARD_COMMAND, 'instanceId': INSTANCE}
    need(isinstance(binding, dict) and set(binding) == {*expected, 'forwardNativeSha256'}
         and all(binding.get(key) == value for key, value in expected.items())
         and re.fullmatch('[a-f0-9]{64}', binding.get('forwardNativeSha256') or ''),
         'PREDECESSOR_NATIVE_BINDING_CHANGED')

def verify_forward_native(native, binding):
    verify_predecessor_binding(binding)
    need(digest(canonical(native)) == binding['forwardNativeSha256']
         and native.get('CommandId') == FORWARD_COMMAND and native.get('InstanceId') == INSTANCE
         and native.get('DocumentName') == 'AWS-RunShellScript'
         and native.get('Status') == 'Success' and native.get('ResponseCode') == 0
         and not native.get('StandardErrorContent'), 'PREDECESSOR_FORWARD_RECEIPT_CHANGED')
    result = json.loads(native['StandardOutputContent'])
    need(result.get('status') == 'ORIGINAL_RELEASE_FORWARD_FINALIZED'
         and result.get('commit') == CURRENT and result.get('workflowRunId') == binding['runId']
         and result.get('originalGithubRunConclusion') == 'failure'
         and result.get('originalReleaseCommandId') == binding['originalReleaseCommandId']
         and result.get('maintenanceReleased') is True and result.get('migrationPerformed') is False
         and all(type(result.get(key)) is int and result[key] == 0
                 for key in ('businessActions', 'newBuilds', 'newBackups', 'restarts')),
         'PREDECESSOR_FORWARD_RESULT_CHANGED')
    need(result.get('independentReadback') == {
        'status': 'REGISTRATION_PARITY_DIAGNOSTICS_INDEPENDENT_READBACK_VERIFIED',
        'commit': CURRENT, 'maintenanceReleased': True, 'migrationPerformed': False,
        'businessActions': 0, 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge']},
        'PREDECESSOR_READBACK_CHANGED')
    tail = result.get('originalTailResult', {})
    need(tail.get('status') == 'REGISTRATION_PARITY_DIAGNOSTICS_DEPLOYED'
         and tail.get('commit') == CURRENT and tail.get('tree') == CURRENT_TREE
         and tail.get('migrationPerformed') is False and type(tail.get('businessActions')) is int
         and tail['businessActions'] == 0 and tail.get('updatedServices') == ['api', 'admin']
         and tail.get('reboundServices') == ['online-recharge'], 'PREDECESSOR_TAIL_CHANGED')
    return result

def canonical_bindings(row):
    result = copy.deepcopy(row)
    binds = result['HostConfig'].get('Binds')
    need(isinstance(binds, list) and len(binds) == 2
         and all(isinstance(value, str) for value in binds) and len(set(binds)) == 2, 'API_BIND_SCOPE_CHANGED')
    parts = [value.split(':') for value in binds]
    need(all(len(value) == 3 and value[0] and value[2] in ('rw', 'ro') for value in parts)
         and {value[1] for value in parts} == set(BIND_DESTINATIONS), 'API_BIND_SCOPE_CHANGED')
    result['HostConfig']['Binds'] = sorted(binds, key=lambda value: value.split(':')[1])
    return result

def configuration(d, state, original):
    row = json.loads(d.run('docker', 'inspect', state['containerId']))
    need(isinstance(row, list) and len(row) == 1, 'INSPECT_LAYOUT_CHANGED')
    if row[0]['Config'].get('Labels', {}).get('com.docker.compose.service') != 'api':
        return original(d, state)
    rewritten = json.dumps([canonical_bindings(row[0])])

    class View:
        def run(self, *args, **kwargs):
            need(args == ('docker', 'inspect', state['containerId']), 'CONFIGURATION_READ_SCOPE_CHANGED')
            return rewritten

    return original(View(), state)

def configuration_helper(h):
    view = types.SimpleNamespace(**vars(h))
    view.configuration = lambda driver, state: configuration(driver, state, h.configuration)
    return view

def sqlite_inspection_source():
    original = helper(OLD_NAME + '-release.py').sqlite_inspection_source()
    need(original.count('assert leases==1;facts=[]') == 1
         and original.count("for task in ['f8ec17e1-036a-493e-ab3c-7a84ef026777','69f6a290-8de4-409f-86ee-d8b5c1f5865b','af941d8b-d0a5-4d94-8a43-029d54f017a9']:") == 1,
         'SQLITE_INSPECTOR_CHANGED')
    return original.replace('assert leases==1;facts=[]', "assert leases==cfg['expectedLeaseCount'];facts=[]").replace(
        "for task in ['f8ec17e1-036a-493e-ab3c-7a84ef026777','69f6a290-8de4-409f-86ee-d8b5c1f5865b','af941d8b-d0a5-4d94-8a43-029d54f017a9']:",
        "for task in cfg['protectedTaskUuids']:")

def validate_sqlite_receipt(value, contract, expected_logical=None):
    policy = contract['sqliteReviewPolicy']
    prior = json.loads((HERE / (OLD_NAME + '-contract.json')).read_bytes())['sqliteReviewPolicy']
    protected = policy['protectedTaskFacts']
    need(protected[:3] == prior['protectedTaskFacts'] and len(protected) >= 4
         and len({row['taskUuid'] for row in protected}) == len(protected)
         and policy['leaseFacts'] == prior['leaseFacts']
         and policy['summary']['taskCounts']['pending'] == 0
         and policy['summary']['taskCounts']['running'] == 0, 'SQLITE_REVIEW_POLICY_INVALID')
    expected = {'version': 1, 'status': 'PASS', **policy['summary'],
        'activeAppleLeaseCount': len(policy['leaseFacts']), 'executingTaskCount': 0,
        'retainedReviewLeaseCount': len(policy['leaseFacts']), 'corruptEncryptedValueCount': 0,
        'leaseFacts': policy['leaseFacts'], 'protectedTaskFacts': protected,
        'dependencies': contract['runtimePythonDependencies'], 'businessActions': 0}
    need(value == expected and (expected_logical is None or value['logicalSha256'] == expected_logical),
         'SQLITE_PRESERVATION_CHANGED')
    return value

def sqlite_receipt(d, directory, contract, expected_logical=None):
    candidate = {**contract['baselineWorkerFiles'], **contract['workerFiles']}
    config = {'safetyHashes': list({contract['baselineWorkerFiles']['release_safety.py'], candidate['release_safety.py']}),
        'candidateSafetyHash': candidate['release_safety.py'], 'candidateFlowHash': candidate['flow_evidence.py'],
        'expectedLeaseCount': len(contract['sqliteReviewPolicy']['leaseFacts']),
        'protectedTaskUuids': [row['taskUuid'] for row in contract['sqliteReviewPolicy']['protectedTaskFacts']]}
    source = "const{spawnSync}=require('child_process');const config=" + json.dumps(config) + ";config.key=process.env.FIELD_ENCRYPTION_KEY;" \
        + "const result=spawnSync('/opt/id-registration/venv/bin/python',['-B','-c'," + json.dumps(sqlite_inspection_source()) \
        + "],{input:JSON.stringify(config)+'\\n',encoding:'utf8',env:{PATH:process.env.PATH},timeout:45000});" \
        + "if(result.status!==0)process.exit(2);console.log(JSON.stringify(JSON.parse(result.stdout)));"
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source, timeout=60))
    return validate_sqlite_receipt(value, contract, expected_logical)

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def published_proof(binding):
    """This exception names one failed run with a separately finalized release."""
    verify_predecessor_binding(binding)
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
    verify_predecessor_binding(binding)
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
    need(proof_raw is not None and digest(proof_raw) == PRIOR_PROOF, 'PREDECESSOR_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    need(proof.get('commit') == CURRENT and proof.get('tree') == CURRENT_TREE
         and proof.get('workflowRunId') == binding['runId'] and proof.get('workflowRunAttempt') == '1',
         'PREDECESSOR_PROOF_IDENTITY_CHANGED')
    plan = {key: proof[key] for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                                      'contractSha256', 'controlSources')}
    h = types.SimpleNamespace(file_inventory=lambda _: dict(files))
    helper(OLD_NAME + '-release.py').verify_proof(proof, plan, prior_recipe(), None, h)
    return proof

def verify_prior_chain():
    """Run the frozen prepare function's native-proof prefix, with no build writes.

    Its old source-admission check is replaced by the frozen runtime contract
    check: current source admission is independently done by verify_sources.
    The bounded prefix ends immediately before the original output creation.
    """
    original = helper(OLD_NAME + '-build.py')
    tree = ast.parse((HERE / (OLD_NAME + '-build.py')).read_bytes())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'prepare')
    stops = [index for index, node in enumerate(function.body) if isinstance(node, ast.Expr)
             and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
             and node.value.func.id == 'need' and len(node.value.args) == 2
             and isinstance(node.value.args[1], ast.Constant) and node.value.args[1].value == 'OUTPUT_EXISTS']
    need(len(stops) == 1, 'PRIOR_PREPARE_BOUNDARY_CHANGED')
    function.name = 'verify_native_prefix'
    function.body = function.body[:stops[0]]
    namespace = {**vars(original), 'verify_sources': helper(OLD_NAME + '-release.py').verify_contract}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])),
                 str(HERE / (OLD_NAME + '-build.py')), 'exec'), namespace)
    namespace['verify_native_prefix']()

def verify_baseline_union(contract, proof):
    prior = prior_recipe()
    expected = {
        'baselineApiFiles': {**prior['baselineApiFiles'], **{n: value for n, value in proof['apiModules'].items() if n.endswith('.js')}},
        'baselineWorkerFiles': {**prior['baselineWorkerFiles'], **proof['workerFiles']},
        'runtimeAdminFiles': {**prior['runtimeAdminFiles'], **proof['adminFiles']},
        'baselineAdminFiles': proof['adminFiles'], 'baselineAdminBuildId': 'v2-' + CURRENT}
    need(all(contract.get(key) == value for key, value in expected.items()), 'BASELINE_UNION_CHANGED')

def reconstruct(context, contract):
    prior = prior_recipe()
    old = helper(OLD_NAME + '-build.py')
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


def published_baseline():
    """Derive the only admitted predecessor from immutable proof and sealed readback."""
    raw = (HERE / 'mailbox-realtime-predecessor.json').read_bytes()
    need(digest(raw) == RECEIPTS_SHA256, 'PREDECESSOR_RECEIPTS_CHANGED')
    record = json.loads(raw)
    prior = prior_recipe()
    binding = {
        'commit': CURRENT, 'tree': CURRENT_TREE, 'runId': '38883922525', 'runAttempt': 1,
        'workflowPath': '.github/workflows/registration-parity-diagnostics-validation.yml',
        'originalRunConclusion': 'failure', 'validationJobId': 116916962577,
        'artifactId': 12038657136,
        'artifactDigest': 'sha256:86b4c4736f8ef07215eabcad5780fc49c4e311e83f5c69c88cb3fa6f2880b78f',
        'bundleName': 'registration-parity-diagnostics-artifact.tar.gz',
        'bundleSha256': PRIOR_BUNDLE, 'proofSha256': PRIOR_PROOF,
        'contractSha256': PRIOR_CONTROLS[OLD_NAME + '-contract.json'],
        'originalReleaseCommandId': '9e73d3f5-6988-438f-80af-ed3f03a15ecd',
        'forwardCommandId': FORWARD_COMMAND, 'instanceId': INSTANCE,
        'forwardNativeSha256': '15ded56da94b9204c5111ad612ee6067b46e5db2d8f47cad634544f033f75ff8'}
    finalized = verify_forward_native(record['forwardNative'], binding)
    native = record['readbackNative']
    need(native.get('CommandId') == '2513fb5b-fbac-493c-8bca-4fc531ce4486'
         and native.get('InstanceId') == INSTANCE and native.get('DocumentName') == 'AWS-RunShellScript'
         and native.get('Status') == 'Success' and native.get('ResponseCode') == 0
         and not native.get('StandardErrorContent'), 'READBACK_NATIVE_CHANGED')
    value = json.loads(native['StandardOutputContent'])
    value_sha = digest(canonical(value))
    need(value_sha == '68ea6c90890134ea167e30822e6f19e43bd8a89ddf91ffb09cf685f65d2cfc24'
         and value['status'] == 'READONLY_BASELINE_VERIFIED' and value['currentStable'] is True
         and value['businessActions'] == 0 and value['manifest'] == {
             'commit': CURRENT, 'sourceTree': CURRENT_TREE, 'scope': 'REGISTRATION_PARITY_DIAGNOSTICS'},
         'READBACK_RESULT_CHANGED')
    proof_raw = record['publishedProofRaw'].encode()
    need(digest(proof_raw) == PRIOR_PROOF, 'PREDECESSOR_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    p = copy.deepcopy(prior)
    p.update(expectedCurrent=CURRENT,
        baselineApiFiles={**prior['baselineApiFiles'], **{n: v for n, v in proof['apiModules'].items() if n.endswith('.js')}},
        baselineWorkerFiles={**prior['baselineWorkerFiles'], **proof['workerFiles']},
        runtimeAdminFiles={**prior['runtimeAdminFiles'], **proof['adminFiles']},
        baselineAdminFiles=proof['adminFiles'], baselineAdminBuildId='v2-' + CURRENT,
        predecessorNative=binding, configurationNormalization=NORMALIZATION)
    verify_baseline_union(p, proof)
    for key, observed in [('baselineApiFiles', 'api'), ('baselineWorkerFiles', 'worker'),
                          ('runtimeAdminFiles', 'admin'), ('runtimePrismaClientFiles', 'client'),
                          ('baselineEngineFiles', 'engine')]:
        need(value['inventories'][observed] == {'count': len(p[key]), 'canonicalSha256': digest(canonical(p[key]))},
             'PUBLISHED_INVENTORY_CHANGED')
    need(value['schemaSha256'] == prior['schemaSha256']
         and value['runtimePrismaClientFiles'] == prior['runtimePrismaClientFiles']
         and value['database'] == prior['databaseReceipt']
         and value['sqlite']['dependencies'] == prior['runtimePythonDependencies'], 'PRESERVED_INPUT_CHANGED')
    for key in ('current', 'manifestSha256', 'services', 'configurationSha256', 'runtimeConfigurationSha256'):
        p[key] = value[key]
    p['runtimeConfigurationRawSha256'] = value['rawRuntimeConfigurationSha256']
    p['sourceProjectionSha256'] = value['projectionSha256']
    p['roleSourceCommits'] = {**prior['roleSourceCommits'], 'api': CURRENT, 'admin': CURRENT}
    p['hostSourceInheritance'] = {'commit': CURRENT, 'release': p['current'], 'manifestSha256': p['manifestSha256'],
        'files': {WORKER + 'release_safety.py': p['baselineWorkerFiles']['release_safety.py']}}
    p['runtimeEvidence'] = {'commandId': native['CommandId'], 'commit': CURRENT,
                            'receiptSha256': value_sha, 'status': 'VERIFIED'}
    p['sqliteReviewPolicy'] = {'summary': value['sqlite']['summary'],
        'leaseFacts': prior['sqliteReviewPolicy']['leaseFacts'],
        'protectedTaskFacts': value['sqlite']['protectedTaskFacts']}
    need(value['sqlite']['activeAppleLeaseCount'] == len(p['sqliteReviewPolicy']['leaseFacts'])
         and p['sqliteReviewPolicy']['protectedTaskFacts'][:3] == prior['sqliteReviewPolicy']['protectedTaskFacts'],
         'TASK_PROTECTION_CHANGED')
    validate_sqlite_receipt({'version': 1, 'status': 'PASS', **p['sqliteReviewPolicy']['summary'],
        'activeAppleLeaseCount': 1, 'executingTaskCount': 0, 'retainedReviewLeaseCount': 1,
        'corruptEncryptedValueCount': 0, **{n: p['sqliteReviewPolicy'][n] for n in ('leaseFacts', 'protectedTaskFacts')},
        'dependencies': p['runtimePythonDependencies'], 'businessActions': 0}, p)
    need(all(p['services'][role]['image'] == finalized['originalTailResult']['images'][role]['imageId']
             for role in ('api', 'admin')), 'FINALIZED_IMAGE_CHANGED')
    return p


def runtime_namespace():
    """Rebind read-only guards; retain the frozen publisher implementation."""
    original = helper(OLD_NAME + '-release.py')
    namespace = dict(vars(original))
    for key, function in vars(original).items():
        if isinstance(function, types.FunctionType) and function.__globals__ is vars(original):
            adapted = types.FunctionType(function.__code__, namespace,
                function.__name__, function.__defaults__, function.__closure__)
            adapted.__kwdefaults__ = copy.deepcopy(function.__kwdefaults__)
            adapted.__annotations__ = dict(function.__annotations__)
            namespace[key] = adapted
    namespace.update(CURRENT=CURRENT, sqlite_receipt=sqlite_receipt,
        sqlite_inspection_source=sqlite_inspection_source, validate_sqlite_receipt=validate_sqlite_receipt)
    return namespace
