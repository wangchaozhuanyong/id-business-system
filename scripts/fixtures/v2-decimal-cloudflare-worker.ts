import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../apps/api/src/generated/prisma-cloudflare/client';
import {
  mapAmount4,
  mapRate8
} from '../../apps/api/src/id-business-v2/runtime/id-business-v2-row-mapper';

interface DecimalAdapterEnvironment {
  V2_DECIMAL_ADAPTER_DATABASE_URL: string;
}

export default {
  async fetch(_request: Request, env: DecimalAdapterEnvironment) {
    const client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: env.V2_DECIMAL_ADAPTER_DATABASE_URL,
        max: 1
      })
    });

    try {
      const rows = await client.$queryRawUnsafe<
        Array<{ id: number; amount: unknown; rate: unknown }>
      >('SELECT id, amount, rate FROM v2_decimal_adapter_contract ORDER BY id');
      return Response.json({
        runtime: 'cloudflare',
        items: rows.map((row) => ({
          id: row.id,
          amount: mapAmount4(row.amount, 'v2_decimal_adapter_contract.amount').toString(),
          rate: mapRate8(row.rate, 'v2_decimal_adapter_contract.rate').toString()
        }))
      });
    } finally {
      await client.$disconnect();
    }
  }
};
