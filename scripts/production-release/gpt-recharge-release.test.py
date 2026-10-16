"""The service credential exception must not hide unrelated runtime changes."""
import copy
import importlib.util
import json
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
