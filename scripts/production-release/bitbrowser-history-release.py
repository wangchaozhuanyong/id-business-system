"""Finite API-only successor for complete, read-only checkout history pagination."""
import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'BITBROWSER_HISTORY_PAGINATION_20261019'
CURRENT = 'fe27681e1ef06b14616276dff33c3febeea47579'
PREDECESSOR_PROOF = 'c2b20ec0385b85c5118a0ee20eb7ec4e4a12ce7fd6bf6c4bc338f26b991868fc'
PREDECESSOR_CONTRACT = '32128879704885ddba87f3cd356bc7736dddadeb71e27b7cc445aa9f1bb4b46a'
CONTRACT_FILE = 'bitbrowser-history-contract.json'
WORKFLOW = '.github/workflows/bitbrowser-history-validation.yml'
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
API_SOURCES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n + '.ts'
    for n in ('persistence/recharge.repository', 'recharge-account-restore', 'recharge-unidentified-checkout'))
TEST_SOURCES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n + '.spec.ts' for n in (
    'persistence/recharge-history.repository', 'recharge-unidentified-checkout', 'recharge-unidentified-replacement'))
APPLICATION = API_SOURCES | TEST_SOURCES
MODULES = frozenset(n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
    for n in API_SOURCES for suffix in ('.js', '.d.ts', '.js.map'))
SHARED = frozenset(n + suffix for n in ('index', 'v2/auto-recharge', 'v2/checkout-diagnostic')
    for suffix in ('.js', '.d.ts'))
MYSQL_FILES = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n
    for n in ('recharge-availability.mysql.integration.spec.ts', 'recharge-direct-payment.mysql.integration.spec.ts'))
INHERITED = frozenset(('bitbrowser-recovery-build.py', 'bitbrowser-recovery-release.py',
    'bitbrowser-recovery-contract.json', 'bitbrowser-billing-build.py', 'bitbrowser-billing-release.py',
    'bitbrowser-billing-contract.json', 'online-query-network-build.py', 'online-query-network-release.py',
    'online-query-network-contract.json', 'online-session-preflight-contract.json',
    'online-pending-features-contract.json', 'recharge-record-build.py', 'recharge-record-release.py',
    'remote-deploy.py', 'recharge-availability-release.py', 'recharge-checkout-release.py',
    'proxy-result-identity-release.py', 'api-admin-scope.py'))
CONTROLS = INHERITED | frozenset('bitbrowser-history-' + n
    for n in ('build.py', 'release.py', 'dispatch.py', 'release.test.py'))
CI_CONTROLS = frozenset('scripts/ci-recharge-' + n
    for n in ('scope.mjs', 'scope.test.mjs', 'check.mjs', 'check.test.mjs'))
ENGINE = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
CONFIGURATION = ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')
OBSERVE_PINS = {
    'recharge-record-release.py': '4ca6d0053f5dc4368d85722ef0df272ace0947c1c91993a0a3da598507b5163f',
    'remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c',
    'online-query-network-release.py': '102f47d1dfd7eded71375da1d4e78215d48f8e20e9b4c11fabe1803331f98ce0',
    'bitbrowser-recovery-contract.json': PREDECESSOR_CONTRACT}


# A closed successor recipe reuses this controller; published legacy contracts stay byte-identical.
FOLLOWUP = 'followup-20261019'
FOLLOWUP_CURRENT = '02a348a6c6b252968bc63ccb38c7d2b82e0e0c66'
FOLLOWUP_PROOF = '3736a559f737576b8fd386a34abfc49587520c2644136f9c199b1bdec1b79cc9'
LEGACY_CONTRACT_SHA = '7b0adc46b435e4e1824c6c142d1948168aa38ebc010a8e81f071abb077b0dc91'
ADMIN_BUILD = CURRENT
ADMIN_PROOF = PREDECESSOR_PROOF
ADMIN_SOURCE = 'faea152b038c7ddb1a3199070f9dc7ffb5583c36'
HISTORY_SOURCE = '3317af5de7330c57a926181dd03cded795c4c38f'
ADMIN_ROOT = 'apps/admin/src/v2/features/auto-recharge/'
FOLLOWUP_API = frozenset('apps/api/src/id-business-v2/auto-recharge/' + n + '.ts'
    for n in ('recharge-account-restore', 'recharge-unidentified-checkout'))
