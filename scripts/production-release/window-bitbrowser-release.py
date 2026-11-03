"""Finite publication adapter: reuse the existing locked migration/image/readback protocol."""
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'window-bitbrowser'
CONTRACT_FILE = PREFIX + '-contract.json'
SCOPE = 'BUSINESS_DISPLAY_BITBROWSER_20261103'
MIGRATION = '20261102150000_online_recharge_bitbrowser'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED_CLIENT = ('runtime/edge-esm.js', 'runtime/edge.js', 'runtime/index-browser.d.ts', 'runtime/index-browser.js', 'runtime/library.d.ts', 'runtime/library.js', 'runtime/react-native.js', 'runtime/wasm-compiler-edge.js', 'runtime/wasm-engine-edge.js')



def load(name):
    spec = importlib.util.spec_from_file_location('window_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def need(value, code):
    if not value:
        raise RuntimeError('WINDOW_BITBROWSER_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def validate(c):
    need(c['scope'] == SCOPE and c['version'] == 1 and c['expectedCurrent'] == c['reviewBase']
         and c['updatedServices'] == list(UPDATED)
         and c['migration']['name'] == MIGRATION
         and c['migration']['sha256'] == c['sources'][c['migration']['path']]
         and c['businessActions'] == 0, 'CONTRACT')
    need(all(re.fullmatch('[a-f0-9]{64}', value) for value in c['sources'].values()), 'SOURCE_DIGEST')
    need(all(name.startswith(('apps/admin/src/v2/', 'apps/admin/src/auth/', 'apps/api/src/id-business-v2/', 'apps/api/src/v2-auth/', 'apps/api/prisma-mysql/')) and '..' not in Path(name).parts for name in c['sources']), 'SOURCE_PATH')
    need(all('/migrations/' not in name or name == c['migration']['path'] for name in c['sources']), 'MIGRATION_SCOPE')
    need(set(c['preservedPrismaClientFiles']) == set(PRESERVED_CLIENT)
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in c['preservedPrismaClientFiles'].values()), 'PRESERVED_CLIENT_SCOPE')
    for name, digest in c['helperPins'].items():
        need(re.fullmatch('[a-z][a-z0-9.-]+', name) and sha((HERE / name).read_bytes()) == digest, 'HELPER_CHANGED')


def db_state(d, directory, database=None):
    database = database or d.current_job_database(directory)
    need(re.fullmatch('[A-Za-z0-9_]+', database), 'DATABASE_TARGET')
    sql = ("SELECT JSON_OBJECT('pending',(SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),"
           "'applied',(SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='" + MIGRATION + "' AND finished_at IS NOT NULL AND rolled_back_at IS NULL),"
           "'checksum',(SELECT checksum FROM _prisma_migrations WHERE migration_name='" + MIGRATION + "' LIMIT 1),"
           "'tables',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('online_recharge_bitbrowser_devices','online_recharge_bitbrowser_states')));\n")
    return json.loads(d.compose(directory, 'exec', '-T', '-e', 'MYSQL_DATABASE=' + database, 'mysql',
        'sh', '-c', 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --batch --skip-column-names -u root "$MYSQL_DATABASE"', input_data=sql))


def verify_db(state, c, applied=False):
    need(state == {'pending': 0, 'applied': int(applied),
        'checksum': c['migration']['sha256'] if applied else None, 'tables': 2 if applied else 0}, 'DATABASE_STATE')


def utilities():
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, _ = history.helpers()
    return h, d


def parent_admin_files(raw, manifest, c):
    pin = c['baselineAdminProof']
    need(pin['file'] == 'permission-loading-build-proof.json'
         and sha(raw) == pin['sha256']
         and manifest['roleSourceProjections']['admin']['buildProofSha256'] == pin['sha256'], 'ADMIN_PARENT_PROOF_CHANGED')
    proof = json.loads(raw)
    files = proof['adminFiles']
    need(proof['commit'] == c['expectedCurrent'] and proof['businessActions'] == 0
         and type(files) is dict and 'index.html' in files
         and len(files) == pin['fileCount']
         and all(not Path(n).is_absolute() and '..' not in Path(n).parts
                 and re.fullmatch('[a-f0-9]{64}', value) for n, value in files.items())
         and sha(canonical(files)) == pin['filesSha256'], 'ADMIN_PARENT_INVENTORY_CHANGED')
    return files


def capture(d, h, c):
    current = (BASE / 'current').resolve(strict=True)
    manifest = json.loads((current / 'release-manifest.json').read_bytes())
    need(current.parent == BASE / 'releases' and manifest['commit'] == c['expectedCurrent']
         and manifest['status'] == 'DEPLOYED', 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    need(set(states) == set(c['preservedServices']) | set(UPDATED), 'SERVICE_SCOPE')
    need(all(states[n]['image'] == manifest['images'][n]['digest'] for n in UPDATED), 'IMAGE_IDENTITY')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, current, states, c)
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    runtime = history.runtime(d, states)
    code = r"""const fs=require('fs'),path=require('path'),c=require('crypto');const groups={};
function walk(p,n=''){for(const e of fs.readdirSync(p,{withFileTypes:true})){const name=n?n+'/'+e.name:e.name,full=path.join(p,e.name);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(full,name);else if(e.isFile()&&name.endsWith('.js')){const g=name.split('/').slice(0,name.startsWith('id-business-v2/')?2:1).join('/');(groups[g]??={})[name]=c.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}}}
walk('/app/apps/api/dist');const sorted=x=>Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0));console.log(JSON.stringify(Object.fromEntries(Object.entries(groups).map(([n,v])=>[n,c.createHash('sha256').update(JSON.stringify(sorted(v))).digest('hex')]))));"""
    groups = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code))
    schema = d.run('docker', 'exec', states['api']['containerId'], 'sha256sum', '/app/node_modules/.prisma/client/schema.prisma').split()[0]
    engine = d.run('docker', 'exec', states['online-recharge']['containerId'], 'sha256sum', '/workspace/engine/credentials.cjs').split()[0]
    client_code = r"""const fs=require('fs'),path=require('path'),crypto=require('crypto');const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});const g=p._engineConfig.generator,suffix='/apps/api/prisma-mysql/schema.prisma';
if(!g.sourceFilePath.endsWith(suffix))throw Error('CLIENT_SCHEMA_PATH');const root=g.sourceFilePath.slice(0,-suffix.length);if(![root+'/node_modules/@prisma/client',root+'/node_modules/.prisma/client'].includes(g.output.value))throw Error('CLIENT_OUTPUT_PATH');
const files={};function walk(dir,n=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const name=n?n+'/'+e.name:e.name,full=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(full,name);else if(e.isFile())files[name]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');else throw Error('KIND');}}walk('/app/node_modules/.prisma/client');console.log(JSON.stringify({root,files}));p.$disconnect();"""
    client = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', client_code))
    need({'count': len(client['files']), 'sha256': sha(canonical(client['files']))} == runtime['clientInventory'], 'CLIENT_CAPTURE_CHANGED')
    need(all(client['files'].get(n) == v for n, v in c['preservedPrismaClientFiles'].items()), 'PRESERVED_CLIENT_CHANGED')
    proof_path = current / c['baselineAdminProof']['file']
    need(not proof_path.is_symlink(), 'ADMIN_PARENT_PROOF_LINK')
    admin_files = parent_admin_files(proof_path.read_bytes(), manifest, c)
    # COPY-based parent images retain old hashed assets. Verify the current entry's
    # exact published files, while runtime.adminInventory still protects the full image.
    load('shared-bank-card-release.py').read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', admin_files)
    names = ('.env.aws.production', 'docker-compose.aws-mysql.yml', 'compose.release.json', 'deploy/caddy/Caddyfile.aws', 'apps/api/prisma-mysql/schema.prisma')
    verify_db(db_state(d, current), c)
    return {'current': str(current), 'expectedCurrent': manifest['commit'], 'manifestSha256': sha((current / 'release-manifest.json').read_bytes()),
        'services': states, 'configurationSha256': {n: sha((current / n).read_bytes()) for n in names},
        'runtime': runtime, 'clientFiles': client['files'], 'clientGenerationRoot': client['root'], 'preservedClientFiles': c['preservedPrismaClientFiles'], 'apiGroups': {'schema': schema, 'groups': groups},
        'adminFilesSha256': sha(canonical(admin_files)), 'nginxSha256': runtime['nginxSha256'], 'engineCredentialsSha256': engine}


def baseline(d, h, c):
    observed = capture(d, h, c)
    need(observed == c['baseline'], 'PARENT_CHANGED')
    config = json.loads(d.compose(Path(observed['current']), 'config', '--format', 'json'))
    api = urlsplit(config['services']['api']['environment']['DATABASE_URL'])
    migration = urlsplit(config['services']['migrate']['environment']['DATABASE_URL'])
    need(api.scheme == 'mysql' and api.hostname == 'mysql' and migration.username and migration.password
         and (api.scheme, api.hostname, api.port or 3306, api.path) == (migration.scheme, migration.hostname, migration.port or 3306, migration.path), 'MIGRATION_TARGET')
    need(re.fullmatch('[A-Za-z0-9_]+', api.username or ''), 'API_DATABASE_USER')
    role_sql = "SELECT COUNT(*) FROM mysql.user WHERE User='" + api.username + "' AND Host='%';\n"
    role_count = d.compose(Path(observed['current']), 'exec', '-T', 'mysql', 'sh', '-c', 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --batch --skip-column-names -u root', input_data=role_sql)
    need(role_count.strip() == '1', 'API_DATABASE_ROLE_CHANGED')
    current = Path(observed['current'])
    return current, (current / 'release-manifest.json').read_bytes(), observed['services']


def verify_proof(proof, plan, c, files):
    need(all(proof[k] == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256'))
         and proof['scope'] == SCOPE and proof['sources'] == c['sources'] and proof['businessActions'] == 0
         and proof['nativeParentCapture'] == plan['nativeParentCapture']
         and proof['baselineApiGroups'] == c['baseline']['apiGroups']['groups']
         and sha(canonical(proof['baselineAdminFiles'])) == c['baseline']['adminFilesSha256'], 'BUILD_IDENTITY')
    expected_modules = {n.removeprefix('apps/api/src/').removesuffix('.ts') + ext for n in c['sources']
        if n.startswith('apps/api/src/') and n.endswith('.ts') and not n.endswith('.spec.ts') for ext in ('.js', '.js.map', '.d.ts')}
    need(expected_modules <= set(proof['apiModules']) and all(n in expected_modules or n.endswith('.d.ts') for n in proof['apiModules']), 'MODULE_SCOPE')
    need(proof['preservedClientFiles'] == c['baseline']['preservedClientFiles']
         and set(proof['prismaClientFiles']) == set(c['baseline']['clientFiles']) - set(proof['preservedClientFiles']), 'CLIENT_FILE_SCOPE')
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
        **{'api/prisma-client/' + n: v for n, v in proof['prismaClientFiles'].items()},
        **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
        **{'source/' + n: v for n, v in c['sources'].items()},
        **{'controls/' + n: v for n, v in proof['controlSources'].items()},
        **{'online-recharge/engine/' + n: c['sources']['apps/api/src/id-business-v2/online-recharge/engine/' + n]
           for n in ('credentials.cjs', 'SOURCE_MANIFEST.json')}}
    need(files == proof['files'] == expected and proof['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes()), 'PAYLOAD_SCOPE')
    verify_migration_transport(proof)
    return proof


def verify_migration_transport(proof):
    value = proof['migrationTransport']
    expected = ('098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:'
                + proof['commit'] + '-' + proof['workflowRunId'] + '-window-bitbrowser-migrate')
    need(set(value) == {'file', 'sha256', 'bytes', 'imageId', 'reference'}
         and value['file'] == PREFIX + '-migration.tar.gz'
         and type(value['bytes']) is int and 0 < value['bytes'] <= 512 * 1024**2
         and re.fullmatch('[a-f0-9]{64}', value['sha256'])
         and re.fullmatch('sha256:[a-f0-9]{64}', value['imageId'])
         and value['reference'] == expected, 'MIGRATION_TRANSPORT_SCOPE')
    return value


def migrate(d, target, c, journal, database):
    driver = load('recharge-plan-billing-release.py')
    driver.db_state, driver.verify_db = db_state, verify_db
    driver.migrate(d, target, c, journal, database)
    config = json.loads(d.compose(target, 'config', '--format', 'json'))
    user = urlsplit(config['services']['api']['environment']['DATABASE_URL']).username
    need(re.fullmatch('[A-Za-z0-9_]+', user or ''), 'API_DATABASE_USER')
    # Only the new tables receive the API's existing read/insert/update capability.
    sql = ''.join("GRANT SELECT, INSERT, UPDATE ON `" + database + "`.`" + name + "` TO '" + user + "'@'%';\n"
        for name in ('online_recharge_bitbrowser_devices', 'online_recharge_bitbrowser_states'))
    d.compose(target, 'exec', '-T', '-e', 'MYSQL_DATABASE=' + database, 'mysql', 'sh', '-c',
        'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --batch --skip-column-names -u root "$MYSQL_DATABASE"', input_data=sql)


class ClientProbeFailed(RuntimeError):
    def __init__(self, kind, result):
        words = frozenset(('docker error response from daemon max depth failed failure cannot can not could unable create start run container process task shim runtime runc exec executable node image network none bridge endpoint port memory allocate available unavailable resource temporarily no space left device file directory system read only invalid argument configuration mount mounts cgroup cgroups pid pids limit exceeded maximum reached disk inode inodes permission denied operation permitted supported unsupported unknown shorthand flag pull healthcheck conflict name already use specified missing found command format formaterror too many open files driver overlay overlay2 initialization init path volume volumes default apparmor profile seccomp security option options namespace namespaces user root node binary loading load library shared libraries interpreter exiting exit status code allocation cap capabilities locked database environment variable entrypoint checkpoint ipv4 ipv6 address pool sandbox connect connection refused timeout timed out oom killed stat mkdir write read sys fs proc dev null insufficient buffer size ulimit threads fork clone thread version api client server requires require newer older minimum maximum windows linux platform architecture amd64 arm64 is are the a an and or to for of on in with by as this that it has have be been was were do does did at detected enabled disabled configure configured unexpected response request requesterror daemonerror message fatal panic warning unsupportedtransport key value malformed valid usage help more information see seealso return returned unsupported never false true busy').split())
        def safe(text):
            return [word if word in words else '[hidden]' for word in re.findall(r'[a-zA-Z]+', text.lower())[:160]]
        self.diagnostic = {'exitCode': result.returncode, 'stderrWords': safe(result.stderr), 'stdoutWords': safe(result.stdout)}
        super().__init__('WINDOW_BITBROWSER_CLIENT_PROBE_' + kind)


def client_probe(d, reference, code, legacy=False):
    image = json.loads(d.run('docker', 'image', 'inspect', reference))[0]['Id']
    need(re.fullmatch('sha256:[a-f0-9]{64}', image), 'CLIENT_PROBE_IMAGE_ID')
    args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', image, '-e', code]
    if legacy:
        args[2:2] = ['--pull=never', '--no-healthcheck']
    result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    if result.returncode:
        text = result.stderr.lower()
        categories = [('max depth exceeded', 'MAX_DEPTH_EXCEEDED'), ('unknown flag', 'FLAG_UNSUPPORTED'), ('flag provided but not defined', 'FLAG_UNSUPPORTED'),
            ('permission denied', 'PERMISSION_DENIED'), ('operation not permitted', 'OPERATION_NOT_PERMITTED'),
            ('read-only file system', 'READ_ONLY_FILESYSTEM'), ('cannot find module', 'NODE_MODULE_NOT_FOUND'),
            ('syntaxerror', 'NODE_SYNTAX'), ('exec format error', 'EXEC_FORMAT'),
            ('invalid reference format', 'IMAGE_REFERENCE'), ('no such file or directory', 'FILE_MISSING'),
            ('oci runtime', 'OCI_START_FAILED'), ('unable to find image', 'IMAGE_MISSING')]
        kind = next((kind for marker, kind in categories if marker in text), 'EXIT_' + str(abs(result.returncode)))
        raise ClientProbeFailed(kind, result)
    value = json.loads(result.stdout)
    need(type(value) is dict, 'CLIENT_PROBE_FORMAT')
    return value


def verify_client_image(d, reference, proof):
    expected = {**proof['prismaClientFiles'], **proof['preservedClientFiles']}
    code = r"""const fs=require('fs'),path=require('path'),crypto=require('crypto');const files={};function walk(p,n=''){for(const e of fs.readdirSync(p,{withFileTypes:true})){const name=n?n+'/'+e.name:e.name,full=path.join(p,e.name);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(full,name);else if(e.isFile())files[name]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');else throw Error('KIND');}}walk('/app/node_modules/.prisma/client');const{Prisma}=require('/app/node_modules/@prisma/client');if(!['OnlineRechargeBitbrowserDevice','OnlineRechargeBitbrowserState'].every(n=>Prisma.dmmf.datamodel.models.some(m=>m.name===n)))throw Error('CLIENT_MODELS');console.log(JSON.stringify(files));"""
    actual = client_probe(d, reference, code)
    need(actual == expected, 'PRISMA_IMAGE_CONTENT_CHANGED')


def smoke(d, h, target, states, proof, c):
    shared = load('shared-bank-card-release.py')
    for role, directory, files in [('api', '/app/apps/api/dist/', proof['apiModules']),
            ('api', '/app/node_modules/.prisma/client/', {**proof['prismaClientFiles'], **proof['preservedClientFiles']}),
            ('admin', '/usr/share/nginx/html/', proof['adminFiles']),
            ('online-recharge', '/workspace/engine/', {n: c['sources']['apps/api/src/id-business-v2/online-recharge/engine/' + n] for n in ('credentials.cjs', 'SOURCE_MANIFEST.json')})]:
        shared.read_hashes(d, states[role]['containerId'], directory, files)
    verify_db(db_state(d, target), c, True)
    code = """const{Prisma,PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});const b=require('/app/apps/api/dist/id-business-v2/online-recharge/bitbrowser-policy.js');
(async()=>{await p.$queryRawUnsafe('SELECT id FROM online_recharge_bitbrowser_devices LIMIT 0');await p.$queryRawUnsafe('SELECT task_id FROM online_recharge_bitbrowser_states LIMIT 0');console.log(JSON.stringify({device:Prisma.dmmf.datamodel.models.some(m=>m.name==='OnlineRechargeBitbrowserDevice'),state:Prisma.dmmf.datamodel.models.some(m=>m.name==='OnlineRechargeBitbrowserState'),policy:typeof b.validateBitbrowserQuote==='function',readGrants:true}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());"""
    need(json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code)) == {'device': True, 'state': True, 'policy': True, 'readGrants': True}, 'MODULE_SMOKE')
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == c['baseline']['nginxSha256'], 'NGINX_CHANGED')
    h.guards(d, target, states, c)
    import urllib.request
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        html = response.read(2 * 1024**2)
    need(sha(html) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in html, 'PUBLIC_VERSION')


def single_api_layer(payload):
    root = payload / 'api/rootfs'
    need(not root.exists(), 'API_SINGLE_LAYER_EXISTS')
    for source, target in [('modules', 'app/apps/api/dist'), ('prisma-client', 'app/node_modules/.prisma/client')]:
        shutil.copytree(payload / 'api' / source, root / target)


def configured_release(c):
    driver = load('recharge-plan-billing-release.py')
    driver.PREFIX, driver.CONTRACT, driver.SCOPE = PREFIX, CONTRACT_FILE, SCOPE
    original_load = driver.load
    def current_helpers(name):
        helper = original_load(name)
        if name == 'recharge-record-release.py':
            retired = load('online-query-network-release.py')
            helper.guards = lambda d, directory, states, selected: retired.retired_guards(d, directory, states, selected, helper)
        return helper
    driver.load = current_helpers
    driver.baseline, driver.db_state, driver.verify_db = baseline, db_state, verify_db
    driver.validate_proof, driver.smoke, driver.migrate = verify_proof, smoke, migrate
    driver.verify_migration_transport = verify_migration_transport
    # Keep the existing lock, SQL fence, migration journal and no-post-SQL-rollback behavior.
    source = inspect.getsource(driver.release)
    changes = {
        "        models = {n: h.configuration(d, before[n])": "        single_api_layer(payload)\n        models = {n: h.configuration(d, before[n])",
        "'COPY modules/ /app/apps/api/dist/\\nCOPY prisma-client/ /app/node_modules/.prisma/client/\\n'": "'COPY rootfs/ /\\n'",
        "c = json.loads((HERE / CONTRACT).read_bytes())": "c = WINDOW_CONTRACT",
        "('admin', 'COPY html/ /usr/share/nginx/html/\\n')": "('admin', 'COPY html/ /usr/share/nginx/html/\\n'), ('online-recharge', 'COPY engine/ /workspace/engine/\\n')",
        "and after['online-recharge']['image'] == before['online-recharge']['image']": "and after['online-recharge']['image'] == images['online-recharge']['imageId']",
        "servicesUpdated=['api', 'admin']": "servicesUpdated=['api', 'admin', 'online-recharge']",
        'migration_reference = load_migration_image(d, proof, plan, stage)': "migration_reference = load_migration_image(d, proof, plan, stage)\n        verify_client_image(d, images['api']['reference'], proof)",
        'fence.acquire()': "load('dependency-security-runtime.py').latest_main(plan['commit']); fence.acquire()",
        '            sql_started = True': "            load('dependency-security-runtime.py').latest_main(plan['commit'])\n            sql_started = True"
    }
    for before, after in changes.items():
        need(source.count(before) == 1, 'INHERITED_RECIPE_CHANGED')
        source = source.replace(before, after)
    values = {**driver.__dict__, 'WINDOW_CONTRACT': c, 'verify_client_image': verify_client_image, 'single_api_layer': single_api_layer}
    exec(compile(source, '<window-bitbrowser-runtime>', 'exec'), values)
    return values['release']


def probe_resources():
    disk = os.statvfs(BASE)
    memory = dict(re.findall(r'^(MemAvailable|MemTotal):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M))
    return {'freeBytes': disk.f_bavail * disk.f_frsize, 'freeInodes': disk.f_favail,
        **{k + 'KiB': int(v) for k, v in memory.items()}}


def diagnose(c):
    pin = c['failedPublicationDiagnostic']
    need(set(pin) == {'commit', 'workflowRunId', 'buildProofSha256', 'acceptedCommandId'}
         and re.fullmatch('[a-f0-9]{40}', pin['commit']) and re.fullmatch('[1-9][0-9]*', pin['workflowRunId'])
         and re.fullmatch('[a-f0-9]{64}', pin['buildProofSha256']), 'DIAGNOSTIC_BINDING')
    stage = BASE / '.staging' / (PREFIX + '-' + pin['commit'] + '-' + pin['workflowRunId'])
    need((stage / 'content/payload/build-proof.json').is_file() and not (stage / 'content/payload/build-proof.json').is_symlink(), 'DIAGNOSTIC_PROOF_MISSING')
    raw = (stage / 'content/payload/build-proof.json').read_bytes()
    need(sha(raw) == pin['buildProofSha256'], 'DIAGNOSTIC_PROOF_CHANGED')
    proof = json.loads(raw)
    need(proof['commit'] == pin['commit'] and proof['workflowRunId'] == pin['workflowRunId']
         and proof['scope'] == c['scope'] and proof['sources'] == c['sources']
         and proof['businessActions'] == 0, 'DIAGNOSTIC_PRODUCER_CHANGED')
    transport = verify_migration_transport(proof)
    result = {'status': 'WINDOW_BITBROWSER_FAILED_PUBLICATION_DIAGNOSED', 'originalCommit': pin['commit'],
        'originalCommandId': pin['acceptedCommandId'], 'businessActions': 0, 'complete': False}
    phase = 'utilities'
    def bounded(error):
        message = str(error)
        return {'exceptionType': type(error).__name__,
            'code': message if re.fullmatch('[A-Z0-9_]{1,180}', message) else 'DETAIL_SUPPRESSED',
            **({'probe': error.diagnostic} if isinstance(error, ClientProbeFailed) else {})}
    try:
        h, d = utilities()
        phase = 'current-manifest'
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'DIAGNOSTIC_CURRENT_PATH')
        manifest = json.loads((current / 'release-manifest.json').read_bytes())
        result.update(currentCommit=manifest['commit'], maintenancePresent=(BASE / 'maintenance.json').exists())
        phase = 'migration-state'
        result['migration'] = db_state(d, current)
        phase = 'stage-journals'
        result['journals'] = {}
        for name in ('switch-state.json', 'migration-operation.json'):
            path = stage / name
            value = json.loads(path.read_bytes()) if path.is_file() else {}
            result['journals'][name] = {k: value[k] for k in ('status', 'phase', 'code', 'sqlStarted', 'automaticRollback') if k in value}
        result['imageBuilds'] = {}
        for role in UPDATED:
            path = stage / (role + '-image-build.json')
            value = json.loads(path.read_bytes()) if path.is_file() else {}
            result['imageBuilds'][role] = {k: value[k] for k in ('status', 'failureKind', 'exceptionType', 'reference') if k in value}
        def image(reference):
            try:
                return json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            except Exception as error:
                return {'diagnosticError': bounded(error)}
        phase = 'candidate-image'
        reference = 'id-business-v2-billing-plan:' + pin['commit'] + '-' + pin['workflowRunId'] + '-api'
        api = image(reference)
        result['apiImage'] = ({'id': api['Id'], 'user': api['Config'].get('User'), 'workingDir': api['Config'].get('WorkingDir'), 'layerCount': len(api['RootFS']['Layers'])}
            if 'Id' in api else api)
        phase = 'parent-image'
        parent_image = proof['nativeParentCapture']['baseline']['services']['api']['image']
        parent = image(parent_image)
        result['apiParentImage'] = {'id': parent['Id'], 'layerCount': len(parent['RootFS']['Layers'])} if 'Id' in parent else parent
        phase = 'migration-image'
        migration = image(transport['reference'])
        result['migrationImage'] = ({'identityMatches': migration['Id'] == transport['imageId']} if 'Id' in migration else migration)
        phase = 'candidate-client'
        result['probeHostResources'] = probe_resources()
        code = r"""const fs=require('fs'),path=require('path'),crypto=require('crypto');const out={files:{}};
    try{function walk(p,n=''){for(const e of fs.readdirSync(p,{withFileTypes:true})){const name=n?n+'/'+e.name:e.name,full=path.join(p,e.name);if(e.isDirectory())walk(full,name);else if(e.isFile())out.files[name]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}}walk('/app/node_modules/.prisma/client');}catch(e){out.filesError={name:e.name,code:e.code};}
    function probe(name){try{const p=require(name);return{ok:true,resolved:require.resolve(name),clientVersion:p.Prisma?.prismaVersion?.client,device:p.Prisma?.dmmf?.datamodel?.models?.some(m=>m.name==='OnlineRechargeBitbrowserDevice')===true,state:p.Prisma?.dmmf?.datamodel?.models?.some(m=>m.name==='OnlineRechargeBitbrowserState')===true};}catch(e){const m=/Cannot find module ['"]([^'"]+)['"]/.exec(e.message||'');return{ok:false,name:e.name,code:e.code,missingModule:m&&/^[@a-zA-Z0-9._/-]+$/.test(m[1])?m[1]:null};}}
    out.bare=probe('@prisma/client');out.absolute=probe('/app/node_modules/@prisma/client');console.log(JSON.stringify(out));"""
        if 'Id' in api:
            try:
                client_probe(d, reference, code, legacy=True)
                result['legacyClientProbe'] = {'ok': True}
            except Exception as error:
                result['legacyClientProbe'] = bounded(error)
            probe = client_probe(d, reference, code)
            expected = {**proof['prismaClientFiles'], **proof['preservedClientFiles']}
            files = probe.pop('files', {})
            probe['filesMatch'] = files == expected
            probe['differingFiles'] = sorted(n for n in files.keys() | expected.keys() if files.get(n) != expected.get(n))
            result['clientProbe'] = probe
        result['complete'] = True
    except Exception as error:
        result['diagnosticError'] = {'stage': phase, **bounded(error)}
    return result


def release(plan, c):
    validate(c)
    if plan['mode'] == 'diagnose':
        with (BASE / '.deploy.lock').open('a') as lock:
            load('recharge-availability-release.py').acquire_release_lock(lock)
            return diagnose(c)
    if plan['mode'] == 'capture':
        h, d = utilities()
        with (BASE / '.deploy.lock').open('a') as lock:
            load('recharge-availability-release.py').acquire_release_lock(lock)
            return {'status': 'WINDOW_BITBROWSER_PARENT_VERIFIED', 'baseline': capture(d, h, c), 'businessActions': 0}
    need(plan['nativeParentCapture']['status'] == 'WINDOW_BITBROWSER_PARENT_VERIFIED', 'CAPTURE_REQUIRED')
    c = {**c, 'baseline': plan['nativeParentCapture']['baseline']}
    return configured_release(c)(plan)
