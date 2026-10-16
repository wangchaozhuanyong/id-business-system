"""A finite browser-registration successor; historical publishers stay byte exact.

The known publisher is reused in a private namespace. Only its release names,
current identity, admission, SQLite receipt and API bind-order representation
change. Its lock, backups, SQL fence, switching, smoke and readback remain intact.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCOPE = 'REGISTRATION_BROWSER'
PARITY_COMMIT = '6fc99d23c2918280a94c3f5b8be48f638190e02f'
PARITY_TREE = '3c7ae119d97c8478f32f644485b7cd1b555830a6'
CURRENT = '59b36f3aadef28a59f47a55ed1e66686fcc2c42c'
CURRENT_TREE = 'e6c4c72aefb68b979f1bee201e510de07fc29a0d'
SOURCE_BASE = '0161e8f92da0c2df5c58ddb4373dbc4d18b04412'
SOURCE_TREE = '5d2e0a8b6243545f9929a69b2ef7eaddbdaf9f19'
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
OLD_NAME = 'registration-parity-diagnostics'
NAME = 'registration-browser'
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
MAILBOX_CONTRACT = '39a94abae3b20ae8bd378176d254abcd1a08d12b6f01df731a8484d0d8035f71'
MAILBOX_PROOF = 'ecf5c6dc2cd93dc94133dbb38f6ef9b37aab5ebecac790c80e99226c0e365e2c'
MAILBOX_BINDING = {
    'commit': CURRENT, 'tree': CURRENT_TREE, 'runId': '38902937350', 'runAttempt': 1,
    'workflowPath': '.github/workflows/mailbox-realtime-validation.yml',
    'validationJobId': 116979377339, 'artifactId': 12046373539,
    'artifactDigest': 'sha256:c7d76459c76654535568052b3b0065e838ba0be348c8eb63a40938d05ba58832',
    'bundleName': 'mailbox-realtime-artifact.tar.gz',
    'bundleSha256': '101321d273c51fc3d780dd9151f0cd144e8f1d70542c6b115321737534dfcacf',
    'proofSha256': MAILBOX_PROOF, 'contractSha256': MAILBOX_CONTRACT,
    'releaseCommandId': 'fc954eeb-3dc2-400d-a0c6-b893e56f5bbf',
    'readbackCommandId': '78c9a386-d36f-4783-b248-ce28528c8957', 'instanceId': INSTANCE,
    'releaseNativeSha256': '95d4fb37d2f80f65c8eec413a7f7ebde497b94e0aad778589c029d4bde608416',
    'readbackNativeSha256': 'cf3fadaecdf5536f268cb0b30dd42ac1fc0f3b3dbed3ff0db3983343f190a2be'}
BIND_DESTINATIONS = ('/app/.runtime/auto-registration', '/app/.runtime/online-recharge')
NORMALIZATION = {'version': 1, 'role': 'api', 'field': 'HostConfig.Binds',
                 'method': 'SORT_COMPLETE_DECLARATIONS_BY_DISTINCT_DESTINATION',
                 'destinations': list(BIND_DESTINATIONS)}


def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def helper(name):
    spec = importlib.util.spec_from_file_location('browser_release_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prior_recipe():
    for name, expected in PRIOR_CONTROLS.items():
        need(digest((HERE / name).read_bytes()) == expected, 'PRIOR_CONTROL_CHANGED')
    recipe = json.loads((HERE / (OLD_NAME + '-contract.json')).read_bytes())
    helper(OLD_NAME + '-release.py').verify_contract(recipe)
    return recipe


def mailbox_recipe():
    raw = (HERE / 'mailbox-realtime-contract.json').read_bytes()
    need(digest(raw) == MAILBOX_CONTRACT, 'MAILBOX_CONTRACT_CHANGED')
    recipe = json.loads(raw)
    need(recipe.get('frozen') is True and recipe.get('scope') == 'MAILBOX_REALTIME_20261016'
         and recipe.get('expectedCurrent') == PARITY_COMMIT and recipe.get('migration') is None
         and recipe.get('workerFiles') == {} and recipe.get('sharedRuntimeUnchanged') is True,
         'MAILBOX_RECIPE_CHANGED')
    return recipe


def verify_mailbox_binding(binding):
    need(binding == MAILBOX_BINDING, 'MAILBOX_NATIVE_BINDING_CHANGED')


def verify_mailbox_native(native, binding, mode):
    verify_mailbox_binding(binding)
    need(mode in ('release', 'readback'), 'MAILBOX_NATIVE_MODE_INVALID')
    need(digest(canonical(native)) == binding[mode + 'NativeSha256']
         and native.get('CommandId') == binding[mode + 'CommandId']
         and native.get('InstanceId') == INSTANCE and native.get('DocumentName') == 'AWS-RunShellScript'
         and native.get('Status') == 'Success' and native.get('ResponseCode') == 0
         and not native.get('StandardErrorContent'), 'MAILBOX_NATIVE_RECEIPT_CHANGED')
    result = json.loads(native['StandardOutputContent'])
    status = 'DEPLOYED' if mode == 'release' else 'INDEPENDENT_READBACK_VERIFIED'
    need(result.get('status') == 'MAILBOX_REALTIME_20261016_' + status
         and result.get('commit') == CURRENT and result.get('migrationPerformed') is False
         and type(result.get('businessActions')) is int and result['businessActions'] == 0
         and result.get('updatedServices') == ['api', 'admin']
         and result.get('reboundServices') == ['online-recharge']
         and (result.get('tree') == CURRENT_TREE if mode == 'release'
              else result.get('maintenanceReleased') is True), 'MAILBOX_NATIVE_RESULT_CHANGED')
    return result


def renamed_code(code):
    """Rename literal release identities only; never modify historical code/files."""
    return code.replace(co_consts=tuple(
        renamed_code(value) if isinstance(value, types.CodeType) else
        value.replace(OLD_NAME, NAME).replace('REGISTRATION_PARITY_DIAGNOSTICS', SCOPE)
        if isinstance(value, str) else value for value in code.co_consts))


def private_namespace(name, overrides):
    need(name in PRIOR_CONTROLS and digest((HERE / name).read_bytes()) == PRIOR_CONTROLS[name],
         'PRIOR_CONTROL_CHANGED')
    original = helper(name)
    namespace = dict(vars(original))
    for key, function in vars(original).items():
        if isinstance(function, types.FunctionType) and function.__globals__ is vars(original):
            adapted = types.FunctionType(renamed_code(function.__code__), namespace,
                function.__name__, function.__defaults__, function.__closure__)
            adapted.__kwdefaults__ = copy.deepcopy(function.__kwdefaults__)
            adapted.__annotations__ = dict(function.__annotations__)
            namespace[key] = adapted
    namespace.update(SCOPE=SCOPE, CURRENT=CURRENT, SOURCE_BASE=SOURCE_BASE, SOURCE_TREE=SOURCE_TREE)
    namespace.update(overrides)
    return namespace


def verify_predecessor_binding(binding):
    expected = {'commit': PARITY_COMMIT, 'tree': PARITY_TREE, 'runId': '38883922525', 'runAttempt': 1,
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
         and result.get('commit') == PARITY_COMMIT and result.get('workflowRunId') == binding['runId']
         and result.get('originalGithubRunConclusion') == 'failure'
         and result.get('originalReleaseCommandId') == binding['originalReleaseCommandId']
         and result.get('maintenanceReleased') is True and result.get('migrationPerformed') is False
         and all(type(result.get(key)) is int and result[key] == 0
                 for key in ('businessActions', 'newBuilds', 'newBackups', 'restarts')),
         'PREDECESSOR_FORWARD_RESULT_CHANGED')
    need(result.get('independentReadback') == {
        'status': 'REGISTRATION_PARITY_DIAGNOSTICS_INDEPENDENT_READBACK_VERIFIED',
        'commit': PARITY_COMMIT, 'maintenanceReleased': True, 'migrationPerformed': False,
        'businessActions': 0, 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge']},
        'PREDECESSOR_READBACK_CHANGED')
    tail = result.get('originalTailResult', {})
    need(tail.get('status') == 'REGISTRATION_PARITY_DIAGNOSTICS_DEPLOYED'
         and tail.get('commit') == PARITY_COMMIT and tail.get('tree') == PARITY_TREE
         and tail.get('migrationPerformed') is False and type(tail.get('businessActions')) is int
         and tail['businessActions'] == 0 and tail.get('updatedServices') == ['api', 'admin']
         and tail.get('reboundServices') == ['online-recharge'], 'PREDECESSOR_TAIL_CHANGED')
    return result


def verify_contract(contract):
    need(contract.get('version') == 1 and contract.get('frozen') is True
         and contract.get('scope') == SCOPE and contract.get('expectedCurrent') == CURRENT
         and contract.get('sourceBaseline') == SOURCE_BASE and contract.get('sourceBaselineTree') == SOURCE_TREE
         and contract.get('migration') is None, 'CONTRACT_NOT_FROZEN')
    prior = prior_recipe()
    need(contract.get('priorControls') == PRIOR_CONTROLS
         and contract.get('configurationNormalization') == NORMALIZATION, 'INHERITANCE_CHANGED')
    verify_predecessor_binding(contract.get('predecessorNative'))
    verify_mailbox_binding(contract.get('mailboxNative'))
    mailbox = mailbox_recipe()
    need(contract.get('mailboxSources') == mailbox['sources']
         and contract.get('mailboxValidationSources') == mailbox['validationSources'], 'MAILBOX_SOURCE_SCOPE_CHANGED')
    for key in ('schemaSha256', 'baselinePrismaClientFiles', 'runtimePrismaClientFiles',
                'baselineEngineFiles', 'runtimePythonDependencies', 'prismaPathMetadata',
                'protectedMigrations', 'unchangedInputs', 'buildSupportHashes',
                'qualityEvidenceHelperSha256', 'sqlFenceHelperSha256', 'backupNormalizerPath',
                'validationBaselineSources', 'registrationNative', 'identityNative',
                'parentControls', 'parentContractSha256', 'parentProofSha256', 'parentNative',
                'successorControls', 'successorContractSha256', 'successorProofSha256',
                'successorNative', 'publishedSuccessorSources', 'dragControls', 'dragContractSha256',
                'dragProofSha256', 'dragNative', 'dragSources', 'accountControls', 'accountContractSha256',
                'accountProofSha256', 'accountNative', 'accountSources', 'checkoutControls',
                'checkoutContractSha256', 'checkoutProofSha256', 'checkoutNative', 'checkoutSources'):
        need(contract.get(key) == prior[key], 'PRESERVED_INPUT_CHANGED')
    source_inputs = contract.get('sourceTreeInputs')
    need(isinstance(source_inputs, dict) and set(source_inputs) == {'apps/api/prisma-mysql/schema.prisma'}
         and re.fullmatch('[a-f0-9]{64}', source_inputs['apps/api/prisma-mysql/schema.prisma'])
         and contract['unchangedInputs']['apps/api/prisma-mysql/schema.prisma'] == contract['schemaSha256'],
         'PRESERVED_INPUT_CHANGED')
    need(isinstance(contract.get('runtimeEvidence'), dict)
         and contract['runtimeEvidence'].get('status') == 'VERIFIED'
         and contract['runtimeEvidence'].get('commit') == CURRENT
         and isinstance(contract.get('services'), dict) and len(contract['services']) == 8
         and set(contract.get('runtimeConfigurationSha256', {})) == set(contract['services'])
         and set(contract.get('runtimeConfigurationRawSha256', {})) == set(contract['services'])
         and contract.get('current', '').startswith('/opt/id-business-v2/releases/')
         and re.fullmatch('[a-f0-9]{64}', contract.get('manifestSha256') or ''), 'RUNTIME_BASELINE_MISSING')
    sources = contract.get('sources')
    allowed = contract.get('allowedApplicationPaths')
    need(isinstance(sources, dict) and sources and isinstance(allowed, list)
         and len(allowed) == len(set(allowed)) and set(sources) == set(allowed)
         and all((name.startswith('apps/api/src/id-business-v2/auto-registration/')
                   or name.startswith('apps/admin/src/v2/features/auto-registration/')
                   or name in ('docs/AUTO_REGISTRATION_BROWSER_CONNECTOR.md', 'scripts/start-auto-registration-connector.sh'))
                  and '/upstream/' not in name and '..' not in Path(name).parts
                  and re.fullmatch('[a-f0-9]{64}', value) for name, value in sources.items()),
         'APPLICATION_SCOPE_CHANGED')
    need(contract.get('workerFiles') == {name.removeprefix(WORKER): value for name, value in sources.items()
            if name.startswith(WORKER) and not Path(name).name.startswith('test_')}
         and all('/' not in name and re.fullmatch('[a-z0-9_-]+\\.(py|js|css)', name)
                 for name in contract['workerFiles']), 'WORKER_SCOPE_CHANGED')
    modules = contract.get('apiModules')
    need(isinstance(modules, dict) and modules and all(
         name.startswith('id-business-v2/auto-registration/') and name.endswith('.js')
         and value == contract['baselineApiFiles'].get(name) for name, value in modules.items()),
         'API_MODULE_SCOPE_CHANGED')
    paths = contract.get('expectedGitChanges')
    need(isinstance(paths, list) and len(paths) == len(set(paths))
         and set(paths) == set(sources) | set(contract.get('validationSources', {})) | set(contract.get('controlPaths', []))
         and isinstance(contract.get('sourceDeltaPaths'), list)
         and len(contract['sourceDeltaPaths']) == len(set(contract['sourceDeltaPaths']))
         and set(contract['sourceDeltaPaths']) <= set(paths)
         and set(contract.get('reviewedFileHashes', {})) == set(paths) - {'scripts/production-release/' + NAME + '-contract.json'}
         and all(re.fullmatch('[a-f0-9]{64}', value) for value in contract['reviewedFileHashes'].values()),
         'SOURCE_CLOSURE_CHANGED')
    need(set(contract.get('controlFiles', [])) == set(prior['controlFiles']) | set(PRIOR_CONTROLS)
         | {NAME + '-release.py', NAME + '-contract.json', 'mailbox-realtime-contract.json'}, 'EXECUTOR_SCOPE_CHANGED')


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


def verify_proof(proof, plan, contract, payload, h):
    need(proof.get('predecessorNative') == contract['predecessorNative']
         and proof.get('mailboxNative') == contract['mailboxNative']
         and proof.get('mailboxSources') == contract['mailboxSources']
         and proof.get('configurationNormalization') == NORMALIZATION, 'PROOF_INHERITANCE_CHANGED')
    return private_namespace(OLD_NAME + '-release.py', {})['verify_proof'](proof, plan, contract, payload, h)


def release(plan, contract, d, h):
    verify_contract(contract)
    namespace = private_namespace(OLD_NAME + '-release.py', {
        'verify_contract': verify_contract, 'verify_proof': verify_proof,
        'sqlite_inspection_source': sqlite_inspection_source,
        'sqlite_receipt': sqlite_receipt, 'validate_sqlite_receipt': validate_sqlite_receipt})
    return namespace['release'](plan, contract, d, configuration_helper(h))
