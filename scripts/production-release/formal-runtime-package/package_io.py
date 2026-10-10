"""Finite ordinary-file/archive loader. No import-time acquisition or admission.

The driver pins this leaf via an acyclic implementation manifest. Consumers are
fixed siblings in the same selected producer archive, not old copied snapshots.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import types
import urllib.request

FILES=frozenset(('package_io.py','pure.py','collector.py','constructor.py','reader.py','qualified.py','contract.json','reviewed-source-table.json'))
CONSUMERS=('remote-deploy.py','api-admin-scope.py','online-recharge-scope.py','api-admin-readonly.py',
 'online-recharge-declaration-measurement.py','api-admin-pending-receipt-wire.py',
 'online-recharge-daemon-identity.py','online-recharge-daemon-listener.py','online-recharge-daemon-socket.py','online-recharge-recovery.json')
LEAVES=('online-recharge-daemon-identity.py','online-recharge-daemon-listener.py','online-recharge-daemon-socket.py','online-recharge-declaration-measurement.py')
PREFIX='scripts/production-release/'
CODES=frozenset(('PACKAGE_INPUT_INVALID','PACKAGE_FILE_CHANGED','PACKAGE_SOURCE_CHANGED','PACKAGE_ARCHIVE_CHANGED','PACKAGE_SCHEMA_CHANGED'))
HEX=re.compile('[a-f0-9]{64}\\Z')

class Rejected(RuntimeError):pass

def need(ok,code='PACKAGE_INPUT_INVALID'):
 if not ok:raise Rejected(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def digest(value):return sha(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode())
def unique(raw,limit=2*1024**2):
 need(type(raw) is bytes and 0<len(raw)<=limit)
 def pairs(rows):
  out={}
  for k,v in rows:need(k not in out);out[k]=v
  return out
 try:return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:need(False))
 except Rejected:raise
 except Exception:raise Rejected('PACKAGE_INPUT_INVALID') from None

def identity(row):return (row.st_dev,row.st_ino,row.st_uid,row.st_gid,row.st_mode,row.st_nlink,row.st_size,row.st_mtime_ns,row.st_ctime_ns)
def parent_fd(path):
 need(path.is_absolute() and '..' not in path.parts,'PACKAGE_FILE_CHANGED')
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);chain=[]
 try:
  for part in path.parts[1:-1]:
   before=os.stat(part,dir_fd=fd,follow_symlinks=False)
   need(stat.S_ISDIR(before.st_mode) and before.st_uid in (0,os.getuid()) and stat.S_IMODE(before.st_mode)&0o022==0,'PACKAGE_FILE_CHANGED')
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
   after=os.fstat(child);need(identity(before)==identity(after),'PACKAGE_FILE_CHANGED')
   chain.append((after.st_dev,after.st_ino,after.st_uid,after.st_gid,after.st_mode));os.close(fd);fd=child
  return fd,chain
 except Exception:os.close(fd);raise

def read_owned(path,limit=2*1024**2):
 path=Path(path);parent,chain=parent_fd(path);fd=None
 try:
  before=os.stat(path.name,dir_fd=parent,follow_symlinks=False)
  need(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1
   and stat.S_IMODE(before.st_mode) in (0o600,0o644) and 0<before.st_size<=limit,'PACKAGE_FILE_CHANGED')
  fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
  need(identity(os.fstat(fd))==identity(before),'PACKAGE_FILE_CHANGED');raw=b''
  while len(raw)<=limit:
   chunk=os.read(fd,min(65536,limit+1-len(raw)))
   if not chunk:break
   raw+=chunk
  need(len(raw)==before.st_size and identity(os.fstat(fd))==identity(before)==identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False)),'PACKAGE_FILE_CHANGED')
  final,again=parent_fd(path)
  try:need(chain==again and os.fstat(final).st_ino==os.fstat(parent).st_ino and os.fstat(final).st_dev==os.fstat(parent).st_dev,'PACKAGE_FILE_CHANGED')
  finally:os.close(final)
 finally:
  if fd is not None:os.close(fd)
  os.close(parent)
 return raw,identity(before)

def archive_inventory(raw,commit,tree):
 need(type(raw) is bytes and len(raw)<=128*1024**2,'PACKAGE_ARCHIVE_CHANGED')
 prefix='id-business-system-'+commit+'/';entries={};inventory={}
 try:
  with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
   members=archive.getmembers();need(len(members)<100000 and sum(m.size for m in members)<512*1024**2,'PACKAGE_ARCHIVE_CHANGED')
   for member in members:
    need((member.name==prefix[:-1] or member.name.startswith(prefix)) and '..' not in Path(member.name).parts
     and (member.isfile() or member.isdir()),'PACKAGE_ARCHIVE_CHANGED')
    if member.isdir():continue
    name=member.name[len(prefix):];need(name and name not in inventory and member.size<=16*1024**2,'PACKAGE_ARCHIVE_CHANGED')
    data=archive.extractfile(member).read();mode='100755' if member.mode&0o111 else '100644'
    inventory[name]={'sha256':sha(data),'mode':mode};parent=entries
    for part in Path(name).parts[:-1]:
     need(part not in parent or type(parent[part]) is dict,'PACKAGE_ARCHIVE_CHANGED');parent=parent.setdefault(part,{})
    need(Path(name).name not in parent,'PACKAGE_ARCHIVE_CHANGED')
    parent[Path(name).name]=(mode,hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).digest())
 except Rejected:raise
 except Exception:raise Rejected('PACKAGE_ARCHIVE_CHANGED') from None
 def encode(items):
  data=b''
  for name,value in sorted(items.items(),key=lambda item:(item[0]+'/' if type(item[1]) is dict else item[0]).encode()):
   mode,oid=('40000',encode(value)) if type(value) is dict else value
   data+=mode.encode()+b' '+name.encode()+b'\0'+oid
  return hashlib.sha1(b'tree '+str(len(data)).encode()+b'\0'+data).digest()
 need(inventory and encode(entries).hex()==tree,'PACKAGE_ARCHIVE_CHANGED');return inventory

def _download(commit):
 with urllib.request.urlopen('https://github.com/wangchaozhuanyong/id-business-system/archive/'+commit+'.tar.gz',timeout=60) as response:
  return response.read(128*1024**2+1)

def execute(path,raw,bindings=None):
 module=types.ModuleType('_fixed_'+path.stem);module.__file__=str(path)
 if bindings:module.__dict__.update(bindings)
 exec(compile(raw,str(path),'exec'),module.__dict__);return module

class Package:
 def __init__(self,directory,manifest):
  self.directory=Path(directory);need(self.directory.is_absolute() and self.directory.resolve()==self.directory)
  need(type(manifest) is dict and set(manifest)=={'version','kind','files','externalLeafPins','consumerFiles','packageRole'})
  need(manifest['version']==2 and type(manifest['version']) is int and manifest['kind']=='FORMAL_RUNTIME_PACKAGE_V2'
   and manifest['packageRole']=='formal-runtime-package' and manifest['consumerFiles']==list(CONSUMERS))
  need(type(manifest['files']) is dict and set(manifest['files'])==FILES and all(type(v) is str and HEX.fullmatch(v) for v in manifest['files'].values()))
  need(type(manifest['externalLeafPins']) is dict and set(manifest['externalLeafPins'])==set(LEAVES)
   and all(type(v) is str and HEX.fullmatch(v) for v in manifest['externalLeafPins'].values()))
  self.manifest=copy.deepcopy(manifest);self.manifest_raw,self.manifest_seal=read_owned(self.directory/'manifest.json')
  need(unique(self.manifest_raw)==manifest,'PACKAGE_SCHEMA_CHANGED')
  self.raw={};self.seals={};self.external={};self.external_seals={};self.bound=None
  for name,h in manifest['files'].items():
   raw,seal=read_owned(self.directory/name);need(sha(raw)==h,'PACKAGE_FILE_CHANGED');self.raw[name]=raw;self.seals[name]=seal
  need(sha(self.raw['reviewed-source-table.json'])=='fe094929ad54d3eb4e518b69c78683258ff68418f149a3f11c96b1b613b7f66e','PACKAGE_SCHEMA_CHANGED')
  self.contract=unique(self.raw['contract.json']);need(set(self.contract)=={'version','kind','baselineCommit','formalTableSha256','parentFormalTableSha256','fields'}
   and self.contract['version']==1 and self.contract['kind']=='FORMAL_RUNTIME_PACKAGE_CONTRACT','PACKAGE_SCHEMA_CHANGED')
 def load_leaf(self,name):
  need(name in FILES and name.endswith('.py'),'PACKAGE_INPUT_INVALID');self.assert_stable()
  module=execute(self.directory/name,self.raw[name])
  if name=='qualified.py':module._SOURCE_TABLE_BYTES=self.raw['reviewed-source-table.json']
  return module
 def assert_stable(self):
  raw,seal=read_owned(self.directory/'manifest.json');need(raw==self.manifest_raw and seal==self.manifest_seal,'PACKAGE_FILE_CHANGED')
  for name,raw in self.raw.items():
   current,seal=read_owned(self.directory/name);need(current==raw and seal==self.seals[name],'PACKAGE_FILE_CHANGED')
  for name,raw in self.external.items():
   current,seal=read_owned(self.directory.parent/name);need(current==raw and seal==self.external_seals[name],'PACKAGE_SOURCE_CHANGED')
  if self.bound:
   current,seal=read_owned(self.directory/'driver.py');need(current==self.bound['driver'] and seal==self.bound['driverSeal'],'PACKAGE_SOURCE_CHANGED')
 def bind_consumers(self,producer):
  need(self.bound is None,'PACKAGE_SOURCE_CHANGED')
  need(type(producer) is dict and set(producer)=={'commit','sourceTree','workflowRunId','workflowRunAttempt'})
  need(all(type(producer[k]) is str and re.fullmatch('[a-f0-9]{40}',producer[k]) for k in ('commit','sourceTree'))
   and all(type(producer[k]) is str and re.fullmatch('[1-9][0-9]*',producer[k]) for k in ('workflowRunId','workflowRunAttempt')))
  self.assert_stable()
  archive=_download(producer['commit']);inventory=archive_inventory(archive,producer['commit'],producer['sourceTree'])
  for name in CONSUMERS:
   raw,seal=read_owned(self.directory.parent/name)
   need(inventory.get(PREFIX+name,{}).get('sha256')==sha(raw),'PACKAGE_SOURCE_CHANGED')
   if name in LEAVES:need(sha(raw)==self.manifest['externalLeafPins'][name],'PACKAGE_SOURCE_CHANGED')
   self.external[name]=raw;self.external_seals[name]=seal
  driver_raw,driver_seal=read_owned(self.directory/'driver.py')
  local={**self.raw,'manifest.json':self.manifest_raw,'driver.py':driver_raw}
  for name,raw in local.items():need(inventory.get(PREFIX+'formal-runtime-package/'+name,{}).get('sha256')==sha(raw),'PACKAGE_SOURCE_CHANGED')
  # Keep the archive-validated first image; never refresh a baseline after its
  # archive check. Every later stability read must equal these exact bytes/seal.
  self.bound={'driver':driver_raw,'driverSeal':driver_seal}
  self.assert_stable()
  def module(name,bindings=None):return execute(self.directory.parent/name,self.external[name],bindings)
  bound=types.SimpleNamespace(online=module('online-recharge-scope.py'),workspace=module('api-admin-scope.py',{'SCOPE':'API_ADMIN_WORKSPACE'}),
   inventory=module('online-recharge-declaration-measurement.py'),identity=module('online-recharge-daemon-identity.py'),
   listener=module('online-recharge-daemon-listener.py'),socket=module('online-recharge-daemon-socket.py'),
   paths={name:self.directory.parent/name for name in CONSUMERS},leaf_pins=copy.deepcopy(self.manifest['externalLeafPins']),
   socket_bytes=self.external['online-recharge-daemon-socket.py'],assert_stable=self.assert_stable)
  need(bound.listener.BASE_SHA==self.manifest['externalLeafPins']['online-recharge-daemon-identity.py']
   and bound.socket.LISTENER_SHA==self.manifest['externalLeafPins']['online-recharge-daemon-listener.py']
   and bound.socket.IDENTITY_SHA==self.manifest['externalLeafPins']['online-recharge-daemon-identity.py'],'PACKAGE_SOURCE_CHANGED')
  need(json.loads(json.dumps(bound.online.DECLARATION_EQUIVALENCE_FIELDS))==self.contract['fields'],'PACKAGE_SCHEMA_CHANGED')
  self.assert_stable();return bound
