import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729000000_current_system_baseline/migration.sql'),
  'utf8'
);

describe('V2 manual renewal source link', () => {
  it('stores one immutable source activation link for each manual renewal result', () => {
    const activation = schema.match(/model IdBusinessV2Activation \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(activation).toMatch(/renewedFromActivationId\s+String\?\s+@unique/);
    expect(activation).toContain('@relation("IdBusinessV2ActivationRenewalChain"');
    expect(migration).toContain('"renewed_from_activation_id" UUID');
    expect(migration).toContain('id_business_v2_activations_renewed_from_activation_id_key');
    expect(migration).toContain('REFERENCES "id_business_v2_activations"("id")');
    expect(migration).toContain('ON DELETE RESTRICT');
  });

  it('writes the source link and excludes already-renewed records from the workbench', () => {
    const manualRenewal = readFileSync(
      resolve(
        process.cwd(),
        'src/id-business-v2/renewals/id-business-v2-manual-renewal.service.ts'
      ),
      'utf8'
    );
    const renewalsRepository = readFileSync(
      resolve(
        process.cwd(),
        'src/id-business-v2/renewals/persistence/id-business-v2-renewals.repository.ts'
      ),
      'utf8'
    );

    expect(manualRenewal).toContain('renewedFromActivationId: sourceActivation.id');
    expect(renewalsRepository).toContain('renewedBy:');
    expect(renewalsRepository).toContain('is: null');
  });
});
