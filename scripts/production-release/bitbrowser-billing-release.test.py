"""Negative controls for the finite BitBrowser API/Admin publication."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('billing_release_test', HERE / 'bitbrowser-billing-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class FiniteBillingControls(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / 'bitbrowser-billing-contract.json').read_bytes())

    def test_frozen_contract_and_preserved_roles(self):
        p.validate_contract(self.c)
        self.assertEqual(p.PRESERVED, ('mysql', 'caddy', 'media-resolver', 'auto-recharge'))
        self.assertNotIn('auto-registration', p.SERVICES)
        self.assertNotIn('online-recharge', p.PRESERVED)

    def test_squash_merge_requires_identical_reviewed_source_bytes(self):
        spec = importlib.util.spec_from_file_location('billing_build_test', HERE / 'bitbrowser-billing-build.py')
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        content = b'reviewed source'
        contract = {'sourceReviewCommit': 'a' * 40, 'sources': {'apps/admin/src/v2/example.ts': p.sha(content)}}
        with patch.object(build, 'git', return_value=content):
            build.reviewed_projection('a' * 40, contract)
            with self.assertRaisesRegex(RuntimeError, 'REVIEW_COMMIT_CHANGED'):
                build.reviewed_projection('b' * 40, contract)
        for rows in ((content, b'changed candidate'), (b'changed review', content)):
            with patch.object(build, 'git', side_effect=rows):
                with self.assertRaisesRegex(RuntimeError, 'REVIEW_SOURCE_PROJECTION_CHANGED'):
                    build.reviewed_projection('a' * 40, contract)

    def test_wrong_predecessor_rejected(self):
        self.c['expectedCurrent'] = 'a' * 40
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY'):
            p.validate_contract(self.c)

    def test_review_origin_and_ci_control_scope_cannot_follow_runtime_drift(self):
        self.assertNotEqual(p.CURRENT, p.SOURCE_BASE)
        self.c['reviewBase'] = p.CURRENT
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY'):
            p.validate_contract(self.c)
        self.c['reviewBase'] = p.SOURCE_BASE
        self.c['ciControlPins']['scripts/unknown.mjs'] = 'a' * 64
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE'):
            p.validate_contract(self.c)

    def test_unknown_source_and_payment_engine_rejected(self):
        for name in ('apps/api/src/id-business-v2/online-recharge/tasks.service.ts', '../escape',
                     'apps/api/prisma-mysql/schema.prisma'):
            value = copy.deepcopy(self.c)
            value['sources'][name] = 'a' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE'):
                p.validate_contract(value)

    def test_extra_shared_output_rejected(self):
        self.c['sharedFiles'].append('v2/accounts.js')
        with self.assertRaisesRegex(RuntimeError, 'OUTPUT_SCOPE'):
            p.validate_contract(self.c)

    def test_missing_api_output_rejected(self):
        self.c['apiModules'].pop()
        with self.assertRaisesRegex(RuntimeError, 'OUTPUT_SCOPE'):
            p.validate_contract(self.c)

    def test_missing_control_rejected(self):
        self.c['controlPins'].pop('remote-deploy.py')
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE'):
            p.validate_contract(self.c)

    def test_unhealthy_or_missing_service_rejected(self):
        for change in ('health', 'missing', 'retired'):
            value = copy.deepcopy(self.c)
            if change == 'health':
                value['baseline']['services']['api']['health'] = 'starting'
            elif change == 'missing':
                value['baseline']['services'].pop('mysql')
            else:
                value['baseline']['services']['auto-registration'] = {}
            with self.assertRaisesRegex(RuntimeError, 'BASELINE'):
                p.validate_contract(value)

    def test_write_or_migration_flag_rejected(self):
        for name, value in (('migrationPerformed', True), ('businessActions', 1)):
            c = copy.deepcopy(self.c)
            c[name] = value
            with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY'):
                p.validate_contract(c)

    def test_mysql_evidence_rejects_skips_wrong_source_or_identity(self):
        identity = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1'}
        value = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'testFiles': {n: self.c['sources'][n] for n in p.MYSQL_FILES}, 'testsTotal': 13,
            'testsPassed': 13, 'testsSkipped': 0, 'testsTodo': 0, 'productionActions': 0,
            'reportSha256': 'd' * 64}
        p.verify_mysql(value, identity, self.c)
        for name, replacement in (('testsSkipped', 1), ('testsPassed', 12), ('productionActions', 1),
            ('commit', 'e' * 40), ('testFiles', {})):
            with self.assertRaisesRegex(RuntimeError, 'MYSQL_EVIDENCE'):
                p.verify_mysql({**value, name: replacement}, identity, self.c)

    def test_payload_rejects_extra_unreviewed_file(self):
        identity = {'commit': 'b' * 40, 'tree': 'c' * 40, 'workflowRunId': '12', 'workflowRunAttempt': '1'}
        mysql = {**identity, 'scope': 'OWNED_EMPTY_DATABASE', 'runtime': 'github-actions-mysql-service',
            'testFiles': {n: self.c['sources'][n] for n in p.MYSQL_FILES}, 'testsTotal': 13,
            'testsPassed': 13, 'testsSkipped': 0, 'testsTodo': 0, 'productionActions': 0,
            'reportSha256': 'd' * 64}
        proof = {**identity, 'scope': p.SCOPE, 'contractSha256': 'e' * 64, 'sources': self.c['sources'],
            'controlSources': self.c['controlPins'], 'migrationPerformed': False, 'businessActions': 0,
            'baselineRuntimeReproduced': True, 'baselineAdminReproduced': True,
            'predecessorProofSha256': self.c['predecessorProofSha256'], 'qualityVerification': {},
            'isolatedMysqlVerification': mysql, 'apiModules': {n: 'a' * 64 for n in self.c['apiModules']},
            'sharedFiles': {n: 'b' * 64 for n in p.SHARED}, 'adminFiles': {'index.html': 'c' * 64}, 'files': {}}
        class Helper:
            @staticmethod
            def file_inventory(_path):
                return {'api/modules/other.js': 'a' * 64}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_CHANGED'):
                p.verify_proof(proof, proof, self.c, Path(directory), Helper)

    def test_no_payment_migration_or_cleanup_commands(self):
        text = (HERE / 'bitbrowser-billing-release.py').read_text()
        self.assertNotIn('migrate deploy', text)
        self.assertNotIn('docker prune', text)
        self.assertIn('check_hashes', text)
        self.assertIn('retired.retired_guards', text)
        self.assertIn('helper.guards', text)
        self.assertIn('runtime_receipt', text)


if __name__ == '__main__':
    unittest.main()
