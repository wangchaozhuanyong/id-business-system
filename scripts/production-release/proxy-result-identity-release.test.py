"""Pure finite-release controls; Docker, databases, AWS and HTTP are mocked."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = ROOT / '.runtime/registration-closure-release/engine-result-identity-patch/control-tests'


def load(name):
    spec = importlib.util.spec_from_file_location('identity_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


r = load('proxy-result-identity-release.py')
b = load('proxy-result-identity-build.py')
h = load('recharge-record-release.py')
billing = load('recharge-billing-release.py')


class ProxyResultIdentityControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.contract = json.loads((HERE / 'proxy-result-identity-contract.json').read_bytes())

    def test_historical_contract_remains_readable_but_its_registration_asset_is_removed(self):
        c = self.contract
        self.assertEqual(c['expectedCurrent'], '7c3c102c98539d33cb379ef018427371ba750cb7')
        self.assertEqual((len(c['sources']), len(c['engineFiles']), len(c['beforeEngineFiles'])), (4, 3, 82))
        self.assertEqual(c['apiStaticPath'], 'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js')
        self.assertFalse((ROOT / c['apiStaticPath']).exists())
        self.assertEqual(c['accountCount'], 20)
        self.assertEqual(len(c['protectedMigrations']), 3)


    def test_migration_and_account_receipt_runs_only_fixed_reads_with_bound_names(self):
        c = self.contract
        columns = [{'COLUMN_NAME': 'registered_at', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'datetime'},
                   {'COLUMN_NAME': 'registration_ip_encrypted', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'text'}]
        migrations = [{'migration_name': name, 'checksum': checksum, 'finished_at': 'finished', 'rolled_back_at': None}
                      for name, checksum in sorted(c['protectedMigrations'].items())]
        accounts = [{'id': str(i), 'synthetic': True} for i in range(20)]
        captured = []

        def execute(directory, *args, **kwargs):
            self.assertEqual(args[:-1], ('exec', '-T', 'api', 'node', '-e'))
            source = args[-1]
            self.assertEqual(source.count('COLUMN_NAME'), 3)
            syntax = subprocess.run(['node', '--check'], input=source, capture_output=True, text=True, check=False)
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
            harness = """const vm=require('vm'),fs=require('fs'),crypto=require('crypto');const input=JSON.parse(fs.readFileSync(0,'utf8'));const calls=[];let value;
