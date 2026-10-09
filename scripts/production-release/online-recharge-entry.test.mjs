import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scripts = join(root, 'scripts/production-release');
const workflow = loadYaml(
  readFileSync(join(root, '.github/workflows/production-release.yml'), 'utf8')
);
const steps = workflow.jobs.release.steps;
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const predecessor = '554eaff77d67cce4b760d24a5c358ccabf2b3a4c';

function predicate(expression, inputs, failed = false) {
  if (!expression) return true;
  return new Function('inputs', 'failure', 'always', 'startsWith', `return (${expression});`)(
    inputs,
    () => failed,
    () => true,
    (value, prefix) => String(value ?? '').startsWith(prefix)
  );
}

function fixture(run) {
  const runtime = join(root, '.runtime/online-recharge/release-entry-tests');
  mkdirSync(runtime, { recursive: true });
  const folder = mkdtempSync(join(runtime, 'case-'));
  const bin = join(folder, 'bin');
  mkdirSync(bin);
  const log = join(folder, 'calls.log');
  writeFileSync(log, '');
  const stub = (name, source) => writeFileSync(join(bin, name), source, { mode: 0o755 });
  stub(
    'docker',
    '#!/bin/sh\nprintf "docker %s\\n" "$*" >> "$TEST_ENTRY_LOG"\nif [ "$1" = login ]; then cat >/dev/null; fi\nif [ "$1" = image ]; then printf "%s\\n" "$RELEASE_COMMIT"; fi\n'
  );
  stub('python3', '#!/bin/sh\nprintf "python %s\\n" "$*" >> "$TEST_ENTRY_LOG"\n');
  stub(
    'aws',
    '#!/bin/sh\nprintf "aws %s\\n" "$*" >> "$TEST_ENTRY_LOG"\ncase "$*" in *get-login-password*) printf "SYNTHETIC_TEST_KEY\\n" ;; *describe-images*) printf "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" ;; *) exit 99 ;; esac\n'
  );
  stub('git', '#!/bin/sh\nexit 99\n');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TEST_ENTRY_LOG: log,
    RELEASE_OPERATION: 'release_online_recharge',
    RELEASE_COMMIT: commit,
    SOURCE_TREE: tree,
    EXPECTED_CURRENT: predecessor,
    RELEASE_REPOSITORY: '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    QUALITY_RUN_ID: '234',
    GITHUB_ENV: join(folder, 'github.env'),
    RELEASE_ADMIN_ONLY: 'false',
    AWS_REGION: 'ap-northeast-1',
    HISTORICAL_EXCEPTION: 'none',
    REUSE_IMAGE_RUN: '',
    REUSE_IMAGE_COMMIT: '',
    REUSE_IMAGE_RUN_ID: '',
    REUSE_IMAGE_RUN_ATTEMPT: '',
    POST_CLEANUP_SEAL_SHA256: '',
    ORDER_ARCHIVE_SEAL_SHA256: '',
    ORDER_ARCHIVE_PREPARED_IMAGES_SHA256: '',
    RELEASE_BROWSER_CACHE_IMAGE: '',
    RELEASE_BROWSER_CACHE_IMAGE_ID: ''
  };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  try {
    run({ env, folder, log });
  } finally {
    rmSync(folder, { recursive: true });
  }
}

test('online scope keeps exact-source/Quality/OIDC checks and preflight before any build or deploy', () => {
  assert.equal(
    workflow.concurrency.cancel_in_progress ?? workflow.concurrency['cancel-in-progress'],
    false
  );
  assert.equal(workflow.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.release.if, "github.ref == 'refs/heads/main'");
  const index = (name) => steps.findIndex((step) => step.name === name);
  const source = index('Verify exact source and passing Quality Gate');
  const oidc = index('Obtain short-lived AWS credentials through OIDC');
  const preflight = index('Verify online recharge predecessor and idle workers before building');
  const build = index('Build images on the GitHub runner');
  const push = index('Push immutable images');
  const deploy = index('Deploy through the production instance');
  const readback = index('Independently read back online recharge runtime and preserved services');
  assert.ok(source >= 0 && source < oidc && oidc < preflight && preflight < build);
  assert.ok(build < push && push < deploy && deploy < readback);
  assert.equal(
    steps[preflight].run,
    'python3 -B scripts/production-release/online-recharge-readonly.py preflight'
  );
  assert.ok(
    workflow.on.workflow_dispatch.inputs.operation.options.includes('verify_online_recharge')
  );
  assert.ok(
    workflow.on.workflow_dispatch.inputs.operation.options.includes('release_online_recharge')
  );
});

