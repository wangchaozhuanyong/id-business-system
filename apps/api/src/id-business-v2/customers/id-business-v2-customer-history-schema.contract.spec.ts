import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260730030000_customer_history_contacts/migration.sql'
  ),
  'utf8'
);
const changeSyncMigration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260729080000_event_driven_change_sync/migration.sql'),
  'utf8'
);

describe('ID Business V2 customer history and contacts schema contract', () => {
  it('stores QQ directly and keeps WhatsApp encrypted with searchable derivatives', () => {
    expect(schema).toMatch(/qq\s+String\?\s+@db\.VarChar\(120\)/);
    expect(schema).toContain('whatsappEncrypted');
    expect(schema).toContain('whatsappHash');
    expect(schema).toContain('whatsappMasked');
    expect(schema).toContain('whatsappTail');
    expect(schema).not.toMatch(/\bwhatsapp\s+String\??\s+/);
    expect(migration).toContain('id_business_v2_customers_qq_idx');
    expect(migration).toContain('id_business_v2_customers_whatsapp_hash_idx');
    expect(migration).toContain('id_business_v2_customers_whatsapp_tail_idx');
  });

  it('preserves legacy manual relations but distinguishes activation-backed history', () => {
    expect(schema).toContain('enum IdBusinessV2CustomerServiceSource');
    expect(schema).toContain('manual_legacy');
    expect(schema).toContain('activation');
    expect(schema).toContain('firstOpenedAt');
    expect(schema).toContain('lastOpenedAt');
    expect(schema).toContain('activationCount');
    expect(migration).toContain("DEFAULT 'manual_legacy'");
    expect(migration).toContain('id_business_v2_customer_services_history_evidence_check');
  });

  it('backfills all activation statuses into one distinct business summary', () => {
    const historyCte = migration.match(
      /WITH "activation_history" AS \(([\s\S]*?)\)\s*INSERT INTO/
    )?.[1];

    expect(historyCte).toBeTruthy();
    expect(historyCte).toContain('MIN("opened_at") AS "first_opened_at"');
    expect(historyCte).toContain('MAX("opened_at") AS "last_opened_at"');
    expect(historyCte).toContain('COUNT(*)::INTEGER AS "activation_count"');
    expect(historyCte).toContain('GROUP BY "customer_id", "service_option_id"');
    expect(historyCte).not.toMatch(/\bWHERE\b|\bstatus\b/i);
    expect(migration).toContain('ON CONFLICT ("customer_id", "option_id") DO UPDATE SET');
  });

  it('increments history on every real activation and reuses customer change notifications', () => {
    expect(migration).toContain(
      'CREATE TRIGGER id_business_v2_activation_customer_service_history'
    );
    expect(migration).toMatch(/AFTER INSERT ON public\.id_business_v2_activations\s+FOR EACH ROW/);
    expect(migration).toContain('id_business_v2_customer_services.activation_count + 1');
    expect(migration).toContain('LEAST(');
    expect(migration).toContain('GREATEST(');
    expect(changeSyncMigration).toContain('CREATE TRIGGER id_business_v2_customer_services_change');
  });
});
