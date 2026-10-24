"""Offline transport, count-only disclosure and current-source boundary tests."""
import ast
import copy
import importlib.util
import inspect
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('financial_readonly_tested', HERE / 'financial-closure-readonly.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class FinancialReadonlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = M.bundle()

    def report(self):
        return {'status': 'FINANCIAL_READONLY_OBSERVED', 'productionWrites': 0,
            'identity': {'current': '/opt/id-business-v2/releases/20261021T000000Z-abc-financial',
                'commit': 'a' * 40, 'manifestSha256': 'b' * 64, 'freeBytes': 8 * 1024**3,
                'apiBillingSha256': 'c' * 64, 'adminIndexSha256': 'd' * 64,
                'services': {n: {'containerId': 'a' * 64, 'image': 'sha256:' + 'b' * 64,
                    'status': 'running', 'health': 'healthy', 'configurationSha256': 'c' * 64}
                    for n in ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')}},
            'audit': {'status': 'AUDITED', 'verifiedReadOnlyAccount': True, 'databaseWrites': 0,
                'checks': [{**{k: d[k] for k in ('code', 'severity', 'scope')}, 'count': 0}
                    for d in self.data['rules']]}}

    def test_frozen_general_and_separate_online_rules(self):
        self.assertEqual(len(self.data['rules']), 60)
        self.assertEqual(sum(r['scope'] == 'general' for r in self.data['rules']), 49)
        self.assertEqual(sum(r['scope'] == 'online-recharge' for r in self.data['rules']), 11)
        for row in self.data['rules']:
            self.assertTrue(row['sql'].startswith('SELECT CAST(COUNT(*) AS CHAR) AS count FROM ('))
        for value in ('SHOW GRANTS', 'SET SESSION TRANSACTION READ ONLY', 'REPEATABLE-READ',
                      'foreign_key_checks', 'Number.isSafeInteger', 'private_input',
                      "url.searchParams.set('connection_limit','1')"):
            self.assertIn(value, self.data['runner'] + inspect.getsource(M.observe_server))

    def test_transport_is_bounded_and_contains_only_reviewed_program(self):
        p = M.parameters(self.data)
        self.assertEqual(set(p), {'commands', 'executionTimeout'})
        self.assertEqual(len(p['commands']), 1)
        self.assertEqual(p['executionTimeout'], ['300'])
        self.assertLess(len(json.dumps(p).encode()), 24000)
        self.assertTrue(p['commands'][0].startswith('python3 -c '))

    def test_server_has_no_filesystem_or_service_mutation(self):
        source = inspect.getsource(M.observe_server)
        tree = ast.parse(source)
        attrs = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        self.assertFalse(attrs & {'write_text', 'write_bytes', 'unlink', 'mkdir', 'rmdir', 'rename', 'chmod'})
        for value in ("'build'", "'restart'", "'up'", "'stop'", "'authorize-security-group-ingress'"):
            self.assertNotIn(value, source)
        self.assertIn('private_input=json.dumps', source)
        self.assertIn("values['V2_DATA_INTEGRITY_DATABASE_URL']", source)

    def test_non_main_or_local_run_stops_before_aws(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(M, 'execute') as execute:
            with self.assertRaisesRegex(RuntimeError, 'MAIN_ONLY'):
                M.main()
            execute.assert_not_called()

    def test_accepts_only_complete_structured_counts(self):
        report = self.report()
        self.assertTrue(M.validate_report(report, self.data['rules']))
        report['audit']['checks'][0]['count'] = 3
        self.assertTrue(M.validate_report(report, self.data['rules']))
        # Findings are evidence, not zeroed or silently treated as unavailable.
        self.assertEqual(report['audit']['checks'][0]['count'], 3)

    def test_missing_audit_is_distinct_from_complete_counts(self):
        report = self.report()
        report['audit'] = {'status': 'AUDIT_UNAVAILABLE', 'databaseWrites': 0,
                           'stage': 'CONFIGURATION', 'rule': None}
        self.assertFalse(M.validate_report(report, self.data['rules']))
        report['audit'].update(stage='RULE', rule=self.data['rules'][0]['code'])
        self.assertFalse(M.validate_report(report, self.data['rules']))
        report['audit']['rule'] = 'untrusted-private-output'
        with self.assertRaisesRegex(RuntimeError, 'AUDIT_INVALID'):
            M.validate_report(report, self.data['rules'])

    def test_rejects_excess_fields_identity_drift_and_invalid_counts(self):
        mutations = [
            lambda r: r.update(secret='fixture'),
            lambda r: r.update(productionWrites=1),
            lambda r: r['identity'].update(current='/other-project/current'),
            lambda r: r['identity'].update(commit='wrong'),
            lambda r: r['identity']['services'].pop('api'),
            lambda r: r['identity']['services']['api'].update(environment='fixture'),
            lambda r: r['audit'].update(verifiedReadOnlyAccount=False),
            lambda r: r['audit'].update(databaseWrites=1),
            lambda r: r['audit']['checks'].pop(),
            lambda r: r['audit']['checks'][0].update(code='other-rule'),
            lambda r: r['audit']['checks'][0].update(count='0'),
            lambda r: r['audit']['checks'][0].update(count=-1),
            lambda r: r['audit']['checks'][0].update(count=2**53),
            lambda r: r['audit']['checks'][0].update(count=True)
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                report = copy.deepcopy(self.report())
                mutate(report)
                with self.assertRaises((RuntimeError, KeyError, TypeError)):
                    M.validate_report(report, self.data['rules'])

    def test_oidc_workflow_is_manual_main_only_and_never_publishes(self):
        source = (M.ROOT / '.github/workflows/financial-closure-validation.yml').read_text()
        block = source.split('  production-readonly:\n', 1)[1]
        self.assertIn("github.ref == 'refs/heads/main'", block)
        self.assertIn("inputs.mode == 'production-readonly'", block)
        self.assertIn('contents: read', block)
        self.assertNotIn('contents: write', block)
        self.assertIn('arn:aws:iam::098208446664:role/id-business-v2-github-release', block)
        self.assertNotIn('release.py', block)


if __name__ == '__main__':
    unittest.main()
