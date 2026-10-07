import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function checkMutation(file, append) {
  const runner = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRead = fs.readFileSync;
    const target = path.resolve(process.env.ARCHITECTURE_TEST_FILE);
    fs.readFileSync = (file, ...args) => {
      const value = originalRead(file, ...args);
      return typeof file === 'string' && path.resolve(file) === target
        ? value + process.env.ARCHITECTURE_TEST_APPEND : value;
    };
    syncBuiltinESMExports();
    await import('./scripts/check-v2-module-architecture.mjs');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHITECTURE_TEST_FILE: file,
      ARCHITECTURE_TEST_APPEND: append
    }
  });
}

test('runtime registry cannot reintroduce a second metadata definition', () => {
  const result = checkMutation(
    'apps/admin/src/v2/features/runtimeRegistry.ts',
    "\nconst extraRegistry = [{ key: 'orders', freshnessPolicy: 'event-driven' }];\n"
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /运行时注册只能重导出 registry/);
});

test('secondary manifests cannot statically import schemas or page components', () => {
  for (const append of [
    "\nimport { v2TablesByFeature } from '@/v2/features/tableSchemas';\n",
    "\nimport Page from './V2ChatgptAccountsView.vue';\n"
  ]) {
    const result = checkMutation(
      'apps/admin/src/v2/features/auto-recharge/chatgpt-accounts-manifest.ts',
      append
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /注册元数据禁止静态加载页面或 tableSchemas/);
  }
});

test('schema-only type imports do not add a runtime dependency', () => {
  const result = checkMutation(
    'apps/admin/src/v2/features/orders/manifest.ts',
    "\nimport type { v2TablesByFeature } from '@/v2/features/tableSchemas';\n"
  );
  assert.equal(result.status, 0, result.stderr);
});
