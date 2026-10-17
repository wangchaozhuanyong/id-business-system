"""Reproduce published role sources; package only the frozen four-feature delta."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import re
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-pending-features'
CONTRACT = HERE / 'online-pending-features-contract.json'
RECONSTRUCTION_PINS = (
    'recharge-checkout-build.py', 'recharge-checkout-contract.json', 'recharge-record-build.py',
    'registration-flow-v4-build.py', 'registration-flow-v4-contract.json', 'registration-flow-v4-release.py')


def publisher():
    spec = importlib.util.spec_from_file_location('pending_publisher', HERE / 'online-pending-features-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def inventory(commit, prefix):
    p = publisher()
    return {name.removeprefix(prefix + '/'): p.sha(git('show', commit + ':' + name))
            for name in git('ls-tree', '-r', '--name-only', commit, '--', prefix).decode().splitlines()}


def freeze_sources(baseline=None):
    p = publisher()
    c = json.loads(CONTRACT.read_bytes())
    # Business bytes were reviewed separately; this action cannot broaden or
    # silently refresh that frozen source set.
    for name, digest in c['sources'].items():
        p.need(p.sha((ROOT / name).read_bytes()) == digest, 'SOURCE_CHANGED')
    c['beforeEngineFiles'] = inventory(p.SOURCE_BASE, p.ENGINE)
    registry = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    c['afterEngineFiles'] = {row['path']: row['adaptedSha256'] for row in registry['files']}
    c['afterEngineFiles']['SOURCE_MANIFEST.json'] = p.sha((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    c['controlPins'] = {name: p.sha((HERE / name).read_bytes()) for name in sorted(p.CONTROLS)}
    c['workflowSha256'] = p.sha((ROOT / p.WORKFLOW).read_bytes())
    c['reconstruction']['pins'] = {name: p.sha((HERE / name).read_bytes()) for name in RECONSTRUCTION_PINS}
    if baseline is not None:
        c['baseline'] = json.loads(Path(baseline).read_bytes())
    p.validate_contract(c, require_baseline=False)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'LOCAL_SOURCES_FROZEN', 'sources': len(c['sources']), 'baselineBound': c['baseline'] is not None}))


def check(c, *, require_baseline=False):
    p = publisher()
    p.validate_contract(c, require_baseline=require_baseline)
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    for name, digest in c['sources'].items():
        path = ROOT / name
        p.need(not path.is_symlink() and path.is_file() and p.sha(path.read_bytes()) == digest
               == p.sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'SOURCE_CHANGED')
    p.need(set(git('diff', '--name-only', c['reviewBase'], c['sourceReviewCommit']).decode().splitlines()) == set(p.APPLICATION),
           'REVIEW_SCOPE_CHANGED')
    for name, digest in {**c['controlPins'], **c['reconstruction']['pins']}.items():
        path = HERE / name
        p.need(not path.is_symlink() and path.is_file() and p.sha(path.read_bytes()) == digest, 'CONTROL_SOURCE_CHANGED')
    p.need(inventory(p.SOURCE_BASE, p.ENGINE) == c['beforeEngineFiles'], 'PUBLISHED_ENGINE_SOURCE_CHANGED')
    registry = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    entries = {row['path']: row['adaptedSha256'] for row in registry['files']}
    p.need(len(entries) == len(registry['files']) and entries == {
        name: digest for name, digest in c['afterEngineFiles'].items() if name != 'SOURCE_MANIFEST.json'}
        and all(p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest for name, digest in entries.items()),
        'SOURCE_MANIFEST_CHANGED')
    return p


def quality_evidence(commit, tree):
    p = publisher()
    helper = p.load('registration-closure-dispatch.py')
    def parts(evidence):
        value = helper.github('repos/' + helper.REPOSITORY + '/actions/runs/' + evidence['runId']
            + '/attempts/' + str(evidence['runAttempt']) + '/jobs?per_page=100')
        p.need(value.get('total_count') == len(value.get('jobs', [])) <= 100, 'QUALITY_JOBS_PAGINATED')
        selected = {}
        for part in p.QUALITY_PARTS:
            rows = [row for row in value['jobs'] if row.get('name') == 'recharge (' + part + ')']
            if len(rows) != 1 or rows[0].get('status') != 'completed' or rows[0].get('conclusion') != 'success':
                return None
            selected[part] = rows[0]['id']
        return {'runId': evidence['runId'], 'runAttempt': evidence['runAttempt'], 'testedTree': tree,
                'parts': list(p.QUALITY_PARTS), 'jobs': selected}
    evidence = helper.quality_source_evidence(commit, tree)
    covered = parts(evidence)
    if covered is None and evidence['kind'] == 'EXACT_MAIN_SUCCESS':
        # A main run may reuse its authenticated PR tree without matrix jobs.
        # Ask the same accepted verifier for that exact PR proof, never treat
        # the successful main summary as four executed checks.
        original = helper.github
        prefix = 'repos/' + helper.REPOSITORY + '/actions/workflows/quality.yml/runs?head_sha=' + commit
        helper.github = lambda path: {'workflow_runs': []} if path.startswith(prefix) else original(path)
        evidence = helper.quality_source_evidence(commit, tree)
        covered = parts(evidence)
    p.need(covered is not None, 'QUALITY_PARTS_MISSING')
    p.validate_quality(evidence, commit, tree)
    return evidence, covered


def overlay(context, names, commit=None):
    p = publisher()
    for name, digest in names.items():
        raw = git('show', commit + ':' + name) if commit else (ROOT / name).read_bytes()
        p.need(p.sha(raw) == digest, 'OVERLAY_SOURCE_CHANGED')
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def reconstruct_admin(c):
    p = publisher()
    recipe = json.loads((HERE / 'recharge-checkout-contract.json').read_bytes())
    builder = p.load('recharge-checkout-build.py')
    builder.OUTPUT = OUT / 'published-admin-reconstruction'
    builder.OUTPUT.mkdir(mode=0o700)
    builder.prepare_published_admin(recipe)
    context = builder.OUTPUT / 'admin-baseline'
    overlay(context, {name: digest for name, digest in recipe['sources'].items()
        if name.startswith(('apps/admin/', 'packages/'))}, c['reconstruction']['adminPublishedCommit'])
    return context


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def declaration_bytes(raw, expected):
    p = publisher()
    variants = (raw,
        raw.replace(b'"needs_review" | "not_applicable"', b'"not_applicable" | "needs_review"'),
        raw.replace(b'"not_applicable" | "needs_review"', b'"needs_review" | "not_applicable"'))
    matches = [value for value in variants if p.sha(value) == expected]
    p.need(bool(matches), 'DECLARATION_ORDER_CONTENT_CHANGED')
    return matches[0]


def canonical_preloads(raw):
    p = publisher()
    text = raw.decode('utf-8')
    matches = list(re.finditer(r'm\.f=(\[[^\]]+\])', text))
    p.need(len(matches) == 1, 'PRELOAD_MAPPING_INVALID')
    match = matches[0]
    names = json.loads(match[1])
    p.need(type(names) is list and len(names) == len(set(names)) and bool(names)
           and all(type(name) is str and re.fullmatch(r'assets/[A-Za-z0-9_.-]+\.(?:js|css)', name)
                   for name in names), 'PRELOAD_MAPPING_INVALID')
    text = text[:match.start(1)] + json.dumps(sorted(names), separators=(',', ':')) + text[match.end(1):]
    def call(item):
        indexes = [int(value) for value in item[1].split(',')]
        p.need(len(indexes) == len(set(indexes)) and all(0 <= value < len(names) for value in indexes),
               'PRELOAD_INDEX_INVALID')
        resolved = [names[value] for value in indexes]
        # Only JS preload order is immaterial here. CSS order remains exact.
        value = {'js': sorted(name for name in resolved if name.endswith('.js')),
                 'css': [name for name in resolved if name.endswith('.css')]}
        return '__vite__mapDeps(' + json.dumps(value, separators=(',', ':')) + ')'
    return re.sub(r'__vite__mapDeps\(\[([0-9,]+)\]\)', call, text).encode()


def published_admin_assets():
    p = publisher()
    binding = p.ADMIN_ARTIFACT
    result = subprocess.run(['gh', 'api', 'repos/wangchaozhuanyong/id-business-system/actions/artifacts/'
        + str(binding['artifactId']) + '/zip'], cwd=ROOT, capture_output=True, timeout=90)
    raw = result.stdout
    p.need(result.returncode == 0 and 0 < len(raw) <= 8 * 1024**2
           and 'sha256:' + p.sha(raw) == binding['artifactDigest'], 'PREDECESSOR_ARTIFACT_CHANGED')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        item = archive.getinfo('recharge-checkout-artifact.tar.gz')
        p.need(0 < item.file_size <= 8 * 1024**2 and not item.flag_bits & 1, 'PREDECESSOR_ARCHIVE_CHANGED')
        bundle = archive.read(item)
    p.need(p.sha(bundle) == binding['artifactSha256'], 'PREDECESSOR_BUNDLE_CHANGED')
    values = {}
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:gz') as archive:
        proof = archive.getmember('payload/build-proof.json')
        p.need(proof.isfile() and 0 < proof.size <= 1024**2, 'PREDECESSOR_PROOF_INVALID')
        raw_proof = archive.extractfile(proof).read()
        p.need(p.sha(raw_proof) == binding['proofSha256'], 'PREDECESSOR_PROOF_CHANGED')
        expected = json.loads(raw_proof)['adminFiles']
        for name in p.ADMIN_PRELOAD_ORDER:
            item = archive.getmember('payload/admin/html/' + name)
            p.need(item.isfile() and 0 < item.size <= 2 * 1024**2, 'PREDECESSOR_ASSET_INVALID')
            value = archive.extractfile(item).read()
            p.need(p.sha(value) == expected[name]
                   and p.sha(canonical_preloads(value)) == p.ADMIN_PRELOAD_ORDER[name], 'PREDECESSOR_ASSET_CHANGED')
            values[name] = value
    return values


def restore_baseline(api, admin, c, *, admin_assets=None):
    p = publisher()
    file_inventory = p.load('recharge-record-release.py').file_inventory
    evidence = {'api': {}, 'admin': {}, 'adminArtifact': None, 'candidateDeclarations': {}}
    actual_api = {name.removeprefix('id-business-v2/online-recharge/'): digest
        for name, digest in file_inventory(api).items() if name.startswith('id-business-v2/online-recharge/')
        and not name.startswith('id-business-v2/online-recharge/engine/')}
    expected_api = c['baseline']['apiOnlineFiles']
    changed = {name for name in actual_api.keys() | expected_api.keys() if actual_api.get(name) != expected_api.get(name)}
    p.need(changed <= p.API_ORDER_ONLY, 'BASE_API_NOT_REPRODUCED')
    for name in sorted(changed):
        target = api / 'id-business-v2/online-recharge' / name
        value = declaration_bytes(target.read_bytes(), expected_api[name])
        evidence['api'][name] = {'rebuiltSha256': actual_api[name], 'publishedSha256': p.sha(value)}
        target.write_bytes(value)
    actual_admin = file_inventory(admin)
    expected_admin = c['baseline']['adminBuiltFiles']
    changed = {name for name in actual_admin.keys() | expected_admin.keys() if actual_admin.get(name) != expected_admin.get(name)}
    p.need(changed <= set(p.ADMIN_PRELOAD_ORDER), 'BASE_ADMIN_NOT_REPRODUCED')
    if changed:
        values = published_admin_assets() if admin_assets is None else admin_assets
        for name in sorted(changed):
            raw = (admin / name).read_bytes()
            p.need(p.sha(canonical_preloads(raw)) == p.ADMIN_PRELOAD_ORDER[name]
                   and p.sha(values[name]) == expected_admin[name]
                   and canonical_preloads(raw) == canonical_preloads(values[name]), 'PRELOAD_CONTENT_CHANGED')
            evidence['admin'][name] = {'rebuiltSha256': p.sha(raw), 'publishedSha256': p.sha(values[name])}
            (admin / name).write_bytes(values[name])
        evidence['adminArtifact'] = p.ADMIN_ARTIFACT
    return evidence


def normalize_candidate_declarations(api, c):
    p = publisher()
    result = {}
    for name in p.API_ORDER_ONLY:
        target = api / 'id-business-v2/online-recharge' / name
        raw = target.read_bytes()
        expected = c['apiDeclarationOnly']['id-business-v2/online-recharge/' + name]
        if p.sha(raw) != expected:
            value = declaration_bytes(raw, expected)
            result[name] = {'rebuiltSha256': p.sha(raw), 'publishedSha256': p.sha(value)}
            target.write_bytes(value)
    return result


def main():
    c = json.loads(CONTRACT.read_bytes())
    p = check(c, require_baseline=True)
    commit, tree = git('rev-parse', 'HEAD').decode().strip(), git('rev-parse', 'HEAD^{tree}').decode().strip()
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
           and os.environ.get('GITHUB_SHA') == commit and not OUT.exists()
           and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    changed = set(git('diff', '--name-only', p.SOURCE_BASE, 'HEAD').decode().splitlines())
    p.need(changed == set(p.APPLICATION) | set(p.SELECTION_CONTROLS), 'FINITE_SELECTION_CHANGED')
    quality, quality_parts = quality_evidence(commit, tree)
    OUT.mkdir(mode=0o700, parents=True)
    helper = p.load('recharge-record-release.py')
    actual_inventory = helper.file_inventory
    extract = p.load('recharge-record-build.py').extract_source
    admin_base = reconstruct_admin(c)
    api_base = OUT / 'api-baseline'
    extract(git('archive', c['reconstruction']['apiSourceCommit']), api_base)
    outputs = {}
    for role, baseline in (('api', api_base), ('admin', admin_base)):
        candidate = OUT / (role + '-candidate')
        shutil.copytree(baseline, candidate)
        overlay(candidate, {name: digest for name, digest in c['sources'].items()
            if name.startswith('apps/' + role + '/') and not name.startswith(p.ENGINE + '/')})
        for variant, context in (('baseline', baseline), ('candidate', candidate)):
            env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (
                c['reconstruction']['adminPublishedCommit'] if variant == 'baseline' else commit)}
            run('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context, env=env)
            run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context, env=env)
            if role == 'api':
                run('npm', 'run', 'prisma:mysql:generate', cwd=context, env=env)
            run('npm', 'run', 'build', '--workspace', '@apple-business/' + role, cwd=context, env=env)
            outputs[role + '-' + variant] = actual_inventory(context / ('apps/' + role + '/dist'))
    api_dist, admin_dist = api_base / 'apps/api/dist', admin_base / 'apps/admin/dist'
    reproduction = restore_baseline(api_dist, admin_dist, c)
    reproduction['candidateDeclarations'] = normalize_candidate_declarations(OUT / 'api-candidate/apps/api/dist', c)
    before_api = actual_inventory(api_dist)
    after_api = actual_inventory(OUT / 'api-candidate/apps/api/dist')
    outputs['admin-baseline'] = actual_inventory(admin_dist)
    before_online = {name.removeprefix('id-business-v2/online-recharge/'): digest for name, digest in before_api.items()
        if name.startswith('id-business-v2/online-recharge/') and not name.startswith('id-business-v2/online-recharge/engine/')}
    p.need(before_online == c['baseline']['apiOnlineFiles'], 'BASE_API_NOT_REPRODUCED')
    p.need(outputs['admin-baseline'] == c['baseline']['adminBuiltFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    modules = p.load('online-checkout-build.py').module_delta(before_api, after_api, c['apiModules'], c['apiDeclarationOnly'])
    payload = OUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / 'api-candidate/apps/api/dist' / name, target)
    shutil.copytree(OUT / 'admin-candidate/apps/admin/dist', payload / 'admin/html')
    for name in p.FILES:
        target = payload / 'engine' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / p.ENGINE / name, target)
    for name in c['sources']:
        target = payload / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    proof = {'version': 1, 'scope': p.SCOPE, 'commit': commit, 'tree': tree,
        'workflowRunId': os.environ['GITHUB_RUN_ID'], 'workflowRunAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'controlSources': c['controlPins'],
        'qualitySourceEvidence': quality, 'qualityPartEvidence': quality_parts,
        'baselineReproduction': reproduction,
        'workflow': p.WORKFLOW, 'workflowSha256': c['workflowSha256'],
        'sources': c['sources'], 'apiModules': modules, 'beforeApiOnlineFiles': before_online,
        'baselineAdminFiles': outputs['admin-baseline'], 'adminFiles': outputs['admin-candidate'],
        'afterEngineFiles': c['afterEngineFiles'], 'baselineApiReproduced': True,
        'baselineAdminSourceReproduced': True, 'updatedServices': list(p.UPDATED),
        'preservedServices': list(p.PRESERVED), 'migrationPerformed': False, 'businessActions': 0,
        'files': actual_inventory(payload)}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'online-pending-features-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_PENDING_FEATURES_NATIVE_BUILT', 'commit': commit,
                     'updatedServices': list(p.UPDATED), 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze-sources', action='store_true')
    parser.add_argument('--baseline')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze_sources:
        freeze_sources(args.baseline)
    elif args.check:
        check(json.loads(CONTRACT.read_bytes()))
        print(json.dumps({'status': 'LOCAL_SOURCE_CONTRACT_VERIFIED', 'businessActions': 0}))
    else:
        publisher().need(args.baseline is None, 'ARGUMENT_INVALID')
        main()