FOLLOWUP_ADMIN = frozenset(ADMIN_ROOT + n for n in (
    'bitbrowser-native-quote.ts', 'bitbrowser-payment-observer.ts', 'bitbrowser-direct-payment.ts'))
FOLLOWUP_TESTS = frozenset(('apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-replacement.spec.ts',
    *(ADMIN_ROOT + n for n in ('bitbrowser-native-quote.spec.ts', 'bitbrowser-native-observer.spec.ts',
        'bitbrowser-direct-payment.spec.ts'))))
RECIPE = 'history-20261019'
UPDATED = ('api',)
PROOF_FILE = 'recharge-checkout-build-proof.json'
BASELINE_STATUS = 'BITBROWSER_HISTORY_READONLY_BASELINE'
ARTIFACT_LIMIT = 8 * 1024**2
_LEGACY = {n: globals()[n] for n in ('SCOPE', 'CURRENT', 'PREDECESSOR_PROOF', 'CONTRACT_FILE', 'PRESERVED',
    'API_SOURCES', 'TEST_SOURCES', 'APPLICATION', 'MODULES', 'INHERITED', 'CONTROLS', 'RECIPE', 'UPDATED',
    'PROOF_FILE', 'BASELINE_STATUS', 'ARTIFACT_LIMIT')}


def select_recipe(name):
    need(name in ('history-20261019', FOLLOWUP), 'RECIPE_INVALID')
    globals().update(_LEGACY)
    if name == FOLLOWUP:
        sources = FOLLOWUP_API
        inherited = INHERITED | frozenset(('bitbrowser-history-contract.json',))
        globals().update(RECIPE=name, SCOPE='BITBROWSER_FOLLOWUP_ACCEPTANCE_20261019',
            CURRENT=FOLLOWUP_CURRENT, PREDECESSOR_PROOF=FOLLOWUP_PROOF,
            CONTRACT_FILE='bitbrowser-followup-contract.json', PRESERVED=('mysql', 'caddy', 'media-resolver', 'auto-recharge'),
            API_SOURCES=sources, TEST_SOURCES=FOLLOWUP_TESTS,
            APPLICATION=sources | FOLLOWUP_ADMIN | FOLLOWUP_TESTS,
            MODULES=frozenset(n.removeprefix('apps/api/src/').removesuffix('.ts') + ext
                for n in sources for ext in ('.js', '.d.ts', '.js.map')),
            INHERITED=inherited, CONTROLS=inherited | (_LEGACY['CONTROLS'] - _LEGACY['INHERITED']),
            UPDATED=('api', 'admin'), PROOF_FILE='bitbrowser-history-build-proof.json',
            BASELINE_STATUS='BITBROWSER_FOLLOWUP_READONLY_BASELINE', ARTIFACT_LIMIT=32 * 1024**2)
    return name


