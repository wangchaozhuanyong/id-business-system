"""Single fixed baseline Compose permission repair; never a qualification reader.

Only the separately pinned transport supplies its fixed seven-service snapshot
reader. No caller selects a path, owner, mode, content hash or admission value.
"""
from pathlib import Path
import hashlib, json, os, re, stat, types

BASE=Path('/opt/id-business-v2')
BASELINE='0a03fa28e6b844a18833d5c63f1de700f091fc64'
LEAF='docker-compose.aws-mysql.yml'
# The existing declaration measurement frozen.COMPOSE_BLOB_SHA256, unchanged.
COMPOSE_SHA256='953c6264f157b00218f2a019d5e2c0b6bc4a34f687f2ec42ad782e0009e7672c'
MAX_BYTES=1024**2
CODES=frozenset(('OK','SCOPE_INVALID','ROOT_REQUIRED','ANCESTOR_INVALID','ANCESTOR_CHANGED',
 'CURRENT_INVALID','CURRENT_CHANGED','SOURCE_INVALID','SOURCE_CHANGED','SOURCE_HASH_CHANGED',
 'SNAPSHOT_INVALID','SERVICES_CHANGED','IO_FAILURE'))
STATUSES=frozenset(('CHANGED','NO_CHANGE','FAILED_BEFORE_MUTATION','FAILED_UNCHANGED',
 'FAILED_ROLLED_BACK','FAILED_MUTATED_UNVERIFIED'))
FIELDS=frozenset(('kind','status','code','composeSha256','servicesBeforeSha256','servicesAfterSha256',
 'currentUnchanged','servicesUnchanged','sourceVerified','repairVerified','mutationAttempted',
 'rollbackVerified','rawOutputSuppressed'))

class Rejected(RuntimeError):pass

def _need(condition,code):
    if not condition:raise Rejected(code)

def _uid():return 0

def _root_identity():return os.getuid()==0 and os.geteuid()==0

def _open_root():
    return os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)

def _identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,
            info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def _directory_identity(info):
    # Directory time/size are not the protected path authority.
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)

def _directory(info):
    _need(stat.S_ISDIR(info.st_mode) and info.st_uid==_uid()
          and stat.S_IMODE(info.st_mode)&0o022==0,'ANCESTOR_INVALID')

def _close(fd):
    if fd is not None:
        try:os.close(fd)
        except OSError:pass

def _child(parent,name):
    before=os.stat(name,dir_fd=parent,follow_symlinks=False);_directory(before)
    fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
    try:
        info=os.fstat(fd);_directory(info)
        _need(_directory_identity(info)==_directory_identity(before),'ANCESTOR_CHANGED')
        return fd,_directory_identity(info)
    except BaseException:_close(fd);raise

def _base():
    fd=_open_root();chain=[]
    try:
        info=os.fstat(fd);_directory(info);chain.append(_directory_identity(info))
        for name in BASE.parts[1:]:
            child,row=_child(fd,name);_close(fd);fd=child;chain.append(row)
        return fd,tuple(chain)
    except BaseException:_close(fd);raise

def _current(base):
    before=os.stat('current',dir_fd=base,follow_symlinks=False)
    _need(stat.S_ISLNK(before.st_mode) and before.st_uid==_uid() and before.st_nlink==1
          and 0<before.st_size<=512,'CURRENT_INVALID')
    target=os.readlink('current',dir_fd=base)
    prefixes=(str(BASE)+'/releases/','releases/')
    names=[target[len(prefix):] for prefix in prefixes if target.startswith(prefix)]
    _need(len(names)==1 and re.fullmatch('[0-9]{8}T[0-9]{6}Z-'+BASELINE[:12],names[0]),'CURRENT_INVALID')
    after=os.stat('current',dir_fd=base,follow_symlinks=False)
    _need(_identity(before)==_identity(after),'CURRENT_CHANGED')
    # The exact link and the no-follow trusted target walk together establish
    # current.resolve() == the sole canonical baseline release below BASE.
    return names[0],(target,_identity(before))

def _release(base,name):
    releases=None
    try:
        releases,row=_child(base,'releases');fd,last=_child(releases,name)
        return fd,(row,last)
    finally:_close(releases)

def _file(info):
    _need(stat.S_ISREG(info.st_mode) and info.st_uid==_uid() and info.st_nlink==1
          and 0<info.st_size<=MAX_BYTES,'SOURCE_INVALID')

def _read(fd,parent):
    first=os.fstat(fd);_file(first);os.lseek(fd,0,os.SEEK_SET)
    digest=hashlib.sha256();length=0
    while True:
        block=os.read(fd,min(65536,MAX_BYTES-length+1))
        if not block:break
        length+=len(block);_need(length<=MAX_BYTES,'SOURCE_INVALID');digest.update(block)
    last=os.fstat(fd);visible=os.stat(LEAF,dir_fd=parent,follow_symlinks=False)
    _need(length==first.st_size and _identity(first)==_identity(last)==_identity(visible),'SOURCE_CHANGED')
    _need(digest.hexdigest()==COMPOSE_SHA256,'SOURCE_HASH_CHANGED')
    return first

def _same_except_chmod(before,after,mode):
    old,new=_identity(before),_identity(after)
    return (all(old[i]==new[i] for i in (0,1,3,4,5,6,7))
            and stat.S_IFMT(after.st_mode)==stat.S_IFMT(before.st_mode)
            and stat.S_IMODE(after.st_mode)==mode)

def _snapshot(reader,directory):
    value=reader(directory)
    _need(type(value) is str and re.fullmatch('[a-f0-9]{64}',value),'SNAPSHOT_INVALID')
    return value

