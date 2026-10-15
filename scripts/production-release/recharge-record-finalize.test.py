import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


finalize = load('finalize', 'recharge-record-finalize.py')
release = load('release', 'recharge-record-release.py')


class ExistingSwitchTests(unittest.TestCase):
    def test_only_image_and_release_paths_may_change_in_resolved_declarations(self):
        old = {'services': {'api': {'image': 'old:api', 'environment': {'fixture': 'same'},
                                   'build': {'context': '/previous/context'}},
                            'admin': {'image': 'preserved:admin'}}}
        new = copy.deepcopy(old)
        new['services']['api']['image'] = 'new:api'
        new['services']['api']['build']['context'] = '/target/context'
        d = Mock()
        d.compose.side_effect = [json.dumps(old), json.dumps(new)]
        self.assertEqual(finalize.declared_models(d, Path('/previous'), Path('/target'),
                                                 'old:api', 'new:api'), old)
        for key in ('environment', 'admin'):
            changed = copy.deepcopy(new)
            if key == 'environment':
                changed['services']['api']['environment']['fixture'] = 'changed'
            else:
                changed['services']['admin']['image'] = 'unexpected:admin'
            d.compose.side_effect = [json.dumps(old), json.dumps(changed)]
            with self.assertRaisesRegex(RuntimeError, 'DECLARED_CONFIGURATION_CHANGED'):
                finalize.declared_models(d, Path('/previous'), Path('/target'), 'old:api', 'new:api')
        self.assertTrue(all(call.args[1:] == ('config', '--format', 'json')
                            for call in d.compose.call_args_list))

    def test_completion_extracts_original_tail_and_never_replays_prior_switch(self):
        root = HERE.parents[1] / '.runtime'
        with tempfile.TemporaryDirectory(prefix='record-finalize-', dir=root) as directory:
            path = Path(directory) / 'controller.py'
            path.write_text("""def release():
    with lock:
        raise RuntimeError('must not replay switch')
        need(True, 'IMAGE_MISMATCH')
        return {'completed': True}
""")
            module = types.SimpleNamespace(__file__=str(path), need=finalize.need)
            call = finalize.finish_function(module)
            self.assertEqual(call(*([None] * 15)), {'completed': True})
            path.write_text('def release():\n    with lock:\n        pass\n')
            with self.assertRaisesRegex(RuntimeError, 'COMPLETION_SOURCE_CHANGED'):
                finalize.finish_function(module)

    def test_unstable_environment_order_and_compose_version_are_metadata_only(self):
        row = {'Config': {'Env': ['B=fixture2', 'A=fixture1'], 'Hostname': 'old',
                          'Image': 'old:api', 'Labels': {'com.docker.compose.version': 'old'}},
               'HostConfig': {'ReadonlyRootfs': True}, 'Mounts': []}
        d = Mock()
        d.run.return_value = json.dumps([row])
        before = release.configuration(d, {'containerId': 'fixture'})
        row['Config']['Env'].reverse()
        row['Config']['Labels']['com.docker.compose.version'] = 'new'
        row['Config']['Hostname'] = 'new'
        row['Config']['Image'] = 'new:api'
        d.run.return_value = json.dumps([row])
        self.assertEqual(before, release.configuration(d, {'containerId': 'fixture'}))
        row['HostConfig']['ReadonlyRootfs'] = False
        d.run.return_value = json.dumps([row])
        self.assertNotEqual(before, release.configuration(d, {'containerId': 'fixture'}))
        row['HostConfig']['ReadonlyRootfs'] = True
        row['Config']['Env'][0] = 'A=changed-value'
        d.run.return_value = json.dumps([row])
        self.assertNotEqual(before, release.configuration(d, {'containerId': 'fixture'}))


if __name__ == '__main__':
    unittest.main()
