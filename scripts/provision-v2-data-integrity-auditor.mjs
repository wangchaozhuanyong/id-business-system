import { PrismaClient } from '@prisma/client';
import { assertV2AuditConnectionReadOnly } from './lib/v2-data-integrity-audit.mjs';
import { buildV2AuditAccountProvisioning } from './lib/v2-data-integrity-auditor.mjs';

const provisioning = buildV2AuditAccountProvisioning(process.env);
const prisma = new PrismaClient({ datasourceUrl: provisioning.rootDatabaseUrl });

try {
  for (const statement of provisioning.statements) {
    await prisma.$executeRawUnsafe(statement);
  }
  const grantRows = await prisma.$queryRawUnsafe(provisioning.showGrantsSql);
  const grants = grantRows.map((row) => ({ grant: String(Object.values(row)[0] ?? '') }));
  assertV2AuditConnectionReadOnly(grants);
  console.log(
    JSON.stringify({
      ok: true,
      username: provisioning.auditUsername,
      grants: grants.map((row) => row.grant)
    })
  );
} finally {
  await prisma.$disconnect();
}
