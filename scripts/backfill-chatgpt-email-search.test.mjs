import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillChatgptEmailSearch } from './backfill-chatgpt-email-search.mjs';

function fixture() {
  const row = {
    id: 'synthetic',
    emailHash: 'synthetic-hash',
    emailEncrypted: 'synthetic@example.invalid',
    updatedAt: new Date('2026-01-01')
  };
  const updates = [];
  let read = false;
  const prisma = {
    idBusinessV2ChatgptAccount: {
      async findMany() {
        if (read) return [];
        read = true;
        return [row];
      },
      async updateMany(args) {
        updates.push(args);
        return { count: 1 };
      }
    }
  };
  return { prisma, row, updates };
}
test('默认预览不写入且不输出邮箱', async () => {
  const f = fixture();
  const result = await backfillChatgptEmailSearch(f.prisma, { decrypt: (value) => value }, () => [
    'opaque'
  ]);
  assert.deepEqual(result, { apply: false, candidates: 1, updated: 0, conflicts: 0 });
  assert.equal(f.updates.length, 0);
  assert.equal(JSON.stringify(result).includes('@'), false);
});
test('执行时按邮箱及版本条件更新派生索引，保留业务更新时间', async () => {
  const f = fixture();
  const result = await backfillChatgptEmailSearch(
    f.prisma,
    { decrypt: (value) => value },
    () => ['opaque'],
    true
  );
  assert.equal(result.updated, 1);
  assert.deepEqual(f.updates[0], {
    where: {
      id: f.row.id,
      emailHash: f.row.emailHash,
      updatedAt: f.row.updatedAt,
      emailSearchTokens: { equals: [] }
    },
    data: { emailSearchTokens: ['opaque'], updatedAt: f.row.updatedAt }
  });
});
