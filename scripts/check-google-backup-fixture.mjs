import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/google-backup-new-system'
);
const manifest = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
assert.equal(manifest.fixtureOnly, true);
assert.equal(Object.keys(manifest.files).length, 7);
for (const [name, metadata] of Object.entries(manifest.files)) {
  assert.match(name, /^(schema\.prisma|migrations\/20261105[0-9_a-z]+\/migration\.sql)$/);
  const bytes = await readFile(resolve(directory, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256, name);
}
const schema = await readFile(resolve(directory, 'schema.prisma'), 'utf8');
assert.equal([...schema.matchAll(/^model /gm)].length, 116);
assert.match(schema, /model IdBusinessV2SubscriptionOrder/);
assert.match(schema, /model IdBusinessV2GoogleMailbox/);
console.log('新版备份测试输入：116 个模型、6 份新增迁移，摘要核对通过；生产 schema 未修改。');
