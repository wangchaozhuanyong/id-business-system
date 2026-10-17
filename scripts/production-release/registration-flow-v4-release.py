"""Finite protocol adapter repair over the exact published component baseline.

Historical controllers remain immutable. Reuse their accepted lock, backup,
write fence and switch code in a private namespace, with this task's admission,
inventory, proof and preservation checks. No migration or signup is performed.
"""
import copy
import inspect
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import types
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = 'registration-flow-v4-20261017'
PREFIX = 'registration-flow-v4'
SCOPE = 'REGISTRATION_FLOW_V4_20261017'
CURRENT = '8df81dca0f08ebdebe6b01b942b033053b8a5c3b'
CURRENT_DIRECTORY = '/opt/id-business-v2/releases/20261017T084211Z-8df81dca0f08-online-legacy-close'
CURRENT_MANIFEST = '1e767009dc638f473fd843337fa1eece1c72efbfed35688510adf4d7c0a30460'
BASELINE_PROJECTION_SHA256 = '0a179d2830feeede7c7a3640c9da7742d608cd73631b46ea2dcbdd91d3fe4fc7'
BASE = Path('/opt/id-business-v2')
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
TYPE_MODULE = 'id-business-v2/auto-registration/apple-mailboxes.types.d.ts'
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
HEX = r'[a-f0-9]{64}'
CONTROL_FILES = (
    'registration-flow-v4-build.py', 'registration-flow-v4-release.py',
    'registration-flow-v4-dispatch.py', 'registration-flow-v4-release.test.py',
    'registration-parity-diagnostics-release.py', 'registration-parity-diagnostics-dispatch.py',
    'registration-closure-release.py', 'registration-closure-dispatch.py',
    'recharge-record-release.py', 'recharge-availability-release.py', 'proxy-result-identity-release.py',
    'recharge-billing-release.py', 'api-admin-scope.py', 'remote-deploy.py',
    'registration-protocol-repair-build.py', 'registration-protocol-repair-release.py',
    'registration-protocol-repair-dispatch.py', 'registration-protocol-repair-release.test.py',
    'registration-protocol-repair-contract.json')
RUNTIME_WORKER_FILES = ('apple_mailboxes.py', 'apple_registration_diagnostics.py', 'flow_evidence.py',
                        'id-workspace.js', 'id-workspace.css', 'release_safety.py', 'precondition_diagnostics.py')
VALIDATION_SUPPORT_SOURCES = {'scripts/check-v2-module-architecture.mjs': '0abe913ace9e319c6ac6f0764efaea76b17c1a06bce018259fbc805765ab5383', 'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py': 'e38b3dd48b3e9d50b87a637681b89f70d0ebe7104132d0ef2fb448036c8af7ec', 'apps/api/src/id-business-v2/auto-registration/worker/test_flow_contract_unit.py': '53410cf3de35c8b37cfc2022428931c9b139f7f39cbf04d889ea4a1866407627'}
APPLICATION_PATHS = tuple(
    ['apps/admin/src/v2/features/auto-registration/' + name for name in
     ('apple-mailbox-presentation.spec.ts', 'apple-mailbox-presentation.ts', 'contracts.ts', 'V2AppleMailboxes.vue')]
    + ['apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts']
    + [WORKER + name for name in ('apple_mailboxes.py', 'apple_registration_diagnostics.py', 'flow_evidence.py',
       'id-workspace.js', 'id-workspace.css', 'release_safety.py', 'test_apple_mailboxes.py', 'test_flow_v4_unit.py',
       'test_flow_evidence.py', 'test_registration_parity_unit.py', 'test_release_safety.py', 'precondition_diagnostics.py', 'test_precondition_diagnostics.py')])


def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def signature(files):
    return {'fileCount': len(files), 'sha256': digest(canonical(files))}


