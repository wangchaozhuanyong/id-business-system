import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('V2 identity authorization version contract', () => {
  it('bumps and consumes the employee scope version for role permission changes', () => {
    const migration = read(
      'prisma/migrations/20260807130000_sensitive_access_role_policy/migration.sql'
    );
    const identityService = read('src/v2-auth/v2-identity.service.ts');

    expect(migration).toContain(
      "EXECUTE FUNCTION public.id_business_v2_publish_change('security', 'employees')"
    );
    expect(identityService).toContain("where: { scope: 'employees' }");
    expect(identityService).toContain('authorizationVersion?.version.toString()');
  });
});
