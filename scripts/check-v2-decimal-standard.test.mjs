import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const file = 'scripts/fixtures/decimal-standard.ts';
const timestamp = String.raw`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/`;
const source = `const timestampPattern = ${timestamp};`;

function check(candidate) {
  const runner = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const original = fs.readFileSync;
    const originalReadDirectory = fs.readdirSync;
    const target = path.resolve(input.file);
    fs.readFileSync = (file, ...args) =>
      typeof file === 'string' && path.resolve(file) === target
        ? input.source : original(file, ...args);
    fs.readdirSync = (directory, ...args) =>
      path.resolve(directory) === path.dirname(target)
        ? [{name: path.basename(target), isDirectory: () => false}]
        : originalReadDirectory(directory, ...args);
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'checker', path.dirname(input.file)];
    await import('./scripts/check-v2-decimal-standard.mjs');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    encoding: 'utf8',
    input: JSON.stringify({ file, source: candidate }),
    timeout: 30000
  });
}

test('complete anchored ISO timestamp preserves microseconds without treating them as money', () => {
  assert.equal(source.split(timestamp).length, 2);
  const result = check(source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /检查通过/);
});

test('the same timestamp source still rejects five and six decimal place money validators', () => {
  for (const places of [5, 6]) {
    const amount = String.raw`/^\d+(?:\.\d{1,PLACES})?$/`.replace('PLACES', String(places));
    const result = check(source + '\nconst unreviewedMoney = ' + amount + ';\n');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /业务数值校验不允许接受超过 4 位小数/);
  }
});

test('partial or unanchored dates never exempt an excessive decimal fraction', () => {
  for (const invalid of [
    timestamp.replace('/^', '/'),
    timestamp.replace('$/', '/'),
    timestamp.replace(String.raw`\d{4}-\d{2}-\d{2}T`, ''),
    timestamp.replace(String.raw`(?:Z|[+-]\d{2}:\d{2})`, ''),
    timestamp.replace('{1,6}', '{1,7}')
  ]) {
    const result = check(source.replace(timestamp, invalid));
    assert.equal(result.status, 1, invalid + '\n' + result.stdout + result.stderr);
    assert.match(result.stderr, /业务数值校验不允许接受超过 4 位小数/);
  }
});
