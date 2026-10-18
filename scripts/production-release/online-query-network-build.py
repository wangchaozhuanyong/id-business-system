"""Reproduce the deployed b8 Admin and pending API, then add the reviewed delta."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / '.deploy/online-query-network'
CONTRACT = HERE / 'online-query-network-contract.json'


def load(name, *, directory=HERE):
    spec = importlib.util.spec_from_file_location('network_builder_' + name.replace('-', '_'), directory / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def publisher():
    return load('online-query-network-release.py')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def frozen_reconstruction(proof_raw):
    p = publisher()
    p.need(p.sha(proof_raw) == p.PREDECESSOR_PROOF, 'PREDECESSOR_PROOF_CHANGED')
    proof = json.loads(proof_raw)
    old = json.loads((HERE / 'online-session-preflight-contract.json').read_bytes())
    pending = json.loads((HERE / 'online-pending-features-contract.json').read_bytes())
    p.need(proof['commit'] == p.SOURCE_BASE and proof['sources'] == old['sources']
        and proof['baselineAdminFiles'] == old['reconstruction']['publishedAdminFiles']
        and proof['migrationPerformed'] is False and proof['businessActions'] == 0, 'PREDECESSOR_IDENTITY_CHANGED')
    return {'predecessorProofSha256': p.PREDECESSOR_PROOF, 'publishedAdminCommit': p.SOURCE_BASE,
        'apiSourceCommit': pending['reconstruction']['apiSourceCommit'], 'apiOverlayReview': pending['sourceReviewCommit'],
        'publishedAdminSources': {name: digest for name, digest in old['sources'].items() if name.startswith('apps/admin/')},
        'publishedAdminFiles': proof['adminFiles'],
        'historicalControlsTree': p.HISTORICAL_CONTROLS_TREE,
        'pins': {name: p.sha(git('show', p.SOURCE_BASE + ':scripts/production-release/' + name))
            for name in sorted(p.RECONSTRUCTION_FILES)}}


def freeze(baseline_path, proof_path):
    p = publisher()
    r = frozen_reconstruction(Path(proof_path).read_bytes())
    old = json.loads((HERE / 'online-session-preflight-contract.json').read_bytes())
    manifest = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    after = {row['path']: row['adaptedSha256'] for row in manifest['files']}
    p.need(len(after) == len(manifest['files']), 'DUPLICATE_ENGINE_SOURCE')
    after['SOURCE_MANIFEST.json'] = p.sha((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    review = git('rev-parse', 'HEAD').decode().strip()
    c = {'version': 1, 'scope': p.SCOPE, 'reviewBase': p.REVIEW_BASE, 'expectedCurrent': p.SOURCE_BASE,
        'sourceReviewCommit': review, 'sourceReviewTag': 'online-query-network-source-review-' + review[:12],
        'engineRoot': p.ENGINE, 'sources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.APPLICATION)},
        'reviewedControlSources': {name: p.sha((ROOT / name).read_bytes()) for name in sorted(p.SCOPE_CONTROLS)},
        'controlPins': {name: p.sha((HERE / name).read_bytes()) for name in sorted(p.CONTROLS)},
        'workflowSha256': p.sha((ROOT / p.WORKFLOW).read_bytes()), 'requiredQualityParts': list(p.QUALITY_PARTS),
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED), 'reconstruction': r,
        'beforeEngineFiles': old['baseline']['engineFiles'], 'afterEngineFiles': after,
        'apiModules': sorted(p.API_MODULES), 'apiDeclarationOnly': {},
        'baseline': json.loads(Path(baseline_path).read_bytes()), 'migrationPerformed': False, 'businessActions': 0}
    p.validate_contract(c)
    CONTRACT.write_text(json.dumps(c, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'ONLINE_QUERY_NETWORK_SOURCE_FROZEN', 'sources': len(c['sources']), 'businessActions': 0}))


def check(c):
    p = publisher()
    p.validate_contract(c)
    tag = 'refs/tags/' + c['sourceReviewTag']
    p.need(git('cat-file', '-t', tag).decode().strip() == 'tag'
        and git('rev-parse', tag + '^{commit}').decode().strip() == c['sourceReviewCommit'], 'REVIEW_TAG_CHANGED')
    p.need(set(git('diff', '--name-only', p.REVIEW_BASE, c['sourceReviewCommit']).decode().splitlines())
        == set(p.APPLICATION) | set(p.SCOPE_CONTROLS), 'REVIEW_SCOPE_CHANGED')
    p.need(p.sha((ROOT / p.WORKFLOW).read_bytes()) == c['workflowSha256'], 'WORKFLOW_CHANGED')
    for name, digest in {**c['sources'], **c['reviewedControlSources']}.items():
        path = ROOT / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == digest
            == p.sha(git('show', c['sourceReviewCommit'] + ':' + name)), 'REVIEWED_SOURCE_CHANGED')
    for name, digest in c['controlPins'].items():
        path = HERE / name
        p.need(path.is_file() and not path.is_symlink() and p.sha(path.read_bytes()) == digest, 'CONTROL_CHANGED')
    p.need(git('rev-parse', p.SOURCE_BASE + ':scripts/production-release').decode().strip()
        == c['reconstruction']['historicalControlsTree'], 'HISTORICAL_CONTROLS_CHANGED')
    for name, digest in c['reconstruction']['pins'].items():
        p.need(p.sha(git('show', p.SOURCE_BASE + ':scripts/production-release/' + name)) == digest,
            'RECONSTRUCTION_CONTROL_CHANGED')
    old = json.loads((HERE / 'online-session-preflight-contract.json').read_bytes())
    p.need(c['beforeEngineFiles'] == old['baseline']['engineFiles']
        and c['reconstruction']['publishedAdminSources'] == {name: digest for name, digest in old['sources'].items()
            if name.startswith('apps/admin/')}, 'PUBLISHED_SOURCE_CHANGED')
    manifest = json.loads((ROOT / p.ENGINE / 'SOURCE_MANIFEST.json').read_bytes())
    entries = {row['path']: row['adaptedSha256'] for row in manifest['files']}
    p.need(len(entries) == len(manifest['files']) and entries == {name: digest for name, digest in c['afterEngineFiles'].items()
        if name != 'SOURCE_MANIFEST.json'} and all(p.sha((ROOT / p.ENGINE / name).read_bytes()) == digest
            for name, digest in c['afterEngineFiles'].items()), 'SOURCE_MANIFEST_CHANGED')
    return p


def overlay(context, sources, commit=None):
    p = publisher()
    for name, digest in sources.items():
        raw = git('show', commit + ':' + name) if commit else (ROOT / name).read_bytes()
        p.need(p.sha(raw) == digest, 'OVERLAY_SOURCE_CHANGED')
        target = context / name
        p.need(target.resolve().is_relative_to(context.resolve()) and not target.is_symlink(), 'OVERLAY_PATH_CHANGED')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)


def reconstruct(c):
    p = publisher()
    # main retired registration tooling. Its historical build recipes stay in
    # ignored build output and never enter the new release payload.
    history = OUT / 'historical-controls'
    load('recharge-record-build.py').extract_source(git('archive', p.SOURCE_BASE,
        'scripts/production-release'), history)
    historical = history / 'scripts/production-release'
    for name, digest in c['reconstruction']['pins'].items():
        p.need(p.sha((historical / name).read_bytes()) == digest, 'HISTORICAL_CONTROL_CHANGED')
    previous = load('online-session-preflight-build.py', directory=historical)
    previous.OUT = OUT / 'admin-reconstruction'
    old = json.loads((HERE / 'online-session-preflight-contract.json').read_bytes())
    # Historical loaders derive ROOT from their staged path. An explicit Git
    # directory keeps nested git archive pathspecs rooted in the real repo.
    git_directory = git('rev-parse', '--absolute-git-dir').decode().strip()
    prior_git_directory = os.environ.get('GIT_DIR')
    os.environ['GIT_DIR'] = git_directory
    try:
        admin = previous.reconstruct(old)
    finally:
        if prior_git_directory is None:
            os.environ.pop('GIT_DIR', None)
        else:
            os.environ['GIT_DIR'] = prior_git_directory
    overlay(admin, c['reconstruction']['publishedAdminSources'], old['sourceReviewCommit'])
    pending = json.loads((HERE / 'online-pending-features-contract.json').read_bytes())
    api = OUT / 'api-baseline'
    load('recharge-record-build.py').extract_source(git('archive', c['reconstruction']['apiSourceCommit']), api)
    overlay(api, {name: digest for name, digest in pending['sources'].items()
        if name.startswith('apps/api/') and not name.startswith(publisher().ENGINE + '/')},
        c['reconstruction']['apiOverlayReview'])
    return api, admin


def quality_evidence(commit, tree):
    p = publisher()
    c = json.loads(CONTRACT.read_bytes())
    def historical_quality(name):
        p.need(name in ('online-session-preflight-build.py', 'registration-closure-dispatch.py'), 'QUALITY_HELPER_SCOPE_CHANGED')
        raw = git('show', p.SOURCE_BASE + ':scripts/production-release/' + name)
        p.need(p.sha(raw) == c['reconstruction']['pins'][name], 'QUALITY_HELPER_CHANGED')
        helper = types.ModuleType('immutable_predecessor_quality_' + name.replace('-', '_'))
        helper.__file__ = str(HERE / name)
        exec(compile(raw, helper.__file__, 'exec'), helper.__dict__)
        return helper
    previous = historical_quality('online-session-preflight-build.py')
    previous.publisher = publisher
    previous.load = historical_quality
    return previous.quality_evidence(commit, tree)


def run(*args, cwd, env):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def normalize_declarations(dist, expected, *, candidate=False):
    p = publisher()
    previous = load('online-pending-features-build.py')
    skip = {name.removesuffix('.js') + '.d.ts' for name in p.API_MODULES} if candidate else set()
    for name in previous.publisher().API_ORDER_ONLY:
        path = 'id-business-v2/online-recharge/' + name
        if path not in skip:
            target = dist / path
            target.write_bytes(previous.declaration_bytes(target.read_bytes(), expected[name]))


def main():
    c = json.loads(CONTRACT.read_bytes())
    p = check(c)
    commit, tree = git('rev-parse', 'HEAD').decode().strip(), git('rev-parse', 'HEAD^{tree}').decode().strip()
    p.need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF') == 'refs/heads/main'
        and os.environ.get('GITHUB_SHA') == commit and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
        and os.environ.get('GITHUB_REPOSITORY') == 'wangchaozhuanyong/id-business-system' and not OUT.exists()
        and not git('status', '--porcelain', '--untracked-files=no').strip(), 'NATIVE_BUILD_REQUIRED')
    p.need(set(git('diff', '--name-only', p.REVIEW_BASE, 'HEAD').decode().splitlines())
        == set(p.APPLICATION) | set(p.PUBLIC_CONTROLS), 'FINITE_SELECTION_CHANGED')
    quality, parts = quality_evidence(commit, tree)
    OUT.mkdir(mode=0o700, parents=True)
    inventory = load('recharge-record-release.py').file_inventory
    api, admin = reconstruct(c)
    outputs = {}
    for role, baseline in (('api', api), ('admin', admin)):
        candidate = OUT / (role + '-candidate')
        shutil.copytree(baseline, candidate)
        overlay(candidate, {name: digest for name, digest in c['sources'].items()
            if name.startswith('apps/' + role + '/') and not name.startswith(p.ENGINE + '/')})
        for variant, context in (('baseline', baseline), ('candidate', candidate)):
            env = {**os.environ, 'NODE_ENV': 'production', 'V2_BUILD_ID': 'v2-' + (p.SOURCE_BASE if variant == 'baseline' else commit)}
            run('npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=context, env=env)
            run('npm', 'run', 'build', '--workspace', '@apple-business/shared', cwd=context, env=env)
            if role == 'api':
                run('npm', 'run', 'prisma:mysql:generate', cwd=context, env=env)
            run('npm', 'run', 'build', '--workspace', '@apple-business/' + role, cwd=context, env=env)
            outputs[role + '-' + variant] = inventory(context / ('apps/' + role + '/dist'))
    before_dist, after_dist = api / 'apps/api/dist', OUT / 'api-candidate/apps/api/dist'
    normalize_declarations(before_dist, c['baseline']['apiOnlineFiles'])
    normalize_declarations(after_dist, c['baseline']['apiOnlineFiles'], candidate=True)
    before_api, after_api = inventory(before_dist), inventory(after_dist)
    before_online = {name.removeprefix('id-business-v2/online-recharge/'): digest for name, digest in before_api.items()
        if name.startswith('id-business-v2/online-recharge/') and '/engine/' not in name}
    p.need(before_online == c['baseline']['apiOnlineFiles'], 'BASE_API_NOT_REPRODUCED')
    p.need(outputs['admin-baseline'] == c['reconstruction']['publishedAdminFiles'], 'BASE_ADMIN_NOT_REPRODUCED')
    modules = load('online-checkout-build.py').module_delta(before_api, after_api, c['apiModules'])
    payload = OUT / 'payload'
    for name in modules:
        target = payload / 'api/modules' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(after_dist / name, target)
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
        'contractSha256': p.sha(CONTRACT.read_bytes()), 'controlSources': c['controlPins'], 'sources': c['sources'],
        'workflow': p.WORKFLOW, 'workflowSha256': c['workflowSha256'], 'qualitySourceEvidence': quality,
        'qualityPartEvidence': parts, 'apiModules': modules, 'beforeApiOnlineFiles': before_online,
        'baselineAdminFiles': outputs['admin-baseline'], 'adminFiles': outputs['admin-candidate'],
        'afterEngineFiles': c['afterEngineFiles'], 'baselineApiReproduced': True, 'baselineAdminSourceReproduced': True,
        'updatedServices': list(p.UPDATED), 'preservedServices': list(p.PRESERVED),
        'migrationPerformed': False, 'businessActions': 0, 'files': inventory(payload)}
    p.verify_proof(proof, proof, c, proof['files'])
    (payload / 'build-proof.json').write_text(json.dumps(proof, sort_keys=True, indent=2) + '\n')
    bundle = OUT / 'online-query-network-artifact.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        archive.add(payload, arcname='payload')
    (OUT / 'artifact-sha256.txt').write_text(p.sha(bundle.read_bytes()) + '\n')
    print(json.dumps({'status': 'ONLINE_QUERY_NETWORK_NATIVE_BUILT', 'commit': commit,
        'updatedServices': list(p.UPDATED), 'businessActions': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze', action='store_true')
    parser.add_argument('--baseline')
    parser.add_argument('--predecessor-proof')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.freeze:
        publisher().need(args.baseline and args.predecessor_proof and not args.check, 'FREEZE_ARGUMENTS_INVALID')
        freeze(args.baseline, args.predecessor_proof)
    elif args.check:
        check(json.loads(CONTRACT.read_bytes()))
        print(json.dumps({'status': 'ONLINE_QUERY_NETWORK_SOURCE_VERIFIED', 'businessActions': 0}))
    else:
        publisher().need(args.baseline is None and args.predecessor_proof is None, 'ARGUMENTS_INVALID')
        main()