test('verification cannot build/push/deploy; diagnosis runs only after failure and cannot make publication eligible', () => {
  const names = [
    'Build images on the GitHub runner',
    'Push immutable images',
    'Deploy through the production instance'
  ];
  for (const operation of ['verify_online_recharge', 'release_online_recharge']) {
    const inputs = { operation, historical_exception: 'none', reuse_image_run: '' };
    for (const name of names) {
      const step = steps.find((row) => row.name === name);
      assert.equal(predicate(step.if, inputs), operation === 'release_online_recharge', name);
    }
    const diagnosis = steps.find(
      (row) => row.name === 'Diagnose an online recharge predecessor failure without writes'
    );
    assert.equal(predicate(diagnosis.if, inputs), false);
    assert.equal(predicate(diagnosis.if, inputs, true), true);
    assert.equal(
      diagnosis.run,
      'python3 -B scripts/production-release/online-recharge-readonly.py diagnostic'
    );
    assert.ok(
      !steps
        .find((row) => row.name === 'Deploy through the production instance')
        .if.includes('always()')
    );
    assert.ok(
      !steps
        .find((row) => row.name === 'Build images on the GitHub runner')
        .if.includes('failure()')
    );
  }
});

test('real bash build and push select four sealed images and exclude all legacy workers/media/Caddy', () => {
  fixture(({ env, log }) => {
    execFileSync('bash', [join(scripts, 'build-images.sh')], { cwd: root, env, stdio: 'pipe' });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const builds = calls.filter((line) => line.startsWith('docker build '));
    assert.equal(builds.length, 4);
    for (const [index, service] of ['api', 'admin', 'migrate', 'online-recharge'].entries()) {
      assert.ok(builds[index].includes(`${commit}-123-1-${service}`));
      assert.ok(builds[index].includes('--platform linux/amd64'));
      assert.ok(builds[index].includes(`id-business-v2.source-tree=${tree}`));
    }
    assert.ok(builds[3].endsWith('apps/api/src/id-business-v2/online-recharge/engine'));
    assert.ok(
      calls.some((line) => line.endsWith('remote-deploy.py --write-online-recharge-build-proof'))
    );
    assert.equal(
      calls.some((line) => /auto-registration|auto-recharge|media-resolver|caddy/.test(line)),
      false
    );
    writeFileSync(log, '');
    execFileSync('bash', [join(scripts, 'push-images.sh')], { cwd: root, env, stdio: 'pipe' });
    const pushCalls = readFileSync(log, 'utf8').trim().split('\n');
    const pushes = pushCalls.filter((line) => line.startsWith('docker push '));
    assert.equal(pushes.length, 4);
    assert.deepEqual(
      pushes.map((line) => line.split('-123-1-')[1]),
      ['api', 'admin', 'migrate', 'online-recharge']
    );
    assert.equal(
      pushCalls.some((line) =>
        /auto-registration|auto-recharge|media-resolver|caddy|SYNTHETIC_TEST_KEY/.test(line)
      ),
      false
    );
  });
});

