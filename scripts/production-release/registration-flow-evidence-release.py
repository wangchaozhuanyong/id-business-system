"""Forward-only API/Admin overlay; preserve schema/client, engine and all business rows."""
import copy
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import types
import urllib.request

BASE = Path('/opt/id-business-v2')
SCOPE = 'REGISTRATION_FLOW_EVIDENCE'
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_FLOW_EVIDENCE_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def helper(name):
    spec = importlib.util.spec_from_file_location('flow_release_' + name.replace('-', '_'), Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive(raw, destination):
    need(not destination.exists(), 'ARTIFACT_OUTPUT_EXISTS')
    destination.mkdir(mode=0o700)
    names, total = set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw)) as source:
        for item in source.getmembers():
            parts = Path(item.name).parts
            total += item.size
            need(parts and parts[0] == 'payload' and not item.name.startswith('/') and '..' not in parts
                 and item.name not in names and (item.isdir() or item.isfile())
                 and item.size <= 8 * 1024**2 and total <= 64 * 1024**2, 'ARTIFACT_PATH_INVALID')
            names.add(item.name)
            path = destination / item.name
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(source.extractfile(item).read())
    return destination / 'payload'


def verify_proof(proof, plan, contract, payload, h):
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == contract['sources'] and proof.get('validationSources') == contract['validationSources']
         and proof.get('sourceBaseline') == contract['sourceBaseline']
         and proof.get('sourceBaselineTree') == contract['sourceBaselineTree']
         and proof.get('runtimeBaselineCommit') == contract['expectedCurrent']
         and proof.get('roleSourceCommits') == contract['roleSourceCommits']
         and proof.get('reviewedApplicationCommit') == contract['reviewedApplicationCommit']
         and proof.get('sourceProjection') == 'PUBLISHED_RUNTIME_PLUS_TASK_DELTA'
         and proof.get('workerFiles') == contract['workerFiles']
         and proof.get('baselinePrismaClientFiles') == contract['baselinePrismaClientFiles']
         and proof.get('runtimePrismaClientFiles') == contract['runtimePrismaClientFiles']
         and proof.get('publishedAdminProofSha256') == contract['publishedAdminProof']['sha256']
         and proof.get('hostSourceInheritance') == contract['hostSourceInheritance']
         and proof.get('sqliteReviewPolicy') == contract['sqliteReviewPolicy']
         and proof.get('prismaPathMetadata') == contract['prismaPathMetadata']
         and proof.get('baselineEngineFiles') == contract['baselineEngineFiles']
         and proof.get('schemaSha256') == contract['schemaSha256']
         and all(proof.get(n) is True for n in ('baselineApiReproduced', 'baselineAdminReproduced', 'unchangedClientReproduced'))
         and proof.get('registrationNative') == contract['registrationNative'] and proof.get('identityNative') == contract['identityNative']
         and proof.get('updatedServices') == ['api', 'admin'] and proof.get('reboundServices') == ['online-recharge']
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0, 'PROOF_INVALID')
    allowed = {name.removesuffix('.js') + suffix for name in contract['apiModules'] for suffix in ('.js', '.js.map', '.d.ts')}
    need(proof['apiModules'] and set(proof['apiModules']) <= allowed and len(proof['adminFiles']) > 200,
         'COMPILED_SCOPE_CHANGED')
    expected = {**{'source/' + n: value for n, value in contract['sources'].items()},
                **{'api/modules/' + n: value for n, value in proof['apiModules'].items()},
                **{'api/worker/' + n: value for n, value in contract['workerFiles'].items()},
                **{'admin/html/' + n: value for n, value in proof['adminFiles'].items()}}
    files = h.file_inventory(payload)
    files.pop('build-proof.json', None)
    need(files == expected == proof.get('files'), 'PAYLOAD_SCOPE_CHANGED')
    need(proof.get('validation') == {'scope': SCOPE, 'sources': contract['sources'],
         'validationSources': contract['validationSources'], 'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'},
         'VALIDATION_RECEIPT_CHANGED')
    return proof


