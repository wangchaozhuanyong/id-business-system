import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CODEXDAICHONG_REVISION } from '../modules/recharge/codexdaichong/prepare.mjs';

test('production recharge asset artifacts are reproducible across clean builds', t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = join(root, 'backups');
  mkdirSync(directory, { recursive: true });
  const fixture = mkdtempSync(join(directory, '.recharge-artifact-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const outputs = ['first.json', 'second.json'].map(name => join(fixture, name));
  for (const output of outputs) {
    const result = spawnSync(process.execPath, [join(root, 'modules/recharge/codexdaichong/assets.mjs'), output],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const first = readFileSync(outputs[0]);
  assert.deepEqual(first, readFileSync(outputs[1]));
  const bundle = JSON.parse(first);
  assert.equal(bundle.revision, CODEXDAICHONG_REVISION);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const entries = Object.fromEntries(Object.entries(bundle.assets).map(([route, value]) => [
    route, digest(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))))
  ]));
  console.log(JSON.stringify({ assetArtifact: {
    sha256: digest(first), bytes: first.length, node: process.version, entries
  } }));
});
