"""Pure finite-admission and switch tests. No Docker, network or database."""
import copy
import base64
import importlib.util
import io
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('terminal_test_' + name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = load('registration-terminal-stop-release.py')
b = load('registration-terminal-stop-build.py')
d = load('registration-terminal-stop-dispatch.py')


class TerminalControls(unittest.TestCase):
    def setUp(self):
        for target in (patch.object(socket.socket, 'connect', side_effect=AssertionError('network disabled')),
                       patch.object(sqlite3, 'connect', side_effect=AssertionError('database disabled'))):
            target.start()
            self.addCleanup(target.stop)

    def ready(self):
        old = r.prior_contract()
        rows = {**old['baselineWorkerFiles'], **old['workerFiles']}
        baseline = copy.deepcopy(old['baseline'])
        baseline.update(commit=r.CURRENT, current='/opt/id-business-v2/releases/approved-a92',
                        manifestSha256='e' * 64, adminBuildId='v2-' + r.CURRENT, publicIndexSha256='f' * 64)
        baseline['inventory']['worker'] = r.signature(rows)
        c = {'version': 1, 'name': r.NAME, 'scope': r.SCOPE, 'frozen': True, 'admission': 'VERIFIED',
             'pendingEvidence': [], 'migration': None, 'businessActions': 0, 'expectedCurrent': r.CURRENT,
             'sourceBaseline': r.SOURCE_BASE, 'sourceBaselineTree': r.SOURCE_TREE, 'publishedPrevious': r.PUBLISHED_PREVIOUS,
             'applicationPaths': list(r.APPLICATION_PATHS), 'expectedGitChanges': list(r.TASK_PATHS),
             'sources': {n: r.digest((r.ROOT / n).read_bytes()) for n in r.APPLICATION_PATHS},
             'validationSources': {}, 'pythonTests': list(r.PYTHON_TESTS), 'apiJavascriptDelta': [],
             'apiRuntimeDelta': [], 'adminDelta': [], 'dependencyDelta': [], 'updatedServices': ['api'],
             'reboundServices': ['online-recharge'], 'baseline': baseline, 'current': baseline['current'],
             'manifestSha256': baseline['manifestSha256'], 'baselineWorkerFiles': rows,
             'schemaSha256': baseline['schemaSha256'], 'publicIndexSha256': baseline['publicIndexSha256'],
             'roleSourceCommits': {'api': r.CURRENT, 'admin': r.CURRENT,
                                  'online-recharge': old['roleSourceCommits']['online-recharge']},
             'publishedInventory': copy.deepcopy(baseline['inventory']),
             'configurationSha256': baseline['configurationSha256'],
             'runtimeConfigurationSha256': baseline['runtimeConfigurationSha256'],
             'sourceProjectionSha256': {'roleSourceProjections': baseline['roleSourceProjectionsSha256'],
                                        'adminSourceProjection': baseline['adminSourceProjectionSha256']},
             'hostSourceInheritance': {'release': baseline['current'], 'files': {}},
             'controlFiles': list(r.control_files()),
             'controlHashes': {n: r.digest((HERE / n).read_bytes()) for n in r.control_files()}}
        c['workerFiles'] = {'apple_mailboxes.py': c['sources'][r.SOURCE]}
        for name in ('backupNormalizerPath', 'engineHealth', 'sqlFenceHelperSha256', 'qualityEvidenceHelperSha256'):
            c[name] = old[name]
        c['buildSupportHashes'] = {'scripts/production-release/registration-closure-release.py':
            old['buildSupportHashes']['scripts/production-release/registration-closure-release.py']}
        return c

    def proof(self, c, plan):
        after = copy.deepcopy(c['baseline']['inventory'])
        after['worker'] = r.signature({**c['baselineWorkerFiles'], **c['workerFiles']})
        result = {k: plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
                                       'contractSha256', 'controlSources')}
        result.update(version=1, scope=r.SCOPE, sources=c['sources'], validationSources={},
                      workerFiles=c['workerFiles'], apiModules={}, apiJavascriptDelta=[], adminFiles={},
                      baselineInventory=c['baseline']['inventory'], afterInventory=after,
                      validation={'status': 'PASS', 'worker': True, 'isolatedPersistence': True,
                                  'pythonTests': list(r.PYTHON_TESTS)}, inheritedValidation=r.PUBLISHED_PREVIOUS,
                      migrationPerformed=False, businessActions=0)
        result['files'] = {**{'source/' + n: v for n, v in c['sources'].items()},
                           **{'api/worker/' + n: v for n, v in c['workerFiles'].items()}}
        return result

    def test_draft_cannot_reach_release_or_transport(self):
        c = self.ready()
        c.update(admission='DRAFT', frozen=False)
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_ADMITTED'):
            r.release({}, c)
        with patch.object(d, 'verified_contract', side_effect=RuntimeError('DRAFT')):
            with self.assertRaisesRegex(RuntimeError, 'DRAFT'):
                d.namespace()['transport']({}, 'release')

    def test_complete_synthetic_admission_and_tamper_rejection(self):
        c = self.ready()
        with patch.object(r, 'BASELINE_PROJECTION_SHA256', r.digest(r.canonical(c['baseline']))):
            r.verify_contract(c)
            for mutate in (
                    lambda x: x.update(expectedCurrent='0' * 40),
                    lambda x: x.update(sourceBaseline='0' * 40),
                    lambda x: x.update(sourceBaselineTree='0' * 40),
                    lambda x: x['baseline']['inventory']['admin'].update(sha256='0' * 64),
                    lambda x: x['baseline']['services']['api'].update(image='sha256:' + '0' * 64),
                    lambda x: x.update(migration={'name': 'wrong'}),
                    lambda x: x.update(businessActions=False),
                    lambda x: x.update(apiJavascriptDelta=['changed.js']),
                    lambda x: x.update(dependencyDelta=['requests']),
                    lambda x: x['workerFiles'].update({'flow_evidence.py': '0' * 64}),
                    lambda x: x['sources'].pop(r.TEST_SOURCE),
                    lambda x: x['expectedGitChanges'].append('unreviewed.py'),
                    lambda x: x['expectedGitChanges'].pop(),
                    lambda x: x['controlHashes'].update({'remote-deploy.py': '0' * 64}),
                    lambda x: x.pop('buildSupportHashes'),
                    lambda x: x['buildSupportHashes'].update({'unexpected.py': '0' * 64}),
                    lambda x: x['buildSupportHashes'].update({
                        'scripts/production-release/registration-closure-release.py': '0' * 64}),
                    lambda x: x['publishedPrevious'].update(runId='1')):
                candidate = copy.deepcopy(c)
                mutate(candidate)
                with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                    r.verify_contract(candidate)

    def test_worker_proof_preserves_all_other_components_and_truthful_inheritance(self):
        c = self.ready()
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                'contractSha256': 'c' * 64, 'controlSources': c['controlHashes']}
        proof = self.proof(c, plan)
        h = Mock()
        h.file_inventory.return_value = {**proof['files'], 'build-proof.json': '0' * 64}
        self.assertIs(r.verify_proof(proof, plan, c, Path('unused'), h), proof)
        for mutate in (
                lambda x: x['afterInventory']['admin'].update(sha256='0' * 64),
                lambda x: x['afterInventory']['api'].update(sha256='0' * 64),
                lambda x: x['afterInventory']['prisma'].update(sha256='0' * 64),
                lambda x: x['afterInventory']['engine'].update(sha256='0' * 64),
                lambda x: x['adminFiles'].update({'index.html': '0' * 64}),
                lambda x: x['apiModules'].update({'a.js': '0' * 64}),
                lambda x: x['workerFiles'].update({'workspace.py': '0' * 64}),
                lambda x: x['validation'].update(admin=True),
                lambda x: x.update(inheritedValidation={}),
                lambda x: x.update(businessActions=False)):
            candidate = copy.deepcopy(proof)
            mutate(candidate)
            with self.subTest(mutate=mutate), self.assertRaises(RuntimeError):
                r.verify_proof(candidate, plan, c, Path('unused'), h)

    def test_native_artifact_rejection_happens_before_extraction(self):
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ARTIFACT_CHANGED'):
            b.verify_previous_bundle(b'unreviewed bytes', {})

    def test_native_prior_run_or_artifact_mismatch_never_downloads_another_bundle(self):
        binding = r.PUBLISHED_PREVIOUS
        run = {'head_sha': r.CURRENT, 'head_branch': 'main', 'event': 'workflow_dispatch',
               'path': binding['workflowPath'], 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1}
        artifact = {'id': binding['artifactId'], 'name': binding['artifactName'],
                    'digest': binding['artifactDigest'], 'size_in_bytes': binding['artifactSize'],
                    'expired': False, 'workflow_run': {'id': int(binding['runId']), 'head_sha': r.CURRENT}}
        for field, value in (('head_sha', '0' * 40), ('path', 'wrong.yml'), ('run_attempt', 2),
                             ('conclusion', 'failure')):
            changed = {**run, field: value}
            with patch.object(b.subprocess, 'check_output', return_value=json.dumps(changed).encode()) as request:
                with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_NATIVE_RUN_CHANGED'):
                    b.previous_artifact({})
                self.assertEqual(request.call_count, 1)
        for field, value in (('id', 1), ('digest', 'sha256:' + '0' * 64), ('expired', True)):
            changed = {**artifact, field: value}
            with patch.object(b.subprocess, 'check_output', side_effect=[json.dumps(run).encode(),
                    json.dumps(changed).encode()]) as request:
                with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_NATIVE_ARTIFACT_CHANGED'):
                    b.previous_artifact({})
                self.assertEqual(request.call_count, 2)

    def test_local_worker_check_is_blocked_before_database_or_dependency_work(self):
        with patch.dict('os.environ', {'GITHUB_ACTIONS': 'false'}), patch.object(b, 'OUT', Path('/missing')):
            with self.assertRaisesRegex(RuntimeError, 'ISOLATED_CI_REQUIRED'):
                b.check_worker()

    def test_frozen_switch_adaptation_fails_closed_if_recipe_changes(self):
        old = r.helper('registration-parity-diagnostics-release.py')
        code = r.adapted_release_code(old.release)
        self.assertIsInstance(code, types.CodeType)
        with patch.object(r.inspect, 'getsource', return_value='def release():\n    pass\n'):
            with self.assertRaisesRegex(RuntimeError, 'FROZEN_SWITCH_RECIPE_CHANGED'):
                r.adapted_release_code(old.release)

    def test_public_readback_uses_inherited_admin_and_rejects_preservation_changes(self):
        c = self.ready()
        public = ('<html>v2-' + r.CURRENT + '</html>\n').encode()
        c['publicIndexSha256'] = r.digest(public)
        before = {name: {'containerId': name, 'image': name, 'reference': name, 'environmentSha256': 'env'}
                  for name in ('api', 'admin', 'online-recharge', *r.PRESERVED[1:])}
        after = copy.deepcopy(before)
        after['api']['containerId'] = 'new-api'
        after['online-recharge']['containerId'] = 'new-sidecar'
        c['runtimeConfigurationSha256'] = {role: 'config' for role in after}
        proof = {'afterInventory': c['baseline']['inventory']}
        receipt = {'before': before, 'database': {'hash': 'database'}, 'sqlite': {'hash': 'sqlite'},
                   'previousRoleProjections': {'api': {'commit': 'old-api'}, 'admin': {'commit': r.CURRENT},
                                               'online-recharge': {'commit': 'engine'}}}
        old, h, driver = Mock(), Mock(), Mock()
        h.configuration.return_value = 'config'
        old.runtime.return_value = proof['afterInventory']
        old.mysql_receipt.return_value = receipt['database']
        old.sqlite_receipt.return_value = receipt['sqlite']
        def command(*args, **kwargs):
            if args[:2] == ('docker', 'inspect'):
                return json.dumps([{'HostConfig': {'NetworkMode': 'container:new-api'}}])
            return (c['baseline']['schemaSha256'] if args[-1].endswith('schema.prisma')
                    else c['baseline']['nginxSha256']) + '  file'
        driver.run.side_effect = command
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='readback-', dir=parent) as directory:
            target = Path(directory)
            (target / 'release-manifest.json').write_text(json.dumps({
                'roleSourceProjections': receipt['previousRoleProjections']}))
            with patch.object(r, 'helper', return_value=old), patch.object(r.urllib.request, 'urlopen',
                    side_effect=lambda *args, **kwargs: io.BytesIO(public)) as read_public:
                r.smoke(driver, target, after, c, proof, receipt, h, Mock(), Mock())
                self.assertEqual(read_public.call_count, 1)
                for role in r.PRESERVED:
                    changed = copy.deepcopy(after)
                    changed[role]['image'] = 'unapproved'
                    with self.subTest(role=role), self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                        r.smoke(driver, target, changed, c, proof, receipt, h, Mock(), Mock())
                self.assertEqual(read_public.call_count, 1)

    def test_real_backup_wrapper_reaches_frozen_backup_and_verifies_s3_without_a_database(self):
        c = self.ready()
        closure = r.helper('registration-closure-release.py')
        parity = r.helper('registration-parity-diagnostics-release.py')
        summary = {'logicalSha256': 'a' * 64}
        c['baseline']['sqlite'] = summary
        payload = b'SYNTHETIC_BACKUP_BYTES'
        reads = Mock(return_value=summary)
        driver = Mock()
        driver.environment_values.return_value = {'MYSQL_BACKUP_S3_BUCKET': 'synthetic-backup'}
        head = {'ContentLength': len(payload), 'ChecksumSHA256': base64.b64encode(
            bytes.fromhex(r.digest(payload))).decode(), 'ServerSideEncryption': 'AES256'}
        driver.run.side_effect = ['', json.dumps(head)]
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        class Connection:
            def __init__(self, path, **kwargs):
                self.path = Path(unquote(urlsplit(path).path)) if isinstance(path, str) and path.startswith('file:') else Path(path)
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def execute(self, *args): return self
            def fetchall(self): return [('ok',)]
            def backup(self, destination): destination.path.write_bytes(payload)
        with tempfile.TemporaryDirectory(prefix='backup-', dir=parent) as directory:
            base = Path(directory)
            (base / 'backups').mkdir()
            volume = base / 'volume'
            volume.mkdir()
            (volume / 'database.db').write_bytes(b'SYNTHETIC_SOURCE')
            marker = volume / '.maintenance'
            marker.write_bytes(b'controlled-owner')
            safety = base / 'release_safety.py'
            safety.write_bytes(b'synthetic safety')
            def helper(name):
                if name == 'registration-parity-diagnostics-release.py': return parity
                if name == 'registration-flow-v4-release.py': return types.SimpleNamespace(sqlite_receipt=reads)
                raise AssertionError('unexpected helper')
            with patch.object(r, 'helper', side_effect=helper), patch.object(closure, 'BASE', base), \
                    patch.object(closure, 'load', return_value=types.SimpleNamespace(logical_summary=lambda db: summary)), \
                    patch.object(sqlite3, 'connect', side_effect=Connection) as connect:
                value = r.backup_sqlite(closure, driver, base, {'commit': 'b' * 40, 'workflowRunId': '123'},
                                        {}, marker, safety, c)
            self.assertTrue(value['s3Verified'])
            self.assertEqual(value['logical'], summary)
            self.assertEqual(value['sha256'], r.digest(payload))
            self.assertEqual(reads.call_args_list[0].args, (driver, base, c, None))
            self.assertEqual(reads.call_args_list[1].args, (driver, base, c, summary['logicalSha256']))
            self.assertEqual(connect.call_count, 3)
            self.assertEqual(driver.run.call_args_list[0].args[:3], ('aws', 's3api', 'put-object'))
            self.assertEqual(driver.run.call_args_list[1].args[:3], ('aws', 's3api', 'head-object'))

    def test_adapted_switch_operates_api_only_and_rebinds_existing_sidecar(self):
        parent = r.ROOT / '.runtime/registration-terminal-stop-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='switch-', dir=parent) as directory:
            base = Path(directory)
            previous = base / 'releases/previous'
            previous.mkdir(parents=True)
            (base / '.staging').mkdir()
            (base / '.deploy.lock').touch()
            manifest = {'commit': r.CURRENT, 'roleSourceProjections': {
                'api': {'commit': r.CURRENT}, 'admin': {'commit': r.CURRENT}, 'online-recharge': {'commit': 'd' * 40}},
                'images': {}}
            raw_manifest = json.dumps(manifest).encode()
            (previous / 'release-manifest.json').write_bytes(raw_manifest)
            (previous / 'compose.release.json').write_text(json.dumps({'services': {
                'api': {'image': 'old-api'}, 'admin': {'image': 'old-admin'}}}))
            before = {name: {'containerId': 'old-' + name, 'image': 'base-' + name} for name in
                      ('api', 'admin', 'online-recharge', *r.PRESERVED[1:])}
            after = copy.deepcopy(before)
            after['api'] = {'containerId': 'new-api', 'image': 'new-api-image'}
            after['online-recharge']['containerId'] = 'new-sidecar'
            observed = {'database': {'hash': 'db'}, 'sqlite': {'logicalSha256': 'sqlite'}}
            a, finite, h, driver = Mock(), Mock(), Mock(), Mock()
            driver.assert_no_active_recharge = Mock()
            driver.assert_no_active_registration = Mock()
            a.write_release_override.side_effect = lambda path, value: path.write_text(json.dumps(value))
            finite.claim_markers.return_value = {'paths': ['unused', str(base / 'marker')]}
            h.base_image_reference.return_value = 'published-api'
            h.fresh_scoped_backup.return_value = {'s3Verified': True}
            h.snapshot.return_value = after
            driver.run.return_value = json.dumps([{'Id': 'new-api-image'}])
            proof = {'sources': {}, 'apiModules': {}, 'adminFiles': {}, 'workerFiles': {'apple_mailboxes.py': '1' * 64}}
            plan = {'mode': 'release', 'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123',
                    'workflowRunAttempt': '1', 'runtimeBaseline': observed, 'controlSources': {},
                    'artifactSha256': r.digest(b'archive'), 'buildProofSha256': r.digest(json.dumps(proof).encode()),
                    'artifactUrl': 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                                   + r.NAME + '-' + 'a' * 40 + '/' + r.NAME + '-artifact.tar.gz'}
            contract = {'scope': r.SCOPE, 'expectedCurrent': r.CURRENT, 'migration': None, 'frozen': True,
                        'sources': {}, 'hostSourceInheritance': {'files': {}}, 'backupNormalizerPath': 'normalizer',
                        'baselineWorkerFiles': {'release_safety.py': r.digest(b'safety')},
                        'sourceProjectionSha256': {}, 'sourceBaseline': r.CURRENT, 'sourceBaselineTree': r.SOURCE_TREE,
                        'roleSourceCommits': {}, 'reviewedApplicationCommit': plan['commit']}
            safety = previous / r.WORKER / 'release_safety.py'
            safety.parent.mkdir(parents=True)
            safety.write_bytes(b'safety')
            old = r.helper('registration-parity-diagnostics-release.py')
            payload = base / 'payload'
            (payload / 'api/worker').mkdir(parents=True)
            (payload / 'api/worker/apple_mailboxes.py').write_bytes(b'candidate')
            (payload / 'build-proof.json').write_text(json.dumps(proof))
            helpers = {'recharge-availability-release.py': a, 'proxy-result-identity-release.py': finite}
            values = {**old.__dict__, 'BASE': base, 'CURRENT': r.CURRENT, 'SCOPE': r.SCOPE,
                      'PRESERVED': r.PRESERVED, 'need': r.need, 'verify_contract': Mock(),
                      'helper': lambda name: helpers.get(name, Mock()), 'baseline': Mock(return_value=(
                          previous, raw_manifest, before, observed)), 'archive': Mock(return_value=payload),
                      'verify_proof': Mock(return_value=proof), 'inherited_host_source': lambda c: previous,
                      'sqlite_receipt': Mock(return_value=observed['sqlite']),
                      'backup_sqlite': Mock(return_value={'s3Verified': True, 'logical': observed['sqlite']}),
                      'smoke': Mock()}
            execute = types.FunctionType(r.adapted_release_code(old.release), values)
            with patch.object(old.urllib.request, 'urlopen', return_value=io.BytesIO(b'archive')):
                result = execute(plan, contract, driver, h)
            self.assertEqual(result['updatedServices'], ['api'])
            self.assertEqual(result['reboundServices'], ['online-recharge'])
            self.assertEqual(set(result['images']), {'api'})
            builds = h.build_image.call_args_list
            self.assertEqual(len(builds), 1)
            dockerfile = (builds[0].args[1] / 'Dockerfile').read_text()
            self.assertIn('COPY worker/', dockerfile)
            self.assertNotIn('COPY modules/', dockerfile)
            self.assertNotIn('html', dockerfile)
            commands = driver.compose.call_args_list
            self.assertEqual([call.args[1:] for call in commands], [
                ('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api'),
                ('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge')])
            target = driver.point_current.call_args.args[0]
            value = json.loads((target / 'release-manifest.json').read_bytes())
            self.assertEqual(value['roleSourceProjections']['admin'], manifest['roleSourceProjections']['admin'])
            self.assertEqual(value['roleSourceProjections']['online-recharge'], manifest['roleSourceProjections']['online-recharge'])
            self.assertEqual(json.loads((target / 'compose.release.json').read_bytes())['services']['admin']['image'], 'old-admin')
            self.assertEqual(value['servicesUpdated'], ['api'])


if __name__ == '__main__':
    unittest.main()
