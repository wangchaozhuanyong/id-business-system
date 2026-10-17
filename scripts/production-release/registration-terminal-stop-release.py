"""One Worker file over measured recharge successors, retaining the a92 registration origin.

Reuse the frozen lock/backup/fence/forward switch in a private namespace. The
small, counted recipe adaptation changes API only; historical controls stay
unchanged. No migration, registration, dependency or Admin update is allowed.
"""
import copy
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
import re
import types
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
NAME = 'registration-terminal-stop-20261017'
PREFIX = 'registration-terminal-stop'
SCOPE = 'REGISTRATION_TERMINAL_STOP_20261017'
CURRENT = '6da10d2e4bd9de6df145899648e234000f84b72b'
SOURCE_BASE = '6da10d2e4bd9de6df145899648e234000f84b72b'
SOURCE_TREE = 'afa73ff2e4c258b811e310873daab8c71fc72bba'
REGISTRATION_ORIGIN = 'a92ea492754781f0b84011321a65b684617e7ce2'
REGISTRATION_ORIGIN_TREE = '6e346195950ef727705c5ef7d181e96a037ed046'
BASELINE_PROJECTION_SHA256 = '1096cb8b79a5cf83c2c213f801876aa2834a7a2f2e59555f29f1db91bbf1174b'
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
SOURCE = WORKER + 'apple_mailboxes.py'
TEST_SOURCE = WORKER + 'test_flow_v4_unit.py'
APPLICATION_PATHS = (SOURCE, TEST_SOURCE)
TASK_PATHS = (*APPLICATION_PATHS, 'docs/V2_TASKS.md',
              'docs/AUTO_REGISTRATION_TERMINAL_STOP_20261017.md',
              *(f'scripts/ci-recharge-{name}' for name in
                ('scope.mjs', 'scope.test.mjs', 'check.mjs', 'check.test.mjs')),
              *(f'scripts/production-release/{PREFIX}-{name}' for name in
                ('contract.json', 'build.py', 'release.py', 'dispatch.py', 'release.test.py')),
              '.github/workflows/' + PREFIX + '-validation.yml')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
HEX = r'[a-f0-9]{64}'
PUBLISHED_PREVIOUS = {
    'commit': REGISTRATION_ORIGIN, 'tree': REGISTRATION_ORIGIN_TREE, 'runId': '39022831680', 'attempt': 1,
    'workflowPath': '.github/workflows/registration-flow-v4-validation.yml',
    'artifactId': 12097058027,
    'artifactName': 'registration-flow-v4-20261017-' + REGISTRATION_ORIGIN + '-1',
    'artifactDigest': 'sha256:2881b4aff67a20bf47e9766f5e464f27c995fd450d92b6ecff67525e55a1630a',
    'artifactSize': 1218890,
    'artifactSha256': '1816301115b203145d9e9297bf232902979dc201a479318059157b6cfed049b6',
    'proofSha256': '230b4cdc8669d6308b5debd2fe5dfc4a437ed95f62d7ad8902ad5d062e81207e',
    'contractSha256': '15eb2bf1a85ceee8631f056b8c5ecd6ba6e404f9fffca51d65a1c790a6496429'}
