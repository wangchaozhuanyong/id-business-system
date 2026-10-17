"""Offline finite repair contract tests. Never contact a database or payment service."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retest_release',HERE/'online-checkout-retest-release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class RetestPublicationTests(unittest.TestCase):
    def setUp(self):
        self.contract=json.loads((HERE/r.CONTRACT_FILE).read_bytes())
    def test_exact_predecessor_and_single_api_module(self):
        r.validate_contract(self.contract)
        self.assertEqual(len(self.contract['sources']),24)
        self.assertEqual(len(self.contract['beforeEngineFiles']),88)
    def test_unreviewed_scope_cannot_enter_artifact(self):
        for name in ['apps/api/src/auth/auth.service.ts','apps/api/src/id-business-v2/online-recharge/unreviewed.ts','apps/api/prisma-mysql/schema.prisma','package-lock.json','docs/unreviewed.md']:
            c=copy.deepcopy(self.contract);c['sources'][name]='a'*64
            with self.assertRaises(RuntimeError):r.validate_contract(c)
    def test_wrong_baseline_missing_source_or_engine_deletion_stops(self):
        for kind in ['baseline','source','engine','module']:
            c=copy.deepcopy(self.contract)
            if kind=='baseline':c['expectedCurrent']='a'*40
            if kind=='source':c['sources'].pop(next(iter(c['sources'])))
            if kind=='engine':c['afterEngineFiles'].pop('worker.cjs')
            if kind=='module':c['apiModules'].append('auth/auth.service.js')
            with self.assertRaises(RuntimeError):r.validate_contract(c)
    def test_transitive_declaration_is_pinned_without_admitting_another_runtime_module(self):
        spec=importlib.util.spec_from_file_location('builder',HERE/'online-checkout-build.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
        modules={'id-business-v2/online-recharge/persistence/tasks.repository'+ext:'a'*64 for ext in ('.js','.js.map','.d.ts')}
        declarations=self.contract['apiDeclarationOnly'];after={**modules,**declarations}
        self.assertEqual(b.module_delta({},after,self.contract['apiModules'],declarations),after)
        with self.assertRaises(RuntimeError):b.module_delta({},after,self.contract['apiModules'])
        for extra in ['auth/unreviewed.d.ts','id-business-v2/online-recharge/unreviewed.js']:
            with self.assertRaises(RuntimeError):b.module_delta({}, {**after,extra:'b'*64},self.contract['apiModules'],declarations)
        with self.assertRaises(RuntimeError):b.module_delta({},after,self.contract['apiModules'],{n:'0'*64 for n in declarations})
    def test_passed_steps_are_reused_only_for_unchanged_inputs_and_exact_failed_build(self):
        spec=importlib.util.spec_from_file_location('retest_builder',HERE/'online-checkout-retest-build.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
        reuse=self.contract['validationReuse'];run={'id':int(reuse['runId']),'head_sha':reuse['commit'],'head_branch':'main','event':'workflow_dispatch','path':'.github/workflows/online-checkout-retest-validation.yml','status':'completed','conclusion':'failure'}
        jobs=[{'name':'validate','steps':[{'name':n,'conclusion':'success'} for n in b.REUSED_STEPS]+[{'name':'Reproduce current three roles and build only this repair','conclusion':'failure'}]}]
        self.assertTrue(b.validate_reuse(reuse,run,jobs,list(b.REUSE_CONTROLS)))
        with self.assertRaises(RuntimeError):b.validate_reuse(reuse,run,jobs,['apps/admin/src/v2/features/online-recharge/useOnlineTask.ts'])
        for key,value in [('head_sha','a'*40),('status','in_progress'),('conclusion','success')]:
            with self.assertRaises(RuntimeError):b.validate_reuse(reuse,{**run,key:value},jobs,[])
        broken=copy.deepcopy(jobs);broken[0]['steps'][0]['conclusion']='failure'
        with self.assertRaises(RuntimeError):b.validate_reuse(reuse,run,broken,[])
    def test_default_publisher_contract_stays_backward_compatible(self):
        spec=importlib.util.spec_from_file_location('original',HERE/'online-checkout-release.py');old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
        self.assertEqual(old.CONTRACT_FILE,'online-checkout-contract.json')
        self.assertEqual(old.SCOPE,'ONLINE_CHECKOUT_FORM_AND_VISIBILITY')
if __name__=='__main__':unittest.main()
