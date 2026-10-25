"""Offline publication, unchanged-image startup and recovery-failure tests."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('online-profile-lock-release.py')


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / r.CONTRACT_FILE).read_bytes())
        self.qa = {'source': {'head': r.SOURCE, 'tree': r.SOURCE_TREE, 'pullRequest': 717,
                             'runId': '123', 'sourceReceiptSha256': 'f' * 64},
                   'control': {'head': 'c' * 40, 'tree': 'b' * 40, 'pullRequest': 718,
                               'runId': '124', 'sourceReceiptSha256': 'e' * 64},
                   'main': {'head': 'a' * 40}, 'commit': 'a' * 40, 'tree': 'b' * 40}
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '125', 'workflowRunAttempt': '1',
                     'contractSha256': r.sha((HERE / r.CONTRACT_FILE).read_bytes()),
                     'controlSources': {**self.c['controlPins'], r.CONTRACT_FILE: r.sha((HERE / r.CONTRACT_FILE).read_bytes())},
                     'qualitySourceEvidence': self.qa, 'nativeParentCapture': {
                         'status': 'ONLINE_PROFILE_LOCK_PARENT_VERIFIED', 'baseline': {'expectedCurrent': r.CURRENT}}}

    def proof(self):
        return {**self.plan, 'version': 1, 'scope': r.SCOPE, 'sources': self.c['sources'],
                'imagesRebuilt': False, 'migrationPerformed': False, 'businessActions': 0,
                'files': {'source/' + n: v for n, v in self.c['sources'].items()}}

    def test_exact_reviewed_contract_and_source_only_payload(self):
        r.validate_contract(self.c)
        proof = self.proof()
        r.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_current_publication_controls_match_live_reviewed_files(self):
        # The legacy contract uses its historical bundle; this publication must
        # independently check every current executable control and its new helper.
        for name, digest in self.c['controlPins'].items():
            self.assertEqual(r.sha((HERE / name).read_bytes()), digest, name)
        for name in ('online-checkout-release.py', 'online-profile-lock-recovery.py'):
            self.assertEqual(self.c['controlPins'][name], self.c['sources']['scripts/production-release/' + name])

    def test_rejects_account_instance_source_parent_images_or_business_scope_changes(self):
        for field, value in [('awsTargetAccount', '000000000000'), ('awsTargetInstance', 'i-other'),
                             ('sourceReviewCommit', 'f' * 40), ('expectedCurrent', 'f' * 40),
                             ('migrationPerformed', True), ('businessActions', 1), ('businessActions', False)]:
            changed = copy.deepcopy(self.c)
            changed[field] = value
            with self.assertRaises(RuntimeError):
                r.validate_contract(changed)
        for field in r.SEALED:
            changed = copy.deepcopy(self.c)
            changed[field][next(iter(changed[field]))] = 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'CONTENT_CHANGED'):
                r.validate_contract(changed)

    def test_rejects_unreviewed_native_quality_and_extra_binary_payload(self):
        for part, key, value in [('source', 'head', 'e' * 40), ('control', 'tree', 'e' * 40),
                                 ('source', 'sourceReceiptSha256', ''), ('main', 'head', 'e' * 40)]:
            proof = self.proof()
            proof['qualitySourceEvidence'] = copy.deepcopy(self.qa)
            proof['qualitySourceEvidence'][part][key] = value
            plan = {**self.plan, 'qualitySourceEvidence': proof['qualitySourceEvidence']}
            with self.assertRaises(RuntimeError):
                r.verify_proof(proof, plan, self.c, proof['files'])
        proof = self.proof()
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
            r.verify_proof(proof, self.plan, self.c, {**proof['files'], 'api/unreviewed.js': 'e' * 64})
        proof['imagesRebuilt'] = True
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            r.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_start_existing_checks_identity_and_does_not_repeat_start_for_running_containers(self):
        before = {name: {'image': 'i', 'reference': 'r', 'containerId': name, 'environmentSha256': 'e',
                         'status': 'running'} for name in r.UPDATED}
        rows = {name: {'Id': name, 'Image': 'i', 'Config': {'Image': 'r', 'Env': ['SYNTHETIC=1']},
                       'State': {'Status': 'running'}} for name in r.UPDATED}
        def compose(_directory, *args, **_kwargs):
            if args[0] == 'ps':
                self.assertEqual(args[1:3], ('--all', '--quiet'))
                return args[-1]
            self.assertEqual(args[0], 'start')
            rows[args[-1]]['State']['Status'] = 'running'
        d = SimpleNamespace(service_state=Mock(side_effect=AssertionError('Running-only snapshot not allowed')),
                            compose=Mock(side_effect=compose), wait_healthy=Mock(),
                            run=Mock(side_effect=lambda *args: json.dumps([rows[args[-1]]])),
                            historical_fingerprint=Mock(return_value='e'))
        r.start_existing(d, Path('/synthetic-release'), before)
        self.assertEqual([c.args[1] for c in d.compose.call_args_list], ['ps', 'ps'])
        self.assertEqual(d.wait_healthy.call_count, 2)
        rows['api']['State']['Status'] = 'exited'
        rows['online-recharge']['State']['Status'] = 'exited'
        r.start_existing(d, Path('/synthetic-release'), before)
        self.assertEqual([c.args[-1] for c in d.compose.call_args_list if c.args[1] == 'start'], list(r.UPDATED))
        d.service_state.assert_not_called()
        rows['api']['Image'] = 'different'
        d.compose.reset_mock()
        with self.assertRaisesRegex(RuntimeError, 'CONTAINER_CHANGED'):
            r.start_existing(d, Path('/synthetic-release'), before)
        self.assertEqual([c.args[1] for c in d.compose.call_args_list], ['ps'])

    def test_unknown_exception_details_never_leave_the_report(self):
        report = r.failure_report(RuntimeError('synthetic-private-cookie-details'), {'mode': 'release'})
        self.assertEqual(report['code'], 'ONLINE_PROFILE_LOCK_UNCONFIRMED')
        self.assertNotIn('cookie', json.dumps(report))

    def test_real_loader_uses_only_global_marker_after_registration_retirement(self):
        output = HERE.parents[1] / '.runtime/profile-lock-recovery-20261025/publication-tests'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory, patch.object(r, 'BASE', Path(directory)):
            owner = r.load('proxy-result-identity-release.py')
            d = SimpleNamespace(run=Mock(side_effect=AssertionError('No legacy mount inspection')))
            receipt = owner.claim_markers(d, {}, self.plan)
            self.assertEqual(receipt['paths'], [str(Path(directory) / 'maintenance.json')])
            self.assertTrue(receipt['registrationRetired'])
            self.assertEqual(json.loads(Path(receipt['paths'][0]).read_bytes())['scope'], r.SCOPE)
            with self.assertRaises(FileExistsError):
                owner.claim_markers(d, {}, self.plan)
            owner.release_markers(receipt)
            self.assertFalse(Path(receipt['paths'][0]).exists())
            d.run.assert_not_called()

    def test_real_loader_retired_guards_reject_restored_mount_and_active_tasks(self):
        output = HERE.parents[1] / '.runtime/profile-lock-recovery-20261025/publication-tests'
        output.mkdir(parents=True, exist_ok=True)
        states = {role: {'containerId': role + '-cid'} for role in r.SERVICES}
        row = {'Config': {'Labels': {'com.docker.compose.project': 'synthetic-id'}},
               'Mounts': [], 'NetworkSettings': {'Networks': {'synthetic-id-default': {}}}}
        def read(*args):
            if args[1] == 'inspect': return json.dumps([row])
            if args[1] in ('ps', 'exec'): return ''
            raise AssertionError('Unexpected runtime read')
        d = SimpleNamespace(run=Mock(side_effect=read), assert_no_active_recharge=Mock(),
                            compose=Mock(return_value='{"busy":0}'))
        with tempfile.TemporaryDirectory(dir=output) as directory, patch.object(r, 'BASE', Path(directory)):
            h = r.load('recharge-record-release.py')
            self.assertEqual(h.SERVICES, r.SERVICES)
            with patch.object(h, 'engine_idle'):
                h.guards(d, Path(directory), states, self.c)
                d.assert_no_active_recharge.assert_called_once()
                d.compose.return_value = '{"busy":1}'
                with self.assertRaisesRegex(RuntimeError, 'ONLINE_TASK_ACTIVE'):
                    h.guards(d, Path(directory), states, self.c)
                d.compose.return_value = '{"busy":0}'
                row['Mounts'] = [{'Destination': '/app/.runtime/auto-registration'}]
                with self.assertRaisesRegex(RuntimeError, 'RETIRED_MOUNT_RETURNED'):
                    h.guards(d, Path(directory), states, self.c)
        report = r.failure_report(RuntimeError('ONLINE_QUERY_NETWORK_RETIRED_MOUNT_RETURNED'), {'mode': 'release'})
        self.assertEqual(report['code'], 'ONLINE_QUERY_NETWORK_RETIRED_MOUNT_RETURNED')

    def fixture(self, recovery_error=None):
        output = HERE.parents[1] / '.runtime/profile-lock-recovery-20261025/publication-tests'
        output.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=output)
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        patch.object(r, 'BASE', base).start()
        self.addCleanup(patch.stopall)
        previous = base / 'releases/previous'
        previous.mkdir(parents=True)
        (base / 'current').symlink_to(previous)
        (base / '.staging').mkdir()
        (previous / 'scripts/production-release').mkdir(parents=True)
        manifest = {'commit': r.CURRENT, 'status': 'DEPLOYED', 'images': {
            name: {'digest': image, 'sourceCommit': r.CURRENT} for name, image in self.c['expectedImages'].items()}}
        (previous / 'release-manifest.json').write_text(json.dumps(manifest))
        before = {name: {'image': self.c['expectedImages'][name], 'reference': 'synthetic:' + name,
                        'containerId': str(index) * 64, 'environmentSha256': 'd' * 64,
                        'status': 'running', 'health': 'healthy', 'startedAtSha256': '0' * 64}
                  for index, name in enumerate(r.SERVICES, 1)}
        live = copy.deepcopy(before)
        baseline = {'current': str(previous), 'expectedCurrent': r.CURRENT,
                    'manifestSha256': r.sha((previous / 'release-manifest.json').read_bytes()),
                    'services': before, 'runtimeConfigurationSha256': {name: 'same-config' for name in r.SERVICES}}
        plan = copy.deepcopy(self.plan)
        plan['nativeParentCapture']['baseline'] = baseline
        events = []
        def compose(_directory, command, *args, **_kwargs):
            if command == 'ps':
                self.assertEqual(args[:2], ('--all', '--quiet'))
                return live[args[-1]]['containerId']
            name = args[0]
            events.append(command + ':' + name)
            self.assertIn(command, ('start', 'stop'))
            self.assertIn(name, r.UPDATED)
            live[name]['status'] = 'exited' if command == 'stop' else 'running'
            live[name]['health'] = None if command == 'stop' else 'healthy'
            if command == 'start':
                live[name]['startedAtSha256'] = '1' * 64
        def point(target, _stamp):
            events.append('publish-pointer')
            (base / 'current').unlink()
            (base / 'current').symlink_to(target)
        d = SimpleNamespace(compose=Mock(side_effect=compose), wait_healthy=Mock(),
                            service_state=lambda _dir, name, **kw: copy.deepcopy(live[name]),
                            run=lambda *_args: json.dumps([{'Id': value['containerId'], 'Image': value['image'],
                                'Config': {'Image': value['reference'], 'Env': ['SYNTHETIC=1']},
                                'State': {'Status': value['status']}} for value in live.values()
                                if value['containerId'] == _args[-1]]),
                            historical_fingerprint=lambda _value: 'd' * 64,
                            point_current=Mock(side_effect=point))
        real_h = load('recharge-record-release.py')
        h = SimpleNamespace(snapshot=lambda _d, _directory: copy.deepcopy(live),
                            configuration=lambda _d, _state: 'same-config', guards=Mock(),
                            safe_archive=real_h.safe_archive, file_inventory=real_h.file_inventory,
                            fresh_scoped_backup=Mock(return_value={'s3Verified': True}))
        source = base / 'fixture-payload/payload'
        for name, expected in self.c['sources'].items():
            raw = subprocess.check_output(['git', 'show', r.SOURCE + ':' + name], cwd=HERE)
            self.assertEqual(r.sha(raw), expected)
            target = source / 'source' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        proof = {**plan, 'version': 1, 'scope': r.SCOPE, 'sources': self.c['sources'],
                 'imagesRebuilt': False, 'migrationPerformed': False, 'businessActions': 0,
                 'files': h.file_inventory(source)}
        proofraw = json.dumps(proof).encode()
        (source / 'build-proof.json').write_bytes(proofraw)
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:gz') as archive:
            archive.add(source, arcname='payload')
        artifact = buf.getvalue()
        plan.update(artifactSha256=r.sha(artifact), buildProofSha256=r.sha(proofraw),
                    artifactUrl='https://github.com/wangchaozhuanyong/id-business-system/releases/download/' +
                    r.PREFIX + '-' + plan['commit'] + '/' + r.PREFIX + '-artifact.tar.gz')
        patch.object(r.urllib.request, 'urlopen', return_value=io.BytesIO(artifact)).start()
        class Fence:
            def __init__(self, *_args): pass
            def acquire(self): events.append('fence-acquired')
            def check_idle(self): events.append('idle')
            def close(self): events.append('fence-closed')
        def claim(*_args):
            (base / 'maintenance.json').write_text('owned synthetic marker')
            return {'synthetic': True}
        def release_marker(_marker):
            self.assertEqual((base / 'maintenance.json').read_text(), 'owned synthetic marker')
            (base / 'maintenance.json').unlink()
        owner = SimpleNamespace(claim_markers=claim, release_markers=release_marker,
                                sql_fence_class=lambda _c: Fence, engine_content=Mock())
        availability = load('recharge-availability-release.py')
        def module(name):
            if name == 'recharge-availability-release.py': return availability
            if name == 'proxy-result-identity-release.py': return owner
            raise AssertionError('Unexpected helper: ' + name)
        patch.object(r, 'load', side_effect=module).start()
        def recover(*_args):
            events.append('recover')
            self.assertEqual([live[name]['status'] for name in r.UPDATED], ['exited', 'exited'])
            self.assertTrue((base / 'maintenance.json').is_file())
            if recovery_error: raise recovery_error
            return {'version': 1, 'profilesExamined': 1, 'profilesRecovered': 1,
                    'lockEntriesArchived': 3, 'profileDataModified': False}
        real_p = load('online-checkout-release.py')
        p = SimpleNamespace(profile_recovery_source=lambda _plan: SimpleNamespace(recover=recover),
                            stop_recharge_and_recover=real_p.stop_recharge_and_recover, read_hashes=Mock())
        patch.object(r, 'helpers', return_value=(h, d, p)).start()
        patch.object(r, 'capture', return_value=baseline).start()
        return base, previous, before, plan, events, d, h, p

    def test_full_publication_and_independent_readback_keep_every_image_and_config(self):
        base, previous, before, plan, events, d, _h, _p = self.fixture()
        result = r.release({**plan, 'mode': 'release'}, self.c)
        self.assertEqual(result['status'], 'ONLINE_PROFILE_LOCK_DEPLOYED')
        self.assertEqual(result['profileLockRecovery']['profilesRecovered'], 1)
        self.assertEqual([e for e in events if e.startswith(('stop:', 'start:'))],
                         ['stop:online-recharge', 'stop:api', 'start:api', 'start:online-recharge'])
        self.assertLess(events.index('stop:api'), events.index('recover'))
        self.assertLess(events.index('recover'), events.index('start:api'))
        self.assertLess(events.index('start:online-recharge'), events.index('publish-pointer'))
        target = (base / 'current').resolve()
        self.assertNotEqual(target, previous)
        manifest = json.loads((target / 'release-manifest.json').read_bytes())
        self.assertEqual(manifest['images'], json.loads((previous / 'release-manifest.json').read_bytes())['images'])
        self.assertFalse((base / 'maintenance.json').exists())
        readback = r.release({**plan, 'mode': 'readback'}, self.c)
        self.assertEqual(readback['status'], 'ONLINE_PROFILE_LOCK_INDEPENDENT_READBACK_VERIFIED')
        self.assertFalse(readback['imagesRebuilt'])
        self.assertEqual(d.point_current.call_count, 1)

    def test_recovery_failure_restores_existing_services_without_advancing_release(self):
        base, previous, _before, plan, events, d, _h, _p = self.fixture(
            RuntimeError('ONLINE_CHECKOUT_PROFILE_LOCK_OWNER_UNKNOWN'))
        with self.assertRaisesRegex(RuntimeError, 'LOCK_OWNER_UNKNOWN'):
            r.release({**plan, 'mode': 'release'}, self.c)
        self.assertEqual((base / 'current').resolve(), previous)
        d.point_current.assert_not_called()
        self.assertFalse((base / 'maintenance.json').exists())
        journal = next((base / '.staging').glob('*/switch-state.json'))
        self.assertEqual(json.loads(journal.read_bytes())['servicesRestored'], True)
        self.assertEqual([e for e in events if e.startswith('start:')], ['start:api', 'start:online-recharge'])

    def test_publication_transport_and_workflow_have_finite_identity_and_acceptance_guards(self):
        source = (HERE / 'online-profile-lock-publication.py').read_text()
        for value in ('COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN', 'NATIVE_RECEIPT_IDENTITY',
                      'AWS_MAX_ATTEMPTS', '098208446664', 'i-0838cebf64f0e2a89', 'NATIVE_ARTIFACT_CHANGED'):
            self.assertIn(value, source)
        self.assertNotIn("load(PREFIX + '-build.py')", source)
        workflow = (HERE.parents[1] / '.github/workflows/online-profile-lock-publication.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('needs: validate', workflow)
        self.assertIn('inputs.commit == github.sha', workflow)
        diagnostic = workflow.split('  original-diagnostic:', 1)[1]
        self.assertIn("inputs.operation == 'read_original_diagnostic'", diagnostic)
        self.assertIn('get-command-invocation', diagnostic)
        self.assertIn('9fb9dfc0-01da-4053-9274-452d58d4e444', diagnostic)
        self.assertNotIn('send-command', diagnostic)
        self.assertNotIn('publish\n', diagnostic)


if __name__ == '__main__':
    unittest.main()
