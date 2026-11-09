import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/google-backup-new-system'
);
const manifest = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
assert.equal(manifest.fixtureOnly, true);
const migrations = (await readdir(resolve(directory, 'migrations'))).sort();
assert.equal(migrations.length, 7);
assert.deepEqual(Object.keys(manifest.files).sort(), [
  ...migrations.map((name) => `migrations/${name}/migration.sql`),
  'schema.prisma'
]);
for (const [name, metadata] of Object.entries(manifest.files)) {
  assert.match(name, /^(schema\.prisma|migrations\/\d{14}_[a-z0-9_]+\/migration\.sql)$/);
  assert.equal(metadata.origin, `apps/api/prisma-mysql/${name}`);
  const bytes = await readFile(resolve(directory, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256, name);
}
const schema = await readFile(resolve(directory, 'schema.prisma'), 'utf8');
assert.equal([...schema.matchAll(/^model /gm)].length, 118);
assert.match(schema, /model IdBusinessV2SubscriptionOrder/);
assert.match(schema, /model IdBusinessV2GoogleMailbox/);
assert.match(schema, /^model IdBusinessV2ClaudeProPerson \{/m);
assert.match(schema, /^model IdBusinessV2ClaudeProOrderRevision \{/m);
console.log('新版备份测试输入：118 个模型、7 份新增迁移，摘要核对通过。');