def api_inventory(d, state, prefix, expected, *, javascript_only=False):
    # Hash only runtime source; values and credentials never leave the process.
    code = """const f=require('fs'),c=require('crypto'),p=PREFIX,rows={};function walk(r=''){for(const e of f.readdirSync(p+r,{withFileTypes:true})){const n=r?`${r}/${e.name}`:e.name;if(e.isSymbolicLink())throw Error('SOURCE_LINK');if(e.isDirectory())walk(n);else if(e.isFile()&&(!JS_ONLY||n.endsWith('.js')))rows[n]=c.createHash('sha256').update(f.readFileSync(p+n)).digest('hex');}}walk();console.log(JSON.stringify(rows));""".replace('PREFIX', json.dumps(prefix)).replace('JS_ONLY', 'true' if javascript_only else 'false')
    need(json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=60)) == expected,
         'API_RUNTIME_INVENTORY_CHANGED')


def worker_inventory(d, state, expected):
    code = "const f=require('fs'),c=require('crypto'),p='/app/" + WORKER + "';console.log(JSON.stringify(Object.fromEntries(f.readdirSync(p).filter(n=>/\\.(py|js|css)$/.test(n)).sort().map(n=>[n,c.createHash('sha256').update(f.readFileSync(p+n)).digest('hex')]))))"
    need(json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code)) == expected, 'WORKER_RUNTIME_CHANGED')


def unchanged_schema(d, directory, contract):
    source = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/app/apps/api/prisma-mysql/schema.prisma')).digest('hex'))"
    need(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source) == contract['schemaSha256'], 'SCHEMA_CHANGED')


def inherited_host_source(contract):
    source = contract['hostSourceInheritance']
    path = Path(source['release'])
    need(path.parent == BASE / 'releases' and not path.is_symlink()
         and source['commit'] == '69eba563895bf083b24c8214a088454d5df34922', 'HOST_SOURCE_INVALID')
    raw = (path / 'release-manifest.json').read_bytes()
    need(digest(raw) == source['manifestSha256'] and json.loads(raw)['commit'] == source['commit'], 'HOST_SOURCE_CHANGED')
    need(source['files'] == {WORKER + 'release_safety.py': contract['baselineWorkerFiles']['release_safety.py']},
         'HOST_SOURCE_SCOPE_CHANGED')
    for name, expected in source['files'].items():
        target = path / name
        need(not target.is_symlink() and digest(target.read_bytes()) == expected, 'HOST_SOURCE_CHANGED')
    return path


