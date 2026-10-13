"""Offline only: synthetic runtime, mocked AWS transport, parsed workflow."""
import base64
import copy
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PATH = Path(__file__).with_name('unpublished-component-runtime-diagnostic.py')
spec = importlib.util.spec_from_file_location('runtime_diagnostic_under_test', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REAL_LOAD = m.load
CORE = REAL_LOAD('unpublished-component-successor.py')
P = {'commit': '1' * 40, 'sourceTree': '2' * 40, 'workflowRunId': '38310000000', 'workflowRunAttempt': '1'}
QUALITY = '38310000001'
EXPECTED = '3' * 40
COMMAND = '11111111-2222-4333-8444-555555555555'
BOOT = b'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n'
SECRET = 'OFFLINE_FIXTURE_VALUE_MUST_NOT_BE_RETAINED'
TMP = ROOT / '.runtime/unpublished-runtime-origin-20261013/checks/offline-temporary-projects'
TMP.mkdir(parents=True, exist_ok=True)


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='diagnostic-', dir=TMP)
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name).resolve()
        self.release = self.folder / 'release'
        self.release.mkdir()
        (self.folder / 'current').symlink_to(self.release, target_is_directory=True)
        self.manifest = raw({'commit': EXPECTED})
        (self.release / 'release-manifest.json').write_bytes(self.manifest)
        (self.release / 'release-manifest.json').chmod(0o600)
        self.body = {'Config': {'Image': 'offline-fixed-image', 'Env': ['B=' + SECRET, 'A=fixture']},
                     'HostConfig': {'NetworkMode': 'offline-network'},
                     'Mounts': [{'Destination': '/app/data', 'Source': '/offline/fixture', 'Type': 'bind'}]}
        self.states = {}
        self.inspect = {}
        for index, role in enumerate(m.ROLES):
            cid = format(index + 1, '064x')
            image = 'sha256:' + format(index + 21, '064x')
            self.states[role] = {'containerId': cid, 'image': image, 'reference': 'offline-fixed-image',
                'status': 'running', 'health': None if role == 'caddy' else 'healthy',
                'startedAtSha256': '4' * 64, 'environmentSha256': m.fingerprint(sorted(self.body['Config']['Env'])),
                'configurationSha256': m.fingerprint(self.body)}
            self.inspect[cid] = json.dumps([{'Id': cid, 'Image': image, **self.body}])
        self.contract = {'currentRelease': str(self.release), 'manifestSha256': m.digest(self.manifest),
                         'services': copy.deepcopy(self.states)}
        self.fake_core = SimpleNamespace(BASELINE_CONTRACT=self.contract, private_bytes=CORE.private_bytes,
                                        validate_invocation=CORE.validate_invocation)
        self.load_patch = mock.patch.object(m, 'load', side_effect=lambda name: self.fake_core
            if name == 'unpublished-component-successor.py' else REAL_LOAD(name))
        self.load_patch.start()
        self.addCleanup(self.load_patch.stop)
        self.commands = []
        self.server = {'Version': '25.0.16', 'ApiVersion': '1.44', 'MinAPIVersion': '1.24'}
        def run(*args, **kwargs):
            self.commands.append((args, kwargs))
            if args == ('docker', 'version', '--format', '{{json .Server}}'):
                return json.dumps(self.server)
            if args[:2] == ('docker', 'inspect') and len(args) == 3:
                return self.inspect[args[2]]
            raise AssertionError('Only fixed Docker read operations are permitted')
        self.d = SimpleNamespace(BASE=self.folder, run=run)
        self.scope = SimpleNamespace(snapshot=lambda _d, _r: copy.deepcopy(self.states),
            workspace_service_names=lambda _d, _r: m.ROLES)
        self.context = (self.d, None, self.scope, None)
        self.version_calls = []
        def api(cid, version, timeout):
            self.version_calls.append((cid, version, timeout))
            return 0, self.inspect[cid]
        self.api = api

    def receipt(self, **kwargs):
        return m.probe(P, QUALITY, EXPECTED, context=self.context, inspect_version=self.api,
                       boot_id_bytes=BOOT, **kwargs)

    def native(self, receipt=None):
        return {'CommandId': COMMAND, 'InstanceId': m.INSTANCE, 'DocumentName': 'AWS-RunShellScript',
            'PluginName': 'aws:runShellScript', 'Status': 'Success', 'StatusDetails': 'Success',
            'Comment': m.COMMENT, 'DocumentVersion': '$DEFAULT', 'ResponseCode': 0,
            'ExecutionStartDateTime': '2026-01-01T00:00:00.000Z',
            'ExecutionEndDateTime': '2026-01-01T00:00:01.000Z', 'ExecutionElapsedTime': 'PT1.000S',
            'StandardOutputContent': raw(receipt or self.receipt()).decode(), 'StandardErrorContent': '',
            'StandardOutputUrl': '', 'StandardErrorUrl': '',
            'CloudWatchOutputConfig': {'CloudWatchLogGroupName': '', 'CloudWatchOutputEnabled': False}}