def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_HISTORY_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('history_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory(value):
    return type(value) is dict and bool(value) and all(isinstance(n, str)
        and re.fullmatch('[A-Za-z0-9_./-]+', n) and not n.startswith('/') and '..' not in Path(n).parts
        and isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for n, v in value.items())


def summary(value):
    return type(value) is dict and set(value) == {'count', 'sha256'} and type(value['count']) is int \
        and value['count'] > 0 and isinstance(value['sha256'], str) and re.fullmatch('[a-f0-9]{64}', value['sha256'])


def validate_contract(c):
    need(type(c) is dict and c.get('version') == 1 and c.get('status') == 'FROZEN'
        and c.get('scope') == SCOPE and c.get('recipe', 'history-20261019') == RECIPE and c.get('expectedCurrent') == c.get('reviewBase') == CURRENT
        and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
        and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
        and c['businessActions'] == 0, 'CONTRACT_IDENTITY_INVALID')
    need(inventory(c.get('sources')) and set(c['sources']) == APPLICATION
        and set(c.get('apiModules', [])) == MODULES and c.get('updatedServices') == list(UPDATED)
        and c.get('reboundServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED),
        'SOURCE_SCOPE_INVALID')
    need(inventory(c.get('publishedApiModules')) and len(c['publishedApiModules']) == 40
        and MODULES <= set(c['publishedApiModules']) and inventory(c.get('publishedSharedFiles'))
        and set(c['publishedSharedFiles']) == SHARED, 'PREDECESSOR_OUTPUT_INVALID')
    need(inventory(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and c['controlPins']['bitbrowser-recovery-contract.json'] == PREDECESSOR_CONTRACT
        and inventory(c.get('ciControlPins')) and set(c['ciControlPins']) == CI_CONTROLS
        and inventory(c.get('mysqlTestSources')) and set(c['mysqlTestSources']) == MYSQL_FILES
        and c.get('predecessorProofSha256') == PREDECESSOR_PROOF
        and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', ''))
        and re.fullmatch('[a-f0-9]{64}', c.get('qualityWorkflowSha256', ''))
        and c.get('sqlFenceHelperSha256') == c['controlPins']['api-admin-scope.py'], 'CONTROL_SCOPE_INVALID')
    b = c.get('baseline', {})
    need(b.get('commit') == CURRENT and b.get('status') == BASELINE_STATUS
        and type(b.get('businessActions')) is int and type(b.get('databaseWrites')) is int
        and b['businessActions'] == b['databaseWrites'] == 0
        and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
        and Path(b.get('current', '')).parent == BASE / 'releases'
        and set(b.get('services', {})) == set(SERVICES)
        and all(s.get('status') == 'running' and (s.get('health') == 'healthy' or n == 'caddy')
            for n, s in b['services'].items())
        and inventory(b.get('runtimeConfigurationSha256')) and set(b['runtimeConfigurationSha256']) == set(SERVICES)
        and inventory(b.get('configurationSha256')) and set(b['configurationSha256']) == set(CONFIGURATION)
        and b.get('proofs', {}).get(PROOF_FILE) == PREDECESSOR_PROOF
        and inventory(b.get('apiModules')) and set(b['apiModules']) == MODULES
        and all(b['apiModules'][n] == c['publishedApiModules'][n] for n in MODULES)
        and all(summary(b.get(n)) for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'adminInventory'))
        and b.get('database', {}).get('pending') == 0
        and inventory({n: b.get('database', {}).get(n) for n in ('ledger', 'columns')})
        and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', ''))
        and b.get('backupNormalizerSha256') == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
        and c.get('engineHealth') == ENGINE, 'BASELINE_INVALID')
    if RECIPE == FOLLOWUP:
        need(c.get('sourceReviewTree') and re.fullmatch('[a-f0-9]{40}', c['sourceReviewTree'])
            and c.get('adminBuildCommit') == ADMIN_BUILD and c.get('adminProofSha256') == ADMIN_PROOF
            and inventory(c.get('publishedAdminFiles')) and len(c['publishedAdminFiles']) == 261
            and c['controlPins'].get('bitbrowser-history-contract.json') == LEGACY_CONTRACT_SHA
            and b['proofs'].get('recharge-checkout-build-proof.json') == ADMIN_PROOF
            and b['services']['api']['image'] == 'sha256:e25b51ac8bb4c7ab0932a19f63a497d221f12e893a07cf05096085de5de822ef'
            and b['services']['admin']['image'] == 'sha256:611cca5fc6fcdbb60d77217b38069ce80027e37a0b31cba3be9ad3d6ab7fb01a',
            'FOLLOWUP_PROVENANCE_INVALID')



def verify_mysql(value, identity, c):
    need(type(value) is dict and value.get('scope') == 'OWNED_EMPTY_DATABASE'
        and value.get('runtime') == 'github-actions-mysql-service'
        and all(value.get(n) == identity[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt'))
        and value.get('testFiles') == c['mysqlTestSources']
        and all(type(value.get(n)) is int for n in ('testsTotal', 'testsPassed', 'testsSkipped', 'testsTodo', 'productionActions'))
        and value['testsTotal'] == value['testsPassed'] == 18
        and value['testsSkipped'] == value['testsTodo'] == value['productionActions'] == 0
        and re.fullmatch('[a-f0-9]{64}', value.get('reportSha256', '')), 'MYSQL_EVIDENCE_INVALID')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(n) == plan.get(n) for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
        'contractSha256', 'qualityVerification', 'isolatedMysqlVerification'))
        and proof.get('version') == 1 and proof.get('scope') == SCOPE and proof.get('sources') == c['sources']
        and proof.get('controlSources') == c['controlPins'] and proof.get('baselineModulesReproduced') == c['baseline']['apiModules']
        and proof.get('predecessorProofSha256') == PREDECESSOR_PROOF
        and proof.get('baselineSharedUnchanged') is True and proof.get('migrationPerformed') is False
        and proof.get('businessActions') == 0 and proof.get('updatedServices') == list(UPDATED)
        and inventory(proof.get('apiModules')) and set(proof['apiModules']) == MODULES, 'PROOF_INVALID')
    verify_mysql(proof.get('isolatedMysqlVerification'), plan, c)
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
        **{'source/' + n: v for n, v in c['sources'].items()}}
    if RECIPE == FOLLOWUP:
        need(proof.get('recipe') == FOLLOWUP and proof.get('baselineAdminReproduced') is True
            and proof.get('baselineAdminFiles') == c['publishedAdminFiles'] and inventory(proof.get('adminFiles'))
            and len(proof['adminFiles']) >= 250 and 'index.html' in proof['adminFiles'],
            'ADMIN_BUILD_PROOF_INVALID')
        expected.update({'admin/html/' + n: v for n, v in proof['adminFiles'].items()})
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def helpers():
    h, d = load('recharge-record-release.py'), load('remote-deploy.py')
    h.SERVICES = SERVICES
    retired = load('online-query-network-release.py')
    h.guards = lambda driver, directory, states, c: retired.retired_guards(driver, directory, states, c, h)
    return h, d, retired


