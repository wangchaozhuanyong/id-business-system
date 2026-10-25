"""Offline files and Docker fixtures only; never contacts production or Docker."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('online-profile-lock-recovery.py')
p = load('online-checkout-release.py')
BASE = HERE.parents[1] / '.runtime/profile-lock-recovery-20261025/tests'


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        BASE.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=BASE)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.volume = self.root / 'volume'
        self.profile = self.volume / 'browser-profiles' / ('a' * 64)
        self.profile.mkdir(parents=True, mode=0o700)
        self.profile.parent.chmod(0o700)
        self.container_id = 'b' * 64
        self.container = {'Id': self.container_id,
            'State': {'Status': 'exited', 'Running': False, 'Pid': 0, 'Paused': False, 'Restarting': False},
            'Config': {'Hostname': 'b' * 12, 'Env': [], 'Labels': {
                'com.docker.compose.project': 'synthetic-project', 'com.docker.compose.service': 'online-recharge'}},
            'Mounts': [{'Type': 'volume', 'Name': 'synthetic_online_recharge_data',
                        'Source': str(self.volume), 'Destination': r.RUNTIME, 'RW': True}]}
        self.containers = [self.container]
        self.volume_info = {'Name': 'synthetic_online_recharge_data', 'Driver': 'local', 'Scope': 'local',
                            'Options': None, 'Mountpoint': str(self.volume), 'Labels': {
                                'com.docker.compose.volume': 'online_recharge_data',
                                'com.docker.compose.project': 'synthetic-project'}}
        self.d = SimpleNamespace(run=Mock(side_effect=self.docker_run), compose=Mock())
        self.lock = (self.root / '.deploy.lock').open('a')
        self.addCleanup(self.lock.close)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.proc = patch.object(r, 'no_browser_writers').start()
        patch.dict(r.os.environ, DOCKER_HOST='', DOCKER_TLS_VERIFY='').start()
        self.addCleanup(patch.stopall)

    def docker_run(self, *command, **kwargs):
        self.assertEqual(kwargs, {'timeout': 5})
        if command == ('docker', 'context', 'inspect'):
            return json.dumps([{'Endpoints': {'docker': {'Host': 'unix:///var/run/docker.sock'}}}])
        if command[:3] == ('docker', 'volume', 'inspect'):
            return json.dumps([self.volume_info])
        if command == ('docker', 'ps', '-aq', '--no-trunc'):
            return '\n'.join(item['Id'] for item in self.containers)
        self.assertEqual(command[:2], ('docker', 'inspect'))
        return json.dumps([next(item for item in self.containers if item['Id'] == name)
                           for name in command[2:]])

    def native_links(self, directory=None, host='012345abcdef'):
        directory = directory or self.profile
        for name, value in zip(r.NAMES, (host + '-2426', 'synthetic-native-cookie', '/tmp/old-container/SingletonSocket')):
            (directory / name).symlink_to(value)

    def recover(self):
        return r.recover(self.d, self.container_id, self.lock)

    def untouched(self):
        self.assertTrue((self.profile / 'SingletonLock').is_symlink())
        self.assertFalse((self.profile / '.retired-singletons').exists())

    def test_retired_container_links_are_archived_and_all_profile_data_is_unchanged(self):
        self.native_links()
        data = {'Default/Cookies': b'synthetic-session-database',
                'Default/Local Storage/state': b'synthetic-local-storage',
                '.active-profile.json': b'{"profile":"synthetic-selection"}',
                'Exit-fixture/Cookies': b'synthetic-previous-partition'}
        for name, raw in data.items():
            file = self.profile / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(raw)
        receipt = self.recover()
        self.assertEqual(receipt, {'version': 1, 'profilesExamined': 1, 'profilesRecovered': 1,
                                  'lockEntriesArchived': 3, 'profileDataModified': False})
        archives = list((self.profile / '.retired-singletons').iterdir())
        self.assertEqual(len(archives), 1)
        self.assertEqual({item.name for item in archives[0].iterdir()}, set(r.NAMES))
        self.assertEqual(archives[0].stat().st_mode & 0o777, 0o700)
        self.assertEqual(os.readlink(archives[0] / 'SingletonLock'), '012345abcdef-2426')
        for name, raw in data.items():
            self.assertEqual((self.profile / name).read_bytes(), raw)
        self.assertEqual(self.recover()['profilesRecovered'], 0, 'repeated preparation does not repeat recovery')
        self.assertEqual(len(list((self.profile / '.retired-singletons').iterdir())), 1)

    def test_running_executor_cannot_be_recovered(self):
        self.native_links()
        self.container['State'].update(Status='running', Running=True, Pid=2426)
        with self.assertRaisesRegex(RuntimeError, 'EXECUTOR_NOT_STOPPED'):
            self.recover()
        self.untouched()

    def test_remote_daemon_and_wrong_volume_labels_are_rejected(self):
        self.native_links()
        with patch.dict(r.os.environ, DOCKER_HOST='tcp://synthetic-remote:2376'):
            with self.assertRaisesRegex(RuntimeError, 'DAEMON_NOT_LOCAL'):
                self.recover()
        self.volume_info['Labels']['com.docker.compose.volume'] = 'unrelated_data'
        with self.assertRaisesRegex(RuntimeError, 'VOLUME_IDENTITY_INVALID'):
            self.recover()
        self.untouched()

    def test_api_shared_volume_must_also_be_stopped_before_recovery(self):
        self.native_links()
        api = copy.deepcopy(self.container)
        api['Id'] = 'c' * 64
        api['Config']['Hostname'] = 'c' * 12
        api['Config']['Labels']['com.docker.compose.service'] = 'api'
        api['Mounts'][0]['Destination'] = '/app/.runtime/online-recharge'
        api['State'].update(Status='running', Running=True, Pid=55)
        self.containers.append(api)
        with self.assertRaisesRegex(RuntimeError, 'VOLUME_IN_USE'):
            self.recover()
        self.untouched()
        api['State'] = copy.deepcopy(self.container['State'])
        self.assertEqual(self.recover()['profilesRecovered'], 1)

    def test_running_paused_or_restarting_volume_users_block_recovery(self):
        self.native_links()
        for state in ({'Status': 'running', 'Running': True, 'Pid': 55},
                      {'Status': 'exited', 'Running': False, 'Pid': 0, 'Paused': True},
                      {'Status': 'exited', 'Running': False, 'Pid': 0, 'Restarting': True}):
            other = copy.deepcopy(self.container)
            other['Id'] = 'c' * 64
            other['State'].update(state)
            self.containers = [self.container, other]
            with self.assertRaisesRegex(RuntimeError, 'VOLUME_IN_USE'):
                self.recover()
            self.untouched()

    def test_host_bind_alias_and_shared_project_cannot_bypass_volume_exclusivity(self):
        self.native_links()
        other = copy.deepcopy(self.container)
        other['Id'] = 'c' * 64
        other['Mounts'] = [{'Type': 'bind', 'Source': str(self.volume.parent), 'Destination': '/alias'}]
        other['State'].update(Status='running', Running=True, Pid=55)
        self.containers.append(other)
        with self.assertRaisesRegex(RuntimeError, 'VOLUME_IN_USE'):
            self.recover()
        other['State'] = copy.deepcopy(self.container['State'])
        other['Config']['Labels']['com.docker.compose.project'] = 'unrelated-project'
        with self.assertRaisesRegex(RuntimeError, 'VOLUME_SHARED'):
            self.recover()
        self.untouched()

    def test_remote_volumes_and_custom_profile_roots_are_not_automatically_repaired(self):
        self.native_links()
        for key, value in [('Driver', 'nfs'), ('Scope', 'global'), ('Options', {'type': 'nfs'})]:
            before = copy.deepcopy(self.volume_info)
            self.volume_info[key] = value
            with self.assertRaisesRegex(RuntimeError, 'VOLUME_NOT_LOCAL'):
                self.recover()
            self.volume_info = before
        self.container['Config']['Env'] = ['ONLINE_RECHARGE_PROFILE_ROOT=/some/other/project']
        with self.assertRaisesRegex(RuntimeError, 'CUSTOM_ROOT_UNSUPPORTED'):
            self.recover()
        self.untouched()

    def test_known_stopped_custom_hostname_is_supported_but_unknown_remote_hostname_is_not(self):
        self.container['Config']['Hostname'] = 'dedicated-stopped-engine'
        self.native_links(host='dedicated-stopped-engine')
        self.assertEqual(self.recover()['profilesRecovered'], 1)
        self.native_links(host='unknown-remote-host')
        with self.assertRaisesRegex(RuntimeError, 'LOCK_OWNER_UNKNOWN'):
            self.recover()
        self.assertTrue((self.profile / 'SingletonLock').is_symlink())

    def test_existing_container_identity_cannot_be_inferred_dead_from_a_local_pid(self):
        self.native_links(host='c' * 12)
        other = copy.deepcopy(self.container)
        other.update(Id='c' * 64, Mounts=[])
        other['Config']['Hostname'] = 'c' * 12
        other['State'].update(Status='running', Running=True, Pid=999)
        self.containers.append(other)
        with self.assertRaisesRegex(RuntimeError, 'LOCK_OWNER_UNKNOWN'):
            self.recover()
        self.untouched()

    def test_regular_file_singleton_is_not_removed(self):
        self.native_links()
        (self.profile / 'SingletonCookie').unlink()
        (self.profile / 'SingletonCookie').write_bytes(b'synthetic-unknown-file')
        with self.assertRaisesRegex(RuntimeError, 'SINGLETON_TYPE_INVALID'):
            self.recover()
        self.untouched()

    def test_unheld_release_lock_is_rejected_before_any_docker_call(self):
        self.native_links()
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        with self.assertRaisesRegex(RuntimeError, 'RELEASE_LOCK_REQUIRED'):
            self.recover()
        self.d.run.assert_not_called()
        self.untouched()

    def test_invalid_profile_and_root_symlinks_are_not_followed(self):
        self.native_links()
        alias = self.profile.parent / ('d' * 64)
        alias.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'DIRECTORY_INVALID'):
            self.recover()
        self.untouched()
        alias.unlink()
        renamed = self.volume / 'other-profiles'
        self.profile.parent.rename(renamed)
        (self.volume / 'browser-profiles').symlink_to(renamed, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'ROOT_INVALID'):
            self.recover()

    def test_archive_symlink_cannot_redirect_writes(self):
        self.native_links()
        outside = self.root / 'untouched'
        outside.mkdir()
        (self.profile / '.retired-singletons').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'RECOVERY_UNCONFIRMED'):
            self.recover()
        self.assertEqual(list(outside.iterdir()), [])
        self.assertTrue((self.profile / 'SingletonLock').is_symlink())

    def test_invalid_later_profile_stops_the_whole_batch_before_mutation(self):
        self.native_links()
        other = self.profile.parent / ('f' * 64)
        other.mkdir(mode=0o700)
        self.native_links(other, host='remote-host-unknown')
        with self.assertRaisesRegex(RuntimeError, 'LOCK_OWNER_UNKNOWN'):
            self.recover()
        self.untouched()

    def test_same_mount_entries_in_a_different_docker_order_are_not_drift(self):
        self.native_links()
        self.container['Mounts'].append({'Type':'bind','Source':str(self.root/'unrelated-config'),
                                        'Destination':'/etc/synthetic-config','RW':False})
        original=r.inventory;calls=0
        def reordered(*args):
            nonlocal calls
            calls+=1
            if calls==2:self.container['Mounts'].reverse()
            return original(*args)
        with patch.object(r,'inventory',side_effect=reordered):
            self.assertEqual(self.recover()['lockEntriesArchived'],3)

    def test_changed_mount_permission_remains_real_drift_before_any_recovery(self):
        self.native_links()
        extra={'Type':'bind','Source':str(self.root/'unrelated-config'),
               'Destination':'/etc/synthetic-config','RW':False}
        self.container['Mounts'].append(extra)
        original=r.inventory;calls=0
        def changed(*args):
            nonlocal calls
            calls+=1
            if calls==2:extra['RW']=True
            return original(*args)
        with patch.object(r,'inventory',side_effect=changed):
            with self.assertRaisesRegex(RuntimeError,'HOST_INVENTORY_CHANGED'):self.recover()
        self.untouched()

    def test_inventory_drift_stops_before_mutation(self):
        self.native_links()
        original = r.inventory
        calls = 0
        def drift(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.container['Config']['Hostname'] = 'changed-stopped-container'
            return original(*args)
        with patch.object(r, 'inventory', side_effect=drift):
            with self.assertRaisesRegex(RuntimeError, 'HOST_INVENTORY_CHANGED'):
                self.recover()
        self.untouched()

    def test_same_link_contents_with_a_new_inode_is_drift(self):
        self.native_links()
        calls = 0
        def change(_directories):
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.profile / 'new-link').symlink_to('012345abcdef-2426')
                (self.profile / 'new-link').replace(self.profile / 'SingletonLock')
        self.proc.side_effect = change
        with self.assertRaisesRegex(RuntimeError, 'SINGLETON_CHANGED'):
            self.recover()
        self.untouched()

    def test_partial_move_failure_restores_original_links_and_never_projects_raw_error(self):
        self.native_links()
        rename = os.rename
        calls = 0
        def interrupted(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('synthetic-private-path-or-cookie-not-for-output')
            return rename(*args, **kwargs)
        with patch.object(r.os, 'rename', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, '^ONLINE_CHECKOUT_PROFILE_RECOVERY_UNCONFIRMED$'):
                self.recover()
        for name in r.NAMES:
            self.assertTrue((self.profile / name).is_symlink())

    def test_host_process_or_unreadable_evidence_blocks_before_archiving(self):
        self.native_links()
        self.proc.side_effect = r.Rejected('ONLINE_CHECKOUT_PROFILE_BROWSER_STILL_RUNNING')
        with self.assertRaisesRegex(RuntimeError, 'BROWSER_STILL_RUNNING'):
            self.recover()
        self.untouched()
        self.proc.side_effect = RuntimeError('synthetic-private-docker-or-process-output')
        with self.assertRaisesRegex(RuntimeError, '^ONLINE_CHECKOUT_PROFILE_RECOVERY_UNCONFIRMED$'):
            self.recover()
        self.untouched()
        self.proc.side_effect = PermissionError('synthetic-private-process')
        with self.assertRaisesRegex(RuntimeError, '^ONLINE_CHECKOUT_PROFILE_RECOVERY_UNCONFIRMED$'):
            self.recover()
        self.untouched()

    def test_publisher_stops_then_checks_and_recovers_then_checks_again(self):
        self.native_links()
        events = []
        self.d.compose.side_effect = lambda *a, **kw: events.append('stop:' + a[-1])
        fence = SimpleNamespace(check_idle=lambda: events.append('idle'), close=lambda: events.append('fence:closed'))
        recovery = SimpleNamespace(recover=lambda *a: (events.append('recover'), r.recover(*a))[1])
        result = p.stop_recharge_and_recover(self.d, self.root, {'online-recharge': {
            'containerId': self.container_id}}, self.lock, fence, recovery)
        self.assertEqual(events, ['stop:online-recharge', 'idle', 'stop:api', 'idle', 'fence:closed', 'recover'])
        self.assertEqual(result['profilesRecovered'], 1)
        self.assertEqual(self.d.compose.call_count, 2)

    def test_recovery_failure_never_proceeds_to_restart_and_unmeasured_helper_is_rejected(self):
        self.native_links(host='unknown-host')
        fence = SimpleNamespace(check_idle=Mock(), close=Mock())
        with self.assertRaisesRegex(RuntimeError, 'LOCK_OWNER_UNKNOWN'):
            p.stop_recharge_and_recover(self.d, self.root, {'online-recharge': {
                'containerId': self.container_id}}, self.lock, fence, r)
        self.assertEqual(self.d.compose.call_args.args[1:], ('stop', 'api'))
        self.assertEqual(self.d.compose.call_count, 2)
        for pins in ({}, {'online-profile-lock-recovery.py': 'f' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'PROFILE_RECOVERY_SOURCE_UNMEASURED'):
                p.profile_recovery_source({'controlSources': pins})
        module = p.profile_recovery_source({'controlSources': {
            'online-profile-lock-recovery.py': p.sha((HERE / 'online-profile-lock-recovery.py').read_bytes())}})
        self.assertTrue(callable(module.recover))


class ProcTests(unittest.TestCase):
    def test_host_cmdline_checks_both_flag_forms_without_signalling_processes(self):
        BASE.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=BASE) as directory:
            proc = Path(directory)
            (proc / 'self').mkdir()
            (proc / 'self/cmdline').write_bytes(b'synthetic-reader\0')
            (proc / '2426').mkdir()
            target = Path('/synthetic-volume/browser-profiles/' + 'a' * 64)
            for args in ((b'--user-data-dir=' + str(target).encode(),),
                         (b'--user-data-dir', (r.RUNTIME + '/browser-profiles/' + target.name).encode())):
                (proc / '2426/cmdline').write_bytes(b'chrome\0' + b'\0'.join(args) + b'\0')
                with patch.object(r, 'Path', side_effect=lambda value: proc if value == '/proc' else Path(value)):
                    with self.assertRaisesRegex(RuntimeError, 'BROWSER_STILL_RUNNING'):
                        r.no_browser_writers([target])
            (proc / '2426/cmdline').write_bytes(b'chrome\0--user-data-dir=/unrelated-project\0')
            with patch.object(r, 'Path', side_effect=lambda value: proc if value == '/proc' else Path(value)):
                r.no_browser_writers([target])


if __name__ == '__main__':
    unittest.main()
