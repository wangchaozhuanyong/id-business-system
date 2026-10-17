"""One approved Worker file over the independently measured a92 publication.

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
CURRENT = 'a92ea492754781f0b84011321a65b684617e7ce2'
SOURCE_TREE = '6e346195950ef727705c5ef7d181e96a037ed046'
BASELINE_PROJECTION_SHA256 = '16798bebef459ea29cbbd38c612a34cd4932498c4beff6dc13b6e31838489d57'
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
    'commit': CURRENT, 'tree': SOURCE_TREE, 'runId': '39022831680', 'attempt': 1,
    'workflowPath': '.github/workflows/registration-flow-v4-validation.yml',
    'artifactId': 12097058027,
    'artifactName': 'registration-flow-v4-20261017-' + CURRENT + '-1',
    'artifactDigest': 'sha256:2881b4aff67a20bf47e9766f5e464f27c995fd450d92b6ecff67525e55a1630a',
    'artifactSize': 1218890,
    'artifactSha256': '1816301115b203145d9e9297bf232902979dc201a479318059157b6cfed049b6',
    'proofSha256': '230b4cdc8669d6308b5debd2fe5dfc4a437ed95f62d7ad8902ad5d062e81207e',
    'contractSha256': '15eb2bf1a85ceee8631f056b8c5ecd6ba6e404f9fffca51d65a1c790a6496429'}
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


def control_files():
    return (*('registration-terminal-stop-' + name for name in
              ('build.py', 'release.py', 'dispatch.py', 'release.test.py')),
            'registration-flow-v4-contract.json', *helper('registration-flow-v4-release.py').CONTROL_FILES)


def verify_contract(c):
    need(type(c.get('version')) is int and c['version'] == 1 and c.get('name') == NAME
         and c.get('scope') == SCOPE and c.get('frozen') is True and c.get('admission') == 'VERIFIED'
         and c.get('pendingEvidence') == [] and c.get('migration') is None
         and type(c.get('businessActions')) is int and c['businessActions'] == 0, 'CONTRACT_NOT_ADMITTED')
    need(c.get('expectedCurrent') == CURRENT and c.get('sourceBaseline') == CURRENT
         and c.get('sourceBaselineTree') == SOURCE_TREE and c.get('publishedPrevious') == PUBLISHED_PREVIOUS
         and digest(canonical(c.get('baseline'))) == BASELINE_PROJECTION_SHA256, 'PREDECESSOR_CHANGED')
    old = prior_contract()
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
    rows = {**old['baselineWorkerFiles'], **old['workerFiles']}
    need(c.get('baselineWorkerFiles') == rows and signature(rows) == b['inventory']['worker']
         and all(b['inventory'][slot] == c['publishedInventory'][slot]
                 for slot in ('api', 'apiJavascript', 'worker', 'admin', 'prisma', 'engine')),
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
             'online-recharge': old['roleSourceCommits']['online-recharge']}, 'SAFETY_INPUT_CHANGED')
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
         and proof['inheritedValidation'] == PUBLISHED_PREVIOUS
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
