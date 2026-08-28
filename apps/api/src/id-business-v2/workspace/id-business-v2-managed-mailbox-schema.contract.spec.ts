import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260815100000_managed_mailboxes/migration.sql'),
  'utf8'
);
const expiryMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260828130000_managed_mailbox_query_code_expiry/migration.sql'
  ),
  'utf8'
);
const mysqlSchema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const mysqlExpiryMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260828130000_managed_mailbox_query_code_expiry/migration.sql'
  ),
  'utf8'
);

describe('managed mailbox schema contract', () => {
  it('stores provider authorization encrypted and the buyer query code as a hash only', () => {
    expect(schema).toContain('model IdBusinessV2ManagedMailbox {');
    expect(schema).toContain('providerCredentialEncrypted String');
    expect(schema).toContain('queryCodeHash');
    expect(schema).not.toMatch(/queryCode\s+String/);
    expect(schema).not.toMatch(/appPassword\s+String/);
  });

  it('adds an append-only public query attempt log with bounded lookup indexes', () => {
    expect(migration).toContain('CREATE TABLE "id_business_v2_mail_query_attempts"');
    expect(migration).toContain('"email_hash" VARCHAR(64) NOT NULL');
    expect(migration).toContain('"ip_hash" VARCHAR(64)');
    expect(migration).toContain('id_business_v2_mail_query_attempts_email_hash_created_at_idx');
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });

  it('expires buyer query codes after a bounded compatibility window in both schemas', () => {
    expect(schema).toContain('queryCodeExpiresAt');
    expect(mysqlSchema).toContain('queryCodeExpiresAt');
    expect(expiryMigration).toContain("INTERVAL '30 days'");
    expect(expiryMigration).toContain('ALTER COLUMN "query_code_expires_at" SET NOT NULL');
    expect(mysqlExpiryMigration).toContain('INTERVAL 30 DAY');
    expect(mysqlExpiryMigration).toContain(
      'MODIFY COLUMN `query_code_expires_at` DATETIME(6) NOT NULL'
    );
    expect([expiryMigration, mysqlExpiryMigration].join('\n')).not.toMatch(
      /DROP TABLE|TRUNCATE|DELETE FROM/
    );
  });
});
