import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('V2 permission catalog contracts', () => {
  it('names the order-create permission as the order-entry switch', () => {
    const seed = read('prisma/seed.ts');
    const migration = read(
      'prisma/migrations/20260806090000_admin_permission_catalog_sync/migration.sql'
    );

    expect(seed).toContain("['订单录入', 'apple.order.create']");
    expect(migration).toContain("'订单录入', 'apple.order.create'");
  });

  it('keeps administrator permissions synchronized without changing custom roles', () => {
    const migration = read(
      'prisma/migrations/20260806090000_admin_permission_catalog_sync/migration.sql'
    );

    expect(migration).toContain('INSERT INTO "permissions"');
    expect(migration).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(migration).toContain('INSERT INTO "role_permissions"');
    expect(migration).toContain('CROSS JOIN "permissions" permission');
    expect(migration).toContain('admin_role."code" = \'admin\'');
    expect(migration).toContain('ON CONFLICT DO NOTHING');
    expect(migration).not.toContain('DELETE FROM "role_permissions"');
  });
});
