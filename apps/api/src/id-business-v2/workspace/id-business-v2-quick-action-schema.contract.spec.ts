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
const orderMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20261008180000_quick_action_user_order/migration.sql'
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

  it('adds a nullable user order without changing or deleting existing reply data', () => {
    const quickActionModel = schema.match(/model IdBusinessV2QuickAction \{([\s\S]*?)\n\}/)?.[1];
    expect(quickActionModel).toMatch(/sortOrder\s+Int\?\s+@map\("sort_order"\)/);
    expect(quickActionModel).toContain('@@index([userId, deletedAt, sortOrder])');
    expect(orderMigration).toContain('ALTER TABLE `id_business_v2_quick_actions`');
    expect(orderMigration).toContain('ADD COLUMN `sort_order` INTEGER NULL');
    expect(orderMigration).toContain('ADD INDEX');
    expect(orderMigration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b|CREATE TABLE/i);
  });
});