test('real bash rejects scope conflicts before Docker/AWS/Python and refuses verify-mode build/push', () => {
  fixture(({ env, log }) => {
    const cases = [
      { HISTORICAL_EXCEPTION: 'registration-worker-96-20261008' },
      { HISTORICAL_EXCEPTION: 'recharge-pro-2f-20261007' },
      { HISTORICAL_EXCEPTION: 'historical-finance-20261005-order-archive' },
      { RELEASE_ADMIN_ONLY: 'true' },
      { REUSE_IMAGE_RUN: '123' },
      { REUSE_IMAGE_COMMIT: commit },
      { POST_CLEANUP_SEAL_SHA256: 'a'.repeat(64) },
      { ORDER_ARCHIVE_SEAL_SHA256: 'b'.repeat(64) },
      { RELEASE_BROWSER_CACHE_IMAGE: `${env.RELEASE_REPOSITORY}:${commit}-123-1-auto-recharge` }
    ];
    for (const change of cases) {
      for (const name of [
        'validate-release-selection.sh',
        'build-images.sh',
        'push-images.sh',
        'dispatch.sh'
      ]) {
        const result = spawnSync('bash', [join(scripts, name)], {
          cwd: root,
          env: { ...env, ...change },
          encoding: 'utf8'
        });
        assert.notEqual(result.status, 0, `${name} ${Object.keys(change)[0]}`);
        assert.equal(readFileSync(log, 'utf8'), '', name);
      }
    }
    for (const name of ['build-images.sh', 'push-images.sh', 'dispatch.sh']) {
      const result = spawnSync('bash', [join(scripts, name)], {
        cwd: root,
        env: { ...env, RELEASE_OPERATION: 'verify_online_recharge' },
        encoding: 'utf8'
      });
      assert.notEqual(result.status, 0, name);
      assert.equal(readFileSync(log, 'utf8'), '', name);
    }
  });
});

function remoteCli(args, validateArguments = false) {
  const code = `import contextlib,io,json,runpy,sys
from pathlib import Path
from types import SimpleNamespace
root=Path(sys.argv[1]);requested=json.loads(sys.argv[2]);strict=sys.argv[3]=='1'
original=runpy.run_path
real=SimpleNamespace(**original(str(root/'scripts/production-release/online-recharge-scope.py')))
calls=[]
def read(method):
 def action(d,expected):
  calls.append({'method':method,'expected':expected});return {'status':'FIXTURE_ONLY'}
 return action
def release(d,args):
 calls.append({'method':'release','scope':args.online_recharge_only})
 if strict:real.validate_arguments(d,args)
 return 0
def intercepted(path,*a,**kw):
 if Path(path).name=='online-recharge-scope.py':
  return {'release':release,'build_proof':lambda d:calls.append({'method':'build_proof'}),'preflight':read('preflight'),'readback':read('readback'),'projection_diagnostic':read('diagnostic')}
 if Path(path).name=='api-admin-scope.py':raise RuntimeError('UNEXPECTED_LEGACY_CONTROLLER')
 return original(path,*a,**kw)
runpy.run_path=intercepted
sys.argv=[str(root/'scripts/production-release/remote-deploy.py'),*requested]
capture=io.StringIO();status=0
with contextlib.redirect_stdout(capture),contextlib.redirect_stderr(capture):
 try:original(sys.argv[0],run_name='__main__')
 except SystemExit as e:status=e.code if isinstance(e.code,int) else 1
 except Exception:status=1
print(json.dumps({'calls':calls,'status':status,'output':capture.getvalue()}))`;
  return JSON.parse(
    execFileSync(
      'python3',
      ['-B', '-c', code, root, JSON.stringify(args), validateArguments ? '1' : '0'],
      { cwd: root, encoding: 'utf8', timeout: 30000 }
    )
  );
}

test('real Python CLI dispatches preflight/readback/diagnostic/proof without invoking old scope or deployment', () => {
  for (const mode of ['preflight', 'readback', 'diagnostic']) {
    const result = remoteCli([`--online-recharge-${mode}`, '--expected-current', predecessor]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, [{ method: mode, expected: predecessor }]);
  }
  const built = remoteCli(['--write-online-recharge-build-proof']);
  assert.equal(built.status, 0);
  assert.deepEqual(built.calls, [{ method: 'build_proof' }]);
  for (const args of [
    ['--online-recharge-preflight', '--expected-current', predecessor, '--api-admin-only'],
    ['--online-recharge-readback', '--expected-current', 'invalid'],
    ['--write-online-recharge-build-proof', '--api-admin-only']
  ]) {
    const result = remoteCli(args);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /ONLINE_RECHARGE_(?:INPUT_INVALID|READ_UNAVAILABLE)/);
  }
});