class PrismaClient{async $queryRawUnsafe(...args){calls.push(args);return args[0].includes('information_schema')?input.columns:args[0].includes('COUNT(*)')?[{n:0}]:input.migrations}constructor(){this.idBusinessV2ChatgptAccount={findMany:async args=>{calls.push(['ACCOUNT_READ',args]);return input.accounts}}}async $disconnect(){}}
vm.runInNewContext(input.source,{require(name){if(name==='@prisma/client')return{PrismaClient};if(name==='node:crypto')return crypto;throw Error('UNEXPECTED_IMPORT')},console:{log(raw){value=JSON.parse(raw)}},process:{}});setImmediate(()=>console.log(JSON.stringify({calls,value})));"""
            result = subprocess.run(['node', '-e', harness], input=json.dumps({'source': source, 'columns': columns,
                'migrations': migrations, 'accounts': accounts}), capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = json.loads(result.stdout)
            captured.extend(result['calls'])
            return json.dumps(result['value'])

        value = r.database_receipt(Mock(compose=execute), Path('/synthetic-read-only'), c)
        self.assertEqual(value['accountCount'], 20)
        self.assertEqual(len(captured), 4)
        self.assertTrue(all(row[0].startswith('SELECT ') for row in captured[:3]))
        self.assertEqual(captured[1][1:], sorted(c['protectedMigrations']))
        self.assertEqual(captured[3], ['ACCOUNT_READ', {'orderBy': {'id': 'asc'}}])
        self.assertNotIn('accounts', value)
        invalid = Mock(compose=Mock(return_value=json.dumps({**value, 'accountCount': 0})))
        with self.assertRaisesRegex(RuntimeError, 'DATABASE_PRESERVATION_FAILED'):
            r.database_receipt(invalid, Path('/synthetic-read-only'), c)

    def test_engine_inventory_is_complete_and_rejects_unknown_source(self):
        c = self.contract
        adapter = Mock()
        adapter.run.return_value = json.dumps(c['beforeEngineFiles'])
        r.engine_content(adapter, c['services']['online-recharge'], c['beforeEngineFiles'])
        source = adapter.run.call_args.args[-1]
        self.assertIn("name==='upstream/node_modules'", source)
        self.assertIn("name==='runtime'", source)
        self.assertIn('readdirSync', source)
        self.assertIn('isSymbolicLink()', source)
        self.assertNotIn('const names=', source)
        self.assertEqual(subprocess.run(['node', '--check'], input=source, capture_output=True, text=True).returncode, 0)
        adapter.run.return_value = json.dumps({**c['beforeEngineFiles'], 'unexpected.cjs': 'foreign'})
        with self.assertRaisesRegex(RuntimeError, 'ENGINE_CONTENT_CHANGED'):
            r.engine_content(adapter, c['services']['online-recharge'], c['beforeEngineFiles'])

    def test_sqlite_inspector_keeps_key_in_child_stdin_and_checks_existing_records(self):
        value = {'status': 'PASS', 'businessActions': 0, 'activeAppleLeaseCount': 0,
                 'corruptEncryptedValueCount': 0, 'logicalSha256': 'a' * 64}
        adapter = Mock()
        adapter.compose.return_value = json.dumps(value)
        self.assertEqual(r.sqlite_receipt(adapter, Path('/fixture')), value)
        source = adapter.compose.call_args.args[-1]
        self.assertIn('encryptionKey:process.env.FIELD_ENCRYPTION_KEY', source)
        self.assertIn('input:JSON.stringify(config)', source)
        self.assertNotIn('console.log(config)', source)
        self.assertEqual(subprocess.run(['node', '--check'], input=source, capture_output=True, text=True).returncode, 0)
        adapter.compose.return_value = json.dumps({**value, 'corruptEncryptedValueCount': 1})
        with self.assertRaisesRegex(RuntimeError, 'SQLITE_PRESERVATION_FAILED'):
            r.sqlite_receipt(adapter, Path('/fixture'))

    def test_inventory_program_excludes_exact_mounted_runtime_but_no_foreign_source(self):
        adapter = Mock()
        adapter.run.return_value = '{}'
        r.engine_content(adapter, {'containerId': 'synthetic'}, {})
        source = adapter.run.call_args.args[-1]
        harness = """const vm=require('vm'),fs=require('fs'),crypto=require('crypto');const input=JSON.parse(fs.readFileSync(0,'utf8'));let result;
