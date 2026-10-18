"""Offline finite-release contracts and mocked readback; no business requests."""
import ast
import copy
import importlib.util
import io
import inspect
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
TEST_OUTPUT = HERE.parents[1] / '.runtime/online-query-network-control-tests'
TEST_OUTPUT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('query_network_tests', HERE / 'online-query-network-release.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
H = 'a' * 64
COMMIT = 'b' * 40
TREE = 'c' * 40


def contract():
    old = json.loads((HERE / 'online-session-preflight-contract.json').read_bytes())
    public = json.loads((HERE / 'online-query-network-contract.json').read_bytes())['reconstruction']['publishedAdminFiles']
    baseline = copy.deepcopy(old['baseline'])
    baseline.update(commit=p.SOURCE_BASE, current='/opt/id-business-v2/releases/current-test')
    baseline['adminFiles'].update(public)
    for role, digest in p.PREDECESSOR_IMAGES.items():
        baseline['services'][role]['image'] = digest
    before = baseline['engineFiles']
    after = {**before, **{name: H for name in p.FILES}}
    return {'version': 1, 'scope': p.SCOPE, 'reviewBase': p.REVIEW_BASE,
        'expectedCurrent': p.SOURCE_BASE, 'sourceReviewCommit': 'd' * 40,
        'sourceReviewTag': 'online-query-network-source-review-' + 'd' * 12,
        'engineRoot': p.ENGINE, 'sources': {name: H for name in p.APPLICATION},
        'reviewedControlSources': {name: H for name in p.SCOPE_CONTROLS},
        'controlPins': {name: H for name in p.CONTROLS}, 'workflowSha256': H,
        'requiredQualityParts': list(p.QUALITY_PARTS), 'updatedServices': list(p.UPDATED),
        'preservedServices': list(p.PRESERVED), 'beforeEngineFiles': before, 'afterEngineFiles': after,
        'apiModules': sorted(p.API_MODULES), 'apiDeclarationOnly': {},
        'migrationPerformed': False, 'businessActions': 0, 'baseline': baseline,
        'reconstruction': {'predecessorProofSha256': p.PREDECESSOR_PROOF,
            'historicalControlsTree': p.HISTORICAL_CONTROLS_TREE,
            'publishedAdminCommit': p.SOURCE_BASE,
            'apiSourceCommit': '17591a4e0d02efb55ad2443d586d6b6913895efb',
            'apiOverlayReview': 'a1e65b996b0c527a562a14c470b5c7650a00bd25',
            'pins': {name: H for name in p.RECONSTRUCTION_FILES},
            'publishedAdminSources': {name: digest for name, digest in old['sources'].items()
                if name.startswith('apps/admin/')}, 'publishedAdminFiles': public}}


def proof(c):
    quality = {'kind': 'EXACT_MAIN_SUCCESS', 'runId': '99', 'runAttempt': 1,
        'testedTree': TREE, 'commit': COMMIT}
    modules = {name.removesuffix('.js') + ext: H for name in p.API_MODULES
        for ext in ('.js', '.js.map', '.d.ts')}
    public = {'index.html': H, 'assets/index-new.js': H}
    files = {**{'source/' + name: value for name, value in c['sources'].items()},
        **{'api/modules/' + name: value for name, value in modules.items()},
        **{'admin/html/' + name: value for name, value in public.items()},
        **{'engine/' + name: c['afterEngineFiles'][name] for name in p.FILES}}
    return {'version': 1, 'scope': p.SCOPE, 'commit': COMMIT, 'tree': TREE,
        'workflowRunId': '100', 'workflowRunAttempt': '1',
        'contractSha256': p.sha((HERE / p.CONTRACT_FILE).read_bytes()),
        'controlSources': dict(c['controlPins']), 'qualitySourceEvidence': quality,
        'qualityPartEvidence': {'runId': '99', 'runAttempt': 1, 'testedTree': TREE,
            'parts': list(p.QUALITY_PARTS), 'jobs': dict(zip(p.QUALITY_PARTS, (10, 11, 12, 13)))},
        'workflow': p.WORKFLOW, 'workflowSha256': H, 'sources': c['sources'],
        'baselineApiReproduced': True, 'baselineAdminSourceReproduced': True,
        'beforeApiOnlineFiles': c['baseline']['apiOnlineFiles'],
        'baselineAdminFiles': c['reconstruction']['publishedAdminFiles'], 'adminFiles': public,
        'apiModules': modules, 'afterEngineFiles': c['afterEngineFiles'], 'files': files,
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0}


def runtime_dependency_closure():
    """Read real ASTs; follow local calls, loaded aliases and literal sibling paths."""
    definitions = {}
    def functions(name):
        if name not in definitions:
            tree = ast.parse((HERE / name).read_bytes())
            definitions[name] = {node.name: node for node in tree.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        return definitions[name]
    queue = [('online-query-network-release.py', name) for name in functions('online-query-network-release.py')]
    queue.extend(('remote-deploy.py', name) for name in ('run', 'compose', 'assert_no_active_recharge',
        'assert_no_active_registration', 'wait_healthy', 'point_current', 'service_state', 'current_job_database'))
    selected, dependencies = set(), {'online-query-network-release.py'}
    def literal_module(node):
        if isinstance(node, ast.Call):
            function = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, 'attr', None)
            if function in ('load', 'helper') and node.args and isinstance(node.args[0], ast.Constant):
                value = node.args[0].value
                if isinstance(value, str) and value.endswith('.py'):
                    return value
        return None
    while queue:
        module, name = queue.pop()
        if (module, name) in selected:
            continue
        selected.add((module, name))
        function = functions(module).get(name)
        if function is None:
            raise AssertionError('runtime function no longer exists: ' + module + ':' + name)
        aliases = {}
        for node in ast.walk(function):
            if isinstance(node, ast.Assign):
                dependency = literal_module(node.value)
                if dependency:
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            aliases[target.id] = dependency
        for node in ast.walk(function):
            if isinstance(node, ast.Call):
                dependency = literal_module(node)
                if dependency:
                    dependencies.add(dependency)
                if isinstance(node.func, ast.Name) and node.func.id in functions(module):
                    queue.append((module, node.func.id))
                if isinstance(node.func, ast.Attribute) and node.func.attr == 'with_name' and node.args \
                        and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) \
                        and node.args[0].value.endswith('.py'):
                    dependencies.add(node.args[0].value)
            if isinstance(node, ast.Attribute):
                dependency = aliases.get(node.value.id) if isinstance(node.value, ast.Name) else literal_module(node.value)
                if dependency and node.attr in functions(dependency):
                    dependencies.add(dependency)
                    queue.append((dependency, node.attr))
    return dependencies, selected


