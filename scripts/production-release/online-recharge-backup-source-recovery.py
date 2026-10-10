"""Draft fixed MySQL backup leaf recovery; no CLI, AWS, database or path selection.

The separately reviewed transport supplies immutable original receipt/S3 data
and descriptors obtained by its no-follow fixed ancestor walk. It must verify
the complete baseline, historical source and receipt before calling. This
core cannot establish those authorities, qualify a release or fetch secrets.
"""
from dataclasses import dataclass
import base64
import ctypes
import errno
import hashlib
import os
import re
import secrets
import stat
import sys
import types

FIELDS=frozenset(('kind','mode','status','code','localStateBefore','localStateAfter',
                 'mutationAttempted','installed','rawOutputSuppressed'))
LOCAL_STATES=frozenset(('NOT_MEASURED','MISSING','NON_FILE','LINK','NONCANONICAL_PATH',
                       'OWNER','MODE','LINK_COUNT','SIZE','HASH','MATCH','IDENTITY_CHANGED'))
CODES=LOCAL_STATES|frozenset(('OK','SCOPE_INVALID','EXPECTED_INVALID','PARENT_UNSAFE',
    'HEAD_INVALID','DOWNLOAD_INVALID','REMOTE_FAILURE','TARGET_CHANGED','INSTALL_UNAVAILABLE','IO_FAILURE'))
STATUSES=frozenset(('DIAGNOSED','NO_CHANGE','RESTORED','REJECTED','FAILED_MUTATED_UNVERIFIED'))


class Rejected(RuntimeError):pass


@dataclass(frozen=True)
class ExpectedBackup:
    # Original receipt fields. s3Verified is the existing receipt field only.
    name:str
    size:int
    sha256:str
    s3Verified:bool
    # Original fixed predecessor configuration, already bound by transport.
    bucket:str
    prefix:str
    region:str

    @property
    def key(self):return self.prefix.rstrip('/')+'/'+self.name


@dataclass(frozen=True)
class DirectoryBinding:
    # Transport's held /opt/id-business-v2/backups and its mysql child FDs.
    # There is no caller-selected pathname in this core.
    parent_fd:int
    mysql_fd:int


def _need(condition,code):
    if not condition:raise Rejected(code)


def _uid():return 0


def _identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,
            info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def _directory_identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)


def _close(fd):
    if fd is not None:
        try:os.close(fd)
        except OSError:pass


def _directory(info):
    _need(stat.S_ISDIR(info.st_mode) and info.st_uid==_uid()
          and stat.S_IMODE(info.st_mode)&0o022==0,'PARENT_UNSAFE')


def _binding(binding,anchor=None):
    _need(type(binding) is DirectoryBinding
        and all(type(fd) is int and fd>=0 for fd in (binding.parent_fd,binding.mysql_fd)),
        'SCOPE_INVALID')
    parent=os.fstat(binding.parent_fd);child=os.fstat(binding.mysql_fd)
    _directory(parent);_directory(child)
    try:visible=os.stat('mysql',dir_fd=binding.parent_fd,follow_symlinks=False)
    except (FileNotFoundError,NotADirectoryError):raise Rejected('NONCANONICAL_PATH') from None
    _need(not stat.S_ISLNK(visible.st_mode),'NONCANONICAL_PATH')
    _directory(visible)
    fresh=os.open('mysql',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,
                  dir_fd=binding.parent_fd)
    try:
        opened=os.fstat(fresh);_directory(opened)
        _need(_directory_identity(opened)==_directory_identity(visible)==_directory_identity(child),
              'NONCANONICAL_PATH')
        current=(_directory_identity(parent),_directory_identity(child))
        _need(anchor is None or current==anchor,'NONCANONICAL_PATH')
        _need(_directory_identity(os.fstat(binding.parent_fd))==current[0]
              and _directory_identity(os.stat('mysql',dir_fd=binding.parent_fd,follow_symlinks=False))==current[1],
              'NONCANONICAL_PATH')
        return current
    finally:_close(fresh)


def _expected(value):
    _need(type(value) is ExpectedBackup
        and type(value.name) is str and re.fullmatch(r'id-business-v2-[0-9]{8}T[0-9]{6}Z\.sql\.gz',value.name)
        and type(value.size) is int and value.size>0
        and type(value.sha256) is str and re.fullmatch('[a-f0-9]{64}',value.sha256)
        and value.s3Verified is True
        and all(type(item) is str and item and '\0' not in item
                for item in (value.bucket,value.region))
        and type(value.prefix) is str and '\0' not in value.prefix,
        'EXPECTED_INVALID')
    return value


