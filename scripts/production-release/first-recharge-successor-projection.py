"""Exact recharge repair overlay on the independently published API/Admin inputs."""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
from types import SimpleNamespace

HERE = Path(__file__).parent
CONTEXT = '.deploy/production-release/first-recharge-successor-build-context'
SCOPE = 'FIRST_RECHARGE_FINITE_PROJECTION'
BUSINESS_COMMIT = '301f9e751dde020031a240920454060ce00a1000'
BUSINESS_TREE = '2d15c4c07ea086064c5928f2336340d3f524e3a5'
APPROVED_CONTRACT_SHA256 = 'e3a9800b7f75078063540414b0e536c625756a562e92e8ae938611d81c2c822d'
API_COMMIT = '43c31870c9497d900491cdb19c5f61c766f3b344'
ADMIN_COMMIT = '568e9390a304a36edba86823d5d5b31e5506763b'
RUNTIME_FILES = ('apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts',
                 'docker-compose.aws-mysql.yml')
COLD_HELPERS = ('remote-deploy.py', 'api-admin-scope.py', 'api-admin-pending-projection.py',
    'api-admin-readonly.py', 'api-admin-pending-receipt-wire.py', 'online-recharge-scope.py',
    'online-recharge-recovery.json', 'admin-pending-online-release.py', 'unpublished-component-successor.py',
    'unpublished-component-successor-readonly.py', 'online-recharge-component-consumer.py')


