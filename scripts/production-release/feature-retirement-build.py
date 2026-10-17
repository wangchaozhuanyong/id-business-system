"""Compile the bounded retirement over the independently pinned live role inputs."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / '.deploy/feature-retirement-release'
CONTRACT = HERE / 'feature-retirement-contract.json'
UI_CHECKS = ('admin-ui', 'v2-ui-language', 'v2-color-contrast', 'v2-table-standard',
             'v2-loading-standard', 'v2-module-architecture', 'v2-isolation')
SOURCE_ROOTS = ('apps/api/src/', 'apps/admin/src/', 'packages/shared/src/', 'packages/shared/test/')
OUTPUT_SUFFIXES = ('.js', '.js.map', '.d.ts')
REQUIRED_CONTROLS = {'scripts/production-release/feature-retirement-build.py',
                     'scripts/production-release/feature-retirement-release.py',
                     'scripts/production-release/feature-retirement-dispatch.py',
                     'scripts/acceptance-v2-feature-retirement.mjs',
                     '.github/workflows/feature-retirement-validation.yml'}


def need(value, code):
    if not value:
        raise RuntimeError('FEATURE_RETIREMENT_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def safe_name(name):
    return (isinstance(name, str) and name and '\\' not in name and '\x00' not in name
            and not PurePosixPath(name).is_absolute()
            and all(part not in ('', '.', '..') for part in name.split('/')))


def inventory(root):
    need(root.is_dir() and not root.is_symlink(), 'INVENTORY_ROOT_INVALID')
    result = {}
    for name in sorted(root.rglob('*')):
        need(not name.is_symlink(), 'CONTENT_SYMLINK')
        if name.is_file():
            result[name.relative_to(root).as_posix()] = digest(name.read_bytes())
    return result


def extract_source(raw, destination):
    need(not destination.exists(), 'EXTRACTION_TARGET_EXISTS')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        members = archive.getmembers()
        names = [member.name.rstrip('/') for member in members]
        need(len(names) == len(set(names)), 'ARCHIVE_DUPLICATE_PATH')
        need(all(safe_name(name) and (member.isfile() or member.isdir())
                 and not member.issym() and not member.islnk()
                 for name, member in zip(names, members)), 'ARCHIVE_PATH_INVALID')
        destination.mkdir(parents=True, mode=0o700)
        for member, name in zip(members, names):
            target = destination / name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(member.mode & 0o777)


def overlay_sources(context, sources, role):
    prefixes = ('packages/shared/', 'apps/' + role + '/')
    for name, expected in sources.items():
        need(safe_name(name) and name.startswith(SOURCE_ROOTS), 'SOURCE_PATH_INVALID')
        if not name.startswith(prefixes):
            continue
        target = context / name
        need(not target.is_symlink(), 'SOURCE_SYMLINK')
        if expected is None:
            need(target.is_file(), 'DELETED_SOURCE_NOT_IN_BASELINE')
            target.unlink()
        else:
            raw = (ROOT / name).read_bytes()
            need(digest(raw) == expected, 'SOURCE_CHANGED')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)


def output_delta(before, after, baseline_files, modules, role, compiled_baseline_files=None, omitted_declarations=None):
    need(all(safe_name(name) and name.endswith('.js') for name in modules), role + '_MODULE_PATH_INVALID')
    allowed = {name.removesuffix('.js') + suffix for name in modules for suffix in OUTPUT_SUFFIXES}
    need(set(baseline_files) == allowed, role + '_BASELINE_SCOPE_CHANGED')
    compiled = baseline_files if compiled_baseline_files is None else compiled_baseline_files
    need(set(compiled) == allowed, role + '_COMPILED_BASELINE_SCOPE_CHANGED')
    differences = {name for name in allowed if compiled[name] != baseline_files[name]}
    need(all(name.endswith('.d.ts') for name in differences), role + '_NONDECLARATION_BASELINE_OVERRIDE')
    need(all(before.get(name) == expected for name, expected in compiled.items()), role + '_BASELINE_NOT_REPRODUCED')
    need(all(before.get(name) == expected for name, expected in modules.items()), role + '_MODULE_BASELINE_CHANGED')
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    omitted = {} if omitted_declarations is None else omitted_declarations
    need(all(safe_name(name) and name.endswith('.d.ts') and name not in allowed
             and pin == {'baselineSha256': before.get(name), 'compiledSha256': after.get(name)}
             and all(before.get(name.removesuffix('.d.ts') + suffix) == after.get(name.removesuffix('.d.ts') + suffix)
                     for suffix in ('.js', '.js.map')) for name, pin in omitted.items()), role + '_OMITTED_DECLARATION_CHANGED')
    caches = {'tsconfig.build.tsbuildinfo'} if role == 'API' else set()
    need(changed and changed - allowed - caches == omitted.keys(), role + '_OUTPUT_SCOPE_CHANGED')
    need(all(name in changed for name in modules), role + '_EXPECTED_MODULE_UNCHANGED')
    # Runtime application always compares against the observed image, including old
    # declaration sidecars. Compiler-only differences never rewrite its admission pins.
    runtime_changed = {name for name in allowed if baseline_files[name] != after.get(name)}
    updated = {name: after[name] for name in sorted(runtime_changed) if name in after}
    removed = {name: baseline_files[name] for name in sorted(runtime_changed) if name not in after}
    need(not set(updated).intersection(removed), role + '_OUTPUT_OVERLAP')
    return updated, removed


def verify_sources(c):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(isinstance(c.get('scope'), str) and c['scope'].startswith('AUTO_REGISTRATION_RETIREMENT_'), 'SCOPE_CHANGED')
    changed_paths = set(git('diff', '--name-only', '--no-renames', c['reviewBase'], 'HEAD').decode().splitlines())
    need(type(c.get('allowedPaths')) is list and len(c['allowedPaths']) == len(set(c['allowedPaths']))
         and all(safe_name(name) for name in c['allowedPaths'])
         and changed_paths == set(c['allowedPaths']), 'REVIEW_PATH_SCOPE_CHANGED')
    for role in ('api', 'admin'):
        baseline = c[role + 'SourceBaseline']
        need(re.fullmatch('[a-f0-9]{40}', baseline) and git('rev-parse', baseline + '^{tree}').decode().strip()
             == c[role + 'SourceBaselineTree'], 'BASE_TREE_CHANGED')
        for name, expected in c['buildInputs'][role].items():
            need(safe_name(name), 'BUILD_INPUT_PATH_INVALID')
            raw = git('show', baseline + ':' + name) if git('ls-tree', baseline, '--', name).strip() else None
            need((digest(raw) if raw is not None else None) == expected, 'BUILD_INPUT_CHANGED')
    preserved_admin_sources(c)
    need(type(c.get('sources')) is dict and c['sources'], 'SOURCES_MISSING')
    for name, expected in c['sources'].items():
        need(safe_name(name) and name.startswith(SOURCE_ROOTS), 'SOURCE_PATH_INVALID')
        source = ROOT / name
        need(not source.is_symlink(), 'SOURCE_SYMLINK')
        if expected is None:
            need(not source.exists(), 'RETIRED_SOURCE_PRESENT')
        else:
            need(isinstance(expected, str) and re.fullmatch('[a-f0-9]{64}', expected)
                 and source.is_file() and digest(source.read_bytes()) == expected, 'SOURCE_CHANGED')
    need(type(c.get('controlSources')) is dict and REQUIRED_CONTROLS <= c['controlSources'].keys(), 'CONTROLS_MISSING')
    for name, expected in c['controlSources'].items():
        need(safe_name(name) and (name.startswith(('scripts/', '.github/workflows/'))
             or name in ('apps/api/Dockerfile.mysql', 'package.json'))
             and (ROOT / name).is_file() and not (ROOT / name).is_symlink()
             and digest((ROOT / name).read_bytes()) == expected, 'CONTROL_CHANGED')
    need(not git('diff', '--name-only', c['apiSourceBaseline'], 'HEAD', '--',
                 'apps/api/prisma-mysql/', 'package-lock.json', 'tsconfig.base.json',
                 'apps/api/package.json', 'apps/admin/package.json', 'packages/shared/package.json').strip(), 'SCHEMA_OR_DEPENDENCY_CHANGED')
    # The Admin source in main must be exactly its published input plus this retirement.
    for role, baseline in [('admin', c['adminSourceBaseline'])]:
        prefixes = ('apps/' + role + '/', 'packages/shared/')
        changed = set(git('diff', '--name-only', '--no-renames', baseline, 'HEAD', '--', *prefixes).decode().splitlines())
        expected = {name for name in c['sources'] if name.startswith(prefixes)}
        need(changed == expected, 'ADMIN_SOURCE_SCOPE_CHANGED')
    api_changed = set(git('diff', '--name-only', '--no-renames', c['apiMainBase'], 'HEAD', '--', 'apps/api/src/').decode().splitlines())
    online = 'apps/api/src/id-business-v2/online-recharge/'
    api_owned = {name for name in c['sources'] if name.startswith('apps/api/')}
    need(not any(name.startswith(online) for name in api_owned)
         and {name for name in api_changed if not name.startswith(online)} == api_owned, 'API_SOURCE_SCOPE_CHANGED')
    for name in c['omittedApiDeclarations']:
        source = 'apps/api/src/' + name.removesuffix('.d.ts') + '.ts'
        # Compiler-only sidecars are not deployed. Their owners may have a
        # published successor; retirement must leave that reviewed source intact.
        need(safe_name(name) and name.endswith('.d.ts') and source not in c['sources']
             and git('ls-tree', c['reviewBase'], '--', source).strip()
             == git('ls-tree', 'HEAD', '--', source).strip()
             and git('ls-tree', 'HEAD', '--', source).strip(), 'OMITTED_DECLARATION_SOURCE_CHANGED')
    need(c.get('databaseVerification') == {'schemaChanged': False, 'migrationPerformed': False,
         'productionDatabaseWrites': False, 'isolatedDatabaseStarted': False}, 'DATABASE_SCOPE_CHANGED')


def preserved_admin_sources(c):
    """Verify the exact published successor delta before applying retirement."""
    pin = c['publishedAdminRecipe']
    need(pin['commit'] == '6da10d2e4bd9de6df145899648e234000f84b72b', 'ADMIN_RECIPE_INVALID')
    sources = c.get('adminPublishedSources')
    need(type(sources) is dict and sources, 'PUBLISHED_ADMIN_SUCCESSOR_MISSING')
    names = set(git('diff', '--name-only', '--no-renames', pin['commit'], c['adminSourceBaseline'],
                    '--', 'apps/admin/', 'packages/shared/').decode().splitlines())
    need(names == sources.keys(), 'PUBLISHED_ADMIN_SUCCESSOR_SCOPE_CHANGED')
    result = {}
    for name, expected in sources.items():
        need(safe_name(name) and name.startswith(('apps/admin/src/', 'packages/shared/src/'))
             and isinstance(expected, str) and re.fullmatch('[a-f0-9]{64}', expected),
             'PUBLISHED_ADMIN_SUCCESSOR_PATH_INVALID')
        raw = git('show', c['adminSourceBaseline'] + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_ADMIN_SUCCESSOR_CHANGED')
        result[name] = raw
    return result


def prepare_published_admin(c):
    """Read the immutable published recipe; never invoke retired command entrypoints."""
    pin = c['publishedAdminRecipe']
    need(pin['commit'] == '6da10d2e4bd9de6df145899648e234000f84b72b' and pin['buildFile'] == 'recharge-checkout-build.py'
         and pin['contractFile'] == 'recharge-checkout-contract.json', 'ADMIN_RECIPE_INVALID')
    for key, name in [('buildSha256', pin['buildFile']), ('contractSha256', pin['contractFile'])]:
        need(digest(git('show', pin['commit'] + ':scripts/production-release/' + name)) == pin[key], 'ADMIN_RECIPE_CHANGED')
    history = OUTPUT / 'published-admin-recipe'
    extract_source(git('archive', pin['commit'], 'scripts/production-release'), history)
    recipe_here = history / 'scripts/production-release'
    spec = importlib.util.spec_from_file_location('feature_retirement_published_admin', recipe_here / pin['buildFile'])
    recipe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recipe)
    recipe.ROOT, recipe.HERE, recipe.OUTPUT = ROOT, recipe_here, OUTPUT
    published = json.loads((recipe_here / pin['contractFile']).read_bytes())
    recipe.prepare_published_admin(published)
    context = OUTPUT / 'admin-baseline'
    for name, expected in published['sources'].items():
        if name.startswith(('apps/admin/', 'packages/shared/')):
            raw = git('show', pin['commit'] + ':' + name)
            need(digest(raw) == expected, 'PUBLISHED_ADMIN_SOURCE_CHANGED')
            target = context / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    for name, raw in preserved_admin_sources(c).items():
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def prepare(c):
    verify_sources(c)
    need(os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('GITHUB_REF') == 'refs/heads/main'
         and os.environ.get('GITHUB_SHA') == git('rev-parse', 'HEAD').decode().strip()
         and not OUTPUT.exists(), 'NATIVE_BUILD_REQUIRED')
    OUTPUT.mkdir(parents=True, mode=0o700)
    prepare_published_admin(c)
    api_raw = git('archive', c['apiSourceBaseline'])
    for role in ('api', 'admin'):
        for variant in ('baseline', 'candidate'):
            context = OUTPUT / (role + '-' + variant)
            if role == 'api':
                extract_source(api_raw, context)
            elif variant == 'candidate':
                shutil.copytree(OUTPUT / 'admin-baseline', context)
            for name, expected in c['buildInputs'][role].items():
                file = context / name
                need((digest(file.read_bytes()) if file.is_file() else None) == expected, 'RECONSTRUCTED_BUILD_INPUT_CHANGED')
            if variant == 'candidate':
                overlay_sources(context, c['sources'], role)
            run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
            run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context)
            if role == 'api':
                run('npm', 'run', 'prisma:mysql:generate', '--workspace', '@apple-business/api', cwd=context)
            env = {**os.environ, 'NODE_ENV': c['adminNodeEnv'],
                   'V2_BUILD_ID': c['baselineAdminBuildId'] if variant == 'baseline' else 'v2-' + os.environ['GITHUB_SHA']}
            run('npm', 'run', 'build', '--workspace', '@apple-business/' + role, cwd=context, env=env)
    b, a = OUTPUT / 'api-baseline', OUTPUT / 'api-candidate'
    modules, removed = output_delta(inventory(b / 'apps/api/dist'), inventory(a / 'apps/api/dist'), c['apiBaselineFiles'], c['apiModules'], 'API', c['apiCompiledBaselineFiles'], c['omittedApiDeclarations'])
    shared, shared_removed = output_delta(inventory(b / 'packages/shared/dist'), inventory(a / 'packages/shared/dist'), c['sharedBaselineFiles'], c['sharedModules'], 'SHARED')
    need(inventory(OUTPUT / 'admin-baseline/apps/admin/dist') == c['publicFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    need(output_delta(inventory(OUTPUT / 'admin-baseline/packages/shared/dist'), inventory(OUTPUT / 'admin-candidate/packages/shared/dist'), c['sharedBaselineFiles'], c['sharedModules'], 'ADMIN_SHARED')
         == (shared, shared_removed), 'SHARED_ROLE_OUTPUT_MISMATCH')
    payload = OUTPUT / 'payload'
    payload.mkdir(mode=0o700)
    for directory, files, source in [('api/modules', modules, a / 'apps/api/dist'), ('api/shared', shared, a / 'packages/shared/dist')]:
        for name in files:
            target = payload / directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
    shutil.copytree(OUTPUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for name, expected in {**c['sources'], **c['controlSources']}.items():
        if expected is not None:
            target = payload / 'source' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            raw = (ROOT / name).read_bytes()
            need(digest(raw) == expected, 'PAYLOAD_SOURCE_CHANGED')
            target.write_bytes(raw)
    deletions = {'version': 1, 'apiModules': removed, 'sharedModules': shared_removed,
                 'sources': sorted(name for name, expected in c['sources'].items() if expected is None)}
    (payload / 'deletions.json').write_text(json.dumps(deletions, sort_keys=True, indent=2) + '\n')
    declaration_differences = {name: {'runtimeSha256': c['apiBaselineFiles'][name], 'compiledSha256': expected}
                              for name, expected in c['apiCompiledBaselineFiles'].items()
                              if expected != c['apiBaselineFiles'][name]}
    proof = {'version': 1, 'scope': c['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'contractSha256': digest(CONTRACT.read_bytes()), 'controlSources': c['controlSources'], 'sources': c['sources'],
             'apiModules': modules, 'apiDeletedModules': removed, 'sharedModules': shared,
             'sharedDeletedModules': shared_removed, 'adminFiles': inventory(payload / 'admin/html'),
             'files': inventory(payload), 'baselineApiReproduced': True, 'baselineSharedReproduced': True,
             'baselineApiCompiledReproduced': True, 'baselineApiFullInventoryReproduced': not declaration_differences,
             'baselineApiDeclarationDifferences': declaration_differences,
             'omittedApiDeclarations': c['omittedApiDeclarations'],
             'omittedApiDeclarationsPackaged': False, 'omittedApiDeclarationsDeployed': False,
             'baselineAdminReproduced': True, 'updatedServices': ['api', 'admin'],
             'databaseVerification': c['databaseVerification'], 'migrationPerformed': False, 'businessActions': 0}
    (OUTPUT / 'prepared-build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')


def validation(c):
    verify_sources(c)
    need((OUTPUT / 'prepared-build-proof.json').is_file(), 'PREPARED_BUILD_MISSING')
    proof = json.loads((OUTPUT / 'prepared-build-proof.json').read_bytes())
    for role in ('api', 'admin'):
        context = OUTPUT / (role + '-candidate')
        run('npm', 'run', 'typecheck', '--workspace', '@apple-business/' + role, cwd=context)
        # Admin sources are verified against the exact published projection above. Its
        # security-header test also reads the current edge source, which is deliberately
        # not overlaid into a historical build context or shipped as a whole config.
        test_context = ROOT if role == 'admin' else context
        run('npm', 'run', 'test', '--workspace', '@apple-business/' + role, '--', *c[role + 'Tests'], cwd=test_context)
    run('npm', 'run', 'test', '--workspace', '@apple-business/shared')
    lint_sources = [name for name, value in c['sources'].items()
                    if value is not None and name.endswith(('.ts', '.vue', '.mjs'))]
    run('npm', 'exec', '--', 'eslint', *lint_sources, 'scripts/acceptance-v2-feature-retirement.mjs')
    for check in UI_CHECKS:
        run('npm', 'run', 'check:' + check)
    run('node', '--test', 'scripts/auto-registration-retired.test.mjs')
    run('node', 'scripts/acceptance-v2-feature-retirement.mjs', '--dist', str(OUTPUT / 'admin-candidate/apps/admin/dist'),
        '--output', str(OUTPUT / 'browser-acceptance'))
    browser = json.loads((OUTPUT / 'browser-acceptance/frontend-static-acceptance.json').read_bytes())
    need(browser['status'] == 'passed' and len(browser['scenarios']) == 4 and not browser['registrationApiRequests']
         and not browser['unexpectedRequests'] and not browser['pageErrors']
         and browser['indexSha256'] == proof['adminFiles']['index.html']
         and browser['buildId'] == 'v2-' + proof['commit'], 'BROWSER_ACCEPTANCE_FAILED')
    receipt = {'scope': c['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
               'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'contractSha256': digest(CONTRACT.read_bytes()),
               'uiChecks': list(UI_CHECKS), 'browserReportSha256': digest((OUTPUT / 'browser-acceptance/frontend-static-acceptance.json').read_bytes()),
               'status': 'PASS', 'businessActions': 0, 'externalRequests': 0}
    (OUTPUT / 'validation-receipt.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')


def quality():
    commit = git('rev-parse', 'HEAD').decode().strip()
    raw = subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/runs?head_sha=' + commit + '&event=push&per_page=100'], cwd=ROOT)
    runs = [item for item in json.loads(raw)['workflow_runs'] if item['path'] == '.github/workflows/quality.yml'
            and item['head_branch'] == 'main' and item['head_sha'] == commit and item['conclusion'] == 'success'
            and item.get('status') == 'completed' and item.get('event') == 'push']
    need(bool(runs), 'QUALITY_GATE_NOT_SUCCESSFUL')
    return {'runId': str(runs[0]['id']), 'commit': commit, 'sourceTree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
            'path': '.github/workflows/quality.yml', 'conclusion': 'success'}


def package(c):
    verify_sources(c)
    proof = json.loads((OUTPUT / 'prepared-build-proof.json').read_bytes())
    validation_receipt = json.loads((OUTPUT / 'validation-receipt.json').read_bytes())
    need(proof['commit'] == git('rev-parse', 'HEAD').decode().strip()
         and proof['tree'] == git('rev-parse', 'HEAD^{tree}').decode().strip()
         and proof['contractSha256'] == digest(CONTRACT.read_bytes())
         and proof['files'] == inventory(OUTPUT / 'payload'), 'COMPILED_INPUT_MOVED')
    need(all(validation_receipt.get(key) == proof[key] for key in ('scope', 'commit', 'tree', 'contractSha256'))
         and validation_receipt.get('uiChecks') == list(UI_CHECKS) and validation_receipt.get('status') == 'PASS'
         and validation_receipt.get('businessActions') == 0 and validation_receipt.get('externalRequests') == 0
         and validation_receipt.get('browserReportSha256') == digest((OUTPUT / 'browser-acceptance/frontend-static-acceptance.json').read_bytes()), 'VALIDATION_MISSING')
    proof['validation'] = validation_receipt
    proof['qualityVerification'] = quality()
    (OUTPUT / 'payload/build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    archive_path = OUTPUT / 'feature-retirement-artifact.tar.gz'
    need(not archive_path.exists(), 'ARTIFACT_ALREADY_PACKAGED')
    with tarfile.open(archive_path, 'w:gz') as archive:
        archive.add(OUTPUT / 'payload', arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(archive_path.read_bytes()) + '\n')
    print(json.dumps({'status': 'FEATURE_RETIREMENT_ARTIFACT_BUILT', 'apiFiles': len(proof['apiModules']),
                      'deletedApiFiles': len(proof['apiDeletedModules']), 'adminFiles': len(proof['adminFiles']),
                      'migrationPerformed': False, 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('prepare', 'validate', 'package', 'quality'))
    args = parser.parse_args()
    if args.operation == 'quality':
        print(json.dumps(quality(), sort_keys=True))
    else:
        contract = json.loads(CONTRACT.read_bytes())
        {'prepare': prepare, 'validate': validation, 'package': package}[args.operation](contract)
