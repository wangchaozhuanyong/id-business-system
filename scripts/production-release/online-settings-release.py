"""Finite API/Admin/sidecar overlay; preserve all other roles, data and runtime settings."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
SCOPE = 'ONLINE_SETTINGS_REGIONS_HELP_AND_CDK_COUNT'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_SETTINGS_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def download_artifact(plan):
    expected = ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                'online-settings-' + plan['commit'] + '/online-settings-artifact.tar.gz')
    need(plan['artifactUrl'] == expected, 'ARTIFACT_LOCATION_INVALID')
    cap = 24 * 1024**2
    with urllib.request.urlopen(expected, timeout=60) as response:
        raw = response.read(cap + 1)
    need(0 < len(raw) <= cap and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
    return raw


def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_proof(proof, plan, contract, files):
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE == contract['scope']
         and all(proof.get(key) == plan[key] for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == contract['sources']
         and proof.get('afterEngineFiles') == contract['afterEngineFiles']
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminSourceReproduced') is True
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    declarations = contract.get('apiDeclarationOnly', {})
    expected_modules = {name.removesuffix('.js') + ext for name in contract['apiModules'] for ext in ('.js', '.js.map', '.d.ts')} | set(declarations)
    need(set(proof.get('apiModules', {})) == expected_modules, 'API_MODULE_SCOPE_CHANGED')
    need(all(name.startswith('id-business-v2/online-recharge/') and name.endswith('.d.ts')
             and '..' not in Path(name).parts and re.fullmatch('[a-f0-9]{64}', digest)
             and proof['apiModules'].get(name) == digest for name, digest in declarations.items()), 'API_DECLARATION_CHANGED')
    expected = {**{'source/' + name: value for name, value in contract['sources'].items()},
                **{'api/modules/' + name: value for name, value in proof['apiModules'].items()},
                **{'admin/html/' + name: value for name, value in proof['adminFiles'].items()},
                **{'engine/' + name: value for name, value in contract['afterEngineFiles'].items() if contract['beforeEngineFiles'].get(name) != value}}
    need(files == expected == proof['files'] and 'index.html' in proof['baselineAdminFiles']
         and 'index.html' in proof['adminFiles'], 'PAYLOAD_SCOPE_CHANGED')


def read_hashes(d, container, root, expected):
    names = sorted(expected)
    need(all(re.fullmatch(r'[A-Za-z0-9_./-]+', name) and '..' not in Path(name).parts and not name.startswith('/') for name in names), 'FILE_PATH_INVALID')
    values = {}
    for offset in range(0, len(names), 80):
        result = d.run('docker', 'exec', container, 'sha256sum', *(root + name for name in names[offset:offset + 80]), timeout=60)
        for line in result.splitlines():
            digest, name = line.split('  ', 1)
            values[name.removeprefix(root)] = digest
    need(values == expected, 'RUNTIME_CONTENT_CHANGED')


def verify_image(original, built, plan):
    layers = original['RootFS']['Layers']
    need(built['RootFS']['Layers'] == layers + built['RootFS']['Layers'][len(layers):]
         and len(built['RootFS']['Layers']) == len(layers) + 1, 'BASE_LAYERS_CHANGED')
    load('recharge-source-recovery-release.py').verify_image_configuration(original['Config'], built['Config'])
    expected = {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'],
                'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}
    need(built['Config'].get('Labels') == expected, 'IMAGE_LABELS_CHANGED')


def baseline(d, contract, h):
    previous = (BASE / 'current').resolve()
    need(str(previous) == contract['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    for overlay in contract['publishedOverlays']:
        need(re.fullmatch('[a-z0-9-]+-build-proof.json', overlay['proofFile'])
             and sha((previous / overlay['proofFile']).read_bytes()) == overlay['proofSha256'], 'PUBLISHED_OVERLAY_PROOF_CHANGED')
    states = h.snapshot(d, previous)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
    need(all(sha((previous / name).read_bytes()) == expected for name, expected in contract['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(contract['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and normalizer.is_file() and not normalizer.is_symlink()
         and sha(normalizer.read_bytes()) == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202', 'BACKUP_NORMALIZER_CHANGED')
    h.guards(d, previous, states, contract)
    read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/id-business-v2/online-recharge/', contract['beforeApiOnlineFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], contract['beforeEngineFiles'])
    return previous, raw, states


def smoke(d, target, states, proof, contract, h):
    read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', proof['apiModules'])
    read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], contract['afterEngineFiles'])
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0] == contract['nginxSha256'], 'NGINX_CHANGED')
    h.engine_idle(d, states['online-recharge'], contract, wait_connected=True)
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
    need(all(states[role] == contract['services'][role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all(states[role]['environmentSha256'] == contract['services'][role]['environmentSha256'] for role in UPDATED), 'ENVIRONMENT_CHANGED')


def release(plan, contract):
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']), 'IDENTITY_INVALID')
    need(sha(Path(__file__).with_name('online-settings-contract.json').read_bytes()) == plan['contractSha256'], 'CONTRACT_CHANGED')
    for name, expected in plan['controlSources'].items():
        need(sha(Path(__file__).with_name(name).read_bytes()) == expected, 'CONTROL_SOURCE_CHANGED')
    h = load('recharge-record-release.py')
    d = h.load_utilities(Path(__file__).with_name('remote-deploy.py'), plan['controlSources']['remote-deploy.py'])
    a = load('recharge-availability-release.py')
    p = load('proxy-result-identity-release.py')
    p.SCOPE = SCOPE
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'online-settings-preservation.json').read_bytes())
            raw_proof = (target / 'online-settings-build-proof.json').read_bytes()
            need(sha(raw_proof) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(raw_proof)
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, target, states, proof, contract, h)
            h.guards(d, target, states, contract)
            return {'status': 'ONLINE_SETTINGS_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, contract, h)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_SETTINGS_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-settings-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        artifact = download_artifact(plan)
        payload = h.safe_archive(artifact, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, contract, files)
        # Reproduce the live Admin source even when older hashed assets are retained.
        read_hashes(d, before['admin']['containerId'], '/usr/share/nginx/html/', proof['baselineAdminFiles'])
        images = {}
        for role, copy_line in [('api', 'COPY modules/ /app/apps/api/dist/'), ('admin', 'COPY html/ /usr/share/nginx/html/'), ('online-recharge', 'COPY source/ /workspace/engine/')]:
            context = stage / ('image-' + role)
            context.mkdir()
            source = payload / ('engine' if role == 'online-recharge' else role)
            if role == 'online-recharge':
                shutil.copytree(source, context / 'source')
            else:
                for entry in source.iterdir():
                    if entry.is_dir():
                        shutil.copytree(entry, context / entry.name)
            a.normalize_image_context(context)
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = 'id-business-v2-online-settings:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            base_ref = h.base_image_reference(d, before[role])
            (context / 'Dockerfile').write_text('FROM ' + base_ref + '\n' + copy_line + '\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            verify_image(original, built, plan)
            images[role] = {'reference': reference, 'imageId': built['Id']}
        baseline(d, contract, h)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-settings')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in contract['sources']:
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name in [*plan['controlSources'], 'online-settings-contract.json']:
            path = target / 'scripts/production-release' / name
            path.write_bytes(Path(__file__).with_name(name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        baseline(d, contract, h)
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(contract)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
        try:
            fence.acquire()
            d.compose(previous, 'stop', 'online-recharge', timeout=90)
            fence.check_idle()
            d.compose(previous, 'stop', 'api', timeout=90)
            fence.check_idle()
            fence.close()
            d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
            d.wait_healthy(target, 'api')
            d.wait_healthy(target, 'admin')
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[role]['image'] == images[role]['imageId'] for role in UPDATED), 'IMAGE_CHANGED')
            smoke(d, target, after, proof, contract, h)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target), 'previous': str(previous), 'businessActions': 0}) + '\n')
            raise
        finally:
            fence.close()
            p.release_markers(marker)
        h.guards(d, target, after, contract)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after, 'images': images,
                   'backup': backup, 'artifactSha256': plan['artifactSha256'], 'buildProofSha256': plan['buildProofSha256'],
                   'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
        (target / 'online-settings-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'online-settings-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                        previousCommit=contract['expectedCurrent'], previousRelease=str(previous),
                        previousManifestSha256=sha(raw_manifest), status='DEPLOYED', servicesUpdated=list(UPDATED),
                        newMigrations=[], migrationPerformed=False, paymentActions=0, onlineSettingsPublication=receipt)
        for role in UPDATED:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
            projections = manifest.setdefault('roleSourceProjections', {})
            projections[role] = {'kind': 'PUBLISHED_PREDECESSOR_PLUS_ONLINE_SETTINGS',
                                 'commit': plan['commit'], 'parentProjection': projections.get(role),
                                 'buildProofSha256': plan['buildProofSha256'],
                                 'sources': {name: value for name, value in contract['sources'].items()
                                             if (name.startswith('apps/admin/') if role == 'admin'
                                                 else name.startswith(contract['engineRoot'] + '/') if role == 'online-recharge'
                                                 else name.startswith('apps/api/') and not name.startswith(contract['engineRoot'] + '/'))}}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-settings')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {'status': 'ONLINE_SETTINGS_DEPLOYED', 'commit': plan['commit'], 'images': images, 'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
