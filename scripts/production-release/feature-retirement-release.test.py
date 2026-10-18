"""Pure/mocked retirement release controls. No Docker, website, or database starts."""
import copy
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('feature_retirement_release', Path(__file__).with_name('feature-retirement-release.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
OLD = m.digest(b'old')
NEW = m.digest(b'new')
COMPOSE = '''name: id-business-v2-prod
services:
  mysql:
    image: mysql:pinned
  auto-recharge:
    image: worker:pinned
  auto-registration:
    image: worker:registration
    environment:
      AUTO_RECHARGE_WORKER_ROLE: registration
    networks:
      - registration-control
      - registration-egress
  online-recharge:
    image: online:pinned
    network_mode: service:api
  api:
    image: api:pinned
    volumes:
      - auto_registration_data:/app/.runtime/auto-registration
      - online_recharge_data:/app/.runtime/online-recharge
    environment:
      AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051
      AUTO_RECHARGE_WORKER_URL: http://auto-recharge:8051
    networks:
      - default
      - registration-control
  admin:
    image: admin:pinned
  caddy:
    image: caddy:pinned
volumes:
  auto_registration_data:
  online_recharge_data:
networks:
  registration-control:
    internal: true
  registration-egress:
  default:
'''
CADDY = b'''{$APP_DOMAIN} {
\tencode zstd gzip
\t@registrationWorkspace path /api/id-business-v2/auto-registration/workspace /api/id-business-v2/auto-registration/workspace/*
\thandle @registrationWorkspace {
\t\t# Preserve the authenticated workspace's own frame and inline-script policy.
\t\treverse_proxy api:3000 {
\t\t\tflush_interval -1
\t\t}
\t}

\thandle {
\t\treverse_proxy admin:80
\t}
}
'''


def identity(role):
    return {'containerId': m.digest(role.encode()), 'image': 'sha256:' + OLD,
            'reference': role + ':pinned', 'startedAtSha256': m.digest(b'started'),
            'environmentSha256': OLD, 'health': None if role == 'caddy' else 'healthy', 'status': 'running'}


def row(role):
    state = identity(role)
    mounts = [{'Type': 'volume', 'Name': 'formal-online', 'Source': '/var/lib/docker/volumes/formal-online/_data',
               'Destination': '/app/.runtime/online-recharge' if role == 'api' else '/workspace/engine/runtime', 'RW': True}]
    if role not in ('api', 'online-recharge'):
        mounts = []
    if role == 'api':
        mounts.append({'Type': 'volume', 'Name': 'formal-registration', 'Source': '/var/lib/docker/volumes/formal-registration/_data',
                       'Destination': '/app/.runtime/auto-registration', 'RW': True})
    return {'Id': state['containerId'], 'Image': state['image'], 'State': {'StartedAt': 'started', 'Running': True},
            'Config': {'Image': state['reference'], 'Hostname': identity('api')['containerId'][:12] if role in ('api', 'online-recharge') else 'host',
                       'Env': ['AUTO_RECHARGE_WORKER_ROLE=registration'] if role == 'auto-registration' else ['KEEP=yes'],
                       'Labels': {'com.docker.compose.project': 'formal', 'com.docker.compose.service': role,
                                  'com.docker.compose.container-number': '1', 'org.opencontainers.image.revision': 'a' * 40}},
            'HostConfig': {'NetworkMode': 'container:' + identity('api')['containerId'] if role == 'online-recharge' else 'formal_default', 'PortBindings': {}},
            'Mounts': mounts, 'NetworkSettings': {'Networks': {'formal_default': {}, 'formal_registration-control': {}}}}


class Fixture(unittest.TestCase):
    def setUp(self):
        (ROOT / '.runtime').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='retirement-release-unit-', dir=ROOT / '.runtime')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.here = self.root / 'controllers'
        self.here.mkdir()
        self.base = self.root / 'server'
        (self.base / 'releases/old').mkdir(parents=True)
        self.patch_here = patch.object(m, 'HERE', self.here)
        self.patch_base = patch.object(m, 'BASE', self.base)
        self.patch_here.start(); self.patch_base.start()
        self.addCleanup(self.patch_here.stop); self.addCleanup(self.patch_base.stop)
        self.c = {'version': 1, 'scope': m.SCOPE, 'backupCreated': False, 'cleanupDataInRelease': False,
                  'migrationPerformed': False, 'businessActions': 0,
                  'databaseVerification': {'isolatedDatabaseStarted': False, 'migrationPerformed': False,
                      'productionDatabaseWrites': False, 'schemaChanged': False},
                  'sources': {'apps/api/src/keep.ts': NEW, 'apps/api/src/id-business-v2/auto-registration/old.ts': None},
                  'controlSources': {}, 'apiModules': {'keep.js': OLD, 'id-business-v2/auto-registration/old.js': OLD},
                  'sharedModules': {'index.js': OLD}, 'apiBaselineFiles': {}, 'sharedBaselineFiles': {},
                  'current': str(self.base / 'releases/old'), 'expectedCurrent': 'b' * 40, 'manifestSha256': OLD,
                  'services': {n: identity(n) for n in m.BEFORE}, 'runtimeConfigurationSha256': {n: OLD for n in m.BEFORE},
                  'configurationSha256': {'.env.aws.production': OLD, 'docker-compose.aws-mysql.yml': OLD,
                                          'compose.release.json': OLD, 'deploy/caddy/Caddyfile.aws': OLD},
                  'registrationVolume': 'formal-registration', 'onlineVolume': 'formal-online', 'retiredTerminalLeaseCount': 1,
                  'actualCaddyMountSource': str(self.base / 'releases/old/deploy/caddy/Caddyfile.aws'),
                  'actualCaddyMountFileSha256': m.digest(CADDY), 'publicFiles': {'index.html': OLD, 'assets/keep.js': OLD},
                  'retiredHostPaths': ['scripts/setup-auto-registration.mjs'], 'retiredAdminAssets': {},
                  'apiSourceBaseline': 'b' * 40, 'adminSourceBaseline': 'c' * 40, 'engineHealth': {}}
        for role in ('api', 'shared'):
            self.c[role + 'BaselineFiles'] = {n[:-3] + ext: v for n, v in self.c[role + 'Modules'].items() for ext in m.SUFFIXES}
        self.c['omittedApiDeclarations'] = {}
        self.c['apiCompiledBaselineFiles'] = dict(self.c['apiBaselineFiles'])
        self.c['adminBaselineFiles'] = dict(self.c['publicFiles'])
        self.plan = {'version': 1, 'scope': m.SCOPE, 'commit': 'a' * 40, 'tree': 'd' * 40, 'branch': 'main',
                     'workflowRunId': '123', 'workflowRunAttempt': '1', 'contractSha256': '',
                     'buildProofSha256': OLD, 'artifactSha256': OLD, 'mode': 'preflight', 'controlSources': {},
                     'artifactUrl': 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/feature-retirement-' + 'a' * 40 + '/feature-retirement-artifact.tar.gz',
                     'qualityVerification': {'runId': '456', 'commit': 'a' * 40, 'sourceTree': 'd' * 40,
                                            'path': '.github/workflows/quality.yml', 'conclusion': 'success'}}
        self.pin()

    def pin(self):
        raw = json.dumps(self.c).encode()
        (self.here / 'feature-retirement-contract.json').write_bytes(raw)
        self.plan['contractSha256'] = m.digest(raw)
        self.plan['controlSources'] = self.c['controlSources']

    def payload(self):
        payload = self.root / 'payload'
        payload.mkdir()
        files = {'source/apps/api/src/keep.ts': b'new', 'api/modules/keep.js': b'new',
                 'api/shared/index.js': b'new', 'admin/html/index.html': b'new', 'admin/html/assets/new.js': b'new'}
        deletions = {'version': 1, 'apiModules': {'id-business-v2/auto-registration/old' + ext: OLD for ext in m.SUFFIXES},
                     'sharedModules': {}, 'sources': ['apps/api/src/id-business-v2/auto-registration/old.ts']}
        files['deletions.json'] = (json.dumps(deletions, sort_keys=True, indent=2) + '\n').encode()
        for name, raw in files.items():
            path = payload / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        proof = {'version': 1, 'scope': m.SCOPE, 'commit': self.plan['commit'], 'tree': self.plan['tree'],
                 'workflowRunId': '123', 'workflowRunAttempt': '1', 'contractSha256': self.plan['contractSha256'],
                 'controlSources': {}, 'sources': self.c['sources'], 'apiModules': {'keep.js': NEW},
                 'apiDeletedModules': deletions['apiModules'], 'sharedModules': {'index.js': NEW}, 'sharedDeletedModules': {},
                 'adminFiles': {'index.html': NEW, 'assets/new.js': NEW}, 'files': m.inventory(payload),
                 'baselineApiReproduced': True, 'baselineAdminReproduced': True, 'baselineSharedReproduced': True,
                 'baselineApiCompiledReproduced': True, 'baselineApiFullInventoryReproduced': True, 'baselineApiDeclarationDifferences': {},
                 'omittedApiDeclarations': {}, 'omittedApiDeclarationsPackaged': False, 'omittedApiDeclarationsDeployed': False,
                 'updatedServices': ['api', 'admin'], 'databaseVerification': self.c['databaseVerification'],
                 'migrationPerformed': False, 'businessActions': 0, 'qualityVerification': self.plan['qualityVerification'],
                 'validation': {'scope': m.SCOPE, 'commit': self.plan['commit'], 'tree': self.plan['tree'],
                                'contractSha256': self.plan['contractSha256'], 'uiChecks': list(m.UI_CHECKS),
                                'browserReportSha256': OLD, 'status': 'PASS', 'businessActions': 0, 'externalRequests': 0}}
        (payload / 'build-proof.json').write_text(json.dumps(proof))
        return payload, proof


class IdentityTests(Fixture):
    def test_fixed_plan_accepts_only_pinned_predecessor(self):
        m.validate_plan(self.plan, self.c)
        for key, value in [('branch', 'other'), ('scope', 'OTHER'), ('artifactUrl', 'https://other.invalid/a'),
                           ('version', True), ('workflowRunId', '0'), ('artifactSha256', 'x'), ('extra', 1)]:
            with self.subTest(key=key):
                bad = {**self.plan, key: value}
                with self.assertRaises(RuntimeError):
                    m.validate_plan(bad, self.c)

    def test_contract_bytes_and_no_data_actions_are_required(self):
        for key, value in [('cleanupDataInRelease', True), ('backupCreated', True), ('businessActions', False),
                           ('registrationVolume', 'formal-online'), ('current', '/other/releases/a')]:
            with self.subTest(key=key):
                saved = self.c[key]; self.c[key] = value; self.pin()
                with self.assertRaises(RuntimeError):
                    m.validate_plan(self.plan, self.c)
                self.c[key] = saved
        self.pin()
        (self.here / 'feature-retirement-contract.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_CHANGED'):
            m.validate_plan(self.plan, self.c)

    def test_controls_allow_only_fixed_extra_build_paths(self):
        for name in ('apps/api/Dockerfile.mysql', 'package.json'):
            self.c['controlSources'] = {name: OLD}; self.pin()
            m.validate_plan(self.plan, self.c)
        self.c['controlSources'] = {'.env.aws.production': OLD}; self.pin()
        with self.assertRaisesRegex(RuntimeError, 'CONTROLLER_SCOPE'):
            m.validate_plan(self.plan, self.c)

    def test_no_secret_or_data_host_deletion(self):
        for name in ('.runtime/auto-registration/database.sqlite', '../scripts/registration.py',
                     'scripts/production-release/remote-deploy.py', 'backups/registration.sql'):
            self.c['retiredHostPaths'] = [name]; self.pin()
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                m.validate_plan(self.plan, self.c)

    def test_only_exact_registered_frontend_asset_can_be_removed(self):
        self.c['adminBaselineFiles']['assets/V2AppleMailboxes-abcd.js'] = OLD
        self.c['retiredAdminAssets'] = {'assets/V2AppleMailboxes-abcd.js': OLD}; self.pin()
        m.validate_plan(self.plan, self.c)
        for asset in ({'index.html': OLD}, {'assets/V2AppleMailboxes-abcd.js': NEW}):
            self.c['retiredAdminAssets'] = asset; self.pin()
            with self.assertRaisesRegex(RuntimeError, 'RETIRED_ADMIN_SCOPE'):
                m.validate_plan(self.plan, self.c)

    def test_proof_pins_every_file_and_deletion(self):
        payload, proof = self.payload()
        m.validate_proof(proof, self.plan, self.c, payload)
        (payload / 'api/modules/keep.js').write_text('tampered')
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
            m.validate_proof(proof, self.plan, self.c, payload)

    def test_missing_delta_or_unreviewed_delta_is_rejected(self):
        payload, proof = self.payload()
        for key, value in [('apiModules', {}), ('apiDeletedModules', {'outside.js': OLD}),
                           ('businessActions', False), ('migrationPerformed', True), ('baselineSharedReproduced', False)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_proof({**proof, key: value}, self.plan, self.c, payload)

    def test_unexpected_payload_source_is_rejected_even_with_inventory(self):
        payload, proof = self.payload()
        (payload / 'source/secret.env').write_text('synthetic')
        proof['files'] = m.inventory(payload); proof['files'].pop('build-proof.json')
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
            m.validate_proof(proof, self.plan, self.c, payload)

    def test_duplicate_json_and_nonfinite_values_are_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{bad'):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                m.closed_json(raw)

    def test_archive_rejects_links_escape_duplicates_and_expansion(self):
        for kind in ('link', 'escape', 'duplicate', 'large'):
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w:gz') as archive:
                name = '../payload/file' if kind == 'escape' else 'payload/file'
                entry = tarfile.TarInfo(name)
                if kind == 'link':
                    entry.type = tarfile.SYMTYPE; entry.linkname = '/etc/passwd'
                elif kind == 'large':
                    entry.size = 33 * 1024**2
                    archive.addfile(entry, io.BytesIO(b'0' * entry.size))
                    continue
                archive.addfile(entry, io.BytesIO(b''))
                if kind == 'duplicate':
                    archive.addfile(entry, io.BytesIO(b''))
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                m.safe_archive(raw.getvalue(), self.root / kind)


class ConfigurationTests(Fixture):
    def test_compose_removes_registration_volume_declaration_and_keeps_online_volume(self):
        result = m.retirement_compose(COMPOSE)
        self.assertNotIn('  auto-registration:', result)
        self.assertNotIn('registration-control', result)
        self.assertNotIn('AUTO_REGISTRATION_WORKER_URL', result)
        self.assertNotIn('auto_registration_data', result)
        self.assertIn('  online_recharge_data:', result)
        self.assertIn('online_recharge_data:/app/.runtime/online-recharge', result)
        self.assertIn('AUTO_RECHARGE_WORKER_URL: http://auto-recharge:8051', result)
        self.assertIn('network_mode: service:api', result)
        self.assertIn('image: mysql:pinned', result)

    def test_only_registration_base_mount_leaves_an_empty_list(self):
        source = COMPOSE.replace('      - online_recharge_data:/app/.runtime/online-recharge\n', '')
        result = m.retirement_compose(source)
        self.assertIn('    volumes: []\n    environment:', result)
        self.assertNotIn('auto_registration_data', result)
        self.assertIn('  online_recharge_data:', result)
        self.assertIn('image: mysql:pinned', result)

    @unittest.skipUnless(os.environ.get('GITHUB_ACTIONS') == 'true', 'Compose schema validation runs only in remote CI; no local Docker')
    def test_remote_compose_config_preserves_overlay_mount_after_base_retirement(self):
        source = COMPOSE.replace('      - online_recharge_data:/app/.runtime/online-recharge\n', '')
        base = self.root / 'compose-base.yml'
        overlay = self.root / 'compose-overlay.json'
        base.write_text(m.retirement_compose(source))
        overlay.write_text(json.dumps({'services': {'api': {'volumes': ['online_recharge_data:/app/.runtime/online-recharge']}}}))
        result = subprocess.run(['docker', 'compose', '-f', str(base), '-f', str(overlay), 'config', '--format', 'json'], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        mounts = value['services']['api']['volumes']
        self.assertEqual(len(mounts), 1)
        self.assertEqual(mounts[0]['source'], 'online_recharge_data')
        self.assertEqual(mounts[0]['target'], '/app/.runtime/online-recharge')
        self.assertNotIn('auto-registration', value['services'])
        self.assertNotIn('auto_registration_data', value.get('volumes', {}))

    def test_changed_or_missing_old_compose_refuses_heuristics(self):
        for text in (COMPOSE.replace('AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051',
                                     'AUTO_REGISTRATION_WORKER_URL: http://other:8051'),
                     COMPOSE.replace('  registration-egress:\n', ''),
                     COMPOSE.replace('  auto-registration:\n', '  something-else:\n')):
            with self.assertRaises(RuntimeError):
                m.retirement_compose(text)

    def test_override_cannot_resurrect_retired_service(self):
        value = {'services': {'api': {'environment': {'KEEP': 'yes', 'AUTO_REGISTRATION_WORKER_URL': 'old'},
                                      'volumes': ['reg:/app/.runtime/auto-registration', 'online:/app/.runtime/online-recharge'],
                                      'networks': ['default', 'registration-control']}, 'admin': {},
                              'auto-registration': {'image': 'old'}, 'mysql': {'image': 'mysql:pinned'},
                              'caddy': {'volumes': ['data:/data']}},
                 'networks': {'registration-control': {}, 'registration-egress': {}, 'default': {}},
                 'volumes': {'auto_registration_data': {'name': 'formal-registration'}, 'online_recharge_data': {'name': 'formal-online'}}}
        original = copy.deepcopy(value)
        result = m.retirement_override(value, {'api': {'reference': 'new-api'}, 'admin': {'reference': 'new-admin'}}, self.base / 'releases/new')
        self.assertEqual(value, original)
        self.assertNotIn('auto-registration', result['services'])
        self.assertEqual(result['services']['mysql'], original['services']['mysql'])
        self.assertEqual(result['services']['api']['environment'], {'KEEP': 'yes'})
        self.assertEqual(result['services']['api']['networks'], ['default'])
        self.assertEqual(result['services']['api']['volumes'], ['online:/app/.runtime/online-recharge'])
        self.assertIn('data:/data', result['services']['caddy']['volumes'])
        self.assertEqual(result['volumes'], {'online_recharge_data': {'name': 'formal-online'}})

    def test_other_service_volume_reference_prevents_text_retirement(self):
        text = COMPOSE.replace('  mysql:\n    image: mysql:pinned\n',
                               '  mysql:\n    image: mysql:pinned\n    volumes:\n      - auto_registration_data:/keep\n')
        with self.assertRaisesRegex(RuntimeError, 'REGISTRATION_VOLUME_STILL_REFERENCED'):
            m.retirement_compose(text)

    def test_override_shared_volume_reference_prevents_declaration_removal(self):
        for volume in ('auto_registration_data:/keep',
                       {'type': 'volume', 'source': 'auto_registration_data', 'target': '/keep'}):
            value = {'services': {'api': {}, 'admin': {}, 'mysql': {'volumes': [volume]}},
                     'volumes': {'auto_registration_data': {'name': 'formal-registration'},
                                 'online_recharge_data': {'name': 'formal-online'}}}
            original = copy.deepcopy(value)
            with self.subTest(volume=volume), self.assertRaisesRegex(RuntimeError, 'REGISTRATION_VOLUME_STILL_REFERENCED'):
                m.retirement_override(value, {'api': {'reference': 'api:new'}, 'admin': {'reference': 'admin:new'}}, self.base / 'releases/new')
            self.assertEqual(value, original)

    def test_caddy_removal_is_exact_and_does_not_mutate_original(self):
        result = m.retirement_caddy(CADDY)
        self.assertNotIn(b'@registrationWorkspace', result)
        self.assertIn(b'reverse_proxy admin:80', result)
        self.assertIn(b'@registrationWorkspace', CADDY)
        with self.assertRaisesRegex(RuntimeError, 'CADDY_RETIRED_HANDLE_CHANGED'):
            m.retirement_caddy(CADDY.replace(b'flush_interval -1', b'flush_interval 1'))

    def test_runtime_model_allows_binds_and_mounts_retirement_only(self):
        before = row('api')
        before['Config']['Env'] += ['AUTO_REGISTRATION_WORKER_URL=http://auto-registration:8051']
        before['HostConfig']['Binds'] = ['formal-registration:/app/.runtime/auto-registration:rw', 'formal-online:/app/.runtime/online-recharge:rw']
        before['HostConfig']['Mounts'] = [{'Type': 'volume', 'Source': 'formal-registration', 'Target': '/app/.runtime/auto-registration'},
                                          {'Type': 'volume', 'Source': 'formal-online', 'Target': '/app/.runtime/online-recharge'}]
        after = copy.deepcopy(before)
        after['Config']['Env'] = ['KEEP=yes']
        after['Mounts'] = after['Mounts'][:1]
        after['HostConfig']['Binds'] = after['HostConfig']['Binds'][1:]
        after['HostConfig']['Mounts'] = after['HostConfig']['Mounts'][1:]
        self.assertEqual(m.model(before, role='api', retiring=True), m.model(after, role='api'))
        after['Config']['Env'] = ['KEEP=changed']
        self.assertNotEqual(m.model(before, role='api', retiring=True), m.model(after, role='api'))

    def test_image_keeps_existing_configuration_and_user(self):
        _, proof = self.payload()
        api = m.image_dockerfile('api', 'api:pinned', {'User': 'node'}, proof, self.plan, self.c)
        self.assertIn('USER node', api)
        self.assertIn('rm -rf -- /app/apps/api/src/id-business-v2/auto-registration', api)
        self.assertIn('/opt/id-registration', api)
        self.assertIn('COPY shared/ /app/packages/shared/dist/', api)
        permissions = 'RUN find /app/apps/api/dist /app/packages/shared/dist -type d -exec chmod 755 {} +'
        self.assertIn(permissions, api)
        self.assertLess(api.index('COPY shared/'), api.index(permissions))
        self.assertLess(api.index(permissions), api.index('USER node'))
        self.assertNotIn('chmod -R', api)
        self.assertNotIn('npm ', api)
        self.assertNotIn('pip ', api)
        admin = m.image_dockerfile('admin', 'admin:pinned', {'User': '101'}, proof, self.plan, self.c)
        self.assertNotIn('rm -rf', admin)
        self.assertIn('USER 101', admin)
        root = m.image_dockerfile('api', 'api:pinned', {'User': ''}, proof, self.plan, self.c)
        self.assertNotIn('USER ', root)
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONFIGURATION_CHANGED'):
            m.verify_image_config({'User': 'node'}, {'User': 'root'})

    def test_admin_cleanup_names_are_exact(self):
        _, proof = self.payload()
        self.c['retiredAdminAssets'] = {'assets/V2AppleMailboxes-123.js': OLD}
        output = m.image_dockerfile('admin', 'admin:pinned', {'User': '101'}, proof, self.plan, self.c)
        self.assertIn('rm -f -- /usr/share/nginx/html/assets/V2AppleMailboxes-123.js', output)
        self.assertNotIn('rm -rf', output)

    def test_readback_reverse_delta_pins_unchanged_modules(self):
        before = {'keep.js': OLD, 'deleted.js': OLD, 'unrelated.js': NEW}
        actual = {'keep.js': NEW, 'added.js': NEW, 'unrelated.js': NEW}
        baseline = {'keep.js': OLD, 'deleted.js': OLD, 'added.js': None}
        m.verify_readback_delta(actual, {'keep.js': NEW, 'added.js': NEW}, {'deleted.js': OLD}, baseline, m.fingerprint(before))
        for bad in ({**actual, 'unrelated.js': OLD}, {**actual, 'deleted.js': OLD}, {**actual, 'keep.js': OLD}):
            with self.assertRaises(RuntimeError):
                m.verify_readback_delta(bad, {'keep.js': NEW, 'added.js': NEW}, {'deleted.js': OLD}, baseline, m.fingerprint(before))

    def test_exact_pinned_contract_is_published_and_drift_refused(self):
        target = self.root / 'published-contract'
        target.mkdir()
        raw = (self.here / 'feature-retirement-contract.json').read_bytes()
        m.publish_contract(target, self.plan)
        copied = target / 'scripts/production-release/feature-retirement-contract.json'
        self.assertEqual(copied.read_bytes(), raw)
        self.assertEqual(m.digest(copied.read_bytes()), self.plan['contractSha256'])
        (self.here / 'feature-retirement-contract.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_CHANGED_BEFORE_COPY'):
            m.publish_contract(target, self.plan)
        self.assertEqual(copied.read_bytes(), raw)

    def test_published_contract_target_cannot_follow_symlink(self):
        target = self.root / 'symlink-contract-target'
        path = target / 'scripts/production-release/feature-retirement-contract.json'
        path.parent.mkdir(parents=True)
        unrelated = self.root / 'unrelated-contract.json'
        unrelated.write_text('keep')
        path.symlink_to(unrelated)
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_TARGET_PATH_INVALID'):
            m.publish_contract(target, self.plan)
        self.assertEqual(unrelated.read_text(), 'keep')

    def test_source_apply_deletes_exact_code_and_never_follows_symlink(self):
        payload, _ = self.payload()
        target = self.root / 'target'
        old = target / 'apps/api/src/id-business-v2/auto-registration/old.ts'
        old.parent.mkdir(parents=True); old.write_text('old')
        script = target / self.c['retiredHostPaths'][0]
        script.parent.mkdir(parents=True); script.write_text('old script')
        unrelated = target / 'keep-data.json'; unrelated.write_text('keep')
        m.apply_sources(target, payload, self.c)
        self.assertFalse(old.exists()); self.assertFalse(script.exists())
        self.assertEqual(unrelated.read_text(), 'keep')
        self.assertEqual((target / 'apps/api/src/keep.ts').read_text(), 'new')
        script.symlink_to(unrelated)
        with self.assertRaisesRegex(RuntimeError, 'RETIRED_HOST_PATH_INVALID'):
            m.apply_sources(target, payload, self.c)


class NativeTests(Fixture):
    def test_exact_container_identity_and_role_are_required(self):
        original = row('auto-registration')
        m.verify_registration(original, identity('auto-registration'), 'formal')
        for key, change in [('Id', 'f' * 64), ('Image', 'sha256:' + NEW)]:
            bad = {**original, key: change}
            with self.assertRaisesRegex(RuntimeError, 'RETIREMENT_IDENTITY_INVALID'):
                m.verify_registration(bad, identity('auto-registration'), 'formal')
        bad = copy.deepcopy(original); bad['Config']['Env'] = ['AUTO_RECHARGE_WORKER_ROLE=recharge']
        with self.assertRaisesRegex(RuntimeError, 'RETIREMENT_IDENTITY_INVALID'):
            m.verify_registration(bad, identity('auto-registration'), 'formal')

    def test_stop_remove_uses_exact_id_without_volume_or_force_flags(self):
        rows = [row('auto-registration'), row('auto-registration')]
        rows[1]['State']['Running'] = False
        d = Mock()
        with patch.object(m, 'inspect', side_effect=rows), patch.object(m, 'retired_containers', side_effect=[[identity('auto-registration')['containerId'][:12]], []]):
            m.retire_container(d, identity('auto-registration'), 'formal')
        self.assertEqual(d.run.call_args_list[0].args, ('docker', 'stop', '--time', '30', identity('auto-registration')['containerId']))
        self.assertEqual(d.run.call_args_list[1].args, ('docker', 'rm', identity('auto-registration')['containerId']))
        self.assertNotIn('-v', str(d.run.call_args_list)); self.assertNotIn('--force', str(d.run.call_args_list))

    def test_extra_registration_container_prevents_any_stop(self):
        d = Mock()
        with patch.object(m, 'inspect', return_value=row('auto-registration')), patch.object(m, 'retired_containers', return_value=['f' * 12]):
            with self.assertRaisesRegex(RuntimeError, 'EXTRA_REGISTRATION_CONTAINER'):
                m.retire_container(d, identity('auto-registration'), 'formal')
        d.run.assert_not_called()

    def test_failed_stop_never_removes(self):
        d = Mock()
        with patch.object(m, 'inspect', return_value=row('auto-registration')), patch.object(m, 'retired_containers', return_value=[]):
            with self.assertRaisesRegex(RuntimeError, 'REGISTRATION_NOT_STOPPED'):
                m.retire_container(d, identity('auto-registration'), 'formal')
        self.assertEqual(d.run.call_count, 1)

    def test_online_exact_physical_volume_and_api_namespace_are_required(self):
        states = {n: identity(n) for n in m.AFTER}
        rows = [row('online-recharge'), row('api')]
        d = Mock(); d.run.return_value = json.dumps([{'Name': 'formal-online', 'Driver': 'local'}])
        with patch.object(m, 'inspect', side_effect=copy.deepcopy(rows)):
            binding = m.online_binding(d, self.base / 'releases/old', self.c, states)
        self.assertEqual(binding['apiContainerId'], states['api']['containerId'])
        self.assertEqual(binding['volumeIdentitySha256'], m.fingerprint({'Name': 'formal-online', 'Driver': 'local'}))
        for change in ('volume', 'network', 'readonly', 'project'):
            bad = copy.deepcopy(rows)
            if change == 'volume': bad[0]['Mounts'][0]['Name'] = 'other'
            if change == 'network': bad[0]['HostConfig']['NetworkMode'] = 'bridge'
            if change == 'readonly': bad[0]['Mounts'][0]['RW'] = False
            if change == 'project': bad[0]['Config']['Labels']['com.docker.compose.project'] = 'other'
            with self.subTest(change=change), patch.object(m, 'inspect', side_effect=bad), self.assertRaisesRegex(RuntimeError, 'ONLINE_BINDING_CHANGED'):
                m.online_binding(d, self.base / 'releases/old', self.c, states)

    def test_preflight_cannot_switch_and_returns_compact_baseline(self):
        d, h = Mock(), Mock()
        before = {'receipt': {'version': 1, 'manifestSha256': OLD}}
        with patch.object(m, 'baseline', return_value=before):
            result = m.release(self.plan, self.c, d, h)
        self.assertEqual(result['mode'], 'preflight')
        self.assertEqual(result['status'], 'FEATURE_RETIREMENT_PREFLIGHT_VERIFIED')
        self.assertEqual(result['runtimeBaseline'], before['receipt'])
        d.assert_not_called(); d.run.assert_not_called(); d.compose.assert_not_called()
        self.assertFalse(result['dataDeleted']); self.assertFalse(result['backupCreated'])

    def test_release_requires_matching_independent_preflight(self):
        self.plan.update(mode='release', runtimeBaseline={'manifestSha256': NEW})
        with patch.object(m, 'baseline', return_value={'receipt': {'manifestSha256': OLD}}):
            with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_BASELINE_CHANGED'):
                m.release(self.plan, self.c, Mock(), Mock())
        self.assertFalse((self.base / '.staging').exists())

    def test_concurrent_publisher_lock_refuses(self):
        import fcntl
        with (self.base / '.deploy.lock').open('a') as selected:
            fcntl.flock(selected.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'RELEASE_LOCKED'):
                m.release(self.plan, self.c, Mock(), Mock())

    def test_readback_dispatch_requires_live_measurement(self):
        self.plan.update(mode='readback', runtimeBaseline={})
        d, h = Mock(), Mock()
        with patch.object(m, 'readback', return_value={'status': 'FEATURE_RETIREMENT_READBACK_VERIFIED'}) as read:
            result = m.release(self.plan, self.c, d, h)
        read.assert_called_once_with(self.plan, self.c, d, h)
        self.assertEqual(result['status'], 'FEATURE_RETIREMENT_READBACK_VERIFIED')

    def test_failed_pre_switch_artifact_is_bounded_and_not_retried(self):
        self.plan.update(mode='release', runtimeBaseline={'version': 1})
        stream = types.SimpleNamespace(__enter__=lambda s: s, __exit__=lambda *args: False)
        response = Mock(); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'not the artifact'
        d, h = Mock(), Mock()
        with patch.object(m, 'baseline', return_value={'receipt': {'version': 1}}), patch.object(m.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_CHANGED'):
                m.release(self.plan, self.c, d, h)
            with self.assertRaisesRegex(RuntimeError, 'RELEASE_ALREADY_ACCEPTED'):
                m.release(self.plan, self.c, d, h)
        log = next((self.base / '.staging').glob('*/switch-state.json')).read_text()
        self.assertIn('NEEDS_FORWARD_DIAGNOSIS', log)
        self.assertNotIn('not the artifact', log)
        d.compose.assert_not_called(); d.run.assert_not_called(); h.fresh_scoped_backup.assert_not_called()


class SwitchBarrierTests(Fixture):
    def switch_fixture(self):
        events = []
        d, h = Mock(), Mock()
        d.assert_no_active_recharge = Mock()
        d.assert_no_active_registration = Mock()
        states = {n: identity(n) for n in m.BEFORE}
        before = {'states': states, 'rows': {'api': row('api')}, 'binding': {'volumeIdentitySha256': OLD}}
        images = {'api': {'reference': 'candidate-api:fixed', 'imageId': 'sha256:' + NEW},
                  'admin': {'reference': 'candidate-admin:fixed', 'imageId': 'sha256:' + NEW}}
        audit, fence, scope = Mock(), Mock(), Mock()
        scope.WorkspaceAuditBarrier.return_value = audit
        scope.OnlineSqlFence.return_value = fence
        audit.acquire.side_effect = lambda: events.append('audit_lock')
        audit.before_stop.side_effect = lambda: events.append('audit_check')
        audit.close.side_effect = lambda: events.append('audit_unlock')
        fence.acquire.side_effect = lambda: events.append('online_lock')
        fence.check_idle.side_effect = lambda: events.append('online_check')
        fence.stop.side_effect = lambda state, **kw: events.append('stop_' + ('api' if state == states['api'] else 'online'))
        fence.close.side_effect = lambda: events.append('online_unlock')
        scope.online_rebind.side_effect = lambda *args: events.append('online_rebind')
        d.compose.side_effect = lambda directory, *args, **kw: events.append('start_' + args[-1])
        d.wait_healthy.side_effect = lambda directory, role: events.append('healthy_' + role)
        return d, h, before, images, audit, fence, scope, events

    def call_switch(self, fixture):
        d, h, before, images, audit, fence, scope, events = fixture
        m.switch_services(d, self.c, Path(self.c['current']), self.base / 'releases/new', before, h,
                          {'sqliteSafetySha256': OLD}, images, scope=scope)

    def test_locked_switch_order_and_only_approved_roles(self):
        f = self.switch_fixture()
        d, h, before, images, audit, fence, scope, events = f
        with patch.object(m, 'sqlite_idle', return_value=OLD) as sqlite, patch.object(m, 'verify_reference') as image_check, patch.object(m, 'retire_container', side_effect=lambda *args: events.append('retire_registration')):
            self.call_switch(f)
        self.assertEqual(sqlite.call_count, 2)
        self.assertLess(events.index('audit_lock'), events.index('retire_registration'))
        self.assertLess(events.index('online_lock'), events.index('retire_registration'))
        self.assertLess(events.index('stop_online'), events.index('stop_api'))
        self.assertLess(events.index('stop_api'), events.index('online_unlock'))
        self.assertLess(events.index('stop_api'), events.index('audit_unlock'))
        self.assertLess(events.index('audit_unlock'), events.index('start_api'))
        self.assertLess(events.index('healthy_api'), events.index('online_rebind'))
        self.assertLess(events.index('online_rebind'), events.index('start_admin'))
        self.assertEqual([call.args[-1] for call in d.compose.call_args_list], ['api', 'admin', 'caddy'])
        self.assertEqual([call.args[1:] for call in image_check.call_args_list], [
            (images['api']['reference'], images['api']['imageId']),
            (before['states']['online-recharge']['reference'], before['states']['online-recharge']['image']),
            (images['admin']['reference'], images['admin']['imageId']),
            (before['states']['caddy']['reference'], before['states']['caddy']['image'])])
        self.assertEqual(audit.QUERY, "SELECT JSON_OBJECT('version',1,'connectionId',CONNECTION_ID(),'busy',0);\n")
        h.fresh_scoped_backup.assert_not_called()

    def test_locked_summary_change_stops_before_any_container(self):
        for results in ([NEW], [OLD, NEW]):
            f = self.switch_fixture()
            d, h, before, images, audit, fence, scope, events = f
            with patch.object(m, 'sqlite_idle', side_effect=results), patch.object(m, 'retire_container') as retire:
                with self.assertRaisesRegex(RuntimeError, 'SQLITE_CHANGED_BEFORE_STOP'):
                    self.call_switch(f)
            audit.close.assert_called_once()
            d.compose.assert_not_called()
            if len(results) == 1:
                retire.assert_not_called(); fence.acquire.assert_not_called(); fence.stop.assert_not_called()
            else:
                self.assertEqual(fence.stop.call_count, 1)
                self.assertEqual(fence.stop.call_args.args[0], before['states']['online-recharge'])
                fence.close.assert_called_once()

    def test_failed_audit_lock_never_stops_any_service(self):
        f = self.switch_fixture()
        d, h, before, images, audit, fence, scope, events = f
        audit.acquire.side_effect = RuntimeError('API_ADMIN_WORKSPACE_AUDIT_GUARD_FAILED')
        with patch.object(m, 'retire_container') as retire:
            with self.assertRaisesRegex(RuntimeError, 'AUDIT_GUARD_FAILED'):
                self.call_switch(f)
        retire.assert_not_called(); fence.acquire.assert_not_called(); d.compose.assert_not_called()

    def test_failed_online_lock_never_retires_or_stops_any_service(self):
        f = self.switch_fixture()
        d, h, before, images, audit, fence, scope, events = f
        fence.acquire.side_effect = RuntimeError('API_ADMIN_ONLINE_FENCE_UNAVAILABLE')
        with patch.object(m, 'sqlite_idle', return_value=OLD), patch.object(m, 'retire_container') as retire:
            with self.assertRaisesRegex(RuntimeError, 'ONLINE_FENCE_UNAVAILABLE'):
                self.call_switch(f)
        audit.close.assert_called_once(); retire.assert_not_called(); fence.stop.assert_not_called()
        d.compose.assert_not_called()

    def test_failed_api_stop_releases_both_locks_without_restart(self):
        f = self.switch_fixture()
        d, h, before, images, audit, fence, scope, events = f
        def stop(state, **kw):
            if state == before['states']['api']:
                raise RuntimeError('API_ADMIN_ONLINE_CONTAINER_NOT_STOPPED')
        fence.stop.side_effect = stop
        with patch.object(m, 'sqlite_idle', return_value=OLD), patch.object(m, 'retire_container'):
            with self.assertRaisesRegex(RuntimeError, 'CONTAINER_NOT_STOPPED'):
                self.call_switch(f)
        fence.close.assert_called_once(); audit.close.assert_called_once(); d.compose.assert_not_called()
        scope.online_rebind.assert_not_called()

    def test_historical_failed_tasks_are_allowed_but_pending_running_or_lease_are_not(self):
        d, scope = Mock(), Mock()
        d.environment_values.return_value = {'FIELD_ENCRYPTION_KEY': 'synthetic-fixture-key-' * 3}
        summary = {'status': 'PASS', 'taskCounts': {'pending': 0, 'running': 0, 'failed': 8, 'completed': 0, 'cancelled': 0},
                   'activeAppleLeaseCount': 0, 'businessActions': 0, 'retiredTerminalLeaseCount': 1}
        d.run.side_effect = [json.dumps([{'Id': self.c['services']['api']['image']}]), json.dumps(summary)]
        self.assertEqual(m.sqlite_idle(d, Path(self.c['current']), self.c, scope), m.fingerprint(summary))
        self.assertIn('readonly', d.run.call_args.args[d.run.call_args.args.index('--mount') + 1])
        self.assertNotIn('synthetic-fixture-key-', str(d.run.call_args.args))
        for state in ('pending', 'running', 'lease'):
            bad = copy.deepcopy(summary)
            if state == 'lease': bad['activeAppleLeaseCount'] = 1
            else: bad['taskCounts'][state] = 1
            d.run.side_effect = [json.dumps([{'Id': self.c['services']['api']['image']}]), json.dumps(bad)]
            with self.subTest(state=state), self.assertRaisesRegex(RuntimeError, 'SQLITE_NOT_IDLE'):
                m.sqlite_idle(d, Path(self.c['current']), self.c, scope)

    def test_sqlite_reader_image_reference_drift_is_rejected_before_execution(self):
        d, scope = Mock(), Mock()
        d.run.return_value = json.dumps([{'Id': 'sha256:' + NEW}])
        with self.assertRaisesRegex(RuntimeError, 'SQLITE_READER_IMAGE_CHANGED'):
            m.sqlite_idle(d, Path(self.c['current']), self.c, scope)
        scope.workspace_private_inspect.assert_not_called()


class TerminalLeaseReadOnlyTests(unittest.TestCase):
    def run_reader(self, *, task_state='failed', record_state='awaiting_review', result='failed', created=False,
                   verified=False, success=False, observed=1):
        from contextlib import redirect_stdout
        rows = [('id.apple-mailbox.fixture', json.dumps({'activeTaskUuid': 'task-fixture', 'taskStatus': record_state})),
                ('id.apple-task.task-fixture', json.dumps({'resultKind': result, 'creationConfirmed': created,
                   'verifiedExistingAccount': verified, 'rawResult': {'success': success}}))]
        connection = Mock()
        connection.execute.side_effect = lambda sql: rows if sql == 'SELECT key,value FROM settings' else [('task-fixture', task_state)]
        class SafetyError(Exception):
            pass
        fixture = types.SimpleNamespace(APPLE_PREFIX='id.apple-mailbox.', APPLE_TASK_PREFIX='id.apple-task.',
            encrypted_proof=Mock(return_value=observed), decrypt_value=lambda value,key:value,
            strict_json=json.loads, SafetyError=SafetyError)
        original = fixture.encrypted_proof
        def inspect(request):
            self.assertEqual(request['mode'], 'inspect')
            self.assertEqual(fixture.encrypted_proof(connection, request['encryptionKey']), 0)
            return {'status': 'PASS', 'activeAppleLeaseCount': 0}
        fixture.inspect_database = inspect
        output = io.StringIO()
        spec = types.SimpleNamespace(loader=Mock(exec_module=lambda _:None))
        with patch.object(m.importlib.util, 'spec_from_file_location', return_value=spec), \
             patch.object(m.importlib.util, 'module_from_spec', return_value=fixture), \
             patch('sys.stdin', io.StringIO(json.dumps({'mode':'inspect','encryptionKey':'synthetic-private-key'}))), \
             redirect_stdout(output):
            exec(compile(m.RETIREMENT_SQLITE_CODE, '<retirement-reader>', 'exec'), {})
        original.assert_called_once()
        self.assertNotIn('task-fixture', output.getvalue())
        self.assertNotIn('synthetic-private-key', output.getvalue())
        self.assertTrue(all(call.args[0].startswith('SELECT ') for call in connection.execute.call_args_list))
        return json.loads(output.getvalue())

    def test_exact_terminal_failure_retains_original_encryption_validation_and_does_not_write(self):
        self.assertEqual(self.run_reader(), {'status':'PASS','activeAppleLeaseCount':0,'retiredTerminalLeaseCount':1})

    def test_active_missing_successful_or_unmatched_lease_is_never_retired(self):
        for kwargs in ({'task_state':'pending'}, {'task_state':'running'}, {'task_state':None},
                       {'record_state':'running'}, {'result':None}, {'created':True},
                       {'verified':True}, {'success':True}, {'observed':2}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.run_reader(**kwargs), {'status':'FAIL'})


class AdditionalProofTests(Fixture):
    def test_declaration_baseline_exceptions_are_exact_and_not_executable(self):
        self.c['apiCompiledBaselineFiles']['keep.d.ts'] = NEW
        self.pin()
        payload, proof = self.payload()
        proof.update(baselineApiFullInventoryReproduced=False,
                     baselineApiDeclarationDifferences={'keep.d.ts': {'runtimeSha256': OLD, 'compiledSha256': NEW}})
        m.validate_proof(proof, self.plan, self.c, payload)
        bad = copy.deepcopy(proof); bad['baselineApiDeclarationDifferences']['keep.d.ts']['runtimeSha256'] = NEW
        with self.assertRaisesRegex(RuntimeError, 'COMPILED_DECLARATION_EVIDENCE_CHANGED'):
            m.validate_proof(bad, self.plan, self.c, payload)
        self.c['apiCompiledBaselineFiles']['keep.js'] = NEW; self.pin()
        with self.assertRaisesRegex(RuntimeError, 'API_COMPILED_BASELINE_INVALID'):
            m.validate_plan(self.plan, self.c)

    def test_omitted_declarations_can_never_be_packaged_or_deployed(self):
        self.c['omittedApiDeclarations'] = {'unchanged.d.ts': {'baselineSha256': OLD, 'compiledSha256': NEW}}
        self.pin()
        payload, proof = self.payload()
        proof['omittedApiDeclarations'] = self.c['omittedApiDeclarations']
        m.validate_proof(proof, self.plan, self.c, payload)
        for key in ('omittedApiDeclarationsPackaged', 'omittedApiDeclarationsDeployed'):
            with self.assertRaisesRegex(RuntimeError, 'OMITTED_DECLARATIONS_DEPLOYED'):
                m.validate_proof({**proof, key: True}, self.plan, self.c, payload)

    def test_historical_admin_files_are_preserved_outside_exact_retired_set(self):
        before = {'index.html': OLD, 'assets/old-other-module.js': OLD, 'assets/V2AppleMailboxes-old.js': OLD}
        after = m.expected_inventory(before, {'index.html': NEW, 'assets/new.js': NEW}, {'assets/V2AppleMailboxes-old.js': OLD})
        self.assertEqual(after, {'index.html': NEW, 'assets/old-other-module.js': OLD, 'assets/new.js': NEW})
        with self.assertRaisesRegex(RuntimeError, 'DELETED_BASELINE_CHANGED'):
            m.expected_inventory(before, {}, {'assets/V2AppleMailboxes-old.js': NEW})

    def test_rendered_configuration_preserves_every_unrelated_service_field(self):
        previous, target = self.base / 'releases/old', self.base / 'releases/new'
        before = {'services': {'auto-registration': {'image': 'reg:old'}, 'mysql': {'image': 'mysql:pinned', 'environment': {'SECRET': 'synthetic'}},
                  'api': {'environment': {'AUTO_REGISTRATION_WORKER_URL': 'old', 'KEEP': 'same'},
                          'volumes': [{'target': '/app/.runtime/auto-registration'}, {'target': '/app/.runtime/online-recharge'}],
                          'networks': {'default': {}, 'registration-control': {}}, 'image': 'api:old'},
                  'admin': {'image': 'admin:old'}, 'caddy': {'volumes': [{'source': str(previous / 'deploy/caddy/Caddyfile.aws'), 'target': '/etc/caddy/Caddyfile', 'bind': {'create_host_path': True}}]}},
                  'networks': {'registration-control': {}, 'registration-egress': {}, 'default': {}}, 'volumes': {'auto_registration_data': {}, 'online_recharge_data': {'name': 'formal-online'}}}
        after = copy.deepcopy(before)
        after['services'].pop('auto-registration')
        after['services']['api']['environment'].pop('AUTO_REGISTRATION_WORKER_URL')
        after['services']['api']['volumes'] = after['services']['api']['volumes'][1:]
        after['services']['api']['networks'].pop('registration-control')
        after['volumes'].pop('auto_registration_data')
        for name in ('registration-control', 'registration-egress'): after['networks'].pop(name)
        images = {'api': {'reference': 'api:new'}, 'admin': {'reference': 'admin:new'}}
        for name, image in images.items(): after['services'][name]['image'] = image['reference']
        after['services']['caddy']['volumes'][0]['source'] = str(target / 'deploy/caddy/Caddyfile.aws')
        m.verify_rendered(before, after, images, previous, target)
        self.assertEqual(after['volumes'], {'online_recharge_data': {'name': 'formal-online'}})
        restored = copy.deepcopy(after); restored['volumes']['auto_registration_data'] = {}
        with self.assertRaisesRegex(RuntimeError, 'COMPOSE_UNRELATED_CONFIGURATION_CHANGED'):
            m.verify_rendered(before, restored, images, previous, target)
        after['services']['mysql']['environment']['SECRET'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'COMPOSE_UNRELATED_CONFIGURATION_CHANGED'):
            m.verify_rendered(before, after, images, previous, target)


if __name__ == '__main__':
    unittest.main()
