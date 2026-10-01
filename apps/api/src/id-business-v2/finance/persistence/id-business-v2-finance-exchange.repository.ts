import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  V2FinanceExchange,
  V2FinanceExchangeSummary,
  V2FinanceCurrency
} from '@apple-business/shared';
import { calculateFinanceExchange, addDecimalStrings } from '@apple-business/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

export type FinanceExchangeWhere = Prisma.IdBusinessV2FinanceExchangeWhereInput;
type ExchangeRow = Prisma.IdBusinessV2FinanceExchangeGetPayload<{ include: { journal: true } }>;
export function mapFinanceExchange(row: ExchangeRow): V2FinanceExchange {
  const { journal, ...value } = row;
  const amounts = {
    sourceAmount: row.sourceAmount.toString(),
    targetAmount: row.targetAmount.toString(),
    feeAmount: row.feeAmount.toString(),
    totalDebit: row.totalDebit.toString(),
    grossTargetAmount: row.grossTargetAmount.toString(),
    feePercent: row.feePercent.toString(),
    exchangeRate: row.exchangeRate.toString(),
    effectiveRate: row.effectiveRate.toString(),
    sourceFxRateToCny: row.sourceFxRateToCny.toString(),
    targetFxRateToCny: row.targetFxRateToCny.toString(),
    feeAmountCny: row.feeAmountCny.toString(),
    fxGainLossCny: row.fxGainLossCny.toString()
  };
  return {
    ...value,
    ...amounts,
    channel: row.channel ?? undefined,
    remark: row.remark ?? undefined,
    sourceFxSnapshotId: row.sourceFxSnapshotId ?? undefined,
    targetFxSnapshotId: row.targetFxSnapshotId ?? undefined,
    reverseRate: calculateFinanceExchange({ ...amounts, feeMode: row.feeMode }).reverseRate,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    status: journal.status
  };
}
@Injectable()
export class IdBusinessV2FinanceExchangeRepository {
  constructor(private readonly prisma: PrismaService) {}
  find(id: string) {
    return this.prisma.idBusinessV2FinanceExchange.findUnique({
      where: { id },
      include: { journal: true }
    });
  }
  replayRead(idempotencyKey: string) {
    return this.prisma.idBusinessV2FinanceExchange.findUnique({
      where: { idempotencyKey },
      include: { journal: true }
    });
  }
  replay(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceExchange.findUnique({
      where: { idempotencyKey },
      include: { journal: true }
    });
  }
  findInTransaction(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2FinanceExchange.findUnique({ where: { id }, include: { journal: true } });
  }
  create(tx: V2CommandTransaction, data: Prisma.IdBusinessV2FinanceExchangeUncheckedCreateInput) {
    return tx.idBusinessV2FinanceExchange.create({ data, include: { journal: true } });
  }
  accounts(tx: V2CommandTransaction, ids: string[]) {
    return tx.idBusinessV2FinanceAccount.findMany({ where: { id: { in: ids } } });
  }
  async list(
    where: Prisma.IdBusinessV2FinanceExchangeWhereInput,
    skip: number,
    take: number,
    oldest: boolean
  ) {
    const active: Prisma.IdBusinessV2FinanceExchangeWhereInput = {
      AND: [where, { journal: { status: 'posted' } }]
    };
    const [items, total, aggregate, sources, targets] = await this.prisma.$transaction([
      this.prisma.idBusinessV2FinanceExchange.findMany({
        where,
        skip,
        take,
        include: { journal: true },
        orderBy: [{ occurredAt: oldest ? 'asc' : 'desc' }, { id: oldest ? 'asc' : 'desc' }]
      }),
      this.prisma.idBusinessV2FinanceExchange.count({ where }),
      this.prisma.idBusinessV2FinanceExchange.aggregate({
        where: active,
        _count: { _all: true },
        _sum: { feeAmountCny: true, fxGainLossCny: true }
      }),
      this.prisma.idBusinessV2FinanceExchange.groupBy({
        where: active,
        by: ['sourceCurrency', 'feeMode'],
        orderBy: { sourceCurrency: 'asc' },
        _sum: { sourceAmount: true, feeAmount: true }
      }),
      this.prisma.idBusinessV2FinanceExchange.groupBy({
        where: active,
        by: ['targetCurrency', 'feeMode'],
        orderBy: { targetCurrency: 'asc' },
        _sum: { targetAmount: true, feeAmount: true }
      })
    ]);
    const currencies = new Map<V2FinanceCurrency, V2FinanceExchangeSummary['currencies'][number]>();
    const get = (currency: V2FinanceCurrency) => {
      let row = currencies.get(currency);
      if (!row) {
        row = { currency, sourceAmount: '0', targetAmount: '0', feeAmount: '0' };
        currencies.set(currency, row);
      }
      return row;
    };
    for (const item of sources) {
      const row = get(item.sourceCurrency);
      row.sourceAmount = addDecimalStrings(
        row.sourceAmount,
        item._sum?.sourceAmount?.toString() ?? '0'
      );
      if (item.feeMode === 'source_extra')
        row.feeAmount = addDecimalStrings(row.feeAmount, item._sum?.feeAmount?.toString() ?? '0');
    }
    for (const item of targets) {
      const row = get(item.targetCurrency);
      row.targetAmount = addDecimalStrings(
        row.targetAmount,
        item._sum?.targetAmount?.toString() ?? '0'
      );
      if (item.feeMode === 'target_deducted')
        row.feeAmount = addDecimalStrings(row.feeAmount, item._sum?.feeAmount?.toString() ?? '0');
    }
    return {
      items: items.map(mapFinanceExchange),
      total,
      summary: {
        count: aggregate._count._all,
        feeAmountCny: aggregate._sum.feeAmountCny?.toString() ?? '0',
        fxGainLossCny: aggregate._sum.fxGainLossCny?.toString() ?? '0',
        currencies: [...currencies.values()]
      }
    };
  }
}