def _file_state(info):
    if stat.S_ISLNK(info.st_mode):return 'LINK'
    if not stat.S_ISREG(info.st_mode):return 'NON_FILE'
    if info.st_uid!=_uid():return 'OWNER'
    if stat.S_IMODE(info.st_mode)&0o022:return 'MODE'
    if info.st_nlink!=1:return 'LINK_COUNT'
    return None


def _visible(binding,name):
    try:return os.stat(name,dir_fd=binding.mysql_fd,follow_symlinks=False)
    except FileNotFoundError:return None


def _read(fd,binding,name,size,*,links=(1,)):
    before=os.fstat(fd)
    _need(stat.S_ISREG(before.st_mode) and before.st_uid==_uid()
          and stat.S_IMODE(before.st_mode)&0o022==0 and before.st_nlink in links,
          'IDENTITY_CHANGED')
    _need(before.st_size==size,'SIZE')
    os.lseek(fd,0,os.SEEK_SET);digest=hashlib.sha256();length=0
    while True:
        block=os.read(fd,min(65536,size-length+1))
        if not block:break
        length+=len(block);_need(length<=size,'IDENTITY_CHANGED');digest.update(block)
    after=os.fstat(fd);visible=_visible(binding,name)
    _need(visible is not None and _identity(before)==_identity(after)==_identity(visible),
          'IDENTITY_CHANGED')
    _need(length==size,'SIZE')
    return before,digest.hexdigest()


def _diagnose(expected,binding,anchor):
    _binding(binding,anchor);visible=_visible(binding,expected.name)
    if visible is None:
        _binding(binding,anchor)
        _need(_visible(binding,expected.name) is None,'TARGET_CHANGED')
        return 'MISSING'
    state=_file_state(visible)
    if state:return state
    if visible.st_size!=expected.size:return 'SIZE'
    fd=None
    try:
        fd=os.open(expected.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,
                   dir_fd=binding.mysql_fd)
        _need(_identity(visible)==_identity(os.fstat(fd)),'IDENTITY_CHANGED')
        _,digest=_read(fd,binding,expected.name,expected.size)
        _binding(binding,anchor)
        return 'MATCH' if digest==expected.sha256 else 'HASH'
    finally:_close(fd)


def _head(value,expected):
    _need(type(value) is dict and set(value)=={'ContentLength','ChecksumSHA256','ServerSideEncryption'}
          and type(value['ContentLength']) is int and value['ContentLength']==expected.size
          and value['ChecksumSHA256']==base64.b64encode(bytes.fromhex(expected.sha256)).decode()
          and value['ServerSideEncryption']=='AES256','HEAD_INVALID')


def _missing(expected,binding,anchor):
    _binding(binding,anchor)
    _need(_visible(binding,expected.name) is None,'TARGET_CHANGED')


def _install_from_fd(fd,parent,name):
    # Fixed Linux production host: AT_EMPTY_PATH links the held inode itself,
    # never a reopened temporary pathname, and linkat cannot overwrite target.
    # Unsupported platforms fail closed; there is no pathname fallback.
    _need(sys.platform=='linux','INSTALL_UNAVAILABLE')
    libc=ctypes.CDLL(None,use_errno=True)
    function=libc.linkat
    function.argtypes=(ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_int)
    function.restype=ctypes.c_int
    if function(fd,b'',parent,name.encode('ascii'),0x1000)!=0:
        code=ctypes.get_errno()
        if code==errno.EEXIST:raise Rejected('TARGET_CHANGED')
        if code in (errno.ENOSYS,errno.EINVAL,errno.EPERM):raise Rejected('INSTALL_UNAVAILABLE')
        raise Rejected('IO_FAILURE')