def runtime(d, states):
    # Only file names, counts and SHA256 values leave the containers.
    code = "const excluded=" + json.dumps(sorted(MODULES)) + ";" + r"""
const fs=require('fs'),path=require('path'),crypto=require('crypto');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function inv(root,except=[]){const out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),n=path.relative(root,p);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(p);else if(e.isFile()&&!except.includes(n))out[n]=hash(fs.readFileSync(p));else if(!e.isFile())throw Error('KIND');}}walk(root);const sorted=Object.fromEntries(Object.entries(out).sort(([a],[b])=>a<b?-1:a>b?1:0));return{count:Object.keys(sorted).length,sha256:hash(JSON.stringify(sorted))};}
console.log(JSON.stringify({apiModules:Object.fromEntries(excluded.map(n=>[n,hash(fs.readFileSync('/app/apps/api/dist/'+n))])),apiPreservedInventory:inv('/app/apps/api/dist',excluded),sharedInventory:inv('/app/packages/shared/dist'),clientInventory:inv('/app/node_modules/.prisma/client')}));
"""
    result = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code, timeout=90))
    rows = {}
    for line in d.run('docker', 'exec', states['admin']['containerId'], 'sh', '-c',
        'cd /usr/share/nginx/html && test -z "$(find . -type l -print -quit)" && find . -type f -exec sha256sum {} +', timeout=90).splitlines():
        digest, name = line.split('  ', 1)
        need(name.startswith('./') and re.fullmatch('[a-f0-9]{64}', digest) and name not in rows, 'ADMIN_INVENTORY_INVALID')
        rows[name.removeprefix('./')] = digest
    result['adminInventory'] = {'count': len(rows), 'sha256': sha(canonical(rows))}
    result['nginxSha256'] = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
        '/etc/nginx/conf.d/default.conf').split()[0]
    return result


def database(d, state):
    code = r"""const{PrismaClient}=require('@prisma/client'),c=require('crypto');const p=new PrismaClient({log:[]});
(async()=>{const rows=await p.$queryRawUnsafe('SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');const cols=await p.$queryRawUnsafe('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');const hash=v=>c.createHash('sha256').update(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)).digest('hex');console.log(JSON.stringify({ledger:hash(rows),columns:hash(cols),pending:Number(pending[0].n)}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());"""
    return json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=60))


