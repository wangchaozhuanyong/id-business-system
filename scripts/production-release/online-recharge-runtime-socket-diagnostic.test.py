"""Portable diagnostic regressions: no AWS, Docker or real socket invocation."""
import ast,copy,hashlib,importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import MagicMock,patch

HERE=Path(__file__).resolve().parent
INPUT=json.loads((HERE/'inputs.json').read_text()) if (HERE/'inputs.json').is_file() else None
ROOT=Path(INPUT['root']) if INPUT else HERE.parents[1]
OUTPUT=ROOT/'.runtime/online-recharge-release-20261009/build/runtime-socket-diagnostic-v2/tests'
OUTPUT.mkdir(parents=True,exist_ok=True)

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

m=load('inventory_diagnostic_candidate',HERE/'online-recharge-declaration-measurement.py')
socket=m.daemon_socket_capability()
fixtures=load('inventory_readonly_synthetic_fixture',ROOT/'scripts/production-release/online-recharge-declaration-measurement.test.py')

def fragment():
    tree=ast.parse((HERE/'online-recharge-declaration-measurement.py').read_bytes())
    fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='inventory')
    index=next(i for i,n in enumerate(fn.body) if isinstance(n,ast.Try) and any(isinstance(x,ast.Call)
        and isinstance(x.func,ast.Name) and x.func.id=='daemon_socket_capability' for x in ast.walk(n)))
    exact=copy.deepcopy(fn.body[index-2:index+1])
    self_contained=ast.parse('def actual_socket_try(d, report, codes):\n    pass\n    return report, sorted(codes)\n')
    self_contained.body[0].body=exact+self_contained.body[0].body[1:]
    ast.fix_missing_locations(self_contained)
    ns=dict(m.__dict__);exec(compile(self_contained,'ACTUAL_INVENTORY_SOCKET_AST','exec'),ns)
    return ns

