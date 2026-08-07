import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const ledgerTypeMigration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729085000_account_loss_ledger_type/migration.sql'),
  'utf8'
);
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729090000_account_loss/migration.sql'),
  'utf8'
);
const freezeReversalMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260806100000_account_loss_freeze_reversal/migration.sql'
  ),
  'utf8'
);

describe('ID Business V2 account loss schema contract', () => {
  it('adds an account loss timestamp and immutable account-loss ledger type', () => {
    expect(schema).toContain('account_loss');
    expect(schema).toMatch(/lossReportedAt\s+DateTime\?/);
    expect(ledgerTypeMigration).toContain('ALTER TYPE "IdBusinessV2BalanceLedgerEntryType"');
    expect(ledgerTypeMigration).toContain("ADD VALUE IF NOT EXISTS 'account_loss'");
    expect(migration).not.toContain('ALTER TYPE "IdBusinessV2BalanceLedgerEntryType"');
    expect(migration).toContain('ADD COLUMN "loss_reported_at" TIMESTAMPTZ(6)');
  });

  it('keeps immutable loss snapshots while the account points at only one active loss', () => {
    expect(schema).toContain('model IdBusinessV2AccountLoss {');
    expect(schema).toMatch(/accountId\s+String\s+@map\("account_id"\)/);
    expect(schema).toMatch(/ledgerEntryId\s+String\s+@unique/);
    expect(schema).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(schema).toContain('status                   IdBusinessV2AccountLossStatus');
    expect(schema).toMatch(/previousStatusOptionId\s+String\?/);
    expect(schema).toMatch(/previousRecordStatus\s+IdBusinessV2RecordStatus\?/);
    expect(schema).toMatch(/financeJournalId\s+String\?\s+@unique/);
    expect(schema).toMatch(/reversalFinanceJournalId\s+String\?\s+@unique/);
    expect(schema).toMatch(/activeLossRecordId\s+String\?\s+@unique/);
    expect(schema).toMatch(/soldOrderId\s+String\?/);
    expect(schema).toMatch(/reportedByName\s+String\?/);
    expect(migration).toContain('id_business_v2_account_losses_account_id_key');
    expect(migration).toContain('id_business_v2_account_losses_ledger_entry_id_key');
    expect(migration).toContain('id_business_v2_account_losses_immutable');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(freezeReversalMigration).toContain(
      'DROP INDEX IF EXISTS "id_business_v2_account_losses_account_id_key"'
    );
    expect(freezeReversalMigration).toContain(
      'CREATE UNIQUE INDEX "id_business_v2_accounts_active_loss_record_id_key"'
    );
    expect(freezeReversalMigration).toContain(
      'CREATE INDEX "id_business_v2_account_losses_status_reported_at_idx"'
    );
    expect(freezeReversalMigration).toContain('OLD.loss_reported_at IS NOT NULL');
    expect(freezeReversalMigration).toContain('NEW.loss_reported_at IS NULL');
    expect(freezeReversalMigration).toContain('loss_record.id = NEW.active_loss_record_id');
    expect(
      freezeReversalMigration.indexOf(
        'DROP TRIGGER IF EXISTS id_business_v2_account_losses_immutable'
      )
    ).toBeLessThan(freezeReversalMigration.indexOf('UPDATE "id_business_v2_account_losses" loss'));
    expect(
      freezeReversalMigration.indexOf(
        'DROP TRIGGER IF EXISTS id_business_v2_accounts_permanent_loss'
      )
    ).toBeLessThan(freezeReversalMigration.indexOf('UPDATE "id_business_v2_accounts" account'));
    expect(migration).toContain('id_business_v2_account_losses_amount_check');
    expect(migration).toContain('id_business_v2_account_losses_reason_check');
    expect(migration).toContain('id_business_v2_account_losses_sale_evidence_check');
    expect(migration).not.toMatch(
      /ALTER TABLE "id_business_v2_account_losses".*ADD COLUMN "updated_at"/s
    );
  });

  it('keeps account-loss ledger entries standalone and allows new zero-value adjustment snapshots', () => {
    expect(migration).toContain(
      'DROP CONSTRAINT "id_business_v2_balance_ledger_business_reference_check"'
    );
    expect(migration).toMatch(
      /entry_type = 'account_loss'.*direction = 'debit'.*gift_card_id IS NULL.*order_id IS NULL.*reversal_of_entry_id IS NULL/s
    );
    expect(freezeReversalMigration).toMatch(
      /entry_type = 'account_loss'.*direction = ANY.*'debit'.*'adjustment'.*gift_card_id IS NULL.*order_id IS NULL.*reversal_of_entry_id IS NULL/s
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "id_business_v2_balance_ledger_movement_amount_check"'
    );
    expect(migration).toMatch(
      /entry_type = 'account_loss'.*balance_amount = 0::numeric.*cost_amount = 0::numeric/s
    );
  });

  it('registers a dedicated real-time scope without backfilling frozen IDs', () => {
    expect(migration).toContain("VALUES ('account-losses', 0)");
    expect(migration).toContain('CREATE TRIGGER id_business_v2_account_losses_change');
    expect(migration).not.toMatch(/UPDATE "id_business_v2_accounts".*"loss_reported_at"/s);
  });
});
