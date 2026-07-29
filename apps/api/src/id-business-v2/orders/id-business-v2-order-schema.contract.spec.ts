import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(process.cwd());
const schema = readFileSync(resolve(apiRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260729000000_current_system_baseline/migration.sql'),
  'utf8'
);
const accountDispositionMigration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260729070000_order_account_disposition/migration.sql'),
  'utf8'
);

function prismaModel(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `Prisma model ${name} should exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('V2501 order schema contract', () => {
  it('creates current order and ledger enum values in the clean baseline', () => {
    expect(migration).toContain('CREATE TYPE "IdBusinessV2BalanceLedgerEntryType"');
    expect(migration).toContain("'order_consumption'");
    expect(migration).toContain("'order_consumption_reversal'");
    expect(migration).toContain('CREATE TYPE "IdBusinessV2OrderStatus"');
  });

  it('keeps orders, locks, and activations inside the isolated V2 namespace', () => {
    expect(schema).toContain('model IdBusinessV2Order {');
    expect(schema).toContain('model IdBusinessV2AccountLock {');
    expect(schema).toContain('model IdBusinessV2Activation {');
    expect(migration).toContain('CREATE TABLE "id_business_v2_orders"');
    expect(migration).toContain('CREATE TABLE "id_business_v2_account_locks"');
    expect(migration).toContain('CREATE TABLE "id_business_v2_activations"');
    expect(migration).not.toMatch(
      /REFERENCES "(?:apple_orders|apple_account_locks|service_activations)"/
    );
  });

  it('stores financial inputs as Decimal and keeps profit server-owned', () => {
    const order = prismaModel('IdBusinessV2Order');

    for (const field of [
      'receivedAmount',
      'platformFeeAmount',
      'accountCostAmount',
      'balanceAmount',
      'balanceCostAmount'
    ]) {
      expect(order).toMatch(new RegExp(`${field}\\s+Decimal\\s+`));
    }
    expect(order).toMatch(/refundCostAmount\s+Decimal\?/);
    expect(order).toMatch(/profitAmount\s+Decimal\?/);
    expect(migration).toContain('id_business_v2_orders_refund_evidence_check');
    expect(migration).toContain('id_business_v2_orders_completed_evidence_check');
  });

  it('encrypts the customer website account and requires idempotent order identity', () => {
    const order = prismaModel('IdBusinessV2Order');

    expect(order).toContain('websiteAccountEncrypted');
    expect(order).toContain('websiteAccountHash');
    expect(order).toContain('websiteAccountMasked');
    expect(order).not.toMatch(/\bwebsiteAccount\s+/);
    expect(order).toMatch(/orderNo\s+String\s+@unique/);
    expect(order).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(order).toContain(
      '@@unique([settlementPlatformOptionId, platformOrderNo], map: "id_business_v2_orders_platform_order_key")'
    );
  });

  it('enforces active-lock uniqueness and lifecycle evidence in PostgreSQL', () => {
    expect(migration).toContain('id_business_v2_account_locks_active_global_key');
    expect(migration).toContain('id_business_v2_account_locks_active_service_key');
    expect(migration).toContain('id_business_v2_account_locks_active_order_key');
    for (const indexName of [
      'id_business_v2_account_locks_active_global_key',
      'id_business_v2_account_locks_active_service_key',
      'id_business_v2_account_locks_active_order_key'
    ]) {
      expect(migration).toMatch(new RegExp(`${indexName}[\\s\\S]{0,240}WHERE`));
    }
    expect(migration).toContain('id_business_v2_account_locks_scope_check');
    expect(migration).toContain('id_business_v2_account_locks_expiry_check');
    expect(migration).toContain('id_business_v2_account_locks_lifecycle_check');
  });

  it('links order consumption to the immutable balance ledger and one activation', () => {
    const ledger = prismaModel('IdBusinessV2BalanceLedger');
    const activation = prismaModel('IdBusinessV2Activation');

    expect(schema).toContain('order_consumption');
    expect(schema).toContain('order_consumption_reversal');
    expect(ledger).toContain('orderId');
    expect(ledger).toContain('@@unique([orderId, entryType])');
    expect(ledger).not.toMatch(/\bupdatedAt\b|\bdeletedAt\b/);
    expect(migration).toContain('id_business_v2_balance_ledger_business_reference_check');
    expect(migration).toContain("'order_consumption'");
    expect(migration).toContain("'order_consumption_reversal'");
    expect(migration).toContain("'debit'");
    expect(migration).toContain("'credit'");
    expect(activation).toMatch(/orderId\s+String\s+@unique/);
    expect(migration).toContain('id_business_v2_activations_due_at_check');
  });

  it('adds the ID sale lifecycle in an incremental migration without rewriting history', () => {
    const order = prismaModel('IdBusinessV2Order');
    const account = prismaModel('IdBusinessV2Account');

    expect(order).toContain('accountDisposition');
    expect(account).toContain('soldByOrderId');
    expect(account).toContain('soldAt');
    expect(accountDispositionMigration).toContain(
      'CREATE TYPE "IdBusinessV2OrderAccountDisposition"'
    );
    expect(accountDispositionMigration).toContain(
      'ADD COLUMN "account_disposition" "IdBusinessV2OrderAccountDisposition" NOT NULL DEFAULT \'retained\''
    );
    expect(accountDispositionMigration).toContain('"sold_by_order_id" UUID');
    expect(accountDispositionMigration).toContain('id_business_v2_accounts_sale_evidence_check');
    expect(migration).not.toContain('account_disposition');
  });
});
