import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(process.cwd());

describe('website visit database schema', () => {
  it('uses one isolated forward migration with encrypted IP storage and bounded indexes', () => {
    const migration = readFileSync(
      resolve(
        apiRoot,
        'prisma-mysql/migrations/20260905160000_website_visit_records/migration.sql'
      ),
      'utf8'
    );
    expect(migration).toContain('CREATE TABLE `id_business_v2_website_visits`');
    expect(migration).toContain('`ip_encrypted` TEXT NOT NULL');
    expect(migration).toContain('`ip_hash` CHAR(64) NOT NULL');
    expect(migration).toContain('idbiz_website_visit_time_idx');
    expect(migration).not.toMatch(/DROP|TRUNCATE|DELETE FROM/i);
  });
});
