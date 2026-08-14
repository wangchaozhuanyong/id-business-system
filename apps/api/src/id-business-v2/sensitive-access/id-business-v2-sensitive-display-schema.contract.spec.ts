import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(process.cwd());
const schema = readFileSync(resolve(apiRoot, 'prisma/schema.prisma'), 'utf8');
const policyMigration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260814030000_sensitive_display_policies/migration.sql'),
  'utf8'
);
const contactMigration = readFileSync(
  resolve(
    apiRoot,
    'prisma/migrations/20260814031000_sensitive_contact_search_indexes/migration.sql'
  ),
  'utf8'
);
const backfill = readFileSync(
  resolve(apiRoot, '../../scripts/backfill-v2-sensitive-search-indexes.mjs'),
  'utf8'
);

function prismaModel(name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `Prisma model ${name} should exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('敏感资料展示与搜索数据库契约', () => {
  it('stores one controlled display policy per role, field and context', () => {
    const policy = prismaModel('IdBusinessV2SensitiveDisplayPolicy');

    expect(schema).toContain('enum IdBusinessV2SensitiveDisplayContext');
    expect(schema).toContain('enum IdBusinessV2SensitiveDisplayMode');
    expect(policy).toContain('roleId');
    expect(policy).toContain('fieldKey');
    expect(policy).toContain('context');
    expect(policy).toContain('mode');
    expect(policy).toContain('@@unique([roleId, fieldKey, context])');
    expect(policyMigration).toContain('CREATE TABLE "id_business_v2_sensitive_display_policies"');
    expect(policyMigration).toContain(
      'id_business_v2_sensitive_display_policies_role_id_field_key_context_key'
    );
    expect(policyMigration).toContain('REFERENCES "roles"("id") ON DELETE CASCADE');
  });

  it('encrypts all customer contacts and adds namespaced blind indexes', () => {
    const customer = prismaModel('IdBusinessV2Customer');

    for (const field of [
      'phoneSearchTokens',
      'wechatEncrypted',
      'wechatHash',
      'wechatMasked',
      'wechatSearchTokens',
      'qqEncrypted',
      'qqHash',
      'qqMasked',
      'qqSearchTokens',
      'whatsappSearchTokens'
    ]) {
      expect(customer).toContain(field);
    }
    for (const column of [
      'phone_search_tokens',
      'wechat_search_tokens',
      'qq_search_tokens',
      'whatsapp_search_tokens'
    ]) {
      expect(contactMigration).toContain(`USING GIN ("${column}")`);
    }
  });

  it('indexes account phones and gift card codes without storing searchable plaintext', () => {
    const account = prismaModel('IdBusinessV2Account');
    const giftCard = prismaModel('IdBusinessV2GiftCard');

    expect(account).toContain('phoneSearchTokens');
    expect(account).toContain('@@index([phoneSearchTokens], type: Gin)');
    expect(giftCard).toContain('codeSearchTokens');
    expect(giftCard).toContain('@@index([codeSearchTokens], type: Gin)');
    expect(contactMigration).toContain('USING GIN ("phone_search_tokens")');
    expect(contactMigration).toContain('USING GIN ("code_search_tokens")');
    expect(contactMigration).not.toContain('phone_encrypted" =');
    expect(contactMigration).not.toContain('code_encrypted" =');
  });

  it('removes historical customer contact plaintext during the repeatable backfill', () => {
    expect(backfill).toContain('wechat: null');
    expect(backfill).toContain('qq: null');
    expect(backfill).toContain("'customer-wechat'");
    expect(backfill).toContain("'customer-qq'");
    expect(backfill).toContain("'gift-card-code'");
    expect(backfill).toContain('assert.equal(legacyCustomers, 0');
  });
});
