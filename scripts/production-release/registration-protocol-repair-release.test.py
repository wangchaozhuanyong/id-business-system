"""Pure admission/preservation checks; never runs a publisher or opens a database."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('pure_repair_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('registration-protocol-repair-release.py')
b = load('registration-protocol-repair-build.py')
d = load('registration-protocol-repair-dispatch.py')


class ProtocolRepairControls(unittest.TestCase):
    def setUp(self):
        self.socket = patch.object(socket.socket, 'connect', side_effect=AssertionError('network disabled'))
        self.database = patch.object(sqlite3, 'connect', side_effect=AssertionError('database disabled'))
        self.socket.start()
        self.database.start()
        self.addCleanup(self.socket.stop)
        self.addCleanup(self.database.stop)

    def ready(self):
        c = json.loads((HERE / 'registration-protocol-repair-contract.json').read_bytes())
        c.update(admission='VERIFIED', frozen=True)
        c['controlHashes'] = {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in r.CONTROL_FILES}
        c['sources'] = {name: r.digest((r.ROOT / name).read_bytes()) for name in c['applicationPaths']}
        c['workerFiles'] = {Path(name).name: value for name, value in c['sources'].items()
                            if name.startswith(r.WORKER) and not Path(name).name.startswith('test_')}
        return c

    def temporary_parent(self):
        parent = r.ROOT / '.runtime/registration-parity-20261016/protocol-repair-20261017/control-tests'
        parent.mkdir(parents=True, exist_ok=True)
        return parent

    def plan(self, mode='preflight'):
        return {'mode': mode, 'commit': 'a' * 40, 'tree': 'b' * 40, 'workflowRunId': '123', 'workflowRunAttempt': '1',
                'contractSha256': 'c' * 64, 'controlSources': self.ready()['controlHashes']}

    def proof(self, c=None, plan=None):
        c, plan = c or self.ready(), plan or self.plan()
        after = copy.deepcopy(c['baseline']['inventory'])
        after['worker'] = r.signature({**c['baselineWorkerFiles'], **c['workerFiles']})
        value = {name: plan[name] for name in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources')}
        value.update(version=1, scope=r.SCOPE, sources=c['sources'], validationSources=c['validationSources'],
                     workerFiles=c['workerFiles'], apiModules={}, apiJavascriptDelta=[],
                     adminFiles={'index.html': 'e' * 64}, baselineInventory=c['baseline']['inventory'],
                     afterInventory=after, validation={'status': 'PASS', 'api': True, 'admin': True,
                                                       'offlineBrowser': True, 'isolatedPersistence': True},
                     migrationPerformed=False, businessActions=0)
        value['files'] = {**{'source/' + n: v for n, v in c['sources'].items()},
                          **{'api/modules/' + n: v for n, v in value['apiModules'].items()},
                          **{'api/worker/' + n: v for n, v in c['workerFiles'].items()},
                          **{'admin/html/' + n: v for n, v in value['adminFiles'].items()}}
        return value

    def test_draft_cannot_reach_release_or_transport(self):
        c = self.ready()
        c['admission'] = 'DRAFT'
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_NOT_ADMITTED'):
            r.release({}, c)

    def test_complete_bound_metadata_can_be_admitted_without_a_database(self):
        r.verify_contract(self.ready())

    def test_baseline_component_identity_and_empty_runtime_js_delta_are_required(self):
        for mutate in (lambda c: c.update(expectedCurrent='0' * 40),
                       lambda c: c.update(version=True), lambda c: c.update(businessActions=False),
                       lambda c: c['baseline']['images']['api'].update(image='sha256:' + '0' * 64),
                       lambda c: c.update(apiJavascriptDelta=['unrelated.js']),
                       lambda c: c.update(apiRuntimeDelta=[r.TYPE_MODULE]),
                       lambda c: c.update(validationSupportSources={'apps/api/unrelated.ts': '0' * 64}),
                       lambda c: c.update(apiDeclarationPaths=[])):
            c = self.ready()
            mutate(c)
            with self.assertRaises(RuntimeError):
                r.verify_contract(c)

    def test_runtime_inventory_or_account_evidence_cannot_be_omitted(self):
        for slot in ('api', 'apiJavascript', 'worker', 'admin', 'engine', 'prisma'):
            c = self.ready()
            del c['baseline']['inventory'][slot]
            with self.assertRaises(RuntimeError):
                r.verify_contract(c)
        c = self.ready()
        c['baseline']['mysql'] = {}
        with self.assertRaises(RuntimeError):
            r.verify_contract(c)

    def test_application_scope_cannot_expand_or_drop_a_file(self):
        for name in (r.APPLICATION_PATHS[0], 'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py'):
            c = self.ready()
            if name in c['sources']:
                c['sources'].pop(name)
                c['applicationPaths'].remove(name)
            else:
                c['sources'][name] = '0' * 64
                c['applicationPaths'].append(name)
            with self.assertRaises(RuntimeError):
                r.verify_contract(c)

    def test_historical_controller_cannot_be_replaced_or_omitted(self):
        c = self.ready()
        c['controlHashes']['registration-parity-diagnostics-release.py'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_CHANGED'):
            r.verify_contract(c)
        c = self.ready()
        c['controlFiles'] = []
        c['controlHashes'] = {}
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_SCOPE_CHANGED'):
            r.verify_contract(c)

    def test_inventory_digest_is_order_independent_and_keeps_historical_assets(self):
        before = {'old.js': 'a', 'index.html': 'b'}
        self.assertEqual(r.signature(before), r.signature(dict(reversed(list(before.items())))))
        after = {**before, 'new.js': 'c', 'index.html': 'd'}
        self.assertEqual(after['old.js'], before['old.js'])
        self.assertEqual(r.signature(after)['fileCount'], 3)

    def test_worker_runtime_history_matches_the_independent_native_digest(self):
        c = self.ready()
        self.assertEqual(r.signature(b.runtime_worker_map(c)), c['baseline']['inventory']['worker'])

    def test_transport_renames_only_this_new_operation(self):
        self.assertEqual(d.rename('registration-parity-diagnostics-contract.json'), 'registration-protocol-repair-contract.json')
        self.assertEqual(d.rename('.github/workflows/registration-parity-diagnostics-validation.yml'),
                         '.github/workflows/registration-protocol-repair-validation.yml')
        self.assertEqual(d.rename('registration-parity-diagnostics-artifact.tar.gz'), r.NAME + '-artifact.tar.gz')
        self.assertEqual(d.rename('REGISTRATION_PARITY_DIAGNOSTICS'), r.SCOPE)
        self.assertEqual(d.rename('registration-closure-dispatch.py'), 'registration-closure-dispatch.py')

    def test_private_clone_preserves_code_and_does_not_run_the_old_publisher(self):
        def sample():
            return 'registration-parity-diagnostics-preservation.json'
        cloned = types.FunctionType(r.rename_code(sample.__code__), {})
        self.assertEqual(sample(), 'registration-parity-diagnostics-preservation.json')
        self.assertEqual(cloned(), r.NAME + '-preservation.json')

    def test_proof_is_closed_and_rejects_wrong_scope_or_unrelated_payload(self):
        c, plan = self.ready(), self.plan()
        good = self.proof(c, plan)
        h = types.SimpleNamespace(file_inventory=lambda _: {**good['files'], 'build-proof.json': 'f' * 64})
        self.assertEqual(r.verify_proof(good, plan, c, Path('/unused'), h), good)
        for update in ({'version': True}, {'scope': 'other'}, {'unexpected': 'field'},
                       {'files': {**good['files'], 'api/modules/unrelated.js': '0' * 64}},
                       {'apiModules': {r.TYPE_MODULE: '0' * 64}},
                       {'apiModules': {'unrelated.js': '0' * 64}}):
            value = {**good, **update}
            with self.assertRaises(RuntimeError):
                r.verify_proof(value, plan, c, Path('/unused'), h)

    def test_real_adapted_preflight_uses_new_identity_and_returns_bound_receipt(self):
        c, plan = self.ready(), self.plan()
        parent = self.temporary_parent()
        with tempfile.TemporaryDirectory(prefix='protocol-control-test-', dir=parent) as name:
            old = r.helper('registration-parity-diagnostics-release.py')
            old.BASE = Path(name)
            real_helper = r.helper
            fake_a = types.SimpleNamespace(acquire_release_lock=Mock())
            fake_finite = types.SimpleNamespace()
            def selected(item):
                return {'registration-parity-diagnostics-release.py': old,
                        'recharge-availability-release.py': fake_a,
                        'proxy-result-identity-release.py': fake_finite}.get(item) or real_helper(item)
            observed = {'database': c['baseline']['mysql'], 'sqlite': c['baseline']['sqlite']}
            bound = Mock(return_value=(Path(c['current']), b'{}', c['baseline']['services'], observed))
            with patch.object(r, 'helper', selected), patch.object(r, 'baseline', bound):
                result = r.release(plan, c, d=object(), h=object())
            self.assertEqual(result['status'], r.SCOPE + '_PREFLIGHT_VERIFIED')
            self.assertEqual(result['runtimeBaseline'], observed)
            self.assertEqual(result['businessActions'], 0)
            fake_a.acquire_release_lock.assert_called_once()
            bound.assert_called_once()

    def test_real_adapted_readback_checks_new_files_and_releases_only_its_marker(self):
        c, plan = self.ready(), self.plan('readback')
        proof = self.proof(c, plan)
        parent = self.temporary_parent()
        with tempfile.TemporaryDirectory(prefix='protocol-control-test-', dir=parent) as name:
            base = Path(name)
            target = base / 'releases' / 'fixture'
            target.mkdir(parents=True)
            (base / 'current').symlink_to(target)
            previous = {role: {'fixture': role} for role in ('api', 'admin', 'online-recharge')}
            manifest = {'commit': plan['commit'], 'sourceTree': plan['tree'], 'scope': r.SCOPE,
                        'roleSourceProjections': {'api': {'parentProjection': previous['api']},
                            'admin': {'parentProjection': previous['admin']}, 'online-recharge': previous['online-recharge']}}
            (target / 'release-manifest.json').write_text(json.dumps(manifest))
            for source, expected in c['sources'].items():
                path = target / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((r.ROOT / source).read_bytes())
            for source in plan['controlSources']:
                path = target / 'scripts/production-release' / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((HERE / source).read_bytes())
            raw = json.dumps(proof).encode()
            plan['buildProofSha256'] = r.digest(raw)
            (target / (r.NAME + '-build-proof.json')).write_bytes(raw)
            receipt = {'after': {'api': {'fixture': 'api'}}, 'previousRoleProjections': previous,
                       'maintenance': {'ownerSha256': 'f' * 64, 'paths': []}}
            (target / (r.NAME + '-preservation.json')).write_text(json.dumps(receipt))
            old = r.helper('registration-parity-diagnostics-release.py')
            old.BASE = base
            real_helper = r.helper
            fake_a = types.SimpleNamespace(acquire_release_lock=Mock())
            finite = types.SimpleNamespace(release_markers=Mock())
            def selected(item):
                return {'registration-parity-diagnostics-release.py': old,
                        'recharge-availability-release.py': fake_a,
                        'proxy-result-identity-release.py': finite}.get(item) or real_helper(item)
            h = types.SimpleNamespace(snapshot=Mock(return_value=receipt['after']))
            smoke = Mock()
            with patch.object(r, 'helper', selected), patch.object(r, 'smoke', smoke):
                result = r.release(plan, c, d=object(), h=h)
            self.assertEqual(result['status'], r.SCOPE + '_INDEPENDENT_READBACK_VERIFIED')
            smoke.assert_called_once()
            finite.release_markers.assert_called_once_with(receipt['maintenance'])
            self.assertTrue((target / (r.NAME + '-readback.json')).is_file())

    def test_real_transport_constants_bind_new_workflow_contract_and_artifact(self):
        namespace = d.namespace()
        def strings(code):
            for item in code.co_consts:
                if isinstance(item, str):
                    yield item
                elif isinstance(item, types.CodeType):
                    yield from strings(item)
        value = '\n'.join(strings(namespace['prepare_plan'].__code__))
        self.assertIn('.github/workflows/registration-protocol-repair-validation.yml', value)
        self.assertIn(r.NAME + '-artifact.tar.gz', value)
        self.assertNotIn('registration-parity-diagnostics-', value)
        self.assertIs(namespace['need'], d.r.need)

    def test_prepared_candidate_sources_are_independently_bound(self):
        with tempfile.TemporaryDirectory(prefix='prepared-', dir=self.temporary_parent()) as name:
            output = Path(name)
            path = output / 'candidate/apps/fixture.txt'
            path.parent.mkdir(parents=True)
            path.write_text('approved')
            c = {'sources': {'apps/fixture.txt': r.digest(path.read_bytes())}, 'validationSources': {}, 'validationSupportSources': {}}
            with patch.object(b, 'OUT', output):
                b.verify_candidate_sources(c)
                path.write_text('changed after prepare')
                with self.assertRaisesRegex(RuntimeError, 'PREPARED_SOURCE_MOVED'):
                    b.verify_candidate_sources(c)

    def test_real_adapted_release_runs_backup_fence_switch_manifest_and_readback(self):
        c, plan = self.ready(), self.plan('release')
        observed = {'database': c['baseline']['mysql'], 'sqlite': c['baseline']['sqlite']}
        plan['runtimeBaseline'] = observed
        plan['artifactUrl'] = ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                               + r.NAME + '-' + plan['commit'] + '/' + r.NAME + '-artifact.tar.gz')
        archive_bytes = b'closed synthetic artifact'
        plan['artifactSha256'] = r.digest(archive_bytes)
        with tempfile.TemporaryDirectory(prefix='release-', dir=self.temporary_parent()) as name:
            base = Path(name)
            (base / '.staging').mkdir()
            previous = base / 'releases/previous'
            previous.mkdir(parents=True)
            (base / 'current').symlink_to(previous)
            before = copy.deepcopy(c['baseline']['services'])
            after = copy.deepcopy(before)
            image_ids = {'api': 'sha256:' + '7' * 64, 'admin': 'sha256:' + '8' * 64}
            for role in image_ids:
                after[role]['image'] = image_ids[role]
            projections = {role: {'commit': c['roleSourceCommits'][role]} for role in c['roleSourceCommits']}
            manifest = {'commit': c['expectedCurrent'], 'roleSourceProjections': projections,
                        'images': {role: {'reference': state['reference'], 'digest': state['image']} for role, state in before.items()}}
            raw_manifest = json.dumps(manifest).encode()
            (previous / 'release-manifest.json').write_bytes(raw_manifest)
            (previous / 'compose.release.json').write_text(json.dumps({'services': {role: {'image': state['reference']} for role, state in before.items()}}))
            safety = previous / r.WORKER / 'release_safety.py'
            safety.parent.mkdir(parents=True)
            safety.write_bytes(subprocess.check_output(['git', 'show', b.C8 + ':' + r.WORKER + 'release_safety.py'], cwd=r.ROOT))
            payload = base / 'payload'
            for source in c['sources']:
                path = payload / 'source' / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((r.ROOT / source).read_bytes())
            for source in c['workerFiles']:
                path = payload / 'api/worker' / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((r.ROOT / r.WORKER / source).read_bytes())
            (payload / 'api/modules').mkdir(parents=True)
            index = payload / 'admin/html/index.html'
            index.parent.mkdir(parents=True)
            index.write_text('fixture management page')
            proof = self.proof(c, plan)
            proof['adminFiles'] = {'index.html': r.digest(index.read_bytes())}
            real_h = r.helper('recharge-record-release.py')
            proof['files'] = real_h.file_inventory(payload)
            raw_proof = json.dumps(proof).encode()
            (payload / 'build-proof.json').write_bytes(raw_proof)
            plan['buildProofSha256'] = r.digest(raw_proof)
            events = []
            driver = types.SimpleNamespace()
            def inspect(*args, **kwargs):
                self.assertEqual(args[:3], ('docker', 'image', 'inspect'))
                value = args[3]
                role = 'api' if value in (before['api']['image'],) or value.endswith('-api') else 'admin'
                return json.dumps([{'Id': image_ids[role] if value.endswith(('-api', '-admin')) else before[role]['image']}])
            driver.run = inspect
            driver.assert_no_active_recharge = Mock(side_effect=lambda _: events.append('recharge-idle'))
            driver.assert_no_active_registration = Mock(side_effect=lambda _: events.append('registration-idle'))
            driver.compose = Mock(side_effect=lambda *a, **kw: events.append('compose-' + '-'.join(str(v) for v in a[1:])))
            driver.wait_healthy = Mock(side_effect=lambda _, role: events.append('healthy-' + role))
            def point(target, stamp):
                events.append('point-current')
                (base / 'current').unlink()
                (base / 'current').symlink_to(target)
            driver.point_current = point
            def build_image(*args):
                events.append('build-' + args[3])
                after[args[3]]['reference'] = args[2]
            h = types.SimpleNamespace(file_inventory=real_h.file_inventory,
                base_image_reference=lambda _, state: state['reference'], build_image=build_image,
                engine_idle=Mock(side_effect=lambda *a, **kw: events.append('engine-idle')),
                fresh_scoped_backup=Mock(side_effect=lambda *a, **kw: events.append('mysql-backup') or {'s3Verified': True}),
                snapshot=Mock(return_value=after))
            a = types.SimpleNamespace(acquire_release_lock=Mock(), normalize_image_context=Mock(),
                write_release_override=lambda path, value: path.write_text(json.dumps(value)))
            markers = {}
            def claim(*args):
                events.append('claim-markers')
                paths = [base / 'maintenance.json', base / 'registration-maintenance.json']
                for path in paths:
                    path.write_text('owned marker')
                markers.update(paths=[str(p) for p in paths], ownerSha256=r.digest(b'owned marker'))
                return markers.copy()
            class Fence:
                def __init__(self, *args): pass
                def acquire(self): events.append('fence-acquire')
                def check_idle(self): events.append('fence-idle')
                def stop(self, state, grace): events.append('stop-api' if state == before['api'] else 'stop-sidecar')
                def close(self): events.append('fence-close')
            actual_finite = r.helper('proxy-result-identity-release.py')
            finite = types.SimpleNamespace(claim_markers=claim, verify_markers=actual_finite.verify_markers,
                release_markers=actual_finite.release_markers, sql_fence_class=lambda _: Fence,
                verify_overlay_image=Mock())
            old = r.helper('registration-parity-diagnostics-release.py')
            old.BASE = base
            old.archive = lambda *a: payload
            def fake_sqlite_backup(*args):
                return {'s3Verified': True, 'logical': args[-1]['baseline']['sqlite']}
            old.backup_sqlite = fake_sqlite_backup
            real_helper = r.helper
            def selected(item):
                return {'registration-parity-diagnostics-release.py': old,
                        'recharge-availability-release.py': a, 'proxy-result-identity-release.py': finite,
                        'recharge-record-release.py': real_h}.get(item) or real_helper(item)
            bound = Mock(return_value=(previous, raw_manifest, before, observed))
            smoke = Mock(side_effect=lambda *a: events.append('smoke'))
            with patch.object(r, 'helper', selected), patch.object(r, 'baseline', bound), \
                    patch.object(r, 'inherited_host_source', return_value=previous), \
                    patch.object(r, 'sqlite_receipt', return_value=c['baseline']['sqlite']), \
                    patch.object(r, 'smoke', smoke), \
                    patch.object(r.urllib.request, 'urlopen', side_effect=lambda *a, **kw: io.BytesIO(archive_bytes)):
                result = r.release(plan, c, driver, h)
                target = (base / 'current').resolve()
                published = json.loads((target / 'release-manifest.json').read_bytes())
                self.assertEqual(result['status'], r.SCOPE + '_DEPLOYED')
                self.assertEqual(published['scope'], r.SCOPE)
                self.assertEqual(published['servicesUpdated'], ['api', 'admin'])
                self.assertEqual(published['servicesRebound'], ['online-recharge'])
                self.assertEqual(published['roleSourceProjections']['online-recharge'], projections['online-recharge'])
                self.assertEqual(published['roleSourceProjections']['api']['parentProjection'], projections['api'])
                self.assertEqual(published['newMigrations'], [])
                self.assertFalse(published['migrationPerformed'])
                self.assertLess(events.index('mysql-backup'), events.index('fence-acquire'))
                self.assertLess(events.index('stop-api'), events.index('stop-sidecar'))
                self.assertLess(events.index('smoke'), events.index('point-current'))
                self.assertTrue(all(Path(path).exists() for path in markers['paths']))
                self.assertEqual(finite.SCOPE, r.SCOPE)
                readback = r.release({**plan, 'mode': 'readback'}, c, driver, h)
                self.assertEqual(readback['status'], r.SCOPE + '_INDEPENDENT_READBACK_VERIFIED')
                self.assertTrue(all(not Path(path).exists() for path in markers['paths']))


if __name__ == '__main__':
    unittest.main()
