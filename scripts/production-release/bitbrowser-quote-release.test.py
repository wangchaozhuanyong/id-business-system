"""Offline negative cases for the finite admin successor and preserved live API."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('bitbrowser-quote-release.py')
B = load('bitbrowser-quote-publication.py')


class QuoteTierPublicationTests(unittest.TestCase):
    def setUp(self):
        (P.ROOT / '.runtime').mkdir(exist_ok=True)
        self.c = json.loads((HERE / P.CONTRACT_FILE).read_bytes())

    def test_exact_frozen_inputs(self):
        B.check(self.c)
        self.assertEqual(set(self.c['productionSources']), P.SOURCES)
        self.assertEqual(P.MODULES, frozenset())

    def test_scope_parent_and_side_effect_widening_rejected(self):
        mutations = [
            lambda c: c['productionSources'].update({'unrelated.ts': 'a' * 64}),
            lambda c: c['validationSources'].clear(),
            lambda c: c['apiModules'].append('other.js'),
            lambda c: c.update(updatedServices=['api', 'admin']),
            lambda c: c.update(reboundServices=['online-recharge']),
            lambda c: c.update(preservedServices=['mysql']),
            lambda c: c.update(migrationPerformed=True),
            lambda c: c.update(businessActions=1),
            lambda c: c.update(expectedCurrent='b' * 40),
            lambda c: c.update(sourceReviewCommit='c' * 40),
            lambda c: c.update(absentSources=[]),
            lambda c: c['sourceParents'].clear(),
            lambda c: c['parentPlan'].update(commit='b' * 40),
            lambda c: c['adminParent'].update(commit='b' * 40),
            lambda c: c['adminParent']['adminFiles'].clear(),
            lambda c: c.update(sqlFenceHelperSha256='d' * 64)
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                c = copy.deepcopy(self.c)
                mutate(c)
                with self.assertRaises(RuntimeError):
                    P.validate_contract(c)

    def test_native_lock_backup_fence_and_admin_merge_remain_inherited(self):
        p = P.engine(self.c)
        self.assertEqual(p.UPDATED, ('admin',))
        self.assertEqual(p.REBOUND, ())
        self.assertIn('api', p.PRESERVED)
        self.assertIn('online-recharge', p.PRESERVED)
        self.assertEqual(p.RECIPE, p.FOLLOWUP)
        self.assertNotEqual(p.RECIPE, p.BOUNDED)
        for function in (p.release, p.baseline, p.activate_services, p.smoke, p.verify_admin_merge):
            self.assertTrue(function.__code__.co_filename.endswith('bitbrowser-history-release.py'))
        self.assertEqual(p.runtime.__code__.co_filename, p.smoke.__code__.co_filename)

    def capture(self):
        ancestor = copy.deepcopy(self.c['parentPlan']['nativeParentCapture']['baseline'])
        runtime = ancestor.pop('runtime')
        ancestor.update(runtime)
        ancestor.update(commit=P.CURRENT, current='/opt/id-business-v2/releases/synthetic-current',
                        proofs={'online-readonly-probe-build-proof.json': self.c['parentPlan']['buildProofSha256']})
        return {'status': 'BITBROWSER_QUOTE_PARENT_VERIFIED', 'baseline': ancestor,
                'parentPlanSha256': self.c['parentPlanSha256'], 'businessActions': 0}

    def test_parent_capture_requires_finite_native_identity_before_reading(self):
        raw = (HERE / P.CONTRACT_FILE).read_bytes()
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '1', 'workflowRunAttempt': '1',
                'mode': 'parent', 'recipe': P.RECIPE, 'contractSha256': P.sha(raw),
                'controlSources': {**self.c['controlPins'], P.CONTRACT_FILE: P.sha(raw)}}
        with patch.object(P, 'capture', return_value=self.capture()) as reader:
            P.release(plan, self.c)
            self.assertEqual(reader.call_count, 1)
            for field, value in [('commit', '../other'), ('tree', ''), ('workflowRunId', '0'),
                                 ('workflowRunAttempt', '1;command'), ('mode', 'migrate'), ('recipe', 'other')]:
                with self.assertRaisesRegex(RuntimeError, 'PLAN_IDENTITY_INVALID'):
                    P.release({**plan, field: value}, self.c)
            self.assertEqual(reader.call_count, 1)

    def test_current_parent_capture_is_required_and_scope_tampering_rejected(self):
        value = self.capture()
        P.verify_capture(value, self.c)
        for mutate in (lambda v: v.update(businessActions=1),
                       lambda v: v.update(status='unverified'),
                       lambda v: v.update(parentPlanSha256='f' * 64),
                       lambda v: v['baseline'].update(commit='e' * 40),
                       lambda v: v['baseline']['services'].pop('api'),
                       lambda v: v['baseline']['database'].update(pending=1),
                       lambda v: v['baseline']['apiModules'].update({'unrelated.js': 'a' * 64}),
                       lambda v: v['baseline'].update(current='/tmp/unrelated')):
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.assertRaises(RuntimeError):
                P.verify_capture(changed, self.c)
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_BASELINE_CHANGED'):
            P.verify_capture(value, {**self.c, 'baseline': {}})

    def test_historical_constructor_inputs_are_closed_and_existing_objects_need_no_fetch(self):
        calls = []
        B.ensure_reconstruction_commits(self.c, lambda *args: calls.append(args) or b'')
        self.assertEqual(len(calls), 54)
        self.assertTrue(all(args[:3] == ('git', 'cat-file', '-e') for args in calls))
        for mutate in (lambda c: c['reconstructionCommits'].pop(),
                       lambda c: c['reconstructionCommits'].append('a' * 40),
                       lambda c: c['previousReadOnlyCapture'].update(commandId='other')):
            changed = copy.deepcopy(self.c)
            mutate(changed)
            with self.assertRaisesRegex(RuntimeError, 'RECONSTRUCTION_INPUTS_CHANGED'):
                P.validate_contract(changed)

    def test_missing_constructor_object_fetches_only_the_exact_commit_and_checks_it_again(self):
        import os
        import subprocess
        calls = []
        fetched = False
        missing = self.c['reconstructionCommits'][0]
        def runner(*args):
            nonlocal fetched
            calls.append(args)
            if args[:2] == ('git', 'fetch'):
                fetched = True
            elif args[-1] == missing + '^{commit}' and not fetched:
                raise subprocess.CalledProcessError(128, args)
            return b''
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': B.REPO}):
            B.ensure_reconstruction_commits(self.c, runner)
        self.assertEqual(calls[:3], [
            ('git', 'cat-file', '-e', missing + '^{commit}'),
            ('git', 'fetch', '--no-tags', '--no-write-fetch-head', '--depth=1', 'origin', missing),
            ('git', 'cat-file', '-e', missing + '^{commit}')])
        self.assertEqual(sum(args[:2] == ('git', 'fetch') for args in calls), 1)
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}):
            with self.assertRaisesRegex(RuntimeError, 'MISSING_HISTORICAL_SOURCE'):
                B.ensure_reconstruction_commits(self.c, lambda *args: (_ for _ in ()).throw(subprocess.CalledProcessError(128, args)))

    def test_previous_read_only_receipt_requires_original_identity_success_and_bounded_payload(self):
        import base64
        import zlib
        value = self.capture()
        invocation = {'CommandId': self.c['previousReadOnlyCapture']['commandId'], 'InstanceId': B.INSTANCE,
                      'DocumentName': 'AWS-RunShellScript', 'PluginName': 'aws:runShellScript',
                      'Status': 'Success', 'ResponseCode': 0, 'StandardErrorContent': '',
                      'StandardOutputContent': json.dumps({'zlibBase64': base64.b64encode(zlib.compress(P.canonical(value))).decode()})}
        self.assertEqual(B.previous_capture(invocation, self.c), value)
        for field, replacement in [('CommandId', 'other'), ('InstanceId', 'other'), ('Status', 'InProgress'),
                                   ('ResponseCode', False), ('ResponseCode', 1), ('StandardErrorContent', 'unknown')]:
            with self.assertRaisesRegex(RuntimeError, 'PREVIOUS_RECEIPT_IDENTITY'):
                B.previous_capture({**invocation, field: replacement}, self.c)
        expanded = {**invocation, 'StandardOutputContent': json.dumps({'zlibBase64': base64.b64encode(zlib.compress(b' ' * (128 * 1024 + 1))).decode()})}
        with self.assertRaisesRegex(RuntimeError, 'PREVIOUS_RECEIPT_BOUND'):
            B.previous_capture(expanded, self.c)

    def proof(self):
        files = {n: '1' * 64 for n in self.c['adminParent']['adminFiles']}
        qa = {'sources': {'commit': P.SOURCE, 'pullRequest': P.SOURCE_PR, 'runId': '1',
                          'sourceReceiptSha256': 'a' * 64},
              'release': {'commit': 'b' * 40, 'runId': '2'}}
        return {'version': 1, 'commit': 'b' * 40, 'tree': 'c' * 40,
                'workflowRunId': '3', 'workflowRunAttempt': '1', 'contractSha256': 'd' * 64,
                'scope': P.SCOPE, 'recipe': P.RECIPE, 'qualityVerification': qa,
                'productionSources': self.c['productionSources'], 'controlSources': self.c['controlPins'],
                'baselineAdminReproduced': True, 'baselineAdminFiles': self.c['adminParent']['adminFiles'],
                'migrationPerformed': False, 'businessActions': 0,
                'nativeParentCapture': self.capture(), 'apiModules': {}, 'adminFiles': files, 'files': {
                    **{'admin/html/' + n: v for n, v in files.items()},
                    **{'source/' + n: v for n, v in self.c['productionSources'].items()}}}

    def test_payload_api_and_quality_tampering_rejected(self):
        proof = self.proof()
        h = type('Inventory', (), {'file_inventory': staticmethod(lambda _: dict(proof['files']))})
        P.verify_proof(proof, proof, self.c, None, h)
        for key, value in [('businessActions', 1), ('migrationPerformed', True),
                           ('baselineAdminReproduced', False), ('baselineAdminFiles', {}),
                           ('productionSources', {}), ('adminFiles', {}),
                           ('apiModules', {'other.js': 'e' * 64}), ('qualityVerification', {})]:
            with self.subTest(key=key):
                changed = copy.deepcopy(proof)
                changed[key] = value
                with self.assertRaises((RuntimeError, KeyError)):
                    P.verify_proof(changed, changed, self.c, None, h)
        proof['files']['api/modules/other.js'] = 'e' * 64
        with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
            P.verify_proof(proof, proof, self.c, None, h)

    def test_native_parent_must_be_reproduced_and_build_must_change(self):
        before = dict(self.c['adminParent']['adminFiles'])
        after = {**before, 'index.html': 'e' * 64}
        B.verify_delta(before, after, self.c)
        before['index.html'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PARENT_NOT_REPRODUCED'):
            B.verify_delta(before, after, self.c)
        before = dict(self.c['adminParent']['adminFiles'])
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_OUTPUT_UNCHANGED'):
            B.verify_delta(before, before, self.c)

    def test_historical_assets_preserved_and_mutated_old_assets_rejected(self):
        p = P.engine(self.c)
        before = {'index.html': 'a' * 64, 'assets/old.js': 'b' * 64}
        candidate = {'index.html': 'c' * 64, 'assets/new.js': 'd' * 64}
        baseline = {'count': len(before), 'sha256': P.sha(P.canonical(before))}
        merged = {**before, **candidate}
        self.assertEqual(p.verify_admin_merge(before, candidate, merged, baseline)['count'], 3)
        for actual in (candidate, {**merged, 'assets/old.js': 'e' * 64}):
            with self.assertRaises(RuntimeError):
                p.verify_admin_merge(before, candidate, actual, baseline)

    def test_transport_records_intent_and_never_retries_uncertain_send(self):
        import tempfile
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as name:
            with patch.object(B, 'OUT', Path(name)), patch.object(B.subprocess, 'run',
                    return_value=SimpleNamespace(returncode=1, stdout=b'')) as send:
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ACCEPTANCE_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '1'}, 'release')
                self.assertEqual(send.call_count, 1)
                with self.assertRaisesRegex(RuntimeError, 'COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN'):
                    B.transport({'commit': 'a' * 40, 'workflowRunId': '1'}, 'release')
                self.assertEqual(send.call_count, 1)

    def test_only_admin_image_builds_fresh_and_checks_unprivileged_readability(self):
        import tempfile
        from types import SimpleNamespace
        legacy = P.load('settled-checkout-release.py')
        original_load = legacy.load
        commands = []
        def build(driver, context, reference, role, before, stage):
            driver.run('docker', 'build', '--network', 'none', str(context))
        driver = SimpleNamespace(run=lambda *a, **kw: commands.append(a) or 'READABLE\n')
        fake = SimpleNamespace(helpers=lambda: (SimpleNamespace(build_image=build), driver, None))
        with patch.object(P, 'load', return_value=legacy), patch.object(legacy, 'load',
                side_effect=lambda name: fake if name == 'bitbrowser-history-release.py' else original_load(name)):
            p = P.engine(self.c)
            h, _, _ = p.helpers()
            with tempfile.TemporaryDirectory(dir=P.ROOT / '.runtime') as name:
                h.build_image(driver, Path(name), 'candidate', 'admin', {}, Path(name))
                with self.assertRaisesRegex(RuntimeError, 'ADMIN_ONLY_BUILD'):
                    h.build_image(driver, Path(name), 'candidate', 'api', {}, Path(name))
        self.assertEqual(commands[0][:3], ('docker', 'build', '--no-cache'))
        self.assertEqual(commands[1][:8], ('docker', 'run', '--rm', '--network', 'none', '--user', '101:101', '--entrypoint'))


if __name__ == '__main__':
    unittest.main()
