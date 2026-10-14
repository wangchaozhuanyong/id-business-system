"""Build the sealed ONLINE application on CI, without production authority.

Only Git objects are source inputs. No AWS, registry upload, database, service
startup, preflight or publication entry belongs to this program.
"""

import argparse
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '0a03fa28e6b844a18833d5c63f1de700f091fc64'
KIND = 'ONLINE_RECHARGE_CI_BUILD_ONLY'
LABEL = 'id-business-v2.ci-online-source-sha256'
IMAGES = ('api', 'admin', 'migrate', 'online-recharge')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
BUILD_TARGETS = (*IMAGES, 'api-build', 'admin-build', 'registration-dependencies')
STATE = {'stage': 'SOURCE_PROJECTION', 'image': None}


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_RECHARGE_CI_' + code)


def load(name):
    path = HERE / name
    spec = importlib.util.spec_from_file_location('online_ci_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('online-recharge-component-consumer.py')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def git_files(commit):
    need(type(commit) is str and re.fullmatch('[a-f0-9]{40}', commit), 'COMMIT_INVALID')
    records = git('ls-tree', '-r', '-z', commit).split(b'\0')
    names = {}
    for raw in filter(None, records):
        header, name = raw.split(b'\t', 1)
        mode, kind, _oid = header.split(b' ')
        path = name.decode('utf-8')
        need(kind == b'blob' and mode in (b'100644', b'100755')
             and path not in names and not PurePosixPath(path).is_absolute()
             and '..' not in PurePosixPath(path).parts, 'GIT_SOURCE_INVALID')
        names[path] = mode.decode('ascii')
    result = {}
    with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', commit)), mode='r:') as source:
        for row in source:
            if row.isdir():
                continue
            need(row.isfile() and row.name in names and row.name not in result
                 and row.size < 16 * 1024 * 1024, 'GIT_SOURCE_INVALID')
            mode = '100755' if row.mode & 0o111 else '100644'
            need(mode == names[row.name], 'GIT_MODE_CHANGED')
            result[row.name] = (source.extractfile(row).read(), mode)
    need(set(result) == set(names), 'GIT_SOURCE_INVALID')
    return result


def source_projection():
    commit = git('rev-parse', 'HEAD').decode().strip()
    tree = git('rev-parse', 'HEAD^{tree}').decode().strip()
    predecessor = c.sealed_authority()['producer']
    candidate, ordinary, base, online = (git_files(ref) for ref in
        (commit, predecessor['commit'], BASE, c.ONLINE_SOURCE))
    output, record = c.prepare_source_projection(candidate, ordinary, base, online,
        commit=commit, tree=tree, ordinary_producer=predecessor)
    need(record['releaseAuthority'] is False and output == candidate, 'PROJECTION_AUTHORITY_CHANGED')
    return output, record


def write_context(directory, files):
    STATE.update(stage='BUILD_PREPARATION', image=None)
    need(not directory.exists() and not directory.is_symlink(), 'BUILD_CONTEXT_EXISTS')
    need(all(not parent.is_symlink() for parent in directory.parents), 'BUILD_CONTEXT_INVALID')
    directory.mkdir(parents=True, mode=0o700)
    for name, (raw, mode) in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as handle:
            handle.write(raw)
        path.chmod(0o755 if mode == '100755' else 0o644)


def verify_context(directory, files):
    STATE.update(stage='CONTEXT_VERIFICATION', image=None)
    need(directory.is_dir() and not directory.is_symlink()
         and all(not parent.is_symlink() for parent in directory.parents), 'BUILD_CONTEXT_CHANGED')
    actual = {}
    for path in directory.rglob('*'):
        need(not path.is_symlink(), 'BUILD_CONTEXT_CHANGED')
        if path.is_file():
            actual[path.relative_to(directory).as_posix()] = (path.read_bytes(),
                '100755' if path.stat().st_mode & 0o111 else '100644')
        else:
            need(path.is_dir(), 'BUILD_CONTEXT_CHANGED')
    need(actual == files, 'BUILD_CONTEXT_CHANGED')


def docker(*args):
    return subprocess.check_output(['docker', *args], cwd=ROOT, timeout=3600).decode()


def build(name, dockerfile, target, context, record):
    need(name in BUILD_TARGETS, 'BUILD_TARGET_INVALID')
    STATE.update(stage='IMAGE_BUILD', image=name)
    reference = 'id-online-ci:' + record['candidateTree'] + '-' + name
    args = ['build', '--platform', 'linux/amd64', '--label',
        'org.opencontainers.image.revision=' + record['candidateCommit'], '--label',
        'id-business-v2.source-tree=' + record['candidateTree'], '--label',
        LABEL + '=' + c.fingerprint(record), '--label', 'id-business-v2.release-authority=false',
        '-f', str(dockerfile), '-t', reference]
    if target:
        args += ['--target', target]
    if name.startswith('admin'):
        args += ['--build-arg', 'AUTH_PROVIDER=local', '--build-arg', 'VITE_API_BASE_URL=/api',
                 '--build-arg', 'V2_BUILD_ID=v2-' + record['candidateCommit']]
    docker(*args, str(context))
    return reference


def content(reference, roots, *, relative=False):
    STATE.update(stage='IMAGE_CONTENT', image=next((name for name in BUILD_TARGETS
        if reference.endswith('-' + name)), None))
    # Explicit entrypoint never runs the API, engine, migration or web server.
    command = 'set -eu; export LC_ALL=C; '
    if relative:
        command += 'cd /workspace/engine; find . -type f ! -path "./runtime/*" '
        command += '! -path "./upstream/node_modules/*" -exec sha256sum {} + | sort'
    else:
        command += 'for p in ' + ' '.join(roots) + '; do test -e "$p"; done; '
        command += 'find ' + ' '.join(roots) + ' -type f -exec sha256sum {} + | sort'
    raw = docker('run', '--rm', '--network', 'none', '--read-only', '--no-healthcheck', '--entrypoint',
                 '/bin/sh', reference, '-c', command)
    rows = raw.splitlines()
    need(0 < len(rows) < 30000 and len(raw) < 8 * 1024 * 1024, 'IMAGE_CONTENT_INVALID')
    result = {}
    for line in rows:
        need(re.fullmatch(r'[a-f0-9]{64}  [^\r\n]+', line), 'IMAGE_CONTENT_INVALID')
        sha, path = line[:64], line[66:]
        need(path not in result and '..' not in PurePosixPath(path).parts and
             (path.startswith('./') if relative else any(path == root or path.startswith(root + '/')
              for root in roots)), 'IMAGE_CONTENT_INVALID')
        result[path] = sha
    return result


def summary(rows):
    return {'fileCount': len(rows), 'sha256': c.digest(('\n'.join(sorted(
        sha + '  ' + name for name, sha in rows.items())) + '\n').encode())}


def inspect(reference, record):
    STATE.update(stage='IMAGE_IDENTITY', image=next((name for name in BUILD_TARGETS
        if reference.endswith('-' + name)), None))
    rows = json.loads(docker('image', 'inspect', reference))
    need(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict, 'IMAGE_IDENTITY_CHANGED')
    value = rows[0]
    labels = value.get('Config', {}).get('Labels', {})
    need(value.get('Architecture') == 'amd64' and re.fullmatch('sha256:[a-f0-9]{64}', value.get('Id', ''))
         and labels.get('org.opencontainers.image.revision') == record['candidateCommit']
         and labels.get('id-business-v2.source-tree') == record['candidateTree']
         and labels.get(LABEL) == c.fingerprint(record)
         and labels.get('id-business-v2.release-authority') == 'false', 'IMAGE_IDENTITY_CHANGED')
    return value['Id']


def build_and_verify(context, files, record):
    verify_context(context, files)
    api_file, admin_file = context / 'apps/api/Dockerfile.mysql', context / 'apps/admin/Dockerfile'
    # Compare packaged compiled bytes with the actual Docker compilation stage.
    api_build = build('api-build', api_file, 'build', context, record)
    admin_build = build('admin-build', admin_file, 'build', context, record)
    registration = build('registration-dependencies', api_file, 'registration-dependencies', context, record)
    api_compiled = content(api_build, ('/app/apps/api/dist', '/app/packages/shared/dist'))
    api_deps = content(registration, ('/opt/id-registration/venv', '/opt/id-registration/dependency-audit.json'))
    admin_compiled = {name.replace('/app/apps/admin/dist/', '/usr/share/nginx/html/', 1): sha
        for name, sha in content(admin_build, ('/app/apps/admin/dist',)).items()}
    api_sources = {'/app/' + name: c.digest(raw) for name, (raw, _mode) in files.items()
        if name.startswith('apps/api/src/id-business-v2/auto-registration/') or
        name == 'apps/admin/src/v2/styles/base.css'}
    expected = {'api': {**api_compiled, **api_deps, **api_sources}, 'admin': admin_compiled,
        'migrate': {'/app/' + name: c.digest(raw) for name, (raw, _mode) in files.items()
            if name.startswith(c.MIGRATION_ROOT + '/') or name in (c.SCHEMA, 'apps/api/prisma-mysql/seed.ts')},
        'online-recharge': {'./' + name[len(ENGINE) + 1:]: c.digest(raw)
            for name, (raw, _mode) in files.items() if name.startswith(ENGINE + '/')
            and not name.startswith((ENGINE + '/runtime/', ENGINE + '/upstream/node_modules/'))}}
    roots = {'api': ('/app/apps/api/dist', '/app/packages/shared/dist',
        '/app/apps/api/src/id-business-v2/auto-registration', '/opt/id-registration/venv',
        '/opt/id-registration/dependency-audit.json', '/app/apps/admin/src/v2/styles/base.css'),
        'admin': ('/usr/share/nginx/html',), 'migrate': ('/app/apps/api/prisma-mysql',),
        'online-recharge': ()}
    images = {}
    for name in IMAGES:
        dockerfile, target, build_context = (admin_file, 'runtime', context) if name == 'admin' else (
            context / ENGINE / 'Dockerfile', '', context / ENGINE) if name == 'online-recharge' else (
            api_file, 'migration' if name == 'migrate' else 'runtime', context)
        reference = build(name, dockerfile, target, build_context, record)
        image_id = inspect(reference, record)
        measured = content(reference, roots[name], relative=name == 'online-recharge')
        STATE.update(stage='IMAGE_SOURCE_VERIFICATION', image=name)
        need(measured == expected[name], 'IMAGE_SOURCE_CHANGED')
        images[name] = {'reference': reference, 'imageId': image_id, **summary(measured)}
    verify_context(context, files)
    return {'version': 1, 'kind': KIND, 'scope': 'CI_ONLY', 'releaseAuthority': False,
        'sourceProjection': record, 'images': images, 'productionAccess': False,
        'registryPushPerformed': False, 'databaseAccessPerformed': False, 'businessActions': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-only', action='store_true', help='Validate Git objects without writing or Docker')
    args = parser.parse_args()
    if not args.source_only:
        need(os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux', 'LINUX_CI_RUNNER_REQUIRED')
    files, record = source_projection()
    if args.source_only:
        print(json.dumps({'kind': KIND, 'candidateCommit': record['candidateCommit'],
            'candidateTree': record['candidateTree'], 'fileCount': len(files),
            'applicationInputSha256': record['applicationInputSha256'],
            'onlineInputSha256': record['onlineInputSha256'], 'releaseAuthority': False,
            'status': 'CI_SOURCE_ONLY_VERIFIED'}))
        return
    directory = ROOT / '.deploy/ci-online-recharge' / record['candidateTree']
    context = directory / 'context'
    write_context(context, files)
    result = build_and_verify(context, files, record)
    STATE.update(stage='RECORD_PERSISTENCE', image=None)
    with (directory / 'ci-build-only.json').open('x') as handle:
        json.dump(result, handle, sort_keys=True, indent=2)
        handle.write('\n')
    print(json.dumps({'kind': KIND, 'candidateCommit': record['candidateCommit'],
        'candidateTree': record['candidateTree'], 'imageCount': len(result['images']),
        'releaseAuthority': False, 'status': 'CI_BUILD_ONLY_VERIFIED'}))


def failure_summary(error):
    code = str(error) if type(error) is RuntimeError and re.fullmatch(
        r'(?:ONLINE_RECHARGE_(?:CI|COMPONENT)|UNPUBLISHED_COMPONENT|API_ADMIN_PENDING)_[A-Z0-9_]+',
        str(error)) else 'ONLINE_RECHARGE_CI_BUILD_FAILED'
    category = ('COMMAND_FAILED' if isinstance(error, subprocess.CalledProcessError) else
        'RESULT_UNCONFIRMED' if isinstance(error, subprocess.TimeoutExpired) else
        'LOCAL_IO_FAILED' if isinstance(error, OSError) else 'VALIDATION_FAILED' if
        code != 'ONLINE_RECHARGE_CI_BUILD_FAILED' else 'RECORD_INVALID')
    kind = type(error).__name__
    allowed = ('RuntimeError', 'ValueError', 'TypeError', 'KeyError', 'FileExistsError',
               'FileNotFoundError', 'PermissionError', 'OSError', 'CalledProcessError', 'TimeoutExpired')
    return {'kind': KIND, 'releaseAuthority': False, 'status': 'FAILED', 'code': code,
        'stage': STATE['stage'], 'image': STATE['image'], 'category': category,
        'errorType': kind if kind in allowed else 'Exception'}


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(failure_summary(error)), file=sys.stderr)
        sys.exit(1)
