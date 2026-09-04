import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('Google Sheets sync contracts', () => {
  const mysqlSchema = read('prisma-mysql/schema.prisma');
  const postgresSchema = read('prisma/schema.prisma');
  const mysqlMigration = read(
    'prisma-mysql/migrations/20260905090000_google_sheets_report_sync/migration.sql'
  );
  const sourceRoot = 'src/id-business-v2/workspace';
  const repository = read(
    `${sourceRoot}/persistence/id-business-v2-google-sheets-sync.repository.ts`
  );
  const controller = read(`${sourceRoot}/id-business-v2-google-sheets-sync.controller.ts`);
  const callbackController = read(`${sourceRoot}/id-business-v2-google-sheets-oauth.controller.ts`);
  const oauthClient = read(`${sourceRoot}/providers/id-business-v2-google-sheets-oauth.client.ts`);
  const sheetsClient = read(`${sourceRoot}/providers/id-business-v2-google-sheets.client.ts`);

  it('adds an encrypted singleton configuration and an execution lease to both schemas', () => {
    for (const schema of [mysqlSchema, postgresSchema]) {
      expect(schema).toContain('model IdBusinessV2GoogleSheetsSync');
      expect(schema).toContain('clientSecretEncrypted');
      expect(schema).toContain('refreshTokenEncrypted');
      expect(schema).toContain('spreadsheetIdEncrypted');
      expect(schema).toContain('runLeaseExpiresAt');
    }
    expect(mysqlMigration).toContain('idbiz_google_sheets_singleton_check');
    expect(mysqlMigration).toContain('CHECK (`id` = 1)');
  });

  it('keeps configuration admin-only and OAuth callback state-bound', () => {
    expect(controller).toContain("@RequireRoles('admin')");
    expect(callbackController).toContain('@Public()');
    expect(oauthClient).toContain("code_challenge_method: 'S256'");
    expect(oauthClient).toContain("access_type: 'offline'");
    expect(oauthClient).toContain('https://www.googleapis.com/auth/drive.file');
    expect(oauthClient).not.toContain("https://www.googleapis.com/auth/drive'");
  });

  it('selects only whitelisted business fields and sends cell values as RAW', () => {
    expect(repository).not.toMatch(/passwordEncrypted|securityInfoEncrypted|phoneEncrypted/);
    expect(repository).not.toMatch(/codeEncrypted|providerCredentialEncrypted/);
    expect(sheetsClient).toContain("valueInputOption: 'RAW'");
    expect(sheetsClient).toContain('/values:batchUpdate');
    expect(sheetsClient).toContain('/values:batchClear');
  });
});
