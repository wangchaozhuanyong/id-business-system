import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811100000_data_lifecycle_integrity_hardening/migration.sql'
  ),
  'utf8'
);

describe('ID Business V2 data lifecycle schema contract', () => {
  it('stores immutable order display snapshots through an incremental migration', () => {
    expect(schema).toContain('model IdBusinessV2OrderDisplaySnapshot');
    expect(migration).toContain('CREATE TABLE public.id_business_v2_order_display_snapshots');
    expect(migration).toContain('capture_id_business_v2_order_display_snapshot');
    expect(migration).toContain('id_business_v2_order_display_snapshot_immutable');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
  });

  it('keeps finance expense writes compatible while freezing historical display names', () => {
    expect(schema).toContain('categoryNameSnapshot');
    expect(schema).toContain('financeAccountNameSnapshot');
    expect(migration).toContain('protect_id_business_v2_finance_expense_display_snapshot');
    expect(migration).toContain('BEFORE INSERT OR UPDATE');
    expect(migration).toContain('SELECT name INTO NEW.category_name_snapshot');
  });

  it('marks supplier wallets so restore cannot enable manually disabled wallets', () => {
    expect(schema).toContain('disabledByOptionDeletionAt');
    expect(schema).toContain('statusBeforeDeletion');
    expect(schema).toContain('deletedByParentOptionId');
    expect(migration).toContain('disabled_by_option_deletion_at');
    expect(migration).toContain('status_before_deletion');
    expect(migration).toContain('deleted_by_parent_option_id');
  });

  it('makes audit history immutable and explicitly reconciles legacy audit gaps', () => {
    expect(migration).toContain('audit_logs_immutable');
    expect(migration).toContain('protect_audit_log_immutability');
    expect(migration).toContain('historicalActorKnown');
    expect(migration).toContain('id_business_v2.integrity.legacy_soft_delete_reconciled');
  });

  it('revokes broad runtime delete privileges and keeps a narrow allowlist', () => {
    expect(migration).toContain(
      'REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM id_business_v2_runtime'
    );
    expect(migration).not.toMatch(
      /GRANT DELETE ON TABLE[\s\S]*public\.id_business_v2_(?:orders|customers|options|accounts),/i
    );
  });

  it('contains no destructive table or column removal', () => {
    expect(migration).not.toMatch(/TRUNCATE\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });
});
