"""Pure local checks for the disabled96 foundation; no actual proof is invented."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import base64
import os
import tempfile

MODULE = Path(__file__).with_name('registration-onboarding-96.py')
ADAPTER_TEST_OUTPUT = MODULE.resolve().parents[2] / '.runtime/registration-runtime96-20261008/adapter-tests'
spec = importlib.util.spec_from_file_location('disabled_registration96', MODULE)
scope = importlib.util.module_from_spec(spec); spec.loader.exec_module(scope)


class DisabledRegistration96Tests(unittest.TestCase):
    def rejected(self, reason, function, *args, **kwargs):
        with self.assertRaises(scope.Registration96Error) as failure:
            function(*args, **kwargs)
        self.assertEqual(str(failure.exception), reason)

    def handoff(self):
        return {'receiptSha256': 'a' * 64, 'taskId': scope.TASK_ID, 'attempt': 9,
            'registered': True, 'passwordLoginVerified': False, 'mfaLoginVerified': False,
            'windowExists': False, 'leaseActive': False, 'busy': False}

    def sources(self):
        return {'runtimeCommit': 'a' * 40, 'candidateCommit': 'b' * 40,
            'registrationImageRevision': 'c' * 40, 'baselineReceiptSha256': 'd' * 64,
            'registrationProjectionSha256': 'e' * 64, 'rechargeProjectionSha256': 'f' * 64}

    def workers(self):
        names = sorted(scope.SOURCE_PAIR) + [scope.WORKER_PREFIX + 'fixture_%02d.py' % i for i in range(58)]
        sealed = {name: {'mode': '100644', 'sha256': hashlib.sha256(name.encode()).hexdigest()} for name in names}
        actual = {name.removeprefix(scope.WORKER_PREFIX): row['sha256'] for name, row in sealed.items()}
        pair = {name: (('candidate ' + name).encode(), '100644') for name in scope.SOURCE_PAIR}
        return actual, sealed, pair

    def test_default_module_cli_and_ssm_are_disabled(self):
        self.assertIs(scope.ENABLED, False)
        self.rejected('REGISTRATION96_DISABLED', scope.ssm_parameters)
        with patch.object(scope, 'ENABLED', True):
            self.rejected('REGISTRATION96_DISABLED', scope.assert_enabled)
        stream = io.StringIO()
        with redirect_stdout(stream):
            self.assertEqual(scope.main(['--registration-worker-96', '--enable', 'synthetic-private']), 2)
        self.assertEqual(json.loads(stream.getvalue()), {'status': 'REGISTRATION96_DISABLED',
            'enabled': False, 'productionOperations': 0, 'parametersGenerated': False})
        self.assertNotIn('synthetic-private', stream.getvalue())

    def test_only_stdlib_adapter_and_no_dynamic_historical_execution(self):
        tree = ast.parse(MODULE.read_bytes())
        imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        imports |= {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertEqual(imports, {'hashlib', 'json', 're', 'sys', 'base64', 'os', 'stat', 'time',
            'fcntl', 'subprocess', 'pathlib', 'datetime', 'gzip', 'zlib'})
        forbidden = {'exec', 'eval', 'compile', '__import__', 'Popen', 'check_output', 'urlopen'}
        calls = {node.func.id if isinstance(node.func, ast.Name) else node.func.attr
            for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, (ast.Name, ast.Attribute))}
        self.assertFalse(calls & forbidden)

    def test_missing_baseline_rejected_before_any_schema_claim(self):
        self.rejected('BASELINE_MISSING', scope.validate_baseline, None)

    def test_baseline_unknown_fields_and_planning_document_rejected(self):
        self.rejected('BASELINE_FIELDS_INVALID', scope.validate_baseline, b'{"enabled":false,"status":"PLAN"}')
        value = dict.fromkeys(scope.BASELINE_KEYS)
        value['unexpected'] = 'synthetic-private'
        self.rejected('BASELINE_FIELDS_INVALID', scope.validate_baseline, json.dumps(value).encode())

    def test_draft_envelope_never_authenticates_unfrozen_nested_schema(self):
        value = dict.fromkeys(scope.BASELINE_KEYS)
        value.update(version=1, status='FINITE_POSTPRO_OBSERVED', readOnly=True,
            windowRestarted=False, runtimeStable=True, historicalChainReexecuted=False, databaseWrites=0)
        value['liveServices'] = {'unreviewed': 'synthetic-private'}
        self.rejected('BASELINE_SCHEMA_UNFROZEN', scope.validate_baseline, json.dumps(value).encode())
        value['databaseWrites'] = False
        self.rejected('BASELINE_SAFETY_INVALID', scope.validate_baseline, json.dumps(value).encode())

    def test_closed_json_rejects_duplicate_nonfinite_and_oversize(self):
        for raw in [b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'[1]', b'\xff']:
            with self.subTest(raw=raw): self.rejected('JSON_INVALID', scope.closed_json, raw)
        self.rejected('BYTES_INVALID', scope.closed_json, b'{}', limit=1)
        self.rejected('BYTES_INVALID', scope.closed_json, b'{}', limit=True)

    def test_carrier_and_module_limits_include_final_whole_source(self):
        self.assertEqual(scope.carrier_bytes(b'a' * 1048576), b'a' * 1048576)
        self.rejected('BYTES_INVALID', scope.carrier_bytes, b'a' * 1048577)
        for function in [scope.module_bytes, scope.profile_bytes]:
            self.rejected('BYTES_INVALID', function, b'a' * (128 * 1024 + 1))

    def test_new_handoff_keeps_registered_facts_and_requires_typed_idle(self):
        value = self.handoff(); self.assertEqual(scope.check_handoff(value), value)
        for name in ['windowExists', 'leaseActive', 'busy']:
            changed = dict(value); changed[name] = True
            self.rejected('HANDOFF_NOT_IDLE', scope.check_handoff, changed)
            changed[name] = 0
            self.rejected('HANDOFF_NOT_IDLE', scope.check_handoff, changed)

    def test_historical_attempt8_or_old_receipt_cannot_close_attempt9(self):
        value = self.handoff(); value['attempt'] = 8
        self.rejected('HANDOFF_NOT_CURRENT', scope.check_handoff, value)
        value = self.handoff(); value['receiptSha256'] = scope.OLD_HANDOFF_SHA256
        self.rejected('HANDOFF_NOT_CURRENT', scope.check_handoff, value)
        value = self.handoff(); value['attempt'] = True
        self.rejected('HANDOFF_NOT_CURRENT', scope.check_handoff, value)
        value = self.handoff(); value['extra'] = None
        self.rejected('HANDOFF_FIELDS_INVALID', scope.check_handoff, value)

    def test_candidate_runtime_and_two_workers_keep_distinct_bound_sources(self):
        value = self.sources(); self.assertEqual(scope.check_source_roles(value, dict(value)), value)
        swapped = dict(value)
        swapped['registrationProjectionSha256'], swapped['rechargeProjectionSha256'] = (
            swapped['rechargeProjectionSha256'], swapped['registrationProjectionSha256'])
        self.rejected('SOURCE_BINDINGS_CHANGED', scope.check_source_roles, swapped, value)
        changed = dict(value); changed['candidateCommit'] = changed['runtimeCommit']
        self.rejected('SOURCE_ROLES_CONFUSED', scope.check_source_roles, changed, dict(changed))
        changed = dict(value); changed['rechargeProjectionSha256'] = changed['registrationProjectionSha256']
        self.rejected('SOURCE_ROLES_CONFUSED', scope.check_source_roles, changed, dict(changed))

    def test_actual95_full60_is_checked_before_exact_browser_pair_delta(self):
        actual, sealed, pair = self.workers()
        original = copy.deepcopy(sealed)
        result = scope.worker_delta(actual, sealed, pair)
        self.assertEqual(sealed, original)
        self.assertEqual({name for name in sealed if result[name] != sealed[name]}, scope.SOURCE_PAIR)
        self.assertEqual(len(result), 60)

    def test_expected_pro_projection_missing_or_truncated_worker_not_actual95(self):
        actual, sealed, pair = self.workers()
        self.rejected('WORKER_INPUT_INVALID', scope.worker_delta, None, sealed, pair)
        changed = dict(actual); changed['fixture_00.py'] = '0' * 64
        self.rejected('WORKER_ACTUAL95_MISMATCH', scope.worker_delta, changed, sealed, pair)
        changed = dict(actual); changed.pop('fixture_00.py')
        self.rejected('WORKER_ACTUAL95_MISMATCH', scope.worker_delta, changed, sealed, pair)
        changed = dict(actual); changed['unknown.py'] = '0' * 64
        self.rejected('WORKER_ACTUAL95_MISMATCH', scope.worker_delta, changed, sealed, pair)

    def test_other_worker_file_missing_pair_or_changed_modes_rejected(self):
        actual, sealed, pair = self.workers()
        changed = dict(pair); changed[scope.WORKER_PREFIX + 'plan_selection.py'] = (b'new Pro', '100644')
        self.rejected('WORKER_INPUT_INVALID', scope.worker_delta, actual, sealed, changed)
        changed = dict(pair); changed.pop(next(iter(scope.SOURCE_PAIR)))
        self.rejected('WORKER_INPUT_INVALID', scope.worker_delta, actual, sealed, changed)
        changed = dict(pair); name = next(iter(scope.SOURCE_PAIR)); changed[name] = (b'new', '100755')
        self.rejected('WORKER_PAIR_INVALID', scope.worker_delta, actual, sealed, changed)
        changed = dict(pair); changed[name] = (name.encode(), '100644')
        self.rejected('WORKER_DELTA_INVALID', scope.worker_delta, actual, sealed, changed)
        broken = copy.deepcopy(sealed); broken[name]['unexpected'] = 'synthetic-private'
        self.rejected('WORKER_SEAL_INVALID', scope.worker_delta, actual, broken, pair)
        broken = copy.deepcopy(sealed); broken[name]['mode'] = []
        self.rejected('WORKER_SEAL_INVALID', scope.worker_delta, actual, broken, pair)


def encoded(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True).encode()


def fixture():
    """All runtime/finance/publication receipts here are SYNTHETIC, never actual.

    Only the already committed R3d browser pair is real local code, so fixtures
    cannot accidentally permit arbitrary unreviewed registration code.
    """
    h = lambda name: hashlib.sha256(('SYNTHETIC ' + name).encode()).hexdigest()
    names = sorted(scope.SOURCE_PAIR) + sorted(scope.CARRIED_SOURCE_COMMITS) + [scope.WORKER_PREFIX + 'fixture_%02d.py' % i for i in range(51)]
    basis = {n: (('SYNTHETIC SEALED95 ' + n).encode(), '100644') for n in names}
    sealed = {n: {'mode': row[1], 'sha256': hashlib.sha256(row[0]).hexdigest()} for n, row in basis.items()}
    reg = {n.removeprefix(scope.WORKER_PREFIX): row['sha256'] for n, row in sealed.items()}
    pro_projection = copy.deepcopy(sealed)
    changed = scope.WORKER_PREFIX + 'fixture_00.py'
    pro_data = b'SYNTHETIC NEW PRO SOURCE'
    pro_projection[changed]['sha256'] = hashlib.sha256(pro_data).hexdigest()
    states = {s: {'containerId': h(s + ' cid'), 'image': 'sha256:' + h(s + ' image'),
        'reference': 'synthetic/' + s, 'status': 'running', 'health': None if s == 'caddy' else 'healthy',
        'startedAtSha256': h(s + ' start'), 'environmentSha256': h(s + ' env'), 'configurationSha256': h(s + ' configuration')}
        for s in scope.SERVICES}
    public = dict(basis)
    old_controls = scope.CONTROL_FILES - {'scripts/production-release/registration-onboarding-96.py', 'scripts/production-release/registration-onboarding-96.test.py'}
    public.update({n: (('SYNTHETIC OLD CONTROL ' + n).encode(), '100755' if n.endswith('.sh') else '100644') for n in old_controls})
    public['docker-compose.aws-mysql.yml'] = (b'SYNTHETIC compose unchanged', '100644')
    public['scripts/v2-registration-finance-audit.mjs'] = (b'SYNTHETIC retained auditor', '100644')
    for n in scope.PUBLIC_BASE:
        if n not in public: public[n] = (('SYNTHETIC PUBLIC BASE ' + n).encode(), '100644')
    old_public = scope.source_map(public)
    old_files = {n: row[0] for n, row in old_public.items()}
    old_files.update({n: h('private ' + n) for n in scope.PRIVATE_FILES})
    identity = {'currentUser': 'id_business_audit@synthetic', 'databaseName': 'id_business_v2', 'transactionIsolation': 'REPEATABLE-READ',
        'foreignKeyChecks': 1, 'readOnly': 0, 'superReadOnly': 0, 'sessionReadOnly': 1}
    checks = {'check_%02d' % i: {'ok': True, 'violationCount': 0} for i in range(49)}
    clearance = {'mode': 'STRICT_ZERO_AFTER_APPROVED_REVERSALS_49', 'checksSha256': scope.canonical_sha256(checks)}
    gate_base = {'stage': 'before', 'status': clearance['mode'], 'accepted': True, 'checkCount': 49, 'executedCheckCount': 49,
        'unavailableCheckCount': 0, 'violationCount': 0, 'scope': {'targetOrdersCount': 0, 'protectedThirdOrderCount': 1}}
    gate_base.update(releaseSealSha256=h('seal'), candidateCommit='a' * 40, candidateTree='b' * 40, sourceTree='c' * 40,
        images={'api': 'sha256:' + h('api image')}, migration={'applied': False}, preparedImagesSha256=h('prepared images'),
        preparationRunId=1, preparationRunAttempt=1)
    reports = {}
    for stage in ('before', 'after'):
        gate = copy.deepcopy(gate_base); gate['stage'] = stage
        reports[stage] = {'ok': True, 'checkCount': 49, 'violationCount': 0, 'failedChecks': [], 'identity': copy.deepcopy(identity),
            'checks': copy.deepcopy(checks), 'gate': gate, 'generatedAt': '2026-10-08T00:00:00.000Z'}
    summaries = {s: {'checkCount': 49, 'violationCount': 0, 'registrationFinanceGate': r['gate']} for s, r in reports.items()}
    manifest = dict.fromkeys(scope.MANIFEST_KEYS - {'fixedRechargeRelease', 'fixedRechargePreservedStates'})
    images = {s: {'reference': states[s]['reference'], 'digest': states[s]['image'], 'sourceCommit': scope.PREVIOUS_COMMIT}
        for s in ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin')}
    images['migrate'] = {'reference': 'synthetic/migrate', 'digest': 'sha256:' + h('migrate'), 'sourceCommit': '8' * 40}
    manifest.update(commit=scope.PREVIOUS_COMMIT, sourceTree='9' * 40, sourceBranch='main', previousCommit='4' * 40,
        previousRelease='/opt/id-business-v2/releases/20261007T180000Z-444444444444', previousManifestSha256=h('inherited older4c manifest'),
        deploymentRun='github-actions-1-1', imageBuildRun='github-actions-1-1', ciWorkflow='Quality Gate', ciWorkflowRunId=1,
        servicesUpdated=['auto-registration'], migrationApplied=False, newMigrations=[], databaseGrants={'status': 'SKIPPED', 'reason': 'FIXED_REGISTRATION_NO_MIGRATIONS'},
        images=images, fixedRegistrationRelease={'id': 'registration-worker-95-20261008', 'registered': True},
        fixedRegistrationPreservedStates={'before': {}, 'after': {}}, sourceArchiveSha256=h('95 archive'),
        dataAuditBefore=summaries['before'], dataAuditAfter=summaries['after'])
    content = {s: {'fileCount': 25, 'sha256': h(s + ' content')} for s in ('api', 'admin')}
    api_proof = {'revision': '815fae391b172d6c368ea2ad25225f52a1272808', 'sourceTree': '3a814394a45ff3422907501ff22d5d994eed3545',
        'buildProof': {'version': 1, 'commit': '815fae391b172d6c368ea2ad25225f52a1272808', 'sourceTree': '3a814394a45ff3422907501ff22d5d994eed3545',
            'images': {s: {**row, 'imageId': states[s]['image'], 'reference': states[s]['reference']} for s, row in content.items()}}}
    api_proof['buildProofCanonicalSha256'] = scope.canonical_sha256(api_proof['buildProof'])
    compiled = {'apps/api/dist/id-business-v2/auto-registration/' + n: h(n) for n in (
        'registration-events.service.js', 'registration-jobs.service.js', 'registration-validation.js', 'registration-worker.js')}
    old = {'status': 'VERIFIED_95_RUNTIME_BASELINE', 'readOnly': True, 'runtimeStable': True, 'databaseWrites': 0,
        'windowRestarted': False, 'current': scope.PREVIOUS_DIRECTORY, 'manifest': manifest, 'fileSha256': old_files,
        'profileSha256': h('95 profile'), 'publicSourceMap': {'fileCount': len(old_public), 'sha256': scope.canonical_sha256(old_public, ascii=False)},
        'liveServices': copy.deepcopy(states), 'actualRegistrationWorkerSourceSha256': reg,
        'actualApiCompiledSourceSha256': compiled, 'apiRuntimeProof': api_proof,
        'audits': {s: {'identitySha256': scope.canonical_sha256(identity)} for s in ('before', 'after')}}
    p = {'current': '/opt/id-business-v2/releases/20261008T000000Z-' + scope.CURRENT_COMMIT[:12], 'commit': scope.CURRENT_COMMIT,
        'tree': scope.CURRENT_TREE, 'run': 'github-actions-2-1', 'controllerSha256': old_files['scripts/production-release/remote-deploy.py']}
    native = {n: h(n) for n in ('apiBuildProofRawSha256', 'apiStateRawSha256', 'apiReadbackSha256',
        'registrationProfileCanonicalSha256', 'registrationReadbackSha256', 'nativeChainSha256')}
    native.update(apiBuildProofCanonicalSha256=api_proof['buildProofCanonicalSha256'], registrationProfileRawSha256=old['profileSha256'])
    retained = {s: {k: v for k, v in row.items() if k != 'configurationSha256'} for s, row in states.items() if s != 'auto-recharge'}
    native['preservedStatesSha256'] = scope.canonical_sha256(retained)
    pro = {'id': 'recharge-pro-6f5-20261008', 'enabled': True, 'approvalStatus': 'APPROVED', 'expectedCurrent': scope.PREVIOUS_COMMIT,
        'scope': {'servicesUpdated': ['auto-recharge'], 'registrationRestartAllowed': False}, 'baselineRelease': {'manifestSha256': old_files['release-manifest.json']},
        'nativeBaseline': native, 'financeClearance': clearance, 'financeValidator': {'kind': 'SYNTHETIC_APPROVED_49'}, 'workerProjection': pro_projection,
        'candidateSourceSha256': {changed: hashlib.sha256(pro_data).hexdigest()}, 'controlSourceSha256': {'scripts/production-release/remote-deploy.py': p['controllerSha256']}}
    task_binding = {'taskId': scope.TASK_ID, 'attempt': 9, 'sinceUtc': '2026-10-07T21:06:54.079Z',
        'acceptedAt': '2026-10-07T21:07:06.938Z', 'profileBoundAt': '2026-10-07T21:07:39.179Z',
        'profileSha256': h('profile bind'), 'accountSha256': h('account bind')}
    handoff = {'receiptSha256': h('new9 handoff'), 'taskId': scope.TASK_ID, 'attempt': 9, 'registered': True,
        'passwordLoginVerified': False, 'mfaLoginVerified': False, 'windowExists': False, 'leaseActive': False, 'busy': False}
    candidate = {n: (MODULE.parents[2].joinpath(n).read_bytes(), '100644') for n in scope.SOURCE_PAIR}
    candidate.update({n: (('SYNTHETIC FINAL CONTROL ' + n).encode(), '100755' if n.endswith('.sh') else '100644') for n in scope.CONTROL_FILES})
    finance = {'releaseSealSha256': h('seal'), 'candidateCommit': 'a' * 40, 'candidateTree': 'b' * 40, 'sourceTree': 'c' * 40,
        'images': {'api': 'sha256:' + h('api image')}, 'migration': {'applied': False}, 'preparedImagesSha256': h('prepared images'),
        'preparationRunId': 1, 'preparationRunAttempt': 1}
    for n in ('.dockerignore', 'scripts/audit-python-dependencies.py'): basis[n] = (('SYNTHETIC build input ' + n).encode(), '100644')
    context = {'version': 1, 'schemaSha256': h('schema'), 'baselineCarrierSha256': h('SYNTHETIC fourth carrier'),
        'baselineRawSha256': h('pending record'), 'baselineCanonicalSha256': h('pending canonical'),
        'formalProducerEvidenceSha256': h('SYNTHETIC producer never actual'), 'parameters': p, 'baseline95': old,
        'baseline95CanonicalSha256': scope.canonical_sha256(old, ascii=False), 'proProfile': pro,
        'proProfileRawSha256': h('pro profile raw'), 'proProfileCanonicalSha256': scope.canonical_sha256(pro),
        'sealed95WorkerProjection': sealed, 'taskBinding': task_binding, 'handoff': handoff,
        'registrationSourceCommit': scope.REGISTRATION_SOURCE_COMMIT, 'registrationSourceSha256': scope.REGISTRATION_SOURCE_SHA256,
        'buildInputSha256': {n: hashlib.sha256(basis[n][0]).hexdigest() for n in ('.dockerignore', 'scripts/audit-python-dependencies.py')},
        'candidate': {'commit': 'e' * 40, 'tree': 'f' * 40, 'run': 'github-actions-3-1', 'ciRunId': 3, 'archiveSha256': h('candidate archive')},
        'controlSourceSha256': {n: hashlib.sha256(candidate[n][0]).hexdigest() for n in scope.CONTROL_FILES},
        'sourceModes': {n: candidate[n][1] for n in scope.CONTROL_FILES}, 'financeFrozen': finance}
    candidate[scope.BASELINE_CARRIER_FILE] = (b'SYNTHETIC fourth carrier', '100644')
    context['baselineCarrierSha256'] = hashlib.sha256(candidate[scope.BASELINE_CARRIER_FILE][0]).hexdigest()
    public[changed] = (pro_data, '100644')
    profile_name = 'deploy/aws/' + pro['id'] + '.json'
    public[profile_name] = (b'SYNTHETIC actual045 pro profile', '100644')
    context['proProfileRawSha256'] = hashlib.sha256(public[profile_name][0]).hexdigest()
    m = copy.deepcopy(manifest)
    m.update(commit=p['commit'], sourceTree=p['tree'], previousCommit=scope.PREVIOUS_COMMIT, previousRelease=old['current'],
        deploymentRun=p['run'], imageBuildRun=p['run'], servicesUpdated=['auto-recharge'], databaseGrants={'status': 'SKIPPED', 'reason': 'FIXED_RECHARGE_NO_MIGRATIONS'})
    ref = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + p['commit'] + '-2-1-auto-recharge'
    m['images']['auto-recharge'] = {'reference': ref, 'digest': 'sha256:' + h('new Pro image'), 'sourceCommit': p['commit']}
    states['auto-recharge'].update(containerId=h('new Pro cid'), image=m['images']['auto-recharge']['digest'], reference=ref,
        startedAtSha256=h('new Pro start'), configurationSha256=h('new Pro configuration'))
    m['fixedRechargePreservedStates'] = {'before': retained, 'after': retained}
    m['fixedRechargeRelease'] = scope.expected_pro_context(context, summaries)
    selected = scope.PUBLIC_BASE | set(pro['candidateSourceSha256']) | set(pro['controlSourceSha256']) | {profile_name}
    files = {d + '/' + n: old_files.get(n, h('selected ' + n)) for d in (p['current'], old['current']) for n in scope.PRIVATE_FILES | selected
        if not (d == old['current'] and n == profile_name or d == p['current'] and n == scope.AUDIT_OVERRIDE)}
    for n, digest in {**pro['candidateSourceSha256'], **pro['controlSourceSha256']}.items(): files[p['current'] + '/' + n] = digest
    files[p['current'] + '/' + profile_name] = context['proProfileRawSha256']
    manifest_raw_sha = scope.private_json_sha256(m); files[p['current'] + '/release-manifest.json'] = manifest_raw_sha
    audits = {s: {'rawSha256': files[p['current'] + '/' + s + '-audit.json'], 'checkCount': 49, 'violationCount': 0,
        'checksSha256': clearance['checksSha256'], 'identitySha256': scope.canonical_sha256(identity), 'gateSha256': scope.canonical_sha256(reports[s]['gate'])} for s in reports}
    task = {'task': {'id': scope.TASK_ID, 'attempt': 9, 'state': 'partial', 'step': 'password', 'reason': 'session_load_timeout',
        'registered': True, 'passwordVerified': False, 'mfaVerified': False, 'updatedAt': '2026-10-08T00:00:00.000Z',
        'leaseUntil': None, 'windowBound': True, 'accountBound': True},
        'account': {'rowCount': 1, 'registered': True, 'encryptedPasswordPresent': False, 'encryptedMfaPresent': False},
        'binding': {n: task_binding[n] for n in ('profileSha256', 'accountSha256', 'acceptedAt', 'profileBoundAt')},
        'codeRead': {'action': 'code_read', 'sinceUtc': task_binding['sinceUtc'], 'count': 0, 'firstAt': None, 'latestAt': None,
            'steps': [], 'truncated': False, 'provesOfficialAcceptance': False}, 'snapshotStable': True, 'officialOtpAccepted': 'NOT_MEASURED'}
    health = {'ready': True, 'registrationBusy': False, 'registrationWindowRetained': False, 'workerRole': 'registration', 'engine': 'camoufox', 'mailDeliveryVersion': 1}
    public_map = scope.source_map(public)
    record = {'version': 1, 'status': 'FINITE_POSTPRO_OBSERVED', 'readOnly': True, 'databaseWrites': 0, 'windowRestarted': False,
        'runtimeStable': True, 'current': p['current'], 'commit': p['commit'], 'sourceTree': p['tree'], 'deploymentRun': p['run'],
        'formalProducerEvidenceSha256': context['formalProducerEvidenceSha256'], 'controllerSha256': p['controllerSha256'],
        'profileRawSha256': context['proProfileRawSha256'], 'profileCanonicalSha256': context['proProfileCanonicalSha256'],
        'manifest': m, 'manifestRawSha256': manifest_raw_sha, 'manifestCanonicalSha256': scope.canonical_sha256(m),
        'fileSha256': files, 'publicSourceMap': {'previous': old['publicSourceMap'], 'current': {'fileCount': len(public_map), 'sha256': scope.canonical_sha256(public_map, ascii=False)}},
        'liveServices': states, 'actualRegistrationWorkerSourceSha256': reg,
        'actualRechargeWorkerSourceSha256': {n.removeprefix(scope.WORKER_PREFIX): row['sha256'] for n, row in pro_projection.items()},
        'actualApiCompiledSourceSha256': compiled, 'apiAdminContentProof': content, 'audits': audits, 'workerHealth': health,
        'taskReadOnly': task, 'officialOtpAccepted': 'NOT_MEASURED', 'businessAcceptanceConfirmed': False, 'historicalChainReexecuted': False}
    raw = encoded(record); context['baselineRawSha256'] = hashlib.sha256(raw).hexdigest(); context['baselineCanonicalSha256'] = scope.canonical_sha256(record)
    carried = {'files': {n: basis[n] for n in scope.CARRIED_SOURCE_COMMITS}, 'sourceCommits': dict(scope.CARRIED_SOURCE_COMMITS)}
    for n in scope.CARRIED_SOURCE_COMMITS: basis[n] = (('SYNTHETIC ORIGINAL2F ' + n).encode(), '100644')
    return {'context': context, 'record': record, 'raw': raw, 'basis': basis, 'carried': carried, 'candidate': candidate, 'public': public, 'reports': reports}


def deployment_fixture(f=None):
    f = fixture() if f is None else f; context, record = f['context'], f['record']
    worker, projection = scope.build_projection(f['basis'], f['candidate'], context, record, carried=f['carried'])
    profile = scope.profile_contract(context, record, projection, enabled=True); profile_raw = f.get('profile_raw', encoded(profile))
    runtime = scope.runtime_projection(f['public'], f['candidate'], profile_raw, context, record, projection)
    release = '/opt/id-business-v2/releases/20261008T010000Z-' + context['candidate']['commit'][:12]
    image = {'image': 'sha256:' + '7' * 64, 'reference': scope.image_reference(context), 'architecture': 'amd64',
        'revision': context['candidate']['commit'], 'workerProjectionSha256': scope.canonical_sha256(projection)}
    running = {n: copy.deepcopy(record[n]) for n in ('liveServices', 'actualRechargeWorkerSourceSha256',
        'actualApiCompiledSourceSha256', 'apiAdminContentProof', 'workerHealth')}
    running['liveServices']['auto-registration'].update(containerId='8' * 64, startedAtSha256='9' * 64,
        configurationSha256='a' * 64, image=image['image'], reference=image['reference'])
    running['actualRegistrationWorkerSourceSha256'] = {n.removeprefix(scope.WORKER_PREFIX): row['sha256'] for n, row in projection.items()}
    backup = {'name': 'id-business-v2-20261008T005900.sql.gz', 'sha256': 'b' * 64, 'size': 100, 's3Verified': True}
    deployed_at = '2026-10-08T01:00:00.000Z'
    manifest = scope.manifest_contract(context, record, profile_raw, projection, image, running,
        f['reports']['before'], f['reports']['after'], backup, release, deployed_at)
    configuration = {'environmentFileSha256': record['fileSha256'][record['current'] + '/.env.aws.production'],
        'composeFileSha256': record['fileSha256'][record['current'] + '/docker-compose.aws-mysql.yml'],
        'overrideCanonicalSha256': scope.canonical_sha256({'services': {n: {'image': manifest['images'][n]['reference'], 'pull_policy': 'never'}
            for n in ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin', 'migrate')}})}
    map_ = scope.source_map(runtime)
    files = {release + '/' + n: map_[n][0] for n in scope.readback_public_files(context)}
    files.update({release + '/' + n: record['fileSha256'][(context['baseline95']['current'] if n == scope.AUDIT_OVERRIDE else record['current']) + '/' + n] for n in scope.PRIVATE_FILES})
    files[release + '/release-manifest.json'] = scope.private_json_sha256(manifest)
    files[release + '/backup-verification.json'] = scope.private_json_sha256(backup)
    files[release + '/compose.release.json'] = scope.private_json_sha256({'services': {n: {'image': manifest['images'][n]['reference'], 'pull_policy': 'never'}
        for n in ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin', 'migrate')}})
    for s in f['reports']: files[release + '/' + s + '-audit.json'] = scope.private_json_sha256(f['reports'][s])
    readback = {'version': 1, 'status': 'VERIFIED_REGISTRATION96_RUNTIME', 'readOnly': True, 'runtimeStable': True,
        'current': release, 'previous': record['current'], 'commit': context['candidate']['commit'], 'sourceTree': context['candidate']['tree'],
        'deploymentRun': context['candidate']['run'], 'profileRawSha256': hashlib.sha256(profile_raw).hexdigest(),
        'moduleSha256': context['controlSourceSha256']['scripts/production-release/registration-onboarding-96.py'],
        'manifest': manifest, 'manifestRawSha256': files[release + '/release-manifest.json'], 'manifestCanonicalSha256': scope.canonical_sha256(manifest),
        'publicSourceMap': {'fileCount': len(map_), 'sha256': scope.canonical_sha256(map_, ascii=False)}, 'fileSha256': files,
        **running, 'auditReports': f['reports'], 'imageMetadata': image, 'configurationProof': configuration, 'backup': backup,
        'officialOtpAccepted': 'NOT_MEASURED', 'businessAcceptanceConfirmed': False}
    f.update(worker=worker, projection=projection, profile_raw=profile_raw, runtime=runtime, release=release,
        image=image, running=running, backup=backup, readback=readback, deployed_at=deployed_at)
    return f


class SyntheticHelpers:
    def __init__(self, fixture_):
        self.f = fixture_; self.trace = []; self.pointer = fixture_['record']['current']; self.calls = {}
        self.fail = {}; self.mutate = {}
        self.functions = {n: self.handler(n) for n in scope.RELEASE_HELPERS}

    def handler(self, name):
        def call(*args):
            self.trace.append((name, args)); self.calls[name] = self.calls.get(name, 0) + 1
            count = self.calls[name]
            if (name, count) in self.mutate: self.mutate[(name, count)](self)
            if (name, count) in self.fail: raise RuntimeError('SYNTHETIC_PRIVATE_ERROR_MUST_NEVER_LEAVE')
            f = self.f
            if name == 'observe_baseline': return encoded(f['record'])
            if name == 'audit49': return copy.deepcopy(f['reports'][args[2]])
            if name == 'require_registration_zero_report':
                report, stage, _frozen = args
                return {'checkCount': 49, 'violationCount': 0, 'registrationFinanceGate': report['gate']}
            if name == 'pull_registration_image': return copy.deepcopy(f['image'])
            if name == 'fresh_backup': return copy.deepcopy(f['backup'])
            if name == 'observe_current': return self.pointer
            if name == 'observe_running': return copy.deepcopy(f['running'])
            if name == 'point_current': self.pointer = args[0]
            if name == 'observe_readback': return copy.deepcopy(f['readback'])
            return None
        return call

    def execute(self):
        f = self.f
        return scope.release_helpers(f['context'], f['raw'], f['profile_raw'], f['projection'], f['runtime'], f['release'],
            f['deployed_at'], self.functions, public=f['public'], candidate=f['candidate'])


class FiniteRegistration96Tests(unittest.TestCase):
    def reject(self, function, *args, **kwargs):
        with self.assertRaises(scope.Registration96Error): function(*args, **kwargs)

    def test_complete_synthetic_baseline_validates_without_claiming_actual_acceptance(self):
        f = fixture(); result = scope.validate_baseline(f['raw'], f['context'])
        self.assertEqual(result, f['record']); self.assertFalse(result['businessAcceptanceConfirmed'])
        self.assertEqual(result['officialOtpAccepted'], 'NOT_MEASURED')
        self.assertFalse(scope.ENABLED); self.assertIsNone(scope.FORMAL_BASELINE_SHA256)

    def test_pinned_formal_producer_raw_receipt_and_missing_freeze_reject(self):
        f = fixture()
        self.reject(scope.validate_frozen, None)
        changed = copy.deepcopy(f['context']); changed['formalProducerEvidenceSha256'] = None
        self.reject(scope.validate_baseline, f['raw'], changed)
        self.reject(scope.validate_baseline, f['raw'] + b' ', f['context'])
        changed = copy.deepcopy(f['record']); changed['formalProducerEvidenceSha256'] = '0' * 64
        self.reject(scope.validate_finite_record, changed, f['context'])

    def test_unknown_nested_fields_types_and_status_cannot_be_resealed_into_valid_record(self):
        f = fixture()
        for name, mutation in [('manifest', lambda r: r['manifest'].update(unknown=None)),
            ('state', lambda r: r['liveServices']['api'].update(Health={'Log': ['SYNTHETIC']})),
            ('health', lambda r: r['workerHealth'].update(ready=1)),
            ('task', lambda r: r['taskReadOnly']['task'].update(attempt=True)),
            ('account', lambda r: r['taskReadOnly']['account'].update(rowCount=True)),
            ('audit', lambda r: r['audits']['before'].update(checkCount=True)),
            ('map', lambda r: r['publicSourceMap']['current'].update(fileCount=True))]:
            r = copy.deepcopy(f['record']); mutation(r)
            with self.subTest(name=name): self.reject(scope.validate_finite_record, r, f['context'])

    def test_original6f_actual_raw_link_and_inherited_manifest_field_are_separate(self):
        f = fixture()
        self.assertNotEqual(f['record']['manifest']['previousManifestSha256'], f['context']['baseline95']['fileSha256']['release-manifest.json'])
        for change in (lambda r: r['manifest'].update(previousManifestSha256=f['context']['baseline95']['fileSha256']['release-manifest.json']),
            lambda r: r['fileSha256'].update({scope.PREVIOUS_DIRECTORY + '/release-manifest.json': '0' * 64})):
            r = copy.deepcopy(f['record']); change(r); r['manifestCanonicalSha256'] = scope.canonical_sha256(r['manifest'])
            self.reject(scope.validate_finite_record, r, f['context'])

    def test_all_seven_services_require_complete_eight_fields(self):
        f = fixture()
        for service in scope.SERVICES:
            r = copy.deepcopy(f['record']); r['liveServices'][service].pop('configurationSha256')
            with self.subTest(service=service): self.reject(scope.validate_finite_record, r, f['context'])
        for service in scope.SERVICES - {'auto-recharge'}:
            r = copy.deepcopy(f['record']); r['liveServices'][service]['configurationSha256'] = '0' * 64
            with self.subTest(service=service): self.reject(scope.validate_finite_record, r, f['context'])

    def test_C9_and_pro_full60_api815_four_and_build_content_remain_separate(self):
        f = fixture()
        for mutation in (lambda r: r.update(actualRegistrationWorkerSourceSha256=r['actualRechargeWorkerSourceSha256']),
            lambda r: r['actualRechargeWorkerSourceSha256'].pop('fixture_00.py'),
            lambda r: r['actualApiCompiledSourceSha256'].pop(next(iter(r['actualApiCompiledSourceSha256']))),
            lambda r: r['apiAdminContentProof']['admin'].update(sha256='0' * 64)):
            r = copy.deepcopy(f['record']); mutation(r); self.reject(scope.validate_finite_record, r, f['context'])

    def test_full_finite_file_map_unknown_missing_and_private_drift_reject(self):
        f = fixture()
        for mutation in (lambda r: r['fileSha256'].update({r['current'] + '/unknown': '0' * 64}),
            lambda r: r['fileSha256'].pop(next(iter(r['fileSha256']))),
            lambda r: r['fileSha256'].update({r['current'] + '/.env.aws.production': '0' * 64})):
            r = copy.deepcopy(f['record']); mutation(r); self.reject(scope.validate_finite_record, r, f['context'])

    def test_new_finite_host_set_excludes_old_redundant_worker_rows_but_keeps_full60_container_proof(self):
        f = fixture(); record = f['record']; old = f['context']['baseline95']
        omitted = scope.WORKER_PREFIX + 'fixture_01.py'
        self.assertIn(omitted, old['fileSha256'])
        self.assertNotIn(old['current'] + '/' + omitted, record['fileSha256'])
        self.assertNotIn(record['current'] + '/' + omitted, record['fileSha256'])
        self.assertEqual(len(record['actualRegistrationWorkerSourceSha256']), 60)
        self.assertEqual(len(record['actualRechargeWorkerSourceSha256']), 60)
        scope.validate_baseline(f['raw'], f['context'])
        changed = copy.deepcopy(record); changed['fileSha256'][old['current'] + '/' + omitted] = old['fileSha256'][omitted]
        self.reject(scope.validate_finite_record, changed, f['context'])

    def test_code_read_count_stays_distinct_from_official_acceptance(self):
        f = fixture(); r = copy.deepcopy(f['record'])
        r['taskReadOnly']['codeRead'].update(count=2, firstAt='2026-10-07T21:07:40.000Z', latestAt='2026-10-07T21:07:42.000Z', steps=['email_code', 'password'])
        self.assertEqual(scope.validate_finite_record(r, f['context'])['officialOtpAccepted'], 'NOT_MEASURED')
        for mutation in (lambda r: r['taskReadOnly']['codeRead'].update(provesOfficialAcceptance=True),
            lambda r: r['taskReadOnly']['codeRead'].update(count=True),
            lambda r: r['taskReadOnly']['codeRead'].update(firstAt='2026-10-07T20:00:00.000Z'),
            lambda r: r.update(businessAcceptanceConfirmed=True)):
            changed = copy.deepcopy(r); mutation(changed); self.reject(scope.validate_finite_record, changed, f['context'])

    def test_fixed_basis_build_only_changes_pair_and_runtime_keeps_other_pro_code(self):
        f = deployment_fixture()
        self.assertEqual(len(f['projection']), 60); self.assertEqual(len(f['worker']), 62)
        self.assertEqual({n for n in f['projection'] if f['projection'][n] != f['context']['sealed95WorkerProjection'][n]}, scope.SOURCE_PAIR)
        changed = scope.WORKER_PREFIX + 'fixture_00.py'
        self.assertNotEqual(f['worker'][changed], f['runtime'][changed])
        self.assertEqual(f['runtime'][changed], f['public'][changed])
        self.assertEqual(f['worker'][changed], f['basis'][changed])
        scope.build_receipt(f['context'], f['projection'])

    def test_currentmain_pro_as_registration_basis_and_58_file_drift_reject(self):
        f = fixture()
        pro_basis = {**f['basis'], **{n: row for n, row in f['public'].items() if n.startswith(scope.WORKER_PREFIX)}}
        self.reject(scope.build_projection, pro_basis, f['candidate'], f['context'], f['record'], carried=f['carried'])
        changed = dict(f['basis']); changed[scope.WORKER_PREFIX + 'fixture_01.py'] = (b'changed', '100644')
        self.reject(scope.build_projection, changed, f['candidate'], f['context'], f['record'], carried=f['carried'])
        changed = dict(f['candidate']); changed[next(iter(scope.SOURCE_PAIR))] = (b'unreviewed', '100644')
        self.reject(scope.build_projection, f['basis'], changed, f['context'], f['record'], carried=f['carried'])

    def test_build_archive_helper_is_called_only_for_candidate_and_direct2f_code_input(self):
        f = fixture(); c_raw, b_raw = b'SYNTHETIC current archive', b'SYNTHETIC direct basis archive'
        f['context']['candidate']['archiveSha256'] = hashlib.sha256(c_raw).hexdigest()
        calls = []
        def archive(raw, commit):
            calls.append((raw, commit)); return f['candidate'] if raw == c_raw else f['basis']
        scope.build_from_archives(c_raw, b_raw, f['context'], f['record'], archive, carried=f['carried'])
        self.assertEqual(calls, [(c_raw, f['context']['candidate']['commit']), (b_raw, scope.WORKER_BASIS_COMMIT)])
        calls.clear(); self.reject(scope.build_from_archives, c_raw + b'?', b_raw, f['context'], f['record'], archive, carried=f['carried'])
        self.assertEqual(calls, [])

    def test_seven_carried_inputs_are_required_exact_hash_mode_and_sealed_sources(self):
        f = fixture()
        self.reject(scope.build_projection, f['basis'], f['candidate'], f['context'], f['record'])
        for mutation in (lambda c: c['files'].pop(next(iter(c['files']))),
            lambda c: c['files'].update({scope.WORKER_PREFIX + 'extra.py': (b'extra', '100644')}),
            lambda c: c['sourceCommits'].update({next(iter(c['sourceCommits'])): scope.CURRENT_COMMIT}),
            lambda c: c['files'].update({next(iter(c['files'])): (b'unknown', '100644')}),
            lambda c: c['files'].update({next(iter(c['files'])): (c['files'][next(iter(c['files']))][0], '100755')})):
            carried = copy.deepcopy(f['carried']); mutation(carried)
            self.reject(scope.build_projection, f['basis'], f['candidate'], f['context'], f['record'], carried=carried)

    def test_new_metadata_is_runtime_only_profile_and_module_do_not_contain_future_commit(self):
        f = deployment_fixture(); profile = json.loads(f['profile_raw'])
        for name in scope.CANDIDATE_KEYS: self.assertNotIn(name, profile)
        self.assertNotIn(f['context']['candidate']['commit'], f['profile_raw'].decode())
        self.assertNotIn(f['context']['candidate']['tree'], f['profile_raw'].decode())
        self.assertEqual(profile['registrationSourceCommit'], scope.REGISTRATION_SOURCE_COMMIT)
        self.assertEqual(profile['baselineCarrierSha256'], f['context']['baselineCarrierSha256'])
        self.assertNotIn(scope.PROFILE_FILE, profile['controlSourceSha256'])
        source = MODULE.read_text()
        self.assertNotIn(f['context']['candidate']['commit'], source)

    def test_private_serialization_is_order_independent_and_full_readback_closes_actual_files(self):
        f = deployment_fixture(); report = f['reports']['after']
        reversed_report = dict(reversed(list(report.items())))
        self.assertEqual(scope.private_json_bytes(report), scope.private_json_bytes(reversed_report))
        # A JSON wire serializer can reorder every nested object without breaking
        # the deliberately stable bytes written by new96 private I/O adapters.
        wire = json.loads(json.dumps(f['readback'], sort_keys=True))
        scope.validate_readback(wire, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])

    def test_profile_disabled_controls_unknown_projection_and_caps_reject(self):
        f = deployment_fixture()
        profile = json.loads(f['profile_raw']); profile['enabled'] = False
        self.reject(scope.validate_profile, encoded(profile), f['context'], f['record'], f['projection'], require_enabled=True)
        projection = copy.deepcopy(f['projection']); projection[scope.WORKER_PREFIX + 'fixture_01.py']['sha256'] = '0' * 64
        self.reject(scope.profile_contract, f['context'], f['record'], projection)
        public = dict(f['public']); public['.env.aws.production'] = (b'SYNTHETIC opaque private', '100644')
        self.reject(scope.runtime_projection, public, f['candidate'], f['profile_raw'], f['context'], f['record'], f['projection'])

    def test_configuration_mount_order_health_log_and_real_drift_boundary(self):
        value = {'Config': {'Env': ['SYNTHETIC=opaque']}, 'HostConfig': {'NetworkMode': 'synthetic'},
            'Mounts': [{'Destination': '/z', 'RW': False}, {'Destination': '/a', 'RW': True}], 'State': {'Health': {'Log': ['SYNTHETIC']}}}
        measured = scope.configuration_sha256(value)
        changed = copy.deepcopy(value); changed['Mounts'].reverse(); changed['State']['Health']['Log'] = ['changed']
        self.assertEqual(measured, scope.configuration_sha256(changed))
        changed['Mounts'][0]['RW'] = False; self.assertNotEqual(measured, scope.configuration_sha256(changed))
        for mutation in (lambda x: x.pop('HostConfig'), lambda x: x['Mounts'][0].update(Destination='relative'),
            lambda x: x['Mounts'][0].update(Destination=x['Mounts'][1]['Destination'])):
            x = copy.deepcopy(value); mutation(x); self.reject(scope.configuration_sha256, x)

    def test_full49_report_identity_checks_stage_and_observation_are_required(self):
        f = fixture()
        scope.validate_audit(f['reports']['after'], 'after', f['context'], f['record'], before=f['reports']['before'])
        for mutation in (lambda r: r.update(checkCount=True), lambda r: r.update(violationCount=1),
            lambda r: r['checks']['check_01'].update(ok=False), lambda r: r['identity'].update(currentUser='root@synthetic'),
            lambda r: r['gate'].update(stage='before')):
            changed = copy.deepcopy(f['reports']['after']); mutation(changed)
            self.reject(scope.validate_audit, changed, 'after', f['context'], f['record'], before=f['reports']['before'])
        self.reject(scope.validate_audit, f['reports']['after'], 'after', f['context'], f['record'])

    def test_valid_readback_preserves_new_pro_and_writes_correct_new_previous_raw_link(self):
        f = deployment_fixture(); r = scope.validate_readback(f['readback'], f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])
        self.assertEqual(r['manifest']['previousManifestSha256'], f['record']['manifestRawSha256'])
        self.assertEqual(r['manifest']['fixedRechargeRelease'], f['record']['manifest']['fixedRechargeRelease'])
        self.assertEqual(r['manifest']['fixedRechargePreservedStates'], f['record']['manifest']['fixedRechargePreservedStates'])
        self.assertFalse(r['businessAcceptanceConfirmed'])

    def test_readback_file_rows_are_finite_while_the_whole_public_map_remains_bound(self):
        f = deployment_fixture(); r = f['readback']
        omitted = scope.WORKER_PREFIX + 'fixture_01.py'
        self.assertIn(omitted, f['runtime'])
        self.assertNotIn(f['release'] + '/' + omitted, r['fileSha256'])
        self.assertLess(len(r['fileSha256']), len(f['runtime']))
        scope.validate_readback(r, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])
        changed = copy.deepcopy(r); changed['fileSha256'][f['release'] + '/' + omitted] = hashlib.sha256(f['runtime'][omitted][0]).hexdigest()
        self.reject(scope.validate_readback, changed, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])
        changed = copy.deepcopy(r); changed['publicSourceMap']['sha256'] = '0' * 64
        self.reject(scope.validate_readback, changed, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])

    def test_readback_rejects_pro_api_reg_configuration_public_or_private_drift(self):
        f = deployment_fixture()
        mutations = [lambda r: r['liveServices']['auto-recharge'].update(configurationSha256='0' * 64),
            lambda r: r['actualRegistrationWorkerSourceSha256'].update(fixture_01_py='0' * 64),
            lambda r: r['actualRechargeWorkerSourceSha256'].pop('fixture_00.py'),
            lambda r: r['actualApiCompiledSourceSha256'].pop(next(iter(r['actualApiCompiledSourceSha256']))),
            lambda r: r['configurationProof'].update(environmentFileSha256='0' * 64),
            lambda r: r['publicSourceMap'].update(sha256='0' * 64),
            lambda r: r['fileSha256'].update({f['release'] + '/.env.aws.production': '0' * 64}),
            lambda r: r['fileSha256'].update({f['release'] + '/after-audit.json': '0' * 64}),
            lambda r: r['manifest'].update(previousManifestSha256=f['record']['manifest']['previousManifestSha256']),
            lambda r: r.update(unknown='SYNTHETIC')]
        for n, mutation in enumerate(mutations):
            r = copy.deepcopy(f['readback']); mutation(r)
            with self.subTest(case=n): self.reject(scope.validate_readback, r, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])

    def test_release_helper_order_single_service_two_idle_checks_and_closed_success(self):
        ops = SyntheticHelpers(deployment_fixture()); result = ops.execute()
        self.assertEqual(result['status'], 'REGISTRATION96_RUNTIME_VERIFIED'); self.assertFalse(result['businessAcceptanceConfirmed'])
        names = [n for n, _args in ops.trace]
        self.assertEqual(names.count('assert_no_active_registration'), 2)
        self.assertEqual(names.count('observe_baseline'), 2)
        self.assertLess(names.index('audit49'), names.index('switch_registration'))
        self.assertEqual([args[-1] for n, args in ops.trace if n == 'switch_registration'], [('auto-registration',)])
        self.assertEqual(names.count('registration_rollback'), 0)
        self.assertEqual(ops.pointer, ops.f['release'])

    def test_first_idle_or_missing_frozen_handoff_rejects_before_side_effects(self):
        ops = SyntheticHelpers(deployment_fixture()); ops.fail[('assert_no_active_registration', 1)] = True
        result = ops.execute(); self.assertFalse(result['workerSwitchStarted'])
        self.assertNotIn('stage_runtime', [n for n, _ in ops.trace])
        for mutation in (lambda f: f['context']['handoff'].update(attempt=8), lambda f: f['context']['handoff'].update(windowExists=True),
            lambda f: f['context'].update(formalProducerEvidenceSha256=None)):
            f = deployment_fixture(); mutation(f); ops = SyntheticHelpers(f)
            self.reject(ops.execute); self.assertEqual(ops.trace, [])

    def test_second_idle_new_dispatch_or_eightfield_drift_prevents_switch(self):
        for mutate in (lambda o: o.f['record']['workerHealth'].update(registrationBusy=True),
            lambda o: o.f['record']['liveServices']['api'].update(configurationSha256='0' * 64),
            lambda o: setattr(o, 'pointer', '/opt/id-business-v2/releases/foreign')):
            ops = SyntheticHelpers(deployment_fixture()); ops.mutate[('observe_baseline', 2)] = mutate
            result = ops.execute(); self.assertFalse(result['workerSwitchStarted'])
            self.assertNotIn('switch_registration', [n for n, _ in ops.trace])
        ops = SyntheticHelpers(deployment_fixture()); ops.fail[('assert_no_active_registration', 2)] = True
        self.assertFalse(ops.execute()['workerSwitchStarted'])

    def test_partial_switch_failure_rollback_is_attempted_and_requires_new_actual_receipt(self):
        ops = SyntheticHelpers(deployment_fixture()); ops.fail[('switch_registration', 1)] = True
        result = ops.execute(); self.assertTrue(result['workerSwitchStarted']); self.assertTrue(result['rollbackOk'])
        self.assertTrue(result['freshRollbackReadbackRequired']); self.assertEqual(ops.calls['registration_rollback'], 1)
        self.assertNotIn('SYNTHETIC_PRIVATE_ERROR', json.dumps(result)); self.assertNotIn('point_current', ops.calls)

    def test_postswitch_health_worker_after49_and_manifest_failures_do_not_publish(self):
        for name, count in [('wait_healthy', 1), ('registration_worker_hashes', 1), ('observe_running', 1), ('audit49', 2), ('write_manifest', 1)]:
            ops = SyntheticHelpers(deployment_fixture()); ops.fail[(name, count)] = True
            result = ops.execute()
            with self.subTest(name=name):
                self.assertTrue(result['workerSwitchStarted']); self.assertEqual(ops.calls['registration_rollback'], 1)
                self.assertNotIn('point_current', ops.calls); self.assertTrue(result['freshRollbackReadbackRequired'])

    def test_postpublish_failure_restores_pointer_only_after_successful_worker_rollback(self):
        ops = SyntheticHelpers(deployment_fixture()); ops.fail[('observe_readback', 1)] = True
        result = ops.execute(); self.assertTrue(result['rollbackOk']); self.assertTrue(result['pointerRestored'])
        self.assertEqual(ops.pointer, ops.f['record']['current'])
        names = [n for n, _ in ops.trace]
        self.assertLess(names.index('registration_rollback'), len(names) - 1 - names[::-1].index('point_current'))

    def test_new_window_blocks_rollback_and_preserves_published_pointer(self):
        ops = SyntheticHelpers(deployment_fixture()); ops.fail[('observe_readback', 1)] = True
        ops.fail[('registration_rollback', 1)] = True
        result = ops.execute(); self.assertTrue(result['rollbackBlocked']); self.assertFalse(result['pointerRestored'])
        self.assertEqual(ops.pointer, ops.f['release']); self.assertEqual(ops.calls['point_current'], 1)

    def test_foreign_pointer_is_neither_overwritten_nor_worker_rolled_back(self):
        ops = SyntheticHelpers(deployment_fixture())
        ops.mutate[('observe_readback', 1)] = lambda o: setattr(o, 'pointer', '/opt/id-business-v2/releases/foreign')
        ops.fail[('observe_readback', 1)] = True
        result = ops.execute(); self.assertTrue(result['rollbackBlocked']); self.assertFalse(result['pointerRestored'])
        self.assertEqual(ops.pointer, '/opt/id-business-v2/releases/foreign')
        self.assertNotIn('registration_rollback', ops.calls); self.assertEqual(ops.calls['point_current'], 1)


def adapter_fixture():
    """Closed synthetic carrier; no provider/production/billing claim."""
    f = fixture(); c, b = f['context'], f['record']
    pro_raw = scope.private_json_bytes(c['proProfile'])
    name = 'deploy/aws/' + c['proProfile']['id'] + '.json'
    f['public'][name] = (pro_raw, '100644')
    c['proProfileRawSha256'] = b['profileRawSha256'] = scope.sha256(pro_raw)
    b['fileSha256'][b['current'] + '/' + name] = scope.sha256(pro_raw)
    m = scope.source_map(f['public'])
    b['publicSourceMap']['current'] = {'fileCount': len(m), 'sha256': scope.canonical_sha256(m, ascii=False)}
    raw = scope.private_json_bytes(b)
    c['baselineRawSha256'], c['baselineCanonicalSha256'] = scope.sha256(raw), scope.canonical_sha256(b)
    old_raw = scope.private_json_bytes(c['baseline95'])
    carrier = {'version': 1, 'status': 'FROZEN_REGISTRATION96_FINITE_CARRIER', 'schemaSha256': c['schemaSha256'],
        'formalProducerEvidenceSha256': c['formalProducerEvidenceSha256'], 'baselineRawBase64': base64.b64encode(raw).decode(),
        'baselineRawSha256': c['baselineRawSha256'], 'baselineCanonicalSha256': c['baselineCanonicalSha256'],
        'baseline95RawBase64': base64.b64encode(old_raw).decode(), 'baseline95RawSha256': scope.sha256(old_raw),
        'baseline95CanonicalSha256': c['baseline95CanonicalSha256'], 'proProfileRawBase64': base64.b64encode(pro_raw).decode(),
        'proProfileRawSha256': c['proProfileRawSha256'], 'proProfileCanonicalSha256': c['proProfileCanonicalSha256'],
        'sealed95WorkerProjection': c['sealed95WorkerProjection'], 'taskBinding': c['taskBinding'], 'handoff': c['handoff'],
        'financeBaseline': c['financeFrozen'], 'buildInputSha256': c['buildInputSha256'], 'currentPublicSourceMap': m}
    carrier_raw = scope.private_json_bytes(carrier); c['baselineCarrierSha256'] = scope.sha256(carrier_raw)
    f['candidate'][scope.BASELINE_CARRIER_FILE] = (carrier_raw, '100644')
    projection = copy.deepcopy(c['sealed95WorkerProjection'])
    projection.update({n: {'mode': '100644', 'sha256': h} for n, h in scope.REGISTRATION_SOURCE_SHA256.items()})
    profile_raw = scope.private_json_bytes(scope.profile_contract(c, b, projection, enabled=True))
    f['candidate'][scope.PROFILE_FILE] = (profile_raw, '100644')
    f.update(raw=raw, carrier=carrier, carrier_raw=carrier_raw, profile_raw=profile_raw, projection=projection)
    return f


class Registration96AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        ADAPTER_TEST_OUTPUT.mkdir(parents=True, exist_ok=True)

    def reject(self, reason, function, *args, **kwargs):
        with self.assertRaises(scope.Registration96Error) as fail: function(*args, **kwargs)
        self.assertEqual(str(fail.exception), reason)

    def parent(self, run=None, compose=None):
        result = {n: lambda *_a, **_k: None for n in scope.PARENT_CAPABILITIES}
        result.update(__file__=str(MODULE.with_name('remote-deploy.py')), BASE=Path('/opt/id-business-v2'))
        if run: result['run'] = run
        if compose: result['compose'] = compose
        return result

    def test_disabled_cli_no_parent_file_subprocess_or_provider_access(self):
        stream = io.StringIO()
        class Forbidden(dict):
            def get(self, *_a): raise AssertionError('parent accessed')
            def __getitem__(self, _key): raise AssertionError('parent accessed')
        with patch.object(scope.os, 'open', side_effect=AssertionError('file accessed')), patch.object(scope.subprocess, 'run', side_effect=AssertionError('provider accessed')), redirect_stdout(stream):
            rc = scope.registration96_cli(['--registration-worker-96', '--secret', 'synthetic-private'], Forbidden())
        self.assertEqual(rc, 2)
        self.assertNotIn('synthetic-private', stream.getvalue())
        self.assertEqual(json.loads(stream.getvalue())['productionOperations'], 0)

    def test_cli_mixed_selectors_duplicates_foreign_scopes_and_image_reuse_reject(self):
        base = ['--check-fixed-registration-scope', '--registration-profile', scope.PROFILE_ID,
            '--registration96-baseline-sha256', 'a' * 64]
        self.assertEqual(scope.parse96_arguments(base)[0], 'scope')
        self.reject('CLI_SCOPE_MIXED', scope.parse96_arguments, base + ['--registration-worker-96'])
        self.reject('CLI_ARGUMENTS_INVALID', scope.parse96_arguments, base + ['--admin-only'])
        self.reject('CLI_ARGUMENTS_INVALID', scope.parse96_arguments, base + ['--registration-profile', scope.PROFILE_ID])
        self.reject('CLI_IMAGE_REUSE_FORBIDDEN', scope.parse96_arguments, base + ['--image-commit', 'b' * 40])

    def test_even_complete_synthetic_pins_cannot_bypass_mixedscope_preflight_io(self):
        values = {'ENABLED': True, 'BASELINE_SCHEMA_SHA256': 'a' * 64, 'FORMAL_BASELINE_SHA256': 'b' * 64,
            'FINAL_SOURCE_PAIR_SHA256': 'c' * 64, 'HANDOFF_SHA256': 'd' * 64}
        stream = io.StringIO()
        with patch.multiple(scope, **values), patch.object(scope.os, 'open', side_effect=AssertionError('file accessed')), redirect_stdout(stream):
            rc = scope.registration96_cli(['--registration-worker-96', '--admin-only'], {})
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(stream.getvalue())['reason'], 'CLI_ARGUMENTS_INVALID')

    def test_rootcap_is_stdlib_and_exact15_source_shape_with_private_carrier(self):
        self.assertLessEqual(MODULE.stat().st_size, scope.MODULE_MAX_BYTES)
        self.assertEqual(len(scope.CONTROL_FILES | {scope.PROFILE_FILE, scope.BASELINE_CARRIER_FILE}), 15)
        self.assertEqual(len(scope.CARRIER_KEYS), 19)
        io_ = scope.Registration96IO(self.parent(), production=False, budget=210)
        self.assertEqual(set(io_.helpers()), scope.RELEASE_HELPERS)
        self.reject('ADAPTER_HELPERS_MISSING', scope.Registration96IO, {}, production=False)

    def test_carrier_three_raw_hashes_canonical_base64_and_actual19_fields_close(self):
        f = adapter_fixture()
        c, raw, baseline, p = scope.carrier_context(f['carrier_raw'], f['profile_raw'], f['context']['candidate'], f['candidate'])
        self.assertEqual(raw, f['raw']); self.assertEqual(baseline, f['record']); self.assertEqual(p, f['projection'])
        for name in ('baselineRawBase64', 'baseline95RawBase64', 'proProfileRawBase64'):
            carrier = copy.deepcopy(f['carrier']); carrier[name] += '\n'
            self.reject('CARRIER_INVALID', scope.carrier_context, encoded(carrier), f['profile_raw'], f['context']['candidate'], f['candidate'])
        carrier = copy.deepcopy(f['carrier']); carrier['candidateCommit'] = 'e' * 40
        self.reject('CARRIER_FIELDS_INVALID', scope.carrier_context, encoded(carrier), f['profile_raw'], f['context']['candidate'], f['candidate'])

    def test_full_actual_public_map_is_required_and_private_entries_reject(self):
        f = adapter_fixture(); m = copy.deepcopy(f['carrier']['currentPublicSourceMap'])
        m['.env.aws.production'] = ['a' * 64, 0o600]
        self.reject('PUBLIC_MAP_INVALID', scope.public_hash_map, m)
        bad = copy.deepcopy(f['carrier']); bad['currentPublicSourceMap'].pop(next(iter(m)))
        # Shape is valid but pin differs: carrier/profile binding may reject first.
        expected = scope.expected_runtime_map(f['carrier_raw'], f['profile_raw'], f['candidate'], f['context'], f['record'])
        for name, row in f['carrier']['currentPublicSourceMap'].items():
            if name not in scope.SOURCE_PAIR | scope.CONTROL_FILES | {scope.PROFILE_FILE, scope.BASELINE_CARRIER_FILE}:
                self.assertEqual(expected[name], row)
        self.reject('CARRIER_PUBLIC_MAP_CHANGED', scope.expected_runtime_map, encoded(bad), f['profile_raw'], f['candidate'], f['context'], f['record'])

    def test_private_reads_writes_nofollow_singlelink_mode_and_owner(self):
        output = ADAPTER_TEST_OUTPUT
        with tempfile.TemporaryDirectory(dir=output) as directory:
            path = Path(directory) / 'closed.json'; scope.write_private_file(path, b'{}')
            self.assertEqual(scope.read_actual_file(path), b'{}')
            link = path.with_name('symbolic'); link.symlink_to(path)
            self.reject('FILE_LOCATION_INVALID', scope.read_actual_file, link)
            hard = path.with_name('hard'); os.link(path, hard)
            self.reject('FILE_IDENTITY_INVALID', scope.read_actual_file, path)
            hard.unlink(); path.chmod(0o644)
            self.reject('FILE_IDENTITY_INVALID', scope.read_actual_file, path)
            self.reject('FILE_IDENTITY_INVALID', scope.read_actual_file, path, modes=(0o644,), owner=os.geteuid() + 1)
            self.reject('FILE_LOCATION_INVALID', scope.write_private_file, path, b'{}', exclusive=False)

    def test_real_git_archive_tree_matches_actual_current_git_tree_in_ram(self):
        import tarfile
        root = MODULE.parents[2]; commit = scope.local_git(root, 'rev-parse', 'HEAD')
        raw = scope.local_git(root, 'archive', '--format=tar', commit, binary=True)
        files = {}
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            for member in archive:
                if member.isfile(): files[member.name] = (archive.extractfile(member).read(), '100755' if member.mode & 0o111 else '100644')
        self.assertEqual(scope.archive_tree(files), scope.local_git(root, 'rev-parse', commit + '^{tree}'))
        one = next(iter(files)); changed = dict(files); changed[one] = (files[one][0] + b'changed', files[one][1])
        self.assertNotEqual(scope.archive_tree(changed), scope.archive_tree(files))

    def test_actual_inspect_derived_eight_fields_and_samecid_recheck(self):
        ids = {n: hashlib.sha256(n.encode()).hexdigest() for n in scope.SERVICES}; calls = []
        inspect = {ids[n]: {'Id': ids[n], 'Image': 'sha256:' + 'a' * 64,
            'Config': {'Image': 'local/' + n, 'Env': ['SYNTHETIC_ENV=closed'], 'Labels': {}},
            'HostConfig': {'Memory': 0}, 'Mounts': [],
            'State': {'Status': 'running', 'StartedAt': '2026-10-08T01:00:00Z', 'Health': {'Status': 'healthy'} if n != 'caddy' else {}}} for n in scope.SERVICES}
        def run(*args, **_kw):
            calls.append(args); self.assertEqual(args[:2], ('docker', 'inspect')); return json.dumps([inspect[args[2]]])
        def compose(_directory, *args, **_kw):
            self.assertEqual(args[:2], ('ps', '-q')); return ids[args[2]]
        adapter = scope.Registration96IO(self.parent(run, compose), production=False, budget=210)
        states = adapter.states(Path('/opt/id-business-v2/releases/closed'))
        self.assertEqual(len(calls), 7)
        self.assertTrue(all(set(row) == scope.STATE_KEYS for row in states.values()))
        first = states['auto-recharge']['configurationSha256']; inspect[ids['auto-recharge']]['HostConfig']['Memory'] = 1
        self.assertNotEqual(adapter.states(Path('/opt/id-business-v2/releases/closed'))['auto-recharge']['configurationSha256'], first)
        adapter.cap['compose'] = lambda *_a, **_k: 'invalid-cid'
        self.reject('SERVICE_STATE_INVALID', adapter.states, Path('/opt/id-business-v2/releases/closed'))

    def test_budget_reserves_rollback_and_same_helpers_scope_only_registration(self):
        adapter = scope.Registration96IO(self.parent(), production=False, budget=210)
        adapter.reserve = 600; adapter.end = scope.time.monotonic() + 500
        self.reject('ADAPTER_BUDGET_EXHAUSTED', adapter.deadline)
        adapter.rollback = True; self.assertGreater(adapter.deadline(), 0)
        self.reject('SERVICE_SCOPE_INVALID', adapter.switch, '/closed', 'image', ('auto-recharge',))

    def test_closed_readback_wire_roundtrip_and_reject_trailing_hash_size_or_raw_provider(self):
        f = deployment_fixture(); value = f['readback']; envelope = scope.encode96_readback(value)
        self.assertEqual(scope.decode96_readback(envelope), value)
        for change in ({'rawBytes': True}, {'sha256': 'a' * 64}, {'unexpected': 'synthetic-private'}, {'data': envelope['data'] + '\n'}):
            bad = dict(envelope); bad.update(change)
            reason = 'READBACK_WIRE_INVALID'
            self.reject(reason, scope.decode96_readback, bad)
        compressed = base64.b64decode(envelope['data']) + b'extra'
        bad = dict(envelope, data=base64.b64encode(compressed).decode())
        self.reject('READBACK_WIRE_INVALID', scope.decode96_readback, bad)

    def test_full_offline_archive_readback_validates_everything_without_files_or_providers(self):
        import tarfile
        f = adapter_fixture(); candidate = f['candidate']; metadata = f['context']['candidate']
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for name, (raw, mode) in sorted(candidate.items()):
                entry = tarfile.TarInfo('id-business-system-' + metadata['commit'] + '/' + name)
                entry.size = len(raw); entry.mode = 0o755 if mode == '100755' else 0o644
                archive.addfile(entry, io.BytesIO(raw))
        candidate_raw = stream.getvalue()
        metadata.update(tree=scope.archive_tree(candidate), archiveSha256=scope.sha256(candidate_raw))
        def parser(raw, commit):
            result = {}; prefix = 'id-business-system-' + commit + '/'
            with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
                for entry in archive:
                    self.assertTrue(entry.isfile() and entry.name.startswith(prefix))
                    result[entry.name[len(prefix):]] = (archive.extractfile(entry).read(), '100755' if entry.mode & 0o111 else '100644')
            return result
        f = deployment_fixture(f); value = f['readback']
        with patch.object(scope.os, 'open', side_effect=AssertionError('file read')), patch.object(scope.subprocess, 'run', side_effect=AssertionError('provider call')):
            self.assertEqual(scope.validate96_readback_archive(value, f['carrier_raw'], f['profile_raw'], candidate_raw, parser, metadata), value)
        for field, changed, reason in (('tree', 'a' * 40, 'ARCHIVE_TREE_CHANGED'), ('archiveSha256', 'b' * 64, 'ARCHIVE_CHANGED')):
            bad = dict(metadata); bad[field] = changed
            self.reject(reason, scope.validate96_readback_archive, value, f['carrier_raw'], f['profile_raw'], candidate_raw, parser, bad)
        value = copy.deepcopy(value); value['auditReports']['after']['identity']['sessionReadOnly'] = 0
        self.reject('AUDIT_IDENTITY_INVALID', scope.validate96_readback_archive, value, f['carrier_raw'], f['profile_raw'], candidate_raw, parser, metadata)

    def test_metadata_is_actual_git_cli_or_manifest_and_missing_ci_never_invented(self):
        root = MODULE.parents[2]; commit = scope.local_git(root, 'rev-parse', 'HEAD')
        tree = scope.local_git(root, 'rev-parse', commit + '^{tree}')
        with patch.dict(scope.os.environ, {}, clear=True):
            self.reject('CLI_METADATA_MISSING', scope.runtime_cli_metadata, {}, root=root)
            data = scope.runtime_cli_metadata({'commit': commit, 'source-tree': tree, 'run-id': '3', 'run-attempt': '1', 'ci-run-id': '4'}, root=root)
        self.assertEqual(data, {'commit': commit, 'tree': tree, 'run': 'github-actions-3-1', 'ciRunId': 4})
        self.reject('LOCAL_SOURCE_CHANGED', scope.runtime_cli_metadata, {'commit': 'f' * 40, 'source-tree': tree}, root=root)
        manifest = {'commit': commit, 'sourceTree': tree, 'deploymentRun': 'github-actions-3-1', 'ciWorkflowRunId': 4, 'sourceArchiveSha256': 'a' * 64}
        observed = scope.runtime_cli_metadata({'expected-current': commit, 'source-tree': tree}, manifest=manifest)
        self.assertEqual(observed['archiveSha256'], 'a' * 64)
        self.reject('READBACK_BINDING_CHANGED', scope.runtime_cli_metadata, {'expected-current': 'f' * 40, 'source-tree': tree}, manifest=manifest)

    def test_file_identity_race_after_read_is_rejected(self):
        from types import SimpleNamespace
        output = ADAPTER_TEST_OUTPUT
        with tempfile.TemporaryDirectory(dir=output) as directory:
            path = Path(directory) / 'closed.json'; scope.write_private_file(path, b'{}')
            real_fstat = scope.os.fstat; calls = []
            def changed(fd):
                row = real_fstat(fd); calls.append(fd)
                if len(calls) == 2:
                    attrs = {n: getattr(row, n) for n in ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
                    attrs['st_mtime_ns'] += 1
                    return SimpleNamespace(**attrs)
                return row
            with patch.object(scope.os, 'fstat', side_effect=changed):
                self.reject('FILE_IDENTITY_CHANGED', scope.read_actual_file, path)

    def test_task_probe_is_readonly_and_never_selects_secret_or_mail(self):
        text = scope.TASK_READ_PROBE
        self.assertNotIn('findMany({where:{mail', text)
        self.assertNotIn('password_encrypted AS', text)
        self.assertNotIn('totp_secret_encrypted AS', text)
        self.assertIn('password_encrypted IS NOT NULL', text)
        self.assertIn('totp_secret_encrypted IS NOT NULL', text)
        self.assertNotIn('$executeRaw', text)
        self.assertNotIn('P.emailHmac', text)
        self.assertIn("where('code_read')", text)

    def test_inspect_output_cap_duplicate_keys_and_multi_container_reject(self):
        self.reject('INSPECT_OUTPUT_INVALID', scope.inspect_rows, 'a' * (1024 * 1024 + 1))
        self.reject('JSON_INVALID', scope.inspect_rows, '[{"Id":"x","Id":"y"}]')
        self.reject('INSPECT_OUTPUT_INVALID', scope.inspect_rows, '[{},{}]')

    def test_build_receipt_only_after_context_bytes_are_written_and_measured(self):
        f = adapter_fixture()
        worker, projection = scope.build_projection(f['basis'], f['candidate'], f['context'], f['record'], carried=f['carried'])
        output = ADAPTER_TEST_OUTPUT
        with tempfile.TemporaryDirectory(dir=output) as directory:
            parent = self.parent()
            def write(root, files):
                root.mkdir(mode=0o700)
                for name, (raw, mode) in files.items():
                    path = root / name; path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(raw); path.chmod(0o755 if mode == '100755' else 0o644)
            parent['write_registration_files'] = write
            adapter = scope.Registration96IO(parent, production=False, budget=210)
            adapter.root = Path(directory); adapter.frozen = f['context']; adapter.build = lambda: (worker, projection)
            receipt = scope.write_build_context(adapter)
            proof = scope.read_actual_file(Path(directory) / '.deploy/production-release/registration-build-projection.json')
            self.assertEqual(scope.closed_json(proof), receipt)
            self.assertEqual(receipt['workerProjectionSha256'], scope.canonical_sha256(projection))
            self.assertEqual(len(scope.source_map(adapter.public(Path(directory) / receipt['contextPath']))), 62)

    def test_current10_previous11_private_baseline_and_current_artifact_extra_reject(self):
        f = fixture(); c, record = f['context'], f['record']
        names = scope.base_file_names(c)
        current = {n for n in scope.PRIVATE_FILES if record['current'] + '/' + n in names}
        previous = {n for n in scope.PRIVATE_FILES if c['baseline95']['current'] + '/' + n in names}
        self.assertEqual(current, scope.PRIVATE_FILES - {scope.AUDIT_OVERRIDE})
        self.assertEqual(previous, scope.PRIVATE_FILES)
        self.assertEqual(scope.validate_finite_record(record, c), record)
        changed = copy.deepcopy(record); changed['fileSha256'][record['current'] + '/' + scope.AUDIT_OVERRIDE] = 'a' * 64
        self.reject('FILE_MAP_FIELDS_INVALID', scope.validate_finite_record, changed, c)
        changed = copy.deepcopy(record); changed['fileSha256'].pop(c['baseline95']['current'] + '/' + scope.AUDIT_OVERRIDE)
        self.reject('FILE_MAP_FIELDS_INVALID', scope.validate_finite_record, changed, c)

    def test_uid1000_only_for_the_exact_six_baseline_paths_newrelease_stays_root(self):
        from types import SimpleNamespace
        f = fixture()
        with patch.object(scope.os, 'geteuid', return_value=0):
            adapter = scope.Registration96IO(self.parent(), production=True, budget=3000)
        adapter.frozen, adapter.baseline = f['context'], f['record']
        exact = [Path(d) / n for d in (f['context']['parameters']['current'], scope.PREVIOUS_DIRECTORY) for n in scope.NODE_PRIVATE_FILES]
        other = [Path(f['record']['current']) / 'after-audit.json',
            Path('/opt/id-business-v2/releases/20261008T010000Z-eeeeeeeeeeee') / 'before-audit.json',
            Path(f['record']['current']) / scope.AUDIT_OVERRIDE]
        def metadata(path):
            node = path in exact
            return SimpleNamespace(st_dev=1, st_ino=2, st_mode=scope.stat.S_IFREG | (0o400 if node else 0o600),
                st_nlink=1, st_uid=1000 if node else 0, st_gid=1000 if node else 0, st_size=2, st_mtime_ns=1, st_ctime_ns=1)
        with patch.object(Path, 'lstat', autospec=True, side_effect=metadata), patch.object(scope, 'read_actual_file', return_value=b'{}') as reader:
            for path in exact:
                adapter.read(path, private=True)
                self.assertEqual(reader.call_args.kwargs['owner'], 1000)
                self.assertEqual(reader.call_args.kwargs['modes'], (0o400,))
            for path in other:
                adapter.read(path, private=True)
                self.assertEqual(reader.call_args.kwargs['owner'], 0)
            adapter.unchanged()
        self.assertEqual(len(exact), 6)

    def test_baseline_absence_rejects_present_file_broken_symlink_and_directory_change(self):
        output = ADAPTER_TEST_OUTPUT
        with tempfile.TemporaryDirectory(dir=output) as directory:
            adapter = scope.Registration96IO(self.parent(), production=False, budget=210)
            adapter.baseline = {'current': directory}
            adapter.baseline_absence(); adapter.baseline_absence()
            target = Path(directory) / scope.AUDIT_OVERRIDE
            target.symlink_to(Path(directory) / 'missing')
            self.reject('BASELINE_PRIVATE_ARTIFACT_PRESENT', adapter.baseline_absence)
            target.unlink(); target.write_bytes(b'{}')
            self.reject('BASELINE_PRIVATE_ARTIFACT_PRESENT', adapter.baseline_absence)
            target.unlink()
            # A changed parent identity cannot authenticate the missing entry.
            adapter.absence_identity = tuple('changed' if i == 1 else v for i, v in enumerate(adapter.absence_identity))
            self.reject('BASELINE_DIRECTORY_CHANGED', adapter.baseline_absence)

    def test_stage_reads_override_only_from_pinned_previous_bytes_and_never_repairs_current(self):
        output = ADAPTER_TEST_OUTPUT
        with tempfile.TemporaryDirectory(dir=output) as directory:
            current, previous, release = (Path(directory) / n for n in ('current', 'previous', 'newrelease'))
            current.mkdir(); previous.mkdir()
            rows = {}
            names = ['.env.aws.production', 'api-admin-build-proof.json', 'api-admin-preservation.json',
                'order-archive-seal.reader.json', 'order-archive-cleanup.reader.json', scope.AUDIT_OVERRIDE]
            for name in names:
                origin = previous if name == scope.AUDIT_OVERRIDE else current
                raw = scope.private_json_bytes({'SYNTHETIC': name})
                scope.write_private_file(origin / name, raw)
                rows[str(origin / name)] = scope.sha256(raw)
            override_raw = scope.private_json_bytes({'services': {'auto-registration': {'image': 'SYNTHETIC old'}}})
            scope.write_private_file(current / 'compose.release.json', override_raw)
            def write(path, runtime):
                path.mkdir()
                for name, (raw, _mode) in runtime.items():
                    (path / name).write_bytes(raw); (path / name).chmod(0o644)
            parent = self.parent(); parent['write_registration_files'] = write
            adapter = scope.Registration96IO(parent, production=False, budget=1800)
            adapter.frozen = copy.deepcopy(fixture()['context']); adapter.frozen['baseline95']['current'] = str(previous)
            adapter.baseline = {'current': str(current), 'fileSha256': rows}; adapter.current = lambda: current
            runtime = {'docker-compose.aws-mysql.yml': (b'SYNTHETIC compose bytes', '100664')}
            adapter.stage(str(release), runtime)
            self.assertEqual((release / 'docker-compose.aws-mysql.yml').stat().st_mode & 0o777, 0o664)
            self.assertEqual(scope.source_map(adapter.public(release)), scope.source_map(runtime))
            self.assertFalse((current / scope.AUDIT_OVERRIDE).exists())
            self.assertEqual((release / scope.AUDIT_OVERRIDE).read_bytes(), (previous / scope.AUDIT_OVERRIDE).read_bytes())
            self.assertEqual((release / scope.AUDIT_OVERRIDE).stat().st_uid, os.geteuid())
            self.assertEqual((release / scope.AUDIT_OVERRIDE).stat().st_mode & 0o777, 0o600)
            self.assertEqual((current / 'compose.release.json').read_bytes(), override_raw)
            rows[str(previous / scope.AUDIT_OVERRIDE)] = 'f' * 64
            self.reject('PRESERVED_PRIVATE_CHANGED', adapter.stage, str(Path(directory) / 'badrelease'), runtime)

    def test_new_readback_still_requires_all11_private_and_true_old_override_hash(self):
        f = deployment_fixture(); value = copy.deepcopy(f['readback'])
        old_key = f['context']['baseline95']['current'] + '/' + scope.AUDIT_OVERRIDE
        new_key = f['release'] + '/' + scope.AUDIT_OVERRIDE
        self.assertEqual(value['fileSha256'][new_key], f['record']['fileSha256'][old_key])
        value['fileSha256'][new_key] = 'e' * 64
        self.reject('READBACK_PRIVATE_CHANGED', scope.validate_readback, value, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])
        value = copy.deepcopy(f['readback']); value['fileSha256'].pop(new_key)
        self.reject('READBACK_FILE_CHANGED', scope.validate_readback, value, f['context'], f['record'], f['profile_raw'], f['projection'], f['runtime'])

    def test_host_compose664_is_preserved_but_git_and_other_modes_stay_canonical(self):
        name = 'docker-compose.aws-mysql.yml'
        host = {name: (b'SYNTHETIC compose', '100664')}
        self.assertEqual(scope.source_map(host)[name][1], 0o664)
        self.reject('SOURCE_FILES_INVALID', scope.source_files, host)
        self.reject('SOURCE_FILES_INVALID', scope.archive_tree, host)
        self.reject('SOURCE_FILES_INVALID', scope.source_map, {'other.yml': (b'closed', '100664')})
        self.reject('PUBLIC_MAP_INVALID', scope.public_hash_map, {'other.yml': ['a' * 64, 0o664]})
        self.reject('PUBLIC_MAP_INVALID', scope.public_hash_map, {name: ['a' * 64, 0o775]})
        f = fixture(); f['public'][name] = (f['public'][name][0], '100664')
        measured = scope.source_map(f['public'])
        f['record']['publicSourceMap']['current'] = {'fileCount': len(measured), 'sha256': scope.canonical_sha256(measured, ascii=False)}
        f['raw'] = encoded(f['record']); f['context']['baselineRawSha256'] = scope.sha256(f['raw'])
        f['context']['baselineCanonicalSha256'] = scope.canonical_sha256(f['record'])
        d = deployment_fixture(f)
        self.assertEqual(d['runtime'][name][1], '100664')
        self.assertEqual(scope.validate_readback(d['readback'], d['context'], d['record'], d['profile_raw'], d['projection'], d['runtime']), d['readback'])
        bad = copy.deepcopy(d['runtime']); bad[name] = (bad[name][0], '100644')
        self.reject('READBACK_PUBLIC_MAP_CHANGED', scope.validate_readback, d['readback'], d['context'], d['record'], d['profile_raw'], d['projection'], bad)

    def test_public_actual664_only_exact_compose_path(self):
        output = ADAPTER_TEST_OUTPUT
        with tempfile.TemporaryDirectory(dir=output) as directory:
            path = Path(directory) / 'docker-compose.aws-mysql.yml'
            path.write_bytes(b'SYNTHETIC compose'); path.chmod(0o664)
            adapter = scope.Registration96IO(self.parent(), production=False, budget=210)
            self.assertEqual(adapter.public(Path(directory))[path.name][1], '100664')
            other = Path(directory) / 'other.yml'; other.write_bytes(b'closed'); other.chmod(0o664)
            self.reject('PUBLIC_MAP_INVALID', adapter.public, Path(directory))

    def test_task_probe_compression_exact_original_stage1_bytes_and_sha(self):
        # Measured from immutable stage1 before compression; no local artifact dependency.
        raw = scope.TASK_READ_PROBE.encode()
        self.assertEqual(len(raw), 6504)
        self.assertEqual(scope.sha256(raw), 'b8f7bb3d42a107d23bfa169056719f1caff2bad3016a98e7c4462d386c61f56c')
        tree = ast.parse(MODULE.read_text())
        node = next(n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(x, ast.Name) and x.id == 'TASK_READ_PROBE' for x in n.targets))
        compressed = base64.b64decode(ast.literal_eval(node.value.func.value.args[0].args[0]))
        self.assertEqual(scope.gzip.decompress(compressed), raw)

    def test_image_first_failure_survives_logout_failure_and_cleanup_is_closed(self):
        f = fixture(); calls = []
        def run(*args, **_kw):
            calls.append(args[:2])
            if args[:2] == ('aws', 'ecr'): return 'SYNTHETIC_PRIVATE_IN_RAM'
            if args[:2] == ('docker', 'pull'): raise scope.Registration96Error('IMAGE_PULL_FAILED')
            if args[:2] == ('docker', 'logout'): raise ValueError('SYNTHETIC_PRIVATE_CLEANUP')
        adapter = scope.Registration96IO(self.parent(run), production=False, budget=1800)
        adapter.frozen = f['context']
        self.reject('IMAGE_PULL_FAILED', adapter.image, scope.image_reference(f['context']))
        self.assertEqual(adapter.cleanup_failures, ['IMAGE_LOGOUT_FAILED'])
        self.assertEqual(calls[-1], ('docker', 'logout'))
        adapter.cap['run'] = lambda *args, **kw: (_ for _ in ()).throw(ValueError('private')) if args[:2] == ('docker', 'logout') else 'closed'
        self.reject('IMAGE_LOGOUT_FAILED', adapter.image, scope.image_reference(f['context']))

    def test_lock_cleanup_attempts_close_after_unlock_error_and_never_overwrites(self):
        adapter = scope.Registration96IO(self.parent(), production=False, budget=210)
        adapter.lock = 987
        with patch.object(scope.fcntl, 'flock', side_effect=OSError('private unlock')), patch.object(scope.os, 'close', side_effect=OSError('private close')) as close:
            adapter.lock_close(); adapter.lock_close()
        close.assert_called_once_with(987)
        self.assertIsNone(adapter.lock)
        self.assertEqual(adapter.cleanup_failures, ['LOCK_UNLOCK_FAILED', 'LOCK_CLOSE_FAILED'])

    def test_cli_first_prepare_failure_survives_lock_cleanup_and_suppresses_raw(self):
        adapter = scope.Registration96IO(self.parent(), production=False, budget=210)
        adapter.lock = 987
        values = {'ENABLED': True, 'BASELINE_SCHEMA_SHA256': 'a' * 64, 'FORMAL_BASELINE_SHA256': 'b' * 64,
            'FINAL_SOURCE_PAIR_SHA256': 'c' * 64, 'HANDOFF_SHA256': 'd' * 64}
        stream = io.StringIO()
        with patch.multiple(scope, **values), patch.object(scope, 'Registration96IO', return_value=adapter), patch.object(adapter, 'prepare', side_effect=scope.Registration96Error('CARRIER_CHANGED')), patch.object(scope.fcntl, 'flock', side_effect=OSError('private cleanup')), patch.object(scope.os, 'close'), redirect_stdout(stream):
            rc = scope.registration96_cli(['--check-fixed-registration-scope', '--registration-profile', scope.PROFILE_ID, '--registration96-baseline-sha256', 'a' * 64], {})
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(stream.getvalue())['reason'], 'CARRIER_CHANGED')
        self.assertEqual(json.loads(stream.getvalue())['cleanupFailures'], ['LOCK_UNLOCK_FAILED'])
        self.assertNotIn('private', stream.getvalue())

    def test_cli_release_cleanup_failure_marks_success_and_preserves_failed_phase(self):
        f = deployment_fixture()
        args = ['--registration-worker-96', '--registration96-baseline-sha256', 'a' * 64,
            '--commit', f['context']['candidate']['commit'], '--source-tree', f['context']['candidate']['tree'],
            '--repository', '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
            '--expected-current', scope.CURRENT_COMMIT, '--run-id', '3', '--run-attempt', '1', '--ci-run-id', '3']
        pins = {'ENABLED': True, 'BASELINE_SCHEMA_SHA256': 'a' * 64, 'FORMAL_BASELINE_SHA256': 'b' * 64,
            'FINAL_SOURCE_PAIR_SHA256': 'c' * 64, 'HANDOFF_SHA256': 'd' * 64}
        for prior in ({'status': 'REGISTRATION96_RUNTIME_VERIFIED'},
            {'status': 'REGISTRATION96_RELEASE_HELPER_FAILED', 'phase': 'image', 'rollbackOk': True}):
            adapter = scope.Registration96IO(self.parent(), production=False, budget=1800)
            adapter.frozen, adapter.baseline, adapter.projection = f['context'], f['record'], f['projection']
            adapter.profile_raw, adapter.baseline_raw, adapter.candidate = f['profile_raw'], f['raw'], f['candidate']
            adapter.prepare = lambda *_args: None; adapter.public = lambda _directory: f['public']; adapter.build = lambda: None
            adapter.lock_acquire = lambda: setattr(adapter, 'lock', 987)
            stream = io.StringIO()
            with patch.multiple(scope, **pins), patch.object(scope, 'Registration96IO', return_value=adapter), patch.object(scope, 'archive_tree', return_value=f['context']['candidate']['tree']), patch.object(scope, 'release_helpers', return_value=copy.deepcopy(prior)), patch.object(Path, 'exists', return_value=False), patch.object(Path, 'is_symlink', return_value=False), patch.object(scope.fcntl, 'flock', side_effect=OSError('SYNTHETIC private')), patch.object(scope.os, 'close'), redirect_stdout(stream):
                rc = scope.registration96_cli(args, {})
            value = json.loads(stream.getvalue()); self.assertEqual(rc, 1)
            self.assertEqual(value['cleanupFailures'], ['LOCK_UNLOCK_FAILED'])
            if prior['status'].endswith('RUNTIME_VERIFIED'):
                self.assertEqual(value['status'], 'REGISTRATION96_CLEANUP_FAILED')
            else:
                self.assertEqual(value['status'], prior['status']); self.assertEqual(value['phase'], 'image')
            self.assertNotIn('private', stream.getvalue())


if __name__ == '__main__': unittest.main()
