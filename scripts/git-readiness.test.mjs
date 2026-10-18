import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/git-readiness.mjs');
const fixtureRoot = resolve('.runtime/git-readiness-regression');
mkdirSync(fixtureRoot, { recursive: true });
function scan(content) {
  const directory = mkdtempSync(resolve(fixtureRoot, 'case-'));
  try {
    for (const args of [
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://example.invalid/test.git']
    ]) {
      assert.equal(spawnSync('git', args, { cwd: directory }).status, 0);
    }
    writeFileSync(
      resolve(directory, '.gitignore'),
      '.env\n.env.*\nbackups/\nuploads/\ntmp/\nnode_modules/\napps/admin/dist/\napps/api/dist/\npackages/shared/dist/\n'
    );
    writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify({ content }));
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const syntheticToken = '123456789:' + 'AbCdEfGhIjKlMnOpQrStUvWxYz'.repeat(2);
const image =
  'id-business-v2-registration-flow-v4-20261017:' + 'a'.repeat(40) + '-39022831680-admin';
test('Docker image repository date is not a standalone bot identifier', () => {
  const result = scan(image);
  assert.equal(result.status, 0, result.stderr);
});
test('standalone synthetic bot tokens remain rejected', () => {
  for (const prefix of ['', 'token=', 'Authorization: ', 'https://example.invalid/']) {
    const result = scan(prefix + syntheticToken);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /candidate.json:1 Bot API token/);
    assert.ok(!result.stderr.includes(syntheticToken));
  }
});
test('an image reference cannot conceal a later token in the same file', () => {
  const result = scan(image + ' ' + syntheticToken);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bot API token/);
});
test('other secret detectors retain their original behavior', () => {
  const result = scan('ghp_' + 'x'.repeat(30));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub token/);
});
