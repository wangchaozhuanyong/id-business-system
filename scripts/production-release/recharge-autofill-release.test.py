"""Offline checks for the finite personal settings and temporary credential release."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('autofill_release', HERE / 'recharge-autofill-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((HERE / module.CONTRACT_FILE).read_bytes())

    def test_contract_pins_and_sources(self):
        module.validate_contract(self.c)
        for name, digest in self.c['controlPins'].items():
            self.assertEqual(module.sha((HERE / name).read_bytes()), digest, name)
        for name, digest in self.c['sources'].items():
            self.assertEqual(module.sha((HERE.parents[1] / name).read_bytes()), digest, name)

    def test_rejects_identity_payment_migration_and_service_extension(self):
        for key, value in [('sourcePullRequest', 740), ('expectedCurrent', 'a' * 40),
                           ('awsTargetAccount', '079740175286'), ('migrationPerformed', True),
                           ('businessActions', 1), ('businessActions', False),
                           ('updatedServices', ['api']), ('preservedServices', [])]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.c)
                changed[key] = value
                with self.assertRaises(RuntimeError):module.validate_contract(changed)

    def test_rejects_unreviewed_source_engine_and_compiled_api(self):
        for field in ('sources', 'beforeEngineFiles', 'afterEngineFiles', 'beforeApiModules'):
            changed = copy.deepcopy(self.c)
            changed[field][next(iter(changed[field]))] = '0' * 64
            with self.subTest(field=field), self.assertRaises(RuntimeError):module.validate_contract(changed)
        for field, value in [('apiModules', ['auth/session.js']), ('apiDeclarationOnly', {'auth.d.ts': '0' * 64})]:
            changed = copy.deepcopy(self.c); changed[field] = value
            with self.assertRaises(RuntimeError):module.validate_contract(changed)

    def test_rejects_replaced_parent_runtime_or_manifest(self):
        for field in ('manifestSha256', 'baselineAdminFilesSha256'):
            changed = copy.deepcopy(self.c);changed['baseline'][field] = '0' * 64
            with self.assertRaises(RuntimeError):module.validate_contract(changed)
        changed = copy.deepcopy(self.c);changed['services']['api']['image'] = 'sha256:' + '0' * 64
        with self.assertRaises(RuntimeError):module.validate_contract(changed)

    def test_quality_binds_reviewed_tree_and_both_native_receipts(self):
        commit, tree = '1' * 40, '2' * 40
        receipt = {'runId':'123','sourceReceiptSha256':'3' * 64}
        q = {'commit':commit,'tree':tree,'source':{**receipt,'head':module.SOURCE,'tree':module.SOURCE_TREE,'pullRequest':741,'billingAllocationRunId':'123'},
             'control':{**receipt,'pullRequest':742,'tree':tree},'main':{'head':commit}}
        module.verify_quality(q, commit, tree)
        for field, value in [('head','0' * 40),('pullRequest',740),('sourceReceiptSha256',''),('runId','0')]:
            changed = copy.deepcopy(q);changed['source'][field] = value
            with self.assertRaises(RuntimeError):module.verify_quality(changed, commit, tree)

    def test_exact_payload_rejects_extra_executable_and_changed_parent(self):
        commit, tree = '1' * 40, '2' * 40
        receipt = {'runId':'123','sourceReceiptSha256':'3' * 64}
        q = {'commit':commit,'tree':tree,'source':{**receipt,'head':module.SOURCE,'tree':module.SOURCE_TREE,
             'pullRequest':741,'billingAllocationRunId':'123'},'control':{**receipt,'pullRequest':742,'tree':tree},'main':{'head':commit}}
        parent = {'baseline':self.c['baseline']}
        plan = {'commit':commit,'tree':tree,'workflowRunId':'123','workflowRunAttempt':'1',
                'contractSha256':'4' * 64,'controlSources':self.c['controlPins'],'nativeParentCapture':parent}
        modules = {n:'5' * 64 for n in self.c['beforeApiModules']}
        files = {**{'source/'+n:v for n,v in self.c['sources'].items()},
                 **{'api/modules/'+n:v for n,v in modules.items()},'admin/html/index.html':'6' * 64,
                 **{'engine/'+n:v for n,v in self.c['afterEngineFiles'].items() if self.c['beforeEngineFiles'][n]!=v}}
        proof = {**plan,'version':1,'scope':module.SCOPE,'sources':self.c['sources'],
                 'qualitySourceEvidence':q,'baselineApiReproduced':True,'baselineAdminSourceReproduced':True,
                 'baselineAdminFiles':self.c['baselineAdminFiles'],'adminFiles':{'index.html':'6' * 64},
                 'apiModules':modules,'afterEngineFiles':self.c['afterEngineFiles'],'files':files,
                 'migrationPerformed':False,'businessActions':0}
        module.verify_proof(proof,plan,self.c,files)
        changed = copy.deepcopy(proof);changed['files']['api/modules/auth/unreviewed.js']='0' * 64
        with self.assertRaises(RuntimeError):module.verify_proof(changed,plan,self.c,changed['files'])
        changed = copy.deepcopy(proof);changed['nativeParentCapture']={'baseline':{}}
        with self.assertRaises(RuntimeError):module.verify_proof(changed,plan,self.c,files)

    def test_unpublished_parallel_sources_are_rejected(self):
        pub = module.load('recharge-autofill-publication.py')
        name = 'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue'
        def same(*args):return name.encode() if args[0] == 'diff' else b'published-source'
        with patch.object(pub,'git',same):pub.reviewed_extensions(self.c)
        def other(*args):
            if args[0] == 'diff':return name.encode()
            return b'unpublished' if args[1].startswith('HEAD:') else b'published-source'
        with patch.object(pub,'git',other), self.assertRaises(RuntimeError):pub.reviewed_extensions(self.c)

    def test_overlay_preserves_unreviewed_source(self):
        builder = module.load('recharge-autofill-build.py')
        runtime = HERE.parents[1] / '.runtime';runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='autofill-scope-',dir=runtime) as temp:
            root = Path(temp);context = root/'context'
            name = 'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts'
            (root/name).parent.mkdir(parents=True);(root/name).write_bytes(b'reviewed')
            (context/name).parent.mkdir(parents=True);(context/name).write_bytes(b'other-work')
            class Result:
                returncode=0;stdout=b'published'
            c={'sources':{name:module.sha(b'reviewed')}}
            with patch.object(builder,'ROOT',root), patch.object(builder,'load',lambda _:module), patch.object(builder.subprocess,'run',return_value=Result()):
                with self.assertRaisesRegex(RuntimeError,'UNPUBLISHED_SOURCE_DIFFERENCE'):
                    builder.overlay_sources(c,{'admin':context},module.CURRENT)
                self.assertEqual((context/name).read_bytes(),b'other-work')
                (context/name).write_bytes(b'published')
                builder.overlay_sources(c,{'admin':context},module.CURRENT)
                self.assertEqual((context/name).read_bytes(),b'reviewed')

    def test_source_commit_can_be_recovered_from_its_original_pr_after_squash(self):
        pub = module.load('recharge-autofill-publication.py')
        class Result:
            def __init__(self, status):self.returncode=status
        with patch.object(pub.subprocess,'run',side_effect=[Result(1),Result(0)]), patch.object(pub,'git') as git:
            pub.ensure_source_commit()
            git.assert_called_once_with('fetch','--no-tags','--no-write-fetch-head','origin','refs/pull/741/head')
        with patch.object(pub.subprocess,'run',return_value=Result(1)), patch.object(pub,'git'), self.assertRaisesRegex(RuntimeError,'SOURCE_COMMIT_MISSING'):
            pub.ensure_source_commit()

    def test_main_advanced_stops_before_any_remote_dispatch(self):
        pub = module.load('recharge-autofill-publication.py')
        with patch.object(pub, 'github', return_value={'object':{'sha':'0' * 40}}), patch.object(pub.subprocess, 'run') as send:
            for mode in ('preflight','release'):
                with self.assertRaisesRegex(RuntimeError,'MAIN_ADVANCED'):
                    pub.transport({'commit':'1' * 40},mode)
            send.assert_not_called()

    def test_native_runtime_and_single_acceptance_are_required(self):
        code=(HERE/'recharge-autofill-publication.py').read_text()
        self.assertIn("github('pulls/741')",code)
        self.assertIn('LINUX_RUNTIME_QUALITY_REQUIRED',code)
        self.assertIn('BILLING_ALLOCATION_QUALITY_REQUIRED',code)
        self.assertIn('NATIVE_BUILD_REQUIRED',code)
        self.assertIn('COMMAND_ALREADY_ACCEPTED_OR_UNCERTAIN',code)
        self.assertIn('sourceReceiptSha256',code)
        self.assertFalse(self.c['migrationPerformed'])
        self.assertEqual(self.c['businessActions'],0)


if __name__ == '__main__':unittest.main()
