import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const baseline = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729000000_current_system_baseline/migration.sql'),
  'utf8'
);
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260731010000_data_governance_workflow/migration.sql'),
  'utf8'
);
const updatedAtMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260731011000_data_governance_updated_at_defaults/migration.sql'
  ),
  'utf8'
);
const previewGuardsMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260731012000_data_governance_preview_guards/migration.sql'
  ),
  'utf8'
);

describe('ID Business V2 data governance schema contract', () => {
  it('adds the workflow only through a new incremental migration', () => {
    expect(baseline).not.toContain('id_business_v2_governance_');
    for (const model of [
      'IdBusinessV2GovernanceJob',
      'IdBusinessV2GovernanceJobItem',
      'IdBusinessV2GovernanceApproval',
      'IdBusinessV2GovernanceCheckpoint'
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
    for (const table of [
      'id_business_v2_governance_jobs',
      'id_business_v2_governance_job_items',
      'id_business_v2_governance_approvals',
      'id_business_v2_governance_checkpoints'
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('binds one immutable approval to the preview and separates requester from approver', () => {
    expect(migration).toContain('id_business_v2_governance_approval_guard');
    expect(migration).toContain('governance_job.requested_by_user_id = NEW.approver_user_id');
    expect(migration).toContain('governance_job.preview_hash <> NEW.preview_hash');
    expect(migration).toContain('id_business_v2_governance_approvals_job_id_key');
    expect(migration).toContain('id_business_v2_governance_approval_immutable');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(previewGuardsMigration).toContain('id_business_v2_governance_job_preview_immutable');
    expect(previewGuardsMigration).toContain('id_business_v2_governance_item_identity_immutable');
  });

  it('stores item outcomes and resumable execution checkpoints', () => {
    expect(schema).toContain('enum IdBusinessV2GovernanceItemStatus');
    expect(schema).toContain('enum IdBusinessV2GovernanceCheckpointStatus');
    expect(schema).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(migration).toContain('id_business_v2_governance_jobs_counts_check');
    expect(migration).toContain('id_business_v2_governance_checkpoints_counts_check');
    expect(migration).toContain('id_business_v2_governance_checkpoints_job_id_batch_no_key');
    expect(updatedAtMigration.match(/ALTER COLUMN "updated_at" DROP DEFAULT/g)).toHaveLength(3);
    expect(schema).toMatch(/resultAuditLogId\s+String\?/);
    expect(previewGuardsMigration).toContain(
      'id_business_v2_governance_job_items_result_audit_log_id_fkey'
    );
  });

  it('keeps general hard deletion disabled at the migration layer', () => {
    expect(migration).not.toMatch(
      /DELETE\s+FROM\s+"id_business_v2_(?:accounts|customers|options|orders)"/i
    );
    expect(migration).not.toMatch(/TRUNCATE\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
  });

  it('publishes governance changes for workflow and recycle-bin source tables', () => {
    expect(migration).toContain("VALUES ('data-governance', 0)");
    for (const source of ['options', 'customers', 'accounts', 'orders']) {
      expect(migration).toContain(`id_business_v2_${source}_governance_change`);
    }
    expect(migration).toContain(
      "EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance')"
    );
  });
});
