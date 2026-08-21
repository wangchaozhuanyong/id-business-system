import { V2_DATA_SCOPES, type V2DataScope } from '@apple-business/shared';
import type { Prisma } from '@prisma/client';

type ScopeVersionClient = Pick<Prisma.TransactionClient, 'idBusinessV2ScopeVersion'>;

export async function bumpV2ScopeVersions(
  client: ScopeVersionClient,
  scopes: readonly V2DataScope[] = V2_DATA_SCOPES,
  updatedAt = new Date()
) {
  const repository = (client as Partial<ScopeVersionClient>).idBusinessV2ScopeVersion;
  if (!repository || typeof repository.updateMany !== 'function') return;

  await repository.updateMany({
    where: { scope: { in: [...new Set(scopes)] } },
    data: { version: { increment: 1 }, updatedAt }
  });
}
