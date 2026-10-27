"""Finite publication rejects source, baseline, provenance and payload drift."""
import copy
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import unittest

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location('provider_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load('mailbox-provider-release.py')
p = load('mailbox-provider-publication.py')


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / m.CONTRACT_FILE).read_bytes())
        qa = {'sourceReviewCommit': m.SOURCE, 'commit': 'c' * 40, 'tree': 'd' * 40,
              'main': {'head': 'c' * 40}, 'source': {'head': 'b' * 40}, 'control': {'head': 'b' * 40}}
        self.plan = {'commit': 'c' * 40, 'tree': 'd' * 40, 'workflowRunId': '123',
                     'workflowRunAttempt': '1', 'contractSha256': 'e' * 64,
                     'controlSources': {'example.py': 'f' * 64}, 'nativeParentCapture': {'businessActions': 0},
                     'qualitySourceEvidence': qa}
        self.files = {'admin/html/index.html': '3' * 64,
                      **{'source/' + n: v for n, v in self.c['sources'].items()}}
        self.proof = {**copy.deepcopy(self.plan), 'scope': m.SCOPE, 'sources': self.c['sources'],
                      'baselineAdminFiles': self.c['baseline']['baselineAdminFiles'],
                      'baselineApiModules': self.c['baseline']['baselineApiModules'],
                      'apiModules': self.c['baseline']['baselineApiModules'], 'adminFiles': {'index.html': '3' * 64},
                      'files': self.files, 'baselineApiReproduced': True, 'baselineAdminSourceReproduced': True,
                      'migrationPerformed': False, 'businessActions': 0}

    def test_runtime_helpers_keep_all_seven_current_services(self):
        helper = m.helpers('recharge-record-release.py')
        self.assertEqual(set(helper.SERVICES), set(self.c['baseline']['runtime']['services']))
        self.assertEqual(len(helper.SERVICES), 7)

    def test_admin_reproduction_uses_its_immutable_source_separate_from_current_engine(self):
        source = (HERE / 'mailbox-provider-build.py').read_text()
        self.assertIn("'--detach', str(source_root), p.ADMIN_CURRENT", source)
        self.assertNotEqual(m.ADMIN_CURRENT, m.CURRENT)
        self.assertEqual(m.SOURCE_BASE, m.ADMIN_CURRENT)

    def test_exact_native_proof_is_accepted(self):
        m.verify_proof(self.proof, self.plan, self.c, self.files)

    def test_baseline_contract_is_fixed_to_the_independently_verified_parent(self):
        for key in ('current', 'manifestSha256', 'services', 'configurationSha256', 'runtimeConfigurationSha256'):
            changed = copy.deepcopy(self.c)
            changed['baseline']['runtime'][key] = 'changed'
            with self.subTest(key=key), self.assertRaises(RuntimeError): m.validate_contract(changed)

    def test_unknown_updated_services_and_side_effects_are_rejected(self):
        for key, value in [('updatedServices', ['admin', 'api']), ('preservedServices', []),
                           ('businessActions', 1), ('businessActions', False), ('migrationPerformed', True)]:
            changed = copy.deepcopy(self.c); changed[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): m.validate_contract(changed)

    def test_any_source_change_is_rejected(self):
        changed = copy.deepcopy(self.c)
        changed['sources'][next(iter(changed['sources']))] = '0' * 64
        with self.assertRaises(RuntimeError): m.validate_contract(changed)

    def test_every_native_identity_is_bound(self):
        for key in self.plan:
            changed = copy.deepcopy(self.proof); changed[key] = 'changed'
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.verify_proof(changed, self.plan, self.c, self.files)

    def test_baseline_bytes_must_be_reproduced(self):
        for key in ('baselineApiModules', 'baselineAdminFiles', 'apiModules'):
            changed = copy.deepcopy(self.proof); changed[key] = {'unknown': '0' * 64}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.verify_proof(changed, self.plan, self.c, self.files)

    def test_reproduction_flags_cannot_be_omitted_or_false(self):
        for key in ('baselineApiReproduced', 'baselineAdminSourceReproduced'):
            changed = copy.deepcopy(self.proof); changed[key] = False
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.verify_proof(changed, self.plan, self.c, self.files)

    def test_no_api_engine_secret_or_unrelated_source_can_enter_payload(self):
        for name in ('api/modules/orders.js', 'engine/worker.js', 'source/.env', 'admin/html/extra.js'):
            files = {**self.files, name: '0' * 64}; proof = {**self.proof, 'files': files}
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                m.verify_proof(proof, self.plan, self.c, files)

    def test_main_quality_cannot_refer_to_another_commit_even_if_copied_into_both_envelopes(self):
        changed = copy.deepcopy(self.proof); plan = copy.deepcopy(self.plan)
        changed['qualitySourceEvidence']['main']['head'] = plan['qualitySourceEvidence']['main']['head'] = '0' * 40
        with self.assertRaises(RuntimeError): m.verify_proof(changed, plan, self.c, self.files)

    def test_only_the_finite_business_and_publication_delta_is_reviewed(self):
        allowed = sorted(set(self.c['sources']) | p.CONTROLS)
        def git(*args):
            return '\n'.join(self.c['sources'] if args[-1] == m.SOURCE else allowed).encode()
        with patch.object(p, 'git', side_effect=git): p.reviewed_extensions(self.c)
        def bad_git(*args):
            return '\n'.join(self.c['sources'] if args[-1] == m.SOURCE else [*allowed, 'apps/api/src/other.ts']).encode()
        with patch.object(p, 'git', side_effect=bad_git), self.assertRaises(RuntimeError):
            p.reviewed_extensions(self.c)

    def test_wrong_pr_receipt_tree_and_missing_admin_checks_are_rejected(self):
        head, tree = 'b' * 40, 'd' * 40
        run = {'head_sha': head, 'event': 'pull_request', 'conclusion': 'success', 'id': 321, 'run_attempt': 1}
        receipt = {'repository': p.REPO, 'pullRequest': 123, 'headSha': head,
                   'testedTree': tree, 'runId': 321, 'runAttempt': 1}
        names = ['quality', 'change-scope', 'recharge (guards)', 'recharge (admin)']
        def github(path):
            return {'workflow_runs': [run]} if '/runs?' in path else {'jobs': [{'name': n, 'conclusion': 'success'} for n in names]}
        with patch.object(p, 'github', side_effect=github), patch.object(p.F, 'require_run'), \
             patch.object(p.F, 'artifact_json', return_value=(receipt, 'e' * 64)):
            self.assertEqual(p.verified_run(head, 'pull_request', tree, 123)['pullRequest'], 123)
            receipt['testedTree'] = '0' * 40
            with self.assertRaises(RuntimeError): p.verified_run(head, 'pull_request', tree, 123)
            receipt['testedTree'] = tree; names.remove('recharge (admin)')
            with self.assertRaises(RuntimeError): p.verified_run(head, 'pull_request', tree, 123)

    def test_deployment_reuses_admin_only_switch_and_stops_for_manual_forward_diagnosis(self):
        source = (HERE / 'mailbox-provider-release.py').read_text()
        self.assertIn("('admin','COPY html/ /usr/share/nginx/html/')", source)
        self.assertIn("'--no-deps','--no-build','--pull','never','admin'", source)
        self.assertIn('fresh_scoped_backup', source)
        self.assertNotIn('stop_recharge_and_recover', source)
        self.assertNotIn('rollback_service(', source)
        self.assertIn("'rollbackPerformed':False", source)


if __name__ == '__main__': unittest.main()
