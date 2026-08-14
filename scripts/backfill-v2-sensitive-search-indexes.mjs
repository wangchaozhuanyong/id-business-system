#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
const {
  FieldEncryptionService
} = require('../apps/api/dist/common/crypto/field-encryption.service.js');
const {
  buildIdBusinessV2BlindIndexTokens
} = require('../apps/api/dist/id-business-v2/runtime/id-business-v2-blind-search.js');

const BATCH_SIZE = 250;

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
    // Missing configuration is reported before connecting.
  }
}

function makeEncryptionService() {
  return new FieldEncryptionService({
    get: (key) => process.env[key]
  });
}

async function backfillAccounts(prisma, encryption) {
  let updated = 0;
  while (true) {
    const rows = await prisma.idBusinessV2Account.findMany({
      where: {
        OR: [
          { appleIdSearchTokens: { isEmpty: true } },
          { phoneEncrypted: { not: null }, phoneSearchTokens: { isEmpty: true } }
        ]
      },
      select: { id: true, appleIdEncrypted: true, phoneEncrypted: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE
    });
    if (rows.length === 0) break;

    await prisma.$transaction(
      rows.map((row) => {
        const appleId = encryption.decrypt(row.appleIdEncrypted);
        const phone = encryption.decrypt(row.phoneEncrypted);
        assert.ok(appleId, `ID ${row.id} 缺少可解密账号`);
        return prisma.idBusinessV2Account.update({
          where: { id: row.id },
          data: {
            appleIdSearchTokens: buildIdBusinessV2BlindIndexTokens(appleId, 'apple-id', (value) =>
              encryption.hash(value)
            ),
            phoneSearchTokens: buildIdBusinessV2BlindIndexTokens(phone, 'account-phone', (value) =>
              encryption.hash(value)
            )
          }
        });
      })
    );
    updated += rows.length;
  }
  return updated;
}

async function backfillOrders(prisma, encryption) {
  let updated = 0;
  while (true) {
    const rows = await prisma.idBusinessV2Order.findMany({
      where: {
        websiteAccountEncrypted: { not: null },
        websiteAccountSearchTokens: { isEmpty: true }
      },
      select: { id: true, websiteAccountEncrypted: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE
    });
    if (rows.length === 0) break;

    await prisma.$transaction(
      rows.map((row) => {
        const websiteAccount = encryption.decrypt(row.websiteAccountEncrypted);
        assert.ok(websiteAccount, `订单 ${row.id} 缺少可解密网站账号`);
        return prisma.idBusinessV2Order.update({
          where: { id: row.id },
          data: {
            websiteAccountSearchTokens: buildIdBusinessV2BlindIndexTokens(
              websiteAccount,
              'website-account',
              (value) => encryption.hash(value)
            )
          }
        });
      })
    );
    updated += rows.length;
  }
  return updated;
}

function maskPhone(value) {
  if (!value) return null;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskContact(value) {
  if (!value) return null;
  if (value.length <= 2) return '*'.repeat(value.length);
  if (value.length <= 5) return `${value.slice(0, 1)}***${value.slice(-1)}`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

async function backfillCustomers(prisma, encryption) {
  let updated = 0;
  let cursor;
  while (true) {
    const rows = await prisma.idBusinessV2Customer.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      select: {
        id: true,
        phoneEncrypted: true,
        wechat: true,
        wechatEncrypted: true,
        qq: true,
        qqEncrypted: true,
        whatsappEncrypted: true
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE
    });
    if (rows.length === 0) break;

    await prisma.$transaction(
      rows.map((row) => {
        const phone = encryption.decrypt(row.phoneEncrypted);
        const wechat = encryption.decrypt(row.wechatEncrypted) ?? row.wechat;
        const qq = encryption.decrypt(row.qqEncrypted) ?? row.qq;
        const whatsapp = encryption.decrypt(row.whatsappEncrypted);
        return prisma.idBusinessV2Customer.update({
          where: { id: row.id },
          data: {
            phoneSearchTokens: buildIdBusinessV2BlindIndexTokens(phone, 'customer-phone', (value) =>
              encryption.hash(value)
            ),
            wechat: null,
            wechatEncrypted: encryption.encrypt(wechat),
            wechatHash: encryption.hash(wechat),
            wechatMasked: maskContact(wechat),
            wechatSearchTokens: buildIdBusinessV2BlindIndexTokens(
              wechat,
              'customer-wechat',
              (value) => encryption.hash(value)
            ),
            qq: null,
            qqEncrypted: encryption.encrypt(qq),
            qqHash: encryption.hash(qq),
            qqMasked: maskContact(qq),
            qqSearchTokens: buildIdBusinessV2BlindIndexTokens(qq, 'customer-qq', (value) =>
              encryption.hash(value)
            ),
            whatsappSearchTokens: buildIdBusinessV2BlindIndexTokens(
              whatsapp,
              'customer-whatsapp',
              (value) => encryption.hash(value)
            ),
            phoneMasked: maskPhone(phone),
            whatsappMasked: maskPhone(whatsapp)
          }
        });
      })
    );
    updated += rows.length;
    cursor = rows.at(-1).id;
  }
  return updated;
}

async function backfillGiftCards(prisma, encryption) {
  let updated = 0;
  while (true) {
    const rows = await prisma.idBusinessV2GiftCard.findMany({
      where: { codeSearchTokens: { isEmpty: true } },
      select: { id: true, codeEncrypted: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE
    });
    if (rows.length === 0) break;

    await prisma.$transaction(
      rows.map((row) => {
        const code = encryption.decrypt(row.codeEncrypted);
        assert.ok(code, `礼品卡 ${row.id} 缺少可解密卡号`);
        return prisma.idBusinessV2GiftCard.update({
          where: { id: row.id },
          data: {
            codeSearchTokens: buildIdBusinessV2BlindIndexTokens(code, 'gift-card-code', (value) =>
              encryption.hash(value)
            )
          }
        });
      })
    );
    updated += rows.length;
  }
  return updated;
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('apps/api/.env');
  assert.ok(process.env.DATABASE_URL, '缺少 DATABASE_URL');
  assert.ok(process.env.FIELD_ENCRYPTION_KEY, '缺少 FIELD_ENCRYPTION_KEY');
  assert.ok(process.env.HASH_SECRET, '缺少 HASH_SECRET');

  const prisma = new PrismaClient();
  const encryption = makeEncryptionService();
  try {
    const accounts = await backfillAccounts(prisma, encryption);
    const customers = await backfillCustomers(prisma, encryption);
    const orders = await backfillOrders(prisma, encryption);
    const giftCards = await backfillGiftCards(prisma, encryption);
    const [
      missingAccounts,
      missingAccountPhones,
      legacyCustomers,
      missingOrders,
      missingGiftCards
    ] = await Promise.all([
      prisma.idBusinessV2Account.count({
        where: { appleIdSearchTokens: { isEmpty: true } }
      }),
      prisma.idBusinessV2Account.count({
        where: { phoneEncrypted: { not: null }, phoneSearchTokens: { isEmpty: true } }
      }),
      prisma.idBusinessV2Customer.count({
        where: { OR: [{ wechat: { not: null } }, { qq: { not: null } }] }
      }),
      prisma.idBusinessV2Order.count({
        where: {
          websiteAccountEncrypted: { not: null },
          websiteAccountSearchTokens: { isEmpty: true }
        }
      }),
      prisma.idBusinessV2GiftCard.count({
        where: { codeSearchTokens: { isEmpty: true } }
      })
    ]);
    assert.equal(missingAccounts, 0, '仍有 ID 账号未生成搜索索引');
    assert.equal(missingAccountPhones, 0, '仍有 ID 手机号未生成搜索索引');
    assert.equal(legacyCustomers, 0, '仍有客户微信或 QQ 使用明文存储');
    assert.equal(missingOrders, 0, '仍有订单网站账号未生成搜索索引');
    assert.equal(missingGiftCards, 0, '仍有礼品卡号未生成搜索索引');
    console.log(
      `敏感搜索索引回填完成：ID ${accounts} 条，客户 ${customers} 条，订单 ${orders} 条，礼品卡 ${giftCards} 条`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
