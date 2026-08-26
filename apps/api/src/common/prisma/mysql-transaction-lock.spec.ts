import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireMysqlTransactionLock, isMysqlRuntimeDatabase } from './mysql-transaction-lock';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalRuntimeDatabaseUrl = process.env.V2_RUNTIME_DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalRuntimeDatabaseUrl === undefined) delete process.env.V2_RUNTIME_DATABASE_URL;
  else process.env.V2_RUNTIME_DATABASE_URL = originalRuntimeDatabaseUrl;
});

describe('acquireMysqlTransactionLock', () => {
  it('uses a PostgreSQL advisory transaction lock for PostgreSQL runtimes', async () => {
    process.env.DATABASE_URL = 'postgresql://app:password@postgres:5432/id_business_v2';
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: null }]),
      $executeRaw: vi.fn()
    };

    await acquireMysqlTransactionLock(client as never, 'security:login:username:admin');

    expect(client.$queryRaw).toHaveBeenCalledOnce();
    expect(client.$queryRaw.mock.calls[0]?.[0].join('')).toContain('pg_advisory_xact_lock');
    expect(client.$executeRaw).not.toHaveBeenCalled();
  });

  it('uses the MySQL lock row for MySQL runtimes', async () => {
    process.env.DATABASE_URL = 'mysql://app:password@mysql:3306/id_business_v2';
    const client = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(1)
    };

    await acquireMysqlTransactionLock(client as never, 'security:login:username:admin');

    expect(client.$executeRaw).toHaveBeenCalledOnce();
    expect(client.$executeRaw.mock.calls[0]?.[0].join('')).toContain(
      'INSERT INTO "mysql_transaction_locks"'
    );
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('isMysqlRuntimeDatabase', () => {
  it('falls back to the Edge runtime database URL when DATABASE_URL is absent', () => {
    delete process.env.DATABASE_URL;
    process.env.V2_RUNTIME_DATABASE_URL = 'mysql://app:password@mysql:3306/id_business_v2';
    expect(isMysqlRuntimeDatabase()).toBe(true);
  });
});
