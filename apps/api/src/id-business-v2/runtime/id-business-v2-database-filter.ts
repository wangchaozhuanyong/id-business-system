export function isV2MysqlDatabase(databaseUrl = process.env.DATABASE_URL): boolean {
  return databaseUrl?.trim().toLowerCase().startsWith('mysql://') ?? false;
}

export function buildV2StringArrayContainsFilter<TFilter>(values: string[]): TFilter | undefined {
  if (values.length === 0) return undefined;
  return (isV2MysqlDatabase() ? { array_contains: values } : { hasEvery: values }) as TFilter;
}
