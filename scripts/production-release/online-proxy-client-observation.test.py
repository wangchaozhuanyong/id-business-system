"""No AWS, DB, browser or real proxy: observation boundary regression."""
import hashlib,importlib.util,json
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('observe',HERE/'online-proxy-client-observation.py')
P=importlib.util.module_from_spec(spec);spec.loader.exec_module(P)
class ObservationTests(unittest.TestCase):
 def test_capture_uses_exact_deployed_proof(self):
  code=P.source('capture',P.PREDECESSOR);compile(code,'<capture>','exec')
  self.assertIn("'mode':'readback'",code)
  self.assertIn('h.snapshot',code)
  plan=json.loads((HERE/'online-proxy-client-parent-plan.json').read_bytes())
  self.assertEqual(plan['commit'],P.PREDECESSOR)
  self.assertEqual(plan['controlSources']['online-proxy-client-release.py'],hashlib.sha256((HERE/'online-proxy-client-release.py').read_bytes()).hexdigest())
  self.assertIn('ONLINE_PROXY_CLIENT_20261031_INDEPENDENT_READBACK_VERIFIED',code)
  self.assertNotIn('docker stop',code)
  with self.assertRaises(AssertionError):P.source('capture','a'*40)
 def test_comparison_is_bounded_and_never_reads_session(self):
  code=P.source('compare','b'*40);compile(code,'<compare>','exec')
  self.assertIn("runProxyClientDiagnostic({proxyConfig})",code)
  self.assertNotIn('sessionEncrypted',code)
  self.assertNotIn('onlineRechargeTask.create',code)
  self.assertNotIn('process.env.PROXY',code)
  self.assertIn("report['requestsIssued']<=5",code)
  self.assertIn("report['maximumDurationMs']==90000",code)
  self.assertIn("report['chatgptRequests']==0",code)
  self.assertNotIn('print(credentials',code)
 def test_only_named_modes_and_digest_are_admitted(self):
  for mode in ['payment','login','recharge']:
   with self.assertRaises(AssertionError):P.source(mode,'a'*40)
  self.assertEqual(P.DIAGNOSTIC_SHA,hashlib.sha256((HERE.parents[1]/'apps/api/src/id-business-v2/online-recharge/engine/proxy-client-diagnostic.cjs').read_bytes()).hexdigest())
 def test_workflow_preserves_existing_role_and_serializes_production(self):
  s=(HERE.parents[1]/'.github/workflows/online-proxy-client-observation.yml').read_text()
  self.assertIn('id-business-v2-production-release',s)
  self.assertIn('cancel-in-progress: false',s)
  self.assertIn('arn:aws:iam::098208446664:role/id-business-v2-github-release',s)
  self.assertNotIn('contents: write',s)
 def test_original_command_is_not_repeated_on_uncertainty(self):
  s=(HERE/'online-proxy-client-observation.py').read_text()
  self.assertIn('ORIGINAL_COMMAND_MUST_BE_RESOLVED',s)
  self.assertIn('ACCEPTANCE_UNCONFIRMED',s)
  self.assertIn('ORIGINAL_RESULT_PENDING_DO_NOT_REPEAT',s)
if __name__=='__main__':unittest.main()
