"""The service credential exception must not hide unrelated runtime changes."""
import copy
import importlib.util
import json
import shutil
import stat
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

path = Path(__file__).with_name('gpt-recharge-release.py')
spec = importlib.util.spec_from_file_location('gpt_publisher', path)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class Inspector:
    def __init__(self, environment):
        self.value = {'Config': {'Hostname': 'api-1', 'Image': 'api:before',
                                'Env': environment, 'Labels': {'com.docker.compose.service': 'api'}},
                      'HostConfig': {'Binds': ['/data:/data:rw'], 'NetworkMode': 'default'},
                      'Mounts': [{'Destination': '/data', 'Source': '/volume/data'}]}

    def run(self, *args):
        return json.dumps([copy.deepcopy(self.value)])


class RuntimePreservation(unittest.TestCase):
    def setUp(self):
        (path.parents[2] / '.deploy').mkdir(exist_ok=True)

    def fingerprint(self, env, allowed=True):
        return publisher.configuration(Inspector(env), {'containerId': 'api', 'reference': 'api:before'}, allowed)

    def test_only_two_new_service_variables_are_exempt(self):
        before = ['DATABASE_URL=synthetic', 'AUTH_SECRET=synthetic']
        self.assertEqual(self.fingerprint(before), self.fingerprint(before + [
            'ONLINE_RECHARGE_VENDURE_KEY=synthetic', 'ONLINE_RECHARGE_VENDURE_SOURCE_IPS=192.0.2.5']))

    def test_other_credentials_and_source_configuration_remain_protected(self):
        before = ['DATABASE_URL=synthetic', 'AUTH_SECRET=synthetic']
        self.assertNotEqual(self.fingerprint(before), self.fingerprint(['DATABASE_URL=changed', 'AUTH_SECRET=synthetic']))
        self.assertNotEqual(self.fingerprint(before), self.fingerprint(before + ['OTHER_SERVICE_KEY=synthetic']))

    def test_preserved_service_does_not_receive_the_api_exception(self):
        self.assertNotEqual(self.fingerprint([], False), self.fingerprint(['ONLINE_RECHARGE_VENDURE_KEY=synthetic'], False))

    def test_inherited_environment_and_compose_links_are_detached_before_any_write(self):
        output = path.parents[2] / '.deploy'
        with tempfile.TemporaryDirectory(dir=output) as directory:
            root = Path(directory)
            previous, shared, target = root / 'previous', root / 'shared', root / 'candidate'
            previous.mkdir()
            shared.mkdir()
            for name in ('.env.aws.production', 'compose.release.json'):
                (shared / name).write_text('synthetic original ' + name)
                (previous / name).symlink_to(shared / name)
            shutil.copytree(previous, target, symlinks=True)
            publisher.copy_private_configuration(previous, target)
            for name in ('.env.aws.production', 'compose.release.json'):
                with self.subTest(name=name):
                    self.assertFalse((target / name).is_symlink())
                    self.assertEqual(stat.S_IMODE((target / name).stat().st_mode), 0o600)
                    self.assertEqual((target / name).read_bytes(), (shared / name).read_bytes())
                    (target / name).write_text('synthetic candidate only')
                    self.assertEqual((shared / name).read_text(), 'synthetic original ' + name)
                    self.assertTrue((previous / name).is_symlink())

    def test_regular_configuration_is_also_private_and_preserves_original_bytes(self):
        output = path.parents[2] / '.deploy'
        with tempfile.TemporaryDirectory(dir=output) as directory:
            previous, target = Path(directory) / 'previous', Path(directory) / 'candidate'
            previous.mkdir()
            for name in ('.env.aws.production', 'compose.release.json'):
                (previous / name).write_text('synthetic original')
            shutil.copytree(previous, target, symlinks=True)
            publisher.copy_private_configuration(previous, target)
            for name in ('.env.aws.production', 'compose.release.json'):
                (target / name).write_text('synthetic candidate')
                self.assertEqual((previous / name).read_text(), 'synthetic original')
                self.assertEqual(stat.S_IMODE((target / name).stat().st_mode), 0o600)

    def test_unexpected_candidate_link_is_rejected_without_writing_its_target(self):
        output = path.parents[2] / '.deploy'
        with tempfile.TemporaryDirectory(dir=output) as directory:
            root = Path(directory)
            previous, target = root / 'previous', root / 'candidate'
            previous.mkdir()
            target.mkdir()
            external = root / 'other-owner'
            external.write_text('protected original')
            (previous / '.env.aws.production').write_text('protected original')
            (target / '.env.aws.production').symlink_to(external)
            with self.assertRaisesRegex(RuntimeError, 'CONFIGURATION_LINK_CHANGED'):
                publisher.copy_private_configuration(previous, target)
            self.assertEqual(external.read_text(), 'protected original')
            self.assertTrue((target / '.env.aws.production').is_symlink())

    def test_switch_failure_closes_fence_and_retains_maintenance(self):
        events = []
        fence = SimpleNamespace(close=lambda: events.append('closed'))
        controls = SimpleNamespace(release_markers=lambda marker: events.append('released'))
        output = path.parents[2] / '.deploy'
        output.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            stage = Path(directory)
            with self.assertRaisesRegex(RuntimeError, 'synthetic startup failure'):
                with publisher.guarded_switch(fence, {}, controls, stage, {'commit': 'synthetic'}):
                    raise RuntimeError('synthetic startup failure')
            receipt = json.loads((stage / 'switch-recovery.json').read_text())
            self.assertEqual(events, ['closed'])
            self.assertTrue(receipt['maintenanceHeld'])
            self.assertFalse(receipt['rollbackPerformed'])

    def test_success_releases_maintenance_only_after_fence_closes(self):
        events = []
        fence = SimpleNamespace(close=lambda: events.append('closed'))
        controls = SimpleNamespace(release_markers=lambda marker: events.append('released'))
        with publisher.guarded_switch(fence, {}, controls, path.parent, {'commit': 'synthetic'}):
            events.append('healthy')
        self.assertEqual(events, ['healthy', 'closed', 'released'])


if __name__ == '__main__':
    unittest.main()
