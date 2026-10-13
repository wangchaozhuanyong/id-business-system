"""Finite recharge overlays on each genuine published component source.

The old B/ONLINE inverse projection is reused without changing its seals. API
and Admin have different published inputs, so they never share a build tree.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace

HERE = Path(__file__).parent
CONTEXT = '.deploy/production-release/recharge-flow-successor-build-context'
SCOPE = 'RECHARGE_FLOW_FINITE_PROJECTION'
BUSINESS_COMMIT = 'bcd67c4dfe3944aa6c0498699a619395f04ed296'
API_COMMIT = '31d2c6885a45817cd40d23fce8d6145bc9f18af2'
ADMIN_COMMIT = '60e164b75d1eedaab440c17139bf9ba55de08c61'
RUNTIME_FILES = ('apps/api/prisma-mysql/schema.prisma', 'apps/api/prisma-mysql/seed.ts',
                 'docker-compose.aws-mysql.yml')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load('recharge_flow_immutable_projection', 'api-admin-pending-projection.py')
inventory, source_tree, fingerprint = (getattr(BASE, name) for name in
                                        ('inventory', 'source_tree', 'fingerprint'))
digest = lambda raw: hashlib.sha256(raw).hexdigest()


def need(condition, code):
    if not condition:
        raise RuntimeError('RECHARGE_FLOW_' + code)


def contract():
    value = json.loads((HERE / 'recharge-flow-successor-contract.json').read_bytes())
    need(value['version'] == 1 and value['businessCommit'] == BUSINESS_COMMIT
         and value['baseline']['api']['commit'] == API_COMMIT
         and value['baseline']['admin']['commit'] == ADMIN_COMMIT
         and len(value['businessFiles']) == 76, 'CONTRACT_CHANGED')
    need(value['contractSha256'] == fingerprint({k: v for k, v in value.items() if k != 'contractSha256'}),
         'CONTRACT_CHANGED')
    return value


def application_rows(files):
    return {name: row for name, row in inventory(files).items()
            if name.startswith(('apps/api/', 'apps/admin/', 'packages/shared/')) or name in
            ('package.json', 'package-lock.json', '.dockerignore', 'tsconfig.base.json', 'deploy/nginx/admin.conf')}


def archives(d, commit, cache):
    if commit not in cache:
        raw = d.registration_download(commit)
        need(type(raw) is bytes and 0 < len(raw) <= 128 * 1024 * 1024, 'ARCHIVE_INVALID')
        files = d.registration_archive(raw, commit)
        cache[commit] = files
    return cache[commit]


def baseline_sources(d, spec, cache):
    api_raw = archives(d, API_COMMIT, cache)
    need(source_tree(api_raw) == spec['baseline']['api']['sourceTree'], 'BASELINE_SOURCE_CHANGED')
    api, api_projection = BASE.project_candidate(d, api_raw, API_COMMIT, source_tree(api_raw))
    admin_controller = load('recharge_flow_cold_admin_projection', 'admin-pending-online-release.py')
    admin_raw = archives(d, ADMIN_COMMIT, cache)
    need(source_tree(admin_raw) == spec['baseline']['admin']['sourceTree'], 'BASELINE_SOURCE_CHANGED')
    admin, admin_projection, _runtime = admin_controller.project_admin(
        admin_raw, *BASE.source_references(d), ADMIN_COMMIT, source_tree(admin_raw))
    for role, record in (('api', api_projection), ('admin', admin_projection)):
        need(record['projectionSha256'] == spec['baseline'][role]['projectionSha256'],
             'BASELINE_PROJECTION_CHANGED')
    # The existing API hotfix changed this one condition. Its genuine native Q
    # is independently authenticated by the reused publisher before any write.
    patch = spec['deployedApiPatch']
    raw, mode = api[patch['path']]
    need(digest(raw) == patch['beforeSha256'] and raw.count(patch['before'].encode()) == 1,
         'DEPLOYED_PATCH_SOURCE_CHANGED')
    raw = raw.replace(patch['before'].encode(), patch['after'].encode(), 1)
    need(digest(raw) == patch['afterSha256'], 'DEPLOYED_PATCH_SOURCE_CHANGED')
    api[patch['path']] = (raw, mode)
    return {'api': api, 'admin': admin}, {'api': api_projection, 'admin': admin_projection}


def project_sources(d, candidate, commit, tree):
    spec, cache = contract(), {}
    need(source_tree(candidate) == tree, 'CANDIDATE_TREE_CHANGED')
    business = archives(d, BUSINESS_COMMIT, cache)
    need(source_tree(business) == spec['businessTree'], 'BUSINESS_SOURCE_CHANGED')
    for path, sha in spec['businessFiles'].items():
        need(path in business and digest(business[path][0]) == sha
             and path in candidate and candidate[path] == business[path], 'BUSINESS_SOURCE_CHANGED')
    expected_rows = application_rows(business)
    for path, row in spec['approvedTestChanges'].items():
        need(expected_rows.get(path) == row['before'], 'TEST_SOURCE_CHANGED')
        expected_rows[path] = row['after']
    need(application_rows(candidate) == expected_rows, 'UNRELATED_APPLICATION_SOURCE_CHANGED')
    before, origins = baseline_sources(d, spec, cache)
    output, contexts = {}, {}
    for role in ('api', 'admin'):
        current = dict(before[role])
        prefix = 'apps/api/' if role == 'api' else 'apps/admin/'
        approved = {path: sha for path, sha in spec['businessFiles'].items()
                    if path.startswith(prefix) or path == 'packages/shared/src/v2/auto-recharge.ts'}
        approved.update(spec['prerequisites'][role])
        for path, sha in approved.items():
            need(path in business and digest(business[path][0]) == sha
                 and path in candidate and candidate[path] == business[path], 'PREREQUISITE_SOURCE_CHANGED')
            current[path] = business[path]
        if role == 'api':
            core = load('recharge_flow_immutable_migration', 'unpublished-component-successor.py')
            schema = current[core.MIGRATION_SCHEMA]
            need(digest(schema[0]) == core.MIGRATION_IDENTITY['schemaBeforeSha256']
                 and schema[0].count(b'model IdBusinessV2RechargeBrowserSetting {') == 1,
                 'MIGRATION_SOURCE_CHANGED')
            raw = schema[0].replace(b'model IdBusinessV2RechargeBrowserSetting {',
                                   core.MIGRATION_MODEL + b'model IdBusinessV2RechargeBrowserSetting {', 1)
            need(digest(raw) == core.MIGRATION_IDENTITY['schemaAfterSha256'], 'MIGRATION_SOURCE_CHANGED')
            current[core.MIGRATION_SCHEMA] = (raw, schema[1])
            approved[core.MIGRATION_SCHEMA] = digest(raw)
            sql = core.MIGRATION_ROOT + '/' + core.MIGRATION_FILE
            need(digest(business[sql][0]) == core.MIGRATION_IDENTITY['sha256'], 'MIGRATION_SOURCE_CHANGED')
            current[sql] = business[sql]
            approved[sql] = digest(business[sql][0])
        previous_rows, after_rows = inventory(before[role]), inventory(current)
        changed = {path: {'before': previous_rows.get(path), 'after': after_rows[path]}
                   for path in approved if previous_rows.get(path) != after_rows.get(path)}
        unchanged = {path: row for path, row in previous_rows.items() if path not in changed}
        need(all(after_rows.get(path) == row for path, row in unchanged.items())
             and set(after_rows) == set(unchanged) | set(changed), 'UNRELATED_OUTPUT_CHANGED')
        contexts[role] = {'baseCommit': spec['baseline'][role]['commit'],
            'baselineProjectionSha256': origins[role]['projectionSha256'],
            'inputFilesSha256': fingerprint(previous_rows), 'outputFilesSha256': fingerprint(after_rows),
            'unchangedFilesSha256': fingerprint(unchanged), 'changedFiles': changed,
            'outputTree': source_tree(current)}
        output.update({role + '/' + path: row for path, row in current.items()})
    record = {'version': 1, 'scope': SCOPE, 'candidateCommit': commit, 'candidateTree': tree,
        'businessCommit': BUSINESS_COMMIT, 'businessTree': spec['businessTree'],
        'contractSha256': spec['contractSha256'], 'contextPath': CONTEXT, 'contexts': contexts,
        'outputFilesSha256': fingerprint(inventory(output)), 'outputTree': source_tree(output)}
    record['projectionSha256'] = fingerprint(record)
    return output, record


def validate_record(record):
    spec = contract()
    need(type(record) is dict and record.get('version') == 1 and record.get('scope') == SCOPE
         and record.get('businessCommit') == BUSINESS_COMMIT and record.get('businessTree') == spec['businessTree']
         and record.get('contractSha256') == spec['contractSha256'] and record.get('contextPath') == CONTEXT
         and set(record.get('contexts', {})) == {'api', 'admin'}
         and record.get('projectionSha256') == fingerprint({k: v for k, v in record.items() if k != 'projectionSha256'}),
         'PROJECTION_CHANGED')
    for key in ('candidateCommit', 'candidateTree', 'outputTree'):
        need(re.fullmatch('[a-f0-9]{40}', record.get(key, '')) is not None, 'PROJECTION_CHANGED')
    return record


def verify_output(files, record):
    validate_record(record)
    need(source_tree(files) == record['outputTree'] and fingerprint(inventory(files)) == record['outputFilesSha256'],
         'OUTPUT_CHANGED')
    return record


def runtime_config_files(d, candidate, record):
    output, expected = project_sources(d, candidate, record['candidateCommit'], record['candidateTree'])
    need(record == expected, 'PROJECTION_SOURCE_CHANGED')
    return {path: output['api/' + path] for path in RUNTIME_FILES}


def verify_build_context(d, context, record):
    path = Path(context).resolve()
    need(path == Path.cwd().resolve() / CONTEXT and path.is_dir()
         and not any(item.is_symlink() for item in path.parents), 'BUILD_CONTEXT_INVALID')
    files = {}
    for item in path.rglob('*'):
        need(not item.is_symlink(), 'BUILD_CONTEXT_CHANGED')
        if item.is_file():
            files[item.relative_to(path).as_posix()] = (item.read_bytes(), '100755' if item.stat().st_mode & 0o111 else '100644')
        else:
            need(item.is_dir(), 'BUILD_CONTEXT_CHANGED')
    return verify_output(files, record)


def projection_module():
    return SimpleNamespace(CONTEXT_PATH=CONTEXT, RUNTIME_FILES=RUNTIME_FILES, inventory=inventory,
        source_tree=source_tree, validate_record=validate_record, verify_output=verify_output,
        project_candidate=project_sources, runtime_config_files=runtime_config_files,
        verify_build_context=verify_build_context)
