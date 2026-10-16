"""API-only forward publication; preserve payment engines, data and other services."""
import datetime
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
HERE = Path(__file__).resolve().parent
ENV_KEYS = ('ONLINE_RECHARGE_VENDURE_KEY', 'ONLINE_RECHARGE_VENDURE_SOURCE_IPS')


def need(value, code):
    if not value:
        raise RuntimeError('GPT_RECHARGE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name, controls):
    path = HERE / name
    need(sha(path.read_bytes()) == controls[name], 'CONTROL_CHANGED')
    spec = importlib.util.spec_from_file_location('gpt_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configuration(d, state, allow_credentials=False):
    row = json.loads(d.run('docker', 'inspect', state['containerId']))[0]
    value = {key: row[key] for key in ('Config', 'HostConfig', 'Mounts')}
    config = value['Config']
    config['Hostname'], config['Image'] = '${CONTAINER}', '${IMAGE}'
    config['Env'] = sorted(v for v in config.get('Env', [])
                           if not (allow_credentials and v.split('=', 1)[0] in ENV_KEYS))
    labels = config.get('Labels', {})
    for key in list(labels):
        if key.startswith('com.docker.compose.') and key not in ('com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.container-number', 'com.docker.compose.oneoff'):
            labels.pop(key)
        elif key in ('org.opencontainers.image.revision', 'id-business-v2.recharge-record-build-proof-sha256'):
            labels.pop(key)
    value['Mounts'].sort(key=lambda v: (v['Destination'], v['Source']))
    if value['HostConfig'].get('Binds'):
        value['HostConfig']['Binds'].sort()
    if state['reference'] and config.get('Labels', {}).get('com.docker.compose.service') == 'online-recharge':
        value['HostConfig']['NetworkMode'] = 'container:${API}'
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def read_modules(d, state, expected):
    names = sorted(expected)
    actual = {}
    for offset in range(0, len(names), 60):
        prefix = '/app/apps/api/dist/'
        result = d.run('docker', 'exec', state['containerId'], 'sha256sum',
                       *(prefix + name for name in names[offset:offset + 60]))
        for row in result.splitlines():
            value, name = row.split('  ', 1)
            actual[name.removeprefix(prefix)] = value
    need(actual == expected, 'API_CONTENT_CHANGED')


def baseline(d, h, c):
    previous = (BASE / 'current').resolve()
    need(str(previous) == c['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == c['manifestSha256'] and json.loads(raw)['commit'] == c['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states == c['services'], 'SERVICES_CHANGED')
    need({role: configuration(d, state, role == 'api') for role, state in states.items()}
         == c['runtimeConfigurationSha256'], 'CONFIGURATION_CHANGED')
    need(all(sha((previous / name).read_bytes()) == expected for name, expected in c['configurationSha256'].items()), 'HOST_CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, previous, states, c)
    read_modules(d, states['api'], c['baselineApiJs'])
    return previous, raw, states


def smoke(d, h, target, states, proof, c):
    read_modules(d, states['api'], {**c['baselineApiJs'], **{n: v for n, v in proof['apiModules'].items() if n.endswith('.js')}})
    preserved = set(states) - {'api', 'online-recharge'}
    need(all(states[role] == c['services'][role] for role in preserved), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['image'] == c['services']['online-recharge']['image']
         and states['online-recharge']['environmentSha256'] == c['services']['online-recharge']['environmentSha256'], 'ENGINE_CHANGED')
    need({role: configuration(d, state, role == 'api') for role, state in states.items()}
         == c['runtimeConfigurationSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)
    # Config is read-only; no code submission, session or execution is involved.
    script = "fetch('http://127.0.0.1:3000/api/id-business-v2/online-recharge/integrations/vendure/config',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>{if(r.status!==403)process.exit(1);console.log('GPT_UNAUTHORIZED_REJECTED')}).catch(()=>process.exit(1))"
    need(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', script) == 'GPT_UNAUTHORIZED_REJECTED', 'AUTH_SMOKE_FAILED')


def copy_private_configuration(previous, target):
    """Detach inherited config links before writing candidate-only credentials or images."""
    for name in ('.env.aws.production', 'compose.release.json'):
        source, destination = previous / name, target / name
        need(source.is_file() and destination.is_file(), 'CONFIGURATION_SOURCE_MISSING')
        need(not destination.is_symlink() or destination.resolve() == source.resolve(),
             'CONFIGURATION_LINK_CHANGED')
        raw = source.read_bytes()
        need(destination.read_bytes() == raw, 'CONFIGURATION_COPY_CHANGED')
        temporary = destination.with_name('.' + name + '.gpt-private-' + secrets.token_hex(8))
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
            need(not destination.is_symlink() and destination.read_bytes() == raw,
                 'PRIVATE_CONFIGURATION_NOT_DETACHED')
        finally:
            if temporary.exists():
                temporary.unlink()


@contextmanager
def guarded_switch(fence, marker, publisher, stage, plan):
    try:
        yield
    except BaseException:
        (stage / 'switch-recovery.json').write_text(json.dumps({
            'status': 'NEEDS_FORWARD_DIAGNOSIS', 'commit': plan['commit'],
            'maintenanceHeld': True, 'rollbackPerformed': False,
            'switchMayHaveStarted': True}) + '\n')
        raise
    finally:
        fence.close()
    publisher.release_markers(marker)


def release(plan, c):
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']), 'IDENTITY_INVALID')
    need(sha((HERE / 'gpt-recharge-contract.json').read_bytes()) == plan['contractSha256'], 'CONTRACT_CHANGED')
    h = load('recharge-record-release.py', plan['controlSources'])
    d = h.load_utilities(HERE / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    a = load('recharge-availability-release.py', plan['controlSources'])
    p = load('proxy-result-identity-release.py', plan['controlSources'])
    p.SCOPE = c['scope']
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == c['scope'], 'READBACK_CURRENT_CHANGED')
            proof = json.loads((target / 'gpt-recharge-build-proof.json').read_bytes())
            states = h.snapshot(d, target)
            smoke(d, h, target, states, proof, c)
            h.guards(d, target, states, c)
            return {'status': 'GPT_RECHARGE_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': 'GPT_RECHARGE_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('gpt-recharge-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/gpt-recharge-' + plan['commit'] + '/gpt-recharge-artifact.tar.gz'
        need(plan['artifactUrl'] == expected, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected, timeout=60) as response:
            artifact = response.read(4 * 1024**2 + 1)
        need(0 < len(artifact) <= 4 * 1024**2 and sha(artifact) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(artifact, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        need(proof['commit'] == plan.get('buildCommit', plan['commit']) and proof['tree'] == plan.get('buildTree', plan['tree'])
             and proof['sourceReviewCommit'] == c['sourceReviewCommit']
             and proof['contractSha256'] == plan['contractSha256'] and proof['reviewedSources'] == c['sources']
             and proof['baselineApiReproduced'] is True and proof['businessActions'] == 0, 'PROOF_IDENTITY_CHANGED')
        expected_files = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                          **{'source/' + n: v for n, v in proof['sources'].items()}}
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        need(files == expected_files and set(proof['sources']) == set(c['sources']), 'PAYLOAD_SCOPE_CHANGED')
        context = stage / 'image-api'
        shutil.copytree(payload / 'api', context)
        a.normalize_image_context(context)
        reference = 'id-business-v2-gpt-recharge:' + plan['commit'] + '-' + plan['workflowRunId']
        base_ref = h.base_image_reference(d, before['api'])
        (context / 'Dockerfile').write_text('FROM ' + base_ref + '\nCOPY modules/ /app/apps/api/dist/\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'api', before['api'], stage)
        original = json.loads(d.run('docker', 'image', 'inspect', before['api']['image']))[0]
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        need(built['RootFS']['Layers'][:-1] == original['RootFS']['Layers'], 'BASE_LAYERS_CHANGED')
        baseline(d, h, c)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-gpt-recharge')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        copy_private_configuration(previous, target)
        for name in proof['sources']:
            path = target / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
        private = BASE / '.secrets'
        private.mkdir(mode=0o700, exist_ok=True)
        key_file = private / 'gpt-recharge-vendure.key'
        need(not key_file.is_symlink(), 'KEY_PATH_INVALID')
        if not key_file.exists():
            fd = os.open(key_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write(secrets.token_hex(32))
        key = key_file.read_text().strip()
        need(re.fullmatch('[a-f0-9]{64}', key) and key_file.stat().st_mode & 0o077 == 0, 'KEY_INVALID')
        env_path = target / '.env.aws.production'
        lines = [line for line in env_path.read_text().splitlines() if line.split('=', 1)[0] not in ENV_KEYS]
        env_path.write_text('\n'.join(lines) + '\n' + ENV_KEYS[0] + '=' + key + '\n' + ENV_KEYS[1] + '=' + c['sourceIp'] + '\n')
        env_path.chmod(0o600)
        override_path = target / 'compose.release.json'
        override = json.loads(override_path.read_bytes())
        override['services']['api']['image'] = reference
        env = override['services']['api'].setdefault('environment', {})
        need(isinstance(env, dict), 'ENVIRONMENT_SHAPE_CHANGED')
        for name in ENV_KEYS:
            env[name] = '${' + name + ':?}'
        override_path.write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        override_path.chmod(0o600)
        baseline(d, h, c)
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, previous)
        with guarded_switch(fence, marker, p, stage, plan):
            fence.acquire()
            d.compose(previous, 'stop', 'online-recharge', timeout=90)
            fence.check_idle()
            d.compose(previous, 'stop', 'api', timeout=90)
            fence.check_idle()
            fence.close()
            d.compose(target, 'up', '-d', '--no-deps', 'api', timeout=180)
            d.wait_healthy(target, 'api')
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(after['api']['image'] == built['Id'], 'API_IMAGE_CHANGED')
            smoke(d, h, target, after, proof, c)
        h.guards(d, target, after, c)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after,
                   'backup': backup, 'artifactSha256': plan['artifactSha256'], 'businessActions': 0, 'migrationPerformed': False,
                   'buildCommit': proof['commit'], 'buildTree': proof['tree'], 'apiModules': proof['apiModules']}
        (target / 'gpt-recharge-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'gpt-recharge-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], scope=c['scope'], previousCommit=c['expectedCurrent'],
                        previousRelease=str(previous), servicesUpdated=['api'], servicesRebound=['online-recharge'],
                        migrationPerformed=False, paymentActions=0, gptRechargePublication=receipt)
        projections = manifest.get('roleSourceProjections', {})
        manifest['previousRoleSourceProjections'] = projections
        manifest['roleSourceProjections'] = {**projections, 'api': {
            'kind': c['scope'], 'commit': plan['commit'], 'sourceTree': plan['tree'],
            'parentProjection': projections.get('api'), 'publishedBaseImageId': before['api']['image'],
            'runtimeImageId': built['Id'], 'sourceDelta': proof['sources'],
            'runtimeModules': proof['apiModules'], 'buildCommit': proof['commit'],
            'buildTree': proof['tree'], 'buildProofSha256': plan['buildProofSha256']}}
        manifest['previousSourceProjection'] = manifest.get('sourceProjection')
        manifest['sourceProjection'] = {'kind': c['scope'], 'baselineCommit': c['expectedCurrent'],
            'sources': proof['sources'], 'buildCommit': proof['commit'], 'buildTree': proof['tree'],
            'buildProofSha256': plan['buildProofSha256']}
        manifest['images']['api'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-gpt-recharge')
        return {'status': 'GPT_RECHARGE_DEPLOYED', 'commit': plan['commit'], 'updatedServices': ['api'], 'businessActions': 0}