def sqlite_inspection_source():
    # Independent publication proof. The worker and its global safety gate stay unchanged.
    return r"""import sys,json,sqlite3,hashlib,importlib.util,uuid
from pathlib import Path
cfg=json.loads(sys.stdin.readline());p=Path('/app/apps/api/src/id-business-v2/auto-registration/worker/release_safety.py');assert not p.is_symlink();helper_hash=hashlib.sha256(p.read_bytes()).hexdigest();assert helper_hash in cfg['safetyHashes']
if helper_hash==cfg['candidateSafetyHash']:
 q=p.with_name('flow_evidence.py');assert not q.is_symlink() and hashlib.sha256(q.read_bytes()).hexdigest()==cfg['candidateFlowHash']
spec=importlib.util.spec_from_file_location('strict_readonly_lease_audit',p);s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
import os,stat
database=Path('/app/.runtime/auto-registration/database.db');component=Path(database.anchor)
for part in database.parts[1:]:
 component/=part;mode=os.lstat(component).st_mode;assert not stat.S_ISLNK(mode)
assert stat.S_ISREG(mode)
for suffix in ('-wal','-shm','-journal'):
 try:mode=os.lstat(str(database)+suffix).st_mode
 except FileNotFoundError:continue
 assert stat.S_ISREG(mode)
with sqlite3.connect('file:/app/.runtime/auto-registration/database.db?mode=ro',uri=True,timeout=5)as db:
 db.execute('PRAGMA query_only=ON');db.execute('BEGIN');assert db.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
 summary=s.logical_summary(db);leases=s.encrypted_proof(db,cfg['key']);assert leases==1;facts=[]
 for name,value in db.execute('SELECT key,value FROM settings'):
  if not name.startswith(s.APPLE_PREFIX):continue
  record=s.strict_json(s.decrypt_value(value,cfg['key']));task=record.get('activeTaskUuid')
  if task is None:continue
  assert str(uuid.UUID(task))==task
  binding_value=db.execute('SELECT value FROM settings WHERE key=?',(s.APPLE_TASK_PREFIX+task,)).fetchone()[0];binding=s.strict_json(s.decrypt_value(binding_value,cfg['key']))
  task_row=db.execute('SELECT * FROM registration_tasks WHERE task_uuid=?',(task,)).fetchone();assert task_row is not None
  task_status=db.execute('SELECT status FROM registration_tasks WHERE task_uuid=?',(task,)).fetchone()[0];assert task_status in s.TASK_STATUSES
  record_status=record.get('taskStatus');assert record_status in {'pending','running','completed','failed','cancelled','awaiting_review','interrupted'}
  h=lambda v:hashlib.sha256(s.canonical(v)).hexdigest()
  facts.append({'taskUuid':task,'taskStatus':task_status,'recordTaskStatus':record_status,'sideEffectPossible':binding.get('sideEffectPossible')is True,'needsReview':binding.get('needsReview')is True,'recordSha256':h(value),'bindingSha256':h(binding_value),'taskRowSha256':h([s.sqlite_value(v)for v in task_row])})
 assert len(facts)==leases
 protected=[]
 for task in ['f8ec17e1-036a-493e-ab3c-7a84ef026777','69f6a290-8de4-409f-86ee-d8b5c1f5865b']:
  binding_value=db.execute('SELECT value FROM settings WHERE key=?',(s.APPLE_TASK_PREFIX+task,)).fetchone()[0];binding=s.strict_json(s.decrypt_value(binding_value,cfg['key']))
  candidates=[]
  for name,value in db.execute('SELECT key,value FROM settings'):
   if name.startswith(s.APPLE_PREFIX):
    record=s.strict_json(s.decrypt_value(value,cfg['key']))
    if record['email']==binding['email']:candidates.append((record,value))
  assert len(candidates)==1;record,value=candidates[0]
  task_row=db.execute('SELECT * FROM registration_tasks WHERE task_uuid=?',(task,)).fetchone();assert task_row is not None
  task_status=db.execute('SELECT status FROM registration_tasks WHERE task_uuid=?',(task,)).fetchone()[0];assert task_status in s.TASK_STATUSES
  h=lambda v:hashlib.sha256(s.canonical(v)).hexdigest()
  protected.append({'taskUuid':task,'taskStatus':task_status,'recordRegistrationStatus':record['registrationStatus'],'recordSource':record['source'],'recordSha256':h(value),'bindingSha256':h(binding_value),'taskRowSha256':h([s.sqlite_value(v)for v in task_row])})
 assert summary['taskCounts']['pending']==0 and summary['taskCounts']['running']==0
 print(json.dumps({'version':1,'status':'PASS',**summary,'activeAppleLeaseCount':leases,'executingTaskCount':0,'retainedReviewLeaseCount':len(facts),'corruptEncryptedValueCount':0,'leaseFacts':facts,'protectedTaskFacts':protected,'businessActions':0},sort_keys=True))
"""


