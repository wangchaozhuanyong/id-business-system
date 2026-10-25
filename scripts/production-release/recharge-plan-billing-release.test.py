"""Pure publication guards; no Docker, database, credentials or production calls."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('billing_test_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('recharge-plan-billing-release.py')
B = load('recharge-plan-billing-build.py')
U = load('recharge-plan-billing-publication.py')
C = json.loads((HERE / 'recharge-plan-billing-contract.json').read_bytes())
TEST_ROOT = HERE.parents[1] / '.runtime/recharge-plan-billing-release-20261026/control-tests'
TEST_ROOT.mkdir(parents=True, exist_ok=True)


class BillingPublicationTests(unittest.TestCase):
    def test_source_quality_requires_every_selected_part_and_rejects_any_failed_job(self):
        required = [{'quality', 'full-quality'},
                    {'quality', 'recharge (guards)', 'recharge (admin)', 'recharge (api)', 'recharge (migration)'}]
        run = dict(id=1, head_sha='a' * 40, event='pull_request', conclusion='success', run_attempt=1)
        jobs = [{'name': name, 'conclusion': 'success'} for name in sorted(required[1])]
        def verify(items):
            with patch.object(U.F, 'github', side_effect=[{'workflow_runs': [run]}, {'jobs': items}]):
                return U.checked_run('quality.yml', 'a' * 40, 'pull_request', required)
        self.assertEqual(verify(jobs)['runId'], '1')
        for name in required[1]:
            with self.subTest(missing=name), self.assertRaisesRegex(RuntimeError, 'CHECK_JOBS_REQUIRED'):
                verify([item for item in jobs if item['name'] != name])
        with self.assertRaisesRegex(RuntimeError, 'CHECK_JOBS_REQUIRED'):
            verify(jobs + [{'name': 'neighboring failed check', 'conclusion': 'failure'}])

    def test_contract_only_admits_the_reviewed_delta_and_separate_migration(self):
        self.assertEqual(C['sourcePullRequest'], 723)
        B.ensure_commit(C['sourceReviewCommit'])
        selected = set(B.git('diff', '--name-only', C['reviewBase'], C['sourceReviewCommit'], '--', 'apps/', 'packages/').decode().splitlines())
        self.assertEqual(selected, set(C['sources']))
        for name, value in C['sources'].items():
            self.assertEqual(B.sha(B.git('show', C['sourceReviewCommit'] + ':' + name)), value)
        sql = B.git('show', C['sourceReviewCommit'] + ':' + C['migration']['path']).decode()
        self.assertNotRegex(sql.upper(), r'\b(DELETE FROM|TRUNCATE|DROP TABLE)\b')
        self.assertEqual(sql.count('ON DELETE SET NULL'), 3)
        self.assertIn('recharge_address_use_nullable_fkey', sql)
        self.assertIn('recharge_card_billing_address_nullable_fkey', sql)
        predecessor = json.loads((HERE / 'online-checkout-contract.json').read_bytes())
        self.assertEqual(C['backupNormalizerPath'], predecessor['backupNormalizerPath'])

    def test_database_must_be_clean_and_exact_before_and_after(self):
        before = dict(pending=0, applied=0, checksum=None, allocationTable=0,
                      referenceColumn=0, nullableUses=0, nullableFks=0)
        P.verify_db(before, C)
        for field in before:
            bad = {**before, field: 'unexpected'}
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'MIGRATION_STATE'):
                P.verify_db(bad, C)
        after = dict(pending=0, applied=1, checksum=C['migration']['sha256'], allocationTable=1,
                     referenceColumn=1, nullableUses=1, nullableFks=3)
        P.verify_db(after, C, True)
        with self.assertRaises(RuntimeError):
            P.verify_db({**after, 'checksum': '0' * 64}, C, True)

    def test_payload_rejects_wrong_run_parent_extra_runtime_and_wrong_registry(self):
        c = copy.deepcopy(C)
        admin = {'index.html': 'a' * 64}
        c['baseline']['adminFilesSha256'] = P.fingerprint(admin)
        plan = dict(commit='1' * 40, tree='2' * 40, workflowRunId='123', workflowRunAttempt='1',
                    contractSha256=P.sha((HERE / P.CONTRACT).read_bytes()))
        modules = {n.removeprefix('apps/api/src/').removesuffix('.ts') + ext: 'b' * 64
                   for n in c['sources'] if n.startswith('apps/api/src/') and not n.endswith('.spec.ts')
                   for ext in ('.js', '.js.map', '.d.ts')}
        proof = {**plan, 'version': 1, 'scope': P.SCOPE, 'sources': c['sources'], 'businessActions': 0,
                 'sourceLayout': 'PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAIN_BILLING_OVERLAY',
                 'baselineApiGroups': c['baseline']['apiGroups']['groups'], 'baselineAdminFiles': admin,
                 'apiModules': modules, 'adminFiles': admin, 'prismaClientFiles': {'index.js': 'c' * 64},
                 'controlSources': {}, 'migrationImage': '098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release@sha256:' + 'd' * 64}
        proof['migrationTransport'] = dict(file=P.PREFIX + '-migration.tar.gz', bytes=10,
            sha256='e' * 64, imageId='sha256:' + 'f' * 64,
            reference='098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + plan['commit'] + '-123-billing-migrate')
        files = {**{'api/modules/' + n: v for n, v in modules.items()},
                 'api/prisma-client/index.js': 'c' * 64, 'admin/html/index.html': 'a' * 64,
                 **{'source/' + n: v for n, v in c['sources'].items()}}
        proof['files'] = files
        P.validate_proof(proof, plan, c, files)
        changes = [lambda p: p.update(workflowRunId='999'),
                   lambda p: p.update(baselineAdminFiles={'index.html': 'e' * 64}),
                   lambda p: p['apiModules'].update({'unreviewed.js': 'e' * 64}),
                   lambda p: p.update(migrationImage=p['migrationImage'].replace('098208446664', '079740175286'))]
        for mutate in changes:
            bad = copy.deepcopy(proof)
            mutate(bad)
            with self.assertRaises(RuntimeError):
                P.validate_proof(bad, plan, c, files)
        with self.assertRaises(RuntimeError):
            P.validate_proof(proof, plan, c, {**files, 'unselected': 'e' * 64})

    def test_migration_never_deploys_unrelated_pending_migrations_or_probes_stopped_api(self):
        class Driver:
            def __init__(self):
                self.commands = []
            def compose(self, *args, **kwargs):
                self.commands.append(args)
            def current_job_database(self, *args):
                raise AssertionError('API is stopped; use already validated schema')
        d = Driver()
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as path, patch.object(P, 'db_state', return_value={}), patch.object(P, 'verify_db'):
            journal = Path(path) / 'operation.json'
            P.migrate(d, Path('/owned'), C, journal, 'validated_database')
            self.assertEqual(json.loads(journal.read_text())['phase'], 'VERIFIED')
        self.assertEqual(len(d.commands), 2)
        self.assertIn('execute', d.commands[0])
        self.assertIn('/app/' + C['migration']['path'], d.commands[0])
        self.assertIn('resolve', d.commands[1])
        self.assertIn(C['migration']['name'], d.commands[1])
        self.assertFalse(any('deploy' in command or '--force' in command for command in d.commands))

    def archive(self, name, kind=tarfile.REGTYPE):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = 1 if kind == tarfile.REGTYPE else 0
            archive.addfile(info, io.BytesIO(b'x') if info.size else None)
        return stream.getvalue()

    def test_migration_transport_rejects_wrong_scope_hash_size_image_and_replay(self):
        raw = b'controlled-native-docker-save-fixture'
        value = dict(file=P.PREFIX + '-migration.tar.gz', bytes=len(raw), sha256=P.sha(raw),
                     imageId='sha256:' + 'f' * 64,
                     reference='098208446664.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release:' + 'a' * 40 + '-123-billing-migrate')
        proof = dict(commit='a' * 40, workflowRunId='123', migrationTransport=value)
        plan = dict(artifactUrl='https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + P.PREFIX + '-' + 'a' * 40 + '/' + P.PREFIX + '-artifact.tar.gz')
        class Driver:
            def __init__(self, image=value['imageId']):
                self.commands, self.image = [], image
            def run(self, *args, **kwargs):
                self.commands.append(args)
                return json.dumps([{'Id': self.image}]) if args[:3] == ('docker', 'image', 'inspect') else ''
        for field, bad in [('file', '../outside'), ('bytes', 513 * 1024**2),
                           ('reference', 'unreviewed:tag'), ('sha256', 'bad'), ('imageId', 'unreviewed')]:
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'TRANSPORT_SCOPE'):
                P.verify_migration_transport({**proof, 'migrationTransport': {**value, field: bad}})
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as path, patch.object(P.urllib.request, 'urlopen', return_value=io.BytesIO(raw)) as download:
            d = Driver()
            self.assertEqual(P.load_migration_image(d, proof, plan, Path(path)), value['reference'])
            self.assertTrue(download.call_args.args[0].endswith('/' + value['file']))
            self.assertEqual(d.commands[0][:2], ('docker', 'load'))
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_ACCEPTED'):
                P.load_migration_image(d, proof, plan, Path(path))
        for content, expected in [(raw + b'oversize', 'TRANSPORT_SIZE'),
                                  (b'0' * len(raw), 'TRANSPORT_HASH')]:
            with tempfile.TemporaryDirectory(dir=TEST_ROOT) as path, patch.object(P.urllib.request, 'urlopen', return_value=io.BytesIO(content)):
                d = Driver()
                with self.assertRaisesRegex(RuntimeError, expected):
                    P.load_migration_image(d, proof, plan, Path(path))
                self.assertEqual(d.commands, [])
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as path, patch.object(P.urllib.request, 'urlopen', return_value=io.BytesIO(raw)):
            with self.assertRaisesRegex(RuntimeError, 'TRANSPORT_IMAGE'):
                P.load_migration_image(Driver('sha256:' + '0' * 64), proof, plan, Path(path))

    def test_archive_rejects_escape_links_and_replay(self):
        for name, kind in [('payload/../../escaped', tarfile.REGTYPE),
                           ('/payload/absolute', tarfile.REGTYPE), ('payload/link', tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=TEST_ROOT) as path:
                with self.assertRaisesRegex(RuntimeError, 'PAYLOAD_PATH'):
                    P.safe_payload(self.archive(name, kind), Path(path) / 'content')
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as path:
            folder = Path(path) / 'content'
            P.safe_payload(self.archive('payload/owned'), folder)
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_ACCEPTED'):
                P.safe_payload(self.archive('payload/owned'), folder)

    def test_workflow_uses_one_existing_release_lock_and_exact_main_build(self):
        workflow = (HERE.parents[1] / '.github/workflows/recharge-plan-billing-publication.yml').read_text()
        self.assertIn('group: id-business-v2-production-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn("inputs.commit == github.sha", workflow)
        self.assertIn('arn:aws:iam::098208446664:role/id-business-v2-github-release', workflow)
        self.assertIn('docker build --target migration', workflow)
        self.assertIn('docker save "$image"', workflow)
        release = (HERE / 'recharge-plan-billing-release.py').read_text()
        self.assertIn("d.run('docker', 'load'", release)
        self.assertNotIn("d.run('docker', 'pull'", release)
        self.assertNotIn('workflow_run:', workflow)
        publication = (HERE / 'recharge-plan-billing-publication.py').read_text()
        self.assertIn("command('preflight'", publication)
        self.assertIn("command('readback'", publication)
        self.assertIn('MAIN_MOVED_BEFORE_PUBLICATION', publication)
        self.assertIn('SSM_PENDING_DO_NOT_REPEAT', publication)
        self.assertNotIn('rollback(', (HERE / 'recharge-plan-billing-release.py').read_text())

    def test_runtime_group_hashes_ignore_non_executable_declaration_noise(self):
        actual = B.runtime_groups({'id-business-v2/example/a.js': 'a' * 64,
                                   'id-business-v2/example/a.d.ts': 'b' * 64})
        self.assertEqual(actual, B.runtime_groups({'id-business-v2/example/a.js': 'a' * 64}))
        self.assertNotEqual(actual, B.runtime_groups({'id-business-v2/example/a.js': 'c' * 64}))


if __name__ == '__main__':
    unittest.main()
