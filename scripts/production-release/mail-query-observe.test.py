import ast
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('observe',Path(__file__).with_name('mail-query-observe.py'))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ReadOnlyScope(unittest.TestCase):
    def test_rejects_malformed_baselines_before_constructing_commands(self):
        for value in ('','main','a'*39,"a'*40; import os",'A'*40):
            with self.assertRaises(ValueError):module.source(value)
    def test_remote_program_has_no_filesystem_or_process_mutations(self):
        tree=ast.parse(module.source('a'*40))
        attributes={n.func.attr for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)}
        self.assertFalse(attributes & {'write_text','write_bytes','mkdir','unlink','rmdir','rename','replace','system','Popen','run'})
        calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id in ('run','compose')]
        compose=[n.args[0].value for n in calls if n.func.id=='compose']
        self.assertEqual(compose,['ps'])
        self.assertTrue(all(isinstance(n.args[0],ast.Constant) for n in calls))
        run_roots={n.args[0].value for n in calls if n.func.id=='run'}
        self.assertEqual(run_roots,{'docker'})
        literals={n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str)}
        self.assertFalse(literals & {'up','restart','stop','rm','prune','migrate'})

if __name__=='__main__':unittest.main()