def helper(name):
    need(re.fullmatch(r'[a-z0-9.-]+', name), 'HELPER_PATH_INVALID')
    path = HERE / name
    spec = importlib.util.spec_from_file_location('protocol_repair_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def historical_repair(c):
    binding = c['reconstruction']['registeredRepair']
    raw = (HERE / 'registration-protocol-repair-contract.json').read_bytes()
    need(binding['commit'] == 'a37e775636f25cd405e33e014519f9881c094d9b'
         and digest(raw) == binding['contractSha256'] == '45c0f30757015c2dac8062c5eee128ff4cbe61a36be153849853d4dec8f33c4c',
         'PUBLISHED_REPAIR_RECIPE_CHANGED')
    old = json.loads(raw)
    helper('registration-protocol-repair-release.py').verify_contract(old)
    need(signature(old['sources']) == binding['sources'], 'PUBLISHED_REPAIR_SOURCES_CHANGED')
    return old


def verify_contract(c):
    need(type(c.get('version')) is int and c['version'] == 1 and c.get('frozen') is True
         and c.get('admission') == 'VERIFIED' and c.get('name') == NAME and c.get('scope') == SCOPE
         and c.get('migration') is None and type(c.get('businessActions')) is int
         and c['businessActions'] == 0 and c.get('pendingEvidence') == [], 'CONTRACT_NOT_ADMITTED')
    # The final independently reviewed native projection is pinned in this new
    # controller. DRAFT placeholders can never authorize production or a build.
    need(c.get('expectedCurrent') == CURRENT and c.get('current') == CURRENT_DIRECTORY
         and c.get('manifestSha256') == CURRENT_MANIFEST
         and digest(canonical(c.get('baseline'))) == BASELINE_PROJECTION_SHA256, 'PREDECESSOR_CHANGED')
    old = historical_repair(c)
    sources = c.get('sources')
    need(isinstance(sources, dict) and set(sources) == set(c.get('applicationPaths', [])) == set(APPLICATION_PATHS)
         and all(name.startswith(('apps/admin/src/v2/features/auto-registration/',
                                  'apps/api/src/id-business-v2/auto-registration/'))
                 and '/upstream/' not in name and '..' not in Path(name).parts
                 and re.fullmatch(HEX, value) for name, value in sources.items()), 'APPLICATION_SCOPE_CHANGED')
    need(set(c.get('workerFiles', {})) == set(RUNTIME_WORKER_FILES)
         and all(c['workerFiles'][name] == sources.get(WORKER + name) for name in RUNTIME_WORKER_FILES),
         'WORKER_SCOPE_CHANGED')
    need(set(c.get('apiDeclarationPaths', [])) == {TYPE_MODULE}
         and c.get('apiJavascriptDelta') == [] and c.get('apiRuntimeDelta') == [], 'API_SCOPE_CHANGED')
    need(set(c.get('validationSources', {})) == {'scripts/acceptance-v2-registration-parity-diagnostics.mjs'}
         and c.get('validationSupportSources') == VALIDATION_SUPPORT_SOURCES
         and all(re.fullmatch(HEX, value) for value in
                 {**c['validationSources'], **c['validationSupportSources']}.values()), 'VALIDATION_SCOPE_CHANGED')
    b = c['baseline']
    need(set(b['services']) == set(helper('recharge-record-release.py').SERVICES)
         and b['commit'] == CURRENT and b['current'] == CURRENT_DIRECTORY and b['manifestSha256'] == CURRENT_MANIFEST,
         'LIVE_COMPONENT_BASELINE_MISSING')
    for slot in ('api', 'apiJavascript', 'worker', 'admin', 'prisma', 'engine'):
        item = b.get('inventory', {}).get(slot)
        need(isinstance(item, dict) and set(item) == {'fileCount', 'sha256'}
             and type(item['fileCount']) is int and item['fileCount'] > 0 and re.fullmatch(HEX, item['sha256']),
             'INVENTORY_BASELINE_MISSING')
    expected_worker = {**old['baselineWorkerFiles'], **old['workerFiles']}
    expected_pins = {**old['reconstruction']['runtimeWorkerSources'],
                     **{name: {'commit': c['reconstruction']['registeredRepair']['commit'], 'sha256': value}
                        for name, value in old['workerFiles'].items()}}
    need(c.get('baselineWorkerFiles') == expected_worker
         and c['reconstruction']['runtimeWorkerSources'] == expected_pins
         and signature(expected_worker) == b['inventory']['worker'], 'RUNTIME_WORKER_SOURCE_SCOPE_CHANGED')
    need(all(c['reconstruction'].get(key) == old['reconstruction'][key] for key in
             ('commit', 'helperSha256', 'contractSha256', 'displaySources', 'successor',
              'previousAdminProof', 'successorAdminProof', 'publishedRecharge')), 'RECONSTRUCTION_HISTORY_CHANGED')
    repaired = c['reconstruction']['registeredRepair']['proof']
    published = b.get('publishedProofs', {}).get('registration-protocol-repair-20261017-build-proof.json', {})
    need(repaired == {'scope': 'REGISTRATION_PROTOCOL_REPAIR_20261017',
             'commit': 'a37e775636f25cd405e33e014519f9881c094d9b',
             'tree': 'ab5238055aac21941f0d700d46695412fa499a6d',
             'sha256': '3507bc7c9c00de4893fde083d2033168cc8263b74ced19f8e2bcdedae3b04edf',
             'adminFiles': {'fileCount': 261, 'sha256': '88f2e4e02dd46722f740943dece93bfcbbed639a2be259c9e5eeb40ee859c176'},
             'apiModules': {'fileCount': 0, 'sha256': '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'}}
         and all(published.get(key) == value for key, value in repaired.items()), 'PUBLISHED_REPAIR_PROOF_CHANGED')
    legacy = c['reconstruction'].get('legacyClose', {})
    need(legacy.get('commit') == CURRENT
         and legacy.get('contractSha256') == '39c386acf122a766a02d8d76831b85f014270f3aca7704e08353cd87934d0d27'
         and legacy.get('sourceReviewCommit') == 'd59b5c43fa69aedbc1ce2dc4739e1fadd7bf991a'
         and legacy.get('sources') == {'fileCount': 5,
             'sha256': '398c98d2e3daeed373e7b65aa63cf9f20d50b83788fad03a1ff07789e488dc1a'}
         and legacy.get('proof') == b['publishedProofs'].get('online-legacy-close-build-proof.json')
         and legacy['proof'] == {'commit': CURRENT, 'scope': 'ONLINE_LEGACY_UNPAID_CLOSURE',
             'tree': '7052cfbe3bcfdf64f8909fdb0c0263355ff7c16c',
             'sha256': 'cee6476432a5656c5192ed1d8b5eea8ffeb44c69099b860c284e8f6567a71e6c',
             'apiModules': {'fileCount': 3, 'sha256': '138237e06a26e812376087e767b44bc0ece62093eb58ab2081b8a4591c9d160b'}},
         'PUBLISHED_LEGACY_BINDING_CHANGED')
    need(isinstance(b.get('sqlite'), dict) and re.fullmatch(HEX, b['sqlite'].get('logicalSha256', ''))
         and not b['sqlite']['taskCounts'].get('pending', 0) and not b['sqlite']['taskCounts'].get('running', 0)
         and isinstance(b.get('mysql'), dict) and re.fullmatch(HEX, b['mysql'].get('accountsSha256', ''))
         and re.fullmatch(HEX, b['mysql'].get('migrationsSha256', ''))
         and type(b['mysql'].get('accountCount')) is int and type(b['mysql'].get('migrationCount')) is int,
         'DATA_BASELINE_MISSING')
    need(c.get('configurationSha256') == b['configurationSha256']
         and c.get('runtimeConfigurationSha256') == b['runtimeConfigurationSha256']
         and c.get('sourceProjectionSha256') == {'roleSourceProjections': b['roleSourceProjectionsSha256'],
                                                'adminSourceProjection': b['adminSourceProjectionSha256']}
         and c.get('hostSourceInheritance') == {'release': CURRENT_DIRECTORY, 'files': {}}, 'CONFIGURATION_BASELINE_MISSING')
    need(set(c.get('controlHashes', {})) == set(c.get('controlFiles', [])) == set(CONTROL_FILES), 'CONTROL_SCOPE_CHANGED')
    for name, expected in c['controlHashes'].items():
        path = HERE / name
        need(re.fullmatch(r'[a-z0-9.-]+', name) and re.fullmatch(HEX, expected)
             and path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected, 'CONTROL_CHANGED')


def inventory(d, state, prefix, kind='all'):
    if kind == 'engine':
        code = ("const f=require('fs'),c=require('crypto'),p=" + json.dumps(prefix) + ";const rows={};"
                "function walk(r=''){for(const e of f.readdirSync(p+r,{withFileTypes:true})){const n=r?r+'/'+e.name:e.name;"
                "if(n==='upstream/node_modules'||n==='runtime')continue;if(e.isSymbolicLink())throw Error('SOURCE_LINK');"
                "if(e.isDirectory())walk(n);else if(e.isFile())rows[n]=c.createHash('sha256').update(f.readFileSync(p+n)).digest('hex');"
                "else throw Error('SOURCE_KIND')}}walk();console.log(JSON.stringify(rows))")
        return signature(json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=60)))
    need(not d.run('docker', 'exec', state['containerId'], 'find', prefix, '!', '-type', 'f', '!', '-type', 'd', '-print', timeout=60),
         'RUNTIME_FILE_KIND_INVALID')
    names = d.run('docker', 'exec', state['containerId'], 'find', prefix, '-type', 'f', timeout=60).splitlines()
    need(all(n.startswith(prefix) and re.fullmatch(r'[A-Za-z0-9_./-]+', n) and '..' not in Path(n).parts for n in names),
         'RUNTIME_PATH_INVALID')
    names = [n for n in names if '__pycache__' not in Path(n).parts and not n.endswith(('.pyc', '.tsbuildinfo'))]
    if kind == 'worker':
        names = [n for n in names if '/' not in n[len(prefix):] and n.endswith(('.py', '.js', '.css'))]
    elif kind == 'js':
        names = [n for n in names if n.endswith('.js')]
    need(names and len(names) == len(set(names)), 'RUNTIME_FILE_SET_INVALID')
    rows = {}
    for offset in range(0, len(names), 200):
        for line in d.run('docker', 'exec', state['containerId'], 'sha256sum', *names[offset:offset + 200], timeout=60).splitlines():
            value, name = line.split('  ', 1)
            need(re.fullmatch(HEX, value) and name in names, 'RUNTIME_DIGEST_INVALID')
            rows[name[len(prefix):]] = value
    need(len(rows) == len(names), 'RUNTIME_FILE_SET_INVALID')
    return signature(rows)