class ContractTests(unittest.TestCase):
    def test_accepts_exact_three_role_overlay(self):
        c = contract()
        p.validate_contract(c)
        value = proof(c)
        p.verify_proof(value, value, c, value['files'])

    def test_baseline_is_required_for_publication(self):
        c = contract()
        c['baseline'] = None
        p.validate_contract(c, require_baseline=False)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_NOT_BOUND'):
            p.validate_contract(c)

    def test_rejects_unreviewed_source_and_schema_or_migration(self):
        for name in ('apps/admin/src/v2/views/V2AutoRegistrationView.vue',
                'apps/api/prisma/schema.mysql.prisma', 'apps/api/prisma/mysql-migrations/new/migration.sql',
                'apps/api/src/id-business-v2/online-recharge/worker.service.ts'):
            with self.subTest(name=name):
                c = contract()
                c['sources'][name] = H
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                    p.validate_contract(c)

    def test_rejects_runtime_role_change(self):
        for key, role in (('updatedServices', 'auto-registration'), ('preservedServices', 'mysql')):
            with self.subTest(key=key):
                c = contract()
                c[key].remove(role) if role in c[key] else c[key].append(role)
                with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY_INVALID'):
                    p.validate_contract(c)

    def test_rejects_migrations_and_false_zero(self):
        for key, value in (('migrationPerformed', True), ('businessActions', 1), ('businessActions', False)):
            with self.subTest(key=key, value=value):
                c = contract()
                c[key] = value
                with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY_INVALID'):
                    p.validate_contract(c)

    def test_rejects_different_predecessor_and_review_base(self):
        for key in ('expectedCurrent', 'reviewBase'):
            with self.subTest(key=key):
                c = contract()
                c[key] = 'e' * 40
                with self.assertRaisesRegex(RuntimeError, 'CONTRACT_IDENTITY_INVALID'):
                    p.validate_contract(c)

    def test_rejects_changed_predecessor_images(self):
        for role in p.UPDATED:
            with self.subTest(role=role):
                c = contract()
                c['baseline']['services'][role]['image'] = 'sha256:' + H
                with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
                    p.validate_contract(c)

    def test_rejects_unhealthy_or_busy_predecessor(self):
        c = contract()
        c['baseline']['engineHealth']['activeTasks'] = 1
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            p.validate_contract(c)

    def test_rejects_changed_engine_baseline(self):
        c = contract()
        c['beforeEngineFiles'] = {**c['beforeEngineFiles'], 'worker.cjs': H}
        with self.assertRaisesRegex(RuntimeError, 'ENGINE_SCOPE_CHANGED'):
            p.validate_contract(c)

    def test_rejects_unrelated_engine_delta(self):
        c = contract()
        c['afterEngineFiles']['worker.cjs'] = H
        with self.assertRaisesRegex(RuntimeError, 'ENGINE_SCOPE_CHANGED'):
            p.validate_contract(c)

    def test_rejects_extra_declaration_and_api_module(self):
        for key, value in (('apiDeclarationOnly', {'id-business-v2/auth.d.ts': H}),
                ('apiModules', [*p.API_MODULES, 'id-business-v2/auto-registration/service.js'])):
            with self.subTest(key=key):
                c = contract()
                c[key] = value
                with self.assertRaisesRegex(RuntimeError, 'API_SCOPE_CHANGED'):
                    p.validate_contract(c)

    def test_rejects_changed_published_admin(self):
        c = contract()
        c['reconstruction']['publishedAdminFiles']['index.html'] = H
        with self.assertRaisesRegex(RuntimeError, 'RECONSTRUCTION_CHANGED'):
            p.validate_contract(c)

    def test_rejects_changed_published_api(self):
        c = contract()
        c['baseline']['apiOnlineFiles']['validation.js'] = H
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            p.validate_contract(c)

    def test_rejects_missing_retained_asset(self):
        c = contract()
        del c['baseline']['adminFiles']['index.html']
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_CHANGED'):
            p.validate_contract(c)

    def test_rejects_traversal_or_unpinned_helper(self):
        for group, name in (('sources', '../escape'), ('controlPins', 'new-helper.py')):
            with self.subTest(group=group):
                c = contract()
                c[group][name] = H
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_SCOPE_CHANGED'):
                    p.validate_contract(c)

    def test_compiled_delta_helper_is_pinned(self):
        self.assertIn('online-checkout-build.py', p.CONTROLS)

    def test_exact_review_contains_no_schema_migration_dependency_or_build_config(self):
        self.assertFalse(any('prisma/' in name or name.endswith(('package.json', 'package-lock.json'))
            or 'Dockerfile' in name or 'auto-registration/' in name for name in p.APPLICATION))
        self.assertEqual(len(p.APPLICATION), 17)


