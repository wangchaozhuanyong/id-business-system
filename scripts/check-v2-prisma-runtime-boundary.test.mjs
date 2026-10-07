import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-v2-prisma-runtime-boundary.mjs');
const schema = readFileSync(path.join(root, 'apps/api/prisma-mysql/schema.prisma'), 'utf8');
const output = path.join(root, '.runtime/architecture-repair-20261005/guards');

function check(source, relative = 'accounts/fixture.service.ts', schemaText = schema) {
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(path.join(output, 'prisma-boundary-'));
  const file = path.join(directory, 'apps/api/src/id-business-v2', relative);
  const schemaPath = path.join(directory, 'apps/api/prisma-mysql/schema.prisma');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(path.dirname(schemaPath), { recursive: true });
    writeFileSync(file, source);
    writeFileSync(schemaPath, schemaText);
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('all MySQL model delegates are rejected in business transaction helpers', () => {
  for (const access of [
    'tx.user.findUnique({})',
    "tx['role'].findMany({})",
    'tx.activeSession.deleteMany({})'
  ]) {
    const result = check(`import type { V2CommandTransaction } from '../runtime/public-api';
      function business(tx: V2CommandTransaction) { return ${access}; }`);
    assert.equal(result.status, 1, access);
    assert.match(result.stderr, /Prisma 模型访问只能位于 persistence adapter/);
  }
});

test('typed aliases and inferred command transaction callbacks cannot hide model access', () => {
  for (const source of [
    `import type { V2CommandTransaction as Transaction } from '../runtime/public-api';
     function business(transaction: Transaction) { const database = transaction; return database.permission.findMany({}); }`,
    `function business(tx: V2CommandTransaction) { const { user: users } = tx; return users.findMany({}); }`,
    `class Example { constructor(private readonly commands: V2CommandTransactionManager) {}
     run() { return this.commands.execute(async (database) => database.user.findUnique({}), {}); } }`
  ]) {
    const result = check(source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Prisma 模型访问只能位于 persistence adapter/);
  }
});

test('future models come from the current MySQL schema rather than a hard-coded delegate list', () => {
  const result = check(
    'function business(tx: V2CommandTransaction) { return tx.futureModel.findMany({}); }',
    undefined,
    `${schema}\nmodel FutureModel { id String @id }\n`
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Prisma 模型访问只能位于 persistence adapter/);
});

test('ordinary user, role and session properties are not Prisma accesses, including shadowed aliases', () => {
  const result = check(`
    const tx: V2CommandTransaction = database;
    function present(tx: { user: { name: string }, role: string }) { return tx.user.name + tx.role; }
    function show(record: { activeSession: boolean }) { return record.activeSession; }
    const data = { user: { id: 'example' } }; const selected = data.user;
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('repository adapters and the explicit transaction bridge retain model access', () => {
  const source = 'function query(tx: V2CommandTransaction) { return tx.user.findUnique({}); }';
  for (const relative of [
    'accounts/persistence/fixture.repository.ts',
    'runtime/id-business-v2-command-transaction.service.ts'
  ]) {
    const result = check(source, relative);
    assert.equal(result.status, 0, result.stderr);
  }
});