test('read-only and release transports seal controllers and recovery policy and suppress raw output', () => {
  const dispatch = readFileSync(join(scripts, 'dispatch.sh'), 'utf8');
  const helper = readFileSync(join(scripts, 'online-recharge-readonly.py'), 'utf8');
  assert.match(
    dispatch,
    /if online_recharge:[\s\S]*--online-recharge-only --online-recharge-build-proof/
  );
  assert.match(
    dispatch,
    /controllers = \('remote-deploy\.py', 'api-admin-scope\.py'\)\n    if online_recharge or os\.environ\.get\('RELEASE_OPERATION'\) == 'release_api_workspace':\n        controllers \+= \('online-recharge-scope\.py', 'online-recharge-recovery\.json'\)\n    for name in controllers:\n        digest = hashlib\.sha256\(Path\('scripts\/production-release', name\)\.read_bytes\(\)\)\.hexdigest\(\)/
  );
  assert.match(
    dispatch,
    /pinned\.extend\(\[f'curl [^\n]+\{sha\}\/scripts\/production-release\/\{name\} -o \{target_path\}',\n\s+f'echo "\{digest\}  \{target_path\}" \| sha256sum -c - >\/dev\/null'\]\)\n    commands\[2:3\] = pinned/
  );
  assert.equal((dispatch.match(/online-recharge-readonly\.py filter-deploy/g) || []).length, 2);
  assert.match(helper, /closed_json\(value\.get\('StandardOutputContent'/);
  assert.match(helper, /validate_proof\(controller, proof, commit/);
  assert.match(helper, /for n in scope\.PRESERVED/);
  assert.match(helper, /validate_diagnostic\(controller, receipt, expected\)/);
  assert.match(helper, /object_pairs_hook=unique/);
  assert.equal(helper.includes("print(value['StandardOutputContent'])"), false);
});

test('actual dispatch generator binds all four carriers before deployment and rejects a missing policy', () => {
  const dispatch = readFileSync(join(scripts, 'dispatch.sh'), 'utf8');
  const generator = dispatch.match(/python3 - "\$parameters_file" <<'PY'\n([\s\S]*?)\nPY/)[1];
  const carriers = [
    'remote-deploy.py',
    'api-admin-scope.py',
    'online-recharge-scope.py',
    'online-recharge-recovery.json'
  ];
  fixture(({ env, folder }) => {
    const sourceDirectory = join(folder, 'scripts/production-release');
    const outputDirectory = join(folder, '.deploy/production-release');
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(outputDirectory, { recursive: true });
    for (const name of carriers)
      writeFileSync(join(sourceDirectory, name), readFileSync(join(scripts, name)));
    writeFileSync(join(outputDirectory, 'online-recharge-build-proof.json'), '{}\n');
    const parametersFile = join(folder, 'parameters.json');
    const generationEnv = { ...env, PATH: process.env.PATH };
    for (const key of ['REUSE_IMAGE_COMMIT', 'REUSE_IMAGE_RUN_ID', 'REUSE_IMAGE_RUN_ATTEMPT'])
      delete generationEnv[key];
    const invoke = () =>
      execFileSync('python3', ['-B', '-c', generator, parametersFile], {
        cwd: folder,
        env: generationEnv,
        stdio: 'pipe'
      });
    invoke();
    const parameters = JSON.parse(readFileSync(parametersFile, 'utf8'));
    assert.deepEqual(parameters.executionTimeout, ['3600']);
    assert.equal(parameters.commands.length, 11);
    assert.match(parameters.commands.at(-1), /--online-recharge-only/);
    for (const [index, name] of carriers.entries()) {
      const target = `/opt/id-business-v2/.staging/oidc-${commit}/${name}`;
      const digest = createHash('sha256')
        .update(readFileSync(join(scripts, name)))
        .digest('hex');
      assert.equal(
        parameters.commands[2 + index * 2],
        `curl -fsSL --retry 3 --max-time 30 https://raw.githubusercontent.com/wangchaozhuanyong/id-business-system/${commit}/scripts/production-release/${name} -o ${target}`
      );
      assert.equal(
        parameters.commands[3 + index * 2],
        `echo "${digest}  ${target}" | sha256sum -c - >/dev/null`
      );
    }
    rmSync(join(sourceDirectory, carriers.at(-1)));
    rmSync(parametersFile);
    assert.throws(invoke);
    assert.throws(() => readFileSync(parametersFile));
  });
});
