import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return `${result.stdout}${result.stderr}`.trim().split('\n')[0];
}

function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function readEnv() {
  const envPath = resolve(rootDir, '.env');
  if (!existsSync(envPath)) {
    return null;
  }

  return readFileSync(envPath, 'utf8');
}

function parseMajor(versionText) {
  const match = versionText?.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

const nodeVersion = commandVersion('node');
addCheck('Node.js >= 22', parseMajor(nodeVersion) >= 22, nodeVersion ?? 'node command not found');

const npmVersion = commandVersion('npm');
addCheck('npm >= 10', parseMajor(npmVersion) >= 10, npmVersion ?? 'npm command not found');

const envContent = readEnv();
addCheck('.env exists', Boolean(envContent), envContent ? '.env found' : 'run npm run setup:env');

for (const workspaceEnv of ['apps/api/.env', 'apps/admin/.env']) {
  const envPath = resolve(rootDir, workspaceEnv);
  const exists = existsSync(envPath);
  const isSymlink = exists && lstatSync(envPath).isSymbolicLink();
  addCheck(
    `${workspaceEnv} symlink`,
    isSymlink,
    isSymlink ? 'linked to root .env' : 'run npm run setup:env'
  );
}

if (envContent) {
  const hasDatabaseUrl = /^DATABASE_URL=postgresql:\/\//m.test(envContent);
  addCheck(
    'DATABASE_URL uses PostgreSQL',
    hasDatabaseUrl,
    hasDatabaseUrl ? 'configured' : 'missing or invalid'
  );

  const placeholders = [
    'JWT_SECRET=change_me',
    'FIELD_ENCRYPTION_KEY=change_me',
    'HASH_SECRET=change_me',
    'SEED_ADMIN_PASSWORD=change_me'
  ].filter((placeholder) => envContent.includes(placeholder));
  addCheck(
    '.env secrets are not placeholders',
    placeholders.length === 0,
    placeholders.length === 0 ? 'configured' : `replace: ${placeholders.join(', ')}`
  );
}

const dockerVersion = commandVersion('docker');
addCheck('Docker CLI installed', Boolean(dockerVersion), dockerVersion ?? 'install Docker Desktop');

if (dockerVersion) {
  const composeVersion = commandVersion('docker', ['compose', 'version']);
  addCheck(
    'Docker Compose available',
    Boolean(composeVersion),
    composeVersion ?? 'docker compose not available'
  );

  const dockerInfo = commandVersion('docker', ['info']);
  addCheck(
    'Docker daemon running',
    Boolean(dockerInfo),
    dockerInfo ? 'running' : 'start Docker Desktop'
  );
}

const prismaResult = spawnSync('npm', ['run', 'prisma:validate', '--silent'], {
  cwd: rootDir,
  encoding: 'utf8',
  shell: false
});
addCheck(
  'Prisma schema validates',
  prismaResult.status === 0,
  prismaResult.status === 0 ? 'valid' : `${prismaResult.stdout}${prismaResult.stderr}`.trim()
);

let failed = 0;
for (const check of checks) {
  const marker = check.ok ? 'OK' : 'FAIL';
  console.log(`[${marker}] ${check.name}: ${check.detail}`);
  if (!check.ok) {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\nEnvironment doctor found ${failed} issue(s).`);
  console.error('See README.md and docs/DEPLOYMENT.md for setup notes.');
  process.exit(1);
}

console.log('\nEnvironment doctor passed.');
