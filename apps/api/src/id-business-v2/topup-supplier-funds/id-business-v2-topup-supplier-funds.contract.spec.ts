import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERMISSIONS_KEY } from '../../auth/auth.decorators';
import { IdBusinessV2GiftCardsController } from '../gift-cards/id-business-v2-gift-cards.controller';
import { IdBusinessV2TopupSupplierFundsController } from './id-business-v2-topup-supplier-funds.controller';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729100000_topup_supplier_funds/migration.sql'),
  'utf8'
);
const financeMigration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729110000_finance_closed_loop/migration.sql'),
  'utf8'
);

describe('V2 topup supplier fund contracts', () => {
  it('keeps funds immutable, decimal-backed and linked to payments and gift cards', () => {
    expect(migration).toContain('CREATE TABLE "id_business_v2_topup_supplier_accounts"');
    expect(migration).toContain('CREATE TABLE "id_business_v2_topup_supplier_payments"');
    expect(migration).toContain('CREATE TABLE "id_business_v2_topup_supplier_ledger"');
    expect(migration).toContain('"received_usdt" DECIMAL(18,4)');
    expect(migration).toContain('"settlement_rate_cny_usdt" DECIMAL(18,8)');
    expect(migration).toContain('"balance_before_cny" DECIMAL(18,4)');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('Topup supplier financial records are immutable');
    expect(migration).toContain('"reversal_of_entry_id" UUID');
  });

  it('installs permissions, realtime scopes and historical snapshots', () => {
    expect(migration).toContain('apple.topup_supplier_fund.view');
    expect(migration).toContain('apple.topup_supplier_fund.manage');
    expect(migration).toContain('apple.gift_card.view_full');
    expect(migration).toContain("'supplier-funds'");
    expect(migration).toContain("'supplier-payments'");
    expect(migration).toContain('"country_name_snapshot"');
    expect(migration).toContain('"supplier_name_snapshot"');
  });

  it('temporarily suspends immutability only while the next migration backfills generic amounts', () => {
    expect(financeMigration).toContain(
      'DROP TRIGGER IF EXISTS id_business_v2_topup_supplier_payments_immutable'
    );
    expect(financeMigration).toContain(
      'DROP TRIGGER IF EXISTS id_business_v2_topup_supplier_ledger_immutable'
    );
    expect(
      financeMigration.match(/CREATE TRIGGER id_business_v2_topup_supplier_payments_immutable/g)
    ).toHaveLength(1);
    expect(
      financeMigration.match(/CREATE TRIGGER id_business_v2_topup_supplier_ledger_immutable/g)
    ).toHaveLength(1);
  });

  it('protects reads and mutations with the dedicated permissions', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        IdBusinessV2TopupSupplierFundsController.prototype.listSuppliers
      )
    ).toEqual(['apple.topup_supplier_fund.view']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        IdBusinessV2TopupSupplierFundsController.prototype.createPayment
      )
    ).toEqual(['apple.topup_supplier_fund.manage']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        IdBusinessV2GiftCardsController.prototype.reassignSupplier
      )
    ).toEqual(['apple.balance.adjust', 'apple.topup_supplier_fund.manage']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2GiftCardsController.prototype.revealCode)
    ).toEqual(['apple.gift_card.view_full']);
  });
});
