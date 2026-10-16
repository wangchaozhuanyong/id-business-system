"""Finite three-file sidecar repair over the independently accepted checkout release."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
FILES = ('worker.cjs', 'test/runtime-main.test.cjs', 'SOURCE_MANIFEST.json')
SCOPE = 'ONLINE_BROWSER_DISPLAY_AUTH'
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')

def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_DISPLAY_' + code)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def validate_plan(plan, contract):
    need(plan['mode'] in ('preflight', 'release', 'readback')
         and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']), 'IDENTITY_INVALID')
    need(plan['basePlan']['commit'] == 'c8ce1a01a1a1e61bcc8de778dad331191319d645'
         and plan['basePlan']['contractSha256'] == plan['contractSha256'], 'PREDECESSOR_CHANGED')
    need(set(plan['sources']) == {ENGINE + '/' + name for name in FILES}
         and all(re.fullmatch('[a-f0-9]{64}', digest) for digest in plan['sources'].values()), 'SOURCE_SCOPE_CHANGED')
    before = contract['afterEngineFiles']
    after = {**before, **{name: plan['sources'][ENGINE + '/' + name] for name in FILES}}
    need(set(before) == set(after) and len(before) == 88 and before['worker.cjs'] != after['worker.cjs'], 'ENGINE_SCOPE_CHANGED')
    return before, after

def smoke(d, target, states, before, expected, old, h, contract):
    need(all(states[role] == before[role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(states['online-recharge']['environmentSha256'] == before['online-recharge']['environmentSha256'], 'ENVIRONMENT_CHANGED')
    old.read_hashes(d, states['online-recharge']['containerId'], '/workspace/engine/', expected)
    need(load('shared-bank-card-release.py').configuration_matches(h, d, states['online-recharge'], contract['runtimeConfigurationSha256']['online-recharge']), 'RUNTIME_CONFIGURATION_CHANGED')

def release(plan, contract):
    before_files, after_files = validate_plan(plan, contract)
    here = Path(__file__).resolve().parent
    need(sha((here / 'online-checkout-contract.json').read_bytes()) == plan['contractSha256'], 'CONTRACT_CHANGED')
    for name, expected in plan['controlSources'].items():
        need(sha((here / name).read_bytes()) == expected, 'CONTROL_CHANGED')
    old, h = load('online-checkout-release.py'), load('recharge-record-release.py')
    d = h.load_utilities(here / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    a, p = load('recharge-availability-release.py'), load('proxy-result-identity-release.py')
    if plan['mode'] != 'readback':
        old.release({**plan['basePlan'], 'mode': 'readback'}, contract)
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        current = (BASE / 'current').resolve()
        manifest_raw = (current / 'release-manifest.json').read_bytes()
        manifest = json.loads(manifest_raw)
        states = h.snapshot(d, current)
        if plan['mode'] == 'readback':
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE, 'READBACK_IDENTITY_CHANGED')
            receipt = json.loads((current / 'online-browser-display-auth-preservation.json').read_bytes())
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, current, states, receipt['before'], after_files, old, h, contract)
            h.guards(d, current, states, contract)
            return {'status': 'ONLINE_CHECKOUT_DISPLAY_READBACK_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        need(str(current) == plan['baselineCurrent'] and sha(manifest_raw) == plan['baselineManifestSha256']
             and manifest['commit'] == plan['basePlan']['commit'], 'BASELINE_CHANGED')
        need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
        before = states
        old.read_hashes(d, before['online-recharge']['containerId'], '/workspace/engine/', before_files)
        if plan['mode'] == 'preflight':
            return {'status': 'ONLINE_CHECKOUT_DISPLAY_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('online-browser-display-auth-' + plan['commit'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        context = stage / 'image'
        source = context / 'source'
        source.mkdir(parents=True)
        raw_base = 'https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/' + plan['commit'] + '/' + ENGINE + '/'
        for name in FILES:
            with urllib.request.urlopen(raw_base + name, timeout=30) as response:
                raw = response.read(512 * 1024 + 1)
            need(len(raw) <= 512 * 1024 and sha(raw) == after_files[name], 'SOURCE_CHANGED')
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        registry = json.loads((source / 'SOURCE_MANIFEST.json').read_bytes())
        need({row['path']: row['adaptedSha256'] for row in registry['files']} ==
             {name: value for name, value in after_files.items() if name != 'SOURCE_MANIFEST.json'}, 'SOURCE_FINGERPRINT_CHANGED')
        a.normalize_image_context(context)
        original = json.loads(d.run('docker', 'image', 'inspect', before['online-recharge']['image']))[0]
        reference = 'id-business-v2-online-display-auth:' + plan['commit']
        (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before['online-recharge'])
            + '\nCOPY source/ /workspace/engine/\nLABEL org.opencontainers.image.revision="' + plan['commit']
            + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'online-recharge', before['online-recharge'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        old.verify_image(original, built, plan)
        probe = d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs',
            '/tmp:rw,nosuid,size=512m,mode=1777', '--entrypoint', 'node', reference, '--test',
            '--test-name-pattern=^headed task children retain', 'test/runtime-main.test.cjs', timeout=75)
        need(re.search(r'(?:#|ℹ) pass 1\b', probe) is not None and re.search(r'(?:#|ℹ) fail 0\b', probe) is not None, 'HEADED_IMAGE_PROBE_FAILED')
        need(h.snapshot(d, current) == before, 'SERVICES_CHANGED')
        backup = h.fresh_scoped_backup(d, current, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-online-display-auth')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(current, target, symlinks=True)
        for name in FILES:
            path = target / ENGINE / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_SOURCE_CHANGED')
            path.write_bytes((source / name).read_bytes())
        shutil.copyfile(Path(__file__), target / 'scripts/production-release' / Path(__file__).name)
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['online-recharge']['image'] = reference
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        p.SCOPE = SCOPE
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(contract)(d, current)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target)}) + '\n')
        try:
            fence.acquire()
            d.compose(current, 'stop', 'online-recharge', timeout=90)
            fence.check_idle()
            fence.close()
            d.compose(target, 'up', '-d', '--no-deps', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(after['online-recharge']['image'] == built['Id'], 'IMAGE_CHANGED')
            smoke(d, target, after, before, after_files, old, h, contract)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target)}) + '\n')
            raise
        finally:
            fence.close()
        p.release_markers(marker)
        h.guards(d, target, after, contract)
        receipt = {'commit': plan['commit'], 'before': before, 'after': after, 'sources': plan['sources'],
            'qualitySourceEvidence': plan['qualitySourceEvidence'], 'image': built['Id'], 'backup': backup,
            'isolatedHeadedBrowserProbe': True, 'preservedServices': list(PRESERVED), 'businessActions': 0}
        (target / 'online-browser-display-auth-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], scope=SCOPE, previousCommit=plan['basePlan']['commit'],
            previousRelease=str(current), previousManifestSha256=sha(manifest_raw), status='DEPLOYED',
            servicesUpdated=['online-recharge'], migrationPerformed=False, newMigrations=[], paymentActions=0,
            onlineBrowserDisplayAuthPublication=receipt)
        manifest['images']['online-recharge'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['online-recharge'] = {'kind': 'PUBLISHED_PREDECESSOR_PLUS_DISPLAY_AUTH',
            'commit': plan['commit'], 'parentProjection': projections.get('online-recharge'),
            'sources': plan['sources']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-online-display-auth')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {'status': 'ONLINE_CHECKOUT_DISPLAY_DEPLOYED', 'commit': plan['commit'], 'preservedServices': list(PRESERVED),
            'isolatedHeadedBrowserProbe': True, 'migrationPerformed': False, 'businessActions': 0}