class ProofTests(unittest.TestCase):
    def reject(self, mutate, code):
        c = contract()
        value = proof(c)
        mutate(value)
        with self.assertRaisesRegex(RuntimeError, code):
            p.verify_proof(value, value, c, value['files'])

    def test_rejects_missing_quality_part(self):
        self.reject(lambda value: value['qualityPartEvidence']['jobs'].pop('api'), 'FINITE_PROOF_CHANGED')

    def test_rejects_changed_tree(self):
        self.reject(lambda value: value['qualitySourceEvidence'].update(testedTree='e' * 40), 'QUALITY_SOURCE_INVALID')

    def test_rejects_changed_control_even_when_plan_matches(self):
        self.reject(lambda value: value['controlSources'].update({'remote-deploy.py': 'f' * 64}), 'FINITE_PROOF_CHANGED')

    def test_rejects_changed_workflow(self):
        self.reject(lambda value: value.update(workflow='.github/workflows/deploy.yml'), 'FINITE_PROOF_CHANGED')

    def test_rejects_unreproduced_api_and_admin(self):
        for name in ('baselineApiReproduced', 'baselineAdminSourceReproduced'):
            with self.subTest(name=name):
                self.reject(lambda value: value.update({name: False}), 'PROOF_CHANGED')

    def test_rejects_migration_and_false_zero(self):
        self.reject(lambda value: value.update(migrationPerformed=True), 'PROOF_CHANGED')
        self.reject(lambda value: value.update(businessActions=False), 'FINITE_PROOF_CHANGED')

    def test_rejects_extra_artifact_even_when_self_declared(self):
        for path in ('engine/credentials.cjs', 'api/modules/auth.js', 'source/apps/api/prisma/schema.prisma'):
            with self.subTest(path=path):
                self.reject(lambda value: value['files'].update({path: H}), 'PAYLOAD_SCOPE_CHANGED')

    def test_rejects_missing_api_module(self):
        self.reject(lambda value: value['apiModules'].pop(next(iter(value['apiModules']))), 'API_MODULE_SCOPE_CHANGED')

    def test_rejects_traversal_in_admin_files(self):
        self.reject(lambda value: value['adminFiles'].update({'../escape': H}), 'FINITE_PROOF_CHANGED')

    def test_rejects_artifact_namespace_before_download(self):
        for path in ('online-checkout-', 'online-query-network-'):
            value = {'commit': COMMIT, 'artifactUrl': p.artifact_url(COMMIT).replace('online-query-network-', path, 1)}
            if path == 'online-query-network-':
                value['artifactUrl'] = value['artifactUrl'].replace('github.com/', 'attacker.example/')
            with self.subTest(path=path), patch.object(p.urllib.request, 'urlopen') as request:
                with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_LOCATION_INVALID'):
                    p.download_artifact(value)
                request.assert_not_called()

    def test_rejects_symlink_and_traversal_archives(self):
        for name, kind in (('payload/admin/html/link', tarfile.SYMTYPE), ('payload/../escape', tarfile.REGTYPE)):
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode='w:gz') as archive:
                item = tarfile.TarInfo(name)
                item.type, item.linkname = kind, '/etc/passwd'
                archive.addfile(item)
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
                with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                    p.load('recharge-record-release.py').safe_archive(raw.getvalue(), Path(directory) / 'out')

    def test_compiled_scope_rejects_unrelated_registration_change(self):
        before = {'id-business-v2/auto-registration/service.js': H}
        after = {**before, **{name.removesuffix('.js') + ext: H for name in p.API_MODULES
            for ext in ('.js', '.js.map', '.d.ts')}}
        after['id-business-v2/auto-registration/service.js'] = 'e' * 64
        with self.assertRaisesRegex(RuntimeError, 'COMPILED_SCOPE_CHANGED'):
            p.load('online-checkout-build.py').module_delta(before, after, p.API_MODULES)


