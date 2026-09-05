import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2WebsiteVisitRepository } from './persistence/id-business-v2-website-visit.repository';

const mysqlIntegrationUrl = process.env.V2_WEBSITE_VISIT_DATABASE_URL;
const describeMysql = mysqlIntegrationUrl ? describe : describe.skip;

describeMysql('website visit repository real MySQL behavior', () => {
  let prisma: PrismaService;
  let repository: IdBusinessV2WebsiteVisitRepository;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: mysqlIntegrationUrl });
    await prisma.$connect();
    repository = new IdBusinessV2WebsiteVisitRepository(prisma);
  });

  afterAll(async () => {
    if (createdIds.length) {
      await prisma.idBusinessV2WebsiteVisit.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma?.$disconnect();
  });

  it('applies idempotency, unique-IP totals, UTC+08 daily grouping, filtering and retention', async () => {
    const now = new Date();
    const current = [randomUUID(), randomUUID(), randomUUID()];
    const expired = randomUUID();
    createdIds.push(...current, expired);
    const insert = (id: string, occurredAt: Date, ipHash: string) =>
      prisma.$transaction((tx) =>
        repository.insert(tx, {
          id,
          host: 'flashcast.com.my',
          path: '/zh',
          occurredAt,
          ipEncrypted: `v1:integration:${id}`,
          ipHash
        })
      );

    await expect(insert(current[0], new Date(now.getTime() - 2_000), 'a'.repeat(64))).resolves.toBe(
      true
    );
    await expect(insert(current[0], new Date(now.getTime() - 2_000), 'a'.repeat(64))).resolves.toBe(
      false
    );
    await insert(current[1], new Date(now.getTime() - 1_000), 'a'.repeat(64));
    await insert(current[2], now, 'b'.repeat(64));
    await insert(expired, new Date(now.getTime() - 31 * 86_400_000), 'c'.repeat(64));

    const report = await repository.report({
      start: new Date(now.getTime() - 86_400_000),
      end: new Date(now.getTime() + 1_000),
      page: 1,
      pageSize: 20,
      sort: 'newest'
    });
    expect(report.summary).toEqual({ pageViews: 3, uniqueIps: 2 });
    expect(report.daily.reduce((total, row) => total + row.metrics.pageViews, 0)).toBe(3);
    expect(report.items.map((row) => row.id)).toEqual([current[2], current[1], current[0]]);

    const filtered = await repository.report({
      start: new Date(now.getTime() - 86_400_000),
      end: new Date(now.getTime() + 1_000),
      ipHash: 'a'.repeat(64),
      page: 1,
      pageSize: 20,
      sort: 'oldest'
    });
    expect(filtered.summary).toEqual({ pageViews: 2, uniqueIps: 1 });
    expect(filtered.items.map((row) => row.id)).toEqual([current[0], current[1]]);

    const before = new Date(now.getTime() - 30 * 86_400_000);
    expect((await repository.expiredIds(before)).map((row) => row.id)).toContain(expired);
    await prisma.$transaction((tx) => repository.removeExpired(tx, [expired], before));
    expect(await repository.find(expired)).toBeNull();
  }, 30_000);
});
