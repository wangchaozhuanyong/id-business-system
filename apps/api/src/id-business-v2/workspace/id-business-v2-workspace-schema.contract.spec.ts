import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260814130000_user_workspace_shortcuts/migration.sql'),
  'utf8'
);
const workspaceModule = readFileSync(
  resolve(process.cwd(), 'src/id-business-v2/workspace/id-business-v2-workspace.module.ts'),
  'utf8'
);

describe('personal workspace schema contract', () => {
  it('keeps shortcuts owned by one user with stable ordering', () => {
    expect(schema).toContain('model IdBusinessV2WorkspaceShortcut {');
    expect(schema).toContain('@@unique([userId, url])');
    expect(schema).toContain('@@index([userId, sortOrder])');
    expect(schema).toContain('onDelete: Cascade');
  });

  it('adds only an incremental table, scope and change trigger', () => {
    expect(migration).toContain('CREATE TABLE "id_business_v2_workspace_shortcuts"');
    expect(migration).toContain("VALUES ('workspace', 0)");
    expect(migration).toContain('CREATE TRIGGER id_business_v2_workspace_shortcuts_change');
    expect(migration).toContain("id_business_v2_publish_change('workspace')");
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/);
  });

  it('registers managed mailbox routes and the Node IMAP provider', () => {
    expect(workspaceModule).toContain('IdBusinessV2WorkspaceController');
    expect(workspaceModule).toContain('IdBusinessV2ManagedMailboxController');
    expect(workspaceModule).toContain('IdBusinessV2PublicMailboxController');
    expect(workspaceModule).toContain('IdBusinessV2ImapMailProvider');
    expect(workspaceModule).toContain('FieldEncryptionService');
    expect(workspaceModule).toContain('IdBusinessV2ManagedMailboxService');
    expect(workspaceModule).toContain('IdBusinessV2MailViewerService');
    expect(workspaceModule).toContain('IdBusinessV2ManagedMailboxRepository');
  });
});