def validate_sqlite_receipt(value, contract, expected_logical=None):
    policy = contract['sqliteReviewPolicy']
    leases = policy['leaseFacts']
    protected = policy['protectedTaskFacts']
    need(len(leases) == 1 and leases[0]['taskUuid'] == '69f6a290-8de4-409f-86ee-d8b5c1f5865b'
         and leases[0]['taskStatus'] == 'failed' and leases[0]['recordTaskStatus'] == 'awaiting_review'
         and leases[0]['needsReview'] is True and leases[0]['sideEffectPossible'] is True
         and policy['summary']['taskCounts']['pending'] == 0 and policy['summary']['taskCounts']['running'] == 0,
         'SQLITE_REVIEW_POLICY_INVALID')
    need(len(protected) == 2 and protected[0]['taskUuid'] == 'f8ec17e1-036a-493e-ab3c-7a84ef026777'
         and protected[0]['taskStatus'] == 'failed' and protected[0]['recordRegistrationStatus'] == 'registered'
         and protected[0]['recordSource'] == 'manual'
         and protected[1]['taskUuid'] == leases[0]['taskUuid'] and protected[1]['taskStatus'] == 'failed'
         and all(re.fullmatch('[a-f0-9]{64}', fact[key]) for fact in [*leases, *protected]
                 for key in ('recordSha256', 'bindingSha256', 'taskRowSha256')),
         'SQLITE_REVIEW_POLICY_INVALID')
    expected = {'version': 1, 'status': 'PASS', **policy['summary'], 'activeAppleLeaseCount': 1,
                'executingTaskCount': 0, 'retainedReviewLeaseCount': 1, 'corruptEncryptedValueCount': 0,
                'leaseFacts': leases, 'protectedTaskFacts': policy['protectedTaskFacts'], 'businessActions': 0}
    need(value == expected and (expected_logical is None or value['logicalSha256'] == expected_logical),
         'SQLITE_PRESERVATION_CHANGED')
    return value


def sqlite_receipt(d, directory, contract, expected_logical=None):
    config = {'safetyHashes': [contract['baselineWorkerFiles']['release_safety.py'], contract['workerFiles']['release_safety.py']],
              'candidateSafetyHash': contract['workerFiles']['release_safety.py'],
              'candidateFlowHash': contract['workerFiles']['flow_evidence.py']}
    source = "const{spawnSync}=require('child_process');const config=" + json.dumps(config) + ";config.key=process.env.FIELD_ENCRYPTION_KEY;" \
        + "const result=spawnSync('/opt/id-registration/venv/bin/python',['-B','-c'," + json.dumps(sqlite_inspection_source()) \
        + "],{input:JSON.stringify(config)+'\\n',encoding:'utf8',env:{PATH:process.env.PATH},timeout:45000});" \
        + "if(result.status!==0)process.exit(2);console.log(JSON.stringify(JSON.parse(result.stdout)));"
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source, timeout=60))
    return validate_sqlite_receipt(value, contract, expected_logical)


def backup_sqlite(old, d, directory, plan, states, marker, safety, contract):
    # Rebind only the inspector in a fresh function namespace. No old module or file is edited.
    need(digest(Path(old.__file__).read_bytes()) == contract['buildSupportHashes'][
        'scripts/production-release/registration-closure-release.py'], 'SQLITE_BACKUP_HELPER_CHANGED')
    original = old.backup_sqlite_locked
    namespace = {**original.__globals__, 'inspect_sqlite': lambda driver, root, expected=None:
                 sqlite_receipt(driver, root, contract, expected)}
    adapted = types.FunctionType(original.__code__, namespace, original.__name__, original.__defaults__, original.__closure__)
    return adapted(d, directory, plan, states, marker.parent, marker, marker.read_bytes(), safety)


