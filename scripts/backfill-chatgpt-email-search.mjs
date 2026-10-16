import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function backfillChatgptEmailSearch(prisma, encryption, buildTokens, apply = false) {
  let cursor;
  let candidates = 0;
  let updated = 0;
  let conflicts = 0;
  while (true) {
    const rows = await prisma.idBusinessV2ChatgptAccount.findMany({
      where: { emailSearchTokens: { equals: [] }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, emailEncrypted: true, emailHash: true, updatedAt: true },
      orderBy: { id: 'asc' },
      take: 250
    });
    if (!rows.length) break;
    for (const row of rows) {
      const email = encryption.decrypt(row.emailEncrypted);
      if (!email) throw new Error('账号邮箱无法解密，回填已停止');
      const tokens = buildTokens(email, 'chatgpt-email', (value) => encryption.hash(value));
      if (!tokens.length) throw new Error('邮箱索引生成失败，回填已停止');
      candidates++;
      if (apply) {
        const result = await prisma.idBusinessV2ChatgptAccount.updateMany({
          where: {
            id: row.id,
            emailHash: row.emailHash,
            updatedAt: row.updatedAt,
            emailSearchTokens: { equals: [] }
          },
          data: { emailSearchTokens: tokens, updatedAt: row.updatedAt }
        });
        updated += result.count;
        conflicts += result.count === 0 ? 1 : 0;
      }
    }
    cursor = rows.at(-1).id;
  }
  return { apply, candidates, updated, conflicts };
}

async function main() {
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require('@prisma/client');
  const {
    FieldEncryptionService
  } = require('../apps/api/dist/common/crypto/field-encryption.service.js');
  const {
    buildIdBusinessV2BlindIndexTokens
  } = require('../apps/api/dist/id-business-v2/runtime/id-business-v2-blind-search.js');
  if (!process.env.DATABASE_URL || !process.env.FIELD_ENCRYPTION_KEY || !process.env.HASH_SECRET)
    throw new Error('缺少受控数据库与加密配置');
  const prisma = new PrismaClient();
  try {
    const result = await backfillChatgptEmailSearch(
      prisma,
      new FieldEncryptionService({ get: (key) => process.env[key] }),
      buildIdBusinessV2BlindIndexTokens,
      process.argv.includes('--apply')
    );
    console.log(JSON.stringify(result));
    if (result.conflicts) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('邮箱索引回填失败，请核对受控执行结果；未输出任何凭据。');
    process.exitCode = 1;
  });
