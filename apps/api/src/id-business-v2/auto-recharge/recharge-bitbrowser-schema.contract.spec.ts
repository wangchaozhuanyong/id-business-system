import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma-mysql/schema.prisma'), 'utf8');
const model = schema.match(/model IdBusinessV2RechargeBrowserSetting \{[\s\S]*?\n\}/)?.[0] ?? '';
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20260912180000_auto_recharge_bitbrowser_settings/migration.sql'
  ),
  'utf8'
);

describe('比特浏览器设置存储合约', () => {
  it('只加密保存接口密钥和动态链接，不保存 JSON 或卡资料', () => {
    expect(model).toContain('localApiTokenEncrypted');
    expect(model).toContain('connectorTokenEncrypted');
    expect(model).toContain('dynamicProxyUrlEncrypted');
    expect(model).not.toMatch(/sessionJson|accessToken|cardNumber|expiry|cvc|securityCode/i);
    expect(migration).not.toMatch(
      /session_json|access_token|card_number|expiry|cvc|security_code/i
    );
  });

  it('使用只向前的新迁移，不修改现有数据', () => {
    expect(migration).toContain('CREATE TABLE `id_business_v2_recharge_browser_settings`');
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE\s+/i);
  });
});
