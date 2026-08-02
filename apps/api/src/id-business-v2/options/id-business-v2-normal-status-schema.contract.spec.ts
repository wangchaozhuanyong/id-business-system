import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const baseline = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729000000_current_system_baseline/migration.sql'),
  'utf8'
);
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260802010000_normal_id_status_seed/migration.sql'),
  'utf8'
);

describe('ID Business V2 normal status migration contract', () => {
  it('adds the missing system status through a new incremental migration', () => {
    expect(baseline).not.toMatch(/'id_status',\s*'normal',\s*'正常'/);
    expect(migration).toContain(`WHERE "type" = 'id_status' AND "code" = 'normal'`);
    expect(migration).toContain(`WHERE "type" = 'id_status' AND "name" = '正常'`);
    expect(migration).toMatch(/'id_status',\s*'normal',\s*'正常'/);
  });

  it('restores the fixed status as active, system-owned and undeleted', () => {
    expect(migration).toContain(`"status" = 'active'`);
    expect(migration).toContain('"is_system" = true');
    expect(migration).toContain('"deleted_at" = NULL');
    expect(migration).toContain(`'id_status:root:正常'`);
  });
});