PUBLISHED_SUCCESSOR = {'commit': '92aba4034ade09985015f7dfa7592fc7553b743c',
 'tree': '37d4881f125c5f907b7241513417a2452dcf19a0',
 'scope': 'ONLINE_CHECKOUT_CS_RECOVERY',
 'workflowPath': '.github/workflows/online-checkout-cs-validation.yml',
 'contractSha256': 'a346175562ee0734efce9c4d7cf3000423d07528085e14a0060b4ea80e229629',
 'runId': '39027872983',
 'attempt': 1,
 'artifactId': 12098934195,
 'artifactName': 'online-checkout-cs-92aba4034ade09985015f7dfa7592fc7553b743c-1',
 'artifactDigest': 'sha256:14f914d771d66c8e5d84f24e40d0ab55851f905dda5f927f8d60ad2ddda8612c',
 'artifactSize': 452532,
 'artifactSha256': 'a54a0c9ff109da5e97cca6bbbc3230dda1e07b48f0aa0a28cc01c754bf18f3e7',
 'proofSha256': 'f689d9f9f2b47bd49f81bd909fd2c5750bace1cc70f9b5cdd610f78c9902dd2f',
 'native': {'preflight': {'commandId': '2b53c5dd-507d-4eca-b80f-8ebea3a8c6ef',
                          'instanceId': 'i-05836da38606e633c',
                          'status': 'Success',
                          'responseCode': 0,
                          'stderrEmpty': True,
                          'result': {'businessActions': 0,
                                     'commit': '92aba4034ade09985015f7dfa7592fc7553b743c',
                                     'status': 'ONLINE_CHECKOUT_CS_PREFLIGHT_VERIFIED'},
                          'resultSha256': 'c581d84188241b573c757967283b6270d703daae6fd295be4ecafe8862d364a9'},
            'release': {'commandId': '44fd9821-98df-4c60-911d-7f8a9b765e41',
                        'instanceId': 'i-05836da38606e633c',
                        'status': 'Success',
                        'responseCode': 0,
                        'stderrEmpty': True,
                        'result': {'businessActions': 0,
                                   'commit': '92aba4034ade09985015f7dfa7592fc7553b743c',
                                   'migrationPerformed': False,
                                   'preservedServices': ['admin',
                                                         'mysql',
                                                         'caddy',
                                                         'media-resolver',
                                                         'auto-recharge',
                                                         'auto-registration'],
                                   'status': 'ONLINE_CHECKOUT_CS_DEPLOYED',
                                   'updatedServices': ['api', 'online-recharge']},
                        'resultSha256': 'bcaee53451e3e39bd0110ada95632e79be4ec0b8e2386d4f2a4ed3756c1e4c4b'},
            'readback': {'commandId': '39b0773a-a897-4a68-9b27-94f72eed19ca',
                         'instanceId': 'i-05836da38606e633c',
                         'status': 'Success',
                         'responseCode': 0,
                         'stderrEmpty': True,
                         'result': {'businessActions': 0,
                                    'commit': '92aba4034ade09985015f7dfa7592fc7553b743c',
                                    'migrationPerformed': False,
                                    'status': 'ONLINE_CHECKOUT_CS_INDEPENDENT_READBACK_VERIFIED'},
                         'resultSha256': 'cfabca8df76e9510f14e55e9e088e819a7e32db40b67cd8c6596701d2e8877f5'}}}
