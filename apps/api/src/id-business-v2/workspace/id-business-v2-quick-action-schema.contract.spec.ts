import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260930230000_workspace_quick_actions/migration.sql'
  ),
  'utf8'
);

describe('quick action storage contract', () => {
  it('keeps reply snippets per user and preserves soft-deleted rows', () => {
    expect(schema).toContain('model IdBusinessV2QuickAction {');
    expect(schema).toContain('@@index([userId, deletedAt, updatedAt])');
    expect(migration).toContain('CREATE TABLE `id_business_v2_quick_actions`');
    expect(migration).toContain('`deleted_at` DATETIME(6) NULL');
    expect(migration).toContain('FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)');
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });
});
