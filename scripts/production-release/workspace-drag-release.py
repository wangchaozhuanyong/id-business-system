"""Admin-only card drag publication; every other running role is preserved."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')


def need(value, code):
    if not value:
        raise RuntimeError('WORKSPACE_DRAG_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def helpers():
    return load(Path(__file__).with_name('recharge-availability-release.py'), 'drag_admin_helpers')


def verify_image_configuration(original, built):
    for value in (original, built):
        marker = value.get('Image')
        need(marker in (None, '') or (isinstance(marker, str) and re.fullmatch('sha256:[a-f0-9]{64}', marker)), 'IMAGE_PARENT_MARKER_INVALID')
    need({k: v for k, v in built.items() if k not in ('Labels', 'Image')} ==
         {k: v for k, v in original.items() if k not in ('Labels', 'Image')}, 'IMAGE_CONFIGURATION_CHANGED')


def preserved(before, after):
    need(set(before) == set(after) and all(before[n] == after[n] for n in before if n != 'admin'), 'PRESERVED_SERVICES_CHANGED')


def validate_proof(proof, plan, c, payload, h):
    need(proof.get('version') == 1 and proof.get('scope') == c['scope']
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
             'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256', 'qualityVerification'))
         and proof.get('sources') == c['sources'] and proof.get('publishedProofSha256') == c['publishedProofSha256']
         and proof.get('browserChecks') == 13 and proof.get('updatedServices') == ['admin']
         and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
         and proof['businessActions'] == 0, 'PROOF_INVALID')
    files = h.file_inventory(payload)
    files.pop('build-proof.json', None)
    need(files == proof.get('files') and len(proof.get('baselineAdminFiles', {})) >= 250
         and len(proof.get('adminFiles', {})) >= 250
         and {n.removeprefix('admin/html/'): v for n, v in files.items() if n.startswith('admin/html/')} == proof['adminFiles']
         and {n.removeprefix('source/'): v for n, v in files.items() if n.startswith('source/')} == c['sources']
         and all(n.startswith(('source/', 'admin/html/')) for n in files), 'PAYLOAD_SCOPE_CHANGED')


def baseline(d, c, h, proof, expected=None):
    previous = (BASE / 'current').resolve()
    need(previous == Path(c['current']) and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == c['manifestSha256'] and json.loads(raw)['commit'] == c['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states['admin']['image'] == c['baselineAdminImage'] and shutil.disk_usage(BASE).free > 6 * 1024**3, 'BASELINE_OR_SPACE_CHANGED')
    helpers().verify_admin(d, states['admin'], proof['baselineAdminFiles'])
    receipt = helpers().runtime_receipt(previous, raw, states)
    receipt['nginxSha256'] = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
    if expected is not None:
        need(receipt == expected, 'RUNTIME_BASELINE_MOVED')
    return previous, raw, states, receipt


def smoke(d, target, proof, states, nginx):
    helpers().verify_admin(d, states['admin'], {**proof['baselineAdminFiles'], **proof['adminFiles']})
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0] == nginx, 'NGINX_CHANGED')
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        raw = response.read(2 * 1024**2)
    need(sha(raw) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in raw, 'PUBLIC_BUILD_CHANGED')
    for name, expected in proof['sources'].items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target)
             and sha(path.read_bytes()) == expected, 'HOST_SOURCE_CHANGED')


def release(plan, c, d, h):
    a = helpers()
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunId'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == c['scope'], 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'workspace-drag-preservation.json').read_bytes())
            proof_raw = (target / 'workspace-drag-build-proof.json').read_bytes()
            need(sha(proof_raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            states = h.snapshot(d, target)
            preserved(receipt['before'], states)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            need(all(sha((target / 'scripts/production-release' / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'READBACK_EXECUTOR_CHANGED')
            smoke(d, target, json.loads(proof_raw), states, receipt['nginxSha256'])
            return {'status': 'WORKSPACE_DRAG_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'updatedServices': ['admin'], 'preservedServices': sorted(n for n in states if n != 'admin'),
                    'migrationPerformed': False, 'businessActions': 0}
        stage = BASE / '.staging' / ('workspace-drag-' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + plan['mode'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/workspace-drag-' + plan['commit'] + '/workspace-drag-artifact.tar.gz'
        need(plan['artifactUrl'] == url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(url, timeout=60) as response:
            raw = response.read(32 * 1024**2 + 1)
        need(0 < len(raw) <= 32 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(raw, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        validate_proof(proof, plan, c, payload, h)
        previous, raw_manifest, before, observed = baseline(d, c, h, proof, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'WORKSPACE_DRAG_PREFLIGHT_VERIFIED', 'commit': plan['commit'],
                    'runtimeBaseline': observed, 'migrationPerformed': False, 'businessActions': 0}
        need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        original = json.loads(d.run('docker', 'image', 'inspect', before['admin']['image']))[0]
        a.normalize_image_context(payload / 'admin')
        reference = 'id-business-v2-workspace-drag:' + plan['commit'] + '-' + plan['workflowRunId']
        label = 'id-business-v2.recharge-record-build-proof-sha256'
        (payload / 'admin/Dockerfile').write_text('FROM ' + h.base_image_reference(d, before['admin'])
            + '\nCOPY html/ /usr/share/nginx/html/\nLABEL org.opencontainers.image.revision="'
            + plan['commit'] + '" ' + label + '="' + plan['buildProofSha256'] + '"\n')
        model = h.configuration(d, before['admin'])
        h.build_image(d, payload / 'admin', reference, 'admin', before['admin'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        verify_image_configuration(original['Config'], built['Config'])
        need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers']
             and built['Config']['Labels'] == {**(original['Config'].get('Labels') or {}),
                 'org.opencontainers.image.revision': plan['commit'], label: plan['buildProofSha256']}, 'IMAGE_LINEAGE_CHANGED')
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '101:101', '--entrypoint', 'sh', reference,
              '-c', 'test -r /usr/share/nginx/html/index.html && test -x /usr/share/nginx/html/assets')
        need(baseline(d, c, h, proof, plan['runtimeBaseline']) == (previous, raw_manifest, before, observed), 'BASELINE_MOVED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-workspace-drag')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in c['sources']:
            p = target / name
            need(not p.is_symlink() and p.resolve().is_relative_to(target), 'SOURCE_PATH_CHANGED')
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes((payload / 'source' / name).read_bytes())
            p.chmod(0o644)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(sha(raw) == expected, 'EXECUTOR_CHANGED')
            p = target / 'scripts/production-release' / name
            need(not p.is_symlink() and p.resolve().is_relative_to(target), 'EXECUTOR_PATH_CHANGED')
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['admin']['image'] = reference
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (stage / 'switch-state.json').write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target)}) + '\n')
        try:
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'admin', timeout=180)
            d.wait_healthy(target, 'admin')
            after = h.snapshot(d, target)
            preserved(before, after)
            need(after['admin']['image'] == built['Id'] and h.configuration(d, after['admin']) == model
                 and after['admin']['environmentSha256'] == before['admin']['environmentSha256'], 'ADMIN_CONFIGURATION_CHANGED')
            smoke(d, target, proof, after, observed['nginxSha256'])
        except Exception:
            preserved(before, h.snapshot(d, target))
            d.compose(previous, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'admin', timeout=180)
            d.wait_healthy(previous, 'admin')
            (stage / 'switch-state.json').write_text('{"status":"PREDECESSOR_ADMIN_RESTORED"}\n')
            raise
        receipt = {'status': 'WORKSPACE_DRAG_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
                   'before': before, 'after': after, 'image': {'reference': reference, 'imageId': built['Id']},
                   'nginxSha256': observed['nginxSha256'], 'updatedServices': ['admin'],
                   'workflowRunId': plan['workflowRunId'], 'migrationPerformed': False, 'businessActions': 0}
        (target / 'workspace-drag-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'workspace-drag-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest['previousAdminSourceProjection'] = manifest.get('adminSourceProjection')
        projection = {'kind': c['scope'], 'commit': plan['commit'], 'sourceTree': plan['tree'],
                      'parentProjection': manifest.get('adminSourceProjection'), 'sources': c['sources'],
                      'runtimeImageId': built['Id'], 'buildProofSha256': plan['buildProofSha256']}
        manifest['roleSourceProjections'] = {**manifest.get('roleSourceProjections', {}), 'admin': projection}
        manifest['adminSourceProjection'] = projection
        manifest['images']['admin'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=c['scope'],
            status='DEPLOYED', previousCommit=c['expectedCurrent'], previousRelease=str(previous),
            previousManifestSha256=sha(raw_manifest), servicesUpdated=['admin'], dependentServiceRebound=None,
            newMigrations=[], migrationPerformed=False, paymentActions=0, validationRun=plan['workflowRunId'],
            actualDeployment=receipt, deploymentMethod='NATIVE_CI_APPROVED_ADMIN_ONLY_SSM_FORWARD',
            previousSourceProjection=manifest.get('sourceProjection'),
            sourceProjection={'kind': c['scope'], 'changedSources': c['sources'], 'buildProofSha256': plan['buildProofSha256']},
            sourceLayout='PUBLISHED_PREDECESSOR_WITH_ADMIN_DRAG_OVERLAY',
            compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-workspace-drag')
        (stage / 'switch-state.json').write_text('{"status":"DEPLOYED"}\n')
        return {k: receipt[k] for k in ('status', 'commit', 'tree', 'image', 'updatedServices', 'migrationPerformed', 'businessActions')}
