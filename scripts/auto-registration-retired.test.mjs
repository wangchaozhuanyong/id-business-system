import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rejectRetiredRegistrationCommand } from './auto-registration-retired.mjs';
import { adminCheckCommands } from './ci-recharge-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('retired registration execution is rejected while recharge and historical audits remain available', () => {
  for (const [file, ...args] of [
    ['npm', 'run', 'auto-registration:setup'],
    ['npm', 'run', 'auto-registration:local'],
    ['npm', 'exec', '--', 'node', 'scripts/acceptance-v2-registration-native-ui.mjs', 'eslint'],
    ['npm', 'exec', 'node', 'scripts/acceptance-v2-registration-native-ui.mjs', 'prettier'],
    ['python3', 'apps/api/src/id-business-v2/auto-registration/worker/main.py'],
    ['node', 'scripts/acceptance-v2-registration-native-ui.mjs'],
    ['python3', '-B', 'scripts/production-release/registration-closure-release.py']
  ])
    assert.throws(() => rejectRetiredRegistrationCommand(file, args), /removed/);
  for (const [file, ...args] of [
    ['node', '--test', 'scripts/auto-registration-retired.test.mjs'],
    ['node', '--test', 'scripts/ci-registration-browser-scope.test.mjs'],
    ['node', '--test', 'scripts/v2-registration-finance-audit.test.mjs'],
    ['python3', 'apps/api/src/id-business-v2/auto-recharge/worker/server.py']
  ])
    assert.doesNotThrow(() => rejectRetiredRegistrationCommand(file, args));
});

test('registration source, installers, acceptance and dedicated release workflows are removed', () => {
  for (const path of [
    'apps/api/src/id-business-v2/auto-registration/worker',
    'apps/api/src/id-business-v2/auto-registration/upstream',
    'scripts/setup-auto-registration.mjs',
    'scripts/start-auto-registration-local.mjs'
  ])
    assert.equal(existsSync(root + path), false, path);
  assert.equal(
    readdirSync(root + '.github/workflows').some((name) => /^registration-/.test(name)),
    false
  );
  assert.equal(
    readdirSync(root + 'scripts').some((name) => /^acceptance-v2-registration-/.test(name)),
    false
  );
  assert.equal(
    readdirSync(root + 'scripts/production-release').some((name) =>
      /^registration-.*\.(?:py|mjs)$/.test(name)
    ),
    false
  );
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(
    Object.keys(scripts).some((name) => name.startsWith('auto-registration:')),
    false
  );
});

test('current packaging and quality no longer execute registration and retained data has no runtime mount', () => {
  assert.doesNotMatch(
    read('apps/api/Dockerfile.mysql'),
    /auto-registration|id-registration|registration-dependencies|python3/u
  );
  const compose = read('docker-compose.aws-mysql.yml');
  assert.doesNotMatch(
    compose,
    /^ {2}auto-registration:|registration-control:|registration-egress:|AUTO_REGISTRATION_WORKER_URL|auto_registration_data:\//mu
  );
  assert.match(compose, /^ {2}auto_registration_data:$/mu);
  assert.match(compose, /^ {2}auto-recharge:$/mu);
  assert.match(compose, /online_recharge_data:\/app\/\.runtime\/online-recharge/u);
  assert.doesNotMatch(
    read('deploy/caddy/Caddyfile.aws'),
    /registrationWorkspace|auto-registration/u
  );
  assert.doesNotMatch(
    read('.github/workflows/quality.yml'),
    /auto-registration:setup|auto-registration\/worker/u
  );
  for (const args of adminCheckCommands('admin', [
    'apps/admin/src/v2/features/auto-recharge/V2ChatgptAccountsView.vue'
  ]))
    assert.doesNotThrow(() => rejectRetiredRegistrationCommand('npm', args));
});

test('production selection refuses registration before any release work', () => {
  for (const selection of [
    { RELEASE_OPERATION: 'release_api_registration' },
    { RELEASE_OPERATION: 'release', HISTORICAL_EXCEPTION: 'registration-worker-96-20261008' }
  ]) {
    assert.throws(
      () =>
        execFileSync('bash', ['scripts/production-release/validate-release-selection.sh'], {
          cwd: root,
          env: { ...process.env, ...selection },
          stdio: 'pipe'
        }),
      (failure) => failure.stderr?.toString().includes('Automatic registration has been removed')
    );
  }
});