def recover(expected,binding,mode='diagnose',*,head_read=None,download=None):
    """Pure local leaf action plus fixed transport callbacks; never a trust flag.

    head_read(expected) returns only the three original S3 identity fields.
    download(expected,fd) streams the original fixed key to the core's held
    0600 FD. The pinned transport MUST bound stdout to expected.size and use
    a total process deadline without retaining stderr. Core rechecks the
    actual FD size/hash and its visible inode; no download path is supplied.
    Callbacks are never invoked in diagnose or for any existing target.
    """
    receipt={'kind':'MYSQL_BACKUP_LOCAL_RECOVERY_V1','mode':mode if type(mode) is str and mode in ('diagnose','restore_missing') else 'INVALID',
             'status':'REJECTED','code':'IO_FAILURE','localStateBefore':'NOT_MEASURED',
             'localStateAfter':'NOT_MEASURED','mutationAttempted':False,'installed':False,'rawOutputSuppressed':True}
    fd=None;temporary=None;anchor=None;created_identity=None
    try:
        _need(type(mode) is str and mode in ('diagnose','restore_missing'),'SCOPE_INVALID')
        expected=_expected(expected);anchor=_binding(binding)
        state=_diagnose(expected,binding,anchor);receipt['localStateBefore']=state
        receipt['localStateAfter']=state
        if mode=='diagnose':
            receipt.update(status='DIAGNOSED',code='OK');return receipt
        if state=='MATCH':
            receipt.update(status='NO_CHANGE',code='OK');return receipt
        _need(state=='MISSING',state)
        _need(type(head_read) is types.FunctionType and type(download) is types.FunctionType,'SCOPE_INVALID')
        _missing(expected,binding,anchor)
        try:remote=head_read(expected)
        except Exception:raise Rejected('REMOTE_FAILURE') from None
        _head(remote,expected);_missing(expected,binding,anchor)
        temporary='.backup-recovery-'+secrets.token_hex(16)+'.partial'
        fd=os.open(temporary,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,
                   0o600,dir_fd=binding.mysql_fd)
        created=os.fstat(fd)
        created_identity=(created.st_dev,created.st_ino)
        _need(stat.S_ISREG(created.st_mode) and created.st_uid==_uid()
              and stat.S_IMODE(created.st_mode)==0o600 and created.st_nlink==1,
              'IDENTITY_CHANGED')
        try:download(expected,fd)
        except Rejected:raise
        except Exception:raise Rejected('REMOTE_FAILURE') from None
        downloaded=os.fstat(fd)
        _need((downloaded.st_dev,downloaded.st_ino)==created_identity
              and downloaded.st_uid==created.st_uid and downloaded.st_gid==created.st_gid
              and stat.S_ISREG(downloaded.st_mode) and stat.S_IMODE(downloaded.st_mode)==0o600
              and downloaded.st_nlink==1,'IDENTITY_CHANGED')
        _need(downloaded.st_size==expected.size,'DOWNLOAD_INVALID')
        os.fsync(fd)
        _,digest=_read(fd,binding,temporary,expected.size)
        _need(digest==expected.sha256,'DOWNLOAD_INVALID')
        _missing(expected,binding,anchor)
        # FD-bound atomic install refuses any existing destination.
        receipt['mutationAttempted']=True
        _install_from_fd(fd,binding.mysql_fd,expected.name)
        receipt['installed']=True;receipt['localStateAfter']='NOT_MEASURED'
        _binding(binding,anchor)
        current,digest=_read(fd,binding,expected.name,expected.size,links=(2,))
        _need(digest==expected.sha256 and stat.S_IMODE(current.st_mode)==0o600,'IDENTITY_CHANGED')
        temp=_visible(binding,temporary)
        _need(temp is not None and _identity(temp)==_identity(current),'IDENTITY_CHANGED')
        os.unlink(temporary,dir_fd=binding.mysql_fd);temporary=None
        os.fsync(binding.mysql_fd)
        _binding(binding,anchor)
        _,digest=_read(fd,binding,expected.name,expected.size)
        _need(digest==expected.sha256,'IDENTITY_CHANGED')
        receipt.update(status='RESTORED',code='OK',localStateAfter='MATCH')
    except Exception as error:
        args=BaseException.args.__get__(error)
        code=args[0] if type(error) is Rejected and type(args) is tuple and len(args)==1 and type(args[0]) is str and args[0] in CODES else 'IO_FAILURE'
        receipt['code']=code
        if receipt['installed']:receipt['status']='FAILED_MUTATED_UNVERIFIED'
        elif code in LOCAL_STATES and receipt['localStateBefore']=='NOT_MEASURED':receipt['localStateBefore']=code
    finally:
        if temporary is not None and fd is not None and created_identity is not None:
            try:
                _binding(binding,anchor);now=_visible(binding,temporary);held=os.fstat(fd)
                # Remove only our original temporary inode; never a replacement.
                if (now is not None and (now.st_dev,now.st_ino)==created_identity
                        and _identity(now)==_identity(held)):
                    os.unlink(temporary,dir_fd=binding.mysql_fd)
            except Exception:pass
        _close(fd)
    return receipt