def sqlite_receipt(d, directory, c, expected_logical=None):
    code = ("import importlib.util,json,sqlite3;from pathlib import Path;"
            "p=Path('/app/" + WORKER + "release_safety.py');s=importlib.util.spec_from_file_location('readonly_safety',p);"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            "db=sqlite3.connect('file:/app/.runtime/auto-registration/database.db?mode=ro',uri=True);"
            "db.execute('PRAGMA query_only=ON');db.execute('BEGIN');v=m.logical_summary(db);"
            "assert db.total_changes==0;db.close();print(json.dumps(v,sort_keys=True))")
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', '/opt/id-registration/venv/bin/python', '-B', '-c', code, timeout=45))
    need(value == c['baseline']['sqlite'] and (expected_logical is None or value['logicalSha256'] == expected_logical),
         'SQLITE_DATA_CHANGED')
    return value


def mysql_receipt(d, directory):
    code = ("const{PrismaClient}=require('@prisma/client'),c=require('crypto'),p=new PrismaClient({log:[]});"
            "(async()=>{const a=await p.idBusinessV2ChatgptAccount.findMany({orderBy:{id:'asc'}});"
            "const m=await p.$queryRawUnsafe('SELECT migration_name,checksum,(finished_at IS NOT NULL) AS finished,'+"
            "'(rolled_back_at IS NOT NULL) AS rolled_back FROM _prisma_migrations ORDER BY migration_name');"
            "const v=m.map(r=>({name:r.migration_name,checksum:r.checksum,finished:Number(r.finished)===1,rolledBack:Number(r.rolled_back)===1}));"
            "console.log(JSON.stringify({accountCount:a.length,accountsSha256:c.createHash('sha256').update(JSON.stringify(a)).digest('hex'),"
            "migrationCount:v.length,migrationsSha256:c.createHash('sha256').update(JSON.stringify(v)).digest('hex')}))"
            "})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());")
    return json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=45))


