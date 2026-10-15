"""Finite forward publisher for the already deployed diagnostic repair baseline.

Requires independently reproduced predecessor content and native successful CI.
It never invokes migration, payment, notifications, cleanup, or automatic rollback.
"""
import copy
import datetime
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request

BASE = Path('/opt/id-business-v2')
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge',
            'auto-registration', 'online-recharge')
PRESERVED = SERVICES[2:7]
MODULE = '/app/apps/api/dist/id-business-v2/auto-recharge/recharge-validation.js'
SCOPE = 'RECHARGE_RECORD_DIAGNOSTICS_ONLY'


def need(condition, code):
    if not condition:
        raise RuntimeError('RECHARGE_RECORD_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def base_image_reference(d, state):
    reference = state['reference']
    need(isinstance(reference, str) and re.fullmatch(r'[a-z0-9][a-z0-9._:/@-]{1,255}', reference)
         and not re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}', reference),
         'BASE_REFERENCE_INVALID')
    image = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
    need(image['Id'] == state['image'], 'BASE_REFERENCE_CHANGED')
    return reference


def build_image(d, source, reference, role, state, stage):
    receipt_path = stage / (role + '-image-build.json')
    receipt = {'role': role, 'status': 'STARTED', 'baseImageId': state['image'],
               'baseReference': state['reference'], 'reference': reference}
    receipt_path.write_text(json.dumps(receipt, sort_keys=True) + '\n')
    try:
        d.run('docker', 'build', '--pull=false', '--network', 'none', '--tag',
              reference, str(source), timeout=300)
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        # Record only bounded classifications, never registry responses or credentials.
        detail = str(error).lower()
        code = 'SOURCE_UNAVAILABLE' if 'pull access denied' in detail or 'insufficient_scope' in detail else (
            'TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else 'COMMAND_FAILED')
        receipt.update(status='FAILED', failureKind=code, exceptionType=type(error).__name__)
        receipt_path.write_text(json.dumps(receipt, sort_keys=True) + '\n')
        raise RuntimeError('RECHARGE_RECORD_' + role.upper() + '_IMAGE_BUILD_' + code) from None
    receipt['status'] = 'BUILT'
    receipt_path.write_text(json.dumps(receipt, sort_keys=True) + '\n')


def safe_archive(raw, directory):
    need(not directory.exists(), 'ARTIFACT_OUTPUT_EXISTS')
    directory.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        names = set()
        for item in archive.getmembers():
            parts = Path(item.name).parts
            need(parts and parts[0] == 'payload' and not item.name.startswith('/')
                 and '..' not in parts and item.name not in names
                 and (item.isfile() or item.isdir()) and item.size <= 8 * 1024**2,
                 'ARTIFACT_PATH_INVALID')
            names.add(item.name)
            path = directory / item.name
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(item).read())
                path.chmod(0o644)
    return directory / 'payload'