class RuntimeTests(unittest.TestCase):
    def test_real_runtime_dependency_closure_is_present_and_pinned(self):
        dependencies, selected = runtime_dependency_closure()
        self.assertTrue(dependencies <= p.CONTROLS, 'unbound runtime files: ' + repr(dependencies - p.CONTROLS))
        self.assertTrue(all((HERE / name).is_file() and not (HERE / name).is_symlink() for name in dependencies))
        self.assertIn(('online-pending-features-release.py', 'verify_runtime_inventory'), selected)
        self.assertIn(('online-checkout-release.py', 'baseline'), selected)
        self.assertIn(('online-checkout-release.py', 'smoke'), selected)
        self.assertIn(('proxy-result-identity-release.py', 'sql_fence_class'), selected)
        self.assertIn('api-admin-scope.py', dependencies)

    def test_real_shared_function_signatures_and_sql_fence_binding(self):
        legacy = p.load('online-checkout-release.py')
        pending = p.load('online-pending-features-release.py')
        self.assertEqual(tuple(inspect.signature(legacy.baseline).parameters), ('d', 'contract', 'h'))
        self.assertEqual(tuple(inspect.signature(legacy.smoke).parameters), ('d', 'target', 'states', 'proof', 'contract', 'h'))
        self.assertEqual(tuple(inspect.signature(pending.verify_runtime_inventory).parameters), ('d', 'states', 'c', 'proof'))
        c = contract()
        c['controlPins']['api-admin-scope.py'] = p.sha((HERE / 'api-admin-scope.py').read_bytes())
        converted = p.legacy_contract(c)
        self.assertEqual(converted['sqlFenceHelperSha256'], c['controlPins']['api-admin-scope.py'])
        self.assertEqual(converted['beforeApiOnlineFiles'], c['baseline']['apiOnlineFiles'])
        fence = p.load('proxy-result-identity-release.py').sql_fence_class(converted)
        self.assertEqual(tuple(inspect.signature(fence).parameters), ('d', 'directory'))
        self.assertIn('id_business_v2_recharge_jobs', fence.QUERY)
        self.assertNotIn('INSERT ', fence.QUERY)
        self.assertNotIn('UPDATE ', fence.QUERY)

    def runtime_inventory(self, *, namespace=True, extra_api=False, extra_admin=False):
        c = contract()
        states = c['baseline']['services']
        actions = []
        helper = p.load('online-pending-features-release.py')
        class D:
            def run(self, *args, **kwargs):
                actions.append(args)
                if args[1] == 'inspect':
                    mode = 'container:' + states['api']['containerId'] if namespace else 'bridge'
                    return json.dumps([{'HostConfig': {'NetworkMode': mode}}])
                if args[3] == 'find':
                    names = [*c['baseline']['adminFiles'], *(['extra.js'] if extra_admin else [])]
                    return '\n'.join('/usr/share/nginx/html/' + name for name in names)
                if args[3] == 'node':
                    return json.dumps({**c['baseline']['apiOnlineFiles'], **({'extra.js': H} if extra_api else {})})
                if args[3] == 'sha256sum':
                    return '\n'.join(c['baseline']['adminFiles'][name.removeprefix('/usr/share/nginx/html/')]
                        + '  ' + name for name in args[4:])
                raise AssertionError('unexpected external command')
        with patch.object(helper.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 * 1024**3)):
            helper.verify_runtime_inventory(D(), states, c)
        self.assertTrue(all(args[0] == 'docker' and args[1] in ('exec', 'inspect') for args in actions))

    def test_runtime_inspection_is_read_only(self):
        self.runtime_inventory()

    def test_rejects_changed_engine_api_namespace(self):
        with self.assertRaisesRegex(RuntimeError, 'API_NAMESPACE_CHANGED'):
            self.runtime_inventory(namespace=False)

    def test_rejects_extra_runtime_api_file(self):
        with self.assertRaisesRegex(RuntimeError, 'API_INVENTORY_CHANGED'):
            self.runtime_inventory(extra_api=True)

    def test_rejects_extra_runtime_admin_file(self):
        with self.assertRaisesRegex(RuntimeError, 'ADMIN_INVENTORY_CHANGED'):
            self.runtime_inventory(extra_admin=True)

    def test_host_readback_rejects_changed_source(self):
        c = contract()
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            with self.assertRaisesRegex(RuntimeError, 'HOST_SOURCE_CHANGED|No such file'):
                p.verify_host(None, Path(directory), c['baseline']['services'], proof(c), c, None)

    def readback(self, *, migration=False):
        c = contract()
        c['controlPins'] = {name: p.sha((HERE / name).read_bytes()) for name in p.CONTROLS}
        value = proof(c)
        value['migrationPerformed'] = migration
        actions = []
        original_load = p.load
        legacy = original_load('online-checkout-release.py')
        original_legacy_load = legacy.load
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            root = Path(directory).resolve()
            target = root / 'releases/current'
            target.mkdir(parents=True)
            (root / 'current').symlink_to(target, target_is_directory=True)
            (target / 'release-manifest.json').write_text(json.dumps({'commit': COMMIT, 'scope': p.SCOPE}))
            states = c['baseline']['services']
            (target / 'online-checkout-preservation.json').write_text(json.dumps({'after': states}))
            raw = json.dumps(value).encode()
            (target / 'online-checkout-build-proof.json').write_bytes(raw)
            selected = {**value, 'mode': 'readback', 'buildProofSha256': p.sha(raw)}
            class D:
                def compose(self, *args, **kwargs):
                    raise AssertionError('readback must never restart, stop, migrate or compose')
                def run(self, *args, **kwargs):
                    raise AssertionError('mock readback must never make business or external requests')
            helpers = types.SimpleNamespace(load_utilities=lambda *args: D(), snapshot=lambda *args: states,
                guards=lambda *args: actions.append('idle-guards'))
            lock = types.SimpleNamespace(acquire_release_lock=lambda *args: actions.append('lock'))
            legacy.load = lambda name: {'recharge-record-release.py': helpers,
                'recharge-availability-release.py': lock}.get(name) or original_legacy_load(name)
            legacy.BASE = root
            legacy.smoke = lambda *args: actions.append('preserved-role-and-runtime-guards')
            count = 0
            def fake_load(name):
                nonlocal count
                if name == 'online-checkout-release.py':
                    count += 1
                    if count == 1:
                        return legacy
                return original_load(name)
            with patch.object(p, 'load', fake_load), patch.object(p, 'validate_plan'), \
                    patch.object(p, 'verify_runtime_inventory', side_effect=lambda *args: actions.append('exact-runtime-inventory')), \
                    patch.object(p, 'verify_host', side_effect=lambda *args: actions.append('host-source-and-configuration')):
                result = p.release(selected, c)
            self.assertEqual(actions, ['lock', 'preserved-role-and-runtime-guards', 'exact-runtime-inventory',
                'host-source-and-configuration', 'idle-guards'])
            return result

    def test_independent_readback_never_performs_writes_and_preserves_five_roles(self):
        result = self.readback()
        self.assertEqual(result['status'], 'ONLINE_QUERY_NETWORK_INDEPENDENT_READBACK_VERIFIED')
        self.assertEqual(result['updatedServices'], list(p.UPDATED))
        self.assertEqual(result['preservedServices'], list(p.PRESERVED))
        self.assertEqual(result['businessActions'], 0)
        self.assertIs(result['migrationPerformed'], False)

    def test_independent_readback_rejects_claimed_migration(self):
        with self.assertRaisesRegex(RuntimeError, 'PROOF_CHANGED'):
            self.readback(migration=True)

    def test_host_configuration_cannot_change_a_preserved_role(self):
        c = contract()
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            root = Path(directory)
            target, previous = root / 'target', root / 'previous'
            target.mkdir()
            previous.mkdir()
            c['sources'] = {'apps/source': p.sha(b'reviewed')}
            (target / 'apps').mkdir()
            (target / 'apps/source').write_bytes(b'reviewed')
            controls = target / 'scripts/production-release'
            controls.mkdir(parents=True)
            (controls / p.CONTRACT_FILE).write_bytes((HERE / p.CONTRACT_FILE).read_bytes())
            c['controlPins'] = {'controller.py': p.sha(b'controller')}
            (controls / 'controller.py').write_bytes(b'controller')
            c['baseline']['configurationSha256'] = {'.env.aws.production': p.sha(b'placeholder'),
                'compose.release.json': H}
            (target / '.env.aws.production').write_bytes(b'placeholder')
            c['baseline']['current'] = str(previous)
            states = c['baseline']['services']
            before = {'services': {role: {'image': 'old:' + role, 'environment': {'UNCHANGED': 'true'}}
                for role in p.SERVICES}}
            (previous / 'compose.release.json').write_text(json.dumps(before))
            expected = copy.deepcopy(before)
            for role in p.UPDATED:
                expected['services'][role]['image'] = states[role]['reference']
            (target / 'compose.release.json').write_text(json.dumps(expected))
            p.verify_host(None, target, states, proof(contract()), c, None)
            expected['services']['auto-registration']['image'] = 'unreviewed:retirement'
            (target / 'compose.release.json').write_text(json.dumps(expected))
            with self.assertRaisesRegex(RuntimeError, 'OVERRIDE_SCOPE_CHANGED'):
                p.verify_host(None, target, states, proof(contract()), c, None)