def runtime(d, states):
    return {'api': inventory(d, states['api'], '/app/apps/api/dist/'),
            'apiJavascript': inventory(d, states['api'], '/app/apps/api/dist/', 'js'),
            'worker': inventory(d, states['api'], '/app/' + WORKER, 'worker'),
            'admin': inventory(d, states['admin'], '/usr/share/nginx/html/'),
            'prisma': inventory(d, states['api'], '/app/node_modules/.prisma/client/'),
            'engine': inventory(d, states['online-recharge'], '/workspace/engine/', 'engine')}


def baseline(d, h, a, finite, c, expected=None):
    previous = (BASE / 'current').resolve()
    need(str(previous) == c['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(digest(raw) == c['manifestSha256'] and manifest['commit'] == CURRENT, 'MANIFEST_CHANGED')
    safety = previous / WORKER / 'release_safety.py'
    need(safety.is_file() and not safety.is_symlink()
         and digest(safety.read_bytes()) == c['baselineWorkerFiles']['release_safety.py'], 'BASE_SAFETY_CHANGED')
    normalizer = Path(c['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and normalizer.is_file() and not normalizer.is_symlink()
         and digest(normalizer.read_bytes()) == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202',
         'BACKUP_NORMALIZER_CHANGED')
    b = c['baseline']
    need(digest(canonical(manifest.get('roleSourceProjections'))) == b['roleSourceProjectionsSha256']
         and digest(canonical(manifest.get('adminSourceProjection'))) == b['adminSourceProjectionSha256'], 'PROJECTION_CHANGED')
    states = h.snapshot(d, previous)
    need(states == b['services'] and runtime(d, states) == b['inventory'], 'RUNTIME_BASELINE_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    need(all(digest((previous / n).read_bytes()) == value for n, value in b['configurationSha256'].items())
         and {role: h.configuration(d, state) for role, state in states.items()} == b['runtimeConfigurationSha256'],
         'CONFIGURATION_CHANGED')
    for name, proof_expected in b['publishedProofs'].items():
        need(digest((previous / name).read_bytes()) == proof_expected['sha256'], 'PUBLISHED_PROOF_CHANGED')
    need(d.run('docker', 'exec', states['api']['containerId'], 'sha256sum',
               '/app/apps/api/prisma-mysql/schema.prisma').split()[0] == b['schemaSha256']
         and d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                   '/etc/nginx/conf.d/default.conf').split()[0] == b['nginxSha256'], 'STATIC_CONFIGURATION_CHANGED')
    h.guards(d, previous, states, c)
    observed = {'sqlite': sqlite_receipt(d, previous, c), 'database': mysql_receipt(d, previous)}
    need(observed['database'] == b['mysql'] and (expected is None or observed == expected), 'DATA_BASELINE_CHANGED')
    return previous, raw, states, observed


def inherited_host_source(c):
    need(c['hostSourceInheritance'] == {'release': c['current'], 'files': {}}, 'HOST_INHERITANCE_CHANGED')
    return Path(c['current'])


def verify_proof(proof, plan, c, payload, h):
    fields = {'version', 'scope', 'commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256',
              'controlSources', 'sources', 'validationSources', 'apiModules', 'apiJavascriptDelta', 'workerFiles',
              'adminFiles', 'baselineInventory', 'afterInventory', 'validation', 'files', 'migrationPerformed', 'businessActions'}
    need(isinstance(proof, dict) and set(proof) == fields and type(proof.get('version')) is int
         and proof['version'] == 1 and proof.get('scope') == SCOPE, 'PROOF_FORMAT_INVALID')
    need(all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == c['sources'] and proof.get('validationSources') == c['validationSources']
         and proof.get('workerFiles') == c['workerFiles'] and proof.get('migrationPerformed') is False
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0
         and proof.get('validation') == {'status': 'PASS', 'api': True, 'admin': True, 'offlineBrowser': True,
                                         'isolatedPersistence': True}, 'PROOF_CHANGED')
    need(proof.get('baselineInventory') == c['baseline']['inventory']
         and proof.get('apiJavascriptDelta') == [] and proof.get('apiModules') == {}, 'COMPILED_SCOPE_CHANGED')
    expected_files = {**{'source/' + n: value for n, value in c['sources'].items()},
                      **{'api/modules/' + n: value for n, value in proof['apiModules'].items()},
                      **{'api/worker/' + n: value for n, value in c['workerFiles'].items()},
                      **{'admin/html/' + n: value for n, value in proof['adminFiles'].items()}}
    need(proof['files'] == expected_files and set(proof['afterInventory']) == set(c['baseline']['inventory'])
         and all(proof['afterInventory'][n] == c['baseline']['inventory'][n]
                 for n in ('api', 'apiJavascript', 'prisma', 'engine'))
         and proof['afterInventory']['worker'] == signature({**c['baselineWorkerFiles'], **c['workerFiles']}), 'PAYLOAD_SCOPE_CHANGED')
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof['files'], 'ARTIFACT_CONTENT_CHANGED')
    return proof


def smoke(d, target, states, c, proof, receipt, h, a, finite):
    before = receipt['before']
    need(all(states[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all(states['online-recharge'][n] == before['online-recharge'][n] for n in ('image', 'reference', 'environmentSha256')),
         'SIDECAR_CHANGED')
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == c['baseline']['runtimeConfigurationSha256'],
         'RUNTIME_CONFIGURATION_CHANGED')
    observed = runtime(d, states)
    need(observed == proof['afterInventory'] and observed['prisma'] == c['baseline']['inventory']['prisma']
         and observed['engine'] == c['baseline']['inventory']['engine']
         and observed['apiJavascript'] == c['baseline']['inventory']['apiJavascript'], 'PUBLISHED_CONTENT_CHANGED')
    need(mysql_receipt(d, target) == receipt['database'] and sqlite_receipt(d, target, c) == receipt['sqlite'], 'BUSINESS_DATA_CHANGED')
    need(d.run('docker', 'exec', states['api']['containerId'], 'sha256sum',
               '/app/apps/api/prisma-mysql/schema.prisma').split()[0] == c['baseline']['schemaSha256']
         and d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
                   '/etc/nginx/conf.d/default.conf').split()[0] == c['baseline']['nginxSha256'], 'STATIC_CONFIGURATION_CHANGED')
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)
    request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(2 * 1024**2)
    need(digest(raw) == proof['adminFiles']['index.html'] and ('v2-' + plan_commit(proof)).encode() in raw, 'PUBLIC_ADMIN_CHANGED')


