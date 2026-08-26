import { isMysqlRuntimeDatabase } from '../../common/prisma/mysql-transaction-lock';

export function isV2MysqlDatabase(
  databaseUrl = process.env.DATABASE_URL ?? process.env.V2_RUNTIME_DATABASE_URL
): boolean {
  return isMysqlRuntimeDatabase(databaseUrl);
}

export function buildV2StringArrayContainsFilter<TFilter>(values: string[]): TFilter | undefined {
  if (values.length === 0) return undefined;
  return (isV2MysqlDatabase() ? { array_contains: values } : { hasEvery: values }) as TFilter;
}
