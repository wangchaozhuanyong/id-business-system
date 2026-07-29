#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const requireSupabase = process.argv.includes('--require-supabase');
const failures = [];

const packageFiles = ['package.json', 'apps/api/package.json', 'apps/admin/package.json'];
const sourceRoots = ['apps/api/src', 'apps/admin/src', 'packages'];
const infrastructureFiles = [
  '.env.example',
  '.env.production.example',
  'docker-compose.prod.yml',
  'scripts/deploy-pm2-api.sh'
];

for (const file of packageFiles) {
  const manifest = JSON.parse(readProjectFile(file));
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {})
  };
  const cloudDependencies = Object.keys(dependencies).filter((name) =>
    /^(?:@aws-sdk\/|aws-sdk$)|amazon|dynamodb|cloudfront|cognito/i.test(name)
  );
  if (cloudDependencies.length) {
    failures.push(`${file} contains AWS runtime dependencies: ${cloudDependencies.join(', ')}`);
  }
}

for (const file of walkFiles(sourceRoots)) {
  const source = readProjectFile(file);
  if (/(?:from\s+|require\()\s*['"](?:@aws-sdk\/|aws-sdk)|amazonaws\.com|s3:\/\//i.test(source)) {
    failures.push(`${file} contains an AWS runtime integration`);
  }
}

for (const file of infrastructureFiles) {
  const source = readProjectFile(file);
  if (
    /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION)\b|amazonaws\.com|s3:\/\//i.test(
      source
    )
  ) {
    failures.push(`${file} contains an active AWS credential or service target`);
  }
}

const productionCompose = readProjectFile('docker-compose.prod.yml');
if (/^\s{2}postgres:\s*$/m.test(productionCompose)) {
  failures.push('docker-compose.prod.yml still provisions a production PostgreSQL container');
}
if (!/DATABASE_URL:\s*\$\{DATABASE_URL:\?set Supabase DATABASE_URL\}/.test(productionCompose)) {
  failures.push('docker-compose.prod.yml does not require the external Supabase DATABASE_URL');
}

const localDatabase = inspectLocalDatabase();
if (requireSupabase && localDatabase.status !== 'supabase') {
  failures.push(`local DATABASE_URL is not confirmed Supabase (${localDatabase.status})`);
}

if (failures.length) {
  console.error(`Cloud independence check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[PASS] no AWS SDK or AWS service integration in runtime dependencies and sources');
console.log('[PASS] production Compose uses external Supabase PostgreSQL');
console.log(
  `[${localDatabase.status === 'supabase' ? 'PASS' : 'INFO'}] local database target: ${localDatabase.detail}`
);
console.log('[Cloud independence] PASSED');

function readProjectFile(file) {
  const absolutePath = path.join(rootDir, file);
  if (!existsSync(absolutePath)) {
    failures.push(`${file}: missing file`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

function walkFiles(roots) {
  const files = [];
  const queue = roots.map((root) => path.join(rootDir, root));
  while (queue.length) {
    const current = queue.pop();
    if (!existsSync(current)) continue;
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) queue.push(path.join(current, entry));
      continue;
    }
    if (!/\.(?:ts|tsx|js|mjs|vue)$/.test(current)) continue;
    files.push(path.relative(rootDir, current));
  }
  return files;
}

function inspectLocalDatabase() {
  const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim();
  const envPath = path.join(rootDir, '.env');
  const envDatabaseUrl = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .find((item) => item.startsWith('DATABASE_URL='))
        ?.slice('DATABASE_URL='.length)
        .trim()
    : undefined;
  const databaseUrl = runtimeDatabaseUrl || envDatabaseUrl;
  if (!databaseUrl) return { status: 'missing', detail: 'DATABASE_URL is absent' };

  try {
    const url = new URL(databaseUrl);
    const isSupabase =
      url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.com');
    const projectRef =
      url.username.split('.')[1] ??
      url.hostname.match(/^db\.([^.]+)\.supabase\.co$/i)?.[1] ??
      'unknown';
    return isSupabase
      ? {
          status: 'supabase',
          detail: `source=${runtimeDatabaseUrl ? 'process' : '.env'} host=${
            url.hostname
          } project=${projectRef} password=${url.password ? 'set' : 'missing'}`
        }
      : {
          status: 'other',
          detail: `source=${runtimeDatabaseUrl ? 'process' : '.env'} host=${url.hostname}`
        };
  } catch {
    return { status: 'invalid', detail: 'DATABASE_URL is invalid' };
  }
}
