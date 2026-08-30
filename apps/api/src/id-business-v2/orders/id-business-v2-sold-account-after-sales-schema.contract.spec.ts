import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260812100000_sold_account_after_sales/migration.sql'),
  'utf8'
);

describe('ID Business V2 sold account after-sales schema contract', () => {
  it('stores order source, original sale evidence and the actually applied ID cost', () => {
    expect(schema).toContain('enum IdBusinessV2OrderAccountSource');
    expect(schema).toMatch(/accountSource\s+IdBusinessV2OrderAccountSource/);
    expect(schema).toMatch(/sourceSoldOrderId\s+String\?/);
    expect(schema).toMatch(/appliedAccountCostAmount\s+Decimal/);
    expect(schema).toContain('IdBusinessV2OrderAfterSalesSource');
    expect(migration).toContain('CREATE TYPE "IdBusinessV2OrderAccountSource"');
    expect(migration).toContain('"source_sold_order_id" UUID');
    expect(migration).toContain('"applied_account_cost_amount" DECIMAL(18, 4)');
  });

  it('backfills only determinable historical ID cost and enforces zero after-sales ID cost', () => {
    expect(migration).toMatch(/WHEN "account_disposition" = 'sold' THEN "account_cost_amount"/);
    expect(migration).toContain('id_business_v2_orders_account_source_check');
    expect(migration).toContain('id_business_v2_orders_applied_account_cost_check');
    expect(migration).toMatch(
      /"account_source" = 'customer_owned'[\s\S]*"source_sold_order_id" IS NOT NULL[\s\S]*"account_disposition" = 'retained'[\s\S]*"account_cost_amount" = 0[\s\S]*"applied_account_cost_amount" = 0/
    );
    expect(migration).toContain('"source_sold_order_id" <> "id"');
  });

  it('uses a restrictive self foreign key and contains no destructive table removal', () => {
    expect(migration).toContain('id_business_v2_orders_source_sold_order_id_fkey');
    expect(migration).toContain('REFERENCES "id_business_v2_orders"("id")');
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).not.toMatch(/TRUNCATE\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });
});