function entry(name,directory=false){return{name,isSymbolicLink:()=>false,isDirectory:()=>directory,isFile:()=>!directory}}
const fakefs={readdirSync(path){if(path==='/workspace/engine/')return[entry('security.cjs'),entry('runtime',true),entry('upstream',true),...(input.foreign?[entry('foreign.cjs')]:[])];if(path==='/workspace/engine/upstream')return[entry('node_modules',true)];throw Error('RUNTIME_OR_DEPENDENCIES_WERE_READ')},readFileSync(path){if(path.endsWith('security.cjs'))return Buffer.from('synthetic-security');if(path.endsWith('foreign.cjs'))return Buffer.from('foreign');throw Error('UNEXPECTED_READ')}};
vm.runInNewContext(input.source,{require(name){if(name==='fs')return fakefs;if(name==='crypto')return crypto;throw Error('UNEXPECTED_IMPORT')},console:{log(raw){result=JSON.parse(raw)}}});console.log(JSON.stringify(result));"""
        for foreign in (False, True):
            result = subprocess.run(['node', '-e', harness], input=json.dumps({'source': source, 'foreign': foreign}),
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(set(json.loads(result.stdout)), {'security.cjs', 'foreign.cjs'} if foreign else {'security.cjs'})

    def test_overlay_requires_exact_parent_layers_config_labels_and_copy_count(self):
        original = {'RootFS': {'Layers': ['base']}, 'Config': {'Env': ['fixed=1'], 'Labels': {'preserved': 'yes'}}}
        plan = {'commit': 'c' * 40, 'buildProofSha256': 'd' * 64}
        built = {'RootFS': {'Layers': ['base', 'copy']}, 'Config': {**original['Config'], 'Labels': {
            'preserved': 'yes', 'org.opencontainers.image.revision': plan['commit'],
            'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}}}
        r.verify_overlay_image(original, built, plan, 1, billing)
        for mutation in ('layer', 'extra-layer', 'environment', 'label'):
            changed = copy.deepcopy(built)
            if mutation == 'layer':
                changed['RootFS']['Layers'][0] = 'foreign'
            elif mutation == 'extra-layer':
                changed['RootFS']['Layers'].append('foreign')
            elif mutation == 'environment':
                changed['Config']['Env'] = []
            else:
                changed['Config']['Labels']['foreign'] = 'yes'
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                r.verify_overlay_image(original, changed, plan, 1, billing)

    def test_real_image_helper_receives_only_finite_networkless_build_arguments(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as name:
            directory = Path(name)
            adapter = Mock()
            state = {'image': 'sha256:' + 'a' * 64, 'reference': 'synthetic-engine:base'}
            h.build_image(adapter, directory, 'synthetic-engine:candidate', 'online-recharge', state, directory)
            args = adapter.run.call_args.args
            self.assertEqual(args, ('docker', 'build', '--pull=false', '--network', 'none', '--tag', 'synthetic-engine:candidate', str(directory)))
            receipt = json.loads((directory / 'online-recharge-image-build.json').read_bytes())
            self.assertEqual(receipt['status'], 'BUILT')

    def test_real_backup_helper_uses_existing_plan_fields_without_database_execution(self):
        with tempfile.TemporaryDirectory(dir=OUTPUT) as name:
            base = Path(name)
            (base / 'backups').mkdir()
            normalizer = base / 'normalizer.sed'
            normalizer.write_bytes((ROOT / 'scripts/mysql-dump-restore-normalizer.sed').read_bytes())
            raw = b'only synthetic backup bytes'
            calls = []

            def run(*args, **kwargs):
                calls.append(args)
                if args[0] == 'bash':
                    path = Path(shlex.split(args[-1].rsplit(' > ', 1)[1])[0])
                    path.write_bytes(raw)
                if args[:3] == ('aws', 's3api', 'head-object'):
                    return json.dumps({'ContentLength': len(raw), 'ChecksumSHA256': base64.b64encode(hashlib.sha256(raw).digest()).decode(),
                                       'ServerSideEncryption': 'AES256'})
                return ''

            adapter = Mock(run=run)
            adapter.environment_values.return_value = {'MYSQL_DATABASE': 'synthetic_fixture',
                'DATABASE_URL': 'mysql://synthetic@mysql/synthetic_fixture', 'MYSQL_BACKUP_S3_BUCKET': 'synthetic-fixture'}
            plan = {'commit': 'c' * 40, 'workflowRunId': '123'}
            with patch.object(h, 'BASE', base):
                result = h.fresh_scoped_backup(adapter, base, plan, normalizer_path=normalizer)
            self.assertTrue(result['s3Verified'])
            self.assertTrue(any(args[:3] == ('aws', 's3api', 'put-object') for args in calls))
            self.assertEqual(result['sha256'], hashlib.sha256(raw).hexdigest())

    def test_immutable_api_mount_change_alters_real_configuration_fingerprint(self):
        row = {'Config': {'Env': [], 'Labels': {'com.docker.compose.service': 'api'}},
               'HostConfig': {}, 'Mounts': [{'Destination': '/app/.runtime/auto-registration', 'Source': '/fixed-volume', 'RW': True}]}
        adapter = Mock()
        adapter.run.return_value = json.dumps([row])
        before = h.configuration(adapter, {'containerId': 'synthetic'})
        row['Mounts'][0]['Source'] = '/foreign-volume'
        adapter.run.return_value = json.dumps([row])
        self.assertNotEqual(h.configuration(adapter, {'containerId': 'synthetic'}), before)

    def test_owned_registration_and_global_markers_reject_foreign_owner_and_release_only_after_success(self):
        plan = {'commit': 'c' * 40, 'workflowRunId': '123'}
        with tempfile.TemporaryDirectory(dir=OUTPUT) as name:
            base = Path(name)
            marker = base / 'registration-maintenance.json'
            with patch.object(r, 'BASE', base), patch.object(r, 'registration_marker', return_value=marker):
                receipt = r.claim_markers(Mock(), {}, plan)
                r.verify_markers(receipt)
                self.assertTrue(all(Path(path).exists() for path in receipt['paths']))
                with self.assertRaises(FileExistsError):
                    r.claim_markers(Mock(), {}, plan)
                self.assertTrue(marker.exists())
                marker.write_text('foreign-owner')
                with self.assertRaisesRegex(RuntimeError, 'MAINTENANCE_OWNER_CHANGED'):
                    r.release_markers(receipt)
                self.assertTrue((base / 'maintenance.json').exists())
                marker.unlink()
                (base / 'maintenance.json').unlink()
                receipt = r.claim_markers(Mock(), {}, plan)
                # An aborted operation keeps both markers until independently verified readback.
                try:
                    raise RuntimeError('synthetic-switch-failure')
                except RuntimeError:
                    r.verify_markers(receipt)
                r.release_markers(receipt)
                self.assertTrue(all(not Path(path).exists() for path in receipt['paths']))

    def test_existing_fence_same_connection_covers_three_tables_and_new_job_race(self):
        fence_class = r.sql_fence_class(self.contract)
        adapter = Mock()
        adapter.current_job_database.return_value = 'synthetic_fixture'
        adapter.service_state.return_value = {'containerId': 'fixed-mysql'}

        def require(value, code):
            if not value:
                raise RuntimeError(code)

        adapter.require = require
        fence = fence_class(adapter, Path('/synthetic-fixture'))
        process = Mock()
        process.poll.return_value = None
        process.stdin = Mock()
        process.stdout = Mock()
        process.stdout.fileno.return_value = 17
        with patch.object(r.subprocess, 'Popen', return_value=process), patch.object(r.select, 'select', return_value=([process.stdout], [], [])), \
                patch.object(r.os, 'read', return_value=b'{"version":1,"connectionId":31,"busy":0}\n'):
            fence.acquire()
        lock = process.stdin.write.call_args_list[0].args[0].decode()
        self.assertEqual(lock, 'SET SESSION lock_wait_timeout=5; SET SESSION innodb_lock_wait_timeout=5; '
                         'LOCK TABLES online_recharge_tasks WRITE, online_recharge_cards WRITE, id_business_v2_recharge_jobs WRITE;\n')
        self.assertIn('state <> 0x66696e6973686564 AND lease_until > UTC_TIMESTAMP(6)', fence.QUERY)
        self.assertEqual(fence.QUERY.count('SELECT COUNT(*)'), 3)
        self.assertEqual(fence.connection_id, 31)
        fence.buffer = b'{"version":1,"connectionId":31,"busy":1}\n'
        with self.assertRaisesRegex(RuntimeError, 'API_ADMIN_ONLINE_TASK_ACTIVE'):
            fence.check_idle()
        self.assertFalse(any(args.args and args.args[0] == 'docker' for args in adapter.run.call_args_list))
        fence.buffer = b'{"version":1,"connectionId":32,"busy":0}\n'
        with self.assertRaises(RuntimeError):
            fence.check_idle()
        fence.close()
        self.assertIn(unittest.mock.call(b'UNLOCK TABLES;\n'), process.stdin.write.call_args_list)
        self.assertIsNone(fence.process)

    def test_payload_rejects_link_traversal_and_unknown_roots(self):
        for name, link in [('payload/../../foreign', False), ('foreign/file', False), ('payload/link', True)]:
            with tempfile.TemporaryDirectory(dir=OUTPUT) as directory:
                raw = io.BytesIO()
                with tarfile.open(fileobj=raw, mode='w:gz') as archive:
                    item = tarfile.TarInfo(name)
                    if link:
                        item.type, item.linkname = tarfile.SYMTYPE, '/foreign'
                    archive.addfile(item, io.BytesIO())
                with self.assertRaisesRegex(RuntimeError, 'ARTIFACT_PATH_INVALID'):
                    r.extract_payload(raw.getvalue(), Path(directory) / 'content')

    def test_historical_joint_build_and_dispatch_refuse_before_any_side_effect(self):
        for script in ('proxy-result-identity-build.py', 'proxy-result-identity-dispatch.py'):
            with self.subTest(script=script):
                result = subprocess.run(['python3', '-B', str(HERE / script)], cwd=ROOT,
                                        capture_output=True, text=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Automatic registration has been removed', result.stderr)


    def test_retired_workflow_has_no_build_cloud_or_publication_authority(self):
        workflow = (ROOT / '.github/workflows/proxy-result-identity-validation.yml').read_text()
        self.assertIn('Automatic registration has been removed', workflow)
        self.assertIn('exit 1', workflow)
        self.assertNotIn('configure-aws-credentials', workflow)
        self.assertNotIn('npm ci', workflow)
        self.assertNotIn('proxy-result-identity-dispatch.py', workflow)
        self.assertNotIn('proxy-result-identity-build.py', workflow)


if __name__ == '__main__':
    unittest.main()
