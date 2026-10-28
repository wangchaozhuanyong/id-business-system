"""Finite Admin repair checks; never start a server or access production."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('settings_controls', HERE / 'mailbox-settings-runtime.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class SettingsControls(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / r.CONTRACT_FILE).read_bytes())

    def test_only_one_admin_source_and_no_migration(self):
        r.validate_contract(self.c)
        for key, value in [('updatedServices', ['api', 'admin']), ('migrationPerformed', True),
                           ('sources', {'apps/api/src/auth.ts': 'a' * 64})]:
            bad = copy.deepcopy(self.c)
            bad[key] = value
            with self.assertRaisesRegex(RuntimeError, 'SCOPE_CHANGED'):
                r.validate_contract(bad)

    def test_native_payload_rejects_api_or_unreviewed_content(self):
        plan = dict(commit='b' * 40, tree='c' * 40, workflowRunId='1', workflowRunAttempt='1',
                    contractSha256='d' * 64, controlSources={}, qualitySourceEvidence={}, nativeParentCapture={})
        files = {'source/' + r.SOURCE: self.c['sources'][r.SOURCE], 'admin/html/index.html': 'e' * 64}
        proof = {**plan, 'scope': r.SCOPE, 'sources': self.c['sources'], 'baselineAdminReproduced': True,
                 'baselineAdminFiles': self.c['baselineAdminFiles'], 'migrationPerformed': False,
                 'businessActions': 0, 'adminFiles': {'index.html': 'e' * 64}, 'files': files}
        r.verify_proof(proof, plan, self.c, files)
        for path in ['api/module.js', 'source/apps/api/src/auth.ts']:
            bad = copy.deepcopy(proof)
            bad['files'][path] = 'f' * 64
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                r.verify_proof(bad, plan, self.c, bad['files'])
        bad = {**proof, 'commit': '0' * 40}
        with self.assertRaisesRegex(RuntimeError, 'BUILD_PROVENANCE_CHANGED'):
            r.verify_proof(bad, plan, self.c, files)

    def test_unchanged_api_database_and_workers_are_required(self):
        states = {n: {'containerId': n, 'image': 'same', 'environmentSha256': 'e'}
                  for n in ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')}
        parent = {'services': states, 'adminConfigurationSha256': 'same'}
        h = Mock()
        changed = copy.deepcopy(states)
        changed['api']['containerId'] = 'replaced-api'
        h.snapshot.return_value = changed
        with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
            r.verify_deployed(Mock(), Mock(), parent, {}, 'same', self.c, h)
        h.snapshot.return_value = states
        h.configuration.return_value = 'different'
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_CONFIGURATION_CHANGED'):
            r.verify_deployed(Mock(), Mock(), parent, {}, 'same', self.c, h)

    def test_control_check_binds_the_exact_one_line_repair(self):
        p = r.load('mailbox-settings-publication.py')
        p.check(self.c)
        self.assertEqual(p.F.WORKFLOW, '.github/workflows/mailbox-settings-publication.yml')
        workflow = (HERE.parents[1] / p.F.WORKFLOW).read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertEqual(workflow.count("inputs.commit == github.sha"), 2)

    def test_admin_reuse_requires_original_job_checkout_and_unchanged_inputs(self):
        p = r.load('mailbox-settings-publication.py')
        b = self.c['adminEvidence']
        steps = [{'name': n, 'conclusion': 'success'} for n in ('Checkout', 'Install package dependencies', 'Check affected recharge part')]
        run = dict(id=b['runId'], run_attempt=1, status='completed', conclusion='failure', event='pull_request',
                   path='.github/workflows/quality.yml', head_sha=b['head'], repository={'full_name': p.REPO}, pull_requests=[])
        job = dict(id=b['jobId'], run_id=b['runId'], name='recharge (admin)', status='completed', conclusion='success', steps=steps)
        checkout = {'sha': b['checkout'], 'tree': {'sha': b['tree']}, 'parents': [{'sha': b['base']}, {'sha': b['head']}]}
        log = '[command]/usr/bin/git log -1 --format=%H\ncheckout ' + b['checkout'] + '\n'
        self.assertTrue(p.admin_evidence_matches(self.c, run, job, checkout, log, True))
        self.assertFalse(p.admin_evidence_matches(self.c, run, job, checkout, log, False))
        self.assertFalse(p.admin_evidence_matches(self.c, run, {**job, 'conclusion': 'failure'}, checkout, log, True))
        self.assertFalse(p.admin_evidence_matches(self.c, run, job, {**checkout, 'sha': '0' * 40}, log, True))
        source = self.c['sourceReview']
        pr = {'number': 753, 'merged_at': '2026-10-28', 'merge_commit_sha': source['main'],
              'head': {'sha': source['head']}, 'base': {'ref': 'main'}}
        self.assertTrue(p.merged_source_matches(self.c, pr))
        self.assertFalse(p.merged_source_matches(self.c, {**pr, 'merged_at': None}))
        self.assertFalse(p.merged_source_matches(self.c, {**pr, 'merge_commit_sha': '0' * 40}))


if __name__ == '__main__':
    unittest.main()