def baseline(d, h, a, finite, contract, expected=None):
    current = (BASE / 'current').resolve()
    need(str(current) == contract['current'] and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    inherited_host_source(contract)
    need({n: json.loads(raw)['roleSourceProjections'][n]['commit'] for n in contract['roleSourceCommits']}
         == contract['roleSourceCommits'], 'ROLE_BASELINE_CHANGED')
    need(json.loads(raw)['roleSourceProjections']['admin']['candidateProofSha256']
         == contract['publishedAdminProof']['sha256'], 'ADMIN_BASELINE_PROOF_CHANGED')
    states = h.snapshot(d, current)
    need(states == contract['services'] and all(digest((current / n).read_bytes()) == value
         for n, value in contract['configurationSha256'].items()), 'RUNTIME_BASELINE_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'],
         'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, current, states, contract)
    finite.engine_content(d, states['online-recharge'], contract['baselineEngineFiles'])
    api_inventory(d, states['api'], '/app/apps/api/dist/', contract['baselineApiFiles'], javascript_only=True)
    api_inventory(d, states['api'], '/app/node_modules/.prisma/client/', contract['runtimePrismaClientFiles'])
    worker_inventory(d, states['api'], contract['baselineWorkerFiles'])
    unchanged_schema(d, current, contract)
    a.verify_admin(d, states['admin'], contract['baselineAdminFiles'])
    observed = {**a.runtime_receipt(current, raw, states), 'database': finite.database_receipt(d, current, contract),
                'sqlite': sqlite_receipt(d, current, contract)}
    if expected is not None:
        need(observed == expected, 'PREFLIGHT_MOVED')
    return current, raw, states, observed


def smoke(d, target, states, contract, proof, receipt, h, a, finite):
    need(all(states[n] == receipt['before'][n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    online = states['online-recharge']
    need(all(online[n] == receipt['before']['online-recharge'][n] for n in ('image', 'reference', 'environmentSha256')),
         'ENGINE_IMAGE_CHANGED')
    row = json.loads(d.run('docker', 'inspect', online['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'ENGINE_API_BINDING_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'],
         'RUNTIME_CONFIGURATION_CHANGED')
    h.engine_idle(d, online, contract, wait_connected=True)
    finite.engine_content(d, online, contract['baselineEngineFiles'])
    api_inventory(d, states['api'], '/app/apps/api/dist/', {**contract['baselineApiFiles'],
        **{n: value for n, value in proof['apiModules'].items() if n.endswith('.js')}}, javascript_only=True)
    a.verify_modules(d, target, proof['apiModules'])
    api_inventory(d, states['api'], '/app/node_modules/.prisma/client/', contract['runtimePrismaClientFiles'])
    worker_inventory(d, states['api'], {**contract['baselineWorkerFiles'], **contract['workerFiles']})
    unchanged_schema(d, target, contract)
    need(finite.database_receipt(d, target, contract) == receipt['database'], 'MYSQL_DATA_CHANGED')
    need(sqlite_receipt(d, target, contract) == receipt['sqlite'], 'SQLITE_DATA_CHANGED')
    a.verify_admin(d, states['admin'], {**contract['baselineAdminFiles'], **proof['adminFiles']})
    request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(2 * 1024**2)
    need(digest(raw) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in raw,
         'PUBLIC_ADMIN_CHANGED')


def release(plan, contract, d, h):
    need(plan['mode'] in ('preflight', 'release', 'readback') and contract['scope'] == SCOPE
         and contract['expectedCurrent'] == '88bce5ab09d20cd303f1fdd5fe310cb0b42e1451'
         and contract['migration'] is None and contract.get('frozen') is True
         and all(re.fullmatch('[a-f0-9]{40}', plan[n]) for n in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan[n]) for n in ('workflowRunId', 'workflowRunAttempt')), 'IDENTITY_INVALID')
    a, finite = helper('recharge-availability-release.py'), helper('proxy-result-identity-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            raw = (target / 'release-manifest.json').read_bytes()
            manifest = json.loads(raw)
            need(manifest['commit'] == plan['commit'] and manifest['sourceTree'] == plan['tree']
                 and manifest['scope'] == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'registration-flow-evidence-preservation.json').read_bytes())
            proof_raw = (target / 'registration-flow-evidence-build-proof.json').read_bytes()
            need(digest(proof_raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(proof_raw)
            need(all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'contractSha256', 'controlSources'))
                 and proof['sources'] == contract['sources'], 'READBACK_IDENTITY_CHANGED')
            need(all(digest((target / name).read_bytes()) == value for name, value in contract['sources'].items())
                 and all(digest((target / 'scripts/production-release' / name).read_bytes()) == value
                         for name, value in plan['controlSources'].items()), 'READBACK_SOURCE_CHANGED')
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, target, states, contract, proof, receipt, h, a, finite)
            need(manifest['roleSourceProjections']['online-recharge'] == receipt['previousRoleProjections']['online-recharge']
                 and all(manifest['roleSourceProjections'][n]['parentProjection'] == receipt['previousRoleProjections'][n]
                         for n in ('api', 'admin')), 'ROLE_INHERITANCE_CHANGED')
            finite.release_markers(receipt['maintenance'])
            (target / 'registration-flow-evidence-readback.json').write_text(json.dumps({'status': 'VERIFIED',
                'commit': plan['commit'], 'maintenanceReleased': True, 'migrationPerformed': False, 'businessActions': 0}) + '\n')
            return {'status': SCOPE + '_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'migrationPerformed': False, 'businessActions': 0, 'maintenanceReleased': True,
                    'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge']}
        previous, raw_manifest, before, observed = baseline(d, h, a, finite, contract, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': SCOPE + '_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'runtimeBaseline': observed,
                    'migrationPerformed': False, 'businessActions': 0}
        need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_REQUIRED')
        stage = BASE / '.staging' / ('registration-flow-evidence-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/registration-flow-evidence-' + plan['commit'] + '/registration-flow-evidence-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            raw = response.read(64 * 1024**2 + 1)
        need(0 < len(raw) <= 64 * 1024**2 and digest(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = archive(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(digest(proof_raw) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = verify_proof(json.loads(proof_raw), plan, contract, payload, h)
        billing = helper('recharge-billing-release.py')
        images = {}
        for role, copies, count in [('api', 'COPY modules/ /app/apps/api/dist/\nCOPY worker/ /app/' + WORKER + '\n', 2),
                                    ('admin', 'COPY html/ /usr/share/nginx/html/\n', 1)]:
            context = payload / role
            a.normalize_image_context(context)
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            (context / 'Dockerfile').write_text('FROM ' + reference + '\n' + copies
                + 'LABEL org.opencontainers.image.revision="' + plan['commit']
                + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            image = 'id-business-v2-registration-flow-evidence:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, context, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            finite.verify_overlay_image(original, built, plan, count, billing)
            images[role] = {'reference': image, 'imageId': built['Id']}
        need(baseline(d, h, a, finite, contract, plan['runtimeBaseline']) == (previous, raw_manifest, before, observed), 'BASELINE_MOVED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-registration-flow-evidence')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        inherited = inherited_host_source(contract)
        for name in contract['hostSourceInheritance']['files']:
            path = target / name
            need(not path.is_symlink(), 'SOURCE_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((inherited / name).read_bytes())
        for name in contract['sources']:
            path = target / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'SOURCE_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(digest(raw) == expected, 'CONTROL_CHANGED')
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'CONTROL_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in ('api', 'admin'):
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, a, finite, contract, plan['runtimeBaseline'])
        maintenance = finite.claim_markers(d, before, plan)
        journal, fence = stage / 'switch-state.json', None
        try:
            finite.verify_markers(maintenance)
            d.assert_no_active_recharge(previous)
            d.assert_no_active_registration(previous)
            h.engine_idle(d, before['online-recharge'], contract)
            need(sqlite_receipt(d, previous, contract) == observed['sqlite'], 'SQLITE_MOVED')
            backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
            need(backup.get('s3Verified') is True, 'MYSQL_BACKUP_UNVERIFIED')
            old = helper('registration-closure-release.py')
            marker = Path(maintenance['paths'][1])
            safety = inherited / WORKER / 'release_safety.py'
            need(digest(safety.read_bytes()) == contract['baselineWorkerFiles']['release_safety.py'], 'BASE_SAFETY_CHANGED')
            sqlite_backup = backup_sqlite(old, d, previous, plan, before, marker, safety, contract)
            need(sqlite_backup['s3Verified'] and sqlite_backup['logical'] == observed['sqlite'], 'SQLITE_BACKUP_UNVERIFIED')
            fence = finite.sql_fence_class(contract)(d, previous)
            fence.acquire()
            fence.check_idle()
            finite.verify_markers(maintenance)
            need(sqlite_receipt(d, previous, contract) == observed['sqlite'], 'SQLITE_MOVED_AFTER_FENCE')
            journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': maintenance}) + '\n')
            fence.stop(before['api'], grace=30)
            fence.stop(before['online-recharge'], grace=45)
            fence.close()
            fence = None
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'admin', timeout=180)
            for role in ('api', 'admin'):
                d.wait_healthy(target, role)
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[n]['image'] == images[n]['imageId'] for n in images), 'PUBLISHED_IMAGE_CHANGED')
            manifest = json.loads(raw_manifest)
            projections = copy.deepcopy(manifest['roleSourceProjections'])
            receipt = {'status': SCOPE + '_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'], 'before': before,
                'after': after, 'database': observed['database'], 'sqlite': observed['sqlite'], 'mysqlBackup': backup,
                'sqliteBackup': sqlite_backup, 'maintenance': maintenance, 'previousRoleProjections': projections,
                'images': images, 'updatedServices': ['api', 'admin'], 'reboundServices': ['online-recharge'],
                'migrationPerformed': False, 'businessActions': 0}
            receipt['hostSourceInheritance'] = contract['hostSourceInheritance']
            smoke(d, target, after, contract, proof, receipt, h, a, finite)
            for role in ('api', 'admin'):
                manifest['roleSourceProjections'][role] = {'kind': SCOPE, 'commit': plan['commit'], 'sourceTree': plan['tree'],
                    'parentProjection': projections[role], 'publishedBaseImageId': before[role]['image'],
                    'runtimeImageId': images[role]['imageId'], 'buildProofSha256': plan['buildProofSha256'],
                    'runtimeFiles': proof['apiModules'] if role == 'api' else proof['adminFiles'],
                    'workerFiles': proof['workerFiles'] if role == 'api' else {},
                    'sourceDelta': {n: v for n, v in contract['sources'].items() if n.startswith('apps/api/' if role == 'api' else 'apps/admin/')}}
                manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
            manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, status='DEPLOYED',
                previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest),
                previousRoleSourceProjections=projections, previousSourceProjection=manifest.get('sourceProjection'),
                sourceProjection={'kind': SCOPE, 'baselineCommit': contract['expectedCurrent'],
                                  'sourceBaseline': contract['sourceBaseline'], 'sourceBaselineTree': contract['sourceBaselineTree'],
                                  'method': 'PUBLISHED_RUNTIME_PLUS_TASK_DELTA', 'sources': contract['sources'],
                                  'roleSourceCommits': contract['roleSourceCommits'],
                                  'reviewedApplicationCommit': contract['reviewedApplicationCommit'],
                                  'hostSourceInheritance': contract['hostSourceInheritance'],
                                  'buildProofSha256': plan['buildProofSha256']},
                servicesUpdated=['api', 'admin'], servicesRebound=['online-recharge'], newMigrations=[], migrationPerformed=False,
                paymentActions=0, subscriptionChanged=False, externalNotification=False, validationRun=plan['workflowRunId'],
                actualDeployment=receipt, compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256']})
            (target / 'registration-flow-evidence-build-proof.json').write_bytes(proof_raw)
            (target / 'registration-flow-evidence-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            d.point_current(target, stamp + '-registration-flow-evidence')
            journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'maintenance': maintenance}) + '\n')
            return {n: receipt[n] for n in ('status', 'commit', 'tree', 'images', 'updatedServices', 'reboundServices', 'migrationPerformed', 'businessActions')}
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target),
                'maintenance': maintenance, 'maintenanceHeld': True, 'rollbackPerformed': False,
                'switchMayHaveStarted': True}) + '\n')
            raise
        finally:
            if fence is not None:
                fence.close()