class RuntimeTests(Fixture):
    def test_real_docker_minimum_124_and_explicit_versions_are_bounded(self):
        value = self.receipt()
        self.assertEqual(m.api_versions(self.server), ('1.40', '1.41', '1.42', '1.43', '1.44'))
        self.assertEqual(len(self.version_calls), 35)
        self.assertTrue(all(0 < timeout <= 20 for _, _, timeout in self.version_calls))
        self.assertEqual(len(self.commands), 8)
        m.validate_receipt(value, P, QUALITY, EXPECTED)
        self.assertIs(value['qualified'], False)
        self.assertIs(value['productionAuthority'], False)
        self.assertNotIn(SECRET, raw(value).decode())
        self.assertNotIn('offline-network', raw(value).decode())
        self.assertNotIn('/offline/fixture', raw(value).decode())

    def test_api_range_rejects_unsupported_or_unbounded_inputs(self):
        for bad in ('1.19', '1.61', '2.44', '1.444', '1.09'):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                m.api_versions({**self.server, 'ApiVersion': bad})
        self.assertEqual(len(m.api_versions({**self.server, 'ApiVersion': '1.60'})), 21)
        self.assertEqual(m.api_versions({**self.server, 'ApiVersion': '1.39'}), ())

    def test_exact_legacy_default_match_is_diagnostic_only(self):
        old = copy.deepcopy(self.body)
        old['Config']['OnBuild'] = None
        old['HostConfig']['KernelMemory'] = 0
        old['HostConfig']['KernelMemoryTCP'] = 0
        for row in self.contract['services'].values():
            row['configurationSha256'] = m.fingerprint(old)
            row['startedAtSha256'] = '5' * 64
        value = self.receipt()
        m.validate_receipt(value, P, QUALITY, EXPECTED)
        self.assertTrue(all(facts['matchingDefaults'] for facts in value['configuration'].values()))
        self.assertTrue(all(facts['startedAtChanged'] for facts in value['configuration'].values()))
        self.assertIs(value['productionAuthority'], False)
        self.assertEqual(value['businessActions'], 0)
        self.assertTrue(all(facts['candidateCount'] <= 24 for facts in value['configuration'].values()))

    def test_real_three_dns_paths_match_the_complete_old_sha_without_authority(self):
        self.body['HostConfig'].update({name: [] for name in m.EMPTY_DNS_FIELDS})
        old = copy.deepcopy(self.body)
        old['HostConfig'].update({name: None for name in m.EMPTY_DNS_FIELDS})
        expected_paths = ['HostConfig.' + name for name in m.EMPTY_DNS_FIELDS]
        for role, state in self.states.items():
            state['configurationSha256'] = m.fingerprint(self.body)
            self.contract['services'][role]['configurationSha256'] = m.fingerprint(old)
            self.inspect[state['containerId']] = json.dumps([{'Id': state['containerId'], 'Image': state['image'], **self.body}])
        value = self.receipt()
        m.validate_receipt(value, P, QUALITY, EXPECTED)
        for facts in value['configuration'].values():
            self.assertEqual(facts['dnsCandidateCount'], 8)
            self.assertEqual(len(facts['matchingDnsRepresentations']), 1)
            match = facts['matchingDnsRepresentations'][0]
            self.assertEqual(match['sha256'], m.fingerprint(old))
            self.assertEqual([change['path'] for change in match['changes']], expected_paths)
            self.assertTrue(all(change['value'] is None for change in match['changes']))
            self.assertIs(facts['qualified'], False)
        self.assertEqual(self.body['HostConfig']['Dns'], [])
        self.assertIs(value['qualified'], False)
        self.assertIs(value['productionAuthority'], False)
        self.assertEqual(value['businessActions'], 0)
        self.assertNotIn(SECRET, raw(value).decode())

    def test_nonempty_dns_and_other_nulls_cannot_be_represented_as_empty(self):
        body = copy.deepcopy(self.body)
        body['HostConfig'].update({'Dns': ['192.0.2.1'], 'DnsOptions': [], 'DnsSearch': None,
                                   'OtherArray': []})
        unchanged = copy.deepcopy(body)
        old = copy.deepcopy(body)
        old['HostConfig']['Dns'] = None
        result = m.reconstruct_empty_dns_sha(body, m.fingerprint(old))
        self.assertEqual(result['status'], 'NO_MATCH')
        self.assertEqual(result['candidateCount'], 4)
        old = copy.deepcopy(body)
        old['HostConfig']['OtherArray'] = None
        self.assertEqual(m.reconstruct_empty_dns_sha(body, m.fingerprint(old))['status'], 'NO_MATCH')
        self.assertEqual(body, unchanged)
        self.assertIs(result['productionAuthority'], False)

    def test_absent_dns_fields_are_never_added(self):
        old = copy.deepcopy(self.body)
        old['HostConfig']['Dns'] = None
        result = m.reconstruct_empty_dns_sha(self.body, m.fingerprint(old))
        self.assertEqual(result['status'], 'NO_MATCH')
        self.assertEqual(result['candidateCount'], 1)
        self.assertNotIn('Dns', self.body['HostConfig'])

    def test_existing_fields_cannot_be_removed_or_replaced(self):
        body = copy.deepcopy(self.body)
        body['Config']['OnBuild'] = ['existing-command']
        old = copy.deepcopy(body)
        old['Config']['OnBuild'] = None
        result = m.reconstruct_legacy_sha(body, m.fingerprint(old), probe_env_order=True)
        self.assertEqual(result['status'], 'NO_MATCH')
        self.assertEqual(body['Config']['OnBuild'], ['existing-command'])

    def test_stable_service_fields_and_health_cannot_drift(self):
        for key, value in (('containerId', 'f' * 64), ('image', 'sha256:' + 'f' * 64),
                ('reference', 'foreign-image'), ('environmentSha256', 'f' * 64), ('health', 'unhealthy'), ('status', 'exited')):
            with self.subTest(key=key):
                states = copy.deepcopy(self.states)
                states['api'][key] = value
                with self.assertRaises(RuntimeError):
                    m.checked_states(states, self.contract['services'])
        with self.assertRaises(RuntimeError):
            m.checked_states({**self.states, 'online-recharge': self.states['api']}, self.contract['services'])

    def test_online_role_is_rejected_before_any_optional_snapshot_branch(self):
        self.scope.workspace_service_names = lambda *_: (*m.ROLES, 'online-recharge')
        self.scope.snapshot = mock.Mock(side_effect=AssertionError('Optional ONLINE branch is forbidden'))
        with self.assertRaisesRegex(RuntimeError, 'ROLES'):
            self.receipt()
        self.scope.snapshot.assert_not_called()

    def test_existing_snapshot_commands_share_the_total_deadline(self):
        original_run = self.d.run
        def snapshot(d, _release):
            d.run('docker', 'version', '--format', '{{json .Server}}', timeout=300)
            return copy.deepcopy(self.states)
        self.scope.snapshot = snapshot
        self.receipt()
        self.assertIs(self.d.run, original_run)
        self.assertTrue(all(0 < kwargs['timeout'] <= 20 for _, kwargs in self.commands))

    def test_current_manifest_or_final_snapshot_change_is_rejected(self):
        (self.release / 'release-manifest.json').write_bytes(raw({'commit': 'f' * 40}))
        with self.assertRaisesRegex(RuntimeError, 'MANIFEST'):
            self.receipt()
        (self.release / 'release-manifest.json').write_bytes(self.manifest)
        after = copy.deepcopy(self.states)
        after['api']['startedAtSha256'] = 'f' * 64
        self.scope.snapshot = mock.Mock(side_effect=[copy.deepcopy(self.states), after])
        with self.assertRaisesRegex(RuntimeError, 'CURRENT_MOVED'):
            self.receipt()

    def test_explicit_api_inspect_never_accepts_a_foreign_container(self):
        row = json.loads(self.inspect[self.states['api']['containerId']])[0]
        row['Id'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'INSPECT_IDENTITY'):
            m.probe(P, QUALITY, EXPECTED, context=self.context,
                inspect_version=lambda *_: (0, json.dumps([row])), boot_id_bytes=BOOT)

    def test_total_deadline_stops_version_enumeration(self):
        count = iter((0, 0, 0, 0, 361))
        with self.assertRaisesRegex(RuntimeError, 'DEADLINE'):
            self.receipt(clock=lambda: next(count, 361))
        self.assertLessEqual(len(self.version_calls), 1)

    def test_failed_versions_are_safe_and_authority_stays_false(self):
        self.api = lambda *_: (1, SECRET)
        value = self.receipt()
        m.validate_receipt(value, P, QUALITY, EXPECTED)
        self.assertEqual(value['configuration']['api']['failedApiVersions'], list(m.api_versions(self.server)))
        self.assertNotIn(SECRET, raw(value).decode())

    def test_existing_environment_digest_sorts_but_complete_configuration_keeps_order(self):
        old = copy.deepcopy(self.body)
        old['Config']['Env'] = sorted(old['Config']['Env'])
        for state in self.contract['services'].values():
            state['configurationSha256'] = m.fingerprint(old)
        def inspect_version(cid, _version, _timeout):
            state = next(row for row in self.states.values() if row['containerId'] == cid)
            return 0, json.dumps([{'Id': cid, 'Image': state['image'], **old}])
        value = m.probe(P, QUALITY, EXPECTED, context=self.context, inspect_version=inspect_version, boot_id_bytes=BOOT)
        m.validate_receipt(value, P, QUALITY, EXPECTED)
        self.assertEqual(value['configuration']['api']['matchingApiVersions'], list(m.api_versions(self.server)))
        self.assertNotEqual(value['configuration']['api']['currentSha256'], m.fingerprint(old))
        self.assertEqual(self.body['Config']['Env'], ['B=' + SECRET, 'A=fixture'])
        self.assertIs(value['qualified'], False)

    def test_closed_receipt_refuses_raw_values_authority_or_unsafe_metadata(self):
        value = self.receipt()
        alterations = [('Env', [SECRET]), ('qualified', True), ('productionAuthority', True), ('businessActions', 1)]
        for key, bad in alterations:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_receipt({**value, key: bad}, P, QUALITY, EXPECTED)
        value['configuration']['api']['startedAtChanged'] = True
        with self.assertRaises(RuntimeError):
            m.validate_receipt(value, P, QUALITY, EXPECTED)

    def test_dns_receipt_cannot_admit_other_fields_nonempty_values_or_duplicate_paths(self):
        value = self.receipt()
        facts = value['configuration']['api']
        for changes in ([{'path': 'HostConfig.OtherArray', 'operation': 'empty_dns_representation', 'value': None}],
                        [{'path': 'HostConfig.Dns', 'operation': 'empty_dns_representation', 'value': ['192.0.2.1']}],
                        [{'path': 'HostConfig.Dns', 'operation': 'empty_dns_representation', 'value': None}] * 2):
            with self.subTest(changes=changes):
                facts['matchingDnsRepresentations'] = [{'sha256': facts['expectedSha256'], 'changes': changes}]
                with self.assertRaisesRegex(RuntimeError, 'RECEIPT_DNS_MATCH'):
                    m.validate_receipt(value, P, QUALITY, EXPECTED)

    def test_native_bytes_are_closed_and_bound_to_exact_command(self):
        native = self.native()
        m.validate_native(raw(native), COMMAND)
        for key, bad in (('HostConfig', {'secret': SECRET}), ('ResponseCode', False),
                ('Comment', SECRET), ('StandardErrorContent', SECRET), ('StandardOutputUrl', 'https://foreign.invalid'),
                ('ExecutionElapsedTime', SECRET), ('InstanceId', 'i-foreign'), ('StatusDetails', SECRET)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.validate_native(raw({**native, key: bad}), COMMAND)
        with self.assertRaises(RuntimeError):
            m.closed(b'{"same":1,"same":2}')
        with self.assertRaises(RuntimeError):
            m.closed(b'{"number":NaN}')

    def test_native_optional_empty_group_and_iso_duration_are_safe(self):
        native = self.native()
        native['CloudWatchOutputConfig'] = {'CloudWatchOutputEnabled': False}
        native['ExecutionElapsedTime'] = 'PT1M1.234S'
        m.validate_native(raw(native), COMMAND)
        native['CloudWatchOutputConfig'] = {'CloudWatchOutputEnabled': 0}
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_METADATA'):
            m.validate_native(raw(native), COMMAND)


class SelectionAndSourceTests(unittest.TestCase):
    def test_existing_none_policy_accepts_only_the_separately_guarded_diagnostic(self):
        env = {'PATH': os.environ['PATH'], 'RELEASE_OPERATION': m.OPERATION, 'HISTORICAL_EXCEPTION': 'none',
            'RELEASE_COMMIT': P['commit'], 'EXPECTED_CURRENT': EXPECTED, 'GITHUB_REF': 'refs/heads/main'}
        result = subprocess.run(['bash', 'scripts/production-release/validate-release-selection.sh'],
            cwd=ROOT, env=env, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)

    def test_remote_main_is_checked_without_a_mutating_git_operation(self):
        answers = [P['commit'].encode(), P['sourceTree'].encode(), b'',
                   (P['commit'] + '\trefs/heads/main').encode()]
        with mock.patch.object(m, 'command_raw', side_effect=answers) as command:
            m.verify_main(P)
        self.assertEqual([call.args for call in command.call_args_list], [
            ('git', 'rev-parse', 'HEAD'), ('git', 'rev-parse', 'HEAD^{tree}'),
            ('git', 'status', '--porcelain', '--untracked-files=all'), ('git', 'ls-remote', 'origin', 'refs/heads/main')])
        with mock.patch.object(m, 'command_raw', side_effect=[*answers[:3], ('f' * 40 + '\trefs/heads/main').encode()]):
            with self.assertRaisesRegex(RuntimeError, 'STALE_MAIN'):
                m.verify_main(P)

    def test_selection_is_main_quality_and_readonly_only(self):
        env = {'RELEASE_OPERATION': m.OPERATION, 'GITHUB_ACTIONS': 'true', 'GITHUB_REF': 'refs/heads/main',
            'AWS_REGION': m.REGION, 'PRODUCTION_INSTANCE_ID': m.INSTANCE, 'RELEASE_COMMIT': P['commit'],
            'SOURCE_TREE': P['sourceTree'], 'GITHUB_RUN_ID': P['workflowRunId'],
            'GITHUB_RUN_ATTEMPT': P['workflowRunAttempt'], 'QUALITY_RUN_ID': QUALITY, 'EXPECTED_CURRENT': EXPECTED}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(m.selection(), (P, QUALITY, EXPECTED))
        for key, bad in (('GITHUB_REF', 'refs/heads/feature'), ('API_FAULT_RESTORE_APPROVED', 'true'),
                ('HISTORICAL_EXCEPTION', 'legacy'), ('REUSE_IMAGE_RUN', '1'), ('DIAGNOSTIC_COMMAND_ID', COMMAND),
                ('CACHE_PLAN_SHA256', 'f' * 64), ('QUALITY_RUN_ID', '')):
            with self.subTest(key=key), mock.patch.dict(os.environ, {**env, key: bad}, clear=True), self.assertRaises(RuntimeError):
                m.selection()

    def test_source_pinned_program_and_parameters_are_credential_free(self):
        params, program = m.parameters(P, QUALITY, EXPECTED)
        self.assertLess(len(raw(params)), 20 * 1024)
        bootstrap = shlex.split(params['commands'][0])
        self.assertEqual(bootstrap[:3], ['python3', '-B', '-c'])
        self.assertNotIn(SECRET, program.decode())
        self.assertIn("'remote'", program.decode())
        self.assertNotIn("'release'", program.decode())
        self.assertIn('False)', program.decode())
        for name in (*CORE.HELPERS, m.NAME):
            self.assertIn(repr(name), program.decode())
            self.assertIn(m.digest(PATH.with_name(name).read_bytes()), program.decode())
        self.assertEqual(params['executionTimeout'], ['900'])
        self.assertIn(m.digest(program), bootstrap[3])


class TransportTests(Fixture):
    def prepare(self, *, lost=False, failed=False, foreign=False):
        self.cwd = Path.cwd()
        os.chdir(self.folder)
        self.addCleanup(os.chdir, self.cwd)
        self.params = {'commands': ['python3 -B -c OFFLINE_FIXED_SOURCE'], 'executionTimeout': ['900']}
        self.source = b'OFFLINE_FIXED_SOURCE'
        self.calls = []
        native = self.native()
        if failed:
            native['Status'] = 'Failed'
            native['StandardErrorContent'] = SECRET
        original = {'CommandId': COMMAND, 'InstanceIds': [m.INSTANCE], 'Targets': [],
            'DocumentName': 'AWS-RunShellScript', 'Comment': m.COMMENT, 'Parameters': self.params}
        if foreign:
            original['Parameters'] = {'commands': [SECRET]}
        def command(*args, **kwargs):
            self.calls.append(args)
            if 'send-command' in args:
                if lost:
                    raise RuntimeError('OFFLINE_LOST_RESPONSE')
                return COMMAND.encode()
            if 'get-command-invocation' in args:
                return raw(native)
            if 'list-commands' in args:
                return raw({'Commands': [original]})
            raise AssertionError('No other AWS or Git action is permitted in mocked transport')
        for patch in (mock.patch.object(m, 'selection', return_value=(P, QUALITY, EXPECTED)),
                      mock.patch.object(m, 'verify_main'),
                      mock.patch.object(m, 'parameters', return_value=(self.params, self.source)),
                      mock.patch.object(m, 'command_raw', side_effect=command)):
            patch.start()
            self.addCleanup(patch.stop)
        return self.folder / '.deploy/production-release'

    def test_accepted_command_resume_never_sends_again(self):
        folder = self.prepare()
        with mock.patch('sys.stdout', new=io.StringIO()):
            m.transport()
            m.transport()
        self.assertEqual(sum('send-command' in args for args in self.calls), 1)
        self.assertEqual(sum('get-command-invocation' in args for args in self.calls), 2)
        self.assertEqual(sum('list-commands' in args for args in self.calls), 2)
        for path in folder.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertNotIn(SECRET, path.read_text())
        self.assertTrue((folder / (m.PREFIX + '-native.json')).exists())
        self.assertTrue((folder / (m.PREFIX + '-original-parameters.json')).exists())

    def test_deploy_parent_symlink_is_rejected_before_any_send(self):
        self.prepare()
        target = self.folder / 'preserved-other-directory'
        target.mkdir()
        (self.folder / '.deploy').symlink_to(target, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            m.transport()
        self.assertEqual(list(target.iterdir()), [])
        self.assertFalse(self.calls)

    def test_pending_accepted_command_is_only_polled(self):
        self.prepare()
        original = m.command_raw
        pending = [True]
        def read(*args, **kwargs):
            if 'get-command-invocation' in args and pending:
                pending.pop()
                self.calls.append(args)
                return raw({'CommandId': COMMAND, 'InstanceId': m.INSTANCE,
                            'DocumentName': 'AWS-RunShellScript', 'Status': 'InProgress'})
            return original(*args, **kwargs)
        with mock.patch.object(m, 'command_raw', side_effect=read), mock.patch.object(m.time, 'sleep') as sleep, mock.patch('sys.stdout', new=io.StringIO()):
            m.transport()
        self.assertEqual(sum('send-command' in args for args in self.calls), 1)
        self.assertEqual(sum('get-command-invocation' in args for args in self.calls), 2)
        sleep.assert_called_once_with(5)

    def test_unknown_send_is_preserved_and_cannot_duplicate(self):
        folder = self.prepare(lost=True)
        with self.assertRaisesRegex(RuntimeError, 'OFFLINE_LOST_RESPONSE'):
            m.transport()
        self.assertTrue((folder / (m.PREFIX + '-send-intent.json')).exists())
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_SEND_RECONCILIATION_REQUIRED'):
            m.transport()
        self.assertEqual(sum('send-command' in args for args in self.calls), 1)

    def test_failed_native_keeps_only_digest_and_safe_status(self):
        folder = self.prepare(failed=True)
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_FAILED'):
            m.transport()
        self.assertTrue((folder / (m.PREFIX + '-failure.json')).exists())
        self.assertFalse((folder / (m.PREFIX + '-native.json')).exists())
        self.assertNotIn(SECRET, ''.join(path.read_text() for path in folder.iterdir()))

    def test_original_ssm_parameters_are_checked_before_native_is_saved(self):
        folder = self.prepare(foreign=True)
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_PARAMETERS'):
            m.transport()
        self.assertFalse((folder / (m.PREFIX + '-native.json')).exists())
        self.assertNotIn(SECRET, ''.join(path.read_text() for path in folder.iterdir()))

    def test_changed_accepted_context_or_source_never_sends(self):
        folder = self.prepare()
        with mock.patch('sys.stdout', new=io.StringIO()):
            m.transport()
        with mock.patch.object(m, 'parameters', return_value=(self.params, b'CHANGED_OFFLINE_SOURCE')):
            with self.assertRaisesRegex(RuntimeError, 'ACCEPTED_SOURCE'):
                m.transport()
        self.assertEqual(sum('send-command' in args for args in self.calls), 1)


class WorkflowTests(unittest.TestCase):
    def test_workflow_diagnostic_inherits_all_gates_and_no_write_steps(self):
        script = r"""
const fs = require('node:fs');
const cp = require('node:child_process');
const yaml = require('js-yaml');
const current = yaml.load(fs.readFileSync('.github/workflows/production-release.yml', 'utf8'));
// The reviewed predecessor is immutable; HEAD already includes this addition in PR and main CI.
const old = yaml.load(cp.execFileSync('git', ['show', 'e90f02a65cdf63b656e82eed6e25fd8a68a21b7b:.github/workflows/production-release.yml'], {encoding: 'utf8'}));
const operation = 'diagnose_unpublished_component_runtime';
const inputs = new Proxy({operation, historical_exception: 'none', reuse_image_run: ''}, {get: (v, k) => v[k] ?? ''});
const always = () => true;
const startsWith = (v, p) => v.startsWith(p);
const steps = current.jobs.release.steps;
const stepContext = new Proxy({}, {get: () => ({outcome: 'failure'})});
const enabled = steps.filter(s => !s.if || Function('inputs', 'always', 'startsWith', 'failure', 'steps', 'return (' + s.if + ')')(inputs, always, startsWith, () => true, stepContext));
const changed = steps.filter(s => old.jobs.release.steps.some(o => o.name === s.name && JSON.stringify(o) !== JSON.stringify(s))).map(s => s.name);
console.log(JSON.stringify({concurrency: current.concurrency, oldConcurrency: old.concurrency,
 jobIf: current.jobs.release.if, permissions: current.permissions, oldPermissions: old.permissions,
 jobEnv: current.jobs.release.env, oldJobEnv: old.jobs.release.env,
 options: current.on.workflow_dispatch.inputs.operation.options,
 oldOptions: old.on.workflow_dispatch.inputs.operation.options,
 oldStepsRetained: old.jobs.release.steps.every(o => steps.some(s => s.name === o.name)), changed,
 added: steps.filter(s => !old.jobs.release.steps.some(o => o.name === s.name)), enabled}));
"""
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['concurrency'], value['oldConcurrency'])
        self.assertEqual(value['concurrency'], {'group': 'id-business-v2-production-release', 'cancel-in-progress': False})
        self.assertEqual(value['permissions'], value['oldPermissions'])
        self.assertEqual(value['jobIf'], "github.ref == 'refs/heads/main'")
        self.assertEqual(value['jobEnv'].pop('TZ'), 'Asia/Kuala_Lumpur')
        self.assertEqual(value['jobEnv'], value['oldJobEnv'])
        self.assertEqual(value['options'], value['oldOptions'][:2] + [m.OPERATION] + value['oldOptions'][2:])
        self.assertTrue(value['oldStepsRetained'])
        self.assertEqual(value['changed'], ['Verify read-only SSM command access'])
        self.assertEqual(len(value['added']), 2)
        names = [step['name'] for step in value['enabled']]
        self.assertIn('Verify exact source and passing Quality Gate', names)
        self.assertIn('Validate release policy and reviewed seal selection', names)
        self.assertIn('Obtain short-lived AWS credentials through OIDC', names)
        self.assertIn('Check AWS identity and production target', names)
        self.assertNotIn('Verify read-only SSM command access', names)
        self.assertEqual(len(value['enabled']), 8, names)
        diagnostic = next(step for step in value['added'] if 'run' in step)
        self.assertEqual(diagnostic['run'], 'python3 -B scripts/production-release/' + m.NAME + ' diagnose')
        self.assertEqual(diagnostic['timeout-minutes'], 18)
        artifact = next(step for step in value['added'] if 'uses' in step)
        self.assertEqual(artifact['uses'], 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
        self.assertEqual(len(artifact['with']['path'].splitlines()), 8)
        self.assertTrue(all(line.startswith('.deploy/production-release/' + m.PREFIX + '-')
                            and '*' not in line for line in artifact['with']['path'].splitlines()))


if __name__ == '__main__':
    unittest.main()
