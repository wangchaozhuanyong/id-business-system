"""Forward-only publication of the finite payment-availability delta."""
import datetime
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_AVAILABILITY_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def normalize_image_context(directory):
    for path in (directory, *directory.rglob('*')):
        need(not path.is_symlink() and (path.is_dir() or path.is_file()), 'IMAGE_CONTEXT_PATH_INVALID')
        path.chmod(0o755 if path.is_dir() else 0o644)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_modules(d, directory, modules):
    code = ("const fs=require('fs'),h=require('crypto');console.log(JSON.stringify(Object.fromEntries("
            + json.dumps(list(modules)) + ".map(n=>{const p='/app/apps/api/dist/'+n;return [n,fs.existsSync(p)?"
            "h.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null]}))));")
    need(json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code)) == modules,
         'API_CONTENT_CHANGED')


def verify_admin(d, state, files):
    need(all(re.fullmatch(r'[A-Za-z0-9_./-]+', name) and '..' not in Path(name).parts
             and not name.startswith('/') for name in files), 'ADMIN_PATH_INVALID')
    prefix = '/usr/share/nginx/html/'
    rows = d.run('docker', 'exec', state['containerId'], 'sha256sum', *(prefix + n for n in files), timeout=60)
    actual = {}
    for row in rows.splitlines():
        sha, path = row.split('  ', 1)
        need(path.startswith(prefix) and path.removeprefix(prefix) not in actual, 'ADMIN_CONTENT_INVALID')
        actual[path.removeprefix(prefix)] = sha
    need(actual == files, 'ADMIN_CONTENT_CHANGED')


def validate_proof(proof, plan, contract, payload, h):
    need(proof.get('version') == 1 and proof.get('scope') == contract['scope']
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256'))
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminArtifactVerified') is True
         and proof.get('baselineAdminVerification') == {**contract['publishedAdminNative'], 'verified': True,
             'publicInventorySha256': digest(json.dumps(contract['publicFiles'], sort_keys=True, separators=(',', ':')).encode())}
         and proof.get('updatedServices') == ['api', 'admin'] and proof.get('migrationPerformed') is False
         and type(proof.get('businessActions')) is int and proof.get('businessActions') == 0, 'PROOF_INVALID')
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files'), 'PAYLOAD_CHANGED')
    expected_api = {n.removesuffix('.js') + ext for n in contract['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    need(set(proof['apiModules']) == expected_api and len(proof['adminFiles']) >= 250
         and {n.removeprefix('source/'): v for n, v in actual.items() if n.startswith('source/')} == contract['sources']
         and {n.removeprefix('api/modules/'): v for n, v in actual.items() if n.startswith('api/modules/')} == proof['apiModules']
         and {n.removeprefix('admin/html/'): v for n, v in actual.items() if n.startswith('admin/html/')} == proof['adminFiles']
         and actual.get('baseline-admin-native.zip') == contract['publishedAdminNative']['artifactDigest'].removeprefix('sha256:')
         and all(n == 'baseline-admin-native.zip' or n.startswith(('source/', 'api/modules/', 'admin/html/')) for n in actual), 'PAYLOAD_SCOPE_INVALID')
    return proof


def smoke(d, target, proof, states, contract, h):
    verify_modules(d, target, proof['apiModules'])
    verify_admin(d, states['admin'], proof['adminFiles'])
    # Retain every previously served asset unless the new build explicitly replaces it.
    old = {n: v for n, v in contract['publicFiles'].items() if n not in proof['adminFiles']}
    verify_admin(d, states['admin'], old)
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/',
            headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        public = response.read(2 * 1024**2)
    need(digest(public) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in public,
         'PUBLIC_BUILD_CHANGED')
    for name, expected in contract['sources'].items():
        path = target / name
        need(path.resolve().is_relative_to(target) and not path.is_symlink()
             and digest(path.read_bytes()) == expected, 'HOST_SOURCE_CHANGED')
    h.guards(d, target, states, contract)
    code = ("const m=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-availability.js');"
            "const a=m.rechargeAvailability({state:'finished',leaseUntil:new Date(0),ownerId:'fixture',accountKey:null,"
            "result:{payment_attempted:true,payment_requests_sent:1,payment_status:'unknown'}},[]);"
            "console.log(JSON.stringify({released:a.execution==='released',unknownProtected:a.accountPaymentRestricted&&a.payment==='unknown'}));")
    need(json.loads(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code))
         == {'released': True, 'unknownProtected': True}, 'AVAILABILITY_SMOKE_FAILED')