class SocketInventoryDiagnosticsTests(unittest.TestCase):
    def error(self,reason='DAEMON_FD_MISSING',phase='OBSERVATION_FIRST'):
        error=socket.Rejected(reason);error.diagnostic_phase=phase
        return error

    def run_fragment(self,*,error=None,stage='binding',binding=None):
        ns=fragment();cap=types.SimpleNamespace(Rejected=socket.Rejected)
        binding={'listenerBinding':{'runtimeIdentity':{}}} if binding is None else binding
        cap.runtime_daemon_socket_binding=MagicMock(return_value=binding)
        cap.validate_binding=MagicMock()
        if stage=='binding':cap.runtime_daemon_socket_binding.side_effect=error
        elif stage=='validate':cap.validate_binding.side_effect=error
        ns['daemon_socket_capability']=MagicMock(return_value=cap)
        if stage=='source':ns['daemon_socket_capability'].side_effect=error
        report={'runtimeDaemonIdentity':{'status':'OBSERVED','report':{}},
                'runtimeDaemonSocket':{'status':'NOT_MEASURED','report':None}}
        got,codes=ns['actual_socket_try'](types.SimpleNamespace(),report,set())
        return got,codes

    def fixture(self,module=m,*,failed=None):
        with tempfile.TemporaryDirectory(prefix='inventory-',dir=OUTPUT) as temp:
            directory=Path(temp)
            for name in module.FILES:(directory/name).write_text('')
            d=fixtures.DockerReadFixture()
            if failed is not None:d.failed=set(failed)
            with patch.object(module,'daemon_identity_capability',side_effect=RuntimeError('UNAVAILABLE')), \
                 patch.object(module,'binary_hash',return_value='e'*64):
                value=module.inventory(d,directory,services=fixtures.states(),image_reference='source-api',image_id=fixtures.IMAGE)
            self.assertFalse(any(x in ('create','start','up') for args,_ in d.calls for x in args))
            return value

    def test_same_sample_pinned_socket_capability_and_literal_enum_sets(self):
        self.assertEqual(m.DAEMON_SOCKET_SOURCE_SHA256,hashlib.sha256((HERE/'online-recharge-daemon-socket.py').read_bytes()).hexdigest())
        self.assertEqual(m.DAEMON_SOCKET_SOURCE_SHA256,'cba4b37317e8f48778c0dbc59f2c3131340f7d769b2807d0e03fe7c4d37e511a')
        self.assertEqual(set(m.SOCKET_DIAGNOSTIC_REASON_CODES),set(socket.CODES))
        self.assertEqual(set(m.SOCKET_DIAGNOSTIC_PHASE_CODES),set(socket.DIAGNOSTIC_PHASES)|set(m.SOCKET_DIAGNOSTIC_COLLECTOR_PHASES))
        tree=ast.parse((HERE/'online-recharge-declaration-measurement.py').read_bytes())
        codes=next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='CODES' for t in n.targets))
        self.assertEqual(ast.literal_eval(codes),m.CODES)
        self.assertEqual(len(m.CODES),len(set(m.CODES)))
        self.assertEqual(m.REVIEWED_GENERATORS,{})

    def test_actual_inventory_try_preserves_owned_phase_and_reason_only_in_codes(self):
        report,codes=self.run_fragment(error=self.error())
        self.assertEqual(report['runtimeDaemonSocket'],{'status':'NOT_MEASURED','report':None})
        self.assertEqual(set(codes),{'RUNTIME_SOCKET_UNAVAILABLE','RUNTIME_SOCKET_PHASE_OBSERVATION_FIRST','RUNTIME_SOCKET_CODE_DAEMON_FD_MISSING'})
        for reason in socket.CODES:
            for phase in socket.DIAGNOSTIC_PHASES:
                pair=m._socket_failure_codes(self.error(reason,phase),socket,'COLLECTOR_BINDING')
                self.assertEqual(pair,(m.SOCKET_DIAGNOSTIC_PHASE_CODES[phase],m.SOCKET_DIAGNOSTIC_REASON_CODES[reason]))

    def test_collector_source_validate_identity_failures_are_fixed_and_not_measured(self):
        for stage,expected in [('source','COLLECTOR_SOURCE'),('validate','COLLECTOR_VALIDATE')]:
            report,codes=self.run_fragment(stage=stage,error=RuntimeError('PRIVATE_DO_NOT_REPORT'))
            self.assertEqual(set(codes),{'RUNTIME_SOCKET_UNAVAILABLE',m.SOCKET_DIAGNOSTIC_PHASE_CODES[expected],m.SOCKET_DIAGNOSTIC_REASON_CODES['VFS_BINDING_UNAVAILABLE']})
            self.assertEqual(report['runtimeDaemonSocket']['status'],'NOT_MEASURED')
            self.assertNotIn('PRIVATE_DO_NOT_REPORT',json.dumps({'report':report,'codes':codes}))
        report,codes=self.run_fragment(binding={'listenerBinding':{'runtimeIdentity':{'different':True}}})
        self.assertIn('RUNTIME_SOCKET_PHASE_COLLECTOR_IDENTITY',codes)
        self.assertIn('RUNTIME_SOCKET_CODE_VFS_BINDING_UNAVAILABLE',codes)
        self.assertEqual(report['runtimeDaemonSocket']['report'],None)

    def test_unknown_exact_args_phase_and_malicious_subclass_never_read_message(self):
        class Evil(socket.Rejected):
            def __str__(self):raise AssertionError('PRIVATE_DO_NOT_REPORT')
            def __getattribute__(self,name):
                if name in ('__dict__','args'):raise AssertionError('PRIVATE_DO_NOT_REPORT')
                return super().__getattribute__(name)
        class EvilText(str):
            def __eq__(self,other):raise AssertionError('PRIVATE_DO_NOT_REPORT')
        fallback=('RUNTIME_SOCKET_PHASE_COLLECTOR_BINDING','RUNTIME_SOCKET_CODE_VFS_BINDING_UNAVAILABLE')
        errors=[Evil('DAEMON_FD_MISSING'),self.error('PRIVATE_DO_NOT_REPORT'),self.error('MATCH'),
                self.error(phase='PRIVATE_DO_NOT_REPORT'),self.error(phase=EvilText('OBSERVATION_FIRST')),
                socket.Rejected('DAEMON_FD_MISSING','PRIVATE_DO_NOT_REPORT'),socket.Rejected('DAEMON_FD_MISSING'),
                RuntimeError('PRIVATE_DO_NOT_REPORT')]
        for error in errors:
            with self.subTest(kind=type(error).__name__):
                self.assertEqual(m._socket_failure_codes(error,socket,'COLLECTOR_BINDING'),fallback)
        self.assertEqual(m._socket_failure_codes(self.error(),socket,'PRIVATE_DO_NOT_REPORT'),('RUNTIME_SOCKET_PHASE_COLLECTOR_SOURCE',fallback[1]))
        self.assertEqual(m._socket_failure_codes(self.error(),None,'COLLECTOR_BINDING'),fallback)

    def test_success_try_body_retains_exact_report_and_has_no_failure_codes(self):
        binding={'listenerBinding':{'runtimeIdentity':{}}}
        report,codes=self.run_fragment(binding=binding)
        self.assertEqual(report['runtimeDaemonSocket'],{'status':'OBSERVED','report':binding})
        self.assertEqual(codes,[])
        if not INPUT:return
        before=ast.parse((HERE/'input-online-recharge-declaration-measurement.py').read_bytes())
        after=ast.parse((HERE/'online-recharge-declaration-measurement.py').read_bytes())
        def body(tree):
            fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='inventory')
            return next(n.body for n in fn.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Call)
                and isinstance(x.func,ast.Name) and x.func.id=='daemon_socket_capability' for x in ast.walk(n)))
        normalized=[n for n in body(after) if not (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='socket_stage' for t in n.targets))]
        self.assertEqual([ast.dump(n) for n in body(before)],[ast.dump(n) for n in normalized])
        a={n.name:n for n in before.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        b={n.name:n for n in after.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))}
        for name in a.keys()-{'inventory','_validate_inventory'}:self.assertEqual(ast.dump(a[name]),ast.dump(b[name]),name)
        original=copy.deepcopy(a['_validate_inventory']);current=copy.deepcopy(b['_validate_inventory'])
        current.body=[n for n in current.body if not (isinstance(n,ast.Expr) and isinstance(n.value,ast.Call)
            and isinstance(n.value.func,ast.Name) and n.value.func.id=='_validate_socket_failure_codes')]
        self.assertEqual(ast.dump(original),ast.dump(current))

    def test_complete_inventory_closed_codes_and_two_key_report_preserve_legacy(self):
        report=self.fixture();self.assertEqual(m.validate_inventory(report),report)
        self.assertEqual(set(report['runtimeDaemonSocket']),{'status','report'})
        self.assertEqual(report['status'],'SOURCE_NOT_MEASURED')
        for key in ('authority','productionEligible','measurementPerformed','proofConstructed'):self.assertIs(report[key],False)
        for change in ('extra-code','dynamic-prefix','missing-phase','missing-reason','two-phases','two-reasons','duplicate','wrong-order','extra-report-key','false-observed'):
            bad=copy.deepcopy(report)
            if change=='extra-code':bad['codes'].append('PRIVATE_DO_NOT_REPORT')
            elif change=='dynamic-prefix':bad['codes'].append('RUNTIME_SOCKET_CODE_PRIVATE_DO_NOT_REPORT')
            elif change=='missing-phase':bad['codes']=[x for x in bad['codes'] if x not in m.SOCKET_DIAGNOSTIC_PHASE_CODES.values()]
            elif change=='missing-reason':bad['codes']=[x for x in bad['codes'] if x not in m.SOCKET_DIAGNOSTIC_REASON_CODES.values()]
            elif change in ('two-phases','two-reasons'):
                extra='RUNTIME_SOCKET_PHASE_QUERY_FIRST' if change=='two-phases' else 'RUNTIME_SOCKET_CODE_VFS_DRIFT'
                bad['codes']=[x for x in m.CODES if x in set(bad['codes'])|{extra}]
            elif change=='duplicate':bad['codes'].append(bad['codes'][-1])
            elif change=='wrong-order':bad['codes']=list(reversed(bad['codes']))
            elif change=='extra-report-key':bad['runtimeDaemonSocket']['diagnostic']='PRIVATE_DO_NOT_REPORT'
            else:bad['runtimeDaemonSocket']['status']='OBSERVED'
            with self.subTest(change=change),self.assertRaisesRegex(m.Rejected,'^INVENTORY_INVALID$'):m.validate_inventory(bad)
        legacy=copy.deepcopy(report)
        legacy['codes']=[v for v in legacy['codes'] if v not in m.SOCKET_DIAGNOSTIC_PHASE_CODES.values() and v not in m.SOCKET_DIAGNOSTIC_REASON_CODES.values()]
        self.assertEqual(m.validate_inventory(legacy),legacy)
        with self.assertRaisesRegex(m.Rejected,'^SOURCE_NOT_MEASURED$'):
            with patch.object(m,'inventory',return_value=report):
                m.measure(None,Path('.'),services={},image_reference='',image_id='',source_seal={},stability_reader=None)

    def test_total_new_wire_fields_bounded_and_no_budget_schema_registration_changes(self):
        report=self.fixture()
        legacy=copy.deepcopy(report);legacy['codes']=[x for x in legacy['codes'] if x not in m.SOCKET_DIAGNOSTIC_PHASE_CODES.values() and x not in m.SOCKET_DIAGNOSTIC_REASON_CODES.values()]
        added=len(json.dumps(report).encode())-len(json.dumps(legacy).encode())
        self.assertGreater(added,0);self.assertLess(added,160)
        self.assertNotIn('PRIVATE_DO_NOT_REPORT',json.dumps(report))
        if not INPUT:return
        a=ast.parse((HERE/'input-online-recharge-declaration-measurement.py').read_bytes())
        b=ast.parse((HERE/'online-recharge-declaration-measurement.py').read_bytes())
        def assignments(tree):return {t.id:ast.dump(n.value) for n in tree.body if isinstance(n,ast.Assign) for t in n.targets if isinstance(t,ast.Name)}
        old=assignments(a);new=assignments(b)
        for name,value in old.items():
            if name not in ('CODES','DAEMON_IDENTITY_SOURCE_SHA256','DAEMON_SOCKET_SOURCE_SHA256'):self.assertEqual(value,new[name],name)

    def test_affected_existing_failed_read_summary_keeps_legacy_and_fixed_pair(self):
        report=self.fixture(failed={'generator','image','source','resource'})
        self.assertEqual(report['codes'],['SOURCE_NOT_MEASURED','GENERATOR_UNAVAILABLE','SOURCE_SHAPE_UNAVAILABLE',
            'IMAGE_CACHE_UNAVAILABLE','RESOURCE_SCHEMA_UNAVAILABLE','RUNTIME_IDENTITY_UNAVAILABLE',
            'RUNTIME_SOCKET_UNAVAILABLE','RUNTIME_TOOLS_UNAVAILABLE','RUNTIME_SOCKET_PHASE_COLLECTOR_SOURCE',
            'RUNTIME_SOCKET_CODE_VFS_BINDING_UNAVAILABLE'])
        self.assertEqual(m.validate_inventory(report),report)
        self.assertEqual(report['runtimeDaemonSocket'],{'status':'NOT_MEASURED','report':None})

if __name__=='__main__':unittest.main(verbosity=2)
