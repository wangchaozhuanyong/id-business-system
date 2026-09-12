import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { V2_DATA_INTEGRITY_CHECKS } from './lib/v2-data-integrity-audit.mjs';

const databaseUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const enabled = Boolean(databaseUrl?.includes('/id_business_v2_rollback_integrity_'));
let client;
if (enabled) {
  const target = new URL(databaseUrl);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /^\/id_business_v2_rollback_integrity_\d+$/);
  client = new PrismaClient({ datasourceUrl: databaseUrl });
}
after(async () => {
  await client?.$disconnect();
});
const query = V2_DATA_INTEGRITY_CHECKS.find(
  (check) => check.code === 'balance_ledger_reversal_mismatch'
).sql;
const original = {
  id: 'original',
  account_id: 'account',
  order_id: 'order',
  gift_card_id: null,
  entry_type: 'order_consumption',
  direction: 'debit',
  balance_amount: '20',
  cost_amount: '60',
  balance_before: '50',
  balance_after: '30',
  cost_before: '150',
  cost_after: '90',
  reversal_of_entry_id: null
};
const refund = {
  ...original,
  id: 'reversal',
  entry_type: 'order_consumption_reversal',
  direction: 'credit',
  balance_amount: '10',
  cost_amount: '30',
  balance_before: '30',
  balance_after: '40',
  cost_before: '90',
  cost_after: '120',
  reversal_of_entry_id: 'original'
};
const giftOriginal = {
  ...original,
  entry_type: 'gift_card_credit',
  direction: 'credit',
  order_id: null,
  gift_card_id: 'gift-card',
  balance_amount: '20',
  cost_amount: '108',
  balance_before: '130',
  balance_after: '150',
  cost_before: '732',
  cost_after: '840'
};
const withdrawal = {
  ...giftOriginal,
  id: 'reversal',
  entry_type: 'gift_card_withdrawal',
  direction: 'debit',
  balance_amount: '20',
  cost_amount: '112',
  balance_before: '150',
  balance_after: '130',
  cost_before: '840',
  cost_after: '728',
  reversal_of_entry_id: 'original'
};
const upgradeOriginal = {
  ...refund,
  id: 'original',
  entry_type: 'order_upgrade_balance_return',
  reversal_of_entry_id: null
};
const upgradeReversal = {
  ...upgradeOriginal,
  id: 'reversal',
  entry_type: 'order_upgrade_balance_return_reversal',
  direction: 'debit',
  balance_before: '50',
  balance_after: '40',
  cost_before: '200',
  cost_after: '170',
  reversal_of_entry_id: 'original'
};

function sqlRow(row) {
  return (
    'SELECT ' +
    Object.entries(row)
      .map(([key, value]) => {
        const literal = value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
        const expression = /^(balance|cost)_/.test(key)
          ? `CAST(${literal} AS DECIMAL(18,4))`
          : literal;
        return `${expression} AS ${key}`;
      })
      .join(', ')
  );
}
async function check(originalRow, reversalRow, priorReturn = false) {
  const fixtures = `WITH id_business_v2_balance_ledger AS (${sqlRow(originalRow)} UNION ALL ${sqlRow(reversalRow)}),
    id_business_v2_order_balance_returns AS (SELECT 'order' AS order_id, 5 AS returned_balance_amount,
      15 AS restored_balance_cost_amount, 'active' AS status ${priorReturn ? '' : 'WHERE FALSE'}), `;
  return client.$queryRawUnsafe(fixtures + query.replace(/^WITH\s+/, ''));
}
const validCases = [
  ['partial order refund', original, refund, false],
  ['partial refund after prior upgrade return', original, refund, true],
  [
    'remaining full refund after prior upgrade return',
    original,
    { ...refund, balance_amount: '15', cost_amount: '45', balance_after: '45', cost_after: '135' },
    true
  ],
  ['weighted-cost gift withdrawal', giftOriginal, withdrawal, false],
  [
    'weighted-cost gift redemption',
    giftOriginal,
    { ...withdrawal, entry_type: 'gift_card_redeemed' },
    false
  ],
  [
    'full-balance gift withdrawal clears all remaining cost',
    giftOriginal,
    {
      ...withdrawal,
      balance_before: '20',
      balance_after: '0',
      cost_before: '111.9999',
      cost_after: '0',
      cost_amount: '111.9999'
    },
    false
  ],
  [
    'exact upgrade reversal after subsequent balance changes',
    upgradeOriginal,
    upgradeReversal,
    false
  ]
];
for (const [name, source, reversal, priorReturn] of validCases) {
  test(`MySQL reversal audit accepts ${name}`, { skip: !enabled }, async () => {
    assert.equal((await check(source, reversal, priorReturn)).length, 0);
  });
}
const invalidCases = [
  ['wrong account', original, { ...refund, account_id: 'wrong' }],
  ['wrong order', original, { ...refund, order_id: 'wrong' }],
  ['missing original link', original, { ...refund, reversal_of_entry_id: null }],
  [
    'wrong direction',
    original,
    { ...refund, direction: 'debit', balance_after: '20', cost_after: '60' }
  ],
  [
    'excess refund',
    original,
    { ...refund, balance_amount: '21', cost_amount: '63', balance_after: '51', cost_after: '153' }
  ],
  ['incorrect refunded cost', original, { ...refund, cost_amount: '31', cost_after: '121' }],
  ['wrong gift card', giftOriginal, { ...withdrawal, gift_card_id: 'wrong' }],
  [
    'wrong gift face value',
    giftOriginal,
    {
      ...withdrawal,
      balance_amount: '10',
      cost_amount: '56',
      balance_after: '140',
      cost_after: '784'
    }
  ],
  [
    'incorrect weighted gift cost',
    giftOriginal,
    { ...withdrawal, cost_amount: '108', cost_after: '732' }
  ],
  ['inconsistent ledger ending balance', giftOriginal, { ...withdrawal, balance_after: '129' }],
  [
    'inexact upgrade reversal cost',
    upgradeOriginal,
    { ...upgradeReversal, cost_amount: '40', cost_after: '160' }
  ],
  ['unknown reversal family', original, { ...refund, entry_type: 'manual_adjustment' }]
];
for (const [name, source, reversal] of invalidCases) {
  test(`MySQL reversal audit rejects ${name}`, { skip: !enabled }, async () => {
    assert.equal((await check(source, reversal)).length, 1);
  });
}
