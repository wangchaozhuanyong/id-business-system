import { checkMode, selectedParts } from './ci-recharge-scope.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  accountLoginPaths,
  accountLoginParts,
  isAccountLoginOnly,
  accountLoginSchemaMatches,
  accountLoginCommands
} from './ci-account-login-scope.mjs';
const c = JSON.parse(
  readFileSync(new URL('./production-release/account-login-contract.json', import.meta.url))
);
test('only the frozen batch is admitted; extra business and duplicate paths are refused', () => {
  assert.equal(isAccountLoginOnly(accountLoginPaths), true);
  assert.equal(
    isAccountLoginOnly([...accountLoginPaths, 'apps/api/src/auth/auth.service.ts']),
    false
  );
  assert.equal(isAccountLoginOnly([...accountLoginPaths, accountLoginPaths[0]]), false);
  assert.equal(
    isAccountLoginOnly(accountLoginPaths.filter((p) => p !== Object.keys(c.sources)[0])),
    false
  );
});
test('schema admission binds exactly the reviewed JSON column', () => {
  const before = execFileSync(
    'git',
    ['show', c.reviewBase + ':apps/api/prisma-mysql/schema.prisma'],
    { encoding: 'utf8' }
  );
  const after = readFileSync(
    new URL('../apps/api/prisma-mysql/schema.prisma', import.meta.url),
    'utf8'
  );
  assert.equal(accountLoginSchemaMatches(before, after), true);
  assert.equal(accountLoginSchemaMatches(before, after + '\n'), false);
});
test('all seven UI rules stay in finite checks and database runs only remotely', () => {
  const commands = accountLoginCommands('guards', accountLoginPaths).flat();
  for (const rule of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(commands.includes(rule));
  assert.deepEqual(accountLoginParts, ['guards', 'api', 'admin', 'connector', 'migration']);
  assert.ok(
    accountLoginCommands('migration', accountLoginPaths)
      .flat()
      .includes('scripts/production-release/account-login-database.mjs')
  );
});

test('shared CI dispatch selects all affected parts and refuses unrelated paths', () => {
  const before = execFileSync(
    'git',
    ['show', c.reviewBase + ':apps/api/prisma-mysql/schema.prisma'],
    { encoding: 'utf8' }
  );
  const after = readFileSync(
    new URL('../apps/api/prisma-mysql/schema.prisma', import.meta.url),
    'utf8'
  );
  assert.equal(checkMode(accountLoginPaths, before, after), 'recharge');
  assert.deepEqual(selectedParts(accountLoginPaths), accountLoginParts);
  assert.equal(
    checkMode([...accountLoginPaths, 'apps/api/src/auth/unauthorized.ts'], before, after),
    'full'
  );
});
