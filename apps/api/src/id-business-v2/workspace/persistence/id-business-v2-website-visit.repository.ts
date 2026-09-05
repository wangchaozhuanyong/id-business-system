import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

interface VisitCreate {
  id: string;
  host: string;
  path: string;
  occurredAt: Date;
  ipEncrypted: string;
  ipHash: string;
}
interface MetricRow {
  pageViews: bigint;
  uniqueIps: bigint;
}
type DailyRow = MetricRow & { date: string };

function metrics(row: MetricRow) {
  const pageViews = Number(row.pageViews);
  const uniqueIps = Number(row.uniqueIps);
  if (!Number.isSafeInteger(pageViews) || !Number.isSafeInteger(uniqueIps))
    throw new Error('Visit report exceeds safe integer range');
  return { pageViews, uniqueIps };
}

@Injectable()
export class IdBusinessV2WebsiteVisitRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(id: string, client: V2CommandTransaction = this.prisma) {
    return client.idBusinessV2WebsiteVisit.findUnique({ where: { id } });
  }

  async insert(tx: V2CommandTransaction, data: VisitCreate) {
    const inserted = await tx.idBusinessV2WebsiteVisit.createMany({
      data: [data],
      skipDuplicates: true
    });
    return inserted.count === 1;
  }

  async report(input: {
    start: Date;
    end: Date;
    ipHash?: string;
    page: number;
    pageSize: 20 | 50;
    sort: 'newest' | 'oldest';
  }) {
    return this.prisma.$transaction(
      async (tx) => {
        const where: Prisma.IdBusinessV2WebsiteVisitWhereInput = {
          occurredAt: { gte: input.start, lte: input.end },
          ...(input.ipHash ? { ipHash: input.ipHash } : {})
        };
        const condition = Prisma.sql`occurred_at >= ${input.start} AND occurred_at <= ${input.end}
        ${input.ipHash ? Prisma.sql`AND ip_hash = ${input.ipHash}` : Prisma.empty}`;
        const [summary] = await tx.$queryRaw<MetricRow[]>(Prisma.sql`
        SELECT COUNT(*) AS pageViews, COUNT(DISTINCT ip_hash) AS uniqueIps
        FROM id_business_v2_website_visits WHERE ${condition}`);
        const daily = await tx.$queryRaw<DailyRow[]>(Prisma.sql`
        SELECT DATE_FORMAT(DATE_ADD(occurred_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS date,
        COUNT(*) AS pageViews, COUNT(DISTINCT ip_hash) AS uniqueIps
        FROM id_business_v2_website_visits WHERE ${condition} GROUP BY date ORDER BY date`);
        const totals = metrics(summary);
        const page = Math.min(
          input.page,
          Math.max(1, Math.ceil(totals.pageViews / input.pageSize))
        );
        const order = input.sort === 'oldest' ? ('asc' as const) : ('desc' as const);
        const items = await tx.idBusinessV2WebsiteVisit.findMany({
          where,
          orderBy: [{ occurredAt: order }, { id: order }],
          take: input.pageSize,
          skip: (page - 1) * input.pageSize,
          select: { id: true, path: true, occurredAt: true, ipEncrypted: true }
        });
        const last = await tx.idBusinessV2WebsiteVisit.aggregate({
          where,
          _max: { receivedAt: true }
        });
        return {
          summary: totals,
          daily: daily.map((row) => ({ date: row.date, metrics: metrics(row) })),
          items,
          page,
          lastReceivedAt: last._max.receivedAt
        };
      },
      { isolationLevel: 'RepeatableRead' }
    );
  }

  async expiredIds(before: Date) {
    return this.prisma.idBusinessV2WebsiteVisit.findMany({
      where: { occurredAt: { lt: before } },
      select: { id: true },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: 1000
    });
  }

  removeExpired(tx: V2CommandTransaction, ids: string[], before: Date) {
    return tx.idBusinessV2WebsiteVisit.deleteMany({
      where: { id: { in: ids }, occurredAt: { lt: before } }
    });
  }
}
