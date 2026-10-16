"""Reject unreviewed payloads, failed predecessors and unrelated runtime changes."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mailbox_version_controls', HERE / 'mailbox-version-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads((HERE / 'mailbox-version-contract.json').read_bytes())

    def test_only_one_api_module_and_finalized_predecessor_are_admitted(self):
        r.verify_contract(self.contract)
        for field, value in [('expectedCurrent', 'a' * 40), ('migration', {'name': 'unreviewed'}), ('updatedServices', ['api', 'admin'])]:
            changed = {**self.contract, field: value}
            with self.assertRaises(RuntimeError):
                r.verify_contract(changed)
        changed = copy.deepcopy(self.contract)
        changed['predecessorNative']['readback']['Status'] = 'Failed'
        with self.assertRaises(RuntimeError):
            r.verify_contract(changed)

    def test_payload_cannot_replace_client_admin_auth_or_another_module(self):
        c = self.contract
        plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '1', 'workflowRunAttempt': '1',
                'contractSha256': 'c' * 64, 'controlSources': {}}
        modules = {n: 'd' * 64 for n in r.MODULES}
        files = {'source/' + r.SOURCE: c['sources'][r.SOURCE], **{'api/modules/' + n: v for n, v in modules.items()}}
        proof = {**plan, 'scope': r.SCOPE, 'sources': c['sources'], 'baselineModulesReproduced': c['baseline']['runtime']['modules'],
                 'modules': modules, 'files': files, 'databaseVerification': {'isolated': True, 'passed': 4},
                 'migrationPerformed': False, 'businessActions': 0}
        r.verify_proof(proof, plan, c, files)
        for name in ('api/modules/auth/auth.service.js', 'admin/html/index.html', 'api/prisma-client/index.js'):
            altered = {**files, name: 'e' * 64}
            with self.assertRaises(RuntimeError):
                r.verify_proof({**proof, 'files': altered}, plan, c, altered)
        with self.assertRaises(RuntimeError):
            r.verify_proof({**proof, 'databaseVerification': {'isolated': False, 'passed': 4}}, plan, c, files)

    def test_smoke_rejects_changes_to_any_preserved_service_before_content_checks(self):
        states = copy.deepcopy(self.contract['baseline']['services'])
        states['admin']['containerId'] = 'unexpected-admin'
        with patch.object(r, 'check_runtime') as check:
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_SERVICE_CHANGED'):
                r.smoke(None, None, Path('/owned'), states, self.contract, {})
            check.assert_not_called()

    def test_runtime_check_cannot_hide_generated_client_or_database_changes(self):
        c = self.contract
        runtime = copy.deepcopy(c['baseline']['runtime'])
        runtime.pop('inputs', None)
        runtime['client']['sha256'] = 'e' * 64
        with patch.object(r, 'contents', return_value=(runtime, c['baseline']['admin'])):
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CONTENT_CHANGED'):
                r.check_runtime(None, None, {}, c, c['baseline']['runtime']['modules'])


if __name__ == '__main__':
    unittest.main()
