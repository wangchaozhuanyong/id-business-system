import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.V2_MAILBOX_QUERY_CODE_TEST_DATABASE_URL;
const enabled = Boolean(url);
const table = `mailbox_validity_fixture_${process.pid}`;
const quotedTable = `\`${table}\``;
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma-mysql/migrations/20261027010000_managed_mailbox_query_code_validity/migration.sql'
  ),
  'utf8'
);
const sql = migration.replaceAll('`id_business_v2_managed_mailboxes`', quotedTable);
let client: PrismaClient;
const rows = async () =>
  client.$queryRawUnsafe<
    Array<{
      id: string;
      query_code_hash: string;
      query_code_encrypted: string;
      query_code_expires_at: Date;
    }>
  >(
    `SELECT id,query_code_hash,query_code_encrypted,query_code_expires_at FROM ${quotedTable} ORDER BY id`
  );
let before: Awaited<ReturnType<typeof rows>>;

describe.skipIf(!enabled)('mailbox validity migration on disposable MySQL', () => {
  beforeAll(() => {
    const parsed = new URL(url!);
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.NODE_ENV !== 'test' ||
      !/^\/id_business_v2_billing_allocation_\d+$/.test(parsed.pathname) ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    ) {
      throw new Error('Mailbox migration tests require the isolated GitHub runner database');
    }
    client = new PrismaClient({ datasources: { db: { url } } });
  });
  beforeEach(async () => {
    await client.$executeRawUnsafe(
      `CREATE TABLE ${quotedTable} (id VARCHAR(36) PRIMARY KEY,query_code_hash VARCHAR(64) NOT NULL,query_code_encrypted TEXT,query_code_expires_at DATETIME(6) NOT NULL)`
    );
    await client.$executeRawUnsafe(
      `INSERT INTO ${quotedTable} VALUES ('expired','fixture-old-hash','fixture-old-encrypted','2020-01-01 08:00:00.123456'),('valid','fixture-current-hash','fixture-current-encrypted','2030-01-01 08:00:00.654321')`
    );
    before = await rows();
    await client.$executeRawUnsafe(sql);
  });
  afterEach(async () => {
    await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quotedTable}`);
  });
  afterAll(async () => {
    await client?.$disconnect();
  });

  it('backfills existing records with the 30-day compatibility default', async () => {
    const result = await client.$queryRawUnsafe<Array<{ days: number }>>(
      `SELECT query_code_validity_days AS days FROM ${quotedTable}`
    );
    expect(result.map((row) => Number(row.days))).toEqual([30, 30]);
  });
  it('preserves existing codes and expired/future timestamps exactly', async () => {
    expect(await rows()).toEqual(before);
  });
  it('rejects null cycles without modifying the existing code or expiry', async () => {
    await expect(
      client.$executeRawUnsafe(
        `UPDATE ${quotedTable} SET query_code_validity_days=NULL WHERE id='valid'`
      )
    ).rejects.toThrow();
    expect(await rows()).toEqual(before);
  });
  it('persists all three longer periods without changing the code or expiry', async () => {
    for (const days of [90, 180, 365]) {
      await client.$executeRawUnsafe(
        `UPDATE ${quotedTable} SET query_code_validity_days=${days} WHERE id='valid'`
      );
      const result = await client.$queryRawUnsafe<Array<{ days: number }>>(
        `SELECT query_code_validity_days AS days FROM ${quotedTable} WHERE id='valid'`
      );
      expect(Number(result[0].days)).toBe(days);
      expect(await rows()).toEqual(before);
    }
  });
  it('fails closed on a duplicate raw migration and retains every existing value', async () => {
    await expect(client.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await rows()).toEqual(before);
  });
});