def plan_commit(proof):
    value = proof['commit']
    need(re.fullmatch(r'[a-f0-9]{40}', value), 'COMMIT_INVALID')
    return value


def rename_code(code):
    values = tuple(rename_code(v) if isinstance(v, types.CodeType) else
                   v.replace('registration-parity-diagnostics', NAME) if isinstance(v, str) else v
                   for v in code.co_consts)
    return code.replace(co_consts=values)


def worker_only_release_code(original):
    source = inspect.getsource(original)
    old = "('api', " + repr('COPY modules/ /app/apps/api/dist/\nCOPY worker/ /app/') + " + WORKER + " + repr('\n') + ", 2)"
    new = "('api', " + repr('COPY worker/ /app/') + " + WORKER + " + repr('\n') + ", 1)"
    need(source.count(old) == 1, 'OVERLAY_RECIPE_CHANGED')
    compiled = compile(source.replace(old, new), original.__code__.co_filename, 'exec')
    functions = [value for value in compiled.co_consts if isinstance(value, types.CodeType)]
    need(len(functions) == 1 and functions[0].co_name == 'release', 'OVERLAY_FUNCTION_CHANGED')
    return rename_code(functions[0])


def release(plan, c, d=None, h=None):
    verify_contract(c)
    c = {**c, 'reviewedApplicationCommit': plan['commit']}
    old = helper('registration-parity-diagnostics-release.py')
    def release_helper(name):
        value = helper(name)
        if name == 'proxy-result-identity-release.py':
            value.SCOPE = SCOPE
        return value
    namespace = {**old.__dict__, 'SCOPE': SCOPE, 'CURRENT': CURRENT, 'PRESERVED': PRESERVED,
                 'need': need, 'helper': release_helper,
                 'verify_contract': verify_contract, 'verify_proof': verify_proof, 'baseline': baseline,
                 'smoke': smoke, 'sqlite_receipt': sqlite_receipt, 'inherited_host_source': inherited_host_source}
    namespace['backup_sqlite'] = types.FunctionType(old.backup_sqlite.__code__, namespace)
    adapted = types.FunctionType(worker_only_release_code(old.release), namespace)
    h = h or helper('recharge-record-release.py')
    d = d or h.load_utilities(HERE / 'remote-deploy.py', c['controlHashes']['remote-deploy.py'])
    return adapted(plan, c, d, h)
