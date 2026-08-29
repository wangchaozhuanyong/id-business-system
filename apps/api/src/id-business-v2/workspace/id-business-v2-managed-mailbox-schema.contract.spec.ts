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
const mysqlCodeOnlyMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260828164500_managed_mailbox_code_only_lookup/migration.sql'
  ),
  'utf8'
);
const microsoftMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260828200000_managed_mailbox_microsoft_oauth/migration.sql'
  ),
  'utf8'
);
const mysqlMicrosoftMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260828200000_managed_mailbox_microsoft_oauth/migration.sql'
  ),
  'utf8'
);
const privacyMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260828213000_mailbox_transient_privacy/migration.sql'
  ),
  'utf8'
);
const mysqlPrivacyMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260828213000_mailbox_transient_privacy/migration.sql'
  ),
  'utf8'
);

describe('managed mailbox schema contract', () => {
  it('stores provider authorization and admin-copyable query codes encrypted', () => {
    expect(schema).toContain('model IdBusinessV2ManagedMailbox {');
    expect(schema).toContain('providerCredentialEncrypted String');
    expect(schema).toContain('queryCodeHash');
    expect(schema).toContain('queryCodeEncrypted');
    expect(schema).not.toMatch(/appPassword\s+String/);
  });

  it('keeps encrypted query codes while removing temporary OAuth state from persistent schemas', () => {
    for (const source of [microsoftMigration, mysqlMicrosoftMigration]) {
      expect(source).toContain('query_code_encrypted');
      expect(source).toContain('id_business_v2_mailbox_oauth_states');
      expect(source).toContain('microsoft');
      expect(source).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
    }
    expect(schema).not.toContain('model IdBusinessV2MailboxOAuthState {');
    expect(mysqlSchema).not.toContain('model IdBusinessV2MailboxOAuthState {');
    for (const source of [privacyMigration, mysqlPrivacyMigration]) {
      expect(source).toContain('DROP TABLE IF EXISTS');
      expect(source).toContain('id_business_v2_mailbox_oauth_states');
    }
  });

  it('retires historical public query logs so buyer IP and attempt hashes are not persisted', () => {
    expect(migration).toContain('CREATE TABLE "id_business_v2_mail_query_attempts"');
    expect(schema).not.toContain('model IdBusinessV2MailQueryAttempt {');
    expect(mysqlSchema).not.toContain('model IdBusinessV2MailQueryAttempt {');
    for (const source of [privacyMigration, mysqlPrivacyMigration]) {
      expect(source).toContain('id_business_v2_mail_query_attempts');
    }
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

  it('uses a unique query-code hash for mailbox lookup without a persistent attempt model', () => {
    expect(mysqlSchema).toMatch(/queryCodeHash\s+String\s+@unique/);
    expect(mysqlCodeOnlyMigration).toContain(
      'id_business_v2_managed_mailboxes_query_code_hash_key'
    );
    expect(mysqlCodeOnlyMigration).toContain(
      'CHANGE COLUMN `email_hash` `query_code_hash` VARCHAR(64) NOT NULL'
    );
    expect(mysqlCodeOnlyMigration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });
});
