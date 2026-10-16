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
  if (!repository) return;

  // A newly introduced scope may not have been seeded in an existing database.
  // Create its first version in the command transaction, then increment normally.
  for (const scope of new Set(scopes)) {
    await repository.upsert({
      where: { scope },
      create: { scope, version: 1, updatedAt },
      update: { version: { increment: 1 }, updatedAt }
    });
  }
}