def bootstrap_contract():
    """Authenticate every cold executable before loading any of them."""
    def require(value):
        if not value:
            raise RuntimeError('FIRST_RECHARGE_COLD_HELPER_CHANGED')
    def unique(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    path = HERE / 'first-recharge-successor-contract.json'
    require(path.is_file() and not path.is_symlink() and path.resolve() == path
            and path.stat().st_size <= 256 * 1024)
    value = json.loads(path.read_bytes(), object_pairs_hook=unique)
    require(type(value) is dict and value.get('contractSha256') == APPROVED_CONTRACT_SHA256)
    body = {k: v for k, v in value.items() if k != 'contractSha256'}
    require(hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            == APPROVED_CONTRACT_SHA256 and type(value.get('coldHelpers')) is dict
            and set(value['coldHelpers']) == set(COLD_HELPERS))
    for name, sha in value['coldHelpers'].items():
        path = HERE / name
        require(path.is_file() and not path.is_symlink() and path.resolve() == path
                and path.stat().st_size <= 8 * 1024 * 1024
                and hashlib.sha256(path.read_bytes()).hexdigest() == sha)
    return value


bootstrap_contract()


def load(name, filename):
    path = HERE / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


history = load('first_recharge_cold_authority', 'online-recharge-component-consumer.py')
core = history.load_core()
base = core.projection_module()
inventory, source_tree, fingerprint, digest = base.inventory, base.source_tree, core.fingerprint, core.digest


def need(value, code):
    if not value:
        raise RuntimeError('FIRST_RECHARGE_' + code)


def contract():
    value = core.closed_json((HERE / 'first-recharge-successor-contract.json').read_bytes())
    fields = {'version', 'scope', 'businessCommit', 'businessTree', 'applicationInputSha256', 'applicationInputCount',
              'businessFiles', 'apiAuthority', 'adminAuthority', 'coldHelpers', 'outputSeals', 'newMigrations',
              'migrationPerformed', 'updatedServices', 'onlinePublished', 'businessActions', 'contractSha256'}
    need(set(value) == fields and type(value.get('version')) is int and value['version'] == 1
         and value.get('scope') == 'FIRST_RECHARGE_SOURCE_CONTRACT'
         and value.get('businessCommit') == BUSINESS_COMMIT and value.get('businessTree') == BUSINESS_TREE
         and value.get('apiAuthority') == history.sealed_authority()
         and value.get('adminAuthority') == history.admin_successor_authority()
         and value.get('contractSha256') == APPROVED_CONTRACT_SHA256
         == fingerprint({k: v for k, v in value.items() if k != 'contractSha256'})
         and len(value['businessFiles']) == 37 and value['applicationInputCount'] == 2192
         and value['newMigrations'] == [] and value['migrationPerformed'] is False
         and value['updatedServices'] == ['api', 'admin'] and value['onlinePublished'] is False
         and type(value['businessActions']) is int and value['businessActions'] == 0,
         'CONTRACT_CHANGED')
    need(set(value['coldHelpers']) == set((*core.HELPERS, 'online-recharge-component-consumer.py'))
         and all(digest((HERE / name).read_bytes()) == sha for name, sha in value['coldHelpers'].items()),
         'COLD_HELPER_CHANGED')
    return value


def application_rows(files):
    return {name: row for name, row in inventory(files).items()
            if name.startswith(history.APP_PREFIXES) or name in history.APP_FILES}


def archive(d, commit, cache):
    if commit not in cache:
        raw = d.registration_download(commit)
        need(type(raw) is bytes and 0 < len(raw) <= 128 * 1024 * 1024, 'ARCHIVE_INVALID')
        cache[commit] = d.registration_archive(raw, commit)
    return cache[commit]


def published_sources(d, cache):
    api = archive(d, API_COMMIT, cache)
    admin = archive(d, ADMIN_COMMIT, cache)
    need(source_tree(api) == history.sealed_authority()['producer']['sourceTree']
         and source_tree(admin) == history.admin_successor_authority()['producer']['sourceTree'],
         'BASELINE_SOURCE_CHANGED')
    api_output, api_record = base.project_candidate(d, api, API_COMMIT, source_tree(api))
    cold = load('first_recharge_cold_admin', 'admin-pending-online-release.py')
    _candidate, admin_output, admin_record, _runtime, _archive = cold.source_projection(
        d, ADMIN_COMMIT, source_tree(admin), expected_current=API_COMMIT)
    need(fingerprint(api_record) == history.sealed_authority()['projectionSha256']
         and admin_record['projectionSha256'] == history.admin_successor_authority()['projectionSha256'],
         'BASELINE_PROJECTION_CHANGED')
    return {'api': api_output, 'admin': admin_output}, {'api': api_record, 'admin': admin_record}


def project_sources(d, candidate, commit, tree):
    spec, cache = contract(), {}
    need(source_tree(candidate) == tree and re.fullmatch('[a-f0-9]{40}', commit or ''), 'CANDIDATE_TREE_CHANGED')
    business = archive(d, BUSINESS_COMMIT, cache)
    need(source_tree(business) == BUSINESS_TREE, 'BUSINESS_SOURCE_CHANGED')
    need(application_rows(candidate) == application_rows(business)
         and fingerprint(application_rows(business)) == spec['applicationInputSha256'],
         'UNRELATED_APPLICATION_SOURCE_CHANGED')
    for path, row in spec['businessFiles'].items():
        need(inventory(business).get(path) == row and candidate.get(path) == business.get(path),
             'BUSINESS_SOURCE_CHANGED')
    # Use the unchanged inverse for central table/registry/router edits. Copying
    # a raw billing-name table would resurrect ONLINE's import and spread.
    projected, _inverse = base.project_candidate(d, business, BUSINESS_COMMIT, BUSINESS_TREE)
    before, origins = published_sources(d, cache)
    output, contexts = {}, {}
    for role in ('api', 'admin'):
        current = dict(before[role])
        allowed = {path for path in spec['businessFiles'] if path.startswith('apps/' + role + '/')}
        for path in allowed:
            need(path in projected, 'OVERLAY_PATH_CHANGED')
            current[path] = projected[path]
        previous_rows, after_rows = inventory(before[role]), inventory(current)
        changed = {path: {'before': previous_rows.get(path), 'after': after_rows[path]}
                   for path in allowed if previous_rows.get(path) != after_rows.get(path)}
        unchanged = {path: row for path, row in previous_rows.items() if path not in changed}
        need(all(after_rows.get(path) == row for path, row in unchanged.items())
             and set(after_rows) == set(unchanged) | set(changed)
             and not any(path.startswith(history.ONLINE_PREFIXES) for path in current),
             'UNRELATED_OUTPUT_CHANGED')
        contexts[role] = {'baseCommit': API_COMMIT if role == 'api' else ADMIN_COMMIT,
            'baselineProjectionSha256': fingerprint(origins[role]) if role == 'api' else origins[role]['projectionSha256'],
            'inputFilesSha256': fingerprint(previous_rows), 'outputFilesSha256': fingerprint(after_rows),
            'unchangedFilesSha256': fingerprint(unchanged), 'changedFiles': changed, 'outputTree': source_tree(current)}
        output.update({role + '/' + path: row for path, row in current.items()})
    record = {'version': 1, 'scope': SCOPE, 'candidateCommit': commit, 'candidateTree': tree,
        'businessCommit': BUSINESS_COMMIT, 'businessTree': BUSINESS_TREE, 'contractSha256': spec['contractSha256'],
        'contextPath': CONTEXT, 'contexts': contexts, 'outputFilesSha256': fingerprint(inventory(output)),
        'outputTree': source_tree(output)}
    record['projectionSha256'] = fingerprint(record)
    if spec.get('outputSeals'):
        validate_record(record)
    return output, record


def validate_record(record):
    spec = contract()
    fields = {'version', 'scope', 'candidateCommit', 'candidateTree', 'businessCommit', 'businessTree',
              'contractSha256', 'contextPath', 'contexts', 'outputFilesSha256', 'outputTree', 'projectionSha256'}
    need(type(record) is dict and set(record) == fields and record['version'] == 1 and record['scope'] == SCOPE
         and record['businessCommit'] == BUSINESS_COMMIT and record['businessTree'] == BUSINESS_TREE
         and record['contractSha256'] == spec['contractSha256'] and record['contextPath'] == CONTEXT
         and set(record['contexts']) == {'api', 'admin'}
         and all(re.fullmatch('[a-f0-9]{40}', record.get(key, '')) for key in ('candidateCommit', 'candidateTree', 'outputTree'))
         and record['projectionSha256'] == fingerprint({k: v for k, v in record.items() if k != 'projectionSha256'}),
         'PROJECTION_CHANGED')
    need(record['contexts'] == spec['outputSeals']['contexts']
         and record['outputFilesSha256'] == spec['outputSeals']['outputFilesSha256']
         and record['outputTree'] == spec['outputSeals']['outputTree'], 'PROJECTION_CHANGED')
    return record


def verify_output(files, record):
    validate_record(record)
    need(source_tree(files) == record['outputTree'] and fingerprint(inventory(files)) == record['outputFilesSha256'],
         'OUTPUT_CHANGED')
    return record


def runtime_config_files(d, candidate, record):
    output, expected = project_sources(d, candidate, record['candidateCommit'], record['candidateTree'])
    need(record == expected, 'PROJECTION_SOURCE_CHANGED')
    return {name: output['api/' + name] for name in RUNTIME_FILES}


def verify_build_context(d, context, record):
    path = Path(context).resolve()
    need(path == Path.cwd().resolve() / CONTEXT and path.is_dir()
         and not any(item.is_symlink() for item in path.parents), 'BUILD_CONTEXT_INVALID')
    files = {}
    for item in path.rglob('*'):
        need(not item.is_symlink(), 'BUILD_CONTEXT_CHANGED')
        if item.is_file():
            metadata = item.stat()
            need(metadata.st_mode & 0o7777 in (0o644, 0o755)
                 and metadata.st_size <= 8 * 1024 * 1024, 'BUILD_CONTEXT_CHANGED')
            files[item.relative_to(path).as_posix()] = (item.read_bytes(), '100755' if metadata.st_mode & 0o111 else '100644')
        else:
            need(item.is_dir(), 'BUILD_CONTEXT_CHANGED')
    return verify_output(files, record)


def projection_module():
    return SimpleNamespace(CONTEXT_PATH=CONTEXT, RUNTIME_FILES=RUNTIME_FILES, inventory=inventory,
        source_tree=source_tree, validate_record=validate_record, verify_output=verify_output,
        project_candidate=project_sources, runtime_config_files=runtime_config_files,
        verify_build_context=verify_build_context)