PUBLISHED_RECHARGE = {'commit': '6da10d2e4bd9de6df145899648e234000f84b72b',
 'tree': 'afa73ff2e4c258b811e310873daab8c71fc72bba',
 'scope': 'BIT_RECHARGE_WEB_DIRECT_EXPIRED_CHECKOUT_20261017',
 'workflowPath': '.github/workflows/recharge-checkout-validation.yml',
 'contractSha256': '2119cf3a93d7055129933cf7c10d4b077849e73c954ff5c4878652dd16cf019d',
 'runId': '39028580578',
 'attempt': 1,
 'artifactId': 12098699584,
 'artifactName': 'recharge-checkout-6da10d2e4bd9de6df145899648e234000f84b72b-1',
 'artifactDigest': 'sha256:d60e3aa2940e47324cf389a1ba8b182a92f631c40b3fcbfcbbdd672df5f6c14f',
 'artifactSize': 1420335,
 'artifactSha256': '0b76039d64798c2a81303fff1f02713d0cc98b93cf0c1e8891ea00cc3daca4d0',
 'proofSha256': '62ed7d268d395aefc34aebf53fa1131f89bf32f5b5511d2a0bdbcaa7bf3e4814',
 'native': {'preflight': {'commandId': 'cc866677-671c-4613-b1f1-cf78a7bbd940',
                          'instanceId': 'i-05836da38606e633c',
                          'status': 'Success',
                          'responseCode': 0,
                          'stderrEmpty': True,
                          'result': {'status': 'RECHARGE_CHECKOUT_PREFLIGHT_VERIFIED',
                                     'commit': '6da10d2e4bd9de6df145899648e234000f84b72b',
                                     'businessActions': 0,
                                     'migrationPerformed': False},
                          'resultSha256': '20bdbbc3cd2a1e4f781e524b3883c9e7a0b95dd2bb7a581e9aa95641c9593b50',
                          'rawResultSha256': 'e70694d36b6854db9d49b77c6143e2415962c7dcb8868629f8274493a6f010a5'},
            'release': {'commandId': '084616bf-b012-4e20-bde5-abdd69983f25',
                        'instanceId': 'i-05836da38606e633c',
                        'status': 'Success',
                        'responseCode': 0,
                        'stderrEmpty': True,
                        'result': {'status': 'RECHARGE_CHECKOUT_DEPLOYED',
                                   'commit': '6da10d2e4bd9de6df145899648e234000f84b72b',
                                   'tree': 'afa73ff2e4c258b811e310873daab8c71fc72bba',
                                   'workflowRunId': '39028580578',
                                   'businessActions': 0,
                                   'migrationPerformed': False,
                                   'images': {'admin': {'imageId': 'sha256:1e127b5283d36c2b5efc4b9d8802aa5dd8773d8010e6365437bd41d80e7a5c86',
                                                        'reference': 'id-business-v2-checkout:6da10d2e4bd9de6df145899648e234000f84b72b-39028580578-admin'},
                                              'api': {'imageId': 'sha256:f71f219c022afb3034a9151762a16787d20004262402b2b844e24aee324c2ab9',
                                                      'reference': 'id-business-v2-checkout:6da10d2e4bd9de6df145899648e234000f84b72b-39028580578-api'}}},
                        'resultSha256': '633f602c6438c3257a8f3631d01ceef3b6eb2e8ccdb4d662f519646cba6143b2',
                        'rawResultSha256': '9c487fc0704782efcaef929103e219964226bbbd5a2c2228bea2759006144c7f'},
            'readback': {'commandId': 'f06375fe-6615-4cce-89a8-2b4fef069e79',
                         'instanceId': 'i-05836da38606e633c',
                         'status': 'Success',
                         'responseCode': 0,
                         'stderrEmpty': True,
                         'result': {'status': 'RECHARGE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED',
                                    'commit': '6da10d2e4bd9de6df145899648e234000f84b72b',
                                    'businessActions': 0,
                                    'migrationPerformed': False,
                                    'images': {'admin': {'imageId': 'sha256:1e127b5283d36c2b5efc4b9d8802aa5dd8773d8010e6365437bd41d80e7a5c86',
                                                         'reference': 'id-business-v2-checkout:6da10d2e4bd9de6df145899648e234000f84b72b-39028580578-admin'},
                                               'api': {'imageId': 'sha256:f71f219c022afb3034a9151762a16787d20004262402b2b844e24aee324c2ab9',
                                                       'reference': 'id-business-v2-checkout:6da10d2e4bd9de6df145899648e234000f84b72b-39028580578-api'}},
                                    'preservedServices': ['mysql',
                                                          'caddy',
                                                          'media-resolver',
                                                          'auto-recharge',
                                                          'auto-registration']},
                         'resultSha256': '146e619b25afd390eb33f829246c6c0be6f577811cfdd7c3fdd7ef4b58175b34',
                         'rawResultSha256': '64de043670ee9dbe62b81d0a6ace1dd29657037b8d126ea6cb5ca4130d4041b5'}}}
