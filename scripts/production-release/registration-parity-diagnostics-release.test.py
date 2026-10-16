"""Pure successor controls. No network, containers, database or production writes."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = ROOT / '.runtime/registration-parity-20261016/control-tests'


def load(name):
    spec = importlib.util.spec_from_file_location('parity_control_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


b = load('registration-parity-diagnostics-build.py')
r = load('registration-parity-diagnostics-release.py')
dispatch = load('registration-parity-diagnostics-dispatch.py')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class ParityDiagnosticsControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.contract = json.loads((HERE / 'registration-parity-diagnostics-contract.json').read_bytes())

    def test_historical_executors_and_contract_remain_byte_exact(self):
        self.assertEqual(b.PARENT_CONTROLS, r.PARENT_CONTROLS)
        for name, expected in b.PARENT_CONTROLS.items():
            self.assertEqual(digest((HERE / name).read_bytes()), expected, name)
        self.assertEqual(b.PARENT_CONTROLS['registration-flow-evidence-contract.json'],
                         '9d5f34916800fb885cb8aabd98bb550900775f47f17d666c8ad40a26f65215ae')

    def test_direct_python_cli_reaches_each_mode_without_external_calls(self):
        # Execute the actual __main__ branch in a fresh interpreter. A profile
        # hook stops at the real mode function before its first statement;
        # platform/process calls are mocked to fail if any escape that hook.
        harness = r'''import json,runpy,socket,subprocess,sys,urllib.request
from pathlib import Path
from unittest.mock import patch
script=Path(sys.argv[1]).resolve();mode=sys.argv[2];arguments=json.loads(sys.argv[3]);calls=[]
class Captured(Exception):pass
def observe(frame,event,arg):
 if event=='call' and Path(frame.f_code.co_filename).resolve()==script and frame.f_code.co_name==mode:
  calls.append(frame.f_code.co_name);raise Captured()
def forbidden(*args,**kwargs):raise AssertionError('UNEXPECTED_EXTERNAL_CALL')
sys.argv=[str(script),*arguments]
with patch.object(subprocess,'run',forbidden),patch.object(subprocess,'check_output',forbidden),patch.object(urllib.request,'urlopen',forbidden),patch.object(socket.socket,'connect',forbidden):
 sys.setprofile(observe)
 try:runpy.run_path(str(script),run_name='__main__')
 except Captured:pass
 finally:sys.setprofile(None)
print(json.dumps(calls))
'''
        for suffix, mode, arguments in [
                *[('build.py', mode, [mode]) for mode in ('prepare', 'build', 'validate', 'package')],
                ('dispatch.py', 'publish', [])]:
            script = HERE / ('registration-parity-diagnostics-' + suffix)
            with self.subTest(mode=mode):
                completed = subprocess.run([sys.executable, '-B', '-c', harness, str(script), mode,
                                            json.dumps(arguments)], cwd=ROOT, capture_output=True, text=True,
                                           timeout=15, check=True)
                self.assertEqual(json.loads(completed.stdout), [mode])
                self.assertEqual(completed.stderr, '')

    def test_unfrozen_build_modes_stop_before_outputs_or_subprocesses(self):
        contract = {**self.contract, 'frozen': False}
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            source = Path(temporary) / 'contract.json'
            source.write_text(json.dumps(contract))
            output = Path(temporary) / 'uncreated'
            with patch.object(b, 'CONTRACT', source), patch.object(b, 'OUTPUT', output), \
                    patch.object(b, 'run') as execute, patch.object(b, 'native_proof') as native:
                for mode in ('prepare', 'build', 'validate', 'package'):
                    with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                        getattr(b, mode)()
                execute.assert_not_called()
                native.assert_not_called()
                self.assertFalse(output.exists())

    def test_unfrozen_preflight_release_readback_stop_before_helpers_or_driver(self):
        for mode in ('preflight', 'release', 'readback'):
            driver = Mock()
            with self.subTest(mode=mode), patch.object(r, 'helper') as helper, \
                    self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                r.release({'mode': mode}, {**self.contract, 'frozen': False}, driver, Mock())
            helper.assert_not_called()
            self.assertFalse(driver.mock_calls)

    def test_unfrozen_dispatch_stops_before_platform_calls(self):
        raw = json.dumps({**self.contract, 'frozen': False}).encode()
        original = Path.read_bytes

        def read(path):
            return raw if path.name == 'registration-parity-diagnostics-contract.json' else original(path)

        with patch.object(Path, 'read_bytes', read), patch.object(dispatch, 'execute') as execute:
            for action in (dispatch.prepare_plan, lambda: dispatch.transport({}, 'preflight')):
                with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_FROZEN'):
                    action()
            execute.assert_not_called()

    def test_parent_tampering_and_missing_runtime_are_rejected(self):
        for patch_value, expected in [
                ({'parentControls': {}}, 'PARENT_CONTROL_CHANGED'),
                ({'parentContractSha256': '0' * 64}, 'PARENT_EVIDENCE_CHANGED'),
                ({'parentProofSha256': '0' * 64}, 'PARENT_EVIDENCE_CHANGED'),
                ({'runtimeEvidence': None}, 'RUNTIME_BASELINE_MISSING')]:
            with self.subTest(patch=patch_value), self.assertRaisesRegex(RuntimeError, expected):
                r.verify_contract({**self.contract, 'frozen': True,
                                   'successorProofSha256': r.SUCCESSOR_PROOF, **patch_value})
        with patch.object(r, 'digest', return_value='0' * 64), \
                self.assertRaisesRegex(RuntimeError, 'PARENT_CONTROL_CHANGED'):
            r.verify_contract({**self.contract, 'frozen': True})

    def test_published_successor_recipe_and_native_proof_are_separately_pinned(self):
        self.assertEqual(b.SUCCESSOR_CONTROLS, r.SUCCESSOR_CONTROLS)
        for name, expected in b.SUCCESSOR_CONTROLS.items():
            self.assertEqual(digest((HERE / name).read_bytes()), expected, name)
        for patch_value in [{'successorControls': {}}, {'successorProofSha256': '0' * 64},
                            {'successorContractSha256': '0' * 64}]:
            with self.subTest(patch=patch_value), \
                    self.assertRaisesRegex(RuntimeError, 'PUBLISHED_SUCCESSOR_EVIDENCE_CHANGED'):
                r.verify_contract({**self.contract, 'frozen': True, **patch_value})

    def test_admin_successor_is_only_three_sources_over_the_exact_sales_compilation(self):
        self.assertEqual(b.DRAG_CONTROLS, r.DRAG_CONTROLS)
        for name, expected in b.DRAG_CONTROLS.items():
            self.assertEqual(digest((HERE / name).read_bytes()), expected, name)
        recipe = json.loads((HERE / 'workspace-drag-contract.json').read_bytes())
        sales = {'adminFiles': {'index.html': 'a' * 64}}
        proof = {'version': 1, 'scope': recipe['scope'], 'commit': b.CURRENT, 'tree': b.SOURCE_TREE,
                 'contractSha256': b.DRAG_CONTROLS['workspace-drag-contract.json'],
                 'controllerSha256': b.DRAG_CONTROLS['workspace-drag-release.py'],
                 'publishedProofSha256': b.SUCCESSOR_PROOF, 'sources': recipe['sources'],
                 'baselineAdminFiles': sales['adminFiles'], 'adminFiles': {'index.html': 'b' * 64},
                 'updatedServices': ['admin'], 'migrationPerformed': False, 'businessActions': 0,
                 'browserChecks': 13}
        proof['files'] = {**{'source/' + n: v for n, v in recipe['sources'].items()},
                          'admin/html/index.html': 'b' * 64}
        self.assertEqual(b.verify_drag_proof(proof, sales, self.contract), proof)
        for changed in [{'sources': {**proof['sources'], 'unreviewed.ts': 'c' * 64}},
                        {'baselineAdminFiles': {}}, {'publishedProofSha256': '0' * 64},
                        {'updatedServices': ['api', 'admin']}, {'migrationPerformed': True},
                        {'businessActions': False}, {'controllerSha256': '0' * 64}]:
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ADMIN_SUCCESSOR_NATIVE_CHANGED'):
                b.verify_drag_proof({**proof, **changed}, sales, self.contract)
        with self.assertRaisesRegex(RuntimeError, 'PUBLISHED_ADMIN_SUCCESSOR_PAYLOAD_CHANGED'):
            b.verify_drag_proof({**proof, 'files': {}}, sales, self.contract)

    def test_client_generation_uses_the_reconstructed_root_cwd_and_no_workspace(self):
        context = ROOT / '.deploy/registration-parity-diagnostics/isolated-fixture'
        with patch.dict(os.environ, {'PATH': '/synthetic/bin', 'PRISMA_UNRELATED': 'kept'}, clear=True), \
                patch.object(b, 'run') as execute:
            b.generate_unchanged_client(context)
        execute.assert_called_once_with(
            'node', 'node_modules/prisma/build/index.js', 'generate', '--schema', b.SCHEMA,
            cwd=context, env={'PATH': '/synthetic/bin', 'PRISMA_UNRELATED': 'kept',
                             'DATABASE_URL': 'mysql://prisma:prisma@127.0.0.1:3306/id_business_v2'})
        self.assertNotIn('--workspace', execute.call_args.args)

    def test_client_comparison_normalizes_only_two_known_metadata_fields_to_runtime_app(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            context = Path(temporary)
            directory = context / 'node_modules/.prisma/client'
            directory.mkdir(parents=True)
            originals = {}
            expected = {}
            for name in ['index.js', 'edge.js', 'wasm.js']:
                raw = ('"output": {\n      "value": ' + json.dumps(str(context / 'node_modules/@prisma/client'), ensure_ascii=False)
                       + ',\n      "fromEnvVar": null\n    },\n  "sourceFilePath": '
                       + json.dumps(str(context / 'apps/api/prisma-mysql/schema.prisma'), ensure_ascii=False) + ',\n')
                if name == 'index.js':
                    raw += 'const alternativePaths = ["node_modules/.prisma/client", ".prisma/client"];\n'
                originals[name] = raw
                (directory / name).write_text(raw)
                expected[name] = digest(raw.replace(str(context) + '/', '/app/').encode())
            (directory / 'schema.prisma').write_text('synthetic fixed schema\n')
            expected['schema.prisma'] = digest(b'synthetic fixed schema\n')
            contract = {'prismaPathMetadata': {'files': ['index.js', 'edge.js', 'wasm.js'],
                        'publishedContext': '/app'}, 'baselinePrismaClientFiles': expected}
            self.assertEqual(b.unchanged_client(context, contract), expected)
            (directory / 'index.js').write_text(originals['index.js'].replace('"sourceFilePath": ', '"foreign": '))
            with self.assertRaisesRegex(RuntimeError, 'CLIENT_METADATA_FIELD_CHANGED'):
                b.unchanged_client(context, contract)
            (directory / 'index.js').write_text(originals['index.js'])
            (directory / 'index.js').write_text(originals['index.js'].replace(
                '"node_modules/.prisma/client"', '"../../node_modules/.prisma/client"'))
            with self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                b.unchanged_client(context, contract)
            (directory / 'index.js').write_text(originals['index.js'])
            (directory / 'unexpected.js').write_text('unreviewed')
            with self.assertRaisesRegex(RuntimeError, 'UNCHANGED_CLIENT_NOT_REPRODUCED'):
                b.unchanged_client(context, contract)

    def test_runtime_schema_cannot_follow_an_unreviewed_root_or_runtime_change(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary:
            context = Path(temporary)
            target = context / b.SCHEMA
            target.parent.mkdir(parents=True)
            target.write_bytes(b'known existing schema')
            expected = digest(target.read_bytes())
            contract = {'schemaSha256': expected, 'unchangedInputs': {b.SCHEMA: expected}}
            b.verify_runtime_schema(context, contract)
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_SCHEMA_CHANGED'):
                b.verify_runtime_schema(context, {**contract, 'schemaSha256': '0' * 64})
            target.write_bytes(b'changed schema')
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_SCHEMA_CHANGED'):
                b.verify_runtime_schema(context, contract)

    def test_projection_canonical_hash_preserves_complete_parent_identity(self):
        manifest = {'roleSourceProjections': {'api': {'commit': 'first', 'files': {'b': 2, 'a': 1}}},
                    'adminSourceProjection': {'sources': ['first', 'second'], 'commit': 'first'}}
        reordered = {'adminSourceProjection': {'commit': 'first', 'sources': ['first', 'second']},
                     'roleSourceProjections': {'api': {'files': {'a': 1, 'b': 2}, 'commit': 'first'}}}
        self.assertEqual(r.projection_hashes(manifest), r.projection_hashes(reordered))
        changed = copy.deepcopy(manifest)
        changed['roleSourceProjections']['api']['files']['a'] = 3
        self.assertNotEqual(r.projection_hashes(manifest), r.projection_hashes(changed))

    def test_api_delta_is_only_approved_modules_and_never_deletes_runtime(self):
        name = 'id-business-v2/auto-registration/apple-mailboxes.types'
        before = {name + '.js': 'a' * 64, name + '.d.ts': 'b' * 64, 'unrelated.js': 'c' * 64}
        after = {**before, name + '.d.ts': 'd' * 64}
        self.assertEqual(b.api_delta(before, after, {name + '.js': 'a' * 64}),
                         {name + '.d.ts': 'd' * 64})
        for invalid in [before, {**after, 'sales.js': 'a' * 64},
                        {key: value for key, value in after.items() if key != 'unrelated.js'}]:
            with self.assertRaisesRegex(RuntimeError, 'API_OUTPUT_SCOPE_CHANGED'):
                b.api_delta(before, invalid, {name + '.js': 'a' * 64})

    def sqlite_fixture(self):
        parent = json.loads((HERE / 'registration-flow-evidence-contract.json').read_bytes())
        policy = copy.deepcopy(self.contract['sqliteReviewPolicy'])
        contract = {**self.contract, 'sqliteReviewPolicy': policy}
        value = {'version': 1, 'status': 'PASS', **policy['summary'], 'activeAppleLeaseCount': 1,
                 'executingTaskCount': 0, 'retainedReviewLeaseCount': 1,
                 'corruptEncryptedValueCount': 0, 'leaseFacts': policy['leaseFacts'],
                 'protectedTaskFacts': policy['protectedTaskFacts'], 'dependencies': self.contract['runtimePythonDependencies'], 'businessActions': 0}
        return contract, value

    def test_three_terminal_tasks_manual_state_and_review_lease_are_preserved_exactly(self):
        contract, value = self.sqlite_fixture()
        self.assertEqual(r.validate_sqlite_receipt(value, contract), value)
        for collection in ('leaseFacts', 'protectedTaskFacts'):
            for index in range(len(value[collection])):
                changed = copy.deepcopy(value)
                changed[collection][index]['bindingSha256'] = '0' * 64
                with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
                    r.validate_sqlite_receipt(changed, contract)
        for field, replacement in [('executingTaskCount', 1), ('activeAppleLeaseCount', 0),
                                   ('businessActions', 1), ('logicalSha256', '0' * 64)]:
            with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
                r.validate_sqlite_receipt({**value, field: replacement}, contract)
        with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_CHANGED'):
            r.validate_sqlite_receipt(value, contract, '0' * 64)

    def test_release_inspector_remains_readonly_and_includes_original_three_task_ids(self):
        source = r.sqlite_inspection_source()
        self.assertIn('PRAGMA query_only=ON', source)
        self.assertIn("db.execute('BEGIN')", source)
        self.assertIn('integrity_check', source)
        self.assertIn('encrypted_proof', source)
        self.assertIn('assert leases==1', source)
        self.assertIn('af941d8b-d0a5-4d94-8a43-029d54f017a9', source)
        self.assertNotIn('UPDATE ', source)
        self.assertNotIn('DELETE ', source)

    def test_real_inspector_projects_every_field_of_all_three_fresh_contract_facts(self):
        tree = ast.parse(r.sqlite_inspection_source())
        append = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == 'append'
                  and isinstance(node.func.value, ast.Name) and node.func.value.id == 'protected']
        self.assertEqual(len(append), 1)
        expression = compile(ast.Expression(append[0].args[0]), '<protected_fact_projection>', 'eval')
        for fact in self.contract['sqliteReviewPolicy']['protectedTaskFacts']:
            with self.subTest(task=fact['taskUuid']):
                context = {
                    '__builtins__': {}, 'task': fact['taskUuid'], 'task_status': fact['taskStatus'],
                    'record': {'registrationStatus': fact['recordRegistrationStatus'],
                               'taskStatus': fact['recordTaskStatus'], 'source': fact['recordSource'],
                               'activeTaskUuid': fact['activeTaskUuid']},
                    'binding': {'sideEffectPossible': fact['sideEffectPossible'],
                                'needsReview': fact['needsReview']},
                    'value': 'synthetic-record', 'binding_value': 'synthetic-binding',
                    'task_row': ('synthetic-row',), 's': types.SimpleNamespace(sqlite_value=lambda v: v),
                    'h': lambda value: fact['recordSha256'] if value == 'synthetic-record'
                         else fact['bindingSha256'] if value == 'synthetic-binding' else fact['taskRowSha256']
                }
                projected = eval(expression, context)
                self.assertEqual(set(projected), set(fact))
                self.assertEqual(projected, fact)
                context['record']['activeTaskUuid'] = 'synthetic-drift'
                self.assertNotEqual(eval(expression, context), fact)

    def test_archive_rejects_links_traversal_duplicates_and_outside_payload(self):
        for name, kind in [('outside/file', tarfile.REGTYPE), ('payload/../escape', tarfile.REGTYPE),
                           ('payload/link', tarfile.SYMTYPE)]:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.size = 0
                archive.addfile(item, io.BytesIO())
            with tempfile.TemporaryDirectory(dir=OUTPUT) as temporary, \
                    self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                r.archive(buffer.getvalue(), Path(temporary) / 'extract')

    def test_new_channel_is_no_migration_no_client_overlay_and_separate_namespace(self):
        source = (HERE / 'registration-parity-diagnostics-release.py').read_text()
        self.assertNotIn('apply_migration', source)
        self.assertNotIn('migrate deploy', source)
        self.assertNotIn('prisma-client/', source[source.index('for role, copies, count in'):])
        self.assertIn("('api', 'COPY modules/", source)
        self.assertIn("'--force-recreate', 'online-recharge'", source)
        self.assertIn('registration-parity-diagnostics-preservation.json', source)
        self.assertIn('registration-parity-diagnostics-readback.json', source)
        self.assertIsNone(self.contract['migration'])


if __name__ == '__main__':
    unittest.main()