def baseline(d, contract, h):
    previous=(BASE/'current').resolve()
    need(previous==Path(contract['current']) and previous.parent==BASE/'releases','CURRENT_CHANGED')
    raw=(previous/'release-manifest.json').read_bytes()
    need(digest(raw)==contract['manifestSha256'],'MANIFEST_CHANGED')
    states=h.snapshot(d,previous)
    need(states==contract['services'],'SERVICES_CHANGED')
    need(all(digest((previous/n).read_bytes())==v for n,v in contract['configurationSha256'].items()),'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free>6*1024**3,'DISK_LOW')
    normalizer=Path(contract['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE/'releases') and normalizer.is_file() and not normalizer.is_symlink() and digest(normalizer.read_bytes())=='ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202','BACKUP_NORMALIZER_CHANGED')
    verify_modules(d,previous,contract['apiModules'])
    verify_admin(d,states['admin'],contract['publicFiles'])
    h.guards(d,previous,states,contract)
    return previous,raw,states


def release(plan, contract, d, h):
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[0-9]+', plan['workflowRunId'])
         and re.fullmatch('[0-9]+', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == contract['scope'], 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'recharge-availability-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED), 'READBACK_SERVICES_CHANGED')
            raw = (target / 'recharge-availability-build-proof.json').read_bytes()
            need(digest(raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            smoke(d, target, json.loads(raw), states, contract, h)
            return {'status': 'RECHARGE_AVAILABILITY_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'images': receipt['images'], 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': False}
        previous, raw_manifest, before = baseline(d, contract, h)
        verify_modules(d, previous, contract['apiModules'])
        if plan['mode'] == 'preflight':
            return {'status': 'RECHARGE_AVAILABILITY_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0, 'migrationPerformed': False}
        stage = BASE / '.staging' / ('recharge-availability-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        bundle = h.download(plan['artifactUrl'], 32 * 1024**2)
        need(digest(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(digest(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = validate_proof(json.loads(raw_proof), plan, contract, payload, h)
        models = {n: h.configuration(d, before[n]) for n in ('api', 'admin', 'online-recharge')}
        images = {}
        for role in ('api', 'admin'):
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            normalize_image_context(payload / role)
            lines = 'FROM ' + reference + '\n'
            lines += 'COPY modules/ /app/apps/api/dist/\n' if role == 'api' else (
                'COPY html/ /usr/share/nginx/html/\n')
            lines += 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n'
            (payload / role / 'Dockerfile').write_text(lines)
            image = 'id-business-v2-availability:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, payload / role, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'], 'BASE_LAYERS_CHANGED')
            need({k: v for k, v in built['Config'].items() if k != 'Labels'} == {k: v for k, v in original['Config'].items() if k != 'Labels'}, 'IMAGE_CONFIGURATION_CHANGED')
            labels = {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'],
                      'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}
            need(built['Config']['Labels'] == labels, 'IMAGE_LABELS_CHANGED')
            images[role] = {'reference': image, 'imageId': built['Id']}
        # Load only the pure availability classifier; no database, volumes or external network.
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
              images['api']['reference'], '-e', "const m=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-availability.js');if(typeof m.rechargeAvailability!=='function')process.exit(2)")
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '101:101',
              '--entrypoint', 'sh', images['admin']['reference'], '-c',
              'test -r /usr/share/nginx/html/index.html && test -x /usr/share/nginx/html/assets')
        need(baseline(d, contract, h)[1:] == (raw_manifest, before), 'BASELINE_MOVED')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-recharge-availability')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in contract['sources']:
            destination = target / name
            need(destination.resolve().is_relative_to(target) and not destination.is_symlink(), 'HOST_SOURCE_PATH_INVALID')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
            destination.chmod(0o644)
        controls = target / 'scripts/production-release'
        controls.mkdir(parents=True, exist_ok=True)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(digest(raw) == expected, 'EXECUTOR_CHANGED')
            (controls / name).write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in images:
            override['services'][role]['image'] = images[role]['reference']
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        need(baseline(d, contract, h)[1:] == (raw_manifest, before), 'BASELINE_MOVED')
        state_path = stage / 'switch-state.json'
        state_path.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
        d.compose(previous, 'stop', 'online-recharge', timeout=90)
        d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
        d.wait_healthy(target, 'api')
        d.wait_healthy(target, 'admin')
        d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
        d.wait_healthy(target, 'online-recharge')
        after = h.snapshot(d, target)
        need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
        for role in ('api', 'admin', 'online-recharge'):
            need(h.configuration(d, after[role]) == models[role] and after[role]['environmentSha256'] == before[role]['environmentSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
        need(all(after[n]['image'] == images[n]['imageId'] for n in images)
             and after['online-recharge']['image'] == before['online-recharge']['image'], 'RUNTIME_IMAGE_CHANGED')
        h.engine_idle(d, after['online-recharge'], contract, wait_connected=True)
        online = json.loads(d.run('docker', 'inspect', after['online-recharge']['containerId']))[0]
        need(online['HostConfig']['NetworkMode'] == 'container:' + after['api']['containerId'], 'ONLINE_BINDING_CHANGED')
        smoke(d, target, proof, after, contract, h)
        receipt = {'status': 'RECHARGE_AVAILABILITY_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
                   'before': before, 'after': after, 'images': images, 'backup': backup, 'workflowRunId': plan['workflowRunId'],
                   'buildProofSha256': plan['buildProofSha256'], 'businessActions': 0, 'migrationPerformed': False}
        (target / 'recharge-availability-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'recharge-availability-build-proof.json').write_bytes(raw_proof)
        (target / 'recharge-availability-baseline-admin-native.zip').write_bytes((payload / 'baseline-admin-native.zip').read_bytes())
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=contract['scope'], status='DEPLOYED',
                        previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest),
                        servicesUpdated=['api', 'admin'], dependentServiceRebound='online-recharge', newMigrations=[], migrationPerformed=False,
                        paymentActions=0, validationRun=plan['workflowRunId'], actualDeployment=receipt,
                        rechargeAvailabilityPublication={'plan': plan, 'baselineManifestSha256': contract['manifestSha256'], 'backup': backup})
        for role in images:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-recharge-availability')
        state_path.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {k: receipt[k] for k in ('status', 'commit', 'tree', 'images', 'workflowRunId', 'businessActions', 'migrationPerformed')}
