import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const model = schema.match(/model IdBusinessV2RechargeAddress \{[\s\S]*?\n\}/)?.[0] ?? '';
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260909100000_auto_recharge_addresses/migration.sql'
  ),
  'utf8'
);

describe('auto recharge address schema contract', () => {
  it('stores only address inventory with a fixed location and controlled status', () => {
    expect(model).toContain('model IdBusinessV2RechargeAddress {');
    expect(model).toContain('@@unique([ownerId, line1])');
    expect(model).not.toMatch(/cardNumber|card_number|cvc|securityCode/);
    expect(migration).toContain("CHECK (`country` = 'US'");
    expect(migration).toContain("`city` = 'Portland'");
    expect(migration).toContain("`state` = 'OR'");
    expect(migration).toContain("`postal_code` = '97204'");
    expect(migration).toContain("CHECK (`status` IN ('unused', 'used', 'disabled'))");
  });

  it('keeps the migration forward-only', () => {
    expect(migration).toContain('CREATE TABLE `id_business_v2_recharge_addresses`');
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });
});
