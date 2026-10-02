import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.hostname, '127.0.0.1');
assert.match(database.pathname, /^\/id_names_qa/);
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const {
  RechargeNameRepository
} = require('../apps/api/dist/id-business-v2/auto-recharge/persistence/recharge-name.repository.js');
const {
  RechargeNameService
} = require('../apps/api/dist/id-business-v2/auto-recharge/recharge-name.service.js');
const {
  RechargeCardRemovalRepository
} = require('../apps/api/dist/id-business-v2/auto-recharge/persistence/recharge-card-removal.repository.js');
const {
  RechargeCardRemovalService
} = require('../apps/api/dist/id-business-v2/auto-recharge/recharge-card-removal.service.js');
const {
  BankRechargeRepository
} = require('../apps/api/dist/id-business-v2/auto-recharge/persistence/bank-recharge.repository.js');
const {
  listChatgptAccounts
} = require('../apps/api/dist/id-business-v2/auto-recharge/bank-recharge-account-list.js');
const prisma = new PrismaClient();
const audits = [];
const audit = {
  append: async (_tx, value) => {
    audits.push(value);
  }
};
const encryption = {
  encrypt: (value) => (value ? `fixture-encrypted:${Buffer.from(value).toString('base64')}` : null),
  decrypt: (value) =>
    value ? Buffer.from(value.replace('fixture-encrypted:', ''), 'base64').toString() : null,
  hash: (value) => (value ? createHash('sha256').update(value).digest('hex') : null)
};
const transactions = {
  execute: (work) =>
    prisma.$transaction(work, { isolationLevel: 'Serializable', timeout: 60000, maxWait: 60000 })
};
const operator = { id: randomUUID() };
const names = new RechargeNameService(
  new RechargeNameRepository(prisma),
  transactions,
  audit,
  encryption
);
const removal = new RechargeCardRemovalService(
  new RechargeCardRemovalRepository(),
  transactions,
  audit,
  names,
  encryption
);
const output = path.resolve(process.cwd(), process.env.QA_OUTPUT_DIR || '.runtime/name-library-qa');
assert.ok(output.startsWith(`${process.cwd()}${path.sep}`), '验收输出必须位于当前项目');
mkdirSync(output, { recursive: true });
try {
  assert.equal(await prisma.idBusinessV2RechargeName.count(), 0, '必须使用空的临时验收库');
  await names.import(
    { names: ['Alice Example', 'Bob Example', 'Chen Example', 'Alice Example'] },
    operator
  );
  const numbers = ['4111111111111111', '5555555555554444', '4242424242424242'];
  const matched = await Promise.all(numbers.map((number) => names.match({ number }, operator)));
  assert.deepEqual(
    new Set(matched.map((value) => value.name)),
    new Set(['Alice Example', 'Bob Example', 'Chen Example'])
  );
  const fourth = await names.match({ number: '378282246310005' }, operator);
  assert.equal(fourth.name, 'Alice Example');
  const countBefore = await prisma.idBusinessV2RechargeName.aggregate({
    _sum: { matchCount: true }
  });
  assert.equal((await names.match({ number: numbers[0] }, operator)).name, matched[0].name);
  assert.deepEqual(
    await prisma.idBusinessV2RechargeName.aggregate({ _sum: { matchCount: true } }),
    countBefore
  );
  await prisma.idBusinessV2BankRechargeCurrency.upsert({
    where: { code: 'USD' },
    create: { code: 'USD', name: '美元', minorUnits: 2 },
    update: {}
  });
  const card = await transactions.execute((tx) =>
    names.prepareCard(
      tx,
      { number: numbers[0], name: matched[0].name, expiry: '12/39', currencyCode: 'USD' },
      operator
    )
  );
  await prisma.idBusinessV2BankRechargeCard.update({
    where: { id: card.id },
    data: { billingNameEncrypted: encryption.encrypt(matched[0].name) }
  });
  await transactions.execute((tx) =>
    names.confirm(tx, encryption.hash(numbers[0]), encryption.encrypt(matched[0].name))
  );
  const accounts = [];
  for (let i = 0; i < 2; i++) {
    const account = await prisma.idBusinessV2ChatgptAccount.create({
      data: {
        emailEncrypted: encryption.encrypt(`test-${i}@example.invalid`),
        emailHash: encryption.hash(`test-${i}@example.invalid`),
        emailMasked: `te***${i}@example.invalid`
      }
    });
    accounts.push(account);
    await prisma.idBusinessV2BankRechargeOrder.create({
      data: {
        orderNo: `QA-${randomUUID()}`,
        source: 'automatic',
        accountId: account.id,
        cardId: card.id,
        plan: 'plus',
        chargeAmount: '10.00',
        chargeCurrencyCode: 'USD',
        openedAt: new Date(),
        verifiedAt: new Date()
      }
    });
  }
  const job = await prisma.idBusinessV2RechargeJob.create({
    data: {
      id: randomUUID(),
      ownerId: operator.id,
      cardId: card.id,
      plan: 'plus',
      action: 'server',
      state: 'finished',
      leaseUntil: new Date(),
      result: {}
    }
  });
  const before = await listChatgptAccounts({}, new BankRechargeRepository(prisma), encryption);
  assert.ok(
    before.items.every(
      (account) =>
        !account.openingCard.deleted && account.openingCard.numberSummary === '4*******11111111'
    )
  );
  const preview = await removal.preview(accounts[0].id, operator);
  assert.equal(preview.linkedAccountCount, 2);
  await removal.remove(
    accounts[0].id,
    {
      cardId: preview.cardId,
      orderId: preview.orderId,
      linkedAccountCount: preview.linkedAccountCount,
      orderCount: preview.orderCount,
      expectedUpdatedAt: preview.expectedUpdatedAt
    },
    operator
  );
  assert.equal(
    await prisma.idBusinessV2BankRechargeCard.findUnique({ where: { id: card.id } }),
    null
  );
  assert.equal(
    (await prisma.idBusinessV2RechargeJob.findUnique({ where: { id: job.id } })).cardId,
    null
  );
  const orders = await prisma.idBusinessV2BankRechargeOrder.findMany();
  assert.equal(orders.length, 2);
  assert.ok(
    orders.every(
      (order) =>
        order.cardId === null &&
        order.cardLast4 === '1111' &&
        order.cardLabelSnapshot === card.label &&
        order.cardDeletedAt !== null &&
        encryption.decrypt(order.cardNumberSummaryEncrypted) === '4*******11111111'
    )
  );
  assert.equal(await prisma.idBusinessV2ChatgptAccount.count(), 2);
  const listing = await listChatgptAccounts({}, new BankRechargeRepository(prisma), encryption);
  assert.ok(
    listing.items.every(
      (account) =>
        account.openingCard.deleted &&
        account.openingCard.last4 === '1111' &&
        account.openingCard.numberSummary === '4*******11111111'
    )
  );
  assert.equal((await names.match({ number: numbers[0] }, operator)).name, matched[0].name);
  for (const number of numbers) assert.ok(!JSON.stringify(audits).includes(number));
  const result = {
    ok: true,
    concurrentMatches: 3,
    cyclicRotation: true,
    repeatDoesNotAdvance: true,
    removedCardRows: 1,
    preservedAccounts: 2,
    preservedOrders: 2,
    jobForeignKeySetNull: true,
    deletedCardNameRecall: true,
    auditsContainNoCardNumbers: true
  };
  writeFileSync(path.join(output, 'mysql-integration.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
