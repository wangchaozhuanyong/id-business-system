import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [part, base] = process.argv.slice(2);
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
const npm = (...args) => run('npm', args);
const changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split('\n');
const shared = () => npm('run', 'build', '--workspace', '@apple-business/shared');

if (part === 'guards') {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing diff base');
  const changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((p) => existsSync(p));
  const formatted = changed.filter((p) => /\.(?:[cm]?js|ts|vue|css|json|md|yml)$/.test(p));
  const linted = changed.filter((p) => /\.(?:mjs|ts|vue)$/.test(p));
  if (formatted.length) npm('exec', '--', 'prettier', '--check', ...formatted);
  if (linted.length) npm('exec', '--', 'eslint', ...linted);
  run('node', [
    '--test',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-precision.test.mjs'
  ]);
  npm(
    'run',
    'check:v2-decimal-standard',
    '--',
    'apps/admin/src/v2/features/auto-recharge',
    'apps/api/src/id-business-v2/auto-recharge',
    'packages/shared/src/v2'
  );
  npm('run', 'check:v2-ui-language', '--', 'apps/admin/src/v2/features/auto-recharge');
} else if (part === 'admin') {
  shared();
  npm(
    'run',
    'test',
    '--workspace',
    '@apple-business/admin',
    '--',
    'src/v2/features/auto-recharge',
    ...(changed.some((p) => p.includes('/audit-logs/'))
      ? ['src/v2/features/audit-logs/audit-log-presentation.spec.ts']
      : [])
  );
  npm('run', 'build', '--workspace', '@apple-business/admin');
  npm('run', 'acceptance:v2-auto-recharge');
} else if (part === 'api') {
  npm('run', 'prisma:mysql:generate');
  npm('run', 'prisma:mysql:validate');
  shared();
  npm(
    'run',
    'test',
    '--workspace',
    '@apple-business/api',
    '--',
    'src/id-business-v2/auto-recharge',
    ...(changed.some((p) => p.startsWith('apps/api/src/auth/')) ? ['src/auth', 'src/security'] : [])
  );
  npm('run', 'build', '--workspace', '@apple-business/api');
} else if (part === 'migration') {
  run('python3', ['scripts/ci-recharge-migration.py']);
} else if (part === 'connector') {
  execFileSync(
    'python3',
    [
      '-m',
      'unittest',
      'test_bitbrowser_catalog',
      'test_bitbrowser_options',
      'test_bitbrowser_connector',
      'test_connector_health',
      'test_session_retry'
    ],
    {
      cwd: 'apps/api/src/id-business-v2/auto-recharge/worker',
      stdio: 'inherit',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    }
  );
} else if (part === 'security') {
  run('python3', ['-B', 'scripts/audit-python-dependencies.test.py']);
  run('node', ['--test', 'scripts/container-hardening.test.mjs']);
  run('sh', ['-n', 'scripts/start-auto-recharge-connector.sh']);
} else throw new Error('Unknown recharge check part');
