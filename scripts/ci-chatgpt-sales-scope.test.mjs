import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  chatgptSalesPaths,
  chatgptSalesParts,
  isChatgptSalesOnly,
  chatgptSalesCommands
} from './ci-chatgpt-sales-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
const before = execFileSync(
  'git',
  ['show', '88bce5ab09d20cd303f1fdd5fe310cb0b42e1451:apps/api/prisma-mysql/schema.prisma'],
  { encoding: 'utf8' }
);
const after = readFileSync('apps/api/prisma-mysql/schema.prisma', 'utf8');
test('sale feature selects all four relevant parts including real MySQL', () => {
  assert.equal(isChatgptSalesOnly(chatgptSalesPaths), true);
  assert.equal(checkMode(chatgptSalesPaths, before, after), 'recharge');
  assert.deepEqual(selectedParts(chatgptSalesPaths), chatgptSalesParts);
  assert.equal(needsOnlineRechargeCiBuild(chatgptSalesPaths), false);
  assert.match(
    chatgptSalesCommands('migration', chatgptSalesPaths).flat().join(' '),
    /chatgpt-sales-database.mjs --quality/
  );
});
test('unknown path, dependency change, missing source and duplicate use ordinary gates', () => {
  for (const paths of [
    [...chatgptSalesPaths, 'package-lock.json'],
    [...chatgptSalesPaths, 'apps/api/src/auth/auth.service.ts'],
    chatgptSalesPaths.filter((n) => !n.endsWith('bank-recharge-account-sales.ts')),
    [...chatgptSalesPaths, chatgptSalesPaths[0]]
  ])
    assert.equal(isChatgptSalesOnly(paths), false);
});
test('unrelated schema bytes cannot use finite schema admission', () => {
  assert.equal(checkMode(chatgptSalesPaths, before + '\n', after), 'full');
  assert.equal(checkMode(chatgptSalesPaths, before, after + '\n'), 'full');
});
test('all seven UI checks, concurrency and finite executor tests remain mandatory', () => {
  const commands = chatgptSalesCommands('guards', chatgptSalesPaths)
    .map((c) => c.join(' '))
    .join('\n');
  for (const n of [
    'admin-ui',
    'v2-ui-language',
    'v2-color-contrast',
    'v2-table-standard',
    'v2-loading-standard',
    'v2-module-architecture',
    'v2-isolation',
    'v2-concurrency-standard',
    'v2-prisma-runtime-boundary'
  ])
    assert.ok(commands.includes('check:' + n));
  assert.ok(commands.includes('chatgpt-sales-release.test.py'));
  assert.ok(commands.includes('proxy-pool.test.cjs'));
});
test('frontend acceptance and both packages retain tests and builds', () => {
  for (const part of ['api', 'admin']) {
    const commands = chatgptSalesCommands(part, chatgptSalesPaths).flat().join(' ');
    assert.match(commands, /run test/);
    assert.match(commands, /run build/);
  }
  assert.match(
    chatgptSalesCommands('admin', chatgptSalesPaths).flat().join(' '),
    /acceptance-v2-chatgpt-account-sales.mjs/
  );
  assert.throws(() => chatgptSalesCommands('connector', chatgptSalesPaths));
});
