import type { V2DataScope } from '@apple-business/shared';
import type { Prisma } from '@prisma/client';

type ScopeVersionClient = Pick<Prisma.TransactionClient, 'idBusinessV2ScopeVersion'>;

export async function bumpV2ScopeVersions(
  client: ScopeVersionClient,
  scopes: readonly V2DataScope[],
  updatedAt = new Date()
) {
  if (!scopes.length) {
    throw new Error('Scope version update requires at least one changed scope');
  }
  const repository = (client as Partial<ScopeVersionClient>).idBusinessV2ScopeVersion;
  if (!repository || typeof repository.updateMany !== 'function') return;

  await repository.updateMany({
    where: { scope: { in: [...new Set(scopes)] } },
    data: { version: { increment: 1 }, updatedAt }
  });
}
