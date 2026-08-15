#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { isV1EncryptedField, maskUserPhone } from './lib/user-phone-encryption.mjs';

const require = createRequire(import.meta.url);
const {
  FieldEncryptionService
} = require('../apps/api/dist/common/crypto/field-encryption.service.js');
const BATCH_SIZE = 100;

function loadEnvFile(filePath) {
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 0) continue;
      process.env[trimmed.slice(0, separator)] ??= trimmed.slice(separator + 1);
    }
  } catch {
    // Required values are checked before any database connection is opened.
  }
}

function createEncryptionService() {
  return new FieldEncryptionService({
    get: (key) => process.env[key]
  });
}

async function backfillPlaintextPhones(prisma, encryption) {
  let updated = 0;
  while (true) {
    const rows = await prisma.$queryRaw`
      SELECT id::text AS id,
             phone,
             phone_encrypted AS "phoneEncrypted"
      FROM public.users
      WHERE phone IS NOT NULL
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `;
    if (rows.length === 0) return updated;

    const results = await prisma.$transaction(
      rows.map((row) => {
        assert.equal(typeof row.id, 'string', '用户手机号回填遇到无效用户 ID');
        assert.equal(typeof row.phone, 'string', `用户 ${row.id} 的历史手机号格式无效`);
        let encrypted = row.phoneEncrypted;
        if (encrypted !== null) {
          assert.ok(
            isV1EncryptedField(encrypted),
            `用户 ${row.id} 已有手机号密文格式无效，已停止回填`
          );
          assert.ok(
            encryption.decrypt(encrypted) === row.phone,
            `用户 ${row.id} 的手机号密文与历史值不一致，已停止回填`
          );
        } else {
          encrypted = encryption.encrypt(row.phone);
        }
        if (row.phone !== '') {
          assert.ok(
            isV1EncryptedField(encrypted),
            `用户 ${row.id} 未生成有效手机号密文，已停止回填`
          );
        }

        return prisma.$executeRaw`
          UPDATE public.users
          SET phone_encrypted = ${encrypted},
              phone_masked = ${maskUserPhone(row.phone)},
              phone = NULL
          WHERE id = CAST(${row.id} AS uuid)
            AND phone IS NOT DISTINCT FROM ${row.phone}
        `;
      })
    );
    const batchUpdated = results.reduce((total, count) => total + count, 0);
    assert.ok(batchUpdated > 0, '用户手机号回填没有取得进展，已停止以避免无限重试');
    updated += batchUpdated;
  }
}

async function verifyEncryptedPhones(prisma, encryption) {
  const pendingRows = await prisma.$queryRaw`
    SELECT count(*)::int AS count
    FROM public.users
    WHERE phone IS NOT NULL
  `;
  assert.equal(pendingRows[0]?.count, 0, '仍有用户手机号使用历史明文列');

  let cursor;
  while (true) {
    const encryptedRows = cursor
      ? await prisma.$queryRaw`
          SELECT id::text AS id,
                 phone_encrypted AS "phoneEncrypted",
                 phone_masked AS "phoneMasked"
          FROM public.users
          WHERE phone_encrypted IS NOT NULL
            AND id > CAST(${cursor} AS uuid)
          ORDER BY id
          LIMIT ${BATCH_SIZE}
        `
      : await prisma.$queryRaw`
          SELECT id::text AS id,
                 phone_encrypted AS "phoneEncrypted",
                 phone_masked AS "phoneMasked"
          FROM public.users
          WHERE phone_encrypted IS NOT NULL
          ORDER BY id
          LIMIT ${BATCH_SIZE}
        `;
    if (encryptedRows.length === 0) break;
    for (const row of encryptedRows) {
      assert.ok(isV1EncryptedField(row.phoneEncrypted), `用户 ${row.id} 的手机号密文格式无效`);
      const decrypted = encryption.decrypt(row.phoneEncrypted);
      assert.ok(decrypted, `用户 ${row.id} 的手机号密文无法解密`);
      assert.ok(
        maskUserPhone(decrypted) === row.phoneMasked,
        `用户 ${row.id} 的手机号脱敏值与密文不一致`
      );
    }
    cursor = encryptedRows.at(-1).id;
  }

  await prisma.$executeRawUnsafe(
    'ALTER TABLE public.users VALIDATE CONSTRAINT users_phone_plaintext_forbidden'
  );
  const constraintRows = await prisma.$queryRaw`
    SELECT convalidated AS validated
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_phone_plaintext_forbidden'
  `;
  assert.equal(constraintRows.length, 1, '缺少 users_phone_plaintext_forbidden 数据库约束');
  assert.equal(constraintRows[0].validated, true, '用户手机号明文禁止约束尚未验证');
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');
  assert.ok(process.env.DATABASE_URL, '缺少 DATABASE_URL');
  assert.ok(
    (process.env.FIELD_ENCRYPTION_KEY?.trim().length ?? 0) >= 32,
    'FIELD_ENCRYPTION_KEY 必须至少 32 个字符'
  );

  const prisma = new PrismaClient();
  const encryption = createEncryptionService();
  try {
    const updated = await backfillPlaintextPhones(prisma, encryption);
    await verifyEncryptedPhones(prisma, encryption);
    console.log(`用户手机号加密回填完成：${updated} 条，历史明文 0 条，约束已验证`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
