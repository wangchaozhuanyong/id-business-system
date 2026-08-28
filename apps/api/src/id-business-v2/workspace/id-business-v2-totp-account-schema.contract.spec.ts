import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const postgresSchema = read('prisma/schema.prisma');
const mysqlSchema = read('prisma-mysql/schema.prisma');
const postgresMigration = read('prisma/migrations/20260828170000_user_totp_accounts/migration.sql');
const mysqlMigration = read(
  'prisma-mysql/migrations/20260828170000_user_totp_accounts/migration.sql'
);
const moduleSource = read('src/id-business-v2/workspace/id-business-v2-workspace.module.ts');

describe('saved TOTP account schema contract', () => {
  it('stores secrets encrypted and isolates unique accounts per user', () => {
    for (const schema of [postgresSchema, mysqlSchema]) {
      expect(schema).toContain('model IdBusinessV2TotpAccount {');
      expect(schema).toContain('secretEncrypted String');
      expect(schema).toContain('@map("secret_encrypted")');
      expect(schema).toContain('secretHash');
      expect(schema).toContain('@@unique([userId, name])');
      expect(schema).toContain('@@unique([userId, secretHash])');
      expect(schema).toContain('onDelete: Cascade');
    }
  });

  it('adds forward-only MySQL and PostgreSQL migrations', () => {
    for (const migration of [postgresMigration, mysqlMigration]) {
      expect(migration).toContain('id_business_v2_totp_accounts');
      expect(migration).toContain('secret_encrypted');
      expect(migration).toContain('secret_hash');
      expect(migration).toContain('digits_check');
      expect(migration).toContain('period_check');
      expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
    }
    expect(postgresMigration).toContain("id_business_v2_publish_change('workspace')");
    expect(postgresMigration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
  });

  it('registers the saved TOTP controller, service and repository', () => {
    expect(moduleSource).toContain('IdBusinessV2TotpAccountController');
    expect(moduleSource).toContain('IdBusinessV2TotpAccountService');
    expect(moduleSource).toContain('IdBusinessV2TotpAccountRepository');
    expect(moduleSource).toContain('FieldEncryptionService');
  });
});