def observe():
    """Explicit read-only server entry; no credentials, business rows, files or state are changed."""
    need(all((HERE / n).is_file() and not (HERE / n).is_symlink()
        and sha((HERE / n).read_bytes()) == v for n, v in OBSERVE_PINS.items()), 'OBSERVER_HELPER_CHANGED')
    h, d, retired = helpers()
    current = (BASE / 'current').resolve(strict=True)
    need(current.parent == BASE / 'releases', 'CURRENT_PATH_INVALID')
    raw = (current / 'release-manifest.json').read_bytes()
    need(json.loads(raw).get('commit') == CURRENT, 'CURRENT_CHANGED')
    proof = (current / PROOF_FILE).read_bytes()
    need(sha(proof) == PREDECESSOR_PROOF, 'PREDECESSOR_PROOF_CHANGED')
    states = h.snapshot(d, current)
    h.guards(d, current, states, {'engineHealth': ENGINE})
    old = json.loads((HERE / 'bitbrowser-recovery-contract.json').read_bytes())
    normalizer = Path(old['baseline']['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink(), 'BACKUP_NORMALIZER_INVALID')
    return {'status': BASELINE_STATUS, 'commit': CURRENT, 'current': str(current),
        'manifestSha256': sha(raw), 'services': states,
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, state) for n, state in states.items()},
        'proofs': {PROOF_FILE: sha(proof), **({'recharge-checkout-build-proof.json': ADMIN_PROOF} if RECIPE == FOLLOWUP else {})}, **runtime(d, states),
        'database': database(d, states['api']), 'backupNormalizerPath': str(normalizer),
        'backupNormalizerSha256': sha(normalizer.read_bytes()), 'freeBytes': shutil.disk_usage(BASE).free,
        'businessActions': 0, 'databaseWrites': 0}