PYTHON_TESTS = ('test_flow_contract_unit', 'test_flow_v4_unit', 'test_flow_evidence',
                'test_registration_parity_unit', 'test_registration_closed_loop_unit',
                'test_apple_mailboxes', 'test_release_safety', 'test_precondition_diagnostics')


def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def signature(rows):
    return {'fileCount': len(rows), 'sha256': digest(canonical(rows))}


def helper(name):
    need(re.fullmatch(r'[a-z0-9.-]+', name), 'HELPER_PATH_INVALID')
    spec = importlib.util.spec_from_file_location('terminal_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def prior_contract():
    raw = (HERE / 'registration-flow-v4-contract.json').read_bytes()
    need(digest(raw) == PUBLISHED_PREVIOUS['contractSha256'], 'PREVIOUS_CONTRACT_CHANGED')
    value = json.loads(raw)
    helper('registration-flow-v4-release.py').verify_contract(value)
    return value


def successor_contract():
    raw = (HERE / 'online-checkout-cs-contract.json').read_bytes()
    need(digest(raw) == PUBLISHED_SUCCESSOR['contractSha256'], 'SUCCESSOR_CONTRACT_CHANGED')
    value = json.loads(raw)
    helper('online-checkout-cs-release.py').validate_contract(value)
    need(value['expectedCurrent'] == REGISTRATION_ORIGIN, 'SUCCESSOR_PARENT_CHANGED')
    return value


def inherited_validation():
    return {'registrationOrigin': PUBLISHED_PREVIOUS, 'checkoutCs': PUBLISHED_SUCCESSOR,
            'runtimeSuccessor': PUBLISHED_RECHARGE}


def recharge_contract():
    raw = (HERE / 'recharge-checkout-contract.json').read_bytes()
    need(digest(raw) == PUBLISHED_RECHARGE['contractSha256'], 'RECHARGE_CONTRACT_CHANGED')
    value = json.loads(raw)
    need(value['scope'] == PUBLISHED_RECHARGE['scope']
         and value['expectedCurrent'] == PUBLISHED_SUCCESSOR['commit']
         and value['publishedAdminRecipe']['commit'] == REGISTRATION_ORIGIN, 'RECHARGE_PARENT_CHANGED')
    return value


def inherited_api_paths():
    cs = {'id-business-v2/online-recharge/checkout-recovery' + ext for ext in ('.js', '.js.map', '.d.ts')}
    cs.add('id-business-v2/online-recharge/contracts.d.ts')
    checkout = {name.removesuffix('.js') + ext for name in recharge_contract()['apiModules']
                for ext in ('.js', '.js.map', '.d.ts')}
    need(not cs.intersection(checkout), 'SUCCESSOR_MODULE_COLLISION')
    return cs, checkout


def control_files():
    return (*('registration-terminal-stop-' + name for name in
              ('build.py', 'release.py', 'dispatch.py', 'release.test.py')),
            'registration-flow-v4-contract.json', 'online-checkout-cs-release.py',
            'online-checkout-cs-contract.json', 'recharge-checkout-release.py',
            'recharge-checkout-contract.json', *helper('registration-flow-v4-release.py').CONTROL_FILES)


def verify_contract(c):
    need(type(c.get('version')) is int and c['version'] == 1 and c.get('name') == NAME
         and c.get('scope') == SCOPE and c.get('frozen') is True and c.get('admission') == 'VERIFIED'
         and c.get('pendingEvidence') == [] and c.get('migration') is None
         and type(c.get('businessActions')) is int and c['businessActions'] == 0, 'CONTRACT_NOT_ADMITTED')
    need(c.get('expectedCurrent') == CURRENT and c.get('sourceBaseline') == SOURCE_BASE
         and c.get('sourceBaselineTree') == SOURCE_TREE and c.get('publishedPrevious') == PUBLISHED_PREVIOUS
         and c.get('publishedSuccessor') == PUBLISHED_SUCCESSOR
         and c.get('publishedRecharge') == PUBLISHED_RECHARGE
         and digest(canonical(c.get('baseline'))) == BASELINE_PROJECTION_SHA256, 'PREDECESSOR_CHANGED')
    old = prior_contract()
    successor = successor_contract()
    recharge_contract()
    need(set(c.get('applicationPaths', [])) == set(c.get('sources', {})) == set(APPLICATION_PATHS)
         and set(c.get('expectedGitChanges', [])) == set(TASK_PATHS)
         and len(c['expectedGitChanges']) == len(TASK_PATHS)
         and c.get('workerFiles') == {'apple_mailboxes.py': c['sources'].get(SOURCE)}
         and c.get('validationSources') == {} and c.get('pythonTests') == list(PYTHON_TESTS)
         and all(re.fullmatch(HEX, value) for value in c['sources'].values()), 'SOURCE_SCOPE_CHANGED')
    need(c.get('apiJavascriptDelta') == [] and c.get('apiRuntimeDelta') == []
         and c.get('adminDelta') == [] and c.get('dependencyDelta') == []
         and c.get('updatedServices') == ['api'] and c.get('reboundServices') == ['online-recharge'],
         'RUNTIME_SCOPE_CHANGED')
    b = c['baseline']
    need(b['commit'] == CURRENT and b['current'] == c.get('current')
         and b['manifestSha256'] == c.get('manifestSha256')
         and b['adminBuildId'] == 'v2-' + CURRENT
         and set(b['services']) == set(helper('recharge-record-release.py').SERVICES), 'LIVE_BASELINE_MISSING')
    images = PUBLISHED_RECHARGE['native']['readback']['result']['images']
    need(all(b['services'][role]['image'] == images[role]['imageId']
             and b['images'][role]['image'] == images[role]['imageId']
             and b['images'][role]['revision'] == CURRENT for role in ('api', 'admin'))
         and b['images']['online-recharge']['revision'] == PUBLISHED_SUCCESSOR['commit'], 'NATIVE_IMAGE_CHANGED')
    rows = {**old['baselineWorkerFiles'], **old['workerFiles']}
    need(c.get('baselineWorkerFiles') == rows and signature(rows) == b['inventory']['worker']
         and all(b['inventory'][slot] == c['registrationInventory'][slot]
                 for slot in ('worker', 'prisma'))
         and b['inventory']['engine'] == signature(successor['afterEngineFiles'])
         and set(b['successorApiModules']) == set.union(*inherited_api_paths())
         and b['publishedProofs']['online-checkout-cs-build-proof.json']['sha256'] == PUBLISHED_SUCCESSOR['proofSha256']
         and b['publishedProofs']['recharge-checkout-build-proof.json']['sha256'] == PUBLISHED_RECHARGE['proofSha256'],
         'BASELINE_CONTENT_CHANGED')
    need(c.get('configurationSha256') == b['configurationSha256']
         and c.get('runtimeConfigurationSha256') == b['runtimeConfigurationSha256']
         and c.get('sourceProjectionSha256') == {
             'roleSourceProjections': b['roleSourceProjectionsSha256'],
             'adminSourceProjection': b['adminSourceProjectionSha256']}
         and c.get('hostSourceInheritance') == {'release': b['current'], 'files': {}}, 'CONFIGURATION_CHANGED')
    need(c.get('backupNormalizerPath') == old['backupNormalizerPath']
         and c.get('engineHealth') == old['engineHealth']
         and c.get('sqlFenceHelperSha256') == old['sqlFenceHelperSha256']
         and c.get('qualityEvidenceHelperSha256') == old['qualityEvidenceHelperSha256']
         and c.get('schemaSha256') == b['schemaSha256']
         and c.get('publicIndexSha256') == b['publicIndexSha256']
         and c.get('roleSourceCommits') == {'api': CURRENT, 'admin': CURRENT,
                                          'online-recharge': PUBLISHED_SUCCESSOR['commit']}, 'SAFETY_INPUT_CHANGED')
    need(c.get('buildSupportHashes') == {
        'scripts/production-release/registration-closure-release.py':
            old['buildSupportHashes']['scripts/production-release/registration-closure-release.py']},
        'BACKUP_SUPPORT_CHANGED')
    need(set(c.get('controlFiles', [])) == set(c.get('controlHashes', {})) == set(control_files()),
         'CONTROL_SCOPE_CHANGED')
    for name, expected in c['controlHashes'].items():
        path = HERE / name
        need(re.fullmatch(HEX, expected) and path.is_file() and not path.is_symlink()
             and digest(path.read_bytes()) == expected, 'CONTROL_CHANGED')


def inherited_function(name, **overrides):
    old = helper('registration-flow-v4-release.py')
    values = {**old.__dict__, 'CURRENT': CURRENT, 'need': need, 'BASE': BASE, **overrides}
    return types.FunctionType(getattr(old, name).__code__, values)


def baseline(d, h, a, finite, c, expected=None):
    return inherited_function('baseline')(d, h, a, finite, c, expected)


def inherited_host_source(c):
    need(c['hostSourceInheritance'] == {'release': c['current'], 'files': {}}, 'HOST_INHERITANCE_CHANGED')
    return Path(c['current'])


def backup_sqlite(old, d, directory, plan, states, marker, safety, c):
    original = helper('registration-parity-diagnostics-release.py').backup_sqlite
    values = {**original.__globals__, 'need': need,
              'sqlite_receipt': helper('registration-flow-v4-release.py').sqlite_receipt}
    execute = types.FunctionType(original.__code__, values, original.__name__,
                                 original.__defaults__, original.__closure__)
    return execute(old, d, directory, plan, states, marker, safety, c)


def verify_proof(proof, plan, c, payload, h):
    fields = {'version', 'scope', 'commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256',
              'controlSources', 'sources', 'validationSources', 'workerFiles', 'apiModules', 'apiJavascriptDelta',
              'adminFiles', 'baselineInventory', 'afterInventory', 'validation', 'inheritedValidation',
              'files', 'migrationPerformed', 'businessActions'}
    need(type(proof) is dict and set(proof) == fields and type(proof['version']) is int and proof['version'] == 1
         and proof['scope'] == SCOPE and all(proof.get(k) == plan[k] for k in
             ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources')),
         'PROOF_IDENTITY_CHANGED')
    need(proof['sources'] == c['sources'] and proof['validationSources'] == {}
         and proof['workerFiles'] == c['workerFiles'] and proof['apiModules'] == {}
         and proof['apiJavascriptDelta'] == [] and proof['adminFiles'] == {}
         and proof['inheritedValidation'] == inherited_validation()
         and proof['validation'] == {'status': 'PASS', 'worker': True, 'isolatedPersistence': True,
                                    'pythonTests': list(PYTHON_TESTS)}
         and proof['migrationPerformed'] is False and type(proof['businessActions']) is int
         and proof['businessActions'] == 0, 'PROOF_SCOPE_CHANGED')
    after = copy.deepcopy(c['baseline']['inventory'])
    after['worker'] = signature({**c['baselineWorkerFiles'], **c['workerFiles']})
    expected = {**{'source/' + n: v for n, v in c['sources'].items()},
                **{'api/worker/' + n: v for n, v in c['workerFiles'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(proof['baselineInventory'] == c['baseline']['inventory'] and proof['afterInventory'] == after
         and proof['files'] == actual == expected, 'PAYLOAD_CHANGED')
    return proof


def smoke(d, target, states, c, proof, receipt, h, a, finite):
    old = helper('registration-flow-v4-release.py')
    before = receipt['before']
    need(all(states[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all(states['online-recharge'][n] == before['online-recharge'][n]
             for n in ('image', 'reference', 'environmentSha256')), 'SIDECAR_CHANGED')
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == c['runtimeConfigurationSha256']
         and old.runtime(d, states) == proof['afterInventory'], 'RUNTIME_CONTENT_CHANGED')
    need(old.mysql_receipt(d, target) == receipt['database']
         and old.sqlite_receipt(d, target, c) == receipt['sqlite'], 'BUSINESS_DATA_CHANGED')
    need(d.run('docker', 'exec', states['api']['containerId'], 'sha256sum',
               '/app/apps/api/prisma-mysql/schema.prisma').split()[0] == c['baseline']['schemaSha256']
         and d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                   '/etc/nginx/conf.d/default.conf').split()[0] == c['baseline']['nginxSha256'], 'STATIC_CONFIGURATION_CHANGED')
    manifest = json.loads((target / 'release-manifest.json').read_bytes())
    previous = receipt['previousRoleProjections']
    need(all(manifest['roleSourceProjections'][role] == previous[role]
             for role in previous if role != 'api'), 'PRESERVED_PROJECTION_CHANGED')
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)
    request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=25) as response:
        public = response.read(2 * 1024**2 + 1)
    need(len(public) <= 2 * 1024**2 and digest(public) == c['publicIndexSha256']
         and c['baseline']['adminBuildId'].encode() in public, 'PUBLIC_ADMIN_CHANGED')


def adapted_release_code(original):
    source = inspect.getsource(original)
    recipes = (
        ("[('api', 'COPY modules/ /app/apps/api/dist/\\nCOPY worker/ /app/' + WORKER + '\\n', 2),\n"
         "                                    ('admin', 'COPY html/ /usr/share/nginx/html/\\n', 1)]",
         "[('api', 'COPY worker/ /app/' + WORKER + '\\n', 1)]", 1),
        ("('api', 'admin')", "('api',)", 4),
        ("['api', 'admin']", "['api']", 3),
        ("'never', 'api', 'admin', timeout=180", "'never', 'api', timeout=180", 1),
    )
    for before, after, count in recipes:
        need(source.count(before) == count, 'FROZEN_SWITCH_RECIPE_CHANGED')
        source = source.replace(before, after)
    compiled = compile(source, original.__code__.co_filename, 'exec')
    functions = [x for x in compiled.co_consts if isinstance(x, types.CodeType)]
    need(len(functions) == 1 and functions[0].co_name == 'release', 'SWITCH_FUNCTION_CHANGED')
    def rename(code):
        return code.replace(co_consts=tuple(rename(v) if isinstance(v, types.CodeType) else
            v.replace('registration-parity-diagnostics', NAME) if isinstance(v, str) else v for v in code.co_consts))
    return rename(functions[0])


def release(plan, c, d=None, h=None):
    verify_contract(c)
    need(plan.get('controlSources') == c['controlHashes']
         and plan.get('contractSha256') == digest((HERE / 'registration-terminal-stop-contract.json').read_bytes()),
         'EXECUTION_CONTRACT_CHANGED')
    c = {**c, 'reviewedApplicationCommit': plan['commit']}
    old = helper('registration-parity-diagnostics-release.py')
    def release_helper(name):
        value = helper(name)
        if name == 'proxy-result-identity-release.py':
            value.SCOPE = SCOPE
        return value
    values = {**old.__dict__, 'SCOPE': SCOPE, 'CURRENT': CURRENT, 'BASE': BASE, 'PRESERVED': PRESERVED,
              'need': need, 'helper': release_helper, 'verify_contract': verify_contract,
              'verify_proof': verify_proof, 'baseline': baseline, 'smoke': smoke,
              'sqlite_receipt': helper('registration-flow-v4-release.py').sqlite_receipt,
              'backup_sqlite': backup_sqlite,
              'inherited_host_source': inherited_host_source}
    execute = types.FunctionType(adapted_release_code(old.release), values)
    h = h or helper('recharge-record-release.py')
    d = d or h.load_utilities(HERE / 'remote-deploy.py', c['controlHashes']['remote-deploy.py'])
    return execute(plan, c, d, h)
