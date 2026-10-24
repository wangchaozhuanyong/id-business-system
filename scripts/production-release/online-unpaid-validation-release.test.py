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
  self.assertEqual(len(self.c['sources']),37)
  self.assertEqual(self.c['updatedServices'],['api','admin','online-recharge'])
 def test_changed_sources_rejected(self):
  self.c['sources']['apps/api/src/id-business-v2/online-recharge/engine/payment-safety.cjs']='a'*64
  with self.assertRaises(RuntimeError):p.validate_contract(self.c)
 def test_dependency_and_migration_not_included(self):
  self.assertTrue(all(not n.endswith(('package.json','schema.prisma')) and '/migrations/' not in n for n in self.c['sources']))
 def test_identity_or_payment_action_rejected(self):
  for key,value in [('expectedCurrent','a'*40),('sourceReviewCommit','b'*40),('migrationPerformed',True),('businessActions',1),('awsTargetAccount','079740175286'),('awsTargetInstance','i-05836da38606e633c')]:
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
 def test_indirect_declarations_cannot_include_executable_or_unrelated_files(self):
  self.c['apiDeclarationOnly']['auth/auth.service.js']='a'*64
  with self.assertRaises(RuntimeError):p.validate_contract(self.c)
 def test_observation_does_not_enter_a_build_or_publish_job(self):
  workflow=(HERE.parents[1]/'.github/workflows/online-unpaid-validation-publication.yml').read_text()
  self.assertIn('if: inputs.inspect_only',workflow)
  self.assertIn('&& !inputs.inspect_only',workflow)
  self.assertIn('publication.py observe',workflow)
 def test_control_publication_requires_authenticated_prior_source_qa_binding(self):
  q={'commit':'a'*40,'tree':'b'*40,'pullRequest':698,'sourceReviewCommit':p.SOURCE,'sourceReceiptSha256':'c'*64}
  with self.assertRaises(RuntimeError):p.verify_quality(q,q['commit'],q['tree'])
  q['sourceVerification']=self.c['sourceQuality'];p.verify_quality(q,q['commit'],q['tree'])
  q['sourceVerification']={**q['sourceVerification'],'head':'d'*40}
  with self.assertRaises(RuntimeError):p.verify_quality(q,q['commit'],q['tree'])
 def test_unknown_failure_never_outputs_raw_error_text(self):
  report=p.failure_report(ValueError('synthetic-private-message'),{'mode':'preflight','controlSources':{}})
  self.assertEqual(report['code'],'ONLINE_UNPAID_REMOTE_FAILED')
  self.assertNotIn('synthetic-private-message',str(report))
 def test_source_and_control_pins_match_saved_files(self):
  for n,v in self.c['controlPins'].items():self.assertEqual(p.sha((HERE/n).read_bytes()),v,n)
if __name__=='__main__':unittest.main()
