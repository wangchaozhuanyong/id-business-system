import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import test from 'node:test';

test('coordinate precision does not weaken money precision or adjacent controls', () => {
  const output = resolve('.deploy/ci-recharge-precision');
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(`${output}/fixture-`);
  const relative = 'apps/admin/src/v2/features/auto-recharge/RechargeWindowOptions.vue';
  const file = resolve(directory, relative);
  mkdirSync(dirname(file), { recursive: true });
  const script = resolve('scripts/check-v2-decimal-standard.mjs');
  const check = () =>
    spawnSync(process.execPath, [script, dirname(relative)], { cwd: directory, encoding: 'utf8' });
  try {
    const original = readFileSync(relative, 'utf8');
    writeFileSync(file, original);
    assert.equal(check().status, 0);
    writeFileSync(file, `${original}\n<el-input-number v-model="amount" :precision="6" />`);
    assert.equal(check().status, 1);
    writeFileSync(file, original.replaceAll(':precision="6"', ':precision="7"'));
    assert.equal(check().status, 1);
    writeFileSync(file, original.replace('v-model="options.latitude"', 'v-model="amount"'));
    assert.equal(check().status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
