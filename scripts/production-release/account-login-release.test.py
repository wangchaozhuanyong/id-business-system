"""Reject drift, partial migrations, unrelated runtime outputs and failed index writes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / name)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

r = load('account-login-release.py')
b = load('account-login-build.py')
c = json.loads((HERE / 'account-login-contract.json').read_bytes())
TEST_TMP = HERE.parents[1] / '.runtime/account-login-release-tests'
TEST_TMP.mkdir(parents=True, exist_ok=True)

class AccountReleaseTests(unittest.TestCase):
    def test_source_and_reconstruction_hashes_are_frozen(self):
        for n, value in {**c['sources'], **c['supportSources']}.items():
            self.assertEqual(r.digest((HERE.parents[1] / n).read_bytes()), value)
        for n, value in c['recipeControls'].items():
            self.assertEqual(r.digest((HERE / n).read_bytes()), value)

    def test_api_delta_refuses_unrelated_runtime_and_deletion(self):
        name = 'id-business-v2/auto-recharge/account.js'
        before = {name:'a',name+'.map':'b',name[:-3]+'.d.ts':'c','other.js':'d'}
        after = {**before,name:'updated'}
        self.assertEqual(len(b.api_delta(before,after,[name])),3)
        with self.assertRaises(RuntimeError): b.api_delta(before,{**after,'other.js':'new'},[name])
        del after[name]
        with self.assertRaises(RuntimeError): b.api_delta(before,after,[name])

    def test_new_api_module_is_admitted_only_at_frozen_path(self):
        name = 'id-business-v2/auto-recharge/new.js'
        after = {name:'a',name+'.map':'b',name[:-3]+'.d.ts':'c'}
        self.assertEqual(len(b.api_delta({},after,[name])),3)
        with self.assertRaises(RuntimeError): b.api_delta({},after,[])

    def applied(self):
        return {'pending':0,'columns':[{'COLUMN_NAME':'email_search_tokens','IS_NULLABLE':'NO','COLUMN_TYPE':'json','COLUMN_DEFAULT':'json_array()'}],
                'rows':[{'checksum':c['migration']['sha256'],'finished':True,'rolledBack':False}],'indexes':[]}

    def test_migration_requires_exact_column_default_and_checksum(self):
        r.check_migration(self.applied(),c,True)
        for key, value in [('COLUMN_TYPE','text'),('IS_NULLABLE','YES'),('COLUMN_DEFAULT',None)]:
            state=self.applied(); state['columns'][0][key]=value
            with self.assertRaises(RuntimeError): r.check_migration(state,c,True)
        state=self.applied();state['rows'][0]['checksum']='0'*64
        with self.assertRaises(RuntimeError):r.check_migration(state,c,True)

    def test_partial_migration_is_never_blindly_repeated(self):
        r.check_migration({'pending':0,'columns':[],'rows':[],'indexes':[]},c)
        with self.assertRaises(RuntimeError):r.check_migration(self.applied(),c)

    def test_backfill_preserves_receipt_and_requires_empty_final_preview(self):
        d=Mock(); d.compose.side_effect=[json.dumps({'apply':False,'candidates':37,'updated':0,'conflicts':0}),json.dumps({'apply':True,'candidates':37,'updated':37,'conflicts':0}),json.dumps({'apply':False,'candidates':0,'updated':0,'conflicts':0})]
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            result=r.run_backfill(d,Path('/fixture'),Path(directory))
            self.assertEqual(result['phase'],'VERIFIED')
            self.assertEqual(result['applied']['updated'],37)
            with self.assertRaises(RuntimeError):r.run_backfill(d,Path('/fixture'),Path(directory))

    def test_backfill_conflict_stops_without_retry(self):
        d=Mock(); d.compose.return_value=json.dumps({'apply':False,'candidates':37,'updated':0,'conflicts':1})
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            with self.assertRaises(RuntimeError):r.run_backfill(d,Path('/fixture'),Path(directory))
        self.assertEqual(d.compose.call_count,1)

    def test_every_runtime_module_and_new_js_absence_remain_strict(self):
        helper=Mock()
        before={'a.js':'old','a.d.ts':'metadata','a.js.map':'debug','new.js':None}
        r.verify_baseline_api(Mock(),Path('/fixture'),{'baselineRuntimeApiFiles':{'a.js':'old'}},{'baselineApiFiles':before},helper)
        self.assertEqual(helper.verify_modules.call_args_list[0].args[-1],{'a.js':'old'})
        self.assertEqual(helper.verify_modules.call_args_list[1].args[-1],{'a.js':'old','new.js':None})
        helper.verify_modules.side_effect=RuntimeError('runtime changed')
        with self.assertRaises(RuntimeError): r.verify_baseline_api(Mock(),Path('/fixture'),c,{'baselineApiFiles':before},helper)

    def test_reuse_is_limited_to_the_successful_native_validator(self):
        dispatch=load('account-login-dispatch.py')
        with unittest.mock.patch.dict(dispatch.os.environ,{'VALIDATED_RUN':'arbitrary'}):
            with self.assertRaisesRegex(RuntimeError,'REUSE_SELECTION_INVALID'):dispatch.prepare_reused_plan()

    def test_runtime_configuration_does_not_change(self):
        r.verify_image_configuration({'Env':['a=b'],'Image':'','Labels':{}},{'Env':['a=b'],'Image':'','Labels':{'new':'proof'}})
        with self.assertRaises(RuntimeError):r.verify_image_configuration({'Env':['a=b']},{'Env':['a=c']})

if __name__ == '__main__':unittest.main()