def file_inventory(root):
    output = {}
    for path in root.rglob('*'):
        need(not path.is_symlink(), 'CONTENT_SYMLINK')
        if path.is_file():
            output[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return output


def validate_proof(proof, plan, contract, payload):
    fields = {'version', 'scope', 'commit', 'tree', 'contractSha256', 'workflowRunId',
              'workflowRunAttempt', 'sourceBaseline', 'liveManifestSha256',
              'baselineApiReproduced', 'baselineAdminReproduced', 'publishedAdminPatchCommit',
              'publishedAdminSources', 'controllerSha256',
              'releaseUtilitySha256', 'files', 'updatedServices', 'dependentServiceRebound',
              'migrationPerformed', 'businessActions'}
    need(type(proof) is dict and set(proof) == fields and type(proof.get('version')) is int
         and proof.get('version') == 3 and proof.get('scope') == SCOPE
         and proof.get('commit') == plan['commit'] and proof.get('tree') == plan['tree']
         and proof.get('workflowRunId') == plan['workflowRunId']
         and proof.get('workflowRunAttempt') == plan['workflowRunAttempt']
         and proof.get('sourceBaseline') == contract['sourceBaseline']
         and proof.get('liveManifestSha256') == contract['manifestSha256']
         and proof.get('contractSha256') == plan['contractSha256']
         and proof.get('baselineApiReproduced') is True
         and proof.get('baselineAdminReproduced') is True
         and proof.get('publishedAdminPatchCommit') == contract['preservedAdminCommit']
         and proof.get('publishedAdminSources') == contract['publishedAdminSources']
         and proof.get('updatedServices') == ['api', 'admin']
         and proof.get('dependentServiceRebound') == 'online-recharge'
         and proof.get('controllerSha256') == plan['controllerSha256']
         and proof.get('releaseUtilitySha256') == plan['releaseUtilitySha256']
         and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
         and proof.get('businessActions') == 0,
         'BUILD_PROOF_INVALID')
    actual = file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') and 'api/recharge-validation.js' in actual
         and 'admin/html/index.html' in actual
         and {name.removeprefix('source/'): value for name, value in actual.items()
              if name.startswith('source/')} == {**contract['changedSources'], **contract['publishedAdminSources']}
         and all(name == 'api/recharge-validation.js' or name.startswith('admin/html/') or name.startswith('source/')
                 for name in actual), 'BUILD_CONTENT_CHANGED')
    return proof


def snapshot(d, directory):
    return {name: d.service_state(directory, name, include_container_id=True,
                                  include_environment_hash=True) for name in SERVICES}


def verify_admin_content(d, state, contract):
    files = contract['publicFiles']
    need(type(files) is dict and len(files) == 259
         and fingerprint(files) == contract['preservedAdminFilesSha256'], 'ADMIN_INVENTORY_CHANGED')
    need(all(re.fullmatch(r'[A-Za-z0-9_./-]+', name) and '..' not in Path(name).parts
             and not name.startswith('/') for name in files), 'ADMIN_PATH_INVALID')
    prefix = '/usr/share/nginx/html/'
    output = d.run('docker', 'exec', state['containerId'], 'sha256sum',
                   *(prefix + name for name in files), timeout=60)
    actual = {}
    for line in output.splitlines():
        parts = line.split('  ', 1)
        need(len(parts) == 2 and parts[1].startswith(prefix), 'ADMIN_CONTENT_INVALID')
        name = parts[1].removeprefix(prefix)
        need(name not in actual, 'ADMIN_CONTENT_INVALID')
        actual[name] = parts[0]
    need(actual == files, 'PRESERVED_ADMIN_CONTENT_CHANGED')


def engine_idle(d, state, contract, *, wait_connected=False):
    code = ("require('/workspace/engine/healthcheck.cjs').check().then(v=>{"
            "console.log(JSON.stringify({ready:v.ready,mode:v.mode,activeTasks:v.activeTasks,"
            "stopping:v.stopping,rpcConnected:v.rpcConnected}))}).catch(()=>process.exit(1))")
    expected = contract['engineHealth']
    need(expected == {'ready': True, 'mode': 'enabled', 'activeTasks': 0,
                      'stopping': False, 'rpcConnected': True}, 'ENGINE_CONTRACT_CHANGED')
    deadline = time.monotonic() + 45
    while True:
        result = json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=15))
        need(type(result.get('activeTasks')) is int, 'ONLINE_NOT_IDLE')
        if result == expected:
            break
        need(wait_connected and result == {**expected, 'rpcConnected': False}
             and time.monotonic() < deadline, 'ONLINE_NOT_IDLE')
        time.sleep(2)
    rpc = ("(async()=>{const value=await require('/workspace/engine/rpc.cjs').rpc('getRuntimeConfig',{});"
           "console.log(JSON.stringify({readOnlyRpcReady:!!value&&typeof value==='object'&&!Array.isArray(value)}))"
           "})().catch(()=>process.exit(1));")
    need(json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', rpc, timeout=15))
         == {'readOnlyRpcReady': True}, 'ONLINE_RPC_UNAVAILABLE')
    return result