class BuildTests(unittest.TestCase):
    def test_real_source_reconstruction_uses_repository_git_directory_and_restores_it(self):
        builder = p.load('online-query-network-build.py')
        c = contract()
        c['reconstruction']['pins'] = {name: p.sha(builder.git('show',
            p.SOURCE_BASE + ':scripts/production-release/' + name)) for name in p.RECONSTRUCTION_FILES}
        calls = []
        original_run = builder.subprocess.run
        def git_only(command, *args, **kwargs):
            self.assertEqual(command[0], 'git')
            self.assertIn(command[1], ('show', 'archive', 'rev-parse', 'merge-file', 'ls-tree', 'cat-file'))
            calls.append(tuple(command[:2]))
            return original_run(command, *args, **kwargs)
        before = builder.os.environ.get('GIT_DIR')
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            output = Path(directory) / 'source-only'
            output.mkdir()
            with patch.object(builder, 'OUT', output), patch.object(builder.subprocess, 'run', side_effect=git_only):
                api, admin = builder.reconstruct(c)
            self.assertEqual(builder.os.environ.get('GIT_DIR'), before)
            self.assertTrue(api.is_dir() and admin.is_dir())
            for name, digest in c['reconstruction']['publishedAdminSources'].items():
                self.assertEqual(p.sha((admin / name).read_bytes()), digest)
            pending = json.loads((HERE / 'online-pending-features-contract.json').read_bytes())
            for name, digest in pending['sources'].items():
                if name.startswith('apps/api/') and not name.startswith(p.ENGINE + '/'):
                    self.assertEqual(p.sha((api / name).read_bytes()), digest)
            schema = 'apps/api/prisma-mysql/schema.prisma'
            self.assertEqual((api / schema).read_bytes(), builder.git('show',
                c['reconstruction']['apiSourceCommit'] + ':' + schema))
            self.assertTrue((admin / 'apps/admin/src/v2/features/auto-registration').is_dir())
        self.assertIn(('git', 'archive'), calls)
        self.assertIn(('git', 'merge-file'), calls)

    def test_actual_builder_serialization_produces_json_archive_and_plain_sha(self):
        tree = ast.parse((HERE / 'online-query-network-build.py').read_bytes())
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        def writes(node, filename):
            return isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) \
                and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'write_text' \
                and any(isinstance(item, ast.Constant) and item.value == filename for item in ast.walk(node.value.func.value))
        start = next(index for index, node in enumerate(main.body) if writes(node, 'build-proof.json'))
        stop = next(index for index, node in enumerate(main.body) if writes(node, 'artifact-sha256.txt')) + 1
        code = compile(ast.Module(body=main.body[start:stop], type_ignores=[]), 'actual_builder_packaging', 'exec')
        value = {'scope': p.SCOPE, 'businessActions': 0, 'migrationPerformed': False}
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            output = Path(directory)
            payload = output / 'payload'
            payload.mkdir()
            exec(code, {'payload': payload, 'proof': value, 'OUT': output, 'p': p, 'json': json, 'tarfile': tarfile})
            raw = (payload / 'build-proof.json').read_bytes()
            self.assertEqual(json.loads(raw), value)
            self.assertTrue(raw.endswith(b'\n'))
            bundle = output / 'online-query-network-artifact.tar.gz'
            self.assertEqual((output / 'artifact-sha256.txt').read_text().strip(), p.sha(bundle.read_bytes()))
            with tarfile.open(bundle, 'r:gz') as archive:
                self.assertEqual(json.loads(archive.extractfile('payload/build-proof.json').read()), value)

    def test_review_tag_must_be_annotated_and_exact(self):
        builder = p.load('online-query-network-build.py')
        c = contract()
        with patch.object(builder, 'publisher', return_value=p), \
                patch.object(builder, 'git', return_value=b'commit\n'):
            with self.assertRaisesRegex(RuntimeError, 'REVIEW_TAG_CHANGED'):
                builder.check(c)

    def test_review_scope_must_be_exact(self):
        builder = p.load('online-query-network-build.py')
        c = contract()
        def git(*args):
            if args[0] == 'cat-file':
                return b'tag\n'
            if args[0] == 'rev-parse':
                return (c['sourceReviewCommit'] + '\n').encode()
            return ('\n'.join([*p.APPLICATION, *p.SCOPE_CONTROLS, 'apps/api/prisma/schema.prisma']) + '\n').encode()
        with patch.object(builder, 'publisher', return_value=p), patch.object(builder, 'git', side_effect=git):
            with self.assertRaisesRegex(RuntimeError, 'REVIEW_SCOPE_CHANGED'):
                builder.check(c)

    def test_rejects_predecessor_proof_substitution(self):
        with self.assertRaisesRegex(RuntimeError, 'PREDECESSOR_PROOF_CHANGED'):
            p.load('online-query-network-build.py').frozen_reconstruction(b'{}')

    def test_overlay_rejects_source_mutation_and_symlink_escape(self):
        builder = p.load('online-query-network-build.py')
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            (source / 'item').write_bytes(b'one')
            target = root / 'target'
            target.mkdir()
            with patch.object(builder, 'ROOT', source):
                with self.assertRaisesRegex(RuntimeError, 'OVERLAY_SOURCE_CHANGED'):
                    builder.overlay(target, {'item': H})
                (target / 'item').symlink_to(source / 'item')
                with self.assertRaisesRegex(RuntimeError, 'OVERLAY_PATH_CHANGED'):
                    builder.overlay(target, {'item': p.sha(b'one')})

    def test_native_builder_rejects_local_or_non_main_environment(self):
        builder = p.load('online-query-network-build.py')
        c = contract()
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            config = Path(directory) / 'contract.json'
            config.write_text(json.dumps(c))
            with patch.object(builder, 'CONTRACT', config), patch.object(builder, 'check', return_value=p), \
                    patch.object(builder, 'git', return_value=(COMMIT + '\n').encode()), \
                    patch.dict(builder.os.environ, {}, clear=True), patch.object(builder, 'reconstruct') as reconstruct:
                with self.assertRaisesRegex(RuntimeError, 'NATIVE_BUILD_REQUIRED'):
                    builder.main()
                reconstruct.assert_not_called()

    def test_deleted_quality_helper_is_pinned_to_published_git_object(self):
        builder = p.load('online-query-network-build.py')
        name = 'registration-closure-dispatch.py'
        self.assertNotIn(name, p.CONTROLS)
        self.assertIn(name, p.RECONSTRUCTION_FILES)
        raw = {item: builder.git('show', p.SOURCE_BASE + ':scripts/production-release/' + item)
            for item in (name, 'online-session-preflight-build.py')}
        c = contract()
        c['reconstruction']['pins'].update({item: p.sha(value) for item, value in raw.items()})
        quality_run = {'workflow_runs': [{'head_sha': COMMIT, 'head_branch': 'main', 'event': 'push',
            'status': 'completed', 'conclusion': 'success', 'path': '.github/workflows/quality.yml',
            'id': 99, 'run_attempt': 1}]}
        jobs = {'total_count': 4, 'jobs': [{'name': 'recharge (' + part + ')', 'status': 'completed',
            'conclusion': 'success', 'id': index + 1} for index, part in enumerate(p.QUALITY_PARTS)]}
        calls = []
        def platform(*args, **kwargs):
            calls.append(args[0])
            self.assertEqual(tuple(args[0][:2]), ('gh', 'api'))
            value = jobs if '/jobs?' in args[0][2] else quality_run
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(value).encode())
        with tempfile.TemporaryDirectory(dir=TEST_OUTPUT) as directory:
            config = Path(directory) / 'contract.json'
            config.write_text(json.dumps(c))
            with patch.object(builder, 'CONTRACT', config), patch.object(builder, 'git',
                    side_effect=lambda *args: raw[args[1].split('/')[-1]]), \
                    patch.object(builder.subprocess, 'run', side_effect=platform):
                evidence, parts = builder.quality_evidence(COMMIT, TREE)
            self.assertEqual(evidence['kind'], 'EXACT_MAIN_SUCCESS')
            self.assertEqual(parts['parts'], list(p.QUALITY_PARTS))
            self.assertEqual(len(calls), 2)

    def test_native_workflow_has_no_deployment_credentials_or_business_actions(self):
        text = (HERE.parents[1] / p.WORKFLOW).read_text()
        self.assertIn("github.ref == 'refs/heads/main' && inputs.commit == github.sha", text)
        self.assertIn('group: id-business-v2-production-release', text)
        self.assertIn('cancel-in-progress: false', text)
        self.assertNotIn('secrets.', text)
        self.assertNotIn('configure-aws-credentials', text)
        self.assertNotIn('workflow_run:', text)
        self.assertIn('online-query-network-release.test.py', text)


if __name__ == '__main__':
    unittest.main()
