"""Actual owned files and bounded isolated child processes. No production/tools.

All FIFO regressions run with a 2s hard bound; children only manipulate their
own test directories. No raw source/env/inspect values are saved or returned.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
IO=load('v2_test_io',HERE/'package_io.py');D=load('v2_test_driver',HERE/'driver.py')
M=json.loads((HERE/'manifest.json').read_bytes())
EXEC=(*M['files'],'manifest.json','driver.py')
CHILD=r'''
import importlib.util,os,sys,json,hashlib
from pathlib import Path
folder=Path(sys.argv[1]);kind=sys.argv[2];root=Path(sys.argv[3])
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
d=load('child_safe_driver',folder/'driver.py')
io=load('child_safe_io',folder/'package_io.py')
manifest=json.loads((folder/'manifest.json').read_bytes())
leaf=folder/'test-leaf.py';leaf.write_bytes(b"VALUE='LOCAL_NON_SECRET'\n");leaf.chmod(0o600)
raw=leaf.read_bytes();target=folder/'manifest.json' if 'manifest' in kind else leaf
if kind.startswith('initial'):
 target.unlink();os.mkfifo(target,0o600)
if kind.startswith('race'):
 original=os.open;changed=False
 def opening(path,*args,**kw):
  global changed
  if path==target.name and kw.get('dir_fd') is not None and not changed:
   target.unlink();os.mkfifo(target,0o600);changed=True
  return original(path,*args,**kw)
 os.open=opening
try:
 if kind.endswith('manifest'):d._local_package()
 elif kind.endswith('loader'):d._load(leaf,hashlib.sha256(raw).hexdigest())
 elif kind=='verified_table_fifo':
  package=io.Package(folder,manifest);q=package.load_leaf('qualified.py')
  table=folder/'reviewed-source-table.json';table.unlink();os.mkfifo(table,0o600)
  q._reviewed_profile()
 elif kind=='initial_package_table_fifo':
  table=folder/'reviewed-source-table.json';table.unlink();os.mkfifo(table,0o600)
  io.Package(folder,manifest)
 elif kind.startswith('collector_') or kind.startswith('qualified_'):
  c=load('child_collector',folder/'collector.py');inv=load('child_inventory',root/'scripts/production-release/online-recharge-declaration-measurement.py')
  pure=load('child_pure',folder/'pure.py');c._configure(inv,pure,json.loads((folder/'contract.json').read_bytes()))
  if kind.startswith('collector_'):
   private=kind.endswith('private');original=os.open;changed=False
   def opening(path,*args,**kw):
    global changed
    if path==leaf.name and kw.get('dir_fd') is not None and not changed:
     leaf.unlink();os.mkfifo(leaf,0o600);changed=True
    return original(path,*args,**kw)
   if kind.startswith('collector_initial'):
    leaf.unlink();os.mkfifo(leaf,0o600)
   else:os.open=opening
   c.file_seal(leaf,private=private)
  elif kind=='qualified_source_fifo':
   q=load('child_source_qualified',folder/'qualified.py');session=type('MockPrivateSession',(),{'base':c})()
   driver=q._ControlledDriver.__new__(q._ControlledDriver);driver.session=session;driver.environment={}
   source=folder/inv.FILES[0];source.write_bytes(b'SYNTHETIC');source.chmod(0o600)
   original=os.open;changed=False
   def opening(path,*args,**kw):
    global changed
    if path==source.name and kw.get('dir_fd') is not None and not changed:
     source.unlink();os.mkfifo(source,0o600);changed=True
    return original(path,*args,**kw)
   os.open=opening;driver.source_environment(folder)
  elif kind=='qualified_client_fifo':
   q=load('child_client_qualified',folder/'qualified.py');path=folder/'config.json';path.write_bytes(b'{}\n');path.chmod(0o600);seal=c.file_seal(path,private=True)
   session=type('MockPrivateSession',(),{'base':c,'client_seals':{path:seal},'profile':{'spec':{'dockerPath':'/usr/bin/docker','composePath':'/usr/libexec/docker/cli-plugins/docker-compose'}}})()
   driver=q._ControlledDriver.__new__(q._ControlledDriver);driver.session=session;driver.config=path;driver.seal=seal
   driver.environment={'PATH':'FIXED','LANG':'C','LC_ALL':'C','DOCKER_HOST':q.UNIX_HOST,'DOCKER_CONFIG':str(folder)}
   driver.driver=type('ForbiddenRunner',(),{'run':lambda *a,**k:(_ for _ in ()).throw(AssertionError('RUN_FORBIDDEN'))})()
   original=os.open;changed=False
   def opening(name,*args,**kw):
    global changed
    if name==path.name and kw.get('dir_fd') is not None and not changed:
     path.unlink();os.mkfifo(path,0o600);changed=True
    return original(name,*args,**kw)
   os.open=opening;driver.run('docker','info')
 elif kind=='direct_unbound_table_fifo':
  q=load('child_unbound_qualified',folder/'qualified.py')
  table=folder/'reviewed-source-table.json';table.unlink();os.mkfifo(table,0o600)
  q._reviewed_profile()
 else:raise AssertionError('UNKNOWN_CHILD_CASE')
except Exception as e:
 codes={'ROOT_DRIVER_SOURCE_UNMEASURED','SOURCE_NOT_MEASURED','PACKAGE_FILE_CHANGED','SOURCE_FILE_INVALID'}
 code=str(e) if str(e) in codes else 'UNEXPECTED_ERROR'
 print(json.dumps({'status':'REJECTED','code':code}));sys.exit(0 if code in codes else 1)
raise AssertionError('UNEXPECTED_ACCEPT')
'''

class BootstrapBoundaryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='bootstrap-',dir=HERE);self.addCleanup(self.temp.cleanup)
  self.base=Path(self.temp.name);self.folder=self.base/'formal-runtime-package';self.folder.mkdir(mode=0o700)
  for name in EXEC:shutil.copyfile(HERE/name,self.folder/name);(self.folder/name).chmod(0o600)
  self.leaf=self.folder/'leaf.py';self.leaf.write_bytes(b"VALUE='LOCAL_NON_SECRET'\n");self.leaf.chmod(0o600)
 def bounded(self,kind,code):
  result=subprocess.run([sys.executable,'-c',CHILD,str(self.folder),kind,str(HERE.parents[2])],timeout=2,capture_output=True,text=True,
   env={'PATH':os.environ.get('PATH',''),'LANG':'C','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'})
  self.assertEqual(result.returncode,0);self.assertEqual(json.loads(result.stdout),{'status':'REJECTED','code':code})
  self.assertEqual(result.stderr,'')
 def test_initial_loader_fifo_rejects_bounded(self):self.bounded('initial_loader','ROOT_DRIVER_SOURCE_UNMEASURED')
 def test_regular_to_fifo_loader_rejects_bounded(self):self.bounded('race_loader','ROOT_DRIVER_SOURCE_UNMEASURED')
 def test_initial_manifest_fifo_rejects_bounded(self):self.bounded('initial_manifest','ROOT_DRIVER_SOURCE_UNMEASURED')
 def test_regular_to_fifo_manifest_rejects_bounded(self):self.bounded('race_manifest','ROOT_DRIVER_SOURCE_UNMEASURED')
 def test_verified_table_fifo_no_second_read_rejects_bounded(self):self.bounded('verified_table_fifo','SOURCE_NOT_MEASURED')
 def test_initial_package_table_fifo_rejects_bounded(self):self.bounded('initial_package_table_fifo','PACKAGE_FILE_CHANGED')
 def test_unbound_qualified_table_fifo_rejects_without_read(self):self.bounded('direct_unbound_table_fifo','SOURCE_NOT_MEASURED')
 def test_parent_rename_even_with_same_leaf_inode_rejected(self):
  original=D.os.read;changed=False
  def reading(fd,size):
   nonlocal changed
   raw=original(fd,size)
   if not changed:
    moved=self.base/'moved';self.folder.rename(moved);self.folder.mkdir(mode=0o700);(moved/'leaf.py').rename(self.leaf);changed=True
   return raw
  with patch.object(D.os,'read',side_effect=reading),self.assertRaisesRegex(D.Rejected,'^ROOT_DRIVER_SOURCE_UNMEASURED$'):D._bootstrap_read(self.leaf)
 def test_leaf_same_bytes_replaced_during_read_rejected(self):
  original=D.os.read;changed=False;raw=self.leaf.read_bytes()
  def reading(fd,size):
   nonlocal changed
   result=original(fd,size)
   if not changed:
    new=self.folder/'replacement';new.write_bytes(raw);new.chmod(0o600);os.replace(new,self.leaf);changed=True
   return result
  with patch.object(D.os,'read',side_effect=reading),self.assertRaisesRegex(D.Rejected,'^ROOT_DRIVER_SOURCE_UNMEASURED$'):D._bootstrap_read(self.leaf)
 def test_initial_links_and_bad_mode_bounded_rejected(self):
  raw=self.leaf.read_bytes()
  for kind in ('symlink','hardlink','mode'):
   with self.subTest(kind=kind):
    self.leaf.unlink()
    if kind=='symlink':self.leaf.symlink_to(HERE/'pure.py')
    elif kind=='hardlink':os.link(self.folder/'pure.py',self.leaf)
    else:self.leaf.write_bytes(raw);self.leaf.chmod(0o666)
    with self.assertRaisesRegex(D.Rejected,'^ROOT_DRIVER_SOURCE_UNMEASURED$'):D._bootstrap_read(self.leaf)
 def test_wrong_os_owner_and_oversize_rejected(self):
  uid=os.getuid()
  with patch.object(D.os,'getuid',return_value=uid+1),self.assertRaisesRegex(D.Rejected,'^ROOT_DRIVER_SOURCE_UNMEASURED$'):D._bootstrap_read(self.leaf)
  with self.leaf.open('r+b') as stream:stream.truncate(2*1024**2+1)
  with self.assertRaisesRegex(D.Rejected,'^ROOT_DRIVER_SOURCE_UNMEASURED$'):D._bootstrap_read(self.leaf)
 def test_parent_mode_and_symlink_rejected(self):
  self.folder.chmod(0o777)
  with self.assertRaises(D.Rejected):D._bootstrap_read(self.leaf)
  self.folder.chmod(0o700);moved=self.base/'moved';self.folder.rename(moved);self.folder.symlink_to(moved)
  with self.assertRaises(D.Rejected):D._bootstrap_read(self.leaf)
 def test_captured_bytes_execute_without_path_second_read(self):
  raw=self.leaf.read_bytes()
  with patch.object(Path,'read_bytes',side_effect=AssertionError('SECOND_PATH_READ_FORBIDDEN')):
   module=D._load(self.leaf,hashlib.sha256(raw).hexdigest())
  self.assertEqual(module.VALUE,'LOCAL_NON_SECRET')
 def test_verified_table_binding_private_closed_bytes_and_no_path_reread(self):
  package=IO.Package(self.folder,M);q=package.load_leaf('qualified.py')
  self.assertIs(type(q._SOURCE_TABLE_BYTES),bytes);self.assertEqual(q._SOURCE_TABLE_BYTES,b'[]\n')
  with patch.object(Path,'read_bytes',side_effect=AssertionError('SECOND_PATH_READ_FORBIDDEN')):
   with self.assertRaisesRegex(q.Rejected,'^SOURCE_NOT_MEASURED$'):q._reviewed_profile()
  for kw in ('source_table','profile','sourceReviewed','path'):
   with self.subTest(kw=kw),self.assertRaises(TypeError):q._reviewed_profile(**{kw:True})
 def test_table_fifo_or_bytes_drift_rechecked_before_archive_download(self):
  for kind in ('bytes','fifo'):
   with self.subTest(kind=kind):
    package=IO.Package(self.folder,M);table=self.folder/'reviewed-source-table.json'
    if kind=='fifo':table.unlink();os.mkfifo(table,0o600)
    else:table.write_bytes(b'[{}]\n')
    with patch.object(IO,'_download',side_effect=AssertionError('ARCHIVE_NOT_ALLOWED')) as download:
     with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_FILE_CHANGED$'):
      package.bind_consumers({'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1'})
     self.assertFalse(download.called)
    table.unlink();table.write_bytes(b'[]\n');table.chmod(0o600)
 def test_initial_collector_public_fifo_rejects_bounded(self):self.bounded('collector_initial_public','SOURCE_FILE_INVALID')
 def test_initial_collector_private_fifo_rejects_bounded(self):self.bounded('collector_initial_private','SOURCE_FILE_INVALID')
 def test_regular_to_fifo_collector_public_rejects_bounded(self):self.bounded('collector_race_public','SOURCE_FILE_INVALID')
 def test_regular_to_fifo_collector_private_rejects_bounded(self):self.bounded('collector_race_private','SOURCE_FILE_INVALID')
 def test_regular_to_fifo_source_text_rejects_bounded(self):self.bounded('qualified_source_fifo','SOURCE_FILE_INVALID')
 def test_regular_to_fifo_private_client_rejects_before_runner_bounded(self):self.bounded('qualified_client_fifo','SOURCE_FILE_INVALID')
 def test_collector_preserves_original_mode_and_owner_rules(self):
  root=HERE.parents[2];c=load('mode_collector',HERE/'collector.py')
  i=load('mode_inventory',root/'scripts/production-release/online-recharge-declaration-measurement.py');d=load('mode_pure',HERE/'pure.py');contract=json.loads((HERE/'contract.json').read_bytes());c._configure(i,d,contract)
  raw=self.leaf.read_bytes()
  for mode,private in ((0o640,False),(0o755,False),(0o444,False),(0o400,True),(0o600,True)):
   with self.subTest(mode=mode,private=private):
    self.leaf.chmod(mode);info=self.leaf.stat();seal=c.file_seal(self.leaf,private=private)
    self.assertEqual(set(seal),{'sha256','identitySha256'})
    self.assertEqual(seal['sha256'],hashlib.sha256(raw).hexdigest())
    self.assertEqual(seal['identitySha256'],d.digest({'device':info.st_dev,'inode':info.st_ino,
     'uid':info.st_uid,'gid':info.st_gid,'mode':info.st_mode,'size':info.st_size,'links':info.st_nlink}))
  for mode,private in ((0o664,False),(0o644,True)):
   self.leaf.chmod(mode)
   with self.assertRaisesRegex(i.Rejected,'^SOURCE_FILE_PERMISSIONS$'):c.file_seal(self.leaf,private=private)
  self.leaf.chmod(0o600);uid=os.getuid()
  with patch.object(c.os,'getuid',return_value=uid+1),self.assertRaisesRegex(i.Rejected,'^SOURCE_FILE_INVALID$'):
   c.file_seal(self.leaf,private=True)
 def test_collector_parent_rename_same_inode_rejected(self):
  c=load('changed_parent_collector',HERE/'collector.py');i=load('parent_inventory',HERE.parents[2]/'scripts/production-release/online-recharge-declaration-measurement.py');d=load('parent_pure',HERE/'pure.py');c._configure(i,d,json.loads((HERE/'contract.json').read_bytes()))
  original=c.os.read;changed=False
  def reading(fd,size):
   nonlocal changed
   raw=original(fd,size)
   if not changed:
    moved=self.base/'relocated';self.folder.rename(moved);self.folder.mkdir(mode=0o700);(moved/'leaf.py').rename(self.leaf);changed=True
   return raw
  with patch.object(c.os,'read',side_effect=reading),self.assertRaisesRegex(i.Rejected,'^SOURCE_FILE_INVALID$'):c.file_seal(self.leaf)
 def test_fixed_package_manifest_execution_closure_and_zero_admission(self):
  # Historical V1->V2 AST evidence is local-only. CI verifies the current
  # complete byte-pinned executable closure and the actual closed entry.
  self.assertEqual(D.PACKAGE_MANIFEST_SHA,'fb5dc7a89c628fbcd151f91dd1ea1b48c7c2ebd0c46641eb910503b04ce1a771')
  self.assertEqual(hashlib.sha256((HERE/'manifest.json').read_bytes()).hexdigest(),D.PACKAGE_MANIFEST_SHA)
  self.assertEqual(hashlib.sha256((HERE/'driver.py').read_bytes()).hexdigest(),
   '4d6d8b4575cd1ea259942f75890093595fe54cbd44fc240f34ab7a895226336b')
  self.assertEqual(set(M),{'version','kind','files','externalLeafPins','consumerFiles','packageRole'})
  self.assertEqual((type(M['version']),M['version'],M['kind'],M['packageRole']),
   (int,2,'FORMAL_RUNTIME_PACKAGE_V2','formal-runtime-package'))
  self.assertEqual(set(M['files']),{'collector.py','constructor.py','contract.json','package_io.py',
   'pure.py','qualified.py','reader.py','reviewed-source-table.json'})
  self.assertEqual(M['consumerFiles'],['remote-deploy.py','api-admin-scope.py','online-recharge-scope.py',
   'api-admin-readonly.py','online-recharge-declaration-measurement.py','api-admin-pending-receipt-wire.py',
   'online-recharge-daemon-identity.py','online-recharge-daemon-listener.py','online-recharge-daemon-socket.py',
   'online-recharge-recovery.json'])
  self.assertEqual(set(M['externalLeafPins']),{'online-recharge-daemon-identity.py',
   'online-recharge-daemon-listener.py','online-recharge-daemon-socket.py','online-recharge-declaration-measurement.py'})
  for name,pin in M['files'].items():
   with self.subTest(leaf=name):self.assertEqual(hashlib.sha256((HERE/name).read_bytes()).hexdigest(),pin)
  for name,pin in M['externalLeafPins'].items():
   with self.subTest(external=name):self.assertEqual(hashlib.sha256((HERE.parent/name).read_bytes()).hexdigest(),pin)
  with patch.object(D,'HERE',self.folder):package=D._local_package()
  self.assertEqual(set(package.raw),set(M['files']))
  self.assertEqual(package.raw['reviewed-source-table.json'],b'[]\n')
  with patch.object(D,'_local_package',return_value=package),patch.object(package,'bind_consumers',
    side_effect=AssertionError('ARCHIVE_ACQUISITION_FORBIDDEN')) as acquire:
   with self.assertRaisesRegex(Exception,'^SOURCE_NOT_MEASURED$'):
    D._capabilities({'commit':'a'*40,'sourceTree':'b'*40,'workflowRunId':'123','workflowRunAttempt':'1'})
   self.assertFalse(acquire.called)

if __name__=='__main__':unittest.main(verbosity=2)