def guards(d, directory, states, contract):
    d.assert_no_active_recharge(directory)
    d.assert_no_active_registration(directory)
    marker = BASE / 'maintenance.json'
    need(not marker.exists(), 'MAINTENANCE_PRESENT')
    need(not Path('/var/lib/docker/volumes/20260821t095106z_auto_registration_data/_data/.id-release-maintenance.json').exists(),
         'MAINTENANCE_PRESENT')
    engine_idle(d, states['online-recharge'], contract)
    code = ("const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});"
            "(async()=>{const r=await p.$queryRawUnsafe(\"SELECT COUNT(*) AS n FROM online_recharge_tasks "
            "WHERE status IN ('queued','running') OR lease_expires_at>UTC_TIMESTAMP(6)\");"
            "console.log(JSON.stringify({busy:Number(r[0].n)}))})().catch(()=>process.exitCode=1)"
            ".finally(()=>p.$disconnect());")
    need(json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code)) == {'busy': 0},
         'ONLINE_TASK_ACTIVE')


def baseline(d, contract):
    previous = (BASE / 'current').resolve()
    need(previous == Path(contract['current']) and previous.parent == BASE / 'releases',
         'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'], 'MANIFEST_CHANGED')
    states = snapshot(d, previous)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need(all(digest((previous / name).read_bytes()) == sha
             for name, sha in contract['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    code = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(" + json.dumps(MODULE) + ")).digest('hex'))"
    need(d.compose(previous, 'exec', '-T', 'api', 'node', '-e', code) == contract['apiValidationSha256'],
         'API_CONTENT_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    verify_admin_content(d, states['admin'], contract)
    guards(d, previous, states, contract)
    return previous, raw, states


def configuration(d, state):
    row = json.loads(d.run('docker', 'inspect', state['containerId']))[0]
    value = {key: copy.deepcopy(row[key]) for key in ('Config', 'HostConfig', 'Mounts')}
    value['Mounts'] = sorted(value['Mounts'], key=lambda m: (m.get('Destination', ''), m.get('Source', '')))
    config = value['Config']
    config['Hostname'] = '${CONTAINER}'
    config['Image'] = '${IMAGE}'
    labels = config.get('Labels', {})
    for key in tuple(labels):
        if key in ('org.opencontainers.image.revision', 'id-business-v2.recharge-record-build-proof-sha256'):
            labels.pop(key)
        elif key in ('com.docker.compose.image', 'com.docker.compose.config-hash',
                     'com.docker.compose.project.config_files', 'com.docker.compose.project.working_dir',
                     'com.docker.compose.project.environment_file', 'com.docker.compose.depends_on',
                     'com.docker.compose.replace'):
            labels.pop(key)
    if state is not None and config.get('Labels', {}).get('com.docker.compose.service') == 'online-recharge':
        value['HostConfig']['NetworkMode'] = 'container:${API}'
    return fingerprint(value)


def download(url, cap):
    need(url.startswith('https://github.com/wangchaozhuanyong/id-business-system/releases/download/recharge-record-'),
         'ARTIFACT_LOCATION_INVALID')
    with urllib.request.urlopen(url, timeout=60) as response:
        raw = response.read(cap + 1)
    need(0 < len(raw) <= cap, 'ARTIFACT_TOO_LARGE')
    return raw


def release(plan, contract, d):
    need(plan['mode'] in ('preflight', 'release', 'readback'), 'MODE_INVALID')
    need(re.fullmatch('[a-f0-9]{40}', plan['commit']) and re.fullmatch('[a-f0-9]{40}', plan['tree'])
         and re.fullmatch('[0-9]+', plan['workflowRunId'])
         and re.fullmatch('[0-9]+', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    os.umask(0o077)
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE,
                 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'recharge-record-preservation.json').read_bytes())
            states = snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED),
                 'READBACK_SERVICES_CHANGED')
            for name, expected in {**contract['changedSources'], **contract['publishedAdminSources']}.items():
                path = target / name
                need(path.resolve().is_relative_to(target) and not path.is_symlink()
                     and digest(path.read_bytes()) == expected, 'READBACK_HOST_SOURCE_CHANGED')
            for name, expected in (('recharge-record-release.py', plan['controllerSha256']),
                                   ('remote-deploy.py', plan['releaseUtilitySha256']),
                                   ('recharge-record-contract.json', plan['contractSha256'])):
                need(digest((target / 'scripts/production-release' / name).read_bytes()) == expected,
                     'READBACK_EXECUTOR_SOURCE_CHANGED')
            guards(d, target, states, contract)
            code = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(" + json.dumps(MODULE) + ")).digest('hex'))"
            need(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code) == receipt['apiValidationSha256'],
                 'READBACK_CONTENT_CHANGED')
            proof_raw = (target / 'recharge-record-build-proof.json').read_bytes()
            need(digest(proof_raw) == receipt['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(proof_raw)
            current_admin_files = {n.removeprefix('admin/html/'): sha for n, sha in proof['files'].items()
                                   if n.startswith('admin/html/')}
            verify_admin_content(d, states['admin'], {**contract, 'publicFiles': current_admin_files,
                                                     'preservedAdminFilesSha256': fingerprint(current_admin_files)})
            fixture = {'callback_operation': 'restore', 'callback_http_status': 409,
                       'callback_error_code': 'CONFLICT', 'callback_failure_kind': 'http',
                       'callback_business_reason': 'callback_previous_payment_unverified',
                       'callback_request_id': '11111111-1111-4111-8111-111111111111'}
            smoke = "const m=require(" + json.dumps(MODULE) + ");const wanted=" + json.dumps(fixture)
            smoke += ";const actual=m.safeDocument({...wanted,raw_body:'discarded-fixture'});"
            smoke += "console.log(JSON.stringify({preserved:Object.keys(wanted).every(k=>actual[k]===wanted[k]),rawRejected:!('raw_body' in actual)}));"
            need(json.loads(d.compose(target, 'exec', '-T', 'api', 'node', '-e', smoke))
                 == {'preserved': True, 'rawRejected': True}, 'READBACK_DIAGNOSTIC_CONTRACT_FAILED')
            return {'status': 'RECHARGE_RECORD_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'images': receipt['images'], 'preservedServices': list(PRESERVED),
                    'onlineMode': engine_idle(d, states['online-recharge'], contract)['mode'],
                    'migrationPerformed': False, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, contract)
        models = {name: configuration(d, before[name]) for name in ('api', 'admin', 'online-recharge')}
        if plan['mode'] == 'preflight':
            return {'status': 'RECHARGE_RECORD_PREFLIGHT_VERIFIED', 'commit': plan['commit'],
                    'currentManifestSha256': digest(raw_manifest), 'servicesSha256': fingerprint(before),
                    'migrationPerformed': False, 'businessActions': 0}
        stage = BASE / '.staging' / ('recharge-record-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        artifact = download(plan['artifactUrl'], 16 * 1024**2)
        need(digest(artifact) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        (stage / 'artifact.tar.gz').write_bytes(artifact)
        payload = safe_archive(artifact, stage / 'content')
        proof = validate_proof(json.loads((payload / 'build-proof.json').read_bytes()), plan, contract, payload)
        need(digest((payload / 'build-proof.json').read_bytes()) == plan['buildProofSha256'], 'PROOF_CHANGED')
        images = {}
        for role in ('api', 'admin'):
            source = payload / role
            base_image = before[role]['image']
            original = json.loads(d.run('docker', 'image', 'inspect', base_image))[0]
            base_reference = base_image_reference(d, before[role])
            copy_line = ('COPY recharge-validation.js ' + MODULE + '\n') if role == 'api' else (
                'COPY html/ /usr/share/nginx/html/\n'
                'RUN find /usr/share/nginx/html -type d -exec chmod 755 {} + && '
                'find /usr/share/nginx/html -type f -exec chmod 644 {} +\n')
            original_user = original['Config'].get('User') or ''
            switch_user = role == 'admin' and original_user not in ('', 'root', '0')
            dockerfile = 'FROM ' + base_reference + '\n' + ('USER root\n' if switch_user else '') + copy_line
            dockerfile += 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" '
            dockerfile += 'id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n'
            need(re.fullmatch('[a-f0-9]{64}', plan['buildProofSha256']), 'PROOF_ID_INVALID')
            if switch_user:
                dockerfile += 'USER ' + original_user + '\n'
            (source / 'Dockerfile').write_text(dockerfile)
            reference = 'id-business-v2-records:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            build_image(d, source, reference, role, before[role], stage)
            need(base_image_reference(d, before[role]) == base_reference, 'BASE_REFERENCE_CHANGED')
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'],
                 'BASE_LAYERS_CHANGED')
            need({k: v for k, v in built['Config'].items() if k != 'Labels'}
                 == {k: v for k, v in original['Config'].items() if k != 'Labels'},
                 'IMAGE_CONFIGURATION_CHANGED')
            labels = {**(original['Config'].get('Labels') or {}),
                      'org.opencontainers.image.revision': plan['commit'],
                      'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}
            need(built['Config']['Labels'] == labels, 'IMAGE_LABELS_CHANGED')
            images[role] = {'reference': reference, 'imageId': built['Id']}
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '101:101',
              '--entrypoint', 'sh', images['admin']['reference'], '-c',
              'test -r /usr/share/nginx/html/index.html && test -x /usr/share/nginx/html/assets')
        # Candidate images are recoverable from the native CI artifact and the
        # protected predecessor. No historical proof is synthesized.
        need(baseline(d, contract)[1:] == (raw_manifest, before), 'BASELINE_MOVED')
        backup = d.fresh_backup(previous)
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-recharge-record')
        need(not target.exists(), 'RELEASE_DIRECTORY_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name, expected in {**contract['changedSources'], **contract['publishedAdminSources']}.items():
            path = target / name
            source = payload / 'source' / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink()
                 and digest(source.read_bytes()) == expected, 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(source.read_bytes())
            path.chmod(0o644)
        # Keep the exact executed controls alongside the native build proof.
        for source, name, expected in (
            (Path(__file__), 'recharge-record-release.py', plan['controllerSha256']),
            (Path(d.__file__), 'remote-deploy.py', plan['releaseUtilitySha256']),
            (Path(__file__).with_name('recharge-record-contract.json'), 'recharge-record-contract.json', plan['contractSha256'])
        ):
            need(source.is_file() and digest(source.read_bytes()) == expected, 'EXECUTED_CONTROL_CHANGED')
            (target / 'scripts/production-release' / name).write_bytes(source.read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in ('api', 'admin'):
            override['services'][role]['image'] = images[role]['reference']
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        need(baseline(d, contract)[1:] == (raw_manifest, before), 'BASELINE_MOVED')
        # The existing enabled sidecar shares the API's network namespace.
        # Rebind it after replacing the API; its image, settings and volume stay.
        d.compose(previous, 'stop', 'online-recharge', timeout=90)
        failure_path = stage / 'switch-state.json'
        failure_path.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target),
                                            'previous': str(previous), 'commit': plan['commit']}) + '\n')
        d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
        d.wait_healthy(target, 'api')
        d.wait_healthy(target, 'admin')
        d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
        d.wait_healthy(target, 'online-recharge')
        after = snapshot(d, target)
        need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
        for role in ('api', 'admin', 'online-recharge'):
            need(configuration(d, after[role]) == models[role], 'RUNTIME_CONFIGURATION_CHANGED')
            need(after[role]['environmentSha256'] == before[role]['environmentSha256'], 'ENVIRONMENT_CHANGED')
        need(all(after[n]['image'] == images[n]['imageId'] for n in ('api', 'admin')),
             'IMAGE_MISMATCH')
        need(after['online-recharge']['image'] == before['online-recharge']['image'], 'ONLINE_IMAGE_CHANGED')
        engine_idle(d, after['online-recharge'], contract, wait_connected=True)
        metadata = json.loads(d.run('docker', 'inspect', after['online-recharge']['containerId']))[0]
        need(metadata['HostConfig']['NetworkMode'] == 'container:' + after['api']['containerId'],
             'ONLINE_BINDING_INVALID')
        guards(d, target, after, contract)
        request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=25) as response:
            public = response.read(2 * 1024**2)
        need(digest(public) == proof['files']['admin/html/index.html']
             and ('v2-' + plan['commit']).encode() in public, 'PUBLIC_INDEX_MISMATCH')
        receipt = {'status': 'RECHARGE_RECORD_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
                   'images': images, 'before': before, 'after': after, 'backup': backup,
                   'apiValidationSha256': proof['files']['api/recharge-validation.js'],
                   'workflowRunId': plan['workflowRunId'], 'artifactSha256': plan['artifactSha256'],
                   'buildProofSha256': plan['buildProofSha256'],
                   'preservedServices': list(PRESERVED), 'onlineMode': contract['engineHealth']['mode'],
                   'migrationPerformed': False, 'businessActions': 0}
        (target / 'recharge-record-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'recharge-record-build-proof.json').write_bytes((payload / 'build-proof.json').read_bytes())
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch=plan['branch'],
                        previousCommit=contract['sourceBaseline'], previousRelease=str(previous),
                        previousManifestSha256=digest(raw_manifest), scope=SCOPE, status='DEPLOYED',
                        validationRun=plan['workflowRunId'], servicesUpdated=['api', 'admin'],
                        dependentServiceRebound='online-recharge', newMigrations=[],
                        migrationPerformed=False, paymentActions=0,
                        deploymentMethod='NATIVE_CI_APPROVED_SSM_FORWARD',
                        compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'],
                                          'validationRun': plan['workflowRunId']},
                        sourceProjection={'sourceBaseline': contract['sourceBaseline'],
                                          'changedSources': contract['changedSources'],
                                          'buildProofSha256': plan['buildProofSha256'],
                                          'publishedAdminBaseCommit': contract['preservedAdminCommit'],
                                          'publishedAdminSources': contract['publishedAdminSources'],
                                          'preservedEngineCommit': contract['preservedEngineCommit']},
                        sourceLayout='PUBLISHED_API_AND_ADMIN_WITH_DIAGNOSTICS_AND_PUBLISHED_ONLINE_OVERLAY',
                        servicesBefore=before, servicesAfter=after, actualDeployment=receipt,
                        rechargeRecordPublication={'artifactSha256': plan['artifactSha256'],
                                                   'buildProofSha256': plan['buildProofSha256'],
                                                   'backup': backup})
        manifest.pop('acceptedSwitchCommandId', None)
        manifest.pop('publicationFinalization', None)
        manifest.pop('deploymentRun', None)
        for role in ('api', 'admin'):
            manifest['images'][role] = {'reference': images[role]['reference'],
                                        'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        manifest['images']['online-recharge'] = {'reference': before['online-recharge']['reference'],
                                                 'digest': before['online-recharge']['image'],
                                                 'sourceCommit': contract['preservedEngineCommit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-recharge-record')
        failure_path.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {key: receipt[key] for key in ('status', 'commit', 'tree', 'images', 'workflowRunId',
                                             'buildProofSha256', 'preservedServices', 'onlineMode',
                                             'migrationPerformed', 'businessActions')}


def load_utilities(path, expected):
    need(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == expected,
         'RELEASE_UTILITY_CHANGED')
    spec = importlib.util.spec_from_file_location('recharge_record_release_utilities', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(module.BASE == BASE, 'RELEASE_BASE_CHANGED')
    return module
