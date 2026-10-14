"""Build the sealed ONLINE application on CI, without production authority.

Only Git objects are source inputs. No AWS, registry upload, database, service
startup, preflight or publication entry belongs to this program.
"""

import argparse
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import stat
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
RUNTIME_LABEL = 'id-business-v2.online-component-source-sha256'
BRANCH = 'codex/online-proof-reuse-integration-20261014'
CI_BASE = 'fff7b257fa402e14da5d9aa43aa4ea22095695c5'
SYNTHETIC_REPOSITORY = '000000000000.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
ACTIVE_ENV = None
ACTIVE_REFERENCES = frozenset()
ACTIVE_COMMANDS = frozenset()
ADMITTED_TREE = None
CONTENT_ROOTS = {
    'api-build': ('/app/apps/api/dist', '/app/packages/shared/dist'),
    'admin-build': ('/app/apps/admin/dist',),
    'registration-dependencies': ('/opt/id-registration/venv', '/opt/id-registration/dependency-audit.json'),
    'api': ('/app/apps/api/dist', '/app/packages/shared/dist',
        '/app/apps/api/src/id-business-v2/auto-registration', '/opt/id-registration/venv',
        '/opt/id-registration/dependency-audit.json', '/app/apps/admin/src/v2/styles/base.css'),
    'admin': ('/usr/share/nginx/html',), 'migrate': ('/app/apps/api/prisma-mysql',),
    'online-recharge': ()}
