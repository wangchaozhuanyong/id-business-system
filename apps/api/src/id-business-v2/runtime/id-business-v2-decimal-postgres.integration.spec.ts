import { PrismaClient as NodePrismaClient } from '@prisma/client';
import { mapAmount4, mapRate8 } from './id-business-v2-row-mapper';

const databaseUrl = process.env.V2_DECIMAL_ADAPTER_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('V2 decimal PostgreSQL adapter contract', () => {
  let nodeClient: NodePrismaClient;

  beforeAll(async () => {
    nodeClient = new NodePrismaClient({ datasources: { db: { url: databaseUrl } } });

    await nodeClient.$executeRawUnsafe(`
      CREATE TABLE v2_decimal_adapter_contract (
        id integer PRIMARY KEY,
        amount numeric(18, 8) NOT NULL,
        rate numeric(20, 9) NOT NULL
      )
    `);
    await nodeClient.$executeRawUnsafe(`
      INSERT INTO v2_decimal_adapter_contract (id, amount, rate)
      VALUES (1, 12.34565, 5.643512345), (2, -0.00005, 0.333333335)
    `);
  });

  afterAll(async () => {
    await nodeClient?.$disconnect();
  });

  it('maps Node Prisma persisted decimals to canonical Amount4 and Rate8 values', async () => {
    const sql = 'SELECT id, amount, rate FROM v2_decimal_adapter_contract ORDER BY id';
    const nodeRows =
      await nodeClient.$queryRawUnsafe<Array<{ id: number; amount: unknown; rate: unknown }>>(sql);

    const normalize = (rows: Array<{ id: number; amount: unknown; rate: unknown }>) =>
      rows.map((row) => ({
        id: row.id,
        amount: mapAmount4(row.amount, 'v2_decimal_adapter_contract.amount').toString(),
        rate: mapRate8(row.rate, 'v2_decimal_adapter_contract.rate').toString()
      }));

    expect(normalize(nodeRows)).toEqual([
      { id: 1, amount: '12.3457', rate: '5.64351235' },
      { id: 2, amount: '-0.0001', rate: '0.33333334' }
    ]);
  });
});
