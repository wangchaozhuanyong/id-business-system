"""Offline scope, provenance, preservation and forward-only switch regressions."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dependency_runtime_tested', HERE / 'dependency-security-runtime.py')
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class DependencyPublication(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / R.CONTRACT_FILE).read_bytes())
        self.plan = {'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                     'contractSha256': 'c' * 64, 'controlSources': {}, 'qualitySourceEvidence': {'source': 'fixture'}}
        self.plan['qualitySourceEvidence'] = {'commit': self.plan['commit'], 'tree': self.plan['tree'],
            'source': {**self.c['sourceReview'], 'sourceReceiptSha256': 'e' * 64},
            'control': {'main': self.plan['commit'], 'tree': self.plan['tree'], 'pullRequest': 800,
                        'head': 'd' * 40, 'runId': '456', 'sourceReceiptSha256': 'f' * 64},
            'main': {'head': self.plan['commit'], 'runId': '789'}}
        roots = R.package_roots(self.c)
        files = {**{'source/' + n: v for n, v in self.c['sources'].items()},
                 'probes/dependency-security-regressions.test.mjs': self.c['probeSha256'],
                 **{'packages/' + n + '/package.json': 'd' * 64 for n in roots if self.c['afterVersions'][n] is not None}}
        self.proof = {**self.plan, 'scope': self.c['scope'], 'baselineSha256': self.c['baselineSha256'],
                      'sources': self.c['sources'], 'packageRoots': roots, 'packageVersions': self.c['afterVersions'],
                      'files': files, 'migrationPerformed': False, 'businessActions': 0}

    def test_frozen_contract_and_minimal_payload_are_admitted(self):
        R.verify_proof(self.proof, self.plan, self.c, self.proof['files'])

    def test_captured_baseline_cannot_be_substituted(self):
        c = copy.deepcopy(self.c)
        c['baseline']['manifestSha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'PUBLICATION_SCOPE_CHANGED'):
            R.validate_contract(c)
        c['baselineSha256'] = R.sha(R.canonical(c['baseline']))
        with self.assertRaisesRegex(RuntimeError, 'FROZEN_BASELINE_CHANGED'):
            R.validate_contract(c)

    def test_payload_rejects_application_database_and_secret_files(self):
        for name in ('packages/apps/api/dist/main.js', 'source/.env', 'source/apps/api/prisma-mysql/schema.prisma',
                     'packages/node_modules/unreviewed/index.js', 'probes/extra.js'):
            proof = copy.deepcopy(self.proof)
            proof['files'][name] = 'e' * 64
            with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_SCOPE_CHANGED'):
                R.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_proof_binds_exact_main_build_and_source_evidence(self):
        for name in self.plan:
            proof = copy.deepcopy(self.proof)
            proof[name] = None
            with self.assertRaisesRegex(RuntimeError, 'BUILD_PROOF_CHANGED'):
                R.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_removed_or_changed_source_and_probe_are_rejected(self):
        for name in ('source/package-lock.json', 'probes/dependency-security-regressions.test.mjs'):
            proof = copy.deepcopy(self.proof)
            proof['files'][name] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_OR_PROBE_CHANGED'):
                R.verify_proof(proof, self.plan, self.c, proof['files'])

    def test_quality_receipt_must_bind_source_and_current_main(self):
        for group, key, value in [('source', 'head', '0' * 40), ('control', 'main', '0' * 40),
                                   ('main', 'head', '0' * 40), ('source', 'sourceReceiptSha256', '')]:
            q = copy.deepcopy(self.plan['qualitySourceEvidence'])
            q[group][key] = value
            with self.assertRaisesRegex(RuntimeError, 'QUALITY_'):
                R.verify_quality(q, self.plan, self.c)

    def test_image_keeps_all_parent_layers_configuration_and_only_two_added_layers(self):
        original = {'RootFS': {'Layers': ['parent']}, 'Config': {'User': '', 'Labels': {'previous': 'fixed'}}}
        built = {'RootFS': {'Layers': ['parent', 'remove', 'copy']},
                 'Config': {'User': '', 'Labels': {'previous': 'fixed', 'org.opencontainers.image.revision': self.plan['commit'],
                     'id-business-v2.recharge-record-build-proof-sha256': 'f' * 64}}}
        plan = {**self.plan, 'buildProofSha256': 'f' * 64}
        R.verify_image(original, built, plan)
        for layers in (['different', 'remove', 'copy'], ['parent', 'copy'], ['parent', 'remove', 'copy', 'extra']):
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_LAYERS_CHANGED'):
                R.verify_image(original, {**built, 'RootFS': {'Layers': layers}}, plan)
        changed = copy.deepcopy(built)
        changed['Config']['User'] = 'different'
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONFIGURATION_CHANGED'):
            R.verify_image(original, changed, plan)

    def test_all_unselected_dependencies_and_runtime_identity_are_preserved(self):
        state = copy.deepcopy(self.c['baseline']['dependencies'])
        state['metadata'] = self.c['runtimeMetadataSha256']
        for name, version in self.c['afterVersions'].items():
            prefix = 'packages/' + name + '/'
            files = {n[len(prefix):]: v for n, v in self.proof['files'].items() if n.startswith(prefix)}
            state['inventory'][name] = None if version is None else {'version': version, 'count': len(files), 'sha256': R.sha(R.canonical(files))}
        R.verify_dependencies(state, self.proof, self.c)
        for name in ('node', 'platform', 'arch', 'preservedNodeModules', 'metadata'):
            changed = copy.deepcopy(state)
            changed[name] = None
            with self.assertRaisesRegex(RuntimeError, 'PRESERVED_DEPENDENCIES_CHANGED'):
                R.verify_dependencies(changed, self.proof, self.c)
        changed = copy.deepcopy(state)
        first = next(n for n, v in self.c['afterVersions'].items() if v is not None)
        changed['inventory'][first]['version'] = '0.0.0'
        with self.assertRaisesRegex(RuntimeError, 'PACKAGE_CONTENT_CHANGED'):
            R.verify_dependencies(changed, self.proof, self.c)

    def test_archive_roots_do_not_delete_overlapping_parent_twice(self):
        roots = R.package_roots(self.c)
        self.assertEqual(len(roots), 9)
        self.assertIsNone(self.c['afterVersions']['node_modules/follow-redirects'])
        self.assertNotIn('node_modules/follow-redirects', roots)
        self.assertIsNone(self.c['runtimeMetadataSha256']['package.json'])
        self.assertIsNone(self.c['runtimeMetadataSha256']['package-lock.json'])
        self.assertFalse(any(a.startswith(b + '/') for a in roots for b in roots if a != b))

    def test_no_migration_and_no_automatic_rollback_paths(self):
        source = (HERE / 'dependency-security-runtime.py').read_text()
        tree = ast.parse(source)
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
        calls = [n.func.attr for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        self.assertTrue({'fresh_scoped_backup', 'activate_services', 'release_markers', 'point_current'} <= set(calls))
        self.assertFalse({'rollback', 'rollback_release', 'migrate', 'restore_database', 'rmtree'} & set(calls))
        self.assertIn('NEEDS_FORWARD_DIAGNOSIS', source)
        self.assertIn("'--network', 'none', '--read-only'", source)

    def test_main_is_rechecked_after_candidate_build_and_backup_before_switch(self):
        source = (HERE / 'dependency-security-runtime.py').read_text()
        self.assertLess(source.index('h.build_image('), source.rindex("latest_main(plan['commit'])"))
        self.assertLess(source.index('h.fresh_scoped_backup('), source.rindex("latest_main(plan['commit'])"))
        self.assertLess(source.rindex("latest_main(plan['commit'])"), source.index('retired.claim_retired_markers('))
        self.assertLess(source.index('fence.acquire()'), source.index('history.activate_services('))


if __name__ == '__main__':
    unittest.main()
