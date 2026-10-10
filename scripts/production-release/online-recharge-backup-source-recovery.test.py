"""Isolated synthetic backup leaf tests. No AWS, SSM, database, or production F/Q.

Non-Linux functional tests emulate only the FD-link installation primitive
inside the private fixture directory. Native AT_EMPTY_PATH is tested only
when a Linux root process is available; no unsafe production fallback exists.
"""
from pathlib import Path
import base64
from dataclasses import replace
import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
OUTPUT=HERE.parents[1]/'.runtime/historical-backup-source-recovery-tests/isolated-fixtures'
OUTPUT.mkdir(mode=0o700,parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('backup_source_recovery_draft',HERE/'online-recharge-backup-source-recovery.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
REAL_READ=os.read


class SyntheticBackupRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='synthetic-only-',dir=OUTPUT)
        self.addCleanup(self.temp.cleanup)
        self.parent=Path(self.temp.name)/'backups';self.parent.mkdir(mode=0o700)
        self.mysql=self.parent/'mysql';self.mysql.mkdir(mode=0o700)
        flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
        self.parent_fd=os.open(self.parent,flags);self.mysql_fd=os.open(self.mysql,flags)
        self.addCleanup(os.close,self.parent_fd);self.addCleanup(os.close,self.mysql_fd)
        self.binding=m.DirectoryBinding(self.parent_fd,self.mysql_fd)
        self.raw=b'SYNTHETIC ONLY: not a database dump or production backup\n'
        self.expected=m.ExpectedBackup('id-business-v2-20000101T000000Z.sql.gz',len(self.raw),
            hashlib.sha256(self.raw).hexdigest(),True,'synthetic-backup-fixture','mysql/synthetic','ap-northeast-1')
        self.target=self.mysql/self.expected.name
        self.head_calls=0;self.download_calls=0
        self.uid=patch.object(m,'_uid',return_value=os.getuid());self.uid.start();self.addCleanup(self.uid.stop)
        self.install=patch.object(m,'_install_from_fd',side_effect=self.emulated_fd_install)
        self.install.start();self.addCleanup(self.install.stop)

    def emulated_fd_install(self,fd,parent,name):
        # Test adapter only: select held fixture inode, then no-overwrite link.
        held=os.fstat(fd)
        source=next(p for p in self.mysql.iterdir() if not p.is_symlink()
                    and (p.stat().st_dev,p.stat().st_ino)==(held.st_dev,held.st_ino))
        try:os.link(source,name,dst_dir_fd=parent,follow_symlinks=False)
        except FileExistsError:raise m.Rejected('TARGET_CHANGED') from None

    def head(self,expected):
        self.assertIs(expected,self.expected);self.head_calls+=1
        return {'ContentLength':expected.size,'ChecksumSHA256':base64.b64encode(bytes.fromhex(expected.sha256)).decode(),
                'ServerSideEncryption':'AES256'}

    def download(self,expected,fd):
        self.assertIs(expected,self.expected);self.assertIs(type(fd),int);self.download_calls+=1
        self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode),0o600)
        os.write(fd,self.raw)

    def recover(self,mode='restore_missing',head=None,download=None):
        def head_callback(expected):return (self.head if head is None else head)(expected)
        def download_callback(expected,fd):return (self.download if download is None else download)(expected,fd)
        value=m.recover(self.expected,self.binding,mode,head_read=head_callback,download=download_callback)
        self.assertEqual(set(value),m.FIELDS)
        self.assertIn(value['status'],m.STATUSES);self.assertIn(value['code'],m.CODES)
        self.assertIn(value['localStateBefore'],m.LOCAL_STATES);self.assertIn(value['localStateAfter'],m.LOCAL_STATES)
        self.assertTrue(value['rawOutputSuppressed'])
        raw=json.dumps(value)
        for forbidden in (str(self.parent),self.expected.name,self.expected.bucket,self.expected.prefix,self.expected.region,self.raw.decode()):
            if forbidden:self.assertNotIn(forbidden,raw)
        return value

    def make_target(self,raw=None):
        self.target.write_bytes(self.raw if raw is None else raw);self.target.chmod(0o600)

    def assert_no_network(self):self.assertEqual((self.head_calls,self.download_calls),(0,0))

    def test_diagnose_missing_is_read_only_and_never_calls_provider(self):
        result=self.recover('diagnose')
        self.assertEqual((result['status'],result['localStateBefore']),('DIAGNOSED','MISSING'))
        self.assertFalse(result['mutationAttempted']);self.assertFalse(result['installed'])
        self.assertEqual(list(self.mysql.iterdir()),[]);self.assert_no_network()

    def test_missing_restore_uses_original_fd_and_exact_bytes_once(self):
        result=self.recover()
        self.assertEqual(result['status'],'RESTORED');self.assertEqual(result['localStateAfter'],'MATCH')
        self.assertEqual(self.target.read_bytes(),self.raw);self.assertEqual(stat.S_IMODE(self.target.stat().st_mode),0o600)
        self.assertEqual(self.target.stat().st_nlink,1);self.assertEqual(list(self.mysql.iterdir()),[self.target])
        self.assertEqual((self.head_calls,self.download_calls),(1,1))

    def test_existing_match_is_noop_without_providers(self):
        self.make_target();before=m._identity(self.target.stat())
        result=self.recover();self.assertEqual(result['status'],'NO_CHANGE')
        self.assertEqual(m._identity(self.target.stat()),before);self.assert_no_network()

    def test_size_and_hash_anomalies_are_diagnosed_preserved_and_never_downloaded(self):
        for state,raw in (('SIZE',b'x'),('HASH',b'x'*len(self.raw))):
            with self.subTest(state=state):
                self.make_target(raw);before=m._identity(self.target.stat())
                diagnostic=self.recover('diagnose');self.assertEqual(diagnostic['localStateBefore'],state)
                rejected=self.recover();self.assertEqual(rejected['code'],state)
                self.assertFalse(rejected['mutationAttempted']);self.assertEqual(self.target.read_bytes(),raw)
                self.assertEqual(m._identity(self.target.stat()),before);self.assert_no_network()

    def test_nonfile_and_symlink_are_preserved_and_refused(self):
        self.target.mkdir(mode=0o700);result=self.recover();self.assertEqual(result['code'],'NON_FILE')
        self.target.rmdir();other=self.mysql/'synthetic-other';other.write_bytes(self.raw);other.chmod(0o600)
        self.target.symlink_to(other.name);before=m._identity(other.stat())
        result=self.recover();self.assertEqual(result['code'],'LINK')
        self.assertTrue(self.target.is_symlink());self.assertEqual(m._identity(other.stat()),before);self.assert_no_network()

    def test_writable_mode_and_hardlink_are_preserved_and_refused(self):
        self.make_target();self.target.chmod(0o666)
        self.assertEqual(self.recover()['code'],'MODE');self.assertEqual(stat.S_IMODE(self.target.stat().st_mode),0o666)
        self.target.chmod(0o600);other=self.mysql/'synthetic-other';os.link(self.target,other)
        self.assertEqual(self.recover()['code'],'LINK_COUNT');self.assertEqual(self.target.stat().st_nlink,2);self.assert_no_network()

    def test_parent_owner_and_writable_mode_are_refused(self):
        self.mysql.chmod(0o777);self.assertEqual(self.recover()['code'],'PARENT_UNSAFE')
        self.mysql.chmod(0o700)
        with patch.object(m,'_uid',return_value=os.getuid()+1):
            self.assertEqual(self.recover()['code'],'PARENT_UNSAFE')
        self.assert_no_network();self.assertFalse(self.target.exists())

    def test_parent_symlink_and_same_shape_directory_replacement_refused(self):
        original=self.parent/'held-original';self.mysql.rename(original);self.mysql.symlink_to(original.name)
        self.assertEqual(self.recover()['code'],'NONCANONICAL_PATH')
        self.mysql.unlink();self.mysql.mkdir(mode=0o700)
        self.assertEqual(self.recover()['code'],'NONCANONICAL_PATH');self.assert_no_network()

    def test_immutable_expected_fields_and_path_scope_rejected(self):
        for altered in (replace(self.expected,name='../synthetic'),replace(self.expected,size=True),
            replace(self.expected,sha256='not-a-hash'),replace(self.expected,s3Verified=False),
            replace(self.expected,prefix=None),replace(self.expected,bucket='nul\0bucket'),
            replace(self.expected,region=None)):
            with self.subTest():
                result=m.recover(altered,self.binding,'restore_missing',head_read=self.head,download=self.download)
                self.assertEqual(result['code'],'EXPECTED_INVALID');self.assertFalse(result['mutationAttempted'])
        self.assert_no_network()
        with self.assertRaises(Exception):self.expected.name='replacement'

    def test_original_s3_config_preserves_key_semantics_without_path_rules(self):
        for prefix in ('mysql/daily','备份/原目录','mysql/has space','mysql//daily',
                       '../original','','/','mysql/daily///',' 原备份//../来源 /'):
            with self.subTest(prefix=prefix):
                self.expected=replace(self.expected,prefix=prefix,bucket='原 bucket/值',region='原 region 值')
                self.assertEqual(self.expected.key,prefix.rstrip('/')+'/'+self.expected.name)
                result=self.recover()
                self.assertEqual(result['status'],'RESTORED')
                self.assertEqual(self.target.read_bytes(),self.raw)
                self.assertEqual(list(self.mysql.iterdir()),[self.target])
                self.target.unlink()
        self.assertEqual((self.head_calls,self.download_calls),(9,9))

    def test_initial_created_mode_failure_cleans_only_own_temporary_inode(self):
        real_open=os.open
        for bad_mode in (0o400,0o644,0o666):
            def open_bad(name,flags,mode=0o777,*,dir_fd=None):
                fd=real_open(name,flags,mode,dir_fd=dir_fd)
                if type(name) is str and name.startswith('.backup-recovery-') and flags&os.O_CREAT:
                    os.fchmod(fd,bad_mode)
                return fd
            with self.subTest(mode=bad_mode),patch.object(m.os,'open',side_effect=open_bad):
                result=self.recover()
            self.assertEqual(result['code'],'IDENTITY_CHANGED')
            self.assertFalse(result['installed']);self.assertFalse(result['mutationAttempted'])
            self.assertEqual(list(self.mysql.iterdir()),[])
        self.assertEqual((self.head_calls,self.download_calls),(3,0))

    def test_initial_created_failure_preserves_a_replacement_temporary_inode(self):
        real_open=os.open;recorded={};moved=self.mysql/'synthetic-held-original'
        replacement=b'SYNTHETIC OTHER INODE: preserve me\n'
        def open_replaced(name,flags,mode=0o777,*,dir_fd=None):
            fd=real_open(name,flags,mode,dir_fd=dir_fd)
            if type(name) is str and name.startswith('.backup-recovery-') and flags&os.O_CREAT:
                os.fchmod(fd,0o644);recorded['name']=name
                os.rename(name,moved.name,src_dir_fd=dir_fd,dst_dir_fd=dir_fd)
                other=real_open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dir_fd)
                try:os.write(other,replacement)
                finally:os.close(other)
            return fd
        with patch.object(m.os,'open',side_effect=open_replaced):result=self.recover()
        self.assertEqual(result['code'],'IDENTITY_CHANGED');self.assertFalse(result['installed'])
        self.assertEqual((self.mysql/recorded['name']).read_bytes(),replacement)
        self.assertEqual(set(self.mysql.iterdir()),{moved,self.mysql/recorded['name']})
        self.assertEqual((self.head_calls,self.download_calls),(1,0))

    def test_literal_module_without_sys_modules_or_future_annotation_lookup(self):
        name='synthetic_unregistered_literal_core'
        self.assertNotIn(name,sys.modules)
        namespace={'__name__':name,'__file__':str(HERE/'online-recharge-backup-source-recovery.py')}
        exec(compile((HERE/'online-recharge-backup-source-recovery.py').read_bytes(),namespace['__file__'],'exec'),namespace)
        self.assertNotIn(name,sys.modules)
        self.assertIs(namespace['ExpectedBackup'].__annotations__['name'],str)
        expected=namespace['ExpectedBackup'](**self.expected.__dict__)
        binding=namespace['DirectoryBinding'](self.parent_fd,self.mysql_fd)
        namespace['_uid']=lambda:os.getuid()
        result=namespace['recover'](expected,binding,'diagnose')
        self.assertEqual((result['status'],result['localStateBefore']),('DIAGNOSED','MISSING'))
        self.assertFalse(self.target.exists());self.assert_no_network()

    def test_head_size_hash_encryption_or_unknown_fields_refused_before_file_creation(self):
        for field,value in (('ContentLength',self.expected.size+1),('ChecksumSHA256','bad'),
                           ('ServerSideEncryption','aws:kms'),('unknown','SYNTHETIC_RAW')):
            def head(expected,f=field,v=value):
                result=self.head(expected);result[f]=v;return result
            with self.subTest(field=field):
                result=self.recover(head=head);self.assertEqual(result['code'],'HEAD_INVALID')
                self.assertFalse(result['mutationAttempted']);self.assertEqual(list(self.mysql.iterdir()),[])
        self.assertEqual(self.download_calls,0)

    def test_download_short_oversize_or_hash_mismatch_never_installed(self):
        for raw in (self.raw[:-1],self.raw+b'extra',b'x'*len(self.raw)):
            def download(expected,fd,payload=raw):os.write(fd,payload)
            with self.subTest():
                result=self.recover(download=download);self.assertEqual(result['code'],'DOWNLOAD_INVALID')
                self.assertFalse(result['installed']);self.assertFalse(self.target.exists())
                self.assertEqual(list(self.mysql.iterdir()),[])

    def test_target_appearing_during_head_or_download_is_never_overwritten(self):
        def head(expected):
            self.make_target(b'existing-synthetic');return self.head(expected)
        result=self.recover(head=head);self.assertEqual(result['code'],'TARGET_CHANGED')
        self.assertEqual(self.download_calls,0);self.assertEqual(self.target.read_bytes(),b'existing-synthetic')
        self.target.unlink()
        def download(expected,fd):
            self.download(expected,fd);self.make_target(b'another-existing-synthetic')
        result=self.recover(download=download);self.assertEqual(result['code'],'TARGET_CHANGED')
        self.assertEqual(self.target.read_bytes(),b'another-existing-synthetic')

    def test_atomic_destination_race_is_never_overwritten(self):
        def install(fd,parent,name):
            self.make_target(b'existing-at-install');self.emulated_fd_install(fd,parent,name)
        with patch.object(m,'_install_from_fd',side_effect=install):result=self.recover()
        self.assertEqual(result['code'],'TARGET_CHANGED');self.assertFalse(result['installed'])
        self.assertEqual(self.target.read_bytes(),b'existing-at-install')

    def test_download_temp_replacement_and_fd_mode_change_refused(self):
        def mode(expected,fd):self.download(expected,fd);os.fchmod(fd,0o644)
        self.assertEqual(self.recover(download=mode)['code'],'IDENTITY_CHANGED');self.assertFalse(self.target.exists())
        def replacement(expected,fd):
            self.download(expected,fd)
            path=next(self.mysql.glob('.backup-recovery-*.partial'));path.unlink()
            path.write_bytes(self.raw);path.chmod(0o600)
        result=self.recover(download=replacement);self.assertEqual(result['code'],'IDENTITY_CHANGED')
        self.assertFalse(self.target.exists());self.assertEqual(len(list(self.mysql.iterdir())),1)

    def test_local_byte_race_refuses_original_file_identity(self):
        self.make_target();changed=False
        def read(fd,size):
            nonlocal changed
            block=REAL_READ(fd,size)
            if block and not changed:changed=True;self.target.write_bytes(self.raw+b'changed')
            return block
        with patch.object(m.os,'read',side_effect=read):result=self.recover('diagnose')
        self.assertEqual(result['code'],'IDENTITY_CHANGED');self.assert_no_network()

    def test_download_parent_replacement_refused_without_install_in_stranger(self):
        def download(expected,fd):
            self.download(expected,fd);self.mysql.rename(self.parent/'held-original');self.mysql.mkdir(mode=0o700)
        result=self.recover(download=download)
        self.assertEqual(result['code'],'NONCANONICAL_PATH');self.assertFalse(result['installed'])
        self.assertEqual(list(self.mysql.iterdir()),[])

    def test_raw_errors_are_suppressed_in_closed_receipt(self):
        marker='SYNTHETIC_RAW_ERROR_MUST_NOT_BE_RETURNED'
        def head(expected):raise RuntimeError(marker)
        result=self.recover(head=head);self.assertEqual(result['code'],'REMOTE_FAILURE')
        self.assertNotIn(marker,json.dumps(result));self.assertFalse(self.target.exists())

    def test_failed_after_install_is_explicit_and_does_not_delete_target(self):
        real_binding=m._binding
        def binding(value,anchor=None):
            if self.target.exists():raise m.Rejected('NONCANONICAL_PATH')
            return real_binding(value,anchor)
        with patch.object(m,'_binding',side_effect=binding):result=self.recover()
        self.assertEqual(result['status'],'FAILED_MUTATED_UNVERIFIED');self.assertTrue(result['installed'])
        self.assertEqual(self.target.read_bytes(),self.raw)

    @unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0,'Native Linux root AT_EMPTY_PATH unavailable locally')
    def test_native_linux_root_fd_install_is_no_overwrite(self):
        self.install.stop()
        fd=os.open(self.mysql/'held',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            os.write(fd,self.raw);m._install_from_fd(fd,self.mysql_fd,self.expected.name)
            self.assertEqual(self.target.read_bytes(),self.raw)
            with self.assertRaises(m.Rejected):m._install_from_fd(fd,self.mysql_fd,self.expected.name)
        finally:os.close(fd)


if __name__=='__main__':unittest.main()
