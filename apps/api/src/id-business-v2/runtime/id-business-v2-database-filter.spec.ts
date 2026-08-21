import { afterEach, describe, expect, it } from 'vitest';
import { buildV2StringArrayContainsFilter } from './id-business-v2-database-filter';

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('buildV2StringArrayContainsFilter', () => {
  it('uses the PostgreSQL scalar-list filter by default', () => {
    delete process.env.DATABASE_URL;
    expect(buildV2StringArrayContainsFilter<Record<string, string[]>>(['token'])).toEqual({
      hasEvery: ['token']
    });
  });

  it('uses the MySQL JSON-array filter for a MySQL runtime', () => {
    process.env.DATABASE_URL = 'mysql://app:password@mysql:3306/id_business_v2';
    expect(buildV2StringArrayContainsFilter<Record<string, string[]>>(['token'])).toEqual({
      array_contains: ['token']
    });
  });

  it('omits an empty token filter', () => {
    expect(buildV2StringArrayContainsFilter<Record<string, string[]>>([])).toBeUndefined();
  });
});
