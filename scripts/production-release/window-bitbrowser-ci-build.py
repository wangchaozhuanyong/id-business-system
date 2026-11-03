"""Finite current-system CI adapter. Never supplies production or release authority."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SCOPE = 'BUSINESS_DISPLAY_BITBROWSER_20261103'
PRIOR = 'ead2ece6b341c7f3280a30a87705f8abca456056'
RUN = 41632130270
REPO = 'wangchaozhuanyong/id-business-system'
SELF = 'scripts/production-release/window-bitbrowser-ci-build.py'
TEST = SELF.removesuffix('.py') + '.test.py'
CONTRACT = 'scripts/production-release/window-bitbrowser-contract.json'
WORKFLOW = '.github/workflows/quality.yml'
GUARD_TEST = 'scripts/ci-recharge-release.test.mjs'
CHECK_TEST = 'scripts/ci-recharge-check.test.mjs'
FIXTURE = 'apps/api/src/id-business-v2/auto-recharge/recharge-manual-settlement.mysql.integration.spec.ts'
DISPLAY_TESTS = {
    'apps/api/src/id-business-v2/topup-supplier-funds/id-business-v2-topup-supplier-funds.contract.spec.ts':
        ("toEqual(['apple.gift_card.view_full']);", "toEqual(['apple.balance.view']);"),
    'apps/api/src/id-business-v2/workspace/id-business-v2-website-visit.service.spec.ts':
        ("items: [{ ipMasked: '203.0.*.*' }]", "items: [{ ipMasked: '203.0.113.19' }]"),
    'apps/admin/src/v2/components/workspace/workspace-ui.contract.spec.ts':
        ("expect(websiteVisitsPanel).toContain('<V2TableActionColumn');\n    expect(websiteVisitsPanel).toContain('30 秒后隐藏');",
         "expect(websiteVisitsPanel).not.toContain('<V2TableActionColumn');\n    expect(websiteVisitsPanel).toContain('{{ row.ipMasked }}');\n    expect(websiteVisitsPanel).not.toContain('30 秒后隐藏');")
}
ACCEPTANCE = 'scripts/acceptance-v2-online-recharge-ui.mjs'
ACCEPTANCE_REPAIRS = {
    "configInput('最大并发激活数')": "configInput('服务器最大并发数')",
    "if (section === 'config' && req.method() === 'GET') return ok(settings);":
        "if (section === 'bitbrowser' && action === 'devices' && req.method() === 'GET')\n      return ok({ items: [] });\n    if (section === 'config' && req.method() === 'GET') return ok(settings);",
    "{ name: '复制卡号', exact: true }": "{ name: '查看卡号', exact: true }",
    "{ name: '复制兑换码', exact: true }": "{ name: '查看／复制', exact: true }",
    "assert.equal(await page.getByRole('button', { name: '查看卡号', exact: true }).count(), 0);":
        "assert.ok(await page.getByRole('button', { name: '查看卡号', exact: true }).count());",
    "case: 'reader-details-without-manage-or-sensitive-actions'":
        "case: 'reader-direct-view-without-management-actions'"
}
DOC = 'docs/WINDOW_BITBROWSER_RELEASE_20261103.md'
ALLOWED_REPAIR = {SELF, TEST, CONTRACT, WORKFLOW, GUARD_TEST, CHECK_TEST, FIXTURE, DOC, ACCEPTANCE, *DISPLAY_TESTS}
CONTROL_RECEIPT = ROOT / '.deploy/window-bitbrowser-ci-controls.json'
STEP = {'release-controls': 'Verify affected release entry and maintenance controls',
        'guards': 'Verify changed release controls'}
VERIFIED_HEAD = '4e47350ebcd3868a989d9f4e6c3b511f148ade12'
VERIFIED_RUN = 41655442082
VERIFIED_STEPS = ('Verify V2 table action layouts', 'Verify V2 button color contrast',
    'Verify ordinary-order archive and restore layouts', 'Verify single-account recharge confirmation flow',
    'Typecheck', 'Install frozen ONLINE browser test dependencies', 'Test')
OLD_BUILD = 'python3 -B scripts/production-release/online-recharge-ci-build.py'
NEW_BUILD = 'python3 -B ' + SELF


def need(value, code):
    if not value:
        raise RuntimeError('WINDOW_CI_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def contract_admitted(c, paths, read):
    try:
        return (c['scope'] == SCOPE and c['reviewBase'] == '1cd5045d811b8ce3d5f87dd9fc1182a0f787d1ea'
            and set(paths) <= set(c['candidateFiles']) and SELF in c['candidateFiles']
            and c['businessActions'] == 0
            and all(sha(read(n)) == digest for n, digest in {**c['sources'], **c['validationSources']}.items())
            and sha(read('package-lock.json')) == c['packageLockSha256'])
    except (KeyError, ValueError, OSError):
        return False


def admitted():
    if not (ROOT / CONTRACT).is_file():
        return False
    c = json.loads((ROOT / CONTRACT).read_bytes())
    paths = git('diff', '--name-only', c['reviewBase'], 'HEAD').decode().splitlines()
    read = lambda n: git('show', 'HEAD:' + n)
    return contract_admitted(c, paths, read) and contract_admitted(c, paths, lambda n: (ROOT / n).read_bytes())


def expected_workflow(old):
    changes = {OLD_BUILD: NEW_BUILD,
        'node scripts/ci-recharge-check.mjs release-controls "$CHECK_BASE"': NEW_BUILD + ' --controls release-controls --base "$CHECK_BASE"',
        'node scripts/ci-recharge-check.mjs guards "$CHECK_BASE"': NEW_BUILD + ' --controls guards --base "$CHECK_BASE"'}
    for before, after in changes.items():
        need(old.count(before) == (2 if before == OLD_BUILD else 1), 'WORKFLOW_RECIPE_CHANGED')
        old = old.replace(before, after)
    for name, setting in [('Verify affected release entry and maintenance controls', 'id: window_ci_controls'),
            ('Verify changed browser worker', "if: steps.window_ci_controls.outputs.reuse_worker != 'true'"),
            ('Verify frozen online recharge engine', "if: steps.window_ci_controls.outputs.reuse_engine != 'true'")]:
        before = '      - name: ' + name + '\n'
        need(old.count(before) == 1, 'WORKFLOW_RECIPE_CHANGED')
        old = old.replace(before, before + '        ' + setting + '\n')
    for name in STEP.values():
        before = '      - name: ' + name + '\n'
        if name == STEP['release-controls']:
            before += '        id: window_ci_controls\n'
        before += '        env:\n'
        need(old.count(before) == 1, 'WORKFLOW_RECIPE_CHANGED')
        old = old.replace(before, before + '          GH_TOKEN: ${{ github.token }}\n')
    for name in VERIFIED_STEPS:
        before = '      - name: ' + name + '\n'
        need(old.count(before) == 1, 'WORKFLOW_RECIPE_CHANGED')
        old = old.replace(before, before + "        if: steps.window_ci_controls.outputs.reuse_verified_full != 'true'\n")
    return old


def reuse_inputs():
    paths = set(git('diff', '--name-only', PRIOR, 'HEAD').decode().splitlines())
    need(paths <= ALLOWED_REPAIR, 'CONTROL_INPUT_CHANGED')
    need((ROOT / WORKFLOW).read_text() == expected_workflow(git('show', PRIOR + ':' + WORKFLOW).decode()), 'WORKFLOW_CHANGED')
    for name, before, after in [(GUARD_TEST, OLD_BUILD, NEW_BUILD), (CHECK_TEST, 'run: ' + OLD_BUILD, 'run: ' + NEW_BUILD)]:
        old = git('show', PRIOR + ':' + name).decode()
        need(old.count(before) == 1 and (ROOT / name).read_text() == old.replace(before, after), 'GUARD_CHANGED')
    old = git('show', PRIOR + ':' + FIXTURE).decode()
    before, after = "evidenceRef: 'BANK-' + id,", "evidenceRef: 'BANK-' + id.replace(/(.{4})/g, '$1_'),"
    need(old.count(before) == 1 and (ROOT / FIXTURE).read_text() == old.replace(before, after), 'FIXTURE_CHANGED')
    for name, (before, after) in DISPLAY_TESTS.items():
        old = git('show', PRIOR + ':' + name).decode()
        need(old.count(before) == 1 and (ROOT / name).read_text() == old.replace(before, after), 'DISPLAY_ASSERTION_CHANGED')
    old = git('show', PRIOR + ':' + ACCEPTANCE).decode()
    for before, after in ACCEPTANCE_REPAIRS.items():
        need(before in old, 'ACCEPTANCE_RECIPE_CHANGED')
        old = old.replace(before, after)
    need((ROOT / ACCEPTANCE).read_text() == old, 'ACCEPTANCE_CHANGED')
    # Application/dependency/helper bytes remain tested; only the declared CI assertions and synthetic ID change.
    return sorted(paths)


def github(path):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/' + REPO + '/' + path], cwd=ROOT))


def verify_prior(run, jobs, part):
    need(run['id'] == RUN and run['head_sha'] == PRIOR and run['path'] == '.github/workflows/quality.yml'
         and run['event'] == 'pull_request' and run['conclusion'] == 'failure'
         and run['repository']['full_name'] == REPO, 'PRIOR_IDENTITY')
    rows = [j for j in jobs['jobs'] if j['name'] == 'full-quality']
    need(len(rows) == 1, 'PRIOR_JOB')
    steps = rows[0]['steps']
    need([s['name'] for s in steps if s['conclusion'] == 'failure']
         == ['Build and verify sealed ONLINE images without production access'], 'PRIOR_FAILURE_CHANGED')
    need(any(s['name'] == STEP[part] and s['conclusion'] == 'success' for s in steps), 'PRIOR_CHECK_NOT_PASSED')
    need(all(any(s['name'] == name and s['conclusion'] == 'success' for s in steps)
        for name in ('Verify changed browser worker', 'Verify frozen online recharge engine')), 'PRIOR_ENGINE_NOT_PASSED')


def verify_completed_inputs(run, jobs):
    paths = set(git('diff', '--name-only', VERIFIED_HEAD, 'HEAD').decode().splitlines())
    need(paths <= {SELF, TEST, CONTRACT, WORKFLOW, ACCEPTANCE, DOC}, 'COMPLETED_INPUT_CHANGED')
    need(run['id'] == VERIFIED_RUN and run['head_sha'] == VERIFIED_HEAD
         and run['path'] == '.github/workflows/quality.yml' and run['event'] == 'pull_request'
         and run['conclusion'] == 'failure' and run['repository']['full_name'] == REPO, 'COMPLETED_RUN_IDENTITY')
    rows = [j for j in jobs['jobs'] if j['name'] == 'full-quality']
    need(len(rows) == 1, 'COMPLETED_JOB')
    steps = rows[0]['steps']
    need([s['name'] for s in steps if s['conclusion'] == 'failure']
         == ['Verify online recharge pages'], 'COMPLETED_FAILURE_CHANGED')
    need(all(any(s['name'] == name and s['conclusion'] == 'success' for s in steps)
         for name in VERIFIED_STEPS), 'COMPLETED_STEP_NOT_PASSED')
    return sorted(paths)


def run(args, **kwargs):
    subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def controls(part, base):
    need(re.fullmatch('[a-f0-9]{40}', base or ''), 'BASE')
    changed = reuse_inputs()
    prior, jobs = github('actions/runs/' + str(RUN)), github('actions/runs/' + str(RUN) + '/jobs')
    verify_prior(prior, jobs, part)
    completed, completed_jobs = github('actions/runs/' + str(VERIFIED_RUN)), github('actions/runs/' + str(VERIFIED_RUN) + '/jobs')
    completed_changes = verify_completed_inputs(completed, completed_jobs)
    tree = git('rev-parse', 'HEAD^{tree}').decode().strip()
    record = {'tree': tree, 'priorRun': RUN, 'priorHead': PRIOR, 'changedControls': changed,
        'scope': 'CI_ONLY', 'releaseAuthority': False, 'businessActions': 0,
        'completedRun': VERIFIED_RUN, 'completedHead': VERIFIED_HEAD, 'completedChanges': completed_changes,
        'reusedSteps': list(VERIFIED_STEPS)}
    if CONTROL_RECEIPT.exists():
        need(json.loads(CONTROL_RECEIPT.read_bytes()) == record, 'CONTROL_RECEIPT_CHANGED')
    else:
        run(['node', '--test', '--test-name-pattern=Quality guards and full checks include scoped', GUARD_TEST])
        run(['node', '--test', '--test-name-pattern=readonly metadata shortcut leaves the separate four-image', CHECK_TEST])
        run(['node', '--test', 'scripts/check-v2-online-recharge-controls.test.mjs'])
        run(['python3', '-B', TEST])
        run(['python3', '-B', str(HERE / 'window-bitbrowser-release.test.py')])
        CONTROL_RECEIPT.parent.mkdir(parents=True, exist_ok=True)
        CONTROL_RECEIPT.write_text(json.dumps(record, sort_keys=True, indent=2) + '\n')
    if part == 'release-controls' and os.environ.get('GITHUB_OUTPUT'):
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write('reuse_worker=true\nreuse_engine=true\nreuse_verified_full=true\n')
    print(json.dumps({**record, 'reusedStep': STEP[part], 'status': 'IDENTICAL_CONTROL_INPUTS_REVERIFIED'}))


def build():
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and sys.platform == 'linux'
         and os.environ.get('GITHUB_REPOSITORY') == REPO
         and os.environ.get('GITHUB_EVENT_NAME') in ('pull_request', 'push')
         and not any(os.environ.get(k) for k in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'DATABASE_URL')), 'ISOLATED_RUNNER_REQUIRED')
    commit, tree = (git('rev-parse', n).decode().strip() for n in ('HEAD', 'HEAD^{tree}'))
    directory = ROOT / '.deploy/ci-online-recharge' / ('window-' + tree)
    need(not directory.exists(), 'OUTPUT_EXISTS')
    context = directory / 'context'
    context.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(git('archive', 'HEAD'))) as archive:
        need(all((m.isfile() or m.isdir()) and not m.name.startswith('/') and '..' not in Path(m.name).parts for m in archive), 'SOURCE_ARCHIVE')
        archive.extractall(context, filter='data')
    c = json.loads((ROOT / CONTRACT).read_bytes())
    checks = {
        'api': ('apps/api/Dockerfile.mysql', 'runtime', '.', ['node', '-e', "const p=require('/app/apps/api/dist/id-business-v2/online-recharge/bitbrowser-policy.js');if(typeof p.validateBitbrowserQuote!=='function')process.exit(1)"]),
        'admin': ('apps/admin/Dockerfile', 'runtime', '.', ['sh', '-c', 'grep -q "v2-' + commit + '" /usr/share/nginx/html/index.html']),
        'migrate': ('apps/api/Dockerfile.mysql', 'migration', '.', ['node', '-e', "const f=require('fs'),c=require('crypto');if(c.createHash('sha256').update(f.readFileSync('/app/" + c['migration']['path'] + "')).digest('hex')!=='" + c['migration']['sha256'] + "')process.exit(1)"]),
        'online-recharge': ('apps/api/src/id-business-v2/online-recharge/engine/Dockerfile', None, 'apps/api/src/id-business-v2/online-recharge/engine', ['node', '-e', "const f=require('fs'),c=require('crypto');if(c.createHash('sha256').update(f.readFileSync('/workspace/engine/credentials.cjs')).digest('hex')!=='" + c['sources']['apps/api/src/id-business-v2/online-recharge/engine/credentials.cjs'] + "')process.exit(1)"])
    }
    images = {}
    for role, (dockerfile, target, source, check) in checks.items():
        ref = 'id-window-ci:' + tree + '-' + role
        args = ['docker', 'build', '--platform', 'linux/amd64', '--label', 'org.opencontainers.image.revision=' + commit,
            '--label', 'id-business-v2.ci-only=NOT_FOR_RELEASE', '-f', str(context / dockerfile), '-t', ref]
        if target:
            args += ['--target', target]
        if role == 'admin':
            args += ['--build-arg', 'V2_BUILD_ID=v2-' + commit]
        args.append(str(context / source))
        run(args)
        identity = json.loads(subprocess.check_output(['docker', 'image', 'inspect', ref], cwd=ROOT))[0]
        need(identity['Os'] == 'linux' and identity['Architecture'] == 'amd64'
             and identity['Config']['Labels']['org.opencontainers.image.revision'] == commit, 'IMAGE_IDENTITY')
        run(['docker', 'run', '--pull=never', '--rm', '--network', 'none', '--read-only', '--no-healthcheck', '--entrypoint', check[0], ref, *check[1:]])
        images[role] = {'imageId': identity['Id'], 'reference': ref, 'contentCheck': True}
    result = {'kind': 'ONLINE_RECHARGE_CI_BUILD_ONLY', 'candidateCommit': commit, 'candidateTree': tree,
        'scope': 'CI_ONLY', 'notForRelease': True, 'releaseAuthority': False, 'productionAccess': False,
        'registryPushPerformed': False, 'databaseAccessPerformed': False, 'businessActions': 0, 'images': images,
        'controlReuse': json.loads(CONTROL_RECEIPT.read_bytes())}
    (directory / 'ci-build-only.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'WINDOW_FOUR_IMAGES_VERIFIED', 'candidateCommit': commit, 'releaseAuthority': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controls', choices=['release-controls', 'guards'])
    parser.add_argument('--base')
    parser.add_argument('--source-only', action='store_true')
    args = parser.parse_args()
    selected = admitted()
    if args.source_only:
        need(selected, 'SOURCE_NOT_ADMITTED')
        print('WINDOW_CI_SOURCE_VERIFIED_NO_BUILD_OR_PRODUCTION_ACCESS')
    elif args.controls and selected:
        controls(args.controls, args.base)
    elif args.controls:
        run(['node', 'scripts/ci-recharge-check.mjs', args.controls, args.base])
    elif selected:
        build()
    else:
        run(['python3', '-B', str(HERE / 'online-recharge-ci-build.py')])


if __name__ == '__main__':
    main()
