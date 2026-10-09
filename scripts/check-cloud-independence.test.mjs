import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-cloud-independence.mjs');
const output = path.join(
  root,
  '.runtime/online-recharge-release-20261009/build/cloud-independence-regressions'
);

function check(sources = {}) {
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(path.join(output, 'source-boundary-'));
  try {
    for (const relative of [
      'docker-compose.aws-mysql.yml',
      'package.json',
      'apps/api/package.json',
      'apps/admin/package.json'
    ]) {
      const file = path.join(directory, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, readFileSync(path.join(root, relative)));
    }
    for (const relative of ['apps/api/src', 'apps/admin/src'])
      mkdirSync(path.join(directory, relative), { recursive: true });
    for (const [relative, source] of Object.entries(sources)) {
      const file = path.join(directory, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    return spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('cloud-independent public configuration remains accepted', () => {
  const result = check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('dependency sources at every nesting depth are outside the business source boundary', () => {
  const result = check({
    'apps/admin/src/node_modules/vendor/index.ts': 'export const provider = "supabase";',
    'apps/admin/src/v2/vendor/node_modules/@fixture/library/src/runtime.ts':
      'export const provider = "cloudflare";',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/node_modules/zod/src/v4/core/util.ts':
      'export const provider = "cloudflare";',
    'apps/api/src/nested/node_modules/vendor/node_modules/transitive/index.ts':
      'export const provider = "supabase";'
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [name, file, source] of [
  [
    'executor source beside a dependency directory',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/runtime.ts',
    'export const provider = "supabase";'
  ],
  [
    'ordinary frontend source',
    'apps/admin/src/v2/features/fixture/View.vue',
    '<template>cloudflare</template>'
  ],
  [
    'a source directory whose name only resembles node_modules',
    'apps/api/src/node_modules-backup/runtime.ts',
    'export const provider = "supabase";'
  ]
])
  test(`removed cloud runtimes are still rejected in ${name}`, () => {
    const result = check({ [file]: source });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(file), result.stderr);
    assert.match(result.stderr, /仍引用已移除的云运行时/);
  });