# Read-only OCI verification of this exact index and amd64 manifest proves the
# base's two HTML files originate in layer 61ca4f733c802afd9e05a32f0de0361b6d713b8b53292dc15fb093229f648674.
# COPY of the compiled directory replaces index.html and retains 50x.html.
ADMIN_RUNTIME_BASE = 'nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10'
ADMIN_BASE_PLATFORM_MANIFEST = 'sha256:62223d644fa234c3a1cc785ee14242ec47a77364226f1c811d2f669f96dc2ac8'
ADMIN_BASE_IMAGE_ID = 'sha256:6769dc3a703c719c1d2756bda113659be28ae16cf0da58dd5fd823d6b9a050ea'
ADMIN_BASE_HTML = {
    '/usr/share/nginx/html/50x.html': '876766b4e80133fd490603e073d3567425b88794828a9292104244c9e40875ed',
    '/usr/share/nginx/html/index.html': 'fb47468a2cd3953c7131431991afcc6a2703f14640520102eea0a685a7e8d6de'}


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
    return subprocess.check_output(['git', *args], cwd=ROOT, env=public_environment())


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
    require_docker_command(args)
    result = subprocess.run(['docker', *args], cwd=ROOT, timeout=3600, env=dict(ACTIVE_ENV),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    need(result.returncode == 0, 'DOCKER_COMMAND_FAILED')
    return result.stdout.decode('utf-8')


def build_arguments(name, dockerfile, target, context, record):
    need(name in BUILD_TARGETS, 'BUILD_TARGET_INVALID')
    reference = 'id-online-ci:' + record['candidateTree'] + '-' + name
    args = ['build', '--platform', 'linux/amd64', '--label',
        'org.opencontainers.image.revision=' + record['candidateCommit'], '--label',
        'id-business-v2.source-tree=' + record['candidateTree'], '--label',
        LABEL + '=' + c.fingerprint(record), '--label', RUNTIME_LABEL + '=' + c.fingerprint(record),
        '--label', 'id-business-v2.ci-only=NOT_FOR_RELEASE', '--label', 'id-business-v2.release-authority=false',
        '-f', str(dockerfile), '-t', reference]
    if target:
        args += ['--target', target]
    if name.startswith('admin'):
        args += ['--build-arg', 'AUTH_PROVIDER=local', '--build-arg', 'VITE_API_BASE_URL=/api',
                 '--build-arg', 'V2_BUILD_ID=v2-' + record['candidateCommit']]
    return (*args, str(context))


def build(name, dockerfile, target, context, record):
    args = build_arguments(name, dockerfile, target, context, record)
    STATE.update(stage='IMAGE_BUILD', image=name)
    approved_docker(*args)
    reference = 'id-online-ci:' + record['candidateTree'] + '-' + name
    return reference


def content_command(roots, *, relative=False):
    command = 'set -eu; export LC_ALL=C; '
    if relative:
        command += 'cd /workspace/engine; find . -type f ! -path "./runtime/*" '
        command += '! -path "./upstream/node_modules/*" -exec sha256sum {} + | sort'
    else:
        command += 'for p in ' + ' '.join(roots) + '; do test -e "$p"; done; '
        command += 'find ' + ' '.join(roots) + ' -type f -exec sha256sum {} + | sort'
    return command


def content_arguments(reference, command):
    return ('run', '--pull=never', '--rm', '--network', 'none', '--read-only',
        '--no-healthcheck', '--entrypoint', '/bin/sh', reference, '-c', command)


def content(reference, roots, *, relative=False):
    STATE.update(stage='IMAGE_CONTENT', image=next((name for name in BUILD_TARGETS
        if reference.endswith('-' + name)), 'admin' if reference == ADMIN_RUNTIME_BASE else None))
    # Explicit entrypoint never runs the API, engine, migration or web server.
    raw = approved_docker(*content_arguments(reference, content_command(roots, relative=relative)))
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
    rows = json.loads(approved_docker('image', 'inspect', reference))
    need(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict, 'IMAGE_IDENTITY_CHANGED')
    value = rows[0]
    labels = value.get('Config', {}).get('Labels', {})
    need(value.get('Architecture') == 'amd64' and re.fullmatch('sha256:[a-f0-9]{64}', value.get('Id', ''))
         and labels.get('org.opencontainers.image.revision') == record['candidateCommit']
         and labels.get('id-business-v2.source-tree') == record['candidateTree']
         and labels.get(LABEL) == c.fingerprint(record)
         and labels.get(RUNTIME_LABEL) == c.fingerprint(record)
         and labels.get('id-business-v2.ci-only') == 'NOT_FOR_RELEASE'
         and labels.get('id-business-v2.release-authority') == 'false', 'IMAGE_IDENTITY_CHANGED')
    return value['Id']


def admin_base_content(files):
    """Authenticate inherited HTML, rather than exempting arbitrary extra files."""
    STATE.update(stage='ADMIN_BASE_VERIFICATION', image='admin')
    raw, mode = files.get('apps/admin/Dockerfile', (b'', ''))
    need(type(raw) is bytes and mode == '100644' and re.findall(
        rb'^FROM (\S+) AS runtime$', raw, flags=re.MULTILINE) == [ADMIN_RUNTIME_BASE.encode()],
        'ADMIN_BASE_SOURCE_CHANGED')
    # BuildKit's cache does not guarantee the base is in Docker's image store.
    # Pull only its immutable public digest; never authenticate or upload.
    approved_docker('pull', '--platform', 'linux/amd64', ADMIN_RUNTIME_BASE)
    metadata = json.loads(approved_docker('image', 'inspect', ADMIN_RUNTIME_BASE))
    need(type(metadata) is list and len(metadata) == 1 and type(metadata[0]) is dict,
         'ADMIN_BASE_IDENTITY_CHANGED')
    value = metadata[0]
    digests = value.get('RepoDigests')
    need(value.get('Architecture') == 'amd64' and value.get('Os') == 'linux'
         and value.get('Id') == ADMIN_BASE_IMAGE_ID and type(digests) is list
         and any(type(digest) is str and digest in (
             'nginx@' + ADMIN_RUNTIME_BASE.split('@')[1],
             'nginx@' + ADMIN_BASE_PLATFORM_MANIFEST,
             'docker.io/library/nginx@' + ADMIN_RUNTIME_BASE.split('@')[1],
             'docker.io/library/nginx@' + ADMIN_BASE_PLATFORM_MANIFEST) for digest in digests),
         'ADMIN_BASE_IDENTITY_CHANGED')
    measured = content(ADMIN_RUNTIME_BASE, ('/usr/share/nginx/html',))
    STATE.update(stage='ADMIN_BASE_VERIFICATION', image='admin')
    need(measured == ADMIN_BASE_HTML, 'ADMIN_BASE_CONTENT_CHANGED')
    return measured, {'reference': ADMIN_RUNTIME_BASE, 'imageId': value['Id'],
        'platformManifestDigest': ADMIN_BASE_PLATFORM_MANIFEST, **summary(measured)}


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
    need('/usr/share/nginx/html/index.html' in admin_compiled, 'ADMIN_COMPILED_INDEX_MISSING')
    api_sources = {'/app/' + name: c.digest(raw) for name, (raw, _mode) in files.items()
        if name.startswith('apps/api/src/id-business-v2/auto-registration/') or
        name == 'apps/admin/src/v2/styles/base.css'}
    expected = {'api': {**api_compiled, **api_deps, **api_sources}, 'admin': admin_compiled,
        'migrate': {'/app/' + name: c.digest(raw) for name, (raw, _mode) in files.items()
            if name.startswith(c.MIGRATION_ROOT + '/') or name in (c.SCHEMA, 'apps/api/prisma-mysql/seed.ts')},
        'online-recharge': {'./' + name[len(ENGINE) + 1:]: c.digest(raw)
            for name, (raw, _mode) in files.items() if name.startswith(ENGINE + '/')
            and not name.startswith((ENGINE + '/runtime/', ENGINE + '/upstream/node_modules/'))}}
    images = {}
    base_record = None
    for name in IMAGES:
        dockerfile, target, build_context = (admin_file, 'runtime', context) if name == 'admin' else (
            context / ENGINE / 'Dockerfile', '', context / ENGINE) if name == 'online-recharge' else (
            api_file, 'migration' if name == 'migrate' else 'runtime', context)
        reference = build(name, dockerfile, target, build_context, record)
        image_id = inspect(reference, record)
        if name == 'admin':
            inherited, base_record = admin_base_content(files)
            expected[name] = {**inherited, **admin_compiled}
        measured = content(reference, CONTENT_ROOTS[name], relative=name == 'online-recharge')
        STATE.update(stage='IMAGE_SOURCE_VERIFICATION', image=name)
        need(measured == expected[name], 'IMAGE_SOURCE_CHANGED')
        images[name] = {'reference': reference, 'imageId': image_id, **summary(measured)}
    verify_context(context, files)
    return {'version': 1, 'kind': KIND, 'scope': 'CI_ONLY', 'releaseAuthority': False,
        'sourceProjection': record, 'images': images, 'productionAccess': False,
        'adminRuntimeBase': base_record, 'notForRelease': True,
        'registryPushPerformed': False, 'databaseAccessPerformed': False, 'businessActions': 0}


def public_environment():
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8', 'TZ': 'UTC', 'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_CONFIG_NOSYSTEM': '1'}


def require_docker_command(args):
    # Authorization is fixed before execution; callers cannot enroll new tuples.
    need(ACTIVE_ENV is not None and args and all(type(arg) is str for arg in args)
         and tuple(args) in ACTIVE_COMMANDS, 'DOCKER_COMMAND_FORBIDDEN')
    references = ((args[args.index('-t') + 1],) if args[0] == 'build' else
        args[1:] if args[0] == 'tag' else (args[-3],) if args[0] == 'run' else (args[-1],))
    need(all(reference in ACTIVE_REFERENCES for reference in references), 'DOCKER_COMMAND_FORBIDDEN')


def approved_docker(*args):
    require_docker_command(args)
    return docker(*args)


def execution_allowlist(context, record, producer=None):
    need(type(record) is dict and record.get('releaseAuthority') is False
         and all(type(record.get(key)) is str and re.fullmatch('[a-f0-9]{40}', record[key])
             for key in ('candidateCommit', 'candidateTree')), 'CI_PRODUCER_CHANGED')
    if producer is not None:
        need(type(producer) is dict and set(producer) == {
             'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
         and producer['commit'] == record['candidateCommit']
         and producer['sourceTree'] == record['candidateTree']
         and all(type(producer[key]) is str and re.fullmatch('[1-9][0-9]*', producer[key])
             for key in ('workflowRunId', 'workflowRunAttempt')), 'CI_PRODUCER_CHANGED')
    references = {'id-online-ci:' + record['candidateTree'] + '-' + name for name in BUILD_TARGETS}
    commands = set()
    for name in BUILD_TARGETS:
        dockerfile, target, selected = (context / 'apps/admin/Dockerfile',
            'build' if name == 'admin-build' else 'runtime', context) if name.startswith('admin') else (
            context / ENGINE / 'Dockerfile', '', context / ENGINE) if name == 'online-recharge' else (
            context / 'apps/api/Dockerfile.mysql', 'build' if name == 'api-build' else
            'registration-dependencies' if name == 'registration-dependencies' else
            'migration' if name == 'migrate' else 'runtime', context)
        commands.add(build_arguments(name, dockerfile, target, selected, record))
        reference = 'id-online-ci:' + record['candidateTree'] + '-' + name
        commands.add(('image', 'inspect', reference))
        commands.add(content_arguments(reference, content_command(CONTENT_ROOTS[name],
            relative=name == 'online-recharge')))
    references.add(ADMIN_RUNTIME_BASE)
    commands.update((('pull', '--platform', 'linux/amd64', ADMIN_RUNTIME_BASE),
        ('image', 'inspect', ADMIN_RUNTIME_BASE),
        content_arguments(ADMIN_RUNTIME_BASE, content_command(CONTENT_ROOTS['admin']))))
    if producer is not None:
        online = load('online-recharge-scope.py')
        for name in IMAGES:
            alias = SYNTHETIC_REPOSITORY + ':' + producer['commit'] + '-' + producer['workflowRunId'] + '-' + producer['workflowRunAttempt'] + '-' + name
            references.add(alias)
            commands.update((('tag', 'id-online-ci:' + record['candidateTree'] + '-' + name, alias),
                ('image', 'inspect', alias), content_arguments(alias, online.content_command(name))))
    return frozenset(commands), frozenset(references)


def configure_execution(directory, record, *, strict=False):
    global ACTIVE_ENV, ACTIVE_COMMANDS, ACTIVE_REFERENCES
    ACTIVE_ENV, ACTIVE_COMMANDS, ACTIVE_REFERENCES = None, frozenset(), frozenset()
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux', 'LINUX_CI_RUNNER_REQUIRED')
    need(type(record.get('candidateTree')) is str and re.fullmatch('[a-f0-9]{40}', record['candidateTree'])
         and directory == ROOT / '.deploy/ci-online-recharge' / record['candidateTree'], 'CI_ADMISSION_CHANGED')
    producer = None
    context = directory / 'context'
    if strict:
        need(ADMITTED_TREE == record['candidateTree'] and record.get('ciOnly') is True
             and record.get('notForRelease') is True, 'CI_ADMISSION_CHANGED')
        producer = record['candidateProducer']
        need(producer.get('workflowRunId') == os.environ.get('GITHUB_RUN_ID') and
             producer.get('workflowRunAttempt') == os.environ.get('GITHUB_RUN_ATTEMPT'), 'CI_PRODUCER_CHANGED')
        context = directory / load('online-recharge-component-runtime.py').CONTEXT
    commands, references = execution_allowlist(context, record, producer)
    temporary = directory / 'private-tmp'; config = directory / 'docker-config'
    for path in (ROOT / '.deploy', ROOT / '.deploy/ci-online-recharge', directory,
                 directory / '.deploy', directory / '.deploy/production-release', temporary, config):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        need(path.resolve() == path and not path.is_symlink(), 'PRIVATE_DIRECTORY_CHANGED')
        path.chmod(0o700)
    need(not list(config.iterdir()), 'DOCKER_CONFIG_NOT_EMPTY')
    ACTIVE_ENV = {**public_environment(), 'DOCKER_CONFIG': str(config),
        'TMPDIR': str(temporary), 'DOCKER_BUILDKIT': '1'}
    ACTIVE_COMMANDS, ACTIVE_REFERENCES = commands, references
    return context


def ci_entry_guard(admitted_tree):
    global ADMITTED_TREE
    ADMITTED_TREE = None
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux', 'LINUX_CI_RUNNER_REQUIRED')
    need(os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system'
         and os.environ.get('GITHUB_EVENT_NAME') == 'pull_request'
         and os.environ.get('CHECK_MODE') == 'ci-only' and os.environ.get('NODE_ENV') == 'test', 'CI_ADMISSION_CHANGED')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_bytes())
    pr = event.get('pull_request', {})
    need(pr.get('head', {}).get('ref') == BRANCH and pr.get('base', {}).get('sha') == CI_BASE
         and type(pr.get('head', {}).get('sha')) is str
         and re.fullmatch('[a-f0-9]{40}', pr['head']['sha'])
         and pr.get('head', {}).get('repo', {}).get('full_name') == 'wangchaozhuanyong/id-business-system'
         and pr.get('base', {}).get('repo', {}).get('full_name') == 'wangchaozhuanyong/id-business-system', 'CI_ADMISSION_CHANGED')
    tree = git('rev-parse', 'HEAD^{tree}').decode().strip()
    need(type(admitted_tree) is str and re.fullmatch('[a-f0-9]{40}', admitted_tree)
         and admitted_tree == tree == git('rev-parse', pr['head']['sha'] + '^{tree}').decode().strip(), 'CI_ADMISSION_CHANGED')
    allowed = {'scripts/production-release/online-recharge-component-runtime.py',
        'scripts/production-release/online-recharge-component-runtime.test.py',
        'scripts/production-release/online-recharge-component-readonly.py',
        'scripts/production-release/online-recharge-component-readonly.test.py',
        'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs',
        'scripts/production-release/online-recharge-ci-build.py',
        'scripts/production-release/online-recharge-ci-build.test.py',
        'docs/CENTRAL_RELEASE_20261002.md', 'docs/WORKSPACE_RELEASE_CLEANUP_20261014.md'}
    changed = set(git('diff', '--name-only', CI_BASE, 'HEAD').decode().splitlines())
    need(changed == allowed, 'CI_ADMISSION_CHANGED')
    ADMITTED_TREE = tree
    return tree


def file_identity(path):
    row = path.lstat()
    return (row.st_dev, row.st_ino, row.st_mode, row.st_nlink, row.st_uid, row.st_gid,
        row.st_size, row.st_mtime_ns, row.st_ctime_ns)


class ReadOnlyDockerDriver:
    def __init__(self, runtime, producer, references):
        self.runtime = runtime; self.producer = producer; self.references = references
        self.controller = load('remote-deploy.py')
        self.online = load('online-recharge-scope.py')

    def api_admin_scope(self, scope):
        need(scope == 'API_ADMIN_WORKSPACE', 'DRIVER_SCOPE_FORBIDDEN')
        return self.controller.api_admin_scope(scope)

    def require(self, value, code):
        if not value:
            # These callers supply fixed codes from sealed modules, never private values.
            raise RuntimeError('ONLINE_RECHARGE_CI_DOCKER_EVIDENCE_CHANGED')

    def run(self, *args, timeout=None):
        need(args and args[0] == 'docker', 'DRIVER_COMMAND_FORBIDDEN')
        for name, reference in self.references.items():
            if args == ('docker', 'image', 'inspect', reference):
                return approved_docker(*args[1:])
            expected = ('docker', 'run', '--rm', '--network', 'none', '--read-only',
                '--entrypoint', '/bin/sh', reference, '-c', self.online.content_command(name))
            if args == expected:
                return approved_docker(*content_arguments(reference, self.online.content_command(name)))
        raise RuntimeError('ONLINE_RECHARGE_CI_DRIVER_COMMAND_FORBIDDEN')


@contextmanager
def source_boundaries(runtime, files, record, producer, transport):
    original_preflight, original_source = runtime.validate_preflight, runtime.source
    baseline = {'ciOnly': True, 'notForRelease': True}
    def preflight(core, actual, selected, expected):
        need(actual == transport and selected == producer and expected == 'CI_ONLY_NOT_FOR_RELEASE', 'CI_PREFLIGHT_CHANGED')
        return {'baseline': baseline}
    def source(driver, selected, evidence):
        need(selected == producer and evidence == baseline, 'CI_SOURCE_CHANGED')
        return files, files, record
    runtime.validate_preflight, runtime.source = preflight, source
    try:
        yield
    finally:
        runtime.validate_preflight, runtime.source = original_preflight, original_source


@contextmanager
def working_directory(directory):
    previous = Path.cwd()
    os.chdir(directory)
    try:
        yield
    finally:
        os.chdir(previous)


def runtime_source_record(files, record, producer, runtime):
    for name in runtime.HELPERS:
        path = HERE / name
        need(files['scripts/production-release/' + name] == (path.read_bytes(),
            '100755' if path.stat().st_mode & 0o111 else '100644'), 'EXECUTOR_SOURCE_CHANGED')
    return {**record, 'kind': runtime.KIND + '_SOURCE', 'contextPath': runtime.CONTEXT,
        'candidateProducer': producer, 'ordinaryAuthoritySha256': c.fingerprint(c.sealed_authority()),
        'actualPredecessor': c.admin_successor_authority()['producer'],
        'adminAuthoritySha256': c.fingerprint(c.admin_successor_authority()),
        'candidateArchiveSha256': c.digest(git('archive', '--format=tar', record['candidateCommit'])),
        'ciOnly': True, 'notForRelease': True, 'releaseAuthority': False}


def double_build_proof(directory, files, record, producer, runtime, build_result):
    STATE.update(stage='DOUBLE_BUILD_PROOF', image=None)
    core = c.load_core(c.sealed_authority()['coreSha256'])
    references = {}
    for name in IMAGES:
        alias = SYNTHETIC_REPOSITORY + ':' + producer['commit'] + '-' + producer['workflowRunId'] + '-' + producer['workflowRunAttempt'] + '-' + name
        approved_docker('tag', build_result['images'][name]['reference'], alias)
        references[name] = alias
    driver = ReadOnlyDockerDriver(runtime, producer, references)
    transport = {'version': 1, 'kind': KIND + '_NOT_FOR_RELEASE_PREFLIGHT', 'scope': 'CI_ONLY',
        'notForRelease': True, 'producer': producer, 'expectedCurrent': 'CI_ONLY_NOT_FOR_RELEASE'}
    # An unadapted formal entry must reject this transport before any production action.
    try:
        runtime.validate_preflight(core, transport, producer, transport['expectedCurrent'])
    except RuntimeError:
        pass
    else:
        raise RuntimeError('ONLINE_RECHARGE_CI_FORMAL_PREFLIGHT_ACCEPTED')
    with working_directory(directory):
        proof_path = directory / runtime.PROOF
        need(not proof_path.exists() and not proof_path.is_symlink(), 'BUILD_PROOF_PREEXISTS')
        core.write_private(directory / runtime.PROJECTION, record)
        with source_boundaries(runtime, files, record, producer, transport):
            first = runtime.build_proof(driver, producer, transport, producer['workflowRunId'], SYNTHETIC_REPOSITORY)
            raw = core.private_bytes(proof_path); identity = file_identity(proof_path)
            parent_identity = file_identity(proof_path.parent)
            second = runtime.build_proof(driver, producer, transport, producer['workflowRunId'], SYNTHETIC_REPOSITORY)
            need(first == second and core.private_bytes(proof_path) == raw
                 and file_identity(proof_path) == identity
                 and file_identity(proof_path.parent) == parent_identity, 'BUILD_PROOF_REUSE_CHANGED')
    # Do not include/upload the inner formal-shaped proof or its CI transport.
    return {'kind': KIND + '_DOUBLE_PROOF', 'scope': 'CI_ONLY', 'notForRelease': True,
        'firstCreated': True, 'secondReused': True, 'samePrivatePath': True,
        'proofRawSha256': c.digest(raw), 'proofIdentityUnchanged': True,
        'parentIdentityUnchanged': True, 'realImagesReverified': True,
        'formalPreflightRejected': True, 'productionAccess': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-only', action='store_true', help='Validate Git objects without writing or Docker')
    parser.add_argument('--ci-real-build-not-for-release', action='store_true')
    parser.add_argument('--admitted-source-tree')
    args = parser.parse_args()
    need(args.admitted_source_tree is None or args.ci_real_build_not_for_release, 'CI_ADMISSION_REQUIRED')
    if not args.source_only:
        need(os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux', 'LINUX_CI_RUNNER_REQUIRED')
        if args.ci_real_build_not_for_release:
            ci_entry_guard(args.admitted_source_tree)
    files, source = source_projection()
    if args.source_only:
        print(json.dumps({'kind': KIND, 'candidateCommit': source['candidateCommit'],
            'candidateTree': source['candidateTree'], 'fileCount': len(files),
            'applicationInputSha256': source['applicationInputSha256'],
            'onlineInputSha256': source['onlineInputSha256'],
            'releaseAuthority': False, 'status': 'CI_SOURCE_ONLY_VERIFIED'}))
        return
    record = source
    if args.ci_real_build_not_for_release:
        runtime = load('online-recharge-component-runtime.py')
        core = c.load_core(c.sealed_authority()['coreSha256'])
        producer = core.producer(source['candidateCommit'], source['candidateTree'],
            os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
        record = runtime_source_record(files, source, producer, runtime)
    directory = ROOT / '.deploy/ci-online-recharge' / record['candidateTree']
    context = configure_execution(directory, record, strict=args.ci_real_build_not_for_release)
    write_context(context, files)
    result = build_and_verify(context, files, record)
    if args.ci_real_build_not_for_release:
        result['doubleProof'] = double_build_proof(directory, files, record, producer, runtime, result)
    STATE.update(stage='RECORD_PERSISTENCE', image=None)
    with (directory / 'ci-build-only.json').open('x') as handle:
        json.dump(result, handle, sort_keys=True, indent=2); handle.write('\n')
    if not args.ci_real_build_not_for_release:
        print(json.dumps({'kind': KIND, 'candidateCommit': record['candidateCommit'],
            'candidateTree': record['candidateTree'], 'imageCount': len(result['images']),
            'releaseAuthority': False, 'status': 'CI_BUILD_ONLY_VERIFIED'}))
        return
    print(json.dumps({'kind': KIND, 'scope': 'CI_ONLY', 'notForRelease': True,
        'candidateCommit': record['candidateCommit'], 'candidateTree': record['candidateTree'],
        'images': result['images'], 'doubleProof': result['doubleProof'],
        'releaseAuthority': False, 'productionAccess': False, 'registryPushPerformed': False,
        'databaseAccessPerformed': False, 'businessActions': 0, 'status': 'CI_BUILD_DOUBLE_PROOF_VERIFIED'}))


def failure_summary(error):
    # Exact built-in types only; never inspect/format unknown exception values.
    category = 'RECORD_INVALID'
    for error_type, closed in ((subprocess.CalledProcessError, 'COMMAND_FAILED'),
        (subprocess.TimeoutExpired, 'RESULT_UNCONFIRMED'), (FileExistsError, 'LOCAL_IO_FAILED'),
        (FileNotFoundError, 'LOCAL_IO_FAILED'), (PermissionError, 'LOCAL_IO_FAILED'),
        (OSError, 'LOCAL_IO_FAILED'), (RuntimeError, 'VALIDATION_FAILED')):
        if type(error) is error_type:
            category = closed; break
    return {'kind': KIND, 'scope': 'CI_ONLY', 'notForRelease': True, 'releaseAuthority': False,
        'status': 'FAILED', 'code': 'ONLINE_RECHARGE_CI_BUILD_FAILED', 'stage': STATE['stage'],
        'image': STATE['image'], 'category': category}


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(failure_summary(error)), file=sys.stderr)
        sys.exit(1)
