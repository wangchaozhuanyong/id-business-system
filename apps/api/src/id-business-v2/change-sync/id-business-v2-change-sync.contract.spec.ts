import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(process.cwd());
const schema = readFileSync(resolve(apiRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(apiRoot, 'prisma/migrations/20260729080000_event_driven_change_sync/migration.sql'),
  'utf8'
);
const controller = readFileSync(
  resolve(apiRoot, 'src/id-business-v2/change-sync/id-business-v2-change-sync.controller.ts'),
  'utf8'
);

describe('V2 event-driven change sync contract', () => {
  it('adds a separate scope version model without changing the clean baseline', () => {
    expect(schema).toContain('model IdBusinessV2ScopeVersion {');
    expect(schema).toContain('@@map("id_business_v2_scope_versions")');
    expect(migration).toContain('CREATE TABLE "id_business_v2_scope_versions"');
  });

  it('bumps versions and publishes from statement triggers in the same transaction', () => {
    expect(migration).toContain('FOR EACH STATEMENT');
    expect(migration).toContain('current_version.version + 1');
    expect(migration).toContain('PERFORM realtime.send(');
    expect(migration).toContain("'id-business-v2:changes'");
    expect(migration).not.toMatch(/\bCOMMIT\b|\bBEGIN TRANSACTION\b/);
  });

  it('broadcasts only scope versions and never reads changed business rows', () => {
    const triggerFunction =
      migration.match(
        /CREATE OR REPLACE FUNCTION public\.id_business_v2_publish_change\(\)([\s\S]*?)REVOKE ALL/
      )?.[1] ?? '';
    expect(triggerFunction).not.toMatch(/\bNEW\b|\bOLD\b/);
    expect(triggerFunction).toContain("'schemaVersion'");
    expect(triggerFunction).toContain("'eventId'");
    expect(triggerFunction).toContain("'occurredAt'");
    expect(triggerFunction).toContain("'scopes'");
    expect(triggerFunction).not.toMatch(
      /apple_id|phone|password|gift_card|order_no|website_account|lock_token/
    );
  });

  it('allows only eligible internal identities to select private broadcasts', () => {
    expect(migration).toContain('identity.enabled = true');
    expect(migration).toContain("internal_user.status = 'active'");
    expect(migration).toContain('internal_user.deleted_at IS NULL');
    expect(migration).toContain('FOR SELECT');
    expect(migration).not.toContain('FOR INSERT');
    expect(migration).toContain("realtime.topic() = 'id-business-v2:changes'");
    expect(migration).toContain("extension = 'broadcast'");
  });

  it('keeps the versions endpoint authenticated and scope-only', () => {
    expect(controller).toContain("@Controller('id-business-v2/change-versions')");
    expect(controller).not.toContain('@Public');
    expect(controller).not.toMatch(/Body|Post|Patch|Delete/);
  });
});
