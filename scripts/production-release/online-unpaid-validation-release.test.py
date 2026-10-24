"""Pure finite-publication checks; no service, network, database or payment calls."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('unpaid_release',HERE/'online-unpaid-validation-release.py')
p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
class FinitePublication(unittest.TestCase):
 def setUp(self):self.c=json.loads((HERE/p.CONTRACT_FILE).read_bytes())
 def test_exact_reviewed_batch(self):
  p.validate_contract(self.c)
  self.assertEqual(len(self.c['sources']),35)
  self.assertEqual(self.c['updatedServices'],['api','admin','online-recharge'])
 def test_changed_sources_rejected(self):
  self.c['sources']['apps/api/src/id-business-v2/online-recharge/engine/payment-safety.cjs']='a'*64
  with self.assertRaises(RuntimeError):p.validate_contract(self.c)
 def test_dependency_and_migration_not_included(self):
  self.assertTrue(all(not n.endswith(('package.json','schema.prisma')) and '/migrations/' not in n for n in self.c['sources']))
 def test_identity_or_payment_action_rejected(self):
  for key,value in [('expectedCurrent','a'*40),('sourceReviewCommit','b'*40),('migrationPerformed',True),('businessActions',1)]:
   c=copy.deepcopy(self.c);c[key]=value
   with self.assertRaises(RuntimeError):p.validate_contract(c)
 def test_unmodified_engine_sources_preserved(self):
  for n,v in self.c['beforeEngineFiles'].items():
   if p.ENGINE+n not in self.c['sources']:self.assertEqual(self.c['afterEngineFiles'][n],v)
 def test_engine_deletion_rejected(self):
  self.c['afterEngineFiles'].pop(next(iter(self.c['beforeEngineFiles'])))
  with self.assertRaises(RuntimeError):p.validate_contract(self.c)
 def test_modules_not_broadened(self):
  self.c['apiModules'].append('auth/auth.service.js')
  with self.assertRaises(RuntimeError):p.validate_contract(self.c)
 def test_source_and_control_pins_match_saved_files(self):
  for n,v in self.c['controlPins'].items():self.assertEqual(p.sha((HERE/n).read_bytes()),v,n)
if __name__=='__main__':unittest.main()