def baseline(d, h, c, expected=None):
    current = (BASE / 'current').resolve(strict=True)
    b = c['baseline']
    need(str(current) == b['current'] and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(sha(raw) == b['manifestSha256'] and json.loads(raw).get('commit') == CURRENT, 'MANIFEST_CHANGED')
    need(all(sha((current / n).read_bytes()) == v for n, v in b['proofs'].items()), 'PREDECESSOR_PROOF_CHANGED')
    states = h.snapshot(d, current)
    need(states == b['services'] and {n: h.configuration(d, s) for n, s in states.items()} == b['runtimeConfigurationSha256'],
        'SERVICES_CHANGED')
    need({n: sha((current / n).read_bytes()) for n in CONFIGURATION} == b['configurationSha256'], 'CONFIGURATION_CHANGED')
    need(runtime(d, states) == {n: b[n] for n in ('apiModules', 'apiPreservedInventory', 'sharedInventory',
        'clientInventory', 'adminInventory', 'nginxSha256')} and database(d, states['api']) == b['database'], 'RUNTIME_CHANGED')
    normalizer = Path(b['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
        and sha(normalizer.read_bytes()) == b['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, current, states, c)
    receipt = load('recharge-availability-release.py').runtime_receipt(current, raw, states)
    if expected is not None:
        need(receipt == expected, 'BASELINE_MOVED')
    return current, raw, states, receipt


def verify_admin_merge(before, candidate, actual, baseline):
    need(inventory(before) and inventory(candidate)
        and {'count': len(before), 'sha256': sha(canonical(before))} == baseline, 'ADMIN_HISTORY_CHANGED')
    merged = {**before, **candidate}
    need(actual == merged, 'ADMIN_HISTORY_CHANGED')
    return {'count': len(merged), 'sha256': sha(canonical(merged))}


def smoke(d, h, retired, target, states, c, proof, before_admin=None):
    before = c['baseline']['services']
    need(all(states[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['image'] == before['online-recharge']['image']
        and all(states[n]['environmentSha256'] == before[n]['environmentSha256'] for n in (*UPDATED, 'online-recharge'))
        and {n: h.configuration(d, s) for n, s in states.items()} == c['baseline']['runtimeConfigurationSha256'],
        'RUNTIME_CONFIGURATION_CHANGED')
    observed = runtime(d, states)
    expected_runtime = {**{n: c['baseline'][n] for n in ('apiModules', 'apiPreservedInventory', 'sharedInventory',
        'clientInventory', 'adminInventory', 'nginxSha256')}, 'apiModules': proof['apiModules']}
    if RECIPE == FOLLOWUP:
        need(type(before_admin) is dict and inventory(before_admin), 'ADMIN_HISTORY_MISSING')
        expected_runtime['adminInventory'] = verify_admin_merge(before_admin, proof['adminFiles'],
            load('recharge-checkout-release.py').admin_inventory(d, states['admin']), c['baseline']['adminInventory'])
        with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
            public = response.read(2 * 1024**2 + 1)
        need(sha(public) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in public, 'PUBLIC_BUILD_CHANGED')
    need(observed == expected_runtime and database(d, states['api']) == c['baseline']['database'], 'RUNTIME_CONTENT_CHANGED')
    original = json.loads((Path(c['baseline']['current']) / 'compose.release.json').read_bytes())
    selected = json.loads((target / 'compose.release.json').read_bytes())
    for role in UPDATED:
        selected['services'][role]['image'] = original['services'][role]['image']
    need(selected == original and all(sha((target / n).read_bytes()) == c['baseline']['configurationSha256'][n]
        for n in CONFIGURATION if n != 'compose.release.json'), 'COMPOSE_SCOPE_CHANGED')
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
    for name, digest in c['sources'].items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target) and sha(path.read_bytes()) == digest, 'HOST_SOURCE_CHANGED')
    retired.verify_retired_runtime(d, states)
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)


def release(plan, c):
    validate_contract(c)
    raw_contract = (HERE / CONTRACT_FILE).read_bytes()
    need(c == json.loads(raw_contract) and plan.get('contractSha256') == sha(raw_contract)
        and plan.get('controlSources') == {**c['controlPins'], CONTRACT_FILE: sha(raw_contract)}, 'PLAN_CHANGED')
    need(plan.get('recipe', 'history-20261019') == RECIPE, 'PLAN_RECIPE_CHANGED')
    need(plan.get('mode') in ('preflight', 'release', 'readback')
        and all(re.fullmatch('[a-f0-9]{40}', plan.get(n, '')) for n in ('commit', 'tree'))
        and all(re.fullmatch('[1-9][0-9]*', plan.get(n, '')) for n in ('workflowRunId', 'workflowRunAttempt')), 'PLAN_IDENTITY_INVALID')
    for name, digest in plan['controlSources'].items():
        path = HERE / name
        need(path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == digest, 'CONTROL_CHANGED')
    h, d, retired = helpers()
    a, p = load('recharge-availability-release.py'), load('proxy-result-identity-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / 'bitbrowser-history-build-proof.json').read_bytes()
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE
                and sha(raw) == plan['buildProofSha256'], 'READBACK_IDENTITY_CHANGED')
            proof = json.loads(raw)
            receipt = json.loads((target / 'bitbrowser-history-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and states['api']['image'] == receipt['image']['imageId']
                and (RECIPE != FOLLOWUP or all(states[role]['image'] == receipt['images'][role]['imageId'] for role in UPDATED)),
                'READBACK_SERVICES_CHANGED')
            need(all(sha((target / 'scripts/production-release' / n).read_bytes()) == v
                for n, v in plan['controlSources'].items()), 'READBACK_EXECUTOR_CHANGED')
            smoke(d, h, retired, target, states, c, proof, receipt.get('beforeAdminFiles'))
            h.guards(d, target, states, c)
            old_projections = json.loads((Path(c['baseline']['current']) / 'release-manifest.json').read_bytes())['roleSourceProjections']
            need(all(manifest['roleSourceProjections'][role]['parentProjection'] == old_projections[role] for role in UPDATED),
                'SOURCE_INHERITANCE_CHANGED')
            return {'status': 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                'updatedServices': list(UPDATED), 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': False}
        if plan['mode'] == 'release':
            need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        previous, raw_manifest, before, receipt = baseline(d, h, c, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'commit': plan['commit'],
                'runtimeBaseline': receipt, 'businessActions': 0, 'migrationPerformed': False}
        stage = BASE / '.staging' / ('bitbrowser-history-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/bitbrowser-history-' + plan['commit'] + '/bitbrowser-history-artifact.tar.gz'
        need(plan.get('artifactUrl') == url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(url, timeout=60) as response:
            bundle = response.read(ARTIFACT_LIMIT + 1)
        need(0 < len(bundle) <= ARTIFACT_LIMIT and sha(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = verify_proof(json.loads(raw_proof), plan, c, payload, h)
        images = {}
        for role in UPDATED:
            context = payload / role
            a.normalize_image_context(context)
            reference = 'id-business-v2-history:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            copy_line = 'COPY modules/ /app/apps/api/dist/' if role == 'api' else 'COPY html/ /usr/share/nginx/html/'
            (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before[role])
                + '\n' + copy_line + '\nLABEL org.opencontainers.image.revision="' + plan['commit']
                + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            p.verify_overlay_image(original, built, plan, 1, load('recharge-checkout-release.py'))
            images[role] = {'reference': reference, 'imageId': built['Id']}
        before_admin = load('recharge-checkout-release.py').admin_inventory(d, before['admin']) if RECIPE == FOLLOWUP else None
        baseline(d, h, c, plan['runtimeBaseline'])
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-bitbrowser-history')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in c['sources']:
            destination = target / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'SOURCE_PATH_CHANGED')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
            destination.chmod(0o644)
        for name in plan['controlSources']:
            destination = target / 'scripts/production-release' / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'CONTROL_PATH_CHANGED')
            destination.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, c, plan['runtimeBaseline'])
        retired.SCOPE = SCOPE
        markers = retired.claim_retired_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': markers}) + '\n')
        try:
            fence.acquire()
            p.verify_markers(markers)
            fence.stop(before['api'], grace=30)
            fence.stop(before['online-recharge'], grace=45)
            fence.close()
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *UPDATED, timeout=180)
            for role in UPDATED:
                d.wait_healthy(target, role)
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[role]['image'] == images[role]['imageId'] for role in UPDATED), 'IMAGE_CHANGED')
            smoke(d, h, retired, target, after, c, proof, before_admin)
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target),
                'maintenanceHeld': True, 'rollbackPerformed': False}) + '\n')
            raise
        finally:
            fence.close()
        image = images['api']
        preservation = {'status': 'BITBROWSER_HISTORY_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
            'before': before, 'after': after, 'image': image, 'images': images, 'beforeAdminFiles': before_admin, 'backup': backup, 'workflowRunId': plan['workflowRunId'],
            'businessActions': 0, 'migrationPerformed': False}
        (target / 'bitbrowser-history-preservation.json').write_text(json.dumps(preservation, sort_keys=True, indent=2) + '\n')
        (target / 'bitbrowser-history-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        for role in UPDATED:
            manifest['roleSourceProjections'][role] = {'kind': SCOPE, 'commit': plan['commit'],
                'parentProjection': copy.deepcopy(manifest['roleSourceProjections'][role]),
                'sources': {n: v for n, v in c['sources'].items() if n.startswith('apps/' + role + '/')},
                'buildProofSha256': plan['buildProofSha256']}
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        if RECIPE == FOLLOWUP:
            manifest['previousAdminSourceProjection'] = copy.deepcopy(manifest.get('adminSourceProjection'))
            manifest['adminSourceProjection'] = copy.deepcopy(manifest['roleSourceProjections']['admin'])
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
            previousCommit=CURRENT, previousRelease=str(previous), previousManifestSha256=sha(raw_manifest),
            status='DEPLOYED', servicesUpdated=list(UPDATED), servicesRebound=['online-recharge'], newMigrations=[],
            migrationPerformed=False, paymentActions=0, bitbrowserHistoryPublication=preservation,
            apiCompiledArtifact={'url': url, 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-bitbrowser-history')
        p.release_markers(markers)
        h.guards(d, target, after, c)
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {n: preservation[n] for n in ('status', 'commit', 'tree', 'image', 'workflowRunId', 'businessActions', 'migrationPerformed')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recipe', default='history-20261019', choices=('history-20261019', FOLLOWUP))
    parser.add_argument('--observe', action='store_true', required=True)
    args = parser.parse_args()
    select_recipe(args.recipe)
    print(json.dumps(observe(), sort_keys=True))
