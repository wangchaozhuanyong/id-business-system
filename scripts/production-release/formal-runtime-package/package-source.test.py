"""Own ordinary-file transport + synthetic immutable Git tree, no production.

All archive transport is mocked; tests never invoke Docker/AWS/Git writes/tools.
"""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
M=load('minimal_driver',HERE/'driver.py');IO=load('minimal_io',HERE/'package_io.py')
MANIFEST=json.loads((HERE/'manifest.json').read_bytes())
EXECUTION=(*MANIFEST['files'],'manifest.json','driver.py')

def synthetic_archive(files,commit):
 stream=io.BytesIO();entries={}
 with tarfile.open(fileobj=stream,mode='w:gz') as tar:
  for name,raw in sorted(files.items()):
   info=tarfile.TarInfo('id-business-system-'+commit+'/'+name);info.size=len(raw);info.mode=0o644;tar.addfile(info,io.BytesIO(raw))
   parent=entries
   for part in Path(name).parts[:-1]:parent=parent.setdefault(part,{})
   parent[Path(name).name]=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).digest()
 def tree(rows):
  raw=b''
  for name,value in sorted(rows.items(),key=lambda item:(item[0]+'/' if type(item[1]) is dict else item[0]).encode()):
   mode,oid=('40000',tree(value)) if type(value) is dict else ('100644',value)
   raw+=mode.encode()+b' '+name.encode()+b'\0'+oid
  return hashlib.sha1(b'tree '+str(len(raw)).encode()+b'\0'+raw).digest()
 return stream.getvalue(),tree(entries).hex()

class PackageSourceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='transport-',dir=HERE);self.addCleanup(self.tmp.cleanup)
  self.parent=Path(self.tmp.name);self.folder=self.parent/'formal-runtime-package';self.folder.mkdir(mode=0o700)
  for n in EXECUTION:
   shutil.copyfile(HERE/n,self.folder/n);(self.folder/n).chmod(0o600)
  for n in IO.CONSUMERS:
   shutil.copyfile(ROOT/'scripts/production-release'/n,self.parent/n);(self.parent/n).chmod(0o600)
  self.files={IO.PREFIX+n:(self.parent/n).read_bytes() for n in IO.CONSUMERS}
  self.files.update({IO.PREFIX+'formal-runtime-package/'+n:(self.folder/n).read_bytes() for n in EXECUTION})
  self.commit='a'*40;self.archive,self.tree=synthetic_archive(self.files,self.commit)
  self.p={'commit':self.commit,'sourceTree':self.tree,'workflowRunId':'70000000001','workflowRunAttempt':'1'}
 def package(self):return IO.Package(self.folder,MANIFEST)
 def bind(self,package=None):
  with patch.object(IO,'_download',return_value=self.archive) as request:
   result=(package or self.package()).bind_consumers(self.p)
   request.assert_called_once_with(self.commit)
  return result
 def test_exact_small_transport_imports_every_algorithm_without_parent_snapshots(self):
  p=self.package()
  self.assertEqual(len(EXECUTION),10)
  for n in MANIFEST['files']:
   if n.endswith('.py'):self.assertTrue(p.load_leaf(n).__file__.endswith(n))
  self.assertFalse((self.folder/'inputs').exists())
  self.assertFalse(any('test' in n or n.endswith('.log') for n in EXECUTION))
 def test_actual_byte_archive_binds_current_consumers_and_three_reused_capabilities(self):
  p=self.package();bound=self.bind(p)
  self.assertEqual(bound.workspace.__file__,str(self.parent/'api-admin-scope.py'))
  self.assertEqual(bound.online.__file__,str(self.parent/'online-recharge-scope.py'))
  self.assertEqual(bound.socket.LISTENER_SHA,MANIFEST['externalLeafPins']['online-recharge-daemon-listener.py'])
  self.assertEqual(set(bound.paths),set(IO.CONSUMERS));p.assert_stable()
 def test_missing_leaf_refuses_import_before_any_archive_read(self):
  (self.folder/'pure.py').unlink()
  with patch.object(IO,'_download',side_effect=AssertionError('FORBIDDEN')):
   with self.assertRaises(OSError):self.package()
 def test_leaf_changed_even_unused_unknown_configuration_code_refused(self):
  p=self.folder/'collector.py';p.write_bytes(p.read_bytes()+b'\n# LOCAL_TAMPER\n')
  with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_FILE_CHANGED$'):self.package()
 def test_symlink_hardlink_fifo_or_writable_leaf_refused(self):
  for kind in ('symlink','hardlink','fifo','mode'):
   with self.subTest(kind=kind):
    path=self.folder/'pure.py';raw=path.read_bytes();path.unlink()
    if kind=='symlink':path.symlink_to(HERE/'pure.py')
    elif kind=='hardlink':os.link(HERE/'pure.py',path)
    elif kind=='fifo':os.mkfifo(path,0o600)
    else:path.write_bytes(raw);path.chmod(0o666)
    with self.assertRaises(IO.Rejected):self.package()
    path.unlink();path.write_bytes(raw);path.chmod(0o600)
 def test_parent_symlink_or_writable_directory_refused(self):
  original=self.folder;replacement=self.parent/'renamed';original.rename(replacement);original.symlink_to(replacement,target_is_directory=True)
  with self.assertRaises(IO.Rejected):self.package()
  original.unlink();replacement.rename(original);original.chmod(0o777)
  with self.assertRaises(IO.Rejected):self.package()
 def test_unknown_manifest_leaf_or_admission_fields_refused(self):
  for field in ('unknown','callerAdmission'):
   bad=copy.deepcopy(MANIFEST)
   if field=='unknown':bad['files']['secrets.env']='0'*64
   else:bad['trusted']=True
   with self.assertRaises(IO.Rejected):IO.Package(self.folder,bad)
 def test_source_tree_or_producer_change_cannot_bind_same_archive(self):
  for key,value in (('sourceTree','f'*40),('commit','b'*40),('workflowRunId','0'),('workflowRunAttempt',True)):
   original=self.p;self.p={**original,key:value}
   with patch.object(IO,'_download',return_value=self.archive):
    with self.assertRaises(IO.Rejected):self.package().bind_consumers(self.p)
   self.p=original
 def test_executing_consumer_not_same_producer_archive_refused_before_execution(self):
  path=self.parent/'api-admin-scope.py';path.write_bytes(path.read_bytes()+b'\n# LOCAL_DIFFERENT_SOURCE\n')
  with patch.object(IO,'_download',return_value=self.archive):
   with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):self.package().bind_consumers(self.p)
 def test_archive_missing_one_required_package_leaf_refused(self):
  files={k:v for k,v in self.files.items() if not k.endswith('/constructor.py')}
  self.archive,self.tree=synthetic_archive(files,self.commit);self.p['sourceTree']=self.tree
  with patch.object(IO,'_download',return_value=self.archive):
   with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):self.package().bind_consumers(self.p)
 def test_external_cap_pin_not_replaced_by_valid_synthetic_tree(self):
  path=self.parent/'online-recharge-daemon-socket.py';path.write_bytes(path.read_bytes()+b'\n# LOCAL_NEW_SOCKET\n')
  self.files[IO.PREFIX+path.name]=path.read_bytes();self.archive,self.tree=synthetic_archive(self.files,self.commit);self.p['sourceTree']=self.tree
  with patch.object(IO,'_download',return_value=self.archive):
   with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):self.package().bind_consumers(self.p)
 def test_final_current_file_or_manifest_change_refused_after_bound_archive(self):
  p=self.package();self.bind(p);path=self.folder/'manifest.json';path.write_bytes(path.read_bytes()+b'\n')
  with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_FILE_CHANGED$'):p.assert_stable()
 def test_current_consumer_replacement_refused_even_same_semantics(self):
  p=self.package();self.bind(p);path=self.parent/'online-recharge-scope.py';raw=path.read_bytes();path.unlink();path.write_bytes(raw);path.chmod(0o600)
  with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):p.assert_stable()
 def test_raw_secret_like_malformed_value_cannot_escape_public_errors(self):
  d=SimpleNamespace(BASE=self.parent)
  module=load('transport_public_driver',self.folder/'driver.py')
  with patch.object(module.os,'geteuid',return_value=0):
   with self.assertRaises(module.Rejected) as caught:module.measure_declaration_equivalence(d,self.parent,{},producer={'token':'LOCAL_SENTINEL'},purpose='INDEPENDENT_PREFLIGHT')
  self.assertEqual(str(caught.exception),'ROOT_GENERATOR_SOURCE_UNMEASURED');self.assertNotIn('LOCAL_SENTINEL',str(caught.exception))
 def test_public_empty_table_refuses_with_no_siblings_archive_or_controller_activity(self):
  for n in IO.CONSUMERS:(self.parent/n).unlink()
  module=load('isolated_public_driver',self.folder/'driver.py')
  class Forbidden:
   def __getattr__(self,name):raise AssertionError('CONTROLLER_ACTIVITY_FORBIDDEN')
  with patch.object(module.os,'geteuid',return_value=0),patch('urllib.request.urlopen',side_effect=AssertionError('NETWORK_FORBIDDEN')):
   with self.assertRaisesRegex(module.Rejected,'^ROOT_GENERATOR_SOURCE_UNMEASURED$'):
    module.measure_declaration_equivalence(Forbidden(),self.parent,{},producer=self.p,purpose='INDEPENDENT_PREFLIGHT')
 def test_modified_nonempty_source_table_cannot_auto_admit_profile(self):
  (self.folder/'reviewed-source-table.json').write_bytes(b'[{"trusted":true}]\n')
  with self.assertRaises(IO.Rejected):self.package()
 def test_bound_context_rejects_second_producer_registry_reuse(self):
  p=self.package();self.bind(p)
  with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):p.bind_consumers(self.p)

 def test_descriptor_leaf_replacement_during_read_refused(self):
  path=self.folder/'pure.py';original=IO.os.read;changed=False
  def reading(fd,size):
   nonlocal changed
   data=original(fd,size)
   if not changed:
    raw=path.read_bytes();replacement=self.folder/'replacement';replacement.write_bytes(raw);replacement.chmod(0o600);os.replace(replacement,path);changed=True
   return data
  with patch.object(IO.os,'read',side_effect=reading),self.assertRaisesRegex(IO.Rejected,'^PACKAGE_FILE_CHANGED$'):IO.read_owned(path)
 def test_parent_rename_same_leaf_inode_during_read_refused(self):
  path=self.folder/'pure.py';original=IO.os.read;changed=False
  def reading(fd,size):
   nonlocal changed
   data=original(fd,size)
   if not changed:
    moved=self.parent/'relocated';self.folder.rename(moved);self.folder.mkdir(mode=0o700);(moved/'pure.py').rename(path);changed=True
   return data
  with patch.object(IO.os,'read',side_effect=reading),self.assertRaisesRegex(IO.Rejected,'^PACKAGE_FILE_CHANGED$'):IO.read_owned(path)
 def test_archive_link_traversal_and_duplicate_are_rejected_before_execution(self):
  for kind in ('symlink','hardlink','traversal','duplicate'):
   with self.subTest(kind=kind):
    stream=io.BytesIO();prefix='id-business-system-'+self.commit+'/'
    with tarfile.open(fileobj=stream,mode='w:gz') as tar:
     row=tarfile.TarInfo(prefix+('safe' if kind!='traversal' else '../outside'))
     if kind in ('symlink','hardlink'):
      row.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.LNKTYPE;row.linkname='LOCAL_SENTINEL';tar.addfile(row)
     else:
      row.size=1;tar.addfile(row,io.BytesIO(b'x'))
      if kind=='duplicate':tar.addfile(row,io.BytesIO(b'x'))
    with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_ARCHIVE_CHANGED$'):IO.archive_inventory(stream.getvalue(),self.commit,self.tree)
 def test_duplicate_json_nonfinite_and_secret_like_input_are_fixed_errors(self):
  for raw in (b'{"a":1,"a":2}',b'{"a":NaN}',b'{"LOCAL_SENTINEL":',b'[]'*1048577):
   with self.subTest(size=len(raw)),self.assertRaises(IO.Rejected) as caught:IO.unique(raw)
   self.assertEqual(str(caught.exception),'PACKAGE_INPUT_INVALID');self.assertNotIn('LOCAL_SENTINEL',str(caught.exception))

 def test_driver_second_read_drift_cannot_be_promoted_to_bound_baseline(self):
  package=self.package();path=self.folder/'driver.py';original=IO.read_owned;calls=0;first=path.read_bytes()
  def reading(candidate,*args,**kwargs):
   nonlocal calls
   if Path(candidate)==path:
    calls+=1
    if calls==2:path.write_bytes(first+b'\n# LOCAL_SECOND_READ_DRIFT\n')
   return original(candidate,*args,**kwargs)
  with patch.object(IO,'_download',return_value=self.archive),patch.object(IO,'read_owned',side_effect=reading):
   with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):package.bind_consumers(self.p)
  self.assertEqual(calls,2)
  self.assertEqual(package.bound['driver'],first)
  self.assertNotEqual(IO.sha(path.read_bytes()),IO.sha(package.bound['driver']))
  with self.assertRaisesRegex(IO.Rejected,'^PACKAGE_SOURCE_CHANGED$'):package.assert_stable()

 def test_archive_verified_vfs_raw_bytes_plus_actual_fifo_path_rejects_bounded(self):
  code=r"""
import importlib.util,json,os,sys
from pathlib import Path
file=Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('closed_source_fixture',file);t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
case=t.PackageSourceTests();case.setUp()
try:
 p=case.package();bound=case.bind(p);q=p.load_leaf('qualified.py');pure=p.load_leaf('pure.py');q._configure(bound,pure,lambda:None)
 session=q._Session.__new__(q._Session);session.capability=bound.socket;session.require_vfs()
 path=bound.paths['online-recharge-daemon-socket.py'];original=os.open;changed=False
 def opening(name,*args,**kwargs):
  global changed
  if name==path.name and kwargs.get('dir_fd') is not None and not changed:
   path.unlink();os.mkfifo(path,0o600);changed=True
  return original(name,*args,**kwargs)
 os.open=opening
 try:session.require_vfs()
 except t.IO.Rejected as e:
  assert str(e)=='PACKAGE_FILE_CHANGED';print(json.dumps({'status':'REJECTED','code':'PACKAGE_FILE_CHANGED'}))
 else:raise AssertionError('VFS_PATH_DRIFT_ACCEPTED')
finally:case.doCleanups()
"""
  result=subprocess.run([sys.executable,'-c',code,str(Path(__file__).resolve())],timeout=2,capture_output=True,text=True,
   env={'PATH':os.environ.get('PATH',''),'LANG':'C','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'})
  self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,'')
  self.assertEqual(json.loads(result.stdout),{'status':'REJECTED','code':'PACKAGE_FILE_CHANGED'})

if __name__=='__main__':unittest.main()
