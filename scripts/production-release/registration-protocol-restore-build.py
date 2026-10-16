"""Reproduce the current shared-card release and withdraw only browser registration."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = 'registration-protocol-restore'
OUTPUT = ROOT / '.deploy' / NAME
CONTRACT = HERE / (NAME + '-contract.json')
spec = importlib.util.spec_from_file_location('protocol_restore_release', HERE / (NAME + '-release.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
need, digest, WORKER, SCOPE = r.need, r.digest, r.WORKER, r.SCOPE


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(directory):
    # Reuse the frozen publisher's exclusion of TypeScript incremental metadata.
    return r.helper(r.OLD_NAME + '-build.py').inventory(directory)


def verify_sources(c):
    r.verify_contract(c)
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    need(git('rev-parse', r.SOURCE_BASE + '^{tree}').decode().strip() == r.SOURCE_TREE, 'BASE_TREE_CHANGED')
    changed = git('diff', '--name-only', r.SOURCE_BASE, 'HEAD').decode().splitlines()
    need(len(changed) == len(set(changed)) and set(changed) == set(c['expectedGitChanges']), 'SOURCE_SCOPE_CHANGED')
    for name, value in c['reviewedFileHashes'].items():
        path = ROOT / name
        need(not path.is_symlink() and path.is_file() and digest(path.read_bytes()) == value, 'SOURCE_CHANGED')
    for name, value in c['withdrawal']['sourceRemovals'].items():
        need(not (ROOT / name).exists() and not (ROOT / name).is_symlink()
             and digest(git('show', r.SOURCE_BASE + ':' + name)) == value, 'REMOVED_SOURCE_CHANGED')
    for name, value in c['unchangedInputs'].items():
        need(digest((ROOT / name).read_bytes()) == value
             == digest(git('show', r.SOURCE_BASE + ':' + name)), 'IMMUTABLE_INPUT_CHANGED')
    need(all(c['reviewedFileHashes'].get(n) == v for n, v in {**c['sources'], **c['validationSources']}.items()),
         'SOURCE_HASH_CLOSURE_CHANGED')
    need(re.fullmatch('[a-f0-9]{40}', c.get('reviewedApplicationCommit') or '')
         and all(digest(git('show', c['reviewedApplicationCommit'] + ':' + n)) == value
                 for n, value in {**c['sources'], **c['validationSources']}.items()),
         'REVIEWED_APPLICATION_CHANGED')
    for name in c['withdrawal']['sourceRemovals']:
        present = subprocess.run(['git', 'cat-file', '-e', c['reviewedApplicationCommit'] + ':' + name],
                                 cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        need(present.returncode == 128, 'REVIEWED_REMOVAL_CHANGED')


def native_bundle(binding):
    prefix = 'repos/wangchaozhuanyong/id-business-system/'
    request = lambda path: subprocess.check_output(['gh', 'api', prefix + path], cwd=ROOT)
    meta = json.loads(request('actions/runs/' + binding['runId']))
    need(meta['head_sha'] == binding['commit'] and meta['head_branch'] == 'main'
         and meta['event'] == 'workflow_dispatch' and meta['status'] == 'completed'
         and meta['conclusion'] == binding['conclusion'] and meta['path'] == binding['workflowPath']
         and meta['run_attempt'] == binding['attempt'], 'PUBLISHED_NATIVE_RUN_CHANGED')
    jobs = json.loads(request('actions/runs/' + binding['runId'] + '/attempts/1/jobs?per_page=100'))['jobs']
    need(sum(j['id'] == binding['validationJobId'] and j['name'] == 'validate'
             and j['conclusion'] == 'success' for j in jobs) == 1, 'PUBLISHED_NATIVE_VALIDATION_CHANGED')
    artifacts = json.loads(request('actions/runs/' + binding['runId'] + '/artifacts?per_page=100'))['artifacts']
    matches = [a for a in artifacts if a['id'] == binding['artifactId'] and a['name'] == binding['artifactName']
               and a['digest'] == binding['artifactDigest'] and not a['expired']]
    need(len(matches) == 1 and matches[0]['workflow_run']['head_sha'] == binding['commit']
         and matches[0]['size_in_bytes'] <= 64 * 1024**2, 'PUBLISHED_NATIVE_ARTIFACT_CHANGED')
    raw = request('actions/artifacts/' + str(binding['artifactId']) + '/zip')
    need(len(raw) == matches[0]['size_in_bytes'] and 'sha256:' + digest(raw) == binding['artifactDigest'],
         'PUBLISHED_NATIVE_ZIP_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        expected = binding['bundleMember']
        need(archive.namelist().count(expected) == 1
             and archive.getinfo(expected).file_size <= 64 * 1024**2, 'PUBLISHED_BUNDLE_MEMBER_CHANGED')
        bundle = archive.read(expected)
    need(digest(bundle) == binding['bundleSha256'], 'PUBLISHED_BUNDLE_CHANGED')
    return verify_bundle(bundle, binding)


def verify_bundle(bundle, binding):
    files = {}
    seen = set()
    proof_raw = None
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:gz') as archive:
        total = 0
        for m in archive.getmembers():
            total += m.size
            limit = historical_member_limit(binding, m.name)
            need(m.name not in seen and not m.name.startswith('/') and '..' not in Path(m.name).parts
                 and Path(m.name).parts[0] == 'payload' and (m.isfile() or m.isdir())
                 and m.size <= limit and total <= 64 * 1024**2, 'PUBLISHED_PAYLOAD_INVALID')
            seen.add(m.name)
            if m.isfile():
                raw = archive.extractfile(m).read()
                if limit > 8 * 1024**2:
                    need(m.size == 13060611 and digest(raw) == SHARED_DECLARATION_SHA,
                         'PUBLISHED_LARGE_DECLARATION_CHANGED')
                name = m.name.removeprefix('payload/')
                files[name] = digest(raw)
                if name == 'build-proof.json':
                    proof_raw = raw
    need(proof_raw is not None and digest(proof_raw) == binding['proofSha256'], 'PUBLISHED_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    need(proof['commit'] == binding['commit'] and proof['tree'] == binding['tree']
         and proof['workflowRunId'] == binding['runId'] and proof['workflowRunAttempt'] == str(binding['attempt'])
         and proof['contractSha256'] == binding['contractSha256'], 'PUBLISHED_PROOF_IDENTITY_CHANGED')
    files.pop('build-proof.json')
    need(files == proof['files'], 'PUBLISHED_FILES_CHANGED')
    recipe_raw = git('show', binding['commit'] + ':scripts/production-release/' + binding['contractFile'])
    need(digest(recipe_raw) == binding['contractSha256'], 'PUBLISHED_CONTRACT_CHANGED')
    recipe = json.loads(recipe_raw)
    need(proof['sources'] == recipe['sources'], 'PUBLISHED_SOURCE_SCOPE_CHANGED')
    for name, value in proof['sources'].items():
        need(digest(git('show', binding['commit'] + ':' + name)) == value, 'PUBLISHED_SOURCE_CHANGED')
    for name, value in proof['controlSources'].items():
        need(digest(git('show', binding['commit'] + ':scripts/production-release/' + name)) == value,
             'PUBLISHED_CONTROL_CHANGED')
    return proof


SHARED_DECLARATION_SHA = 'de0f432308f72e5e58cae4fa8a12a389f81d582d5342fd231a57c29c90c6c7cb'


def historical_member_limit(binding, name):
    # The already-published e84 declaration is larger than the general member
    # cap. Only this native source, single path, exact size and hash may exceed it.
    if binding == r.PUBLISHED_BUILDS['sharedCard'] and name == 'payload/api/prisma-client/index.d.ts':
        return 13060611
    return 8 * 1024**2


def overlay(context, commit, sources):
    for name, expected in sources.items():
        path = context / name
        need('..' not in Path(name).parts and not path.is_symlink()
             and path.resolve().is_relative_to(context.resolve()), 'OVERLAY_PATH_INVALID')
        raw = git('show', commit + ':' + name)
        need(digest(raw) == expected, 'PUBLISHED_SOURCE_CHANGED')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def reconstruct(context, c, *, include_browser):
    prior = r.helper('registration-browser-release.py').prior_recipe()
    old = r.helper(r.OLD_NAME + '-build.py')
    old.reconstruct(context, prior)
    overlay(context, '6fc99d23c2918280a94c3f5b8be48f638190e02f',
            {**prior['sources'], **prior['validationSources']})
    browser_recipe = history_browser(c)
    r.helper('registration-browser-build.py').restore_runtime_worker_tests(context, browser_recipe, prior)
    settings = json.loads((HERE / 'online-settings-contract.json').read_bytes())
    for layer in settings['publishedOverlays']:
        if layer['commit'] == r.BROWSER_COMMIT and not include_browser:
            continue
        overlay(context, layer['commit'], {**layer['sources'], **layer['validationSources']})
    overlay(context, settings['sourceReviewCommit'], settings['sources'])
    overlay(context, r.CURRENT, c['retainedSharedCard']['sources'])
    if include_browser:
        # Published validation bytes are not the installed runtime test bytes.
        # Restore the same three immutable e90 files used by the prior builder.
        r.helper('registration-browser-build.py').restore_runtime_worker_tests(context, browser_recipe, prior)
    else:
        # Keep the encrypted historical reader, while no browser executable remains.
        overlay(context, r.BROWSER_COMMIT, {WORKER + 'release_safety.py': r.SAFE_READER_SHA})
        for name in c['withdrawal']['sourceRemovals']:
            need(not (context / name).exists(), 'WITHDRAWN_SOURCE_REINTRODUCED')
        for name, value in {**c['sources'], **c['validationSources']}.items():
            path = context / name
            raw = (ROOT / name).read_bytes()
            need(digest(raw) == value, 'CANDIDATE_SOURCE_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        for name, expected in c['validationBaselineSources'].items():
            overlay(context, r.SOURCE_BASE, {name: expected})
    expected_worker = dict(c['baselineWorkerFiles'])
    if not include_browser:
        expected_worker = {n: v for n, v in expected_worker.items() if n not in c['withdrawal']['workerRemovals']}
        expected_worker.update(c['workerFiles'])
    need(all((context / WORKER / n).is_file() and digest((context / WORKER / n).read_bytes()) == value
             for n, value in expected_worker.items()), 'RECONSTRUCTED_WORKER_CHANGED')
    need(digest((context / 'apps/api/prisma-mysql/schema.prisma').read_bytes()) == c['schemaSha256'],
         'PRESERVED_SCHEMA_CHANGED')


def history_browser(c):
    return r.history(c)


def generate_client(context):
    # Match the actual shared-card publisher, including npm workspace semantics.
    # ci-info's public generated metadata is fixed in the child only.
    env = {**os.environ, 'GITHUB_ACTIONS': 'true',
           'DATABASE_URL': 'mysql://prisma:prisma@127.0.0.1:3306/id_business_v2'}
    run('npm', 'run', 'prisma:mysql:generate', cwd=context, env=env)


def unchanged_client(context, c):
    directory = context / 'node_modules/.prisma/client'
    values = inventory(directory)
    metadata = c['prismaPathMetadata']
    need(metadata['files'] == ['index.js', 'edge.js', 'wasm.js'], 'CLIENT_METADATA_SCOPE_CHANGED')
    for name in metadata['files']:
        raw = (directory / name).read_text()
        for field, suffix in [('"output": {\n      "value": ', 'node_modules/@prisma/client'),
                              ('"sourceFilePath": ', 'apps/api/prisma-mysql/schema.prisma')]:
            before = field + json.dumps(str(context / suffix))
            after = field + json.dumps(metadata['publishedContext'] + '/' + suffix)
            need(raw.count(before) == 1, 'CLIENT_METADATA_FIELD_CHANGED')
            raw = raw.replace(before, after, 1)
        values[name] = digest(raw.encode())
    if values != c['baselinePrismaClientFiles']:
        print(json.dumps({'status': 'PRISMA_CLIENT_INVENTORY_MISMATCH',
            **r.helper(r.OLD_NAME + '-build.py').client_inventory_diagnostic(c['baselinePrismaClientFiles'], values)}),
            flush=True)
    need(values == c['baselinePrismaClientFiles'], 'UNCHANGED_CLIENT_NOT_REPRODUCED')
    return values


def api_delta(before, after, approved):
    c = json.loads(CONTRACT.read_bytes())
    removed = c['withdrawal']['apiRemovals']
    need(before.keys() - after.keys() == removed.keys()
         and all(before.get(n) == v for n, v in removed.items()), 'COMPILED_REMOVAL_SCOPE_CHANGED')
    for suffix in ('.js', '.js.map'):
        name = r.TYPE_DECLARATION.removesuffix('.d.ts') + suffix
        need(before.get(name) == after.get(name), 'TYPE_ONLY_JAVASCRIPT_CHANGED')
    need(after.get(r.TYPE_DECLARATION) == r.TYPE_DECLARATION_SHA, 'TYPE_DECLARATION_NOT_REPRODUCED')
    projected = {n: v for n, v in before.items() if n not in removed}
    return r.helper(r.OLD_NAME + '-build.py').api_delta(projected, after, approved)


def namespace():
    return r.private_namespace(r.OLD_NAME + '-build.py', {'CONTRACT': CONTRACT, 'OUTPUT': OUTPUT,
        'verify_sources': verify_sources, 'unchanged_client': unchanged_client, 'api_delta': api_delta,
        'run': run, 'git': git})


def verify_baseline_union(c, proofs):
    browser = history_browser(c)
    need(proofs['browser']['sources'] == browser['sources']
         and proofs['sharedCard']['sources'] == c['retainedSharedCard']['sources'], 'PUBLISHED_CHAIN_CHANGED')
    api = dict(browser['baselineApiFiles'])
    admin = dict(browser['runtimeAdminFiles'])
    for layer in ('browser', 'onlineSettings', 'sharedCard'):
        api.update({n: v for n, v in proofs[layer]['apiModules'].items() if n.endswith('.js')})
        admin.update(proofs[layer]['adminFiles'])
    expected = {'baselineApiFiles': api, 'runtimeAdminFiles': admin,
        'baselineWorkerFiles': {**browser['baselineWorkerFiles'], **proofs['browser']['workerFiles']},
        'baselineAdminFiles': proofs['sharedCard']['adminFiles'],
        'baselinePrismaClientFiles': {**browser['baselinePrismaClientFiles'], **proofs['sharedCard']['prismaClientFiles']},
        'runtimePrismaClientFiles': {**browser['runtimePrismaClientFiles'], **proofs['sharedCard']['prismaClientFiles']}}
    need(all(c.get(k) == value for k, value in expected.items()), 'PUBLISHED_BASELINE_UNION_CHANGED')


def prepare():
    c = json.loads(CONTRACT.read_bytes())
    verify_sources(c)
    r.helper('registration-browser-build.py').verify_prior_chain()
    proofs = {name: native_bundle(binding) for name, binding in c['publishedBuilds'].items()}
    verify_baseline_union(c, proofs)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True, mode=0o700)
    for role in ('baseline', 'candidate'):
        context = OUTPUT / role
        reconstruct(context, c, include_browser=role == 'baseline')
        run('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context)
        generate_client(context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)
    print(json.dumps({'status': SCOPE + '_PREPARED', 'migrationPerformed': False, 'businessActions': 0}))


def build():
    namespace()['build']()
    path = OUTPUT / 'prepared-build-proof.json'
    proof = json.loads(path.read_bytes())
    c = json.loads(CONTRACT.read_bytes())
    proof.update(withdrawal=c['withdrawal'], retainedSharedCard=c['retainedSharedCard'])
    path.write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')


def validate():
    c = json.loads(CONTRACT.read_bytes())
    verify_sources(c)
    context = OUTPUT / 'candidate'
    python = OUTPUT / 'python/bin/python'
    (context / '.runtime').mkdir(parents=True, exist_ok=True)
    for module in c['pythonTests']:
        need(re.fullmatch('test_[a-z0-9_]+', module), 'TEST_PATH_INVALID')
        run(str(python), '-B', '-m', 'unittest', module, cwd=context / WORKER)
    for workspace, tests in [('apps/api', c['apiTests']), ('apps/admin', c['adminTests'])]:
        run('npm', 'run', 'test', '--workspace', workspace, '--', *tests, cwd=context)
        run('npm', 'run', 'typecheck', '--workspace', workspace, cwd=context)
    for guard in ('admin-ui', 'v2-ui-language', 'v2-color-contrast', 'v2-table-standard',
                  'v2-loading-standard', 'v2-module-architecture', 'v2-isolation'):
        run('npm', 'run', 'check:' + guard, cwd=context)
    for script in c['browserAcceptances']:
        need(script in {**c['validationSources'], **c['validationBaselineSources']}
             and script.startswith('scripts/acceptance-v2-'), 'BROWSER_TEST_PATH_INVALID')
        run('node', script, '--python=' + str(python), cwd=context)
    (OUTPUT / 'validation-receipt.json').write_text(json.dumps({'scope': SCOPE, 'sources': c['sources'],
        'validationSources': c['validationSources'], 'businessActions': 0, 'externalRequests': 0, 'status': 'PASS'},
        sort_keys=True) + '\n')


def package():
    namespace()['package']()


def check(mode):
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('CHECK_MODE') == 'recharge',
         'CHECKS_REQUIRE_ISOLATED_CI')
    prepare()
    (OUTPUT / 'candidate' / '.runtime').mkdir(mode=0o700, parents=True, exist_ok=True)
    python = OUTPUT / 'python/bin/python'
    run(sys.executable, '-m', 'venv', str(OUTPUT / 'python'))
    run(str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '-r',
        str(OUTPUT / 'candidate' / WORKER / 'requirements.lock.txt'))
    c = json.loads(CONTRACT.read_bytes())
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    need(unchanged_client(baseline, c) == unchanged_client(candidate, c), 'UNCHANGED_CLIENT_NOT_REPRODUCED')
    if mode == 'check-api':
        for context in (baseline, candidate):
            run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
        before, after = inventory(baseline / 'apps/api/dist'), inventory(candidate / 'apps/api/dist')
        need({n: v for n, v in before.items() if n.endswith('.js')} == c['baselineApiFiles'],
             'BASE_API_NOT_REPRODUCED')
        api_delta(before, after, c['apiModules'])
        run('npm', 'run', 'typecheck', '--workspace', 'apps/api', cwd=candidate)
        run('npm', 'run', 'test', '--workspace', 'apps/api', '--', *c['apiTests'], cwd=candidate)
        for module in c['pythonTests']:
            need(re.fullmatch('test_[a-z0-9_]+', module), 'TEST_PATH_INVALID')
            run(str(python), '-B', '-m', 'unittest', module, cwd=candidate / WORKER)
    else:
        commit = git('rev-parse', 'HEAD').decode().strip()
        for context, build_id in [(baseline, c['baselineAdminBuildId']), (candidate, 'v2-' + commit)]:
            run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=context,
                env={**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': build_id})
        need(inventory(baseline / 'apps/admin/dist') == c['baselineAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
        run('npm', 'run', 'typecheck', '--workspace', 'apps/admin', cwd=candidate)
        run('npm', 'run', 'test', '--workspace', 'apps/admin', '--', *c['adminTests'], cwd=candidate)
        run('npm', 'exec', '--', 'playwright', 'install', '--with-deps', 'chromium', cwd=candidate)
        for script in c['browserAcceptances']:
            need(script in {**c['validationSources'], **c['validationBaselineSources']}, 'BROWSER_TEST_PATH_INVALID')
            run('node', script, '--python=' + str(python), cwd=candidate)


def main(arguments):
    need(len(arguments) == 1 and arguments[0] in {'prepare', 'build', 'validate', 'package', 'check-api', 'check-admin'},
         'BUILD_MODE_INVALID')
    if arguments[0].startswith('check-'):
        check(arguments[0])
    else:
        globals()[arguments[0]]()


if __name__ == '__main__':
    main(sys.argv[1:])
