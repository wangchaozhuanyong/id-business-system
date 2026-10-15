"""Reproduce published content, then build only the approved availability delta."""
import ast
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import re
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.deploy/recharge-availability-release'
CONTRACT = Path(__file__).with_name('recharge-availability-contract.json')


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_AVAILABILITY_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def inventory(root):
    result = {}
    for path in root.rglob('*'):
        need(not path.is_symlink(), 'CONTENT_SYMLINK')
        if path.is_file():
            result[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return result


def helper():
    spec = importlib.util.spec_from_file_location('published_record_build', Path(__file__).with_name('recharge-record-build.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.OUTPUT = OUTPUT
    return module


def platform_bytes(path):
    return subprocess.check_output(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/' + path], cwd=ROOT)


def platform_json(path):
    return json.loads(platform_bytes(path))


def platform_log_bytes(path):
    need(re.fullmatch(r'actions/jobs/[0-9]+/logs', path), 'DATABASE_LOG_PATH_INVALID')
    # Capture original bytes for verification; never forward log control bytes
    # to a terminal. New gh versions require an explicit flag for this stream.
    command = ['gh', 'api', '--allow-escape-sequences', 'repos/wangchaozhuanyong/id-business-system/' + path]
    result = subprocess.run(command, cwd=ROOT, capture_output=True)
    if result.returncode and b'unknown flag: --allow-escape-sequences' in result.stderr:
        result = subprocess.run([command[0], command[1], command[3]], cwd=ROOT, capture_output=True)
    need(result.returncode == 0, 'DATABASE_LOG_REQUEST_FAILED')
    return result.stdout


def verify_published_admin(contract):
    binding = contract['publishedAdminNative']
    run_id = str(binding['runId'])
    native = platform_json('actions/runs/' + run_id)
    need(native['head_sha'] == contract['sourceBaseline'] == binding['sourceCommit']
         and native['status'] == 'completed' and native['conclusion'] == binding.get('runConclusion', 'success')
         and native['path'] == binding['workflowPath'] and native['event'] == 'push'
         and native['run_attempt'] == 1, 'PUBLISHED_ADMIN_RUN_CHANGED')
    jobs = platform_json('actions/runs/' + run_id + '/attempts/1/jobs?per_page=100')['jobs']
    validators = [j for j in jobs if j['name'] == 'validate']
    need(len(validators) == 1 and validators[0]['conclusion'] == binding.get('validationConclusion', 'success')
         and any(s['name'] == 'Build Admin with Vue TypeScript checking' and s['conclusion'] == 'success'
                 for s in validators[0]['steps'])
         and [s['name'] for s in validators[0]['steps'] if s['conclusion'] == 'failure']
             == binding.get('failedValidationSteps', []), 'PUBLISHED_ADMIN_BUILD_NOT_SUCCESSFUL')
    artifacts = platform_json('actions/runs/' + run_id + '/artifacts')['artifacts']
    matches = [a for a in artifacts if a['id'] == binding['artifactId']]
    need(len(matches) == 1 and matches[0]['name'] == binding['artifactName']
         and matches[0]['expired'] is False and matches[0]['digest'] == binding['artifactDigest'],
         'PUBLISHED_ADMIN_ARTIFACT_CHANGED')
    workflow = git('show', contract['sourceBaseline'] + ':' + binding['workflowPath'])
    need(digest(workflow) == binding['workflowSha256'], 'PUBLISHED_ADMIN_COMMANDS_CHANGED')
    raw = platform_bytes('actions/artifacts/' + str(binding['artifactId']) + '/zip')
    need(len(raw) <= 8 * 1024**2 and 'sha256:' + digest(raw) == binding['artifactDigest'], 'PUBLISHED_ADMIN_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        need(len(names) == len(set(names)), 'PUBLISHED_ADMIN_DUPLICATE_PATH')
        actual = {n.removeprefix('apps/admin/dist/'): digest(archive.read(n))
                  for n in names if n.startswith('apps/admin/dist/') and not n.endswith('/')}
    need(actual == contract['publicFiles'], 'PUBLISHED_ADMIN_CONTENT_CHANGED')
    receipt = {**binding, 'verified': True,
               'publicInventorySha256': digest(json.dumps(actual, sort_keys=True, separators=(',', ':')).encode())}
    return raw, receipt


def published_admin_inputs(commit):
    if subprocess.run(['git','cat-file','-e',commit+'^{commit}'],cwd=ROOT,
                      stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        run('git','fetch','--no-tags','origin',commit)
    entries = []
    for row in filter(None, git('ls-tree','-r','-z',commit).split(b'\0')):
        header, raw_name = row.split(b'\t',1)
        mode, kind, oid = header.decode().split()
        name = raw_name.decode()
        if name.startswith(('apps/admin/','packages/shared/')) or name in {
                'package.json','package-lock.json','tsconfig.base.json','.npmrc'} or name.endswith('/package.json'):
            need(kind == 'blob' and mode in ('100644','100755'), 'SUCCESSOR_SOURCE_MODE_INVALID')
            entries.append((name,mode,oid))
    raw = subprocess.check_output(['git','cat-file','--batch'],cwd=ROOT,
                                 input=''.join(oid+'\n' for _,_,oid in entries).encode())
    position, files = 0, {}
    for name,mode,oid in entries:
        end = raw.index(b'\n',position)
        header = raw[position:end].decode().split()
        need(header[:2] == [oid,'blob'], 'SUCCESSOR_SOURCE_OBJECT_INVALID')
        length = int(header[2])
        content = raw[end+1:end+1+length]
        need(raw[end+1+length:end+2+length] == b'\n', 'SUCCESSOR_SOURCE_OBJECT_INVALID')
        files[name] = {'mode':mode,'sha256':digest(content)}
        position = end+2+length
    need(position == len(raw), 'SUCCESSOR_SOURCE_OBJECT_INVALID')
    return files


def successor_receipt(contract, field='publishedAdminSuccessor'):
    binding = contract[field]
    return {key:binding[key] for key in ('sourceCommit','sourceTree','archiveSha256','publicInventorySha256')} | {
        'inputSha256':binding['roleProjection']['inputSha256'],'qualityRunId':binding['quality']['runId'],'verified':True}


def verify_successor_archive(raw, binding):
    need(len(raw) == binding['archiveBytes'] and digest(raw) == binding['archiveSha256'], 'SUCCESSOR_ARCHIVE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        members = archive.getmembers()
        names = [item.name for item in members]
        expected = {'compiled-manifest.json','admin/Dockerfile'} | {'admin/dist/'+n for n in binding['publicFiles']}
        need(len(names) == len(set(names)) and set(names) == expected
             and all(item.isfile() and 0 <= item.size <= 8*1024**2 for item in members), 'SUCCESSOR_ARCHIVE_SCOPE_INVALID')
        metadata = json.loads(archive.extractfile('compiled-manifest.json').read())
        need(metadata == {'commit':binding['sourceCommit'],'roleProjection':binding['roleProjection'],
                          'newStaticFiles':binding['publicFiles'],'newStaticSha256':binding['publicInventorySha256']},
             'SUCCESSOR_MANIFEST_CHANGED')
        actual = {name:digest(archive.extractfile('admin/dist/'+name).read()) for name in binding['publicFiles']}
    need(actual == binding['publicFiles'] and digest(json.dumps(actual,sort_keys=True,separators=(',',':')).encode())
         == binding['publicInventorySha256'], 'SUCCESSOR_STATIC_CHANGED')


def verify_published_admin_version(contract, binding, parent_commit):
    quality = binding['quality']
    projection = binding['roleProjection']
    canonical = lambda value: json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    files = published_admin_inputs(binding['sourceCommit'])
    need(projection['commit'] == binding['sourceCommit'] and projection['sourceTree'] == binding['sourceTree']
         == git('rev-parse',binding['sourceCommit']+'^{tree}').decode().strip()
         and projection['publishedBaseCommit'] == parent_commit
         and len(files) == projection['inputFileCount'] and digest(canonical(files)) == projection['inputSha256']
         and {name:files[name] for name in binding['repairSources']} == binding['repairSources']
         and digest(canonical(binding['repairSources'])) == projection['repairInputsSha256'], 'SUCCESSOR_INPUTS_CHANGED')
    if parent_commit == contract['sourceBaseline']:
        need(projection.get('retainedPublishedAdminSource') == contract['sourceBaseline'], 'SUCCESSOR_ROOT_CHANGED')
    changed = set(git('diff','--name-only',parent_commit,binding['sourceCommit'],'--',*files).decode().splitlines())
    need(changed == set(binding['repairSources']), 'SUCCESSOR_SOURCE_SCOPE_CHANGED')
    native = platform_json('actions/runs/'+str(quality['runId']))
    need(native['head_sha'] == binding['sourceCommit'] and native['head_branch'] == quality['headBranch']
         and native['event'] == 'pull_request' and native['path'] == '.github/workflows/quality.yml'
         and native['status'] == 'completed' and native['conclusion'] == 'success' and native['run_attempt'] == 1,
         'SUCCESSOR_QUALITY_CHANGED')
    jobs = platform_json('actions/runs/'+str(quality['runId'])+'/attempts/1/jobs?per_page=100')['jobs']
    states = {job['name']:job['conclusion'] for job in jobs}
    need(all(states.get(n) == 'success' for n in ('change-scope','recharge (guards)','recharge (admin)','quality'))
         and all(v in ('success','skipped') for v in states.values()), 'SUCCESSOR_QUALITY_NOT_SUCCESSFUL')
    artifacts = platform_json('actions/runs/'+str(quality['runId'])+'/artifacts')['artifacts']
    matches = [a for a in artifacts if a['id'] == quality['artifactId']]
    need(len(matches) == 1 and not matches[0]['expired'] and matches[0]['name'] == 'quality-source-evidence-1'
         and matches[0]['digest'] == quality['artifactDigest'], 'SUCCESSOR_QUALITY_ARTIFACT_CHANGED')
    quality_zip = platform_bytes('actions/artifacts/'+str(quality['artifactId'])+'/zip')
    need('sha256:'+digest(quality_zip) == quality['artifactDigest'], 'SUCCESSOR_QUALITY_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(quality_zip)) as archive:
        need(archive.namelist() == ['evidence.json'] and json.loads(archive.read('evidence.json')) == quality['evidence'],
             'SUCCESSOR_QUALITY_EVIDENCE_CHANGED')
    need(quality['evidence']['headSha'] == binding['sourceCommit']
         and quality['evidence']['testedTree'] == binding['sourceTree']
         and quality['evidence']['repository'] == 'wangchaozhuanyong/id-business-system'
         and quality['evidence']['runId'] == quality['runId'] and quality['evidence']['runAttempt'] == 1
         and quality['evidence']['pullRequest'] == quality['pullRequest'], 'SUCCESSOR_QUALITY_IDENTITY_CHANGED')
    release = platform_json('releases/tags/'+binding['releaseTag'])
    assets = [a for a in release['assets'] if a['id'] == binding['assetId']]
    need(release['id'] == binding['releaseId'] and release['tag_name'] == binding['releaseTag']
         and release['target_commitish'] == binding['sourceCommit'] and len(assets) == 1
         and assets[0]['name'] == 'published-bit-login-admin-native.tar.gz'
         and assets[0]['size'] == binding['archiveBytes'] and assets[0]['digest'] == 'sha256:'+binding['archiveSha256'],
         'SUCCESSOR_ASSET_IDENTITY_CHANGED')
    raw = subprocess.check_output(['gh','api','repos/wangchaozhuanyong/id-business-system/releases/assets/'+str(binding['assetId']),
                                  '-H','Accept: application/octet-stream'],cwd=ROOT)
    verify_successor_archive(raw,binding)
    return raw, quality_zip


def verify_published_admin_successor(contract):
    ancestor = contract['publishedAdminAncestor']
    parent_raw, parent_quality = verify_published_admin_version(contract,ancestor,contract['sourceBaseline'])
    raw, quality_zip = verify_published_admin_version(contract,contract['publishedAdminSuccessor'],ancestor['sourceCommit'])
    return raw,quality_zip,successor_receipt(contract),parent_raw,parent_quality,successor_receipt(contract,'publishedAdminAncestor')


def database_inputs(contract):
    # These MySQL suites import API/shared sources only. Published Admin-only
    # repairs receive their own frontend validation and cannot change DB inputs.
    return {'sourceBaseline': contract['sourceBaseline'], 'apiModules': contract['apiModules'],
            'sources': {n: v for n, v in contract['sources'].items()
                        if n.startswith(('apps/api/', 'packages/'))}}


def database_preparation_functions(tree):
    # The only new preparation step copies the authenticated, frontend-only
    # predecessor. API/shared/schema/lockfile materialization stays identical.
    statement = ast.dump(ast.parse('apply_preserved_admin_sources(context, contract)').body[0])
    class FrontendOverlay(ast.NodeTransformer):
        def visit_Expr(self, node):
            return None if ast.dump(node) == statement else self.generic_visit(node)
    selected = {'prepare', 'helper', 'run', 'git'}
    return {n.name: ast.dump(FrontendOverlay().visit(n)) for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name in selected}


def verify_shared_proxy_sources(contract):
    binding = contract.get('publishedSharedProxy')
    if not binding:
        need(not contract.get('preservedAdminSources'), 'PRESERVED_ADMIN_ORIGIN_MISSING')
        return
    files = published_admin_inputs(binding['sourceCommit'])
    parent = published_admin_inputs(contract['publishedAdminSuccessor']['sourceCommit'])
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    changed = set(git('diff', '--name-only', contract['publishedAdminSuccessor']['sourceCommit'],
                      binding['sourceCommit'], '--', *sorted(set(files) | set(parent))).decode().splitlines())
    actual = {n: files[n]['sha256'] if n in files else None for n in changed}
    projection = binding['runtimeProjection']
    need(all(n.startswith('apps/admin/src/v2/') for n in actual)
         and actual == contract['preservedAdminSources']
         and digest(canonical(actual)) == binding['sourceDeltaSha256']
         and len(files) == binding['inputFileCount'] and digest(canonical(files)) == binding['inputSha256']
         and git('rev-parse', binding['sourceCommit']+'^{tree}').decode().strip() == binding['sourceTree']
         and projection['commit'] == binding['sourceCommit'] and projection['sourceTree'] == binding['sourceTree']
         and projection['publicationArtifactSha256'] == binding['archiveSha256']
         and projection['ciRun'] == str(binding['runId']) and projection['role'] == 'admin'
         and projection['runtimeImageId'] == contract['services']['admin']['image'],
         'PRESERVED_ADMIN_SOURCE_CHANGED')


def apply_preserved_admin_sources(context, contract):
    for name, expected in contract.get('preservedAdminSources', {}).items():
        need(name.startswith('apps/admin/src/v2/') and '..' not in Path(name).parts,
             'PRESERVED_ADMIN_SCOPE_INVALID')
        target = context / name
        need(not target.is_symlink(), 'PRESERVED_ADMIN_SYMLINK')
        if expected is None:
            target.unlink(missing_ok=True)
        else:
            raw = git('show', contract['publishedSharedProxy']['sourceCommit']+':'+name)
            need(digest(raw) == expected, 'PRESERVED_ADMIN_SOURCE_CHANGED')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)


def shared_proxy_receipt(contract):
    binding = contract['publishedSharedProxy']
    return {n: binding[n] for n in ('sourceCommit', 'sourceTree', 'archiveSha256', 'artifactDigest',
            'publicInventorySha256', 'inputSha256', 'sourceDeltaSha256', 'runId')} | {'verified': True}


def verify_shared_proxy_archive(raw, binding):
    need(len(raw) <= 16*1024**2 and 'sha256:'+digest(raw) == binding['artifactDigest'],
         'SHARED_PROXY_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        need(len(names) == len(set(names)) and all(not Path(n).is_absolute() and '..' not in Path(n).parts
             and info.file_size <= 32*1024**2 and (info.external_attr >> 16) & 0o170000 != 0o120000
             for n, info in zip(names, archive.infolist())), 'SHARED_PROXY_ARCHIVE_UNSAFE')
        bundle = archive.read('shared-proxy-release/publication.tar.gz')
        need(len(bundle) == binding['archiveBytes'] and digest(bundle) == binding['archiveSha256']
             == archive.read('shared-proxy-release/publication-sha256.txt').decode().strip(),
             'SHARED_PROXY_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        members = archive.getmembers()
        need(all((m.isdir() or m.isfile()) and not Path(m.name).is_absolute() and '..' not in Path(m.name).parts
                 and 0 <= m.size <= 32*1024**2 for m in members)
             and sum(m.size for m in members) <= 64*1024**2, 'SHARED_PROXY_ARCHIVE_UNSAFE')
        files = {m.name.removeprefix('./'): m for m in members if m.isfile()}
        need(len(files) == sum(m.isfile() for m in members), 'SHARED_PROXY_ARCHIVE_UNSAFE')
        metadata_raw = archive.extractfile(files['publication.json']).read()
        metadata = json.loads(metadata_raw)
        need(digest(metadata_raw) == binding['metadataSha256'] and metadata['commit'] == binding['sourceCommit']
             and metadata['sourceTree'] == binding['sourceTree'] and metadata['runId'] == str(binding['runId'])
             and metadata['baseline'] == '04aa234505adccfe295776245b88fc56feac0588'
             and metadata['adminBaseline'] == '4aa49436239ab57e9deb3b5890e645ceeef25149'
             and set(files) == set(metadata['files']) | {'publication.json'}, 'SHARED_PROXY_METADATA_CHANGED')
        need(all(digest(archive.extractfile(files[n]).read()) == v for n, v in metadata['files'].items()),
             'SHARED_PROXY_CONTENT_CHANGED')
        public = {n.removeprefix('admin/dist/'): v for n, v in metadata['files'].items() if n.startswith('admin/dist/')}
        need(public == binding['publicFiles'] and digest(json.dumps(public, sort_keys=True,
             separators=(',', ':')).encode()) == binding['publicInventorySha256'], 'SHARED_PROXY_PUBLIC_CHANGED')


def verify_published_shared_proxy(contract):
    binding = contract['publishedSharedProxy']
    verify_shared_proxy_sources(contract)
    native = platform_json('actions/runs/'+str(binding['runId']))
    need(native['head_sha'] == binding['sourceCommit'] and native['head_branch'] == binding['headBranch']
         and native['event'] == 'push' and native['path'] == binding['workflowPath']
         and native['status'] == 'completed' and native['conclusion'] == 'success' and native['run_attempt'] == 1
         and digest(git('show', binding['sourceCommit']+':'+binding['workflowPath'])) == binding['workflowSha256'],
         'SHARED_PROXY_RUN_CHANGED')
    jobs = platform_json('actions/runs/'+str(binding['runId'])+'/attempts/1/jobs')['jobs']
    need(len(jobs) == 1 and jobs[0]['name'] == 'validate' and jobs[0]['conclusion'] == 'success'
         and set(binding['requiredSteps']) <= {s['name'] for s in jobs[0]['steps'] if s['conclusion'] == 'success'},
         'SHARED_PROXY_VALIDATION_CHANGED')
    artifacts = platform_json('actions/runs/'+str(binding['runId'])+'/artifacts')['artifacts']
    matches = [a for a in artifacts if a['id'] == binding['artifactId']]
    need(len(matches) == 1 and not matches[0]['expired'] and matches[0]['name'] == binding['artifactName']
         and matches[0]['digest'] == binding['artifactDigest'], 'SHARED_PROXY_ARTIFACT_CHANGED')
    raw = platform_bytes('actions/artifacts/'+str(binding['artifactId'])+'/zip')
    verify_shared_proxy_archive(raw, binding)
    return raw, shared_proxy_receipt(contract)


def verify_database_evidence(contract):
    binding = contract['databaseValidationNative']
    commit, run_id = binding['sourceCommit'], str(binding['runId'])
    old_raw = git('show', commit + ':scripts/production-release/recharge-availability-contract.json')
    old = json.loads(old_raw)
    need(database_inputs(old) == database_inputs(contract), 'DATABASE_INPUTS_CHANGED')
    path = '.github/workflows/recharge-availability-validation.yml'
    workflow = git('show', commit + ':' + path)
    current = (ROOT / path).read_bytes()
    def commands(raw):
        text = raw.decode()
        start = text.index('      - name: Migrate only the disposable runner database\n')
        end = text.index('      - name: Verify published provenance and build finite API and Admin artifacts\n')
        return text[start:end].replace("        if: steps.database_evidence.outputs.reuse != 'true'\n", '')
    def environment(raw):
        text = raw.decode()
        return text[text.index('    services:\n'):text.index('    steps:\n')]
    need(digest(workflow) == binding['workflowSha256'] and commands(workflow) == commands(current)
         and environment(workflow) == environment(current), 'DATABASE_COMMANDS_CHANGED')
    previous_build = ast.parse(git('show', commit + ':scripts/production-release/recharge-availability-build.py'))
    current_build = ast.parse(Path(__file__).read_bytes())
    # Source admission is checked directly against the frozen forward-main
    # boundary below; candidate materialization and all DB inputs stay exact.
    verify_sources(contract)
    need(database_preparation_functions(previous_build) == database_preparation_functions(current_build)
         and git('show', commit + ':scripts/production-release/recharge-record-build.py')
             == Path(__file__).with_name('recharge-record-build.py').read_bytes(), 'DATABASE_PREPARATION_CHANGED')
    native = platform_json('actions/runs/' + run_id)
    need(native['head_sha'] == commit and native['head_branch'] == 'main' and native['status'] == 'completed'
         and native['event'] == 'workflow_dispatch' and native['path'] == path and native['run_attempt'] == 1,
         'DATABASE_RUN_CHANGED')
    jobs = platform_json('actions/runs/' + run_id + '/attempts/1/jobs')['jobs']
    validators = [j for j in jobs if j['name'] == 'validate']
    required = {'Migrate only the disposable runner database',
                'Verify availability queries, locking, idempotency and audit rollback in isolated MySQL'}
    need(len(validators) == 1 and validators[0]['conclusion'] == 'success'
         and required <= {s['name'] for s in validators[0]['steps'] if s['conclusion'] == 'success'},
         'DATABASE_VALIDATION_NOT_SUCCESSFUL')
    artifacts = platform_json('actions/runs/' + run_id + '/artifacts')['artifacts']
    matches = [a for a in artifacts if a['id'] == binding['artifactId']]
    need(len(matches) == 1 and matches[0]['name'] == binding['artifactName']
         and not matches[0]['expired'] and matches[0]['digest'] == binding['artifactDigest'], 'DATABASE_ARTIFACT_CHANGED')
    raw = platform_bytes('actions/artifacts/' + str(binding['artifactId']) + '/zip')
    need('sha256:' + digest(raw) == binding['artifactDigest'], 'DATABASE_ARTIFACT_DIGEST_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        bundle = archive.read('recharge-availability-artifact.tar.gz')
        need(digest(bundle) == archive.read('artifact-sha256.txt').decode().strip(), 'DATABASE_BUNDLE_CHANGED')
    with tarfile.open(fileobj=io.BytesIO(bundle)) as archive:
        proof = json.loads(archive.extractfile('payload/build-proof.json').read())
        need(proof['commit'] == commit and proof['workflowRunId'] == run_id and proof['workflowRunAttempt'] == '1'
             and proof['tree'] == git('rev-parse', commit + '^{tree}').decode().strip()
             and proof['contractSha256'] == digest(old_raw), 'DATABASE_BUILD_IDENTITY_CHANGED')
        for name, expected in old['sources'].items():
            need(digest(archive.extractfile('payload/source/' + name).read()) == expected, 'DATABASE_TESTED_SOURCE_CHANGED')
    log = re.sub(rb'\x1b\[[0-9;]*m', b'', platform_log_bytes('actions/jobs/' + str(validators[0]['id']) + '/logs'))
    need(b'7 passed' in log and b'25 passed' in log, 'DATABASE_TEST_COUNTS_CHANGED')
    return {**binding, 'verified': True, 'reused': True, 'testsPassed': 32}


def database_evidence():
    contract = json.loads(CONTRACT.read_bytes())
    proof = verify_database_evidence(contract)
    (OUTPUT / 'database-evidence.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write('reuse=true\n')
    print(json.dumps(proof, sort_keys=True))


def verify_sources(contract):
    need(not git('status', '--porcelain', '--untracked-files=no').strip(), 'SOURCE_DIRTY')
    changed = set(git('diff', '--name-only', contract['reviewBase'], 'HEAD', '--', 'apps/', 'packages/').decode().splitlines())
    approved = {n for n in contract['sources'] if n.startswith(('apps/', 'packages/'))} | set(contract.get('preservedAdminSources', {}))
    verify_source_boundary(contract,changed,approved)
    for name, expected in contract['sources'].items():
        need(digest((ROOT / name).read_bytes()) == expected, 'SOURCE_CHANGED')
    verify_shared_proxy_sources(contract)
    for name, expected in contract.get('preservedAdminSources', {}).items():
        path = ROOT / name
        need((not path.exists()) if expected is None else path.is_file() and digest(path.read_bytes()) == expected,
             'PRESERVED_ADMIN_SOURCE_CHANGED')
    need(git('show', contract['sourceBaseline'] + ':package-lock.json') == (ROOT / 'package-lock.json').read_bytes(), 'LOCKFILE_CHANGED')


def verify_source_boundary(contract, changed, approved):
    foreign = {name for name in changed-approved
               if git('ls-tree','HEAD','--',name) != git('ls-tree',contract['sourceBaseline'],'--',name)}
    retained = contract.get('mainOnlySources',{})
    need(approved <= changed and foreign == set(retained), 'SOURCE_SCOPE_CHANGED')
    if not retained:
        return
    commit = contract['mainOnlySourceBaseline']
    need(re.fullmatch('[a-f0-9]{40}',commit) and subprocess.run(
        ['git','merge-base','--is-ancestor',commit,'HEAD'],cwd=ROOT).returncode == 0, 'MAIN_ONLY_BASE_CHANGED')
    for name,expected in retained.items():
        old = git('ls-tree',commit,'--',name)
        current = git('ls-tree','HEAD','--',name)
        need(old == current and (digest(git('show',commit+':'+name)) if old else None) == expected,
             'MAIN_ONLY_SOURCE_CHANGED')


def verify_api_outputs(before, after, modules):
    permitted = {n.removesuffix('.js') + ext for n in modules for ext in ('.js', '.js.map', '.d.ts')}
    # Incremental caches and inferred declarations are not executable output.
    # Only the finite declaration files in permitted are included in the payload.
    changed_runtime = {n for n in set(before) | set(after)
                       if n.endswith(('.js', '.js.map')) and before.get(n) != after.get(n)}
    need(changed_runtime <= permitted, 'API_OUTPUT_SCOPE_CHANGED')
    need(all(n in after for n in permitted), 'API_OUTPUT_MISSING')
    return permitted


def prepare():
    contract = json.loads(CONTRACT.read_bytes())
    if subprocess.run(['git','cat-file','-e',contract['sourceBaseline']+'^{commit}'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        run('git','fetch','--no-tags','origin',contract['sourceBaseline'])
    verify_sources(contract)
    need(not OUTPUT.exists(), 'OUTPUT_EXISTS')
    OUTPUT.mkdir(parents=True)
    h = helper()
    source = git('archive', contract['sourceBaseline'])
    for name in ('baseline', 'candidate'):
        context = OUTPUT / name
        h.extract_source(source, context)
        if name == 'candidate':
            apply_preserved_admin_sources(context, contract)
            for path in contract['sources']:
                destination = context / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes((ROOT / path).read_bytes())
        run('npm', 'ci', '--no-audit', cwd=context)
        run('npm', 'run', 'prisma:mysql:generate', '--workspace', 'apps/api', cwd=context)
        run('npm', 'run', 'build', '--workspace', 'packages/shared', cwd=context)


def build():
    contract = json.loads(CONTRACT.read_bytes())
    verify_sources(contract)
    baseline, candidate = OUTPUT / 'baseline', OUTPUT / 'candidate'
    for context in (baseline, candidate):
        run('npm', 'run', 'build', '--workspace', 'apps/api', cwd=context)
    for name, expected in contract['apiModules'].items():
        path = baseline / 'apps/api/dist' / name
        need((digest(path.read_bytes()) if path.exists() else None) == expected, 'BASELINE_API_NOT_REPRODUCED')
    before = inventory(baseline / 'apps/api/dist')
    after = inventory(candidate / 'apps/api/dist')
    permitted = verify_api_outputs(before, after, contract['apiModules'])
    # Reuse the exact original successful native Admin build; do not relabel a local rebuild.
    published_admin_zip, admin_verification = verify_published_admin(contract)
    successor_raw, successor_quality_zip, successor_verification, ancestor_raw, ancestor_quality_zip, ancestor_verification = verify_published_admin_successor(contract)
    shared_proxy_raw, shared_proxy_verification = verify_published_shared_proxy(contract)
    run('npm', 'run', 'build', '--workspace', 'apps/admin', cwd=candidate,
        env={**os.environ, 'NODE_ENV': contract['adminNodeEnv'], 'V2_BUILD_ID': 'v2-' + git('rev-parse', 'HEAD').decode().strip()})
    payload = OUTPUT / 'payload'
    payload.mkdir()
    (payload / 'baseline-admin-native.zip').write_bytes(published_admin_zip)
    (payload / 'baseline-admin-successor-native.tar.gz').write_bytes(successor_raw)
    (payload / 'baseline-admin-successor-quality-native.zip').write_bytes(successor_quality_zip)
    (payload / 'baseline-admin-ancestor-native.tar.gz').write_bytes(ancestor_raw)
    (payload / 'baseline-admin-ancestor-quality-native.zip').write_bytes(ancestor_quality_zip)
    (payload / 'baseline-shared-proxy-native.zip').write_bytes(shared_proxy_raw)
    for name in sorted(permitted):
        path = payload / 'api/modules' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate / 'apps/api/dist' / name, path)
    shutil.copytree(candidate / 'apps/admin/dist', payload / 'admin/html')
    for name in contract['sources']:
        path = payload / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / name).read_bytes())
    proof = {'version': 1, 'scope': contract['scope'], 'commit': git('rev-parse', 'HEAD').decode().strip(),
             'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'contractSha256': digest(CONTRACT.read_bytes()),
             'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
             'controllerSha256': digest(Path(__file__).with_name('recharge-availability-release.py').read_bytes()),
             'releaseUtilitySha256': digest(Path(__file__).with_name('remote-deploy.py').read_bytes()),
             'helperSha256': digest(Path(__file__).with_name('recharge-record-release.py').read_bytes()),
             'baselineApiReproduced': True, 'baselineAdminArtifactVerified': True,
             'databaseVerification': json.loads((OUTPUT / 'database-evidence.json').read_bytes()),
             'baselineAdminVerification': admin_verification, 'baselineAdminSuccessorVerification': successor_verification,
             'baselineAdminAncestorVerification': ancestor_verification,
             'preservedSharedProxyVerification': shared_proxy_verification,
             'files': inventory(payload),
             'apiModules': {name: after[name] for name in sorted(permitted)},
             'adminFiles': inventory(candidate / 'apps/admin/dist'), 'updatedServices': ['api', 'admin'],
             'migrationPerformed': False, 'businessActions': 0}
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUTPUT / 'recharge-availability-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUTPUT / 'artifact-sha256.txt').write_text(digest(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'AVAILABILITY_ARTIFACT_BUILT', 'apiFiles': len(permitted), 'adminFiles': len(proof['adminFiles'])}))


if __name__ == '__main__':
    {'prepare': prepare, 'build': build, 'database-evidence': database_evidence}[sys.argv[1]]()
