"""Fixed-leaf permission repair regressions in a private project filesystem."""
from pathlib import Path
import hashlib, importlib.util, json, os, stat, subprocess, tempfile, unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'.runtime/online-recharge-release-20261009/build/source-permission-repair-fixtures'
OUTPUT.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('fixed_compose_permission_repair',Path(__file__).with_name('online-recharge-source-permission-repair.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REAL_FCHMOD=os.fchmod
REAL_READ=os.read

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

class PermissionRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw=subprocess.run(['git','-C',str(ROOT),'show',m.BASELINE+':'+m.LEAF],check=True,capture_output=True).stdout
        assert hashlib.sha256(cls.raw).hexdigest()==m.COMPOSE_SHA256

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fixed-leaf-',dir=OUTPUT)
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'vroot';self.root.mkdir(mode=0o700)
        self.base=self.root/'opt/id-business-v2';self.release=self.base/('releases/20261009T000000Z-'+m.BASELINE[:12])
        self.release.mkdir(parents=True,mode=0o755)
        self.current=self.base/'current';self.current.symlink_to('releases/'+self.release.name)
        self.leaf=self.release/m.LEAF;self.leaf.write_bytes(self.raw);self.leaf.chmod(0o666)
        self.states={name:{'image':'sha256:'+hashlib.sha256(name.encode()).hexdigest(),'reference':'synthetic-'+name,
          'status':'running','health':None if name=='caddy' else 'healthy','containerId':hashlib.sha256(('cid-'+name).encode()).hexdigest(),
          'startedAtSha256':'a'*64,'environmentSha256':'b'*64,'configurationSha256':'c'*64}
          for name in ('api','admin','mysql','caddy','media-resolver','auto-recharge','auto-registration')}
        self.samples=0;self.chmods=[]
        for mock in (patch.object(m,'_open_root',side_effect=lambda:os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)),
                     patch.object(m,'_root_identity',return_value=True),patch.object(m,'_uid',return_value=os.getuid())):
            mock.start();self.addCleanup(mock.stop)

    def reader(self,hook=None):
        def snapshot(directory):
            self.assertEqual(directory,m.BASE/'releases'/self.release.name)
            self.samples+=1
            if hook:hook(self.samples)
            return digest(self.states)
        return snapshot

    def fchmod(self,hook=None):
        def chmod(fd,mode):
            self.chmods.append((fd,mode,os.fstat(fd).st_ino))
            REAL_FCHMOD(fd,mode)
            if hook:hook(len(self.chmods))
        return patch.object(m.os,'fchmod',side_effect=chmod)

    def change_current(self):
        self.current.unlink();self.current.symlink_to('releases/20261009T000001Z-'+m.BASELINE[:12])

    def assert_failed_before(self,result,code):
        self.assertEqual(result['status'],'FAILED_BEFORE_MUTATION');self.assertEqual(result['code'],code)
        self.assertFalse(result['mutationAttempted']);self.assertFalse(result['repairVerified']);self.assertEqual(self.chmods,[])

    def test_only_writable_bits_removed_and_all_other_attributes_bytes_kept(self):
        self.leaf.chmod(0o6757);before=self.leaf.stat();raw=self.leaf.read_bytes()
        with self.fchmod():result=m.repair(self.reader())
        after=self.leaf.stat()
        self.assertEqual(result['status'],'CHANGED');self.assertEqual(result['code'],'OK')
        self.assertTrue(result['repairVerified']);self.assertTrue(result['currentUnchanged']);self.assertTrue(result['servicesUnchanged'])
        self.assertEqual(stat.S_IMODE(after.st_mode),stat.S_IMODE(before.st_mode)&~0o022)
        for attr in ('st_dev','st_ino','st_uid','st_gid','st_nlink','st_size','st_mtime_ns'):
            self.assertEqual(getattr(before,attr),getattr(after,attr),attr)
        self.assertEqual(raw,self.leaf.read_bytes());self.assertEqual(len(self.chmods),1)
        self.assertEqual(self.samples,3);self.assertEqual(result['servicesBeforeSha256'],result['servicesAfterSha256'])

    def test_compliant_mode_is_noop_and_repair_is_idempotent(self):
        self.leaf.chmod(0o644);before=m._identity(self.leaf.stat())
        with self.fchmod():first=m.repair(self.reader())
        self.assertEqual(first['status'],'NO_CHANGE');self.assertFalse(first['mutationAttempted'])
        self.assertEqual(before,m._identity(self.leaf.stat()));self.assertEqual(self.chmods,[])
        self.leaf.chmod(0o666)
        with self.fchmod():changed=m.repair(self.reader());again=m.repair(self.reader())
        self.assertEqual(changed['status'],'CHANGED');self.assertEqual(again['status'],'NO_CHANGE')
        self.assertEqual(len(self.chmods),1)

    def test_root_and_caller_scope_rejected_without_open_or_mutation(self):
        with patch.object(m,'_open_root',side_effect=AssertionError('MUST_NOT_OPEN')),self.fchmod():
            for callback in (None,True,'a'*64,SimpleNamespace(__call__=lambda _: 'a'*64)):
                self.assert_failed_before(m.repair(callback),'SCOPE_INVALID')
            with patch.object(m,'_root_identity',return_value=False):
                self.assert_failed_before(m.repair(self.reader()),'ROOT_REQUIRED')
        with self.assertRaises(TypeError):m.repair(self.reader(),base=self.base)
        with self.assertRaises(TypeError):m.repair(self.reader(),expected_snapshot='a'*64)

    def test_leaf_symlink_refused_without_touching_target(self):
        target=self.release/'other';self.leaf.rename(target);self.leaf.symlink_to(target.name)
        before=target.stat().st_mode
        with self.fchmod():self.assert_failed_before(m.repair(self.reader()),'SOURCE_INVALID')
        self.assertEqual(target.stat().st_mode,before)

    def test_leaf_hardlink_refused_without_mutation(self):
        os.link(self.leaf,self.release/'other')
        with self.fchmod():self.assert_failed_before(m.repair(self.reader()),'SOURCE_INVALID')

    def test_leaf_wrong_owner_is_refused_before_mutation(self):
        original=m._file
        def owner(info):
            attributes={name:getattr(info,name) for name in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')}
            attributes['st_uid']+=1;return original(SimpleNamespace(**attributes))
        with patch.object(m,'_file',side_effect=owner),self.fchmod():
            self.assert_failed_before(m.repair(self.reader()),'SOURCE_INVALID')

    def test_ancestor_symlink_writable_or_wrong_owner_refused(self):
        self.release.chmod(0o775)
        with self.fchmod():self.assert_failed_before(m.repair(self.reader()),'ANCESTOR_INVALID')
        self.release.chmod(0o755);replacement=self.base/'other-releases';(self.base/'releases').rename(replacement)
        (self.base/'releases').symlink_to(replacement.name)
        with self.fchmod():self.assert_failed_before(m.repair(self.reader()),'ANCESTOR_INVALID')
        (self.base/'releases').unlink();replacement.rename(self.base/'releases')
        original=m._directory
        def owner(info):
            attrs={name:getattr(info,name) for name in ('st_dev','st_ino','st_mode','st_uid','st_gid')};attrs['st_uid']+=1
            return original(SimpleNamespace(**attrs))
        with patch.object(m,'_directory',side_effect=owner),self.fchmod():
            self.assert_failed_before(m.repair(self.reader()),'ANCESTOR_INVALID')

    def test_hash_and_size_refused_without_content_rewrite(self):
        self.leaf.write_bytes(self.raw+b'changed');before=self.leaf.read_bytes()
        with self.fchmod():self.assert_failed_before(m.repair(self.reader()),'SOURCE_HASH_CHANGED')
        self.assertEqual(self.leaf.read_bytes(),before)
        self.leaf.write_bytes(b'x'*(m.MAX_BYTES+1))
        with self.fchmod():self.assert_failed_before(m.repair(self.reader()),'SOURCE_INVALID')

    def test_byte_race_during_descriptor_read_refused_before_mutation(self):
        changed=False
        def read(fd,size):
            nonlocal changed
            block=REAL_READ(fd,size)
            if block and not changed:
                changed=True;self.leaf.write_bytes(self.raw+b'changed')
            return block
        with patch.object(m.os,'read',side_effect=read),self.fchmod():
            self.assert_failed_before(m.repair(self.reader()),'SOURCE_CHANGED')

    def test_path_replacement_same_bytes_refused_before_mutation(self):
        def hook(count):
            if count==1:
                replacement=self.release/'replacement';replacement.write_bytes(self.raw);replacement.chmod(0o666)
                replacement.replace(self.leaf)
        with self.fchmod():self.assert_failed_before(m.repair(self.reader(hook)),'SOURCE_INVALID')

    def test_current_change_before_mutation_refused(self):
        with self.fchmod():
            self.assert_failed_before(m.repair(self.reader(lambda n:self.change_current() if n==1 else None)),'CURRENT_CHANGED')

    def test_services_change_before_mutation_refused(self):
        def hook(n):
            if n==2:self.states['api']['configurationSha256']='d'*64
        with self.fchmod():self.assert_failed_before(m.repair(self.reader(hook)),'SERVICES_CHANGED')

    def test_current_change_after_mutation_restores_only_same_fd(self):
        before=self.leaf.stat()
        with self.fchmod(lambda n:self.change_current() if n==1 else None):result=m.repair(self.reader())
        self.assertEqual(result['status'],'FAILED_ROLLED_BACK');self.assertEqual(result['code'],'CURRENT_CHANGED')
        self.assertTrue(result['rollbackVerified']);self.assertFalse(result['currentUnchanged']);self.assertFalse(result['repairVerified'])
        self.assertEqual(stat.S_IMODE(self.leaf.stat().st_mode),stat.S_IMODE(before.st_mode))
        self.assertEqual(len(self.chmods),2);self.assertEqual(self.chmods[0][0],self.chmods[1][0])
        self.assertEqual(self.chmods[0][2],self.chmods[1][2]);self.assertEqual(self.leaf.read_bytes(),self.raw)

    def test_services_change_after_mutation_rolls_back_same_fd(self):
        def hook(n):
            if n==3:self.states['mysql']['containerId']='d'*64
        with self.fchmod():result=m.repair(self.reader(hook))
        self.assertEqual(result['status'],'FAILED_ROLLED_BACK');self.assertEqual(result['code'],'SERVICES_CHANGED')
        self.assertTrue(result['rollbackVerified']);self.assertFalse(result['servicesUnchanged'])
        self.assertEqual(stat.S_IMODE(self.leaf.stat().st_mode),0o666)
        self.assertEqual(len(self.chmods),2);self.assertEqual(self.chmods[0][0],self.chmods[1][0])

    def test_unsafe_post_write_byte_change_never_chmods_again_or_claims_recovery(self):
        with self.fchmod(lambda n:self.leaf.write_bytes(self.raw+b'changed') if n==1 else None):result=m.repair(self.reader())
        self.assertEqual(result['status'],'FAILED_MUTATED_UNVERIFIED');self.assertFalse(result['rollbackVerified'])
        self.assertFalse(result['repairVerified']);self.assertFalse(result['sourceVerified']);self.assertEqual(len(self.chmods),1)

    def test_fchmod_error_checks_actual_fd_and_reports_unchanged_or_rolled_back(self):
        for applied,expected in ((False,'FAILED_UNCHANGED'),(True,'FAILED_ROLLED_BACK')):
            with self.subTest(applied=applied):
                self.leaf.chmod(0o666);calls=[]
                def chmod(fd,mode):
                    calls.append(fd)
                    if len(calls)==1:
                        if applied:REAL_FCHMOD(fd,mode)
                        raise OSError('PRIVATE_FAILURE_DO_NOT_REPORT')
                    REAL_FCHMOD(fd,mode)
                with patch.object(m.os,'fchmod',side_effect=chmod):result=m.repair(self.reader())
                self.assertEqual(result['status'],expected);self.assertEqual(result['code'],'IO_FAILURE')
                self.assertEqual(stat.S_IMODE(self.leaf.stat().st_mode),0o666)
                self.assertTrue(result['mutationAttempted']);self.assertFalse(result['repairVerified'])
                self.assertNotIn('PRIVATE_FAILURE',json.dumps(result))
                if applied:self.assertEqual(calls[0],calls[1])

    def test_failed_rollback_is_explicit_mutated_unverified(self):
        calls=[]
        def chmod(fd,mode):
            calls.append(fd)
            if len(calls)==2:raise OSError('PRIVATE_ROLLBACK_FAILURE')
            REAL_FCHMOD(fd,mode)
        def hook(n):
            if n==3:self.states['api']['containerId']='d'*64
        with patch.object(m.os,'fchmod',side_effect=chmod):result=m.repair(self.reader(hook))
        self.assertEqual(result['status'],'FAILED_MUTATED_UNVERIFIED');self.assertFalse(result['rollbackVerified'])
        self.assertFalse(result['repairVerified']);self.assertEqual(stat.S_IMODE(self.leaf.stat().st_mode),0o644)

    def test_closed_receipt_and_unissued_error_values_do_not_leak(self):
        def fail(_):raise m.Rejected(['PRIVATE_TOKEN_MODE_UID_PATH_DO_NOT_REPORT'])
        with self.fchmod():result=m.repair(fail)
        self.assert_failed_before(result,'IO_FAILURE');self.assertEqual(set(result),m.FIELDS)
        self.assertIn(result['status'],m.STATUSES);self.assertIn(result['code'],m.CODES)
        self.assertEqual(result['composeSha256'],m.COMPOSE_SHA256)
        self.assertTrue(result['rawOutputSuppressed']);self.assertNotIn('PRIVATE_TOKEN',json.dumps(result))
        for forbidden in ('mode','uid','path','rawException','content','environment'):self.assertNotIn(forbidden,result)
        self.assertTrue(all(type(result[name]) is bool for name in ('currentUnchanged','servicesUnchanged','sourceVerified','repairVerified','mutationAttempted','rollbackVerified','rawOutputSuppressed')))
        with self.fchmod():self.assert_failed_before(m.repair(lambda _:True),'SNAPSHOT_INVALID')

if __name__=='__main__':unittest.main()
