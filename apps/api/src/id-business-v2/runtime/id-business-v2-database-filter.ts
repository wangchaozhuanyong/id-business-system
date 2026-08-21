export function buildV2StringArrayContainsFilter<TFilter>(values: string[]): TFilter | undefined {
  if (values.length === 0) return undefined;
  const databaseUrl = process.env.DATABASE_URL?.trim().toLowerCase() ?? '';
  return (
    databaseUrl.startsWith('mysql://') ? { array_contains: values } : { hasEvery: values }
  ) as TFilter;
}