def _fresh(name,chain,pointer=None):
    base=parent=None
    try:
        base,first=_base()
        if pointer is not None:
            actual,current=_current(base)
            _need(actual==name and current==pointer,'CURRENT_CHANGED')
        parent,last=_release(base,name)
        _need(first+last==chain,'ANCESTOR_CHANGED')
        _close(base);base=None
        return parent
    except BaseException:_close(parent);raise
    finally:_close(base)

def _verified(fd,name,chain,pointer,before,mode=None):
    parent=_fresh(name,chain,pointer)
    try:
        current=_read(fd,parent)
        _need(_identity(before)==_identity(current) if mode is None
              else _same_except_chmod(before,current,mode),'SOURCE_CHANGED')
        return current
    finally:_close(parent)

def _rollback(fd,name,chain,before,target):
    # Never reopen or chmod a replacement leaf. Only the held original FD may
    # be restored, after no-follow path/inode/bytes/owner/ancestor verification.
    parent=_fresh(name,chain)
    try:
        now=_read(fd,parent);original=stat.S_IMODE(before.st_mode)
        _need(_same_except_chmod(before,now,target) or _same_except_chmod(before,now,original),'SOURCE_CHANGED')
        changed=stat.S_IMODE(now.st_mode)!=original
        if changed:os.fchmod(fd,original)
        final=_read(fd,parent)
        _need(_same_except_chmod(before,final,original),'SOURCE_CHANGED')
        # Reopen the full protected chain once more after restoring the FD.
        confirm=_fresh(name,chain)
        try:_need(_identity(final)==_identity(_read(fd,confirm)),'SOURCE_CHANGED')
        finally:_close(confirm)
        return changed
    finally:_close(parent)

def repair(snapshot_read=None):
    """Called only by the separately pinned fixed-operation transport."""
    receipt={'kind':'ONLINE_SOURCE_PERMISSION_REPAIR_V1','status':'FAILED_BEFORE_MUTATION','code':'IO_FAILURE',
      'composeSha256':COMPOSE_SHA256,'servicesBeforeSha256':'NOT_MEASURED','servicesAfterSha256':'NOT_MEASURED',
      'currentUnchanged':False,'servicesUnchanged':False,'sourceVerified':False,'repairVerified':False,
      'mutationAttempted':False,'rollbackVerified':False,'rawOutputSuppressed':True}
    base=parent=fd=None;before=None;name=chain=pointer=target=None
    try:
        _need(type(snapshot_read) is types.FunctionType,'SCOPE_INVALID')
        _need(_root_identity(),'ROOT_REQUIRED')
        base,ancestors=_base();name,pointer=_current(base)
        parent,release_chain=_release(base,name);chain=ancestors+release_chain
        visible=os.stat(LEAF,dir_fd=parent,follow_symlinks=False);_file(visible)
        fd=os.open(LEAF,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        before=_read(fd,parent)
        _need(_identity(visible)==_identity(before),'SOURCE_CHANGED')
        receipt['sourceVerified']=True
        directory=BASE/'releases'/name
        stable=_snapshot(snapshot_read,directory);receipt['servicesBeforeSha256']=stable
        _verified(fd,name,chain,pointer,before)
        _need(_snapshot(snapshot_read,directory)==stable,'SERVICES_CHANGED')
        _verified(fd,name,chain,pointer,before)
        target=stat.S_IMODE(before.st_mode)&~0o022
        if target!=stat.S_IMODE(before.st_mode):
            receipt['mutationAttempted']=True
            os.fchmod(fd,target)
        _verified(fd,name,chain,pointer,before,target if receipt['mutationAttempted'] else None)
        after=_snapshot(snapshot_read,directory);receipt['servicesAfterSha256']=after
        receipt['servicesUnchanged']=after==stable
        _need(receipt['servicesUnchanged'],'SERVICES_CHANGED')
        _verified(fd,name,chain,pointer,before,target if receipt['mutationAttempted'] else None)
        receipt.update(status='CHANGED' if receipt['mutationAttempted'] else 'NO_CHANGE',code='OK',repairVerified=True,currentUnchanged=True,servicesUnchanged=True)
    except Exception as error:
        args=BaseException.args.__get__(error)
        receipt['code']=args[0] if type(error) is Rejected and type(args) is tuple and len(args)==1 and type(args[0]) is str and args[0] in CODES else 'IO_FAILURE'
        if receipt['code'] in ('SOURCE_INVALID','SOURCE_CHANGED','SOURCE_HASH_CHANGED','ANCESTOR_INVALID','ANCESTOR_CHANGED'):receipt['sourceVerified']=False
        if receipt['code']=='CURRENT_CHANGED':receipt['currentUnchanged']=False
        if receipt['code']=='SERVICES_CHANGED':receipt['servicesUnchanged']=False
        if receipt['mutationAttempted']:
            try:
                rolled=_rollback(fd,name,chain,before,target)
                receipt.update(status='FAILED_ROLLED_BACK' if rolled else 'FAILED_UNCHANGED',rollbackVerified=rolled,sourceVerified=True)
            except Exception:
                receipt['status']='FAILED_MUTATED_UNVERIFIED';receipt['sourceVerified']=False
    finally:
        _close(fd);_close(parent);_close(base)
    return receipt

if __name__=='__main__':
    # Direct CLI has no writable-operation arguments or admission channel.
    import sys
    print(json.dumps(repair(),sort_keys=True,separators=(',',':')))
    sys.exit(1)
