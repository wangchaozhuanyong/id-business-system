import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseNativeMysqlTestOptions,
  startNativeMysqlTestInstance,
  verifyNativeMysqlTestProject,
  verifyNativeMysqlTestDirectory
} from './lib/native-mysql-test-instance.mjs';

test('native test transport requires an explicit installed absolute binary directory', () => {
  assert.deepEqual(
    parseNativeMysqlTestOptions(
      ['--runtime=native', '--mysql-bin=/installed/mysql/bin', '--order-archive-only'],
      ['--order-archive-only']
    ),
    {
      runtime: 'native',
      explicitRuntime: true,
      mysqlBin: '/installed/mysql/bin',
      extraFlags: ['--order-archive-only']
    }
  );
  for (const args of [
    ['--runtime=native'],
    ['--runtime=native', '--mysql-bin=relative'],
    ['--runtime=native', '--mysql-bin=/x', '--mysql-bin=/y'],
    ['--runtime=native', '--runtime=docker'],
    ['--mysql-bin=/x'],
    ['--runtime=other'],
    ['--database=production']
  ])
    assert.throws(() => parseNativeMysqlTestOptions(args));
});

test('runtime ancestors and changed cleanup paths cannot redirect writes or deletion outside the project', () => {
  const testParent = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../.runtime/native-mysql-path-tests'
  );
  mkdirSync(testParent, { recursive: true });
  const project = mkdtempSync(resolve(testParent, 'fixture-'));
  try {
    const schema = resolve(project, 'apps/api/prisma-mysql/schema.prisma');
    mkdirSync(dirname(schema), { recursive: true });
    writeFileSync(schema, 'owned fixture');
    const outside = resolve(project, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, resolve(project, '.runtime'));
    assert.throws(() => verifyNativeMysqlTestProject(project));
    assert.equal(existsSync(resolve(outside, 'native-mysql-tests')), false);
    rmSync(resolve(project, '.runtime'));
    const parent = verifyNativeMysqlTestProject(project);
    mkdirSync(parent, { recursive: true });
    const owned = mkdtempSync(resolve(parent, 'owned-'));
    verifyNativeMysqlTestDirectory(project, owned);
    const moved = resolve(parent, 'retained');
    renameSync(owned, moved);
    symlinkSync(outside, owned);
    assert.throws(() => verifyNativeMysqlTestDirectory(project, owned));
    assert.ok(existsSync(moved));
    assert.ok(existsSync(outside));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('legacy transport remains available explicitly and unknown business flags reject', () => {
  assert.equal(parseNativeMysqlTestOptions(['--runtime=docker']).runtime, 'docker');
  assert.throws(() => parseNativeMysqlTestOptions(['--real-payment']));
  assert.throws(() =>
    parseNativeMysqlTestOptions(['--runtime=docker', '--mysql-bin=/installed/bin'])
  );
});

test('existing live database names and data paths cannot be supplied to the disposable launcher', async () => {
  for (const database of [
    'id_business_v2',
    'mysql',
    'production',
    'id_native_test; DROP DATABASE mysql'
  ])
    await assert.rejects(startNativeMysqlTestInstance({ mysqlBin: '/installed/bin', database }));
});
