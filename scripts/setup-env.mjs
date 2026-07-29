import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envExamplePath = resolve(rootDir, '.env.example');
const rootEnvPath = resolve(rootDir, '.env');
const workspaceEnvLinks = [resolve(rootDir, 'apps/api/.env'), resolve(rootDir, 'apps/admin/.env')];

function secret(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}

function createRootEnv() {
  if (existsSync(rootEnvPath)) {
    console.log('Skipped .env because it already exists.');
    return;
  }

  const content = readFileSync(envExamplePath, 'utf8')
    .replace(/^JWT_SECRET=.*/m, `JWT_SECRET=${secret()}`)
    .replace(/^SEED_ADMIN_PASSWORD=.*/m, `SEED_ADMIN_PASSWORD=${secret(24)}`)
    .replace(/^FIELD_ENCRYPTION_KEY=.*/m, `FIELD_ENCRYPTION_KEY=${secret(32)}`)
    .replace(/^HASH_SECRET=.*/m, `HASH_SECRET=${secret()}`);

  writeFileSync(rootEnvPath, content, { encoding: 'utf8', mode: 0o600 });
  console.log('Created .env with local development secrets.');
}

function ensureWorkspaceEnvLink(linkPath) {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(linkPath);
    } else {
      console.log(
        `Skipped ${relative(rootDir, linkPath)} because it already exists and is not a symlink.`
      );
      return;
    }
  }

  const target = relative(dirname(linkPath), rootEnvPath);
  symlinkSync(target, linkPath);
  console.log(`Linked ${relative(rootDir, linkPath)} -> ${target}`);
}

createRootEnv();
for (const linkPath of workspaceEnvLinks) {
  ensureWorkspaceEnvLink(linkPath);
}
