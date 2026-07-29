import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729000000_current_system_baseline/migration.sql'),
  'utf8'
);

describe('ID Business V2 immutable balance ledger schema', () => {
  it('rejects direct ledger updates and production deletes', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER id_business_v2_balance_ledger_immutable BEFORE (?:DELETE OR UPDATE|UPDATE OR DELETE) ON id_business_v2_balance_ledger/
    );
    expect(migration).toContain("RAISE EXCEPTION 'V2 balance ledger is immutable'");
  });

  it('limits fixture deletion to explicitly named one-time acceptance databases', () => {
    expect(migration).toContain("right(current_database(), 11) = '_acceptance'");
    expect(migration).toContain("IF TG_OP = 'DELETE'");
  });
});
