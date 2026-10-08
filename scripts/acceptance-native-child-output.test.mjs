import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(project, '.runtime/native-child-output-tests');

for (const suite of ['financial', 'rollback']) {
  test(`${suite} native child failure captures private output and still cleans its owned instance`, () => {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(resolve(parent, 'owned-'));
    try {
      mkdirSync(resolve(directory, 'apps/api/prisma-mysql/migrations/fixture'), {
        recursive: true
      });
      mkdirSync(resolve(directory, 'lib'));
      writeFileSync(
        resolve(directory, 'lib/v2-data-integrity-audit.mjs'),
        `export { V2_DATA_INTEGRITY_CHECKS } from ${JSON.stringify(pathToFileURL(resolve(project, 'scripts/lib/v2-data-integrity-audit.mjs')).href)};`
      );
      const source = readFileSync(
        resolve(project, `scripts/acceptance-v2-${suite}-integrity.mjs`),
        'utf8'
      );
      writeFileSync(
        resolve(directory, 'entry.mjs'),
        source
          .replace("from 'node:child_process'", "from './transport.mjs'")
          .replace("from './lib/native-mysql-test-instance.mjs'", "from './transport.mjs'")
      );
      writeFileSync(
        resolve(directory, 'transport.mjs'),
        `
import { appendFileSync } from 'node:fs';
import { spawnSync as actualSpawn } from 'node:child_process';
export { parseNativeMysqlTestOptions } from ${JSON.stringify(pathToFileURL(resolve(project, 'scripts/lib/native-mysql-test-instance.mjs')).href)};
export async function startNativeMysqlTestInstance() {
  appendFileSync('calls.txt', 'start\\n');
  return { port:33111, rootPassword:'isolated-synthetic-placeholder',
    async cleanup() { appendFileSync('calls.txt', 'cleanup\\n'); } };
}
export function spawnSync(command, args, options) {
  if(command !== 'npm') throw new Error('Unexpected transport invocation');
  appendFileSync('calls.txt', 'child\\n');
  return actualSpawn(process.execPath, ['-e',
    'process.stdout.write("SYNTHETIC_PRIVATE_OUTPUT");process.stderr.write("SYNTHETIC_PRIVATE_OUTPUT");process.exit(1)'], options);
}
`
      );
      const result = spawnSync(
        process.execPath,
        ['entry.mjs', '--runtime=native', '--mysql-bin=/installed/mysql/bin'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 10000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME }
        }
      );
      assert.notEqual(result.status, 0);
      assert.deepEqual(readFileSync(resolve(directory, 'calls.txt'), 'utf8').trim().split('\n'), [
        'start',
        'child',
        'cleanup'
      ]);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('SYNTHETIC_PRIVATE_OUTPUT'));
      assert.match(result.stderr, /原生验收子进程失败/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
