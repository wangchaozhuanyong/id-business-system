import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = process.cwd();
const projectRoot = resolve(apiRoot, '../..');
const schema = readFileSync(resolve(apiRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260815120000_encrypt_user_phone/migration.sql'),
  'utf8'
);
const profileService = readFileSync(
  resolve(apiRoot, 'src/v2-auth/profile/v2-profile.service.ts'),
  'utf8'
);
const backfill = readFileSync(resolve(projectRoot, 'scripts/backfill-user-phone.mjs'), 'utf8');

describe('user phone encryption schema contract', () => {
  it('exposes only encrypted and masked user phone fields to Prisma', () => {
    const userModel = schema.match(/model User \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(userModel).toContain('phoneEncrypted');
    expect(userModel).toContain('@map("phone_encrypted")');
    expect(userModel).toContain('phoneMasked');
    expect(userModel).not.toMatch(/\n\s+phone\s+String/);
  });

  it('adds an incremental fail-closed migration without deleting historical data', () => {
    expect(migration).toContain('ADD COLUMN phone_encrypted TEXT');
    expect(migration).toContain('ADD COLUMN phone_masked VARCHAR(80)');
    expect(migration).toContain('users_phone_plaintext_forbidden');
    expect(migration).toContain('CHECK (phone IS NULL) NOT VALID');
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE FROM/i);
  });

  it('returns the stored mask and requires verified encrypted backfill', () => {
    expect(profileService).toContain('phoneMasked: true');
    expect(profileService).toContain('phoneMasked: user.phoneMasked');
    expect(profileService).not.toMatch(/\bphone:\s*true/);
    expect(backfill).toContain('FIELD_ENCRYPTION_KEY');
    expect(backfill).toContain('phone_encrypted');
    expect(backfill).toContain('phone = NULL');
    expect(backfill).toContain('VALIDATE CONSTRAINT users_phone_plaintext_forbidden');
  });
});
